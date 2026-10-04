import { createRequire } from 'node:module'
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { VectorStore } from '../interfaces.js'
import { retrievalLogger } from '../log.js'
import { LocalNumpyVectorStore } from './local_numpy.js'

const require = createRequire(import.meta.url)

interface Hnsw {
  initIndex(max: number, m: number, ef: number): void
  addPoint(v: number[], id: number, update: boolean): void
  searchKnn(v: number[], k: number): { neighbors: number[]; distances: number[] }
  getCurrentCount(): number
  getMaxElements(): number
  resizeIndex(n: number): void
  /** Search-time beam width. The recall/speed knob — see {@link EF_FLOOR}. */
  setEf(ef: number): void
  getEf(): number
  /** Tombstone one label: excluded from `searchKnn` without rebuilding the graph. */
  markDelete(id: number): void
  /** Persist/restore the native graph (sync variants: this port is synchronous). */
  writeIndexSync(path: string): void
  readIndexSync(path: string, allowReplaceDeleted: boolean): void
  /** Every label the graph holds, INCLUDING tombstoned ones (that is how dead points are counted). */
  getIdsList(): number[]
}

/**
 * Search-time beam width, when the config does not say otherwise.
 *
 * hnswlib's own narrow default beam is a QUALITY CLIFF rather than a neutral choice. Measured with
 * the raw binding at the shipped width (2000 random unit vectors, dim 768, true top-10 as ground
 * truth):
 *
 *     ef   10     64     128    256    400
 *     R@10 0.29   0.79   0.94   0.99   1.00
 *     ms   0.20   0.43   0.56   0.72   0.82
 *
 * (At dim 512 the same measurement was R@10 0.36 / 0.81 / 0.93 / 1.00 / 1.00 at 0.13 / 0.27 / 0.39 /
 * 0.51 / 0.57 ms; the row of 0.45 … 1.00 this comment used to carry was an earlier run.) Recall
 * falls as the corpus grows (at n=8000 / dim 768, R@10 was 0.86 at `ef = 256` and 0.91 at
 * `ef = 400`), and random vectors are the WORST case — real embeddings cluster, so production
 * recall is higher than these numbers. 256 keeps the small/medium corpora near-exact without
 * giving up the speedup; the knob is `vectorStore.hnswlib_ef_search`.
 */
export const DEFAULT_EF_SEARCH = 256

/**
 * When to COMPACT tombstones away, as a fraction of the live count.
 *
 * Deleted points stay in the graph (excluded from results, but still traversed), so they cost
 * search time and file size. Compaction is a full rebuild, so it must not run per eviction —
 * that is the defect this replaced. 20% keeps the wasted traversal bounded while making a
 * rebuild happen at most once per fifth of the corpus in evictions.
 */
const COMPACT_RATIO = 0.2
/** …and never compact for a handful of tombstones, however small the corpus is. */
const COMPACT_MIN = 256

/**
 * `hnswlib` — real ANN backend via `hnswlib-node` (cosine space, HierarchicalNSW).
 * Uses the stable v2 string-space + initIndex + Array API. Wraps every native call
 * in a try/catch and falls back to the in-memory brute-force store so the plugin
 * never crashes on a pathological native binding — and a fallback that is TAKEN is
 * always logged, because "never crashes" must not become "silently returns nothing".
 */
export class HnswlibVectorStore implements VectorStore {
  readonly name = 'hnswlib'
  readonly dim: number
  private lib: Hnsw | null = null
  private fallback: LocalNumpyVectorStore
  private readonly vectors = new Map<number, Float32Array>()
  /**
   * The beam width in effect, and the index it was applied to: `ef` is in force on `efOn`.
   *
   * The index is part of the key, not just the number. `reindex()` and `rebuild()` REPLACE the
   * native index, and a replacement starts at hnswlib's own default `ef` (10), so a bare number
   * would compare equal and skip the re-apply — silently dropping ANN recall to ~0.44 of the
   * true top-k after any batch eviction, which is the cliff this whole knob exists to avoid.
   */
  private efOn: Hnsw | null = null
  private ef = 0

  private readonly efSearch: number

