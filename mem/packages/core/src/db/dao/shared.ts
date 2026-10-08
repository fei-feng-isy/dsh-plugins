/**
 * The DAO layer's SHARED ALGORITHMS AND CONTRACTS.
 *
 * DAOs are split by AGGREGATE, not by store (`docs/vector-repair-shared-flow.md` §2), and each
 * aggregate keeps its own SQL text: replacing a readable statement with a generic
 * table/column-parameterized builder would cost the comments' index reasoning without converging a
 * business rule — a `count`/`get`/`delete`/`list` one-liner is a different aggregate's statement,
 * not a fork (§4.5 "明确不收敛").
 *
 * What DOES get one implementation here is the part that is literally "one rule, two tables":
 *
 *  - the entity-candidate leg's SCORE and ORDER, plus its batch/union loop
 *    ({@link entityCandidates} / {@link entityCandidateTail});
 *  - the batched `UPDATE … SET entities_version = ?` ({@link setEntitiesVersionBatch});
 *  - the short-query LIKE fallback's build/guard/double-bind protocol
 *    ({@link likeSubstringLeg});
 *  - the document-frequency query shape ({@link queryDocFrequency});
 *  - the batched "entity-name bags for a row-id set" read ({@link entityBags}).
 *
 * Each caller still supplies its own statement (or its `FROM`/name/filter pieces), so the SQL stays
 * at the call site while the rule lives here exactly once. No base class: every export is a free
 * function, the style `store/common.ts` established.
 */
import type { Db } from '../port.js'
import { batches, inList } from '../chunk.js'
import { likeSubstring } from '../tokenizer.js'

/**
 * The entity-candidate leg's ORDER contract — the tail every candidate statement ends with.
 *
 * The formula is the leg's own score (anchored Jaccard with a saturating union,
 * `store/entity_leg.ts`): `shared / (queryWidth + min(total - shared, widthCap))`. Ordering by it is
 * load-bearing, not cosmetic: `fuse` scales each leg by its maximum, and a survivor's scaled value
 * is unchanged only when the ordering — and therefore the maximum — survives the trim. A narrower
 * row sharing one entity can therefore outrank a wide one sharing two, and the cap keeps it.
 * `total ASC` is only a deterministic tie-break among equal ratios, and the id makes the order total.
 *
 * `idColumn` is the aggregate's own id (`fa.fact_id` / `ce.chunk_id`); that, the `total` subquery's
 * table and the filter predicates are the ONLY differences between the two statements.
 */
export function entityCandidateTail(idColumn: string): string {
  return `GROUP BY ${idColumn}
  ORDER BY (CAST(shared AS REAL) / (? + MIN(total - shared, ?))) DESC, total ASC, ${idColumn} ASC
  LIMIT ?`
}

/** One call to the shared entity-candidate runner — see {@link entityCandidates}. */
export interface EntityCandidateQuery {
  /** The (anchor) names to match: one `IN (…)`, or one per batch when {@link batchNames}. */
  names: readonly string[]
  /**
   * NULL-able filter values bound right AFTER the name list and BEFORE `queryWidth`, in the SQL's
   * own order (both callers spell their predicates as `(? IS NULL OR …)`, so a value the filter
   * does not use is still bound as `null`).
   */
  filterParams: readonly unknown[]
  limit: number
  /** The query's FULL entity count (`W` in `store/entity_leg.ts`); `widthCap` is its saturating cap. */
  queryWidth: number
  widthCap: number
  /**
   * `true` (knowledge): run one statement per name-batch and UNION the ids, because the query can in
   * principle carry more names than a single `IN (…)` may bind. A union of per-batch tops is NOT a
   * top-N, so that caller must enforce its real cap on the union AFTER scoring.
   * `false` (memory): one statement and one exact `LIMIT` — the store's names are request-bounded,
   * so a single `LIMIT` is already the top-N and the cap argument above holds bit-for-bit.
   */
  batchNames: boolean
  /**
   * The full statement for one placeholder list; it must project `id`, `shared`, `total` and end
   * with {@link entityCandidateTail}.
   */
  sql: (placeholders: string) => string
}

/**
 * Run an entity-candidate query: bind order, batching and union are shared; the SQL is the caller's.
 *
 * Bind order (identical in both aggregates): `<names …>, <filterParams …>, queryWidth, widthCap, limit`.
 */
export function entityCandidates(db: Db, q: EntityCandidateQuery): number[] {
  if (!q.names.length || q.limit <= 0) return []
  const out: number[] = []
  // `null` = single-statement mode (no dedupe needed: one row per id, by the GROUP BY).
  const seen = q.batchNames ? new Set<number>() : null
  for (const batch of q.batchNames ? batches(q.names) : [q.names]) {
    const { placeholders, values } = inList(batch)
    const rows = db
      .prepare<{ id: number }>(q.sql(placeholders))
      .all(...values, ...q.filterParams, q.queryWidth, q.widthCap, q.limit)
    for (const row of rows) {
      if (seen !== null) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
      }
      out.push(row.id)
    }
  }
  return out
}

/**
 * The batched `UPDATE … SET entities_version = ?` shared by `FactsDao` and `ChunksDao`.
 *
 * Only the aggregate's `table` / `idColumn` differ. Returns the summed `changes`; the knowledge
 * caller ignores it (its method's signature returns `void`), the memory caller's `number` is
 * unchanged.
 */
export function setEntitiesVersionBatch(
  db: Db,
  table: string,
  idColumn: string,
  ids: readonly number[],
  version: number,
): number {
  let changes = 0
  for (const batch of batches(ids)) {
    const { placeholders, values } = inList(batch)
    changes += db
      .prepare(`UPDATE ${table} SET entities_version = ? WHERE ${idColumn} IN (${placeholders})`)
      .run(version, ...values).changes
  }
  return changes
}

