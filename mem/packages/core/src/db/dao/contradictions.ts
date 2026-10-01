/**
 * `contradiction_log` — the open/resolved conflict pairs.
 *
 * The detector decides WHAT conflicts; this DAO owns how a pair is recorded, deduped (the
 * partial unique index makes `log` idempotent across processes), retired, and listed. Both
 * sides of every read are filtered to ACTIVE facts: the corpus is "changed × active", so a
 * pair whose other side left it is no longer actionable (see DESIGN §11).
 */
import { MAX_REPORTED_CONFLICTS, type ContradictionRecord } from '@avantf/mem-contract'
import type { Db } from '../port.js'
import { batches } from '../chunk.js'

export interface ConflictPair {
  /** Row id of the pair — the handle `contradict_resolve` takes. */
  contradiction_id: number
  fact_a: number
  fact_b: number
  score: number
}

/** A row of `contradiction_log` as stored: the pair plus its adjudication state. */
export interface StoredConflict {
  id: number
  fact_a: number
  fact_b: number
  score: number
  /** 0 = open, 1 = closed (see `resolution` / `loser_fact_id` for how). */
  resolved: number
  resolution: string | null
  loser_fact_id: number | null
  /** `auto` (a fact left the corpus) or `verdict` (explicit adjudication). */
  resolved_by: string | null
}

export class ContradictionsDao {
  constructor(private readonly db: Db) {}

  /**
   * Pairs the detector must NOT log again, normalized `min|max` — open pairs plus pairs closed
   * by an explicit VERDICT.
   *
   * The distinction matters in both directions: a pair retired because a fact left the active
   * corpus must be loggable again after `restore` (that is the documented archive → restore →
   * re-detect cycle), while a pair someone adjudicated as `false_positive` — or as a
   * `true_positive` where both statements stay — must not be resurrected by a later sweep just
   * because a pending id was still queued.
   */
  suppressedPairs(): Set<string> {
    const rows = this.db
      .prepare<{ fact_a: number; fact_b: number }>(
        "SELECT fact_a, fact_b FROM contradiction_log WHERE resolved = 0 OR resolved_by = 'verdict'",
      )
      .all()
    return new Set(rows.map((row) => this.normalize(row.fact_a, row.fact_b)))
  }

  /**
   * Suppressed pairs that NAME `factId` — the write path's version of {@link suppressedPairs}.
   *
   * A single fact's check can only ever consult pairs it is part of (`maybeLog(fid, other, …)`),
   * so reading the whole log was pure waste: measured 60.8 ms per write at 100k open pairs, while
   * this answers in 0.06 ms. Both branches are index seeks on the plain `fact_a`/`fact_b` indexes
   * (the partial UNIQUE index cannot serve the `resolved_by` disjunct).
   */
  suppressedPairsFor(factId: number): Set<string> {
    const rows = this.db
      .prepare<{ fact_a: number; fact_b: number }>(
        `SELECT fact_a, fact_b FROM contradiction_log
           WHERE fact_a = ? AND (resolved = 0 OR resolved_by = 'verdict')
          UNION
         SELECT fact_a, fact_b FROM contradiction_log
           WHERE fact_b = ? AND (resolved = 0 OR resolved_by = 'verdict')`,
      )
      .all(factId, factId)
    return new Set(rows.map((row) => this.normalize(row.fact_a, row.fact_b)))
  }

  log(factA: number, factB: number, score: number): void {
    const [a, b] = this.normalize(factA, factB).split('|').map(Number)
    // OR IGNORE: `idx_contradict_open_pair` enforces one OPEN row per pair across processes,
    // so a concurrent writer that logged the same pair first turns this into a no-op rather
    // than a constraint error (the pair IS open, which is what the caller reports).
    this.db.prepare('INSERT OR IGNORE INTO contradiction_log (fact_a, fact_b, score) VALUES (?, ?, ?)').run(a, b, score)
  }

  resolve(
    id: number,
    resolution: 'true_positive' | 'false_positive',
    loserFactId?: number,
    resolvedBy: 'auto' | 'verdict' = 'verdict',
  ): void {
    this.db
      .prepare(
        `UPDATE contradiction_log
            SET resolved = 1, resolution = ?, resolved_at = CURRENT_TIMESTAMP,
                loser_fact_id = ?, resolved_by = ?
          WHERE id = ?`,
      )
      .run(resolution, loserFactId ?? null, resolvedBy, id)
  }

  /**
   * One stored row by id — what an adjudication needs before it decides anything: which two
   * facts the pair names (so a "loser" can be validated against it) and whether it is still
   * open.
   */
  getById(id: number): StoredConflict | undefined {
    return this.db
      .prepare<StoredConflict>(
        'SELECT id, fact_a, fact_b, score, resolved, resolution, loser_fact_id, resolved_by FROM contradiction_log WHERE id = ?',
      )
      .get(id)
  }

