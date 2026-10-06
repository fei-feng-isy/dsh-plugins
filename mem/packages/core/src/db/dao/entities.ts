/**
 * `entities` + `fact_entities` — the entity graph behind the jaccard / related / reason
 * paths and the contradiction detector's candidate narrowing.
 *
 * Every id list that can grow with the CORPUS goes through `batches()`: a single `IN (…)`
 * would exceed SQLite's bind-parameter cap and, on the write path, silently disable
 * contradiction detection (see `db/chunk.ts`).
 */
import type { Db } from '../port.js'
import { batches, inList } from '../chunk.js'
import type { ExtractedEntity } from '../../entities/extract.js'

export class EntitiesDao {
  constructor(private readonly db: Db) {}

  /**
   * Ensure every entity exists (with the extractor's `type` / `method`) and link the fact to it.
   *
   * `INSERT OR IGNORE` + the `name` uniqueness make this idempotent, which matters because
   * both `add` and the revive branch of `persistFact` call it for the same fact.
   *
   * FIRST WRITE WINS for `entity_type` / `extraction_method`: a name already in the vocabulary
   * keeps the type/method of whichever write introduced it (`INSERT OR IGNORE` skips the row),
   * so an old row is never rewritten by a later fact that happens to share the name. That is the
   * documented trade-off of not bumping `ENTITY_EXTRACTOR_VERSION` — new entities get real
   * values, pre-existing ones keep theirs.
   */
  linkFact(factId: number, entities: readonly ExtractedEntity[]): void {
    if (!entities.length) return
    const ensure = this.db.prepare('INSERT OR IGNORE INTO entities (name, entity_type, extraction_method) VALUES (?, ?, ?)')
    const idOf = this.db.prepare<{ entity_id: number }>('SELECT entity_id FROM entities WHERE name = ?')
    const link = this.db.prepare('INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?, ?)')
    for (const entity of entities) {
      ensure.run(entity.name, entity.type, entity.method)
      const row = idOf.get(entity.name)
      if (row) link.run(factId, row.entity_id)
    }
  }

  /**
   * Drop one fact's links, leaving the shared `entities` vocabulary alone.
   *
   * `linkFact` is additive (`INSERT OR IGNORE`) — correct for the write path, where a fact's links
   * are written once — so RE-EXTRACTION has to clear first or the old names would survive alongside
   * the new ones. Orphaned `entities` rows are harmless: the entity leg joins `fact_entities`, so
   * an unlinked name is unreachable, and a later fact using it reuses the row.
   */
  unlinkFact(factId: number): void {
    this.db.prepare('DELETE FROM fact_entities WHERE fact_id = ?').run(factId)
  }

  /** One fact's entity names (detail / contradiction scoring). */
  namesForFact(factId: number): string[] {
    return this.db
      .prepare<{ name: string }>(
        'SELECT e.name FROM entities e JOIN fact_entities fe ON fe.entity_id = e.entity_id WHERE fe.fact_id = ?',
      )
      .all(factId)
      .map((row) => row.name)
  }

  /** Batched entity bags for a candidate set: `Map<factId, names>` (ids with none get `[]`). */
  bagsForFacts(ids: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>()
    if (!ids.length) return out
    for (const id of ids) out.set(id, [])
    for (const batch of batches(ids)) {
      const { placeholders, values } = inList(batch)
      const rows = this.db
        .prepare<{ fact_id: number; name: string }>(
          `SELECT fe.fact_id AS fact_id, e.name AS name FROM fact_entities fe
           JOIN entities e ON e.entity_id = fe.entity_id
           WHERE fe.fact_id IN (${placeholders})`,
        )
        .all(...values)
      for (const row of rows) out.get(row.fact_id)?.push(row.name)
    }
    return out
  }

  /** How many entities a fact is linked to — the scorer's `|A|`. */
  countForFact(factId: number): number {
    const row = this.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM fact_entities WHERE fact_id = ?').get(factId)
    return Number(row?.n ?? 0)
  }

  /**
   * How many ACTIVE facts carry each name — the entity leg's document frequency.
   *
   * The anchor filter (`store/entity_leg.ts`) needs it to drop corpus-wide words from a query's
   * evidence: a name carried by ~half the store is not discriminative, and treating it as an anchor
   * would make the entity leg drag the whole store in. Only the caller's QUERY names are looked up
   * (a handful), so this is one indexed COUNT per name, not a corpus scan. A name absent from the
   * map has frequency 0, i.e. no active fact carries it and it can never be shared.
   */
  activeDocFrequency(names: readonly string[]): Map<string, number> {
    const out = new Map<string, number>()
    if (!names.length) return out
    const { placeholders, values } = inList(names)
    const rows = this.db
      .prepare<{ name: string; df: number }>(
        `SELECT e.name AS name, COUNT(*) AS df
           FROM entities e
           JOIN fact_entities fe ON fe.entity_id = e.entity_id
           JOIN facts fa ON fa.fact_id = fe.fact_id
          WHERE e.name IN (${placeholders}) AND fa.status = 'active'
          GROUP BY e.name`,
      )
      .all(...values)
    for (const row of rows) out.set(row.name, Number(row.df))
    return out
  }

