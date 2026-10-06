/**
 * R4-S7 · the two UNLABELLED items: the entity-bag / anchor sweep on the literal shape, and the
 * `fix_or` prototype for `gradedTerms`' 2-char blind spot.
 *
 * PART 1 — SWEEP. R3 observed a STRUCTURAL improvement (entity-bag median width 28 -> 2) with no
 * quality change, because its literal-shape queries were already saturated. The real corpus IS the
 * literal shape (S1: 2803/2803 pairs literal), so this is the corpus where "does pruning the bag or
 * tightening the anchor ceiling buy precision" can actually be answered. The sweep re-implements the
 * entity leg in the arm (`arm.jaccard`) with four knobs — df prune, bag width cap, anchor ceiling
 * rate, union cap — and reports both the leg-level readout and the full hybrid pass. The local
 * overlap function is asserted EQUAL to the production `anchoredOverlap` at the production cap.
 *
 * PART 2 — `fix_or`. R2-3 quantified the defect (a 2-char CJK topic next to an index-expressible
 * word is invisible to the trigram leg) and showed `fix_naive` (union the terms, then grade) RAISES
 * the reachability clamp from 1 to 2 and can make it worse, while `fix_or` (search the union, grade
 * the substring evidence as an OR against the PRODUCTION clamp) recovers it. This card implements
 * `fix_or` in the script and checks the hard constraint: whenever `relevanceTerms` is non-empty the
 * effective clamp stays BYTE-IDENTICAL to production, and every query with no invisible 2-char run
 * returns byte-identical ids AND scores. It runs over the frozen 41, the real 20, and derived
 * 2-char-shape queries.
 *
 * Usage: node mem/scripts/spikes/bench-r4-5-sweep-fixor.mjs
 * PRIVACY: ids/counts/ratios only; derived query strings stay in /tmp.
 */
import { join } from 'node:path'
import * as R from './bench-r4-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const outSweep = L.arg('sweep', join(L.REPO, 'docs/spikes/raw/round4-s7-sweep.json'))
const outFix = L.arg('fixor', join(L.REPO, 'docs/spikes/raw/round4-s7-fixor.json'))
const LIMIT = 5
const { ANCHOR_MIN } = await import(L.lib('core/lib/store/entity_leg.js'))
const pct = (n, d) => (d ? L.round4(n / d) : null)
const CJK = /[\u4e00-\u9fff]/
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g

/** Copy of the production formula with the union cap as a parameter (asserted equal at cap=3). */
function overlapC(anchors, queryWidth, factEntities, cap) {
  if (anchors.length === 0 || queryWidth <= 0) return 0
  let shared = 0
  for (const n of anchors) if (factEntities.has(n)) shared += 1
  if (shared === 0) return 0
  const extra = Math.min(factEntities.size - shared, cap)
  return shared / (queryWidth + Math.max(0, extra))
}

function readAll(snap) {
  const db = L.openReadOnly(snap)
  try {
    const facts = db.prepare("select fact_id id, content from facts where status='active' order by fact_id").all()
    const links = db.prepare(
      `select fe.fact_id id, e.name name from fact_entities fe join entities e on e.entity_id = fe.entity_id
         join facts f on f.fact_id = fe.fact_id where f.status='active'`,
    ).all()
    const bags = new Map()
    for (const r of links) {
      if (!bags.has(r.id)) bags.set(r.id, new Set())
      bags.get(r.id).add(r.name)
    }
    const df = new Map()
    for (const names of bags.values()) for (const n of names) df.set(n, (df.get(n) ?? 0) + 1)
    return { facts, bags, df }
  } finally { db.close() }
}

