/**
 * The seat readers, and the rule that every seat field goes through one.
 *
 * `seat.ts` exists because a field the running dsh dropped (0.1.6 dropped `SessionSnapshot.queue`)
 * would otherwise throw inside a component body and blank the whole panel with no text. These tests
 * pin both halves: the readers tolerate an absent/wrong-typed field, and the client sources do not
 * read a seat field directly.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isRunning, queuedCount } from '../src/client/seat.js'

const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')

describe('seat field readers', () => {
  it('answers a neutral constant when the host dropped the field (the 0.1.6 `queue` case)', () => {
    // A 0.1.6-shaped snapshot: `running` present, no `queue`. Reading `session.queue.length` directly
    // throws, and a throw here is an empty panel that never retries.
    expect(queuedCount({ running: true })).toBe(-1)
    expect(queuedCount(undefined)).toBe(-1)
    expect(queuedCount({})).toBe(-1)
    expect(isRunning({})).toBe(false)
    expect(isRunning(undefined)).toBe(false)
  })

  it('reports the real values when the fields are there', () => {
    expect(queuedCount({ queue: ['a', 'b', 'c'], running: true })).toBe(3)
    expect(queuedCount({ queue: [], running: false })).toBe(0)
    expect(isRunning({ running: true })).toBe(true)
    expect(isRunning({ running: false })).toBe(false)
  })

  it('treats a wrong-typed field as absent rather than trusting it', () => {
    expect(queuedCount({ queue: 'nope' } as never)).toBe(-1)
    expect(isRunning({ running: 'yes' } as never)).toBe(false)
  })

  it('is the only place a seat snapshot field is read', () => {
    // The regression guard: `index.ts` used to read `session.queue.length` inline. A new direct read
    // would land here with the same "blank panel on an upgraded host" failure mode, so the shape of
    // the client sources is asserted, not just their behaviour.
    const index = readFileSync(join(clientDir, 'index.ts'), 'utf8')
    for (const direct of ['session.queue', 'session.running', 'chat.order']) {
      expect(index, `${direct} must be read through seat.ts`).not.toContain(direct)
    }
  })
})
