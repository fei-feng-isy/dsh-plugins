/**
 * The `/mem` command's behaviour, against a REAL core runtime.
 *
 * WHY A REAL STORE. The command is a thin shell around `facts_io`; a fake store would test this
 * file's own arithmetic while the thing that matters — content identity, skipping archived rows,
 * `assert_count` staying put, "zero writes" meaning zero rows — lives in the engine. So every case
 * below builds `buildRuntime` over a temp data home and lets the real `add` path run.
 *
 * The command service is a FAKE (a collector of registrations), because the host service is in
 * `@deepseek-ai/dsh-commands`, which this package's CI tree does not have. `src/command.ts` declares
 * that slice structurally for the same reason.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, decodeFactsExport, type AvantfRuntime } from '@avantf/mem'
import { registerMemCommand, runMemCommand } from '../src/command.js'

/** No model, no download (the plugin vitest env also sets the kill switch). */
const semantic = {
  name: 'cmd_never_warm',
  dim: 768,
  isAvailable: (): boolean => false,
  async encode(): Promise<Float32Array> { throw new Error('no model') },
  async encodeBatch(): Promise<Float32Array[]> { throw new Error('no model') },
}

const homes: string[] = []
const runtimes: AvantfRuntime[] = []

function makeHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), 'avf-cmd-' + label + '-'))
  homes.push(home)
  return home
}

