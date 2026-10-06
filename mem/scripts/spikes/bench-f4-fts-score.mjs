/**
 * P0-1 · F4 — the FTS leg's SCORE FUNCTION: production `bm25` vs coverage vs a hybrid.
 *
 * HYPOTHESIS (the 2026-10-04 shape). FTS5's `bm25()` sums over the OR'd trigrams, so a long note
 * that incidentally contains several query fragments can outrank the short fact that actually
 * answers the question. The leg's FLOOR already grades by distinct-term coverage
 * (`applyTermFloor` → `countMatchedTerms`), but the SCORE it hands to `fuse` is still bm25.
 *
 * ARMS (identical everywhere except the FTS raw score):
 *   A `bm25`      — production: `-bm25(facts_fts)`, exactly what `MemoryStore.ftsPath` returns.
 *   B `coverage`  — `countMatchedTerms(text, gradedTerms(query)) / terms.length`.
 *   C `hybrid`    — `(bm25 / max(bm25)) × coverage` (normalized bm25 times coverage; keeps the IDF
 *                   information bm25 carries while letting coverage veto a coincidental match).
 *
 * The candidate set is IDENTICAL across arms by construction: the arms only replace the raw score
 * MAP, never its keys, and `applyTermFloor` is deterministic on `(text, terms)`. Measured on this
 * snapshot the FTS `legCap` is 200 > 85 active facts, so the bm25 `ORDER BY … LIMIT cap` does not
 * even bind — the cap cannot be the explanation for anything below. The script ASSERTS the per-arm
 * floored key sets are equal and records it.
 *
 * NETWORKS: frozen 41 (strict floors, real embedder, real remember) + the real 20-query snapshot
 * set (RERANK_AB_REAL.md §1). Each query's production arm is identity-checked against `rt.recall`.
 *
 * VERDICT RULE (from the brief): `must_include` does not fall AND (`must_exclude` or top-3
 * relevant count strictly rises) AND the non-self candidate union does not narrow ⇒ adopt.
 *
 * Usage: node mem/scripts/spikes/bench-f4-fts-score.mjs [--json mem/docs/spikes/raw/f4-fts-score.json]
 * PRIVACY: ids / lengths / scores only — no fact text is ever printed or written.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/f4-fts-score.json'))
const LIMIT = 5

/** The three raw-score functions. All receive (rawFtsMap, {terms, texts}) and return a new Map. */
export const FTS_ARMS = {
  bm25: (raw) => raw,
  coverage: (raw, { terms, texts }) => {
    const n = Math.max(1, terms.length)
    const out = new Map()
    for (const id of raw.keys()) out.set(id, L.countMatchedTerms(texts.get(id) ?? '', terms) / n)
    return out
  },
  hybrid: (raw, { terms, texts }) => {
    let max = 0
    for (const v of raw.values()) if (Number.isFinite(v) && v > max) max = v
    const n = Math.max(1, terms.length)
    const out = new Map()
    for (const [id, v] of raw) {
      const cov = L.countMatchedTerms(texts.get(id) ?? '', terms) / n
      out.set(id, max > 0 ? (v / max) * cov : cov)
    }
    return out
  },
}

const ARM_NAMES = ['bm25', 'coverage', 'hybrid']
const armFor = (name) => ({ name, fts: FTS_ARMS[name] })

