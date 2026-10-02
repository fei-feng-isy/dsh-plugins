/**
 * WHICH base the plugin loads, and what each answer costs.
 *
 * `wellformed.spec.ts` proves the boundary behaviour with the real base installed. This file varies
 * the OTHER variable — the kit the plugin ends up holding — and pins the two required properties of
 * the degradation:
 *
 *  - when the loaded base carries `wellFormedText` / `wellFormedDeep` (interface v2), the plugin USES
 *    them: the spies below count real calls from the tree funnel, the tool render and the prompt;
 *  - when it does not (base absent, or a v1 module without the two members), the plugin mounts
 *    UNCHANGED — the same nine tools, the same three commands — and repairs with the local copy.
 *
 * "Unchanged" is the load-bearing word: the requirement is that the decision is "is the FUNCTION
 * present", never "is the interface generation incompatible", and never a reason to refuse or to
 * half-mount. The runtime interface gate lives in `envinit.ts` and is mocked here only to hand the
 * plugin a kit; it is not what this file judges.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Shared with the mock factory (hoisted above the imports), toggled per test. */
const spies = vi.hoisted(() => ({
  text: 0,
  deep: 0,
  /** Which kit `loadCompat` hands back: the real v2 module, a v1 look-alike, or nothing at all. */
  mode: 'v2' as 'v2' | 'v1' | 'absent',
}))

vi.mock('../src/envinit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/envinit.js')>()
  return {
    ...actual,
    loadCompat: async (options?: Parameters<typeof actual.loadCompat>[0]) => {
      const runtime = await actual.loadCompat(options)
      if (runtime === undefined || spies.mode === 'absent') return undefined
      const kit = runtime.kit
      if (kit === undefined) return runtime
      if (spies.mode === 'v1') {
        // A base older than interface v2: every OTHER kit member present, the two well-formed
        // members absent. This is the shape the resolver must judge by, not the generation number.
        const v1: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(kit)) {
          if (key !== 'wellFormedText' && key !== 'wellFormedDeep') v1[key] = value
        }
        return { ...runtime, kit: v1 as typeof kit }
      }
      // v2: the real base functions, wrapped so the test can observe that they were the ones used.
      return {
        ...runtime,
        kit: {
          ...kit,
          wellFormedText: (value: string) => {
            spies.text += 1
            return kit.wellFormedText(value)
          },
          wellFormedDeep: <T>(value: T) => {
            spies.deep += 1
            return kit.wellFormedDeep(value)
          },
        } as typeof kit,
      }
    },
  }
})

const { callTool, mount } = await import('./mount.js')

const LONE_HIGH = '\uD800'
const NINE_TOOLS = [
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

/** `String.prototype.isWellFormed` where the engine has it, and an equivalent scan where it does not. */
function isWellFormed(value: string): boolean {
  const native = (String.prototype as { isWellFormed?: () => boolean }).isWellFormed
  if (typeof native === 'function') return native.call(value)
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
      continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** Root one tree through the real tool and return the stored title. */
async function rootTitle(mounted: Awaited<ReturnType<typeof mount>>, title: string): Promise<string> {
  const created = await callTool(mounted, 'create_mission', { title, description: 'work', analysis: [] }, mounted.owner)
  expect(created.ok, created.summary).toBe(true)
  const rootId = String(created.data?.['root_id'] ?? '')
  return mounted.nodeFor(rootId)?.title ?? ''
}

beforeEach(() => {
  spies.text = 0
  spies.deep = 0
  spies.mode = 'v2'
})

describe('the loaded base carries the two functions (v2)', () => {
  it('uses THEM for every boundary, not the local copy', async () => {
    spies.mode = 'v2'
    const mounted = await mount()
    expect(mounted.registered.map((tool) => tool.name)).toEqual(NINE_TOOLS)

    // The host's resolved pair IS the loaded kit's: calling it must be the spy.
    expect(mounted.host.wellFormed.text(LONE_HIGH)).toBe('\uFFFD')
    expect(spies.text).toBeGreaterThan(0)

    // The inbound funnel and the tool render went through the base's `deep` too.
    expect(await rootTitle(mounted, `t${LONE_HIGH}`)).toBe('t\uFFFD')
    expect(spies.deep).toBeGreaterThan(0)
  })
})

describe('the loaded base lacks them (absent, or older than v2)', () => {
  it('mounts unchanged and repairs with the local copy when the base is absent', async () => {
    spies.mode = 'absent'
    const mounted = await mount()
    // Mount behaviour is untouched: the same tools, the same commands.
    expect(mounted.registered.map((tool) => tool.name)).toEqual(NINE_TOOLS)
    expect(mounted.commands.map((command) => command.name).sort()).toEqual(['archive', 'clean', 'mission'])
    // The local copy is what repairs — and it repairs.
    expect(spies.deep).toBe(0)
    const title = await rootTitle(mounted, `t${LONE_HIGH}`)
    expect(isWellFormed(title)).toBe(true)
    expect(title).toBe('t\uFFFD')
  })

  it('mounts unchanged and falls back when the base is v1 (no well-formed members)', async () => {
    spies.mode = 'v1'
    const mounted = await mount()
    expect(mounted.registered.map((tool) => tool.name)).toEqual(NINE_TOOLS)
    // The v1 member is still usable: the prompt layer is not the subject here, but a mount that lost
    // it would be a degradation of the MOUNT, which is exactly what must not happen.
    expect(mounted.host.wellFormed.text(LONE_HIGH)).toBe('\uFFFD')
    expect(spies.text).toBe(0)
    expect(await rootTitle(mounted, `t${LONE_HIGH}`)).toBe('t\uFFFD')
  })
})
