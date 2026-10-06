import { describe, it, expect } from 'vitest'
import {
  aggregate,
  aggregateRanking,
  dcgAtK,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  relevantInTop,
  reciprocalRank,
  TOP_N,
} from '../src/eval/metrics.js'
import { evaluateCases } from '../src/eval/runner.js'
import type { EvalCase } from '../src/eval/loader.js'

const perQuery = (actual: number[], expected: number[], k = 3) => ({
  query: 'q',
  k,
  precision_at_k: precisionAtK(actual, expected, k),
  recall_at_k: recallAtK(actual, expected, k),
  reciprocal_rank: reciprocalRank(actual, expected),
  actual_ids: actual,
  expected_ids: expected,
  must_include_satisfied: true,
  must_exclude_satisfied: true,
})

describe('P-02 ranking metrics', () => {
  it('nDCG@k uses binary relevance and an IDCG over min(|expected|, k)', () => {
    // The only relevant fact is first → perfect.
    expect(ndcgAtK([0, 1, 2], [0], 3)).toBe(1)
    // …second → 1/log2(3) divided by the ideal 1/log2(2)=1.
    expect(ndcgAtK([1, 0], [0], 2)).toBeCloseTo(1 / Math.log2(3), 12)
    // No relevance at all → 0, never NaN.
    expect(ndcgAtK([1, 2], [0], 2)).toBe(0)
    expect(ndcgAtK([1, 2], [], 2)).toBe(0)
    // Two relevant facts, both present in the ideal two slots → perfect.
    expect(ndcgAtK([0, 1], [0, 1], 2)).toBe(1)
    // DCG is the numerator and is exposed separately.
    expect(dcgAtK([1, 0], [0], 2)).toBeCloseTo(1 / Math.log2(3), 12)
    expect(dcgAtK([0, 1], [0], 2)).toBe(1)
    expect(() => ndcgAtK([0], [0], 0)).toThrow(/k 必须 >= 1/)
  })

  it('counts relevant results inside the top-3 window', () => {
    expect(TOP_N).toBe(3)
    expect(relevantInTop([5, 0, 1, 2], [0, 1], 3)).toBe(2)
    expect(relevantInTop([5, 0, 1, 2], [0, 1], 2)).toBe(1)
    // A shorter-than-3 result list is the window.
    expect(relevantInTop([0, 1], [0, 1, 2], 3)).toBe(2)
    expect(relevantInTop([], [0], 3)).toBe(0)
    expect(() => relevantInTop([0], [0], 0)).toThrow(/n 必须 >= 1/)
  })

  it('aggregates ranking separately from the frozen summary', () => {
    const rows = [perQuery([0, 1, 2], [0], 3), perQuery([1, 2, 3], [0], 3)]
    const ranking = aggregateRanking(rows)
    expect(ranking.n_queries).toBe(2)
    expect(ranking.mean_ndcg_at_k).toBeCloseTo((1 + 0) / 2, 12)
    expect(ranking.top3_relevant_total).toBe(1)
    expect(ranking.mean_top3_relevant).toBe(0.5)
    expect(ranking.top3_hit_rate).toBe(0.5)
    // The summary aggregate is untouched by the ranking aggregate.
    expect(Object.keys(aggregate(rows)).sort()).toEqual([
      'empty_rate', 'mean_precision_at_k', 'mean_recall_at_k', 'mrr',
      'must_exclude_pass_rate', 'must_include_pass_rate', 'n_queries',
    ])
    expect(aggregateRanking([])).toEqual({ n_queries: 0, mean_ndcg_at_k: 0, top3_relevant_total: 0, mean_top3_relevant: 0, top3_hit_rate: 0 })
  })

  it('evaluateCases exposes ranking as a SIBLING of summary, not a key inside it', async () => {
    const cases: EvalCase[] = [{
      id: 'c1',
      tags: [],
      setup_facts: ['a', 'b', 'c'],
      queries: [{ query: 'q', k: 3, expected_ids: [0], must_include: [0], must_exclude: [] }],
    }]
    const report = await evaluateCases(cases, async () => [0, 1, 2])
    // The seven frozen keys and nothing more: this is the invariant `eval_zh.spec.ts` pins with
    // `toEqual`, so a metric added here instead of beside it would break that spec.
    expect(Object.keys(report.summary).length).toBe(7)
    expect(Object.keys(report.summary)).not.toContain('ranking')
    expect(Object.keys(report.summary)).not.toContain('ndcg_at_k')
    expect(report.ranking.mean_ndcg_at_k).toBe(1)
    expect(report.ranking.top3_relevant_total).toBe(1)
  })
})
