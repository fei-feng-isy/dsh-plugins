/**
 * The three stable contracts the business flow depends on.
 * The business flow (fusion pipeline, stores, tools, router, UI) must depend only on
 * these interfaces — never on a concrete backend. See DESIGN §5.
 */

/** Encodes text into a normalized embedding vector. */
export interface SemanticBackend {
  readonly name: string
  readonly dim: number
  encode(text: string): Promise<Float32Array>
  encodeBatch(texts: string[]): Promise<Float32Array[]>
  isAvailable(): boolean
  /** Optional async bootstrap: configure env + download/load the model. */
  warmUp?(): Promise<void>
  /**
   * Optional non-blocking retry for call sites that only *observe* availability
   * (hybrid search, best-effort indexing): re-attempts a failed bootstrap,
   * coalescing with any in-flight attempt and throttling to one attempt per
   * floor. Implementations that load lazily may omit it.
   */
  ensureWarm?(): void
}

/** Re-ranks candidate facts/chunks by query relevance. */
export interface Reranker {
  readonly name: string
  rerank(query: string, candidates: { id: number; text: string }[]): Promise<number[]>
  isAvailable(): boolean
  /** Optional async bootstrap: configure env + download/load the model. */
  warmUp?(): Promise<void>
  /** Optional non-blocking retry — see {@link SemanticBackend.ensureWarm}. */
  ensureWarm?(): void
}

/** Distance/ann index over entry vectors (per-store instance). */
export interface VectorStore {
  readonly name: string
  readonly dim: number
  add(id: number, vec: Float32Array): void
  /** Cosine-similarity top-k over all stored vectors (brute force by default). */
  topk(vec: Float32Array, k: number): { id: number; score: number }[]
  fetch(ids: number[]): Map<number, Float32Array>
  remove(id: number): void
  /**
   * Optional batch removal. A backend that cannot delete incrementally MUST implement this so
   * eviction loops stay O(N) instead of O(N²); callers prefer it whenever they evict more than one
   * id. (hnswlib deletes by tombstone, so its `removeMany` is O(k) — it implements this to share
   * the "compact once for the whole batch" path, not because a single delete would rebuild.)
   */
  removeMany?(ids: number[]): void
  /**
   * Optional: drop any dead/tombstoned entries the backend is carrying, now. An explicit
   * "reclaim it" hook for maintenance; implementations that cannot accumulate dead state omit it.
   */
  compact?(): void
  count(): number
  rebuild(rows: Iterable<{ id: number; vec: Float32Array }>): void
  /**
   * Optional: materialize any structure the backend built LAZILY. `topk` must always be correct
   * without it (it builds on demand); this exists so callers that need deterministic first-query
   * latency — benchmarks, and tests that assert on build cost — can force the work.
   */
  prepare?(): void
  /**
   * Optional: point the backend at an on-disk cache of its native index. The path is the
   * STORE's choice and must embed the vector space (model/dim), so a model swap cannot load a
   * snapshot built from another space. Best-effort: a missing/corrupt/stale file is rebuilt.
   */
  attachPersistence?(path: string): void
  /**
   * Optional: persist any state that is only in memory. Called on shutdown; implementations that
   * have nothing pending may omit it.
   */
  flush?(): void
}

export interface TopKHit {
  id: number
  score: number
}
