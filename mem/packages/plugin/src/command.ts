/**
 * `/mem` — the in-host slash-command face of facts export / import / merge.
 *
 * WHY THIS FILE EXISTS. The engine already owns the hard part (content identity, the one add path,
 * detailed reports) in `@avantf/mem/facts_io`, and the CLI exposes it to a terminal. A DSH user
 * should not have to leave the conversation for a backup, a restore or a two-machine merge — but the
 * plugin may not import the CLI (another tree, and `pnpm guard` forbids it). So this module is a
 * thin adapter over the same core functions: parse `rawInput`, resolve filesystem paths, do the
 * file I/O, and render human-readable Chinese text. It contains NO import logic of its own.
 *
 * THE PROCESS BOUNDARY IS THE POINT. A slash command runs inside the host process, so its writes go
 * through the same `rt.remember` / vector index the current session reads — a fact imported now
 * is retrievable immediately, no restart. `avantf-mem import|merge` is a SEPARATE process: its
 * writes land in the database, but the running host's in-memory index was built earlier and will not
 * see them until `dsh` restarts. Both the help text and INSTALL state this difference; it is
 * the one thing users get wrong when they restore a backup from a shell.
 *
 * COMMANDS IS OPTIONAL. This module registers through `ctx.get('commands')` rather than
 * declaring the service in `inject`: a host without the command service must still mount the
 * tools, the `avantfMemory` service, the prompt sections and the Remote face. Adding
 * `commands` to `inject` would turn such a host's row INACTIVE — a whole-plugin refusal
 * for a missing nicety. Absence is a warning, never a throw.
 *
 * This module stays free of `@deepseek-ai/*` VALUE imports (the command service is declared
 * structurally) so `test/command.spec.ts` can run in a CI tree without the DSH peers linked.
 *
 * @module @avantf/dsh-mem/command
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  codecForExportPath,
  decodeFactsExport,
  encodeFactsExport,
  exportFacts,
  importFacts,
  mergeDb,
  type AvantfRuntime,
  type FactsExportCodec,
  type ImportReport,
  type MergeReport,
  type MetadataDropped,
} from '@avantf/mem'
import { expandHome, type AvantfLogger } from '@avantf/mem-contract'

/** What one `/mem` invocation answers; the command service renders `text` verbatim. */
export interface MemCommandResult {
  kind: 'success' | 'error'
  text: string
}

/** The slice of the host `commands` service this module calls. */
export interface MemCommandsService {
  register(definition: {
    name: string
    description: string
    input?: { hint?: string }
    handler: (invocation: { rawInput: string }) => MemCommandResult | Promise<MemCommandResult>
  }): unknown
}

/** The slice of a Cordis context registration needs — deliberately structural. */
export interface MemCommandContext {
  get(name: string): unknown
}

/** Registration options; the degraded path supplies the reason its runtime never opened. */
export interface RegisterMemCommandOptions {
  /**
   * When set, the command always answers with this reason instead of touching a runtime. The
   * degraded mount passes the SAME `describeError` message its tools report.
   */
  degradedReason?: string
}

/** The three subcommands, in the order the help lists them. */
const USAGE = {
  export: '/mem export [path] [--brotli|--gzip|--plain]',
  import: '/mem import <file> [--dry-run] [--source-ref <text>]',
  merge: '/mem merge <db-path> [--dry-run] [--source-ref <text>]',
} as const

const HELP_HINT = '无参显示状态与用法；子命令：export / import / merge。'

/** One short description shared by registration and the help text. */
export const MEM_COMMAND_DESCRIPTION =
  '记忆事实的导出 / 导入 / 合并：无参看状态与用法；export 生成快照（默认 brotli 压缩），import 按内容导入快照，'
  + 'merge 合并另一台主机的 memory.db。斜杠命令在宿主进程内执行，导入后立即可检索。'

/** The input placeholder advertised to capable clients. */
export const MEM_COMMAND_INPUT_HINT =
  '[export [path] [--brotli|--gzip|--plain] | import <file> [--dry-run] [--source-ref <text>] | merge <db-path> [--dry-run] [--source-ref <text>]]'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Local `YYYYMMDD-HHMMSS`, sortable by name and rendered in the user's time zone. */
function timestampName(now = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
    + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
}

/** The suffix each container writes — the same extension rule `codecForExportPath` reads. */
const EXPORT_SUFFIX: Readonly<Record<FactsExportCodec, string>> = {
  brotli: '.json.br',
  gzip: '.json.gz',
  none: '.json',
}

