/**
 * The relevance floors both stores apply to their legs' OWN raw scores, before `fuse()`.
 *
 * WHY PRE-FUSION, AND WHY ABSOLUTE. `retrieval-core/src/fusion.ts` scales each leg by that leg's
 * MAXIMUM, so every leg's head is 1.0 by construction and the fused number is only comparable
 * WITHIN one query. A cutoff on the fused score would therefore mean a different thing per query
 * (and would move whenever a leg's head changed). The legs' raw numbers do have an absolute scale —
 * cosine for the semantic leg, the Jaccard ratio for the entity leg, "distinct query terms hit" for
 * FTS — so that is where the floors live. The side benefit is that flooring a leg's tail cannot
 * move its maximum, so the cap-invariance §20.17 relies on is untouched.
 *
 * THREE FLOORS, ONE SHAPE. `min_semantic_similarity` / `min_fts_terms` / `min_jaccard`; each `0`
 * means "this leg is not gated", and a candidate EQUAL to its floor is KEPT (only strictly-lower
 * candidates are dropped). The FTS floor is judged PER ROW, not per query: "the store holds this
 * term somewhere" is the conditional-hint probe's question (`lexical.ts`), and it would let a row
 * that shares one incidental trigram ride into the result — exactly the low-relevance candidate the
 * floor exists to remove.
 *
 * DEGRADED RELAXATION. With the semantic leg down (`DEGRADED_WEIGHTS`), FTS + entity are the only
 * evidence a query has, so a two-term bar that the semantic leg used to soften would empty whole
 * short queries. The FTS floor's effective value drops to 1 in that mode; an explicit `0` stays 0.
 *
 * WHY THERE IS A RELAXED PROFILE AT ALL, AND WHY IT IS NOT "NO FLOOR". The floors are calibrated
 * for paraphrase-style relevance, and there is a band where no threshold separates "answers the
 * question" from "unrelated": measured on the live store, the fact answering 「我是谁」 scored cosine
 * 0.444 under the original 512-dim default (0.459 under the shipped 768-dim `bge-base-zh-v1.5`)
 * while four unrelated queries topped out at 0.384 (0.353 at 768) — a ~0.1 margin, and the
 * answering fact was the query's own top-1. So the answer is not a lower default (which would trade
 * precision for
 * the whole corpus) but a SECOND pass with an absolute bottom line ({@link LOOSE_FLOORS}), run only
 * when the strict pass returned nothing at all AND the floors are why (`dropped_by_floor > 0`).
 *
 * WHICH LEGS A RELAXED PASS LOWERS, AND WHY THAT IS NOT A NO-OP IN THE REPORT. Only the legs the
 * strict pass actually DROPPED candidates on (see {@link droppedLegs}) are lowered. Lowering a leg
 * that dropped nothing cannot admit anything — a floor only removes entries — so the chosen
 * candidates are identical either way; what changes is the `floors` envelope handed back, which
 * used to claim every leg had been relaxed even when only one was ever the problem. An EXPLICIT
 * `floors: 'loose'` request has no prior pass to read, so it lowers every gated leg — to the SAME
 * bottom lines the automatic pass uses, so the explicit entry can never drop below them (it is not
 * a backdoor; see {@link resolveFloors}).
 *
 * WHY NOT EXEMPT `pinned` FACTS FROM THE FLOORS. It was the obvious shortcut and it is wrong: the
 * exemption only lets a fact into the fusion pool, it does not add score, and `fuse` ranks by each
 * leg's normalized raw score before slicing to `limit`. So on a query with plenty of strong
 * candidates the archive sits at the tail and is invisible — but on a weak (or should-be-empty)
 * query it fills the tail, i.e. every search starts showing the same archive. The effect grows with
 * the number of pinned facts, and on a small corpus (`overFetch = limit × 5` covers the whole store)
 * the exemption degenerates into "every pinned fact joins every fusion". A relaxed PASS with a floor
 * of its own is bounded instead: it costs one extra query, only when the strict answer was empty,
 * and it can still report "nothing relevant" for a genuinely unrelated question.
 *
 * FTS REACHABILITY. `min_fts_terms` counts distinct query terms a row hits, but a query can only
 * produce so many terms (`relevanceTerms`: latin words ≥5 chars + CJK 3-grams) — a 3-character CJK
 * query yields exactly ONE trigram, so a configured bar of 2 is unreachable and that leg is empty
 * for it by construction. The effective bar is therefore `min(configured, termCount)`.
 *
 * @module store/floors
 */
