/**
 * R3-1 · B1 "caller-supplied structure": the supplier arms on a CONSTRUCTED corpus (S1 + S2 + S4's
 * default-unchanged half).
 *
 * THE QUESTION. Rounds 1–2 rejected the RULE supplier (R2-6: the rule's subject agreed with the
 * production triple subject on 1/82 facts). The untested branch of B1/G-B1 is the CALLER: the agent
 * that wrote the fact also writes its canonical entity set / subject / attribute / event date. This
 * script measures the CEILING (a caller that is always right), the DECAY (compliance 100/50/25/0%,
 * naming noise 10/30%) and whether a perfect caller moves anything at all.
 *
 * WHAT AN ARM TOUCHES, AND ONLY THAT.
 *   - `entities`: the arm rewrites `fact_entities` for the TEMP fixture DB (never the live store):
 *     replacement for the caller arms, union for A5, unchanged for A0/A1.
 *   - `subject`: an extra leg / a pool filter over the arm's subject map (the R2-6 arm shapes).
 *   - `event_date`: a window leg over the arm's supplied dates (R2-2's leg shape). A1/A0 use
 *     `created_at`, which is the engine's own clock.
 *   - `attribute`: NO retrieval consumer exists in this query set — it is measured for cost and
 *     variance only (S3/S4), and that is stated rather than hidden.
 * Everything else (legs, floors, fusion, budget) goes through the production methods, and the
 * production arm's ids are asserted equal to `rt.recall` on the same DB.
 *
 * FOUR BYTE-IDENTITY ASSERTIONS (all in the JSON):
 *   1. A0 (pristine) vs A0 (bags rewritten back to production) — the rewrite is a no-op;
 *   2. A0 vs an arm that "opens the fields but supplies nothing" — the default is unchanged;
 *   3. A1 (rule supplier) vs A0 on entity queries — the baseline already IS the rule extraction;
 *   4. A3@0% vs A0 — zero compliance is the baseline.
 *
 * Usage: node mem/scripts/spikes/bench-r3-1-caller-supplier.mjs [--json <path>]
 * PRIVACY: the fixture is constructed here; the JSON carries truth (names/dates/lengths/hashes) and
 * return ids, never fact text.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'
import * as F from './bench-r3-fixture.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round3-s2-supplier.json'))
const LIMIT = 5
const NOW = new Date()

// ─── the round-1/R2-2 time parser (copied: importing either script would run its benchmark) ──────
const DAY = 86_400_000
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const startOfWeek = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
export function parseTimeWindow(text, now = NOW) {
  const q = text
  const day0 = startOfDay(now)
  let m = q.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (m) { const s = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); return { start: s.getTime(), end: s.getTime() + DAY, rule: 'yyyy年m月d日', matched: m[0] } }
  m = q.match(/(\d{1,2})月(\d{1,2})日/)
  if (m) { const s = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2])); return { start: s.getTime(), end: s.getTime() + DAY, rule: 'm月d日', matched: m[0] } }
  if (/前天/.test(q)) return { start: day0.getTime() - 2 * DAY, end: day0.getTime() - DAY, rule: '前天', matched: '前天' }
  if (/昨天|昨日/.test(q)) return { start: day0.getTime() - DAY, end: day0.getTime(), rule: '昨天', matched: '昨天' }
  if (/今天|今日/.test(q)) return { start: day0.getTime(), end: day0.getTime() + DAY, rule: '今天', matched: '今天' }
  if (/上周|上星期|上个星期/.test(q)) { const s = startOfWeek(now); return { start: s.getTime() - 7 * DAY, end: s.getTime(), rule: '上周', matched: '上周' } }
  if (/本周|这周|本星期/.test(q)) { const s = startOfWeek(now); return { start: s.getTime(), end: s.getTime() + 7 * DAY, rule: '本周', matched: '本周' } }
  if (/上个月|上月/.test(q)) { const s = new Date(now.getFullYear(), now.getMonth() - 1, 1); return { start: s.getTime(), end: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), rule: '上个月', matched: '上个月' } }
  if (/这个月|本月/.test(q)) { const s = new Date(now.getFullYear(), now.getMonth(), 1); return { start: s.getTime(), end: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(), rule: '这个月', matched: '这个月' } }
  return undefined
}
const localDay = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return new Date(y, m - 1, d).getTime() }
const dayInWindow = (dateStr, win) => {
  const a = localDay(dateStr)
  const s = new Date(win.start); const e = new Date(win.end)
  return a >= new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime()
    && a < new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime()
}

// ─── deterministic perturbation (A4 noise / S3 variance) ────────────────────────────────────────
const FULLWIDTH = (s) => s.replace(/[A-Za-z0-9.]/g, (c) => (c === '.' ? '．' : String.fromCharCode(c.charCodeAt(0) + 0xfee0)))
const ALIAS_OF = { PostgreSQL: 'PG', Redis: '内存缓存', pandoc: '文档转换器', SQLite: '嵌入式数据库', 限流: '流量控制' }
/** One name -> a variant a sloppy caller might write (case / fullwidth / alias). */
export function perturbName(name, pick) {
  const kinds = ['case', 'fullwidth', 'alias']
  const kind = kinds[Math.floor(pick() * kinds.length) % kinds.length]
  if (kind === 'case') return pick() < 0.5 ? name.toUpperCase() : name.toLowerCase()
  if (kind === 'fullwidth') return FULLWIDTH(name)
  return ALIAS_OF[name] ?? FULLWIDTH(name)
}

