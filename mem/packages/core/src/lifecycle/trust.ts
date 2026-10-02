/**
 * Trust & forgetting math — PURE functions, no DB and no clock of their own
 * (`clock` / `nowMs` are always injected, so every rule is unit-testable).
 *
 * Spec: docs/TRUST_MODEL.md §2. Key rules encoded here:
 *  - `eff = pinned ? 1 : clamp(trust − step × (clock − settle_clock), 0, 1)` (§2.2)
 *  - recall only ever RAISES trust (`max(eff, …)`, R2) and never pins (D11)
 *  - zero-gain recalls neither consume quota nor stamp `last_reinforced_at` (R10)
 *  - explicit feedback can pin (snap to 1.0) or forget immediately (§2.4)
 *  - `enabled=false` degrades `eff()` to the stored value (D12)
 */
import type { Config } from '@avantf/mem-contract'

export const DAY_MS = 86_400_000
/** The reinforcement quota window is a CALENDAR day ("每天" is a calendar notion, §2.3). */
const QUOTA_WINDOW_MS = DAY_MS
/** Guard for "did the number actually move" comparisons. */
export const EPSILON = 1e-9

type TrustConfig = Config['trust']

/** The facts-row subset the trust math needs. */
export interface TrustRow {
  trust_score: number
  settle_clock: number
  pinned: number | boolean
  bonus_count: number | null
  bonus_window_at: string | null
  status: string
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

export function isPinned(row: Pick<TrustRow, 'pinned'>): boolean {
  return Number(row.pinned) === 1
}

/**
 * `'YYYY-MM-DD HH:MM:SS'` (SQLite UTC) or ISO → epoch ms; null/garbage → null.
 *
 * A stamp with NO zone designator is read as UTC, not as local time. `Date.parse` treats a zone-less
 * ISO string as LOCAL, and everything in this store is written in UTC (`CURRENT_TIMESTAMP`, and
 * {@link formatUtcTs}), so handing one over as-is would shift every quota window and every decay
 * measurement by the host's UTC offset — a fact reinforced at 23:00 UTC+8 would look reinforced 8
 * hours earlier, and the 24h cap would open or close at the wrong moment. An explicit `Z` or
 * `±HH:MM` is left alone.
 */
export function parseUtcTs(ts: string | null | undefined): number | null {
  if (ts === null || ts === undefined || ts === '') return null
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T')
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`
  const ms = Date.parse(zoned)
  return Number.isFinite(ms) ? ms : null
}

/** Epoch ms → `'YYYY-MM-DD HH:MM:SS'` (the SQLite `CURRENT_TIMESTAMP` shape, UTC). */
export function formatUtcTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

/** eff(f) — the trust a caller should act on right now (spec §2.2). */
export function effectiveTrust(row: TrustRow, clock: number, cfg: TrustConfig, enabled: boolean = cfg.enabled): number {
  if (!enabled) return clamp01(row.trust_score)
  if (isPinned(row)) return 1
  return clamp01(row.trust_score - cfg.decay_per_day * (clock - row.settle_clock))
}

/**
 * What a caller should SEE for a row — the R11 display rule (spec §6):
 * `active` → `eff()`; **non-active → the stored value verbatim** (the decay
 * formula keeps running mathematically for archived rows, so the projection must
 * not use it), and `enabled=false` → stored value (D12).
 */
export function displayTrust(row: TrustRow, clock: number, cfg: TrustConfig, enabled: boolean = cfg.enabled): number {
  if (row.status !== 'active') return clamp01(row.trust_score)
  return effectiveTrust(row, clock, cfg, enabled)
}

/**
 * Remaining active days: `eff / step`. `null` for pinned rows, non-active rows and
 * when trust is disabled — the contract's `remaining_days` (spec §6 / R11).
 */
export function remainingDays(row: TrustRow, clock: number, cfg: TrustConfig, enabled: boolean = cfg.enabled): number | null {
  if (row.status !== 'active' || isPinned(row) || !enabled || cfg.decay_per_day <= 0) return null
  return effectiveTrust(row, clock, cfg, enabled) / cfg.decay_per_day
}

/** The window bookkeeping shared by recall and (optionally) feedback. */
interface Window {
  count: number
  at: string
  reset: boolean
}

function rollWindow(row: TrustRow, nowMs: number): Window {
  const at = row.bonus_window_at
  const started = parseUtcTs(at)
  if (at === null || started === null || nowMs - started >= QUOTA_WINDOW_MS) {
    return { count: 0, at: formatUtcTs(nowMs), reset: true }
  }
  return { count: row.bonus_count ?? 0, at, reset: false }
}

/** Everything a recall write needs to persist (spec §2.3). */
export interface RecallOutcome {
  /** `trust_score` after settling the decay at `clock`. */
  settled: number
  /** Final `trust_score` (equals `settled` when no bonus was granted). */
  next: number
  granted: boolean
  bonusCount: number
  windowAt: string
}

/**
 * Apply one recall to a fact: settle, then grant a bonus inside the daily quota.
 * Returns `next === settled` when the quota is exhausted, the ceiling is reached,
 * the fact is pinned, or the gain would be zero (R2/R10/D11).
 */
export function grantRecallBonus(
  row: TrustRow,
  clock: number,
  nowMs: number,
  cfg: TrustConfig,
  enabled: boolean = cfg.enabled,
): RecallOutcome {
  const settled = effectiveTrust(row, clock, cfg, enabled)
  const window = rollWindow(row, nowMs)
  const inactive = row.status !== 'active' || isPinned(row) || !enabled
  if (inactive || window.count >= cfg.recall_daily_cap) {
    return { settled, next: settled, granted: false, bonusCount: window.count, windowAt: window.at }
  }

  const gain = cfg.recall_delta * Math.pow(cfg.recall_marginal_decay, window.count)
  // "≤ floor ⇒ back to floor", otherwise a capped additive gain — and NEVER below
  // the settled value (a recall must not punish a high-trust fact, R2).
  const next = settled <= cfg.recall_floor
    ? Math.max(settled, cfg.recall_floor)
    : Math.max(settled, Math.min(cfg.recall_ceiling, settled + gain))

  if (next <= settled + EPSILON) {
    // Zero-gain recall: no quota consumed, no `last_reinforced_at` stamp (R10).
    return { settled, next: settled, granted: false, bonusCount: window.count, windowAt: window.at }
  }
  return { settled, next, granted: true, bonusCount: window.count + 1, windowAt: window.at }
}

/** Everything a feedback write needs to persist (spec §2.4). */
interface FeedbackOutcome {
  settled: number
  next: number
  pin: boolean
  forget: boolean
  /** true when the row was left untouched (pinned / archived). */
  untouched: boolean
  bonusCount: number
  windowAt: string
}

/**
 * Apply one explicit `helpful` (+1) / `unhelpful` (-1) step.
 *
 * Pinned and archived rows are untouched (R7): only `helpful_count` changes for
 * them, so a pinned fact can never end up storing 0.95 while displaying 1.0.
 * When `feedback_daily_cap > 0` feedback shares the per-fact 24h window counter.
 */
export function applyFeedbackDelta(
  row: TrustRow,
  clock: number,
  delta: number,
  nowMs: number,
  cfg: TrustConfig,
  enabled: boolean = cfg.enabled,
): FeedbackOutcome {
  const settled = effectiveTrust(row, clock, cfg, enabled)
  // The 24h counter is shared with recall ONLY when a feedback cap is configured;
  // with the default `0` (unlimited feedback) it must not burn recall quota.
  const shared = cfg.feedback_daily_cap > 0
  const window: Window = shared
    ? rollWindow(row, nowMs)
    : { count: row.bonus_count ?? 0, at: row.bonus_window_at ?? formatUtcTs(nowMs), reset: false }
  const untouched = row.status !== 'active' || isPinned(row) || !enabled
  if (untouched) {
    return { settled, next: row.trust_score, pin: false, forget: false, untouched: true, bonusCount: window.count, windowAt: window.at }
  }
  if (shared && window.count >= cfg.feedback_daily_cap) {
    return { settled, next: settled, pin: false, forget: false, untouched: false, bonusCount: window.count, windowAt: window.at }
  }

  let next = clamp01(settled + delta * cfg.feedback_delta)
  const pin = next >= cfg.permanent_threshold
  // Float tolerance: ten 0.05 steps from 0.5 leave ~5.5e-17, not exactly 0.
  const forget = !pin && next <= cfg.forget_threshold + EPSILON
  if (forget) next = cfg.forget_threshold
  return {
    settled,
    next,
    pin,
    forget,
    untouched: false,
    bonusCount: shared ? window.count + 1 : window.count,
    windowAt: window.at,
  }
}