import type { FloorProfile, RetrievalFloorDrops, RetrievalFloors } from '@avantf/mem-contract'
import { relevanceTerms } from './lexical.js'

/** The retriever knobs the floors read (a structural type so tests can pass a literal). */
export interface FloorConfig {
  min_semantic_similarity: number
  min_fts_terms: number
  min_jaccard: number
}

/**
 * The legs that own a floor. The HRR probe has no floor of its own — it shares the Jaccard one — so
 * it never appears here; a drop on `hrr` relaxes `jaccard` (see {@link droppedLegs}).
 */
export type FloorLeg = 'semantic' | 'fts' | 'jaccard'

/**
 * What the RELAXED pass lowers each floor TO, as absolute values.
 *
 *  - semantic **0.40**: strictly BETWEEN the measured unrelated-query ceiling and the
 *    pronoun-query top-1. Both bounds are load-bearing. Above the ceiling, so a genuinely
 *    unrelated question still comes back EMPTY from the relaxed pass — the four measured samples
 *    topped out at 0.300/0.384/0.315/0.351 under the original 512-dim default and at
 *    0.271/0.353/0.350/0.269 under the shipped 768-dim `bge-base-zh-v1.5` (a 0.35 bar would already
 *    admit two of them in either scale). Below the top-1, so 「我是谁」 finds its fact (0.444 at 512,
 *    0.459 at 768). 0.40 keeps the larger margin on the noise side, which is where a false positive
 *    costs the caller a wrong answer rather than a missing one.
 *  - fts: NOT a constant — {@link looseTermFloor}, half the query's distinct terms with a floor of
 *    1. `1` here is the "no terms to scale by" baseline (the previously constant value); a query
 *    that cannot produce terms is not graded at all, and one that produces a single term (every
 *    3-char CJK query) is already graded against that one term by the reachability clamp.
 *  - jaccard **0.15** (positive — the previous `0` was the ungated hole this closes). Measured, not
 *    guessed, on two corpora: (a) the live store, 64 active facts, the common-entity questions a
 *    real user asks about this repo ("插件怎么安装" / "任务怎么拆分" / "知识库在哪里" …) put their
 *    TOP non-answering entity candidate at Jaccard 0.0909 and most at 0.02–0.07, so 0.15 removes that
 *    whole tail; (b) the gold-labelled 35-query eval set, where the LOWEST Jaccard any answering pair
 *    reached is 0.25 (「老王喜欢什么风格」) — a bottom line above 0.25 starts dropping gold pairs,
 *    while 0.15 filters none. The entity leg cannot fully separate the two classes on short queries
 *    (a one-entity query against a one-entity fact is 1.0 by construction, and non-gold pairs reach
 *    0.667), so this is deliberately a "no incidental small overlap" line, not a relevance classifier.
 */
export const LOOSE_FLOORS: RetrievalFloors = { semantic: 0.4, fts: 1, jaccard: 0.15 }

/**
 * The FTS bar the RELAXED pass applies to a query carrying `termCount` distinct terms.
 *
 * Positive on purpose: "Relaxed" must never mean "ungated", and the old constant of `1` let a single
 * incidental trigram become a leg's head (per-leg max normalization makes it 1.0) on any query long
 * enough to produce several terms. Half the query's terms — `ceil(termCount / 2)`, at least 1 — keeps
 * a real fraction of what the query asked for while still relaxing the configured bar of 2 to 1 for
 * a two-term query. `termCount` 0/omitted keeps the baseline of 1 (such a query is not graded by
 * {@link applyTermFloor} at all). The `min(configured, …)` in {@link resolveFloors} means this can
 * only relax, never raise.
 */
export function looseTermFloor(termCount?: number): number {
  const half = termCount === undefined || termCount <= 0 ? 0 : Math.ceil(termCount / 2)
  return Math.max(1, half)
}

