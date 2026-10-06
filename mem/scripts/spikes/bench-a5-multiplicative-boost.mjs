/**
 * P0-3 · A5 — multiplicative post-fusion boost (recency / trust).
 *
 * HYPOTHESIS. A signal that is orthogonal to relevance (how RECENT a fact is, how much it has been
 * reinforced) should nudge the fused order: `final' = final × (1 + α(signal − 0.5))`, α ∈ {0.1,0.2}.
 * The brief pre-registers the expectation: with α capped at 0.2 the effect is ±10%, so at best it
 * moves the tail — if the frozen numbers do not rise, the verdict is 不采纳 and no amount of
 * tuning is allowed to make the numbers move.
 *
 * ARMS (identical everywhere else):
 *   A production fused order.
 *   B/C/D/E  boost by `recency` or `trust`, each at α = 0.1 and 0.2.
 * `proof` is SKIPPED: mem has no proof field on a fact (checked against the schema), and the brief
 * says to skip it when absent rather than invent a placeholder.
 *
 * SIGNALS (documented so the number is reproducible):
 *   - recency: `updated_at ?? created_at` parsed to ms, MIN-MAX normalized across the active corpus
 *     (`(t − min)/(max − min)`; 0.5 if the corpus has one distinct timestamp).
 *   - trust:   the stored `facts.trust_score` (already in [0,1]).
 *
 * METRICS: the same network as P0-1 — frozen 41 (must_include / must_exclude / top-3 relevant) and
 * the real 20-query set (top-1 / top-3 relevant), plus the number of queries whose returned order
 * moved at all.
 *
 * VERDICT RULE (brief): strictly up AND must_include not lower ⇒ 采纳; otherwise 不采纳.
 *
 * Usage: node mem/scripts/spikes/bench-a5-multiplicative-boost.mjs
 * PRIVACY: ids / scores / timestamps only — no fact text.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/a5-multiplicative-boost.json'))
const LIMIT = 5
const ALPHAS = [0.1, 0.2]
const SIGNALS = ['recency', 'trust']

const top3 = (ids, gold) => (gold ? ids.slice(0, 3).filter((id) => gold.includes(id)).length : null)
const top1 = (ids, gold) => (gold ? (ids[0] !== undefined && gold.includes(ids[0]) ? 1 : 0) : null)

/** MIN-MAX normalized recency over the active corpus. */
export function recencySignal(meta) {
  const times = new Map()
  for (const [id, m] of meta) {
    const t = Date.parse(m.updated ?? m.created ?? '')
    times.set(id, Number.isFinite(t) ? t : null)
  }
  const vals = [...times.values()].filter((v) => v !== null)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const out = new Map()
  for (const [id, t] of times) out.set(id, t === null ? 0.5 : max > min ? (t - min) / (max - min) : 0.5)
  return out
}

export function trustSignal(meta) {
  const out = new Map()
  for (const [id, m] of meta) out.set(id, Number.isFinite(m.trust) ? m.trust : 0.5)
  return out
}

