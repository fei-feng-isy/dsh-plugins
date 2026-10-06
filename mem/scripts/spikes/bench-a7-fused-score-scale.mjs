/**
 * P1-3 · A7/F2 — is there a CROSS-QUERY ABSOLUTE fused score? (feasibility; likely 不适用).
 *
 * THE QUESTION. hindsight-style "give up answering when the fused score is below a threshold"
 * assumes the fused number means the same thing across queries. `retrieval-core/src/fusion.ts`
 * scales every leg by that leg's OWN maximum, so each leg's head is 1.0 BY CONSTRUCTION — which
 * makes the fused number comparable only WITHIN one query (`store/floors.ts` says exactly this and
 * puts the cutoffs on the legs' absolute RAW scores instead). This card turns that design statement
 * into measured numbers.
 *
 * WHAT IS MEASURED
 *   1. the fused top-1 of every query in both networks (real 20 + frozen 41) — its distribution,
 *      and how close it sits to the weight-sum ceiling `Σ weights`;
 *   2. the semantic leg's RAW cosine of the same top-1 candidate — the absolute scale that IS
 *      cross-query comparable and is what the floors use;
 *   3. a threshold-separability test: sweep a fixed fused threshold and ask whether it separates
 *      queries that have a declared gold answer from those that do not (real set), and whether it
 *      separates the frozen cases' satisfied/un-satisfied queries (it cannot — the fused top-1 is
 *      per-query monotone by construction).
 *
 * VERDICT (brief): no absolute scale ⇒ **不适用**; the empty-answer decision stays on the per-leg
 * absolute raw floors, and this card records WHY rather than forcing a threshold.
 *
 * Usage: node mem/scripts/spikes/bench-a7-fused-score-scale.mjs
 * PRIVACY: ids / scores only — no fact text.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/a7-fused-score-scale.json'))
const LIMIT = 5

function quantiles(values) {
  const v = [...values].sort((a, b) => a - b)
  const at = (p) => (v.length === 0 ? null : L.round4(v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]))
  return { n: v.length, min: at(0), p10: at(0.1), p25: at(0.25), median: at(0.5), p75: at(0.75), p90: at(0.9), max: at(1) }
}

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-a7-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts } = L.loadActiveTexts(snap)
  track.texts = texts
  L.banner('A7/F2 · fused-score scale', { active_facts: texts.size })
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const queries = L.resolveRealGolds(snap, { texts })

  const identity = []
  for (const q of queries) identity.push(await L.identityCheck(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const idFail = identity.filter((r) => !r.ok)

  const config = rt.memory.config.retriever
  const weightSum = config.weight_semantic + config.weight_fts + config.weight_jaccard

  // ── real set ─────────────────────────────────────────────────────────────────
  const real = []
  for (const q of queries) {
    const pass = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const top = pass.pool[0]
    // The semantic leg's absolute cosine for the same candidate (raw, pre-normalization).
    const semRaw = pass.perVariant[0].raw.semantic
    real.push({
      id: q.id,
      query: q.q,
      kind: q.kind,
      has_gold: q.gold !== null,
      pooled: pass.pool.length,
      fused_top1: top ? L.round4(top.score) : 0,
      fused_top1_id: top?.id ?? null,
      semantic_top1: L.round4(Math.max(0, ...semRaw.values())),
      semantic_of_fused_top1: semRaw.has(top?.id) ? L.round4(semRaw.get(top.id)) : null,
      weighted_leg_heads: L.round4(pass.legs.filter((l) => l.scores.size > 0).reduce((n, l) => n + l.weight, 0)),
    })
  }

  // ── frozen 41 ────────────────────────────────────────────────────────────────
  const cases = L.frozenCases()
  const frozenPasses = []
  const failures = []
  const retrieve = L.makeEvalRetriever({
    emb,
    arm: { name: 'a7' },
    track,
    profile: 'strict',
    onIdentity: (r) => { if (!r.ok) failures.push(r) },
    afterPass: (query, pass) => {
      const top = pass.pool[0]
      const semRaw = pass.perVariant[0].raw.semantic
      frozenPasses.push({
        query,
        fused_top1: top ? L.round4(top.score) : 0,
        semantic_top1: L.round4(Math.max(0, ...semRaw.values())),
        weighted_leg_heads: L.round4(pass.legs.filter((l) => l.scores.size > 0).reduce((n, l) => n + l.weight, 0)),
      })
    },
  })
  const report = await L.evaluateCases(cases, retrieve)

  const allTop1 = [...real.filter((r) => r.pooled > 0).map((r) => r.fused_top1), ...frozenPasses.map((r) => r.fused_top1)]
  const allSem = [...real.map((r) => r.semantic_top1), ...frozenPasses.map((r) => r.semantic_top1)]

  // ── threshold separability (real set: has_gold vs not) ───────────────────────
  const thresholds = []
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const tau = L.round4(t)
    const predicted = real.filter((r) => r.fused_top1 >= tau).map((r) => r.has_gold)
    const tp = predicted.filter(Boolean).length
    const fp = predicted.length - tp
    const fn = real.filter((r) => r.has_gold && r.fused_top1 < tau).length
    const tn = real.filter((r) => !r.has_gold && r.fused_top1 < tau).length
    thresholds.push({ tau, tp, fp, fn, tn, precision: tp + fp === 0 ? null : L.round4(tp / (tp + fp)), recall: tp + fn === 0 ? null : L.round4(tp / (tp + fn)) })
  }
  const separating = thresholds.filter((r) => r.fp === 0 && r.fn === 0)

  // Gold-vs-no-gold overlap on the fused top-1: the direct "no threshold exists" witness.
  const goldTop1 = real.filter((r) => r.has_gold).map((r) => r.fused_top1)
  const noGoldTop1 = real.filter((r) => !r.has_gold).map((r) => r.fused_top1)

  const verdict = {
    absolute_scale_exists: false,
    evidence: {
      weight_sum_ceiling: weightSum,
      fused_top1_min: Math.min(...allTop1),
      fused_top1_median: quantiles(allTop1).median,
      semantic_top1_median: quantiles(allSem).median,
      real_no_gold_top1_max: Math.max(...noGoldTop1),
      real_gold_top1_min: Math.min(...goldTop1),
      separating_thresholds_count: separating.length,
    },
    verdict: '不适用 (not applicable)',
    reason: 'fusion scales every leg by its own maximum (retrieval-core/src/fusion.ts), so the fused number is only comparable WITHIN one query; no fixed fused threshold separates answer from no-answer, and the empty-answer decision must keep resting on the per-leg absolute raw floors (store/floors.ts).',
  }

  console.log('fused_top1 quantiles', JSON.stringify(quantiles(allTop1)))
  console.log('semantic_top1 quantiles', JSON.stringify(quantiles(allSem)))
  console.log('real gold top1', JSON.stringify(goldTop1), 'no-gold top1', JSON.stringify(noGoldTop1))
  console.log('separating thresholds', separating.length)
  console.log('verdict', JSON.stringify(verdict, null, 2))

  L.writeJson(jsonOut, {
    card: 'A7/F2',
    measured_at: new Date().toISOString(),
    node: process.version,
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size },
    code_evidence: [
      'retrieval-core/src/fusion.ts: fuse() scales each path by that path\u2019s own maximum (scaleByMax).',
      'store/floors.ts module comment: "the fused number is only comparable WITHIN one query" — the cutoffs live on the legs\u2019 absolute raw scores.',
    ],
    weight_sum_ceiling: weightSum,
    fused_top1_quantiles: quantiles(allTop1),
    semantic_top1_quantiles: quantiles(allSem),
    real_gold_top1: goldTop1,
    real_no_gold_top1: noGoldTop1,
    threshold_sweep: thresholds,
    separating_thresholds: separating,
    frozen: { queries: frozenPasses.length, identity_failures: failures.length, passes: frozenPasses },
    real,
    verdict,
    reproduction: 'node mem/scripts/spikes/bench-a7-fused-score-scale.mjs',
  })
  L.teardown(track)
}

await main()
