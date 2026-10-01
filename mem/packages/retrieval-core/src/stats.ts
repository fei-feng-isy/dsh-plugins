/**
 * Process-wide retrieval health counters (DESIGN §20).
 *
 * What this answers, and why it is a counter rather than a query: "is the semantic leg
 * actually live?", "how often does a query return nothing?", "how slow is retrieval?", and
 * "did any budget truncate model-facing text?". None of those can be recovered from the
 * database after the fact — the DB only holds what was stored, not how it was retrieved.
 *
 * In-process like {@link retrievalLogger}, with `snapshot()`/`restore()` so the STORE can
 * persist the aggregate through `avantf_stats`: a restart resets counters in the reference
 * design, which makes a long-lived degradation look like a fresh healthy process. The
 * counters themselves stay free of any DB dependency (retrieval-core has none).
 *
 * The SHAPES live in `@avantf/mem-contract` (they are UI payloads — the settings page renders
 * them), so this module only owns the counting.
 */
import type { KindHealth, RetrievalFloorDrops, RetrievalHealth, RetrievalHealthSummary } from '@avantf/mem-contract'

function empty(): RetrievalHealth {
  return {
    queries: 0,
    zero_results: 0,
    results: 0,
    latency_ms_total: 0,
    latency_ms_max: 0,
    semantic_live: 0,
    semantic_degraded: 0,
    rerank_used: 0,
    rerank_fallback: 0,
    embedding_truncated: 0,
    rerank_truncated: 0,
    output_truncated: 0,
    legs_capped: 0,
    candidates_dropped_by_floor: 0,
    updated_at: null,
    by_kind: {},
  }
}

let active: RetrievalHealth = empty()

export interface RetrievalEvent {
  /** `memory` | `knowledge` | `cross` — free-form so a new store needs no schema change. */
  kind: string
  results: number
  latencyMs: number
  semanticLive: boolean
  rerankUsed?: boolean
  rerankFallback?: boolean
  /**
   * Per-leg candidates removed by the relevance floors before fusion. The per-leg shape is what
   * makes an empty result readable ("the FTS floor cut 7 rows" vs "no leg had a candidate"); the
   * aggregate counter below is what survives the process.
   */
  droppedByFloor?: RetrievalFloorDrops
}

/** Record one completed retrieval. */
export function recordRetrieval(event: RetrievalEvent): void {
  active.queries += 1
  active.results += event.results
  if (event.results === 0) active.zero_results += 1
  const latency = Number.isFinite(event.latencyMs) ? Math.max(0, event.latencyMs) : 0
  active.latency_ms_total += latency
  if (latency > active.latency_ms_max) active.latency_ms_max = latency
  if (event.semanticLive) active.semantic_live += 1
  else active.semantic_degraded += 1
  if (event.rerankUsed) active.rerank_used += 1
  if (event.rerankFallback) active.rerank_fallback += 1
  const drops = event.droppedByFloor
  if (drops !== undefined) {
    const total = drops.semantic + drops.fts + drops.jaccard + drops.hrr
    if (Number.isFinite(total) && total > 0) active.candidates_dropped_by_floor += total
  }
  const bucket = (active.by_kind[event.kind] ??= { queries: 0, zero_results: 0, results: 0 })
  bucket.queries += 1
  bucket.results += event.results
  if (event.results === 0) bucket.zero_results += 1
  active.updated_at = new Date().toISOString()
}

export type TruncationKind = 'embedding' | 'rerank' | 'output'

/**
 * Record that a retrieval LEG returned exactly its cap, i.e. that its tail was dropped.
 *
 * The cap is a cost bound, and `fusion` scaling by each leg's maximum means a trimmed tail cannot
 * rescale the survivors — but "cannot distort" is not "did not bind": past the headroom a leg's
 * weakest entries simply cannot reach the result, and nothing else reports that. `size === cap` is
 * the same proxy the lifecycle tick uses for "the budget ran out" (a leg that finished under the
 * cap cannot have been cut).
 */
export function recordLegCapped(): void {
  active.legs_capped += 1
  active.updated_at = new Date().toISOString()
}

/**
 * Record that a budget had to bound model-facing text.
 *
 * This counter is the point of the whole module: the pre-existing behavior truncated
 * embedding input silently, so nothing anywhere could tell that a store had been indexed
 * with half its text missing.
 */
export function recordTruncation(kind: TruncationKind): void {
  if (kind === 'embedding') active.embedding_truncated += 1
  else if (kind === 'rerank') active.rerank_truncated += 1
  else active.output_truncated += 1
  active.updated_at = new Date().toISOString()
}

/** A copy safe to hand to a caller (never the live object). */
export function retrievalHealth(): RetrievalHealth {
  return { ...active, by_kind: Object.fromEntries(Object.entries(active.by_kind).map(([k, v]) => [k, { ...v }])) }
}

export function retrievalHealthSummary(): RetrievalHealthSummary {
  const h = retrievalHealth()
  const div = (n: number): number => (h.queries === 0 ? 0 : round(n / h.queries, 4))
  return {
    queries: h.queries,
    zero_result_rate: div(h.zero_results),
    avg_results_per_query: round(h.queries === 0 ? 0 : h.results / h.queries, 2),
    avg_latency_ms: round(h.queries === 0 ? 0 : h.latency_ms_total / h.queries, 2),
    max_latency_ms: round(h.latency_ms_max, 2),
    semantic_live_rate: div(h.semantic_live),
    rerank_used: h.rerank_used,
    rerank_fallback: h.rerank_fallback,
    embedding_truncated: h.embedding_truncated,
    rerank_truncated: h.rerank_truncated,
    output_truncated: h.output_truncated,
    legs_capped: h.legs_capped,
    candidates_dropped_by_floor: h.candidates_dropped_by_floor,
    updated_at: h.updated_at,
    by_kind: h.by_kind,
  }
}

/**
 * Restore a snapshot read back from storage. Deliberately total: a snapshot written by an
 * older build (or a corrupt row) must not break the diagnostics path, so unknown/missing
 * numbers fall back to the empty counter instead of throwing.
 */
export function restoreRetrievalHealth(snapshot: unknown): void {
  if (snapshot === null || typeof snapshot !== 'object') return
  const src = snapshot as Partial<RetrievalHealth>
  const next = empty()
  for (const key of Object.keys(next) as (keyof RetrievalHealth)[]) {
    if (key === 'by_kind' || key === 'updated_at') continue
    const value = src[key]
    if (typeof value === 'number' && Number.isFinite(value)) (next[key] as number) = value
  }
  if (typeof src.updated_at === 'string') next.updated_at = src.updated_at
  if (src.by_kind !== null && typeof src.by_kind === 'object') {
    for (const [kind, value] of Object.entries(src.by_kind)) {
      if (value === null || typeof value !== 'object') continue
      const v = value as Partial<KindHealth>
      next.by_kind[kind] = {
        queries: num(v.queries),
        zero_results: num(v.zero_results),
        results: num(v.results),
      }
    }
  }
  active = next
}

/** Clear every counter (tests, and an explicit operator reset). */
export function resetRetrievalHealth(): void {
  active = empty()
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
