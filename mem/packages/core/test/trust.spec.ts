import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type Config } from '@avantf/mem-contract'
import { openMemoryDb, type Db } from '../src/db/conn.js'
import { advancePresence, initClock, readClock } from '../src/lifecycle/presence.js'
import { runTrustTick } from '../src/lifecycle/tick.js'
import {
  applyFeedbackDelta,
  displayTrust,
  effectiveTrust,
  formatUtcTs,
  grantRecallBonus,
  parseUtcTs,
  remainingDays,
  type TrustRow,
} from '../src/lifecycle/trust.js'

let dir: string
let db: Db

const cfg = (over?: Record<string, unknown>): Config => ConfigSchema.parse(over ?? {})
/** The pure math takes the `trust` SECTION, not the whole config. */
const trustCfg = (over?: Record<string, unknown>): Config['trust'] => cfg(over).trust
const row = (over: Partial<TrustRow> = {}): TrustRow => ({
  trust_score: 0.5,
  settle_clock: 0,
  pinned: 0,
  bonus_count: 0,
  bonus_window_at: formatUtcTs(Date.now()),
  status: 'active',
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-trust-'))
  db = openMemoryDb(join(dir, 'memory.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('trust math (pure, TRUST_MODEL.md §2.2)', () => {
  it('decays linearly along the active-day clock, clamped to [0,1]', () => {
    const c = trustCfg({ trust: { decay_per_day: 0.01 } })
    expect(effectiveTrust(row({ trust_score: 0.5, settle_clock: 0 }), 10, c)).toBeCloseTo(0.4, 9)
    expect(effectiveTrust(row({ trust_score: 0.5, settle_clock: 0 }), 90, c)).toBe(0) // 0.5 - 0.9 → clamped
    expect(effectiveTrust(row({ trust_score: 0.2, settle_clock: 100 }), 100, c)).toBeCloseTo(0.2, 9)
  })

  it('returns 1 for pinned and the stored value when trust is disabled (D6/D12)', () => {
    const c = trustCfg({ trust: { decay_per_day: 0.01 } })
    expect(effectiveTrust(row({ trust_score: 0.3, pinned: 1, settle_clock: 0 }), 1000, c)).toBe(1)
    expect(effectiveTrust(row({ trust_score: 0.3, settle_clock: 0 }), 1000, c, false)).toBeCloseTo(0.3, 9)
  })

  it('remaining days = eff / step, null for pinned / archived / disabled (R11)', () => {
    const c = trustCfg({ trust: { decay_per_day: 0.005 } })
    expect(remainingDays(row({ trust_score: 0.5, settle_clock: 0 }), 0, c)).toBeCloseTo(100, 9)
    expect(remainingDays(row({ pinned: 1 }), 0, c)).toBeNull()
    expect(remainingDays(row({ status: 'archived' }), 0, c)).toBeNull()
    expect(remainingDays(row(), 0, c, false)).toBeNull()
  })

  it('R11 display rule: active shows eff(), non-active shows the STORED value', () => {
    const c = trustCfg({ trust: { decay_per_day: 0.01 } })
    // active: decayed
    expect(displayTrust(row({ trust_score: 0.5, settle_clock: 0 }), 10, c)).toBeCloseTo(0.4, 9)
    // archived: the same row must NOT be reported decayed (the formula would say 0.4)
    expect(displayTrust(row({ trust_score: 0.5, settle_clock: 0, status: 'archived' }), 10, c)).toBeCloseTo(0.5, 9)
    // pinned active: 1; disabled: stored
    expect(displayTrust(row({ trust_score: 0.3, pinned: 1, settle_clock: 0 }), 1000, c)).toBe(1)
    expect(displayTrust(row({ trust_score: 0.3, settle_clock: 0 }), 1000, c, false)).toBeCloseTo(0.3, 9)
  })
})

describe('recall reinforcement (pure, TRUST_MODEL.md §2.3)', () => {
  const c = trustCfg({ trust: { decay_per_day: 0.01, recall_delta: 0.03, recall_ceiling: 0.85, recall_daily_cap: 3 } })

  it('≤ recall_floor → straight back to the floor', () => {
    // settled = 0.1 - 0.01 * 5 = 0.05 → the floor branch lifts it to `recall_floor`.
    const o = grantRecallBonus(row({ trust_score: 0.1, settle_clock: 0 }), 5, Date.now(), c)
    expect(o.settled).toBeCloseTo(0.05, 9)
    expect(o.next).toBe(0.5)
    expect(o.granted).toBe(true)
    expect(o.bonusCount).toBe(1)
  })

  it('does not consume quota when there is nothing to gain (R10)', () => {
    const o = grantRecallBonus(row({ trust_score: 0.5, settle_clock: 0 }), 0, Date.now(), c)
    expect(o.settled).toBe(0.5)
    expect(o.next).toBe(0.5)
    expect(o.granted).toBe(false)
    expect(o.bonusCount).toBe(0)
  })

  it('never lowers a trust that feedback pushed above the ceiling (R2)', () => {
    const o = grantRecallBonus(row({ trust_score: 0.88, settle_clock: 0 }), 0, Date.now(), c)
    expect(o.next).toBeGreaterThanOrEqual(0.88)
  })

  it('caps the gain at recall_ceiling and never pins (D11)', () => {
    const o = grantRecallBonus(row({ trust_score: 0.84, settle_clock: 0 }), 0, Date.now(), c)
    expect(o.next).toBeCloseTo(0.85, 9)
  })

  it('enforces the per-fact daily cap and resets on the next calendar day', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    // Start ABOVE the floor (at exactly 0.5 the floor branch is a zero-gain no-op, R10)
    // and anchor the quota window to the synthetic `now` so rollover is deterministic.
    let current = row({ trust_score: 0.6, settle_clock: 0, bonus_window_at: formatUtcTs(now) })
    for (let i = 0; i < 3; i++) {
      const o = grantRecallBonus(current, 0, now, c)
      expect(o.granted).toBe(true)
      current = { ...current, trust_score: o.next, bonus_count: o.bonusCount, bonus_window_at: o.windowAt }
    }
    const capped = grantRecallBonus(current, 0, now, c)
    expect(capped.granted).toBe(false)
    expect(capped.bonusCount).toBe(3)
    // 24h later the window rolls over.
    const nextDay = grantRecallBonus(current, 0, now + 24 * 3600 * 1000 + 1, c)
    expect(nextDay.granted).toBe(true)
    expect(nextDay.bonusCount).toBe(1)
  })

  it('applies marginal decay inside the window', () => {
    const soft = trustCfg({ trust: { recall_delta: 0.03, recall_marginal_decay: 0.5 } })
    const now = Date.parse('2026-01-01T00:00:00Z')
    const start = row({ trust_score: 0.6, bonus_window_at: formatUtcTs(now) })
    const first = grantRecallBonus(start, 0, now, soft)
    const second = grantRecallBonus({ ...start, trust_score: first.next, bonus_count: first.bonusCount, bonus_window_at: first.windowAt }, 0, now, soft)
    const third = grantRecallBonus({ ...start, trust_score: second.next, bonus_count: second.bonusCount, bonus_window_at: second.windowAt }, 0, now, soft)
    expect(first.next - 0.6).toBeCloseTo(0.03, 9)
    expect(second.next - first.next).toBeCloseTo(0.015, 9)
    expect(third.next - second.next).toBeCloseTo(0.0075, 9)
  })

  it('is a no-op for pinned or archived rows', () => {
    expect(grantRecallBonus(row({ pinned: 1 }), 10, Date.now(), c).granted).toBe(false)
    expect(grantRecallBonus(row({ status: 'archived' }), 10, Date.now(), c).granted).toBe(false)
  })
})

describe('explicit feedback (pure, TRUST_MODEL.md §2.4)', () => {
  const c = trustCfg({ trust: { decay_per_day: 0, feedback_delta: 0.05 } })

  it('adds/subtracts the feedback delta', () => {
    expect(applyFeedbackDelta(row({ trust_score: 0.5 }), 0, +1, Date.now(), c).next).toBeCloseTo(0.55, 9)
    expect(applyFeedbackDelta(row({ trust_score: 0.5 }), 0, -1, Date.now(), c).next).toBeCloseTo(0.45, 9)
  })

  it('pins at the permanent threshold and forgets at the forget line', () => {
    const up = applyFeedbackDelta(row({ trust_score: 0.86 }), 0, +1, Date.now(), c)
    expect(up.pin).toBe(true)
    expect(up.next).toBeGreaterThanOrEqual(0.9)
    const down = applyFeedbackDelta(row({ trust_score: 0.04 }), 0, -1, Date.now(), c)
    expect(down.forget).toBe(true)
    expect(down.next).toBe(0)
  })

  it('leaves pinned and archived rows untouched (R7)', () => {
    const pinned = applyFeedbackDelta(row({ pinned: 1, trust_score: 1 }), 5, -1, Date.now(), c)
    expect(pinned.untouched).toBe(true)
    expect(pinned.next).toBe(1)
    const archived = applyFeedbackDelta(row({ status: 'archived', trust_score: 0 }), 5, +1, Date.now(), c)
    expect(archived.untouched).toBe(true)
  })

  it('does not consume the recall window when feedback is uncapped (default)', () => {
    const o = applyFeedbackDelta(row({ trust_score: 0.5, bonus_count: 2 }), 0, +1, Date.now(), c)
    expect(o.bonusCount).toBe(2) // untouched: feedback_daily_cap = 0
  })

  it('honors feedback_daily_cap when configured', () => {
    const capped = trustCfg({ trust: { decay_per_day: 0, feedback_daily_cap: 1 } })
    const o = applyFeedbackDelta(row({ trust_score: 0.5, bonus_count: 1 }), 0, +1, Date.now(), capped)
    expect(o.next).toBeCloseTo(0.5, 9) // no gain past the cap
    expect(o.untouched).toBe(false)
  })
})

describe('active-day clock (presence, TRUST_MODEL.md §2.1)', () => {
  it('starts at 0 and does not age on a first-ever run', () => {
    expect(readClock(db)).toBe(0)
    const first = advancePresence(db, { nowMs: Date.now(), gapCapDays: 1 })
    expect(first.counted).toBe(0)
    expect(first.clock).toBe(0)
  })

  it('counts a 90-day shutdown as ONE day (D2)', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z')
    advancePresence(db, { nowMs: t0, gapCapDays: 1 })
    const back = advancePresence(db, { nowMs: t0 + 90 * 86_400_000, gapCapDays: 1 })
    expect(back.counted).toBe(1)
    expect(back.clock).toBe(1)
    // Immediate follow-up: nothing more to count.
    expect(advancePresence(db, { nowMs: t0 + 90 * 86_400_000 + 1000, gapCapDays: 1 }).counted).toBeLessThan(0.001)
  })

  it('runs 1:1 with the calendar while the process keeps running', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z')
    advancePresence(db, { nowMs: t0, gapCapDays: 1 })
    let clock = 0
    for (let hour = 1; hour <= 24; hour++) clock = advancePresence(db, { nowMs: t0 + hour * 3_600_000, gapCapDays: 1 }).clock
    expect(clock).toBeCloseTo(1, 6)
  })

  it('ignores clock rollback (gap = max(0, …))', () => {
    advancePresence(db, { nowMs: Date.now(), gapCapDays: 1 })
    const before = readClock(db)
    const back = advancePresence(db, { nowMs: Date.now() - 10 * 86_400_000, gapCapDays: 1 })
    expect(back.counted).toBe(0)
    expect(back.clock).toBe(before)
  })

  it('self-heals when the meta row trails the facts (spec §2.1)', () => {
    db.prepare(
      "INSERT INTO facts (content, settle_clock) VALUES ('愈合测试', 20)",
    ).run()
    expect(initClock(db)).toBe(20)
    expect(readClock(db)).toBe(20)
  })

  it('two connections starting together advance the clock only once', () => {
    const db2 = openMemoryDb(join(dir, 'memory.db'))
    const t0 = Date.parse('2026-01-01T00:00:00Z')
    advancePresence(db, { nowMs: t0, gapCapDays: 1 })
    const a = advancePresence(db, { nowMs: t0 + 5 * 86_400_000, gapCapDays: 1 })
    const b = advancePresence(db2, { nowMs: t0 + 5 * 86_400_000 + 50, gapCapDays: 1 })
    expect(a.clock).toBe(1)
    expect(b.counted).toBeLessThan(0.001) // second process sees the fresh last_seen
    db2.close()
  })
})

