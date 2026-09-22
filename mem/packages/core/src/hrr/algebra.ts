import { TWO_PI } from './atoms.js'

export class ShapeMismatchError extends Error {}

function check(v: unknown, role: string): asserts v is Float64Array {
  if (!(v instanceof Float64Array)) throw new ShapeMismatchError(`${role} 必须是 Float64Array`)
  if (v.length === 0) throw new ShapeMismatchError(`${role} 不能是空向量`)
}

function sameDim(a: Float64Array, b: Float64Array): void {
  if (a.length !== b.length) throw new ShapeMismatchError(`dim 不一致：a=${a.length} vs b=${b.length}`)
}

/** bind(a, b) = (a + b) mod 2π — compose two phase vectors. */
export function bind(a: Float64Array, b: Float64Array): Float64Array {
  check(a, 'a')
  check(b, 'b')
  sameDim(a, b)
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = mod2pi(a[i] + b[i])
  return out
}

/** bundle(*vectors) — circular-mean superposition `angle(Σ exp(i·v)) mod 2π`. */
export function bundle(...vectors: Float64Array[]): Float64Array {
  if (vectors.length === 0) throw new Error('bundle 至少需要 1 个向量')
  check(vectors[0], 'vectors[0]')
  const dim = vectors[0].length
  for (let i = 1; i < vectors.length; i++) {
    check(vectors[i], `vectors[${i}]`)
    sameDim(vectors[0], vectors[i])
  }
  const re = new Float64Array(dim)
  const im = new Float64Array(dim)
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      re[i] += Math.cos(v[i])
      im[i] += Math.sin(v[i])
    }
  }
  const out = new Float64Array(dim)
  for (let i = 0; i < dim; i++) out[i] = mod2pi(Math.atan2(im[i], re[i]))
  return out
}

export function mod2pi(x: number): number {
  const r = x % TWO_PI
  return r < 0 ? r + TWO_PI : r
}

/**
 * Cosine-like phase similarity in [0, 1]: `(sum cos(a-b) + dim) / (2*dim)`.
 *
 * THE BASELINE IS 0.5, AND THAT SHAPES HOW THE LEG CONTRIBUTES. Two unrelated random bundles score
 * 0.5 in expectation, and at dim=1024 the spread around it is tiny — measured over 200 unrelated
 * pairs against five different probes: mean 0.499–0.503, sd 0.0105–0.0111, and the BEST of the 200
 * reached only 0.525–0.536. A bundle scores 1.0 against itself, so the range that matters in
 * practice is [~0.5, 1.0].
 *
 * Consequence at the fusion step: `scaleByMax` divides the leg by its own maximum, so the weakest
 * unrelated candidate still keeps 0.88–0.90 of the strongest one's contribution. Within a set of
 * candidates that do NOT share the probe's entities, this leg is therefore close to a CONSTANT boost
 * rather than a ranking signal — which is benign in `MemoryStore.hrrPath`'s normal path (every
 * candidate there shares an entity by construction, and sharing moves the score well above 0.5) and
 * NOT benign in its fallback path, where the scored set is "the `cap` most recent facts" and most of
 * them share nothing.
 *
 * Stated rather than fixed: subtracting the baseline (`max(0, (sim - 0.5) * 2)`) would make the leg
 * discriminative, but it changes ranking, and the differential that would justify it is the same one
 * `docs/PROVENANCE_REVIEW.md` N5 records as missing — the frozen eval set exercises `recall.search`,
 * and this leg only runs for `recall.probe`, so no existing gate would move either way. Pinned by
 * `test/hrr.spec.ts` so the change has to be made deliberately, with a probe-shaped eval beside it.
 */
export function phaseSimilarity(a: Float64Array, b: Float64Array): number {
  sameDim(a, b)
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.cos(a[i] - b[i])
  return (s + a.length) / (2 * a.length)
}