function openRuntime(home: string): AvantfRuntime {
  // The default path (<home>/memory/memory.db), which is what a real host uses: `/mem` reaches the
  // database through `rt.config.memory.db.path`, the same value the config resolved.
  const rt = buildRuntime({
    dataHome: home,
    semantic,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
  runtimes.push(rt)
  return rt
}

afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.shutdown()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function activeContents(rt: AvantfRuntime): string[] {
  return rt.memory.list(undefined, 'active', 100, 0).facts.map((fact) => fact.content)
}

describe('/mem status', () => {
  it('answers with counts, data root, the three subcommands and the process-boundary rule', async () => {
    const home = makeHome('status')
    const rt = openRuntime(home)
    await rt.remember({ action: 'add', content: '状态条目的活跃事实' })
    const archived = await rt.remember({ action: 'add', content: '状态条目的归档事实' })
    rt.admin({ action: 'archive', fact_id: archived.fact_id, reason: 'test' })

    const result = await runMemCommand(rt, '')

    expect(result.kind).toBe('success')
    expect(result.text).toContain('活跃事实：1 条')
    expect(result.text).toContain('归档事实：1 条')
    expect(result.text).toContain('数据根：' + home)
    expect(result.text).toContain('/mem export [path]')
    expect(result.text).toContain('/mem import <file>')
    expect(result.text).toContain('/mem merge <db-path>')
    // The default path is stated as the concrete file this invocation would use, and its pattern is
    // the sortable local-time form INSTALL documents.
    expect(result.text).toContain(join(home, 'backups'))
    // The default file is brotli: the smallest container, and the one INSTALL documents.
    expect(result.text).toMatch(/memory-\d{8}-\d{6}\.json\.br/)
    // The codec flags are advertised in the usage text.
    expect(result.text).toContain('--brotli')
    expect(result.text).toContain('--gzip')
    expect(result.text).toContain('--plain')
    // Both halves of the process-boundary warning are present: in-host writes are immediately usable,
    // CLI writes need a restart.
    expect(result.text).toContain('立即可检索')
    expect(result.text).toContain('需要重启 dsh')
    expect(result.text).toContain('CLI')
  })
})

describe('/mem export and import', () => {
  it('exports to an explicit nested path and round-trips into another data home', async () => {
    const homeA = makeHome('a')
    const rtA = openRuntime(homeA)
    await rtA.remember({ action: 'add', content: '源事实甲' })
    await rtA.remember({ action: 'add', content: '源事实乙' })
    const archived = await rtA.remember({ action: 'add', content: '源事实丙' })
    rtA.admin({ action: 'archive', fact_id: archived.fact_id, reason: 'test' })

    // A directory that does not exist yet: export must create it recursively.
    const out = join(homeA, 'nested', 'deep', 'facts.json')
    const exported = await runMemCommand(rtA, 'export "' + out + '"')

    expect(exported.kind).toBe('success')
    expect(exported.text).toContain('文件：' + out)
    expect(exported.text).toContain('2 条活跃 / 1 条归档')
    const doc = JSON.parse(readFileSync(out, 'utf8')) as {
      format: string
      version: number
      facts: unknown[]
      source: { counts: { active: number; archived: number } }
    }
    expect(doc.format).toBe('avantf-mem-facts')
    expect(doc.version).toBe(1)
    expect(doc.source.counts).toEqual({ active: 2, archived: 1 })
    expect(doc.facts).toHaveLength(3)

    // Without a path: <data home>/backups/memory-YYYYMMDD-HHMMSS.json.br (brotli), recursively created.
    const defaultExport = await runMemCommand(rtA, 'export')
    expect(defaultExport.kind).toBe('success')
    const backupFiles = readdirSync(join(homeA, 'backups'))
    expect(backupFiles).toHaveLength(1)
    expect(backupFiles[0]).toMatch(/^memory-\d{8}-\d{6}\.json\.br$/)
    expect(defaultExport.text).toContain(join(homeA, 'backups', backupFiles[0]))
    const defaultDoc = decodeFactsExport(readFileSync(join(homeA, 'backups', backupFiles[0])))
    expect(defaultDoc.codec).toBe('brotli')
    expect(defaultDoc.doc.facts).toHaveLength(3)

    const homeB = makeHome('b')
    const rtB = openRuntime(homeB)
    const own = await rtB.remember({ action: 'add', content: '目标库自己的事实' })

    const imported = await runMemCommand(rtB, 'import "' + out + '"')

    expect(imported.kind).toBe('success')
    expect(imported.text).toContain('imported: 2')
    expect(imported.text).toContain('skipped_existing: 0')
    expect(imported.text).toContain('skipped_archived: 1')
    expect(imported.text).toContain('metadata_dropped:')
    // In-host writes are immediately visible to the same runtime — the whole reason to prefer /mem.
    expect(imported.text).toContain('立即可检索（同一 runtime，无需重启）')
    const contents = activeContents(rtB)
    expect(contents).toHaveLength(3)
    expect(contents.sort()).toEqual(['目标库自己的事实', '源事实乙', '源事实甲'].sort())
    expect(rtB.memory.get(own.fact_id)?.content).toBe('目标库自己的事实')
  })

  it('defaults to brotli and honours --gzip / --plain plus the extension rule', async () => {
    const homeA = makeHome('codec')
    const rtA = openRuntime(homeA)
    await rtA.remember({ action: 'add', content: '压缩用例事实甲' })
    await rtA.remember({ action: 'add', content: '压缩用例事实乙' })

    const plain = await runMemCommand(rtA, 'export --plain')
    expect(plain.kind).toBe('success')
    expect(plain.text).toContain('codec: none')
    expect(plain.text).toContain('bytes:')
    expect(plain.text).toContain('plain_bytes:')
    expect(plain.text).toContain('压缩比:')
    const plainFiles = readdirSync(join(homeA, 'backups')).filter((name) => name.endsWith('.json'))
    expect(plainFiles).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(homeA, 'backups', plainFiles[0]!), 'utf8')).facts).toHaveLength(2)

    const gzip = await runMemCommand(rtA, 'export --gzip')
    expect(gzip.kind).toBe('success')
    expect(gzip.text).toContain('codec: gzip')
    const gzipFiles = readdirSync(join(homeA, 'backups')).filter((name) => name.endsWith('.json.gz'))
    expect(gzipFiles).toHaveLength(1)
    const gzipDoc = decodeFactsExport(readFileSync(join(homeA, 'backups', gzipFiles[0]!)))
    expect(gzipDoc.codec).toBe('gzip')
    expect(gzipDoc.doc.facts).toHaveLength(2)

    // Explicit path: the extension decides, with no flag needed.
    const explicit = join(homeA, 'nested', 'facts.json.gz')
    const explicitResult = await runMemCommand(rtA, 'export "' + explicit + '"')
    expect(explicitResult.kind).toBe('success')
    expect(explicitResult.text).toContain('codec: gzip')
    expect(decodeFactsExport(readFileSync(explicit)).codec).toBe('gzip')

    // The no-path default is brotli, and that compressed file imports into another data home.
    const defaultResult = await runMemCommand(rtA, 'export')
    expect(defaultResult.kind).toBe('success')
    expect(defaultResult.text).toContain('codec: brotli')
    const brotliFiles = readdirSync(join(homeA, 'backups')).filter((name) => name.endsWith('.json.br'))
    expect(brotliFiles).toHaveLength(1)
    const homeB = makeHome('codec-b')
    const rtB = openRuntime(homeB)
    const imported = await runMemCommand(rtB, 'import "' + join(homeA, 'backups', brotliFiles[0]!) + '"')
    expect(imported.kind).toBe('success')
    expect(imported.text).toContain('imported: 2')
  })

  it('is idempotent: a second import skips everything and leaves assert_count alone', async () => {
    const homeA = makeHome('a2')
    const rtA = openRuntime(homeA)
    await rtA.remember({ action: 'add', content: '共同事实' })
    await rtA.remember({ action: 'add', content: '源库独有事实' })
    const out = join(homeA, 'facts.json')
    expect((await runMemCommand(rtA, 'export ' + out)).kind).toBe('success')

    const homeB = makeHome('b2')
    const rtB = openRuntime(homeB)
    const common = await rtB.remember({ action: 'add', content: '共同事实' })

    const first = await runMemCommand(rtB, 'import ' + out)
    expect(first.kind).toBe('success')
    expect(first.text).toContain('imported: 1')
    expect(first.text).toContain('skipped_existing: 1')

    const before = rtB.memory.countByStatus()
    const assertBefore = rtB.memory.get(common.fact_id)?.assert_count
    const second = await runMemCommand(rtB, 'import ' + out)

    expect(second.kind).toBe('success')
    expect(second.text).toContain('imported: 0')
    expect(second.text).toContain('skipped_existing: 2')
    expect(rtB.memory.countByStatus()).toEqual(before)
    // A duplicate add would have bumped this to 2; the prefilter is what prevents it.
    expect(rtB.memory.get(common.fact_id)?.assert_count).toBe(assertBefore)
  })
})

