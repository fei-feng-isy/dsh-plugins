/**
 * The plugin's log sink: `ctx.logger` never reaches the terminal, so lines also go to
 * stderr (`console.error`, leaving stdout free) and stay mirrored into the host logger.
 * @module @avantf/dsh-mission/log
 */

export const LOG_PREFIX = '[avantf-mission]'

export interface MissionLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Build the plugin's logger; `sink` is injectable so a test can assert the lines. */
export function createLogger(
  host: { info(message: string): void; warn(message: string): void; error(message: string): void } | undefined,
  sink: (line: string) => void = (line) => { console.error(line) },
): MissionLogger {
  const emit = (level: 'info' | 'warn' | 'error', message: string): void => {
    sink(`${LOG_PREFIX} ${level.toUpperCase()} ${message}`)
    try {
      host?.[level](`${LOG_PREFIX} ${message}`)
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
