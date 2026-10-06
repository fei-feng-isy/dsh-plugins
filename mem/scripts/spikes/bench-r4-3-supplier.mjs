/**
 * R4-S3 · the B1 (caller-supplied structure) upper bound ON THE REAL CORPUS, split by shape.
 *
 * R3 measured the mechanism on a CONSTRUCTED corpus and concluded "the gain exists only on the
 * ALIAS shape; on the literal shape it is zero". This card replaces the construction with the live
 * corpus and the model's own shadow annotation: the supplied entity set is what a writing agent
 * actually produced for the fact (passes A / A-ext), the queries are reverse-derived (S4), and the
 * shape is classified per query (a query is ALIAS when the name it looks up does not occur in its
 * source fact's text).
 *
 * ARMS (each rewrites `fact_entities` on a TEMP snapshot copy — never the live store):
 *   A0      baseline (production bag); the "fields open, nothing supplied" twin must be byte-identical
 *   A2      the annotation's names replace the bag (facts outside the annotated sample keep production)
 *   A2x     A ∪ A-ext names (two independent canonical passes)
 *   A2norm  A2 with the supplied names mapped into the ENGINE's name space where a folded match exists
 *           (the contract-normalisation ceiling — R3 §3.1's warning)
 *   A5      merge: production ∪ caller (the additive reading; the union cannot shrink)
 *   A3-50/25/0  compliance = the per-fact coin keeps the caller structure; 0% must equal A0
 *
 * Usage: node mem/scripts/spikes/bench-r4-3-supplier.mjs [--json <path>]
 * PRIVACY: ids, counts, scores and ratios only; the query strings stay in /tmp.
 */
import { join } from 'node:path'
import * as R from './bench-r4-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round4-s3-supplier.json'))
const LIMIT = 5
const pct = (n, d) => (d ? L.round4(n / d) : null)
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)
const coin = (seed, index) => (((seed ^ Math.imul(index + 1, 2654435761)) >>> 0) % 1000) / 1000

function readState(snap) {
  const db = L.openReadOnly(snap)
  try {
    const facts = db.prepare("select fact_id id, content from facts where status='active' order by fact_id").all()
    const links = db.prepare(
      `select fe.fact_id id, e.name name from fact_entities fe join entities e on e.entity_id = fe.entity_id
         join facts f on f.fact_id = fe.fact_id where f.status='active'`,
    ).all()
    const bags = new Map()
    for (const r of links) {
      if (!bags.has(r.id)) bags.set(r.id, [])
      bags.get(r.id).push(r.name)
    }
    return { facts, bags }
  } finally {
    db.close()
  }
}

function rewriteBags(snap, ids, bags) {
  const db = L.openWritable(snap)
  const t0 = process.hrtime.bigint()
  let links = 0
  try {
    const del = db.prepare('DELETE FROM fact_entities WHERE fact_id = ?')
    const ensure = db.prepare('INSERT OR IGNORE INTO entities(name) VALUES (?)')
    const idOf = db.prepare('SELECT entity_id FROM entities WHERE name = ?')
    const link = db.prepare('INSERT OR IGNORE INTO fact_entities(fact_id, entity_id) VALUES (?, ?)')
    db.exec('BEGIN')
    for (const id of ids) {
      del.run(id)
      for (const n of bags.get(id) ?? []) {
        ensure.run(n)
        const row = idOf.get(n)
        if (row) { link.run(id, row.entity_id); links += 1 }
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* already gone */ }
    throw error
  } finally { db.close() }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, links }
}

const bagWidths = (snap) => {
  const db = L.openReadOnly(snap)
  try {
    const rows = db.prepare('select fact_id id, count(*) n from fact_entities group by fact_id').all()
    return new Map(rows.map((r) => [Number(r.id), Number(r.n)]))
  } finally { db.close() }
}

