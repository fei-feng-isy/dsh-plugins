import type { VectorStore } from '@avantf/mem-core'
import { retrievalLogger } from '@avantf/mem-core'

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
 * Identity of a VECTOR SPACE: which backend, which model, how wide.
 *
 * Persisted beside every vector (`facts.embedding_model`, `doc_chunks.embedding_model`) so
 * "these vectors came from a different model" is detectable. It used to record only the
 * backend name, which made a same-width model swap (bge-small-zh → bge-m3, both 512d)
 * indistinguishable from "already encoded": the two spaces then shared one index and were
 * ranked against each other.
 *
 * The vector STORE is deliberately not part of the identity: numpy vs hnswlib indexes the
 * same vectors, so switching it must not trigger re-encoding (that is `reloadIndex`).
 */
export function vectorSpaceId(backend: string, model: string, dim: number): string {
  return `${backend}/${model}/${String(dim)}`
}

/**
 * Rebuild a live vstore from persisted vector BLOBs — the restart-recovery path
 * shared by both stores (the two copies had already drifted: memory warned on
 * dim mismatches, knowledge dropped them silently).
 *
 * The rows come from the owning store's DAO (DESIGN §19): this helper decodes and
 * filters them, it never runs SQL itself.
 *
 * @param rows - `id` (fact/chunk id) + `vec` (BLOB), as read back from the store.
 * @param label - store name used in the dim-mismatch warning.
 */
export function reloadVectorIndex(
  vstore: VectorStore,
  rows: readonly { id: number; vec: Uint8Array | null }[],
  label: string,
): { loaded: number; skipped: number } {
  const entries: { id: number; vec: Float32Array }[] = []
  let skipped = 0
  for (const r of rows) {
    const vec = bytesToFloat32(r.vec)
    if (vec && vec.length === vstore.dim) entries.push({ id: r.id, vec })
    else skipped++
  }
  if (skipped > 0) {
    // Dim mismatch (e.g. semantic.dim changed since these vectors were written):
    // skip them — vectors_fix / reindex re-encode with the current model.
    retrievalLogger().warn(`${label} index reload: skipped ${skipped} vector(s) with dim != ${vstore.dim}`)
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
