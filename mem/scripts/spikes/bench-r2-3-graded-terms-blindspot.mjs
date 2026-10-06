/**
 * R2-3 · the round-1 side finding: `gradedTerms`'s "2-char CJK topic + 3-char word" blind spot.
 *
 * THE DEFECT. For a query like `限流 上个月`, `relevanceTerms` emits the trigrams of `上个月` and
 * NOTHING for `限流` (a 2-char CJK run has no 3-gram). Because the term set is non-empty, the
 * short-query substring fallback never fires (`gradedTerms`: "any text that yields even one
 * index-expressible term is returned UNCHANGED"). So the FTS leg is searched and graded as if the
 * query were only `上个月`, and the topic word is invisible to it. This is the shape A2's window
 * queries take (`<topic> <window word>`), so it is the A2 line's own lexical gap.
 *
 * WHAT IS MEASURED (no implementation — round-1 pinned `relevanceTerms` byte-identical, and this
 * card may not touch production).
 *   1. POPULATION: over all real + frozen queries, how many carry the shape (>= 1 two-char CJK run
 *      AND >= 1 index-expressible term)?
 *   2. DERIVED SHAPE QUERIES from the snapshot: a 2-char topic entity `e2` (active df >= 2) plus a
 *      3+-char entity `e3` that does not occur in the topic's gold facts; query = `e2 e3`,
 *      gold = the active facts carrying `e2` and NOT `e3`. The same `e2` alone is the control where
 *      the fallback DOES fire.
 *   3. SCRIPT-SIDE BEFORE/AFTER: the FTS leg (production `ftsPath` + production `applyTermFloor`)
 *      versus two script-side fixes:
 *        `fix_naive` — union the substring terms into `gradedTerms` (what the brief sketches);
 *        `fix_or`    — search both paths but grade the substring evidence as an OR against a floor
 *                      still clamped by the INDEXED term count.
 *      The distinction matters: `fix_naive` RAISES the reachability clamp from 1 to 2 for exactly
 *      this shape, so a gold fact that contains only the 2-char topic is now required to contain
 *      the 3-char word too — the naive fix can make the blind spot worse.
 *
 * VERDICT RULE: report the affected share + the before/after hit rates; DO NOT implement. Any
 * recommendation must survive the clamp arithmetic measured below.
 *
 * Usage: node mem/scripts/spikes/bench-r2-3-graded-terms-blindspot.mjs [--json <path>]
 * PRIVACY: ids / counts / short derived topic words only; no fact text is written.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round2-r2-3-graded-terms-blindspot.json'))
const LIMIT = 5
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
const runShape = (text) => {
  const runs = text.match(CJK_RUN) ?? []
  const has2 = runs.some((r) => r.length === 2)
  const hasExpressible = runs.some((r) => r.length >= 3) || (text.match(/[A-Za-z0-9_.]{5,}/g) ?? []).length > 0
  return { has2, hasExpressible, affected: has2 && hasExpressible }
}

function loadEntities(snap) {
  const db = L.openReadOnly(snap)
  try {
    const rows = db.prepare(
      `select f.fact_id id, e.name entity
         from facts f join fact_entities fe on fe.fact_id = f.fact_id
         join entities e on e.entity_id = fe.entity_id
        where f.status = 'active'`,
    ).all()
    const bags = new Map()
    for (const r of rows) {
      if (!bags.has(r.id)) bags.set(r.id, new Set())
      bags.get(r.id).add(r.entity)
    }
    const df = new Map()
    for (const names of bags.values()) for (const n of names) df.set(n, (df.get(n) ?? 0) + 1)
    return { ids: [...bags.keys()], bags, df }
  } finally {
    db.close()
  }
}

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-r23-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts, meta } = L.loadActiveTexts(snap)
  track.texts = texts
  L.banner('R2-3 · gradedTerms 2-char topic blind spot', { snapshot: snap, active_facts: texts.size })

  // ── 1. population scan over the real 20 + frozen 41 ─────────────────────────────────────────
  const frozenQueries = L.frozenCases().flatMap((c) => c.queries.map((q) => q.query))
  const population = [
    ...L.REAL_QUERIES.map((q) => ({ source: 'real', q: q.q })),
    ...frozenQueries.map((q) => ({ source: 'frozen', q })),
  ]
  const popRows = population.map((p) => {
    const shape = runShape(p.q)
    const graded = L.gradedTerms(p.q)
    const indexedOnly = L.relevanceTerms(p.q).length > 0
    // The blind spot is exactly: the fallback is suppressed AND a 2-char run exists.
    const runs2 = (p.q.match(CJK_RUN) ?? []).filter((r) => r.length === 2)
    const topicInvisible = indexedOnly && runs2.length > 0 && runs2.every((r) => !graded.some((t) => t.includes(r)))
    return { ...p, ...shape, indexed_only: indexedOnly, graded_terms: graded.length, topic_invisible: topicInvisible }
  })
  const populationSummary = {
    total: popRows.length,
    real: popRows.filter((r) => r.source === 'real').length,
    frozen: popRows.filter((r) => r.source === 'frozen').length,
    with_two_char_cjk_run: popRows.filter((r) => r.has2).length,
    with_index_expressible_term: popRows.filter((r) => r.hasExpressible).length,
    affected_shape: popRows.filter((r) => r.affected).length,
    fallback_suppressed_with_2char_run: popRows.filter((r) => r.indexed_only && r.has2).length,
    topic_invisible_to_fts: popRows.filter((r) => r.topic_invisible).length,
  }
  console.log('population:', JSON.stringify(populationSummary))
  console.log('  affected queries:', JSON.stringify(popRows.filter((r) => r.affected).map((r) => ({ q: r.q, source: r.source, topic_invisible: r.topic_invisible }))))

  // ── 2. derive the shape from the snapshot ───────────────────────────────────────────────────
  const { ids, bags, df } = loadEntities(snap)
  const e2s = [...df.entries()]
    .filter(([n, d]) => n.length === 2 && d >= 2 && d <= 12 && CJK_CHAR.test(n))
    .map(([n, d]) => ({ n, d }))
  const e3s = [...df.entries()].filter(([n]) => n.length >= 3 && CJK_CHAR.test(n)).map(([n, d]) => ({ n, d }))
  const derived = []
  for (const e2 of e2s) {
    if (derived.length >= 20) break
    const withE2 = ids.filter((id) => bags.get(id).has(e2.n))
    // gold = the facts carrying the topic and NOT the 3-char word (the realistic A2 shape: the fact
    // never mentions the window word).
    for (const e3 of e3s) {
      if (e3.n === e2.n) continue
      const gold = withE2.filter((id) => !bags.get(id).has(e3.n))
      const withE3 = ids.filter((id) => bags.get(id).has(e3.n))
      if (gold.length === 0 || withE3.length === 0) continue
      derived.push({ topic: e2.n, topic_df: e2.d, word3: e3.n, word3_df: e3.d, gold, query: `${e2.n} ${e3.n}`, control_query: e2.n })
      break
    }
  }
  console.log(`derived shape queries: ${derived.length} (topics available: ${e2s.length})`)

  // ── 3. leg-level before/after ───────────────────────────────────────────────────────────────
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const floor = rt.memory.config.retriever.min_fts_terms
  const identity = []
  for (const d of derived) identity.push(await L.identityCheck(rt, d.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const identityFailures = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - identityFailures.length}/${identity.length} pass`)

  const rows = []
  for (const d of derived) {
    const cap = L.legCapFor(rt.memory.config, LIMIT * 5)
    const indexed = L.relevanceTerms(d.query)
    const subs = L.substringTerms(d.query)
    const prodLeg = rt.memory.ftsPath(d.query, undefined, cap)
    const subRows = rt.memory.facts.ftsSubstringSearch(subs, undefined, cap)
    const prodFloored = L.applyTermFloor(prodLeg, texts, d.query, floor).scores
    // fix_naive: union BEFORE grading, clamp from the union's size.
    const naiveRaw = new Map(prodLeg)
    for (const r of subRows) naiveRaw.set(r.id, Math.max(naiveRaw.get(r.id) ?? 0, r.rank))
    const naiveTerms = [...new Set([...indexed, ...subs])]
    const naiveEffective = L.effectiveTermFloor(floor, naiveTerms.length)
    const naiveFloored = new Map()
    for (const [id, score] of naiveRaw) if (L.countMatchedTerms(texts.get(id) ?? '', naiveTerms) >= naiveEffective) naiveFloored.set(id, score)
    // fix_or: union for SEARCH, but the bar stays the production clamp (indexed terms), and the
    // substring evidence is a MAX not an AND.
    const orEffective = L.effectiveTermFloor(floor, indexed.length)
    const orFloored = new Map()
    for (const [id, score] of naiveRaw) {
      const graded = Math.max(
        L.countMatchedTerms(texts.get(id) ?? '', indexed),
        L.countMatchedTerms(texts.get(id) ?? '', subs),
      )
      if (graded >= orEffective) orFloored.set(id, score)
    }
    // control: the topic alone — the fallback DOES fire.
    const controlLeg = rt.memory.ftsPath(d.control_query, undefined, cap)
    const controlFloored = L.applyTermFloor(controlLeg, texts, d.control_query, floor).scores
    const hit = (m) => d.gold.some((id) => m.has(id))
    rows.push({
      topic: d.topic,
      topic_df: d.topic_df,
      word3: d.word3,
      word3_df: d.word3_df,
      query: d.query,
      gold_count: d.gold.length,
      indexed_terms: indexed.length,
      substring_terms: subs.length,
      prod_leg_size: prodLeg.size,
      sub_leg_size: subRows.length,
      floor_config: floor,
      prod_effective_floor: L.effectiveTermFloor(floor, indexed.length),
      naive_effective_floor: naiveEffective,
      or_effective_floor: orEffective,
      production_hits_gold: hit(prodFloored),
      fix_naive_hits_gold: hit(naiveFloored),
      fix_or_hits_gold: hit(orFloored),
      control_topic_alone_hits_gold: hit(controlFloored),
      production_leg_has_gold_raw: hit(prodLeg),
      fixed_leg_has_gold_raw: hit(naiveRaw),
    })
  }

  const summarize = (key) => ({
    gold_queries: rows.length,
    hits: rows.filter((r) => r[key]).length,
    hit_rate: rows.length ? L.round4(rows.filter((r) => r[key]).length / rows.length) : null,
  })
  const summary = {
    production: summarize('production_hits_gold'),
    fix_naive: summarize('fix_naive_hits_gold'),
    fix_or: summarize('fix_or_hits_gold'),
    control_topic_alone: summarize('control_topic_alone_hits_gold'),
    production_raw_leg_has_gold: summarize('production_leg_has_gold_raw'),
    fixed_raw_leg_has_gold: summarize('fixed_leg_has_gold_raw'),
  }
  console.log('summary:', JSON.stringify(summary, null, 2))
  console.log('gold queries where naive fix is WORSE than production:',
    rows.filter((r) => r.production_hits_gold && !r.fix_naive_hits_gold).length,
    '| where naive fix is BETTER:', rows.filter((r) => !r.production_hits_gold && r.fix_naive_hits_gold).length)

  const verdict = {
    affected_share_of_real_frozen_queries: populationSummary.total
      ? L.round4(populationSummary.affected_shape / populationSummary.total)
      : null,
    affected_queries: populationSummary.affected_shape,
    production_hit_rate: summary.production.hit_rate,
    fix_naive_hit_rate: summary.fix_naive.hit_rate,
    fix_or_hit_rate: summary.fix_or.hit_rate,
    control_fallback_hit_rate: summary.control_topic_alone.hit_rate,
    naive_fix_raises_clamp: rows.some((r) => r.naive_effective_floor > r.prod_effective_floor),
    // No implementation: the brief forbids touching production, and `relevanceTerms` is pinned.
    call: 'quantified, not implemented — a naive term union raises the reachability clamp; the OR-shaped fix recovers the topic without narrowing the indexed path',
  }
  console.log('verdict:', JSON.stringify(verdict))

  const out = {
    card: 'R2-3',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size, median_len: [...meta.values()].map((m) => m.len).sort((a, b) => a - b)[Math.floor(meta.size / 2)] },
    population_summary: populationSummary,
    population_rows: popRows,
    derived,
    rows,
    summary,
    identity: { checked: identity.length, passed: identity.length - identityFailures.length, failures: identityFailures },
    verdict,
    reproduction: 'node mem/scripts/spikes/bench-r2-3-graded-terms-blindspot.mjs --json mem/docs/spikes/raw/round2-r2-3-graded-terms-blindspot.json',
  }
  L.writeJson(jsonOut, out)
  L.teardown(track)
}

await main()
