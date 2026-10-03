/**
 * The three mission timestamps: when a node was accepted, when it was FIRST dispatched, and when it
 * ended — plus the durations derived from them.
 *
 * Two properties are the point of the whole feature:
 *
 * - the clock is written at exactly the right STATE TRANSITION (`createdAt` at creation,
 *   `dispatchedAt` at the first transition into `running`, `endedAt` at the terminal transition), and
 *   a re-dispatch or a reclaim never moves an instant that has already been stamped;
 * - a record written before the fields existed reads as `null` — never `undefined` — because the
 *   state machine must be able to eat a BARE record from a store that never ran the zod schema.
 *
 * The clock is injected (`now`), so every instant below is an exact, asserted number rather than a
 * wall-clock observation.
 */
import { describe, expect, it } from 'vitest'
import {
  MissionTree,
  queueMs,
  runMs,
  totalMs,
  type NodeRecord,
  type TreeState,
  type TreeStore,
} from '../src/index.js'

/** An in-memory store that keeps the documents exactly as written. */
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

/** A tree over an injected, strictly increasing clock: every `now()` call is one more tick, so the
 *  instants a mutation stamps are exact and a test can assert them by value. */
function makeTree() {
  const store = memoryStore()
  let tick = 0
  let sequence = 0
  const tree = new MissionTree(store, {
    isAgentLive: () => false,
    probeOwner: () => Promise.resolve({ kind: 'exists' }),
    spill: () => Promise.resolve(null),
    now: () => (tick += 1),
    newId: () => `n${String(++sequence).padStart(4, '0')}`,
  })
  return { tree, store, ticks: () => tick }
}

async function rootOf(tree: MissionTree, title = 'Root mission'): Promise<string> {
  const created = await tree.createRoot({
    ownerSessionId: 'owner',
    title,
    description: 'Do the whole thing',
    analysis: [],
  })
  if (!created.ok) throw new Error(`root creation failed: ${created.message}`)
  return created.value.id
}

/** The blocking shape of an exhausted machine: one full slot already running, capacity 1. */
function fullMachine(): {
  capacity: number
  maxConcurrent: number
  runningCount: number
  runningWeight: number
  deferredSince: ReadonlyMap<string, number>
  agingMs: number
  now: number
} {
  return {
    capacity: 1,
    maxConcurrent: 1,
    runningCount: 1,
    runningWeight: 1,
    deferredSince: new Map<string, number>(),
    agingMs: 300_000,
    now: 0,
  }
}

describe('the timestamps are written at the state transitions', () => {
  it('accepts a node with no dispatch clock and no end clock', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    const node = tree.node(id)
    expect(node?.createdAt).toBe(1)
    expect(node?.dispatchedAt).toBeNull()
    expect(node?.endedAt).toBeNull()
  })

  it('stamps `dispatchedAt` on the first dispatch, and never moves it on a re-dispatch', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    const first = await tree.dispatch(id, 'mission-aaaa1111')
    if (!first.ok) throw new Error(`dispatch failed: ${first.message}`)
    // createRoot took tick 1; this dispatch is the second `now()` the mutation makes.
    expect(first.value.node.dispatchedAt).toBe(2)
    expect(first.value.node.endedAt).toBeNull()

    // A reclaim re-queues the node without ending it; a second dispatch is a LATER attempt, not the
    // first one, so the queue clock keeps the instant the mission really started.
    const reclaimed = await tree.reclaim(id, 'vanished')
    if (!reclaimed.ok) throw new Error(`reclaim failed: ${reclaimed.message}`)
    expect(reclaimed.value.dispatchedAt).toBe(2)
    expect(reclaimed.value.endedAt).toBeNull()

    const again = await tree.dispatch(id, 'mission-bbbb2222')
    if (!again.ok) throw new Error(`re-dispatch failed: ${again.message}`)
    expect(again.value.node.dispatchedAt).toBe(2)
    expect(again.value.node.attempts).toBe(2)
  })

  it('leaves a node the capacity gate skipped with `dispatchedAt === null`, then fills it', async () => {
    const { tree } = makeTree()
    const running = await rootOf(tree, 'already running')
    const queued = await rootOf(tree, 'still queued')
    // Occupy the whole (capacity-1) machine with a real running node: the gate re-reads the LIVE load
    // under the lock, so the policy's own count is deliberately not what makes this refuse.
    const occupied = await tree.dispatch(running, 'mission-aaaa1111')
    if (!occupied.ok) throw new Error(`dispatch failed: ${occupied.message}`)

    const busy = await tree.dispatch(queued, 'mission-bbbb2222', fullMachine())
    expect(busy.ok).toBe(false)
    // A capacity skip is queuing, not a dispatch: the record must not look like it ever ran.
    expect(tree.node(queued)?.dispatchedAt).toBeNull()
    expect(tree.node(queued)?.attempts).toBe(0)

    // Free the machine, then dispatch the queued node: the FIRST dispatch fills the instant.
    const freed = await tree.reclaim(running, 'vanished')
    if (!freed.ok) throw new Error(`reclaim failed: ${freed.message}`)
    const dispatched = await tree.dispatch(queued, 'mission-bbbb2222', fullMachine())
    if (!dispatched.ok) throw new Error(`dispatch failed: ${dispatched.message}`)
    expect(dispatched.value.node.dispatchedAt).not.toBeNull()
    expect(dispatched.value.node.dispatchedAt).toBe(dispatched.value.node.claimedAt)
  })

  it('stamps `endedAt` when a result is submitted, and keeps the dispatch clock', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    const dispatched = await tree.dispatch(id, 'mission-aaaa1111')
    if (!dispatched.ok) throw new Error(`dispatch failed: ${dispatched.message}`)
    const startedAt = dispatched.value.node.dispatchedAt

    const submitted = await tree.submitResult(id, 'mission-aaaa1111', 'done')
    if (!submitted.ok) throw new Error(`submit failed: ${submitted.message}`)
    expect(submitted.value.node.status).toBe('done')
    expect(submitted.value.node.dispatchedAt).toBe(startedAt)
    expect(submitted.value.node.endedAt).not.toBeNull()
  })

  it('stamps `endedAt` on a node cancelled before it ever ran, leaving `dispatchedAt` null', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    const cancelled = await tree.cancelTree(id, 'owner')
    if (!cancelled.ok) throw new Error(`cancel failed: ${cancelled.message}`)
    const node = tree.node(id)
    expect(node?.status).toBe('failed')
    expect(node?.dispatchedAt).toBeNull()
    expect(node?.endedAt).not.toBeNull()
  })

  it('stamps `endedAt` on a node that exhausts its failure budget without a result', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    // Five reclaims spend the execution budget; the fifth dispatch refuses by failing the node.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const dispatched = await tree.dispatch(id, `mission-aaaa${String(attempt).padStart(4, '0')}`)
      if (!dispatched.ok) throw new Error(`dispatch ${String(attempt)} failed: ${dispatched.message}`)
      const reclaimed = await tree.reclaim(id, 'vanished')
      if (!reclaimed.ok) throw new Error(`reclaim ${String(attempt)} failed: ${reclaimed.message}`)
    }
    const refused = await tree.dispatch(id, 'mission-ffff9999')
    expect(refused.ok).toBe(false)
    const node = tree.node(id)
    expect(node?.status).toBe('failed')
    expect(node?.endedAt).not.toBeNull()
    // It DID run before failing, so the start clock stays where the first dispatch put it.
    expect(node?.dispatchedAt).not.toBeNull()
  })
})