/**
 * `<data home>/backups/memory-YYYYMMDD-HHMMSS.json.br` — never inside `memory/`.
 *
 * Brotli is the default because it is the smallest (measured: 70.6 KiB vs 92.3 gzip vs 300.0 plain
 * for 233 facts). An explicit `--gzip` / `--plain` keeps the file name honest by changing the
 * suffix along with the bytes.
 */
export function defaultExportPath(home: string, now = new Date(), codec: FactsExportCodec = 'brotli'): string {
  return join(home, 'backups', 'memory-' + timestampName(now) + EXPORT_SUFFIX[codec])
}

/**
 * Resolve a user-typed path the way a shell would: `~` against the user home (the contract's
 * ONE `expandHome`, not a second copy), everything else against `process.cwd()`.
 */
function userPath(input: string): string {
  return resolve(expandHome(input))
}

/**
 * Write a file atomically: a sibling temp file, then one `rename` (same directory, so the
 * rename cannot cross a filesystem). An overwrite is therefore either the old bytes or the new
 * bytes, never a truncated export. The temp file is removed when anything fails.
 */
function writeFileAtomic(path: string, bytes: Buffer | string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '.' + basename(path) + '.tmp-' + String(process.pid) + '-' + randomBytes(4).toString('hex'))
  try {
    writeFileSync(tmp, bytes)
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temp file may not have been created; the original failure is the one worth reporting.
    }
    throw error
  }
}

interface ParsedInput {
  positionals: string[]
  dryRun: boolean
  sourceRef?: string
  /** `export`'s explicit container flag (`--plain` is `none`); absent = extension rule. */
  codec?: FactsExportCodec
}

/**
 * Split on whitespace while honouring single/double quotes, then pull out the supported flags.
 * Unknown flags and a missing flag value are ERRORS (not silently ignored): a typo must not turn a
 * planned dry run into a real import.
 */
function parseInput(rawInput: string): ParsedInput {
  const tokens = tokenize(rawInput)
  const positionals: string[] = []
  let dryRun = false
  let sourceRef: string | undefined
  const codecs: FactsExportCodec[] = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '--dry-run') {
      dryRun = true
      continue
    }
    if (token === '--brotli' || token === '--gzip' || token === '--plain') {
      codecs.push(token === '--brotli' ? 'brotli' : token === '--gzip' ? 'gzip' : 'none')
      continue
    }
    if (token === '--source-ref') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--source-ref 缺少取值（用法：--source-ref <text>）')
      }
      sourceRef = value
      i += 1
      continue
    }
    if (token.startsWith('--source-ref=')) {
      sourceRef = token.slice('--source-ref='.length)
      if (sourceRef === '') throw new Error('--source-ref 不能为空')
      continue
    }
    if (token.startsWith('--')) throw new Error('未知参数 ' + token)
    positionals.push(token)
  }

  if (sourceRef !== undefined && sourceRef.trim() === '') throw new Error('--source-ref 不能为空')
  if (codecs.length > 1) throw new Error('--brotli / --gzip / --plain 只能给一个')
  return {
    positionals,
    dryRun,
    ...(sourceRef === undefined ? {} : { sourceRef: sourceRef.trim() }),
    ...(codecs[0] === undefined ? {} : { codec: codecs[0] }),
  }
}