async function main() {
  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r45-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { facts, bags, df } = readAll(snap)
  const ids = facts.map((f) => f.id)
  const texts = new Map(facts.map((f) => [f.id, String(f.content)]))
  const track = { runtimes: [], dirs: [work], texts }
  const emb = await L.warmEmbedder()
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  R.banner('R4-S7 · sweep + fix_or', { active: ids.length })

  // ── derived 2-char-shape queries (R2-3's derivation) ──────────────────────────────────────────
  const e2s = [...df.entries()].filter(([n, d]) => n.length === 2 && d >= 2 && d <= 12 && CJK.test(n)).map(([n, d]) => ({ n, d }))
  const e3s = [...df.entries()].filter(([n, d]) => n.length >= 3 && CJK.test(n)).map(([n, d]) => ({ n, d }))
  const derived = []
  for (const e2 of e2s) {
    if (derived.length >= 20) break
    const withE2 = ids.filter((id) => bags.get(id).has(e2.n))
    for (const e3 of e3s) {
      if (e3.n === e2.n) continue
      const gold = withE2.filter((id) => !bags.get(id).has(e3.n))
      const withE3 = ids.filter((id) => bags.get(id).has(e3.n))
      if (!gold.length || !withE3.length) continue
      derived.push({ topic: e2.n, topic_df: e2.d, word3: e3.n, word3_df: e3.d, gold, query: `${e2.n} ${e3.n}` })
      break
    }
  }
  R.writeTmp('fixor-derived-queries.json', { note: 'derived topic words; /tmp only', derived: derived.map((d) => ({ query: d.query, gold: d.gold })) })

  // ── PART 2a: leg-level production / fix_naive / fix_or ────────────────────────────────────────
  const floorCfg = rt.memory.config.retriever.min_fts_terms
  const cap = L.legCapFor(rt.memory.config, LIMIT * 5)
  const fixRows = []
  for (const d of derived) {
    const indexed = L.relevanceTerms(d.query)
    const subs = L.substringTerms(d.query)
    const prodLeg = rt.memory.ftsPath(d.query, undefined, cap)
    const subRows = rt.memory.facts.ftsSubstringSearch(subs, undefined, cap)
    const prodFloored = L.applyTermFloor(prodLeg, texts, d.query, floorCfg).scores
    const naiveRaw = new Map(prodLeg)
    for (const r of subRows) naiveRaw.set(r.id, Math.max(naiveRaw.get(r.id) ?? 0, r.rank))
    const naiveTerms = [...new Set([...indexed, ...subs])]
    const naiveEffective = L.effectiveTermFloor(floorCfg, naiveTerms.length)
    const naiveFloored = new Map()
    for (const [id, score] of naiveRaw) if (L.countMatchedTerms(texts.get(id) ?? '', naiveTerms) >= naiveEffective) naiveFloored.set(id, score)
    // fix_or: search the union, grade the OR against the PRODUCTION clamp.
    const orEffective = L.effectiveTermFloor(floorCfg, indexed.length)
    const orRaw = new Map(prodLeg)
    for (const r of subRows) orRaw.set(r.id, Math.max(orRaw.get(r.id) ?? 0, r.rank))
    const orFloored = new Map()
    for (const [id, score] of orRaw) {
      const graded = Math.max(
        L.countMatchedTerms(texts.get(id) ?? '', indexed),
        L.countMatchedTerms(texts.get(id) ?? '', subs),
      )
      if (graded >= orEffective) orFloored.set(id, score)
    }
    const hit = (m) => d.gold.some((id) => m.has(id))
    fixRows.push({
      topic_len: d.topic.length, topic_df: d.topic_df, word3_df: d.word3_df, gold_count: d.gold.length,
      indexed_terms: indexed.length, substring_terms: subs.length,
      prod_leg_size: prodLeg.size, prod_effective_floor: L.effectiveTermFloor(floorCfg, indexed.length),
      naive_effective_floor: naiveEffective, or_effective_floor: orEffective,
      production_hits_gold: hit(prodFloored), fix_naive_hits_gold: hit(naiveFloored), fix_or_hits_gold: hit(orFloored),
      production_raw_has_gold: hit(prodLeg), fix_or_raw_has_gold: hit(orRaw),
    })
  }
  const fixSummary = (k) => ({ queries: fixRows.length, hits: fixRows.filter((r) => r[k]).length, hit_rate: pct(fixRows.filter((r) => r[k]).length, fixRows.length) })

  // ── PART 2b: end-to-end fix_or via an appended leg (production clamp untouched) ───────────────
  const fixArm = (q) => {
    const indexed = L.relevanceTerms(q)
    if (indexed.length === 0) return {} // production already runs the substring fallback
    const subs = L.substringTerms(q)
    if (subs.length === 0) return {}
    const prodLeg = rt.memory.ftsPath(q, undefined, cap)
    const rows = rt.memory.facts.ftsSubstringSearch(subs, undefined, cap)
    const effective = L.effectiveTermFloor(floorCfg, indexed.length)
    const extra = new Map()
    for (const r of rows) {
      if (prodLeg.has(r.id)) continue
      const graded = Math.max(L.countMatchedTerms(texts.get(r.id) ?? '', indexed), L.countMatchedTerms(texts.get(r.id) ?? '', subs))
      if (graded >= effective) extra.set(r.id, r.rank)
    }
    if (!extra.size) return {}
    return { appendLegs: () => [{ weight: rt.memory.config.retriever.weight_fts, scores: extra, leg: 'fts' }] }
  }

  const resolveGolds = L.resolveRealGolds(snap, { texts })
  const endToEnd = []
  const queries = [
    ...derived.map((d, i) => ({ id: `derived-${i}`, q: d.query, gold: d.gold, set: 'derived_2char' })),
    ...resolveGolds.map((q) => ({ id: q.id, q: q.q, gold: q.gold, set: 'real_20' })),
  ]
  for (const q of queries) {
    const base = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const fixed = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: fixArm(q.q) })
    const indexed = L.relevanceTerms(q.q)
    const subs = L.substringTerms(q.q)
    endToEnd.push({
      id: q.id, set: q.set, gold_total: q.gold ? q.gold.length : 0,
      indexed_terms: indexed.length, substring_terms: subs.length,
      blind_spot_shape: indexed.length > 0 && subs.length > 0,
      ids_equal: base.ids.join(',') === fixed.ids.join(','),
      scores_equal: JSON.stringify(base.scores) === JSON.stringify(fixed.scores),
      base_ids: base.ids, fixed_ids: fixed.ids,
      base_hits_gold: q.gold ? (q.gold.some((g) => base.ids.includes(g)) ? 1 : 0) : null,
      fixed_hits_gold: q.gold ? (q.gold.some((g) => fixed.ids.includes(g)) ? 1 : 0) : null,
      effective_floor_production: L.effectiveTermFloor(floorCfg, indexed.length),
      effective_floor_fix: L.effectiveTermFloor(floorCfg, indexed.length),
    })
  }

  // ── PART 2c: frozen 41 via the eval runner ────────────────────────────────────────────────────
  const frozen = L.frozenCases()

  // Direct per-query frozen comparison through runScript (same runtime, one temp store per case).
  const frozenRows = []
  for (const c of frozen.slice(0, 41)) {
    const caseWork = L.mkdtempSync(join(L.tmpdir(), 'avantf-r45e-'))
    track.dirs.push(caseWork)
    const caseSnap = join(caseWork, 'memory.db')
    const caseHome = L.mkdtempSync(join(L.tmpdir(), 'avantf-r45h-'))
    track.dirs.push(caseHome)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(caseHome, 'configs'), { recursive: true })
    writeFileSync(join(caseHome, 'configs/common.yaml'), `semantic:\n  local_model: ${L.DEFAULT_MODEL}\n  dim: ${L.DEFAULT_DIM}\n  auto_download: false\n`)
    const rtCase = L.newRuntime({ snapPath: caseSnap, semantic: emb, track })
    const setupContents = c.setup_facts.map((f) => (typeof f === 'string' ? f : f.content))
    const caseIds = []
    for (const content of setupContents) caseIds.push((await rtCase.remember({ action: 'add', content })).fact_id)
    const caseTexts = new Map(caseIds.map((id, i) => [id, setupContents[i]]))
    const caseTrack = { runtimes: [], dirs: [], texts: caseTexts }
    for (const q of c.queries) {
      const base = await L.runScript(rtCase, q.query, { limit: q.k ?? 5, maxTokens: 0, floors: 'strict', track: caseTrack, arm: {} })
      const a = {}
      const indexed = L.relevanceTerms(q.query)
      if (indexed.length > 0) {
        const subs = L.substringTerms(q.query)
        if (subs.length) {
          const prodLeg = rtCase.memory.ftsPath(q.query, undefined, cap)
          const rows = rtCase.memory.facts.ftsSubstringSearch(subs, undefined, cap)
          const effective = L.effectiveTermFloor(rtCase.memory.config.retriever.min_fts_terms, indexed.length)
          const extra = new Map()
          for (const r of rows) {
            if (prodLeg.has(r.id)) continue
            const graded = Math.max(L.countMatchedTerms(caseTexts.get(r.id) ?? '', indexed), L.countMatchedTerms(caseTexts.get(r.id) ?? '', subs))
            if (graded >= effective) extra.set(r.id, r.rank)
          }
          if (extra.size) a.appendLegs = () => [{ weight: rtCase.memory.config.retriever.weight_fts, scores: extra, leg: 'fts' }]
        }
      }
      const fixed = await L.runScript(rtCase, q.query, { limit: q.k ?? 5, maxTokens: 0, floors: 'strict', track: caseTrack, arm: a })
      frozenRows.push({
        case: c.id, query_index: c.queries.indexOf(q),
        ids_equal: base.ids.join(',') === fixed.ids.join(','),
        scores_equal: JSON.stringify(base.scores) === JSON.stringify(fixed.scores),
        blind_spot_shape: L.relevanceTerms(q.query).length > 0 && L.substringTerms(q.query).length > 0,
        base_hits_expected: q.expected_ids.some((i) => base.ids.includes(caseIds[i])) ? 1 : 0,
        fixed_hits_expected: q.expected_ids.some((i) => fixed.ids.includes(caseIds[i])) ? 1 : 0,
      })
    }
  }

  const fixOut = {
    card: 'R4-S7-fix_or',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: true, note: 'all end-to-end runs go through runScript on a production runtime; S3/S5 report the identity check for the same scaffolding (86/86 and 34/34)' },
    definition: {
      defect: 'a 2-char CJK run beside an index-expressible term is invisible to the trigram leg (relevanceTerms emits nothing for it, so the substring fallback never fires)',
      fix_naive: 'union terms, then grade the union — RAISES the clamp from indexed count to union count',
      fix_or: 'search the union, grade max(indexed matches, substring matches) against the PRODUCTION clamp (effectiveTermFloor(min_fts_terms, indexed.length))',
      hard_constraint: 'whenever relevanceTerms is non-empty the effective clamp and the indexed search path must be byte-identical to production; a query with no invisible 2-char run must return byte-identical ids AND scores',
    },
    leg_level: {
      queries: derived.length,
      floor_config: floorCfg,
      summary: { production: fixSummary('production_hits_gold'), fix_naive: fixSummary('fix_naive_hits_gold'), fix_or: fixSummary('fix_or_hits_gold') },
      naive_raises_clamp: fixRows.filter((r) => r.naive_effective_floor > r.prod_effective_floor).length,
      or_changes_clamp: fixRows.filter((r) => r.or_effective_floor !== r.prod_effective_floor).length,
      rows: fixRows,
    },
    end_to_end: {
      derived_and_real: endToEnd.map((r) => ({ id: r.id, set: r.set, blind_spot_shape: r.blind_spot_shape, ids_equal: r.ids_equal, scores_equal: r.scores_equal, gold_total: r.gold_total, base_hits_gold: r.base_hits_gold, fixed_hits_gold: r.fixed_hits_gold })),
      summary: {
        queries: endToEnd.length,
        blind_spot_queries: endToEnd.filter((r) => r.blind_spot_shape).length,
        byte_identical_ids: endToEnd.filter((r) => r.ids_equal).length,
        byte_identical_scores: endToEnd.filter((r) => r.scores_equal).length,
        changed_ids: endToEnd.filter((r) => !r.ids_equal).length,
        gold_gained: endToEnd.filter((r) => r.fixed_hits_gold > r.base_hits_gold).length,
        gold_lost: endToEnd.filter((r) => r.fixed_hits_gold < r.base_hits_gold).length,
        clamp_changed: endToEnd.filter((r) => r.effective_floor_production !== r.effective_floor_fix).length,
      },
      no_blind_spot_byte_identical: endToEnd.filter((r) => !r.blind_spot_shape).every((r) => r.ids_equal && r.scores_equal),
    },
    frozen_41: {
      direct_rows: frozenRows,
      summary: {
        queries: frozenRows.length,
        blind_spot_queries: frozenRows.filter((r) => r.blind_spot_shape).length,
        byte_identical_ids: frozenRows.filter((r) => r.ids_equal).length,
        byte_identical_scores: frozenRows.filter((r) => r.scores_equal).length,
        changed: frozenRows.filter((r) => !r.ids_equal).length,
        expected_gained: frozenRows.filter((r) => r.fixed_hits_expected > r.base_hits_expected).length,
        expected_lost: frozenRows.filter((r) => r.fixed_hits_expected < r.base_hits_expected).length,
      },
      note: 'the frozen set is driven through runScript per case (fresh temp store per case, real remember), so each query gets a direct production-vs-fix comparison',
    },
    verdict: {
      fix_or_recovers_leg: fixSummary('fix_or_hits_gold').hits >= fixSummary('production_hits_gold').hits,
      fix_naive_hurts: fixSummary('fix_naive_hits_gold').hits < fixSummary('production_hits_gold').hits,
      clamp_preserved: fixRows.every((r) => r.or_effective_floor === r.prod_effective_floor),
      frozen_no_regression: frozenRows.filter((r) => r.fixed_hits_expected < r.base_hits_expected).length === 0,
      changed_only_on_blind_spot_shape: endToEnd.filter((r) => !r.ids_equal).every((r) => r.blind_spot_shape),
    },
    reproduction: 'node mem/scripts/spikes/bench-r4-5-sweep-fixor.mjs',
  }

  // ── PART 1: the sweep ─────────────────────────────────────────────────────────────────────────
  const sweepQueries = [
    ...R.readTmp('queries.json').queries.filter((q) => q.qualifies && q.form === 'entity').slice(0, 28).map((q) => ({ id: q.id, q: q.query, gold: q.gold, form: 'entity' })),
    ...R.readTmp('queries.json').queries.filter((q) => q.qualifies && q.form === 'entity_canonical' && q.shape === 'alias').map((q) => ({ id: q.id, q: q.query, gold: q.gold, form: 'canonical_alias' })),
  ]
  const corpus = ids.length
  const CONFIGS = [
    { id: 'prod', dfMax: Infinity, widthCap: Infinity, anchorRate: null, unionCap: L.ENTITY_UNION_CAP },
    { id: 'prune-df16', dfMax: 16, widthCap: Infinity, anchorRate: null, unionCap: L.ENTITY_UNION_CAP },
    { id: 'prune-df8', dfMax: 8, widthCap: Infinity, anchorRate: null, unionCap: L.ENTITY_UNION_CAP },
    { id: 'prune-df4', dfMax: 4, widthCap: Infinity, anchorRate: null, unionCap: L.ENTITY_UNION_CAP },
    { id: 'width-8', dfMax: Infinity, widthCap: 8, anchorRate: null, unionCap: L.ENTITY_UNION_CAP },
    { id: 'width-4', dfMax: Infinity, widthCap: 4, anchorRate: null, unionCap: L.ENTITY_UNION_CAP },
    { id: 'width-2', dfMax: Infinity, widthCap: 2, anchorRate: null, unionCap: L.ENTITY_UNION_CAP },
    { id: 'anchor-0.1', dfMax: Infinity, widthCap: Infinity, anchorRate: 0.1, unionCap: L.ENTITY_UNION_CAP },
    { id: 'anchor-0.4', dfMax: Infinity, widthCap: Infinity, anchorRate: 0.4, unionCap: L.ENTITY_UNION_CAP },
    { id: 'cap-1', dfMax: Infinity, widthCap: Infinity, anchorRate: null, unionCap: 1 },
    { id: 'cap-6', dfMax: Infinity, widthCap: Infinity, anchorRate: null, unionCap: 6 },
    { id: 'cap-12', dfMax: Infinity, widthCap: Infinity, anchorRate: null, unionCap: 12 },
    { id: 'width4+cap1', dfMax: 8, widthCap: 4, anchorRate: 0.1, unionCap: 1 },
  ]
  const sweepRows = []
  const sweepMeta = []
  for (const cfg of CONFIGS) {
    const effBag = new Map()
    for (const id of ids) {
      let names = [...(bags.get(id) ?? [])].filter((n) => (df.get(n) ?? 0) <= cfg.dfMax)
      if (cfg.widthCap !== Infinity) names = names.sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || a.localeCompare(b)).slice(0, cfg.widthCap)
      effBag.set(id, new Set(names))
    }
    const ceiling = cfg.anchorRate === null ? null : Math.max(ANCHOR_MIN, Math.ceil(cfg.anchorRate * corpus))
    const legSizes = []
    let diffsFromProd = null
    for (const q of sweepQueries) {
      let legSize = 0
      const arm = {
        jaccard: (raw, meta) => {
          const qe = [...new Set(meta.qEntities)]
          const anchors = ceiling === null
            ? L.selectAnchors(qe, df, corpus)
            : qe.filter((n) => (df.get(n) ?? 0) > 0 && (df.get(n) ?? 0) <= ceiling)
          const cands = anchors.length ? rt.memory.entities.candidateFactsForAnyEntity(anchors, undefined, meta.legCap, qe.length, cfg.unionCap) : []
          const out = new Map()
          for (const id of cands) {
            if (!texts.has(id)) continue
            const s = overlapC(anchors, qe.length, effBag.get(id) ?? new Set(), cfg.unionCap)
            if (s > 0) out.set(id, s)
          }
          legSize = out.size
          if (cfg.id === 'prod') {
            const prodScores = raw.scores ?? raw
            diffsFromProd = JSON.stringify([...out.entries()].sort()) === JSON.stringify([...prodScores.entries()].sort())
          }
          return out
        },
      }
      const p = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm })
      legSizes.push(legSize)
      const gold = q.gold ?? []
      const poolIds = new Set(p.pool.map((h) => h.id))
      sweepRows.push({
        config: cfg.id, query_id: q.id, form: q.form, gold_total: gold.length,
        top1: gold.length ? (gold.includes(p.ids[0]) ? 1 : 0) : null,
        top3_gold: gold.length ? p.ids.slice(0, 3).filter((x) => gold.includes(x)).length : null,
        gold_in_pool: gold.length ? gold.filter((x) => poolIds.has(x)).length : null,
        missing: gold.length ? gold.some((x) => !p.ids.includes(x)) : null,
        pool_size: p.pool.length, entity_leg_size: legSize,
      })
    }
    const widths = [...effBag.values()].map((s) => s.size)
    sweepMeta.push({
      config: cfg.id, dfMax: cfg.dfMax === Infinity ? null : cfg.dfMax, widthCap: cfg.widthCap === Infinity ? null : cfg.widthCap,
      anchorRate: cfg.anchorRate, unionCap: cfg.unionCap, anchorCeiling: ceiling,
      bag_width_median: widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)],
      mean_entity_leg_size: L.round4(legSizes.reduce((a, b) => a + b, 0) / legSizes.length),
      baseline_overlap_matches_production: diffsFromProd,
    })
  }
  const sweepSummary = {}
  for (const cfg of CONFIGS) {
    const rs = sweepRows.filter((r) => r.config === cfg.id && r.form === 'entity')
    const ra = sweepRows.filter((r) => r.config === cfg.id && r.form === 'canonical_alias')
    const agg = (rows) => ({
      queries: rows.length,
      top1: rows.filter((r) => r.top1 === 1).length,
      top3_gold: rows.reduce((n, r) => n + (r.top3_gold ?? 0), 0),
      gold_total: rows.reduce((n, r) => n + r.gold_total, 0),
      gold_in_pool: rows.reduce((n, r) => n + (r.gold_in_pool ?? 0), 0),
      missing: rows.filter((r) => r.missing).length,
      mean_pool: rows.length ? L.round4(rows.reduce((n, r) => n + r.pool_size, 0) / rows.length) : null,
      mean_entity_leg: rows.length ? L.round4(rows.reduce((n, r) => n + r.entity_leg_size, 0) / rows.length) : null,
    })
    sweepSummary[cfg.id] = { entity_literal: agg(rs), canonical_alias: agg(ra) }
  }
  const sweepOut = {
    card: 'R4-S7-sweep',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: true, note: 'all sweep passes go through runScript with arm.jaccard replacing only the entity-leg scores' },
    design: {
      corpus: 'live snapshot, 85 active facts (the literal shape: S1 measured 2803/2803 entity pairs literal)',
      knobs: { dfMax: 'drop entity names with active df above this', widthCap: 'keep at most K rarest names per fact', anchorRate: 'anchor ceiling = max(ANCHOR_MIN, ceil(rate x 85)); null = production ceiling', unionCap: 'ENTITY_UNION_CAP in the saturating denominator' },
      queries: { entity_literal: sweepQueries.filter((q) => q.form === 'entity').length, canonical_alias: sweepQueries.filter((q) => q.form === 'canonical_alias').length },
      local_overlap_equals_production_at_cap3: sweepMeta.find((m) => m.config === 'prod')?.baseline_overlap_matches_production ?? null,
    },
    configs_meta: sweepMeta,
    summary: sweepSummary,
    rows: sweepRows,
    reproduction: 'node mem/scripts/spikes/bench-r4-5-sweep-fixor.mjs',
  }

  const whitelist = R.repoCjkWhitelist()
  for (const [name, o] of [['sweep', sweepOut], ['fixor', fixOut]]) {
    o.privacy = R.auditArtifact(o, { cjkWhitelist: whitelist })
    if (!o.privacy.clean) {
      console.error(`PRIVACY AUDIT FAILED (${name})`, JSON.stringify(o.privacy).slice(0, 3000))
      process.exitCode = 1
    }
  }
  L.writeJson(outSweep, sweepOut)
  L.writeJson(outFix, fixOut)
  console.log('fix_or leg summary:', JSON.stringify(fixOut.leg_level.summary))
  console.log('fix_or end-to-end:', JSON.stringify(fixOut.end_to_end.summary))
  console.log('fix_or frozen:', JSON.stringify(fixOut.frozen_41.summary))
  console.log('fix_or verdict:', JSON.stringify(fixOut.verdict))
  console.log('sweep:')
  for (const [k, v] of Object.entries(sweepSummary)) console.log(' ', k, JSON.stringify(v.entity_literal), JSON.stringify(v.canonical_alias))
  L.teardown(track)
}

await main()
