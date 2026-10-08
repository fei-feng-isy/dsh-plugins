/**
 * The ONE entity-version sweep both stores run.
 *
 * `entities_version` is the stamp that says "these entity rows were produced by the CURRENT
 * extraction rules". A rule change makes every row carrying an older stamp stale, and the only way
 * to close that gap is to re-extract those rows' text — for memory the entity links, the triples and
 * the HRR bundle derived from them; for knowledge the `chunk_entities` rows. That SKELETON was
 * written twice and drifted apart in exactly the ways a copy drifts: memory had the in-flight guard,
 * the budget clamp and the `{rebuilt, deferred, skipped}` report, while knowledge had the same
 * selection inlined in `reindex` with no guard at all. This module is the one copy; the stores
 * contribute a per-aggregate adapter (which rows, how to extract, what to write) and nothing else.
 *
 * Layering, deliberate: this is an ORCHESTRATION rule, not SQL, so it lives beside `common.ts` and
 * `legs.ts` in `store/` — the DAO layer stays split by aggregate and keeps its own statements
 * (`docs/vector-repair-shared-flow.md` §2 / §7).
 *
 * What must NOT move here: the extractor, the rows a store writes, and that store's side effects.
 * Memory's transaction also replaces triples, moves the HRR bundle and re-queues the conflict check
 * (both conflict legs read what the sweep rebuilt); knowledge replaces `chunk_entities` under
 * `MAX_ENTITIES_PER_CHUNK`. Those are domain semantics, and folding them in would trade one
 * duplicated loop for two conditional branches.
 *
 * @module store/entity_sweep
 */

/**
 * What one bounded sweep pass did.
 *
 * `rebuilt` counts rows this pass re-extracted AND wrote — its batch size when it filled it. The
 * stamp is what makes a corpus current, so a row re-extracted to the same names still counts (and is
 * not selected again); a row whose write FAILED does not, because its old stamp survives. It is
 * deliberately not "rows whose extraction output changed", which no caller could use: they drain a
 * stale corpus by looping until `deferred === 0`.
 */
export interface EntitySweepReport {
  /** Rows this pass re-extracted and wrote (its batch size, when it filled it and nothing failed). */
  rebuilt: number
  /** Rows still carrying an older stamp after this pass. */
  deferred: number
  /** Another pass was already running, so this one did nothing (`deferred` is still current). */
  skipped: boolean
}

/**
 * Rows one sweep pass may rebuild when the caller names no budget.
 *
 * `MemoryStore.reindexEntities` has always defaulted to this, and the CLI passes it explicitly; it
 * lives here so the shared loop and that public re-export cannot drift. Bounds MEMORY, not only
 * mission: a pass selects every chosen row's text before rebuilding the first one.
 */
export const ENTITY_SWEEP_BATCH = 2000

/**
 * A row the sweep may rebuild, as far as the SHARED loop is concerned.
 *
 * Deliberately unconstrained: the loop only routes a row from the selection to the adapter's own
 * `extractAndWriteEntities`, so it must not name any column. Memory's row carries
 * `{ fact_id, content }`, knowledge's `{ chunk_id, text }` — parameterizing the loop over the
 * store's row type is what keeps those names out of the orchestration layer.
 */
export type EntitySweepRow = object

/**
 * Per-store primitives. One adapter per aggregate, deliberately narrow.
 *
 * `staleEntityBatch` returns BOTH the scope's full stale count and a bounded slice in one read: the
 * loop needs the remaining count for its report and the rows for its mission, and two queries would
 * scan the same table twice. The two numbers must describe the same population: `total` counts every
 * row the store's scope considers stale (memory: every ACTIVE fact; knowledge: every chunk of the
 * sweep's domain scope), and `rows` is that population ordered by id, truncated to `limit`.
 */
