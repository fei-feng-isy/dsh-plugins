import type { VectorStore } from '@avantf/mem-retrieval'

/** Little-endian Float32 ↔ BLOB helpers for persisted vectors (cross-platform stable). */

export function float32ToBytes(vec: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}

export function bytesToFloat32(buf: Uint8Array | null | undefined): Float32Array | null {
  if (!buf || buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null
  const out = new Float32Array(buf.byteLength / 4)
  const view = buf instanceof Buffer ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  for (let i = 0; i < out.length; i++) out[i] = view.readFloatLE(i * 4)
  return out
}

/**
 * Identity of a VECTOR SPACE — the REPRESENTATION FINGERPRINT.
 *
 * Persisted beside every vector (`facts.embedding_model`, `doc_chunks.embedding_model`) so
 * "these vectors came from a different representation" is detectable. It used to record only the
 * backend name, then `backend/model/dim`; both were blind to the rest of what decides which
 * coordinates a vector lives in — pooling, normalization, the truncation window, and the weights
 * behind an unchanged repo name. The space id now embeds:
 *
 *  - {@link VECTOR_SPACE_FORMAT}, a format version. Bumping it is a deliberate ONE-TIME full
 *    re-encode of every existing library (the old ids simply are not equal to any new id), which
 *    is exactly why the stale-vector warning has to explain that case instead of calling it a
 *    model swap (see `reportStaleVectors`);
 *  - the backend, model and width, as before;
 *  - the backend's declared representation (`representationKey`): pooling / normalize /
 *    max_input_tokens / model revision. The revision is omitted when the family sidecar could not
 *    be read — a documented degradation, never a crash.
 *
 * The vector STORE is deliberately not part of the identity: numpy vs hnswlib indexes the
 * same vectors, so switching it must not trigger re-encoding (that is `reloadIndex`).
 */
export const VECTOR_SPACE_FORMAT = 2

/** `v<format>/` — the prefix every current-format space id starts with (and old ids do not). */
export const VECTOR_SPACE_FORMAT_PREFIX = `v${String(VECTOR_SPACE_FORMAT)}/`

/**
 * @param backend - the `SemanticBackend` name.
 * @param model - the configured model id.
 * @param dim - the configured width.
 * @param representation - the normalized representation key (`representationKey`). Omitted by
 *   callers with no backend in hand (benchmarks, the pure id tests); such an id is still
 *   format-prefixed, so it can never equal a pre-fingerprint id.
 */
export function vectorSpaceId(backend: string, model: string, dim: number, representation?: string): string {
  const base = `${VECTOR_SPACE_FORMAT_PREFIX}${backend}/${model}/${String(dim)}`
  return representation === undefined || representation === '' ? base : `${base}@${representation}`
}

/**
 * `true` when a recorded space id predates the representation fingerprint (`v2/…`), or comes from a
 * format this build does not know. The distinction is what lets the warning explain a one-time
 * format upgrade separately from "another model's vectors are in this index".
 */
export function isPreFingerprintSpace(recorded: string | null | undefined): boolean {
  return typeof recorded === 'string' && recorded !== '' && !recorded.startsWith(VECTOR_SPACE_FORMAT_PREFIX)
}

/**
 * Rebuild a live vstore from persisted vector BLOBs — the restart-recovery path
 * shared by both stores (the two copies had already drifted: memory warned on
 * dim mismatches, knowledge dropped them silently).
 *
 * The rows come from the owning store's DAO (DESIGN §19): this helper decodes and
 * filters them, it never runs SQL itself.
 *
 * A row whose width does not fit the store is skipped (never `add()`ed — the store
 * would throw). The OWNING store reports that condition itself, as one actionable
 * line with the count, the reason and the manual re-encode entry (`reportStaleVectors`),
 * so this helper stays quiet: two warnings for one condition read as two problems.
 *
 * @param rows - `id` (fact/chunk id) + `vec` (BLOB), as read back from the store.
 * @param _label - store name; unused here (the owning store owns the warning), kept so call sites read
 *                 as "which store is reloading".
 */
export function reloadVectorIndex(
  vstore: VectorStore,
  rows: readonly { id: number; vec: Uint8Array | null }[],
  _label: string,
): { loaded: number; skipped: number } {
  const entries: { id: number; vec: Float32Array }[] = []
  let skipped = 0
  for (const r of rows) {
    const vec = bytesToFloat32(r.vec)
    if (vec && vec.length === vstore.dim) entries.push({ id: r.id, vec })
    else skipped++
  }
  vstore.rebuild(entries)
  return { loaded: entries.length, skipped }
}

/**
 * On-disk ANN snapshot PREFIX for a store's vector index (the adapter appends
 * `.<fingerprint>.hnsw`), or `null` when the database has no file to sit beside.
 *
 * The VECTOR SPACE is part of the name, not just of the rows: a snapshot is a serialized graph, so
 * loading one built from another model (or width) would silently serve vectors that describe
 * different text. Embedding the space means a model swap looks for a different file, and the
 * adapter's fingerprint covers everything else (see `HnswlibVectorStore.snapshotPath`).
 *
 * The space is `encodeURIComponent`-escaped rather than sanitized: lossy replacement mapped `a/b`
 * and `a_b` onto the SAME name, which is exactly the collision this path exists to prevent.
 * `:memory:` (or any non-file path) returns `null` — otherwise the snapshot is written into the
 * process working directory under a `:memory:.…` name.
 */
export function vectorCachePath(dbPath: string, space: string): string | null {
  if (!dbPath || dbPath.startsWith(':')) return null
  return `${dbPath}.${encodeURIComponent(space)}`
}
