/**
 * The leg runner: how BOTH stores turn their own raw leg scores into `HybridLeg`s — plus the two
 * leg SOURCES that were the same flow twice ({@link ftsLeg}, {@link semanticLeg}, §4.6 of
 * `docs/vector-repair-shared-flow.md`). Both stores keep only their DAO/vstore primitives and their
 * scope: the `-rank`/`rank` sign convention, the short-query fallback, `max(50, k)`, the dimension
 * check's error and the Map insertion order live here once.
 *
 * `MemoryStore.searchLegs` and `KnowledgeStore.searchLegs` were the same skeleton written twice —
 * a `leg()` wrapper whose `capped` flag is measured on the RAW (pre-floor) score set, the
 * `applyTermFloor` / `applyScoreFloor` application, and the "semantic backend down ⇒ an EQUAL-WEIGHT
 * empty leg with `droppedByFloor: 0`" fallback — and even the comments explaining them were the same
 * paragraph twice. What legitimately differs is only the leg LIST and where each leg's scores come
 * from: memory computes anchors once and shares them between the entity and HRR legs, has the HRR
 * probe and the time-window scan; knowledge's entity leg is a query-driven async Jaccard. Those stay
 * at the store, exactly as §2 of `docs/vector-repair-shared-flow.md` requires.
 *
 * WHY THE CAP IS MEASURED ON THE RAW SET. `size === cap` is the only observable "this leg was cut"
 * signal (a leg that finished under the cap cannot have been trimmed), and it feeds the health
 * counters so the headroom can be sized from data — what makes the cap measurable instead of a silent
 * quality cliff (DESIGN §20.17). The relevance floors remove the tail anyway, so
 * deriving the flag from the FLOORED size would erase the signal exactly when the cap bound. The
 * floor functions only ever REMOVE entries, so the raw set is the honest measurement.
 *
 * WHY THE SEMANTIC LEG CARRIES NO `capped`. It is capped by the POOL size (`overFetch`), not by
 * `legCap`, so comparing it against `legCap` would report a trim that never happened. That is why
 * {@link LegRunner.semantic} is a separate method rather than a flag on {@link LegRunner.scored}:
 * the absence is structural, not something a caller can forget to set.
 *
 * WHY COMPOSITION. No base class (see the spec §2): the two stores share no construction, DB, DAO or
 * table, and a template-method base class would be a structural rewrite of two hub files. This is
 * the same style as `store/common.ts` — free functions plus a small interface — so a THIRD store can
 * be added by supplying its own leg list and sources and driving THIS runner (proved by a fake
 * third store in `test/legs.spec.ts`).
 *
 * CONCURRENCY lives one level up, in `store/hybrid.ts`'s `runLegs`: it awaits the returned
 * (value | promise) array concurrently and isolates a failing leg to itself. This module only BUILDS
 * legs, so both stores get the same awaiting and isolation by construction.
 *
 * @module store/legs
 */
import { applyScoreFloor, applyTermFloor, type FloorLeg } from './floors.js'
import { RetrievalInputError, type HybridContext, type HybridLeg } from './hybrid.js'
import { buildFtsQuery, type FtsTokenizer } from '../db/tokenizer.js'
import { substringTerms } from './lexical.js'

/**
 * The legs {@link LegRunner.scored} may wrap: those whose raw score has an absolute scale a floor
 * can cut. `semantic` is excluded on purpose — it shares `applyScoreFloor` but must not carry the
 * cap signal, and it is reached through {@link LegRunner.semantic} (see the module comment).
 */
export type ScoredLeg = Exclude<FloorLeg, 'semantic'>

