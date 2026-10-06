/**
 * R2-1 · F4's POSITIVE CONTROL — is the round-1 "no difference" a real property or a dead arm?
 *
 * ROUND 1's TENSION. On the live 20-query network the three FTS score functions (bm25 / coverage /
 * hybrid) produced IDENTICAL fused scores on 20/20 queries while the FTS leg's OWN head differed on
 * 2/20. Two readings were left open:
 *   (a) the FTS leg has no say in the returned order on that network (the semantic leg dominates),
 *       so the measurement was a false green — the arm never had a chance to matter; or
 *   (b) the FTS score function genuinely cannot move the delivered order.
 * Round 1 could not separate them. This card does, and it MUST prove its own harness can detect a
 * change (a positive control), or the card does not count.
 *
 * NETWORKS (semantic leg made unavailable / its weight zeroed).
 *   `degraded`  — a stub backend with `isAvailable() === false`, so `hybridSearch` picks the
 *                 production `DEGRADED_WEIGHTS` (semantic 0.00 / fts 0.65 / jaccard 0.35). This is
 *                 the real "semantic leg is down" network.
 *   `fts_only`  — same degraded runtime, weights overridden to semantic 0.00 / fts 1.00 /
 *                 jaccard 0.35: the FTS leg is made DECISIVE, so if its score function can ever
 *                 change the order, it must here.
 *   `live_sem0` — real embedder, weights semantic 0.00 / fts 1.00 / jaccard 0.35: the semantic leg
 *                 still contributes CANDIDATES (union) but no score.
 * Each network runs four arms: `bm25` (production), `coverage`, `hybrid`, and `inverted` — the
 * POSITIVE CONTROL, a within-leg order reversal that preserves the raw score range
 * (`v -> (min + max) - v`), so the leg's head is the previous tail. No query may make the three
 * production arms differ; at least one MUST make the control differ.
 *
 * VERDICT RULE (brief). Any divergence among bm25/coverage/hybrid on a semantic-disabled network => F4
 * is "valid only on lexically dominated networks" (conditional). Zero divergence on ALL measured
 * networks WITH a passing positive control => the F4 veto is sealed.
 *
 * Usage: node mem/scripts/spikes/bench-r2-1-f4-negative-control.mjs [--json <path>]
 * PRIVACY: ids / scores / lengths only — no fact text is printed or written.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round2-r2-1-f4-negative-control.json'))
const LIMIT = 5

/** The three production candidates (identical definitions to round 1's bench-f4-fts-score.mjs). */
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
  /** POSITIVE CONTROL: reverse the leg's own order while preserving its raw range. */
  inverted: (raw) => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const v of raw.values()) {
      if (v < min) min = v
      if (v > max) max = v
    }
    const out = new Map()
    for (const [id, v] of raw) out.set(id, min + max - v)
    return out
  },
}

const ARM_NAMES = ['bm25', 'coverage', 'hybrid', 'inverted']
const PROD_ARMS = ['bm25', 'coverage', 'hybrid']
const armFor = (name, weights) => ({ name, fts: FTS_ARMS[name], ...(weights === undefined ? {} : { weights }) })

