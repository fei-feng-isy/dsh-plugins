/**
 * The retrieval orchestration BOTH stores run.
 *
 * `MemoryStore.search` and `KnowledgeStore.search` used to carry parallel copies of this flow
 * (~80 lines each: limit normalization → weights → over-fetch → leg cap → fuse → live filter →
 * slice → output budget → health event). The legs themselves are legitimately store-specific —
 * different tables, different filters (`category` vs `domain`/`source`), and only memory has the
 * HRR probe — but the ORCHESTRATION is one algorithm, and two copies of it drifted:
 *
 *   - the `NaN` limit guard existed only in memory, so a non-finite limit reached knowledge's SQL
 *     `LIMIT` and took the whole cross-store query down with it (`Promise.all` has no per-leg catch);
 *   - `retriever.over_fetch_factor` was read only by memory, while knowledge hardcoded `limit * 3`,
 *     so one config knob silently meant two different things;
 *   - `recordLegCapped()` was called only by memory, so a capped knowledge leg was unobservable —
 *     exactly the blindness DESIGN §20.17 says the counter exists to remove.
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
import { DEGRADED_WEIGHTS, type Config, type FloorProfile, type RecallResult, type RetrievalFloorDrops, type RetrievalFloors } from '@avantf/mem-contract'
import {
  fitToTokenBudget,
  fuse,
  recordLegCapped,
  recordRetrieval,
  recordTruncation,
  retrievalLogger,
  type BudgetInput,
  type Hit,
  type SemanticBackend,
} from '@avantf/mem-retrieval'
import { droppedLegs, emptyFloorDrops, resolveFloors, totalFloorDrops, type FloorLeg } from './floors.js'
import { gradedTerms } from './lexical.js'
import { selfQueryRewrite } from './self_query.js'

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
   * from data instead of from a constant nobody re-derives. Measured on the leg's RAW score set:
   * the relevance floors may shrink a capped leg afterwards, and re-deriving this from the floored
   * size would silently erase the cap signal.
   */
  capped?: boolean
  /**
   * Which floor governs this leg, for {@link HybridResult.dropped_by_floor}'s per-leg breakdown.
   * The HRR probe shares the entity (`jaccard`) floor; naming it separately keeps a narrowed
   * candidate set attributable without double-counting the entity leg's own drops.
   *
   * The `jaccard` KEY is historical: the entity leg's metric is now anchored Jaccard with a
   * saturating union, whose unit (and the `min_jaccard` floor on it) is defined in
   * `store/entity_leg.ts` — read that before re-calibrating the knob.
   */
  leg?: keyof RetrievalFloorDrops
  /** Candidates this leg removed because they fell below its floor. */
  droppedByFloor?: number
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
   * The EFFECTIVE relevance floors for this query, already resolved for `semAvail` (see
   * `store/floors.ts`). Handed to the store for the same reason as {@link weights}: a leg applies
   * its own floor, and deriving the relaxed value twice is how two stores end up cutting different
   * candidates.
   */
  floors: RetrievalFloors
  /**
   * The fusion weights in force, already rebalanced for `semAvail`. Handed to the store because a
   * leg's weight is part of the leg, and the degraded rebalance must be the SAME one the result
   * reports — deriving it twice is how two stores end up reporting different numbers.
   */
  weights: RetrievalWeights
  /** A query vector the caller already encoded (the cross-store router encodes once for both stores). */
  queryVector?: Float32Array
  /**
   * Called by a store when it ENCODED this query itself (rather than reusing {@link queryVector}),
   * so a retry pass can hand the same vector back instead of paying the model again.
   *
   * The single-store `search` path is the one that needs this: its caller supplies no vector, and the
   * relaxed retry below re-ran the whole pass — including `semantic.encode(query)`. The cross-store
   * router already passes a vector, so it is unaffected (performance review §7.7 / P8).
   */
  onQueryVector?(vec: Float32Array): void
}

