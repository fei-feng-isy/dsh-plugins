/**
 * The capacity dispatch gate: weight accounting, work-conserving filling, aging into a reservation,
 * the exclusive "whole machine" case, the free-memory floor, and the `waitingFor` projection.
 *
 * The whole point of these cases is the discipline: being skipped by an admission gate is QUEUING,
 * never refusal. Nothing here charges `attempts`/`failures`/`spawnFailures`, sets a cooldown or
 * records a stall, and every deferral is undone by the next completion. Everything is driven by an
 * injected clock and an injected probe, so no test waits on wall time or on this machine's RAM.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENGINE_OPTIONS,
  MissionEngine,
  MissionTree,
  type DispatchDeferral,
  type NodeRecord,
  type ResourceProbe,
  type TreeState,
  type TreeStore,
  type WaitingFor,
} from '../src/index.js'

function memoryStore(): TreeStore {
  const documents = new Map<string, TreeState>()
  return {
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

/** A tree, an engine and a worker pool whose capacity, clock, probe and aging window are all fixed
 *  by the test. `started` counts worker starts per node, so "dispatched exactly once" is observable. */
function makeWorld(options: {
  capacity: number
  maxConcurrent?: number
  capacityWaitMs?: number
  minFreeMemoryBytes?: number
  probe?: ResourceProbe
  clock?: () => number
}) {
  const store = memoryStore()
  let sequence = 0
  let tick = 1_000
  const now = options.clock ?? (() => (tick += 1_000))
  const started: string[] = []
  const claimsByNode = new Map<string, string[]>()
  /** What each node's start was TOLD it waited for capacity — the fact the prompt renders. */
  const waits = new Map<string, number>()
  const deferred: DispatchDeferral[] = []
  const tree = new MissionTree(store, {
    isAgentLive: (sessionId) => sessionId === 'owner' || started.includes(sessionId),
    probeOwner: () => Promise.resolve({ kind: 'exists' as const }),
    spill: () => Promise.resolve(null),
    now,
    newId: () => `n${String(++sequence).padStart(4, '0')}`,
  })
  const engine = new MissionEngine(
    tree,
    {
      reserveClaimId: () => `mission-${String(++sequence)}`,
      releaseClaimId: () => undefined,
      startWorker: ({ node, claimId, waitedMs }) => {
        started.push(claimId)
        if (waitedMs !== undefined) waits.set(node.id, waitedMs)
        const held = claimsByNode.get(node.id) ?? []
        held.push(claimId)
        claimsByNode.set(node.id, held)
        return Promise.resolve()
      },
      interruptWorker: () => Promise.resolve(),
      notifyOwner: () => undefined,
      notifyDeferred: (info) => deferred.push(info),
    },
    {
      maxConcurrent: options.maxConcurrent ?? 8,
      capacity: options.capacity,
      capacityWaitMs: options.capacityWaitMs ?? DEFAULT_ENGINE_OPTIONS.capacityWaitMs,
      minFreeMemoryBytes: options.minFreeMemoryBytes ?? 0,
      ...options.probe === undefined ? {} : { probe: options.probe },
      staleMs: 60_000,
      roundMs: DEFAULT_ENGINE_OPTIONS.roundMs,
      now,
    },
  )
  return {
    tree,
    engine,
    started,
    claimsByNode,
    deferred,
    waits,
    now,
    /** How many times a node's worker was STARTED — "dispatched exactly once" made observable. */
    starts: (nodeId: string): number => claimsByNode.get(nodeId)?.length ?? 0,
  }
}

async function root(
  tree: MissionTree,
  title: string,
  input: { weight?: number; unit?: string | null } = {},
): Promise<string> {
  const created = await tree.createRoot({
    ownerSessionId: 'owner',
    title,
    description: 'd',
    analysis: [],
    ...input.weight === undefined ? {} : { weight: input.weight },
    ...input.unit === undefined ? {} : { unit: input.unit },
  })
  if (!created.ok) throw new Error(`root failed: ${created.message}`)
  return created.value.id
}

