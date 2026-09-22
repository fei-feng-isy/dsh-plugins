/**
 * The retrieval orchestration BOTH stores run.
 *
 * `MemoryStore.search` and `KnowledgeStore.search` used to carry parallel copies of this flow
 * (~80 lines each: limit normalization → weights → over-fetch → leg cap → fuse → live filter →
 * rerank → slice → output budget → health event). The legs themselves are legitimately
 * store-specific — different tables, different filters (`category` vs `domain`/`source`), and only
 * memory has the HRR probe — but the ORCHESTRATION is one algorithm, and two copies of it drifted:
 *
 *   - the `NaN` limit guard existed only in memory, so a non-finite limit reached knowledge's SQL
 *     `LIMIT` and took the whole cross-store query down with it (`Promise.all` has no per-leg catch);
 *   - `retriever.over_fetch_factor` was read only by memory, while knowledge hardcoded `limit * 3`,
 *     so one config knob silently meant two different things;
 *   - `recordLegCapped()` was called only by memory, so a capped knowledge leg was unobservable —
 *     exactly the blindness DESIGN §20.17 says the counter exists to remove;
 *   - the reranker's used/fallback flags were a helper in memory and an inline expression in
 *     knowledge.
 *
 * Fixing those one at a time would leave the next drift a matter of when. The stores now supply
 * their legs and their hit mapping; everything that can drift lives here once.
 *
 * A leg that THROWS is isolated: it contributes nothing, the query still answers from the others,
 * and the failure is logged. The read path used to have no per-leg catch at all (the write path
 * did), so an ONNX error at inference cost the caller the FTS and entity legs too.
 *
 * @module store/hybrid
 */
import { DEGRADED_WEIGHTS, type Config, type RecallResult } from '@avantf/mem-contract'
import {
  fitToTokenBudget,
  fuse,
  recordLegCapped,
  recordRetrieval,
  recordTruncation,
  rerankHits,
  retrievalLogger,
  type BudgetInput,
  type Hit,
  type Reranker,
  type SemanticBackend,
} from '@avantf/mem-core'

/** The `limit` a caller gets when it passes nothing usable. */
export const DEFAULT_SEARCH_LIMIT = 10

/**
 * A retrieval input the CALLER got wrong, as opposed to a backend that failed at runtime.
 *
 * Leg failures are isolated (see {@link runLegs}) so one dead leg cannot cost the caller the whole
 * query — but that must not extend to a caller contract violation. A wrong-width `queryVector` means
 * the caller encoded with a different backend than this store, so EVERY query in that session would
 * score as garbage; answering from the other legs would hide exactly the misconfiguration the check
 * exists to surface.
 */
export class RetrievalInputError extends Error {}

/** …and the over-fetch factor when the config does not set one (matches the contract default). */
export const DEFAULT_OVER_FETCH_FACTOR = 5

/** The three weights a `RecallResult` reports. */
export type RetrievalWeights = RecallResult['weights']

/** One retrieval leg's contribution to the fusion. */
export interface HybridLeg {
  /** Fusion weight; the caller resolves it against `semAvail` (see {@link HybridContext}). */
  weight: number
  /** candidate id → raw score, in the leg's own scale (`fuse` normalizes per leg). */
  scores: Map<number, number>
  /**
   * True when the leg was cut at {@link HybridContext.legCap}.
   *
   * `size === cap` is the only observable "this leg was trimmed" signal — a leg that finished under
   * the cap cannot have been cut — and it feeds the health counters, so the headroom can be sized
   * from data instead of from a constant nobody re-derives.
   */
  capped?: boolean
}

/** What the orchestrator resolved before handing control to the store's legs. */
export interface HybridContext {
  /** The query, trimmed. */
  query: string
  /** How many hits the caller receives (already guarded against a non-finite input). */
  limit: number
  /** Size of the fused pool the legs should aim to fill. */
  overFetch: number
  /** Per-leg row cap. */
  legCap: number
  /** Whether the semantic backend is live; false means the degraded weights are in force. */
  semAvail: boolean
  /**
   * The fusion weights in force, already rebalanced for `semAvail`. Handed to the store because a
   * leg's weight is part of the leg, and the degraded rebalance must be the SAME one the result
   * reports — deriving it twice is how two stores end up reporting different numbers.
   */
  weights: RetrievalWeights
  /** A query vector the caller already encoded (the cross-store router encodes once for both stores). */
  queryVector?: Float32Array
}

