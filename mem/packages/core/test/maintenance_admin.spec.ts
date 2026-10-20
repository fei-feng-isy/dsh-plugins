/**
 * `mem_admin` maintenance actions: export / import / merge / restore_snapshot.
 *
 * What this file pins, and why each property is load-bearing:
 *
 *   1. every path parameter is confined to THIS run's data root — absolute escape, `..` and a
 *      symlink that points outside are all refused on BOTH the read and the write side;
 *   2. export returns a RECEIPT, never the document body; the bytes on disk decode to the same
 *      facts and the counts match the database;
 *   3. import is the existing content-union (idempotent, dry-run writes nothing) and merge is the
 *      existing read-only db union (the source file is byte-identical afterwards);
 *   4. restore_snapshot requires `confirm: true`, refuses a non-empty facts table, writes nothing on
 *      a dry run, and — the point of exposing it as a tool — a 233-row rebuild is IMMEDIATELY
 *      searchable through `rt.recall` in the same process (live index reloaded, FTS from triggers).
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { runToolSpec } from '../src/dispatch.js'
import { ADMIN_TOOL } from '@avantf/mem-contract'
import {
  decodeFactsExport,
  encodeFactsExport,
  exportFacts,
  isSqliteDatabase,
  parseFactsExport,
  type FactsExportDocument,
  type ImportReport,
  type MergeReport,
} from '../src/facts_io.js'
import type { SemanticBackend } from '@avantf/mem-retrieval'

/** No model, no download: these specs are about files, paths and the rebuild, not embeddings. */
class NoModel implements SemanticBackend {
  readonly name = 'maintenance_never_warm'
  readonly dim = 768
  isAvailable(): boolean { return false }
  async encode(): Promise<Float32Array> { throw new Error('no model') }
  async encodeBatch(): Promise<Float32Array[]> { throw new Error('no model') }
}

const homes: string[] = []
const runtimes: AvantfRuntime[] = []

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'avantf-admin-' + label + '-'))
  homes.push(dir)
  return dir
}

function makeRuntime(label: string): AvantfRuntime {
  const rt = buildRuntime({ dataHome: tempDir(label), semantic: new NoModel() })
  runtimes.push(rt)
  return rt
}

function stopRuntime(rt: AvantfRuntime): void {
  rt.shutdown()
  const index = runtimes.indexOf(rt)
  if (index >= 0) runtimes.splice(index, 1)
}

afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.shutdown()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function countOf(rt: AvantfRuntime): number {
  return Number((rt.db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n)
}

/** Narrow the content-detected import report: this file's JSON cases always answer `mode: 'json'`. */
function jsonReport(report: ImportReport | MergeReport): ImportReport {
  if (report.mode !== 'json') throw new Error('expected a JSON import report, got mode=' + report.mode)
  return report
}

/** Narrow the db case (import of a SQLite file, or the explicit merge action). */
function dbReport(report: ImportReport | MergeReport): MergeReport {
  if (report.mode !== 'db') throw new Error('expected a db report, got mode=' + report.mode)
  return report
}

/** A valid v2 snapshot with `total` synthetic ACTIVE facts (the restore fixture builder). */
function snapshotOf(total: number): FactsExportDocument {
  const facts = Array.from({ length: total }, (_, index) => {
    const id = index + 1
    return {
      source_id: id,
      content: '事实编号 restoretok' + String(id),
      category: 'general',
      status: 'active',
      created_at: '2026-10-01 00:00:00',
      updated_at: '2026-10-01 00:00:00',
      ttl_days: 0,
      pinned: false,
      pinned_at: null,
      trust_score: 0.5,
      assert_count: 1,
      helpful_count: 0,
      last_reinforced_at: null,
      sources: [],
      valid_from: null,
      valid_to: null,
      supersedes_source_id: null,
      archive: null,
    }
  })
  return parseFactsExport(JSON.stringify({
    format: 'avantf-mem-facts',
    version: 2,
    exported_at: '2026-10-20T08:00:00.000Z',
    source: { data_home: '/tmp/source-home', db: '/tmp/source-home/memory.db', counts: { active: total, archived: 0 } },
    facts,
  }))
}

/** Write an encoded snapshot under the runtime's data root and return its root-relative path. */
function placeSnapshot(rt: AvantfRuntime, name: string, doc: FactsExportDocument): string {
  const dir = join(rt.config.home, 'incoming')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), encodeFactsExport(doc, { codec: 'brotli' }))
  return join('incoming', name)
}

