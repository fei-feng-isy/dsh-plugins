/**
 * The read projections (`src/projection.ts`) exercised against a REAL `MissionTree`, with NO service,
 * no context and no IO — the property that made them worth extracting out of `host.ts`.
 *
 * The tree is seeded through the store the way a restart does: deliberately BARE node records, which
 * is the durable shape core documents it must accept (`normalizeLoaded` fills every field added since
 * — the same reading the plugin's `domain_defaults_pin.spec.ts` holds field by field).
 */
import { describe, expect, it } from 'vitest'
import { MissionTree, type NodeRecord, type TreeState } from '@avantf/mission-core'
import { detailOf, treesForSession, workerLiveOf, workerReleasedOf, workerSessionIdOf } from '../src/projection.js'
import { ROW_CORRECTIONS_MAX } from '../src/wire.js'

const OWNER = 'session-owner'
const OTHER = 'session-other'

/** A bare durable record: only the fields the projection reads are spelled, the rest are defaults. */
function bareNode(fields: Record<string, unknown>): NodeRecord {
  return fields as unknown as NodeRecord
}

function seededState(input: {
  rootId: string
  ownerSessionId: string
  nodes: readonly NodeRecord[]
}): TreeState {
  return {
    tree: { rootId: input.rootId, ownerSessionId: input.ownerSessionId, createdAt: 1, closedAt: null, reportedAt: null },
    nodes: new Map(input.nodes.map((node) => [node.id, node])),
  }
}

/** A real tree opened over seeded states; nothing is materialized and nothing is written. */
async function seededTree(states: readonly TreeState[]): Promise<MissionTree> {
  const store = {
    loadAll: () => Promise.resolve([...states]),
    put: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  }
  const tree = new MissionTree(store, {
    isAgentLive: () => true,
    probeOwner: () => Promise.resolve({ kind: 'exists' as const }),
    spill: () => Promise.resolve(null),
    now: () => 1,
    newId: () => 'unused',
  })
  await tree.open()
  return tree
}

/** The two trees of the main fixture: one owned by OWNER (a running root plus one done child) and one
 *  owned by OTHER, so the session filter has something to exclude. */
async function mainTree(): Promise<MissionTree> {
  const root = bareNode({
    id: 'r1',
    rootId: 'r1',
    parentId: null,
    title: 'root',
    description: 'root description',
    context: ['because'],
    corrections: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
    status: 'running',
    attempts: 3,
    createdAt: 10,
    dispatchedAt: 11,
    endedAt: null,
    depth: 0,
    children: ['child1'],
    claimedBy: 'mission-live',
    executorSessionId: 'mission-live',
    executorReleasedAt: null,
    weight: 2,
    hasResult: false,
    result: null,
    resultRef: '/spill/root.txt',
    resultHint: 'cat it',
    analysisNotes: ['note-a'],
    analysisAttempt: 3,
  })
  const child = bareNode({
    id: 'child1',
    rootId: 'r1',
    parentId: 'r1',
    title: 'child',
    description: 'child description',
    context: [],
    corrections: [],
    status: 'done',
    attempts: 1,
    createdAt: 12,
    depth: 1,
    children: [],
    claimedBy: null,
    executorSessionId: 'mission-released',
    executorReleasedAt: 99,
    weight: 1,
    hasResult: true,
    result: 'child done',
    resultRef: '/spill/child.txt',
    resultHint: null,
  })
  const foreignRoot = bareNode({
    id: 'r9',
    rootId: 'r9',
    parentId: null,
    title: 'foreign',
    description: 'd',
    context: [],
    corrections: [],
    status: 'ready',
    createdAt: 20,
    depth: 0,
    children: [],
    executorSessionId: null,
    executorReleasedAt: null,
    hasResult: false,
  })
  return seededTree([
    seededState({ rootId: 'r1', ownerSessionId: OWNER, nodes: [root, child] }),
    seededState({ rootId: 'r9', ownerSessionId: OTHER, nodes: [foreignRoot] }),
  ])
}

describe('the worker-handle predicates (pure)', () => {
  it('reads the persisted handle, liveness and the release mark', () => {
    expect(workerSessionIdOf(bareNode({ executorSessionId: 'mission-a' }))).toBe('mission-a')
    expect(workerSessionIdOf(bareNode({ executorSessionId: '' }))).toBeNull()
    expect(workerSessionIdOf(bareNode({ executorSessionId: null }))).toBeNull()

    // Live needs ALL THREE: running, a claim, and the claim being the persisted handle.
    const live = { status: 'running', claimedBy: 'mission-a', executorSessionId: 'mission-a' }
    expect(workerLiveOf(bareNode(live))).toBe(true)
    expect(workerLiveOf(bareNode({ ...live, status: 'done' }))).toBe(false)
    expect(workerLiveOf(bareNode({ ...live, claimedBy: null }))).toBe(false)
    expect(workerLiveOf(bareNode({ ...live, claimedBy: 'mission-b' }))).toBe(false)

    expect(workerReleasedOf(bareNode({ executorReleasedAt: 5 }))).toBe(true)
    expect(workerReleasedOf(bareNode({ executorReleasedAt: null }))).toBe(false)
  })
})