function node(tree: MissionTree, id: string): NodeRecord {
  const found = tree.node(id)
  if (found === undefined) throw new Error(`node ${id} missing`)
  return found
}

/** Every budget a skipped dispatch must NOT touch. */
function expectUntouched(node: NodeRecord): void {
  expect(node.attempts).toBe(0)
  expect(node.failures).toBe(0)
  expect(node.spawnFailures).toBe(0)
  expect(node.stalls).toBe(0)
  expect(node.status).toBe('ready')
}

describe('capacity gate', () => {
  it('dispatches while the running weight fits and skips — without charging — what does not', async () => {
    const world = makeWorld({ capacity: 3 })
    const heavy = await root(world.tree, 'heavy', { weight: 3 })
    const light = await root(world.tree, 'light', { weight: 1 })

    expect(await world.engine.pump()).toBe(1)
    // The heavy root was dispatched alone: it fills capacity 3.
    expect(world.starts(heavy)).toBe(1)
    expect(node(world.tree, heavy).attempts).toBe(1)
    // The light one is QUEUED, not refused: every budget untouched, still dispatchable.
    expectUntouched(node(world.tree, light))
    expect(world.engine.waitingFor(light)).toEqual({
      reason: 'capacity',
      resource: 'cpu',
      needed: 1,
      available: 0,
    })
  })

  it('resumes dispatching the queued node as soon as the load drops (no separate acceptance)', async () => {
    const world = makeWorld({ capacity: 2 })
    const first = await root(world.tree, 'first', { weight: 2 })
    const second = await root(world.tree, 'second', { weight: 2 })
    await world.engine.pump()
    expect(world.starts(first)).toBe(1)
    expectUntouched(node(world.tree, second))

    // The running node submits: capacity is free again on this very pump.
    const claim = world.claimsByNode.get(first)?.[0]
    expect(claim).toBeDefined()
    await world.tree.submitResult(first, claim as string, 'done')
    expect(await world.engine.pump()).toBe(1)
    expect(world.starts(second)).toBe(1)
    expect(node(world.tree, second).attempts).toBe(1)
  })

  it('is work-conserving: a heavy head that does not fit does not idle capacity a light one can use', async () => {
    const world = makeWorld({ capacity: 4 })
    const running = await root(world.tree, 'running', { weight: 2 })
    const heavy = await root(world.tree, 'heavy', { weight: 3 })
    const light = await root(world.tree, 'light', { weight: 1 })
    await world.engine.pump()
    expect(world.starts(running)).toBe(1)
    // running(2) + heavy(3) = 5 > 4, so the heavy head is skipped and the light one behind it runs.
    expect(world.starts(heavy)).toBe(0)
    expect(world.starts(light)).toBe(1)
    expectUntouched(node(world.tree, heavy))
    expect(world.starts(light)).toBe(1)
  })

  it('caps the NUMBER of units through maxConcurrent even while capacity has room', async () => {
    const world = makeWorld({ capacity: 8, maxConcurrent: 1 })
    const first = await root(world.tree, 'first', { weight: 1 })
    const second = await root(world.tree, 'second', { weight: 1 })
    await world.engine.pump()
    expect(world.starts(first)).toBe(1)
    expect(world.engine.waitingFor(second)).toEqual({ reason: 'slot', needed: 1, available: 0 })
  })

  it('reports a held unit as the wait reason, without aging it toward a capacity reservation', async () => {
    const world = makeWorld({ capacity: 4, capacityWaitMs: 1_000 })
    const holder = await root(world.tree, 'holder', { weight: 1, unit: 'pkg/x.ts' })
    const waiter = await root(world.tree, 'waiter', { weight: 1, unit: 'pkg/x.ts' })
    await world.engine.pump()
    expect(world.starts(holder)).toBe(1)
    // Long past the aging window, still a unit wait: it must never reserve the machine.
    for (let step = 0; step < 20; step += 1) await world.engine.pump()
    expect(world.engine.waitingFor(waiter)).toEqual({ reason: 'unit', unit: 'pkg/x.ts' })
    expectUntouched(node(world.tree, waiter))
    expect(world.starts(waiter)).toBe(0)
  })
})

