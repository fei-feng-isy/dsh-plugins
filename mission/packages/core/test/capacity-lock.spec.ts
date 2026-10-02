/**
 * The capacity gate re-checked UNDER the tree lock.
 *
 * `planDispatch` decides admission from a snapshot taken OUTSIDE the lock, so two pumps can each see
 * an empty machine and both bind (`claimedAt` seconds apart, the second while the first still runs).
 * The fix is the same shape the unit lease has always had: re-run the arithmetic against the LIVE
 * load inside the transition into `running` (`MissionTree.dispatch` / `adoptParked` /
 * `adoptContinuation`), through the ONE shared judgement the plan itself uses.
 *
 * What these cases pin down:
 * ① a second pump holding a stale policy is refused `capacity-busy`;
 * ② the exclusive `weight > capacity` rule holds under the lock too;
 * ③ the ordinary plan-path deferral is unchanged (no double accounting);
 * ④ a lock refusal charges NOTHING — no `attempts`/`failures`/`spawnFailures`/`stalls`, no cooldown;
 * ⑤ `waitingFor` and the deferral log are right on BOTH paths, and a refusal is never reported as a
 *    dispatch failure;
 * ⑥ the unit lease stays the first refusal and the two resource checks share one under-lock call site.
 *
 * Everything is driven by an injected clock and an in-memory store, so no test waits on wall time.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENGINE_OPTIONS,
  MissionEngine,
  MissionTree,
  type CapacityPolicy,
  type DispatchDeferral,
  type NodeRecord,
  type TreeState,
  type TreeStore,
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

/** A tree plus an engine, with capacity, clock and reporting all fixed by the test. `onReserve` is
 *  the seam that lets a case interleave a competing binding between the engine's plan and its own
 *  lock-held dispatch (the microtask window `withLock` opens). */
