/**
 * The plugin log sink — ONE implementation for every plugin in the family.
 *
 * It merges the two loggers the plugins used to carry separately:
 *
 *  - the memory side's `createConsoleLogger(prefix)` (`@avantf/mem-contract`): a stable
 *    `[avantf-mem] LEVEL message` line on STDERR, because the CLI and the MCP server own stdout for
 *    JSON / JSON-RPC;
 *  - the mission side's `createLogger(host, sink)`: the same stderr line, PLUS a mirror into the host's
 *    `ctx.logger` (`ctx.logger` alone never reaches the terminal).
 *
 * Both planes are kept, and each is independently injectable so a spec can assert the lines. Nothing
 * here throws: a logging failure must never take down the engine it is describing, so the host
 * mirror is wrapped and the sink is the caller's responsibility.
 *
 * @module @avantf/dsh-plugin-base/kit/logger
 */

/** One leveled log sink. */
export interface PluginLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** The `ctx.logger` slice a plugin mirrors into; every method is optional. */
export type PluginLoggerHost = Partial<PluginLogger>

export interface PluginLoggerOptions {
  /** The stable token every line starts with, e.g. `[avantf-mem]`. */
  readonly prefix: string
  /** The host logger to mirror into, when there is one. */
  readonly host?: PluginLoggerHost
  /** Where the stderr line lands; defaults to `console.error` (stdout stays free). */
  readonly sink?: (line: string) => void
}

/**
 * Build a plugin logger.
 *
 * @param options - the prefix, an optional host mirror, an optional sink override.
 * @returns the leveled logger.
 */
export function createPluginLogger(options: PluginLoggerOptions): PluginLogger {
  const { prefix, host } = options
  const sink = options.sink ?? ((line: string): void => { console.error(line) })
  const emit = (level: 'info' | 'warn' | 'error', message: string): void => {
    sink(`${prefix} ${level.toUpperCase()} ${message}`)
    try {
      host?.[level]?.(`${prefix} ${message}`)
    } catch {
      // A logging failure must never take down the engine it is describing.
    }
  }
  return {
    info: (message) => { emit('info', message) },
    warn: (message) => { emit('warn', message) },
    error: (message) => { emit('error', message) },
  }
}
