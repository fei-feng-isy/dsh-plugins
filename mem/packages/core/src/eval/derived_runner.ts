/**
 * The two arms the P-02 regression net runs, over the derived cases from `derive.ts`.
 *
 *  - `stubRank` / `runDerivedCaseStub`: a DETERMINISTIC, model-free retriever that scores a fact by
 *    how many of the query's literal fragments it contains. It exists to prove the FIXTURE, not the
 *    product: a planted carrier that literally contains the bridge must outrank the gold in the base
 *    arm, and removing it must put the gold back at rank 1. That is the "counterfactual self-check"
 *    the collision sensitivity requirement asks for, and it needs no model to be meaningful.
 *  - `runDerivedCaseReal`: the same cases driven through a real runtime (`remember` + `recall`), for
 *    the nightly job. It is duck-typed so this module does not depend on the runtime.
 *
 * The two arms share ONE outcome shape, so a report can say which arm produced which numbers.
 */

import { fragmentsOf, timeWordsIn, type DerivedCase, type GuardKind } from './derive.js'

export interface RankedFacts {
  /** Fact indices, best first. */
  ranked: number[]
  /** The stub score of each ranked fact (parallel to `ranked`). */
  scores: number[]
}

/**
 * Deterministic lexical-overlap stub: score = number of the query's distinct fragments the fact
 * contains literally. Raw count, deliberately NOT length-normalized — the pathology under test is
 * "a long unrelated note that happens to contain the bridge out-scores the short gold", which a
 * per-character normalization would erase.
 */
export function stubRank(query: string, facts: readonly string[], k = 3): RankedFacts {
  const queryFragments = [...new Set(fragmentsOf(query))]
  const scored = facts.map((fact, index) => {
    const own = new Set(fragmentsOf(fact))
    let score = 0
    for (const fragment of queryFragments) if (own.has(fragment)) score++
    return { index, score }
  })
  const hits = scored
    .filter((row) => row.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, k)
  return { ranked: hits.map((row) => row.index), scores: hits.map((row) => row.score) }
}

export interface DerivedQueryOutcome {
  query: string
  guard: GuardKind
  ranked: number[]
  scores: number[]
  gold_rank: number | null
  carrier_rank: number | null
  must_include_ok: boolean
  must_exclude_ok: boolean
  /** The fixture's own recorded collision rate (fraction of non-gold facts sharing a fragment). */
  collision_rate: number
}

export interface CollisionCheckOutcome {
  /** `true` when the planted carrier really does outrank the gold in the base arm. */
  base_carrier_before_gold: boolean
  /** `true` when removing the carrier puts the gold first (the counterfactual arm). */
  counterfactual_gold_top1: boolean
}

export interface DerivedCaseOutcome {
  id: string
  /** Arm label so a merged report cannot confuse stub numbers with real ones. */
  arm: 'stub' | 'real'
  queries: DerivedQueryOutcome[]
  collision_self_check: CollisionCheckOutcome | null
}

function rankOf(ranked: readonly number[], index: number | null): number | null {
  if (index === null) return null
  const at = ranked.indexOf(index)
  return at === -1 ? null : at + 1
}

export function runDerivedCaseStub(c: DerivedCase): DerivedCaseOutcome {
  const queries: DerivedQueryOutcome[] = c.queries.map((q) => {
    const { ranked, scores } = stubRank(q.query, c.setup_facts, q.k)
    return {
      query: q.query,
      guard: q.guard,
      ranked,
      scores,
      gold_rank: rankOf(ranked, q.gold_index),
      carrier_rank: rankOf(ranked, q.carrier_index),
      must_include_ok: q.must_include.every((i) => ranked.includes(i)),
      must_exclude_ok: !q.must_exclude.some((i) => ranked.includes(i)),
      collision_rate: q.collision_rate,
    }
  })

  let collisionSelfCheck: CollisionCheckOutcome | null = null
  if (c.collision !== null) {
    const q = c.queries[c.collision.query_index]
    const base = stubRank(q.query, c.setup_facts, q.k).ranked
    const carrierRank = rankOf(base, c.collision.carrier_index)
    const goldRank = rankOf(base, c.collision.gold_index)
    // The carrier is the LAST fact, so removing it does not shift the gold's index.
    const withoutCarrier = c.setup_facts.filter((_, i) => i !== c.collision!.carrier_index)
    const counterfactual = stubRank(q.query, withoutCarrier, q.k).ranked
    collisionSelfCheck = {
      base_carrier_before_gold: carrierRank !== null && (goldRank === null || carrierRank < goldRank),
      counterfactual_gold_top1: counterfactual[0] === c.collision.gold_index,
    }
  }

  return { id: c.id, arm: 'stub', queries, collision_self_check: collisionSelfCheck }
}