export interface EntitySweepTarget<T extends EntitySweepRow> {
  /**
   * The scope's full stale count plus at most `limit` of those rows, ordered by id.
   *
   * `limit` is `maxPerPass`; the loop calls this once per pass. Both numbers must describe the SAME
   * population — `total` is every stale row of the store's scope (memory: every ACTIVE fact;
   * knowledge: every chunk of the sweep's domain), `rows` is that population truncated.
   */
  staleEntityBatch(limit: number): { total: number; rows: readonly T[] }
  /**
   * Optional count-only read of the SAME population as {@link staleEntityBatch}'s `total`.
   *
   * It exists for the guard branch, which needs the current deferred count and no rows; absent, that
   * branch falls back to `staleEntityBatch(0).total`. The loop holds the guard for the whole pass and
   * each store is single-threaded, so the count cannot move between the two calls it makes.
   */
  staleEntityCount?(): number
  /** Re-extract one row's text and write that store's derived rows. May throw; the loop isolates. */
  extractAndWriteEntities(row: T): Promise<void>
  /**
   * Log a row this pass could not rebuild. Required, not defaulted: only the store knows which
   * column names the row in its own logs (`fact_id` / `chunk_id`), and a shared warning cannot.
   */
  onRowError(row: T, error: unknown): void
}

/** Everything {@link sweepVersionedEntities} needs beyond the adapter. */
export interface EntitySweepOptions {
  /** Rows this pass may rebuild; defaults to {@link ENTITY_SWEEP_BATCH}, clamped at 0. */
  budget?: number
  /** Return `true` to stop before the next row (plugin unloading, runtime closed). */
  shouldStop?: () => boolean
}

/**
 * The module-level in-flight guard.
 *
 * Held here, not in the stores, because it protects THIS loop: two callers can overlap (the plugin's
 * heartbeat and `maintenance` are both periodic), and a limited ORDERED selection makes two
 * concurrent passes pick the same rows and re-tag them twice. Overlap is not corruption — each row is
 * written in its own transaction — it is duplicated mission in a single-threaded process, and the
 * answer is one pass reporting `skipped`. A `WeakSet` keyed by the caller's guard object keeps the
 * state in this module without adding a mutable field to either hub store, and without a module-level
 * boolean that would make two stores' sweeps block each other.
 *
 * The `guard` argument is therefore an IDENTITY, not a token: a store must pass the SAME object to
 * every call for its whole lifetime (both stores hold one as a private field). Two different objects
 * are two different sweeps and run concurrently — that per-store granularity is the point.
 */
const SWEEPING = new WeakSet<object>()

/**
 * Re-extract the entity rows written by older extraction rules, ONE bounded pass.
 *
 * The contract, in order: take the guard (an overlapping pass reports `skipped` and does nothing);
 * read the scope's stale count and at most `maxPerPass` rows; re-extract each row through the
 * adapter, isolating failures; report `{ rebuilt, deferred, skipped }`.
 *
 * Not an unbounded drain, on purpose: this is reachable from a settings-page button and a periodic
 * heartbeat, so it must not block on a whole stale corpus. Callers that want the corpus current loop
 * until `deferred === 0` (the CLI does).
 *
 * A row whose extraction or write throws is skipped, not fatal: the transaction that stamps the
 * version never ran, so the row is still stale and the NEXT pass retries it — the same retry contract
 * the knowledge store used per chunk. Letting the throw escape would instead abandon the rest of the
 * batch with no report of what was done.
 *
 * @param guard the store's stable in-flight identity (see {@link SWEEPING})
 */
export async function sweepVersionedEntities<T extends EntitySweepRow>(
  target: EntitySweepTarget<T>,
  guard: object,
  opts: EntitySweepOptions = {},
): Promise<EntitySweepReport> {
  const maxPerPass = Math.max(0, Math.floor(opts.budget ?? ENTITY_SWEEP_BATCH))
  if (SWEEPING.has(guard)) {
    const deferred = target.staleEntityCount?.() ?? target.staleEntityBatch(0).total
    return { rebuilt: 0, deferred, skipped: true }
  }
  SWEEPING.add(guard)
  try {
    // One selection serves both the report and the mission: the adapter returns the scope's FULL
    // stale count alongside the rows, so `limit` truncates `rows` without hiding how much is left.
    const { total, rows } = target.staleEntityBatch(maxPerPass)
    let rebuilt = 0
    for (const row of rows) {
      if (opts.shouldStop?.() === true) break
      if (rebuilt >= maxPerPass) break
      try {
        await target.extractAndWriteEntities(row)
      } catch (error) {
        target.onRowError(row, error)
        // Not counted as rebuilt: the version stamp is part of the row's own write, so a failed row
        // is still stale and must stay in `deferred`.
        continue
      }
      rebuilt += 1
    }
    return { rebuilt, deferred: Math.max(0, total - rebuilt), skipped: false }
  } finally {
    SWEEPING.delete(guard)
  }
}
