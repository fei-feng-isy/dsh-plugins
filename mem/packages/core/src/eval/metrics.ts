/** Retrieval-quality metrics (pure functions, backend-agnostic). */

export function precisionAtK(actual: number[], expected: number[], k: number): number {
  if (k < 1) throw new Error('k 必须 >= 1')
  const exp = new Set(expected)
  if (exp.size === 0) return 0
  const top = new Set(actual.slice(0, k))
  let hits = 0
  for (const e of exp) if (top.has(e)) hits++
  return hits / k
}

export function recallAtK(actual: number[], expected: number[], k: number): number {
  if (k < 1) throw new Error('k 必须 >= 1')
  const exp = new Set(expected)
  if (exp.size === 0) return 0
  const top = new Set(actual.slice(0, k))
  let hits = 0
  for (const e of exp) if (top.has(e)) hits++
  return hits / exp.size
}

export function reciprocalRank(actual: number[], expected: number[]): number {
  const exp = new Set(expected)
  if (exp.size === 0) return 0
  for (let i = 0; i < actual.length; i++) {
    if (exp.has(actual[i])) return 1 / (i + 1)
  }
  return 0
}

export interface PerQueryMetrics {
  query: string
  k: number
  precision_at_k: number
  recall_at_k: number
  reciprocal_rank: number
  actual_ids: number[]
  expected_ids: number[]
  must_include_satisfied: boolean
  must_exclude_satisfied: boolean
}

export interface AggregateMetrics {
  n_queries: number
  mean_precision_at_k: number
  mean_recall_at_k: number
  mrr: number
  empty_rate: number
  must_include_pass_rate: number
  must_exclude_pass_rate: number
}

export function aggregate(perQuery: PerQueryMetrics[]): AggregateMetrics {
  const n = perQuery.length
  if (n === 0) {
    return { n_queries: 0, mean_precision_at_k: 0, mean_recall_at_k: 0, mrr: 0, empty_rate: 0, must_include_pass_rate: 0, must_exclude_pass_rate: 0 }
  }
  return {
    n_queries: n,
    mean_precision_at_k: perQuery.reduce((s, m) => s + m.precision_at_k, 0) / n,
    mean_recall_at_k: perQuery.reduce((s, m) => s + m.recall_at_k, 0) / n,
    mrr: perQuery.reduce((s, m) => s + m.reciprocal_rank, 0) / n,
    empty_rate: perQuery.filter((m) => m.actual_ids.length === 0).length / n,
    must_include_pass_rate: perQuery.filter((m) => m.must_include_satisfied).length / n,
    must_exclude_pass_rate: perQuery.filter((m) => m.must_exclude_satisfied).length / n,
  }
}
