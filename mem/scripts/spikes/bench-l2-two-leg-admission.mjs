/**
 * P0-2 · L2 — "≥2 legs must have evidence" admission (a NEGATIVE hypothesis, expected 不采纳).
 *
 * HYPOTHESIS UNDER TEST. A candidate that only ONE leg admitted is noise, so the fused pool should
 * drop it unless it is close to the top-1. The brief pre-registers the expected answer as 不采纳:
 * intersection-style admission deletes single-leg strong hits, which is independently the same
 * conclusion the repo review and the hindsight MinScores note reached. The value of this card is the
 * COUNTER-EVIDENCE NUMBER, not a win.
 *
 * ARMS. Production pool; then, on that pool only:
 *   `keep = (legs with evidence >= 2) OR (score >= top1 × (1 − δ))`, δ ∈ {0.20, 0.40}.
 * "Evidence" = the leg's FLOORED score map has this id with a score > 0 — exactly the three legs
 * `fuse` sees. Nothing else changes: the semantic / FTS / entity legs, the floors and the limit are
 * byte-identical to production.
 *
 * METRICS: gold ids removed from the returned top-5; top-3 relevant count (real 20 + frozen 41);
 * how many RETURNED hits are single-leg (the shape the rule targets); and whether the accident
 * fixture (a single-leg strong hit) is among them.
 *
 * VERDICT RULE (brief): any gold removed OR top-3 not up ⇒ 不采纳 (record the numbers).
 *
 * Usage: node mem/scripts/spikes/bench-l2-two-leg-admission.mjs
 * PRIVACY: ids / scores only — no fact text.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/l2-two-leg-admission.json'))
const LIMIT = 5
const DELTAS = [0.2, 0.4]

const evidenceOf = (legs) => {
  const ev = new Map()
  for (const leg of legs) {
    for (const [id, s] of leg.scores) if (Number.isFinite(s) && s > 0) ev.set(id, (ev.get(id) ?? 0) + 1)
  }
  return ev
}

/** Build the admission arm for one δ. */
export const admissionArm = (delta) => ({
  name: `admit2_d${delta}`,
  fuse(pool, { legs }) {
    if (pool.length === 0) return pool
    const ev = evidenceOf(legs)
    const top = pool[0].score
    const keep = pool.filter((h) => (ev.get(h.id) ?? 0) >= 2 || h.score >= top * (1 - delta))
    return keep
  },
})