  /**
   * Candidate facts for the embedding leg, narrowed by the scorer's NECESSARY conditions
   * (see {@link ContradictDetector}): at least `minShared` shared entities and at most
   * `maxEntities` of their own, both active and never the checked fact itself.
   *
   * `INDEXED BY` pins the join order to mine → other → facts. Without statistics SQLite
   * drives from `facts` by status instead (a corpus-sized scan: measured 115 ms with zero
   * candidates on a 300k-fact store, versus 0.13 ms here), and it only collects statistics on
   * the lifecycle tick — so a store that grew since startup would charge every write for the
   * whole corpus. The hint makes the plan independent of ANALYZE timing.
   */
  candidateFacts(factId: number, minShared: number, maxEntities: number): number[] {
    return this.db
      .prepare<{ fact_id: number }>(
        `SELECT other.fact_id AS fact_id
           FROM fact_entities mine
           JOIN fact_entities other INDEXED BY idx_fact_entities_entity
             ON other.entity_id = mine.entity_id
           JOIN facts fa ON fa.fact_id = other.fact_id
          WHERE mine.fact_id = ? AND other.fact_id != ? AND fa.status = 'active'
          GROUP BY other.fact_id
         HAVING COUNT(*) >= ?
            AND (SELECT COUNT(*) FROM fact_entities b WHERE b.fact_id = other.fact_id) BETWEEN ? AND ?`,
      )
      .all(factId, factId, minShared, 2, maxEntities)
      .map((row) => row.fact_id)
  }

  /** Active facts linked to `name`, optionally limited to one category (`related` leg). */
  activeFactsForEntity(name: string, category?: string): number[] {
    return this.db
      .prepare<{ fact_id: number }>(
        `SELECT DISTINCT fe.fact_id AS fact_id FROM fact_entities fe
           JOIN entities e ON e.entity_id = fe.entity_id
           JOIN facts fa ON fa.fact_id = fe.fact_id
          WHERE e.name = ? AND fa.status = 'active' AND (? IS NULL OR fa.category = ?)`,
      )
      .all(name, category ?? null, category ?? null)
      .map((row) => row.fact_id)
  }

  /** Active facts linked to ALL of `names` (AND-join, `reason` leg). */
  activeFactsForAllEntities(names: readonly string[]): number[] {
    if (!names.length) return []
    // `values` is padded to the ladder rung; the HAVING count must use the REAL number of names.
    const { placeholders, values } = inList(names)
    return this.db
      .prepare<{ fact_id: number }>(
        `SELECT fe.fact_id AS fact_id FROM fact_entities fe
           JOIN entities e ON e.entity_id = fe.entity_id
           JOIN facts fa ON fa.fact_id = fe.fact_id
          WHERE e.name IN (${placeholders}) AND fa.status = 'active'
          GROUP BY fe.fact_id HAVING COUNT(DISTINCT e.name) = ?`,
      )
      .all(...values, names.length)
      .map((row) => row.fact_id)
  }

  /** Active facts sharing ANY of `names`, in one category (the entity leg). */
  /**
   * Candidate facts for an entity query, ordered by the leg's score and CAPPED.
   *
   * The cap is the whole point: this leg used to return every fact sharing ANY query entity —
   * unbounded in the corpus (measured 6600 rows for a common phrase at 33k facts, and the fusion
   * step then normalized and sorted all of them).
   *
   * The ordering must be the leg's own score order, or the cap drops the best rows: `fuse` scales
   * by each leg's maximum, and a survivor's scaled value is unchanged only when the ordering (and
   * therefore the maximum) survives the trim. The leg scores anchored Jaccard with a saturating
   * union (`store/entity_leg.ts`): `shared / (queryWidth + min(total - shared, widthCap))`, where `queryWidth` is the
   * query's FULL entity count and `names` is its anchors. That ratio — not the raw shared count — is what this orders by, because a
   * narrower fact sharing one entity can outrank a wide one sharing two. `total ASC` is only a
   * deterministic tie-break among equal ratios. The caller still recomputes the score in JS for the
   * survivors, so one formula stays in charge.
   */
  candidateFactsForAnyEntity(
    names: readonly string[],
    category: string | undefined,
    limit: number,
    queryWidth: number,
    widthCap: number,
    /**
     * P-08 provenance filter (`fact_sources.ref`). `EXISTS`, never a JOIN: a fact with several
     * sources would fan out into several rows and eat the leg's `LIMIT`, silently shrinking recall.
     */
    source?: string,
  ): number[] {
    if (!names.length || limit <= 0) return []
    const { placeholders, values } = inList(names)
    return this.db
      .prepare<{ id: number }>(
        `SELECT fa.fact_id AS id, COUNT(*) AS shared,
                (SELECT COUNT(*) FROM fact_entities x WHERE x.fact_id = fa.fact_id) AS total
           FROM facts fa
           JOIN fact_entities fe ON fe.fact_id = fa.fact_id
           JOIN entities e ON e.entity_id = fe.entity_id
          WHERE e.name IN (${placeholders}) AND fa.status = 'active' AND (? IS NULL OR fa.category = ?)
            AND (? IS NULL OR EXISTS (
                  SELECT 1 FROM fact_sources fs WHERE fs.fact_id = fa.fact_id AND fs.ref = ?
                ))
          GROUP BY fa.fact_id
          ORDER BY (CAST(shared AS REAL) / (? + MIN(total - shared, ?))) DESC, total ASC, fa.fact_id ASC
          LIMIT ?`,
      )
      .all(...values, category ?? null, category ?? null, source ?? null, source ?? null, queryWidth, widthCap, limit)
      .map((row) => row.id)
  }
}
