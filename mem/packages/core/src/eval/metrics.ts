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

// ─── ranking metrics (P-02) ──────────────────────────────────────────────────
//
// These are RANKING-quality numbers that `summary` deliberately does not carry: `summary`'s seven
// keys are asserted with `toEqual` to the last bit by `eval_zh.spec.ts`, so a new key there turns a
// frozen-number regression into a key-set failure. `evaluateCases` returns them as the SIBLING
// `ranking` field instead (see `runner.ts`), which is additive and cannot move the frozen numbers.
//
// Binary relevance, exactly like the bench harness's A1 nDCG (`scripts/bench/lib/quality.mjs`), so
// the two agree by construction: DCG over the returned order, IDCG over `min(|expected|, k)` ideal
// slots.

/** Discounted cumulative gain at k (binary relevance). */
export function dcgAtK(actual: number[], expected: number[], k: number): number {
  if (k < 1) throw new Error('k 必须 >= 1')
  const exp = new Set(expected)
  let dcg = 0
  for (let i = 0; i < Math.min(actual.length, k); i++) {
    if (exp.has(actual[i])) dcg += 1 / Math.log2(i + 2)
  }
  return dcg
}

/**
 * nDCG@k (binary relevance).
 *
 * 0 when there is nothing relevant to find (and when the ideal ranking is empty), never NaN — the
 * per-query value is averaged and a NaN would poison the whole aggregate.
 */
export function ndcgAtK(actual: number[], expected: number[], k: number): number {
  if (k < 1) throw new Error('k 必须 >= 1')
  const ideal = Math.min(new Set(expected).size, k)
  if (ideal === 0) return 0
  let idcg = 0
  for (let i = 1; i <= ideal; i++) idcg += 1 / Math.log2(i + 1)
  return dcgAtK(actual, expected, k) / idcg
}

/** How many relevant results appear in the first `n` slots. */
export function relevantInTop(actual: number[], expected: number[], n: number): number {
  if (n < 1) throw new Error('n 必须 >= 1')
  const exp = new Set(expected)
  let hits = 0
  for (let i = 0; i < Math.min(actual.length, n); i++) if (exp.has(actual[i])) hits++
  return hits
}

/** The window "top-3 relevant count" is measured over. */
export const TOP_N = 3

export interface RankingMetrics {
  n_queries: number
  mean_ndcg_at_k: number
  /** Relevant results inside the top {@link TOP_N}, summed over queries. */
  top3_relevant_total: number
  /** Mean relevant results inside the top {@link TOP_N}. */
  mean_top3_relevant: number
  /** Fraction of queries with at least one relevant result in the top {@link TOP_N}. */
  top3_hit_rate: number
}

export function aggregateRanking(perQuery: PerQueryMetrics[]): RankingMetrics {
  const n = perQuery.length
  if (n === 0) return { n_queries: 0, mean_ndcg_at_k: 0, top3_relevant_total: 0, mean_top3_relevant: 0, top3_hit_rate: 0 }
  const top3 = perQuery.map((m) => relevantInTop(m.actual_ids, m.expected_ids, TOP_N))
  return {
    n_queries: n,
    mean_ndcg_at_k: perQuery.reduce((s, m) => s + ndcgAtK(m.actual_ids, m.expected_ids, m.k), 0) / n,
    top3_relevant_total: top3.reduce((s, v) => s + v, 0),
    mean_top3_relevant: top3.reduce((s, v) => s + v, 0) / n,
    top3_hit_rate: top3.filter((v) => v > 0).length / n,
  }
}
