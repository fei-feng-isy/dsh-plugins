import { createHash } from 'node:crypto'

/** 2π (float64, cross-platform stable). */
export const TWO_PI = Math.PI * 2

export class AtomDimensionError extends Error {}

function validateDim(dim: number): void {
  if (!Number.isInteger(dim) || typeof dim !== 'number') {
    throw new AtomDimensionError(`dim 必须是 int，实际：${dim}`)
  }
  if (dim <= 0) throw new AtomDimensionError(`dim 必须是正整数，实际：${dim}`)
  if (dim % 2 !== 0) throw new AtomDimensionError(`dim 必须是偶数，实际：${dim}`)
}

/**
 * Process-wide memo for {@link atom}.
 *
 * Deriving one atom means `dim/32` SHA-256 blocks plus `dim` BigInt divisions — measured ~0.7 ms at
 * dim=1024 — and the same entity names recur constantly: `add`/`update` derive one atom per entity
 * per write (before this, ~3.9 ms per write), and the HRR leg derives them for the query's entities
 * on every probe. The function is pure and deterministic BY CONTRACT, so caching cannot change a
 * result, and `bundle()` only READS its inputs, which is why handing out shared arrays is safe.
 *
 * Bounded by a BYTE budget, evicted FIFO (oldest insertion first). Three reasons this is a budget
 * and not an entry count: the cost of an entry is exactly `dim * 8` bytes (`Float64Array(dim)`), so
 * an entry count gives a process at dim=1024 sixteen times the memory of one at dim=64; `dim`
 * follows the configured HRR dimension, so a count that is safe for one config is not safe for
 * another; and eviction must be incremental — the previous `clear()` on overflow threw away the
 * whole vocabulary, so the next lookups paid `dim/32` SHA-256 blocks plus `dim` BigInt divisions
 * (measured ~0.7 ms at dim=1024) each. FIFO over LRU is deliberate: a hit would have to reorder the
 * Map (delete + re-insert) on the hot path, while the working set here is a small entity vocabulary
 * that fits far inside the budget, so the two policies keep the same entries in practice.
 */
const ATOM_CACHE = new Map<string, Float64Array>()
/** Default byte budget for {@link ATOM_CACHE}: 16 MiB = 2048 atoms at dim=1024. */
const ATOM_CACHE_BYTES = 16 * 1024 * 1024
/** Bytes currently held by {@link ATOM_CACHE}; kept in step with the map, never recomputed. */
let atomCacheBytes = 0

/**
 * Deterministic phase vector derived from `name` (Plate-style HRR atom).
 * SHA-256(name) → rolling SHA-256 blocks → uint64 LE → phase in [0, 2π).
 * Same (name, dim) yields identical vectors across environments.
 *
 * The returned array is SHARED with the memo (treat it as immutable — callers only read it).
 */
export function atom(name: string, dim = 1024): Float64Array {
  if (typeof name !== 'string') throw new TypeError(`name 必须是 str`)
  if (!name) throw new Error('name 不能是空字符串')
  validateDim(dim)

  const cacheKey = `${dim}\u0000${name}`
  const cached = ATOM_CACHE.get(cacheKey)
  if (cached) return cached

  const base = createHash('sha256').update(name, 'utf8').digest()
  const bytesNeeded = dim * 8
  const chunks: Buffer[] = []
  let collected = 0
  let counter = 0
  while (collected < bytesNeeded) {
    const counterBuf = Buffer.alloc(4)
    counterBuf.writeUInt32BE(counter, 0)
    const block = createHash('sha256').update(Buffer.concat([base, counterBuf])).digest()
    chunks.push(block)
    collected += 32
    counter += 1
  }
  const raw = Buffer.concat(chunks).subarray(0, bytesNeeded)
  const TWO_64 = 2n ** 64n

  const out = new Float64Array(dim)
  for (let i = 0; i < dim; i++) {
    const u = raw.readBigUInt64LE(i * 8)
    out[i] = (Number(u) / Number(TWO_64)) * TWO_PI
  }
  // Evict from the oldest insertion until the new entry fits, so resident bytes never exceed the
  // budget (a single entry larger than the whole budget is admitted alone: refusing it would cost a
  // full recomputation on every call, and the caller already owns the same `dim * 8` bytes).
  const bytes = dim * 8
  while (atomCacheBytes + bytes > ATOM_CACHE_BYTES) {
    const oldestKey = ATOM_CACHE.keys().next().value
    if (oldestKey === undefined) break
    const victim = ATOM_CACHE.get(oldestKey)!
    ATOM_CACHE.delete(oldestKey)
    atomCacheBytes -= victim.length * 8
  }
  ATOM_CACHE.set(cacheKey, out)
  atomCacheBytes += bytes
  return out
}

/** Batch-derive atom vectors; returns `names.length` rows of dim. */
export function atomBatch(names: string[], dim = 1024): Float64Array[] {
  validateDim(dim)
  return names.map((n) => atom(n, dim))
}

/**
 * Whether `vec` is a valid phase vector (Float64Array, even positive length, finite and in [0, 2π)).
 *
 * The finiteness check is not redundant with the range check: every comparison against NaN is false,
 * so `NaN < 0 || NaN >= TWO_PI` passes and a corrupt blob decoded to NaN used to read as a valid
 * atom — then `phaseSimilarity` returned NaN and poisoned the fused ranking (see `scaleByMax`).
 */
export function isValidAtom(vec: Float64Array): boolean {
  if (!(vec instanceof Float64Array)) return false
  if (vec.length === 0 || vec.length % 2 !== 0) return false
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i]) || vec[i] < 0 || vec[i] >= TWO_PI) return false
  }
  return true
}