/** What a store supplies. Generic in `H`, the caller-facing hit shape. */
export interface HybridDeps<H> {
  /** Which health-event kind this search records. */
  kind: 'memory' | 'knowledge'
  config: Config
  semantic: SemanticBackend
  reranker: Reranker
  /**
   * The legs to fuse, as promises (or values). Awaited concurrently; a rejection costs that leg
   * only. The async setup a store needs before it can build its legs — memory extracts the query's
   * entities ONCE and shares them between the Jaccard and HRR legs — happens in this method's own
   * body, before the array is returned.
   */
  legs(ctx: HybridContext): Promise<readonly (HybridLeg | Promise<HybridLeg>)[]>
  /** Text for the fused ids: the live filter, the reranker's input, and the hit bodies. */
  texts(ids: number[]): Map<number, string>
  /** Build the caller-facing hits from the ranked, live, already-sliced ids. */
  hits(ranked: readonly Hit[], texts: Map<number, string>): H[]
  /**
   * Called with the hits the caller ACTUALLY receives — after the output budget, not before it.
   *
   * This is where a store reinforces what it returned. Reinforcing the pre-budget list used to
   * refresh the dormancy clock (and grant the trust bonus) for hits the token budget had already
   * dropped, i.e. rewarding facts the caller never saw; the cross-store path had already learned
   * that lesson (R5/R21) and the single-store path had not.
   */
  onReturn?(kept: readonly Budgeted<H>[]): void
}

/** One search request, before resolution. */
export interface HybridPlan {
  query: string
  limit?: number
  /** Overrides the config-derived pool size; never smaller than `limit`. */
  overFetch?: number
  /** Per-call output token budget; `0` = unlimited, omitted = `retriever.max_output_tokens`. */
  maxTokens?: number
  queryVector?: Float32Array
  /**
   * Emit a health event for this search (default true). The cross-store router sets it false: it
   * fuses both stores into ONE user-facing query and records a single `kind: 'cross'` event, so
   * `queries` counts questions instead of legs (DESIGN §20.5).
   */
  recordStats?: boolean
}

/** A hit after the output budget: `text` may have been shortened, and `truncated` says so. */
export type Budgeted<T> = T & { truncated?: boolean }

export interface HybridResult<H> {
  hits: Budgeted<H>[]
  /** The semantic backend was down, so the degraded weights were used. */
  degraded: boolean
  weights: RetrievalWeights
  /** Tokens the returned hits carry; `0` means "not computed" (an unlimited budget skips the pass). */
  used_tokens: number
}

/**
 * The per-leg row cap: `retriever.leg_cap` when set, otherwise derived from the pool size.
 *
 * Derived default: 4× the pool, so each leg can fill the fused result on its own. Stated once here
 * rather than per store, because the health counter compares against whatever this returns.
 */
export function legCapFor(config: Config, overFetch: number): number {
  const configured = config.retriever.leg_cap
  return configured > 0 ? configured : Math.max(200, overFetch * 4)
}

/**
 * Whether the configured reranker is actually in use — the two flags a retrieval event carries.
 *
 * "Configured" is not "used": a reranker that is selected but unavailable falls back to the fused
 * order, and counting that as a rerank would make the counter lie in exactly the case it exists to
 * expose (the reference implementation leaves `rerank_fallback` unfeedable).
 */
export function rerankState(reranker: Reranker): { used: boolean; fallback: boolean } {
  const configured = reranker.name !== 'none'
  const available = reranker.isAvailable()
  return { used: configured && available, fallback: configured && !available }
}

/**
 * Bound a ranked hit list to a token budget, marking what was shortened.
 *
 * An unlimited budget returns the hits untouched: `fitToTokenBudget` would still walk every entry
 * to sum `used_tokens`, and every caller discards that number (the cross-store path passes 0
 * deliberately — it bounds the MERGED result instead). `used_tokens: 0` means "not computed", and
 * the budget module keeps its own honest accounting for callers that ask.
 */
export function applyOutputBudget<H extends BudgetInput>(
  config: Config,
  hits: H[],
  perCall?: number,
): { kept: Budgeted<H>[]; used_tokens: number } {
  const maxTokens = perCall ?? config.retriever.max_output_tokens
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return { kept: hits, used_tokens: 0 }
  const out = fitToTokenBudget(hits, { maxTokens })
  if (out.truncated > 0) recordTruncation('output')
  return { kept: out.kept, used_tokens: out.used_tokens }
}

