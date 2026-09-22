import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HnswlibVectorStore } from '../src/adapters/hnswlib.js'
import { setRetrievalLogger } from '../src/log.js'

// a tiny helper to build normalized vectors
function vec(seed: number, dim = 8): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed + i)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  for (let i = 0; i < dim; i++) v[i] /= norm
  return v
}

describe('hnswlib vector store', () => {
  it('ranks by cosine similarity (higher score = more similar)', () => {
    const vs = new HnswlibVectorStore(8)
    const q = vec(1)
    const a = vec(1) // same as query → highest similarity
    const b = vec(9) // far → low similarity
    vs.add(10, a)
    vs.add(20, b)
    const hits = vs.topk(q, 2)
    expect(hits[0].id).toBe(10)
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })

  it('supports fetch and count', () => {
    const vs = new HnswlibVectorStore(8)
    vs.add(1, vec(2))
    vs.add(2, vec(3))
    expect(vs.count()).toBe(2)
    expect(vs.fetch([1, 2]).size).toBe(2)
  })

  it('rejects a wrong-dim vector without tearing down the live index', () => {
    const vs = new HnswlibVectorStore(8)
    vs.add(1, vec(2))
    expect(() => vs.add(2, new Float32Array(3))).toThrow(/向量维度不匹配/)
    // the store is still usable and the first vector survived
    expect(vs.count()).toBe(1)
    expect(vs.topk(vec(2), 1)[0].id).toBe(1)
  })
})

/**
 * The search beam (`ef`) is the recall/speed knob, and hnswlib's own default is a cliff: with
 * `ef = 10` this adapter returned ~0.45 of the true top-k on 2000 random vectors in dim 512,
 * while the configured floor (256) is ~exact. Pinned here because nothing else would notice the
 * regression — the index still answers, just worse, and the fused ranking hides it.
 */
