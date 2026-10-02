import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type Config } from '@avantf/mem-contract'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import type { SemanticBackend } from '@avantf/mem-retrieval'
import { float32ToBytes } from '../src/db/vectors.js'
import { runMaintenance } from '../src/lifecycle/maintenance.js'
import {
  ContradictDetector,
  MAX_REPORTED_CONFLICTS,
  detectContradictionEmbedding,
  polarityLookupSql,
  sameSubjPredLookupSql,
} from '../src/lifecycle/contradiction.js'

/**
 * A semantic backend that is always ready, so a write can encode and the embedding leg can run.
 * Mirrors the seam `retrieval_budget.spec.ts` uses (the suite's own runtime has no model).
 */
function alwaysWarm(): SemanticBackend {
  return {
    name: 'always_warm',
    dim: 512,
    isAvailable: () => true,
    encode: async () => { const v = new Float32Array(512); v[0] = 1; return v },
    encodeBatch: async (texts: string[]) => texts.map(() => { const v = new Float32Array(512); v[0] = 1; return v }),
  }
}

/** A persisted-vector blob with the configured 512 dim (unit basis vector). */
function fakeVector(axis: number): Buffer {
  const v = new Float32Array(512)
  v[axis] = 1
  return float32ToBytes(v)
}

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-life-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

function backdate(factId: number, col: 'created_at' | 'updated_at' | 'archived_at' | 'last_retrieved_at', days: number): void {
  const iso = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ')
  rt.db.prepare(`UPDATE facts SET ${col} = ? WHERE fact_id = ?`).run(iso, factId)
}

