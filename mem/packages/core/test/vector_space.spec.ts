import { describe, it, expect } from 'vitest'
import { classifyVectorSpace, countVectorSpace, type VectorSpaceProbe } from '../src/store/vector_space.js'
import { float32ToBytes, vectorSpaceId } from '../src/db/vectors.js'

/**
 * The ONE vector-space rule (`store/vector_space.ts`), pinned as a pure function.
 *
 * The five copies it replaces were written over three different shapes of the same evidence (raw
 * BLOB, projected `length(blob)`, decoded `Float32Array`). So the assertions below are deliberately
 * CROSS-SHAPE: the same corpus described in all three shapes must classify identically — that is the
 * property the refactor exists for, not "each shape works".
 */
const DIM = 768
const SPACE = vectorSpaceId('axis_sem', 'Xenova/bge-base-zh-v1.5', DIM, 'mean,normalize:512')
const OTHER_SPACE = vectorSpaceId('axis_sem', 'other/model', DIM, 'mean,normalize:512')
/** A same-width id from before the representation fingerprint (`v2/…`). */
const LEGACY_SPACE = 'axis_sem/Xenova/bge-small-zh-v1.5/768'

const identity = { space: SPACE, dim: DIM }

function blob(floats: number): Float32Array {
  return new Float32Array(floats)
}

/** The same persisted row, in each of the three shapes the call sites actually hold. */
function shapesOf(vec: Float32Array | null, embeddingModel: string | null): VectorSpaceProbe[] {
  return [
    { source: 'blob', vec: vec === null ? null : new Uint8Array(float32ToBytes(vec)), embeddingModel },
    { source: 'byteLength', byteLength: vec === null ? null : vec.length * 4, embeddingModel },
    { source: 'decoded', vec, embeddingModel },
  ]
}
/** One row of the synthetic corpus: width, recorded space. */
interface Row {
  floats: number
  space: string | null
  /** `null` floats = no persisted vector at all (the blob is NULL). */
  absent?: boolean
}

const CORPUS: Row[] = [
  { floats: DIM, space: SPACE }, // current
  { floats: DIM, space: OTHER_SPACE }, // same width, another model ⇒ space_stale
  { floats: DIM, space: LEGACY_SPACE }, // same width, pre-fingerprint ⇒ space_stale + legacy
  { floats: DIM, space: null }, // unrecorded space ⇒ space_stale, NOT legacy
  { floats: 512, space: OTHER_SPACE }, // wrong width ⇒ stale, whatever the recorded space says
  { floats: 0, space: SPACE }, // zero-length blob ⇒ stale
  { floats: DIM, space: SPACE, absent: true }, // no vector at all ⇒ stale
]

/** The corpus in one shape, as the three call sites would each hand it to the counter. */
function corpusIn(shape: 'blob' | 'byteLength' | 'decoded'): VectorSpaceProbe[] {
  return CORPUS.map((row) => {
    // `absent` is the "no persisted vector at all" row: a NULL width in every shape.
    const vec = row.absent === true ? null : blob(row.floats)
    if (shape === 'blob') {
      return { source: 'blob', vec: vec === null ? null : new Uint8Array(float32ToBytes(vec)), embeddingModel: row.space }
    }
    if (shape === 'byteLength') {
      return { source: 'byteLength', byteLength: vec === null ? null : vec.length * 4, embeddingModel: row.space }
    }
    return { source: 'decoded', vec, embeddingModel: row.space }
  })
}

describe('classifyVectorSpace — the ONE stale-vector rule', () => {
  it('classifies a width that cannot serve the store as `stale` (null, wrong width, empty blob)', () => {
    for (const probe of shapesOf(null, SPACE)) {
      expect(classifyVectorSpace(probe, identity)).toEqual({ verdict: 'stale', legacy: false })
    }
    expect(classifyVectorSpace({ source: 'byteLength', byteLength: null, embeddingModel: SPACE }, identity).verdict).toBe('stale')
    expect(classifyVectorSpace({ source: 'blob', vec: new Uint8Array(0), embeddingModel: SPACE }, identity).verdict).toBe('stale')
    // `dim * 4`, not `dim`: a 512-float blob in a 768-float store is stale even though it decodes.
    for (const probe of shapesOf(blob(512), SPACE)) {
      expect(classifyVectorSpace(probe, identity).verdict).toBe('stale')
    }
  })

  it('classifies a usable-width vector from another space as `space_stale`', () => {
    for (const probe of shapesOf(blob(DIM), OTHER_SPACE)) {
      expect(classifyVectorSpace(probe, identity)).toEqual({ verdict: 'space_stale', legacy: false })
    }
    // An UNRECORDED space is foreign (`!== space`), not a fourth state.
    for (const probe of shapesOf(blob(DIM), null)) {
      expect(classifyVectorSpace(probe, identity)).toEqual({ verdict: 'space_stale', legacy: false })
    }
  })

  it('splits `space_stale` into legacy (pre-fingerprint id) and a genuine model swap', () => {
    for (const probe of shapesOf(blob(DIM), LEGACY_SPACE)) {
      expect(classifyVectorSpace(probe, identity)).toEqual({ verdict: 'space_stale', legacy: true })
    }
    // A v2 id from another model is NOT legacy: the distinction is the recorded FORMAT, not the model.
    expect(classifyVectorSpace({ source: 'decoded', vec: blob(DIM), embeddingModel: OTHER_SPACE }, identity).legacy).toBe(false)
  })

  it('classifies the current space as `current`', () => {
    for (const probe of shapesOf(blob(DIM), SPACE)) {
      expect(classifyVectorSpace(probe, identity)).toEqual({ verdict: 'current', legacy: false })
    }
  })

  it('counts the same corpus identically in all three evidence shapes', () => {
    const counts = (['blob', 'byteLength', 'decoded'] as const).map((shape) => countVectorSpace(corpusIn(shape), identity))
    expect(counts[0]).toEqual({ stale: 3, space_stale: 3, legacy: 1 })
    expect(counts[1]).toEqual(counts[0])
    expect(counts[2]).toEqual(counts[0])
  })

  it('counts from the per-row verdicts and keeps `legacy` a SPLIT of `space_stale`', () => {
    for (const probe of corpusIn('decoded')) {
      const { verdict } = classifyVectorSpace(probe, identity)
      expect(['current', 'stale', 'space_stale']).toContain(verdict)
    }
    const counts = countVectorSpace(corpusIn('decoded'), identity)
    expect(counts.legacy).toBeLessThanOrEqual(counts.space_stale)
    // An unrecorded space (`null`) is space_stale and NOT legacy, so the split is strictly smaller.
    expect(counts.legacy).toBe(1)
  })

  it('is a no-op count on an empty corpus and on an all-current corpus', () => {
    expect(countVectorSpace([], identity)).toEqual({ stale: 0, space_stale: 0, legacy: 0 })
    expect(countVectorSpace(shapesOf(blob(DIM), SPACE), identity)).toEqual({ stale: 0, space_stale: 0, legacy: 0 })
  })
})
