/**
 * A typert registry that THROWS must not take the plugin down with it.
 *
 * The browser face is one of five things this plugin contributes, and the least load-bearing
 * one: without it the 任务 panel reports that it cannot read the tree, while the engine, the
 * tools, the commands, the prompt sections and the storage domain keep working. `apply` must
 * therefore never reject over it. A rejected `apply` is contained in this plugin's own fiber
 * (`cordis/src/fiber.ts:646-673`) and the loader then disposes only this entry
 * (`cordis-plugin-loader/src/config/entry.ts:291-302`); it is the startup audit
 * (`dsh-app-boot/lib/index.js:1465-1494`) and the config hot-reload transaction
 * (`cordis-plugin-loader/src/config/group.ts:59-106`) that turn such a failure into a
 * whole-tree rollback — at which point the engine, this plugin's tools and every neighbouring
 * plugin's row go down with a missing browser face.
 *
 * The failing registry is not hypothetical: `typert.register` validates a contribution whose
 * shape moves between harness revisions (see the structural note on `DeclaredSchema` in
 * `src/wire.ts`), and this plugin is built against one revision while running on another.
 *
 * The real `apply` runs here, over the mount harness's service stubs — only `loadCompat` is
 * mocked, because environment initialisation is not what this file is about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/envinit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/envinit.js')>()
  return {
    ...actual,
    // `undefined` is the base-ABSENT runtime: the documented "cannot tell" path (the bootstrap could
    // not load `@avantf/dsh-plugin-base`), which mounts the full plugin and degrades only the shared
    // prompt layer. What this file varies is the TYPERT registry, not the gate.
    loadCompat: () => Promise.resolve(undefined),
  }
})

const { mount } = await import('./mount.js')

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

describe('a typert registry that throws', () => {
  it('never rejects apply, and still mounts the engine, the tools and the commands', async () => {
    const mounted = await mount({ typertThrows: true })
    // The case actually armed the failure rather than exercising the healthy path.
    expect(mounted.typertError).toBeInstanceOf(Error)

    // ① the engine is up: the storage domain was opened and the service published.
    expect(mounted.ctx.get('avantfMission')).toBeDefined()
    expect(mounted.domainOpens).toBe(1)

    // ② all nine tools are registered — nothing was dropped for want of a browser face.
    expect(mounted.registered.map((tool) => tool.name)).toEqual([
      'create_mission',
      'adjust_mission',
      'note_mission',
      'decompose_mission',
      'submit_mission',
      'mission_result',
      'list_missions',
      'finish_mission',
      'cancel_mission',
    ])

    // ③ the three commands and the prompt contributions are there.
    expect(mounted.commands.map((command) => command.name).sort()).toEqual(['archive', 'clean', 'mission'])
    expect(mounted.sections.map((section) => section.name)).toContain('avantf:mission-tree-guide')
    expect(mounted.contexts.map((context) => context.name)).toContain('avantf:mission-tree')

    // ④ the mount is FUNCTIONAL, not a shell: a tool round-trips through the open domain.
    const created = await mounted.registered
      .find((tool) => tool.name === 'create_mission')
      ?.execute(
        { title: 'Anything', description: 'prove the engine works without a browser face', analysis: [] },
        { agent: mounted.owner, concludeTurn: () => undefined },
      )
    expect((created as { ok: boolean }).ok).toBe(true)
  })

  it('says what was lost, in one ERROR naming both halves of the decision', async () => {
    await mount({ typertThrows: true })

    const complaints = lines.filter((line) => line.includes('typert host face FAILED'))
    expect(complaints, `expected one ERROR, got:\n${lines.join('\n')}`).toHaveLength(1)
    expect(complaints[0]).toContain('[avantf-mission] ERROR')
    expect(complaints[0]).toContain('任务 view will report it')
    expect(complaints[0]).toContain('tools mount anyway')
    expect(complaints[0]).toContain('typert registry is broken')
  })

  it('registers the face normally when the registry behaves', async () => {
    const mounted = await mount()
    expect(lines.filter((line) => line.includes('typert host face FAILED'))).toEqual([])
    expect(mounted.typertContributions).toHaveLength(1)
    expect(mounted.typertError).toBeUndefined()
  })
})
