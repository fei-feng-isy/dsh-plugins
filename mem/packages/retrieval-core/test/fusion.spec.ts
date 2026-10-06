import { describe, it, expect } from 'vitest'
import { scaleByMax, fuse, type FusionPath } from '../src/fusion.js'

describe('scaleByMax', () => {
  it('scales by the maximum, keeping the spread and the magnitudes', () => {
    const m = scaleByMax(new Map([[1, 0.5], [2, 0.9], [3, 0.7]]))
    expect(m.get(2)).toBeCloseTo(1, 6)
    expect(m.get(1)).toBeCloseTo(0.5 / 0.9, 6)
    expect(m.get(3)).toBeCloseTo(0.7 / 0.9, 6)
  })

  it('maps a single value to 1, and a non-positive set to 0', () => {
    expect(scaleByMax(new Map([[1, 2]])).get(1)).toBe(1)
    // No ranking information: 0 rather than a division by a non-positive max (or a blanket 1,
    // which would let a degenerate path outvote real ones).
    expect(scaleByMax(new Map([[1, 0]])).get(1)).toBe(0)
    expect(scaleByMax(new Map([[1, -0.4], [2, -0.9]]))).toEqual(new Map([[1, 0], [2, 0]]))
  })
})

describe('fuse', () => {
  it('fuses weighted paths and ranks descending', () => {
    const paths: FusionPath[] = [
      { weight: 0.55, scores: new Map([[1, 0.9], [2, 0.7]]) },
      { weight: 0.3, scores: new Map([[2, 0.8], [3, 0.6]]) },
      { weight: 0.15, scores: new Map([[1, 0.5], [3, 0.5]]) },
    ]
    const hits = fuse(paths, 3)
    const ids = hits.map((h) => h.id)
    expect(ids).toHaveLength(3)
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score)
    expect(hits[1].score).toBeGreaterThanOrEqual(hits[2].score)
  })

  it('returns empty for no candidates', () => {
    expect(fuse([{ weight: 1, scores: new Map() }], 5)).toEqual([])
  })

  it('keeps a candidate whose every path scored zero, rather than hiding it', () => {
    // A degenerate path contributes 0; the id still came from somewhere, so it belongs in the pool
    // (the output budget decides whether it is returned).
    const hits = fuse([{ weight: 1, scores: new Map([[7, 0]]) }], 5)
    expect(hits.map((h) => h.id)).toEqual([7])
  })

  it('breaks ties on ascending id, so the order is not Map-insertion dependent', () => {
    const hits = fuse([
      { weight: 1, scores: new Map([[3, 1], [1, 1], [2, 1]]) },
    ], 3)
    expect(hits.map((h) => h.id)).toEqual([1, 2, 3])
  })

  it('is INVARIANT to a capped path: trimming the tail must not rescale the survivors', () => {
    // The store bounds every non-semantic leg for cost (`memory.ts` `legCap`), which removes that
    // leg's weakest entries. Under the previous min-max normalization those entries WERE the minimum
    // the survivors were measured against, so one trimmed entry swapped the top two (this test used
    // to pin exactly that, as an accepted cost). Scaling by the max — an entry no cap can remove —
    // makes a trimmed tail unable to touch a surviving entry's score.
    const leg1Full: FusionPath = { weight: 0.6, scores: new Map([[1, 1], [2, 0.8], [3, 0.6]]) }
    const leg1Capped: FusionPath = { weight: 0.6, scores: new Map([[1, 1], [2, 0.8]]) }
    const leg2: FusionPath = { weight: 0.4, scores: new Map([[2, 1], [3, 0.6]]) }

    const wide = fuse([leg1Full, leg2], 5)
    const capped = fuse([leg1Capped, leg2], 5)

    // Same ranked list — the cap cannot reorder what it did not remove.
    expect(capped.map((h) => h.id)).toEqual(wide.map((h) => h.id))
    expect(wide.map((h) => h.id)).toEqual([2, 1, 3])

    // Survivors keep their scores EXACTLY; only the entry the cap removed loses its share.
    const scoreOf = (hits: ReturnType<typeof fuse>, id: number): number => hits.find((h) => h.id === id)!.score
    expect(scoreOf(capped, 1)).toBeCloseTo(scoreOf(wide, 1), 12)
    expect(scoreOf(capped, 2)).toBeCloseTo(scoreOf(wide, 2), 12)
    expect(scoreOf(capped, 3)).toBeLessThan(scoreOf(wide, 3))
    expect(scoreOf(wide, 3)).toBeCloseTo(0.6, 6) // 0.6·0.6 + 0.4·0.6
    expect(scoreOf(capped, 3)).toBeCloseTo(0.24, 6) // only leg 2 is left
  })

  it('pins the BOUNDARY of that invariance: a set that loses its maximum IS rescaled', () => {
    // The invariance above holds only for a leg whose cap is ordered by that leg's OWN score (FTS
    // bm25, entity Jaccard). The HRR probe's candidates arrive in the JACCARD leg's order (the
    // entity-Jaccard ratio, which is not the phase similarity this leg scores by) — and in recency
    // order in its fallback — so its cap CAN drop the best scorer, and then `v / max` moves for
    // every survivor. `DESIGN §20.17` scopes the claim exactly this way; this test is the arithmetic
    // half of that boundary (`recall.spec.ts` drives the store-level half). If the HRR leg ever gets
    // score-ordered capping, this expectation must FLIP to an equality.
    const full = fuse([{ weight: 1, scores: new Map([[1, 0.9], [2, 0.5], [3, 0.25]]) }], 3)
    const minusMax = fuse([{ weight: 1, scores: new Map([[2, 0.5], [3, 0.25]]) }], 3)
    const scoreOf = (hits: ReturnType<typeof fuse>, id: number): number => hits.find((h) => h.id === id)!.score

    // The survivors 2 and 3 are untouched BY THE CAP, yet their fused scores move: 2 becomes the new
    // maximum (1.0, up from 0.556) and 3 doubles (0.5, up from 0.278).
    expect(scoreOf(full, 2)).toBeCloseTo(0.5 / 0.9, 6)
    expect(scoreOf(minusMax, 2)).toBeCloseTo(1, 6)
    expect(scoreOf(full, 3)).toBeCloseTo(0.25 / 0.9, 6)
    expect(scoreOf(minusMax, 3)).toBeCloseTo(0.5, 6)
  })
})