describe('/mem dry run and failures', () => {
  it('writes nothing with --dry-run', async () => {
    const homeA = makeHome('a3')
    const rtA = openRuntime(homeA)
    await rtA.remember({ action: 'add', content: '仅预演的事实' })
    const out = join(homeA, 'facts.json')
    expect((await runMemCommand(rtA, 'export ' + out)).kind).toBe('success')

    const homeB = makeHome('b3')
    const rtB = openRuntime(homeB)
    await rtB.remember({ action: 'add', content: '目标已有的事实' })
    const before = rtB.memory.countByStatus()

    const planned = await runMemCommand(rtB, 'import ' + out + ' --dry-run')

    expect(planned.kind).toBe('success')
    expect(planned.text).toContain('would_import: 1')
    expect(planned.text).toContain('零写入')
    expect(rtB.memory.countByStatus()).toEqual(before)

    // The plan was real: the same command without the flag writes the row.
    const real = await runMemCommand(rtB, 'import ' + out)
    expect(real.kind).toBe('success')
    expect(rtB.memory.countByStatus().active).toBe(before.active + 1)
  })

  it('returns an actionable error and writes nothing for a bad path, flag or format version', async () => {
    const home = makeHome('bad')
    const rt = openRuntime(home)
    await rt.remember({ action: 'add', content: '坏输入不应改变这一条' })
    const before = rt.memory.countByStatus()

    const missing = await runMemCommand(rt, 'import ' + join(home, 'missing.json'))
    expect(missing.kind).toBe('error')
    expect(missing.text).toContain('导入文件不存在')

    const badVersionFile = join(home, 'bad-version.json')
    writeFileSync(badVersionFile, JSON.stringify({ format: 'avantf-mem-facts', version: 99, facts: [] }))
    const badVersion = await runMemCommand(rt, 'import ' + badVersionFile)
    expect(badVersion.kind).toBe('error')
    expect(badVersion.text).toContain('不支持的导出格式版本')
    expect(badVersion.text).toContain('99')
    expect(badVersion.text).toContain('不会写入任何事实')

    const garbageFile = join(home, 'garbage.json')
    writeFileSync(garbageFile, 'not json at all')
    const garbage = await runMemCommand(rt, 'import ' + garbageFile)
    expect(garbage.kind).toBe('error')
    expect(garbage.text).toContain('不是有效的 JSON')

    const badFlag = await runMemCommand(rt, 'import ' + badVersionFile + ' --bogus')
    expect(badFlag.kind).toBe('error')
    expect(badFlag.text).toContain('未知参数 --bogus')

    expect(rt.memory.countByStatus()).toEqual(before)
  })

  it('merges another host database, and --dry-run leaves the target untouched', async () => {
    const sourceHome = makeHome('src')
    const rtSource = openRuntime(sourceHome)
    await rtSource.remember({ action: 'add', content: '源库事实一' })
    await rtSource.remember({ action: 'add', content: '源库事实二' })

    const targetHome = makeHome('dst')
    const rtTarget = openRuntime(targetHome)
    await rtTarget.remember({ action: 'add', content: '目标库已有事实' })
    const before = rtTarget.memory.countByStatus()
    const sourceDb = join(sourceHome, 'memory', 'memory.db')

    const planned = await runMemCommand(rtTarget, 'merge ' + sourceDb + ' --dry-run')
    expect(planned.kind).toBe('success')
    expect(planned.text).toContain('would_add: 2')
    expect(rtTarget.memory.countByStatus()).toEqual(before)

    const merged = await runMemCommand(rtTarget, 'merge ' + sourceDb)
    expect(merged.kind).toBe('success')
    expect(merged.text).toContain('added: 2')
    expect(merged.text).toContain('立即可检索（同一 runtime，无需重启）')
    expect(activeContents(rtTarget)).toHaveLength(3)
  })
})

