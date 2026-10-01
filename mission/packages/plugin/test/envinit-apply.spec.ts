/**
 * `apply`'s two environment-driven exits, mounted as the real function.
 *
 * `envinit.spec.ts` exercises the loader; it never runs `apply`. That leaves the two decisions `apply`
 * makes around the awaited environment gate untested, and both are the kind that only fire in
 * production: the REFUSAL branch (a proven-incompatible host, where nothing may be registered and the
 * megaphone is the sole channel left) and the DISPOSED branch (`ctx.fiber.uid === null` after the
 * await, where every later Cordis call would throw `INACTIVE_EFFECT` and half-register the plugin).
 *
 * Two things make these tests able to fail for their OWN reason:
 *
 * - the loader is mocked (`../src/envinit.js`): these tests are about `apply`'s control flow, not
 *   about provisioning;
 * - the HOST is mocked too (`../src/host.js`), and the stub context carries every service the tail of
 *   `apply` touches. Without that, a missing guard does not reach the assertions — it crashes inside
 *   `new AvantfMissionHost` (`TypeError: … reading 'provide'`) and the test goes red for a reason that has
 *   nothing to do with the guard. With it, a missing guard runs to completion and the assertions fire:
 *   a host was constructed, `ctx.effect` was called, tools were registered.
 */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The loader surface `index.ts` imports, replaced wholesale.
 *
 * `vi.hoisted` because `vi.mock`'s factory is lifted above the imports: the spies must exist before
 * `../src/index.js` is evaluated.
 */
const mocks = vi.hoisted(() => ({
  loadCompat: vi.fn(),
  provision: vi.fn(),
  registerCompatMegaphone: vi.fn(),
  verifyRegisteredFaces: vi.fn(),
}))

/** How many hosts were built; the one thing the two guards exist to prevent. */
const hosts = vi.hoisted(() => ({ constructed: 0 }))

vi.mock('../src/envinit.js', () => mocks)
vi.mock('../src/host.js', () => ({
  AvantfMissionHost: class {
    constructor() { hosts.constructed += 1 }
    start(): Promise<void> { return Promise.resolve() }
    stop(): Promise<void> { return Promise.resolve() }
    markReady(): void { /* the real host keeps the `start()` promise; nothing to hold here */ }
  },
}))

const { apply } = await import('../src/index.js')

/** Lines the plugin's logger sent to stderr (it has no host logger here, so that is its only sink). */
const stderr: string[] = []

/**
 * A context complete enough that the code AFTER either guard — the host, the typert lookup, the
 * prompt sections, the tools, the lifecycle effect — runs to the end instead of throwing. Every
 * surface a mistakenly-continued `apply` would touch records instead of failing, so "nothing was
 * registered" is a positive observation.
 */
function fakeContext(uid: number | null = 1) {
  const registered: unknown[] = []
  const handlers: string[] = []
  const sections: string[] = []
  const commands: string[] = []
  const ctx = {
    logger: undefined,
    fiber: { uid },
    effect: vi.fn(),
    on: vi.fn((event: string) => { handlers.push(event) }),
    get: () => undefined,
    tools: { register: (tool: unknown) => { registered.push(tool) } },
    commands: { register: (command: { name: string }) => { commands.push(command.name) } },
    systemPrompt: {
      section: vi.fn((definition: { name: string }) => { sections.push(definition.name) }),
      context: vi.fn((definition: { name: string }) => { sections.push(definition.name) }),
      getSectionOrder: () => 0,
    },
  }
  return { ctx, registered, handlers, sections, commands }
}

/** The runtime handle `loadCompat` resolves to; only its identity matters to `apply`. */
const RUNTIME = { prefix: 'compat:', schemaNames: [] }

/** A verdict that has PROVEN the host incompatible — the one shape that may refuse the mount. */
const REFUSAL = {
  load: false, skipped: false, status: 'probe-failed', problems: ['tools.register is gone'],
  warnings: ['w1'], notes: [], lines: [], reason: 'incompatible',
}

beforeEach(() => {
  stderr.length = 0
  hosts.constructed = 0
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr.push(args.map(String).join(' ')) })
  for (const spy of Object.values(mocks)) spy.mockReset()
})

afterEach(() => { vi.restoreAllMocks() })

describe('apply: environment exits', () => {
  it('refuses the mount through the megaphone and registers nothing at all', async () => {
    mocks.loadCompat.mockResolvedValue(RUNTIME)
    mocks.provision.mockReturnValue(REFUSAL)
    const { ctx, registered, handlers, sections, commands } = fakeContext()

    await apply(ctx as unknown as Context, {})

    // The verdict is the megaphone's argument, and it is the loader's own object.
    expect(mocks.provision).toHaveBeenCalledTimes(1)
    expect(mocks.registerCompatMegaphone).toHaveBeenCalledTimes(1)
    expect(mocks.registerCompatMegaphone.mock.calls[0]?.[1]).toBe(REFUSAL)

    // The point of the branch: no host, no tools, no listeners, no prompt sections, no lifecycle
    // effect, no post-registration check. These assertions are reached — and would fail — if the
    // refusal ever stopped returning early.
    expect(hosts.constructed).toBe(0)
    expect(registered).toEqual([])
    expect(commands).toEqual([])
    expect(handlers).toEqual([])
    expect(sections).toEqual([])
    expect(ctx.effect).not.toHaveBeenCalled()
    expect(mocks.verifyRegisteredFaces).not.toHaveBeenCalled()
    expect(stderr.join('\n')).toContain('plugin not loaded')
  })

  it('stops cleanly when the fiber was disposed while the environment was being prepared', async () => {
    let release: ((value: unknown) => void) | undefined
    mocks.loadCompat.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const { ctx, registered, handlers, sections, commands } = fakeContext()

    const mounting = apply(ctx as unknown as Context, {})
    // A reload/unload landing inside the await: Cordis clears the uid on disposal.
    ctx.fiber.uid = null
    release?.(undefined)
    await mounting

    // Neither the gate nor anything after it may run — the megaphone included, since a refusal
    // report would itself be a registration on a dead fiber.
    expect(mocks.provision).not.toHaveBeenCalled()
    expect(mocks.registerCompatMegaphone).not.toHaveBeenCalled()
    expect(hosts.constructed).toBe(0)
    expect(registered).toEqual([])
    expect(commands).toEqual([])
    expect(handlers).toEqual([])
    expect(sections).toEqual([])
    expect(ctx.effect).not.toHaveBeenCalled()
    expect(stderr.join('\n')).toContain('unmounted while preparing the environment')
  })
})
