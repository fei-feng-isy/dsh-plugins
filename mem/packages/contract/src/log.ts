/**
 * Minimal leveled logger shared by the engine, the retrieval core, and the DSH
 * plugin. The plugin injects the host `ctx.logger` facade so every line lands in
 * the DSH host output; standalone runs (CLI / MCP / tests) fall back to console.
 *
 * The console fallback writes to STDERR on purpose: the CLI and the MCP server
 * own stdout for JSON / JSON-RPC, so logs must never share that stream.
 */

/** One leveled log sink. */
export interface AvantfLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** The `console` slice this module writes through (typed locally: the contract has no DOM lib). */
interface ConsoleSink {
  error(message: string): void
}

function consoleSink(): ConsoleSink | undefined {
  return (globalThis as { console?: ConsoleSink }).console
}

/** Build a stderr-backed logger with a stable `[avantf-mem]` prefix. */
export function createConsoleLogger(prefix = '[avantf-mem]'): AvantfLogger {
  const emit = (level: 'INFO' | 'WARN' | 'ERROR', message: string): void => {
    const sink = consoleSink()
    if (sink === undefined) return
    sink.error(`${prefix} ${level} ${message}`)
  }
  return {
    info: message => emit('INFO', message),
    warn: message => emit('WARN', message),
    error: message => emit('ERROR', message),
  }
}

/** The default console logger used whenever no host logger is supplied. */
export const defaultLogger: AvantfLogger = createConsoleLogger()

/** How deep the `cause` chain is followed before giving up. */
const MAX_CAUSE_DEPTH = 5

/**
 * Flatten an error and its `cause` chain into one log-safe line.
 *
 * Node's `fetch` (undici) reports any failed request as a bare
 * `TypeError: fetch failed` and puts the actionable detail — DNS failure,
 * connect timeout, TLS error — plus the `UND_ERR_*` code on `error.cause`.
 * Logging `message` alone therefore hides *why* a model download failed: a
 * poisoned DNS entry and a dead mirror both read as "fetch failed". Every
 * adapter / bootstrap log goes through this helper so the cause survives.
 */
export function describeError(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    const text = current instanceof Error ? current.message : String(current)
    if (text.length > 0 && !parts.includes(text)) parts.push(text)
    current = causeOf(current)
  }
  const code = errorCode(error)
  const head = parts.length > 0 ? parts.join(' <- ') : String(error)
  const tail = code === undefined ? head : `${head} [${code}]`
  // Node's own errno text is English and lands in the UI verbatim; a Chinese gloss in FRONT keeps
  // the first thing a user reads in Chinese while the technical detail stays for diagnosis.
  const gloss = code === undefined ? undefined : CODE_GLOSS[code]
  return gloss === undefined ? tail : `${gloss}（${code}）—— ${tail}`
}

/** The errno / transport codes our paths actually produce, with what they mean in Chinese. */
const CODE_GLOSS: Record<string, string> = {
  EACCES: '权限不足',
  EPERM: '权限不足',
  ENOENT: '文件或目录不存在',
  EISDIR: '期望文件但拿到目录',
  ENOTDIR: '期望目录但拿到文件',
  EEXIST: '已经存在',
  ENOSPC: '磁盘空间不足',
  EROFS: '只读文件系统',
  EBUSY: '资源被占用',
  EMFILE: '打开的文件过多',
  ENFILE: '系统打开的文件过多',
  ELOOP: '符号链接层级过多',
  ENAMETOOLONG: '路径过长',
  ENOTEMPTY: '目录非空',
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '连接被重置',
  ETIMEDOUT: '连接超时',
  ENOTFOUND: '域名解析失败',
  EAI_AGAIN: '域名解析暂时失败',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_SOCKET: '连接中断',
}

/** The `cause` of an error, or undefined for a non-error / a leaf. */
function causeOf(error: unknown): unknown {
  return error instanceof Error ? (error as { cause?: unknown }).cause : undefined
}

/** The first `code` in the chain (`UND_ERR_CONNECT_TIMEOUT`, `ENOTFOUND`, …). */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
    current = causeOf(current)
  }
  return undefined
}
