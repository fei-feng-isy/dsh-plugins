import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'lib', 'index.js')

/**
 * Every scenario gets its OWN data home. Export reads one home and import writes another, so a
 * shared fixture would make "source"/"target" ambiguous — and a sync test that reuses a home cannot
 * prove the fresh-machine case.
 */
const homes: string[] = []

function makeHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), 'avf-io-' + label + '-'))
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

function add(home: string, content: string, extra: string[] = []): { fact_id: number; is_new: boolean; assert_count: number } {
  return run(['add', content, ...extra], home)
}

/** ACTIVE contents, as the CLI lists them (newest first). */
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

/** One fact row by content — some carried fields (ttl_days, validity) are not on `show`. */
function factRow(dbPath: string, content: string): Record<string, unknown> {
  const db = openDatabase(dbPath, true)
  try {
    const row = db.prepare('SELECT * FROM facts WHERE content = ?').get(content)
    expect(row, 'fact ' + content).toBeTruthy()
    return row as Record<string, unknown>
  } finally {
    db.close()
  }
}

/** The provenance rows of one fact, in the DAO's order. */
function sourcesOf(dbPath: string, factId: number): { kind: string; ref: string }[] {
  const db = openDatabase(dbPath, true)
  try {
    return (db.prepare('SELECT kind, ref FROM fact_sources WHERE fact_id = ? ORDER BY kind ASC, ref ASC').all(factId) as { kind: string; ref: string }[])
      .map((row) => ({ kind: row.kind, ref: row.ref }))
  } finally {
    db.close()
  }
}

