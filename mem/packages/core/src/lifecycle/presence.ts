/**
 * The ACTIVE-DAY clock (spec docs/TRUST_MODEL.md §2.1).
 *
 * `clock` counts days the system was actually present (startup + heartbeat), with
 * each presence contributing at most `presence.gap_cap_days` days — so a 90-day
 * shutdown ages memories by 1 day, while an always-on system advances 1:1 with the
 * calendar. State lives in the existing `avantf_stats` key/value table.
 *
 * The read-modify-write runs inside an IMMEDIATE transaction: two processes starting
 * together serialize, and the second one sees the fresh `last_seen` (gap ≈ 0), so
 * the clock is never advanced twice.
 */
import type { Db } from '../db/conn.js'
import { FactsDao } from '../db/dao/facts.js'
import { StatsDao } from '../db/dao/stats.js'
import { DAY_MS, formatUtcTs, parseUtcTs } from './trust.js'

export const CLOCK_KEY = 'trust_clock'
export const LAST_SEEN_KEY = 'trust_last_seen'

/** Current active-day count (0 when never initialized). */
export function readClock(db: Db): number {
  const raw = new StatsDao(db).read(CLOCK_KEY)
  const value = raw === null ? 0 : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** Epoch ms of the last presence, or null on a first-ever run. */
export function readLastSeen(db: Db): number | null {
  return parseUtcTs(new StatsDao(db).read(LAST_SEEN_KEY))
}

/**
 * Initialize/repair the clock. If the meta row was lost while facts exist, the
 * clock must not trail their `settle_clock`, or those facts would never settle
 * again (spec §2.1 self-heal).
 */
export function initClock(db: Db): number {
  const stats = new StatsDao(db)
  const clock = Math.max(readClock(db), new FactsDao(db).maxSettleClock() ?? 0)
  stats.write(CLOCK_KEY, String(clock))
  return clock
}

/** Advance the clock for one presence; returns the new clock and what was counted. */
export function advancePresence(db: Db, opts?: { nowMs?: number; gapCapDays?: number }): { clock: number; counted: number } {
  const nowMs = opts?.nowMs ?? Date.now()
  const cap = opts?.gapCapDays ?? 1
  const stats = new StatsDao(db)
  const tx = db.transaction((): { clock: number; counted: number } => {
    const clock = readClock(db)
    const lastSeen = readLastSeen(db)
    const gapDays = lastSeen === null ? 0 : Math.max(0, (nowMs - lastSeen) / DAY_MS)
    const counted = Math.min(gapDays, cap)
    stats.write(CLOCK_KEY, String(clock + counted))
    stats.write(LAST_SEEN_KEY, formatUtcTs(nowMs))
    return { clock: clock + counted, counted }
  })
  // IMMEDIATE: two processes starting together must serialize here, or both would count the
  // same gap.
  return tx.immediate()
}
