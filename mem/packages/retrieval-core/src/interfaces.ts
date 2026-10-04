/**
 * The three stable contracts the business flow depends on.
 * The business flow (fusion pipeline, stores, tools, router, UI) must depend only on
 * these interfaces — never on a concrete backend. See DESIGN §5.
 */

/**
 * HOW a backend turns text into a vector — the knobs that decide which coordinates a stored vector
 * lives in, beyond `name`/`dim`.
 *
 * The vector-space identity used to record only `backend/model/dim`, so a change of pooling,
 * normalization, input window or the weights behind the same repo name produced the SAME identity:
 * new vectors were written into an index that still held the old ones and nothing detected the
 * migration (see `db/vectors.ts` and DESIGN §20). A backend that can name these knobs declares them
 * here and the space id carries them (see `representationKey`).
 */
export interface SemanticRepresentation {
  /** Pooling strategy handed to the feature-extraction pipeline (`mean`, `cls`, …). */
  readonly pooling: string
  /** Whether vectors are L2-normalized by the pipeline (cosine relies on it). */
  readonly normalize: boolean
  /**
   * The CONFIGURED input-token cap (`0` = auto/declared window), i.e. the truncation window the
   * adapter bounds text to before encoding. The CONFIGURED value, not the resolved one: the
   * resolved window depends on the loaded tokenizer, so it is unknown before warmup — and the
   * fingerprint must be identical before and after warmup, or a store would declare its own rows
   * stale the moment the model finished loading.
   */
  readonly maxInputTokens: number
  /**
   * Content identity of the model files (the family sidecar's revision sha), when one could be
   * read. Absent = "could not be read" (not "known to be empty"): the fingerprint then omits it,
   * which is the documented degradation, never an error.
   */
  readonly revision?: string
}

/** Encodes text into a normalized embedding vector. */
export interface SemanticBackend {
  readonly name: string
  readonly dim: number
  encode(text: string): Promise<Float32Array>
  encodeBatch(texts: string[]): Promise<Float32Array[]>
  isAvailable(): boolean
  /**
   * Optional declaration of the representation knobs this backend applies. The built-in
   * `local_bge` declares them; a third-party backend that omits this is fingerprinted as
   * `rep=undeclared` (the space id still changes with name/dim), which is honest rather than a
   * silent claim to a representation nobody verified.
   */
  representation?(): SemanticRepresentation
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
   * latency — benchmarks, and tests that assert on build cost — can force the mission.
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