function writeDoc(dir: string, name: string, value: unknown): string {
  const file = join(dir, name)
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  return file
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

describe('CLI export / import', () => {
  it('round-trips the ACTIVE corpus by content, not by source id', () => {
    const A = makeHome('a1')
    const B = makeHome('b1')
    const first = add(A, '源库事实甲', ['--category', 'project', '--ttl', '30'])
    add(A, '源库事实乙')
    const archived = add(A, '源库事实丙')
    run(['archive', String(archived.fact_id)], A)
    // P-13 validity is planted directly: the CLI has no `add` flag for it, and a foreign host may
    // carry one. This is the value the import must map onto event_date / valid_until.
    const dbA = openDatabase(memoryDbOf(A))
    try {
      dbA.prepare('UPDATE facts SET valid_from = ?, valid_to = ? WHERE fact_id = ?')
        .run('2026-09-01', '2026-12-31', first.fact_id)
    } finally {
      dbA.close()
    }
    // B already holds a DIFFERENT fact at the same id: id 1 must not be treated as identity.
    const target = add(B, '目标库自己的事实')
    expect(target.fact_id).toBe(first.fact_id)

    const out = join(A, 'facts.json')
    const exported = run(['export', '--status', 'all', '--out', out], A)
    // '.json' means plain minified JSON: the report names the container and the sizes, and ratio 1.
    expect(exported).toMatchObject({ out, codec: 'none', counts: { active: 2, archived: 1 } })
    expect(exported.bytes).toBe(exported.plain_bytes)
    expect(exported.ratio).toBe(1)

    const report = run(['import', out], B)
    expect(report).toMatchObject({
      file: out,
      // The export now WRITES v2; the report echoes the document's version as-is.
      version: 2,
      total: 3,
      imported: 2,
      skipped_existing: 0,
      skipped_archived: 1,
      failed: [],
    })
    expect(report).not.toHaveProperty('would_import')
    expect(report.metadata_dropped).toEqual({
      timestamps: 2,
      trust: 2,
      assert_count: 0,
      helpful_count: 0,
      pinned: 0,
      supersedes: 0,
    })
    // The target's own fact survives, and both source-active facts landed as NEW ids.
    expect(activeContents(B).sort()).toEqual(['源库事实乙', '源库事实甲', '目标库自己的事实'].sort())
    expect(run(['show', String(target.fact_id)], B).content).toBe('目标库自己的事实')
    expect(report.new_ids.map((entry: { new_fact_id: number }) => entry.new_fact_id)).toEqual([2, 3])

    // Metadata v1 DOES carry: category, TTL, validity (event_date/valid_until), fallback provenance.
    const row = factRow(memoryDbOf(B), '源库事实甲')
    expect(row.category).toBe('project')
    expect(row.ttl_days).toBe(30)
    expect(row.valid_from).toBe('2026-09-01')
    expect(row.valid_to).toBe('2026-12-31')
    expect(row.assert_count).toBe(1) // a fresh assertion, not the source's counter
    expect(sourcesOf(memoryDbOf(B), Number(row.fact_id))).toEqual([{ kind: 'manual', ref: 'import:facts.json' }])
  }, 60_000)

  it('is idempotent: a second import skips everything and leaves assert_count alone', () => {
    const A = makeHome('a2')
    const B = makeHome('b2')
    add(A, '共同事实')
    add(A, '源库独有事实')
    const common = add(B, '共同事实')
    const out = join(A, 'facts.json')
    run(['export', '--out', out], A)

    const firstRun = run(['import', out], B)
    expect(firstRun).toMatchObject({ total: 2, imported: 1, skipped_existing: 1, skipped_archived: 0, failed: [] })
    const assertBefore = Number(factRow(memoryDbOf(B), '共同事实').assert_count)
    expect(assertBefore).toBe(1) // a duplicate `add` would have made this 2
    const countBefore = countFacts(memoryDbOf(B))

    const secondRun = run(['import', out], B)
    expect(secondRun).toMatchObject({
      total: 2,
      imported: 0,
      skipped_existing: 2,
      skipped_archived: 0,
      failed: [],
      new_ids: [],
    })
    expect(Number(factRow(memoryDbOf(B), '共同事实').assert_count)).toBe(assertBefore)
    expect(countFacts(memoryDbOf(B))).toBe(countBefore)
    expect(common.fact_id).toBe(1)
  }, 60_000)

  it('--dry-run reports the plan and writes nothing', () => {
    const A = makeHome('a3')
    const B = makeHome('b3')
    add(A, '待导入甲')
    add(A, '待导入乙')
    add(B, '目标基线事实')
    const out = join(A, 'facts.json')
    run(['export', '--out', out], A)
    const before = countFacts(memoryDbOf(B))
    const contentsBefore = activeContents(B)

    const report = run(['import', out, '--dry-run'], B)

    expect(report).toMatchObject({
      total: 2,
      imported: 0,
      would_import: 2,
      skipped_existing: 0,
      skipped_archived: 0,
      failed: [],
      new_ids: [],
    })
    // The plan still explains what a real run would lose.
    expect(report.metadata_dropped.timestamps).toBe(2)
    expect(countFacts(memoryDbOf(B))).toBe(before)
    expect(activeContents(B)).toEqual(contentsBefore)
  }, 60_000)

  it('imports only ACTIVE rows and counts the archived ones skipped', () => {
    const A = makeHome('a4')
    const B = makeHome('b4')
    const C = makeHome('c4')
    add(A, '活跃事实')
    const old = add(A, '归档事实')
    run(['archive', String(old.fact_id)], A)

    const archivedDoc = join(A, 'archived.json')
    const exported = run(['export', '--status', 'archived', '--out', archivedDoc], A)
    // counts describe the SOURCE database, not the --status selection.
    expect(exported.counts).toEqual({ active: 1, archived: 1 })
    const doc = JSON.parse(readFileSync(archivedDoc, 'utf8')) as { facts: { status: string }[] }
    expect(doc.facts).toHaveLength(1)
    expect(doc.facts[0]!.status).toBe('archived')

    const archivedOnly = run(['import', archivedDoc], B)
    expect(archivedOnly).toMatchObject({
      total: 1,
      imported: 0,
      skipped_archived: 1,
      skipped_existing: 0,
      failed: [],
      new_ids: [],
    })
    expect(countFacts(memoryDbOf(B))).toBe(0) // archived status was NOT restored

    const allDoc = join(A, 'all.json')
    run(['export', '--status', 'all', '--out', allDoc], A)
    const all = run(['import', allDoc], C)
    expect(all).toMatchObject({ total: 2, imported: 1, skipped_archived: 1 })
    expect(activeContents(C)).toEqual(['活跃事实'])
  }, 60_000)

  it('refuses a wrong format / version / facts shape before writing anything', () => {
    const B = makeHome('b5')
    add(B, '基线事实')
    const before = countFacts(memoryDbOf(B))
    const cases: { name: string; content: unknown; message: string }[] = [
      { name: 'bad-format.json', content: { format: 'something-else', version: 1, facts: [] }, message: 'format' },
      { name: 'bad-version.json', content: { format: 'avantf-mem-facts', version: 3, facts: [] }, message: '版本' },
      { name: 'bad-facts.json', content: { format: 'avantf-mem-facts', version: 1, facts: {} }, message: 'facts' },
      { name: 'bad-json.json', content: 'not json at all', message: 'JSON' },
    ]
    for (const item of cases) {
      const file = writeDoc(B, item.name, item.content)
      const failure = runFail(['import', file], B)
      expect(failure.status, item.name).not.toBe(0)
      expect(failure.stderr, item.name).toContain(item.message)
      expect(countFacts(memoryDbOf(B)), item.name).toBe(before)
    }
    expect(activeContents(B)).toEqual(['基线事实'])
  }, 60_000)

  it('collects a refused row into failed and imports the rows around it', () => {
    const A = makeHome('a6')
    const B = makeHome('b6')
    run(['stats'], A) // create the database without adding a fact
    const secret = 'ghp_AbCdEfGhIjKlMnOpQrStUvWx'
    // A high-confidence credential shape is refused by the store's write-side guard (P-03). It can
    // only be planted by raw SQL because add itself refuses it — which makes it a stable per-row
    // failure that sits FIRST in the document.
    const db = openDatabase(memoryDbOf(A))
    try {
      db.prepare('INSERT INTO facts (content, settle_clock) VALUES (?, 0)').run(secret)
    } finally {
      db.close()
    }
    add(A, '失败后的事实甲')
    add(A, '失败后的事实乙')
    const out = join(A, 'facts.json')
    run(['export', '--out', out], A)

    const report = run(['import', out], B)

    expect(report.total).toBe(3)
    expect(report.imported).toBe(2)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].source_id).toBe(1)
    expect(report.failed[0].error).toContain('已拒绝写入明文')
    // The rows AFTER the failure both landed.
    expect(report.new_ids.map((entry: { source_id: number }) => entry.source_id)).toEqual([2, 3])
    expect(activeContents(B).sort()).toEqual(['失败后的事实乙', '失败后的事实甲'].sort())
  }, 60_000)

  it('exports the document to stdout and imports it from stdin', () => {
    const A = makeHome('a7')
    const B = makeHome('b7')
    add(A, '管道事实')

    const document = runRaw(['export'], A)
    // stdout stays UNCOMPRESSED and minified (one line of JSON, no indentation), so it can be piped
    // straight into `jq` or `import -`.
    expect(document.trimEnd()).toBe(JSON.stringify(JSON.parse(document)))
    expect(document.trimEnd()).not.toContain('\n')
    const parsed = JSON.parse(document) as { format: string; facts: unknown[] }
    expect(parsed.format).toBe('avantf-mem-facts')
    expect(parsed.facts).toHaveLength(1)

    const result = spawnSync('node', [CLI, 'import', '-'], {
      env: { ...process.env, AVANTF_HOME: B },
      input: document,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout ?? '{}') as { file: string; imported: number; total: number; new_ids: { new_fact_id: number }[] }
    expect(report).toMatchObject({ file: '-', imported: 1, total: 1 })
    expect(activeContents(B)).toEqual(['管道事实'])
    expect(sourcesOf(memoryDbOf(B), report.new_ids[0]!.new_fact_id)).toEqual([{ kind: 'manual', ref: 'import:stdin' }])
  }, 60_000)

  it('reports every value v1 cannot restore instead of pretending', () => {
    const A = makeHome('a8')
    const B = makeHome('b8')
    add(A, '普通事实')
    add(A, '被重申的事实')
    add(A, '被重申的事实') // assert_count becomes 2
    const pinned = add(A, '被钉住的事实')
    run(['pin', String(pinned.fact_id)], A)
    const helpful = add(A, '被反馈的事实')
    run(['helpful', String(helpful.fact_id)], A)
    const old = add(A, '旧版事实')
    run(['edit', String(old.fact_id), '新版事实'], A) // archives 旧版, active 新版 carries supersedes_id
    const out = join(A, 'facts.json')
    run(['export', '--out', out], A)

    const report = run(['import', out], B)

    expect(report).toMatchObject({ total: 6, imported: 5, skipped_archived: 1 })
    expect(report.metadata_dropped).toEqual({
      timestamps: 5,
      trust: 5,
      assert_count: 1,
      helpful_count: 1,
      pinned: 1,
      supersedes: 1,
    })
    // The imported rows are FRESH assertions: the source's counter/trust/pin did not travel.
    const reiterated = factRow(memoryDbOf(B), '被重申的事实')
    expect(reiterated.assert_count).toBe(1)
    expect(reiterated.pinned).toBe(0)
    expect(factRow(memoryDbOf(B), '被钉住的事实').pinned).toBe(0)
  }, 90_000)

  it('prefers a document fact source over --source-ref, falling back to import:<file>', () => {
    const A = makeHome('a9')
    const B = makeHome('b9')
    const C = makeHome('c9')
    add(A, '带来源的事实')
    const first = join(A, 'first.json')
    run(['export', '--out', first], A)

    run(['import', first, '--source-ref', 'tool:laptop'], B)
    const bRow = factRow(memoryDbOf(B), '带来源的事实')
    expect(sourcesOf(memoryDbOf(B), Number(bRow.fact_id))).toEqual([{ kind: 'tool', ref: 'laptop' }])

    // Re-exporting B carries that provenance, and the embedded ref wins over a different flag.
    const second = join(B, 'second.json')
    run(['export', '--out', second], B)
    run(['import', second, '--source-ref', 'tool:desktop'], C)
    const cRow = factRow(memoryDbOf(C), '带来源的事实')
    // The embedded ref wins over the flag. v1 carries ONE source_ref string, so the original `kind`
    // is not part of it: `laptop` re-classifies as manual rather than tool. What this proves is
    // precedence (the flag was `tool:desktop` and did not land), not kind preservation.
    expect(sourcesOf(memoryDbOf(C), Number(cRow.fact_id))).toEqual([{ kind: 'manual', ref: 'laptop' }])
  }, 60_000)

  it('writes brotli by extension, gzip by flag or extension, plain minified on --plain', () => {
    const A = makeHome('a10')
    for (let i = 0; i < 6; i += 1) {
      add(A, '压缩导出用例事实第' + String(i) + '条：这是一段足够长、结构重复的内容，用来看压缩报告是否合理。')
    }
    const counts = { active: 6, archived: 0 }

    const brPath = join(A, 'facts.json.br')
    const brotli = run(['export', '--out', brPath], A)
    expect(brotli).toMatchObject({ out: brPath, codec: 'brotli', counts })
    expect(brotli.bytes).toBeLessThan(brotli.plain_bytes)
    expect(brotli.ratio).toBeLessThan(1)
    expect(readFileSync(brPath).subarray(0, 1).toString('utf8')).not.toBe('{')

    // Renaming the compressed file to '.json' changes nothing: import sniffs the CONTENT.
    const renamed = join(A, 'renamed.json')
    copyFileSync(brPath, renamed)
    const B = makeHome('b10')
    expect(run(['import', renamed], B)).toMatchObject({ total: 6, imported: 6, failed: [] })

    // Extension rule for gzip, and a flag that overrides a plain-looking name.
    const gzPath = join(A, 'facts.json.gz')
    const gzip = run(['export', '--out', gzPath], A)
    expect(gzip).toMatchObject({ codec: 'gzip', counts })
    expect(gzip.bytes).toBeLessThan(gzip.plain_bytes)
    expect(readFileSync(gzPath).subarray(0, 2).toString('hex')).toBe('1f8b')
    const forced = run(['export', '--out', join(A, 'forced.json'), '--gzip'], A)
    expect(forced.codec).toBe('gzip')
    const C = makeHome('c10')
    expect(run(['import', join(A, 'forced.json')], C)).toMatchObject({ total: 6, imported: 6 })

    // --plain overrides a .br name and writes the canonical minified JSON.
    const plainPath = join(A, 'plain.json.br')
    const plain = run(['export', '--out', plainPath, '--plain'], A)
    expect(plain).toMatchObject({ codec: 'none', counts })
    expect(plain.bytes).toBe(plain.plain_bytes)
    const text = readFileSync(plainPath, 'utf8')
    expect(text.trimEnd()).toBe(JSON.stringify(JSON.parse(text)))
    expect(text.trimEnd()).not.toContain('\n')

    // Two codec flags contradict each other.
    const conflict = runFail(['export', '--out', join(A, 'x.json'), '--gzip', '--plain'], A)
    expect(conflict.status).not.toBe(0)
    expect(conflict.stderr).toContain('只能给一个')
    // A codec without --out would silently change what stdout means, so it is refused.
    const noOut = runFail(['export', '--brotli'], A)
    expect(noOut.status).not.toBe(0)
    expect(noOut.stderr).toContain('--out')
  }, 90_000)
})