function tokenize(rawInput: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted: '"' | "'" | undefined
  let started = false
  for (const char of rawInput) {
    if (quoted !== undefined) {
      if (char === quoted) quoted = undefined
      else current += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quoted = char
      started = true
      continue
    }
    if (/\s/u.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quoted !== undefined) throw new Error('参数里的引号没有闭合')
  if (started) tokens.push(current)
  return tokens
}

function metadataDroppedLine(dropped: MetadataDropped): string {
  return '  metadata_dropped: '
    + 'timestamps=' + String(dropped.timestamps) + ', trust=' + String(dropped.trust)
    + ', assert_count=' + String(dropped.assert_count) + ', helpful_count=' + String(dropped.helpful_count)
    + ', pinned=' + String(dropped.pinned) + ', supersedes=' + String(dropped.supersedes)
}

/** Failures are rendered in full up to {@link FAILURES_SHOWN}; the rest is a count, never silence. */
const FAILURES_SHOWN = 5

function failureLines(
  failures: readonly { id: number | null; error: string }[],
  label: string,
): string[] {
  if (failures.length === 0) return ['  ' + label + ': 0']
  const lines = ['  ' + label + ': ' + String(failures.length) + ' 条']
  for (const failure of failures.slice(0, FAILURES_SHOWN)) {
    const who = failure.id === null ? 'source_id 未知' : 'source_id ' + String(failure.id)
    lines.push('    - ' + who + ': ' + failure.error)
  }
  if (failures.length > FAILURES_SHOWN) {
    lines.push('    …其余 ' + String(failures.length - FAILURES_SHOWN) + ' 条略')
  }
  return lines
}

function importReportText(file: string, report: ImportReport, dryRun: boolean): string {
  const lines = [
    dryRun ? '导入预演完成（--dry-run，零写入）：' + file : '导入完成：' + file,
    '  total: ' + String(report.total),
  ]
  if (dryRun) {
    lines.push('  would_import: ' + String(report.would_import ?? 0))
  } else {
    lines.push('  imported: ' + String(report.imported))
  }
  lines.push(
    '  skipped_existing: ' + String(report.skipped_existing),
    '  skipped_archived: ' + String(report.skipped_archived),
    metadataDroppedLine(report.metadata_dropped),
    ...failureLines(
      report.failed.map((failure) => ({ id: failure.source_id, error: failure.error })),
      'failed',
    ),
    dryRun
      ? '  这是预演：没有写入任何事实。去掉 --dry-run 才会真正导入。'
      : '  已写入的事实立即可检索（同一 runtime，无需重启）。',
  )
  return lines.join('\n')
}

function mergeReportText(report: MergeReport, dryRun: boolean): string {
  const lines = [
    dryRun ? '合并预演完成（--dry-run，零写入）：' + report.source : '合并完成：' + report.source,
    '  源库活跃事实：' + String(report.source_active) + ' 条',
    dryRun ? '  would_add: ' + String(report.would_add) : '  added: ' + String(report.added),
    '  skipped_existing: ' + String(report.skipped_existing),
    '  skipped_archived: ' + String(report.skipped_archived),
    ...failureLines(
      report.failed.map((failure) => ({ id: failure.source_fact_id, error: failure.error })),
      'failed',
    ),
    dryRun
      ? '  这是预演：没有写入任何事实。去掉 --dry-run 才会真正合并。'
      : '  已写入的事实立即可检索（同一 runtime，无需重启）。',
  ]
  return lines.join('\n')
}

/** The no-argument view: counts, data roots, the three commands, and the process-boundary rule. */
function statusText(rt: AvantfRuntime): string {
  const counts = rt.memory.countByStatus()
  const defaultPath = defaultExportPath(rt.config.home)
  return [
    '记忆插件状态',
    '  活跃事实：' + String(counts.active) + ' 条',
    '  归档事实：' + String(counts.archived) + ' 条',
    '  数据根：' + rt.config.home,
    '  记忆库：' + rt.config.memory.db.path,
    '',
    '用法：',
    '  ' + USAGE.export,
    '      导出全部事实（active + archived）为 avantf-mem-facts v2 快照；不带 path 时写到',
    '      ' + defaultPath,
    '      实际默认文件名为 memory-YYYYMMDD-HHMMSS.json.br（brotli，最小；本地时间，可按名称排序）。',
    '      显式路径按扩展名选编码（.br / .gz），或加 --brotli / --gzip / --plain。',
    '  ' + USAGE.import,
    '      按内容并集导入快照；明文 / gzip / brotli 按内容自动识别（不看扩展名）。',
    '      目标已有的内容（含归档行）跳过，可重复执行。',
    '  ' + USAGE.merge,
    '      合并另一台主机的 memory.db；源库只读，按内容求并集。',
    '',
    '说明：',
    '  - 斜杠命令在宿主进程内执行，导入 / 合并后立即可检索（同一 runtime，无需重启）。',
    '  - CLI（avantf-mem import / merge）是独立进程：写完后宿主的内存索引仍是旧的，需要重启 dsh。',
    '  - 路径里的 ~ 按用户主目录展开；相对路径按进程当前目录解析。',
    '  - ' + HELP_HINT,
  ].join('\n')
}

async function commandExport(rt: AvantfRuntime, parsed: ParsedInput): Promise<MemCommandResult> {
  if (parsed.dryRun) return { kind: 'error', text: 'export 不支持 --dry-run。用法：' + USAGE.export }
  if (parsed.sourceRef !== undefined) {
    return { kind: 'error', text: 'export 不支持 --source-ref。用法：' + USAGE.export }
  }
  if (parsed.positionals.length > 1) {
    return { kind: 'error', text: 'export 只接受一个输出路径。用法：' + USAGE.export }
  }
  const requested = parsed.positionals[0]
  // The DEFAULT file is brotli (smallest); an explicit --gzip/--plain keeps the suffix truthful.
  // An explicit path follows the shared rule: flag → extension → plain minified JSON.
  const path = requested === undefined
    ? defaultExportPath(rt.config.home, new Date(), parsed.codec ?? 'brotli')
    : userPath(requested)
  const codec = requested === undefined
    ? (parsed.codec ?? 'brotli')
    : codecForExportPath(path, parsed.codec)
  try {
    const doc = exportFacts(rt)
    const bytes = encodeFactsExport(doc, { codec })
    const plainBytes = encodeFactsExport(doc, { codec: 'none' }).length
    writeFileAtomic(path, bytes)
    const counts = doc.source.counts
    const ratio = plainBytes === 0 ? 100 : Number(((bytes.length / plainBytes) * 100).toFixed(1))
    return {
      kind: 'success',
      text: [
        '导出完成：' + String(counts.active) + ' 条活跃 / ' + String(counts.archived)
          + ' 条归档（共 ' + String(doc.facts.length) + ' 条）',
        '  codec: ' + codec,
        '  bytes: ' + String(bytes.length),
        '  plain_bytes: ' + String(plainBytes),
        '  压缩比: ' + String(ratio) + '%',
        '  文件：' + path,
        '  这是本机快照（与机器无关的 avantf-mem-facts v2 文档）；在另一台机器上用 /mem import 按内容并集导入。',
      ].join('\n'),
    }
  } catch (error) {
    return { kind: 'error', text: '导出失败（写入 ' + path + '）：' + messageOf(error) }
  }
}

async function commandImport(rt: AvantfRuntime, parsed: ParsedInput): Promise<MemCommandResult> {
  if (parsed.codec !== undefined) {
    // Import sniffs the container by content, so a codec flag has nothing to act on — refuse it
    // instead of pretending it did something.
    return { kind: 'error', text: 'import 不支持 --brotli / --gzip / --plain（导入按内容自动识别）。用法：' + USAGE.import }
  }
  if (parsed.positionals.length !== 1) {
    return { kind: 'error', text: 'import 需要一个快照文件路径。用法：' + USAGE.import }
  }
  const path = userPath(parsed.positionals[0])
  if (!existsSync(path)) {
    return {
      kind: 'error',
      text: '导入文件不存在：' + path + '\n（相对路径按进程当前目录解析；~ 会按用户主目录展开。）',
    }
  }
  try {
    if (!statSync(path).isFile()) throw new Error('不是普通文件（可能是目录）')
    // BYTES, not text: the file may be gzip or brotli. `decodeFactsExport` sniffs the content, so a
    // compressed backup renamed to `.json` (or a plain one renamed to `.json.br`) still imports.
    const doc = decodeFactsExport(readFileSync(path)).doc
    const sourceRef = parsed.sourceRef ?? 'import:' + basename(path)
    const report = await importFacts(rt, doc, { dryRun: parsed.dryRun, sourceRef })
    return { kind: 'success', text: importReportText(path, report, parsed.dryRun) }
  } catch (error) {
    return {
      kind: 'error',
      text: '导入失败（' + path + '）：' + messageOf(error) + '\n'
        + '文件必须是 /mem export 或 avantf-mem export 生成的 avantf-mem-facts v1/v2 文档：'
        + '明文 .json、gzip .json.gz 或 brotli .json.br（按内容识别，不看扩展名）；格式 / 版本不对时不会写入任何事实。',
    }
  }
}

async function commandMerge(rt: AvantfRuntime, parsed: ParsedInput): Promise<MemCommandResult> {
  if (parsed.codec !== undefined) {
    return { kind: 'error', text: 'merge 不支持 --brotli / --gzip / --plain。用法：' + USAGE.merge }
  }
  if (parsed.positionals.length !== 1) {
    return { kind: 'error', text: 'merge 需要一个源 memory.db 路径。用法：' + USAGE.merge }
  }
  const path = userPath(parsed.positionals[0])
  if (!existsSync(path)) {
    return {
      kind: 'error',
      text: '源库不存在：' + path + '\n（相对路径按进程当前目录解析；~ 会按用户主目录展开。）',
    }
  }
  try {
    const report = await mergeDb(rt, path, {
      dryRun: parsed.dryRun,
      ...(parsed.sourceRef === undefined ? {} : { sourceRef: parsed.sourceRef }),
    })
    return { kind: 'success', text: mergeReportText(report, parsed.dryRun) }
  } catch (error) {
    return {
      kind: 'error',
      text: '合并失败（源库 ' + path + '）：' + messageOf(error) + '\n'
        + '源库必须以只读方式可打开，且是包含 facts 表的 memory.db；它不是本机的导出 JSON（那个用 /mem import）。',
    }
  }
}

/**
 * Run one `/mem` invocation. Pure of host services: the caller only needs a built runtime,
 * which is what makes the whole command testable without mounting the plugin.
 *
 * @param rt - the live runtime (the same instance the tools use).
 * @param rawInput - the text after `/mem` (may be empty).
 * @returns a success or error result whose `text` is already human-readable Chinese.
 */
export async function runMemCommand(rt: AvantfRuntime, rawInput: string): Promise<MemCommandResult> {
  let parsed: ParsedInput
  try {
    parsed = parseInput(rawInput)
  } catch (error) {
    return {
      kind: 'error',
      text: messageOf(error) + '\n用法：' + USAGE.export + ' | ' + USAGE.import + ' | ' + USAGE.merge,
    }
  }

  const [sub, ...rest] = parsed.positionals
  if (sub === undefined || sub === 'help' || sub === '?') {
    // The word help may be followed by a subcommand name; that still prints the overview.
    try {
      return { kind: 'success', text: statusText(rt) }
    } catch (error) {
      return { kind: 'error', text: '读取记忆状态失败：' + messageOf(error) }
    }
  }
  const restParsed: ParsedInput = { ...parsed, positionals: rest }
  switch (sub) {
    case 'export':
      return await commandExport(rt, restParsed)
    case 'import':
      return await commandImport(rt, restParsed)
    case 'merge':
      return await commandMerge(rt, restParsed)
    default:
      return {
        kind: 'error',
        text: '未知子命令：' + sub + '\n用法：' + USAGE.export + ' | ' + USAGE.import + ' | ' + USAGE.merge,
      }
  }
}

/**
 * Register the one `mem` slash command, when the host has a command service.
 *
 * Missing `commands` is a WARNING, not a mount failure: this plugin's tools, service, prompt
 * and Remote face must survive a host that has no human-command registry. A registration that
 * throws is contained for the same reason.
 *
 * @param ctx - the plugin context; only `get` is called.
 * @param rt - the live runtime, or `undefined` on the degraded mount.
 * @param log - the plugin logger.
 * @param options - `degradedReason` makes the command report the runtime failure instead of running.
 */
export function registerMemCommand(
  ctx: MemCommandContext,
  rt: AvantfRuntime | undefined,
  log: AvantfLogger,
  options: RegisterMemCommandOptions = {},
): void {
  let commands: MemCommandsService | undefined
  try {
    const candidate = ctx.get('commands') as Partial<MemCommandsService> | undefined
    commands = candidate !== null && candidate !== undefined && typeof candidate.register === 'function'
      ? candidate as MemCommandsService
      : undefined
  } catch (error) {
    log.warn('could not read the commands service (' + messageOf(error) + '); /mem is unavailable, the tools keep working')
    return
  }
  if (commands === undefined) {
    log.warn('the commands service is not mounted; /mem is unavailable (tools, the memory service and the panels keep working)')
    return
  }

  const degradedReason = options.degradedReason
  try {
    commands.register({
      name: 'mem',
      description: MEM_COMMAND_DESCRIPTION,
      input: { hint: MEM_COMMAND_INPUT_HINT },
      handler: async ({ rawInput }: { rawInput: string }): Promise<MemCommandResult> => {
        if (degradedReason !== undefined) {
          return {
            kind: 'error',
            text: '记忆引擎未就绪：' + degradedReason + '\n修复上面的错误后重启 dsh；工具面同样只报告这个原因。',
          }
        }
        if (rt === undefined) {
          return { kind: 'error', text: '记忆引擎尚未构建完成；稍后重试，或查看启动日志里的 runtime 错误。' }
        }
        try {
          return await runMemCommand(rt, rawInput)
        } catch (error) {
          // Last-resort containment: a command handler that throws is settled as an error by the
          // host, but the reason would be generic. Keep the actionable text.
          return { kind: 'error', text: '/mem 执行失败：' + messageOf(error) }
        }
      },
    })
    log.info(degradedReason === undefined
      ? 'command registered: /mem (status, export, import, merge)'
      : 'command registered: /mem (DEGRADED — reports why the runtime is unavailable)')
  } catch (error) {
    log.warn('could not register /mem (' + messageOf(error) + '); the tools keep working')
  }
}
