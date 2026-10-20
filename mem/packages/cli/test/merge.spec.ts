import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'lib', 'index.js')

/**
 * Each scenario gets its OWN data home: the merge command reads one home's memory.db and writes the
 * other's, so a shared fixture would make "source"/"target" ambiguous.
 */
const homes: string[] = []

function makeHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), 'avf-merge-' + label + '-'))
  homes.push(home)
  return home
}

function memoryDbOf(home: string): string {
  return join(home, 'memory', 'memory.db')
}

/**
 * node:sqlite through createRequire, never a static import: Vite 5 (this package's vitest) does not
 * know the builtin and tries to resolve a file called "sqlite". The runtime call also mirrors how
 * the engine loads it.
 */
interface RawDatabase {
  prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown }
  close(): void
}
type DatabaseCtor = new (path: string, options?: { readOnly?: boolean }) => RawDatabase

function openDatabase(path: string, readOnly = false): RawDatabase {
  const require_ = createRequire(import.meta.url)
  const module = require_('node:sqlite') as { DatabaseSync?: DatabaseCtor }
  if (typeof module.DatabaseSync !== 'function') throw new Error('node:sqlite unavailable')
  return new module.DatabaseSync(path, { readOnly })
}

function runRaw(args: string[], home: string): string {
  return execFileSync('node', [CLI, ...args], {
    env: { ...process.env, AVANTF_HOME: home },
    encoding: 'utf8',
  })
}

function run(args: string[], home: string): any {
  return JSON.parse(runRaw(args, home))
}

function runFail(args: string[], home: string): { status: number; stderr: string } {
  const result = spawnSync('node', [CLI, ...args], { env: { ...process.env, AVANTF_HOME: home }, encoding: 'utf8' })
  return { status: result.status ?? -1, stderr: result.stderr ?? '' }
}

function add(home: string, content: string): { fact_id: number; is_new: boolean } {
  return run(['add', content], home)
}

/** ACTIVE contents, newest-first as the CLI lists them. */
function activeContents(home: string): string[] {
  const page = run(['list', '--status', 'active', '--limit', '200'], home) as { facts: { content: string }[] }
  return page.facts.map((fact) => fact.content)
}

/** Total rows in a database, independent of the CLI (proves "zero writes" at the storage level). */
function countFacts(dbPath: string): number {
  const db = openDatabase(dbPath, true)
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n)
  } finally {
    db.close()
  }
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