  /**
   * Elements in the native graph, INCLUDING the ones `markDelete` has tombstoned.
   *
   * The live set is `vectors` (authoritative for `count`/`fetch`), so the number of dead points is
   * `graphElements - vectors.size` — a derived quantity rather than a set of ids, because the graph
   * OUTLIVES the process: a snapshot restored from disk already contains every dead point earlier
   * sessions created, and a per-session `Set` could not see them (measured across 4 sessions of
   * 100 evictions: live 1200→800 while the graph stayed at 1200, with the counter reading 100).
   *
   * Bookkeeping: a snapshot restore reads `getIdsList().length`; a build from rows sets it to the
   * row count; `add` increments it only when the id was NOT already in the graph (an update in
   * place, which also un-deletes a tombstone, does not grow the graph).
   */
  private graphElements = 0
  /** Snapshot path PREFIX (set by the owning store via {@link attachPersistence}); see `snapshotPath`. */
  private cachePath: string | null = null
  /** Something changed since the snapshot was written. */
  private dirty = false
  private restores = 0
  private rebuilds = 0

  constructor(dim: number, efSearch = DEFAULT_EF_SEARCH) {
    this.dim = dim
    this.efSearch = Math.max(16, Math.floor(efSearch))
    this.fallback = new LocalNumpyVectorStore(dim)
    try {
      const { HierarchicalNSW } = require('hnswlib-node') as { HierarchicalNSW: new (space: string, dim: number) => Hnsw }
      const lib = new HierarchicalNSW('cosine', dim)
      lib.initIndex(Math.max(1024, dim * 2), 16, 100)
      this.lib = lib
    } catch {
      this.lib = null
    }
  }

  add(id: number, vec: Float32Array): void {
    // Fail fast on a bad dim instead of letting the native call throw and tear down
    // the live index (the catch below nulls `lib` and rebuilds the fallback, which
    // would then throw again on the same vector).
    if (vec.length !== this.dim) throw new Error(`向量维度不匹配：得到 ${vec.length}，需要 ${this.dim}`)
    if (this.lib) {
      try {
        if (this.lib.getCurrentCount() >= this.lib.getMaxElements()) this.lib.resizeIndex(this.lib.getMaxElements() * 2)
        // Ask the GRAPH whether this was a new element: hnswlib adds a label the first time and
        // updates it in place afterwards (an update also un-deletes a tombstone — verified against
        // the binding), and `getCurrentCount()` moves only in the first case. The live map cannot
        // answer this: a re-added tombstone is absent from `vectors` but already in the graph.
        const before = this.lib.getCurrentCount()
        this.lib.addPoint(Array.from(vec), id, false)
        if (this.lib.getCurrentCount() > before) this.graphElements += 1
        this.vectors.set(id, vec)
        this.dirty = true
        return
      } catch {
        this.lib = null
        // The native index is gone; the fallback must receive EVERY vector
        // tracked so far, not just adds from this point on, or topk silently
        // loses the older half of the corpus.
        this.rebuildFallback()
      }
    }
    this.fallback.add(id, vec)
    this.vectors.set(id, vec)
    this.dirty = true
  }

  /** Whether the real hnswlib native index is active (false = brute-force fallback). */
  get native(): boolean {
    return this.lib !== null
  }

  /**
   * Counters a caller (test, benchmark, diagnostics) can assert on without guessing from timing:
   * `restores` = snapshots loaded, `rebuilds` = full native builds, `tombstones` = pending deletes.
   */
  stats(): { live: number; tombstones: number; graphElements: number; restores: number; rebuilds: number; native: boolean } {
    return {
      live: this.vectors.size,
      // Dead points in the graph, whether this session or an earlier one created them.
      tombstones: Math.max(0, this.graphElements - this.vectors.size),
      graphElements: this.graphElements,
      restores: this.restores,
      rebuilds: this.rebuilds,
      native: this.native,
    }
  }

/** Point the native index at an on-disk snapshot (see {@link VectorStore.attachPersistence}). */
  attachPersistence(path: string): void {
    this.cachePath = path
  }

  /**
   * The snapshot file for a row set: `prefix.<fingerprint>.hnsw`.
   *
   * Putting the fingerprint in the NAME is what makes the commit atomic. The previous shape wrote
   * two files (index, then a JSON sidecar with the fingerprint) and validated the sidecar against
   * the CURRENT rows — so an interleaved pair `(index_B, meta_A)` could describe two different
   * corpora and still pass the check (the metadata was never bound to the graph it accompanied).
   * With one file there is nothing to desynchronize: a snapshot either exists under the name of the
   * row set it was built from, or it does not exist at all.
   */
  private snapshotPath(fingerprint: string): string | null {
    return this.cachePath === null ? null : `${this.cachePath}.${fingerprint}.hnsw`
  }

