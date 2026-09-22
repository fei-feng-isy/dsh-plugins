import type { Reranker } from '../interfaces.js'

/** `none` — reranking disabled (the default). Reports unavailable so callers skip the rerank pass entirely. */
export class NoneReranker implements Reranker {
  readonly name = 'none'
  isAvailable(): boolean {
    return false
  }
  async rerank(_query: string, candidates: { id: number; text: string }[]): Promise<number[]> {
    // Identity order (contract: candidate ids, best first).
    return candidates.map((c) => c.id)
  }
}