const top3Relevant = (ids, gold) => (gold ? ids.slice(0, 3).filter((id) => gold.includes(id)).length : null)
const top1Relevant = (ids, gold) => (gold ? (ids[0] !== undefined && gold.includes(ids[0]) ? 1 : 0) : null)
const rankOf = (ids, id) => (ids.indexOf(id) === -1 ? null : ids.indexOf(id) + 1)

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-f4-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts, meta } = L.loadActiveTexts(snap)
  track.texts = texts
  L.banner('F4 · FTS score function', { snapshot: snap, active_facts: texts.size })

  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const queries = L.resolveRealGolds(snap, { texts })

  // ── identity (production arm must reproduce rt.recall on this snapshot) ──────
  const identity = []
  for (const q of queries) {
    identity.push(await L.identityCheck(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  }
  const identityFailures = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - identityFailures.length}/${identity.length} pass`)
  if (identityFailures.length) console.log('  FAIL', JSON.stringify(identityFailures, null, 2))

  // ── real 20-query network ────────────────────────────────────────────────────
  const real = []
  for (const q of queries) {
    const arms = {}
    const keySets = {}
    const legTops = {}
    for (const name of ARM_NAMES) {
      const pass = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: armFor(name) })
      arms[name] = {
        ids: pass.ids,
        scores: pass.ids.map((id) => pass.scores.find((s) => s.id === id)?.score ?? null),
        pool_size: pass.pool.length,
        top1: top1Relevant(pass.ids, q.gold),
        top3: top3Relevant(pass.ids, q.gold),
        ranks: { 103: rankOf(pass.ids, 103), 117: rankOf(pass.ids, 117), 125: rankOf(pass.ids, 125) },
      }
      // candidate-legality guard: the floored FTS key set may not differ between arms.
      keySets[name] = pass.perVariant.map((v) => [...v.legs[L.FTS_LEG_INDEX].scores.keys()].sort((a, b) => a - b).join(','))
      // Leg-level reading: does the arm move the FTS leg's OWN head at all? Without this, an
      // unchanged fused order would be indistinguishable from an arm that never ran.
      const scores = pass.perVariant[0].legs[L.FTS_LEG_INDEX].scores
      legTops[name] = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5).map(([id, s]) => `${id}@${L.round4(s)}`).join(',')
    }
    const sameKeys = keySets.bm25.every((k, i) => ARM_NAMES.every((n) => keySets[n][i] === k))
    const legDiffers = !ARM_NAMES.every((n) => legTops[n] === legTops.bm25)
    const fusedDiffers = !ARM_NAMES.every((n) => JSON.stringify(arms[n].scores) === JSON.stringify(arms.bm25.scores))
    real.push({
      id: q.id,
      query: q.q,
      kind: q.kind,
      gold: q.gold ?? null,
      same_fts_candidate_set: sameKeys,
      fts_leg_head_differs: legDiffers,
      fused_scores_differ: fusedDiffers,
      fts_leg_top: legTops,
      arms,
    })
  }
  const diagnostics = {
    queries_with_same_candidate_set: real.filter((r) => r.same_fts_candidate_set).length,
    queries_where_fts_leg_head_differs: real.filter((r) => r.fts_leg_head_differs).length,
    queries_where_fused_scores_differ: real.filter((r) => r.fused_scores_differ).length,
    queries_where_returned_ids_differ: real.filter((r) => !ARM_NAMES.every((n) => r.arms[n].ids.join(',') === r.arms.bm25.ids.join(','))).length,
  }

  // ── frozen 41 network ────────────────────────────────────────────────────────
  const cases = L.frozenCases()
  const frozen = {}
  for (const name of ARM_NAMES) {
    const failures = []
    const retrieve = L.makeEvalRetriever({ emb, arm: armFor(name), track, profile: 'strict', onIdentity: (r) => { if (!r.ok) failures.push(r) } })
    const report = await L.evaluateCases(cases, retrieve)
    const s = report.summary
    frozen[name] = {
      precision_at_k: L.round4(s.mean_precision_at_k),
      recall_at_k: L.round4(s.mean_recall_at_k),
      mrr: L.round4(s.mrr),
      must_include: L.round4(s.must_include_pass_rate),
      must_include_pass: report.perQuery.filter((q) => q.must_include_satisfied).length,
      must_include_total: report.perQuery.length,
      must_exclude: L.round4(s.must_exclude_pass_rate),
      must_exclude_pass: report.perQuery.filter((q) => q.must_exclude_satisfied).length,
      empty_rate: L.round4(s.empty_rate),
      top3_relevant_mean: L.round4(
        report.perQuery.reduce((n, q) => n + q.actual_ids.slice(0, 3).filter((id) => q.expected_ids.includes(id)).length, 0)
        / report.perQuery.length,
      ),
      identity_failures: failures.length,
      blocked: report.perQuery.filter((q) => !q.must_include_satisfied).map((q) => q.query),
      per_query: report.perQuery.map((q) => ({ query: q.query, k: q.k, actual: q.actual_ids, expected: q.expected_ids, must_include: q.must_include_satisfied, must_exclude: q.must_exclude_satisfied })),
    }
    console.log(`frozen[${name}]: must_include ${frozen[name].must_include_pass}/${frozen[name].must_include_total} must_exclude ${frozen[name].must_exclude_pass}/${frozen[name].must_include_total} top3rel ${frozen[name].top3_relevant_mean} identity_failures ${failures.length}`)
  }

  // ── aggregate real-set readings ──────────────────────────────────────────────
  const gold = real.filter((r) => r.gold !== null)
  const summarize = (name) => ({
    gold_queries: gold.length,
    top1_ok: gold.filter((r) => r.arms[name].top1 === 1).length,
    top3_relevant_mean: L.round4(gold.reduce((n, r) => n + r.arms[name].top3, 0) / gold.length),
    self_ranks: real.filter((r) => r.kind === 'self').map((r) => ({ query: r.q, ids: r.arms[name].ids, ranks: r.arms[name].ranks })),
  })
  const realSummary = Object.fromEntries(ARM_NAMES.map((n) => [n, summarize(n)]))

  // ── verdict ──────────────────────────────────────────────────────────────────
  const verdicts = {}
  for (const name of ['coverage', 'hybrid']) {
    const f = frozen[name]
    const base = frozen.bm25
    const b = frozen.bm25
    const mustIncludeOk = f.must_include_pass >= b.must_include_pass
    const mustExcludeUp = f.must_exclude_pass > b.must_exclude_pass
    const top3Up = f.top3_relevant_mean > b.top3_relevant_mean
    const realTop3Up = realSummary[name].top3_relevant_mean > realSummary.bm25.top3_relevant_mean
    const noNarrowing = real.every((r) => r.same_fts_candidate_set)
    const adopt = mustIncludeOk && (mustExcludeUp || top3Up || realTop3Up) && noNarrowing
    verdicts[name] = {
      must_include_not_lower: mustIncludeOk,
      must_exclude_strictly_up: mustExcludeUp,
      frozen_top3_up: top3Up,
      real_top3_up: realTop3Up,
      candidate_union_not_narrowed: noNarrowing,
      verdict: adopt ? 'adopt' : 'reject',
      // The measured deltas, so the verdict is auditable without re-reading the tables.
      delta: {
        froze_must_include: f.must_include_pass - base.must_include_pass,
        frozen_must_exclude: f.must_exclude_pass - base.must_exclude_pass,
        frozen_top3: L.round4(f.top3_relevant_mean - base.top3_relevant_mean),
        real_top1: realSummary[name].top1_ok - realSummary.bm25.top1_ok,
        real_top3: L.round4(realSummary[name].top3_relevant_mean - realSummary.bm25.top3_relevant_mean),
      },
    }
  }

  console.log('\narm\tfrozen must_inc\tmust_exc\ttop3\t| real top1\ttop3')
  for (const n of ARM_NAMES) {
    console.log([n, `${frozen[n].must_include_pass}/41`, `${frozen[n].must_exclude_pass}/41`, frozen[n].top3_relevant_mean, '|', `${realSummary[n].top1_ok}/${gold.length}`, realSummary[n].top3_relevant_mean].join('\t'))
  }
  console.log('\nverdicts', JSON.stringify(verdicts, null, 2))
  console.log('\nself-query #103/#117/#125 ranks')
  for (const r of real.filter((x) => x.kind === 'self')) {
    console.log([r.q, ...ARM_NAMES.map((n) => `${n}[${r.arms[n].ids.join(',')}] #103=${r.arms[n].ranks[103] ?? '-'} #117=${r.arms[n].ranks[117] ?? '-'} #125=${r.arms[n].ranks[125] ?? '-'}`)].join('\n  '))
  }

  const out = {
    card: 'F4',
    measured_at: new Date().toISOString(),
    node: process.version,
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size, median_len: [...meta.values()].map((m) => m.len).sort((a, b) => a - b)[Math.floor(meta.size / 2)] },
    limit: LIMIT,
    arms: { bm25: 'production -bm25', coverage: 'countMatchedTerms/terms.length', hybrid: 'normalized bm25 x coverage' },
    identity: { checked: identity.length, passed: identity.length - identityFailures.length, failures: identityFailures },
    real_summary: realSummary,
    diagnostics,
    real,
    frozen,
    verdicts,
    reproduction: `node mem/scripts/spikes/bench-f4-fts-score.mjs --json mem/docs/spikes/raw/f4-fts-score.json`,
  }
  L.writeJson(jsonOut, out)
  L.teardown(track)
}

await main()