describe('aging into a reservation', () => {
  it('stops admitting new nodes once the wait passes the threshold, then runs the reserved node', async () => {
    let clock = 0
    const world = makeWorld({ capacity: 2, capacityWaitMs: 5_000, clock: () => clock })
    const running = await root(world.tree, 'running', { weight: 2 })
    const reserved = await root(world.tree, 'reserved', { weight: 2 })
    await world.engine.pump()
    expect(world.starts(running)).toBe(1)
    // The first deferral starts the clock.
    clock += 1_000
    await world.engine.pump()
    expect(world.starts(reserved)).toBe(0)

    // Past the threshold: the deferred node reserves the machine. A NEW light node that would
    // happily fit beside `running` must NOT be admitted.
    clock += 5_000
    const latecomer = await root(world.tree, 'latecomer', { weight: 1 })
    expect(await world.engine.pump()).toBe(0)
    expect(world.starts(latecomer)).toBe(0)
    expectUntouched(node(world.tree, latecomer))
    expect(world.deferred.some((info) => info.nodeId === reserved && info.reserved)).toBe(true)

    // Drain the machine: the reserved node is dispatched, exactly once.
    const claim = world.claimsByNode.get(running)?.[0] as string
    await world.tree.submitResult(running, claim, 'done')
    expect(await world.engine.pump()).toBe(1)
    expect(world.starts(reserved)).toBe(1)
    // A second pass must not double-run it.
    await world.engine.pump()
    expect(world.starts(reserved)).toBe(1)
    // And the latecomer is now admissible behind it (weight 2 + 1 > 2, so it waits for its turn).
    expectUntouched(node(world.tree, latecomer))
  })

  it('hands the dispatch the wait it served, read from the same aging clock the queue marker uses', async () => {
    // ⑦ The prompt's "it queued for N" must come from the engine's own bookkeeping, not a second
    // stopwatch: the start is told exactly the age of the entry `waitingFor` is built from.
    let clock = 0
    const world = makeWorld({ capacity: 1, capacityWaitMs: 60_000, clock: () => clock })
    const running = await root(world.tree, 'running', { weight: 1 })
    await world.engine.pump()
    expect(world.starts(running)).toBe(1)
    // It never waited, so its dispatch is told nothing (0 = no queue line in the prompt).
    expect(world.waits.get(running)).toBe(0)

    const queued = await root(world.tree, 'queued', { weight: 1 })
    clock += 1_000
    await world.engine.pump()
    // The first capacity deferral starts the clock at this instant.
    expect(world.starts(queued)).toBe(0)

    clock += 122_000
    const claim = world.claimsByNode.get(running)?.[0] as string
    await world.tree.submitResult(running, claim, 'done')
    clock += 1_000
    expect(await world.engine.pump()).toBe(1)
    expect(world.starts(queued)).toBe(1)
    // 124_000 − 1_000: the whole time the gate held it, as the same clock measured it.
    expect(world.waits.get(queued)).toBe(123_000)
  })

  it('serves the oldest reservation first when several aged node wait', async () => {    let clock = 0
    const world = makeWorld({ capacity: 1, capacityWaitMs: 5_000, clock: () => clock })
    const running = await root(world.tree, 'running', { weight: 1 })
    await world.engine.pump()
    expect(world.starts(running)).toBe(1)
    const first = await root(world.tree, 'first-waiter', { weight: 1 })
    clock += 1_000
    await world.engine.pump()
    const second = await root(world.tree, 'second-waiter', { weight: 1 })
    clock += 1_000
    await world.engine.pump()

    clock += 10_000
    await world.engine.pump()
    const claim = world.claimsByNode.get(running)?.[0] as string
    await world.tree.submitResult(running, claim, 'done')
    await world.engine.pump()
    // The older waiter got the machine; the newer one still waits.
    expect(world.starts(first)).toBe(1)
    expect(world.starts(second)).toBe(0)
  })

  it('dispatches a node heavier than the whole machine only when nothing else is running', async () => {
    const world = makeWorld({ capacity: 2 })
    const ordinary = await root(world.tree, 'ordinary', { weight: 1 })
    const whole = await root(world.tree, 'whole-machine', { weight: 5 })
    await world.engine.pump()
    expect(world.starts(ordinary)).toBe(1)
    // Heavier than capacity can never fit beside anything, and it does not wedge the queue.
    expect(world.starts(whole)).toBe(0)
    expectUntouched(node(world.tree, whole))

    const claim = world.claimsByNode.get(ordinary)?.[0] as string
    await world.tree.submitResult(ordinary, claim, 'done')
    expect(await world.engine.pump()).toBe(1)
    expect(world.starts(whole)).toBe(1)
  })
})