/** Build the leg runner for one query. `legCap` is the cap every non-semantic leg is measured against. */
export interface LegRunner {
  /** The per-leg row cap in force for this query (see `hybrid.ts`'s `legCapFor`). */
  readonly cap: number
  /**
   * Wrap raw scores that have NO floor of their own (memory's HRR probe and time-window scan): the
   * cap signal is attached and nothing else — no `leg` label, no `droppedByFloor`, exactly as those
   * legs have always shipped (they share the entity leg's weight and floor report).
   */
  plain(scores: Map<number, number>, weight: number): HybridLeg
  /**
   * A score-floored leg: `applyScoreFloor` on the raw map, then the cap measured on the RAW map. The
   * floored map is what the leg ships; `raw` is only ever read for the cap.
   */
  scored(name: ScoredLeg, raw: Map<number, number>, weight: number, floor: number): HybridLeg
  /**
   * The FTS leg: the per-row term floor (`applyTermFloor`) needs the candidates' texts, read by the
   * store for the whole raw set (one batched query). The cap is measured on the raw map.
   */
  term(name: 'fts', raw: Map<number, number>, texts: Map<number, string>, query: string, weight: number, floor: number): HybridLeg
  /**
   * The semantic leg: score-floored like {@link scored}, but deliberately WITHOUT a `capped` key
   * (see the module comment). The async model encode itself happens at the store, which is the only
   * place that knows its backend and filters.
   */
  semantic(raw: Map<number, number>, weight: number, floor: number): HybridLeg
  /**
   * The fallback for a DOWN semantic backend: an EMPTY leg at the SAME weight, reporting zero floor
   * drops. Equal weight, not zero: the leg is absent, the weight contract (`RecallResult.weights`)
   * must not move to a fourth value, and the orchestrator already rebalanced the weights for
   * `semAvail === false` (`DEGRADED_WEIGHTS`).
   */
  semanticOff(weight: number): HybridLeg
}

/**
 * The one `capped` derivation (raw-set size vs cap). Kept as a named helper so the three call sites
 * cannot drift into measuring the floored set.
 */
function wasCapped(raw: Map<number, number>, cap: number): boolean {
  return raw.size === cap
}

/**
 * Build the leg runner for one query.
 *
 * The per-store leg ORDER is NOT here: it is the store's "leg list" (see §4.5 阶段 4) because leg
 * index is part of the contract — `hybrid.ts`'s `unionLegs` merges the original and the
 * self-reference rewrite runs BY INDEX, so a store that reordered its legs would silently re-map
 * evidence. What this runner guarantees is that every leg, whichever order it lands in, gets the
 * same wrapper, the same floor order and the same down-semantic fallback.
 */
export function makeLegRunner(ctx: Pick<HybridContext, 'legCap'>): LegRunner {
  const cap = ctx.legCap
  return {
    cap,
    plain(scores, weight) {
      return { weight, scores, capped: wasCapped(scores, cap) }
    },
    scored(name, raw, weight, floor) {
      const floored = applyScoreFloor(raw, floor)
      return { weight, scores: floored.scores, capped: wasCapped(raw, cap), leg: name, droppedByFloor: floored.dropped }
    },
    term(name, raw, texts, query, weight, floor) {
      const floored = applyTermFloor(raw, texts, query, floor)
      return { weight, scores: floored.scores, capped: wasCapped(raw, cap), leg: name, droppedByFloor: floored.dropped }
    },
    semantic(raw, weight, floor) {
      // No `capped` key: the pool caps this leg, not `legCap` (see the module comment).
      const floored = applyScoreFloor(raw, floor)
      return { weight, scores: floored.scores, leg: 'semantic', droppedByFloor: floored.dropped }
    },
    semanticOff(weight) {
      return { weight, scores: new Map<number, number>(), leg: 'semantic', droppedByFloor: 0 }
    },
  }
}

/** The per-store pieces of the FTS leg — see {@link ftsLeg}. `Scope` is opaque to the flow. */
export interface FtsLegOptions<Scope> {
  query: string
  /** The per-leg row cap (the store's `legCap`), handed to whichever DAO statement runs. */
  cap: number
  /** The store's scope shape (`{category, source}` / `{domain, source}`), passed straight through. */
  scope: Scope
  /** The table's own tokenizer, for the `MATCH` build (`buildFtsQuery`). */
  tokenizer: FtsTokenizer
  /** The FTS `MATCH` statement; its `rank` is bm25 (negative = better). */
  search: (ftsQuery: string, scope: Scope, limit: number) => readonly { id: number; rank: number }[]
  /** The short-query LIKE statement; its `rank` counts the terms the row contains (higher = better). */
  substringSearch: (terms: readonly string[], scope: Scope, limit: number) => readonly { id: number; rank: number }[]
}

