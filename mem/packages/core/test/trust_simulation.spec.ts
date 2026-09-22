import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { runMaintenance } from '../src/lifecycle/maintenance.js'

/**
 * M5 calibration harness (TRUST_MODEL.md §11): a scripted virtual lifetime that
 * drives the ACTIVE-DAY clock day by day and asserts the population curve is the
 * one the model promises — never-used memories die at ~90 active days, regularly
 * recalled ones stay alive without becoming permanent, explicit feedback pins, and
 * a shut-down period costs exactly one day.
 */
let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-sim-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

const setClock = (day: number): void => {
  rt.db
    .prepare("INSERT INTO avantf_stats (key, value) VALUES ('trust_clock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(day))
}
const statusOf = (id: number): { status: string; trust: number; pinned: number; reason: string | null } =>
  rt.db.prepare('SELECT status, trust_score AS trust, pinned, archive_reason AS reason FROM facts WHERE fact_id = ?').get(id) as never

describe('180-active-day simulation (M5)', () => {
  it('keeps used memories alive, forgets unused ones, pins the explicitly useful', async () => {
    const daily = await rt.remember({ action: 'add', content: '每天都会被用到的事实' })
    const weekly = await rt.remember({ action: 'add', content: '每周会被用到的事实' })
    const never = await rt.remember({ action: 'add', content: '写完就再也没用过的事实' })
    const pinned = await rt.remember({ action: 'add', content: '被明确固化的事实' })
    // Drive to permanence before the simulation starts (8 × helpful = 0.9).
    for (let i = 0; i < 8; i++) await rt.remember({ action: 'helpful', fact_id: pinned.fact_id })
    expect(statusOf(pinned.fact_id).pinned).toBe(1)

    const curve: { day: number; daily: number; weekly: number }[] = []
    for (let day = 1; day <= 180; day++) {
      setClock(day)
      // The reinforcement quota window is a CALENDAR day; a compressed simulation
      // must roll it explicitly (real 24h never pass inside a test).
      rt.db
        .prepare("UPDATE facts SET bonus_window_at = datetime('now', '-25 hours') WHERE fact_id IN (?, ?)")
        .run(daily.fact_id, weekly.fact_id)
      rt.memory.reinforce([daily.fact_id])
      if (day % 7 === 0) rt.memory.reinforce([weekly.fact_id])
      runMaintenance(rt.db, rt.config.common, { clock: day })
      if (day % 30 === 0) curve.push({ day, daily: statusOf(daily.fact_id).trust, weekly: statusOf(weekly.fact_id).trust })
    }

    // eslint-disable-next-line no-console
    console.log('simulation curve:', JSON.stringify(curve))

    // A memory used every day stays comfortably alive and is NOT permanent (recall
    // alone can never reach the pin threshold).
    // One recall a day keeps it at `recall_floor` (the floor branch) — alive but
    // never climbing, and never permanent.
    const d = statusOf(daily.fact_id)
    expect(d.status).toBe('active')
    expect(d.pinned).toBe(0)
    expect(d.trust).toBeGreaterThanOrEqual(0.49)

    // A weekly-used memory is alive too, just lower.
    // Weekly use: it saw-tooths between `recall_floor` and one week of decay
    // (0.5 - 6 * step ≈ 0.467), i.e. always alive.
    const w = statusOf(weekly.fact_id)
    expect(w.status).toBe('active')
    expect(w.trust).toBeGreaterThan(0.45)

    // The never-used one was forgotten at ~90 active days.
    const n = statusOf(never.fact_id)
    expect(n.status).toBe('archived')
    expect(n.reason).toBe('forgot')

    // The pinned one never decayed.
    const p = statusOf(pinned.fact_id)
    expect(p.status).toBe('active')
    expect(p.pinned).toBe(1)
    expect(p.trust).toBe(1)
  })

  it('a 90-day shutdown costs exactly one active day (never-used memory survives)', async () => {
    const a = await rt.remember({ action: 'add', content: '停机前写入的记忆' })
    const rt2 = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      // Simulate: the fact was written 90 calendar days ago; the system has been off.
      rt2.db
        .prepare("UPDATE avantf_stats SET value = datetime('now', '-90 days') WHERE key = 'trust_last_seen'")
        .run()
      const before = rt2.memory.trustDiagnose()
      rt2.memory.trustTick() // one presence after the shutdown
      const after = rt2.memory.trustDiagnose()
      expect(after.clock - before.clock).toBeCloseTo(1, 6) // capped at gap_cap_days
      expect(statusOf(a.fact_id).status).toBe('active')
      expect(statusOf(a.fact_id).trust).toBeCloseTo(0.5 - 0.5 / 90, 6) // one day older only
    } finally {
      rt2.shutdown()
    }
  })

  it('a long-idle system still prunes via the calendar fallback (D4)', async () => {
    const a = await rt.remember({ action: 'add', content: '一年没被想起的记忆' })
    rt.db.prepare("UPDATE facts SET last_retrieved_at = datetime('now', '-400 days') WHERE fact_id = ?").run(a.fact_id)
    const res = runMaintenance(rt.db, rt.config.common, { clock: 0 })
    expect(res.archived_idle).toBe(1)
    expect(statusOf(a.fact_id).reason).toBe('idle')
  })
})
