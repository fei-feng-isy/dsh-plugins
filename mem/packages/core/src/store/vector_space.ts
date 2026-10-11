/**
 * The ONE rule that decides whether a persisted vector can serve the store's CURRENT embedding
 * space — and therefore the one place the three counts (`stale` / `space_stale` / `legacy`) mean
 * anything.
 *
 * The rule used to be written out five times (the shared open-time reload, the memory store's cheap
 * blob-length scan, the memory store's decode pass, the knowledge store's SQL projection and its
 * encode-source predicate), each in a slightly different shape: one over `Uint8Array`, one over a
 * projected `length(blob)`, one over a decoded `Float32Array`. They happened to agree; nothing made
 * them. A change to "what counts as stale" landing on one of them is exactly the silent two-spaces-
 * in-one-index failure `reportStaleVectors` exists to announce.
 *
 * The rule, as three elements (and nothing else):
 *
 *   1. `vec == null || byteLength !== dim * 4` → `stale` (the bytes cannot even decode into the
 *      current store);
 *   2. `embedding_model !== space` → `space_stale` (same width, another model's coordinates);
 *   3. of those, `isPreFingerprintSpace(...)` → `legacy` (a one-time format upgrade, not a model
 *      swap).
 *
 * WHAT IS NOT HERE: the SQL mirror (`ChunksDao.vectorSpaceCounts`) stays in SQL — it is what makes a
 * per-slice migration cheap (no blob is read) — and the cross assertions in
 * `test/vector_migration.spec.ts` / `test/knowledge_vector_migration.spec.ts` bind its counts to the
 * counts this module produces and to the startup warning. That is the direction the mirror has to be
 * checked in; a JS port of the SQL query would just be a sixth copy.
 *
 * @module store/vector_space
 */
import { isPreFingerprintSpace } from '../db/vectors.js'
import type { StaleVectorCounts } from './common.js'

/** How many bytes one element of a persisted vector BLOB costs (`float32ToBytes` writes LE f32). */
const BYTES_PER_FLOAT32 = 4

/** What one persisted vector IS, in the current space. */
export type VectorSpaceVerdict = 'current' | 'stale' | 'space_stale'

/**
 * A persisted vector's width, in whichever shape the CALLER already has it — the discriminant is the
 * shape, never the truth:
 *
 *   - `blob` — the raw BLOB (`Uint8Array`), for a caller that has read the bytes;
 *   - `byteLength` — a projected `length(semantic_vector)`, for a caller that must not read them;
 *   - `decoded` — an already decoded `Float32Array`, for a caller that had to decode anyway.
 *
 * All three answer the same question (`width === dim`), which is the point: the caller with the
 * cheapest possible evidence is not forced to re-read the row in another shape. A `null`/`undefined`
 * width is "no usable bytes" and classifies as `stale`, like a wrong one.
 */
export type PersistedVectorWidth =
  | { readonly source: 'blob'; readonly vec: Uint8Array | null | undefined }
  | { readonly source: 'byteLength'; readonly byteLength: number | null | undefined }
  | { readonly source: 'decoded'; readonly vec: Float32Array | null | undefined }

/** One width probe plus the space RECORDED beside it (the second element of the rule). */
export type VectorSpaceProbe = PersistedVectorWidth & {
  /** `facts.embedding_model` / `doc_chunks.embedding_model` of the same row; `null` = unrecorded. */
  readonly embeddingModel: string | null | undefined
}

/** The space the store writes into RIGHT NOW. */
export interface VectorSpaceIdentity {
  /** The representation fingerprint (`vectorSpaceOf`). */
  readonly space: string
  /** The width the store writes now, in floats. */
  readonly dim: number
}

/** One row's classification. */
export interface VectorSpaceClassification {
  readonly verdict: VectorSpaceVerdict
  /** Of a `space_stale` verdict: the recorded id predates the representation fingerprint. */
  readonly legacy: boolean
}

/**
 * Classify ONE persisted vector. Pure: no store, no database, no logging — a caller that disagrees
 * with the result has to disagree with the rule, not with a copy of it.
 *
 * A caller-supplied vector is trusted to come from this backend, but its DIMENSION is still checked
 * — the same asymmetry `legs.ts` applies to a caller-supplied `queryVector`: provenance is the
 * caller's to assert, width is cheap and decides whether the bytes can be compared at all.
 */
export function classifyVectorSpace(probe: VectorSpaceProbe, identity: VectorSpaceIdentity): VectorSpaceClassification {
  const fits = probe.source === 'blob'
    ? probe.vec !== null && probe.vec !== undefined && probe.vec.byteLength === identity.dim * BYTES_PER_FLOAT32
    : probe.source === 'byteLength'
      ? probe.byteLength === identity.dim * BYTES_PER_FLOAT32
      : probe.vec !== null && probe.vec !== undefined && probe.vec.length === identity.dim
  if (!fits) return { verdict: 'stale', legacy: false }
  if (probe.embeddingModel !== identity.space) {
    return { verdict: 'space_stale', legacy: isPreFingerprintSpace(probe.embeddingModel) }
  }
  return { verdict: 'current', legacy: false }
}

/**
 * {@link classifyVectorSpace} over a corpus: the `{ stale, space_stale, legacy }` triple the warning
 * and the `/mem` status surface report, counted by the same rule that classified each row.
 *
 * `legacy` counts only rows already counted in `space_stale` (`reportStaleVectors` clamps it there
 * too) — it is a REASON split, never a fourth bucket.
 */
export function countVectorSpace(
  probes: readonly VectorSpaceProbe[],
  identity: VectorSpaceIdentity,
): StaleVectorCounts {
  let stale = 0
  let spaceStale = 0
  let legacy = 0
  for (const probe of probes) {
    const classified = classifyVectorSpace(probe, identity)
    if (classified.verdict === 'stale') {
      stale++
      continue
    }
    if (classified.verdict === 'space_stale') {
      spaceStale++
      if (classified.legacy) legacy++
    }
  }
  return { stale, space_stale: spaceStale, legacy }
}