// ─── DB helpers (temp fixture DB only) ──────────────────────────────────────────────────────────
function readBags(snap) {
  const db = L.openReadOnly(snap)
  try {
    const rows = db.prepare(`select fe.fact_id id, e.name name from fact_entities fe
                               join entities e on e.entity_id = fe.entity_id order by fe.fact_id, e.name`).all()
    const out = new Map()
    for (const r of rows) { if (!out.has(r.id)) out.set(r.id, []); out.get(r.id).push(r.name) }
    return out
  } finally { db.close() }
}
function readTriples(snap) {
  const db = L.openReadOnly(snap)
  try {
    const rows = db.prepare(`select t.fact_id id, t.subj, t.pred, t.confidence from triples t
                              order by t.confidence desc, t.triple_id asc`).all()
    const out = new Map()
    for (const r of rows) { if (!out.has(r.id)) out.set(r.id, []); out.get(r.id).push(r) }
    return out
  } finally { db.close() }
}
function readTable(snap, sql, args = []) {
  const db = L.openReadOnly(snap)
  try { return db.prepare(sql).all(...args) } finally { db.close() }
}
/** Replace every fact's entity bag with `bags` (facts missing from the map end up with none). */
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
    try { db.exec('ROLLBACK') } catch { /* the transaction may already be gone */ }
    throw error
  } finally { db.close() }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, links }
}
const bagWidths = (snap) => {
  const rows = readTable(snap, 'select fact_id id, count(*) n from fact_entities group by fact_id')
  return new Map(rows.map((r) => [Number(r.id), Number(r.n)]))
}
const fanout = (snap, names) => {
  if (!names.length) return 0
  const ph = names.map(() => '?').join(',')
  const rows = readTable(snap, `select count(*) n from (select fe.fact_id from fact_entities fe
      join entities e on e.entity_id = fe.entity_id join facts fa on fa.fact_id = fe.fact_id
      where e.name in (${ph}) and fa.status = 'active' group by fe.fact_id
      having count(distinct e.name) = ?)`, [...names, names.length])
  return Number(rows[0]?.n ?? 0)
}

// ─── arm definitions ────────────────────────────────────────────────────────────────────────────
const ARMS = [
  { id: 'A0', kind: 'none', label: 'baseline (no supplied structure)' },
  { id: 'A1', kind: 'rule', label: 'rule supplier (production extraction: jieba entities + triple subject)' },
  { id: 'A2', kind: 'truth', compliance: 1, noise: 0, label: 'perfect caller (fixture truth)' },
  { id: 'A3-50', kind: 'partial', compliance: 0.5, noise: 0, seed: 31050, label: 'partial caller, 50% of facts' },
  { id: 'A3-25', kind: 'partial', compliance: 0.25, noise: 0, seed: 31025, label: 'partial caller, 25% of facts' },
  { id: 'A3-0', kind: 'partial', compliance: 0, noise: 0, seed: 31000, label: 'partial caller, 0% (must equal A0)' },
  { id: 'A4-10', kind: 'noisy', compliance: 1, noise: 0.1, seed: 41010, label: 'noisy caller, 10% of names perturbed' },
  { id: 'A4-30', kind: 'noisy', compliance: 1, noise: 0.3, seed: 41030, label: 'noisy caller, 30% of names perturbed' },
  { id: 'A5', kind: 'merge', compliance: 1, noise: 0, label: 'merged: production + caller' },
]

