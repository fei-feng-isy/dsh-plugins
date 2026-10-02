/**
 * `weight`: the node's declared capacity share. Pinned here are the four rules that make it safe to
 * persist — default 1, clamping, NO inheritance from the parent, and a legacy record reading as 1 —
 * plus the round trip through the store.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENGINE_OPTIONS,
  DEFAULT_WEIGHT,
  MAX_WEIGHT,
  MissionEngine,
  MissionTree,
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

function makeTree(store: TreeStore): MissionTree {
  let sequence = 0
  return new MissionTree(store, {
    isAgentLive: () => true,
    probeOwner: () => Promise.resolve({ kind: 'exists' as const }),
    spill: () => Promise.resolve(null),
    now: () => 100,
    newId: () => `n${String(++sequence).padStart(4, '0')}`,
  })
}

function makeEngine(tree: MissionTree): MissionEngine {
  let sequence = 0
  return new MissionEngine(
    tree,
    {
      reserveClaimId: () => `mission-${String(++sequence)}`,
      releaseClaimId: () => undefined,
      startWorker: () => Promise.resolve(),
      interruptWorker: () => Promise.resolve(),
      notifyOwner: () => undefined,
    },
    {
      maxConcurrent: 4,
      capacity: 64,
      capacityWaitMs: DEFAULT_ENGINE_OPTIONS.capacityWaitMs,
      minFreeMemoryBytes: 0,
      staleMs: 60_000,
      roundMs: DEFAULT_ENGINE_OPTIONS.roundMs,
    },
  )
}

async function create(tree: MissionTree, weight?: number): Promise<NodeRecord> {
  const result = await tree.createRoot({
    ownerSessionId: 'owner',
    title: 'root',
    description: 'd',
    analysis: [],
    ...weight === undefined ? {} : { weight },
  })
  if (!result.ok) throw new Error(result.message)
  return result.value
}

describe('weight on a root', () => {
  it('defaults to 1 when nothing is declared', async () => {
    const node = await create(makeTree(memoryStore()))
    expect(node.weight).toBe(DEFAULT_WEIGHT)
  })

  it('clamps into [1, MAX_WEIGHT] and floors fractions', async () => {
    const tree = makeTree(memoryStore())
    expect((await create(tree, 3.7)).weight).toBe(3)
    expect((await create(tree, 0)).weight).toBe(1)
    expect((await create(tree, -4)).weight).toBe(1)
    expect((await create(tree, 9_999)).weight).toBe(MAX_WEIGHT)
  })

  it('survives a persistence round trip', async () => {
    const store = memoryStore()
    const created = await create(makeTree(store), 5)
    const reopened = makeTree(store)
    await reopened.open()
    expect(reopened.node(created.id)?.weight).toBe(5)
  })

  it('reads a record written before the field existed as 1', async () => {
    const store = memoryStore()
    const created = await create(makeTree(store), 5)
    const document = store.documents.get(created.id)
    expect(document).toBeDefined()
    // Simulate an older build's document: the field is simply absent.
    const legacyNode = { ...(document as TreeState).nodes.get(created.id) } as Record<string, unknown>
    delete legacyNode['weight']
    store.documents.set(created.id, {
      tree: (document as TreeState).tree,
      nodes: new Map([[created.id, legacyNode as unknown as NodeRecord]]),
    })
    const reopened = makeTree(store)
    await reopened.open()
    expect(reopened.node(created.id)?.weight).toBe(DEFAULT_WEIGHT)
  })

  it('reads a dirty persisted value as 1 rather than letting it through', async () => {
    const store = memoryStore()
    const created = await create(makeTree(store), 4)
    const document = store.documents.get(created.id) as TreeState
    const dirty = { ...document.nodes.get(created.id), weight: 'heavy' } as unknown as NodeRecord
    store.documents.set(created.id, { tree: document.tree, nodes: new Map([[created.id, dirty]]) })
    const reopened = makeTree(store)
    await reopened.open()
    expect(reopened.node(created.id)?.weight).toBe(DEFAULT_WEIGHT)
  })
})

describe('weight on decomposed children', () => {
  it('does not inherit the parent estimate, and keeps a reused node’s own weight', async () => {
    const tree = makeTree(memoryStore())
    const engine = makeEngine(tree)
    const parent = await create(tree, 8)
    await engine.pump()
    const claim = tree.node(parent.id)?.claimedBy
    expect(claim).toBeTruthy()
    await tree.recordAnalysis(parent.id, claim as string, 'split it')
    const split = await tree.decompose(parent.id, claim as string, [
      { title: 'no weight declared', description: 'd', context: [] },
      { title: 'declared heavy', description: 'd', context: [], weight: 6 },
    ])
    if (!split.ok) throw new Error(split.message)
    const [plain, heavy] = split.value.created
    // The parent declared 8; a child that says nothing is the ordinary slot, NOT 8.
    expect(tree.node(plain as string)?.weight).toBe(DEFAULT_WEIGHT)
    expect(tree.node(heavy as string)?.weight).toBe(6)

    // A spec repeated inside ONE decomposition reuses the node that call created; the reused node
    // keeps the weight it was created with (the reuse path must not rewrite it).
    const parent2 = await create(tree, 1)
    await engine.pump()
    const claim2 = tree.node(parent2.id)?.claimedBy as string
    await tree.recordAnalysis(parent2.id, claim2, 'reuse it')
    const reused = await tree.decompose(parent2.id, claim2, [
      { title: 'declared heavy', description: 'd', context: [], weight: 6 },
      { title: 'declared heavy', description: 'd', context: ['second reason'] },
    ])
    if (!reused.ok) throw new Error(reused.message)
    expect(reused.value.created).toHaveLength(1)
    expect(reused.value.reused).toEqual(reused.value.created)
    expect(tree.node(reused.value.created[0] as string)?.weight).toBe(6)
  })
})
