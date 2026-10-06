/**
 * P0-4 · A8 — output budget: TRUNCATE (production) vs WHOLE-ENTRY PACKING.
 *
 * PRODUCTION BEHAVIOUR. `fitToTokenBudget` degrades the TEXT, never the entry: a hit that fits no
 * budget keeps its identity with `truncated: true` and an empty/short body, so the caller still
 * knows it existed. The alternative under test is "整条装箱": walk the ranked hits in order, keep a
 * hit only when its WHOLE text fits the remaining budget, skip it otherwise, and fall back to the
 * top-1 whole hit if nothing fits at all.
 *
 * ARMS
 *   A `truncate` — production `applyOutputBudget` (also what `rt.recall({max_tokens})` does).
 *   B `box`      — whole-entry packing; nothing is ever half-text.
 *
 * METRICS per budget: returned count, `truncated` hit count, gold ids kept (must_include on the real
 * 20-query set; the frozen 41 at a tight budget), output tokens, and whether any hit text is a
 * prefix (half text).
 *
 * VERDICT RULE (brief): must_include does not fall AND the "half text" count is zero ⇒ 采纳.
 *
 * Usage: node mem/scripts/spikes/bench-a8-budget-boxing.mjs
 * PRIVACY: ids / token counts only — never the text.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/a8-budget-boxing.json'))
const LIMIT = 5
const REAL_BUDGETS = [80, 150, 300, 600]
const FROZEN_BUDGETS = [10, 30]

/** Whole-entry packing (the alternative under test). */
export const boxArm = {
  name: 'box',
  budget(hits, { maxTokens }) {
    const kept = []
    let used = 0
    for (const h of hits) {
      const cost = L.estimateTokens(h.text)
      if (used + cost <= maxTokens) {
        kept.push({ ...h, truncated: false })
        used += cost
      }
    }
    if (kept.length === 0 && hits.length > 0) {
      const h = hits[0]
      kept.push({ ...h, truncated: false })
      used = L.estimateTokens(h.text)
    }
    return kept
  },
}

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-a8-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts } = L.loadActiveTexts(snap)
  track.texts = texts
  L.banner('A8 · budget boxing', { active_facts: texts.size, real_budgets: REAL_BUDGETS, frozen_budgets: FROZEN_BUDGETS })
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const queries = L.resolveRealGolds(snap, { texts })

  // Identity must hold at EVERY budget measured, for both the unlimited and the budgeted plan.
  const identity = []
  for (const q of queries) {
    for (const t of [0, ...REAL_BUDGETS]) {
      identity.push(await L.identityCheck(rt, q.q, { limit: LIMIT, maxTokens: t, floors: 'strict', track }))
    }
  }
  const idFail = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - idFail.length}/${identity.length} pass (budgets 0/${REAL_BUDGETS.join('/')})`)

  const real = []
  for (const q of queries) {
    const row = { id: q.id, query: q.q, kind: q.kind, gold: q.gold ?? null, budgets: {} }
    for (const t of REAL_BUDGETS) {
      const prod = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: t, floors: 'strict', track, arm: {} })
      const box = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: t, floors: 'strict', track, arm: boxArm })
      const goldKept = (ids, gold) => (gold ? ids.filter((id) => gold.includes(id)).length : null)
      row.budgets[t] = {
        truncate: {
          ids: prod.ids,
          returned: prod.ids.length,
          truncated: prod.budgeted.filter((h) => h.truncated === true).length,
          empty_text: prod.budgeted.filter((h) => (h.text ?? '') === '').length,
          used_tokens: prod.used_tokens,
          gold_kept: goldKept(prod.ids, q.gold),
        },
        box: {
          ids: box.ids,
          returned: box.ids.length,
          truncated: box.budgeted.filter((h) => h.truncated === true).length,
          empty_text: box.budgeted.filter((h) => (h.text ?? '') === '').length,
          used_tokens: box.used_tokens,
          gold_kept: goldKept(box.ids, q.gold),
          skipped: prod.ids.filter((id) => !box.ids.includes(id)).length,
        },
      }
    }
    real.push(row)
  }
  const goldReal = real.filter((r) => r.gold !== null)
  const realSummary = {}
  for (const t of REAL_BUDGETS) {
    realSummary[t] = {
      truncate: {
        returned_total: real.reduce((n, r) => n + r.budgets[t].truncate.returned, 0),
        truncated_total: real.reduce((n, r) => n + r.budgets[t].truncate.truncated, 0),
        empty_text_total: real.reduce((n, r) => n + r.budgets[t].truncate.empty_text, 0),
        gold_kept: goldReal.reduce((n, r) => n + r.budgets[t].truncate.gold_kept, 0),
        used_tokens_total: real.reduce((n, r) => n + r.budgets[t].truncate.used_tokens, 0),
      },
      box: {
        returned_total: real.reduce((n, r) => n + r.budgets[t].box.returned, 0),
        truncated_total: real.reduce((n, r) => n + r.budgets[t].box.truncated, 0),
        empty_text_total: real.reduce((n, r) => n + r.budgets[t].box.empty_text, 0),
        gold_kept: goldReal.reduce((n, r) => n + r.budgets[t].box.gold_kept, 0),
        used_tokens_total: real.reduce((n, r) => n + r.budgets[t].box.used_tokens, 0),
      },
    }
  }

  // ── frozen 41 at tight budgets: the id-set loss is the decisive reading ──────
  const cases = L.frozenCases()
  const frozen = {}
  for (const t of FROZEN_BUDGETS) {
    for (const [label, arm] of [['truncate', {}], ['box', boxArm]]) {
      const failures = []
      const retrieve = L.makeEvalRetriever({ emb, arm, track, profile: 'strict', maxTokens: t, onIdentity: (r) => { if (!r.ok) failures.push(r) } })
      const report = await L.evaluateCases(cases, retrieve)
      frozen[`${label}_${t}`] = {
        must_include_pass: report.perQuery.filter((q) => q.must_include_satisfied).length,
        must_include: L.round4(report.summary.must_include_pass_rate),
        empty_rate: L.round4(report.summary.empty_rate),
        identity_failures: failures.length,
        blocked: report.perQuery.filter((q) => !q.must_include_satisfied).map((q) => q.query),
      }
      console.log(`frozen[${label}@${t}]: must_include ${frozen[`${label}_${t}`].must_include_pass}/41 empty ${frozen[`${label}_${t}`].empty_rate}`)
    }
  }

  const verdicts = {}
  for (const t of REAL_BUDGETS) {
    const goldNotLower = realSummary[t].box.gold_kept >= realSummary[t].truncate.gold_kept
    const noHalfText = realSummary[t].box.truncated_total === 0
    verdicts[`real_${t}`] = {
      gold_not_lower: goldNotLower,
      half_text_zero: noHalfText,
      gold_delta: realSummary[t].box.gold_kept - realSummary[t].truncate.gold_kept,
      returned_delta: realSummary[t].box.returned_total - realSummary[t].truncate.returned_total,
      verdict: goldNotLower && noHalfText ? 'adopt' : 'reject',
    }
  }
  for (const t of FROZEN_BUDGETS) {
    const v = frozen[`box_${t}`].must_include_pass >= frozen[`truncate_${t}`].must_include_pass
    verdicts[`frozen_${t}`] = { must_include_not_lower: v, delta: frozen[`box_${t}`].must_include_pass - frozen[`truncate_${t}`].must_include_pass, verdict: v ? 'adopt' : 'reject' }
  }

  console.log('\nreal summary', JSON.stringify(realSummary, null, 2))
  console.log('\nverdicts', JSON.stringify(verdicts, null, 2))

  L.writeJson(jsonOut, {
    card: 'A8',
    measured_at: new Date().toISOString(),
    node: process.version,
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size },
    arms: { truncate: 'production fitToTokenBudget (text degraded, entry kept)', box: 'whole-entry packing, skip what does not fit, top-1 fallback' },
    real_budgets: REAL_BUDGETS,
    frozen_budgets: FROZEN_BUDGETS,
    identity: { checked: identity.length, passed: identity.length - idFail.length, failures: idFail },
    real_summary: realSummary,
    real,
    frozen,
    verdicts,
    reproduction: 'node mem/scripts/spikes/bench-a8-budget-boxing.mjs',
  })
  L.teardown(track)
}

await main()