/** What a store supplies. Generic in `H`, the caller-facing hit shape. */
export interface HybridDeps<H> {
  /** Which health-event kind this search records. */
  kind: 'memory' | 'knowledge'
  config: Config
  semantic: SemanticBackend
  /**
   * The legs to fuse, as promises (or values). Awaited concurrently; a rejection costs that leg
   * only. The async setup a store needs before it can build its legs — memory extracts the query's
   * entities ONCE and shares them between the Jaccard and HRR legs — happens in this method's own
   * body, before the array is returned.
   */
  legs(ctx: HybridContext): Promise<readonly (HybridLeg | Promise<HybridLeg>)[]>
  /** Text for the fused ids: the live filter and the hit bodies. */
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
   * Overrides the self-reference rewriter for this search (方案 A, `store/self_query.ts`).
   *
   * Default = the intent table. A TEST SEAM, not a second pluggability path: the frozen sentinel
   * passes `() => undefined` to prove its assertions rest on the table (turn it off and the
   * self-referential questions fall back to their pre-A outcomes), and `() => '<anything>'` to
   * reproduce a MISCONFIGURED table and prove the augmentation only ever ADDS recall.
   */
  rewriteQuery?: (query: string) => string | undefined
  /**
   * Which relevance-floor policy governs this query (see the contract's `FLOOR_PROFILES`):
   * omitted = the configured floors plus ONE relaxed pass when they empty the result, `'strict'` =
   * no fallback, `'loose'` = the relaxed floors outright.
   *
   * The cross-store router pins a profile on every store call (`'strict'` for its first pass,
   * `'loose'` for its second): only the MERGED result may decide whether relaxing is warranted, or a
   * store that happens to be empty would inject its relaxed tail into another store's strict answer.
   */
  floors?: FloorProfile
  /**
   * Which legs a `'loose'` pass may lower (see `store/floors.ts`'s `FloorResolution.relaxLegs`).
   * Omitted on the default policy: the single-store retry reads the STRICT pass's own drop report and
   * lowers exactly those legs. The cross-store router has no single strict pass — it pins the legs
   * the MERGED strict pass dropped on its second call, so "only what actually dropped" holds there
   * too (relaxing a leg that dropped nothing admits no candidate; it only misreports `floors`).
   */
  relaxLegs?: readonly FloorLeg[]
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
  /** The floors actually applied (post degraded-relaxation AND profile), for the result envelope. */
  floors: RetrievalFloors
  /** How many candidates each leg dropped below its floor. */
  dropped_by_floor: RetrievalFloorDrops
  /**
   * The strict pass returned nothing while having dropped candidates, and ONE relaxed pass supplied
   * these hits — `floors` are that pass's values. An explicit `floors: 'loose'` request does NOT set
   * this: the caller asked for the relaxed profile, so nothing was "relaxed behind its back".
   */
  relaxed?: boolean
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
 * The order of the last steps is load-bearing: slice the fused (over-fetched) pool to `limit`,
 * THEN apply the output budget, and only then tell the store what was returned. Budgeting before
 * the slice would spend the budget on hits that are about to be dropped.
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
  // Computed once for both passes: the FTS bar is clamped to the terms this QUERY can produce (a
  // 3-char CJK query has one trigram, and a 2-char one falls back to ONE substring term, so a
  // configured 2 is unreachable for either).
  const termCount = gradedTerms(query).length