const top1Relevant = (ids, gold) => (gold ? (ids[0] !== undefined && gold.includes(ids[0]) ? 1 : 0) : null)
const top3Relevant = (ids, gold) => (gold ? ids.slice(0, 3).filter((id) => gold.includes(id)).length : null)

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-r21-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts, meta } = L.loadActiveTexts(snap)
  track.texts = texts
  L.banner('R2-1 · F4 negative + positive control', { snapshot: snap, active_facts: texts.size })

  const rtLive = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const rtDeg = L.newRuntime({ snapPath: snap, semantic: L.degradedSemantic(), track })
  const queries = L.resolveRealGolds(snap, { texts })

  const DEG = L.DEGRADED_WEIGHTS
  const FTS_DOM = { semantic: 0, fts: 1, jaccard: DEG.jaccard }
  const NETWORKS = [
    { id: 'degraded', rt: rtDeg, semAvail: false, weights: DEG, note: 'production DEGRADED_WEIGHTS' },
    { id: 'fts_only', rt: rtDeg, semAvail: false, weights: FTS_DOM, note: 'semantic 0 / fts 1' },
    { id: 'live_sem0', rt: rtLive, semAvail: true, weights: FTS_DOM, note: 'semantic available but weight 0' },
  ]

  // ── identity on the degraded runtime (production arm = the degraded network) ────────────────
  const identityDeg = []
  for (const q of queries) identityDeg.push(await L.identityCheck(rtDeg, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const identityDegFailures = identityDeg.filter((r) => !r.ok)
  console.log(`identity(degraded runtime, production arm): ${identityDeg.length - identityDegFailures.length}/${identityDeg.length}`)
  if (identityDegFailures.length) console.log('  FAIL', JSON.stringify(identityDegFailures.slice(0, 3), null, 2))

  const networks = {}
  for (const net of NETWORKS) {
    const perQuery = []
    for (const q of queries) {
      const arms = {}
      const legTops = {}
      for (const name of ARM_NAMES) {
        const pass = await L.runScript(net.rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: armFor(name, net.weights) })
        arms[name] = {
          ids: pass.ids,
          scores: pass.ids.map((id) => pass.scores.find((s) => s.id === id)?.score ?? null),
          top1: top1Relevant(pass.ids, q.gold),
          top3: top3Relevant(pass.ids, q.gold),
        }
        const scores = pass.perVariant[0].legs[L.FTS_LEG_INDEX].scores
        legTops[name] = [...scores.entries()]
          .sort((a, b) => b[1] - a[1] || a[0] - b[0])
          .slice(0, 5)
          .map(([id, s]) => `${id}@${L.round4(s)}`)
          .join(',')
      }
      const sameIds = PROD_ARMS.every((n) => arms[n].ids.join(',') === arms.bm25.ids.join(','))
      const sameScores = PROD_ARMS.every((n) => JSON.stringify(arms[n].scores) === JSON.stringify(arms.bm25.scores))
      perQuery.push({
        id: q.id,
        query: q.q,
        kind: q.kind,
        gold: q.gold ?? null,
        prod_arms_same_ids: sameIds,
        prod_arms_same_scores: sameScores,
        fts_leg_head_differs: !PROD_ARMS.every((n) => legTops[n] === legTops.bm25),
        control_ids_differ: arms.inverted.ids.join(',') !== arms.bm25.ids.join(','),
        arms: Object.fromEntries(ARM_NAMES.map((n) => [n, arms[n]])),
        fts_leg_top: legTops,
      })
    }
    networks[net.id] = {
      note: net.note,
      sem_available: net.semAvail,
      weights: net.weights,
      queries: perQuery,
      diagnostics: {
        queries_total: perQuery.length,
        prod_arms_identical_ids: perQuery.filter((r) => r.prod_arms_same_ids).length,
        prod_arms_identical_scores: perQuery.filter((r) => r.prod_arms_same_scores).length,
        queries_where_fts_leg_head_differs: perQuery.filter((r) => r.fts_leg_head_differs).length,
        queries_where_control_ids_differ: perQuery.filter((r) => r.control_ids_differ).length,
        // Which queries the production arms disagree on, and by how much — the evidence a
        // "conditional" verdict has to name (ids and scores only).
        divergent_queries: perQuery.filter((r) => !r.prod_arms_same_ids).map((r) => ({
          id: r.id,
          query: r.query,
          gold: r.gold,
          ids_by_arm: Object.fromEntries(PROD_ARMS.map((n) => [n, r.arms[n].ids])),
          scores_by_arm: Object.fromEntries(PROD_ARMS.map((n) => [n, r.arms[n].scores])),
        })),
      },
    }
    const d = networks[net.id].diagnostics
    console.log(`[${net.id}] prod arms identical ids ${d.prod_arms_identical_ids}/${d.queries_total} scores ${d.prod_arms_identical_scores}/${d.queries_total}; fts head differs ${d.queries_where_fts_leg_head_differs}; control differs ${d.queries_where_control_ids_differ}`)
  }

  // ── positive control gate + verdict ─────────────────────────────────────────────────────────
  const controlOk = Object.values(networks).some((n) => n.diagnostics.queries_where_control_ids_differ > 0)
  const anyDivergence = Object.values(networks).some((n) => n.diagnostics.prod_arms_identical_ids < n.diagnostics.queries_total)
  const quality = {}
  for (const net of NETWORKS) {
    const goldRows = networks[net.id].queries.filter((r) => r.gold !== null)
    quality[net.id] = Object.fromEntries(PROD_ARMS.map((name) => [
      name,
      {
        gold_queries: goldRows.length,
        top1_ok: goldRows.filter((r) => r.arms[name].top1 === 1).length,
        top3_relevant_mean: L.round4(goldRows.reduce((n, r) => n + r.arms[name].top3, 0) / goldRows.length),
      },
    ]))
  }
  const verdict = {
    positive_control_passed: controlOk,
    any_production_arm_divergence: anyDivergence,
    call: !controlOk
      ? 'card_invalid_positive_control_failed'
      : anyDivergence
        ? 'conditional_adopt_only_on_lexically_dominated_networks'
        : 'reject_sealed',
  }

  const out = {
    card: 'R2-1',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size, median_len: [...meta.values()].map((m) => m.len).sort((a, b) => a - b)[Math.floor(meta.size / 2)] },
    networks: networks,
    quality_by_network: quality,
    identity: { runtime: 'degraded', checked: identityDeg.length, passed: identityDeg.length - identityDegFailures.length, failures: identityDegFailures },
    verdict,
    reproduction: 'node mem/scripts/spikes/bench-r2-1-f4-negative-control.mjs --json mem/docs/spikes/raw/round2-r2-1-f4-negative-control.json',
  }
  L.writeJson(jsonOut, out)
  L.teardown(track)
}

await main()