/**
 * Run one hybrid search.
 *
 * The order of the last three steps is load-bearing: rerank the over-fetched pool, THEN slice to
 * `limit`, THEN apply the output budget, and only then tell the store what was returned. Slicing
 * before the rerank would rank an arbitrary subset; budgeting before the slice would spend the
 * budget on hits that are about to be dropped.
 */
export async function hybridSearch<H extends BudgetInput>(deps: HybridDeps<H>, plan: HybridPlan): Promise<HybridResult<H>> {
  const startedAt = Date.now()
  const retriever = deps.config.retriever
  // `?? 10` is not enough on its own: a caller can pass `NaN` (see `runtime.query`'s note), and a
  // non-finite limit propagates into the leg caps and their SQL `LIMIT`, where it throws — taking
  // the whole cross-store query down, since the router awaits both stores together.
  const limit = Number.isFinite(plan.limit) ? (plan.limit as number) : DEFAULT_SEARCH_LIMIT
  const query = plan.query.trim()
  const semAvail = deps.semantic.isAvailable()
  // A degraded query still drives recovery: the next one can use the model.
  if (!semAvail) deps.semantic.ensureWarm?.()
  const weights: RetrievalWeights = semAvail
    ? {
        semantic: retriever.weight_semantic,
        fts: retriever.weight_fts,
        jaccard: retriever.weight_jaccard,
      }
    : DEGRADED_WEIGHTS
  const overFetch = Math.max(limit, plan.overFetch ?? limit * (retriever.over_fetch_factor || DEFAULT_OVER_FETCH_FACTOR))
  const legCap = legCapFor(deps.config, overFetch)

  const legs = await runLegs(deps, {
    query,
    limit,
    overFetch,
    legCap,
    semAvail,
    weights,
    ...(plan.queryVector === undefined ? {} : { queryVector: plan.queryVector }),
  })
  for (const leg of legs) if (leg.capped === true) recordLegCapped()

  const fused = fuse(legs.map((leg) => ({ weight: leg.weight, scores: leg.scores })), overFetch)
  const texts = deps.texts(fused.map((h) => h.id))
  // Drop stale candidates (purged rows, vectors lingering in the index).
  const live = fused.filter((h) => texts.has(h.id))
  const ranked = (await rerankHits(deps.reranker, query, live, (id) => texts.get(id) ?? '')).slice(0, limit)
  const hits = deps.hits(ranked, texts)
  // The output budget is applied LAST: it must bound what the caller receives, and it is the only
  // place that knows how much text the whole result carries (DESIGN §20).
  const budgeted = applyOutputBudget(deps.config, hits, plan.maxTokens)
  deps.onReturn?.(budgeted.kept)

  if (plan.recordStats !== false) {
    const rerank = rerankState(deps.reranker)
    recordRetrieval({
      kind: deps.kind,
      results: budgeted.kept.length,
      latencyMs: Date.now() - startedAt,
      semanticLive: semAvail,
      rerankUsed: rerank.used,
      rerankFallback: rerank.fallback,
    })
  }
  return { hits: budgeted.kept, degraded: !semAvail, weights, used_tokens: budgeted.used_tokens }
}

/**
 * Await the store's legs, isolating a failure to the leg that caused it.
 *
 * A rejected leg contributes nothing and is reported; the query still answers from the others. The
 * setup call itself (entity extraction, say) is guarded the same way, because an empty result the
 * caller can act on beats an exception from a retrieval path.
 */
async function runLegs<H extends BudgetInput>(deps: HybridDeps<H>, ctx: HybridContext): Promise<HybridLeg[]> {
  let pending: readonly (HybridLeg | Promise<HybridLeg>)[]
  try {
    pending = await deps.legs(ctx)
  } catch (error) {
    if (error instanceof RetrievalInputError) throw error
    retrievalLogger().warn(
      `${deps.kind} 检索：候选腿准备失败（${describe(error)}）——本次返回空结果，其余功能不受影响`,
    )
    return []
  }
  const settled = await Promise.all(pending.map(async (leg, index) => {
    try {
      return await leg
    } catch (error) {
      if (error instanceof RetrievalInputError) throw error
      retrievalLogger().warn(
        `${deps.kind} 检索：第 ${String(index + 1)} 条腿失败（${describe(error)}）——已跳过该腿，用其余腿的结果作答`,
      )
      return { weight: 0, scores: new Map<number, number>() } satisfies HybridLeg
    }
  }))
  return settled
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
