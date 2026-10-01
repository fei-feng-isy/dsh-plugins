/**
 * `facts` — the memory store's main table.
 *
 * Started with the READ paths the detector, the diagnostics and the clock self-heal need;
 * the write path (`persistFact`, archive/restore/feedback, vector repair) moves here next, so
 * the store ends up holding business rules only and no SQL. See DESIGN §19.
 */
import type { Db } from '../port.js'
import { batches } from '../chunk.js'
import { ENTITY_EXTRACTOR_VERSION } from '../../entities/extract.js'

/**
 * Every `facts` column EXCEPT the two BLOBs (`hrr_vector` ~8 KB, `semantic_vector` ~2 KB per row).
 *
 * Multi-row reads that only need scalars used to be `SELECT *`, so a page of the admin list and
 * every recall's trust settlement dragged the whole vector corpus through the driver — tens of
 * megabytes per query at 33k facts, for columns the caller never looked at. The vector reads that DO
 * want them keep their own explicit projections (`activeVectorRows`, `hrrRowsForFacts`).
 *
 * `getById` deliberately still selects everything: `restore` re-indexes the persisted vector it
 * reads off that one row.
 *
 * `test/db_lifecycle.spec.ts` asserts this list against `PRAGMA table_info(facts)`, so a new column
 * fails a test instead of silently vanishing from these two reads.
 */
export const FACT_COLUMNS_NO_BLOB = `fact_id, content, category, tags, trust_score, settle_clock,
    pinned, pinned_at, bonus_count, bonus_window_at, last_reinforced_at, archived_clock,
    retrieval_count, helpful_count, last_retrieved_at, embedding_model, vector_store, status,
    supersedes_id, entities_version, conflict_checked, archived_at, archive_reason, ttl_days,
    mirror_source, mirror_target, created_at, updated_at`

export class FactsDao {
  constructor(private readonly db: Db) {}