/**
 * A non-finite score must not escape its own candidate.
 *
 * One NaN used to do two kinds of damage: it poisoned that candidate's merged total, and it made the
 * sort comparator return NaN — an undefined order, so the ENTIRE ranking became arbitrary rather than
 * one entry being wrong. A corrupt HRR blob was a live source of exactly that (every range check
 * compares false against NaN, so the decoder accepted it).
 */
describe('fusion with a non-finite score', () => {
  it('maps NaN to a zero contribution and keeps the rest of the order intact', () => {
    const hits = fuse([
      { weight: 1, scores: new Map([[1, 0.8], [2, Number.NaN], [3, 0.4]]) },
    ], 3)
    expect(hits.map((h) => h.id)).toEqual([1, 3, 2])
    expect(hits.every((h) => Number.isFinite(h.score))).toBe(true)
    expect(hits.find((h) => h.id === 2)!.score).toBe(0)
  })

  it('keeps NaN out of the maximum, so a leg is not flattened by one bad row', () => {
    // With NaN as the "maximum", every finite score would divide into NaN and the whole leg would
    // contribute nothing.
    const scaled = scaleByMax(new Map([[1, 0.5], [2, Number.NaN]]))
    expect(scaled.get(1)).toBeCloseTo(1, 6)
    expect(scaled.get(2)).toBe(0)
  })

  it('leaves a second leg ranking a NaN candidate normally', () => {
    const hits = fuse([
      { weight: 1, scores: new Map([[1, Number.NaN], [2, 0.9]]) },
      { weight: 1, scores: new Map([[1, 0.7], [2, 0.35]]) },
    ], 2)
    // Candidate 1 loses the first leg (zero contribution) but is still scored by the second one:
    // 1 → 0 + 1.0, 2 → 1.0 + 0.5. The order is decided by real numbers, not by a NaN comparator.
    expect(hits.map((h) => h.id)).toEqual([2, 1])
    expect(hits.find((h) => h.id === 1)!.score).toBeCloseTo(1, 6)
    expect(hits.find((h) => h.id === 2)!.score).toBeCloseTo(1.5, 6)
  })
})

/**
 * P-01: per-leg evidence is opt-in, and turning it on changes NOTHING about the ranking.
 *
 * `fuse` is the memory/knowledge shared kernel, so this is the level at which "the evidence is
 * additive" can be stated without either store in the room.
 */
describe('fuse with per-leg evidence (P-01)', () => {
  const paths: FusionPath[] = [
    { weight: 0.55, scores: new Map([[1, 0.9], [2, 0.7]]) },
    { weight: 0.3, scores: new Map([[2, 0.8], [3, 0.6]]) },
  ]

  it('omits the evidence entirely unless asked', () => {
    for (const hit of fuse(paths, 3)) expect(hit).not.toHaveProperty('legs')
  })

  it('reports raw and normalized per leg, null where the leg had no candidate', () => {
    const hits = fuse(paths, 3, { includeLegs: true })
    const byId = new Map(hits.map((h) => [h.id, h]))
    const expectLeg = (leg: { raw: number; normalized: number } | null | undefined, raw: number, normalized: number): void => {
      expect(leg).not.toBeNull()
      expect(leg!.raw).toBeCloseTo(raw, 12)
      expect(leg!.normalized).toBeCloseTo(normalized, 12)
    }
    // Candidate 1: only the first leg. raw kept; normalized = raw / that leg's max (0.9).
    expectLeg(byId.get(1)!.legs![0], 0.9, 1)
    expect(byId.get(1)!.legs![1]).toBeNull()
    // Candidate 3: only the second leg, normalized against THAT leg's max (0.8).
    expect(byId.get(3)!.legs![0]).toBeNull()
    expectLeg(byId.get(3)!.legs![1], 0.6, 0.75)
    // Both legs recalled candidate 2.
    expectLeg(byId.get(2)!.legs![0], 0.7, 0.7 / 0.9)
    expectLeg(byId.get(2)!.legs![1], 0.8, 1)
  })

  it('produces the identical ranking and scores with and without the evidence', () => {
    const plain = fuse(paths, 3).map((h) => [h.id, h.score])
    const withLegs = fuse(paths, 3, { includeLegs: true }).map((h) => [h.id, h.score])
    expect(withLegs).toEqual(plain)
  })
})
