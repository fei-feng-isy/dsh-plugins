/**
 * The guidance layer asks the BASE for this plugin's NAMESPACE — the `mission` in `mission-*.md`.
 *
 * `<data home>/prompts` is one directory shared by the whole family (the memory plugin keeps its
 * `mem-*` files there), and until interface v3 the `mem-*` / `mission-*` split was a convention with
 * no machine check. v3 makes it a field the base validates: `PromptFiles({ namespace })` refuses to
 * read or write any spec that is not `<namespace>-…`, so a mistyped prefix degrades to the built-in
 * default instead of touching a file another plugin's user owns.
 *
 * What this file exists for is the WIRING, which no unit test of `prompt.ts` can see: `prompt.ts`
 * owns the constant, but only `apply` decides whether it reaches the constructor. `loadCompat` is
 * mocked here — not to fake the base, but to observe which options `apply` hands the REAL loader,
 * the same device `wellformed-mount.spec.ts` uses to watch the kit. The second describe varies the
 * other side of the contract: a base whose `PromptFiles` predates v3 and knows nothing of the field.
 *
 * The BASE is genuinely absent in `mount-anyway.spec.ts` (the `kit?.PromptFiles === undefined`
 * branch), which is untouched by this change.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Shared with the mock factory, which is hoisted above the imports. */
const spies = vi.hoisted(() => ({
  /** Every options object `apply` handed the loaded kit's `PromptFiles` constructor. */
  constructed: [] as { dir?: string; namespace?: string }[],
  /**
   * Which kit `loadCompat` hands back:
   *  - `v3`: the real module (a namespace-aware constructor);
   *  - `v2`: the same loader behind a constructor that IGNORES the field — the shape of a base
   *    written before interface v3. The plugin's request is unchanged; only the answer differs.
   */
  mode: 'v3' as 'v3' | 'v2',
}))

vi.mock('../src/envinit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/envinit.js')>()
  return {
    ...actual,
    loadCompat: async (options?: Parameters<typeof actual.loadCompat>[0]) => {
      const runtime = await actual.loadCompat(options)
      if (runtime === undefined || runtime.kit === undefined) return runtime
      const kit = runtime.kit
      const Real = kit.PromptFiles
      // A subclass keeps everything else the REAL base: only the constructor is observed, and in
      // `v2` mode it drops the one field a pre-v3 loader would never look at.
      class Recording extends Real {
        constructor(options: ConstructorParameters<typeof Real>[0]) {
          if (spies.mode === 'v2') {
            const { namespace: _ignored, ...legacy } = options
            super(legacy)
          } else {
            super(options)
          }
          spies.constructed.push({ dir: options.dir, namespace: options.namespace })
        }
      }
      return { ...runtime, kit: { ...kit, PromptFiles: Recording } as typeof kit }
    },
  }
})

const { mount } = await import('./mount.js')
const { PROMPT_NAMESPACE, promptDir } = await import('../src/prompt.js')

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
const THREE_COMMANDS = ['archive', 'clean', 'mission']
const SECTION = 'avantf:mission-tree-guide'

/** The section's text for the owner, or `undefined` when it was never registered. */
function guide(mounted: Awaited<ReturnType<typeof mount>>): string | undefined {
  return mounted.sections.find((entry) => entry.name === SECTION)?.text({ agent: mounted.owner })
}

beforeEach(() => {
  spies.constructed.length = 0
  spies.mode = 'v3'
})

describe('the namespace reaches the base\'s PromptFiles', () => {
  it('constructs the loader with `namespace: \'mission\'` and this plugin\'s prompt directory', async () => {
    const mounted = await mount()
    expect(spies.constructed).toHaveLength(1)
    // The value flows from `prompt.ts`'s constant through `index.ts` — a construction that dropped
    // the field would leave the shared directory unguarded and this expectation red.
    expect(PROMPT_NAMESPACE).toBe('mission')
    expect(spies.constructed[0]).toEqual({ dir: promptDir(), namespace: 'mission' })
    // …and the section it backs is registered as usual.
    expect(mounted.sections.map((entry) => entry.name)).toContain(SECTION)
  })
})

describe('a base older than v3 (its PromptFiles ignores `namespace`)', () => {
  it('mounts UNCHANGED — no degradation, and the file is still read byte for byte', async () => {
    spies.mode = 'v2'
    const dir = promptDir()
    mkdirSync(dir, { recursive: true })
    const edited = '旧底座也要逐字读到这一条。'
    writeFileSync(`${dir}/mission-tree-guide.md`, `${edited}\n`, 'utf8')
    try {
      const mounted = await mount()
      // The plugin still ASKS for the namespace; the older base simply ignores the extra field.
      expect(spies.constructed[0]?.namespace).toBe('mission')
      // No degradation: the same tools, commands and sections, and the user's text wins.
      expect(mounted.registered.map((tool) => tool.name)).toEqual(NINE_TOOLS)
      expect(mounted.commands.map((command) => command.name).sort()).toEqual(THREE_COMMANDS)
      expect(guide(mounted)).toBe(edited)
    } finally {
      rmSync(`${dir}/mission-tree-guide.md`, { force: true })
    }
  })
})
