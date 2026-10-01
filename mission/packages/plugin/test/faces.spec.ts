/**
 * The two tool faces: which agent sees which half of the mission-tree tools.
 *
 * Visibility only — the refusals inside the tool bodies stay the boundary — but the
 * faces are what keep an owner from carrying executor tools it can never use, and an
 * executor from reading the tree it is only one node of.
 */
import { describe, expect, it } from 'vitest'
import { OWNER_TOOL_DENY, WORKER_TOOL_DENY, visibleTo } from '../src/faces.js'
import { agent, callTool, mount } from './mount.js'

/** Every name this plugin registers, as the mount harness saw it. */
async function registeredNames(): Promise<readonly string[]> {
  const mounted = await mount()
  return mounted.registered.map((entry) => entry.name)
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
  it('classifies every registered tool into exactly one face', async () => {
    // A new tool must be placed deliberately: this fails until it is named on one side.
    const names = (await registeredNames()).slice().sort()
    const hiddenFromWorker = names.filter((name) => WORKER_TOOL_DENY.includes(name))
    const hiddenFromOwner = names.filter((name) => OWNER_TOOL_DENY.includes(name))
    expect([...hiddenFromWorker, ...hiddenFromOwner].sort()).toEqual(names)
    // Disjoint: a name hidden from both faces would be a tool nobody can call.
    expect(hiddenFromWorker.filter((name) => hiddenFromOwner.includes(name))).toEqual([])
  })

  it('keeps the owner tools with the owner and the executor tools with the executor', async () => {
    const names = await registeredNames()
    const ownerSees = names.filter((name) => !OWNER_TOOL_DENY.includes(name))
    const workerSees = names.filter((name) => !WORKER_TOOL_DENY.includes(name))
    expect(ownerSees).toEqual([
      'create_mission',
      'adjust_mission',
      'mission_result',
      'list_missions',
      'finish_mission',
      'cancel_mission',
    ])
    expect(workerSees).toEqual(['note_mission', 'decompose_mission', 'submit_mission'])
  })

  it('filters an assembled tool list without touching anything else', () => {
    const tools = [{ name: 'bash' }, { name: 'create_mission' }, { name: 'submit_mission' }]
    expect(visibleTo(tools, OWNER_TOOL_DENY).map((tool) => tool.name)).toEqual(['bash', 'create_mission'])
    expect(visibleTo(tools, WORKER_TOOL_DENY).map((tool) => tool.name)).toEqual(['bash', 'submit_mission'])
  })
})

describe('the worker face at dispatch', () => {
  it('denies the owner tools to every dispatched worker', async () => {
    const mounted = await mount()
    await callTool(mounted, 'create_mission', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    await mounted.flush()

    const deny = mounted.dispatched[0]?.toolFilter?.deny ?? []
    for (const name of ['create_mission', 'mission_result', 'list_missions', 'finish_mission', 'cancel_mission']) {
      expect(deny, `${name} must not reach a worker`).toContain(name)
    }
    // The executor's own tools stay — including `note_mission`, which `decompose_mission`
    // requires before it will split.
    expect(deny).not.toContain('note_mission')
    expect(deny).not.toContain('decompose_mission')
    expect(deny).not.toContain('submit_mission')
  })
})

describe('the owner face', () => {
  it('restricts the executor tools on the agent when it appears', async () => {
    const mounted = await mount()
    mounted.ctx.emit('agent/created', created(mounted.owner))

    expect(mounted.restrictions).toHaveLength(1)
    expect(mounted.restrictions[0]?.agentId).toBe('owner')
    expect(mounted.restrictions[0]?.filter.deny).toEqual(['note_mission', 'decompose_mission', 'submit_mission'])
  })

  it('applies that face once, not on every event', async () => {
    const mounted = await mount()
    mounted.ctx.emit('agent/created', created(mounted.owner))
    mounted.ctx.emit('agent/created', created(mounted.owner))
    expect(mounted.restrictions).toHaveLength(1)
  })

  it('leaves a worker alone: its face rides the dispatch request instead', async () => {
    const mounted = await mount()
    const worker = agent('mission-1', { origin: 'subagent', delegationDepth: 1 })
    mounted.ctx.emit('agent/created', created(worker))
    expect(mounted.restrictions).toEqual([])
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

  it('leaves a worker\'s assembly untouched', async () => {
    const mounted = await mount()
    const assembly = {
      sections: [],
      contexts: [],
      tools: [{ name: 'bash', description: '', parameters: {} }, { name: 'decompose_mission', description: '', parameters: {} }],
      variables: {},
    }
    const worker = agent('mission-1', { origin: 'subagent', delegationDepth: 1 })
    const filtered = await mounted.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent: worker as never },
      () => Promise.resolve(assembly as never),
    )
    expect(filtered.tools.map((tool) => tool.name)).toEqual(['bash', 'decompose_mission'])
  })
})
