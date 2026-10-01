/**
 * The log sink.
 *
 * Its whole purpose is that a mount is verifiable from outside the process, so the
 * assertions are about the two properties that makes true: the visible copy
 * happens, and a failing host logger cannot take down the engine that is reporting
 * through it.
 */
import { describe, expect, it } from 'vitest'
import { createLogger, LOG_PREFIX } from '../src/log.js'

/** Collect the visible copy instead of writing it to a stream. */
function collecting() {
  const lines: string[] = []
  return { lines, sink: (line: string): void => { lines.push(line) } }
}

/** A host logger that records what it received. */
function hostLogger() {
  const info: string[] = []
  const warn: string[] = []
  const error: string[] = []
  return { info, warn, error, logger: { info: (m: string) => { info.push(m) }, warn: (m: string) => { warn.push(m) }, error: (m: string) => { error.push(m) } } }
}

describe('createLogger', () => {
  it('writes the visible copy with one prefix and the level', () => {
    const { lines, sink } = collecting()
    const log = createLogger(undefined, sink)
    log.info('engine ready')
    log.warn('owner is not live')
    log.error('start-up FAILED: boom')
    expect(lines).toEqual([
      `${LOG_PREFIX} INFO engine ready`,
      `${LOG_PREFIX} WARN owner is not live`,
      `${LOG_PREFIX} ERROR start-up FAILED: boom`,
    ])
  })

  it('mirrors every line into the host logger', () => {
    const { sink } = collecting()
    const host = hostLogger()
    const log = createLogger(host.logger, sink)
    log.info('a')
    log.warn('b')
    log.error('c')
    expect(host.info).toEqual([`${LOG_PREFIX} a`])
    expect(host.warn).toEqual([`${LOG_PREFIX} b`])
    expect(host.error).toEqual([`${LOG_PREFIX} c`])
  })

  it('survives a throwing host logger', () => {
    const { lines, sink } = collecting()
    const log = createLogger(
      {
        info: () => { throw new Error('logger is broken') },
        warn: () => { throw new Error('logger is broken') },
        error: () => { throw new Error('logger is broken') },
      },
      sink,
    )
    // A logging failure must not become the plugin's failure.
    expect(() => { log.info('still reported') }).not.toThrow()
    expect(lines).toEqual([`${LOG_PREFIX} INFO still reported`])
  })
})
