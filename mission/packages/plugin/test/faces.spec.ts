/**
 * The two tool faces, now installed PER AGENT SCOPE.
 *
 * What this file proves is the boundary the change exists for: the nine mission tools are registered
 * into the scope of the sessions that can use them — six for a session that may root a tree, three
 * for one of our dispatched workers, none at all for anybody else — and NOTHING is registered
 * globally any more. Visibility (the assembly waterfall) is a second, stateless layer; it is pinned
 * here too, but the scope assertions are the ones that make a teammate subagent carry zero mission
 * tools rather than nine hidden ones.
 *
 * The plugin's own face installer is what the fixture drives (`mount.ts` binds it), so these cases
 * exercise the same `missionFaceOf` decision a live `agent/created` does.
 */
import { describe, expect, it } from 'vitest'
import {
  OWNER_FACE_TOOLS,
  OWNER_TOOL_DENY,
  WORKER_TOOL_DENY,
  MISSION_TOOL_NAMES,
  faceTools,
  hiddenMissionTools,
  missionFaceOf,
  visibleTo,
} from '../src/faces.js'
import { agent, callTool, mount, type Mounted, type StubAgent } from './mount.js'
import { makeFaceInstaller } from '../src/index.js'

/** Every name in one scope's OWN layer: the registration this whole file is about. */
function scopedNames(mounted: Mounted, subject: StubAgent): string[] {
  return mounted.scopedNamesOf(subject)
}

/** Whether ANY mission name is registered in the GLOBAL layer, via the one-argument `tools.get`. */
function globalMissionNames(mounted: Mounted): string[] {
  const tools = mounted.ctx.get('tools') as unknown as { get: (name: string, scope?: unknown) => unknown }
  return MISSION_TOOL_NAMES.filter((name) => tools.get(name) !== undefined)
}

/**
 * The `agent/created` payload this plugin's listener answers.
 *
 * dsh 0.1.7 made `source` a REQUIRED field of that event; the 0.1.5 line declares none. The payload
 * is therefore passed whole as `never`, the same escape this file already used for the agent: the
 * listener reads only `agent`, and a literal that satisfies one generation's payload type is an
 * excess-property error on the other.
 */
function created(agent: unknown): never {
  return { agent, source: 'startup' } as never
}

describe('the face table', () => {
  it('partitions every mission tool into exactly one face', () => {
    // A new tool must be placed deliberately: this fails until it is named on one side.
    const hiddenFromWorker = MISSION_TOOL_NAMES.filter((name) => WORKER_TOOL_DENY.includes(name))
    const hiddenFromOwner = MISSION_TOOL_NAMES.filter((name) => OWNER_TOOL_DENY.includes(name))
    expect([...hiddenFromWorker, ...hiddenFromOwner].sort()).toEqual([...MISSION_TOOL_NAMES].sort())
    // Disjoint: a name hidden from both faces would be a tool nobody can call.
    expect(hiddenFromWorker.filter((name) => hiddenFromOwner.includes(name))).toEqual([])
    // The two INSTALL lists are the faces themselves, and they partition the nine as well.
    expect([...faceTools('owner'), ...faceTools('worker')].sort()).toEqual([...MISSION_TOOL_NAMES].sort())
  })

  it('pins the worker face: internal delegation open, messaging and the owner half closed', () => {
    // The exact list is a boundary, not a convenience — a name added or dropped here changes what every
    // dispatched worker may do — so it is pinned rather than sampled.
    expect([...WORKER_TOOL_DENY]).toEqual([
      'send_message',
      'create_goal',
      'get_goal',
      'update_goal',
      'create_mission',
      'adjust_mission',
      'mission_result',
      'list_missions',
      'finish_mission',
      'cancel_mission',
    ])
    // `subagent` / `subagent_fork` are deliberately ABSENT: a child spawned inside one node cannot break
    // convergence (the tree reads nodes and results), whereas `send_message` could report AROUND the tree
    // into the owner's own session, and the goal tools would let an executor answer to another objective.
    // `submit_mission` stays the one exit either way.
    expect(WORKER_TOOL_DENY).not.toContain('subagent')
    expect(WORKER_TOOL_DENY).not.toContain('subagent_fork')
  })

  it('filters an assembled tool list without touching anything else', () => {
    const tools = [{ name: 'bash' }, { name: 'create_mission' }, { name: 'submit_mission' }]
    expect(visibleTo(tools, OWNER_TOOL_DENY).map((tool) => tool.name)).toEqual(['bash', 'create_mission'])
    expect(visibleTo(tools, WORKER_TOOL_DENY).map((tool) => tool.name)).toEqual(['bash', 'submit_mission'])
  })

  it('classifies the two roles from the same judgement the plugin uses', async () => {
    const mounted = await mount()
    expect(missionFaceOf(mounted.host, mounted.owner)).toBe('owner')
    expect(missionFaceOf(mounted.host, agent('mission-1234abcd', { origin: 'subagent', delegationDepth: 1 }))).toBe('worker')
    expect(missionFaceOf(mounted.host, agent('f4f3163b-1111-2222-3333-444455556666', { origin: 'subagent' }))).toBeUndefined()
  })
})