  /**
   * 方案 A — the self-reference AUGMENTATION (docs/SELF_QUERY_RELEVANCE.md §4-A).
   *
   * The corpus writes the user in the third person and the user asks in the first, so a
   * first-person question shares no lexical term with the fact that answers it and the semantic leg
   * has to carry the whole decision. The intent table (`store/self_query.ts`) supplies ONE canonical
   * third-person rewrite and the ORIGINAL query and the rewrite each run the full leg set.
   *
   * THE FLOOR IS RESOLVED PER RUN (0.4.2). Each run is graded by ITS OWN reachability clamp —
   * `min(configured, gradedTerms(variant).length)` — because a variant with MORE terms has a
   * HIGHER bar, and grading it at the original's lower bar is what let a single incidental trigram
   * from the rewrite become that leg's head. Measured on the live store: `我是谁？` yields ONE term
   * (`我是谁`) while its rewrite `用户是谁` yields TWO (`用户是` / `户是谁`), and the rewrite's
   * `用户是` is a literal substring of an unrelated long note — that note then took the FTS leg's
   * head (weight × 1.0) and outvoted the identity fact, which the rewrite had correctly put first.
   * `applyTermFloor` re-clamps to the query it is grading, but the clamp is one-directional
   * (`min`): it can only LOWER an unreachable bar, never RAISE a bar inherited from another text, so
   * the resolution has to happen per variant (see {@link resolveFloors}). Each variant's own bar is
   * then floored at the reported one, so every run is graded at or ABOVE what the envelope says: the
   * envelope reports the ORIGINAL query's floors (the question the user actually asked) and can never
   * overstate the bar a run was held to.
   *
   * WHY AUGMENT, NOT REPLACE. The table is a closed cue list over a language with unbounded
   * self-reference variants, so a wrong match is inevitable. Under augmentation a false positive can
   * only add candidates; the original query's candidates are always kept, exactly like the relaxed
   * floor policy ("only ever widens"). Under replacement it would change what the user actually
   * asked. `queries.length === 1` (the overwhelming majority) leaves the run below bit-identical to
   * the pre-A path: one `deps.legs` call, same context, same vector wiring.
   *
   * FLOORS, `relaxed` AND `dropped_by_floor` UNDER AUGMENTATION. The PROFILE is resolved once per
   * pass from the ORIGINAL query and handed to both runs; only the per-variant reachability clamp
   * above differs, and it can only raise. Every leg of every run is therefore judged by AT LEAST the
   * numbers the result reports — the envelope can never say "strict" while a rewrite run answered from
   * the relaxed band (the distortion this design exists to rule out). `relaxed` is decided exactly as
   * it was: the automatic loose pass fires only when the strict pass returned NOTHING with drops, and
   * it re-runs BOTH variants under the loosened floors. Because a leg only ever REMOVES entries, the
   * per-leg merge of the two runs' drop counts uses `max` (summing would count the same candidate
   * twice) and `capped` uses OR — both conservative, neither inflates the report that feeds the retry
   * decision.
   */
  const augment = (plan.rewriteQuery ?? selfQueryRewrite)(query)
  const queries = augment !== undefined && augment !== query ? [query, augment] : [query]
  /**
   * The query vector in force, ACROSS both passes.
   *
   * The single-store path is handed no vector by its caller (only the cross-store router encodes
   * once), so before this the relaxed retry re-encoded the same query — ~4 ms on a warm model, paid
   * every time the strict pass emptied with floor drops. A store publishes what it encoded through
   * {@link HybridContext.onQueryVector}, and the retry below reuses it. A caller-supplied vector
   * (cross-store) is already here and is passed through unchanged.
   */
  let passVector = plan.queryVector
  /**
   * The rewrite's own vector, ACROSS both passes, for the same reason as {@link passVector}: the
   * rewrite is a different text, so it needs its own encode, and the relaxed retry must not pay for
   * it twice. Keyed by variant text (there is at most one).
   */
  const augmentVectors = new Map<string, Float32Array>()