  /**
   * Widen the search beam, skipping the native call only when this exact width is already in
   * force on THIS index (see {@link efOn}).
   */
  private setEf(ef: number): void {
    if (this.lib === null || (ef === this.ef && this.efOn === this.lib)) return
    try {
      this.lib.setEf(ef)
      this.ef = ef
      this.efOn = this.lib
    } catch {
      // An older binding without `setEf` keeps hnswlib's own default; search still works. Record
      // the attempt so the failing call is not repeated on every query of this index.
      this.ef = ef
      this.efOn = this.lib
    }
  }

  private rebuildFallback(): void {
    this.fallback = new LocalNumpyVectorStore(this.dim)
    for (const [i, v] of this.vectors) this.fallback.add(i, v)
  }

  topk(vec: Float32Array, k: number): { id: number; score: number }[] {
    // A wrong-width query would make the native call throw; the brute-force path cannot answer it
    // either. Say so instead of returning a bare [] — an empty result otherwise reads as "nothing
    // matched", which is a different claim from "this query could not be run".
    if (vec.length !== this.dim) {
      retrievalLogger().warn(
        `hnswlib: 查询向量维度不匹配（得到 ${String(vec.length)}，需要 ${String(this.dim)}）——跳过本次语义检索`,
      )
      return []
    }
    if (this.lib && this.vectors.size > 0) {
      try {
        // `ef` must be at least `k`, and a wider beam is what buys recall back.
        this.setEf(Math.max(this.efSearch, k * 8))
        const { neighbors, distances } = this.lib.searchKnn(Array.from(vec), Math.min(Math.max(1, k), this.vectors.size))
        const out: { id: number; score: number }[] = []
        for (let i = 0; i < neighbors.length; i++) out.push({ id: neighbors[i], score: Math.max(0, 1 - distances[i]) })
        return out
      } catch (error) {
        // The native index is not trustworthy from here on, so drop it and answer from a brute-force
        // copy of EVERY tracked vector — the same recovery `add()` performs. Handing back
        // `this.fallback` as it stands would answer `[]`: the fallback only holds vectors while the
        // native side is ALREADY down (a healthy graph keeps it empty, and a snapshot restore leaves
        // it empty on purpose), so the failure would be invisible — `stats().native` still true, the
        // health counters clean, and every subsequent query silently empty.
        this.lib = null
        this.efOn = null
        this.rebuildFallback()
        retrievalLogger().warn(
          `hnswlib: 原生检索失败（${error instanceof Error ? error.message : String(error)}）`
          + '——已弃用原生索引并切换到暴力回退，本次与后续结果仍然完整',
        )
        return this.fallback.topk(vec, k)
      }
    }
    return this.fallback.topk(vec, k)
  }

  fetch(ids: number[]): Map<number, Float32Array> {
    const out = new Map<number, Float32Array>()
    for (const id of ids) {
      const v = this.vectors.get(id)
      if (v) out.set(id, v)
    }
    return out
  }

  remove(id: number): void {
    this.removeMany([id])
  }

  /**
   * Batch removal via TOMBSTONES — O(k), not O(N).
   *
   * `markDelete` excludes a label from `searchKnn` without touching the graph (measured: 1000
   * tombstones = 0.19 ms on an 8000-vector index, against 1.3 s for the rebuild this used to
   * do). Deleted points are still traversed and still occupy space, so {@link maybeCompact}
   * rebuilds once tombstones become a meaningful fraction of the corpus.
   */
  removeMany(ids: number[]): void {
    if (!ids.length) return
    let unmarked = false
    for (const id of ids) {
      if (!this.vectors.delete(id)) continue
      this.dirty = true
      if (!this.lib) {
        this.fallback.remove(id)
        continue
      }
      try {
        this.lib.markDelete(id)
      } catch {
        // Already deleted, or unknown to the native side (e.g. it was added while the native index
        // was down). The live map — the authority for count/fetch — is updated either way, so the
        // only risk is a stale point in the graph. KEEP GOING: returning early here left the rest of
        // the batch live in both the map and the graph, i.e. archived facts that still answered
        // semantic queries, with nothing telling the caller the index had diverged from the DB.
        unmarked = true
      }
    }
    // One rebuild for the whole batch when a tombstone could not be trusted (it re-adds from
    // `vectors`, so the stale point is gone); otherwise compact only once it is worth a full pass.
    if (unmarked) this.reindex()
    else this.maybeCompact()
  }