describe('hnswlib search beam', () => {
  function rng(seed: number): () => number {
    return () => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  function unitVectors(count: number, dim: number, next: () => number): { id: number; vec: Float32Array }[] {
    return Array.from({ length: count }, (_, i) => {
      const vec = new Float32Array(dim)
      let norm = 0
      for (let d = 0; d < dim; d++) {
        vec[d] = next() * 2 - 1
        norm += vec[d] * vec[d]
      }
      norm = Math.sqrt(norm) || 1
      for (let d = 0; d < dim; d++) vec[d] /= norm
      return { id: i + 1, vec }
    })
  }

  /** `count` random unit query vectors, drawn from the same stream as the corpus. */
  function unitQueries(count: number, dim: number, next: () => number): Float32Array[] {
    return Array.from({ length: count }, () => {
      const vec = new Float32Array(dim)
      let norm = 0
      for (let d = 0; d < dim; d++) {
        vec[d] = next() * 2 - 1
        norm += vec[d] * vec[d]
      }
      norm = Math.sqrt(norm) || 1
      for (let d = 0; d < dim; d++) vec[d] /= norm
      return vec
    })
  }

  /** Recall of `store` against brute force over `corpus` (ids absent from the store are not gold). */
  function recallOf(
    store: HnswlibVectorStore,
    corpus: { id: number; vec: Float32Array }[],
    queries: Float32Array[],
    k: number,
  ): number {
    let hit = 0
    let total = 0
    for (const q of queries) {
      const exact = new Set(
        corpus
          .map((r) => ({ id: r.id, score: r.vec.reduce((s, x, d) => s + x * (q[d] ?? 0), 0) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k)
          .map((r) => r.id),
      )
      for (const found of store.topk(q, k)) if (exact.has(found.id)) hit += 1
      total += exact.size
    }
    return total === 0 ? 1 : hit / total
  }

  it('recovers the brute-force neighbours on a corpus past the auto threshold', () => {
    const dim = 128
    const next = rng(7)
    const rows = unitVectors(2000, dim, next)
    const queries = unitQueries(10, dim, next)

    const store = new HnswlibVectorStore(dim)
    if (!store.native) return // no binding in this environment: nothing to pin
    store.rebuild(rows)

    expect(recallOf(store, rows, queries, 10)).toBeGreaterThan(0.95)
  })

  it('keeps the beam applied after an eviction that REPLACES the native index', () => {
    // A replacement builds a NEW HierarchicalNSW, which starts at hnswlib's own default `ef`.
    // The beam cache is keyed on the index instance for this reason: keyed on the number alone,
    // the re-apply was skipped and recall fell back to ~0.44 of the true top-k — on the write
    // path, after every archive/purge, with nothing in the logs.
    //
    // Eviction itself no longer replaces the index (it tombstones — see the tombstone suite);
    // compaction and `rebuild` still do, and those are what this pins.
    const dim = 128
    const next = rng(13)
    const rows = unitVectors(2000, dim, next)
    const queries = unitQueries(10, dim, next)

    const store = new HnswlibVectorStore(dim)
    if (!store.native) return
    store.rebuild(rows)
    expect(recallOf(store, rows, queries, 10)).toBeGreaterThan(0.95)

    const evicted = new Set([1, 2, 3])
    store.removeMany([...evicted])
    const surviving = rows.filter((r) => !evicted.has(r.id))
    expect(store.count()).toBe(surviving.length)
    expect(recallOf(store, surviving, queries, 10)).toBeGreaterThan(0.95)

    // Force the replacement path explicitly, then re-check the beam.
    store.compact()
    expect(store.stats().rebuilds).toBeGreaterThan(1)
    expect(recallOf(store, surviving, queries, 10)).toBeGreaterThan(0.95)
  })

  it('honours an explicit ef_search, including a deliberately narrow beam', () => {
    const dim = 64
    const next = rng(11)
    const rows = unitVectors(500, dim, next)
    const narrow = new HnswlibVectorStore(dim, 16)
    if (!narrow.native) return
    narrow.rebuild(rows)
    // A narrow beam still returns k DISTINCT neighbours — a lower recall, not a broken search.
    const hits = narrow.topk(rows[0]!.vec, 10)
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length)
    expect(hits.length).toBeGreaterThan(0)
  })
})

/**
 * Tombstones, compaction and snapshots — the three things that make the ANN backend usable at
 * scale. Eviction used to rebuild the whole graph (1.3 s for ONE id at 8000 vectors, paid on
 * every `update`/`archive`/tick), and startup rebuilt an index that is a serializable structure.
 * These tests assert on the adapter's own counters rather than on wall time, so they pin the
 * MECHANISM (a tombstone, not a rebuild) instead of a machine-dependent duration.
 */
describe('hnswlib tombstones and snapshots', () => {
  const dim = 64
  /** Snapshot files in a directory — the store keeps at most ONE per row set (fingerprint in the name). */
  const snapshots = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.hnsw'))

  function rng(seed: number): () => number {
    return () => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  function corpus(n: number, next: () => number): { id: number; vec: Float32Array }[] {
    return Array.from({ length: n }, (_, i) => {
      const vec = new Float32Array(dim)
      let norm = 0
      for (let d = 0; d < dim; d++) {
        vec[d] = next() * 2 - 1
        norm += vec[d] * vec[d]
      }
      norm = Math.sqrt(norm) || 1
      for (let d = 0; d < dim; d++) vec[d] /= norm
      return { id: i + 1, vec }
    })
  }

  it('evicts by TOMBSTONE, not by rebuilding the graph', () => {
    const rows = corpus(2000, rng(21))
    const store = new HnswlibVectorStore(dim)
    if (!store.native) return
    store.rebuild(rows)
    const afterBuild = store.stats()
    expect(afterBuild.rebuilds).toBe(1)

    store.removeMany([1, 2, 3])
    const afterEvict = store.stats()
    expect(afterEvict.tombstones).toBe(3)
    expect(afterEvict.rebuilds).toBe(afterBuild.rebuilds) // no rebuild
    expect(afterEvict.live).toBe(1997)
    expect(store.count()).toBe(1997)

    // the evicted ids are gone from the results, the rest still rank
    const hits = store.topk(rows[900]!.vec, 10)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.id <= 3)).toBe(false)
    expect(hits[0]!.id).toBe(rows[900]!.id)
  })

  it('compacts once tombstones are worth a full pass', () => {
    const rows = corpus(2000, rng(23))
    const store = new HnswlibVectorStore(dim)
    if (!store.native) return
    store.rebuild(rows)
    const rebuilds = store.stats().rebuilds

    // floor is max(COMPACT_MIN=256, 20% of live) → 500 of 2000 crosses it
    store.removeMany(rows.slice(0, 500).map((r) => r.id))
    const s = store.stats()
    expect(s.tombstones).toBe(0) // compaction dropped them
    expect(s.rebuilds).toBe(rebuilds + 1)
    expect(s.live).toBe(1500)
    // …and the compacted graph still ranks the survivors
    expect(store.topk(rows[900]!.vec, 5)[0]!.id).toBe(rows[900]!.id)
  })

  it('re-adding a tombstoned id makes it searchable again', () => {
    const rows = corpus(300, rng(29))
    const store = new HnswlibVectorStore(dim)
    if (!store.native) return
    store.rebuild(rows)
    store.removeMany([7])
    expect(store.topk(rows[6]!.vec, 5).some((h) => h.id === 7)).toBe(false)

    store.add(7, rows[6]!.vec)
    expect(store.stats().tombstones).toBe(0) // the tombstone was cleared
    expect(store.topk(rows[6]!.vec, 3)[0]!.id).toBe(7)
  })

  it('ignores a removal of an id it does not have', () => {
    const store = new HnswlibVectorStore(dim)
    if (!store.native) return
    store.rebuild(corpus(50, rng(31)))
    expect(() => store.removeMany([9999])).not.toThrow()
    expect(store.count()).toBe(50)
  })

  it('restores from a snapshot when the rows are provably the same', () => {
    const rows = corpus(500, rng(37))
    const dir = mkdtempSync(join(tmpdir(), 'avantf-hnsw-'))
    const path = join(dir, 'index.hnsw')

    const first = new HnswlibVectorStore(dim)
    if (!first.native) return
    first.attachPersistence(path)
    first.rebuild(rows)
    expect(snapshots(dir)).toHaveLength(1) // one file, named by the fingerprint
    expect(first.stats().restores).toBe(0) // it BUILT, then wrote

    const second = new HnswlibVectorStore(dim)
    second.attachPersistence(path)
    second.rebuild(rows)
    expect(second.stats().restores).toBe(1) // it LOADED
    expect(second.count()).toBe(rows.length)
    // the beam must be re-applied after a load: the loaded graph starts at hnswlib's default ef
    const hits = second.topk(rows[100]!.vec, 10)
    expect(hits[0]!.id).toBe(rows[100]!.id)
  })

  it('cannot even FIND a snapshot whose ID SET differs at the same count', () => {
    // A session that evicted 200 facts and added 200 others keeps the count but not the ids. The
    // snapshot for the old row set still exists under ITS fingerprint; the new row set looks for a
    // different file name, so there is no validity check left to get wrong.
    const rows = corpus(200, rng(41))
    const path = join(mkdtempSync(join(tmpdir(), 'avantf-hnsw-')), 'index.hnsw')
    const first = new HnswlibVectorStore(dim)
    if (!first.native) return
    first.attachPersistence(path)
    first.rebuild(rows)

    const shifted = rows.map((r) => ({ id: r.id + 1000, vec: r.vec }))
    const second = new HnswlibVectorStore(dim)
    second.attachPersistence(path)
    second.rebuild(shifted)
    expect(second.stats().restores).toBe(0)
    expect(second.stats().rebuilds).toBe(1)
    expect(second.topk(shifted[50]!.vec, 5)[0]!.id).toBe(shifted[50]!.id)
  })

  it('refuses a snapshot when the same ids were RE-ENCODED (kb reindex shape)', () => {
    // Same chunk ids, new text ⇒ new vectors. An ids-only fingerprint passes here and would serve
    // a graph describing text that no longer exists, so the fingerprint samples the vectors.
    const before = corpus(150, rng(47))
    const path = join(mkdtempSync(join(tmpdir(), 'avantf-hnsw-')), 'index.hnsw')
    const first = new HnswlibVectorStore(dim)
    if (!first.native) return
    first.attachPersistence(path)
    first.rebuild(before)

    // same ids 1..150, different vectors (a fresh draw from another stream)
    const reencoded = corpus(150, rng(53))
    const second = new HnswlibVectorStore(dim)
    second.attachPersistence(path)
    second.rebuild(reencoded)
    expect(second.stats().restores).toBe(0) // stale content detected
    expect(second.stats().rebuilds).toBe(1)
    expect(second.topk(reencoded[10]!.vec, 5)[0]!.id).toBe(reencoded[10]!.id)
  })
})

/**
 * The graph OUTLIVES the process, so "how many tombstones do I have" cannot be a per-session
 * counter. Measured before this fix: four sessions of 100 evictions left 400 dead points in the
 * graph while the counter read 100 each time, and nothing ever compacted.
 */
describe('hnswlib persistent tombstones', () => {
  const dim = 64
  function corpus(n: number, seed: number): { id: number; vec: Float32Array }[] {
    const next = (() => {
      return () => {
        seed |= 0
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    })()
    return Array.from({ length: n }, (_, i) => {
      const vec = new Float32Array(dim)
      let norm = 0
      for (let d = 0; d < dim; d++) {
        vec[d] = next() * 2 - 1
        norm += vec[d] * vec[d]
      }
      norm = Math.sqrt(norm) || 1
      for (let d = 0; d < dim; d++) vec[d] /= norm
      return { id: i + 1, vec }
    })
  }
  const snapshots = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.hnsw'))

  it('counts the dead points EARLIER sessions left, and compacts when the total crosses the floor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-hnsw-sessions-'))
    const path = join(dir, 'index.hnsw')
    const all = corpus(1200, 91)
    const alive = new Set(all.map((r) => r.id))
    const seen: { live: number; dead: number; graph: number }[] = []
    let compactions = 0

    for (let session = 0; session < 4; session++) {
      const store = new HnswlibVectorStore(dim)
      if (!store.native) return
      store.attachPersistence(path)
      store.rebuild(all.filter((r) => alive.has(r.id)))
      const doomed = [...alive].slice(0, 100)
      store.removeMany(doomed)
      for (const id of doomed) alive.delete(id)
      const s = store.stats()
      // The reported count matches the graph's own element count in EVERY session — including the
      // ones that restored a graph full of another session's tombstones.
      expect(s.tombstones, `session ${session}`).toBe(s.graphElements - s.live)
      expect(s.graphElements).toBeGreaterThanOrEqual(s.live)
      seen.push({ live: s.live, dead: s.tombstones, graph: s.graphElements })
      compactions += s.rebuilds
      store.flush()
    }
    // Across the four sessions the graph must have been reclaimed at least once (the total dead
    // crosses max(256, 20% of live)), and it must never have run away from the live count.
    expect(compactions).toBeGreaterThan(1)
    expect(seen[seen.length - 1]!.graph - seen[seen.length - 1]!.live).toBeLessThan(300)
  })

  it('re-adding a tombstoned id does NOT inflate the dead count', () => {
    // The live map cannot answer "was this label already in the graph": a re-added tombstone is
    // absent from `vectors` but present in the graph (and gets un-deleted in place). The count
    // therefore comes from the graph's own element delta.
    const rows = corpus(300, 93)
    const store = new HnswlibVectorStore(dim)
    if (!store.native) return
    store.rebuild(rows)
    store.removeMany([7])
    expect(store.stats().tombstones).toBe(1)
    store.add(7, rows[6]!.vec)
    expect(store.stats().tombstones).toBe(0)
  })

  it('deletes snapshots of other row sets (they can never be loaded again)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-hnsw-cleanup-'))
    const path = join(dir, 'index.hnsw')
    const store = new HnswlibVectorStore(dim)
    if (!store.native) return
    store.attachPersistence(path)
    store.rebuild(corpus(200, 97))
    expect(snapshots(dir)).toHaveLength(1)
    store.rebuild(corpus(200, 101)) // a different row set ⇒ a different fingerprint ⇒ a new name
    expect(snapshots(dir)).toHaveLength(1)
  })
})

