/**
 * A storage domain that will not open must DEGRADE the mount, not kill the process.
 *
 * Measured on the installed loader (R4, see the `start()` doc in `src/host.ts`), a start-up failure
 * has exactly three outcomes: an `apply` throw or an AWAITED rejection fails only that loader entry
 * (0.1.7 / 0.2.0 lines); an UNHANDLED rejection is a whole-generation fatal (`installFailLoud` →
 * `exit(1)`); on the 0.1.5 line any inactive row makes the boot throw. `apply` kicks `host.start()`
 * off fire-and-forget, and the old `.catch(… => { throw error })` left the resulting promise with no
 * consumer — so a single storage hiccup became a process-level fatal, the opposite of what the code
 * comment claimed.
 *
 * The policy under test (same as mem's DEGRADED mount): storage will not open → the plugin MOUNTS,
 * logs one loud ERROR naming the cause, keeps the whole tool surface registered with every entry
 * answering "not ready + reason", lets `/mission` report it, and leaves NO unhandled rejection.
 *
 * The mount here runs on the REAL fire-and-forget path (`awaitReady: false`: nothing has consumed
 * `whenReady()` yet), which is what makes the unhandled-rejection assertion meaningful rather than a
 * harness artifact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mount, callTool } = await import('./mount.js')

/** Every line this mount sent to stderr, where `createLogger` mirrors them. */
const lines: string[] = []

beforeEach(() => {
  lines.length = 0
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The nine tools the mount must keep registering even when nothing can be read or written. */
const TOOL_NAMES = [
  'create_mission',
  'adjust_mission',
  'note_mission',
  'decompose_mission',
  'submit_mission',
  'mission_result',
  'list_missions',
  'finish_mission',
  'cancel_mission',
]

describe('a storage domain that will not open', () => {
  it('mounts DEGRADED: tools answer the reason, /mission reports it, no unhandled rejection', async () => {
    const rejections: unknown[] = []
    const listener = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      const mounted = await mount({ failDomainOpen: true, awaitReady: false })

      // Let the start-up rejection settle. On the OLD code this is the turn in which Node would emit
      // `unhandledRejection` for the re-thrown start-up promise; `rejections` is asserted below.
      await new Promise((resolve) => setTimeout(resolve, 30))

      // ① the plugin is MOUNTED — this was a failed row (or a fatal) before.
      expect(mounted.ctx.get('avantfMission')).toBeDefined()
      expect(mounted.host.degradedReason()).toContain('could not be opened')

      // ② the whole tool surface is still registered.
      expect(mounted.registered.map((tool) => tool.name)).toEqual(TOOL_NAMES)
      expect(mounted.commands.map((command) => command.name).sort()).toEqual(['archive', 'clean', 'mission'])

      // ③ every entry answers a readable "not ready + reason" instead of a TypeError out of a missing tree.
      const created = await callTool(mounted, 'create_mission', { title: 'x', description: 'y' }, mounted.owner)
      expect(created.ok).toBe(false)
      expect(created.summary).toContain('未就绪')
      expect(created.summary).toContain('could not be opened')
      expect(created.data).toMatchObject({ code: 'not-ready' })

      const listed = await callTool(mounted, 'list_missions', {}, mounted.owner)
      expect(listed.ok).toBe(false)
      expect(listed.summary).toContain('could not be opened')

      // ④ `/mission` reports through its ordinary error shape, not a throw.
      const command = await mounted.runCommand('mission', '')
      expect(command.kind).toBe('error')
      expect(command.text).toContain('could not be opened')

      // ⑤ exactly one loud ERROR naming the cause (the operator must be able to diagnose it).
      const degradedLines = lines.filter((line) => line.includes('mounting DEGRADED'))
      expect(degradedLines, `expected one ERROR, got:\n${lines.join('\n')}`).toHaveLength(1)
      expect(degradedLines[0]).toContain('[avantf-mission] ERROR')
      expect(degradedLines[0]).toContain('could not be opened')

      // ⑥ the FATAL path is not taken: nothing left unhandled, and readiness RESOLVES rather than rejects.
      expect(rejections).toEqual([])
      await expect(mounted.host.whenReady()).resolves.toBeUndefined()
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  it('leaves a healthy mount alone (the gate keys on degraded, not on readiness)', async () => {
    const mounted = await mount()
    expect(mounted.host.degradedReason()).toBeUndefined()
    const listed = await callTool(mounted, 'list_missions', {}, mounted.owner)
    expect(listed.ok).toBe(true)
  })
})
