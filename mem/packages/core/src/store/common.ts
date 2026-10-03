/**
 * Pieces both stores need identically.
 *
 * Small on purpose: `MemoryStore` and `KnowledgeStore` are separate stores over separate databases
 * and should stay that way (AGENTS.md). What they must NOT have is two copies of the same
 * three-line helper, because a fix then lands in one of them — which is exactly what happened to the
 * retrieval orchestration (see `store/hybrid.ts`) and to the foreign-vector-space warning below: the
 * memory store checked whether its persisted vectors came from the CURRENT vector space and told the
 * operator how to fix it, while the knowledge store checked only the width, so a model swap left two
 * spaces silently mixed in one index until someone happened to run `kb_reindex`.
 *
 * @module store/common
 */
import type { SemanticBackend, VectorStore } from '@avantf/mem-retrieval'
import { retrievalLogger } from '@avantf/mem-retrieval'
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
 * A change of backend, model or width makes every stored vector stale, and the point of recording
 * the identity is that such a change is DETECTED instead of silently mixing two spaces in one index.
 */
export function vectorSpaceOf(semantic: SemanticBackend, model: string): string {
  return vectorSpaceId(semantic.name, model, semantic.dim)
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
 * Tell the operator that persisted vectors came from ANOTHER vector space.
 *
 * A dim-valid vector from a different space is still RANKED — the reload cannot tell the difference
 * — so a silent model swap would mix two spaces in one index and degrade every semantic query
 * without an error anywhere. Said once per process; acting on it is the operator's choice because
 * re-encoding is a real cost (and they should see the count first).
 *
 * @param kind   store label for the message (`memory` / `knowledge`)
 * @param space  the vector space the store writes into now
 * @param foreign how many persisted vectors were written in a different one
 * @param fix    the action that re-encodes them, as the operator would type it
 */
export function reportForeignVectors(kind: string, space: string, foreign: number, fix: string): void {
  if (foreign <= 0) return
  retrievalLogger().warn(
    `${kind} index: ${String(foreign)} vector(s) were written in another space than ${space} — they are `
    + `still ranked; run ${fix} to re-encode them`,
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