describe('the model-facing tool boundary', () => {
  it('routes export through ADMIN_TOOL and rejects a confirm-less restore before dispatch', async () => {
    const rt = makeRuntime('tool-boundary')
    await rt.remember({ action: 'add', content: 'tool boundary token' })

    const exported = await runToolSpec(rt, ADMIN_TOOL, { action: 'export' })
    if (!exported.ok) throw new Error('expected an ok envelope, got: ' + exported.error)
    expect(exported.result).toMatchObject({ codec: 'brotli', overwritten: false })
    expect(JSON.stringify(exported)).not.toContain('tool boundary token')

    const invalid = await runToolSpec(rt, ADMIN_TOOL, { action: 'restore_snapshot', file: 'x.json.br' })
    expect(invalid.ok).toBe(false)
    if (invalid.ok) throw new Error('restore_snapshot without confirm must not validate')
    expect((invalid.violations ?? []).join(' ')).toContain('confirm')
  })
})

describe('mem_admin export', () => {
  it('writes <home>/backups by default, reports bytes/counts, and never returns the document', async () => {
    const rt = makeRuntime('export-default')
    await rt.remember({ action: 'add', content: '导出令牌 export-token-alpha', category: 'project' })
    await rt.remember({ action: 'add', content: '导出令牌 export-token-beta' })
    const archived = await rt.remember({ action: 'add', content: '导出令牌 export-token-archived' })
    rt.admin({ action: 'archive', fact_id: archived.fact_id })

    const report = rt.admin({ action: 'export' })
    expect(report.codec).toBe('brotli')
    expect(dirname(report.file)).toBe(join(rt.config.home, 'backups'))
    expect(basename(report.file)).toMatch(/^memory-\d{8}-\d{6}\.json\.br$/)
    expect(report.bytes).toBe(statSync(report.file).size)
    expect(report.counts).toEqual({ active: 2, archived: 1 })
    expect(report.overwritten).toBe(false)

    const decoded = decodeFactsExport(readFileSync(report.file))
    expect(decoded.codec).toBe('brotli')
    expect(decoded.doc.facts).toHaveLength(3)
    expect(report.plain_bytes).toBe(encodeFactsExport(decoded.doc, { codec: 'none' }).length)
    // The receipt is a receipt: no fact text crosses the tool boundary.
    expect(JSON.stringify(report)).not.toContain('export-token-alpha')

    // An existing target is replaced atomically, and the report says so.
    const again = rt.admin({ action: 'export', file: report.file })
    expect(again.overwritten).toBe(true)
    expect(again.file).toBe(report.file)
  })

  it('narrows facts by status while counts stay whole-database', async () => {
    const rt = makeRuntime('export-status')
    await rt.remember({ action: 'add', content: 'active-export-token' })
    const archived = await rt.remember({ action: 'add', content: 'archived-export-token' })
    rt.admin({ action: 'archive', fact_id: archived.fact_id })

    const report = rt.admin({ action: 'export', status: 'active' })
    const decoded = decodeFactsExport(readFileSync(report.file))
    expect(decoded.doc.facts.map((fact) => fact.content)).toEqual(['active-export-token'])
    expect(report.counts).toEqual({ active: 1, archived: 1 })
  })

  it('refuses absolute, .. and symlink escapes out of the data root', () => {
    const rt = makeRuntime('export-escape')
    const outside = tempDir('export-outside')
    expect(() => rt.admin({ action: 'export', file: join(outside, 'backup.json.br') })).toThrow(/数据根/)
    expect(() => rt.admin({ action: 'export', file: '../backup.json.br' })).toThrow(/数据根/)

    symlinkSync(outside, join(rt.config.home, 'escape-link'))
    expect(() => rt.admin({ action: 'export', file: 'escape-link/backup.json.br' })).toThrow(/数据根/)
  })
})

