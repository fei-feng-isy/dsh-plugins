/**
 * P1-1 · A3 — entity normalization (trigram-Jaccard merge + canonical bags), OFFLINE.
 *
 * HYPOTHESIS. The entity leg's bags are noisy near-duplicates (`dsh`/`DSH`, `mem`/`memory`, …), so
 * merging trigram-similar entity NAMES shrinks the bag, sharpens the anchor filter and cuts fanout —
 * but over-merging two genuinely different things destroys recall. The brief requires BOTH a metric
 * move AND a sampled merge audit, and rejects the arm when the over-merge rate is >= 5%.
 *
 * ARMS
 *   A production entity leg (identity-checked).
 *   B/C/D canonical merge at trigram-Jaccard thresholds {0.5, 0.7, 0.9}.
 *
 * HOW THE MERGE IS APPLIED (consistently on both sides)
 *   - `trigrams(name)` = lowercased 3-grams; a name shorter than 3 chars contributes itself as one
 *     token (2-char CJK names have no 3-gram, so they can only merge with an identical name — i.e.
 *     never, since `entities.name` is UNIQUE). This is stated because it bounds what A3 can do to
 *     the 2-char CJK queries.
 *   - union-find over pairs with `|A∩B|/|A∪B| >= threshold`; the canonical name of a cluster is the
 *     name with the highest active document frequency (tie: shortest, then lexicographic).
 *   - every fact's entity bag and the query's `extractEntities()` names are mapped to canonical
 *     names, then the PRODUCTION metric is applied unchanged: canonical df -> `selectAnchors` ->
 *     candidates sharing >= 1 anchor -> `anchoredOverlap(anchors, canonicalQueryWidth, canonicalBag)`.
 *
 * NETWORKS: the 5 two-char real queries (gold = `goldByEntity`) plus 10 higher-df entity-name
 * lookups (gold = the facts whose entity bag holds that name), and the full fused pipeline for the
 * same queries. Everything else (semantic / FTS legs, floors, weights, limit) is untouched.
 *
 * VERDICT RULE (brief): entity-query performance improves AND sampled over-merge rate < 5% ⇒ adopt.
 *
 * Usage: node mem/scripts/spikes/bench-a3-entity-merge.mjs
 * NOTE ON TEXT: the audit prints entity NAMES (metadata from the `entities` table). No fact content
 * is ever printed or written.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/a3-entity-merge.json'))
const LIMIT = 5
const THRESHOLDS = [0.5, 0.7, 0.9]
const AUDIT_SIZE = 20

const trigrams = (name) => {
  const s = name.toLowerCase()
  const g = new Set()
  if (s.length < 3) g.add(s)
  else for (let i = 0; i + 3 <= s.length; i += 1) g.add(s.slice(i, i + 3))
  return g
}
const jaccard = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return inter / (a.size + b.size - inter)
}

/** Union-find merge of entity names at one Jaccard threshold. Returns {canonicalByName, pairs, clusters}. */
export function mergeEntities(entities, threshold) {
  const parent = new Map(entities.map((e) => [e.name, e.name]))
  const find = (x) => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)
    while (parent.get(x) !== r) {
      const next = parent.get(x)
      parent.set(x, r)
      x = next
    }
    return r
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const grams = new Map(entities.map((e) => [e.name, trigrams(e.name)]))
  const inverted = new Map()
  for (const e of entities) for (const g of grams.get(e.name)) {
    if (!inverted.has(g)) inverted.set(g, [])
    inverted.get(g).push(e.name)
  }
  const pairs = []
  const seenPair = new Set()
  for (const e of entities) {
    const candidates = new Set()
    for (const g of grams.get(e.name)) for (const other of inverted.get(g)) if (other !== e.name) candidates.add(other)
    for (const other of candidates) {
      const key = e.name < other ? `${e.name}\u0000${other}` : `${other}\u0000${e.name}`
      if (seenPair.has(key)) continue
      seenPair.add(key)
      const j = jaccard(grams.get(e.name), grams.get(other))
      if (j >= threshold) {
        pairs.push({ a: e.name, b: other, jaccard: L.round4(j) })
        union(e.name, other)
      }
    }
  }
  const clusters = new Map()
  for (const e of entities) {
    const root = find(e.name)
    if (!clusters.has(root)) clusters.set(root, [])
    clusters.get(root).push(e)
  }
  const canonicalByName = new Map()
  const clusterList = []
  for (const members of clusters.values()) {
    const sorted = [...members].sort((x, y) => y.df - x.df || x.name.length - y.name.length || (x.name < y.name ? -1 : 1))
    const canonical = sorted[0].name
    for (const m of members) canonicalByName.set(m.name, canonical)
    clusterList.push({ canonical, members: members.map((m) => m.name), size: members.length })
  }
  return { canonicalByName, pairs, clusters: clusterList }
}

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-a3-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts } = L.loadActiveTexts(snap)
  track.texts = texts
  L.banner('A3 · entity normalization', { active_facts: texts.size, thresholds: THRESHOLDS })
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })

  // ── corpus-side entity data (all read-only) ──────────────────────────────────
  const db = L.openReadOnly(snap)
  let entities
  let bagsByFact
  try {
    entities = db
      .prepare(
        `select e.entity_id id, e.name name,
                (select count(*) from fact_entities fe2 join facts f2 on f2.fact_id = fe2.fact_id
                  where fe2.entity_id = e.entity_id and f2.status = 'active') df
           from entities e`,
      )
      .all()
    const rows = db
      .prepare(
        `select fe.fact_id fid, e.name name from fact_entities fe
           join entities e on e.entity_id = fe.entity_id
           join facts f on f.fact_id = fe.fact_id
          where f.status = 'active'`,
      )
      .all()
    bagsByFact = new Map()
    for (const r of rows) {
      if (!bagsByFact.has(r.fid)) bagsByFact.set(r.fid, [])
      bagsByFact.get(r.fid).push(r.name)
    }
  } finally {
    db.close()
  }
  const activeFacts = texts.size
  const rawBagWidths = [...bagsByFact.values()].map((b) => b.length).sort((a, b) => a - b)
  const median = (arr) => arr[Math.floor(arr.length / 2)]

  // ── query set: 5 two-char + 10 higher-df entity names ────────────────────────
  const twoChar = ['插件', '任务', '版本', '宿主', '会话']
  const extra = entities
    .filter((e) => e.df > 0 && !twoChar.includes(e.name) && e.name.length >= 2)
    .sort((a, b) => b.df - a.df || (a.name < b.name ? -1 : 1))
    .slice(0, 10)
    .map((e) => e.name)
  const queryNames = [...twoChar, ...extra]

  const merged = {}
  for (const t of THRESHOLDS) merged[t] = mergeEntities(entities, t)

  // ── per arm, the canonical view + the raw entity-leg map ─────────────────────
  const canonicalView = (t) => {
    const { canonicalByName } = merged[t]
    const canonDf = new Map()
    const canonBags = new Map()
    for (const [fid, bag] of bagsByFact) {
      const set = new Set(bag.map((n) => canonicalByName.get(n) ?? n))
      canonBags.set(fid, set)
      for (const n of set) canonDf.set(n, (canonDf.get(n) ?? 0) + 1)
    }
    return { canonicalByName, canonDf, canonBags }
  }

  /** The merged entity leg for one query, mirroring `MemoryStore.jaccardPath`'s shape. */
  const mergedLeg = async (query, view, legCap) => {
    const qNames = Array.from(new Set((await L.extractEntities(query)).map((e) => view.canonicalByName.get(e.name) ?? e.name)))
    const anchors = qNames.length > 0 ? L.selectAnchors(qNames, view.canonDf, activeFacts) : []
    const scored = []
    if (anchors.length > 0) {
      for (const [fid, bag] of view.canonBags) {
        const s = L.anchoredOverlap(anchors, qNames.length, bag)
        if (s > 0) scored.push({ id: fid, score: s })
      }
    }
    scored.sort((a, b) => b.score - a.score || a.id - b.id)
    const cap = legCap ?? 200
    return { scores: new Map(scored.slice(0, cap).map((x) => [x.id, x.score])), fanout: scored.length, anchors, qNames }
  }

  // ── production leg view (for baseline fanout/width) ──────────────────────────
  const identity = []
  for (const q of queryNames) identity.push(await L.identityCheck(rt, q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const idFail = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - idFail.length}/${identity.length} pass`)

  const rows = []
  for (const q of queryNames) {
    const gold = L.goldByEntity(snap, q)
    if (gold.length === 0) continue
    const basePass = await L.runScript(rt, q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const baseEntity = basePass.perVariant[0].legs[1].scores // legs are [semantic, jaccard, fts]
    const row = {
      query: q,
      gold_size: gold.length,
      base: {
        ids: basePass.ids,
        top1: gold.includes(basePass.ids[0]) ? 1 : 0,
        top3: basePass.ids.slice(0, 3).filter((id) => gold.includes(id)).length,
        fanout: basePass.perVariant[0].raw.candidates.length,
        entity_leg_size: baseEntity.size,
        entity_leg_top3: [...baseEntity.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map(([id]) => id),
      },
      arms: {},
    }
    for (const t of THRESHOLDS) {
      const view = canonicalView(t)
      const arm = {
        name: `merge_${t}`,
        jaccard: () => {
          // filled per query below; the hook is re-created per query so it can close over `leg`
          return arm.__leg.scores
        },
      }
      const leg = await mergedLeg(q, view, basePass.legCap)
      arm.__leg = leg
      const pass = await L.runScript(rt, q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm })
      row.arms[`t${t}`] = {
        ids: pass.ids,
        top1: gold.includes(pass.ids[0]) ? 1 : 0,
        top3: pass.ids.slice(0, 3).filter((id) => gold.includes(id)).length,
        fanout: leg.fanout,
        entity_leg_size: leg.scores.size,
        entity_leg_top3: [...leg.scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3).map(([id]) => id),
        anchors: leg.anchors.length,
      }
    }
    rows.push(row)
  }
  const summarise = (label, pick) => ({
    queries: rows.length,
    top1_ok: rows.filter((r) => pick(r).top1 === 1).length,
    top3_relevant_mean: L.round4(rows.reduce((n, r) => n + pick(r).top3, 0) / rows.length),
    fanout_median: median(rows.map((r) => pick(r).fanout).sort((a, b) => a - b)),
    entity_leg_size_median: median(rows.map((r) => pick(r).entity_leg_size).sort((a, b) => a - b)),
  })
  const summary = { base: summarise('base', (r) => r.base) }
  for (const t of THRESHOLDS) summary[`t${t}`] = summarise(`t${t}`, (r) => r.arms[`t${t}`])

  // ── merge audit: the 20 pairs with the highest member df, per threshold ──────
  const audit = {}
  for (const t of THRESHOLDS) {
    const dfOf = new Map(entities.map((e) => [e.name, e.df]))
    const sample = [...merged[t].pairs]
      .sort((a, b) => Math.max(dfOf.get(b.a) ?? 0, dfOf.get(b.b) ?? 0) - Math.max(dfOf.get(a.a) ?? 0, dfOf.get(a.b) ?? 0))
      .slice(0, AUDIT_SIZE)
      .map((p) => ({ ...p, df_a: dfOf.get(p.a) ?? 0, df_b: dfOf.get(p.b) ?? 0 }))
    audit[`t${t}`] = {
      pair_count: merged[t].pairs.length,
      cluster_count: merged[t].clusters.filter((c) => c.size > 1).length,
      sample,
    }
  }

  const base = summary.base
  /**
   * HAND JUDGEMENT of the 20-pair sample printed below, decided by reading the names (metadata, no
   * fact text). Kept as a constant so the audit number in the JSON is reproducible from this script
   * rather than asserted in prose. `over` lists the merges that collapse two genuinely DIFFERENT
   * things; case variants (DSH/dsh) and singular/plural forms (plugin/plugins) are accepted.
   */
  const OVER_MERGE_JUDGED = {
    't0.5': {
      over: [['npm', 'pnpm'], ['PNPM', 'npm'], ['base', 'base64'], ['avantf', 'avantfWork'], ['listPackages', 'packages'], ['packageId', 'packages']],
      rationale: 'different tools (npm vs pnpm) and different identifiers (base vs base64, an identifier vs its package name) collapsed by substring overlap',
    },
    't0.7': { over: [], rationale: 'the top-20 sample is case variants and singular/plural forms only' },
    't0.9': { over: [], rationale: 'only case variants merge at this threshold' },
  }
  for (const t of THRESHOLDS) {
    const j = OVER_MERGE_JUDGED[`t${t}`]
    audit[`t${t}`].sample_size = audit[`t${t}`].sample.length
    audit[`t${t}`].over_merge_judged = j.over
    audit[`t${t}`].over_merge_judgement = j.rationale
    audit[`t${t}`].over_merge_rate = audit[`t${t}`].sample.length === 0 ? null : L.round4(j.over.length / audit[`t${t}`].sample.length)
  }
  const verdicts = {}
  for (const t of THRESHOLDS) {
    const s = summary[`t${t}`]
    const improved = s.top1_ok > base.top1_ok || s.top3_relevant_mean > base.top3_relevant_mean
    const rate = audit[`t${t}`].over_merge_rate
    verdicts[`t${t}`] = {
      improved,
      top1_delta: s.top1_ok - base.top1_ok,
      top3_delta: L.round4(s.top3_relevant_mean - base.top3_relevant_mean),
      over_merge_rate: rate,
      verdict: improved && rate !== null && rate < 0.05 ? 'adopt' : 'reject',
    }
  }

  console.log('bag width (raw) median', median(rawBagWidths), 'min', rawBagWidths[0], 'max', rawBagWidths[rawBagWidths.length - 1])
  console.log('summary', JSON.stringify(summary, null, 2))
  console.log('audit sample t0.5:')
  for (const p of audit['t0.5'].sample) console.log(`  ${p.a} (df ${p.df_a})  ~  ${p.b} (df ${p.df_b})  J=${p.jaccard}`)
  console.log('audit sample t0.7:')
  for (const p of audit['t0.7'].sample) console.log(`  ${p.a} (df ${p.df_a})  ~  ${p.b} (df ${p.df_b})  J=${p.jaccard}`)
  console.log('verdicts', JSON.stringify(verdicts, null, 2))

  L.writeJson(jsonOut, {
    card: 'A3',
    measured_at: new Date().toISOString(),
    node: process.version,
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: activeFacts, entities_total: entities.length, entities_with_active_facts: entities.filter((e) => e.df > 0).length },
    thresholds: THRESHOLDS,
    merge_rule: 'lowercased trigram Jaccard over entity names (names <3 chars contribute themselves), union-find, canonical = highest active df',
    bag_width: { raw_median: median(rawBagWidths), raw_min: rawBagWidths[0], raw_max: rawBagWidths[rawBagWidths.length - 1] },
    query_set: { two_char: twoChar, extra_entity_names: extra },
    identity: { checked: identity.length, passed: identity.length - idFail.length, failures: idFail },
    summary,
    rows,
    audit,
    verdicts,
    reproduction: 'node mem/scripts/spikes/bench-a3-entity-merge.mjs',
  })
  L.teardown(track)
}

await main()