describe('the scoped installation', () => {
  it('① installs exactly the owner six into a tree-rooting agent\'s own scope', async () => {
    const mounted = await mount()
    expect(scopedNames(mounted, mounted.owner)).toEqual([...OWNER_FACE_TOOLS].sort())
    for (const name of OWNER_TOOL_DENY) {
      expect(scopedNames(mounted, mounted.owner), `${name} must not be in the owner's scope`).not.toContain(name)
    }
  })

  it('② installs exactly the worker three into a dispatched worker\'s own scope', async () => {
    const mounted = await mount()
    await callTool(mounted, 'create_mission', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    await mounted.flush()
    const worker = mounted.workerFor(String(mounted.dispatched[0]?.childId ?? ''))
    expect(worker.id).toMatch(/^mission-/u)
    expect(scopedNames(mounted, worker)).toEqual([...OWNER_TOOL_DENY].sort())
    for (const name of OWNER_FACE_TOOLS) {
      expect(scopedNames(mounted, worker), `${name} must not be in a worker's scope`).not.toContain(name)
    }
  })

  it('③ installs NOTHING into a session that is neither owner nor worker', async () => {
    // A teammate subagent: `origin: 'subagent'` (so it cannot root a tree) with an id that is not one
    // of our claim ids. It must carry no mission tool at all — not nine hidden ones.
    const mounted = await mount()
    const teammate = agent('f4f3163b-1111-2222-3333-444455556666', { origin: 'subagent' })
    mounted.emitCreated(teammate)
    expect(scopedNames(mounted, teammate)).toEqual([])
    const tools = mounted.ctx.get('tools') as unknown as { get: (name: string, scope?: unknown) => unknown }
    for (const name of MISSION_TOOL_NAMES) {
      expect(tools.get(name, teammate), `${name} must not be visible to a teammate`).toBeUndefined()
    }
    // …and it inherits none of the owner's layer either: the owner's six live in the OWNER's scope.
    for (const name of OWNER_FACE_TOOLS) {
      expect(tools.get(name, teammate)).toBeUndefined()
    }
    // Nothing about installing it touched the global layer.
    expect(globalMissionNames(mounted)).toEqual([])
  })

  it('④ a registration made in one scope is invisible globally and to every other scope', async () => {
    const mounted = await mount()
    // The owner's six exist in the owner's scope and in NO global reading: `restrict()` and the compat
    // check judge by the one-argument `get`, which is why these never appear as "unknown global tool".
    expect(scopedNames(mounted, mounted.owner)).toHaveLength(6)
    expect(globalMissionNames(mounted)).toEqual([])
  })

  it('does not double-install when the same agent is announced twice', async () => {
    const mounted = await mount()
    try {
      const before = mounted.installedFaces().length
      const beforeScoped = scopedNames(mounted, mounted.owner)
      mounted.emitCreated(mounted.owner)
      mounted.emitCreated(mounted.owner)
      // The ledger is the observation that no SECOND registration happened — the previous test's
      // plugin still lives in this process, and only a fresh install would add entries.
      expect(mounted.installedFaces().length).toBe(before)
      expect(scopedNames(mounted, mounted.owner)).toEqual(beforeScoped)
      expect(scopedNames(mounted, mounted.owner)).toEqual([...OWNER_FACE_TOOLS].sort())
    } finally {
      await mounted.ctx.fiber.dispose()
    }
  })

  it('uninstalls on agent/disposed and clears everything when the plugin unloads', async () => {
    const mounted = await mount()
    // The owner was installed by the cold-resume sweep — the mount-time half of the installation.
    expect(scopedNames(mounted, mounted.owner)).toEqual([...OWNER_FACE_TOOLS].sort())
    expect(mounted.installedFaces()).toHaveLength(6)

    // Disposal releases the scope's layer through the disposers the plugin kept.
    mounted.emitDisposed(mounted.owner)
    expect(scopedNames(mounted, mounted.owner)).toEqual([])
    expect(mounted.scopedNamesOf(mounted.owner)).toEqual([])

    // A worker announced after that still installs its own three: the plugin is still mounted, and the
    // disposal touched only the disposed agent's scope.
    const worker = agent('mission-1234abcd', { origin: 'subagent', delegationDepth: 1 })
    mounted.emitCreated(worker)
    expect(scopedNames(mounted, worker)).toEqual([...OWNER_TOOL_DENY].sort())

    // Plugin unload: `ctx.effect` sweeps every remaining scope.
    await mounted.ctx.fiber.dispose()
    expect(scopedNames(mounted, worker)).toEqual([])
    expect(mounted.scopedNamesOf(worker)).toEqual([])
  })

  it('installs NOTHING when the plugin mounts with an empty agent registry', async () => {
    // `noAgents` removes even the owner from the registry the cold-resume sweep reads, which is the
    // case the old global registration could not express: there is no agent, so there is no face.
    const mounted = await mount({ noAgents: true })
    expect(mounted.installedFaces()).toEqual([])
    expect(globalMissionNames(mounted)).toEqual([])
    expect(scopedNames(mounted, mounted.owner)).toEqual([])
  })

  it('NAMES the skip when a session has no scoped registry, and stays silent for a session with no face', async () => {
    // The installer's own skip path, driven directly because the mount fixture always has a registry:
    // a session that cannot be reached gets NO tool at all — the assembly waterfall can only filter a
    // list it is handed, so it cannot restore this. Silent in that case would look exactly like "the
    // plugin has no tools", which is the failure shape this warning exists to make visible.
    const mounted = await mount()
    try {
      const noRegistry = agent('no-registry-session')
      delete noRegistry.ctx
      const lines: string[] = []
      const log = {
        info: () => undefined,
        warn: (message: string) => { lines.push(message) },
        error: () => undefined,
      }
      // The SAME installer the live `agent/created` listener and the fixture's seam both drive, bound
      // to this mount's real host so the role judgement is the production one.
      const install = makeFaceInstaller({
        host: mounted.host,
        tools: [],
        compat: undefined,
        ctx: mounted.ctx,
        log,
        installed: new Map(),
      })

      install(noRegistry)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('no scoped tools registry')
      expect(lines[0]).toContain(noRegistry.id)
      expect(lines[0]).toContain('no mission tool')

      // A session that was never going to get a face is not a degradation: a teammate subagent, whose
      // absence of mission tools is the DESIGN, must not produce a line here.
      lines.length = 0
      const teammate = agent('f4f3163b-1111-2222-3333-444455556666', { origin: 'subagent' })
      delete teammate.ctx
      install(teammate)
      expect(lines).toEqual([])
    } finally {
      // `tools: []` means this installer registered nothing, but the mount itself still holds the
      // owner's face; dispose so the next case starts from a clean registry.
      await mounted.ctx.fiber.dispose()
    }
  })
})

describe('the worker face at dispatch', () => {
  it('denies the harness capabilities a worker must not use, and never names a scoped tool', async () => {
    // `toolFilter` may only name GLOBAL tools: naming a name registered in some agent's own scope makes
    // `restrict()` throw for the whole dispatch (`startChild` then retries without that name). The
    // mission tools are agent-scoped now, so this face carries the harness names — the owner half is
    // already absent from a worker, because it was never registered into the worker's scope.
    const mounted = await mount()
    await callTool(mounted, 'create_mission', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    await mounted.flush()

    const deny = mounted.dispatched[0]?.toolFilter?.deny ?? []
    for (const name of ['send_message', 'create_goal', 'get_goal', 'update_goal']) {
      expect(deny, `${name} must not reach a worker`).toContain(name)
    }
    // Nothing scope-registered is named (it would throw); the executor's own tools are not denied.
    for (const name of OWNER_FACE_TOOLS) {
      expect(deny, `${name} is scope-registered and must not be named in a filter`).not.toContain(name)
    }
    expect(deny).not.toContain('note_mission')
    expect(deny).not.toContain('decompose_mission')
    expect(deny).not.toContain('submit_mission')
  })
})

describe('the owner face', () => {
  it('restricts nothing in the scoped world: the executor half is not a global name', async () => {
    // `restrict()` may only name GLOBAL tools. The executor half is installed in the WORKER's scope,
    // so there is nothing for an owner to deny — the face is already enforced by the registration.
    const mounted = await mount()
    mounted.ctx.emit('agent/created', created(mounted.owner))
    expect(mounted.restrictions()).toEqual([])
    expect(scopedNames(mounted, mounted.owner)).toEqual([...OWNER_FACE_TOOLS].sort())
  })

  it('leaves a worker alone: its face rides the dispatch request instead', async () => {
    const mounted = await mount()
    const worker = agent('mission-1', { origin: 'subagent', delegationDepth: 1 })
    mounted.ctx.emit('agent/created', created(worker))
    expect(mounted.restrictions()).toEqual([])
    // `mission-1` is not a claim-shaped id, so it is not one of our workers either: no face.
    expect(scopedNames(mounted, worker)).toEqual([])
  })

  it('filters the tools out of the owner\'s assembly, which is what the model reads', async () => {
    // The stateless half: an agent that already existed when this plugin mounted still
    // cannot see the executor tools, because the assembly itself drops them.
    const mounted = await mount()
    const assembly = {
      sections: [],
      contexts: [],
      tools: [
        { name: 'bash', description: '', parameters: {} },
        { name: 'create_mission', description: '', parameters: {} },
        { name: 'decompose_mission', description: '', parameters: {} },
        { name: 'submit_mission', description: '', parameters: {} },
      ],
      variables: {},
    }
    const filtered = await mounted.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent: mounted.owner as never },
      () => Promise.resolve(assembly as never),
    )
    expect(filtered.tools.map((tool) => tool.name)).toEqual(['bash', 'create_mission'])
  })

  it('filters the owner half, not the executor half, out of a worker\'s assembly', async () => {
    // The stateless half for a dispatched worker: it keeps `note_mission` / `decompose_mission` /
    // `submit_mission` and loses the six owner tools. `mission-1234abcd` is a real claim id — a
    // worker's face is decided by `isWorkerClaim`, not by the `origin: 'subagent'` header alone.
    const mounted = await mount()
    const assembly = {
      sections: [],
      contexts: [],
      tools: [
        { name: 'bash', description: '', parameters: {} },
        { name: 'decompose_mission', description: '', parameters: {} },
        { name: 'create_mission', description: '', parameters: {} },
      ],
      variables: {},
    }
    const worker = agent('mission-1234abcd', { origin: 'subagent', delegationDepth: 1 })
    const filtered = await mounted.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent: worker as never },
      () => Promise.resolve(assembly as never),
    )
    expect(filtered.tools.map((tool) => tool.name)).toEqual(['bash', 'decompose_mission'])
  })
})