/** The floor every leg's drops start from. */
export function emptyFloorDrops(): RetrievalFloorDrops {
  return { semantic: 0, fts: 0, jaccard: 0, hrr: 0 }
}

/**
 * The FTS bar actually applied to a query carrying `termCount` distinct terms.
 *
 * A query cannot be graded against more terms than it has (see the module comment: a 3-char CJK
 * query has one trigram), so the configured bar is CLAMPED to the reachable maximum. `termCount`
 * `0`/omitted leaves the value alone — such a query is not graded at all by {@link applyTermFloor},
 * and changing the REPORTED value there would misdescribe what the caller is reading. `0` stays `0`
 * (the operator's off switch).
 *
 * This is the ONE place the clamp lives; `resolveFloors` (what the result reports) and
 * `applyTermFloor` (what the leg does) both call it, so the number the caller reads is the number
 * the leg used.
 */
export function effectiveTermFloor(floor: number, termCount?: number): number {
  if (!(floor > 0)) return floor
  if (termCount === undefined || termCount <= 0) return floor
  return Math.min(floor, termCount)
}

/** The per-query floor resolution inputs beyond the configuration. */
export interface FloorResolution {
  /** `loose` lowers each configured floor (see {@link LOOSE_FLOORS}); absent means `strict`. */
  profile?: FloorProfile
  /** This query's distinct term count (`relevanceTerms(query).length`), for the FTS clamp. */
  termCount?: number
  /**
   * Which legs a `'loose'` profile may lower, from {@link droppedLegs} of the pass that made the
   * relaxation necessary. Omitted = every gated leg, which is what an EXPLICIT `floors: 'loose'`
   * request means (the caller asked for the profile outright and there is no prior pass to read).
   * Either way the target values are the same {@link LOOSE_FLOORS} / {@link looseTermFloor} bottom
   * lines — naming fewer legs can only make the pass stricter, never looser.
   */
  relaxLegs?: readonly FloorLeg[]
}

/**
 * The legs a pass actually dropped candidates on — the only ones a relaxed pass can help.
 *
 * A leg that dropped nothing has no candidate below its strict floor, so lowering that floor admits
 * nothing new; including it in the relaxed `floors` would just misreport which leg was the problem.
 * `hrr` maps onto `jaccard` because the probe shares the entity leg's candidate set and floor (see
 * `HybridLeg.leg`).
 */
export function droppedLegs(drops: RetrievalFloorDrops): FloorLeg[] {
  const legs: FloorLeg[] = []
  if (drops.semantic > 0) legs.push('semantic')
  if (drops.fts > 0) legs.push('fts')
  if (drops.jaccard > 0 || drops.hrr > 0) legs.push('jaccard')
  return legs
}

/**
 * Resolve the effective floors for one query (see the module comment for the rules).
 *
 * Exported so both stores and the tests read the SAME rule rather than re-deriving it — the whole
 * point of hosting the orchestration in one file was that a per-store copy of a rule drifts.
 *
 * The relaxed profile takes `min(configured, relaxed)` per leg: it can only RELAX. A leg the
 * operator disabled (`0` = off) stays disabled, a floor the operator already set below the relaxed
 * value is left alone, and {@link FloorResolution.relaxLegs} can only narrow WHICH legs move.
 * "Relaxed" never means "ungated" — otherwise the pass could not answer "nothing relevant".
 */
export function resolveFloors(retriever: FloorConfig, semAvail: boolean, resolution: FloorResolution = {}): RetrievalFloors {
  const configured: RetrievalFloors = {
    semantic: retriever.min_semantic_similarity,
    // `0` is the operator's escape hatch and survives the relaxation; anything positive becomes the
    // degraded bar of 1.
    fts: semAvail ? retriever.min_fts_terms : (retriever.min_fts_terms > 0 ? 1 : 0),
    jaccard: retriever.min_jaccard,
  }
  const mayRelax = (leg: FloorLeg): boolean =>
    resolution.profile === 'loose'
    && (resolution.relaxLegs === undefined || resolution.relaxLegs.includes(leg))
  const lowered = {
    semantic: mayRelax('semantic') ? Math.min(configured.semantic, LOOSE_FLOORS.semantic) : configured.semantic,
    fts: mayRelax('fts') ? Math.min(configured.fts, looseTermFloor(resolution.termCount)) : configured.fts,
    jaccard: mayRelax('jaccard') ? Math.min(configured.jaccard, LOOSE_FLOORS.jaccard) : configured.jaccard,
  }
  return { ...lowered, fts: effectiveTermFloor(lowered.fts, resolution.termCount) }
}