describe('the derived durations', () => {
  it('measures queue, run and total time from the three instants', () => {
    const node = { createdAt: 1_000, dispatchedAt: 1_600, endedAt: 4_600 }
    expect(queueMs(node)).toBe(600)
    expect(runMs(node)).toBe(3_000)
    expect(totalMs(node)).toBe(3_600)
  })

  it('answers `null` for a duration whose end is not recorded', () => {
    const queued = { createdAt: 1_000, dispatchedAt: null, endedAt: null }
    expect(queueMs(queued)).toBeNull()
    expect(runMs(queued)).toBeNull()
    expect(totalMs(queued)).toBeNull()

    const running = { createdAt: 1_000, dispatchedAt: 1_600, endedAt: null }
    expect(queueMs(running)).toBe(600)
    expect(runMs(running)).toBeNull()
    expect(totalMs(running)).toBeNull()

    // Cancelled before it ran: the wait is measured, the execution is not — there was none.
    const cancelled = { createdAt: 1_000, dispatchedAt: null, endedAt: 3_000 }
    expect(queueMs(cancelled)).toBeNull()
    expect(runMs(cancelled)).toBeNull()
    expect(totalMs(cancelled)).toBe(2_000)
  })

  it('never reports a negative duration when a clock ran backwards', () => {
    const skewed = { createdAt: 5_000, dispatchedAt: 1_000, endedAt: 500 }
    expect(queueMs(skewed)).toBe(0)
    expect(runMs(skewed)).toBe(0)
    expect(totalMs(skewed)).toBe(0)
  })
})

describe('a record written before the timestamps existed', () => {
  it('loads with `null`, not `undefined`, through a store that never ran the schema', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    // Strip both fields from the persisted document, exactly as a pre-timestamp build wrote it.
    const state = store.documents.get(id)
    if (state === undefined) throw new Error('the fixture persisted nothing')
    const bare = (state.nodes.get(id) ?? {}) as Record<string, unknown>
    delete bare['dispatchedAt']
    delete bare['endedAt']

    const reopened = new MissionTree(store, {
      isAgentLive: () => false,
      probeOwner: () => Promise.resolve({ kind: 'exists' }),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'unused',
    })
    await reopened.open()
    const node: NodeRecord | undefined = reopened.node(id)
    expect(node?.dispatchedAt).toBeNull()
    expect(node?.endedAt).toBeNull()
    // The state machine can compute over the record without producing NaN.
    expect(queueMs(node ?? { createdAt: 0, dispatchedAt: null, endedAt: null })).toBeNull()
    expect(totalMs(node ?? { createdAt: 0, dispatchedAt: null, endedAt: null })).toBeNull()
  })
})