  /**
   * Rebuild once the dead points are worth a full pass (see {@link COMPACT_RATIO}).
   *
   * The count is DERIVED from the graph, so it includes what earlier sessions left behind: that is
   * what makes accumulation across CLI invocations self-correcting instead of monotonic.
   */
  private maybeCompact(): void {
    if (this.lib === null) return
    const dead = this.graphElements - this.vectors.size
    const floor = Math.max(COMPACT_MIN, Math.floor(this.vectors.size * COMPACT_RATIO))
    if (dead >= floor) this.compact()
  }

  /**
   * Recreate the serving index (native when possible) from the tracked vectors.
   *
   * Public because it is the "compact now" operation: it drops every tombstone and leaves a
   * clean graph. Called by `maybeCompact()` and by `rebuild()`'s failure paths.
   */
  compact(): void {
    this.reindex()
  }

  /** Recreate the serving index (native when possible) from the tracked vectors. */
  private reindex(): void {
    const stored = [...this.vectors.entries()]
    if (this.lib) {
      try {
        const { HierarchicalNSW } = require('hnswlib-node') as { HierarchicalNSW: new (space: string, dim: number) => Hnsw }
        const lib = new HierarchicalNSW('cosine', this.dim)
        lib.initIndex(Math.max(1024, (stored.length || 1) * 2), 16, 100)
        this.lib = lib
        // Drop the reference to the replaced index: the instance key in `setEf` already forces a
        // re-apply, and this also stops `efOn` from pinning the old native structure alive.
        this.efOn = null
        for (const [i, v] of stored) this.lib.addPoint(Array.from(v), i, false)
        this.graphElements = stored.length
        this.rebuilds += 1
        this.persist()
        return
      } catch {
        this.lib = null
      }
    }
    this.fallback = new LocalNumpyVectorStore(this.dim)
    for (const [i, v] of stored) this.fallback.add(i, v)
    this.graphElements = stored.length
  }

  count(): number {
    return this.vectors.size
  }

  /**
   * Build from the store's rows, reusing the on-disk snapshot when it provably describes them.
   *
   * The snapshot check is a FINGERPRINT over the live ids plus the count, not just a count: a
   * session that evicted three facts and added three others has the same count with different
   * contents, and loading that would silently serve vectors that no longer exist. The path
   * carries the vector space (see `attachPersistence`), so a model/dim swap cannot load at all.
   */
  rebuild(rows: Iterable<{ id: number; vec: Float32Array }>): void {
    const list = [...rows]
    this.vectors.clear()
    this.fallback = new LocalNumpyVectorStore(this.dim)
    this.graphElements = 0
    this.dirty = true
    if (this.restore(list)) {
      for (const r of list) this.vectors.set(r.id, r.vec)
      return
    }
    if (this.lib) {
      try {
        const { HierarchicalNSW } = require('hnswlib-node') as { HierarchicalNSW: new (space: string, dim: number) => Hnsw }
        const lib = new HierarchicalNSW('cosine', this.dim)
        lib.initIndex(Math.max(1024, (list.length || 1) * 2), 16, 100)
        this.lib = lib
        // Same as `reindex()`: unpin the replaced index (see `efOn`).
        this.efOn = null
      } catch {
        this.lib = null
      }
    }
    for (const r of list) this.add(r.id, r.vec)
    // `add` marked the store dirty for each row; after a build from scratch the snapshot is
    // written once, not once per vector.
    this.rebuilds += 1
    this.persist()
  }

  /** Persist pending state (called on shutdown); a no-op without a cache path or change. */
  flush(): void {
    if (this.dirty) this.persist()
  }