describe('registerMemCommand', () => {
  it('only warns when commands is missing, and registers exactly one mem command when present', async () => {
    const home = makeHome('reg')
    const rt = openRuntime(home)
    const warnings: string[] = []
    const log = { info: () => {}, warn: (message: string) => { warnings.push(message) }, error: () => {} }

    expect(() => registerMemCommand({ get: () => undefined }, rt, log)).not.toThrow()
    expect(warnings.join('\n')).toContain('commands service is not mounted')
    expect(warnings.join('\n')).toContain('/mem is unavailable')

    const registered: {
      name: string
      handler: (invocation: { rawInput: string }) => Promise<{ kind: string; text: string }>
    }[] = []
    const ctx = {
      get: (name: string) => name === 'commands'
        ? { register: (definition: (typeof registered)[number]) => { registered.push(definition); return () => {} } }
        : undefined,
    }
    registerMemCommand(ctx, rt, log)

    expect(registered).toHaveLength(1)
    expect(registered[0].name).toBe('mem')
    const result = await registered[0].handler({ rawInput: '' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('活跃事实：0 条')

    // The degraded mount registers the same command, but it reports the runtime failure verbatim.
    const degraded: (typeof registered)[number][] = []
    const degradedCtx = {
      get: () => ({ register: (definition: (typeof registered)[number]) => { degraded.push(definition); return () => {} } }),
    }
    registerMemCommand(degradedCtx, undefined, log, { degradedReason: '数据库被锁住了' })
    expect(degraded).toHaveLength(1)
    const degradedResult = await degraded[0].handler({ rawInput: '' })
    expect(degradedResult.kind).toBe('error')
    expect(degradedResult.text).toContain('数据库被锁住了')
  })
})
