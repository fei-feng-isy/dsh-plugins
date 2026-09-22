import type { VectorStore } from '../interfaces.js'
import { LocalNumpyVectorStore } from './local_numpy.js'
import { HnswlibVectorStore } from './hnswlib.js'
import { retrievalLogger } from '../log.js'

/**
 * `auto` — monotonic vector-store upgrade: start on brute-force `local_numpy`,
 * and once the live vector count crosses `auto_thresholds.hnswlib`, migrate to
 * a real `hnswlib` ANN index (only when the native binding actually loads).
 * Never downgrades within a process; if hnswlib is unavailable, stays on numpy.
 *
 * The migration is **lazy**: `rebuild()` (the startup path) only records that an upgrade is due,
 * and the native build happens on the first `topk` that needs it — or on an explicit
 * `prepare()`. Building it in `rebuild()` made every process start pay a full ANN build
 * (measured: 0.75 s at 2000 vectors, 6.3 s at 8000, 14.7 s at 16000) even for a command that
 * never runs a vector search, which is why `avantf-mem list` took seconds.
 */
export class AutoVectorStore implements VectorStore {
  readonly dim: number
  private delegate: VectorStore
  private readonly threshold: number
  private readonly efSearch: number | undefined
  private upgradeAttempted = false
  /** An upgrade is owed but has not been built yet (see the class comment). */
  private upgradeDue = false
  private pendingPersistence: string | null = null

  constructor(dim: number, threshold = 2000, efSearch?: number) {
    this.dim = dim
    this.threshold = threshold
    this.efSearch = efSearch
    this.delegate = new LocalNumpyVectorStore(dim)
  }

  /** Name of the backend currently serving reads/writes. */
  get name(): string {
    return this.delegate.name === 'local_numpy' ? 'auto:local_numpy' : 'auto:hnswlib'
  }

  add(id: number, vec: Float32Array): void {
    this.delegate.add(id, vec)
    this.noteCount()
  }

  topk(vec: Float32Array, k: number): { id: number; score: number }[] {
    // The one place the deferred migration actually happens: a caller that searches needs the
    // index, a caller that only lists does not.
    this.prepare()
    return this.delegate.topk(vec, k)
  }

  fetch(ids: number[]): Map<number, Float32Array> {
    return this.delegate.fetch(ids)
  }

  remove(id: number): void {
    this.delegate.remove(id)
  }

  removeMany(ids: number[]): void {
    if (this.delegate.removeMany) this.delegate.removeMany(ids)
    else for (const id of ids) this.delegate.remove(id)
  }

  count(): number {
    return this.delegate.count()
  }

  rebuild(rows: Iterable<{ id: number; vec: Float32Array }>): void {
    this.delegate.rebuild(rows)
    this.noteCount()
  }

  /** Build the ANN index now if one is owed (see the class comment). */
  prepare(): void {
    if (!this.upgradeDue) return
    this.upgradeDue = false
    this.maybeUpgrade()
  }

  attachPersistence(path: string): void {
    this.pendingPersistence = path
    this.delegate.attachPersistence?.(path)
  }

  flush(): void {
    this.delegate.flush?.()
  }

  /** Reclaim dead entries in the migrated backend (the numpy fallback has none). */
  compact(): void {
    this.delegate.compact?.()
  }

  private noteCount(): void {
    if (this.upgradeAttempted || this.delegate.name !== 'local_numpy') return
    if (this.delegate.count() < this.threshold) return
    // Owed, not built: the next `topk`/`prepare()` pays it. `add` used to build here, which put
    // a full ANN build inside a write path the moment the corpus crossed the threshold.
    this.upgradeDue = true
  }

  private maybeUpgrade(): void {
    if (this.upgradeAttempted || this.delegate.name !== 'local_numpy') return
    if (this.delegate.count() < this.threshold) return
    this.upgradeAttempted = true
    const numpy = this.delegate as LocalNumpyVectorStore
    const hnsw = new HnswlibVectorStore(this.dim, this.efSearch)
    if (!hnsw.native) {
      retrievalLogger().warn(`vector-store auto: hnswlib native binding unavailable — staying on local_numpy (count=${numpy.count()})`)
      return
    }
    if (this.pendingPersistence !== null) hnsw.attachPersistence(this.pendingPersistence)
    hnsw.rebuild([...numpy.entries()].map(([id, vec]) => ({ id, vec })))
    this.delegate = hnsw
    retrievalLogger().info(`vector-store auto: upgraded local_numpy → hnswlib at count=${hnsw.count()} (threshold=${this.threshold})`)
  }
}
