/**
 * Plan guard for the memory FTS leg (`FactsDao.ftsSearch`) — the P1 of the 2026-10-03 performance
 * review (`docs/review/2026-10-03-performance-review.md` §1.2/§7.1).
 *
 * The pathology: with no `sqlite_stat1` row for `facts`, SQLite drives this JOIN from `facts`
 * through `idx_facts_status_category (status=?)` and RE-RUNS the whole external-content MATCH once
 * per row. The fingerprint of that shape is the INNER `SCAN f VIRTUAL TABLE INDEX 0:=M1` (the
 * healthy FTS-driven plan says `INDEX 0:M1`, no `=`). It is invisible to the other suites because
 * every one of them either reopens the store (whose open tick analyzes) or runs few rows; the
 * review's whole point is that a FRESH install's first session is exactly the bad window.
 *
 * So this spec builds the fresh-session shape on purpose: open the runtime while the database is
 * empty (its `PRAGMA optimize` therefore writes no stats), THEN seed, and assert the plan of the
 * production SQL text WITHOUT reopening. `FTS_SEARCH_SQL` is imported, not retyped, so a future
 * edit to the statement cannot leave this guard checking a stale copy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { FTS_SEARCH_SQL } from '../src/db/dao/facts.js'

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-fts-plan-'))
  mkdirSync(join(dir, 'configs'), { recursive: true })
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * The pathology's inner-loop fingerprint. The healthy plan prints `SCAN f VIRTUAL TABLE INDEX 0:M1`
 * (no `=`); the flipped one prints it as the INNER loop as `INDEX 0:=M1`.
 */
const BAD_INNER = /SCAN f VIRTUAL TABLE INDEX 0:=M1/

/** A MATCH expression the trigram tokenizer accepts; the plan does not depend on the value (bound). */
const MATCH = '"性能优" OR "能优化"'

function explain(params: unknown[], sql = FTS_SEARCH_SQL): string {
  return (rt.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
    .map((r) => r.detail)
    .join(' | ')
}

/** Number of `sqlite_stat1` rows for `facts`; 0 when the table has not been created at all. */
function factsStatRows(): number {
  try {
    return (rt.db.prepare("SELECT count(*) AS c FROM sqlite_stat1 WHERE tbl = 'facts'").get() as { c: number }).c
  } catch {
    return 0
  }
}

/**
 * The bench corpus shape (highly repeated entities, a shared CJK phrase) — the same one whose
 * selective query flipped hardest, and `facts_fts`'s triggers keep the FTS index in step.
 */
function seedFacts(n: number): void {
  const ins = rt.db.prepare(
    'INSERT INTO facts (content, category, settle_clock, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  )
  const tx = rt.db.transaction(() => {
    for (let i = 0; i < n; i++) {
      ins.run(
        `性能优化记录：svc-payment-${i % 200} 针对 cache-layer-${i % 50} 的调整（条目 ${i}）`,
        i % 2 === 0 ? 'bench' : 'other',
        0,
        'active',
        '2026-01-01 00:00:00',
        '2026-01-01 00:00:00',
      )
    }
  })
  tx()
}

describe('facts FTS leg plan (P1, 2026-10-03 performance review)', () => {
  it('drives from the FTS table on a fresh session, before any statistics exist', () => {
    seedFacts(1000)
    // The point of the fixture: the runtime opened when `facts` was EMPTY, so the open tick's
    // `PRAGMA optimize` wrote nothing — this is precisely the window a new install is in.
    expect(factsStatRows()).toBe(0)

    const shapes: [string, unknown[]][] = [
      ['no category filter (main leg + hint)', [MATCH, null, null, -1]],
      ['category filter', [MATCH, 'bench', 'bench', -1]],
      ['hint: LIMIT 1, no category', [MATCH, null, null, 1]],
    ]
    for (const [label, params] of shapes) {
      const plan = explain(params)
      expect(plan, `${label}: ${plan}`).not.toMatch(BAD_INNER)
      expect(plan, `${label}: ${plan}`).toMatch(/SCAN f VIRTUAL TABLE INDEX 0:M1/)
      expect(plan, `${label}: ${plan}`).toMatch(/SEARCH fa USING INTEGER PRIMARY KEY/)
    }
  })

  it('keeps the pinned plan after ANALYZE and after PRAGMA optimize', () => {
    seedFacts(1000)
    rt.db.exec('ANALYZE facts')
    expect(factsStatRows()).toBeGreaterThan(0)
    rt.db.pragma('optimize')

    for (const params of [[MATCH, null, null, -1], [MATCH, 'bench', 'bench', -1]] as unknown[][]) {
      const plan = explain(params)
      expect(plan, plan).not.toMatch(BAD_INNER)
      expect(plan, plan).toMatch(/SCAN f VIRTUAL TABLE INDEX 0:M1/)
    }
  })

  it('NOT INDEXED changes the plan, not the answer', () => {
    seedFacts(500)
    // The unpinned control is the statement the pathology was found in; run BOTH and compare the
    // rows they return. (Its plan here is the bad one, which is the point — it is still correct.)
    const unpinned = FTS_SEARCH_SQL.replace('JOIN facts fa NOT INDEXED ON', 'JOIN facts fa ON')
    const rows = (sql: string) =>
      new Map(
        (rt.db.prepare(sql).all(MATCH, 'bench', 'bench', -1) as { id: number; rank: number }[])
          .map((r) => [r.id, r.rank]),
      )
    const pinned = rows(FTS_SEARCH_SQL)
    expect(pinned.size).toBeGreaterThan(0)
    expect(rows(unpinned)).toEqual(pinned)
  })
})
