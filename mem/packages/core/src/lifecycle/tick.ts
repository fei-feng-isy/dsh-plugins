/**
 * One trust/lifecycle tick (spec docs/TRUST_MODEL.md §4) — five ordered statements:
 *
 *   ① settle   — materialize decay for every row whose ACTIVE DAY changed
 *   ② TTL      — calendar expiry (explicit instruction; pinned is not exempt)
 *   ③ forgot   — trust ≤ forget_threshold after settling (pinned exempt)
 *   ④ idle     — calendar fallback: unused for `idle_calendar_days`
 *   ⑤ purge    — physical delete of archived rows past the window
 *
 * EVERY step is budgeted by the same `tick_max_facts`, not just ①.
 *
 * It used to say "only ① is budgeted; ②③④⑤ only ever touch critical rows", and that reading is
 * wrong in the direction that matters: ②③④⑤ each run inside the tick's ONE `IMMEDIATE` transaction,
 * which holds the write lock for its whole duration, so an unbounded archive or purge pass over a
 * large corpus blocks every other process (and the startup path, which is where the tick runs) for
 * as long as it takes. Bounding each step is what keeps that lock short; `archived_deferred` and
 * `purged_deferred` report what a bounded pass left for the next beat, so a backlog is visible
 * instead of silent. The whole pass is one transaction, and the archived/purged ids are returned so
 * the caller can evict them from the live vector index.
 */
import type { Config } from '@avantf/mem-contract'
import type { Db } from '../db/conn.js'
import { FactsDao } from '../db/dao/facts.js'

export interface TickResult {
  clock: number
  /** Rows materialized by ① (equals "trust actually changed" — see the note in runTrustTick). */
  settled: number
  archived_ttl: number
  archived_forgot: number
  archived_idle: number
  purged: number
  purged_ids: number[]
  archived_ids: number[]
  /** Rows still awaiting ① when the budget ran out (0 for a full pass). */
  skipped: number
  /** Rows still due for ②③④ when the budget ran out (0 when the pass finished them). */
  archived_deferred: number
  /** Rows still due for ⑤ when the budget ran out (0 when the pass finished them). */
  purged_deferred: number
}

export function runTrustTick(db: Db, cfg: Config, opts: { clock: number; budget?: number | null }): TickResult {
  const clock = opts.clock
  const budget = opts.budget ?? cfg.trust.tick_max_facts
  const step = cfg.trust.decay_per_day
  const enabled = cfg.trust.enabled ? 1 : 0
  const trustEnabled = cfg.trust.enabled

  const facts = new FactsDao(db)

  const tx = db.transaction((): TickResult => {
    // ① — settle (budgeted; `tick_max_facts <= 0` means "no budget").
    // D12: `enabled=false` freezes trust entirely — no settle, no decay-driven forgetting.
    const settled = !trustEnabled
      ? 0
      : budget > 0
        ? facts.settleBudgeted({ step, clock, budget })
        : facts.settleAll({ step, clock })
    const skipped = trustEnabled && budget > 0 ? facts.countPendingSettle({ clock }) : 0

    // ②③④ share the SAME budget as ①: the tick is one IMMEDIATE transaction under a 5 s
    // `busy_timeout` shared with the host/CLI/MCP, so one pass may not archive an unbounded
    // backlog. What it does not reach stays due and is reported as `archived_deferred`.
    const archiveBudget = budget > 0 ? budget : 0
    // ② — TTL (calendar, explicit instruction: pinned is NOT exempt; runs even when trust is off).
    const ttlIds = facts.archiveExpiredByTtl({ clock, budget: archiveBudget })
    // ③ — forgot (① already clamped trust to the threshold; trust-driven, so gated by D12).
    const forgotIds = trustEnabled
      ? facts.archiveForgotten({ clock, forgetThreshold: cfg.trust.forget_threshold, budget: archiveBudget })
      : []
    // ④ — idle calendar fallback.
    const idleIds = facts.archiveIdle({ clock, idleCalendarDays: cfg.trust.idle_calendar_days, budget: archiveBudget })
    // Only when a step ran out of budget: the number of rows the next pass still has to archive.
    const hitBudget = archiveBudget > 0
      && (ttlIds.length === archiveBudget || forgotIds.length === archiveBudget || idleIds.length === archiveBudget)
    const deferred = hitBudget
      ? facts.countArchiveBacklog({ forgetThreshold: cfg.trust.forget_threshold, idleCalendarDays: cfg.trust.idle_calendar_days })
      : 0
    // ⑤ — purge (budgeted like ②③④: it is the most expensive single step and it shares the same
    // IMMEDIATE transaction, so a large backlog must not hold the write lock for all of it).
    const purgeArgs = {
      clock,
      enabled,
      purgeAfterDays: cfg.lifecycle.purge_after_archived_days,
      skipPinned: cfg.trust.purge_skips_pinned,
    }
    const purgedIds = facts.purgeArchived({ ...purgeArgs, budget: archiveBudget })
    // `purgeArchived` spends ONE budget across its two mutually exclusive branches, so "deleted
    // exactly the budget" is the exact condition for "there may be more due" — the test this line
    // needs. With the old per-branch `LIMIT` the same pass could delete 2 × budget rows and still
    // fail this equality (each branch short of the budget), which is how a backlog went unreported.
    const purgedDeferred = archiveBudget > 0 && purgedIds.length === archiveBudget
      ? facts.countPurgeBacklog(purgeArgs)
      : 0

    return {
      clock,
      // ① only matches rows whose `settle_clock` day is behind, and every such row has
      // trust > forget_threshold (③ archived the rest last pass) ⇒ the value always moves.
      settled,
      archived_ttl: ttlIds.length,
      archived_forgot: forgotIds.length,
      archived_idle: idleIds.length,
      purged: purgedIds.length,
      purged_ids: purgedIds,
      archived_ids: [...ttlIds, ...forgotIds, ...idleIds],
      skipped,
      // Rows ②③④ left for the next tick because this pass hit its budget (0 when it did not).
      archived_deferred: deferred,
      // Rows ⑤ left for the next tick for the same reason.
      purged_deferred: purgedDeferred,
    }
  })
  return tx.immediate()
}
