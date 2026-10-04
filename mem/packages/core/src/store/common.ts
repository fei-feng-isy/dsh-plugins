/**
 * Pieces both stores need identically.
 *
 * Small on purpose: `MemoryStore` and `KnowledgeStore` are separate stores over separate databases
 * and should stay that way (AGENTS.md). What they must NOT have is two copies of the same
 * three-line helper, because a fix then lands in one of them — which is exactly what happened to the
 * retrieval orchestration (see `store/hybrid.ts`) and to the stale-vector warning below: the
 * memory store checked whether its persisted vectors came from the CURRENT vector space and told the
 * operator how to fix it, while the knowledge store checked only the width, so a model swap left two
 * spaces silently mixed in one index until someone happened to run `kb_reindex`.
 *
 * @module store/common
 */
import type { SemanticBackend, VectorStore } from '@avantf/mem-retrieval'
import { representationKeyOf, retrievalLogger } from '@avantf/mem-retrieval'
import { toWellFormedText } from '@avantf/mem-contract'
import { vectorSpaceId } from '../db/vectors.js'

/**
 * The ONE write-side normalization both stores call before anything reaches the database.
 *
 * `@avantf/mem-contract`'s `toWellFormedText` is the implementation (well-formed + NFC); this name
 * is the store-layer entry, so the write paths say WHAT they are doing ("normalize this for a
 * write") rather than repeating a Unicode recipe. Every text field a store persists — fact content,
 * category, archive reason, a document's domain/source/title/uri, entity names and the SPO slots of
 * extracted triples — goes through here, which is what keeps a lone surrogate (and the strict-JSON
 * failure it causes downstream) out of the database in the first place.
 */
export function normalizeWrite(value: string): string {
  return toWellFormedText(value)
}

/** {@link normalizeWrite} over a batch (entity names, caller paths, …). */
export function normalizeWrites(values: readonly string[]): string[] {
  return values.map(normalizeWrite)
}

/**
 * Identity of the vector space a store currently writes into.
 *
 * A change of backend, model, width — or of anything else that decides which coordinates a vector
 * lives in (pooling, normalization, the input window, the model revision behind an unchanged repo
 * name) — makes every stored vector stale. The point of recording the identity is that such a
 * change is DETECTED instead of silently mixing two spaces in one index. The backend declares its
 * representation (`SemanticBackend.representation`); one that does not is fingerprinted as
 * `rep=undeclared`, which is honest rather than a claim nobody verified.
 */
export function vectorSpaceOf(semantic: SemanticBackend, model: string): string {
  return vectorSpaceId(semantic.name, model, semantic.dim, representationKeyOf(semantic))
}

/** The two contract counts plus the internal "predates the representation fingerprint" split. */
export interface StaleVectorCounts {
  stale: number
  space_stale: number
  /**
   * Of {@link space_stale}, how many were written BEFORE the representation fingerprint (`v2/…`).
   * The count is what makes the warning able to say "this is a one-time format upgrade" instead of
   * blaming a model swap the operator never made.
   */
  legacy?: number
}

/**
 * Drop ids from the vector index, in one batch when the backend supports it.
 *
 * `removeMany` is optional on the interface: a backend that cannot delete incrementally would make
 * an eviction loop O(N²) without it, and hnswlib's is O(k) tombstoning.
 */
export function evictVectors(vstore: VectorStore, ids: readonly number[]): void {
  if (ids.length === 0) return
  if (vstore.removeMany) vstore.removeMany([...ids])
  else for (const id of ids) vstore.remove(id)
}

/**
 * Tell the operator that persisted vectors came from ANOTHER vector space — loudly, and with the
 * manual remedy.
 *
 * Changing the embedding space (model, width, pooling, normalization) is a DATA MIGRATION: the
 * persisted bytes stay valid-looking but are no longer comparable with the current query vector, so
 * the semantic leg must not serve them. Measured on the real library after the 512→768 default-model
 * swap: 78 of 80 ACTIVE facts fell out of the semantic leg and retrieval silently degraded to
 * lexical+entity (every probe query answered with the same unrelated short fact), with no error
 * anywhere. The count, the reason and the ONE manual entry have to be visible at start.
 *
 * Both halves are reported in one message because they are one condition seen two ways: a changed
 * WIDTH (`stale`, whose bytes cannot even be decoded into the current store) and a changed SPACE at
 * the same width (`space_stale`, whose bytes decode but rank in another model's coordinates).
 *
 * @param kind   store label for the message (`memory` / `knowledge`)
 * @param space  the vector space the store writes into now
 * @param counts how many persisted vectors are unusable in the current space, by kind
 * @param fix    the manual entry that re-encodes them, as the operator would type it
 */
export function reportStaleVectors(
  kind: string,
  space: string,
  counts: StaleVectorCounts,
  fix: string,
): void {
  const total = counts.stale + counts.space_stale
  if (total <= 0) return
  const legacy = Math.min(counts.legacy ?? 0, counts.space_stale)
  const reasons: string[] = []
  if (counts.stale > 0) reasons.push(`${String(counts.stale)} with a width that no longer matches`)
  if (counts.space_stale - legacy > 0) reasons.push(`${String(counts.space_stale - legacy)} written by another model or representation`)
  if (legacy > 0) {
    reasons.push(
      `${String(legacy)} written before the representation fingerprint — a ONE-TIME full re-encode of the whole library `
      + '(seconds; measured ~11 s for 80 facts)',
    )
  }
  retrievalLogger().warn(
    `${kind} index: ${String(total)} persisted vector(s) belong to an OLDER embedding space than ${space} `
    + `(${reasons.join('; ')}) — the semantic leg cannot use them, so retrieval degrades to lexical+entity `
    + `(this is a data migration, not a transient error); run ${fix} to re-encode them`,
  )
}

/**
 * Hand the event loop back between two synchronous batches.
 *
 * The mount-time corpus reconcile reads and hashes EVERY managed document (and then walks the tree
 * again for orphans), all of it synchronous `node:fs`; at 10k documents that is a >0.6 s block of the
 * host's event loop (measured — see the performance review §7.5 / P6). `setImmediate` (a macrotask),
 * not a resolved-promise microtask: yielding to the microtask queue would let other JS continuations
 * run while timers and I/O queued behind the batch still waited.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(() => { resolve() }) })
}

/**
 * How many items one synchronous batch may visit before {@link yieldToEventLoop} runs.
 *
 * 200 is a compromise: large enough that the yields themselves are noise next to the per-item
 * `read`+`sha256` (measured ~60 µs each), small enough that the longest single block stays in the
 * low tens of milliseconds at any corpus size.
 */
export const YIELD_BATCH = 200

/**
 * Visit `items` in order, yielding the event loop every `every` items.
 *
 * Use this INSTEAD of a bare `for` loop whenever the per-item mission is synchronous filesystem or
 * hashing work whose item count follows the corpus (not the request): the caller's whole loop used to
 * be one uninterrupted block, so the host could not serve a timer or an I/O callback until it was
 * over. An empty list does nothing (and never yields).
 */
export async function forEachYielding<T>(
  items: readonly T[],
  visit: (item: T, index: number) => void,
  every: number = YIELD_BATCH,
): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    visit(items[index] as T, index)
    if ((index + 1) % every === 0) await yieldToEventLoop()
  }
}
