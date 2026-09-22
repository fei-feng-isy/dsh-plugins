/**
 * Hybrid fusion: each path's raw scores are scaled by that path's OWN maximum, then summed with
 * the configured weights and cut to the top-k.
 *
 * Scaling by the max (rather than min-max over the path's returned set) is what makes the result
 * INVARIANT to a capped path — FOR A PATH THAT HANDS ITS ENTRIES OVER IN ITS OWN SCORE ORDER.
 * The store bounds every non-semantic leg (`memory.ts` `legCap`) for cost, and a cap then removes
 * that leg's weakest entries, which is exactly the minimum a min-max normalization would have
 * measured against: trimming used to rescale every survivor and could reorder them (a documented,
 * previously-accepted effect). With `v/max` the number is the same with or without the cap,
 * because the maximum belongs to an entry a cap cannot remove.
 *
 * That "cannot remove" is the assumption, and the store has ONE leg that breaks it: the HRR probe.
 * Its candidates arrive in another leg's order — the entity-Jaccard ratio (`candidateFactsForAnyEntity`,
 * which is the JACCARD leg's score, not the phase similarity this leg scores by), or recency in the
 * no-candidate fallback (see `MemoryStore.hrrPath`). Either way the cap may drop this leg's highest
 * scorer and the scaling does move. Stated rather than implied, because the invariance is the whole
 * reason this normalization was chosen; `docs/PROVENANCE_REVIEW.md` N5 records the missing
 * differential, and `recordLegCapped()` is what makes the cap observable at all.
 *
 * Magnitudes are kept: a path whose scores cluster high still contributes more per entry than one
 * whose scores are near zero, which is the information ranks alone would throw away.
 */

export interface FusionPath {
  weight: number
  /** candidate id → raw score (un-normalized). */
  scores: Map<number, number>
}

export interface Hit {
  id: number
  score: number
}

/**
 * Scale raw scores by the set's maximum, into [0,1].
 *
 * A set whose maximum is not positive carries no ranking information, so every entry maps to 0 —
 * it still participates in the pool (with no contribution) instead of being dropped, which is what
 * keeps a degenerate path from emptying the result.
 *
 * A NON-FINITE score is treated the same way (mapped to 0, kept in the pool). It cannot come from a
 * healthy leg, but a corrupt HRR blob decodes to NaN without a length check failing, and one NaN
 * would otherwise do two kinds of damage: poison that candidate's merged total, and make `fuse`'s
 * sort comparator return NaN — an undefined order, so the whole ranking (not just one entry)
 * becomes arbitrary.
 */
export function scaleByMax(scores: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>()
  if (scores.size === 0) return out
  let max = -Infinity
  for (const v of scores.values()) if (Number.isFinite(v) && v > max) max = v
  if (!(max > 0)) {
    for (const id of scores.keys()) out.set(id, 0)
    return out
  }
  for (const [id, v] of scores) out.set(id, Number.isFinite(v) ? Math.max(0, v) / max : 0)
  return out
}

/**
 * Fuse paths by scaling each path's scores by its own maximum, summing weighted values, and
 * returning the top-k descending. Ties break on ascending id so the ranking is deterministic —
 * scaled scores collide far more often than min-max ones did (both legs of a pair can rank two
 * candidates identically), and the previous order was Map-insertion order.
 */
export function fuse(paths: FusionPath[], topK: number): Hit[] {
  const pooled = new Set<number>()
  for (const p of paths) for (const id of p.scores.keys()) pooled.add(id)

  const scaledPaths = paths.map((p) => ({ weight: p.weight, scores: scaleByMax(p.scores) }))

  const merged = new Map<number, number>()
  for (const id of pooled) {
    let s = 0
    for (const p of scaledPaths) {
      const nv = p.scores.get(id)
      if (nv !== undefined) s += p.weight * nv
    }
    // Every pooled id is kept, including a zero total: it came from some path, so dropping it here
    // would hide a candidate the caller may still want (the output budget decides what is returned).
    merged.set(id, s)
  }

  return [...merged.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, topK)
}