  /**
   * One full pass under ONE floor profile: legs → fuse → live filter → slice → budget.
   *
   * `onReturn` (the store's reinforcement) is deliberately NOT called here: the strict pass is a
   * probe whenever a relaxed pass may follow, and reinforcing text the caller never receives is
   * exactly the defect `onReturn`'s doc calls out. The chosen pass is delivered by the caller below.
   *
   * `passVector` is read at call time and updated through `onQueryVector` while the pass runs, so the
   * relaxed retry starts with whatever the strict pass encoded (see the variable's own comment).
   */
  const runPass = async (profile: FloorProfile, relaxLegs?: readonly FloorLeg[]): Promise<{ hits: Budgeted<H>[]; used_tokens: number; floors: RetrievalFloors; dropped_by_floor: RetrievalFloorDrops; capped: number }> => {
    // Resolved per pass and handed to the legs: the degraded relaxation of `min_fts_terms` must be
    // the same value the result reports, or a caller cannot tell which rule produced an empty answer.
    // This resolution describes the USER's query (`termCount`) and is what the envelope reports.
    const floors = resolveFloors(retriever, semAvail, {
      profile,
      termCount,
      ...(relaxLegs === undefined ? {} : { relaxLegs }),
    })
    // One `deps.legs` call per query variant, CONCURRENTLY. The caller-supplied vector belongs to the
    // ORIGINAL query only: handing it to the rewrite would score the semantic leg with the wrong
    // text's embedding. The rewrite therefore encodes itself (the store's own `semantic.encode`) and
    // publishes through `onQueryVector`, which is kept per variant for the relaxed retry.
    const runs = await Promise.all(queries.map(async (variant, index) => {
      const isOriginal = index === 0
      const vector = isOriginal ? passVector : augmentVectors.get(variant)
      // The FTS reachability clamp is per GRADED TEXT (方案 A note above): a rewrite that yields more
      // terms than the original must be judged against its own bar, or the clamp's one-directional
      // `min` cannot raise it. It is then floored at the REPORTED bar, so a run can only ever be
      // STRICTER than the envelope claims — the report can never overstate what was applied. (A
      // rewrite with FEWER terms than the original would otherwise clamp lower; the augmentation must
      // not admit lexical evidence weaker than the user's own query requires.) Every other floor is
      // term-count-independent, so this touches `fts` only.
      const ownFloors = isOriginal ? floors : resolveFloors(retriever, semAvail, {
        profile,
        termCount: gradedTerms(variant).length,
        ...(relaxLegs === undefined ? {} : { relaxLegs }),
      })
      const variantFloors = ownFloors === floors
        ? floors
        : { ...ownFloors, fts: Math.max(floors.fts, ownFloors.fts) }
      return runLegs(deps, {
        query: variant,
        limit,
        overFetch,
        legCap,
        semAvail,
        weights,
        floors: variantFloors,
        ...(vector === undefined ? {} : { queryVector: vector }),
        onQueryVector: (vec) => {
          if (isOriginal) passVector = vec
          else augmentVectors.set(variant, vec)
        },
      })
    }))
    const legs = runs.length === 1 ? runs[0]! : unionLegs(runs)
    let capped = 0
    for (const leg of legs) if (leg.capped === true) capped += 1
    const droppedByFloor = emptyFloorDrops()
    for (const leg of legs) {
      if (leg.leg !== undefined && leg.droppedByFloor !== undefined) droppedByFloor[leg.leg] += leg.droppedByFloor
    }
    const fused = fuse(legs.map((leg) => ({ weight: leg.weight, scores: leg.scores })), overFetch)
    const texts = deps.texts(fused.map((h) => h.id))
    // Drop stale candidates (purged rows, vectors lingering in the index).
    const live = fused.filter((h) => texts.has(h.id))
    const ranked = live.slice(0, limit)
    const hits = deps.hits(ranked, texts)
    // The output budget is applied LAST: it must bound what the caller receives, and it is the only
    // place that knows how much text the whole result carries (DESIGN §20).
    const budgeted = applyOutputBudget(deps.config, hits, plan.maxTokens)
    return { hits: budgeted.kept, used_tokens: budgeted.used_tokens, floors, dropped_by_floor: droppedByFloor, capped }
  }

