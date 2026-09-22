import { describe, it, expect } from 'vitest'
import { AutoVectorStore } from '../src/adapters/auto_vstore.js'
import { HnswlibVectorStore } from '../src/adapters/hnswlib.js'

function vec(seed: number, dim = 8): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed + i)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  for (let i = 0; i < dim; i++) v[i] /= norm
  return v
}

const nativeAvailable = new HnswlibVectorStore(8).native

/**
 * The migration is LAZY: crossing the threshold records that an upgrade is owed, and the native
 * build happens on the first `topk` (or an explicit `prepare()`).
 *
 * Why: building it eagerly — in `rebuild()` (the startup path) or in `add()` (the write path) —
 * made every process start pay a full ANN build (measured 0.75 s at 2000 vectors, 6.3 s at 8000,
 * 14.7 s at 16000) even for a command that never searches. The two tests below therefore assert
 * the DEFERRAL as hard as they assert the eventual upgrade: a regression to eager building would
 * otherwise be invisible here and only show up as a slow `avantf-mem list`.
 */
describe('AutoVectorStore', () => {
  it('starts on brute-force numpy below the threshold', () => {
    const vs = new AutoVectorStore(8, 100)
    vs.add(1, vec(1))
    expect(vs.name).toBe('auto:local_numpy')
    expect(vs.count()).toBe(1)
  })

  it('defers the migration until a search actually needs the index', () => {
    const vs = new AutoVectorStore(8, 4)
    for (let i = 1; i <= 3; i++) vs.add(i, vec(i))
    expect(vs.name).toBe('auto:local_numpy')
    vs.add(4, vec(4))
    // Crossing the threshold does NOT build: the write path must not pay for it.
    expect(vs.name).toBe('auto:local_numpy')

    const hits = vs.topk(vec(2), 4)
    expect(hits[0].id).toBe(2) // exact match ranks first, whichever backend answered
    // …and the search itself is what triggered the migration.
    expect(vs.name).toBe(nativeAvailable ? 'auto:hnswlib' : 'auto:local_numpy')
    // All vectors survive the migration either way.
    expect(vs.count()).toBe(4)
    expect(vs.fetch([1, 2, 3, 4]).size).toBe(4)
  })

  it('defers on rebuild() too, and builds on prepare()', () => {
    const vs = new AutoVectorStore(8, 2)
    vs.rebuild([1, 2, 3].map((i) => ({ id: i, vec: vec(i) })))
    expect(vs.count()).toBe(3)
    // `rebuild` is the startup path: it must not build the ANN index.
    expect(vs.name).toBe('auto:local_numpy')
    vs.prepare()
    expect(vs.name).toBe(nativeAvailable ? 'auto:hnswlib' : 'auto:local_numpy')
  })

  it('stays on brute force below the threshold, even after prepare() and a search', () => {
    const vs = new AutoVectorStore(8, 100)
    vs.rebuild([1, 2, 3].map((i) => ({ id: i, vec: vec(i) })))
    vs.prepare()
    expect(vs.name).toBe('auto:local_numpy')
    expect(vs.topk(vec(1), 3).length).toBe(3)
    expect(vs.name).toBe('auto:local_numpy')
  })

  it('never returns a removed vector', () => {
    const vs = new AutoVectorStore(8, 100)
    vs.add(1, vec(1))
    vs.add(2, vec(2))
    vs.remove(1)
    expect(vs.count()).toBe(1)
    expect(vs.fetch([1]).size).toBe(0)
    expect(vs.topk(vec(1), 5).map((h) => h.id)).not.toContain(1)
  })
})
