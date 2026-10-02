/**
 * Unit leases: the engine's guarantee that one scope has one executor at a time.
 *
 * These cases drive the REAL tree and engine over an in-memory store, so what is asserted is the
 * state rule itself — "the lease is the unit of the `running` nodes" — and not a table some caller
 * has to remember to release. The eight acceptance properties (at most one per unit, different
 * units in parallel, a blocked parent holding nothing, a reclaim releasing, undeclared units
 * unchanged, no cross-tree double run, legacy records reading as `null`, and the durable round
 * trip) live here and in the plugin's `domain.spec.ts` / `unit-lease.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENGINE_OPTIONS,
  MissionEngine,
  MissionTree,
  type ChildSpec,
  type NodeRecord,
  type TreeState,
  type TreeStore,
} from '../src/index.js'

function memoryStore(): TreeStore & { documents: Map<string, TreeState> } {
  const documents = new Map<string, TreeState>()
  return {
    documents,
    loadAll: () => Promise.resolve([...documents.values()]),
    put: (state) => {
      documents.set(state.tree.rootId, state)
      return Promise.resolve()
    },
    remove: (rootId) => {
      documents.delete(rootId)
      return Promise.resolve()
    },
  }
}

/** A tree plus a worker pool, with a monotonic injected clock. */
function makeWorld(options: { maxConcurrent?: number } = {}) {
  const store = memoryStore()
  const live = new Set<string>(['owner'])
  const started: string[] = []
  let sequence = 0
  let tick = 0
  const tree = new MissionTree(store, {
    isAgentLive: (sessionId) => live.has(sessionId),
    probeOwner: () => Promise.resolve({ kind: 'exists' }),
    spill: () => Promise.resolve(null),
    now: () => (tick += 1),
    newId: () => `n${String(++sequence).padStart(4, '0')}`,
  })
  const engine = new MissionEngine(
    tree,
    {
      reserveClaimId: () => `mission-${String(++sequence)}`,
      releaseClaimId: () => undefined,
      startWorker: ({ claimId }) => {
        started.push(claimId)
        // Materializes immediately, like the real child: the node is bound to a live holder.
        live.add(claimId)
        return Promise.resolve()
      },
      interruptWorker: () => Promise.resolve(),
      notifyOwner: () => undefined,
    },
    { maxConcurrent: options.maxConcurrent ?? 4, staleMs: 60_000, roundMs: DEFAULT_ENGINE_OPTIONS.roundMs },
  )
  return { tree, engine, store, live, started }
}

/** Root one mission; `unit` is omitted (not passed) unless the caller names it, so the "nothing
 *  declared" case is the default the tests exercise. */
async function root(tree: MissionTree, input: { title: string; unit?: string | null }): Promise<string> {
  const created = await tree.createRoot({
    ownerSessionId: 'owner',
    title: input.title,
    description: 'd',
    analysis: [],
    ...input.unit === undefined ? {} : { unit: input.unit },
  })
  if (!created.ok) throw new Error(`root creation failed: ${created.message}`)
  return created.value.id
}

/** note_mission then decompose_mission, the only legal prelude to a split. */
async function split(
  tree: MissionTree,
  nodeId: string,
  holder: string,
  children: readonly ChildSpec[],
): Promise<readonly string[]> {
  const noted = await tree.recordAnalysis(nodeId, holder, '这次为什么拆：缺一个前置事实')
  if (!noted.ok) throw new Error(`recordAnalysis failed: ${noted.code}`)
  const out = await tree.decompose(nodeId, holder, children)
  if (!out.ok) throw new Error(`decompose failed: ${out.code} ${out.message}`)
  return out.value.created
}

/** Every `running` node, across every tree, with the unit it holds. */
function running(tree: MissionTree): { id: string; unit: string | null; claimedBy: string | null }[] {
  return tree
    .trees()
    .flatMap((entry) => tree.nodesOf(entry.rootId))
    .filter((node) => node.status === 'running')
    .map((node) => ({ id: node.id, unit: node.unit, claimedBy: node.claimedBy }))
}

