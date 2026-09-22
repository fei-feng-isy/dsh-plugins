import { atom, TWO_PI } from './atoms.js'
import { bundle } from './algebra.js'

/**
 * Encode a fact's entity set as an HRR phase vector (composition via bundle of
 * entity atoms). Deterministic for a given entity set, enabling the HRR probe
 * (phase similarity) used for entity-level recall of facts whose entities were
 * not captured by the entity table.
 */
export function encodeHrrEntityVector(entityNames: string[], dim = 1024): Float64Array {
  if (entityNames.length === 0) return atom('__empty__', dim)
  return bundle(...entityNames.map((n) => atom(n, dim)))
}

/**
 * Serialize a phase vector to bytes (for SQLite BLOB).
 *
 * Written as explicit little-endian, matching `float32ToBytes` — the layout is then
 * a property of the format rather than of the host's byte order.
 */
export function hrrToBytes(vec: Float64Array): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 8)
  for (let i = 0; i < vec.length; i++) buf.writeDoubleLE(vec[i], i * 8)
  return buf
}

/**
 * Deserialize bytes to a phase vector, or `null` when the bytes are not one.
 *
 * Reads through a `DataView` instead of `new Float64Array(buf.buffer, buf.byteOffset, …)`:
 * that constructor requires an 8-byte-ALIGNED `byteOffset`, and nothing about a SQLite
 * BLOB promises one (better-sqlite3 happens to hand back offset-0 buffers today, but the
 * callers here also pass plain `Uint8Array`s — a subarray or a pooled `Buffer` slice
 * would throw a RangeError from deep inside retrieval). A trailing partial element is
 * ignored, as before.
 *
 * A NON-FINITE phase is rejected here rather than scored: every range check in
 * {@link isValidAtom} compares false against NaN, so a corrupt blob would otherwise sail through
 * the caller's length check, make `phaseSimilarity` return NaN, and poison the whole fused ranking
 * (one NaN in a sort comparator leaves the ORDER undefined, not just one score wrong). Callers
 * already treat `null` as "skip this row".
 */
export function hrrFromBytes(buf: Buffer | Uint8Array): Float64Array | null {
  if (!buf || buf.byteLength === 0) return null
  const count = Math.floor(buf.byteLength / 8)
  if (count === 0) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out = new Float64Array(count)
  for (let i = 0; i < count; i++) {
    const phase = view.getFloat64(i * 8, true)
    if (!Number.isFinite(phase) || phase < 0 || phase >= TWO_PI) return null
    out[i] = phase
  }
  return out
}
