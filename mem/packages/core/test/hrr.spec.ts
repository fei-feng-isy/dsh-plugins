import { describe, it, expect } from 'vitest'
import { atom, atomBatch, isValidAtom, TWO_PI, AtomDimensionError } from '../src/hrr/atoms.js'
import { bind, bundle, phaseSimilarity, ShapeMismatchError } from '../src/hrr/algebra.js'
import { scaleByMax } from '@avantf/mem-retrieval'
import { encodeHrrEntityVector, hrrToBytes, hrrFromBytes } from '../src/hrr/encode.js'

describe('HRR atoms', () => {
  it('is deterministic for the same (name, dim)', () => {
    const a = atom('张伟', 1024)
    const b = atom('张伟', 1024)
    expect(a.length).toBe(1024)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('differs across names', () => {
    const a = atom('张伟', 256)
    const b = atom('李娜', 256)
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })

  it('produces valid phase vectors in [0, 2π)', () => {
    const v = atom('项目', 512)
    expect(isValidAtom(v)).toBe(true)
    for (let i = 0; i < v.length; i++) {
      expect(v[i]).toBeGreaterThanOrEqual(0)
      expect(v[i]).toBeLessThan(TWO_PI)
    }
  })

  it('rejects invalid dims', () => {
    expect(() => atom('x', 0)).toThrow(AtomDimensionError)
    expect(() => atom('x', 7)).toThrow(AtomDimensionError)
  })

  it('atomBatch matches per-atom calls', () => {
    const names = ['a', 'b', 'c']
    const batch = atomBatch(names, 64)
    expect(batch.length).toBe(3)
    batch.forEach((v, i) => expect(Array.from(v)).toEqual(Array.from(atom(names[i], 64))))
  })

  it('memoizes (name, dim) and evicts the oldest entry FIFO at the byte budget', () => {
    // The shared instance IS the contract, not just the value: `bundle()` only reads its inputs, so
    // a hit must hand back the same array instead of a copy.
    const hot = 'cache_hot'
    const first = atom(hot, 1024)
    expect(atom(hot, 1024)).toBe(first)

    // Budget is 16 MiB and one entry costs exactly dim * 8 = 8 KiB, so 2048 atoms fit and the 2049th
    // must push the oldest out. A missing or entry-counted bound keeps all 2049 resident (or clears
    // the whole map), and either way the identity assertion below changes.
    const names = Array.from({ length: 2049 }, (_, i) => `cache_fill_${i}`)
    const arrays = names.map((n) => atom(n, 1024))
    expect(atom(names[0]!, 1024)).not.toBe(arrays[0])
    // ...and the newest survives: eviction is incremental FIFO, not a full clear on overflow.
    expect(atom(names[2048]!, 1024)).toBe(arrays[2048])
  })
})

describe('HRR algebra', () => {
  it('bind composes phases mod 2π', () => {
    const a = atom('张伟', 64)
    const b = atom('李娜', 64)
    const c = bind(a, b)
    for (let i = 0; i < c.length; i++) {
      const expectVal = (a[i] + b[i]) % TWO_PI
      expect(Math.abs(c[i] - expectVal) < 1e-9).toBe(true)
    }
  })

  it('bind is commutative', () => {
    const a = atom('甲', 64)
    const b = atom('乙', 64)
    expect(Array.from(bind(a, b))).toEqual(Array.from(bind(b, a)))
  })

  it('bundle produces a valid phase vector', () => {
    const v = bundle(atom('a', 64), atom('b', 64), atom('c', 64))
    expect(isValidAtom(v)).toBe(true)
  })

  it('bundle requires at least one vector', () => {
    expect(() => bundle()).toThrow(Error)
  })

  it('phase similarity is high for identical vectors and low for nearly-orthogonal', () => {
    const a = atom('x', 256)
    expect(phaseSimilarity(a, a)).toBeCloseTo(1, 5)
    const b = bind(a, atom('noise', 256))
    expect(phaseSimilarity(a, b)).toBeLessThan(0.9)
  })

  it('rejects mismatched dims', () => {
    expect(() => bind(atom('a', 32), atom('b', 64))).toThrow(ShapeMismatchError)
  })
})

describe('HRR byte serialization', () => {
  it('round-trips an entity vector through a BLOB', () => {
    const vec = encodeHrrEntityVector(['测试实体', 'foo'])
    expect(Array.from(hrrFromBytes(hrrToBytes(vec))!)).toEqual(Array.from(vec))
  })

  it('reads a buffer whose byteOffset is NOT 8-byte aligned', () => {
    // The previous implementation built a Float64Array VIEW over the input buffer, which
    // requires an 8-byte-aligned `byteOffset`. Nothing promises that — a pooled Buffer
    // slice or a shifted Uint8Array throws a RangeError from inside retrieval. Read
    // through a DataView instead.
    const vec = encodeHrrEntityVector(['测试实体', 'foo'])
    const bytes = hrrToBytes(vec)
    const raw = new ArrayBuffer(bytes.byteLength + 3)
    new Uint8Array(raw).set(bytes, 3)
    const misaligned = new Uint8Array(raw, 3)
    expect(misaligned.byteOffset % 8).not.toBe(0)
    // what the old code did, and why it cannot be relied on:
    expect(() => new Float64Array(misaligned.buffer, misaligned.byteOffset, 8)).toThrow(RangeError)

    const back = hrrFromBytes(misaligned)
    expect(back).not.toBeNull()
    expect(Array.from(back!)).toEqual(Array.from(vec))
  })

  it('ignores a trailing partial element and rejects an empty buffer', () => {
    const vec = encodeHrrEntityVector(['测试实体'])
    const padded = Buffer.concat([hrrToBytes(vec), Buffer.from([1, 2, 3])])
    expect(hrrFromBytes(padded)!.length).toBe(vec.length)
    expect(hrrFromBytes(Buffer.alloc(0))).toBeNull()
    expect(hrrFromBytes(Buffer.from([1, 2, 3]))).toBeNull() // fewer than 8 bytes
  })
})

/**
 * A corrupt blob must be REFUSED, not scored.
 *
 * Every range check compares false against NaN, so a decoder that only checks the length hands the
 * scorer a NaN phase: `phaseSimilarity` returns NaN, the fused total for that candidate becomes NaN,
 * and the sort comparator returns NaN — which leaves the ORDER of the whole result undefined, not
 * just one score wrong.
 */
describe('HRR decode refuses corrupt bytes', () => {
  it('rejects a NaN phase', () => {
    const bytes = hrrToBytes(encodeHrrEntityVector(['测试实体']))
    bytes.writeDoubleLE(Number.NaN, 0)
    expect(hrrFromBytes(bytes)).toBeNull()
  })

  it('rejects a phase outside [0, 2π)', () => {
    const bytes = hrrToBytes(encodeHrrEntityVector(['测试实体']))
    bytes.writeDoubleLE(TWO_PI, 8)
    expect(hrrFromBytes(bytes)).toBeNull()
    const negative = hrrToBytes(encodeHrrEntityVector(['测试实体']))
    negative.writeDoubleLE(-0.5, 0)
    expect(hrrFromBytes(negative)).toBeNull()
  })

  it('rejects a NaN atom, which the range check alone would have accepted', () => {
    const nan = new Float64Array(4).fill(Number.NaN)
    expect(isValidAtom(nan)).toBe(false)
  })
})

/**
 * The HRR leg's contribution shape, PINNED.
 *
 * `phaseSimilarity` has a baseline of 0.5 for unrelated bundles and a very small spread at
 * dim=1024, so after fusion's `scaleByMax` the weakest unrelated candidate keeps ~0.9 of the
 * strongest one's contribution: within a set that shares nothing with the probe, the leg is close to
 * a constant boost rather than a ranking signal. That is a known, documented property (see
 * `phaseSimilarity`), NOT an accident — and correcting it (subtracting the baseline) would move
 * ranking with no existing gate to justify the movement, because the frozen eval set exercises
 * `recall.search` while this leg only runs for `recall.probe`. These numbers are here so that change
 * has to be made deliberately, with a probe-shaped differential beside it.
 */
describe('HRR similarity baseline (pinned)', () => {
  const dim = 1024

  function bundleOf(names: string[]): Float64Array {
    return encodeHrrEntityVector(names, dim)
  }

  it('scores a bundle against itself at 1.0', () => {
    const probe = bundleOf(['内存', '回收'])
    expect(phaseSimilarity(probe, probe)).toBeCloseTo(1, 12)
  })

  it('scores unrelated bundles at ~0.5 with a very small spread', () => {
    const probe = bundleOf(['内存', '回收'])
    const sims: number[] = []
    for (let index = 0; index < 200; index++) {
      sims.push(phaseSimilarity(probe, bundleOf([`实体${index}甲`, `实体${index}乙`])))
    }
    const mean = sims.reduce((total, value) => total + value, 0) / sims.length
    const sd = Math.sqrt(sims.reduce((total, value) => total + (value - mean) ** 2, 0) / sims.length)
    expect(mean).toBeCloseTo(0.5, 2)
    // Measured 0.0105–0.0111 across five probes; the bound is loose enough to survive a different
    // dim or entity vocabulary and tight enough that a broken bundle would fail it.
    expect(sd).toBeLessThan(0.05)
  })

  it('keeps ~0.9 of the top contribution for the weakest unrelated candidate after scaleByMax', () => {
    const probe = bundleOf(['张伟', '管理'])
    const scores = new Map<number, number>()
    for (let index = 0; index < 50; index++) {
      scores.set(index, phaseSimilarity(probe, bundleOf([`无关${index}甲`, `无关${index}乙`])))
    }
    const scaled = scaleByMax(scores)
    const values = [...scaled.values()]
    const weakest = Math.min(...values)
    // THIS is the line a baseline correction must move: with the 0.5 baseline left in place, the
    // spread collapses to a near-uniform boost.
    expect(weakest).toBeGreaterThan(0.75)
    expect(Math.max(...values)).toBeCloseTo(1, 12)
  })

  it('separates a bundle that SHARES an entity from one that does not', () => {
    // The signal the leg exists for, and the reason the flat baseline is tolerable in `hrrPath`'s
    // normal path: every candidate there shares an entity with the probe by construction.
    const probe = bundleOf(['张伟', '管理'])
    const sharing = bundleOf(['张伟', '平台组'])
    const unrelated = bundleOf(['李娜', '平台组'])
    expect(phaseSimilarity(probe, sharing)).toBeGreaterThan(phaseSimilarity(probe, unrelated))
    expect(phaseSimilarity(probe, sharing)).toBeGreaterThan(0.6)
  })
})