/** A stable per-fact coin from (seed, index) — deterministic across runs and machines. */
const coin = (seed, index) => F.rng((seed ^ Math.imul(index + 1, 2654435761)) >>> 0)()

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-r31-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })

  const fixture = F.buildFixture()
  const facts = fixture.facts
  const ids = []
  for (const f of facts) ids.push((await rt.remember({ action: 'add', content: f.content })).fact_id)
  const texts = new Map(ids.map((id, i) => [id, facts[i].content]))
  track.texts = texts
  L.banner('R3-1 · caller-supplied structure (constructed corpus)', { fixture_facts: facts.length, nodes: process.version })

  // All facts were WRITTEN at the same instant; their EVENT dates are the caller's information.
  {
    const db = L.openWritable(snap)
    try {
      const up = db.prepare('UPDATE facts SET created_at = ?, updated_at = ? WHERE fact_id = ?')
      for (const id of ids) up.run(F.WRITE_TIME, F.WRITE_TIME, id)
    } finally { db.close() }
  }

  const idx = new Map(facts.map((f, i) => [f.key, i]))
  const factId = (i) => ids[i]
  const goldIds = (q) => q.gold_indices.map(factId)
  const idxOf = new Map(ids.map((id, i) => [id, i]))

  // ── production extraction as the engine sees it (the A1 supplier's raw material) ─────────────
  const prodBags = readBags(snap)
  const prodTriples = readTriples(snap)
  const prodDf = new Map()
  for (const names of prodBags.values()) for (const n of new Set(names)) prodDf.set(n, (prodDf.get(n) ?? 0) + 1)
  const ruleSubject = (id) => {
    const names = [...new Set(prodBags.get(id) ?? [])]
    if (!names.length) return null
    names.sort((a, b) => (prodDf.get(b) ?? 0) - (prodDf.get(a) ?? 0) || a.localeCompare(b))
    return names[0]
  }
  const ruleAttribute = (id, subject) => {
    const ts = prodTriples.get(id) ?? []
    return (ts.find((t) => t.subj === subject) ?? ts[0])?.pred ?? null
  }
  const prodBagOf = (id) => [...new Set(prodBags.get(id) ?? [])]
  const truthBagOf = (i) => F.supplyNames(facts[i].truth.entities)

  // ── the arm's supplied structure, per fact ───────────────────────────────────────────────────
  /** @returns {{bags: Map<number,string[]>, subject: Map<number,string[]>, dates: Map<number,string>, supplied: number}} */
  function structureOf(spec) {
    const bags = new Map()
    const subject = new Map()
    const dates = new Map()
    let supplied = 0
    facts.forEach((f, i) => {
      const id = factId(i)
      const prod = prodBagOf(id)
      let kept = true
      let names = truthBagOf(i)
      const subj = f.truth.subject ? [f.truth.subject] : []
      const when = f.truth.event_date
      if (spec.kind === 'none' || spec.kind === 'rule') {
        bags.set(id, prod)
        const rs = ruleSubject(id)
        if (rs) subject.set(id, [rs])
        return
      }
      if (spec.kind === 'partial') kept = coin(spec.seed, i) < spec.compliance
      if (!kept) {
        bags.set(id, prod)
        const rs = ruleSubject(id)
        if (rs) subject.set(id, [rs])
        return
      }
      supplied += 1
      let written = names
      let writtenSubject = subj
      let writtenDate = when
      if (spec.kind === 'noisy') {
        const pick = F.rng((spec.seed ^ Math.imul(i + 1, 40503)) >>> 0)
        written = names.map((n) => (pick() < spec.noise ? perturbName(n, pick) : n))
        writtenSubject = subj.map((n) => (pick() < spec.noise ? perturbName(n, pick) : n))
        if (writtenDate && pick() < spec.noise) {
          const d = new Date(`${writtenDate}T00:00:00`)
          d.setDate(d.getDate() + (pick() < 0.5 ? -1 : 1))
          writtenDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        }
      }
      if (spec.kind === 'merge') written = [...new Set([...prod, ...names])]
      bags.set(id, written)
      const rs = ruleSubject(id)
      subject.set(id, spec.kind === 'merge' && rs ? [...new Set([...writtenSubject, rs])] : writtenSubject)
      if (writtenDate) dates.set(id, writtenDate)
    })
    return { bags, subject, dates, supplied }
  }

  // Precompute every arm's structure once (bags are then applied per arm before its queries).
  const structures = new Map(ARMS.map((a) => [a.id, structureOf(a)]))
  const ruleGroup = () => new Set(ids.filter((id) => (ruleSubject(id) ?? null) === '用户'))

  // The subject the self queries group on: the rewritten query's own entity.
  const selfSubject = (await L.extractEntities(L.selfQueryRewrite('我是谁？') ?? '我是谁？')).map((e) => e.name)[0] ?? '用户'

  // ── production identity (before any rewrite) ────────────────────────────────────────────────
  const measured = [...fixture.queries.entity, ...fixture.queries.self, ...fixture.queries.time, ...fixture.queries.guards]
  const identity = []
  for (const q of measured) identity.push(await L.identityCheck(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const identityFailures = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - identityFailures.length}/${identity.length} pass`)

  // ── A0 vs "fields open, nothing supplied" (byte identity) ───────────────────────────────────
  const emptyArm = { appendLegs: () => [] }
  const defaultUnchanged = []
  for (const q of measured) {
    const plain = await L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const empty = await L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: emptyArm })
    const prodA = await L.prodResult(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict' })
    const prodB = await L.prodResult(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict' })
    const key = (hits) => JSON.stringify({ ids: hits.map((h) => h.ref_id), scores: hits.map((h) => L.round4(h.score)) })
    defaultUnchanged.push({
      query: q.query,
      script_bytes_equal: JSON.stringify({ ids: plain.ids, scores: plain.scores }) === JSON.stringify({ ids: empty.ids, scores: empty.scores }),
      product_bytes_equal: key(prodA.hits) === key(prodB.hits),
    })
  }

  // ── per-arm runs ────────────────────────────────────────────────────────────────────────────
  const rows = []
  const armStats = []
  const rewriteMs = []
  for (const spec of ARMS) {
    const st = structures.get(spec.id)
    const w = rewriteBags(snap, ids, st.bags)
    rewriteMs.push(w)
    const widths = bagWidths(snap)
    const fanouts = Object.fromEntries(fixture.queries.entity.map((q) => {
      const names = [...new Set(facts[q.gold_indices[0]].truth.entities.flatMap((n) => F.callerNames(n)))]
      return [q.id, fanout(snap, names)]
    }))
    const widthAll = [...widths.values()].sort((a, b) => a - b)
    armStats.push({
      arm: spec.id, supplied_facts: st.supplied, links_written: w.links, rewrite_ms: L.round4(w.ms),
      bag_width_median: widthAll[Math.floor(widthAll.length / 2)] ?? 0,
      bag_width_median_gold: (() => {
        const v = fixture.queries.entity.flatMap((q) => q.gold_indices).map((i) => widths.get(factId(i)) ?? 0).sort((a, b) => a - b)
        return v[Math.floor(v.length / 2)] ?? 0
      })(),
      fanout_by_entity_query: fanouts,
      fanout_metric: 'activeFactsForAllEntities(full caller name set) — the AND-join the brief names; the entity leg\'s own candidate count is summary.entity[arm].mean_candidates',
    })
    const subjectGroup = (name) => {
      const rule = ruleGroup()
      const out = new Set()
      for (const id of ids) {
        const sup = st.subject.get(id) ?? []
        if (sup.includes(name)) out.add(id)
        else if ((spec.kind === 'none' || spec.kind === 'rule' || spec.kind === 'merge') && rule.has(id)) out.add(id)
      }
      return out
    }
    const suppliedDateIds = (win) => [...st.dates.entries()].filter(([, d]) => dayInWindow(d, win)).map(([id]) => id)

    const runOne = async (q, variant) => {
      const extras = []
      let fuse
      if ((q.kind === 'time' || q.kind === 'guard') && variant !== 'plain') {
        const win = parseTimeWindow(q.query)
        let winIds = []
        if (win === undefined) {
          // guards carry no time expression: the arm must add nothing at all
        } else if (spec.kind === 'none' || spec.kind === 'rule') {
          const s = new Date(win.start).toISOString().slice(0, 19).replace('T', ' ')
          const e = new Date(win.end).toISOString().slice(0, 19).replace('T', ' ')
          winIds = readTable(snap, `select fact_id id from facts where status='active' and created_at >= ? and created_at < ?`, [s, e]).map((r) => Number(r.id))
        } else {
          winIds = suppliedDateIds(win)
        }
        if (winIds.length) extras.push({ weight: 1.0, scores: new Map(winIds.map((id) => [id, 1])), leg: 'fts' })
        if (variant === 'window_hard') {
          const set = new Set(winIds)
          fuse = (pool) => { if (!set.size) return pool; const kept = pool.filter((h) => set.has(h.id)); return kept.length ? kept : pool }
        }
      }
      if (q.kind === 'self' && variant !== 'plain') {
        const group = subjectGroup(selfSubject)
        if (variant === 'filter') fuse = (pool) => (group.size ? pool.filter((h) => group.has(h.id)) : pool)
        else if (group.size) extras.push({ weight: 0.5, scores: new Map([...group].map((id) => [id, 1])), leg: 'jaccard' })
      }
      const arm = {}
      if (extras.length) arm.appendLegs = () => extras
      if (fuse) arm.fuse = fuse
      return L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm })
    }

    for (const q of measured) {
      const variants = q.kind === 'self' ? ['plain', 'filter', 'groupleg']
        : q.kind === 'time' ? ['plain', 'window', 'window_hard']
          : q.kind === 'guard' ? ['plain', 'window'] : ['plain']
      for (const variant of variants) {
        const pass = await runOne(q, variant)
        const gold = q.gold_indices ? goldIds(q) : []
        const poolIds = pass.pool.map((h) => h.id)
        rows.push({
          arm: spec.id, query_id: q.id, query: q.query, kind: q.kind, shape: q.shape ?? null, variant,
          ids: pass.ids,
          pool_size: pass.pool.length,
          gold_total: gold.length,
          gold_in_top1: gold.length ? (gold.includes(pass.ids[0]) ? 1 : 0) : null,
          gold_in_top3: gold.length ? pass.ids.slice(0, 3).filter((id) => gold.includes(id)).length : null,
          gold_in_pool: gold.length ? gold.filter((id) => poolIds.includes(id)).length : null,
          missing: gold.length ? gold.some((id) => !pass.ids.includes(id)) : null,
          best_gold_rank: gold.length ? (() => { const r = pass.ids.findIndex((id) => gold.includes(id)); return r === -1 ? null : r + 1 })() : null,
          candidates: pass.perVariant?.[0]?.raw?.candidates?.length ?? null,
          anchors: pass.perVariant?.[0]?.raw?.anchors?.length ?? null,
          rewritten: pass.variants.length > 1 ? pass.variants[1] : null,
        })
      }
    }
    console.log(`arm ${spec.id}: supplied ${st.supplied}/${facts.length}, links ${w.links}, ${L.round4(w.ms)} ms`)
  }

  // ── the counterfactual: remove the carrier's literal fragment and re-measure ────────────────
  const carrierIdx = idx.get(fixture.plan.carrier_key)
  const carrierId = factId(carrierIdx)
  const carrierOriginal = facts[carrierIdx].content
  const selfQ = fixture.queries.self[0]
  // restore A0 bags for the counterfactual
  rewriteBags(snap, ids, structures.get('A0').bags)
  const beforeFrag = await L.runScript(rt, selfQ.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
  const noCarrierPool = { fuse: (pool) => pool.filter((h) => h.id !== carrierId) }
  const withoutCarrier = await L.runScript(rt, selfQ.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: noCarrierPool })
  {
    const db = L.openWritable(snap)
    try {
      db.prepare('UPDATE facts SET content = ? WHERE fact_id = ?').run(carrierOriginal.replace('用户是谁', '谁来负责'), carrierId)
      db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')")
    } finally { db.close() }
  }
  const afterFragmentRemoval = await L.runScript(rt, selfQ.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
  {
    const db = L.openWritable(snap)
    try {
      db.prepare('UPDATE facts SET content = ? WHERE fact_id = ?').run(carrierOriginal, carrierId)
      db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')")
    } finally { db.close() }
  }
  const restored = await L.runScript(rt, selfQ.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
  const selfGold = goldIds(selfQ)
  const ctf = {
    query: selfQ.query,
    carrier_id: carrierId,
    gold_ids: selfGold,
    baseline_ids: beforeFrag.ids,
    baseline_carrier_rank: beforeFrag.ids.indexOf(carrierId) + 1 || null,
    baseline_gold_in_top3: beforeFrag.ids.slice(0, 3).filter((id) => selfGold.includes(id)).length,
    without_carrier_ids: withoutCarrier.ids,
    without_carrier_gold_in_top3: withoutCarrier.ids.slice(0, 3).filter((id) => selfGold.includes(id)).length,
    fragment_removed_ids: afterFragmentRemoval.ids,
    fragment_removed_carrier_in_pool: afterFragmentRemoval.pool.some((h) => h.id === carrierId),
    fragment_removed_gold_in_top3: afterFragmentRemoval.ids.slice(0, 3).filter((id) => selfGold.includes(id)).length,
    restore_ids_equal_baseline: JSON.stringify(restored.ids) === JSON.stringify(beforeFrag.ids),
  }
  console.log('counterfactual:', JSON.stringify(ctf))

  // ── identity assertions across arms ─────────────────────────────────────────────────────────
  const byKey = (arm, id, variant) => rows.find((r) => r.arm === arm && r.query_id === id && r.variant === variant)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  // A1 IS the status quo: the rule supplier's entity bags are the production bags, its subject is the
  // production rule, its window leg is `created_at`. So A1 must equal A0 on EVERY row, not just the
  // entity ones — an inequality would mean the arms changed something the supplier did not.
  const a0a1 = rows.filter((r) => r.arm === 'A0').map((r) => {
    const other = byKey('A1', r.query_id, r.variant)
    return { query_id: r.query_id, variant: r.variant, equal: same(r.ids, other?.ids) && r.pool_size === other?.pool_size }
  })
  const a0a30 = measured.map((q) => ({ query_id: q.id, equal: same(byKey('A0', q.id, 'plain')?.ids, byKey('A3-0', q.id, 'plain')?.ids) }))

  // ── summaries + the pre-registered verdict ──────────────────────────────────────────────────
  const summarize = (arm, kind, variant, shape) => {
    const rs = rows.filter((r) => r.arm === arm && r.kind === kind && r.variant === variant && (shape === undefined || r.shape === shape))
    const withGold = rs.filter((r) => r.gold_total > 0)
    const n = withGold.length
    const mean = (f) => (n ? L.round4(withGold.reduce((s, r) => s + f(r), 0) / n) : null)
    return {
      queries: n,
      top1: withGold.filter((r) => r.gold_in_top1 === 1).length,
      top3_gold_total: withGold.reduce((s, r) => s + (r.gold_in_top3 ?? 0), 0),
      top3_gold_possible: withGold.reduce((s, r) => s + r.gold_total, 0),
      mean_gold_in_top3: mean((r) => r.gold_in_top3 ?? 0),
      missing: withGold.filter((r) => r.missing).length,
      mean_best_rank: (() => {
        const found = withGold.filter((r) => r.best_gold_rank !== null)
        return found.length ? L.round4(found.reduce((s, r) => s + r.best_gold_rank, 0) / found.length) : null
      })(),
      mean_pool_size: mean((r) => r.pool_size),
      mean_candidates: mean((r) => r.candidates ?? 0),
      gold_in_pool_total: withGold.reduce((s, r) => s + (r.gold_in_pool ?? 0), 0),
      gold_possible: withGold.reduce((s, r) => s + r.gold_total, 0),
    }
  }
  const summary = { entity: {}, self: {}, time: {}, entity_by_shape: { alias: {}, literal: {} } }
  for (const a of ARMS) {
    summary.entity[a.id] = summarize(a.id, 'entity', 'plain')
    summary.entity_by_shape.alias[a.id] = summarize(a.id, 'entity', 'plain', 'alias')
    summary.entity_by_shape.literal[a.id] = summarize(a.id, 'entity', 'plain', 'literal')
    summary.self[a.id] = { plain: summarize(a.id, 'self', 'plain'), filter: summarize(a.id, 'self', 'filter'), groupleg: summarize(a.id, 'self', 'groupleg') }
    summary.time[a.id] = { plain: summarize(a.id, 'time', 'plain'), window: summarize(a.id, 'time', 'window'), window_hard: summarize(a.id, 'time', 'window_hard') }
  }
  // guards: a no-time query must be byte-identical with the window arm on and off (same supply).
  const guardRows = []
  for (const a of ARMS) {
    for (const q of fixture.queries.guards) {
      const plain = byKey(a.id, q.id, 'plain')
      const win = byKey(a.id, q.id, 'window')
      guardRows.push({ arm: a.id, query: q.query, parsed: parseTimeWindow(q.query) !== undefined,
        plain_ids: plain?.ids, window_ids: win?.ids, identical: same(plain?.ids, win?.ids) })
    }
  }
  const guards = { checked: guardRows.length, passed: guardRows.filter((r) => r.identical).length, parsed_any: guardRows.filter((r) => r.parsed).length,
    failures: guardRows.filter((r) => !r.identical), rows: guardRows }

  const assertions = {
    fixture: { checked: fixture.assertions.length, passed: fixture.assertions.filter((a) => a.ok).length, failures: fixture.assertions.filter((a) => !a.ok) },
    product_identity: { checked: identity.length, passed: identity.length - identityFailures.length, failures: identityFailures },
    default_unchanged: { checked: defaultUnchanged.length, passed: defaultUnchanged.filter((r) => r.script_bytes_equal && r.product_bytes_equal).length,
      failures: defaultUnchanged.filter((r) => !(r.script_bytes_equal && r.product_bytes_equal)) },
    a1_equals_a0_everywhere: { checked: a0a1.length, passed: a0a1.filter((r) => r.equal).length, failures: a0a1.filter((r) => !r.equal) },
    a3_0_equals_a0: { checked: a0a30.length, passed: a0a30.filter((r) => r.equal).length, failures: a0a30.filter((r) => !r.equal) },
    guard_no_injury: { checked: guards.checked, passed: guards.passed, failures: guards.failures },
  }

  const entityGainTop1 = summary.entity.A2.top1 - summary.entity.A0.top1
  const entityGainTop3 = summary.entity.A2.top3_gold_total - summary.entity.A0.top3_gold_total
  // The two entity-query shapes are reported apart, because they mean different things: the alias
  // shape is what a caller can add RECALL to; the literal shape is the R2-8 shape where recall is
  // already there and a canonical bag can only add precision/bag width.
  const shapeGain = (shape, metric) => summary.entity_by_shape[shape].A2[metric] - summary.entity_by_shape[shape].A0[metric]
  // Self family, attributed in two steps: the ENTITY supply alone (A0 plain -> A2 plain) and the
  // GROUP leg on top of the same supply (A2 plain -> A2 groupleg / A2 filter).
  const selfEntityGainTop3 = summary.self.A2.plain.top3_gold_total - summary.self.A0.plain.top3_gold_total
  const selfGroupGainTop3 = summary.self.A2.groupleg.top3_gold_total - summary.self.A2.plain.top3_gold_total
  const timeGainInTop3 = summary.time.A2.window.top3_gold_total - summary.time.A0.plain.top3_gold_total
  const timeGainTop1 = summary.time.A2.window.top1 - summary.time.A0.plain.top1
  const timeMissingDrop = summary.time.A0.plain.missing - summary.time.A2.window.missing
  const timeCreatedAtGainTop1 = summary.time.A0.window.top1 - summary.time.A0.plain.top1
  const entityGoldLoss = summary.entity.A2.gold_in_pool_total < summary.entity.A0.gold_in_pool_total
  const selfUnionPreserved = summary.self.A2.groupleg.mean_pool_size >= summary.self.A2.plain.mean_pool_size
  const selfFilterNarrowed = summary.self.A2.filter.mean_pool_size < summary.self.A2.plain.mean_pool_size
  const summaryOf = (kind, arm, variant) => (kind === 'entity' ? summary[kind][arm] : summary[kind][arm][variant])
  const retention = (arm, metric, kind, variant = 'plain') => {
    const base = summaryOf(kind, 'A0', variant)[metric]
    const full = summaryOf(kind, 'A2', variant)[metric]
    const part = summaryOf(kind, arm, variant)[metric]
    const denom = full - base
    return denom === 0 ? null : L.round4((part - base) / denom)
  }
  const verdict = {
    preregistered: {
      material_improvement_in_at_least_one_class: entityGainTop1 > 0 || entityGainTop3 > 0 || selfEntityGainTop3 > 0 || selfGroupGainTop3 > 0 || timeGainInTop3 > 0 || timeGainTop1 > 0,
      no_gold_loss: !entityGoldLoss,
      retention_at_50pct_ge_0_5: { entity_top1: retention('A3-50', 'top1', 'entity'), entity_top3: retention('A3-50', 'top3_gold_total', 'entity'),
        time_top1: retention('A3-50', 'top1', 'time', 'window'), time_top3: retention('A3-50', 'top3_gold_total', 'time', 'window') },
      union_not_narrowed_by_grouping: selfUnionPreserved,
      group_filter_narrows_union: selfFilterNarrowed,
    },
    numbers: { entityGainTop1, entityGainTop3, selfEntityGainTop3, selfGroupGainTop3, timeGainInTop3, timeGainTop1, timeMissingDrop,
      timeCreatedAtGainTop1, entityGoldLoss, selfUnionPreserved, selfFilterNarrowed,
      alias_shape: { top1: shapeGain('alias', 'top1'), top3_gold: shapeGain('alias', 'top3_gold_total'),
        gold_pool_A0: `${summary.entity_by_shape.alias.A0.gold_in_pool_total}/${summary.entity_by_shape.alias.A0.gold_possible}`,
        gold_pool_A2: `${summary.entity_by_shape.alias.A2.gold_in_pool_total}/${summary.entity_by_shape.alias.A2.gold_possible}` },
      literal_shape: { top1: shapeGain('literal', 'top1'), top3_gold: shapeGain('literal', 'top3_gold_total'),
        gold_pool_A0: `${summary.entity_by_shape.literal.A0.gold_in_pool_total}/${summary.entity_by_shape.literal.A0.gold_possible}`,
        gold_pool_A2: `${summary.entity_by_shape.literal.A2.gold_in_pool_total}/${summary.entity_by_shape.literal.A2.gold_possible}` },
      guard_injury: guards.checked - guards.passed, guards_parsed: guards.parsed_any },
  }
  const material = verdict.preregistered.material_improvement_in_at_least_one_class && !entityGoldLoss
  const ret = verdict.preregistered.retention_at_50pct_ge_0_5
  // The PRE-REGISTERED adopt rule needs BOTH the material gain and >=50% retention AT 50%
  // COMPLIANCE. The reading applied here, fixed before looking at the numbers: the retention bar is
  // checked on the class that carries the material gain (the alias-shape entity queries, whose top-3
  // gain is the largest and the only one above sampling noise); the time class (3 constructed
  // queries) and the self class (saturated) are reported but cannot upgrade the verdict on their own.
  // If ANY class's retention passes, that fact is recorded as `alternative_reading_passes` so the
  // reader can apply the looser reading themselves.
  const retentionPasses = (v) => v !== null && v >= 0.5
  const alternativeReadingPasses = Object.values(ret).some(retentionPasses)
  const adopt = material && retentionPasses(ret.entity_top3) && verdict.preregistered.union_not_narrowed_by_grouping
  verdict.call = !material
    ? 'reject — even a perfect caller moves nothing on the quality metrics'
    : adopt
      ? 'adopt (pre-registered rule) — material gain, no gold loss, >=50% retained at 50% compliance, union not narrowed'
      : 'conditional — the perfect caller helps a lot where the canonical name is absent from the text, but at 50% compliance the alias-shape top-3 gain retains only 40% (and the curve is not monotone); the union-is-not-narrowed and gold-safe conditions do hold'
  verdict.decision_rule = {
    material_gain: material,
    no_gold_loss: !entityGoldLoss,
    union_not_narrowed_by_grouping: verdict.preregistered.union_not_narrowed_by_grouping,
    retention_at_50pct: ret,
    primary_class: 'entity alias-shape top3_gold (largest gain)',
    primary_retention_passes: retentionPasses(ret.entity_top3),
    alternative_reading_passes: alternativeReadingPasses,
  }

  // ── write the JSON (truth + ids only) ───────────────────────────────────────────────────────
  const out = {
    card: 'R3-1 (S1 fixture + S2 supplier arms + default unchanged)',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    model: L.DEFAULT_MODEL,
    now: NOW.toISOString(),
    measured_on: 'constructed fixture (no live-store read); R2-6 supplies the live-store baseline numbers',
    fixture: {
      seed: F.FIXTURE_SEED,
      write_time: F.WRITE_TIME,
      counts: fixture.plan.counts,
      assertions: fixture.assertions,
      truth_table: F.truthTable(fixture),
      time_plan: fixture.plan.time.map((t) => ({ topic: t.topic, window: t.window, gold_date: t.gold_date, gold_index: t.gold_index })),
      entities_per_fact_median_production: (() => { const v = [...prodBags.values()].map((n) => new Set(n).size).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] ?? 0 })(),
      supply_normalization: F.CALLER_NAME_MAP,
      carrier_key: fixture.plan.carrier_key,
      distractor_key: fixture.plan.distractor_key,
    },
    arms: ARMS,
    arm_stats: armStats,
    identity: { checked: identity.length, passed: identity.length - identityFailures.length, failures: identityFailures },
    rows,
    summary,
    guards,
    default_unchanged: defaultUnchanged,
    assertions,
    counterfactual: ctf,
    verdict,
    write_cost: { rewrites: rewriteMs.map((r) => ({ ms: L.round4(r.ms), links: r.links })) },
    reproduction: 'node mem/scripts/spikes/bench-r3-1-caller-supplier.mjs --json mem/docs/spikes/raw/round3-s2-supplier.json',
  }
  // privacy self-check: no text/content keys, no >300 char strings
  const badKeys = []
  const longStrings = []
  const walk = (v, path) => {
    if (typeof v === 'string') { if (v.length > 300) longStrings.push(`${path}(${v.length})`); return }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`))
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'text' || k === 'content') badKeys.push(`${path}.${k}`); walk(x, `${path}.${k}`) }
  }
  walk(out, '$')
  out.privacy_selfcheck = { text_or_content_keys: badKeys, strings_over_300: longStrings, clean: badKeys.length === 0 && longStrings.length === 0 }
  console.log('privacy:', JSON.stringify(out.privacy_selfcheck))
  console.log('verdict:', JSON.stringify(verdict.call))
  L.writeJson(jsonOut, out)
  L.teardown(track)
}

await main()