/**
 * The FTS leg, shared by `MemoryStore.ftsPath` and `KnowledgeStore.ftsPath` (§4.6.1).
 *
 * The two were line-for-line the same flow — `buildFtsQuery` → the `MATCH` statement with NEGATED
 * bm25, else `substringTerms` → the LIKE statement with `rank` — differing only in the DAO and the
 * order its scope parameters bind. Both conventions are load-bearing and preserved verbatim:
 *
 *  - **bm25 is negative** (more negative = better match), so the `MATCH` branch negates it and higher
 *    stays better everywhere downstream;
 *  - **the LIKE `rank`** already counts contained terms, so it is used as-is, keeping the two branches
 *    on the same "higher = better" scale;
 *  - **an empty term list returns the empty map** (`substringTerms` yields none for a query with no
 *    3-char run) — the leg is empty by construction, not by a query that matched nothing.
 *
 * THE SHORT-QUERY FALLBACK. `buildFtsQuery` returning `null` means the query carries no term the
 * trigram index can express (measured: every term in the FTS table is 3 characters), which used to
 * leave this leg empty by construction — the 2-char CJK shape. `substringTerms` is the one finer
 * predicate the FTS5 trigram TABLE still answers (`LIKE '%…%'`), bounded by `cap`; the accuracy guard
 * is the per-row term floor in `applyTermFloor`, which requires the row to CONTAIN the run.
 */
export function ftsLeg<Scope>(opts: FtsLegOptions<Scope>): Map<number, number> {
  const ftsQuery = buildFtsQuery(opts.query, opts.tokenizer)
  if (ftsQuery) {
    // FTS5 bm25() is negative (more negative = better match); negate so higher = better.
    const rows = opts.search(ftsQuery, opts.scope, opts.cap)
    return new Map(rows.map((r) => [r.id, -r.rank]))
  }
  const terms = substringTerms(opts.query)
  if (terms.length === 0) return new Map()
  const rows = opts.substringSearch(terms, opts.scope, opts.cap)
  return new Map(rows.map((r) => [r.id, r.rank]))
}

/** The per-store pieces of the semantic leg — see {@link semanticLeg}. */
export interface SemanticLegOptions {
  query: string
  /** The requested leg size; the pool is over-fetched to `max(50, k)` below. */
  k: number
  /** A caller-encoded vector for this exact query; skips {@link encode}. */
  queryVector?: Float32Array
  /** Publishes the vector actually used, so the relaxed retry reuses it instead of re-encoding. */
  onVector?: (vec: Float32Array) => void
  encode: (query: string) => Promise<Float32Array>
  /** The vstore's width, checked against the vector before it is scored. */
  dim: number
  topk: (vec: Float32Array, k: number) => readonly { id: number; score: number }[]
  /**
   * The store's eligibility filter over the pool ids.
   *
   * `undefined` = **keep everything** — knowledge's "no domain/source asked" short-circuit stays a
   * short-circuit (no lookup runs at all). A returned set is the allow-list; the flow still maps the
   * pool in ITS order, so ids/scores/insertion order are the vstore's.
   */
  filterTopk: (ids: readonly number[]) => ReadonlySet<number> | undefined
}

/**
 * The semantic leg, shared by `MemoryStore.semanticPath` and `KnowledgeStore.semanticPath` (§4.6.2).
 *
 * The flow: encode (unless the caller supplied the vector) → dimension check → publish → over-fetch
 * `max(50, k)` from the vstore → empty pool early-returns → filter → map id→score. Both stores used
 * to spell all of it out; only the filter differs, and that difference lives in `filterTopk`.
 *
 * Preserved verbatim: the `max(50, k)` over-fetch (the pool must leave room for the filter to remove
 * rows without shrinking the leg below `k`), the `RetrievalInputError` and its exact message, the
 * empty-pool early return, and the returned map's insertion order (the vstore's pool order).
 */
export async function semanticLeg(opts: SemanticLegOptions): Promise<Map<number, number>> {
  const vec = opts.queryVector ?? await opts.encode(opts.query)
  // A caller-supplied vector is trusted to come from this backend, but the dimension is cheap to
  // check and a mismatch would otherwise score as garbage. It is an INPUT error, not a leg failure:
  // the orchestrator isolates a dead leg so the query still answers, but a wrong width means the
  // caller encoded with a different backend, and quietly answering from the other legs would hide
  // that for the rest of the session.
  if (vec.length !== opts.dim) {
    throw new RetrievalInputError(`queryVector 维度不符：${vec.length} != ${opts.dim}`)
  }
  opts.onVector?.(vec)
  const topk = opts.topk(vec, Math.max(50, opts.k))
  if (!topk.length) return new Map()
  const allowed = opts.filterTopk(topk.map((t) => t.id))
  const out = new Map<number, number>()
  for (const t of topk) if (allowed === undefined || allowed.has(t.id)) out.set(t.id, t.score)
  return out
}