/**
 * The three roles the assembly waterfall tells apart, and the one thing it must never touch: the
 * scoped registration. Hiding is usability only — `create_mission` still answers `no-authority` and
 * `note/decompose/submit` still answer `not-owner`.
 */
describe('the assembly face by session role', () => {
  const NON_MISSION = 'bash'

  /** The nine mission tools plus one host tool, as the assembler hands them over. */
  function allTools(): { name: string; description: string; parameters: Record<string, never> }[] {
    return [NON_MISSION, ...MISSION_TOOL_NAMES].map((name) => ({ name, description: '', parameters: {} }))
  }

  async function visibleFor(
    mounted: Awaited<ReturnType<typeof mount>>,
    caller: unknown,
    tools = allTools(),
  ): Promise<string[]> {
    const assembly = { sections: [], contexts: [], tools, variables: {} }
    const filtered = await mounted.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent: caller as never },
      () => Promise.resolve(assembly as never),
    )
    return filtered.tools.map((tool) => tool.name)
  }

  it('① a top-level session keeps the owner six and loses the executor three', async () => {
    const mounted = await mount()
    const visible = await visibleFor(mounted, mounted.owner)
    expect(visible).toEqual([NON_MISSION, ...OWNER_FACE_TOOLS])
    for (const name of OWNER_TOOL_DENY) expect(visible).not.toContain(name)
  })

  it('② a worker keeps the executor three and loses the owner six', async () => {
    const mounted = await mount()
    const visible = await visibleFor(
      mounted,
      agent('mission-1234abcd', { origin: 'subagent', delegationDepth: 1 }),
    )
    expect(visible).toEqual([NON_MISSION, ...OWNER_TOOL_DENY])
    for (const name of OWNER_FACE_TOOLS) expect(visible).not.toContain(name)
  })

  it('③ a session that is neither owner nor worker sees no mission tool at all', async () => {
    // A teammate subagent: `origin: 'subagent'` (so it cannot root a tree) with an id that is not one
    // of our claim ids. Before this change it carried all nine, one of which refuses on every call.
    const mounted = await mount()
    const teammate = agent('f4f3163b-1111-2222-3333-444455556666', { origin: 'subagent' })
    const visible = await visibleFor(mounted, teammate)
    expect(visible).toEqual([NON_MISSION])
    for (const name of MISSION_TOOL_NAMES) expect(visible).not.toContain(name)
  })

  it('④ every mission tool is installed in its OWNER\'s scope and in nobody else\'s', async () => {
    // The old shape of this case pinned "registered globally, visible nowhere" — that is precisely
    // what changed. Each of the nine is now in exactly one scope, decided by role.
    const mounted = await mount()
    const ownerNames = new Set(scopedNames(mounted, mounted.owner))
    await callTool(mounted, 'create_mission', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    await mounted.flush()
    const worker = mounted.workerFor(String(mounted.dispatched[0]?.childId ?? ''))
    const workerNames = new Set(scopedNames(mounted, worker))
    const union = new Set([...ownerNames, ...workerNames])
    expect([...union].sort()).toEqual([...MISSION_TOOL_NAMES].sort())
    expect([...ownerNames].sort()).toEqual([...OWNER_FACE_TOOLS].sort())
    expect([...workerNames].sort()).toEqual([...OWNER_TOOL_DENY].sort())
    // The global view has none of them, which is what "not registered globally" means.
    expect(globalMissionNames(mounted)).toEqual([])
  })

  it('the role helper is the same judgement the waterfall applies', () => {
    expect(hiddenMissionTools('owner')).toEqual(OWNER_TOOL_DENY)
    expect(hiddenMissionTools('worker')).toEqual(OWNER_FACE_TOOLS)
    expect(hiddenMissionTools('other')).toEqual(MISSION_TOOL_NAMES)
  })
})