describe('trust tick (TRUST_MODEL.md §4)', () => {
  const insert = (id: number, trust: number, settle: number, extra: Partial<Record<'pinned' | 'status' | 'ttl_days', number | string>> = {}): void => {
    db.prepare(
      `INSERT INTO facts (fact_id, content, trust_score, settle_clock, pinned, status, ttl_days, bonus_count, bonus_window_at, created_at, last_retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run(id, `fact-${id}`, trust, settle, extra.pinned ?? 0, extra.status ?? 'active', extra.ttl_days ?? 0)
  }

  it('settles only the rows whose active day changed, and reports the skipped budget', () => {
    const c = cfg({ trust: { decay_per_day: 0.01, tick_max_facts: 1, idle_calendar_days: 99999 } })
    insert(1, 0.5, 0)
    insert(2, 0.5, 0)
    insert(3, 0.5, 10) // already settled at the current day → untouched
    const first = runTrustTick(db, c, { clock: 10, budget: 1 })
    expect(first.settled).toBe(1)
    expect(first.skipped).toBe(1)
    expect((db.prepare('SELECT trust_score FROM facts WHERE fact_id = 1').get() as { trust_score: number }).trust_score).toBeCloseTo(0.4, 9)
    // second pass finishes the backlog, then stays idempotent
    expect(runTrustTick(db, c, { clock: 10, budget: 1 }).settled).toBe(1)
    expect(runTrustTick(db, c, { clock: 10, budget: 1 }).settled).toBe(0)
  })

  it('archives at zero (forgot) and never touches pinned rows', () => {
    const c = cfg({ trust: { decay_per_day: 0.01, idle_calendar_days: 99999 } })
    insert(1, 0.05, 0) // 5 active days to zero
    insert(2, 0.5, 0, { pinned: 1 })
    const res = runTrustTick(db, c, { clock: 5, budget: 0 })
    expect(res.archived_forgot).toBe(1)
    expect(res.archived_ids).toEqual([1])
    expect((db.prepare('SELECT status FROM facts WHERE fact_id = 1').get() as { status: string }).status).toBe('archived')
    const pinned = db.prepare('SELECT status, trust_score, settle_clock FROM facts WHERE fact_id = 2').get() as { status: string; trust_score: number; settle_clock: number }
    expect(pinned).toEqual({ status: 'active', trust_score: 0.5, settle_clock: 0 })
  })

  it('is idempotent for a second identical pass', () => {
    const c = cfg({ trust: { decay_per_day: 0.01, idle_calendar_days: 99999 } })
    insert(1, 0.5, 0)
    const a = runTrustTick(db, c, { clock: 10, budget: 0 })
    const b = runTrustTick(db, c, { clock: 10, budget: 0 })
    expect(a.settled).toBe(1)
    expect(b.settled).toBe(0)
    expect(b.archived_forgot).toBe(0)
  })
})

/**
 * Every stored timestamp is UTC, so a stamp with no zone designator must be READ as UTC.
 *
 * `Date.parse` treats a zone-less ISO string as LOCAL time, which would shift every quota window and
 * every decay measurement by the host's UTC offset — invisible in a test suite that runs in UTC and
 * wrong everywhere else.
 */
describe('parseUtcTs', () => {
  it('reads the SQLite shape and a zone-less ISO stamp as UTC', () => {
    const expected = Date.UTC(2026, 8, 20, 10, 0, 0)
    expect(parseUtcTs('2026-09-20 10:00:00')).toBe(expected)
    expect(parseUtcTs('2026-09-20T10:00:00')).toBe(expected)
    expect(parseUtcTs('2026-09-20T10:00:00Z')).toBe(expected)
  })

  it('honours an explicit offset instead of assuming UTC', () => {
    expect(parseUtcTs('2026-09-20T10:00:00+08:00')).toBe(Date.UTC(2026, 8, 20, 2, 0, 0))
  })

  it('is null for missing or unparseable input', () => {
    expect(parseUtcTs(null)).toBeNull()
    expect(parseUtcTs(undefined)).toBeNull()
    expect(parseUtcTs('')).toBeNull()
    expect(parseUtcTs('not a timestamp')).toBeNull()
  })

  it('round-trips through formatUtcTs regardless of the host zone', () => {
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5)
    expect(parseUtcTs(formatUtcTs(ms))).toBe(ms)
  })
})