const top3 = (ids, gold) => (gold ? ids.slice(0, 3).filter((id) => gold.includes(id)).length : null)

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-l2-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts } = L.loadActiveTexts(snap)
  track.texts = texts
  L.banner('L2 · ≥2-leg admission', { active_facts: texts.size })
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const queries = L.resolveRealGolds(snap, { texts })

  const identity = []
  for (const q of queries) identity.push(await L.identityCheck(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const idFail = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - idFail.length}/${identity.length} pass`)

  // ── real set ─────────────────────────────────────────────────────────────────
  const real = []
  for (const q of queries) {
    const base = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const ev = evidenceOf(base.legs)
    const row = {
      id: q.id,
      query: q.q,
      kind: q.kind,
      gold: q.gold ?? null,
      base_ids: base.ids,
      base_top3: top3(base.ids, q.gold),
      returned_evidence: base.ranked.map((h) => ({ id: h.id, evidence: ev.get(h.id) ?? 0, score: L.round4(h.score) })),
      arms: {},
    }
    for (const delta of DELTAS) {
      const pass = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: admissionArm(delta) })
      const removed = base.ids.filter((id) => !pass.ids.includes(id))
      row.arms[`d${delta}`] = {
        delta,
        ids: pass.ids,
        top3: top3(pass.ids, q.gold),
        removed_from_top5: removed,
        gold_removed: q.gold ? removed.filter((id) => q.gold.includes(id)) : [],
        single_leg_hits_removed: removed.filter((id) => (ev.get(id) ?? 0) < 2),
      }
    }
    real.push(row)
  }
  const goldReal = real.filter((r) => r.gold !== null)
  const realSummary = {}
  for (const delta of DELTAS) {
    const k = `d${delta}`
    realSummary[k] = {
      gold_queries: goldReal.length,
      gold_removed_total: goldReal.reduce((n, r) => n + r.arms[k].gold_removed.length, 0),
      gold_removed_detail: goldReal.flatMap((r) => r.arms[k].gold_removed.map((id) => ({ query: r.q, id }))),
      top3_relevant_mean: L.round4(goldReal.reduce((n, r) => n + r.arms[k].top3, 0) / goldReal.length),
      base_top3_relevant_mean: L.round4(goldReal.reduce((n, r) => n + r.base_top3, 0) / goldReal.length),
      hits_removed_total: real.reduce((n, r) => n + r.arms[k].removed_from_top5.length, 0),
      single_leg_hits_removed_total: real.reduce((n, r) => n + r.arms[k].single_leg_hits_removed.length, 0),
    }
  }
  const returnedHits = real.flatMap((r) => r.returned_evidence)
  const evidenceHistogram = {}
  for (const h of returnedHits) evidenceHistogram[h.evidence] = (evidenceHistogram[h.evidence] ?? 0) + 1

  // ── frozen 41 ────────────────────────────────────────────────────────────────
  const cases = L.frozenCases()
  const frozen = {}
  for (const delta of DELTAS) {
    const failures = []
    const retrieve = L.makeEvalRetriever({ emb, arm: admissionArm(delta), track, profile: 'strict', onIdentity: (r) => { if (!r.ok) failures.push(r) } })
    const report = await L.evaluateCases(cases, retrieve)
    frozen[`d${delta}`] = {
      must_include: L.round4(report.summary.must_include_pass_rate),
      must_include_pass: report.perQuery.filter((q) => q.must_include_satisfied).length,
      must_exclude: L.round4(report.summary.must_exclude_pass_rate),
      empty_rate: L.round4(report.summary.empty_rate),
      top3_relevant_mean: L.round4(report.perQuery.reduce((n, q) => n + q.actual_ids.slice(0, 3).filter((id) => q.expected_ids.includes(id)).length, 0) / report.perQuery.length),
      identity_failures: failures.length,
      blocked_missing_expected: report.perQuery.filter((q) => !q.must_include_satisfied).map((q) => ({ query: q.query, actual: q.actual_ids, expected: q.expected_ids })),
    }
    console.log(`frozen[d${delta}]: must_include ${frozen[`d${delta}`].must_include_pass}/41 top3 ${frozen[`d${delta}`].top3_relevant_mean} empty ${frozen[`d${delta}`].empty_rate}`)
  }
  // baseline frozen for the delta comparison (no arm)
  const failures0 = []
  const baseRetrieve = L.makeEvalRetriever({ emb, arm: { name: 'base' }, track, profile: 'strict', onIdentity: (r) => { if (!r.ok) failures0.push(r) } })
  const baseReport = await L.evaluateCases(cases, baseRetrieve)
  const frozenBase = {
    must_include_pass: baseReport.perQuery.filter((q) => q.must_include_satisfied).length,
    must_include: L.round4(baseReport.summary.must_include_pass_rate),
    top3_relevant_mean: L.round4(baseReport.perQuery.reduce((n, q) => n + q.actual_ids.slice(0, 3).filter((id) => q.expected_ids.includes(id)).length, 0) / baseReport.perQuery.length),
    identity_failures: failures0.length,
  }

  // ── verdict ──────────────────────────────────────────────────────────────────
  const verdicts = {}
  for (const delta of DELTAS) {
    const k = `d${delta}`
    const anyGoldRemoved = realSummary[k].gold_removed_total > 0
    const top3Up = realSummary[k].top3_relevant_mean > realSummary[k].base_top3_relevant_mean || frozen[k].top3_relevant_mean > frozenBase.top3_relevant_mean
    verdicts[k] = {
      gold_removed: realSummary[k].gold_removed_total,
      must_include_frozen: `${frozen[k].must_include_pass}/41 (base ${frozenBase.must_include_pass}/41)`,
      top3_up: top3Up,
      verdict: !anyGoldRemoved && top3Up ? 'adopt' : 'reject',
      reason: anyGoldRemoved ? 'gold removed' : top3Up ? 'gains without gold loss' : 'no gain',
    }
  }

  console.log('\nreal (gold queries):', JSON.stringify(realSummary, null, 2))
  console.log('\nreturned-hit evidence histogram (1 = single-leg):', JSON.stringify(evidenceHistogram))
  console.log('\nverdicts', JSON.stringify(verdicts, null, 2))

  L.writeJson(jsonOut, {
    card: 'L2',
    measured_at: new Date().toISOString(),
    node: process.version,
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size },
    rule: 'keep = (#legs with evidence >= 2) OR score >= top1*(1-delta)',
    deltas: DELTAS,
    identity: { checked: identity.length, passed: identity.length - idFail.length, failures: idFail },
    evidence_histogram_returned_hits: evidenceHistogram,
    real_summary: realSummary,
    real,
    frozen_base: frozenBase,
    frozen,
    verdicts,
    reproduction: 'node mem/scripts/spikes/bench-l2-two-leg-admission.mjs',
  })
  L.teardown(track)
}

await main()