describe('contradiction detection (structural)', () => {
  it('detects a same-subj/obj opposite-polarity conflict at 0.95 WHEN THE FACT IS WRITTEN', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })

    // The write itself reports the conflict — the writer does not have to know that a
    // sweep exists, and the open-conflict list is truthful from this moment on.
    expect(b.contradictions).toMatchObject([{ other_fact_id: a.fact_id, score: 0.95 }])
    expect(a.contradictions).toBeUndefined() // nothing to conflict with yet

    const listed = rt.memory.listContradictions({ limit: 10 }) as { fact_a: number; fact_b: number; score: number }[]
    const lp = listed.find((c) => (c.fact_a === a.fact_id && c.fact_b === b.fact_id) || (c.fact_b === a.fact_id && c.fact_a === b.fact_id))
    expect(lp).toBeDefined()

    // The sweep is a catch-up, not a second writer: an already-open pair is not re-logged.
    expect(rt.memory.checkContradictions()).toEqual([])
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(1)
  })

  it('does NOT log a same-subj/pred different-obj pair at the default 0.5 threshold', async () => {
    const a = await rt.remember({ action: 'add', content: '项目使用 MySQL' })
    const b = await rt.remember({ action: 'add', content: '项目使用 PostgreSQL' })
    expect(b.contradictions).toBeUndefined() // 0.5 < default threshold 0.6
    expect(rt.memory.checkContradictions()).toEqual([])
    expect(rt.memory.listContradictions({ limit: 10 }).length).toBe(0)
    expect(a.fact_id).toBeGreaterThan(0)
  })

  it('editing a conflicting fact retires the superseded row instead of stacking a duplicate', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(1)

    // Same subject/object with the same positive predicate ('喜欢…呀' still extracts as
    // 喜欢/小红), so the new revision conflicts with b exactly like a did.
    const edited = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '老王喜欢小红呀' })
    // The new revision still conflicts with b…
    expect(edited.contradictions).toMatchObject([{ other_fact_id: b.fact_id, score: 0.95 }])

    // …but the superseded revision's row is retired, so the OPEN list holds exactly the
    // live pair. Without this, every edit appended a permanent row pointing at content
    // that is already archived — and nothing in the API can retire one.
    const open = rt.memory.listContradictions({ limit: 10 }) as { fact_a: number; fact_b: number }[]
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ fact_a: b.fact_id, fact_b: edited.fact_id })

    // The archived revision is recorded as the loser, so the retirement is auditable.
    const resolved = rt.db
      .prepare('SELECT loser_fact_id, resolution FROM contradiction_log WHERE resolved = 1')
      .all() as { loser_fact_id: number; resolution: string }[]
    expect(resolved).toEqual([{ loser_fact_id: a.fact_id, resolution: 'true_positive' }])
  })

  it('archiving one side of an open conflict retires it', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(1)
    rt.memory.remove(a.fact_id)
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(0)
  })

  it('restoring a fact re-checks it, so the retired conflict comes back', async () => {
    // Retiring on archive must not be a one-way door: after a restore both sides are
    // active again, so the write-path check has to run for the restored fact.
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    rt.memory.remove(a.fact_id)
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(0)

    rt.memory.restore(a.fact_id)
    const back = rt.memory.listContradictions({ limit: 10 }) as { fact_a: number; fact_b: number }[]
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ fact_a: a.fact_id })
  })

  it('never lists a conflict whose fact is archived (rows written by an older build)', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    // Simulate a pre-fix row: archive behind the store's back, leaving `resolved = 0`.
    rt.db.prepare("UPDATE facts SET status = 'archived' WHERE fact_id = ?").run(a.fact_id)
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(0)
  })

  it('keeps the structural lookups on the triples index (no corpus-sized materialization)', () => {
    // Measured cliff this pins: `fact_id IN (SELECT fact_id FROM facts WHERE status='active')`
    // made SQLite materialize every ACTIVE fact id per lookup — 202 ms with ZERO matches on a
    // 300k-triple corpus, charged to every `remember` regardless of how many facts conflict.
    // The join form seeks `idx_triples_subj` and probes `facts` by primary key, with no
    // dependency on planner statistics (which this DB only collects on the lifecycle tick).
    const plan = (sql: string, params: unknown[]): string[] =>
      (rt.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail)
    const cases: [string, unknown[]][] = [
      [polarityLookupSql(2), ['老王', '小红', '喜欢', '不喜欢', 1]],
      [sameSubjPredLookupSql(), ['老王', '喜欢', '小红', 1]],
    ]
    for (const [sql, params] of cases) {
      const lines = plan(sql, params)
      // Which of the two seek indexes wins is the planner's call (obj+pred and subj+pred are
      // both selective here); what must never happen is a scan.
      expect(lines.some((l) => /idx_triples_(subj|obj)/.test(l)), lines.join(' | ')).toBe(true)
      expect(lines.some((l) => /SCAN/.test(l)), lines.join(' | ')).toBe(false)
    }
  })

  it('keeps the contradiction queue DURABLE across a restart (report §10.2 #3)', async () => {
    // The queue holds facts awaiting the EMBEDDING leg of detection, which cannot run without a
    // vector — so with the model unavailable every write adds one. It used to live in an in-process
    // Set: it grew without bound, needed a configured cap, and — the part a cap could not fix —
    // was LOST on restart, so those facts never got the check at all. `facts.conflict_checked` is
    // the durable form; nothing is dropped and nothing is forgotten when the process ends.
    const dir2 = mkdtempSync(join(tmpdir(), 'avantf-pending-'))
    try {
      const first = buildRuntime({ dataHome: dir2, memoryDbPath: join(dir2, 'memory.db') })
      for (let i = 0; i < 6; i++) await first.remember({ action: 'add', content: `排队事实 ${i}` })
      expect(first.memory.trustDiagnose().conflict_pending).toBe(6)
      first.shutdown()

      // A NEW process on the same database: the queue is still there.
      const second = buildRuntime({ dataHome: dir2, memoryDbPath: join(dir2, 'memory.db') })
      try {
        expect(second.memory.trustDiagnose().conflict_pending).toBe(6)
        // The sweep cannot drain them — draining requires the vector they are waiting for — and
        // that is the honest answer, not a silent "nothing to do".
        expect(second.memory.checkContradictions()).toEqual([])
        expect(second.memory.trustDiagnose().conflict_pending).toBe(6)
      } finally {
        second.shutdown()
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('keeps the new listing/conflict indexes in the plan AFTER the tick runs ANALYZE', async () => {
    // The lifecycle tick calls `PRAGMA optimize`, which creates `sqlite_stat1` — and with
    // statistics present SQLite switched `page()` back to `SCAN facts` + a temp b-tree at 33k
    // rows, silently undoing the fix the index exists for. `INDEXED BY` is what makes it
    // deterministic; this test asserts the plans AFTER an explicit ANALYZE for that reason.
    const plan = (sql: string, params: unknown[]): string =>
      (rt.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(' | ')

    // Enough rows that a scan would be the planner's alternative (the shapes are what matter).
    const seed = rt.db.transaction(() => {
      const insFact = rt.db.prepare(
        'INSERT INTO facts (content, category, settle_clock, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      )
      const insLog = rt.db.prepare('INSERT INTO contradiction_log (fact_a, fact_b, score, resolved, resolved_by) VALUES (?,?,?,?,?)')
      for (let i = 0; i < 400; i++) insFact.run(`性能优化记录条目 ${i}`, 'bench', 0, 'active', '2026-01-01 00:00:00', '2026-01-01 00:00:00')
      for (let i = 0; i < 300; i++) {
        const verdict = i % 10 === 0
        insLog.run(i + 1, ((i * 7 + 13) % 400) + 1, 0.8, verdict ? 1 : 0, verdict ? 'verdict' : null)
      }
    })
    seed()
    rt.db.exec('ANALYZE')

    // ① the unfiltered page is an index scan in created_at order, never a sort
    const unfiltered = plan('SELECT * FROM facts INDEXED BY idx_facts_created WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', ['active', 50, 0])
    expect(unfiltered, unfiltered).toMatch(/idx_facts_created/)
    expect(unfiltered, unfiltered).not.toMatch(/TEMP B-TREE|SCAN facts/)

    // ② both conflict-lookup shapes use the per-side indexes (MULTI-INDEX OR), never a log scan
    const conflictShapes: [string, unknown[]][] = [
      [`SELECT c.id FROM contradiction_log c JOIN facts fa ON fa.fact_id = c.fact_a AND fa.status = 'active'
         JOIN facts fb ON fb.fact_id = c.fact_b AND fb.status = 'active'
        WHERE c.resolved = 0 AND (c.fact_a = ? OR c.fact_b = ?) ORDER BY c.score DESC, c.id ASC LIMIT ?`, [3, 3, 20]],
      ['UPDATE contradiction_log SET resolved = 1 WHERE resolved = 0 AND (fact_a = ? OR fact_b = ?)', [3, 3]],
      ["SELECT fact_a, fact_b FROM contradiction_log WHERE fact_a = ? AND (resolved = 0 OR resolved_by = 'verdict')"
        + " UNION SELECT fact_a, fact_b FROM contradiction_log WHERE fact_b = ? AND (resolved = 0 OR resolved_by = 'verdict')", [3, 3]],
    ]
    for (const [sql, params] of conflictShapes) {
      const lines = plan(sql, params)
      expect(lines, lines).not.toMatch(/SCAN contradiction_log|SCAN c\b/)
      expect(lines, lines).toMatch(/idx_contradict_(fact_a|fact_b|open_pair)/)
    }

    // ③ the purge DELETE's FK subprogram: the fact_a/fact_b CASCADEs must SEEK the log (they used
    // to SCAN it per deleted row, because the partial UNIQUE index cannot serve an FK check).
    // The loser action legitimately scans its own covering index — it has no selective predicate.
    const del = plan("DELETE FROM facts WHERE status = 'archived' AND pinned = 0", [])
    expect(del, del).toMatch(/SEARCH contradiction_log USING COVERING INDEX idx_contradict_fact_a/)
    expect(del, del).toMatch(/SEARCH contradiction_log USING COVERING INDEX idx_contradict_fact_b/)
    expect(del.split(' | '), del).not.toContain('SCAN contradiction_log')

    // ④ the idle predicate rides the EXPRESSION index of step 5 and never the plain column index
    // step 4 dropped (the regex must not match the new name by prefix).
    const idle = plan("SELECT fact_id FROM facts WHERE status = 'active' AND pinned = 0 AND julianday(COALESCE(last_retrieved_at, created_at)) < julianday('now', '-365 days')", [])
    expect(idle, idle).toMatch(/idx_facts_idle_cutoff/)
    expect(idle, idle).not.toMatch(/idx_facts_idle(?!_)/)
    // …and every tick predicate avoids a bare table scan, which is what each new index is for.
    const tickShapes: [string, unknown[], RegExp][] = [
      ["SELECT COUNT(*) FROM facts WHERE status = 'active' AND pinned = 0 AND settle_clock < CAST(100 AS INTEGER)", [], /idx_facts_trust/],
      ["SELECT COUNT(*) FROM facts WHERE status = 'active' AND pinned = 0 AND trust_score <= 0", [], /idx_facts_forget/],
      ["SELECT COUNT(*) FROM facts WHERE bonus_window_at IS NOT NULL AND bonus_window_at > datetime('now', '-1 day')", [], /idx_facts_bonus_window/],
      ["SELECT COUNT(*) FROM facts WHERE status = 'archived' AND pinned = 0 AND archived_clock IS NOT NULL AND archived_clock < 100 - 30", [], /idx_facts_purge/],
    ]
    for (const [sql, params, expected] of tickShapes) {
      const lines = plan(sql, params)
      expect(lines, lines).toMatch(expected)
      expect(lines.split(' | '), lines).not.toContain('SCAN facts')
    }
  })

  it('retires the open conflicts of a BATCH of archived facts, on either side of the pair', async () => {
    // `retireConflicts` used to loop one UPDATE per id (O(archived × log), 6.3 s for 999 ids at
    // 99k open pairs, inside the tick's single IMMEDIATE transaction). The batched form runs two
    // statements per 500 ids and must still (a) close pairs where the id is on EITHER side and
    // (b) record the fact that LEFT as the loser.
    const a = await rt.remember({ action: 'add', content: '网关部署在 A 区' })
    const b = await rt.remember({ action: 'add', content: '网关部署在 B 区' })
    const c = await rt.remember({ action: 'add', content: '网关部署在 C 区' })
    // Raw rows, not `normalize`d: one pair has the archived fact on the fact_a side, the other on
    // the fact_b side — the two branches of the batched statements.
    rt.db.prepare('INSERT INTO contradiction_log (fact_a, fact_b, score, resolved) VALUES (?,?,?,0)').run(b.fact_id, a.fact_id, 0.9)
    rt.db.prepare('INSERT INTO contradiction_log (fact_a, fact_b, score, resolved) VALUES (?,?,?,0)').run(b.fact_id, c.fact_id, 0.8)

    await rt.admin({ action: 'archive', fact_id: b.fact_id }) // retires both pairs of B

    const rows = rt.db.prepare('SELECT fact_a, fact_b, resolved, resolved_by, loser_fact_id FROM contradiction_log ORDER BY id').all() as
      { fact_a: number; fact_b: number; resolved: number; resolved_by: string | null; loser_fact_id: number | null }[]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.resolved).toBe(1)
      expect(row.resolved_by).toBe('auto')
      expect(row.loser_fact_id).toBe(b.fact_id) // the revision that left the corpus
    }
  })

  it('keeps detecting when a hub entity exceeds the SQLite bind-parameter cap', async () => {
    // The write-path candidate pool grows with the CORPUS: past SQLITE_MAX_VARIABLE_NUMBER
    // (32 766) `entityBags` threw "too many SQL variables", and because detection is
    // best-effort the throw turned into a silently skipped check (`contradictions` came back
    // undefined even for a structural 0.95 hit). The batch size is well under the cap.
    //
    // The seeded facts are linked to BOTH entities of the checked fact: the lossless
    // narrowing requires ≥ ⌈p·|A|⌉ shared entities, so a hub that shares only one is pruned
    // before the batch load and this path would not be exercised at all.
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const insEnt = rt.db.prepare('INSERT OR IGNORE INTO entities (name) VALUES (?)')
    const eidOf = rt.db.prepare('SELECT entity_id FROM entities WHERE name = ?')
    insEnt.run('老王')
    insEnt.run('小红')
    const ids = ['老王', '小红'].map((n) => (eidOf.get(n) as { entity_id: number }).entity_id)
    const insFact = rt.db.prepare('INSERT OR IGNORE INTO facts (content, settle_clock) VALUES (?, 0)')
    const insLink = rt.db.prepare('INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?, ?)')
    rt.db.transaction(() => {
      for (let i = 0; i < 33_000; i++) {
        const row = insFact.run(`老王负责历史事务${i}`)
        const id = Number(row.lastInsertRowid)
        for (const eid of ids) insLink.run(id, eid)
      }
    })()

    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    expect(b.contradictions).toMatchObject([{ other_fact_id: a.fact_id, score: 0.95 }])
  })

  it('dedupes pre-existing duplicate open rows when the database is upgraded', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    // Reproduce a database from the PRE-versioning era (or two concurrent writers): no guard
    // index, a duplicate OPEN row, and `user_version = 0` so the migration path runs — the
    // clean-up is a numbered step now, not something re-applied on every open.
    rt.db.exec('DROP INDEX IF EXISTS idx_contradict_open_pair')
    rt.db.prepare('INSERT INTO contradiction_log (fact_a, fact_b, score) VALUES (?, ?, 0.9)').run(a.fact_id, b.fact_id)
    rt.db.pragma('user_version = 0')
    rt.shutdown()
    rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })

    expect(rt.db.prepare('SELECT COUNT(*) AS c FROM contradiction_log WHERE resolved = 0').get()).toEqual({ c: 1 })
    expect(
      rt.db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND name = 'idx_contradict_open_pair'").get(),
    ).toEqual({ c: 1 })
  })

  it('allows only one OPEN row per pair (cross-process duplicate logging)', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(1)
    // A second process logging the same pair hits the partial unique index instead of
    // stacking a duplicate; `ContradictionRepo.log` uses INSERT OR IGNORE for that race.
    expect(() =>
      rt.db.prepare('INSERT INTO contradiction_log (fact_a, fact_b, score) VALUES (?, ?, 0.9)').run(a.fact_id, b.fact_id),
    ).toThrow(/UNIQUE/i)
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(1)
  })

  it('update that merges into an existing fact still runs the check', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    const c = await rt.remember({ action: 'add', content: '陈静加入平台组' })
    // Retire the open pair: the merge path must re-check the fact it landed on, otherwise a
    // conflict that is not currently in the open log would never come back.
    rt.db.prepare('UPDATE contradiction_log SET resolved = 1').run()
    const merged = await rt.remember({ action: 'update', fact_id: c.fact_id, content: '老王不喜欢小红' })
    expect(merged).toMatchObject({ fact_id: b.fact_id, is_new: false, revived: false })
    expect(merged.contradictions).toMatchObject([{ other_fact_id: a.fact_id, score: 0.95 }])
  })

  it('a duplicate add changes nothing and does not re-report the conflict', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    // Idempotent re-add: no new row, no new state, so the conflict is not reported again
    // (it is already in the open log for the UI).
    const again = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    expect(again.is_new).toBe(false)
    expect(again.contradictions).toBeUndefined()
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(1)
    expect(a.fact_id).toBeGreaterThan(0)
  })

  it('reports the conflict a merge lands on even when the pair is ALREADY open', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    const c = await rt.remember({ action: 'add', content: '陈静加入平台组' })
    // B's conflict with A is open. A merge into B changes state, so the writer must be told
    // about that conflict — reporting only what THIS pass inserted said "no conflicts" while
    // `contradict` showed one.
    const merged = await rt.remember({ action: 'update', fact_id: c.fact_id, content: '老王不喜欢小红' })
    expect(merged).toMatchObject({ fact_id: b.fact_id, is_new: false })
    expect(merged.contradictions).toMatchObject([{ other_fact_id: a.fact_id, score: 0.95 }])
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(1) // still one row, not two
  })

  it('stays silent when an update changes nothing at all', async () => {
    await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    // Re-saving identical content onto the same fact is as much a no-op as a duplicate add.
    const again = await rt.remember({ action: 'update', fact_id: b.fact_id, content: '老王不喜欢小红' })
    expect(again.fact_id).toBe(b.fact_id)
    expect(again.contradictions).toBeUndefined()
  })

  /**
   * Adjudication (DESIGN §20). Detection used to be one-way: a pair was logged, and the only
   * thing that ever closed it was a fact LEAVING the active corpus. Two statements could be
   * known to be inconsistent, both stay put, and the open list would keep the pair forever
   * (`ContradictionsDao.resolve` existed with no caller).
   */
  it('adjudicates an open conflict: the loser is archived and the pair is closed', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    const [pair] = rt.memory.listContradictions({ limit: 10 }) as { contradiction_id: number; fact_a: number; fact_b: number }[]
    expect(pair).toBeDefined()

    const outcome = rt.admin({
      action: 'contradict_resolve',
      contradiction_id: pair!.contradiction_id,
      resolution: 'true_positive',
      loser_fact_id: b.fact_id,
    })
    expect(outcome).toMatchObject({ resolved: true, contradiction_id: pair!.contradiction_id, archived_loser: b.fact_id })

    // The wrong statement left the active corpus, the pair is closed, and the verdict is stored.
    expect(rt.memory.get(b.fact_id)?.status).toBe('archived')
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(0)
    const row = rt.db
      .prepare('SELECT resolved, resolution, loser_fact_id FROM contradiction_log WHERE id = ?')
      .get(pair!.contradiction_id)
    expect(row).toEqual({ resolved: 1, resolution: 'true_positive', loser_fact_id: b.fact_id })
    // The surviving statement is untouched and still retrievable.
    expect(a.fact_id).toBeGreaterThan(0)
  })

  it('the write path hands back the id a verdict needs, so no second lookup is required', async () => {
    await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    // `mem_remember` reports the conflict, and the handle must be in THAT payload: the row id is
    // all `contradict_resolve` takes, so omitting it forced a detour through `mem_recall contradict`.
    expect(b.contradictions).toHaveLength(1)
    const reported = b.contradictions![0]!
    expect(reported.contradiction_id).toBeGreaterThan(0)

    const outcome = rt.admin({
      action: 'contradict_resolve',
      contradiction_id: reported.contradiction_id,
      resolution: 'true_positive',
      loser_fact_id: b.fact_id,
    })
    expect(outcome).toMatchObject({ resolved: true, archived_loser: b.fact_id })
  })

  it('true_positive without a loser confirms the conflict but keeps both statements', async () => {
    // "These do conflict, and I am not the one to say which is wrong" is a real verdict, and the
    // contract allows it (only `false_positive` is refused a loser). Pin what it means: the pair
    // closes for good and nothing is archived.
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    const [pair] = rt.memory.listContradictions({ limit: 10 }) as { contradiction_id: number }[]

    const outcome = rt.admin({ action: 'contradict_resolve', contradiction_id: pair!.contradiction_id, resolution: 'true_positive' })
    expect(outcome).toMatchObject({ resolved: true, archived_loser: null })
    expect(rt.memory.get(a.fact_id)?.status).toBe('active')
    expect(rt.memory.get(b.fact_id)?.status).toBe('active')

    const row = rt.db
      .prepare('SELECT resolved, resolution, loser_fact_id, resolved_by FROM contradiction_log WHERE id = ?')
      .get(pair!.contradiction_id)
    expect(row).toEqual({ resolved: 1, resolution: 'true_positive', loser_fact_id: null, resolved_by: 'verdict' })

    // And the verdict holds: the sweep must not re-open it, or the confirmation would be a no-op.
    rt.memory.checkContradictions()
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(0)
  })

  it('a false_positive verdict closes the pair and keeps both facts', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    const [pair] = rt.memory.listContradictions({ limit: 10 }) as { contradiction_id: number }[]

    const outcome = rt.admin({
      action: 'contradict_resolve',
      contradiction_id: pair!.contradiction_id,
      resolution: 'false_positive',
    })
    expect(outcome).toMatchObject({ resolved: true, archived_loser: null })
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(0)
    // Both statements are still live: the verdict was about the pair, not the facts.
    expect(rt.memory.countByStatus()).toMatchObject({ active: 2, archived: 0 })
    expect(a.fact_id).not.toBe(b.fact_id)
  })

  it('a sweep does not re-open a pair an explicit verdict closed', async () => {
    // Found by the write-side eval: the pending set never drains while the embedder is down, so
    // a later `contradict_check` re-detected the pair — the verdict had closed the row, not the
    // question. `resolved_by` separates a VERDICT (final) from an automatic retirement (which
    // must stay re-loggable, see the archive → restore test below).
    await rt.remember({ action: 'add', content: '老王喜欢小红' })
    await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    const [pair] = rt.memory.listContradictions({ limit: 10 }) as { contradiction_id: number }[]
    rt.admin({ action: 'contradict_resolve', contradiction_id: pair!.contradiction_id, resolution: 'false_positive' })
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(0)

    rt.memory.checkContradictions()
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(0)
    // One row, not two: the sweep recognised the pair instead of logging it again.
    expect(rt.db.prepare('SELECT COUNT(*) AS n FROM contradiction_log').get()).toEqual({ n: 1 })
    expect(rt.db.prepare('SELECT resolved_by FROM contradiction_log').get()).toEqual({ resolved_by: 'verdict' })
  })

  it('refuses to re-adjudicate a pair that already carries a verdict', async () => {
    // A verdict has a side effect a second one cannot undo: naming loser A ARCHIVES A. Applying a
    // second verdict with loser B would archive B while A stays archived, and the row would name one
    // loser while two facts are gone — with no history saying so. It used to overwrite
    // `resolution`/`loser_fact_id`/`resolved_at` in place.
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    const [pair] = rt.memory.listContradictions({ limit: 10 }) as { contradiction_id: number }[]
    const first = rt.admin({
      action: 'contradict_resolve',
      contradiction_id: pair!.contradiction_id,
      resolution: 'true_positive',
      loser_fact_id: a.fact_id,
    })
    expect(first).toMatchObject({ resolved: true, archived_loser: a.fact_id })

    expect(rt.admin({
      action: 'contradict_resolve',
      contradiction_id: pair!.contradiction_id,
      resolution: 'false_positive',
    })).toMatchObject({ resolved: false, reason: 'already_resolved' })
    // Neither a "both fine" reversal nor a DIFFERENT loser is applied.
    expect(rt.admin({
      action: 'contradict_resolve',
      contradiction_id: pair!.contradiction_id,
      resolution: 'true_positive',
      loser_fact_id: b.fact_id,
    })).toMatchObject({ resolved: false, reason: 'already_resolved' })

    // The row still describes the FIRST verdict, and only the first loser is archived.
    expect(rt.db.prepare('SELECT resolution, loser_fact_id, resolved_by FROM contradiction_log').get())
      .toEqual({ resolution: 'true_positive', loser_fact_id: a.fact_id, resolved_by: 'verdict' })
    expect(rt.memory.countByStatus()).toMatchObject({ active: 1, archived: 1 })
  })

  it('refuses a verdict that does not describe the pair', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢小红' })
    const b = await rt.remember({ action: 'add', content: '老王不喜欢小红' })
    const outsider = await rt.remember({ action: 'add', content: '陈静加入平台组' })
    const [pair] = rt.memory.listContradictions({ limit: 10 }) as { contradiction_id: number }[]

    // A loser that is not part of the pair would archive an innocent fact.
    expect(rt.admin({
      action: 'contradict_resolve',
      contradiction_id: pair!.contradiction_id,
      resolution: 'true_positive',
      loser_fact_id: outsider.fact_id,
    })).toMatchObject({ resolved: false, reason: 'loser_not_in_pair' })
    // "Both are fine" cannot name a loser — that would contradict itself.
    expect(rt.admin({
      action: 'contradict_resolve',
      contradiction_id: pair!.contradiction_id,
      resolution: 'false_positive',
      loser_fact_id: a.fact_id,
    })).toMatchObject({ resolved: false, reason: 'loser_requires_true_positive' })
    // An id that is not a conflict at all.
    expect(rt.admin({
      action: 'contradict_resolve',
      contradiction_id: 999_999,
      resolution: 'false_positive',
    })).toMatchObject({ resolved: false, reason: 'not_found' })
    // None of the refusals changed anything.
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(1)
    expect(rt.memory.countByStatus()).toMatchObject({ active: 3, archived: 0 })
    expect(b.fact_id).toBeGreaterThan(0)
  })

  it('caps how many conflicts a write reports, most severe first', async () => {
    // A fact can be named in many open pairs and this payload goes to a model, so the report
    // is bounded (the full list stays on the `contradict` surface). The rows are fabricated:
    // producing 25 real near-duplicates would exercise the detector, not the bound.
    const target = await rt.remember({ action: 'add', content: '张伟负责支付网关' })
    const insFact = rt.db.prepare('INSERT INTO facts (content, settle_clock) VALUES (?, 0)')
    const insLog = rt.db.prepare('INSERT INTO contradiction_log (fact_a, fact_b, score) VALUES (?, ?, ?)')
    const created = rt.db.transaction(() =>
      Array.from({ length: MAX_REPORTED_CONFLICTS + 5 }, (_, i) => {
        const id = Number(insFact.run(`与目标冲突的历史事实 ${String(i)}`).lastInsertRowid)
        insLog.run(target.fact_id, id, 0.6 + i / 100) // ascending, so a cap must drop the tail
        return id
      }))()

    // A merge into the target is a real state change, so its open set is what gets reported.
    const source = await rt.remember({ action: 'add', content: '陆明负责结算服务' })
    const merged = await rt.remember({ action: 'update', fact_id: source.fact_id, content: '张伟负责支付网关' })
    expect(merged.fact_id).toBe(target.fact_id)
    const reported = merged.contradictions ?? []
    expect(reported).toHaveLength(MAX_REPORTED_CONFLICTS)
    // Most severe first: the LOWEST fabricated scores are the ones dropped.
    expect(reported[0]!.score).toBeCloseTo(0.6 + (created.length - 1) / 100, 6)
    const scores = reported.map((c) => c.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
    expect(reported.map((c) => c.other_fact_id)).not.toContain(target.fact_id)
    // The cap is a REPORTING bound only — the log still holds every open pair.
    expect(rt.memory.listContradictions({ limit: 100 })).toHaveLength(created.length)
  })
})