describe('mem_admin import', () => {
  it('unions content idempotently, honours dry_run, and refuses paths outside the root', async () => {
    const source = makeRuntime('import-source')
    await source.remember({ action: 'add', content: '导入令牌 import-token-alpha' })
    await source.remember({ action: 'add', content: '导入令牌 import-token-beta' })
    const exported = source.admin({ action: 'export' })

    const target = makeRuntime('import-target')
    const incoming = join(target.config.home, 'incoming')
    mkdirSync(incoming, { recursive: true })
    copyFileSync(exported.file, join(incoming, 'snapshot.json.br'))

    const first = jsonReport(await target.admin({ action: 'import', file: 'incoming/snapshot.json.br' }))
    expect(first.mode).toBe('json')
    expect(first.imported).toBe(2)
    expect(countOf(target)).toBe(2)

    const second = jsonReport(await target.admin({ action: 'import', file: 'incoming/snapshot.json.br' }))
    expect(second.imported).toBe(0)
    expect(second.skipped_existing).toBe(2)

    const dry = makeRuntime('import-dry')
    const dryIncoming = join(dry.config.home, 'incoming')
    mkdirSync(dryIncoming, { recursive: true })
    copyFileSync(exported.file, join(dryIncoming, 'snapshot.json.br'))
    const planned = jsonReport(await dry.admin({ action: 'import', file: 'incoming/snapshot.json.br', dry_run: true }))
    expect(planned.would_import).toBe(2)
    expect(planned.imported).toBe(0)
    expect(countOf(dry)).toBe(0)

    const outside = tempDir('import-outside')
    copyFileSync(exported.file, join(outside, 'snapshot.json.br'))
    await expect(target.admin({ action: 'import', file: join(outside, 'snapshot.json.br') })).rejects.toThrow(/数据根/)
    await expect(target.admin({ action: 'import', file: '../snapshot.json.br' })).rejects.toThrow(/数据根/)

    // Size is checked from stat() before the file is read into memory.
    const huge = join(target.config.home, 'huge.json')
    writeFileSync(huge, '')
    truncateSync(huge, 512 * 1024 * 1024 + 1)
    await expect(target.admin({ action: 'import', file: 'huge.json' })).rejects.toThrow(/文件过大/)
  })

  it('detects a SQLite input by content and reports mode=db (source opened read-only)', async () => {
    const source = makeRuntime('import-db-source')
    await source.remember({ action: 'add', content: '导入数据库令牌 import-db-alpha' })
    await source.remember({ action: 'add', content: '导入数据库令牌 import-db-beta' })
    source.db.pragma('wal_checkpoint(TRUNCATE)')
    const sourceDb = source.config.memory.db.path
    stopRuntime(source)

    const target = makeRuntime('import-db-target')
    const incoming = join(target.config.home, 'incoming')
    mkdirSync(incoming, { recursive: true })
    const fixture = join(incoming, 'other.db')
    copyFileSync(sourceDb, fixture)
    const before = readFileSync(fixture)
    expect(isSqliteDatabase(before)).toBe(true)

    const report = dbReport(await target.admin({ action: 'import', file: 'incoming/other.db' }))
    expect(report.mode).toBe('db')
    expect(report.source).toBe(fixture)
    expect(report.added).toBe(2)
    expect(report.new_ids).toHaveLength(2)
    expect(countOf(target)).toBe(2)
    // Same read-only guarantee as the explicit merge action.
    expect(readFileSync(fixture).equals(before)).toBe(true)

    // A dry run reports the plan without touching the target.
    const dry = makeRuntime('import-db-dry')
    const dryIncoming = join(dry.config.home, 'incoming')
    mkdirSync(dryIncoming, { recursive: true })
    copyFileSync(sourceDb, join(dryIncoming, 'other.db'))
    const planned = dbReport(await dry.admin({ action: 'import', file: 'incoming/other.db', dry_run: true }))
    expect(planned.would_add).toBe(2)
    expect(planned.added).toBe(0)
    expect(countOf(dry)).toBe(0)
  })

  it('still refuses a SQLite input outside the data root', async () => {
    const source = makeRuntime('import-db-outside-source')
    await source.remember({ action: 'add', content: '导入数据库越界令牌' })
    source.db.pragma('wal_checkpoint(TRUNCATE)')
    const sourceDb = source.config.memory.db.path
    stopRuntime(source)

    const target = makeRuntime('import-db-outside-target')
    const outside = tempDir('import-db-outside')
    const outsideDb = join(outside, 'other.db')
    copyFileSync(sourceDb, outsideDb)
    await expect(target.admin({ action: 'import', file: outsideDb })).rejects.toThrow(/数据根/)
  })

  it('refuses a symlink whose target is outside the root', async () => {
    const source = makeRuntime('import-link-source')
    await source.remember({ action: 'add', content: '链接导入令牌 import-link-token' })
    const exported = source.admin({ action: 'export' })

    const target = makeRuntime('import-link-target')
    const outside = tempDir('import-link-outside')
    const outsideFile = join(outside, 'snapshot.json.br')
    copyFileSync(exported.file, outsideFile)
    symlinkSync(outsideFile, join(target.config.home, 'linked.json.br'))

    await expect(target.admin({ action: 'import', file: 'linked.json.br' })).rejects.toThrow(/数据根/)
  })
})