  /**
   * The subset of `ids` that is ACTIVE, batched.
   *
   * The catch-up sweep hands this the whole pending set, which grows with the corpus: one
   * statement would exceed SQLite's bind-parameter cap (see `db/chunk.ts`).
   */
  activeIds(ids: readonly number[]): number[] {
    const out: number[] = []
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.db
        .prepare<{ fact_id: number }>(`SELECT fact_id FROM facts WHERE status = 'active' AND fact_id IN (${placeholders})`)
        .all(...batch)
      for (const row of rows) out.push(row.fact_id)
    }
    return out
  }

  /** One row by id (the store's `getRow`), undefined when absent. */
  getById(factId: number): Record<string, unknown> | undefined {
    return this.db.prepare<Record<string, unknown>>('SELECT * FROM facts WHERE fact_id = ?').get(factId)
  }

  /** Lowest `settle_clock` in the store (trust diagnostics). */
  minSettleClock(): number | null {
    const row = this.db.prepare<{ m: number | null }>('SELECT MIN(settle_clock) AS m FROM facts').get()
    return row?.m ?? null
  }

  /** Vector-index health counters: total rows, rows with a vector, active rows without one. */
  vectorCounts(): { total: number; withSemantic: number; missing: number } {
    const scalar = (sql: string): number => Number(this.db.prepare<{ n: number }>(sql).get()?.n ?? 0)
    return {
      total: scalar('SELECT COUNT(*) AS n FROM facts'),
      withSemantic: scalar('SELECT COUNT(*) AS n FROM facts WHERE semantic_vector IS NOT NULL'),
      missing: scalar("SELECT COUNT(*) AS n FROM facts WHERE semantic_vector IS NULL AND status = 'active'"),
    }
  }

  /** Highest `settle_clock` ever written, or null on an empty store (clock self-heal). */
  maxSettleClock(): number | null {
    const row = this.db.prepare<{ m: number | null }>('SELECT MAX(settle_clock) AS m FROM facts').get()
    return row?.m ?? null
  }

  countAll(): number {
    return Number(this.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM facts').get()?.n ?? 0)
  }

  countByStatus(): { active: number; archived: number } {
    const active = this.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM facts WHERE status = 'active'").get()?.n ?? 0
    const archived = this.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM facts WHERE status = 'archived'").get()?.n ?? 0
    return { active: Number(active), archived: Number(archived) }
  }

  /**
   * Rows by id (trust settlement, hit projection); order is the caller's business.
   *
   * Scalars only — see {@link FACT_COLUMNS_NO_BLOB}. This runs on EVERY recall, over the whole hit
   * set, to read trust and window fields.
   */
  rowsByIds(ids: readonly number[]): Record<string, unknown>[] {
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.db
      .prepare<Record<string, unknown>>(`SELECT ${FACT_COLUMNS_NO_BLOB} FROM facts WHERE fact_id IN (${placeholders})`)
      .all(...ids)
  }

  /** `fact_id → content` for a hit set (never N+1). */
  textsByIds(ids: readonly number[]): Map<number, string> {
    const out = new Map<number, string>()
    if (!ids.length) return out
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare<{ fact_id: number; content: string }>(`SELECT fact_id, content FROM facts WHERE fact_id IN (${placeholders})`)
      .all(...ids)
    for (const row of rows) out.set(row.fact_id, row.content)
    return out
  }

  /** `fact_id → created_at/updated_at` for a hit set (the recall hit's two timestamps). */
  timesByIds(ids: readonly number[]): Map<number, { created_at: string; updated_at: string | null }> {
    const out = new Map<number, { created_at: string; updated_at: string | null }>()
    if (!ids.length) return out
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db
      .prepare<{ fact_id: number; created_at: string | null; updated_at: string | null }>(
        `SELECT fact_id, created_at, updated_at FROM facts WHERE fact_id IN (${placeholders})`,
      )
      .all(...ids)
    for (const row of rows) {
      out.set(row.fact_id, {
        created_at: row.created_at === null ? '' : String(row.created_at),
        updated_at: row.updated_at === null ? null : String(row.updated_at),
      })
    }
    return out
  }

  /** Active rows that carry a persisted vector (index classification). */
  activeVectorRows(): { fact_id: number; semantic_vector: Uint8Array; embedding_model: string | null }[] {
    return this.db
      .prepare<{ fact_id: number; semantic_vector: Uint8Array; embedding_model: string | null }>(
        `SELECT fact_id, semantic_vector, embedding_model FROM facts
          WHERE semantic_vector IS NOT NULL AND status = 'active'`,
      )
      .all()
  }

  /**
   * Facts per archive reason — the trust diagnostics breakdown. One grouped scan rather than
   * a count per reason, because the reasons are few but the table is not.
   */
  archivedByReason(): { reason: string; n: number }[] {
    return this.db
      .prepare<{ reason: string; n: number }>(
        "SELECT archive_reason AS reason, COUNT(*) AS n FROM facts WHERE status = 'archived' GROUP BY archive_reason",
      )
      .all()
  }

  /** Distinct embedding models among active facts (vector diagnostics). */
  embeddingModels(): { model: string | null; n: number }[] {
    return this.db
      .prepare<{ model: string | null; n: number }>(
        "SELECT embedding_model AS model, COUNT(*) AS n FROM facts WHERE embedding_model IS NOT NULL GROUP BY embedding_model",
      )
      .all()
  }

  // ─── write path ──────────────────────────────────────────────────────────

  /**
   * Insert one revision. `INSERT OR IGNORE` is the duplicate-content guard (R1), so the
   * caller must treat `changes === 0` as "content already exists" and fall back to the
   * duplicate branch.
   *
   * `createdAt` is named EXPLICITLY rather than left to the column DEFAULT, because a
   * superseding revision must INHERIT the archived row's `created_at` (the memory's first
   * assertion date, distinct from when its text was rewritten). `updated_at` and
   * `last_retrieved_at` are stamped `CURRENT_TIMESTAMP` in the same statement: a revision
   * whose `created_at` is old must not be judged idle by the next tick, where "idle" reads
   * `COALESCE(last_retrieved_at, created_at)`.
   */
  insertRevision(v: {
    content: string
    category: string
    ttlDays: number
    supersedesId: number | null
    hrr: Uint8Array
    trust: number
    clock: number
    pinned: 0 | 1
    pinnedAt: string | null
    windowAt: string
    createdAt: string
  }): { changes: number; lastInsertRowid: number | bigint } {
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO facts
           (content, category, ttl_days, mirror_source, supersedes_id, hrr_vector,
            trust_score, settle_clock, pinned, pinned_at, bonus_count, bonus_window_at,
            entities_version, conflict_checked, created_at, updated_at, last_retrieved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .run(
        v.content, v.category, v.ttlDays, 'user', v.supersedesId, v.hrr, v.trust, v.clock,
        v.pinned, v.pinnedAt, v.windowAt, ENTITY_EXTRACTOR_VERSION, v.createdAt,
      )
  }

  findByContent(content: string): Record<string, unknown> | undefined {
    return this.db.prepare<Record<string, unknown>>('SELECT * FROM facts WHERE content = ?').get(content)
  }

  // ─── derived state (DESIGN §20.3 / §20.16) ──────────────────────────────

  /**
   * ACTIVE facts whose entity/triple rows were produced by OLDER extraction rules.
   *
   * `entities_version < ?` (not `!= ?` or `IS NULL OR`) so `idx_facts_entities_version` serves it
   * as a range seek; the column is `NOT NULL DEFAULT 0`, so no row can be invisible to it.
   * Budgeted, because the first sweep after a rule change has the whole corpus to do.
   *
   * ORDER BY is the INDEX's own order (`entities_version, fact_id`), deliberately: ordering by
   * `fact_id` alone cannot be served by an index whose first column is a RANGE, so the planner
   * sorted every matching row in a temp b-tree before applying the LIMIT — i.e. the budget
   * bounded what was rebuilt but not what was read. This order also drains the oldest vintage
   * first, which is the more useful one when several rule changes are pending.
   */
  staleEntityRows(version: number, limit: number): { fact_id: number; content: string }[] {
    return this.db
      .prepare<{ fact_id: number; content: string }>(
        `SELECT fact_id, content FROM facts
          WHERE status = 'active' AND entities_version < :version
          ORDER BY entities_version ASC, fact_id ASC LIMIT :limit`,
      )
      .all({ version, limit })
  }

  countStaleEntities(version: number): number {
    return Number(
      this.db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM facts WHERE status = 'active' AND entities_version < :version",
        )
        .get({ version })?.n ?? 0,
    )
  }

  /** Stamp the rules that produced a batch of rows' entity/triple data. */
  setEntitiesVersion(ids: readonly number[], version: number): number {
    let changes = 0
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      changes += this.db
        .prepare(`UPDATE facts SET entities_version = ? WHERE fact_id IN (${placeholders})`)
        .run(version, ...batch).changes
    }
    return changes
  }

  /**
   * Replace a fact's HRR vector.
   *
   * The bundle is derived from the ENTITY NAMES (`encodeHrrEntityVector`), so re-extraction has to
   * rewrite it together with the entity rows — otherwise the probe leg would keep scoring a bundle
   * built from names the fact no longer has.
   */
  setHrrVector(factId: number, bytes: Uint8Array): void {
    this.db.prepare('UPDATE facts SET hrr_vector = ? WHERE fact_id = ?').run(bytes, factId)
  }

  /**
   * ACTIVE facts still awaiting the EMBEDDING leg of the conflict check, in `fact_id` order.
   *
   * The durable replacement for the detector's in-process pending set: a fact written while the
   * embedder was unavailable stays here across restarts instead of being lost (and instead of the
   * set growing without bound).
   *
   * `semantic_vector IS NOT NULL` is a cheap pre-filter, NOT the completion test: the legs are
   * scored from the live index, and a row can hold a vector the index cannot serve (another
   * process's write, a blob this process's index dropped at rebuild). The store stamps only what a
   * pass could actually complete, so such a row stays here until `vectors_fix` re-encodes it.
   *
   * `after` is what keeps that from becoming a stall. The drain takes rows ABOVE the last id it
   * attempted, so a row it cannot complete is stepped over rather than pinned to the head with
   * every row behind it: without this, either the drain re-selects the same un-completable rows
   * forever (and never reaches the rest of the queue), or it has to stamp rows it never checked,
   * which is the defect the completion test exists to prevent.
   *
   * The ORDER BY rides `idx_facts_conflict_pending` (both leading columns are equalities, so the
   * index is already in `fact_id` order) — no temp b-tree, and no blob in the index.
   */
  pendingConflictRows(limit: number, after = 0): { fact_id: number; content: string }[] {
    return this.db
      .prepare<{ fact_id: number; content: string }>(
        `SELECT fact_id, content FROM facts
          WHERE status = 'active' AND conflict_checked = 0 AND semantic_vector IS NOT NULL
            AND fact_id > :after
          ORDER BY fact_id ASC LIMIT :limit`,
      )
      .all({ after, limit })
  }

  /**
   * Facts whose embedding-leg check has not run.
   *
   * Deliberately WITHOUT the `semantic_vector IS NOT NULL` filter that {@link pendingConflictRows}
   * needs: the interesting number is "how far behind is the detector", and with the embedder down
   * that is exactly the population with NO vector — those are waiting for the model (and for
   * `vectors_fix`), so hiding them would report an empty queue while nothing had been checked.
   */
  countPendingConflicts(): number {
    return Number(
      this.db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM facts WHERE status = 'active' AND conflict_checked = 0",
        )
        .get()?.n ?? 0,
    )
  }

  markConflictChecked(ids: readonly number[]): number {
    let changes = 0
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      changes += this.db
        .prepare(`UPDATE facts SET conflict_checked = 1 WHERE fact_id IN (${placeholders})`)
        .run(...batch).changes
    }
    return changes
  }

  /**
   * Send facts BACK to the conflict queue (`conflict_checked = 0`), batched.
   *
   * Needed whenever a fact's derived inputs move, because the verdict is a statement about those
   * inputs: the embedding leg's candidate set comes from `fact_entities`, and the structural leg
   * reads `triples`. A rule change rewrites both (`reindexEntities`), so the old verdict was about
   * a fact that no longer exists — and leaving the marker would keep it while `conflict_pending`
   * reported zero behind. Same rule as {@link setSemanticVector}: what the check SAW changed.
   */
  requeueConflictCheck(ids: readonly number[]): number {
    let changes = 0
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      changes += this.db
        .prepare(`UPDATE facts SET conflict_checked = 0 WHERE fact_id IN (${placeholders})`)
        .run(...batch).changes
    }
    return changes
  }

  /** Revive an archived row (R18/R19: refresh the idle clock, clear the archive bookkeeping). */
  revive(factId: number, category: string, ttlDays: number, trust: number, clock: number): number {
    return this.db
      .prepare(
        `UPDATE facts
            SET status = 'active', archived_at = NULL, archive_reason = NULL, archived_clock = NULL,
                category = ?, ttl_days = ?, trust_score = ?, settle_clock = ?,
                last_retrieved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE fact_id = ? AND status = 'archived'`,
      )
      .run(category, ttlDays, trust, clock, factId).changes
  }

  /** Land explicit category/TTL on a row that already exists (pure duplicate). */
  applyValues(factId: number, category: string, ttlDays: number): void {
    this.db
      .prepare('UPDATE facts SET category = ?, ttl_days = ?, updated_at = CURRENT_TIMESTAMP WHERE fact_id = ?')
      .run(category, ttlDays, factId)
  }

  statusOf(factId: number): string | undefined {
    return this.db.prepare<{ status: string }>('SELECT status FROM facts WHERE fact_id = ?').get(factId)?.status
  }

  /**
   * Land a (re-)encoded vector, and RE-QUEUE the fact for the conflict check.
   *
   * `conflict_checked` answers "has the embedding leg run against the vector in this row?", so a
   * new vector invalidates it: the scorer's second input is the vector, and a re-encode (a model
   * swap, `vectors_fix`, a first encode) is a different question from the one that was answered.
   * Without the reset the marker means "checked in whatever space this row happened to be in when
   * the leg last ran" — and after a model swap the leg had never run in the new space at all,
   * while `conflict_pending` reported zero. See DESIGN §20.16.
   */
  setSemanticVector(factId: number, vector: Uint8Array, model: string, store: string): void {
    this.db
      .prepare('UPDATE facts SET semantic_vector = ?, embedding_model = ?, vector_store = ?, conflict_checked = 0 WHERE fact_id = ?')
      .run(vector, model, store, factId)
  }

  /** Archive with an explicit reason; returns how many rows moved. */
  archive(factId: number, clock: number, reason: string): number {
    return this.db
      .prepare(
        "UPDATE facts SET status = 'archived', archived_at = CURRENT_TIMESTAMP, archived_clock = ?, archive_reason = ? WHERE fact_id = ?",
      )
      .run(clock, reason, factId).changes
  }

  /** The superseded revision leaves the active corpus (`replaced`). */
  archiveSuperseded(factId: number, clock: number): number {
    return this.db
      .prepare(
        "UPDATE facts SET status = 'archived', archived_at = CURRENT_TIMESTAMP, archived_clock = ?, archive_reason = 'replaced' WHERE fact_id = ? AND status = 'active'",
      )
      .run(clock, factId).changes
  }

  linkSupersede(factId: number, supersedesId: number): void {
    this.db.prepare('UPDATE facts SET supersedes_id = ? WHERE fact_id = ? AND supersedes_id IS NULL').run(supersedesId, factId)
  }

  /**
   * Restore an archived fact, settling its trust and refreshing the idle clock (spec §2.6).
   *
   * `AND status = 'archived'` is load-bearing, like the guard on every sibling above: this UPDATE
   * clears the archive bookkeeping and refreshes `last_retrieved_at`, so ungated it would take an
   * ACTIVE row and (a) push its idle clock forward — silently extending the life of a fact the next
   * tick was about to re-archive — and (b) reset `trust_score` to the settled value it computed. It
   * returned `1` either way, so the caller could not tell that a row it never asked about had moved.
   */
  restore(factId: number, trust: number, clock: number): number {
    return this.db
      .prepare(
        `UPDATE facts
            SET status = 'active', archived_at = NULL, archive_reason = NULL, archived_clock = NULL,
                trust_score = ?, settle_clock = ?, last_retrieved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE fact_id = ? AND status = 'archived'`,
      )
      .run(trust, clock, factId).changes
  }

  bumpHelpful(factId: number, delta: number): void {
    this.db.prepare('UPDATE facts SET helpful_count = MAX(0, helpful_count + ?) WHERE fact_id = ?').run(delta, factId)
  }

  /** Feedback outcome: pin at the permanent threshold (trust snaps to 1). */
  pinOutcome(factId: number, clock: number, bonusCount: number, windowAt: string): void {
    this.db
      .prepare(
        `UPDATE facts
            SET trust_score = 1, pinned = 1, pinned_at = COALESCE(pinned_at, CURRENT_TIMESTAMP),
                settle_clock = ?, bonus_count = ?, bonus_window_at = ?, archived_clock = NULL,
                last_reinforced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE fact_id = ?`,
      )
      .run(clock, bonusCount, windowAt, factId)
  }

  /** Feedback outcome: the forget line was reached — archive in the same statement. */
  forgetOutcome(factId: number, trust: number, clock: number, bonusCount: number, windowAt: string): void {
    this.db
      .prepare(
        `UPDATE facts
            SET trust_score = ?, settle_clock = ?, bonus_count = ?, bonus_window_at = ?,
                status = 'archived', archived_at = CURRENT_TIMESTAMP, archived_clock = ?,
                archive_reason = 'forgot', updated_at = CURRENT_TIMESTAMP
          WHERE fact_id = ?`,
      )
      .run(trust, clock, bonusCount, windowAt, clock, factId)
  }

  /** Feedback outcome: reinforced (or decayed) but still active. */
  reinforceOutcome(factId: number, trust: number, clock: number, bonusCount: number, windowAt: string): void {
    this.db
      .prepare(
        `UPDATE facts
            SET trust_score = ?, settle_clock = ?, bonus_count = ?, bonus_window_at = ?,
                last_reinforced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE fact_id = ?`,
      )
      .run(trust, clock, bonusCount, windowAt, factId)
  }

  pin(factId: number, clock: number): number {
    return this.db
      .prepare(
        `UPDATE facts
            SET pinned = 1, pinned_at = COALESCE(pinned_at, CURRENT_TIMESTAMP), trust_score = 1,
                settle_clock = ?, updated_at = CURRENT_TIMESTAMP
          WHERE fact_id = ? AND status = 'active'`,
      )
      .run(clock, factId).changes
  }

  unpin(factId: number, clock: number): number {
    return this.db
      .prepare("UPDATE facts SET pinned = 0, pinned_at = NULL, settle_clock = ?, updated_at = CURRENT_TIMESTAMP WHERE fact_id = ? AND pinned = 1")
      .run(clock, factId).changes
  }

  // ─── read/model paths ────────────────────────────────────────────────────

  /**
   * One page, newest first (the `list` action).
   *
   * TWO shapes, deliberately, because they want different indexes and the shared
   * `(? IS NULL OR category = ?)` form made the planner sort EVERY active row for the unfiltered
   * one (measured 124 ms at 33k facts against 2.1 ms with an index that carries the order):
   *
   *  - unfiltered: pinned to `idx_facts_created(status, created_at DESC)`. `INDEXED BY` is
   *    load-bearing, not decoration — the lifecycle tick runs `PRAGMA optimize`, and once
   *    `sqlite_stat1` exists the planner can switch this query back to `SCAN facts` + a temp
   *    b-tree (verified at 33k rows), silently undoing the fix at exactly the scale it matters.
   *  - category-filtered: left to the planner, which seeks `idx_facts_status_category` and sorts
   *    only that category's rows. Pinning the created-at index here would instead walk the whole
   *    index in order and filter per row (measured 9.8 ms for a category with 17 rows at 33k),
   *    i.e. it would trade a fast path for a slow one to save an index we do not need.
   */
  page(status: string, category: string | undefined, limit: number, offset: number): Record<string, unknown>[] {
    if (category === undefined) {
      return this.db
        .prepare<Record<string, unknown>>(
          `SELECT ${FACT_COLUMNS_NO_BLOB} FROM facts INDEXED BY idx_facts_created
            WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(status, limit, offset)
    }
    return this.db
      .prepare<Record<string, unknown>>(
        `SELECT ${FACT_COLUMNS_NO_BLOB} FROM facts
          WHERE status = ? AND category = ?
          ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(status, category, limit, offset)
  }

  countInStatus(status: string, category?: string): number {
    return Number(
      this.db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM facts WHERE status = ? AND (? IS NULL OR category = ?)')
        .get(status, category ?? null, category ?? null)?.n ?? 0,
    )
  }

  // ─── trust/forgetting diagnostics (the `trust_diagnose` report) ──────────
  //
  // One method per number the report shows, rather than a `count(sql)` passthrough:
  // the point of this layer is that the SQL for a table lives in ITS DAO, and a
  // caller-compiled statement puts the text back in the store (unbatched, untyped, and
  // invisible to any DAO-wide change). The queries are otherwise verbatim.

  /** Every ACTIVE fact (the report's `active`). */
  countActive(): number {
    return Number(this.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM facts WHERE status = 'active'").get()?.n ?? 0)
  }

  /** ACTIVE and permanent — pinned facts are exempt from decay (the report's `pinned`). */
  countPinnedActive(): number {
    return Number(
      this.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM facts WHERE status = 'active' AND pinned = 1").get()?.n ?? 0,
    )
  }

  /**
   * ACTIVE facts whose decayed trust would reach zero within `withinDays` ACTIVE days —
   * i.e. `trust_score - step × (clock - settle_clock) <= step × withinDays`.
   */
  countForgettingWithin(p: { step: number; clock: number; withinDays: number }): number {
    return Number(
      this.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM facts
            WHERE status = 'active' AND pinned = 0
              AND (trust_score - :step * (:clock - settle_clock)) <= :step * :soon`,
        )
        .get({ step: p.step, clock: p.clock, soon: p.withinDays })?.n ?? 0,
    )
  }

  /** Facts with a still-live (calendar 24h) reinforcement window — the per-fact quota. */
  /**
   * The two "reinforcement quota" numbers of `trust_diagnose`, from ONE statement.
   *
   * They share a predicate and used to run it twice — twice the mission for two columns of the same
   * rows. It is now also sargable (`bonus_window_at > datetime('now', '-1 day')`, a plain string
   * comparison on the stored UTC-ISO format) and served by `idx_facts_bonus_window`, instead of
   * calling `julianday` on every row of `facts` (measured 13.4–16.2 ms at 20k, per query).
   */
  bonusStatedToday(): { count: number; granted: number } {
    const row = this.db
      .prepare<{ n: number; granted: number }>(
        // `bonus_count > 0` is load-bearing for the COUNT: `add` opens the window with
        // `bonus_count = 0` (see `insertRevision`), so without it EVERY fact written today counts
        // as "consumed quota today" — `reinforced_today` would mean "facts with a live window",
        // not "facts that actually spent quota" (R17/R24). The SUM is unaffected either way.
        `SELECT COUNT(*) AS n, COALESCE(SUM(bonus_count), 0) AS granted FROM facts
          WHERE bonus_count > 0 AND bonus_window_at IS NOT NULL
            AND bonus_window_at > datetime('now', '-1 day')`,
      )
      .get()
    return { count: Number(row?.n ?? 0), granted: Number(row?.granted ?? 0) }
  }

  /** ACTIVE, unpinned facts unused for `days` CALENDAR days (the idle-archival fallback). */
  countIdleCandidates(days: number): number {
    return Number(
      this.db
        .prepare<{ n: number }>(
          // Same sargable shape as `archiveIdle`, so it rides `idx_facts_idle_cutoff` too — the
          // diagnostic must not cost a full scan of the corpus it is reporting on.
          `SELECT COUNT(*) AS n FROM facts
            WHERE status = 'active' AND pinned = 0
              AND julianday(COALESCE(last_retrieved_at, created_at)) < julianday('now', :modifier)`,
        )
        .get({ modifier: `-${days} days` })?.n ?? 0,
    )
  }

  /**
   * Rows still due for ②③④ after a budgeted tick — what the NEXT pass will archive.
   *
   * One statement over the three predicates (they are alternatives, and the sets are disjoint:
   * a row has either a TTL, a forgotten trust score, or an idle clock). Only called when a step
   * actually filled its budget, so the common tick pays nothing for it.
   */
  countArchiveBacklog(p: { forgetThreshold: number; idleCalendarDays: number }): number {
    const params = { forgetThreshold: p.forgetThreshold, idleModifier: `-${p.idleCalendarDays} days` }
    // UNION of ids, NOT the sum of three counts: a row that is both TTL-expired and idle-due was
    // counted twice, so `archived_deferred` could exceed the number of rows actually pending.
    return Number(
      this.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM (
             SELECT fact_id FROM facts WHERE status = 'active' AND ttl_days > 0
               AND julianday('now') - julianday(created_at) > ttl_days
             UNION SELECT fact_id FROM facts WHERE status = 'active' AND pinned = 0 AND trust_score <= :forgetThreshold
             UNION SELECT fact_id FROM facts WHERE status = 'active' AND pinned = 0
               AND julianday(COALESCE(last_retrieved_at, created_at)) < julianday('now', :idleModifier)
           )`,
        )
        .get(params)?.n ?? 0,
    )
  }

  // ─── vector maintenance ──────────────────────────────────────────────────

  /**
   * Drop unusable (stale-dim) vectors so a re-encode can replace them — and re-queue the same
   * rows, for the same reason {@link setSemanticVector} does: the vector the leg was checked
   * against is gone, so the check has to run again once the replacement lands.
   */
  clearVectors(ids: readonly number[]): number {
    let changes = 0
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      changes += this.db
        .prepare(`UPDATE facts SET semantic_vector = NULL, embedding_model = NULL, conflict_checked = 0 WHERE fact_id IN (${placeholders})`)
        .run(...batch).changes
    }
    return changes
  }

  /** Active facts with no persisted vector — what `vectors_fix` has to encode. */
  missingVectorRows(): { fact_id: number; content: string }[] {
    return this.db
      .prepare<{ fact_id: number; content: string }>(
        "SELECT fact_id, content FROM facts WHERE semantic_vector IS NULL AND status = 'active'",
      )
      .all()
  }

  /** Persisted HRR vectors of the active corpus (probe leg). */
  /**
   * Active HRR rows, NEWEST FIRST when capped.
   *
   * `LIMIT` without `ORDER BY` returns an arbitrary (implementation-defined) slice, which is the
   * wrong way to bound a leg: the caller could not reason about what it had scored, and at 33k
   * facts with a cap of 200 it silently made 32.8k of them unreachable. Recency is the honest
   * prior for a memory store and `idx_facts_created(status, created_at DESC)` already serves it.
   */
  activeHrrRows(category?: string, limit?: number): { fact_id: number; hrr_vector: Uint8Array }[] {
    return this.db
      .prepare<{ fact_id: number; hrr_vector: Uint8Array }>(
        `SELECT fact_id, hrr_vector FROM facts
          WHERE status = 'active' AND hrr_vector IS NOT NULL AND (? IS NULL OR category = ?)
          ORDER BY created_at DESC, fact_id DESC
          LIMIT ?`,
      )
      .all(category ?? null, category ?? null, limit ?? -1)
  }

  /**
   * HRR vectors for a KNOWN candidate set (batched) — the probe leg's normal path.
   *
   * Reading every active row meant decoding one 8 KB blob per fact and running 1024 `cos` calls
   * on each (measured 1.37 s for a probe at 33k facts). The candidates come from the entity leg,
   * which is the same information the HRR bundle encodes (its atoms ARE the entity names), so the
   * narrowing removes the O(N) part rather than a meaningful part of the ranking.
   */
  hrrRowsForFacts(ids: readonly number[], category?: string): { fact_id: number; hrr_vector: Uint8Array }[] {
    if (!ids.length) return []
    const out: { fact_id: number; hrr_vector: Uint8Array }[] = []
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      out.push(
        ...this.db
          .prepare<{ fact_id: number; hrr_vector: Uint8Array }>(
            `SELECT fact_id, hrr_vector FROM facts
              WHERE fact_id IN (${placeholders}) AND status = 'active' AND hrr_vector IS NOT NULL
                AND (? IS NULL OR category = ?)`,
          )
          .all(...batch, category ?? null, category ?? null),
      )
    }
    return out
  }

  /** ACTIVE subset of `ids` in one category (`null` = any) — the semantic leg's filter. */
  activeIdsIn(ids: readonly number[], category?: string): number[] {
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.db
      .prepare<{ fact_id: number }>(
        `SELECT fact_id FROM facts WHERE fact_id IN (${placeholders}) AND status = 'active' AND (? IS NULL OR category = ?)`,
      )
      .all(...ids, category ?? null, category ?? null)
      .map((row) => row.fact_id)
  }

  // ─── recall bookkeeping ──────────────────────────────────────────────────

  /** `retrieval_count` + the "last used" clock (spec §2.5), batched. */
  touchUsage(ids: readonly number[]): void {
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      this.db
        .prepare(`UPDATE facts SET retrieval_count = retrieval_count + 1, last_retrieved_at = CURRENT_TIMESTAMP WHERE fact_id IN (${placeholders})`)
        .run(...batch)
    }
  }

  /** Recall bonus not granted: only the settled trust moved. */
  settleTrust(factId: number, trust: number, clock: number): void {
    this.db.prepare('UPDATE facts SET trust_score = ?, settle_clock = ? WHERE fact_id = ?').run(trust, clock, factId)
  }

  /** Recall bonus granted: trust + the daily quota window. */
  reinforce(factId: number, trust: number, clock: number, bonusCount: number, windowAt: string): void {
    this.db
      .prepare(
        `UPDATE facts
            SET trust_score = ?, settle_clock = ?, bonus_count = ?, bonus_window_at = ?,
                last_reinforced_at = CURRENT_TIMESTAMP
          WHERE fact_id = ?`,
      )
      .run(trust, clock, bonusCount, windowAt, factId)
  }

  /**
   * FTS5 leg over the external-content `facts_fts`.
   *
   * `bm25()` is negative (more negative = better), so the caller negates; a JOIN back to
   * `facts` keeps archived rows and other categories out of the leg.
   */
  ftsSearch(ftsQuery: string, category?: string, limit?: number): { id: number; rank: number }[] {
    return this.db
      .prepare<{ id: number; rank: number }>(
        `SELECT f.rowid AS id, bm25(facts_fts) AS rank FROM facts_fts f
         JOIN facts fa ON fa.fact_id = f.rowid
         WHERE facts_fts MATCH ? AND fa.status = 'active' AND (? IS NULL OR fa.category = ?)
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(ftsQuery, category ?? null, category ?? null, limit ?? -1)
  }

  // ─── lifecycle tick (DESIGN §TRUST_MODEL §4) ─────────────────────────────

  /**
   * ①'s predicate: the active-day counter crossed an integer boundary since the last settle.
   * Kept next to its four siblings so the tick's ORDER and the SQL stay in one place.
   *
   * SARGABLE on purpose. It used to be `CAST(settle_clock AS INTEGER) < CAST(:clock AS INTEGER)`,
   * and a function on the LEFT column forbids a range seek on
   * `idx_facts_trust(status, pinned, settle_clock)` — so every tick read EVERY active unpinned row
   * (measured 13.5 ms per statement at 180k, twice: settle + countPendingSettle).
   *
   * Equivalence for `settle_clock >= 0` (it is an active-day counter, and clocks only advance):
   * with `c = CAST(:clock AS INTEGER)` an integer, `floor(x) < c` ⟺ `x < c` — if `x < c` then
   * `floor(x) <= x < c`; if `x >= c` then `floor(x) >= c`. So dropping the left CAST changes no
   * row, and `settle_clock < c` is a seek + range scan of exactly the pending rows.
   */
  private static readonly SETTLE_PREDICATE =
    "status = 'active' AND pinned = 0 AND settle_clock < CAST(:clock AS INTEGER)"

  /** ① materialize decay, bounded to `budget` rows. */
  settleBudgeted(p: { step: number; clock: number; budget: number }): number {
    return this.db
      .prepare(
        `UPDATE facts
            SET trust_score = MAX(0, MIN(1, trust_score - :step * (:clock - settle_clock))),
                settle_clock = :clock
          WHERE ${FactsDao.SETTLE_PREDICATE}
            AND fact_id IN (SELECT fact_id FROM facts WHERE ${FactsDao.SETTLE_PREDICATE} ORDER BY settle_clock ASC LIMIT :budget)`,
      )
      .run(p).changes
  }

  /** ① materialize decay for every pending row (no budget). */
  settleAll(p: { step: number; clock: number }): number {
    return this.db
      .prepare(
        `UPDATE facts
            SET trust_score = MAX(0, MIN(1, trust_score - :step * (:clock - settle_clock))),
                settle_clock = :clock
          WHERE ${FactsDao.SETTLE_PREDICATE}`,
      )
      .run(p).changes
  }

  /** Rows still awaiting ① (the budget ran out). */
  countPendingSettle(p: { clock: number }): number {
    return Number(this.db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM facts WHERE ${FactsDao.SETTLE_PREDICATE}`).get(p)?.n ?? 0)
  }

  /**
   * ② calendar TTL — explicit instruction, so `pinned` is NOT exempt.
   *
   * `budget` (0 = none) caps how many rows ONE tick may archive: the tick is a single IMMEDIATE
   * transaction shared by several processes, so an unbudgeted pass over a large backlog held the
   * write lock for as long as it took (measured 14400 rows in one tick). The remainder stays due
   * and is reported as a deferred count, then archived by the next tick.
   */
  archiveExpiredByTtl(p: { clock: number; budget?: number }): number[] {
    return this.db
      .prepare<{ fact_id: number }>(
        `UPDATE facts
            SET status = 'archived', archived_at = CURRENT_TIMESTAMP, archived_clock = :clock, archive_reason = 'ttl'
          WHERE status = 'active' AND ttl_days > 0
            AND julianday('now') - julianday(created_at) > ttl_days
            AND (:budget = 0 OR fact_id IN (
                  SELECT fact_id FROM facts WHERE status = 'active' AND ttl_days > 0
                    AND julianday('now') - julianday(created_at) > ttl_days LIMIT :budget))
          RETURNING fact_id`,
      )
      .all({ clock: p.clock, budget: p.budget ?? 0 })
      .map((row) => row.fact_id)
  }

  /**
   * ③ trust-driven forgetting (① already clamped trust to the threshold).
   *
   * Sargable as written (`status`/`pinned` equality + `trust_score <= ?`), and served by
   * `idx_facts_forget(status, pinned, trust_score)`: before that index this statement read every
   * active unpinned row per tick (measured 18.6–27.4 ms at 180k, with ZERO matches).
   */
  archiveForgotten(p: { clock: number; forgetThreshold: number; budget?: number }): number[] {
    return this.db
      .prepare<{ fact_id: number }>(
        `UPDATE facts
            SET status = 'archived', archived_at = CURRENT_TIMESTAMP, archived_clock = :clock, archive_reason = 'forgot'
          WHERE status = 'active' AND pinned = 0 AND trust_score <= :forgetThreshold
            AND (:budget = 0 OR fact_id IN (
                  SELECT fact_id FROM facts WHERE status = 'active' AND pinned = 0 AND trust_score <= :forgetThreshold LIMIT :budget))
          RETURNING fact_id`,
      )
      .all({ clock: p.clock, forgetThreshold: p.forgetThreshold, budget: p.budget ?? 0 })
      .map((row) => row.fact_id)
  }

  /**
   * ④ calendar fallback: never touched for `idle_calendar_days`.
   *
   * The comparison is written as `<expression> < julianday('now', :modifier)` — the same
   * expression `idx_facts_idle_cutoff` indexes — so it is a range seek. The old form
   * (`julianday('now') - <expression> > :days`) called `julianday` on EVERY active row and could
   * not use any index (measured 33–212 ms at 180k).
   */
  archiveIdle(p: { clock: number; idleCalendarDays: number; budget?: number }): number[] {
    return this.db
      .prepare<{ fact_id: number }>(
        `UPDATE facts
            SET status = 'archived', archived_at = CURRENT_TIMESTAMP, archived_clock = :clock, archive_reason = 'idle'
          WHERE status = 'active' AND pinned = 0
            AND julianday(COALESCE(last_retrieved_at, created_at)) < julianday('now', :idleModifier)
            AND (:budget = 0 OR fact_id IN (
                  SELECT fact_id FROM facts WHERE status = 'active' AND pinned = 0
                    AND julianday(COALESCE(last_retrieved_at, created_at)) < julianday('now', :idleModifier) LIMIT :budget))
          RETURNING fact_id`,
      )
      .all({ clock: p.clock, idleModifier: `-${p.idleCalendarDays} days`, budget: p.budget ?? 0 })
      .map((row) => row.fact_id)
  }

  /**
   * ⑤ physical delete of archived rows past the retention window.
   *
   * TWO statements in this order, sharing one predicate:
   *
   *   1. clear `supersedes_id` on the rows about to be deleted. The column self-references
   *      `facts`, and an ACTIVE revision points at the archived revision it replaced, so the
   *      DELETE below failed with `SQLITE_CONSTRAINT_FOREIGNKEY` whenever a revision chain
   *      crossed `purge_after_archived_days`. Because the whole tick is ONE transaction and it
   *      runs from the store's constructor, that failure did not merely skip the purge: it rolled
   *      back settle/TTL/idle with it and left the process unable to start, permanently.
   *   2. delete them.
   *
   * The predicate is built once and interpolated into both statements, so "which rows are
   * purged" cannot drift between the unlink and the delete. Both run inside the caller's
   * IMMEDIATE transaction (`runTrustTick`), so no reader observes the unlinked state.
   */
  purgeArchived(p: { clock: number; enabled: number; purgeAfterDays: number; skipPinned: boolean; budget?: number }): number[] {
    const baseParams = FactsDao.purgeParams(p)
    const purged = new Set<number>()
    for (const branch of FactsDao.purgeBranches(p)) {
      // `budget` (0 = none) bounds how many rows ONE pass deletes, like ②③④: purge is the most
      // expensive single step (its FK cascades seek per deleted row on old databases) and it runs
      // inside the tick's single IMMEDIATE transaction, so an unbudgeted backlog holds the write
      // lock for its whole duration. The bound is applied identically to the unlink and the delete
      // — they share this one predicate text.
      // The bound is a NAMED parameter like the rest of this predicate, not an interpolated number:
      // it was the one place in the codebase that spelled a value into SQL text. `Math.floor` made it
      // safe (a non-number would have been a syntax error, not an injection) but the shape was the
      // thing worth removing.
      const bounded = p.budget !== undefined && p.budget > 0
      const predicate = bounded
        ? `${branch} AND fact_id IN (SELECT fact_id FROM facts WHERE ${branch} LIMIT :budget)`
        : branch
      const params = bounded ? { ...baseParams, budget: Math.floor(p.budget!) } : baseParams
      // Unlink BEFORE deleting, against the SAME predicate text: `supersedes_id` self-references
      // `facts` and an ACTIVE revision points at the archived one it replaced, so a bare DELETE
      // raised SQLITE_CONSTRAINT_FOREIGNKEY, rolled back the whole tick and left the process
      // unable to start (see DESIGN §19). `idx_facts_supersedes` serves this lookup.
      this.db
        .prepare(
          `UPDATE facts SET supersedes_id = NULL
            WHERE supersedes_id IN (SELECT fact_id FROM facts WHERE ${predicate})`,
        )
        .run(params)
      for (const row of this.db
        .prepare<{ fact_id: number }>(`DELETE FROM facts WHERE ${predicate} RETURNING fact_id`)
        .all(params)) {
        purged.add(row.fact_id)
      }
    }
    return [...purged]
  }

  /** The two mutually exclusive purge branches (see `purgeArchived` for why they are split). */
  private static purgeBranches(p: { clock: number; enabled: number; purgeAfterDays: number; skipPinned: boolean }): string[] {
    const pinned = p.skipPinned ? 'AND pinned = 0' : ''
    // The unit differs per branch, so the predicate cannot be one expression: the active-day branch
    // is `archived_clock < clock - days` (a range seek on `idx_facts_purge`), the calendar one is a
    // `julianday` comparison. The old single `CASE` was correct but unindexable.
    return [
      // enabled = 1 AND archived_clock IS NOT NULL → ACTIVE days; strict `> days` becomes the
      // equivalent `archived_clock < clock - days`.
      `status = 'archived' ${pinned} AND :enabled = 1 AND archived_clock IS NOT NULL
         AND archived_clock < :clock - :purgeAfterDays`,
      // everything else → CALENDAR days since `archived_at` (trust off, or a row archived before
      // the clock existed). Mutually exclusive with the branch above.
      `status = 'archived' ${pinned} AND (:enabled = 0 OR archived_clock IS NULL)
         AND julianday(archived_at) < julianday('now', :purgeModifier)`,
    ]
  }

  private static purgeParams(p: { clock: number; enabled: number; purgeAfterDays: number }): Record<string, number | string> {
    return {
      clock: p.clock,
      enabled: p.enabled,
      purgeAfterDays: p.purgeAfterDays,
      purgeModifier: `-${p.purgeAfterDays} days`,
    }
  }

  /** Archived rows still due for ⑤ after a budgeted pass (0 when the pass finished them). */
  countPurgeBacklog(p: { clock: number; enabled: number; purgeAfterDays: number; skipPinned: boolean }): number {
    const [a, b] = FactsDao.purgeBranches(p)
    return Number(
      this.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM (
             SELECT fact_id FROM facts WHERE ${a}
             UNION SELECT fact_id FROM facts WHERE ${b}
           )`,
        )
        .get(FactsDao.purgeParams(p))?.n ?? 0,
    )
  }
}
