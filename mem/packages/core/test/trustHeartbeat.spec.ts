/**
 * The shared trust heartbeat (`installTrustHeartbeat`).
 *
 * The oracle lives with the sink, and it is a fake-timer one on purpose: the property that matters
 * is temporal — exactly one tick and one `onBeat` per interval, and nothing at all after dispose.
 * The two surfaces differ only in wording and in the extra per-beat work, which is what the second
 * case pins.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTrustHeartbeat } from '../src/index.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('the shared trust heartbeat', () => {
  it('ticks once per beat, runs onBeat after it, and stops for good on dispose', () => {
    vi.useFakeTimers()
    const events: string[] = []
    const warnings: string[] = []
    const stop = installTrustHeartbeat({
      memory: { trustTick: () => { events.push('tick') } },
      logger: { warn: (message) => { warnings.push(message) } },
      heartbeatMinutes: 1,
      onBeat: () => { events.push('beat') },
    })
    // Nothing before the first interval: the caller's startup pass is its own.
    expect(events).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(events).toEqual(['tick', 'beat'])
    vi.advanceTimersByTime(60_000)
    expect(events).toEqual(['tick', 'beat', 'tick', 'beat'])
    // Disposed: ten more minutes must produce nothing (the DSH plugin's `ctx.effect` and the MCP
    // server's shutdown both rely on this).
    stop()
    vi.advanceTimersByTime(10 * 60_000)
    expect(events).toEqual(['tick', 'beat', 'tick', 'beat'])
    expect(warnings).toEqual([])
  })

  it('warns in the caller\'s own wording and keeps beating when the tick throws', () => {
    vi.useFakeTimers()
    let ticks = 0
    let beats = 0
    const warnings: string[] = []
    const stop = installTrustHeartbeat({
      memory: { trustTick: () => { ticks += 1; throw new Error('database is not open') } },
      logger: { warn: (message) => { warnings.push(message) } },
      heartbeatMinutes: 60,
      // The MCP wording: the surface names its own failure, and the sink must not homogenize it.
      tickFailed: (message) => `trust heartbeat: sweep failed (${message})`,
      onBeat: () => { beats += 1 },
    })
    vi.advanceTimersByTime(3_600_000)
    expect(warnings).toEqual(['trust heartbeat: sweep failed (database is not open)'])
    // The extra work still ran: a failed sweep must not skip the rest of the beat.
    expect(ticks).toBe(1)
    expect(beats).toBe(1)
    stop()
  })

  it('defaults the failure wording, and handles a non-Error value', () => {
    vi.useFakeTimers()
    const warnings: string[] = []
    const stop = installTrustHeartbeat({
      memory: { trustTick: () => { throw 'cold' } },
      logger: { warn: (message) => { warnings.push(message) } },
      heartbeatMinutes: 1,
    })
    vi.advanceTimersByTime(60_000)
    expect(warnings).toEqual(['trust tick failed: cold'])
    stop()
  })
})