export interface DerivedSuiteOutcome {
  arm: 'stub'
  cases: DerivedCaseOutcome[]
  all_collision_self_checks_pass: boolean
  /** A retriever that emits any query containing a time expression has broken the guard. */
  any_time_word_query: boolean
  /** Every `irrelevant` negative-control query must come back empty. */
  all_irrelevant_empty: boolean
}

export function runDerivedSuiteStub(cases: readonly DerivedCase[]): DerivedSuiteOutcome {
  const outcomes = cases.map(runDerivedCaseStub)
  const checks = outcomes.map((o) => o.collision_self_check).filter((c): c is CollisionCheckOutcome => c !== null)
  return {
    arm: 'stub',
    cases: outcomes,
    all_collision_self_checks_pass: checks.length > 0
      && checks.every((c) => c.base_carrier_before_gold && c.counterfactual_gold_top1),
    // The guard is a property of the EMITTED set: no query may carry a time expression.
    any_time_word_query: outcomes.some((o) => o.queries.some((q) => timeWordsIn(q.query).length > 0)),
    all_irrelevant_empty: outcomes.every((o) => o.queries.filter((q) => q.guard === 'irrelevant').every((q) => q.ranked.length === 0)),
  }
}

// ─── the real-model arm ──────────────────────────────────────────────────────

/** The slice of the runtime the real arm needs. Duck-typed on purpose (no runtime import). */
export interface DerivedRuntimePort {
  remember(req: { action: 'add'; content: string }): Promise<{ fact_id: number }>
  recall(req: { action: 'search'; query: string; limit?: number }): Promise<{ hits: { ref_id: number }[] }>
}

/** Seed a case's facts and return the fact ids in `setup_facts` order. */
export async function seedDerivedFacts(rt: DerivedRuntimePort, facts: readonly string[]): Promise<number[]> {
  const ids: number[] = []
  for (const fact of facts) ids.push((await rt.remember({ action: 'add', content: fact })).fact_id)
  return ids
}

/**
 * Drive one derived case through a real runtime. The `k` of each query is honored with `limit`
 * (the derived queries use k=3), and the returned order is the store's own.
 */
export async function runDerivedCaseReal(rt: DerivedRuntimePort, c: DerivedCase): Promise<DerivedCaseOutcome> {
  const ids = await seedDerivedFacts(rt, c.setup_facts)
  const resolve = (refId: number): number => ids.indexOf(refId)

  const queries: DerivedQueryOutcome[] = []
  for (const q of c.queries) {
    const result = await rt.recall({ action: 'search', query: q.query, limit: q.k })
    const ranked = result.hits
      .map((h) => resolve(h.ref_id))
      .filter((i) => i >= 0)
      .slice(0, q.k)
    queries.push({
      query: q.query,
      guard: q.guard,
      ranked,
      scores: [],
      gold_rank: rankOf(ranked, q.gold_index),
      carrier_rank: rankOf(ranked, q.carrier_index),
      must_include_ok: q.must_include.every((i) => ranked.includes(i)),
      must_exclude_ok: !q.must_exclude.some((i) => ranked.includes(i)),
      collision_rate: q.collision_rate,
    })
  }

  let collisionSelfCheck: CollisionCheckOutcome | null = null
  if (c.collision !== null) {
    const base = queries[c.collision.query_index]
    // The COUNTERFACTUAL is the stub arm's job: it is a property of the fixture's arithmetic
    // (remove the carrier → gold back at rank 1) and needs no model. The real arm reports the base
    // ranking only, so a nightly report never claims a counterfactual it did not run.
    collisionSelfCheck = {
      base_carrier_before_gold: base.carrier_rank !== null
        && (base.gold_rank === null || base.carrier_rank < base.gold_rank),
      counterfactual_gold_top1: false,
    }
  }

  return { id: c.id, arm: 'real', queries, collision_self_check: collisionSelfCheck }
}
