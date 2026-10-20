/**
 * `avantf-mem restore <file>` — the CLI face of the full-fidelity rebuild.
 *
 * The engine spec (`core/test/facts_restore.spec.ts`) owns the field-by-field promise; this file is
 * about the SURFACE, and it pins the decisions that only argv can get wrong:
 *
 *   1. a v2 export (what `export --out` writes today, brotli by extension) restores into an empty
 *      home with ids, archived rows and metadata intact, and the report is the engine's plus
 *      `file`/`codec`;
 *   2. a v1 file restores too (the shape of every backup already on disk);
 *   3. a NON-empty home is refused with a non-zero exit and zero writes, and a second restore is
 *      refused the same way;
 *   4. a corrupt file / unknown version exits non-zero and writes nothing;
 *   5. `--dry-run` is a plan (counts only, zero writes);
 *   6. `restore <fact_id>` STILL unarchives one fact — the command has two meanings and a bare
 *      integer must keep the old one.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'lib', 'index.js')

const homes: string[] = []

function makeHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), 'avf-restore-' + label + '-'))
  homes.push(home)
  return home
}

function memoryDbOf(home: string): string {
  return join(home, 'memory', 'memory.db')
}

interface RawStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}
interface RawDatabase {
  prepare(sql: string): RawStatement
  close(): void
}
type DatabaseCtor = new (path: string, options?: { readOnly?: boolean }) => RawDatabase

function openDatabase(path: string, readOnly = false): RawDatabase {
  const require_ = createRequire(import.meta.url)
  const module = require_('node:sqlite') as { DatabaseSync?: DatabaseCtor }
  if (typeof module.DatabaseSync !== 'function') throw new Error('node:sqlite unavailable')
  return new module.DatabaseSync(path, { readOnly })
}

function run(args: string[], home: string): any {
  return JSON.parse(execFileSync('node', [CLI, ...args], {
    env: { ...process.env, AVANTF_HOME: home },
    encoding: 'utf8',
  }))
}

function runFail(args: string[], home: string): { status: number; stderr: string } {
  const result = spawnSync('node', [CLI, ...args], { env: { ...process.env, AVANTF_HOME: home }, encoding: 'utf8' })
  return { status: result.status ?? -1, stderr: result.stderr ?? '' }
}

function add(home: string, content: string, extra: string[] = []): { fact_id: number; is_new: boolean } {
  return run(['add', content, ...extra], home)
}

function countFacts(dbPath: string): number {
  const db = openDatabase(dbPath, true)
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n)
  } finally {
    db.close()
  }
}

function ftsRows(dbPath: string): number {
  const db = openDatabase(dbPath, true)
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM facts_fts').get() as { n: number }).n)
  } finally {
    db.close()
  }
}

function rowOf(dbPath: string, content: string): Record<string, unknown> {
  const db = openDatabase(dbPath, true)
  try {
    return db.prepare('SELECT * FROM facts WHERE content = ?').get(content) as Record<string, unknown>
  } finally {
    db.close()
  }
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

describe('CLI restore <snapshot>', () => {
  it('rebuilds an EMPTY home from a v2 export: ids, archived rows and metadata all come back', () => {
    const A = makeHome('a1')
    const B = makeHome('b1')
    const first = add(A, '活跃事实甲', ['--category', 'project', '--ttl', '30'])
    const second = add(A, '已归档事实乙')
    run(['archive', String(second.fact_id), '--reason', 'forgot'], A)

    // The values v2 carries and no CLI flag can set: plant them, exactly like a migrated library.
    const dbA = openDatabase(memoryDbOf(A))
    try {
      dbA.prepare(
        'UPDATE facts SET settle_clock = ?, retrieval_count = ?, bonus_count = ?, mirror_source = ?, trust_score = ? WHERE fact_id = ?',
      ).run(9, 4, 1, 'laptop', 0.87, first.fact_id)
    } finally {
      dbA.close()
    }

    const out = join(A, 'facts.json.br')
    const exported = run(['export', '--status', 'all', '--out', out], A)
    expect(exported).toMatchObject({ out, codec: 'brotli', counts: { active: 1, archived: 1 } })

    const report = run(['restore', out], B)
    expect(report).toMatchObject({
      file: out,
      codec: 'brotli',
      version: 2,
      restored: 2,
      active: 1,
      archived: 1,
      fts_rows: 2,
    })
    expect(report.entities).toMatchObject({ rebuilt: 1, deferred: 0 })
    expect(report.vectors.hint).toContain('vectors --fix')
    expect(report.vectors.restored).toBe(0)

    // fact_id is PRESERVED (the whole point: the supersedes chain and provenance rows point at it).
    const restored = rowOf(memoryDbOf(B), '活跃事实甲')
    expect(restored.fact_id).toBe(first.fact_id)
    expect(restored.settle_clock).toBe(9)
    expect(restored.retrieval_count).toBe(4)
    expect(restored.bonus_count).toBe(1)
    expect(restored.mirror_source).toBe('laptop')
    expect(Number(restored.trust_score)).toBeCloseTo(0.87, 9)
    expect(restored.category).toBe('project')
    expect(restored.ttl_days).toBe(30)
    expect(restored.semantic_vector).toBeNull()

    // The archived half really is archived, and the CLI's own listing agrees.
    const archivedRow = rowOf(memoryDbOf(B), '已归档事实乙')
    expect(archivedRow.status).toBe('archived')
    expect(archivedRow.archive_reason).toBe('forgot')
    expect(archivedRow.archived_at).toBeTruthy()
    const archivedList = run(['list', '--status', 'archived', '--limit', '10'], B) as { facts: { content: string }[] }
    expect(archivedList.facts.map((fact) => fact.content)).toEqual(['已归档事实乙'])

    // FTS was maintained by the trigger: same row count as facts.
    expect(ftsRows(memoryDbOf(B))).toBe(2)
    expect(countFacts(memoryDbOf(B))).toBe(2)
  }, 60_000)

  it('restores a v1 file: archived rows return, metadata_missing counts what it could not carry', () => {
    const home = makeHome('v1')
    const dir = makeHome('v1-file')
    const file = join(dir, 'memory-20261020-160149.json.br')
    // A genuine v1 document: only the columns the historical exporter wrote.
    const v1 = {
      format: 'avantf-mem-facts',
      version: 1,
      exported_at: '2026-10-20T08:01:49.000Z',
      source: { data_home: '/home/user/.avantf', db: '/home/user/.avantf/memory/memory.db', counts: { active: 2, archived: 2 } },
      facts: [
        {
          source_id: 1, content: '平台组负责统一网关', category: 'project', status: 'active',
          created_at: '2026-09-01 01:00:00', updated_at: '2026-09-02 02:00:00', ttl_days: 30,
          pinned: false, pinned_at: null, trust_score: 0.82, assert_count: 3, helpful_count: 1,
          last_reinforced_at: '2026-09-04 00:00:00',
          sources: [{ kind: 'manual', ref: 'import:memory-20261020-160149.json.br' }],
          valid_from: '2026-09-01', valid_to: null, supersedes_source_id: null, archive: null,
        },
        {
          source_id: 2, content: '旧版：项目使用 MySQL', category: 'project', status: 'archived',
          created_at: '2026-08-01 01:00:00', updated_at: '2026-08-10 02:00:00', ttl_days: 0,
          pinned: false, pinned_at: null, trust_score: 0.31, assert_count: 1, helpful_count: 0,
          last_reinforced_at: null, sources: [], valid_from: null, valid_to: '2026-08-10',
          supersedes_source_id: null, archive: { at: '2026-08-10 02:00:00', reason: 'superseded' },
        },
        {
          source_id: 3, content: '新版：项目使用 PostgreSQL', category: 'project', status: 'active',
          created_at: '2026-08-10 02:00:00', updated_at: '2026-08-10 02:00:00', ttl_days: 0,
          pinned: true, pinned_at: '2026-08-11 00:00:00', trust_score: 1, assert_count: 1, helpful_count: 0,
          last_reinforced_at: null, sources: [], valid_from: null, valid_to: null,
          supersedes_source_id: 2, archive: null,
        },
        {
          source_id: 4, content: '已经遗忘的低信任事实', category: 'general', status: 'archived',
          created_at: '2026-07-01 01:00:00', updated_at: '2026-07-01 01:00:00', ttl_days: 0,
          pinned: false, pinned_at: null, trust_score: 0.05, assert_count: 1, helpful_count: 0,
          last_reinforced_at: null, sources: [], valid_from: null, valid_to: null,
          supersedes_source_id: null, archive: { at: '2026-09-01 00:00:00', reason: 'forgot' },
        },
      ],
    }
    writeFileSync(file, JSON.stringify(v1))

    const report = run(['restore', file], home)
    expect(report).toMatchObject({ version: 1, restored: 4, active: 2, archived: 2, fts_rows: 4 })
    expect(report.entities).toMatchObject({ rebuilt: 2, deferred: 0 })

    // v1 had no settle_clock: the CURRENT clock (0 on a fresh home) is the no-decay baseline, and
    // trust comes from the document untouched.
    const row = rowOf(memoryDbOf(home), '平台组负责统一网关')
    expect(row.settle_clock).toBe(0)
    expect(Number(row.trust_score)).toBeCloseTo(0.82, 9)
    expect(row.created_at).toBe('2026-09-01 01:00:00')

    // The archived rows are the ones that used to be lost.
    expect(rowOf(memoryDbOf(home), '旧版：项目使用 MySQL').status).toBe('archived')
    expect(rowOf(memoryDbOf(home), '旧版：项目使用 MySQL').archive_reason).toBe('superseded')
    expect(Number(rowOf(memoryDbOf(home), '新版：项目使用 PostgreSQL').supersedes_id)).toBe(2)

    // Per-field absence accounting: nine v2-only columns × four facts, and none of v1's own.
    const missing = report.metadata_missing as Record<string, number>
    for (const field of [
      'settle_clock', 'bonus_count', 'bonus_window_at', 'retrieval_count',
      'last_retrieved_at', 'mirror_source', 'mirror_target', 'entities_version', 'conflict_checked',
    ]) {
      expect(missing[field], field).toBe(4)
    }
    expect(missing.created_at).toBe(0)
    expect(missing.archive).toBe(0)
    expect(missing.sources).toBe(0)
  }, 60_000)

  it('refuses a NON-empty home (zero writes) and refuses a second restore', () => {
    const A = makeHome('a3')
    const B = makeHome('b3')
    add(A, '源库事实')
    const out = join(A, 'facts.json')
    run(['export', '--out', out], A)

    add(B, '目标库自己的事实')
    const before = countFacts(memoryDbOf(B))
    const refused = runFail(['restore', out], B)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('不是空的')
    expect(refused.stderr).toContain('import / merge')
    expect(countFacts(memoryDbOf(B))).toBe(before)
    expect(countFacts(memoryDbOf(B))).toBe(1)

    // A fresh home accepts it once; restoring the SAME file again there is refused (the facts table
    // is no longer empty), which is what makes `restore` un-repeatable by construction.
    const C = makeHome('c3')
    expect(run(['restore', out], C).restored).toBe(1)
    const again = runFail(['restore', out], C)
    expect(again.status).not.toBe(0)
    expect(again.stderr).toContain('不是空的')
    expect(countFacts(memoryDbOf(C))).toBe(1)
  }, 60_000)

  it('writes nothing for a corrupt file or an unknown version, and --dry-run is a plan', () => {
    const A = makeHome('a4')
    const B = makeHome('b4')
    add(A, '活跃事实甲')
    const archived = add(A, '已归档事实乙')
    run(['archive', String(archived.fact_id)], A)
    const out = join(A, 'facts.json')
    run(['export', '--out', out], A)

    // --dry-run: counts only, zero writes, and it names the target's current fact count so a refusal
    // is predictable rather than surprising.
    const plan = run(['restore', out, '--dry-run'], B)
    expect(plan).toMatchObject({
      dry_run: true,
      would_restore: { total: 2, active: 1, archived: 1 },
      target_facts: 0,
      restored: 0,
      fts_rows: 0,
    })
    expect(countFacts(memoryDbOf(B))).toBe(0)

    // Bad version / corrupt bytes: a non-zero exit and still zero facts.
    const badVersion = join(B, 'bad-version.json')
    writeFileSync(badVersion, JSON.stringify({ format: 'avantf-mem-facts', version: 3, facts: [] }))
    const versionFailure = runFail(['restore', badVersion], B)
    expect(versionFailure.status).not.toBe(0)
    expect(versionFailure.stderr).toContain('版本')

    const corrupt = join(B, 'corrupt.json')
    writeFileSync(corrupt, 'this is not a snapshot at all')
    const corruptFailure = runFail(['restore', corrupt], B)
    expect(corruptFailure.status).not.toBe(0)
    expect(corruptFailure.stderr).toContain('无法识别导出文件')

    const missing = runFail(['restore', join(B, 'does-not-exist.json')], B)
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('不存在')
    expect(countFacts(memoryDbOf(B))).toBe(0)
  }, 90_000)

  it('a bare integer still unarchives ONE fact (the old meaning of restore)', () => {
    const home = makeHome('legacy')
    const fact = add(home, '会被归档再恢复的事实')
    run(['archive', String(fact.fact_id)], home)
    expect((run(['list', '--status', 'archived', '--limit', '10'], home) as { facts: unknown[] }).facts).toHaveLength(1)

    // No file named `1` in cwd: the integer stays a fact id.
    run(['restore', String(fact.fact_id)], home)
    const active = run(['list', '--status', 'active', '--limit', '10'], home) as { facts: { content: string }[] }
    expect(active.facts.map((item) => item.content)).toEqual(['会被归档再恢复的事实'])
  }, 60_000)

  it('a v2 export still IMPORTS through the union path (restore did not change import)', () => {
    const A = makeHome('a6')
    const B = makeHome('b6')
    add(A, '活跃事实甲')
    const archived = add(A, '已归档事实乙')
    run(['archive', String(archived.fact_id)], A)
    const out = join(A, 'facts.json')
    run(['export', '--out', out], A)

    add(B, '目标库自己的事实') // takes fact_id 1 in the target
    const report = run(['import', out], B)
    expect(report).toMatchObject({ version: 2, total: 2, imported: 1, skipped_archived: 1, failed: [] })
    expect(countFacts(memoryDbOf(B))).toBe(2)
    // The union path is unchanged: a NEW id (the source's id 1 belongs to another fact here), the
    // v2 metadata IGNORED (a fresh assertion, not the source's counters), and no archived revival.
    const imported = rowOf(memoryDbOf(B), '活跃事实甲')
    expect(imported.fact_id).not.toBe(1)
    expect(imported.assert_count).toBe(1)
    expect(rowOf(memoryDbOf(B), '已归档事实乙')).toBeUndefined()
  }, 60_000)
})
