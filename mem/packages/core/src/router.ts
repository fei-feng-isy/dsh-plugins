import { DEGRADED_WEIGHTS, type RecallHit, type RecallResult, type RetrievalFloorDrops } from '@avantf/mem-contract'
import { fitToTokenBudget, recordTruncation } from '@avantf/mem-retrieval'
import { mergeFloorDrops } from './store/floors.js'

interface CrossQueryOptions {
  limit?: number
  kind?: 'all' | 'fact' | 'doc_chunk'
  domain?: string
  source?: string
  /**
   * Token budget for the merged result; `0` = unlimited, omitted = the caller already bounded
   * the legs (the runtime lifts the per-store budgets for the pool and bounds the OUTCOME here,
   * because fusion can reorder which entries deserve the text).
   */
  maxTokens?: number
  /**
   * The knowledge leg's floor report. `KnowledgeStore.search` answers with hits only, so the
   * runtime hands its captured `HybridResult` drops here; the memory side already arrives on
   * `memory.dropped_by_floor`. Without this, the merged result would report only half the floors.
   */
  kbDroppedByFloor?: RetrievalFloorDrops
}

/** The memory search result the router derives degradation/weights from. */
type CrossQueryMemory = Pick<RecallResult, 'hits' | 'degraded' | 'weights' | 'floors' | 'dropped_by_floor'>

/**
 * Joint min-max normalization over the MERGED pool — the rule the cross-store score
 * contract is defined by (DESIGN §7).
 *
 * Degenerate case (every candidate carries the same score — including a pool of one):
 * the raw score is KEPT. A collapsed range encodes no ranking information, so rescaling
 * it would invent a "perfect match" out of an absolute fused score that may say
 * otherwise. `minMaxNormalize` maps the same case to 1 instead, which is right there
 * because it only ever feeds a relative weighted sum inside ONE fusion path; the two
 * differ deliberately rather than by oversight.
 *
 * Returns COPIES: the inputs are the stores' own result objects, and callers still
 * read their original scores.
 */
export function normalizeMergedScores<T extends { score: number }>(pool: T[]): T[] {
  if (pool.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const h of pool) {
    if (h.score < min) min = h.score
    if (h.score > max) max = h.score
  }
  const range = max - min
  return pool.map((h) => ({ ...h, score: range === 0 ? h.score : (h.score - min) / range }))
}

/**
 * Cross-retrieval router: merge memory + knowledge hits, joint min-max normalize
 * the final fused scores over the *combined* pool (so the two stores' scores are
 * comparable), then rank by score.
 *
 * Degradation and weights are inherited from the memory search result rather
 * than hardcoded: both stores share the same semantic adapter, so
 * `memory.degraded`/`memory.weights` already describe whether the semantic leg
 * ran. Reporting a fixed `degraded: true` here made every `kb_query` look
 * degraded even when embeddings were live.
 */
export function crossQuery(memory: CrossQueryMemory, kb: RecallHit[], opts?: CrossQueryOptions): RecallResult {
  const limit = opts?.limit ?? 10
  const weights = memory.weights ?? DEGRADED_WEIGHTS
  // Both stores read the SAME `retriever` floors, so the effective values are the memory leg's
  // (post degraded-relaxation); the DROPS are per store and are merged below.
  const floors = memory.floors
  const droppedByFloor = mergeFloorDrops(memory.dropped_by_floor, opts?.kbDroppedByFloor)
  let pool = [...memory.hits, ...kb]
  if (opts?.kind === 'fact') pool = pool.filter((h) => h.kind === 'fact')
  if (opts?.kind === 'doc_chunk') pool = pool.filter((h) => h.kind === 'doc_chunk')
  // `domain`/`source` are knowledge-base concepts (domain→source→chunk): memory
  // facts carry null for both, so either filter necessarily drops them. They match
  // on the hit's OWN fields — never on a split of `source_ref`, which cannot be
  // parsed back unambiguously when a domain or source name contains `:`.
  if (opts?.domain) pool = pool.filter((h) => h.kind === 'doc_chunk' && h.domain === opts.domain)
  if (opts?.source) pool = pool.filter((h) => h.kind === 'doc_chunk' && h.source === opts.source)

  if (pool.length === 0) return { hits: [], degraded: memory.degraded, weights, floors, dropped_by_floor: droppedByFloor }

  const scaled = normalizeMergedScores(pool)
  scaled.sort((a, b) => b.score - a.score)
  const hits = scaled.slice(0, limit)
  if (opts?.maxTokens === undefined) return { hits, degraded: memory.degraded, weights, floors, dropped_by_floor: droppedByFloor }
  // `0` = the caller lifted the budget (the stores already skipped their own passes); estimating
  // every entry just to report a number nobody reads would be the same waste one level up.
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) return { hits, degraded: memory.degraded, weights, floors, dropped_by_floor: droppedByFloor }
  // One budget for the whole merged result, applied AFTER fusion: bounding each leg first would
  // let the knowledge side spend tokens on hits that fusion then drops.
  const budgeted = fitToTokenBudget(hits, { maxTokens: opts.maxTokens })
  if (budgeted.truncated > 0) recordTruncation('output')
  return { hits: budgeted.kept, degraded: memory.degraded, weights, floors, dropped_by_floor: droppedByFloor }
}