describe('mem_admin merge', () => {
  it('merges a memory.db from <home>/incoming, read-only, and refuses an outside source', async () => {
    const source = makeRuntime('merge-source')
    await source.remember({ action: 'add', content: '合并令牌 merge-token-alpha' })
    await source.remember({ action: 'add', content: '合并令牌 merge-token-beta' })
    source.db.pragma('wal_checkpoint(TRUNCATE)')
    const sourceDb = source.config.memory.db.path
    stopRuntime(source)

    const target = makeRuntime('merge-target')
    const incoming = join(target.config.home, 'incoming')
    mkdirSync(incoming, { recursive: true })
    const fixture = join(incoming, 'other.db')
    copyFileSync(sourceDb, fixture)
    const before = readFileSync(fixture)

    const report = dbReport(await target.admin({ action: 'merge', file: 'incoming/other.db' }))
    expect(report.mode).toBe('db')
    expect(report.source).toBe(fixture)
    expect(report.source_active).toBe(2)
    expect(report.added).toBe(2)
    expect(countOf(target)).toBe(2)
    // The source is opened READ ONLY: not one byte may move.
    expect(readFileSync(fixture).equals(before)).toBe(true)

    const dry = makeRuntime('merge-dry')
    const dryIncoming = join(dry.config.home, 'incoming')
    mkdirSync(dryIncoming, { recursive: true })
    copyFileSync(sourceDb, join(dryIncoming, 'other.db'))
    const planned = dbReport(await dry.admin({ action: 'merge', file: 'incoming/other.db', dry_run: true }))
    expect(planned.would_add).toBe(2)
    expect(planned.added).toBe(0)
    expect(countOf(dry)).toBe(0)

    const outside = tempDir('merge-outside')
    const outsideDb = join(outside, 'other.db')
    copyFileSync(sourceDb, outsideDb)
    await expect(target.admin({ action: 'merge', file: outsideDb })).rejects.toThrow(/数据根/)
  })
})

describe('mem_admin restore_snapshot', () => {
  it('requires confirm: true and refuses a non-empty facts table', async () => {
    const target = makeRuntime('restore-guard')
    const file = placeSnapshot(target, 'snapshot.json.br', snapshotOf(2))

    // The contract's literal is the first gate; the runtime repeats it because Remote/embedder
    // callers do not necessarily pass through the tool schema.
    const untyped = target.admin as unknown as (req: unknown) => Promise<unknown>
    await expect(untyped({ action: 'restore_snapshot', file })).rejects.toThrow(/confirm/)

    await target.remember({ action: 'add', content: '非空库里的既有事实' })
    await expect(target.admin({ action: 'restore_snapshot', file, confirm: true })).rejects.toThrow(/不是空的/)
    expect(countOf(target)).toBe(1)
  })

  it('refuses a snapshot outside the data root', async () => {
    const target = makeRuntime('restore-escape')
    const outside = tempDir('restore-outside')
    const file = join(outside, 'snapshot.json.br')
    writeFileSync(file, encodeFactsExport(snapshotOf(2), { codec: 'brotli' }))
    await expect(target.admin({ action: 'restore_snapshot', file, confirm: true })).rejects.toThrow(/数据根/)
    await expect(target.admin({ action: 'restore_snapshot', file: '../snapshot.json.br', confirm: true })).rejects.toThrow(/数据根/)
  })

  it('dry_run is a plan: zero writes, target_facts is reported', async () => {
    const target = makeRuntime('restore-dry')
    const file = placeSnapshot(target, 'snapshot.json.br', snapshotOf(4))
    const report = await target.admin({ action: 'restore_snapshot', file, confirm: true, dry_run: true })
    expect(report.dry_run).toBe(true)
    expect(report.would_restore).toEqual({ total: 4, active: 4, archived: 0 })
    expect(report.target_facts).toBe(0)
    expect(countOf(target)).toBe(0)
  })

  it('rebuilds 233 facts and the SAME process can search them immediately', async () => {
    const target = makeRuntime('restore-233')
    const file = placeSnapshot(target, 'snapshot-233.json.br', snapshotOf(233))

    const report = await target.admin({ action: 'restore_snapshot', file, confirm: true })
    expect(report.restored).toBe(233)
    expect(report.active).toBe(233)
    expect(report.fts_rows).toBe(233)
    expect(report.codec).toBe('brotli')
    expect(countOf(target)).toBe(233)

    // The tool call itself must leave the live runtime usable — no restart, no CLI follow-up.
    const result = await target.recall({ action: 'search', query: 'restoretok233', limit: 5 })
    const hit = result.hits.find((entry) => entry.ref_id === 233)
    expect(hit, 'the restored fact must be visible to recall in this process').toBeDefined()
    expect(hit?.text).toContain('restoretok233')
  }, 60_000)
})
