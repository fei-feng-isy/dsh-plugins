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
 * @module store/floors
 */
import type { RetrievalFloorDrops, RetrievalFloors } from '@avantf/mem-contract'
import { relevanceTerms } from './lexical.js'

/** The retriever knobs the floors read (a structural type so tests can pass a literal). */
export interface FloorConfig {
  min_semantic_similarity: number
  min_fts_terms: number
  min_jaccard: number
}

/** The floor every leg's drops start from. */
export function emptyFloorDrops(): RetrievalFloorDrops {
  return { semantic: 0, fts: 0, jaccard: 0, hrr: 0 }
}

/**
 * Resolve the effective floors for one query (see the module comment for the relaxation rule).
 *
 * Exported so both stores and the tests read the SAME rule rather than re-deriving it — the whole
 * point of hosting the orchestration in one file was that a per-store copy of a rule drifts.
 */
export function resolveFloors(retriever: FloorConfig, semAvail: boolean): RetrievalFloors {
  return {
    semantic: retriever.min_semantic_similarity,
    // `0` is the operator's escape hatch and survives the relaxation; anything positive becomes the
    // degraded bar of 1.
    fts: semAvail ? retriever.min_fts_terms : (retriever.min_fts_terms > 0 ? 1 : 0),
    jaccard: retriever.min_jaccard,
  }
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
    if (score >= floor) out.set(id, score)
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
  const out = new Map<number, number>()
  let dropped = 0
  for (const [id, score] of scores) {
    if (countMatchedTerms(texts.get(id) ?? '', terms) >= floor) out.set(id, score)
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

/** Sum every leg of one drop report (the health counter's per-query contribution). */
export function totalFloorDrops(drops: RetrievalFloorDrops): number {
  return drops.semantic + drops.fts + drops.jaccard + drops.hrr
}