async function main() {
  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r43-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { facts, bags: prodBags } = readState(snap)
  const ids = facts.map((f) => f.id)
  const texts = new Map(facts.map((f) => [f.id, String(f.content)]))
  const track = { runtimes: [], dirs: [work], texts }
  R.banner('R4-S3 · caller-supplied structure on the real corpus', { active: ids.length })

  const qfile = R.readTmp('queries.json')
  // Query budget: every alias-shaped canonical query (the B1 population is small — keep all of
  // them), plus stratified samples of the literal forms, so 8 arms stay minutes not hours.
  const pick = (arr, n) => (arr.length <= n ? arr : arr.filter((_, i) => i % Math.ceil(arr.length / n) === 0).slice(0, n))
  const allQueries = [
    ...pick(qfile.queries.filter((q) => q.qualifies && q.form === 'entity'), 40),
    ...qfile.queries.filter((q) => q.qualifies && q.form === 'guard_no_time'),
    ...qfile.queries.filter((q) => q.qualifies && q.form === 'entity_canonical' && q.shape === 'alias'),
    ...pick(qfile.queries.filter((q) => q.qualifies && q.form === 'entity_canonical' && q.shape === 'literal'), 30),
  ].filter((q, i, a) => a.findIndex((x) => x.id === q.id) === i)
  const annA = R.readTmp('annot-a.json')
  let annAext = { facts: [] }
  try { annAext = R.readTmp('annot-a-ext.json') } catch { /* optional */ }

  const suppliedA = new Map(annA.facts.filter((f) => texts.has(f.id)).map((f) => [f.id, [...new Set(f.entities ?? [])]]))
  const suppliedX = new Map(suppliedA)
  for (const f of annAext.facts ?? []) {
    if (!texts.has(f.id)) continue
    suppliedX.set(f.id, [...new Set([...(suppliedX.get(f.id) ?? []), ...(f.entities ?? [])])])
  }

  // The engine-name-space mapping (the contract-normalisation step R3 flagged).
  const prodFold = new Map()
  for (const [id, names] of prodBags) for (const n of names) prodFold.set(R.normName(n), n)
  let mapped = 0
  let unmappedAlias = 0
  const normNames = new Map()
  for (const [id, names] of suppliedA) {
    const out = names.map((n) => {
      const hit = prodFold.get(R.normName(n))
      if (hit) { mapped += 1; return hit }
      if (!(texts.get(id) ?? '').includes(n)) unmappedAlias += 1
      return n
    })
    normNames.set(id, [...new Set(out)])
  }

  const armBag = (kind, seed = 0) => {
    const out = new Map()
    for (const id of ids) {
      const prod = [...new Set(prodBags.get(id) ?? [])]
      if (kind === 'A0') { out.set(id, prod); continue }
      const supplied = kind === 'A2x' ? suppliedX.get(id) : kind === 'A2norm' ? normNames.get(id) : suppliedA.get(id)
      if (kind.startsWith('A3')) {
        const kept = coin(seed, ids.indexOf(id)) < Number(kind.slice(3)) / 100
        out.set(id, kept && supplied ? supplied : prod)
        continue
      }
      if (!supplied) { out.set(id, prod); continue }
      if (kind === 'A5') out.set(id, [...new Set([...prod, ...supplied])])
      else out.set(id, supplied)
    }
    return out
  }

  const ARMS = [
    { id: 'A0', bags: armBag('A0') },
    { id: 'A2', bags: armBag('A2') },
    { id: 'A2x', bags: armBag('A2x') },
    { id: 'A2norm', bags: armBag('A2norm') },
    { id: 'A5', bags: armBag('A5') },
    { id: 'A3-50', bags: armBag('A3-50', 31050) },
    { id: 'A3-25', bags: armBag('A3-25', 31025) },
    { id: 'A3-0', bags: armBag('A3-0', 0) },
  ]

  // ── identity + default-unchanged, on the untouched production bag ─────────────────────────────
  const emb = await L.warmEmbedder()
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const identity = []
  const unchanged = []
  for (const q of allQueries) {
    identity.push(await L.identityCheck(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
    // The two-pass identity is over A0 only; the "fields open but nothing supplied" twin is A3-0 below.
  }
  const identityFailures = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - identityFailures.length}/${identity.length} pass`)

  // ── per-arm runs ──────────────────────────────────────────────────────────────────────────────
  const rows = []
  const armMeta = []
  for (const arm of ARMS) {
    const w = rewriteBags(snap, ids, arm.bags)
    const widths = bagWidths(snap)
    const goldWidths = []
    for (const q of allQueries) {
      const p = await L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
      const gold = q.gold ?? []
      const poolIds = new Set(p.pool.map((h) => h.id))
      const legs0 = p.perVariant?.[0]?.raw ?? null
      const legHasGold = legs0 ? {
        semantic: gold.some((g) => legs0.semantic.has(g)),
        jaccard: gold.some((g) => legs0.jaccard.has(g)),
        fts: gold.some((g) => legs0.fts.has(g)),
      } : null
      for (const g of gold) goldWidths.push(widths.get(g) ?? 0)
      rows.push({
        arm: arm.id, query_id: q.id, form: q.form, shape: q.shape, gold_total: gold.length,
        ids: p.ids, pool_size: p.pool.length,
        gold_in_top1: gold.length ? (gold.includes(p.ids[0]) ? 1 : 0) : null,
        gold_in_top3: gold.length ? p.ids.slice(0, 3).filter((x) => gold.includes(x)).length : null,
        gold_in_pool: gold.length ? gold.filter((x) => poolIds.has(x)).length : null,
        missing: gold.length ? gold.some((x) => !p.ids.includes(x)) : null,
        best_gold_rank: gold.length ? (() => { const r = p.ids.findIndex((x) => gold.includes(x)); return r === -1 ? null : r + 1 })() : null,
        candidates: legs0?.candidates?.length ?? null,
        anchors: legs0?.anchors?.length ?? null,
        leg_has_gold: legHasGold,
      })
    }
    const widthAll = [...widths.values()]
    armMeta.push({
      arm: arm.id, links_written: w.links, rewrite_ms: L.round4(w.ms),
      bag_width_median: median(widthAll),
      bag_width_median_gold: median(goldWidths),
    })
    console.log(`arm ${arm.id}: links ${w.links}, bag median ${median(widthAll)}, ${L.round4(w.ms)} ms`)
  }

  const summarize = (armId, form, shape) => {
    const rs = rows.filter((r) => r.arm === armId && (form === undefined || r.form === form) && (shape === undefined || r.shape === shape))
    const withGold = rs.filter((r) => r.gold_total > 0)
    return {
      queries: rs.length,
      gold_queries: withGold.length,
      gold_total: withGold.reduce((n, r) => n + r.gold_total, 0),
      top1_queries: withGold.filter((r) => r.gold_in_top1 === 1).length,
      top3_gold: withGold.reduce((n, r) => n + (r.gold_in_top3 ?? 0), 0),
      gold_in_pool: withGold.reduce((n, r) => n + (r.gold_in_pool ?? 0), 0),
      missing_queries: withGold.filter((r) => r.missing).length,
      mean_pool_size: rs.length ? L.round4(rs.reduce((n, r) => n + r.pool_size, 0) / rs.length) : null,
      mean_entity_candidates: rs.length ? L.round4(rs.reduce((n, r) => n + (r.candidates ?? 0), 0) / rs.length) : null,
      mean_anchors: rs.length ? L.round4(rs.reduce((n, r) => n + (r.anchors ?? 0), 0) / rs.length) : null,
    }
  }

  const legExplain = (armId, form, shape) => {
    const rs = rows.filter((r) => r.arm === armId && r.form === form && r.shape === shape && r.gold_total > 0)
    return {
      queries: rs.length,
      semantic_has_gold: rs.filter((r) => r.leg_has_gold?.semantic).length,
      jaccard_has_gold: rs.filter((r) => r.leg_has_gold?.jaccard).length,
      fts_has_gold: rs.filter((r) => r.leg_has_gold?.fts).length,
      answered_by_semantic_only: rs.filter((r) => r.leg_has_gold?.semantic && !r.leg_has_gold?.jaccard && !r.leg_has_gold?.fts).length,
      answered_by_fts_only: rs.filter((r) => r.leg_has_gold?.fts && !r.leg_has_gold?.jaccard && !r.leg_has_gold?.semantic).length,
    }
  }

  const groups = [
    ['all', undefined, undefined],
    ['entity_literal', 'entity', 'literal'],
    ['canonical_literal', 'entity_canonical', 'literal'],
    ['canonical_alias', 'entity_canonical', 'alias'],
    ['guard_no_time', 'guard_no_time', 'literal'],
  ]
  const summary = {}
  for (const [label, form, shape] of groups) {
    summary[label] = Object.fromEntries(ARMS.map((a) => [a.id, summarize(a.id, form, shape)]))
  }

  // ── assertions ────────────────────────────────────────────────────────────────────────────────
  const a0rows = rows.filter((r) => r.arm === 'A0')
  const a30rows = rows.filter((r) => r.arm === 'A3-0')
  const sameA0A30 = a0rows.every((r) => {
    const b = a30rows.find((x) => x.query_id === r.query_id)
    return b && JSON.stringify(r.ids) === JSON.stringify(b.ids)
  })
  const aliasQ = allQueries.filter((q) => q.shape === 'alias')
  const aliasA0 = summarize('A0', 'entity_canonical', 'alias')
  const aliasA2 = summarize('A2', 'entity_canonical', 'alias')
  const litA0 = summarize('A0', 'entity_canonical', 'literal')
  const litA2 = summarize('A2', 'entity_canonical', 'literal')

  const retention = (metric, shape, form) => {
    const a0 = summarize('A0', form, shape)[metric]
    const a2 = summarize('A2', form, shape)[metric]
    const a3 = summarize('A3-50', form, shape)[metric]
    const gain = a2 - a0
    return { a0, a2, a3_50: a3, gain: gain, retained_at_50: gain > 0 ? L.round4((a3 - a0) / gain) : null }
  }

  const out = {
    card: 'R4-S3',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { checked: identity.length, passed: identity.length - identityFailures.length, failures: identityFailures },
    design: {
      corpus: 'live snapshot, 85 active facts; supply from the shadow annotation (64 facts annotated)',
      arms: ARMS.map((a) => a.id),
      arm_semantics: {
        A0: 'production bag', A2: 'annotation-A names replace the bag',
        A2x: 'annotation A ∪ A-ext names', A2norm: 'A2 names mapped into the engine name space where a folded match exists',
        A5: 'production ∪ caller (union cannot shrink)',
        'A3-50/25/0': 'per-fact coin keeps the caller structure; 0% must equal A0',
      },
      query_forms: ['entity', 'entity_canonical', 'guard_no_time'],
      shapes: { literal: 'lookup name occurs in the source fact text', alias: 'it does not' },
      supply_normalization: {
        supplied_names: [...suppliedA.values()].reduce((n, v) => n + v.length, 0),
        mapped_into_engine_namespace: mapped,
        alias_names_left_unmapped: unmappedAlias,
        note: 'the engine-name-space mapping is the ceiling reading; the raw reading is A2',
      },
    },
    arms_meta: armMeta,
    summary,
    shape_population: {
      entity: allQueries.filter((q) => q.form === 'entity').length,
      canonical_literal: allQueries.filter((q) => q.form === 'entity_canonical' && q.shape === 'literal').length,
      canonical_alias: aliasQ.length,
      guard_no_time: allQueries.filter((q) => q.form === 'guard_no_time').length,
      alias_query_ids: aliasQ.map((q) => q.id),
    },
    assertions: {
      identity_passed: identity.length - identityFailures.length,
      identity_checked: identity.length,
      A3_0_equals_A0_ids: sameA0A30,
      union_not_narrowed_entity_literal: summary.entity_literal.A2.mean_pool_size >= summary.entity_literal.A0.mean_pool_size,
      union_not_narrowed_canonical_alias: summary.canonical_alias.A2.mean_pool_size >= summary.canonical_alias.A0.mean_pool_size,
    },
    retention: {
      canonical_alias_top3_gold: retention('top3_gold', 'alias', 'entity_canonical'),
      canonical_alias_gold_in_pool: retention('gold_in_pool', 'alias', 'entity_canonical'),
      canonical_alias_top1_queries: retention('top1_queries', 'alias', 'entity_canonical'),
      canonical_literal_top3_gold: retention('top3_gold', 'literal', 'entity_canonical'),
      entity_literal_top3_gold: retention('top3_gold', 'literal', 'entity'),
    },
    leg_attribution_A0: {
      canonical_alias: legExplain('A0', 'entity_canonical', 'alias'),
      canonical_literal: legExplain('A0', 'entity_canonical', 'literal'),
      entity_literal: legExplain('A0', 'entity', 'literal'),
      note: 'which production leg already carries the gold; the semantic leg is the candidate explanation for why the canonical-name gap does not bite',
    },
    verdict: {
      alias_population_n: aliasQ.length,
      alias_gold_in_pool_a0: aliasA0.gold_in_pool,
      alias_gold_in_pool_a2: aliasA2.gold_in_pool,
      alias_gold_total: aliasA2.gold_total,
      alias_candidates_a0: aliasA0.mean_entity_candidates,
      alias_candidates_a2: aliasA2.mean_entity_candidates,
      literal_gold_in_pool_a0: litA0.gold_in_pool,
      literal_gold_in_pool_a2: litA2.gold_in_pool,
      literal_gold_total: litA2.gold_total,
      literal_displacement: litA2.gold_in_pool - litA0.gold_in_pool,
    },
    rows,
    reproduction: 'node mem/scripts/spikes/bench-r4-3-supplier.mjs --json mem/docs/spikes/raw/round4-s3-supplier.json',
  }
  const whitelist = R.repoCjkWhitelist()
  out.privacy = R.auditArtifact(out, { cjkWhitelist: whitelist })
  if (!out.privacy.clean) {
    console.error('PRIVACY AUDIT FAILED', JSON.stringify(out.privacy).slice(0, 3000))
    process.exitCode = 1
  }
  L.writeJson(jsonOut, out)
  for (const [label] of groups) {
    console.log(`${label}:`, JSON.stringify(Object.fromEntries(ARMS.map((a) => {
      const s = summary[label][a.id]
      return [a.id, `${s.top1_queries}/${s.gold_queries} top3=${s.top3_gold}/${s.gold_total} pool=${s.gold_in_pool} miss=${s.missing_queries} cand=${s.mean_entity_candidates}`]
    })), null, 1))
  }
  console.log('assertions:', JSON.stringify(out.assertions))
  console.log('verdict:', JSON.stringify(out.verdict))
  L.teardown(track)
}

main()