  /**
   * Close every OPEN conflict that involves `factId`.
   *
   * Called when a fact leaves the ACTIVE corpus (archived / superseded / forgotten).
   * Two things depend on it:
   *  - the conflict is no longer actionable, and `list` would otherwise keep showing a
   *    row whose `content_a/content_b` describe a revision that is already archived;
   *  - `update` archives the old revision and writes a NEW fact, so without this every
   *    edit of a conflicting fact appended another permanent open row for the same
   *    logical conflict — and nothing in the API can retire one (there is no
   *    `resolve` action on any tool/CLI/MCP surface).
   *
   * The archived fact is recorded as the loser: it is the revision that left the store.
   */
  resolveForFact(factId: number, resolution: 'true_positive' | 'false_positive' = 'true_positive'): number {
    return this.db
      .prepare(
        `UPDATE contradiction_log
            SET resolved = 1, resolution = ?, resolved_at = CURRENT_TIMESTAMP, loser_fact_id = ?,
                resolved_by = 'auto'
          WHERE resolved = 0 AND (fact_a = ? OR fact_b = ?)`,
      )
      .run(resolution, factId, factId, factId).changes
  }

  /**
   * {@link resolveForFact} for a BATCH of ids leaving the corpus — the lifecycle tick path.
   *
   * The per-id loop cost O(archived × log) plus one statement compile per id: measured 6.3 s for
   * 999 ids at 99k open pairs. Two statements PER BATCH (one per side) do the same mission: each is
   * an index seek on the plain `fact_a`/`fact_b` index, and the side that matched supplies the
   * loser (the fact that actually left the corpus), so the recorded verdict is unchanged.
   */
  resolveForFacts(factIds: readonly number[], resolution: 'true_positive' | 'false_positive' = 'true_positive'): number {
    const ids = [...new Set(factIds)].filter((id) => id > 0)
    if (ids.length === 0) return 0
    let changes = 0
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      changes += this.db
        .prepare(
          `UPDATE contradiction_log
              SET resolved = 1, resolution = ?, resolved_at = CURRENT_TIMESTAMP, loser_fact_id = fact_a,
                  resolved_by = 'auto'
            WHERE resolved = 0 AND fact_a IN (${placeholders})`,
        )
        .run(resolution, ...batch).changes
      changes += this.db
        .prepare(
          `UPDATE contradiction_log
              SET resolved = 1, resolution = ?, resolved_at = CURRENT_TIMESTAMP, loser_fact_id = fact_b,
                  resolved_by = 'auto'
            WHERE resolved = 0 AND fact_b IN (${placeholders})`,
        )
        .run(resolution, ...batch).changes
    }
    return changes
  }

  list(resolved = 0, category?: string, threshold?: number, limit = 10): ContradictionRecord[] {
    return this.db
      .prepare<ContradictionRecord>(
        // ACTIVE facts only: the detector's corpus is "changed × active", so a pair
        // involving an archived/superseded revision is not an open conflict any more —
        // `resolveForFact` normally retires it, and this filter keeps the invariant even
        // for rows written by an older build.
        `SELECT c.id AS contradiction_id, c.fact_a, c.fact_b, c.score, c.detected_at, c.resolved,
                fa.content AS content_a, fb.content AS content_b,
                fa.category AS category_a, fb.category AS category_b
         FROM contradiction_log c
         JOIN facts fa ON fa.fact_id = c.fact_a AND fa.status = 'active'
         JOIN facts fb ON fb.fact_id = c.fact_b AND fb.status = 'active'
         WHERE c.resolved = ? AND (? IS NULL OR fa.category = ? OR fb.category = ?)
           AND (? IS NULL OR c.score >= ?)
         ORDER BY c.score DESC, c.detected_at DESC LIMIT ?`,
      )
      .all(resolved, category ?? null, category ?? null, category ?? null, threshold ?? null, threshold ?? null, limit)
  }

  /**
   * Every OPEN conflict that names `factId`, most severe first, with BOTH sides still active.
   *
   * The detector's own `logged` list carries only what THIS pass inserted (`maybeLog` skips an
   * already-open pair), while a caller asking "what conflicts with the fact I just wrote?"
   * needs the whole open set: an update that merges into an existing fact changes state
   * without inserting a row for a conflict that was already open, and reporting nothing there
   * is a false all-clear.
   */
  openConflictsFor(factId: number, limit = MAX_REPORTED_CONFLICTS): ConflictPair[] {
    return this.db
      .prepare<ConflictPair>(
        // `contradiction_id` travels with the pair so a WRITER can act on it directly: the row id
        // is the only handle `contradict_resolve` takes, and a report that omits it forces a
        // second lookup through `recall.contradict` for a pair the caller just created.
        `SELECT c.id AS contradiction_id, c.fact_a AS fact_a, c.fact_b AS fact_b, c.score AS score
           FROM contradiction_log c
           JOIN facts fa ON fa.fact_id = c.fact_a AND fa.status = 'active'
           JOIN facts fb ON fb.fact_id = c.fact_b AND fb.status = 'active'
          WHERE c.resolved = 0 AND (c.fact_a = ? OR c.fact_b = ?)
          ORDER BY c.score DESC, c.id ASC
          LIMIT ?`,
      )
      .all(factId, factId, limit)
  }

  private normalize(a: number, b: number): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }
}