/**
 * Recovery from a PATHOLOGICAL native binding.
 *
 * These paths cannot be reached with a healthy `hnswlib-node`, and CI has no binding at all (every
 * native case above returns early on `!store.native`), so a fake index is installed over a populated
 * store: `lib` is private, and the seam is the only way to pin what happens when the native side
 * throws. What is pinned is the difference between "degraded" and "silently empty" — the fallback
 * used to be handed back unpopulated, so one native failure emptied every later query while
 * `stats().native` still reported a healthy index.
 */
describe('hnswlib recovery from a broken native binding', () => {
  /** Replace the native index with one whose search and tombstone calls always throw. */
  function installBrokenNative(store: HnswlibVectorStore): void {
    const fake = {
      initIndex(): void {},
      addPoint(): void {},
      getCurrentCount: (): number => 0,
      getMaxElements: (): number => 1024,
      resizeIndex(): void {},
      setEf(): void {},
      getEf: (): number => 256,
      searchKnn(): { neighbors: number[]; distances: number[] } {
        throw new Error('native searchKnn exploded')
      },
      markDelete(): void {
        throw new Error('native markDelete exploded')
      },
      writeIndexSync(): void {},
      readIndexSync(): void {},
      getIdsList: (): number[] => [],
    }
    ;(store as unknown as { lib: unknown }).lib = fake
  }

  /** Route the retrieval-core logger into an array for the duration of one case. */
  function captureWarnings(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    setRetrievalLogger({ info(): void {}, warn(message: string): void { lines.push(message) }, error(): void {} })
    return { lines, restore: (): void => setRetrievalLogger(undefined) }
  }

  it('answers from a COMPLETE brute-force copy when the native search throws', () => {
    const store = new HnswlibVectorStore(8)
    store.add(1, vec(1))
    store.add(2, vec(2))
    store.add(3, vec(3))
    installBrokenNative(store)
    const captured = captureWarnings()
    try {
      const hits = store.topk(vec(1), 3)
      // Every vector is still reachable, and the query's own twin still ranks first.
      expect(hits.map(hit => hit.id).sort((a, b) => a - b)).toEqual([1, 2, 3])
      expect(hits[0].id).toBe(1)
      // The degradation is REPORTED, not merely survived.
      expect(store.native).toBe(false)
      expect(captured.lines.join()).toContain('暴力回退')
    } finally {
      captured.restore()
    }
  })

  it('keeps answering after the fallback was taken, and does not re-throw', () => {
    const store = new HnswlibVectorStore(8)
    store.add(1, vec(1))
    store.add(2, vec(2))
    installBrokenNative(store)
    const captured = captureWarnings()
    try {
      expect(store.topk(vec(1), 2)).toHaveLength(2)
      // `lib` is gone, so the second query takes the brute-force path directly: one warning, not one
      // per query, and the same complete answer.
      expect(store.topk(vec(2), 2)).toHaveLength(2)
      expect(captured.lines).toHaveLength(1)
    } finally {
      captured.restore()
    }
  })

  it('skips a wrong-dim query with a warning instead of an empty "no match"', () => {
    const store = new HnswlibVectorStore(8)
    store.add(1, vec(1))
    const captured = captureWarnings()
    try {
      expect(store.topk(new Float32Array(3), 1)).toEqual([])
      expect(captured.lines.join()).toContain('维度不匹配')
    } finally {
      captured.restore()
    }
  })

  it('removeMany does not drop the REST of the batch when one markDelete fails', () => {
    const store = new HnswlibVectorStore(8)
    store.add(1, vec(1))
    store.add(2, vec(2))
    store.add(3, vec(3))
    installBrokenNative(store)
    // An early return after the first failure used to leave ids 2 and 3 live in BOTH the map and the
    // graph: archived facts that still answered semantic queries, with the caller none the wiser.
    store.removeMany([1, 2, 3])
    expect(store.count()).toBe(0)
    expect(store.topk(vec(1), 3)).toEqual([])
  })
})
