/**
 * The 「任务」 view's remount-resistant state (`viewState.ts`).
 *
 * WHY THIS SUITE EXISTS. The host keys `conversation.view` entries by ENTRY IDENTITY, so the tab's
 * running marker re-registering its seat (the only way the label ever refreshes — see
 * `client-status.spec.ts`) remounts `MissionTreeView`. The reader's expanded rows, open dialog and
 * scroll offset therefore live in this module, and these tests pin the two properties that make that
 * safe: the same session gets the SAME record back (so a remount restores, not resets), and a
 * long-lived tab cannot grow the store without bound.
 *
 * What this CANNOT pin is the remount itself — that the host mints a new React key, and that the
 * restored state lands on screen, are browser facts and are reported as unverified rather than
 * dressed up as tests.
 */
import { describe, expect, it } from 'vitest'
import { rememberOverride, viewStateFor } from '../src/client/viewState.js'

describe('the remount-resistant view state', () => {
  it('hands back the SAME record for a session, and a separate one per session', () => {
    const first = viewStateFor('session-a')
    first.scrollTop = 512
    first.openId = 'n1'
    rememberOverride(first, 'n1', false)

    const again = viewStateFor('session-a')
    expect(again).toBe(first)
    expect(again.scrollTop).toBe(512)
    expect(again.openId).toBe('n1')
    expect(again.overrides.get('n1')).toBe(false)

    // Another conversation must not inherit a scroll offset or an open dialog.
    const other = viewStateFor('session-b')
    expect(other).not.toBe(first)
    expect(other.scrollTop).toBe(0)
    expect(other.openId).toBeUndefined()
    expect(other.overrides.size).toBe(0)
  })

  it('records an override per node, replacing the previous value', () => {
    const state = viewStateFor('session-overrides')
    rememberOverride(state, 'n1', false)
    rememberOverride(state, 'n2', true)
    rememberOverride(state, 'n1', true)
    expect(state.overrides.get('n1')).toBe(true)
    expect(state.overrides.get('n2')).toBe(true)
  })

  it('bounds the per-session overrides, dropping the coldest first', () => {
    const state = viewStateFor('session-bounded')
    for (let index = 0; index < 600; index += 1) rememberOverride(state, `n${String(index)}`, true)
    expect(state.overrides.size).toBe(512)
    // The first-written keys went first; the newest is still there.
    expect(state.overrides.has('n0')).toBe(false)
    expect(state.overrides.has('n599')).toBe(true)
  })

  it('bounds the number of sessions it remembers', () => {
    const sessions = Array.from({ length: 40 }, (_unused, index) => `session-cap-${String(index)}`)
    for (const sessionId of sessions) viewStateFor(sessionId).scrollTop = 42
    // The oldest are dropped; the newest are still remembered.
    expect(viewStateFor('session-cap-0').scrollTop).toBe(0)
    expect(viewStateFor('session-cap-39').scrollTop).toBe(42)
  })
})