describe('one executor per unit', () => {
  it('① dispatches one of two same-unit siblings, then the other once the first is done', async () => {
    const { tree, engine } = makeWorld({ maxConcurrent: 4 })
    const rootId = await root(tree, { title: 'lane', unit: 'mission/packages/plugin/src/host.ts' })
    const dispatched = await tree.dispatch(rootId, 'mission-w1')
    expect(dispatched.ok).toBe(true)
    const children = await split(tree, rootId, 'mission-w1', [
      { title: 'a', description: 'd', context: ['why'] },
      { title: 'b', description: 'd', context: ['why'] },
    ])
    // The parent left `running`, so its scope is free again; the children inherited it.
    expect(tree.node(rootId)?.status).toBe('blocked')
    for (const id of children) expect(tree.node(id)?.unit).toBe('mission/packages/plugin/src/host.ts')

    // One pump, one worker: the sibling carries the same unit and waits.
    expect(await engine.pump()).toBe(1)
    const first = running(tree)
    expect(first).toHaveLength(1)
    expect(first[0]?.unit).toBe('mission/packages/plugin/src/host.ts')
    const waiting = children.filter((id) => tree.node(id)?.status === 'ready')
    expect(waiting).toHaveLength(1)

    // The holder finishes; the very next pass runs the sibling, never before.
    const held = first[0]
    expect(held?.claimedBy).not.toBeNull()
    const submitted = await tree.submitResult(held?.id ?? '', held?.claimedBy ?? '', 'done')
    expect(submitted.ok).toBe(true)
    expect(await engine.pump()).toBe(1)
    expect(running(tree)).toHaveLength(1)
    expect(running(tree)[0]?.id).toBe(waiting[0])
  })

  it('② runs two different units at the same time', async () => {
    const { tree, engine } = makeWorld({ maxConcurrent: 4 })
    const rootId = await root(tree, { title: 'lanes' })
    await tree.dispatch(rootId, 'mission-w1')
    await split(tree, rootId, 'mission-w1', [
      { title: 'a', description: 'd', context: ['why'], unit: 'pkg/a.ts' },
      { title: 'b', description: 'd', context: ['why'], unit: 'pkg/b.ts' },
    ])
    expect(await engine.pump()).toBe(2)
    expect(running(tree).map((node) => node.unit).sort()).toEqual(['pkg/a.ts', 'pkg/b.ts'])
  })

  it('③ a blocked parent holds no lease, so its same-unit children can run', async () => {
    const { tree } = makeWorld()
    const rootId = await root(tree, { title: 'parent', unit: 'pkg/x.ts' })
    await tree.dispatch(rootId, 'mission-w1')
    await split(tree, rootId, 'mission-w1', [
      { title: 'a', description: 'd', context: ['why'] },
    ])
    // The parent is blocked — not running — so nothing holds `pkg/x.ts` and the child is next.
    expect(running(tree)).toHaveLength(0)
    expect(tree.node(rootId)?.status).toBe('blocked')
    expect(tree.nextDispatchable()?.unit).toBe('pkg/x.ts')
  })

  it('④ a reclaim releases the unit for the next same-unit node', async () => {
    const { tree } = makeWorld()
    const first = await root(tree, { title: 'first', unit: 'pkg/x.ts' })
    const second = await root(tree, { title: 'second', unit: 'pkg/x.ts' })
    expect((await tree.dispatch(first, 'mission-w1')).ok).toBe(true)

    // Atomic refusal while the holder is running: the tree lock is what makes this exact.
    const refused = await tree.dispatch(second, 'mission-w2')
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.code).toBe('unit-busy')
    expect(tree.node(second)?.status).toBe('ready')

    // The holder goes away; the unit is free the moment it is no longer `running`.
    expect((await tree.reclaim(first, 'vanished')).ok).toBe(true)
    expect(tree.node(first)?.status).toBe('interrupted')
    expect((await tree.dispatch(second, 'mission-w2')).ok).toBe(true)
    expect(running(tree).map((node) => node.id)).toEqual([second])
  })

  it('⑤ an undeclared unit takes no lease and keeps today’s parallel behaviour', async () => {
    const { tree, engine } = makeWorld({ maxConcurrent: 3 })
    const ids = [
      await root(tree, { title: 'a' }),
      await root(tree, { title: 'b' }),
      await root(tree, { title: 'c' }),
    ]
    for (const id of ids) expect(tree.node(id)?.unit).toBeNull()
    expect(await engine.pump()).toBe(3)
    expect(running(tree)).toHaveLength(3)
  })

  it('⑥ a running node blocks the same unit in another tree (no double run across roots)', async () => {
    const { tree, engine } = makeWorld({ maxConcurrent: 5 })
    const first = await root(tree, { title: 'first', unit: 'pkg/x.ts' })
    const second = await root(tree, { title: 'second', unit: 'pkg/x.ts' })
    expect(await engine.pump()).toBe(1)
    expect(running(tree)).toHaveLength(1)
    const holder = running(tree)[0]
    expect(tree.node(second)?.status).toBe('ready')

    const submitted = await tree.submitResult(holder?.id ?? '', holder?.claimedBy ?? '', 'done')
    expect(submitted.ok).toBe(true)
    expect(await engine.pump()).toBe(1)
    expect(running(tree).map((node) => node.id)).toEqual([second])
    expect(tree.node(first)?.status).toBe('done')
  })
})

describe('durable compatibility', () => {
  it('⑦ reads a record written before `unit` existed as no lease', async () => {
    const source = makeWorld()
    const id = await root(source.tree, { title: 'legacy', unit: 'pkg/x.ts' })
    const stored = source.tree.node(id)
    if (stored === undefined) throw new Error('no node')
    // The shape an earlier build persisted: the field is ABSENT, not null.
    const legacy = { ...stored } as unknown as Record<string, unknown>
    delete legacy['unit']
    const documents = new Map<string, TreeState>([[
      id,
      { tree: { ...source.tree.treeOf(id)! }, nodes: new Map([[id, legacy as unknown as NodeRecord]]) },
    ]])

    let tick = 0
    const reopened = new MissionTree(
      {
        loadAll: () => Promise.resolve([...documents.values()]),
        put: (state) => {
          documents.set(state.tree.rootId, state)
          return Promise.resolve()
        },
        remove: (rootId) => {
          documents.delete(rootId)
          return Promise.resolve()
        },
      },
      {
        isAgentLive: (sessionId) => sessionId === 'owner',
        probeOwner: () => Promise.resolve({ kind: 'exists' }),
        spill: () => Promise.resolve(null),
        now: () => (tick += 1),
        newId: () => 'zzz00001',
      },
    )
    await reopened.open()
    expect(reopened.node(id)?.unit).toBeNull()
    // And it is an ordinary candidate: no lease, exactly as before the field existed.
    expect(reopened.nextDispatchable()?.id).toBe(id)
  })
})