  // THE RETRY RULE (DESIGN §20.19). The strict pass answers unless it returned NOTHING while having
  // dropped candidates — the one shape in which a lower floor can help (a leg with no candidates at
  // all cannot gain any from relaxing). The relaxed pass keeps an absolute bottom line, so an
  // unrelated question still comes back empty instead of surfacing the archive. An explicit profile
  // (`'strict'` / `'loose'`) suppresses the retry: the caller stated which pass it wants.
  let chosen = await runPass(plan.floors === 'loose' ? 'loose' : 'strict', plan.relaxLegs)
  let relaxed = false
  if (plan.floors === undefined && chosen.hits.length === 0 && totalFloorDrops(chosen.dropped_by_floor) > 0) {
    // Only the legs that actually dropped are lowered. Lowering any other cannot admit a candidate
    // (a floor only removes); it would just make `floors` claim a leg was relaxed when it never was.
    const loosened = await runPass('loose', droppedLegs(chosen.dropped_by_floor))
    // Only a pass that actually produced something replaces the strict answer. If relaxing changes
    // nothing, the caller gets the STRICT result — its `dropped_by_floor` is the honest "the floors
    // removed N" report, and an empty query stays bit-identical to what it was before this rule.
    if (loosened.hits.length > 0) {
      chosen = loosened
      relaxed = true
    }
  }
  for (let i = 0; i < chosen.capped; i += 1) recordLegCapped()
  deps.onReturn?.(chosen.hits)

  if (plan.recordStats !== false) {
    recordRetrieval({
      kind: deps.kind,
      results: chosen.hits.length,
      // Covers BOTH passes: the caller waited for the whole thing.
      latencyMs: Date.now() - startedAt,
      semanticLive: semAvail,
      droppedByFloor: chosen.dropped_by_floor,
    })
  }
  return {
    hits: chosen.hits,
    degraded: !semAvail,
    weights,
    used_tokens: chosen.used_tokens,
    floors: chosen.floors,
    dropped_by_floor: chosen.dropped_by_floor,
    ...(relaxed ? { relaxed: true } : {}),
  }
}

/**
 * Union the per-leg raw scores of the augmented runs (方案 A) — original first, then the rewrite(s).
 *
 * Same leg INDEX, not "same `leg` label": both runs come from ONE store with an identical context
 * except for the query text, so the leg array has the same shape and order (memory: semantic,
 * jaccard, fts[, hrr]; knowledge: semantic, fts, jaccard). Merging by index is what keeps this from
 * becoming a second leg with its own weight — the weight, `leg` label and `capped` bookkeeping stay
 * the ORIGINAL run's.
 *
 * A candidate present in both runs keeps its MAX score, and `capped` is the OR. `droppedByFloor`
 * is the MAX too: both runs commonly drop the SAME candidate (the rewrite is a third-person
 * paraphrase of the same question), and we do not carry the pre-floor raw sets, so summing would
 * double-count it. The max is the conservative number that never inflates the drop report — which
 * is what `feeds` the relaxed-retry decision and the health counters. A store returning a different
 * leg count for one variant is a contract violation; the extra legs are appended rather than
 * silently discarded, so it cannot narrow the union either.
 */
function unionLegs(runs: readonly (readonly HybridLeg[])[]): HybridLeg[] {
  const [first, ...rest] = runs
  const out: HybridLeg[] = (first ?? []).map((leg) => ({ ...leg, scores: new Map(leg.scores) }))
  for (const run of rest) {
    run.forEach((leg, index) => {
      const current = out[index]
      if (current === undefined) {
        out.push({ ...leg, scores: new Map(leg.scores) })
        return
      }
      for (const [id, score] of leg.scores) {
        const previous = current.scores.get(id)
        if (previous === undefined || score > previous) current.scores.set(id, score)
      }
      if (leg.capped === true) current.capped = true
      if (leg.leg !== undefined) current.leg = leg.leg
      if (leg.droppedByFloor !== undefined) {
        current.droppedByFloor = Math.max(current.droppedByFloor ?? 0, leg.droppedByFloor)
      }
    })
  }
  return out
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