/** The per-aggregate pieces of the document-frequency query — see {@link queryDocFrequency}. */
export interface DocFrequencyQuery {
  /** `FROM …` with its JOINs: everything between the projection and `WHERE`. */
  from: string
  /** The name expression (`e.name`, `name`), used as the alias, the IN predicate and `GROUP BY`. */
  nameExpr: string
  /** A constant predicate ANDed after the IN clause; it must add NO bind parameters. */
  where?: string
}

/**
 * Document frequency — "how many rows carry each name".
 *
 * Shared by `EntitiesDao.activeDocFrequency` and `ChunksDao.docFrequency`; the only difference is
 * the population the caller's `where`/`from` describe (memory counts ACTIVE facts, knowledge has no
 * status column and counts chunks). Only the caller's QUERY names are looked up, so this is one
 * indexed COUNT per name rather than a corpus scan. A name absent from the map has frequency 0.
 */
export function queryDocFrequency(db: Db, names: readonly string[], q: DocFrequencyQuery): Map<string, number> {
  const out = new Map<string, number>()
  if (!names.length) return out
  const { placeholders, values } = inList(names)
  const rows = db
    .prepare<{ name: string; df: number }>(
      `SELECT ${q.nameExpr} AS name, COUNT(*) AS df${q.from}
        WHERE ${q.nameExpr} IN (${placeholders})${q.where === undefined ? '' : ` AND ${q.where}`}
        GROUP BY ${q.nameExpr}`,
    )
    .all(...values)
  for (const row of rows) out.set(row.name, Number(row.df))
  return out
}

/** The two SQL fragments {@link likeSubstringLeg} hands back to the caller's statement builder. */
export interface LikeSubstringFragments {
  /** The `WHERE` predicate (OR of the term patterns). */
  any: string
  /** The score expression (count of the terms the row contains), to be aliased as `rank`. */
  count: string
}

/**
 * The SHORT-QUERY LIKE fallback shared by `FactsDao.ftsSubstringSearch` and
 * `ChunksDao.ftsSubstringSearch`.
 *
 * The predicate text itself already comes from `db/tokenizer.ts#likeSubstring`; this owns the
 * protocol AROUND it, which both copies spelled out:
 *
 *  1. build the fragments — empty terms yield no patterns, which means "match nothing" ⇒ `[]`;
 *  2. `count` lands in the SELECT and `any` in the WHERE, so the SAME pattern list is bound TWICE:
 *     once with the SELECT's placeholders, then — after the caller's filter params — with the
 *     WHERE's;
 *  3. `LIMIT ?` last, defaulting to `-1` (unbounded; the store bounds the leg).
 *
 * `ORDER BY rank DESC, <id> ASC` stays in the caller's SQL: the id column is aggregate-specific and
 * `rank` must read the SELECT alias, so the fragments and the patterns are built once and used twice.
 */
export function likeSubstringLeg(
  db: Db,
  column: string,
  terms: readonly string[],
  buildSql: (fragments: LikeSubstringFragments) => string,
  filterParams: readonly unknown[] = [],
  limit?: number,
): { id: number; rank: number }[] {
  const fragments = likeSubstring(column, terms)
  if (fragments.params.length === 0) return []
  return db
    .prepare<{ id: number; rank: number }>(buildSql(fragments))
    .all(...fragments.params, ...filterParams, ...fragments.params, limit ?? -1)
}

/** The per-aggregate SQL pieces of {@link entityBags}. */
export interface EntityBagsQuery {
  /** `FROM …` with its alias: `fact_entities fe` / `chunk_entities`. */
  table: string
  /** The id expression, also the `WHERE … IN (…)` subject: `fe.fact_id` / `chunk_id`. */
  keyColumn: string
  /** The name expression: `e.name` / `name`. */
  nameColumn: string
  /** The `JOIN` that reaches the name vocabulary, for aggregates that have one (`''`/omitted for `chunk_entities`). */
  joinEntities?: string
  /**
   * The DEFAULT semantics — the one real difference between the two callers, so it is explicit:
   *
   *  - `true` (memory): every requested id is pre-seeded with `[]` in the REQUEST's order, so the
   *    caller can assume `bags.get(id)` exists. Names are appended in row order after that;
   *  - `false` (knowledge): only rows that actually carry entities appear (the caller uses `?? []`).
   */
  seedEmpty: boolean
}

/**
 * Batched entity-name bags for a row-id set: `Map<rowId, names>`.
 *
 * Shared by `EntitiesDao.bagsForFacts` and `ChunksDao.entityBags` (§4.6.3): one `IN (…)` statement
 * per `batches()` slice, rows folded into the map in first-seen order. The SQL SHAPE is the only
 * aggregate-specific part (`table` / `keyColumn` / `nameColumn` / `joinEntities`); the crucial
 * `seedEmpty` difference above is the caller's to declare and stays observable.
 */
export function entityBags(db: Db, ids: readonly number[], q: EntityBagsQuery): Map<number, string[]> {
  const out = new Map<number, string[]>()
  if (q.seedEmpty) for (const id of ids) out.set(id, [])
  for (const batch of batches(ids)) {
    const { placeholders, values } = inList(batch)
    const rows = db
      .prepare<{ id: number; name: string }>(
        `SELECT ${q.keyColumn} AS id, ${q.nameColumn} AS name FROM ${q.table}${q.joinEntities === undefined ? '' : ` ${q.joinEntities}`} WHERE ${q.keyColumn} IN (${placeholders})`,
      )
      .all(...values)
    for (const row of rows) {
      const list = out.get(row.id)
      if (list) list.push(row.name)
      else out.set(row.id, [row.name])
    }
  }
  return out
}