describe('CLI merge', () => {
  it('unions two databases that share ids but not contents: no overwrite, no id reuse', () => {
    const target = makeHome('t1')
    const source = makeHome('s1')
    const targetA = add(target, '目标事实甲')
    const targetB = add(target, '目标事实乙')
    const sourceA = add(source, '源事实甲')
    const sourceB = add(source, '源事实乙')
    // The precondition the command exists for: identical ids, different facts.
    expect([sourceA.fact_id, sourceB.fact_id]).toEqual([targetA.fact_id, targetB.fact_id])

    const report = run(['merge', memoryDbOf(source)], target)

    expect(report).toMatchObject({
      mode: 'db',
      source: memoryDbOf(source),
      source_active: 2,
      added: 2,
      would_add: 0,
      skipped_existing: 0,
      skipped_archived: 0,
      failed: [],
    })
    // New target ids, never the source ids: nothing was written over rows 1/2.
    expect(report.new_ids).toEqual([
      { source_fact_id: sourceA.fact_id, new_fact_id: 3 },
      { source_fact_id: sourceB.fact_id, new_fact_id: 4 },
    ])

    expect(run(['show', String(targetA.fact_id)], target).content).toBe('目标事实甲')
    expect(run(['show', String(targetB.fact_id)], target).content).toBe('目标事实乙')
    const contents = activeContents(target)
    expect(contents).toHaveLength(4)
    expect(contents).toEqual(expect.arrayContaining(['目标事实甲', '目标事实乙', '源事实甲', '源事实乙']))
    // Default provenance is the source database itself, so a later audit can tell them apart.
    expect(run(['show', '3'], target).sources).toEqual([{ kind: 'manual', ref: 'merge:' + memoryDbOf(source) }])
  }, 60_000)

  it('does not re-import an existing content and leaves its assert_count alone', () => {
    const target = makeHome('t2')
    const source = makeHome('s2')
    const common = add(target, '两边都有的共同事实')
    add(source, '两边都有的共同事实')
    add(source, '源库独有的新事实')
    expect(run(['show', String(common.fact_id)], target).assert_count).toBe(1)

    const report = run(['merge', memoryDbOf(source), '--source-ref', 'tool:merge-test'], target)

    expect(report).toMatchObject({ source_active: 2, added: 1, would_add: 0, skipped_existing: 1, failed: [] })
    const after = run(['show', String(common.fact_id)], target)
    expect(after.content).toBe('两边都有的共同事实')
    expect(after.assert_count).toBe(1) // a duplicate add would have made this 2
    // --source-ref overrides the default merge:<path> provenance.
    const imported = report.new_ids[0].new_fact_id as number
    expect(run(['show', String(imported)], target).sources).toEqual([{ kind: 'tool', ref: 'merge-test' }])
  }, 60_000)

  it('--dry-run reports the plan and writes nothing', () => {
    const target = makeHome('t3')
    const source = makeHome('s3')
    add(target, '目标基线事实')
    add(source, '待合并甲')
    add(source, '待合并乙')
    const before = countFacts(memoryDbOf(target))
    const contentsBefore = activeContents(target)

    const report = run(['merge', memoryDbOf(source), '--dry-run'], target)

    expect(report).toMatchObject({
      source_active: 2,
      added: 0,
      would_add: 2,
      skipped_existing: 0,
      skipped_archived: 0,
      failed: [],
      new_ids: [],
    })
    expect(countFacts(memoryDbOf(target))).toBe(before)
    expect(activeContents(target)).toEqual(contentsBefore)
    // The source is not touched either.
    expect(countFacts(memoryDbOf(source))).toBe(2)
  }, 60_000)

  it('skips archived source facts (they never enter the target active corpus)', () => {
    const target = makeHome('t4')
    const source = makeHome('s4')
    const archived = add(source, '源库已归档事实')
    run(['archive', String(archived.fact_id)], source)
    add(source, '源库活跃事实')

    const report = run(['merge', memoryDbOf(source)], target)

    expect(report).toMatchObject({ source_active: 1, added: 1, skipped_archived: 1, skipped_existing: 0, failed: [] })
    expect(activeContents(target)).toEqual(['源库活跃事实'])
  }, 60_000)

  it('treats an ARCHIVED target row as existing, so it is never revived', () => {
    const target = makeHome('t5')
    const source = makeHome('s5')
    const archived = add(target, '目标已归档事实')
    run(['archive', String(archived.fact_id)], target)
    add(source, '目标已归档事实')
    add(source, '源库新增事实')

    const report = run(['merge', memoryDbOf(source)], target)

    // findByContent does not filter status, so the archive row is the identity and must be skipped.
    expect(report).toMatchObject({ added: 1, skipped_existing: 1, failed: [] })
    const stillArchived = run(['list', '--status', 'archived', '--limit', '200'], target) as { facts: { content: string }[] }
    expect(stillArchived.facts.map((fact) => fact.content)).toContain('目标已归档事实')
    expect(activeContents(target)).toEqual(['源库新增事实'])
  }, 60_000)

  it('matches content identity AFTER NFC normalization, not raw bytes', () => {
    const target = makeHome('t6')
    const source = makeHome('s6')
    add(target, 'caf\u00e9 记忆') // precomposed
    // The database is created without facts, then the decomposed spelling is planted directly:
    // the CLI's own add would normalize it before storing, and this test is about what a FOREIGN
    // row (an older host, a hand-edited file) looks like on disk.
    run(['stats'], source)
    const db = openDatabase(memoryDbOf(source))
    try {
      db.prepare('INSERT INTO facts (content, settle_clock) VALUES (?, 0)').run('cafe\u0301 记忆')
    } finally {
      db.close()
    }

    const report = run(['merge', memoryDbOf(source)], target)

    // Byte-different, NFC-equal: the target row is the identity, so nothing is written.
    expect(report).toMatchObject({ source_active: 1, added: 0, skipped_existing: 1, failed: [] })
    const targetRow = run(['show', '1'], target)
    expect(targetRow.content).toBe('caf\u00e9 记忆')
    expect(targetRow.assert_count).toBe(1)
    expect(activeContents(target)).toEqual(['caf\u00e9 记忆'])
  }, 60_000)

  it('collects a refused row into failed and still imports the rows around it', () => {
    const target = makeHome('t6')
    const source = makeHome('s6')
    add(source, '失败前的事实')
    // A high-confidence credential shape is refused by the store's write-side guard (P-03). It can
    // only be planted by raw SQL because add itself refuses it — which is what makes it a stable
    // per-row failure for this test.
    const secret = 'ghp_AbCdEfGhIjKlMnOpQrStUvWx'
    const db = openDatabase(memoryDbOf(source))
    try {
      db.prepare('INSERT INTO facts (content, settle_clock) VALUES (?, 0)').run(secret)
    } finally {
      db.close()
    }
    add(source, '失败后的事实')

    const report = run(['merge', memoryDbOf(source)], target)

    expect(report.added).toBe(2)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].source_fact_id).toBe(2)
    expect(report.failed[0].error).toContain('已拒绝写入明文')
    // The row BEFORE the failure and the row AFTER it both landed.
    expect(report.new_ids.map((entry: { source_fact_id: number }) => entry.source_fact_id)).toEqual([1, 3])
    const contents = activeContents(target)
    expect(contents).toHaveLength(2)
    expect(contents).not.toContain(secret)
  }, 60_000)

  it('keeps merge:<source path> provenance even when the source row has its own source', () => {
    const target = makeHome('t9')
    const source = makeHome('s9')
    const fact = add(source, '源库带来源的事实')
    // A source row may carry provenance of its own; `merge`'s documented contract is still
    // merge:<absolute path> for every imported row (the shared import loop can prefer embedded
    // sources — merge turns that off so the origin host's labels do not silently take over).
    const db = openDatabase(memoryDbOf(source))
    try {
      db.prepare('INSERT INTO fact_sources (fact_id, kind, ref) VALUES (?, ?, ?)').run(fact.fact_id, 'tool', 'origin')
    } finally {
      db.close()
    }

    const report = run(['merge', memoryDbOf(source)], target)

    expect(report).toMatchObject({ added: 1, skipped_existing: 0, failed: [] })
    expect(run(['show', String(report.new_ids[0].new_fact_id)], target).sources)
      .toEqual([{ kind: 'manual', ref: 'merge:' + memoryDbOf(source) }])
  }, 60_000)

  it('exits non-zero when the source path does not exist', () => {
    const target = makeHome('t7')
    const result = runFail(['merge', join(target, 'does-not-exist.db')], target)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('源库不存在或不是文件')
  }, 60_000)
})
