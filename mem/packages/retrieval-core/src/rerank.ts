import type { Reranker } from './interfaces.js'

/**
 * The one rerank-and-reorder pass shared by every retrieval leg (memory search,
 * knowledge search — the blocks were byte-identical and had already drifted once
 * on the miss-sort sentinel).
 *
 * Contract: `reranker.rerank` returns candidate ids best-first; ids it omits sort
 * last with their fused order preserved (stable sort). A disabled/unavailable
 * reranker is a pass-through.
 */
export async function rerankHits<T extends { id: number }>(
  reranker: Reranker,
  query: string,
  hits: T[],
  textOf: (id: number) => string,
): Promise<T[]> {
  if (hits.length === 0) return hits
  if (!reranker.isAvailable()) {
    // Observing call site: a failed bootstrap stays retryable (see warm_gate.ts).
    reranker.ensureWarm?.()
    return hits
  }
  const order = await reranker.rerank(query, hits.map((h2) => ({ id: h2.id, text: textOf(h2.id) })))
  const rankMap = new Map(order.map((id, i) => [id, i]))
  return [...hits].sort(
    (a, b) => (rankMap.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rankMap.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  )
}
