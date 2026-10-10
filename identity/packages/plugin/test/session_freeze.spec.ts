/**
 * The per-session freeze, in isolation.
 *
 * The plugin-level behaviour (a mid-session file edit cannot reach a running session, the next session
 * sees it) is pinned end-to-end in `mechanism.spec.ts`; this file pins the store's own contract,
 * including the two cases that are easy to get wrong: an empty identity is a real frozen value, and an
 * assembly with no session is not frozen at all.
 */
import { describe, expect, it } from 'vitest'
import { SessionFreeze } from '../src/session-freeze.js'

describe('SessionFreeze', () => {
  it('reads once per session and ignores every later change', () => {
    const freeze = new SessionFreeze()
    const session = {}
    let reads = 0
    const read = (): string => {
      reads += 1
      return `v${String(reads)}`
    }
    expect(freeze.text(session, read)).toBe('v1')
    expect(freeze.text(session, read)).toBe('v1')
    expect(reads).toBe(1)
  })

  it('gives each session its own read', () => {
    const freeze = new SessionFreeze()
    let reads = 0
    const read = (): string => {
      reads += 1
      return `v${String(reads)}`
    }
    const a = {}
    const b = {}
    expect(freeze.text(a, read)).toBe('v1')
    expect(freeze.text(b, read)).toBe('v2')
    expect(freeze.text(a, read)).toBe('v1')
  })

  it('freezes an empty identity too (the switch was off when the session started)', () => {
    const freeze = new SessionFreeze()
    const session = {}
    expect(freeze.text(session, () => '')).toBe('')
    // A falsy check instead of `undefined` would re-read here and change the prompt mid-session.
    expect(freeze.text(session, () => 'later')).toBe('')
  })

  it('reads live when the assembly carries no session to key on', () => {
    const freeze = new SessionFreeze()
    let reads = 0
    const read = (): string => {
      reads += 1
      return `v${String(reads)}`
    }
    expect(freeze.text(undefined, read)).toBe('v1')
    expect(freeze.text(undefined, read)).toBe('v2')
  })
})