describe('treesForSession', () => {
  it('returns one session’s trees only, newest tree first, and nothing without a session', async () => {
    const tree = await mainTree()
    expect(treesForSession(tree, undefined, () => null)).toEqual([])
    expect(treesForSession(tree, '', () => null)).toEqual([])
    expect(treesForSession(undefined, OWNER, () => null)).toEqual([])

    // `trees()` is insertion order; the projection reverses it, so the panel renders newest first.
    expect(treesForSession(tree, OWNER, () => null).map((view) => view.rootId)).toEqual(['r1'])
    expect(treesForSession(tree, OTHER, () => null).map((view) => view.rootId)).toEqual(['r9'])
    expect(treesForSession(tree, 'nobody', () => null)).toEqual([])
  })

  it('projects the row: COUNTED premises, capped corrections, worker handles and waitingFor', async () => {
    const tree = await mainTree()
    const [view] = treesForSession(tree, OWNER, (nodeId) => (nodeId === 'r1' ? { reason: 'unit', unit: 'scope-a' } : null))
    const root = view?.nodes.find((node) => node.id === 'r1')
    const child = view?.nodes.find((node) => node.id === 'child1')

    // The premise TEXTS never travel in the row; only the count does (see wire.ts's context rule).
    expect(root?.context).toEqual([])
    expect(root?.contextCount).toBe(1)
    expect(root?.corrections).toEqual(['c2', 'c3', 'c4', 'c5', 'c6'])
    expect(root?.corrections).toHaveLength(ROW_CORRECTIONS_MAX)
    expect(root?.correctionCount).toBe(6)
    expect(root?.waitingFor).toEqual({ reason: 'unit', unit: 'scope-a' })
    expect(root?.workerSessionId).toBe('mission-live')
    expect(root?.workerLive).toBe(true)
    expect(root?.workerReleased).toBe(false)

    expect(child?.context).toEqual([])
    expect(child?.contextCount).toBe(0)
    expect(child?.workerSessionId).toBe('mission-released')
    expect(child?.workerLive).toBe(false)
    expect(child?.workerReleased).toBe(true)
    expect(child?.waitingFor).toBeNull()
    expect(child?.resultRef).toBe('/spill/child.txt')
  })
})

describe('detailOf', () => {
  const deps = (overrides: Partial<{ ownedBy: (node: NodeRecord, sessionId: string | undefined) => boolean }> = {}) => ({
    ownedBy: (node: NodeRecord, sessionId: string | undefined) => node.rootId === 'r1' && sessionId === OWNER,
    waitingForOf: (nodeId: string) => (nodeId === 'r1' ? { reason: 'slot' as const } : null),
    ...overrides,
  })

  it('refuses a missing engine, a missing node and another session’s node — in that order', async () => {
    const tree = await mainTree()
    expect(detailOf(undefined, OWNER, 'r1', deps())).toEqual({ children: [], error: '任务引擎尚未启动' })
    expect(detailOf(tree, OWNER, 'nope', deps())).toEqual({ children: [], error: '任务 nope 不存在' })
    expect(detailOf(tree, OWNER, 'r1', deps({ ownedBy: () => false }))).toEqual({ children: [], error: '这个任务属于别的会话' })
    expect(detailOf(tree, OTHER, 'r1', deps())).toEqual({ children: [], error: '这个任务属于别的会话' })
  })

  it('projects the node and its children, with spilled results joined to their hint', async () => {
    const tree = await mainTree()
    const outcome = detailOf(tree, OWNER, 'r1', deps())
    expect(outcome.error).toBeUndefined()
    expect(outcome.node).toMatchObject({
      id: 'r1',
      rootId: 'r1',
      title: 'root',
      description: 'root description',
      context: ['because'],
      corrections: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
      analysisNotes: ['note-a'],
      analysisAttempt: 3,
      status: 'running',
      attempts: 3,
      depth: 0,
      createdAt: 10,
      dispatchedAt: 11,
      endedAt: null,
      result: null,
      // The whole locator, hint included — a pointer nobody can follow is not a pointer.
      resultPointer: '/spill/root.txt — cat it',
      workerSessionId: 'mission-live',
      workerLive: true,
      workerReleased: false,
      weight: 2,
      waitingFor: { reason: 'slot' },
    })
    expect(outcome.children).toEqual([{
      id: 'child1',
      title: 'child',
      status: 'done',
      result: 'child done',
      resultPointer: '/spill/child.txt',
    }])
  })
})