/** `0` = off; a score EQUAL to the floor passes (the floor drops strictly-lower candidates only). */
export function passesFloor(score: number, floor: number): boolean {
  return !(floor > 0) || score >= floor
}

/** Drop the entries of one leg's raw score map that fall below `floor`, counting them. */
export function applyScoreFloor(
  scores: Map<number, number>,
  floor: number,
): { scores: Map<number, number>; dropped: number } {
  if (!(floor > 0) || scores.size === 0) return { scores, dropped: 0 }
  const out = new Map<number, number>()
  let dropped = 0
  for (const [id, score] of scores) {
    // A non-finite score is not evidence of relevance; an ACTIVE floor drops it (with the floor off
    // it stays and `fuse` maps it to 0, unchanged from before).
    if (passesFloor(score, floor)) out.set(id, score)
    else dropped += 1
  }
  return { scores: out, dropped }
}

/**
 * How many distinct query terms `text` carries.
 *
 * Substring containment, case-insensitively: FTS5's trigram tokenizer matches a quoted phrase by
 * consecutive trigrams and is ASCII-case-insensitive, which is the same predicate as "the term
 * occurs in the text". `relevanceTerms` lowercases its latin words, so the comparison has to.
 */
export function countMatchedTerms(text: string, terms: readonly string[]): number {
  if (text === '') return 0
  const haystack = text.toLowerCase()
  let matched = 0
  for (const term of terms) if (haystack.includes(term)) matched += 1
  return matched
}

/**
 * Apply the per-row FTS floor to one FTS leg's scores.
 *
 * The terms come from `relevanceTerms(query)` (latin words ≥ 5 chars + every CJK 3-gram) — the same
 * tokenisation the conditional-hint probe uses, so "relevant enough" means one thing in this repo.
 * A query with NO such term is not graded at all: there is nothing to count, and dropping every row
 * on a technicality would turn a 3–4 char latin query (`buildFtsQuery` still emits it) into silence.
 *
 * The bar itself is {@link effectiveTermFloor}: a query that can only produce one term (a 3-char CJK
 * query is one trigram) is measured against that one term, not against a configured 2 it could never
 * reach.
 */
export function applyTermFloor(
  scores: Map<number, number>,
  texts: Map<number, string>,
  query: string,
  floor: number,
): { scores: Map<number, number>; dropped: number } {
  if (!(floor > 0) || scores.size === 0) return { scores, dropped: 0 }
  const terms = relevanceTerms(query)
  if (terms.length === 0) return { scores, dropped: 0 }
  const effective = effectiveTermFloor(floor, terms.length)
  const out = new Map<number, number>()
  let dropped = 0
  for (const [id, score] of scores) {
    if (passesFloor(countMatchedTerms(texts.get(id) ?? '', terms), effective)) out.set(id, score)
    else dropped += 1
  }
  return { scores: out, dropped }
}

/** Sum per-leg drop counts (the cross-store result merges both stores' reports). */
export function mergeFloorDrops(
  ...parts: readonly (RetrievalFloorDrops | undefined)[]
): RetrievalFloorDrops {
  const out = emptyFloorDrops()
  for (const part of parts) {
    if (part === undefined) continue
    out.semantic += part.semantic
    out.fts += part.fts
    out.jaccard += part.jaccard
    out.hrr += part.hrr
  }
  return out
}

/** Sum every leg of one drop report (the retry decision and the health counter both read it). */
export function totalFloorDrops(drops: RetrievalFloorDrops): number {
  return drops.semantic + drops.fts + drops.jaccard + drops.hrr
}
