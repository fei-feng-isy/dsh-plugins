import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema } from '@avantf/mem-contract'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { float32ToBytes } from '../src/db/vectors.js'
import { runMaintenance } from '../src/lifecycle/maintenance.js'

/**
 * TRUST_MODEL.md §12 acceptance checklist — the rows that the pure/store/simulation
 * suites do not already pin down: the R11 display rules, the R12 limbo, the R22
 * calendar purge while disabled, the R25 creation-time quota window, the R5 idle
 * guarantee for ask/chain/reason, and the full `enabled=false` scope table (§7/R14).
 */
let dir: string
let rt: AvantfRuntime

const config = (yaml: string): void => writeFileSync(join(dir, 'configs', 'common.yaml'), yaml, 'utf8')
const open = (): AvantfRuntime => buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })

/** A persisted-vector blob with the configured 768 dim (unit basis vector). */
const fakeVector = (axis: number): Buffer => {
  const v = new Float32Array(768)
  v[axis] = 1
  return float32ToBytes(v)
}

const setClock = (db: AvantfRuntime['db'], day: number): void => {
  db.prepare("INSERT INTO avantf_stats (key, value) VALUES ('trust_clock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(day))
}
const rowOf = (db: AvantfRuntime['db'], id: number): Record<string, unknown> =>
  db.prepare('SELECT * FROM facts WHERE fact_id = ?').get(id) as Record<string, unknown>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-accept-'))
  mkdirSync(join(dir, 'configs'), { recursive: true })  // the config files live in one directory now
  rt = open()
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('§12 acceptance — display rules (R11)', () => {
  it('active shows the effective trust; archived shows the stored one; pinned has no remaining days', async () => {
    const active = await rt.remember({ action: 'add', content: '活跃事实的信任展示' })
    const archived = await rt.remember({ action: 'add', content: '归档事实的信任展示' })
    const pinned = await rt.remember({ action: 'add', content: '永久事实的信任展示' })
    await rt.admin({ action: 'pin', fact_id: pinned.fact_id })
    setClock(rt.db, 45)
    await rt.admin({ action: 'archive', fact_id: archived.fact_id })

    const activeList = await rt.admin({ action: 'list', status: 'active' })
    const a = (activeList.facts as { fact_id: number; trust_score: number; remaining_days: number | null }[]).find((f) => f.fact_id === active.fact_id)!
    const p = (activeList.facts as { fact_id: number; trust_score: number; remaining_days: number | null }[]).find((f) => f.fact_id === pinned.fact_id)!
    const archivedList = await rt.admin({ action: 'list', status: 'archived' })
    const g = (archivedList.facts as { fact_id: number; trust_score: number; remaining_days: number | null }[]).find((f) => f.fact_id === archived.fact_id)!

    // active: eff(45) = 0.5 − (0.5/90)·45 = 0.25 → 0.25 / step = exactly 45 left
    expect(a.trust_score).toBeCloseTo(0.25, 6)
    expect(a.remaining_days).toBeCloseTo(45, 3)
    // archived: the decay formula would report 0.25 — R11 says show the STORED 0.5
    expect(rowOf(rt.db, archived.fact_id).trust_score).toBeCloseTo(0.5, 9)
    expect(g.trust_score).toBeCloseTo(0.5, 9)
    expect(g.remaining_days).toBeNull()
    // pinned: displayed as 1 with no countdown
    expect(p.trust_score).toBe(1)
    expect(p.remaining_days).toBeNull()
    // detail uses the same projection
    expect(rt.memory.get(archived.fact_id)!.trust_score).toBeCloseTo(0.5, 9)
  })
})

describe('§12 acceptance — limbo: pinned ∧ TTL (R12)', () => {
  it('archives on explicit TTL, is never purged, and restore keeps it pinned', async () => {
    const a = await rt.remember({ action: 'add', content: '永久但带 TTL 的事实', ttl_days: 1 })
    await rt.admin({ action: 'pin', fact_id: a.fact_id })
    rt.db.prepare("UPDATE facts SET created_at = datetime('now', '-3 days') WHERE fact_id = ?").run(a.fact_id)

    const res = await rt.admin({ action: 'maintenance' }) as { archived_ids: number[] }
    expect(res.archived_ids).toContain(a.fact_id)
    const archived = rowOf(rt.db, a.fact_id)
    expect(archived.status).toBe('archived')
    expect(archived.archive_reason).toBe('ttl') // the explicit instruction wins over the pin
    expect(Number(archived.pinned)).toBe(1)

    // 400 active days later the purge must still skip it (purge_skips_pinned)
    const purge = await rt.memory.maintenance()
    expect(purge.archived_ids).not.toContain(a.fact_id)
    const later = runMaintenance(rt.db, rt.config.common, { clock: 400, budget: 0 })
    expect(later.purged_ids).not.toContain(a.fact_id)
    expect(rowOf(rt.db, a.fact_id)).toBeDefined()

    expect(rt.memory.restore(a.fact_id)).toBe(true)
    const restored = rowOf(rt.db, a.fact_id)
    expect(restored.status).toBe('active')
    expect(Number(restored.pinned)).toBe(1)
    expect(Number(restored.trust_score)).toBe(1)
  })
})

describe('§12 acceptance — purge is never wrong (R19/R22)', () => {
  it('a manual archive made at a late clock is not purged in the same pass', async () => {
    const a = await rt.remember({ action: 'add', content: '很晚才手动归档的事实' })
    setClock(rt.db, 400)
    await rt.admin({ action: 'archive', fact_id: a.fact_id }) // archived_clock = 400
    const res = runMaintenance(rt.db, rt.config.common, { clock: 400 })
    expect(res.purged_ids).not.toContain(a.fact_id)
    expect(rowOf(rt.db, a.fact_id)).toBeDefined()
  })

  it('with trust disabled, purge falls back to the CALENDAR (R22)', async () => {
    config('trust:\n  enabled: false\n')
    const fresh = await rt.remember({ action: 'add', content: '禁用期间刚归档的事实' })
    const old = await rt.remember({ action: 'add', content: '禁用期间早已归档的事实' })
    await rt.admin({ action: 'archive', fact_id: fresh.fact_id })
    await rt.admin({ action: 'archive', fact_id: old.fact_id })
    // The frozen clock cannot drive the active-day branch: make it look ancient so a
    // clock-based purge would delete BOTH rows, then rely on the calendar fallback.
    rt.db.prepare("UPDATE facts SET archived_at = datetime('now', '-400 days') WHERE fact_id = ?").run(old.fact_id)
    // `enabled=false` + an absurd active-day clock: only the calendar branch can save
    // the fresh row (the frozen clock itself can no longer express "recently archived").
    const disabled = ConfigSchema.parse({ trust: { enabled: false } })
    const res = runMaintenance(rt.db, disabled, { clock: 10_000 })
    expect(res.purged_ids).not.toContain(fresh.fact_id) // archived today → kept
    expect(res.purged_ids).toContain(old.fact_id) // archived 400 calendar days ago → purged
  })
})

describe('§12 acceptance — quota window exists from creation (R25)', () => {
  it('add writes bonus_window_at and the first recall consumes one slot', async () => {
    const a = await rt.remember({ action: 'add', content: '刚创建就进入配额窗口的事实' })
    const created = rowOf(rt.db, a.fact_id)
    expect(created.bonus_window_at).not.toBeNull() // no NULL branch exists (R25)
    expect(Number(created.bonus_count)).toBe(0)

    // Start above the floor so the recall actually gains; one slot is consumed.
    rt.db.prepare('UPDATE facts SET trust_score = 0.6 WHERE fact_id = ?').run(a.fact_id)
    rt.memory.reinforce([a.fact_id])
    const after = rowOf(rt.db, a.fact_id)
    expect(Number(after.bonus_count)).toBe(1)
    expect(Number(after.trust_score)).toBeCloseTo(0.63, 6)
  })
})

describe('§12 acceptance — ask / chain / reason keep a fact alive (R5)', () => {
  it('facts returned by ask, chain or reason are not killed by the idle sweep', async () => {
    const asked = await rt.remember({ action: 'add', content: '张伟管理李娜' })
    const chained = await rt.remember({ action: 'add', content: '李娜管理王强' })
    const reasoned = await rt.remember({ action: 'add', content: '王强负责发布流程' })
    const untouched = await rt.remember({ action: 'add', content: '从没被任何路径用过的事实' })
    // Everything was created "a year ago" — idle would kill it unless the given
    // retrieval path refreshes `last_retrieved_at`.
    rt.db.prepare("UPDATE facts SET created_at = datetime('now', '-400 days'), last_retrieved_at = NULL").run()

    const idsOf = (r: { hits: { ref_id: number }[] }): number[] => r.hits.map((h) => h.ref_id)
    const viaAsk = idsOf(await rt.recall({ action: 'ask', query: '张伟管理谁' }) as { hits: { ref_id: number }[] })
    const viaChain = idsOf(await rt.recall({ action: 'chain', subj: '张伟', pred: '管理', second_pred: '管理' }) as { hits: { ref_id: number }[] })
    const viaReason = idsOf(await rt.recall({ action: 'reason', entities: ['王强'] }) as { hits: { ref_id: number }[] })
    expect(viaAsk).toContain(asked.fact_id)
    expect(viaChain).toContain(chained.fact_id)
    expect(viaReason).toContain(reasoned.fact_id)
    const touched = new Set([...viaAsk, ...viaChain, ...viaReason])
    for (const id of touched) expect(rowOf(rt.db, id).last_retrieved_at).not.toBeNull()

    const res = await rt.admin({ action: 'maintenance' }) as { archived_idle: number }
    expect(res.archived_idle).toBe(1) // only the never-retrieved control fact
    for (const id of touched) expect(rowOf(rt.db, id).status).toBe('active')
    expect(rowOf(rt.db, untouched.fact_id).archive_reason).toBe('idle')
  })
})

describe('§12 acceptance — the tick evicts vectors it archived', () => {
  it('a fact forgotten by the automatic pass leaves the live index', async () => {
    const a = await rt.remember({ action: 'add', content: '会被自动遗忘并驱逐向量的事实' })
    rt.db.prepare('UPDATE facts SET semantic_vector = ? WHERE fact_id = ?').run(fakeVector(5), a.fact_id)
    expect(rt.memory.vectorsDiagnose().indexed).toBe(0) // vec added by hand to the DB only
    const rt2 = open()
    try {
      expect(rt2.memory.vectorsDiagnose().indexed).toBe(1)
      setClock(rt2.db, 90)
      rt2.db.prepare('UPDATE facts SET settle_clock = 0 WHERE fact_id = ?').run(a.fact_id)
      const res = rt2.memory.trustTick()
      expect(res.archived_ids).toContain(a.fact_id)
      expect(rowOf(rt2.db, a.fact_id).archive_reason).toBe('forgot')
      expect(rt2.memory.vectorsDiagnose().indexed).toBe(0) // evicted with the archive
    } finally {
      rt2.shutdown()
    }
  })
})

describe('§7 acceptance — the full enabled=false scope table (R14)', () => {
  beforeEach(() => {
    rt.shutdown()
    config('trust:\n  enabled: false\n')
    rt = open()
  })

  it('freezes presence but still runs TTL / idle / purge and the read paths', async () => {
    const a = await rt.remember({ action: 'add', content: '禁用信任时写入的事实' })
    const before = rt.memory.trustDiagnose().clock
    rt.db.prepare("UPDATE avantf_stats SET value = datetime('now', '-90 days') WHERE key = 'trust_last_seen'").run()
    rt.memory.trustTick()
    expect(rt.memory.trustDiagnose().clock).toBe(before) // presence stopped → clock frozen
    expect(rt.memory.trustDiagnose().enabled).toBe(false)
    expect(rt.memory.get(a.fact_id)!.trust_score).toBeCloseTo(0.5, 9) // read path still works
  })

  it('stops recall reinforcement but still records usage', async () => {
    const a = await rt.remember({ action: 'add', content: '禁用信任时被召回的事实' })
    rt.db.prepare('UPDATE facts SET trust_score = 0.6, last_retrieved_at = NULL WHERE fact_id = ?').run(a.fact_id)
    rt.memory.reinforce([a.fact_id])
    const after = rowOf(rt.db, a.fact_id)
    expect(Number(after.trust_score)).toBeCloseTo(0.6, 9) // no bonus
    expect(Number(after.bonus_count)).toBe(0)
    expect(after.last_retrieved_at).not.toBeNull() // usage stats still move
    expect(Number(after.retrieval_count)).toBe(1)
  })

  it('stops feedback trust changes and automatic pinning, but records helpful_count', async () => {
    const a = await rt.remember({ action: 'add', content: '禁用信任时被判有用的事实' })
    for (let i = 0; i < 10; i++) await rt.remember({ action: 'helpful', fact_id: a.fact_id })
    const row = rowOf(rt.db, a.fact_id)
    expect(Number(row.trust_score)).toBeCloseTo(0.5, 9) // no +delta, no snap
    expect(Number(row.pinned)).toBe(0)
    expect(Number(row.helpful_count)).toBe(10) // bookkeeping continues
  })

  it('still honors explicit pin/unpin and restore/revive', async () => {
    const a = await rt.remember({ action: 'add', content: '禁用信任时被显式固化的事实' })
    expect(rt.memory.pin(a.fact_id)).toBe(true)
    expect(Number(rowOf(rt.db, a.fact_id).pinned)).toBe(1)
    expect(Number(rowOf(rt.db, a.fact_id).trust_score)).toBe(1)
    expect(rt.memory.unpin(a.fact_id)).toBe(true)
    expect(Number(rowOf(rt.db, a.fact_id).pinned)).toBe(0)

    // restore: a forgot archive is lifted back to recall_floor without settling
    rt.db.prepare("UPDATE facts SET status = 'archived', archive_reason = 'forgot', trust_score = 0, archived_clock = 0 WHERE fact_id = ?").run(a.fact_id)
    expect(rt.memory.restore(a.fact_id)).toBe(true)
    const restored = rowOf(rt.db, a.fact_id)
    expect(restored.status).toBe('active')
    expect(Number(restored.trust_score)).toBeCloseTo(rt.config.common.trust.recall_floor, 9)

    // revive: re-adding archived content lifts it to the floor as well
    const b = await rt.remember({ action: 'add', content: '禁用信任时被复活的事实' })
    rt.db.prepare("UPDATE facts SET status = 'archived', archive_reason = 'forgot', trust_score = 0 WHERE fact_id = ?").run(b.fact_id)
    const again = await rt.remember({ action: 'add', content: '禁用信任时被复活的事实' })
    expect(again.revived).toBe(true)
    expect(again.fact_id).toBe(b.fact_id)
    expect(Number(rowOf(rt.db, b.fact_id).trust_score)).toBeCloseTo(rt.config.common.trust.recall_floor, 9)
  })
})