function makeWorld(options: {
  capacity: number
  maxConcurrent?: number
  capacityWaitMs?: number
  clock?: () => number
  onReserve?: () => void
}) {
  const store = memoryStore()
  let sequence = 0
  let tick = 1_000
  const now = options.clock ?? (() => (tick += 1_000))
  const started: string[] = []
  const claimsByNode = new Map<string, string[]>()
  const deferred: DispatchDeferral[] = []
  const dispatchFailures: { nodeId: string; error: unknown }[] = []
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
      reserveClaimId: () => {
        options.onReserve?.()
        return `mission-${String(++sequence)}`
      },
      releaseClaimId: () => undefined,
      startWorker: ({ node, claimId }) => {
        started.push(claimId)
        const held = claimsByNode.get(node.id) ?? []
        held.push(claimId)
        claimsByNode.set(node.id, held)
        return Promise.resolve()
      },
      interruptWorker: () => Promise.resolve(),
      notifyOwner: () => undefined,
      notifyDeferred: (info) => deferred.push(info),
      reportDispatchFailure: (nodeId, error) => dispatchFailures.push({ nodeId, error }),
    },
    {
      maxConcurrent: options.maxConcurrent ?? 8,
      capacity: options.capacity,
      capacityWaitMs: options.capacityWaitMs ?? DEFAULT_ENGINE_OPTIONS.capacityWaitMs,
      minFreeMemoryBytes: 0,
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
    dispatchFailures,
    now,
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

/** The policy ONE pump builds from the load IT can see — a snapshot, exactly like the engine's. Two
 *  pumps started before either binds share this stale view of an empty machine. */
function snapshot(tree: MissionTree, capacity: number, maxConcurrent = 8, now = 0): CapacityPolicy {
  const load = tree.runningLoad()
  return {
    capacity,
    maxConcurrent,
    runningCount: load.count,
    runningWeight: load.weight,
    deferredSince: new Map(),
    agingMs: 60_000,
    now,
  }
}

/** Every budget and clock a DEFERRAL must leave alone. */
function expectUntouched(node: NodeRecord): void {
  expect(node.status).toBe('ready')
  expect(node.attempts).toBe(0)
  expect(node.failures).toBe(0)
  expect(node.spawnFailures).toBe(0)
  expect(node.stalls).toBe(0)
  expect(node.claimedAt).toBe(0)
  expect(node.claimedBy).toBeNull()
}

describe('capacity re-checked under the tree lock', () => {
  it('① refuses the second of two pumps that each planned against the same stale snapshot', async () => {
    const world = makeWorld({ capacity: 2 })
    const heavy = await root(world.tree, 'heavy', { weight: 2 })
    const light = await root(world.tree, 'light', { weight: 1 })
    // The snapshot both pumps see: nothing running yet.
    const stale = snapshot(world.tree, 2)
    expect(stale.runningCount).toBe(0)
    expect(stale.runningWeight).toBe(0)

    // Pump 1 plans and selects the heavy root; pump 2 plans with that node already spoken for and
    // selects the light one — from the SAME stale, empty-machine snapshot.
    expect(world.tree.planDispatch(new Set(), stale).selected?.id).toBe(heavy)
    expect(world.tree.planDispatch(new Set([heavy]), stale).selected?.id).toBe(light)

    expect((await world.tree.dispatch(heavy, 'claim-heavy', stale)).ok).toBe(true)
    // Only the lock-held recheck can stop this: the policy still claims the machine is empty.
    const refused = await world.tree.dispatch(light, 'claim-light', stale)
    expect(refused.ok).toBe(false)
    expect(refused.ok ? '' : refused.code).toBe('capacity-busy')
    expect(node(world.tree, heavy).status).toBe('running')
    expectUntouched(node(world.tree, light))
  })

  it('② keeps a heavier-than-the-machine node out while anything else runs, even from a stale snapshot', async () => {
    const world = makeWorld({ capacity: 4 })
    const ordinary = await root(world.tree, 'ordinary', { weight: 1 })
    const whole = await root(world.tree, 'whole-machine', { weight: 6 })
    const stale = snapshot(world.tree, 4)
    expect((await world.tree.dispatch(ordinary, 'claim-ordinary', stale)).ok).toBe(true)

    // Exclusive means "only while NOTHING is running"; the stale snapshot says `runningCount` is 0.
    const refused = await world.tree.dispatch(whole, 'claim-whole', stale)
    expect(refused.ok ? '' : refused.code).toBe('capacity-busy')
    expectUntouched(node(world.tree, whole))
  })

  it('③ admits the exclusive node the moment the machine is empty (the rule is not "always refuse")', async () => {
    const world = makeWorld({ capacity: 4 })
    const ordinary = await root(world.tree, 'ordinary', { weight: 1 })
    const whole = await root(world.tree, 'whole-machine', { weight: 6 })
    const stale = snapshot(world.tree, 4)
    await world.tree.dispatch(ordinary, 'claim-ordinary', stale)
    expect((await world.tree.dispatch(whole, 'claim-whole', stale)).ok).toBe(false)
    expect((await world.tree.submitResult(ordinary, 'claim-ordinary', 'done')).ok).toBe(true)

    expect((await world.tree.dispatch(whole, 'claim-whole', stale)).ok).toBe(true)
    expect(node(world.tree, whole).status).toBe('running')
  })

  it('③ is an idempotent no-op for a node the plan itself already deferred', async () => {
    const world = makeWorld({ capacity: 2 })
    const running = await root(world.tree, 'running', { weight: 2 })
    const queued = await root(world.tree, 'queued', { weight: 1 })
    await world.tree.dispatch(running, 'claim-running', snapshot(world.tree, 2))

    const fresh = snapshot(world.tree, 2)
    const plan = world.tree.planDispatch(new Set(), fresh)
    expect(plan.selected).toBeUndefined()
    expect(plan.deferred.map((entry) => entry.node.id)).toContain(queued)

    // Dispatching a plan-deferred node anyway changes nothing on either attempt: the same refusal,
    // the same untouched record. The recheck is a pure read of live state.
    for (const claim of ['claim-q1', 'claim-q2']) {
      const refused = await world.tree.dispatch(queued, claim, fresh)
      expect(refused.ok ? '' : refused.code).toBe('capacity-busy')
      expectUntouched(node(world.tree, queued))
    }
  })
})

describe('the plan path is unchanged', () => {
  it('④ still selects a fitting candidate, defers what does not fit, and never double-charges', async () => {
    const world = makeWorld({ capacity: 3 })
    const heavy = await root(world.tree, 'heavy', { weight: 3 })
    const light = await root(world.tree, 'light', { weight: 1 })
    expect(await world.engine.pump()).toBe(1)
    expect(world.starts(heavy)).toBe(1)
    expect(world.starts(light)).toBe(0)
    expectUntouched(node(world.tree, light))

    // A second pass re-derives the deferral and charges nothing a second time.
    expect(await world.engine.pump()).toBe(0)
    expectUntouched(node(world.tree, light))
    expect(world.engine.waitingFor(light)).toEqual({
      reason: 'capacity',
      resource: 'cpu',
      needed: 1,
      available: 0,
    })
    expect(world.deferred.some((info) => info.nodeId === light && info.waitingFor.reason === 'capacity')).toBe(true)
  })
})

describe('a lock refusal is a deferral, never a failure', () => {
  it('⑤ touches no budget, arms no cooldown and lets the node go out at once when the machine drains', async () => {
    const world = makeWorld({ capacity: 2 })
    const heavy = await root(world.tree, 'heavy', { weight: 2 })
    const light = await root(world.tree, 'light', { weight: 1 })
    const stale = snapshot(world.tree, 2)
    await world.tree.dispatch(heavy, 'claim-heavy', stale)

    const refused = await world.tree.dispatch(light, 'claim-light', stale)
    expect(refused.ok ? '' : refused.code).toBe('capacity-busy')
    expectUntouched(node(world.tree, light))

    // No cooldown was armed (claimedAt is still 0), so the very next dispatch after the drain runs.
    expect((await world.tree.submitResult(heavy, 'claim-heavy', 'done')).ok).toBe(true)
    expect((await world.tree.dispatch(light, 'claim-light', snapshot(world.tree, 2))).ok).toBe(true)
    expect(node(world.tree, light).status).toBe('running')
  })
})

describe('waitingFor and the deferral log on both paths', () => {
  it('⑥ publishes the plan reason for a node the plan itself defers', async () => {
    const world = makeWorld({ capacity: 2 })
    const running = await root(world.tree, 'running', { weight: 2 })
    const queued = await root(world.tree, 'queued', { weight: 1 })
    await world.engine.pump()
    expect(world.starts(running)).toBe(1)
    expect(world.engine.waitingFor(queued)).toEqual({
      reason: 'capacity',
      resource: 'cpu',
      needed: 1,
      available: 0,
    })
    expect(world.deferred.some((info) => info.nodeId === queued)).toBe(true)
  })

  it('⑥ publishes it through the plan path when the LOCK recheck refuses inside a pump', async () => {
    let side: (() => void) | undefined
    const world = makeWorld({ capacity: 2, onReserve: () => side?.() })
    const light = await root(world.tree, 'light', { weight: 1 })
    const heavy = await root(world.tree, 'heavy', { weight: 2 })

    // Between the engine's plan (which selected `light` from an empty machine) and its own lock-held
    // dispatch, reserve a second worker: `withLock` queues it first, so `heavy` binds before `light`
    // is rechecked. Only the under-lock capacity recheck can refuse `light`.
    let fired = false
    side = () => {
      if (fired) return
      fired = true
      void world.tree.dispatch(heavy, 'side-claim')
    }

    expect(await world.engine.pump()).toBe(0)
    expect(fired).toBe(true)
    expect(world.starts(light)).toBe(0)
    expectUntouched(node(world.tree, light))
    // The refusal is handed back to the plan, so the ordinary projection classifies and ages it.
    expect(world.engine.waitingFor(light)).toEqual({
      reason: 'capacity',
      resource: 'cpu',
      needed: 1,
      available: 0,
    })
    expect(world.deferred.some((info) => info.nodeId === light && info.waitingFor.reason === 'capacity')).toBe(true)
    // A capacity deferral is never a dispatch failure.
    expect(world.dispatchFailures).toEqual([])
  })
})

describe('the unit lease and the capacity gate share one under-lock call site', () => {
  it('⑦ reports a held unit first, and refuses capacity for an undeclared-unit candidate', async () => {
    const world = makeWorld({ capacity: 2 })
    const holder = await root(world.tree, 'holder', { weight: 1, unit: 'pkg/x.ts' })
    const waiter = await root(world.tree, 'waiter', { weight: 1, unit: 'pkg/x.ts' })
    const whole = await root(world.tree, 'whole', { weight: 10 })
    const stale = snapshot(world.tree, 2)
    expect((await world.tree.dispatch(holder, 'claim-holder', stale)).ok).toBe(true)

    // The lease is the FIRST refusal — a scope conflict is named as such, not as capacity.
    const unitRefused = await world.tree.dispatch(waiter, 'claim-waiter', stale)
    expect(unitRefused.ok ? '' : unitRefused.code).toBe('unit-busy')
    expectUntouched(node(world.tree, waiter))

    // A candidate with no unit reaches the capacity half of the same call site.
    const capacityRefused = await world.tree.dispatch(whole, 'claim-whole', stale)
    expect(capacityRefused.ok ? '' : capacityRefused.code).toBe('capacity-busy')
    expectUntouched(node(world.tree, whole))
  })
})
