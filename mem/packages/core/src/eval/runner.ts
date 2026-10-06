import { aggregate, aggregateRanking, precisionAtK, recallAtK, reciprocalRank, type PerQueryMetrics, type AggregateMetrics, type RankingMetrics } from './metrics.js'
import type { EvalCase } from './loader.js'

/** A retrieve function over the case's facts, returning indices in relevance order. */
type RetrieveFn = (query: string, k: number, facts: string[]) => Promise<number[]>

interface EvalReport {
  perQuery: PerQueryMetrics[]
  summary: AggregateMetrics
  /**
   * P-02 ranking-quality metrics. A SIBLING of `summary`, never a key inside it: `eval_zh.spec.ts`
   * asserts `summary` with `toEqual` over exactly seven keys, so a new key there would turn a
   * frozen-number regression into a key-set failure. `perQuery` is unchanged, so the bench
   * harness's `(ids, scores)` fingerprint over it cannot move.
   */
  ranking: RankingMetrics
}

async function evaluateCase(caseData: EvalCase, retrieve: RetrieveFn): Promise<PerQueryMetrics[]> {
  const out: PerQueryMetrics[] = []
  for (const q of caseData.queries) {
    const actual = (await retrieve(q.query, q.k, caseData.setup_facts)).slice(0, q.k)
    const expected = q.expected_ids ?? []
    const top = new Set(actual)
    out.push({
      query: q.query,
      k: q.k,
      precision_at_k: precisionAtK(actual, expected, q.k),
      recall_at_k: recallAtK(actual, expected, q.k),
      reciprocal_rank: reciprocalRank(actual, expected),
      actual_ids: actual,
      expected_ids: expected,
      must_include_satisfied: (q.must_include ?? []).every((id) => top.has(id)),
      must_exclude_satisfied: !(q.must_exclude ?? []).some((id) => top.has(id)),
    })
  }
  return out
}

export async function evaluateCases(cases: EvalCase[], retrieve: RetrieveFn): Promise<EvalReport> {
  const all: PerQueryMetrics[] = []
  for (const c of cases) all.push(...(await evaluateCase(c, retrieve)))
  return { perQuery: all, summary: aggregate(all), ranking: aggregateRanking(all) }
}