describe('free-memory floor', () => {
  it('defers dispatch below the floor instead of refusing it, and resumes when the floor clears', async () => {
    let available = 100 * 1024 * 1024
    const probe: ResourceProbe = {
      parallelism: () => 8,
      memoryBudget: () => available,
      pressure: () => null,
    }
    const world = makeWorld({ capacity: 8, minFreeMemoryBytes: 256 * 1024 * 1024, probe })
    const id = await root(world.tree, 'waiting on memory', { weight: 1 })
    expect(await world.engine.pump()).toBe(0)
    expectUntouched(node(world.tree, id))
    expect(world.engine.waitingFor(id)).toEqual({
      reason: 'capacity',
      resource: 'memory',
      needed: 256 * 1024 * 1024,
      available: 100 * 1024 * 1024,
    })

    available = 1024 * 1024 * 1024
    expect(await world.engine.pump()).toBe(1)
    expect(world.starts(id)).toBe(1)
  })

  it('reads a null memory signal as "cannot confirm the floor" and stays conservative', async () => {
    const probe: ResourceProbe = {
      parallelism: () => 8,
      memoryBudget: () => null,
      pressure: () => null,
    }
    const world = makeWorld({ capacity: 8, minFreeMemoryBytes: 256 * 1024 * 1024, probe })
    const id = await root(world.tree, 'unknown memory', { weight: 1 })
    expect(await world.engine.pump()).toBe(0)
    expectUntouched(node(world.tree, id))
    expect(world.engine.waitingFor(id)).toEqual({ reason: 'capacity', resource: 'memory' })
  })

  it('leaves the gate inactive when the probed port has no memoryBudget implementation', async () => {
    const probe: ResourceProbe = {
      parallelism: () => 8,
      pressure: () => null,
    }
    const world = makeWorld({ capacity: 8, minFreeMemoryBytes: 256 * 1024 * 1024, probe })
    const id = await root(world.tree, 'no signal port', { weight: 1 })
    expect(await world.engine.pump()).toBe(1)
    expect(world.starts(id)).toBe(1)
  })
})

describe('waitingFor projection', () => {
  it('is null for a running node and carries the numbers when it has them', async () => {
    const world = makeWorld({ capacity: 4 })
    const running = await root(world.tree, 'running', { weight: 3 })
    const queued = await root(world.tree, 'queued', { weight: 2 })
    await world.engine.pump()
    expect(world.engine.waitingFor(running)).toBeNull()
    const waiting: WaitingFor | null = world.engine.waitingFor(queued)
    expect(waiting).toEqual({ reason: 'capacity', resource: 'cpu', needed: 2, available: 1 })
  })

  it('exposes the capacity the engine gates on for diagnostics', async () => {
    const world = makeWorld({ capacity: 7, maxConcurrent: 3 })
    await root(world.tree, 'one', { weight: 2 })
    await world.engine.pump()
    expect(world.engine.capacity()).toEqual({
      capacity: 7,
      maxConcurrent: 3,
      runningCount: 1,
      runningWeight: 2,
    })
  })
})
