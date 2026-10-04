/**
 * The entity leg's metric: ANCHORED JACCARD WITH A SATURATING UNION.
 *
 * WHY THE OLD METRIC FAILED SHORT QUERIES. The leg scored the plain Jaccard ratio
 * `|Q ∩ F| / |Q ∪ F|`. Both stores are written by the SAME entity extractor, which keeps every
 * noun-ish token, so a real memory fact carries ~31 entity names (measured on the live store:
 * min 3 / median 31 / max 66; `scripts/ENTITY_TOKENIZER_VALUE.md`). A query extracts one or two.
 * Even a PERFECT 1-entity match is then `1 / (1 + 31 - 1) ≈ 0.03`, so with `min_jaccard` at any
 * useful value the leg is unreachable for a short query BY CONSTRUCTION — measured: 1-entity
 * queries could clear 0.2 against 2 of 80 facts. Extracting MORE entities only grows the
 * denominator (the tokenizer direction was measured and rejected), so the fix has to be the
 * metric, not the extractor.
 *
 * THE METRIC. `A` is the query's ANCHOR entities (below). The score keeps the Jaccard form — so a
 * fact that is "about" the query outranks one that merely contains it — but the fact's own width
 * enters through a SATURATING term:
 *
 *     score(A, W, F) = |A ∩ F| / ( W + min(|F \ A|, ENTITY_UNION_CAP) )
 *
 * The query side is `W`, the query's FULL entity count, not `|A|`: the Jaccard denominator is the
 * union, and the query's own width belongs in it whether or not each entity turned out to be
 * discriminative (a question that names five things asks for more than one that names one). When
 * every query entity is an anchor (the frozen eval set) and the fact is no wider than
 * `W + ENTITY_UNION_CAP`, this IS the plain Jaccard ratio `|Q ∩ F| / |Q ∪ F|` — those facts keep
 * their EXACT old score and ordering (verified bit-for-bit on all four eval arms). Past the cap the
 * denominator stops growing, so a wide fact that genuinely mentions a query's rare entity is
 * REACHABLE instead of being divided into oblivion. The cap is not a free parameter: the floor is
 * 0.2 and a two-entity query sharing ONE entity must still clear it (`1 / (2 + C) >= 0.2 ⇒ C <= 3`),
 * so `C = 3` is the largest fact penalty that keeps that shape.
 *
 * WHY ANCHORS (IDF FILTERING). Removing the width blow-up alone would let a corpus-wide word
 * (`用户` / `插件` / `任务` …) admit EVERY fact that mentions it — "drag the whole store in". The
 * extracted bags are dominated by such words, so the precision lever is rarity: an entity is an
 * ANCHOR when its document frequency over the active corpus is at most {@link anchorCeiling}. Only
 * anchors can produce candidates or contribute to the numerator; a query whose entities are ALL
 * generic therefore yields no entity evidence and the other legs answer it. That is deliberate
 * (silent beats noisy), and the FTS leg's 2-char substring fallback (§20.20⑦) serves the 2-char
 * shape.
 *
 * WHAT `W` COUNTS, AND WHY IT IS NOT `|A|`. `W` is the query's FULL entity count — every entity the
 * extractor returned, generic or absent included. A Jaccard denominator is the union of what the
 * query asked for, and the old metric counted all of it; keeping `W` there is what makes a narrow
 * fact's score IDENTICAL to the old ratio, so the frozen eval and every narrow real fact keep their
 * exact numbers and ordering. Dropping the absent entities from `W` was measured and moved the live
 * eval (`CI 用哪个 Python 版本` lost rank 1): a query that names things the corpus does not carry
 * really is asking for more, and the floor is calibrated against that.
 *
 * THE CEILING SCALES WITH THE CORPUS, WITH A FLOOR. A fixed count would mean different things on a
 * 3-fact eval case and a 300k-fact store, and a purely relative one would call every entity
 * "generic" on a tiny corpus (`ceil(0.2 * 3) = 1` filters any name that appears twice — which is
 * every name in a 3-fact relation case). {@link ANCHOR_MIN} forgives small corpora; the relative
 * term is what bites on a real store. Both are calibrated, not guessed: DESIGN §20.19.
 *
 * @module store/entity_leg
 */

/** An entity is an anchor at or below `max(ANCHOR_MIN, ceil(ANCHOR_RATE × activeFacts))`. */
export const ANCHOR_RATE = 0.2

/**
 * Small-corpus forgiveness, and its bound.
 *
 * Without it, `ceil(0.2 × 3) = 1` would call every name appearing twice "generic" — which is every
 * name in a 3-fact relation case — and the eval set would lose its entity leg entirely. This is
 * measured, not guessed: at `2` the eval corpus calls `Python` (carried by all three facts of its
 * case) generic, and `CI 用哪个 Python 版本` loses its answer's entity evidence to the FTS leg —
 * the live arm regressed `must_exclude`, the degraded arm lost rank 1 on that query. `4` keeps a
 * name a small corpus repeats; the relative term is what bites on a real store (a 3-fact case
 * filters nothing, by design).
 */
export const ANCHOR_MIN = 4

/**
 * How many entities a fact may carry beyond the query's anchors before the width penalty stops
 * growing (see the module doc: derived from the 0.2 floor and the 2-anchor reachability
 * requirement, `1 / (2 + C) >= 0.2`).
 */
export const ENTITY_UNION_CAP = 3

/** The document-frequency ceiling for a corpus of `corpus` active facts/chunks. */
export function anchorCeiling(corpus: number): number {
  return Math.max(ANCHOR_MIN, Math.ceil(ANCHOR_RATE * Math.max(0, corpus)))
}

/**
 * The query entities that may serve as evidence.
 *
 * `df` is the DOCUMENT FREQUENCY of each query entity over the active corpus (how many facts /
 * chunks carry it). An entity is kept when it occurs at least once and at most
 * {@link anchorCeiling} times; the returned order is the input order (the caller only needs the
 * set, and a stable order keeps the SQL/scoring deterministic).
 */
export function selectAnchors(
  queryEntities: Iterable<string>,
  df: ReadonlyMap<string, number>,
  corpus: number,
): string[] {
  const ceiling = anchorCeiling(corpus)
  const out: string[] = []
  for (const name of queryEntities) {
    const frequency = df.get(name) ?? 0
    if (frequency > 0 && frequency <= ceiling) out.push(name)
  }
  return out
}

/**
 * The leg's raw score, in [0, 1] — see the module doc for the formula and the constants.
 *
 * `0` for an empty anchor set (no discriminative query entity) and for "shares none". `queryWidth`
 * is the query's full entity count (`W`), which keeps the narrow-fact case identical to the old
 * Jaccard ratio; the fact's width only matters up to {@link ENTITY_UNION_CAP} extra entities, so a
 * wide bag cannot divide a short query into nothing while a narrow one still ranks above a wide one.
 */
export function anchoredOverlap(anchors: readonly string[], queryWidth: number, factEntities: ReadonlySet<string>): number {
  if (anchors.length === 0 || queryWidth <= 0) return 0
  let shared = 0
  for (const name of anchors) if (factEntities.has(name)) shared += 1
  if (shared === 0) return 0
  // `|F \ A| = |F| - |A ∩ F|` (every shared entity is in F).
  const extra = Math.min(factEntities.size - shared, ENTITY_UNION_CAP)
  return shared / (queryWidth + Math.max(0, extra))
}