describe('the contradiction queue reports its real backlog', () => {
  it('counts rows that are waiting but NOT selectable (no embedder)', async () => {
    // The queue predicate requires `semantic_vector IS NOT NULL`, so with no embedder — the default
    // shape on a machine without a model — the SELECTION is empty while rows are genuinely waiting.
    // The empty branch used to hardcode `pending: 0`, so `maintenance` printed "queue empty" beside
    // `trust`'s "落后 N" on the very same store.
    await rt.remember({ action: 'add', content: '老王负责甲事务' })
    await rt.remember({ action: 'add', content: '小李负责乙事务' })

    const report = rt.memory.drainConflicts()
    expect(report.checked).toBe(0)
    expect(report.pending).toBeGreaterThan(0)
    // The two channels agree, which is the whole point.
    expect(report.pending).toBe(rt.memory.trustDiagnose().conflict_pending)
  })
})

describe('contradiction embedding fallback', () => {
  it('detectContradictionEmbedding scores entity overlap * cosine (near-dup → 0)', () => {
    const v1 = new Float32Array([1, 0, 0, 0])
    const v2 = new Float32Array([0.85, 0.527, 0, 0]) // cos(v1,v2)≈0.85
    const same = detectContradictionEmbedding(['老王', '小李'], ['老王', '小李'], v1, v2)
    expect(same).toBeCloseTo(0.85, 2)
    // near-duplicate (>0.97) → 0
    const near = detectContradictionEmbedding(['老王', '小李'], ['老王', '小李'], v1, v1)
    expect(near).toBe(0)
    // low overlap → 0
    const low = detectContradictionEmbedding(['老王', '小李'], ['张三', '王五'], v1, v2)
    expect(low).toBe(0)
  })

  it('the detector embedding pass logs a contradiction when vectors + entities align', async () => {
    const a = await rt.remember({ action: 'add', content: '老王负责甲事务' })
    const b = await rt.remember({ action: 'add', content: '老王负责乙事务' })
    const v1 = new Float32Array([1, 0, 0, 0])
    const v2 = new Float32Array([0.85, 0.527, 0, 0])
    const det = new ContradictDetector(
      rt.db,
      0.6,
      (ids) => new Map(ids.map((id) => [id, id === a.fact_id ? v1 : v2])),
      () => ['老王', '甲'],
    )
    // The detector is stateless about what is pending (the store owns the durable queue), so the
    // caller supplies the ids to check.
    const sigs = det.checkMany([a.fact_id]).logged
    const pair = sigs.find((s) => (s.fact_a === a.fact_id && s.fact_b === b.fact_id) || (s.fact_a === b.fact_id && s.fact_b === a.fact_id))
    expect(pair).toBeDefined()
    expect(pair!.score).toBeGreaterThanOrEqual(0.6)
  })

  it('checkOne (the write-path entry) finds the pair and only ever records it once', async () => {
    const a = await rt.remember({ action: 'add', content: '老王负责甲事务' })
    const b = await rt.remember({ action: 'add', content: '老王负责乙事务' })
    const v1 = new Float32Array([1, 0, 0, 0])
    const v2 = new Float32Array([0.85, 0.527, 0, 0])
    const det = new ContradictDetector(
      rt.db,
      0.6,
      (ids) => new Map(ids.map((id) => [id, id === a.fact_id ? v1 : v2])),
      () => ['老王', '甲'],
    )
    const sigs = det.checkOne(a.fact_id).logged
    expect(sigs.some((s) => (s.fact_a === a.fact_id && s.fact_b === b.fact_id) || (s.fact_a === b.fact_id && s.fact_b === a.fact_id))).toBe(true)
    // Re-running (what a later sweep does) must not log the same pair twice.
    expect(det.checkOne(a.fact_id).logged).toEqual([])
    expect(rt.memory.listContradictions({ limit: 10 })).toHaveLength(1)
  })

  it('reports a check as complete only when it held the fact\'s OWN vector', async () => {
    // The contract the durable queue is built on: `logged` says "no pair was recorded", which is
    // also the answer for a fact the embedding leg could not score at all. Only `complete`
    // distinguishes them, and the store stamps on THAT (see `MemoryStore.checkContradictions`) —
    // so a pass that cannot reach the vector must never report the fact as complete.
    const a = await rt.remember({ action: 'add', content: '老王负责甲事务' })
    const withVector = new ContradictDetector(
      rt.db,
      0.6,
      (ids) => new Map(ids.map((id) => [id, new Float32Array([1, 0, 0, 0])])),
      () => ['老王', '甲'],
    )
    expect(withVector.checkOne(a.fact_id).complete).toEqual([a.fact_id])

    // Same fact, same DB, but the live index has no vector for it (another space, another
    // process's write, dropped at rebuild). Nothing was scored ⇒ nothing may be stamped.
    const withoutVector = new ContradictDetector(rt.db, 0.6, () => new Map(), () => ['老王', '甲'])
    const result = withoutVector.checkOne(a.fact_id)
    expect(result.logged).toEqual([])
    expect(result.complete).toEqual([])
  })

  it('narrows the candidate universe to entity-sharing facts (which is lossless)', async () => {
    const unrelated = await rt.remember({ action: 'add', content: '陈静加入平台组' })
    const a = await rt.remember({ action: 'add', content: '老王负责甲事务' })
    const b = await rt.remember({ action: 'add', content: '老王负责乙事务' })
    const v1 = new Float32Array([1, 0, 0, 0])
    const v2 = new Float32Array([0.85, 0.527, 0, 0])
    const asked: number[][] = []
    const det = new ContradictDetector(
      rt.db,
      0.6,
      (ids) => { asked.push(ids); return new Map(ids.map((id) => [id, id === a.fact_id ? v1 : v2])) },
      () => ['老王', '甲'],
    )
    det.checkOne(a.fact_id)
    // One batched fetch, over the candidates only: a fact sharing no entity can never
    // reach the entity-overlap floor, so it must not be decoded.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain(a.fact_id)
    expect(asked[0]).toContain(b.fact_id)
    expect(asked[0]).not.toContain(unrelated.fact_id)
  })

  it('prunes a candidate that shares too few entities to reach the threshold (lossless)', async () => {
    const a = await rt.remember({ action: 'add', content: '老王负责甲事务' })          // [老王, 事务]
    const sharesOne = await rt.remember({ action: 'add', content: '老王不喜欢小红' })   // [老王, 小红]
    const asked: number[][] = []
    const det = new ContradictDetector(
      rt.db,
      0.6,
      (ids) => { asked.push(ids); return new Map(ids.map((id) => [id, new Float32Array([1, 0, 0, 0])])) },
      () => ['老王', '事务'],
    )
    det.checkOne(a.fact_id)
    // |A| = 2 and p = threshold/simDupMax = 0.6/0.97 ≈ 0.619, so a pair must share ≥ 2
    // entities; one shared entity caps the score at (1/3)×0.97 ≈ 0.32 — far below 0.6 — so
    // excluding it cannot lose a contradiction, it only skips the vector fetch.
    expect(asked[0]).toContain(a.fact_id)
    expect(asked[0]).not.toContain(sharesOne.fact_id)
  })

  it('a fact whose embedding leg ran is NOT pending; one without a vector is', async () => {
    // The marker means "the embedding leg ran against the CURRENT vector", so a write that could
    // encode leaves nothing behind, while a write that could not stays queued for the drain.
    const withModel = buildRuntime({
      dataHome: dir,
      memoryDbPath: join(dir, 'memory.db'),
      semantic: alwaysWarm(),
    })
    try {
      await withModel.remember({ action: 'add', content: '老王负责甲事务' })
      expect(withModel.memory.trustDiagnose().conflict_pending).toBe(0)
      // …and the drain has nothing to do, because nothing is queued.
      expect(withModel.memory.checkContradictions()).toEqual([])
    } finally {
      withModel.shutdown()
    }

    // `rt` (this suite's runtime) has no model: the same write stays pending.
    await rt.remember({ action: 'add', content: '陈静负责乙事务' })
    expect(rt.memory.trustDiagnose().conflict_pending).toBe(1)
  })

  it('drains the queue only when the LIVE INDEX can serve the vector, not when the column has one', async () => {
    // The marker means "the embedding leg ran against the CURRENT vector", and the leg is scored
    // from the live index — NOT from the `semantic_vector` column. The queue predicate asks the
    // database ("has a vector"), so the two can disagree for a row written in another space, by
    // another process, or dropped while the index was rebuilt. The drain must close only rows it
    // actually scored: this test used to assert the opposite (a column-only write drained the
    // queue), which pinned a permanent exemption for a check that never ran.
    const a = await rt.remember({ action: 'add', content: '老王负责甲事务' })
    expect(rt.memory.trustDiagnose().conflict_pending).toBe(1)

    rt.db.prepare('UPDATE facts SET semantic_vector = ?').run(fakeVector(0))
    expect(rt.memory.checkContradictions()).toEqual([])
    expect(rt.memory.trustDiagnose().conflict_pending).toBe(1) // STILL unchecked — nothing was scored

    // Put the same bytes in the LIVE INDEX and the drain can finish the job.
    const vstore = (rt.memory as unknown as { vstore: { dim: number; add(id: number, v: Float32Array): void } }).vstore
    const live = new Float32Array(vstore.dim)
    live[0] = 1
    vstore.add(a.fact_id, live)

    expect(rt.memory.checkContradictions()).toEqual([])
    expect(rt.memory.trustDiagnose().conflict_pending).toBe(0) // drained
    // Idempotent: nothing left to drain.
    expect(rt.memory.checkContradictions()).toEqual([])
  })

  it('maintenance carries ONE bounded conflict pass and reports what is left', async () => {
    // `maintenance` is the surfaces' "clean up now" (the settings page and the MCP tool call it), so
    // it carries one pass of EACH half of the derived state. The conflict half used to be reachable
    // only through the explicit `contradict_check` action, which mattered once the v6 upgrade
    // stopped backfilling `conflict_checked`: every vector-bearing row is queued at once, so someone
    // must be able to drain it without knowing that action exists.
    const reachable = await rt.remember({ action: 'add', content: '小张负责乙事务' })
    const stranded = await rt.remember({ action: 'add', content: '小赵负责丙事务' })
    expect(reachable.is_new).toBe(true)
    expect(stranded.is_new).toBe(true)
    // Both queued: the fake backend produced no vector at write time.
    expect(rt.memory.trustDiagnose().conflict_pending).toBe(2)
    // One gets its vector in the COLUMN and the LIVE INDEX, the other only in the column — the
    // disagreement the drain must not paper over.
    rt.db.prepare('UPDATE facts SET semantic_vector = ?').run(fakeVector(0))
    const vstore = (rt.memory as unknown as { vstore: { dim: number; add(id: number, v: Float32Array): void } }).vstore
    const live = new Float32Array(vstore.dim)
    live[0] = 1
    vstore.add(reachable.fact_id, live)

    const result = await rt.memory.maintenance()
    expect(result.conflicts).toEqual({ checked: 1, logged: 0, pending: 1 })
    // The entity half rides the same call and owes nothing on fresh rows.
    expect(result.entities).toEqual({ rebuilt: 0, deferred: 0, skipped: false })
  })

  it('a FAILED check leaves the row queued (a caught failure is not a completed check)', async () => {
    // The write path is best-effort: a detector that throws must never fail the write. It must
    // not mark the fact checked either. `detectContradictions` used to return `[]` for a caught
    // exception, and the caller stamped the marker on it anyway — so the one row we KNOW was not
    // checked was the one row that could never be checked again.
    const a = await rt.remember({ action: 'add', content: '老王负责甲事务' })
    rt.db.prepare('UPDATE facts SET semantic_vector = ?').run(fakeVector(0))
    // Make the next drain blow up inside the vector fetch (what a broken index does).
    const vstore = (rt.memory as unknown as { vstore: { fetch(ids: number[]): Map<number, Float32Array> } }).vstore
    const original = vstore.fetch.bind(vstore)
    vstore.fetch = () => { throw new Error('index unavailable') }
    expect(() => rt.memory.checkContradictions()).toThrow('index unavailable')
    vstore.fetch = original

    expect(rt.memory.trustDiagnose().conflict_pending).toBe(1) // still owed a check
  })
})