/** The boost arm for one signal map + α. */
export const boostArm = (name, signal, alpha) => ({
  name,
  fuse(pool) {
    return pool
      .map((h) => ({ ...h, score: h.score * (1 + alpha * ((signal.get(h.id) ?? 0.5) - 0.5)) }))
      .sort((a, b) => b.score - a.score || a.id - b.id)
  },
})

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-a5-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts, meta } = L.loadActiveTexts(snap)
  track.texts = texts
  const signals = { recency: recencySignal(meta), trust: trustSignal(meta) }
  L.banner('A5 · multiplicative boost', { active_facts: texts.size, alphas: ALPHAS, signals: SIGNALS })
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const queries = L.resolveRealGolds(snap, { texts })

  const identity = []
  for (const q of queries) identity.push(await L.identityCheck(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const idFail = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - idFail.length}/${identity.length} pass`)

  const armNames = []
  const real = []
  for (const q of queries) {
    const base = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const row = { id: q.id, query: q.q, kind: q.kind, gold: q.gold ?? null, base_ids: base.ids, base_top1: top1(base.ids, q.gold), base_top3: top3(base.ids, q.gold), arms: {} }
    for (const sig of SIGNALS) {
      for (const alpha of ALPHAS) {
        const name = `${sig}_a${alpha}`
        if (!armNames.includes(name)) armNames.push(name)
        const pass = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: boostArm(name, signals[sig], alpha) })
        row.arms[name] = {
          ids: pass.ids,
          top1: top1(pass.ids, q.gold),
          top3: top3(pass.ids, q.gold),
          order_changed: pass.ids.join(',') !== base.ids.join(','),
        }
      }
    }
    real.push(row)
  }
  const goldReal = real.filter((r) => r.gold !== null)
  const realSummary = {}
  for (const name of armNames) {
    realSummary[name] = {
      top1_ok: goldReal.filter((r) => r.arms[name].top1 === 1).length,
      base_top1_ok: goldReal.filter((r) => r.base_top1 === 1).length,
      top3_relevant_mean: L.round4(goldReal.reduce((n, r) => n + r.arms[name].top3, 0) / goldReal.length),
      base_top3_relevant_mean: L.round4(goldReal.reduce((n, r) => n + r.base_top3, 0) / goldReal.length),
      queries_with_order_changed: real.filter((r) => r.arms[name].order_changed).length,
    }
  }

  const cases = L.frozenCases()
  const frozen = {}
  for (const name of ['base', ...armNames]) {
    const failures = []
    let arm = { name }
    if (name !== 'base') {
      const [sig, a] = name.split('_a')
      arm = boostArm(name, signals[sig], Number(a))
    }
    const retrieve = L.makeEvalRetriever({ emb, arm, track, profile: 'strict', onIdentity: (r) => { if (!r.ok) failures.push(r) } })
    const report = await L.evaluateCases(cases, retrieve)
    frozen[name] = {
      must_include_pass: report.perQuery.filter((q) => q.must_include_satisfied).length,
      must_include: L.round4(report.summary.must_include_pass_rate),
      must_exclude_pass: report.perQuery.filter((q) => q.must_exclude_satisfied).length,
      must_exclude: L.round4(report.summary.must_exclude_pass_rate),
      top3_relevant_mean: L.round4(report.perQuery.reduce((n, q) => n + q.actual_ids.slice(0, 3).filter((id) => q.expected_ids.includes(id)).length, 0) / report.perQuery.length),
      empty_rate: L.round4(report.summary.empty_rate),
      identity_failures: failures.length,
    }
    console.log(`frozen[${name}]: must_inc ${frozen[name].must_include_pass}/41 must_exc ${frozen[name].must_exclude_pass}/41 top3 ${frozen[name].top3_relevant_mean}`)
  }

  const verdicts = {}
  for (const name of armNames) {
    const f = frozen[name]
    const b = frozen.base
    const mustIncludeOk = f.must_include_pass >= b.must_include_pass
    const frozenUp = f.top3_relevant_mean > b.top3_relevant_mean || f.must_exclude_pass > b.must_exclude_pass
    const realUp = realSummary[name].top3_relevant_mean > realSummary[name].base_top3_relevant_mean || realSummary[name].top1_ok > realSummary[name].base_top1_ok
    verdicts[name] = {
      must_include_not_lower: mustIncludeOk,
      frozen_strictly_up: frozenUp,
      real_strictly_up: realUp,
      delta: {
        frozen_must_include: f.must_include_pass - b.must_include_pass,
        frozen_must_exclude: f.must_exclude_pass - b.must_exclude_pass,
        frozen_top3: L.round4(f.top3_relevant_mean - b.top3_relevant_mean),
        real_top1: realSummary[name].top1_ok - realSummary[name].base_top1_ok,
        real_top3: L.round4(realSummary[name].top3_relevant_mean - realSummary[name].base_top3_relevant_mean),
      },
      verdict: mustIncludeOk && (frozenUp || realUp) ? 'adopt' : 'reject',
    }
  }

  console.log('\nreal summary', JSON.stringify(realSummary, null, 2))
  console.log('\nverdicts', JSON.stringify(verdicts, null, 2))

  L.writeJson(jsonOut, {
    card: 'A5',
    measured_at: new Date().toISOString(),
    node: process.version,
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size },
    alphas: ALPHAS,
    signals: { recency: 'min-max(updated_at ?? created_at) over active corpus', trust: 'facts.trust_score', proof: 'skipped — mem has no proof field' },
    identity: { checked: identity.length, passed: identity.length - idFail.length, failures: idFail },
    real_summary: realSummary,
    real,
    frozen,
    verdicts,
    reproduction: 'node mem/scripts/spikes/bench-a5-multiplicative-boost.mjs',
  })
  L.teardown(track)
}

await main()
