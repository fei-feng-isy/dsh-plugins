/**
 * The manual `admin maintenance` entry — now a thin shell over the automatic tick
 * (spec docs/TRUST_MODEL.md §6.1 / M3b).
 *
 * Surface stability (D10): the original report keys are all preserved
 * (`decayed / archived_ttl / archived_age / purged / purged_ids / archived_ids`)
 * and the new detail is purely additive. `archived_age` now means "non-TTL
 * automatic archival" = `forgot + idle`.
 *
 * The `maintenance` action forces a FULL pass (no settle budget); the automatic
 * startup/heartbeat passes use `tick_max_facts`.
 */
import type { Config } from '@avantf/mem-contract'
import type { Db } from '../db/conn.js'
import { readClock } from './presence.js'
import { runTrustTick } from './tick.js'

export interface MaintenanceResult {
  /** Rows whose trust was materialized by the settle sweep (see tick.ts). */
  decayed: number
  archived_ttl: number
  /** Non-TTL automatic archival = `forgot + idle` (kept name, widened meaning). */
  archived_age: number
  purged: number
  /** Fact ids physically deleted by the purge — callers evict their vectors from the live index. */
  purged_ids: number[]
  /** Fact ids archived by this pass — the live index tracks ACTIVE facts only. */
  archived_ids: number[]
  // ── additive detail (D10: new keys only, nothing renamed) ──
  settled: number
  clock: number
  archived_forgot: number
  archived_idle: number
  /** Rows still pending settle because the budget ran out (always 0 for a forced pass). */
  skipped: number
  /** Rows still due for TTL/forgot/idle because the budget ran out (0 for a forced pass). */
  archived_deferred: number
  /** Rows still due for purge when the budget ran out (0 for a forced pass). */
  purged_deferred: number
}

/**
 * Run one lifecycle pass now.
 *
 * @param db - memory DB.
 * @param cfg - resolved config.
 * @param opts.clock - active-day clock to settle at (defaults to the stored clock).
 * @param opts.budget - settle budget; `0` (default here) = full pass.
 */
export function runMaintenance(db: Db, cfg: Config, opts?: { clock?: number; budget?: number | null }): MaintenanceResult {
  const tick = runTrustTick(db, cfg, {
    clock: opts?.clock ?? readClock(db),
    budget: opts?.budget ?? 0,
  })
  return {
    decayed: tick.settled,
    archived_ttl: tick.archived_ttl,
    archived_age: tick.archived_forgot + tick.archived_idle,
    purged: tick.purged,
    purged_ids: tick.purged_ids,
    archived_ids: tick.archived_ids,
    settled: tick.settled,
    clock: tick.clock,
    archived_forgot: tick.archived_forgot,
    archived_idle: tick.archived_idle,
    skipped: tick.skipped,
    archived_deferred: tick.archived_deferred,
    purged_deferred: tick.purged_deferred,
  }
}