describe('lifecycle maintenance (active-day trust model)', () => {
  it('ttl_days = 0 means no expiry (a canceled TTL survives its old deadline)', async () => {
    // The tick's TTL step is `ttl_days > 0 AND age > ttl_days`, so 0 is the encoding for
    // "no expiry". Cancelling must therefore be possible through the same write path that
    // set it — otherwise a fact with a TTL is capped forever.
    const a = await rt.remember({ action: 'add', content: '先设 1 天有效期再取消', ttl_days: 1 })
    const b = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '取消有效期后应长期存活', ttl_days: 0 })
    expect(b.fact_id).not.toBe(a.fact_id)

    // Push the revision past the deadline the OLD one carried; the TTL step must skip it.
    backdate(b.fact_id, 'created_at', 3)
    rt.memory.trustTick()
    expect(rt.db.prepare('SELECT status, ttl_days FROM facts WHERE fact_id = ?').get(b.fact_id))
      .toEqual({ status: 'active', ttl_days: 0 })
  })

  it('decays trust LINEARLY along the active-day clock (no floor)', async () => {
    const a = await rt.remember({ action: 'add', content: '陈静加入平台组' })
    const cfg: Config = ConfigSchema.parse({ trust: { decay_per_day: 0.01, idle_calendar_days: 99999 } })
    const res = runMaintenance(rt.db, cfg, { clock: 10 })
    expect(res.decayed).toBe(1)
    expect(res.settled).toBe(1)
    const row = rt.db.prepare('SELECT trust_score, settle_clock FROM facts WHERE fact_id = ?').get(a.fact_id) as { trust_score: number; settle_clock: number }
    expect(row.trust_score).toBeCloseTo(0.4, 6) // 0.5 - 0.01 * 10 active days
    expect(row.settle_clock).toBe(10)
  })

  it('forgets after 90 active days, while a recalled fact stays alive', async () => {
    const used = await rt.remember({ action: 'add', content: '一直有人用的事实' })
    const stale = await rt.remember({ action: 'add', content: '再也没人用的事实' })
    // Disable the calendar fallback so only the active-day clock is under test.
    const cfg: Config = ConfigSchema.parse({ trust: { idle_calendar_days: 99999 } })
    // The used fact was recalled at active day 30 → back to start (0.5), clock re-anchored.
    rt.db.prepare("UPDATE avantf_stats SET value = '30' WHERE key = 'trust_clock'").run()
    rt.memory.reinforce([used.fact_id])
    const res = runMaintenance(rt.db, cfg, { clock: 90 })
    expect(res.archived_forgot).toBe(1)
    expect(res.archived_age).toBe(1) // archived_age = forgot + idle (name kept, D10)
    const staleRow = rt.db.prepare('SELECT status, archive_reason FROM facts WHERE fact_id = ?').get(stale.fact_id) as { status: string; archive_reason: string }
    expect(staleRow.status).toBe('archived')
    expect(staleRow.archive_reason).toBe('forgot')
    // 90 - 30 = 60 active days elapsed for the used one → 0.5 - (0.5/90)*60 ≈ 0.167 > 0
    const usedRow = rt.db.prepare('SELECT status, trust_score FROM facts WHERE fact_id = ?').get(used.fact_id) as { status: string; trust_score: number }
    expect(usedRow.status).toBe('active')
    expect(usedRow.trust_score).toBeGreaterThan(0)
  })

  it('archives expired ttl facts (calendar, explicit instruction)', async () => {
    const a = await rt.remember({ action: 'add', content: '临时密码是 123456', ttl_days: 1 })
    backdate(a.fact_id, 'created_at', 2)
    const cfg: Config = ConfigSchema.parse({ trust: { enabled: false } }) // TTL runs even when trust is off (D12)
    const res = runMaintenance(rt.db, cfg, { clock: 0 })
    expect(res.archived_ttl).toBe(1)
    const row = rt.db.prepare('SELECT status, archive_reason FROM facts WHERE fact_id = ?').get(a.fact_id) as { status: string; archive_reason: string }
    expect(row.status).toBe('archived')
    expect(row.archive_reason).toBe('ttl')
  })

  it('a revision expires on the ORIGINAL recording clock — update does not extend its TTL', async () => {
    // `update` inherits `created_at`, which is exactly what the TTL predicate reads. The bound
    // therefore means "valid for N days after FIRST recorded", and rewriting a nearly-expired
    // memory must not hand it a fresh N days. Pinned as a deliberate consequence (TRUST_MODEL.md).
    const a = await rt.remember({ action: 'add', content: '只在最初记录后 1 天内有效', ttl_days: 1 })
    backdate(a.fact_id, 'created_at', 5) // first recorded 5 days ago — already past its bound
    const b = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '只在最初记录后 1 天内有效（改写）' })
    expect(b.fact_id).not.toBe(a.fact_id)
    const cfg: Config = ConfigSchema.parse({ trust: { enabled: false } }) // TTL runs even when trust is off (D12)
    const res = runMaintenance(rt.db, cfg, { clock: 0 })
    expect(res.archived_ttl).toBe(1)
    const row = rt.db.prepare('SELECT status, archive_reason FROM facts WHERE fact_id = ?').get(b.fact_id) as { status: string; archive_reason: string }
    expect(row.status).toBe('archived')
    expect(row.archive_reason).toBe('ttl')
  })

  it('idle fallback archives after idle_calendar_days without use (D4)', async () => {
    const a = await rt.remember({ action: 'add', content: '一年没被用过的事实' })
    backdate(a.fact_id, 'last_retrieved_at', 400)
    const cfg: Config = ConfigSchema.parse({ trust: { idle_calendar_days: 365 } })
    const res = runMaintenance(rt.db, cfg, { clock: 0 })
    expect(res.archived_idle).toBe(1)
    const row = rt.db.prepare('SELECT status, archive_reason FROM facts WHERE fact_id = ?').get(a.fact_id) as { status: string; archive_reason: string }
    expect(row.archive_reason).toBe('idle')
  })

  it('a revision of an OLD memory is not archived as idle by the next tick', async () => {
    // The revision inherits the old `created_at`, so without a fresh use clock the idle
    // predicate `COALESCE(last_retrieved_at, created_at)` would read a year old and the very
    // next tick would archive the memory the user had just re-asserted. `insertRevision`
    // re-stamps `last_retrieved_at`; this is that guarantee's regression.
    const a = await rt.remember({ action: 'add', content: '很久以前记下、刚刚被改写的事实' })
    backdate(a.fact_id, 'created_at', 400)
    backdate(a.fact_id, 'last_retrieved_at', 400)
    const b = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '很久以前记下、刚刚被改写的事实（新版）' })
    const cfg: Config = ConfigSchema.parse({ trust: { idle_calendar_days: 365 } })
    const res = runMaintenance(rt.db, cfg, { clock: 0 })
    expect(res.archived_idle).toBe(0)
    expect(rt.db.prepare('SELECT status FROM facts WHERE fact_id = ?').get(b.fact_id)).toEqual({ status: 'active' })
  })

  it('purges archived facts once the ACTIVE-DAY window passes (R19)', async () => {
    const a = await rt.remember({ action: 'add', content: '已经废弃的记录' })
    await rt.admin({ action: 'archive', fact_id: a.fact_id }) // archived_clock = current clock (0)
    const cfg: Config = ConfigSchema.parse({ lifecycle: { purge_after_archived_days: 365 } })
    expect(runMaintenance(rt.db, cfg, { clock: 100 }).purged).toBe(0) // still inside the window
    const res = runMaintenance(rt.db, cfg, { clock: 400 })
    expect(res.purged_ids).toContain(a.fact_id)
    expect(rt.db.prepare('SELECT status FROM facts WHERE fact_id = ?').get(a.fact_id)).toBeUndefined()
  })

  it('never purges a fresh archive whose archived_clock is missing (calendar fallback)', async () => {
    const a = await rt.remember({ action: 'add', content: '被外部路径归档的记录' })
    await rt.admin({ action: 'archive', fact_id: a.fact_id })
    // Simulate a row archived without archived_clock: the old COALESCE(...,0) purge
    // would delete it as soon as the active-day clock passed 365.
    rt.db.prepare('UPDATE facts SET archived_clock = NULL WHERE fact_id = ?').run(a.fact_id)
    const cfg: Config = ConfigSchema.parse({ lifecycle: { purge_after_archived_days: 365 } })
    const res = runMaintenance(rt.db, cfg, { clock: 400 })
    expect(res.purged_ids).not.toContain(a.fact_id)
    expect(rt.db.prepare('SELECT status FROM facts WHERE fact_id = ?').get(a.fact_id)).toBeDefined()
  })

  it('purge survives a contradiction whose loser is being purged (FK without ON DELETE)', async () => {
    const keeper = await rt.remember({ action: 'add', content: '保留的事实' })
    const loser = await rt.remember({ action: 'add', content: '被清除的事实' })
    rt.memory.pin(keeper.fact_id) // pinned ⇒ immune to decay/archive/purge, keeps the log row alive
    await rt.admin({ action: 'archive', fact_id: loser.fact_id })
    // A resolved contradiction that named the archived fact as the loser. `fact_a`/
    // `fact_b` point at the SURVIVING fact on purpose: pointing them at the doomed
    // one would cascade-delete the log row and hide the loser FK. `loser_fact_id`
    // is ON DELETE SET NULL, so purging the loser must succeed and detach the row.
    rt.db.prepare('INSERT INTO contradiction_log (fact_a, fact_b, score, resolved, loser_fact_id) VALUES (?, ?, 0.9, 1, ?)')
      .run(keeper.fact_id, keeper.fact_id, loser.fact_id)
    const cfg: Config = ConfigSchema.parse({ lifecycle: { purge_after_archived_days: 365 } })
    const res = runMaintenance(rt.db, cfg, { clock: 400 })
    expect(res.purged_ids).toContain(loser.fact_id)
    expect(rt.db.prepare('SELECT status FROM facts WHERE fact_id = ?').get(loser.fact_id)).toBeUndefined()
    // the surviving log row is detached, not deleted
    const log = rt.db.prepare('SELECT loser_fact_id FROM contradiction_log').get() as { loser_fact_id: number | null } | undefined
    expect(log?.loser_fact_id ?? null).toBeNull()
  })

  it('purges a SUPERSEDED revision its active successor still references (self-FK, R19)', async () => {
    // A revision chain: `update` archives the original and links the new row back to it. The
    // archived half is referenced through `supersedes_id`, whose (former) NO ACTION self-FK made
    // the DELETE below throw SQLITE_CONSTRAINT_FOREIGNKEY — rolling back the whole tick and, from
    // the constructor path, leaving the process unable to start. `purgeArchived` unlinks first.
    const first = await rt.remember({ action: 'add', content: '缓存策略：先写后失效' })
    const second = await rt.remember({ action: 'update', fact_id: first.fact_id, content: '缓存策略：写穿' })
    const cfg: Config = ConfigSchema.parse({ lifecycle: { purge_after_archived_days: 365 } })
    expect(runMaintenance(rt.db, cfg, { clock: 0 }).purged).toBe(0) // same active day: not due yet
    const chain = rt.db.prepare('SELECT supersedes_id FROM facts WHERE fact_id = ?').get(second.fact_id) as { supersedes_id: number | null }
    expect(chain.supersedes_id).toBe(first.fact_id)

    const res = runMaintenance(rt.db, cfg, { clock: 400 })
    expect(res.purged_ids).toContain(first.fact_id)
    expect(rt.db.prepare('SELECT status FROM facts WHERE fact_id = ?').get(first.fact_id)).toBeUndefined()
    // The successor is detached, not cascade-deleted: retention is per revision, not per chain.
    expect(rt.db.prepare('SELECT count(*) AS n FROM facts WHERE fact_id = ?').get(second.fact_id)).toEqual({ n: 1 })
    const after = rt.db.prepare('SELECT supersedes_id FROM facts WHERE fact_id = ?').get(second.fact_id) as { supersedes_id: number | null }
    expect(after.supersedes_id ?? null).toBeNull()
  })

  it('purges under the CALENDAR branch too: trust off + window 0 fires without a backfill', async () => {
    const first = await rt.remember({ action: 'add', content: '网关配置：轮询' })
    const second = await rt.remember({ action: 'update', fact_id: first.fact_id, content: '网关配置：推送' })
    // `enabled = 0` selects `julianday('now') - julianday(archived_at)`, so a window of 0 is
    // already satisfied seconds after the archive — the branch where the old crash was IMMEDIATE
    // rather than one purge window away.
    const cfg: Config = ConfigSchema.parse({ trust: { enabled: false }, lifecycle: { purge_after_archived_days: 0 } })
    const res = runMaintenance(rt.db, cfg, { clock: 0 })
    expect(res.purged_ids).toContain(first.fact_id)
    expect(rt.db.prepare('SELECT status, supersedes_id FROM facts WHERE fact_id = ?').get(second.fact_id))
      .toEqual({ status: 'active', supersedes_id: null })
  })

  it('a fresh process starts on a store whose revision chain crossed the purge window', async () => {
    const first = await rt.remember({ action: 'add', content: '监控方案：轮询' })
    await rt.remember({ action: 'update', fact_id: first.fact_id, content: '监控方案：推送' })
    // Force the archived revision past the window (its `archived_clock` is the clock at archive
    // time, which was 0 here). The restart below runs a tick from the store constructor.
    rt.db.prepare("UPDATE facts SET archived_clock = -400 WHERE status = 'archived'").run()
    const restarted = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    expect(restarted.db.prepare('SELECT count(*) AS n FROM facts WHERE fact_id = ?').get(first.fact_id)).toEqual({ n: 0 })
    restarted.shutdown()
  })

  it('new stores do not declare the self-referencing FK that made purge fail', () => {
    const ddl = rt.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'facts'").get() as { sql: string }
    expect(ddl.sql).not.toMatch(/supersedes_id\s+INTEGER\s+REFERENCES/i)
  })

  it('budgets one tick’s archiving and reports what it deferred', async () => {
    // The tick is ONE IMMEDIATE transaction shared with the host/CLI/MCP (busy_timeout = 5 s), so a
    // pass may not archive an unbounded backlog. ②③④ therefore share ①'s budget and the remainder
    // is reported as `archived_deferred` instead of silently waiting for the next heartbeat.
    for (let i = 0; i < 5; i++) {
      const f = await rt.remember({ action: 'add', content: `很久没被用过的事实 ${i}` })
      backdate(f.fact_id, 'last_retrieved_at', 400)
    }
    const cfg: Config = ConfigSchema.parse({ trust: { idle_calendar_days: 365 } })

    const budgeted = runMaintenance(rt.db, cfg, { clock: 0, budget: 2 })
    expect(budgeted.archived_idle).toBe(2)
    expect(budgeted.archived_deferred).toBe(3) // what the next pass still has to archive

    // ⑤ shares the budget too: archived rows past the window are purged `budget` at a time. Four
    // extra rows are inserted directly so the pass has a remainder to report (only the two rows
    // archived above are due otherwise).
    rt.db.prepare("UPDATE facts SET archived_clock = -400 WHERE status = 'archived'").run()
    const insArchived = rt.db.prepare(
      `INSERT INTO facts (content, category, settle_clock, status, archived_clock, archived_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    for (let i = 0; i < 4; i++) insArchived.run(`待清除事实 ${i}`, 'bench', 0, 'archived', -400, '2024-01-01 00:00:00', '2020-01-01 00:00:00', '2020-01-01 00:00:00')
    const budgetedPurge = runMaintenance(rt.db, cfg, { clock: 0, budget: 2 })
    expect(budgetedPurge.purged).toBe(2)
    expect(budgetedPurge.purged_deferred).toBe(4) // the rest of the window-expired backlog

    // A forced pass (`budget: 0`) is the "clean up now" path and drains everything, as before.
    const full = runMaintenance(rt.db, cfg, { clock: 0, budget: 0 })
    expect(full.archived_idle).toBe(1) // the last idle-due row (2 were archived by the budgeted pass)
    expect(full.archived_deferred).toBe(0)
    expect(full.purged).toBe(full.purged_ids.length)
    expect(full.purged_deferred).toBe(0)
  })

  it('spends ONE purge budget across both branches and reports the real backlog', () => {
    // `purgeArchived` has two mutually exclusive branches (active-day clock vs calendar). Each used
    // to splice its OWN `LIMIT :budget`, so a pass with rows in both could delete 2 × budget — the
    // unbounded write-lock hold the budget exists to prevent — and `purged.length === budget` (the
    // tick's deferral test) stayed false, so the leftover backlog went unreported.
    const cfg: Config = ConfigSchema.parse({ lifecycle: { purge_after_archived_days: 30 } })
    const ins = rt.db.prepare(
      `INSERT INTO facts (content, category, settle_clock, status, archived_clock, archived_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    // Branch 1 (trust on, clock set): due on ACTIVE days. 2 rows — under the budget of 3.
    for (let i = 0; i < 2; i++) ins.run(`时钟分支 ${i}`, 'bench', 0, 'archived', -400, '2024-01-01 00:00:00', '2020-01-01 00:00:00', '2020-01-01 00:00:00')
    // Branch 2 (archived_clock NULL): due on CALENDAR days. 5 rows — so the SHARED budget of 3 runs
    // out partway through this branch, and the other 4 rows are the backlog the tick must report.
    for (let i = 0; i < 5; i++) ins.run(`日历分支 ${i}`, 'bench', 0, 'archived', null, '2020-01-01 00:00:00', '2020-01-01 00:00:00', '2020-01-01 00:00:00')

    const res = runMaintenance(rt.db, cfg, { clock: 0, budget: 3 })
    // 2 (branch 1) + at most 1 (branch 2) — never 2 × budget.
    expect(res.purged).toBe(3)
    expect(res.purged_ids).toHaveLength(3)
    expect(res.purged_deferred).toBe(4)

    // A full pass drains both branches: nothing is lost to the shared accounting.
    const full = runMaintenance(rt.db, cfg, { clock: 0, budget: 0 })
    expect(full.purged).toBe(4)
    expect(full.purged_deferred).toBe(0)
  })

  it('enabled=false stops decay but still runs TTL / idle / purge (D12)', async () => {
    const decayTarget = await rt.remember({ action: 'add', content: '信任关闭时不该衰减的事实' })
    const idleTarget = await rt.remember({ action: 'add', content: '信任关闭时仍会被 idle 清理的事实' })
    backdate(idleTarget.fact_id, 'last_retrieved_at', 400)
    const cfg: Config = ConfigSchema.parse({ trust: { enabled: false, idle_calendar_days: 365 } })
    const clockBefore = Number((rt.db.prepare("SELECT value FROM avantf_stats WHERE key = 'trust_clock'").get() as { value: string }).value)
    // A pass 50 active days later would decay (and forcibly forget) the first fact if
    // trust were enabled; disabled means: no decay, but the calendar idle sweep runs.
    const res = runMaintenance(rt.db, cfg, { clock: clockBefore + 50 })
    expect(res.settled).toBe(0)
    expect(res.archived_forgot).toBe(0)
    expect(res.archived_idle).toBe(1)
    const kept = rt.db.prepare('SELECT status, trust_score FROM facts WHERE fact_id = ?').get(decayTarget.fact_id) as { status: string; trust_score: number }
    expect(kept.status).toBe('active')
    expect(kept.trust_score).toBeCloseTo(0.5, 6) // stored value untouched
    const idleRow = rt.db.prepare('SELECT status FROM facts WHERE fact_id = ?').get(idleTarget.fact_id) as { status: string }
    expect(idleRow.status).toBe('archived')
  })

  it('the clock is only advanced by presence, never by a maintenance pass', async () => {
    await rt.remember({ action: 'add', content: '维护不推进活跃日时钟' })
    const before = Number((rt.db.prepare("SELECT value FROM avantf_stats WHERE key = 'trust_clock'").get() as { value: string }).value)
    runMaintenance(rt.db, ConfigSchema.parse({}), { clock: before + 30 })
    const after = Number((rt.db.prepare("SELECT value FROM avantf_stats WHERE key = 'trust_clock'").get() as { value: string }).value)
    expect(after).toBe(before) // only `advancePresence` writes the clock
  })
})