  /**
   * Load the snapshot that describes EXACTLY these rows, if it exists.
   *
   * There is no validity check to get wrong: the file is named by the fingerprint of the row set
   * it was built from, so a snapshot for a different corpus is a different file (and simply will
   * not be found). That is the whole reason the fingerprint moved into the name.
   *
   * `allowReplaceDeleted` is deliberately FALSE: with it enabled, `addPoint` on a label that the
   * snapshot recorded as deleted throws ("Can't use addPoint to update deleted elements if
   * replacement of deleted elements is enabled"), which would break the very first re-add of an
   * archived-then-restored fact. Verified against the binding; deleted entries stay excluded from
   * `searchKnn` either way.
   */
  private restore(rows: readonly { id: number; vec: Float32Array }[]): boolean {
    if (this.lib === null || rows.length === 0) return false
    const path = this.snapshotPath(fingerprintOf(rows))
    if (path === null || !existsSync(path)) return false
    try {
      this.lib.readIndexSync(path, false)
      // The graph carries every dead point earlier sessions tombstoned; `getIdsList()` lists the
      // labels INCLUDING deleted ones (verified), so this is where the inherited count comes from.
      this.graphElements = this.lib.getIdsList().length
      // The loaded graph starts at hnswlib's own default `ef`, and `efOn` still names this very
      // object — without clearing it, `setEf` would judge the beam "already applied" and every
      // query after a restart would run at the recall cliff (0.44) this cache exists to avoid.
      this.efOn = null
      this.restores += 1
      this.dirty = false
      return true
    } catch {
      // A truncated file is not fatal: fall through and rebuild from the DB.
      return false
    }
  }

  /** Live rows, as `fingerprintOf` wants them. */
  private liveRows(): { id: number; vec: Float32Array }[] {
    return [...this.vectors.entries()].map(([id, vec]) => ({ id, vec }))
  }

  /**
   * Write the native graph, atomically: a temp file plus `rename`, so a reader (the other
   * process sharing this data home) sees either the old snapshot or the complete new one.
   * Best-effort by design — a failing cache must never fail a write that already hit the DB.
   */
  private persist(): void {
    if (this.cachePath === null || this.lib === null) return
    const path = this.snapshotPath(fingerprintOf(this.liveRows()))
    if (path === null) return
    const tmp = `${path}.${process.pid}.tmp`
    try {
      this.lib.writeIndexSync(tmp)
      // ONE rename is the whole commit: readers see either the previous snapshot (a different
      // name, still valid for its own corpus) or this complete file.
      renameSync(tmp, path)
      this.dirty = false
      this.dropStaleSnapshots(path)
    } catch {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // nothing else to do: the snapshot is optional
      }
    }
  }

  /**
   * Delete snapshots for OTHER row sets of this store (best-effort).
   *
   * They can never be loaded again — the name IS the fingerprint — so keeping them only leaks disk.
   * A concurrent process may have just written one; unlinking an open file is safe on POSIX, and
   * the worst case is that the other process rebuilds next start.
   */
  private dropStaleSnapshots(keep: string): void {
    if (this.cachePath === null) return
    const prefix = `${this.cachePath}.`
    try {
      for (const entry of readdirSync(dirname(this.cachePath))) {
        const full = `${dirname(this.cachePath)}/${entry}`
        if (full === keep || !full.startsWith(prefix)) continue
        if (!entry.endsWith('.hnsw') && !entry.endsWith('.tmp')) continue
        rmSync(full, { force: true })
      }
    } catch {
      // best-effort
    }
  }
}

/**
 * Identity of a row set: the id set AND a sample of each vector's content, in ascending id order.
 *
 * The content half is not optional. Ids alone cannot see a re-encoded vector — a `kb reindex`
 * after an edit keeps every chunk id while replacing its text and vector — and loading that
 * snapshot would serve a graph whose vectors describe text that no longer exists. Sampling 8
 * coordinates per row (rather than all of them) keeps startup cheap: a real re-encode changes
 * essentially every coordinate, so a collision would require the vectors to agree on the sample
 * by construction.
 */
function fingerprintOf(rows: Iterable<{ id: number; vec: Float32Array }>): string {
  const sorted = [...rows].sort((a, b) => a.id - b.id)
  let h = 2166136261
  for (const r of sorted) {
    h ^= r.id
    h = Math.imul(h, 16777619)
    const v = r.vec
    const step = Math.max(1, Math.floor(v.length / 8))
    for (let i = 0; i < v.length; i += step) {
      h ^= Math.round(v[i] * 1e6) | 0
      h = Math.imul(h, 16777619)
    }
  }
  return `${sorted.length}:${(h >>> 0).toString(36)}`
}
