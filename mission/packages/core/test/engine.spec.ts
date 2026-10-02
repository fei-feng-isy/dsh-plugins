/**
 * The dispatch loop: capacity, reclamation and owner notification.
 *
 * The engine is exercised with a stubbed worker starter, so these are the
 * decisions it makes — how many workers it starts, which bindings it reclaims,
 * whom it wakes — with no harness and no model.
 */
import { describe, expect, it } from 'vitest'
import {
  CAPACITY,
  CAPACITY_CEILING,
  DEFAULT_ENGINE_OPTIONS,
  MissionEngine,
  MissionTree,
  isTroubledNode,
  type HungReport,
  type ResourceProbe,
  type ResumeOutcome,
  type StallReport,
  type TreeState,
  type TreeStore,
} from '../src/index.js'

/** Engine options that inject the OPEN capacity gate (the pre-capacity behaviour), for the literal
 *  constructions in this file that are not about the capacity gate itself. */
const OPEN_GATE = {
  capacity: CAPACITY_CEILING,
  capacityWaitMs: DEFAULT_ENGINE_OPTIONS.capacityWaitMs,
  minFreeMemoryBytes: DEFAULT_ENGINE_OPTIONS.minFreeMemoryBytes,
} as const

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

/**
 * A tree plus a worker pool.
 *
 * `materializeLazily` reproduces the real ordering — a reserved claim id is not
 * an agent until the child materializes — which is what the capacity tests need.
 * Everything else registers the worker immediately, so a `running` node really
 * does have a live holder.
 */
function makeWorld(options: {
  maxConcurrent: number
  staleMs?: number
  /** Round ceiling; defaults to the production one, so only a test that means to hit it configures it. */
  roundMs?: number
  clock?: () => number
  sessions?: Set<string>
  /** Owner sessions the host cannot answer for at all: orphaned, but never destroyed. */
  unobservable?: Set<string>
  materializeLazily?: boolean
  /**
   * Awaited before `interruptWorker` records its call. A test parks one sweep inside the await whose
   * width is the M5 window: a concurrent sweep reclaims and re-dispatches the node while the first
   * one is still holding its pre-interrupt snapshot.
   */
  beforeInterrupt?: (sessionId: string) => Promise<void>
  /**
   * Capacity gate. Omitted means the OPEN ceiling, so the pre-capacity cases in this file keep their
   * meaning; the capacity tests inject a small number and, where the aging clock matters, a clock.
   */
  capacity?: number
  capacityWaitMs?: number
  probe?: ResourceProbe
  minFreeMemoryBytes?: number
}) {
  const store = memoryStore()
  const live = new Set<string>(['owner'])
  const sessions = options.sessions ?? new Set<string>(['owner'])
  const unobservable = options.unobservable ?? new Set<string>()
  const started: string[] = []
  /** Every claim id handed out by `reserveClaimId`, in order, so a test can name the one a refusal used. */
  const reserved: string[] = []
  /** Every claim handed back by `releaseClaimId`: a refused dispatch must hand its own reservation back. */
  const released: string[] = []
  const pending = new Set<string>()
  const interrupted: string[] = []
  const notified: string[] = []
  const stalled: StallReport[] = []
  const hung: HungReport[] = []
  let sequence = 0
  let tick = 0
  const tree = new MissionTree(store, {
    isAgentLive: (sessionId) => live.has(sessionId),
    probeOwner: (sessionId) =>
      Promise.resolve(
        unobservable.has(sessionId)
          ? { kind: 'unobservable' as const, detail: `stubbed: cannot read ${sessionId}` }
          : sessions.has(sessionId)
            ? { kind: 'exists' as const }
            : { kind: 'missing' as const },
      ),
    spill: () => Promise.resolve(null),
    now: options.clock ?? (() => (tick += 1)),
    newId: () => `n${String(++sequence).padStart(4, '0')}`,
  })
  const engine = new MissionEngine(
    tree,
    {
      reserveClaimId: () => {
        const claimId = `mission-${String(++sequence)}`
        reserved.push(claimId)
        return claimId
      },
      releaseClaimId: (claimId) => released.push(claimId),
      startWorker: ({ claimId }) => {
        started.push(claimId)
        if (options.materializeLazily === true) {
          // Materialization is asynchronous in reality: the agent registers
          // later, which is exactly why a live-agent count cannot cap the pass.
          pending.add(claimId)
        } else {
          live.add(claimId)
        }
        return Promise.resolve()
      },
      interruptWorker: async (sessionId) => {
        await options.beforeInterrupt?.(sessionId)
        interrupted.push(sessionId)
      },
      notifyOwner: (rootId, reason) => notified.push(`${rootId}:${reason}`),
      notifyStalled: (info) => stalled.push(info),
      notifyHung: (info) => hung.push(info),
    },
    {
      maxConcurrent: options.maxConcurrent,
      staleMs: options.staleMs ?? 60_000,
      roundMs: options.roundMs ?? DEFAULT_ENGINE_OPTIONS.roundMs,
      now: options.clock,
      capacity: options.capacity ?? CAPACITY_CEILING,
      capacityWaitMs: options.capacityWaitMs ?? DEFAULT_ENGINE_OPTIONS.capacityWaitMs,
      minFreeMemoryBytes: options.minFreeMemoryBytes ?? DEFAULT_ENGINE_OPTIONS.minFreeMemoryBytes,
      ...options.probe === undefined ? {} : { probe: options.probe },
    },
  )
  /** Let every lazily created worker become a live agent (the next tick). */
  const materialize = (): void => {
    for (const claimId of pending) live.add(claimId)
    pending.clear()
  }
  return { tree, engine, live, started, reserved, released, interrupted, notified, stalled, hung, store, materialize }
}

async function roots(tree: MissionTree, count: number, owner = 'owner'): Promise<string[]> {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const created = await tree.createRoot({
      ownerSessionId: owner,
      title: `root ${String(index)}`,
      description: 'd',
      analysis: [],
    })
    if (!created.ok) throw new Error('root failed')
    ids.push(created.value.id)
  }
  return ids
}

describe('capacity', () => {
  it('never dispatches more than maxConcurrent in one pass', async () => {
    const world = makeWorld({ maxConcurrent: 3, materializeLazily: true })
    await roots(world.tree, 8)
    expect(await world.engine.pump()).toBe(3)
    expect(world.started).toHaveLength(3)
  })

  it('counts workers from earlier passes against the ceiling', async () => {
    const world = makeWorld({ maxConcurrent: 2, materializeLazily: true })
    await roots(world.tree, 3)
    expect(await world.engine.pump()).toBe(2)
    // Those two materialize before the next trigger; the ceiling stays full.
    world.materialize()
    expect(await world.engine.pump()).toBe(0)
    expect(world.started).toHaveLength(2)
  })
})

describe('claim accounting', () => {
  it('does not hand back a claim that was actually bound', async () => {
    const world = makeWorld({ maxConcurrent: 2 })
    await roots(world.tree, 1)
    expect(await world.engine.pump()).toBe(1)
    expect(world.started).toHaveLength(1)
    expect(world.released).toEqual([])
  })

  it('hands back the reservation when the dispatch is refused at the ceiling', async () => {
    const world = makeWorld({ maxConcurrent: 2 })
    const [id] = await roots(world.tree, 1)
    if (id === undefined) throw new Error('no root')

    // Burn the failure budget the honest way: every vanished worker charges `failures`, and at the
    // ceiling `dispatch` refuses (`failExhausted`) — AFTER the engine has already reserved a claim,
    // which is the only refusal path a real run reaches.
    let guard = 0
    while (world.tree.node(id)?.status !== 'failed' && guard < 12) {
      guard += 1
      await world.engine.pump()
      const claim = world.tree.node(id)?.claimedBy ?? ''
      if (claim !== '') world.live.delete(claim)
      await world.engine.reclaimStale()
    }
    expect(world.tree.node(id)?.status).toBe('failed')

    // Nothing was started for the refused reservation, and it was handed back rather than left as a
    // ghost that keeps answering "live" for an id no node holds.
    const refused = world.reserved.at(-1)
    expect(refused).toBeDefined()
    expect(world.released).toEqual([refused])
    expect(world.started).not.toContain(refused)
  })
})

describe('reclamation', () => {
  it('reclaims a binding whose worker vanished, and re-dispatches it', async () => {
    const world = makeWorld({ maxConcurrent: 4 })
    const [id] = await roots(world.tree, 1)
    await world.engine.pump()
    const claim = world.tree.node(id)?.claimedBy ?? ''
    expect(claim).not.toBe('')

    world.live.delete(claim)
    expect(await world.engine.sweep()).toEqual({ reclaimed: 1, dispatched: 1 })
    expect(world.tree.node(id)?.status).toBe('running')
    expect(world.tree.node(id)?.attempts).toBe(2)
    expect(world.started).toHaveLength(2)
  })

  it('interrupts a worker that is alive but has been silent past the window', async () => {
    let now = 1_000
    const world = makeWorld({ maxConcurrent: 4, staleMs: 10, clock: () => now })
    const [id] = await roots(world.tree, 1)
    await world.engine.pump()
    const claim = world.tree.node(id)?.claimedBy ?? ''

    // The clock moves and the worker says nothing.
    now += 11
    await world.engine.reclaimStale()
    expect(world.interrupted).toEqual([claim])
    expect(world.tree.node(id)?.status).toBe('interrupted')
  })

  it('leaves a live worker alone while it is inside the window', async () => {
    let now = 1_000
    const world = makeWorld({ maxConcurrent: 4, staleMs: 60_000, clock: () => now })
    const [id] = await roots(world.tree, 1)
    await world.engine.pump()

    now += 30_000
    await world.engine.reclaimStale()
    expect(world.interrupted).toEqual([])
    expect(world.tree.node(id)?.status).toBe('running')
  })

  it('refuses a stale snapshot reclaim once a concurrent sweep re-dispatched the node', async () => {
    // The M5 window, exactly: sweep1 snapshots the binding and parks inside `interruptWorker(A)`;
    // sweep2 runs end to end in that gap — reclaims X and pumps it back out to claim B. Acted on
    // blindly, sweep1's stale `stalled` verdict would strip B's binding (B's `submit_mission` then
    // answers `not-owner`, so it is an orphan) and charge `failures` a second time for one attempt.
    let now = 1_000
    let releaseFirst: (() => void) | undefined
    let gated = false
    const world = makeWorld({
      maxConcurrent: 1,
      staleMs: 10,
      clock: () => now,
      beforeInterrupt: () => {
        if (gated) return Promise.resolve()
        gated = true
        return new Promise<void>((resolve) => { releaseFirst = resolve })
      },
    })
    const [id] = await roots(world.tree, 1)
    if (id === undefined) throw new Error('no root')
    await world.engine.pump()
    const claimA = world.tree.node(id)?.claimedBy ?? ''
    expect(claimA).not.toBe('')

    // Past the stale window: sweep1 will judge A stalled and suspend on the interrupt.
    now += 11
    const sweepOne = world.engine.sweep()
    expect(gated, 'sweep1 must be parked inside interruptWorker for the window to exist').toBe(true)

    // sweep2 finishes while sweep1 is parked: reclaim X as stalled, then re-dispatch it.
    const second = await world.engine.sweep()
    expect(second).toEqual({ reclaimed: 1, dispatched: 1 })
    const claimB = world.tree.node(id)?.claimedBy ?? ''
    expect(claimB).not.toBe(claimA)
    expect(world.tree.node(id)?.failures).toBe(1)

    releaseFirst?.()
    // sweep1's stale verdict is refused: nothing left for it to reclaim or dispatch.
    expect(await sweepOne).toEqual({ reclaimed: 0, dispatched: 0 })
    expect(world.tree.node(id)).toMatchObject({
      status: 'running',
      claimedBy: claimB,
      attempts: 2,
      failures: 1,
      stalls: 1,
    })
  })
})

describe('owner notification', () => {
  it('reports a terminal root exactly once per engine generation', async () => {
    const world = makeWorld({ maxConcurrent: 4 })
    const [id] = await roots(world.tree, 1)
    await world.engine.pump()
    const claim = world.tree.node(id)?.claimedBy ?? ''
    await world.tree.submitResult(id, claim, 'done')
    await world.engine.pump()
    expect(world.notified).toEqual([`${id}:done`])

    await world.engine.pump()
    expect(world.notified).toHaveLength(1)

    // A hot reload re-arms the memo; a closed tree is never reported again.
    world.engine.forgetReport(id)
    await world.engine.pump()
    expect(world.notified).toHaveLength(2)
  })

  it('stops reporting a tree the owner has closed', async () => {
    const world = makeWorld({ maxConcurrent: 4 })
    const [id] = await roots(world.tree, 1)
    await world.engine.pump()
    const claim = world.tree.node(id)?.claimedBy ?? ''
    await world.tree.submitResult(id, claim, 'done')
    await world.tree.markResultRead(id)
    await world.tree.finish(id, 'owner')
    world.engine.forgetReport(id)
    await world.engine.pump()
    expect(world.notified).toEqual([])
  })
})

describe('orphans', () => {
  it('destroys the trees of a session that is gone and keeps the others', async () => {
    // The distinction is durable existence, not a live agent: a restart has no
    // live agents at all, yet its sessions are intact.
    const world = makeWorld({ maxConcurrent: 4, sessions: new Set(['owner']) })
    const [kept] = await roots(world.tree, 1)
    const [gone] = await roots(world.tree, 1, 'deleted-session')

    expect(await world.engine.reconcileOrphans()).toEqual([gone])
    expect(world.tree.treeOf(gone)).toBeUndefined()
    expect(world.tree.treeOf(kept)).toBeDefined()
    expect(world.store.documents.size).toBe(1)
  })

  it('never destroys a tree whose owner is merely unobservable, and interrupts the workers of one that is gone', async () => {
    const world = makeWorld({
      maxConcurrent: 4,
      sessions: new Set(['owner']),
      unobservable: new Set(['opaque-session']),
    })
    const [kept] = await roots(world.tree, 1)
    const [gone] = await roots(world.tree, 1, 'deleted-session')
    const [opaque] = await roots(world.tree, 1, 'opaque-session')
    // A worker still holding the gone tree: destroying it must stop the worker first.
    await world.tree.dispatch(gone, 'mission-gone')
    world.live.add('mission-gone')

    expect(await world.engine.reconcileOrphans()).toEqual([gone])
    expect(world.interrupted).toEqual(['mission-gone'])
    expect(world.tree.treeOf(gone)).toBeUndefined()
    expect(world.tree.treeOf(kept)).toBeDefined()
    // "Cannot tell" is not "gone": the opaque tree keeps its owner's mission.
    expect(world.tree.treeOf(opaque)).toBeDefined()
    const orphans = await world.tree.orphanedTrees()
    expect(orphans.map((entry) => entry.probe.kind)).toEqual(['unobservable'])
  })
})

describe('terminal reporting is durable, not per-pass', () => {
  it('wakes the owner once for a terminal tree, across engine restarts', async () => {
    const world = makeWorld({ maxConcurrent: 1 })
    const [rootId] = await roots(world.tree, 1)
    if (rootId === undefined) throw new Error('no root')

    // Drive the tree to a terminal state, then pump repeatedly.
    await world.tree.dispatch(rootId, 'mission-terminal')
    await world.tree.submitResult(rootId, 'mission-terminal', 'done')

    await world.engine.pump()
    await world.engine.pump()
    await world.engine.pump()
    expect(world.notified).toEqual([`${rootId}:done`])

    // A fresh engine over the same durable state must not re-report: the marker
    // lives on the tree, not in the engine that happened to observe it.
    const restarted = new MissionEngine(
      world.tree,
      {
        reserveClaimId: () => 'mission-restarted',
        releaseClaimId: () => undefined,
        startWorker: () => Promise.resolve(),
        interruptWorker: () => Promise.resolve(),
        notifyOwner: (id, reason) => world.notified.push(`${id}:${reason}`),
      },
      { ...OPEN_GATE, maxConcurrent: 1, staleMs: 60_000, roundMs: DEFAULT_ENGINE_OPTIONS.roundMs },
    )
    await restarted.pump()
    await restarted.pump()
    expect(world.notified).toEqual([`${rootId}:done`])
  })

  it('wakes again after the marker is cleared for a re-rooted tree', async () => {
    const world = makeWorld({ maxConcurrent: 1 })
    const [rootId] = await roots(world.tree, 1)
    if (rootId === undefined) throw new Error('no root')
    await world.tree.dispatch(rootId, 'mission-a')
    await world.tree.submitResult(rootId, 'mission-a', 'done')
    await world.engine.pump()
    expect(world.notified).toHaveLength(1)

    // Clearing is what a caller does when the same root becomes mission again.
    await world.tree.clearReport(rootId)
    await world.engine.pump()
    expect(world.notified).toHaveLength(2)
  })
})

describe('stalls', () => {
  /** A world whose clock the test moves by hand. */
  function clockedWorld(staleMs = 1_000) {
    let value = 1_000_000
    const world = makeWorld({ maxConcurrent: 1, staleMs, clock: () => value })
    return {
      world,
      now: () => value,
      advance: (ms: number) => {
        value += ms
      },
    }
  }

  it('never reclaims a live worker that keeps reporting progress', async () => {
    const { world, now, advance } = clockedWorld()
    const [id] = await roots(world.tree, 1)
    if (id === undefined) throw new Error('no root')
    await world.engine.pump()
    const claim = world.tree.node(id)?.claimedBy ?? ''

    // Three windows' worth of wall clock, but the worker is never silent for a
    // whole one: this is the long execution the stale check must leave alone.
    for (let round = 0; round < 3; round += 1) {
      advance(900)
      world.tree.touchProgress(id, now())
      expect(await world.engine.sweep()).toEqual({ reclaimed: 0, dispatched: 0 })
    }
    expect(world.tree.node(id)?.status).toBe('running')
    expect(world.tree.node(id)?.claimedBy).toBe(claim)
    expect(world.interrupted).toEqual([])
    expect(world.stalled).toEqual([])
  })

  it('reclaims a worker that has been silent for the whole window', async () => {
    const { world, advance } = clockedWorld()
    const [id] = await roots(world.tree, 1)
    if (id === undefined) throw new Error('no root')
    await world.engine.pump()
    const claim = world.tree.node(id)?.claimedBy ?? ''

    advance(1_001)
    // Reclaimed and re-dispatched in one pass, so the node is running again — on
    // its second attempt, with one stall on the record.
    expect(await world.engine.sweep()).toEqual({ reclaimed: 1, dispatched: 1 })
    expect(world.interrupted).toEqual([claim])
    expect(world.tree.node(id)?.attempts).toBe(2)
    expect(world.tree.node(id)?.stalls).toBe(1)
    // One stall is not worth a turn of the owner's own.
    expect(world.stalled).toEqual([])
  })

  it('tells the owner on the second stall, and only once', async () => {
    const { world, advance } = clockedWorld()
    const [id] = await roots(world.tree, 1)
    if (id === undefined) throw new Error('no root')
    await world.engine.pump()

    advance(1_001)
    await world.engine.sweep()
    expect(world.stalled).toHaveLength(0)

    advance(1_001)
    await world.engine.sweep()
    expect(world.stalled).toHaveLength(1)
    expect(world.stalled[0]?.nodeId).toBe(id)
    expect(world.stalled[0]?.stalls).toBe(2)
    expect(world.stalled[0]?.attempts).toBe(2)
    // The report carries the FAILURE budget, which is what the owner-facing sentence quotes:
    // `attempts` also rises on rounds that succeed, so it can exceed `maxAttempts` and must
    // never be printed as "N of the limit".
    expect(world.stalled[0]?.failures).toBe(2)

    // A third stall is the same news; the durable marker is what keeps a flaky node
    // from turning every sweep into a wake.
    advance(1_001)
    await world.engine.sweep()
    expect(world.stalled).toHaveLength(1)
  })

  it('reports the first stall of a node that is nearly out of attempts', async () => {
    const { world, advance } = clockedWorld()
    const [id] = await roots(world.tree, 1)
    if (id === undefined) throw new Error('no root')

    // Three attempts lost to workers that VANISHED — not the node's fault, and not a
    // stall — so its first real stall happens late in its life.
    for (let round = 0; round < 3; round += 1) {
      await world.engine.pump()
      world.live.delete(world.tree.node(id)?.claimedBy ?? '')
      await world.engine.sweep()
    }
    expect(world.tree.node(id)?.attempts).toBe(4)
    expect(world.tree.node(id)?.stalls).toBe(0)

    advance(1_001)
    await world.engine.sweep()
    // attempts + 1 would exhaust the budget, so the owner hears about this one.
    expect(world.stalled).toHaveLength(1)
    expect(world.stalled[0]?.stalls).toBe(1)
    expect(world.stalled[0]?.attempts).toBe(4)
    expect(world.stalled[0]?.title).toBe('root 0')
  })
})

/**
 * The W8 blind spot (2026-10-02): a worker that stayed `running` for 7.5 hours while provider
 * retries refreshed its timestamp every minute, so the old "no events" criterion never fired.
 * These cases pin the replacement — output is the criterion, with a round cap as the backstop —
 * and, just as important, that nothing the old criterion caught was lost.
 */
describe('hung workers: alive but producing nothing', () => {
  /**
   * A world with a hand-moved clock and BOTH windows explicit, so which bound fires is never an
   * accident. `noise`/`output` move the clock and the node together, exactly as a session event does.
   */
  async function hungWorld(options: { staleMs?: number; roundMs?: number } = {}) {
    let value = 1_000_000
    const world = makeWorld({
      maxConcurrent: 1,
      staleMs: options.staleMs ?? 1_000,
      roundMs: options.roundMs ?? 1_000_000,
      clock: () => value,
    })
    const [id] = await roots(world.tree, 1)
    if (id === undefined) throw new Error('no root')
    await world.engine.pump()
    const claim = world.tree.node(id)?.claimedBy ?? ''
    if (claim === '') throw new Error('the root was not dispatched')
    return {
      world,
      id,
      claim,
      advance: (ms: number) => { value += ms },
      /** Transport-layer noise: the worker is heard from, but produced nothing. */
      noise: (ms: number) => { value += ms; world.tree.touchActivity(id, value) },
      /** Real output. */
      output: (ms: number) => { value += ms; world.tree.touchProgress(id, value) },
    }
  }

  it('① reclaims an alive-but-unproductive worker as `hung`, without charging the failure budget', async () => {
    const h = await hungWorld({ staleMs: 1_000 })
    // Past the stale window in steps, each carrying a noise event: activity is always fresh, output
    // never. This is the W8 shape — a provider retrying for hours.
    for (let step = 0; step < 4; step += 1) h.noise(400)
    const node = h.world.tree.node(h.id)
    expect(node?.activityAt).toBeGreaterThan(node?.progressAt ?? 0)

    expect(await h.world.engine.reclaimStale()).toBe(1)
    expect(h.world.interrupted).toEqual([h.claim])
    expect(h.world.tree.node(h.id)?.status).toBe('interrupted')
    // The new cause is named, carries WHICH bound fired, and reports how long the worker was idle.
    expect(h.world.hung).toHaveLength(1)
    expect(h.world.hung[0]).toMatchObject({ nodeId: h.id, title: 'root 0', bound: 'output', idleMs: 1_600 })
    // The failure/silence budgets and the owner-facing stall signal are all untouched.
    expect(h.world.tree.node(h.id)?.failures).toBe(0)
    expect(h.world.tree.node(h.id)?.spawnFailures).toBe(0)
    expect(h.world.tree.node(h.id)?.stalls).toBe(0)
    expect(h.world.stalled).toEqual([])
  })

  it('② never reclaims a worker that keeps producing output, across many windows', async () => {
    const h = await hungWorld({ staleMs: 1_000 })
    for (let round = 0; round < 5; round += 1) {
      h.output(900)
      expect(await h.world.engine.sweep()).toEqual({ reclaimed: 0, dispatched: 0 })
    }
    // Four and a half windows of wall clock, and the worker is still the same live binding.
    expect(h.world.tree.node(h.id)?.status).toBe('running')
    expect(h.world.tree.node(h.id)?.claimedBy).toBe(h.claim)
    expect(h.world.interrupted).toEqual([])
    expect(h.world.hung).toEqual([])
    expect(h.world.stalled).toEqual([])
  })

  it('③ still reclaims a TRULY silent worker as `stalled`, charging failures (regression)', async () => {
    const h = await hungWorld({ staleMs: 1_000 })
    // No events of any kind: the original criterion, and the original verdict.
    h.advance(1_001)
    expect(await h.world.engine.sweep()).toEqual({ reclaimed: 1, dispatched: 1 })
    expect(h.world.interrupted).toEqual([h.claim])
    expect(h.world.hung).toEqual([])
    expect(h.world.tree.node(h.id)?.stalls).toBe(1)
    expect(h.world.tree.node(h.id)?.failures).toBe(1)
  })

  it('④ re-dispatches a `hung` node once, and refuses the interrupted worker’s late result', async () => {
    const h = await hungWorld({ staleMs: 1_000 })
    for (let step = 0; step < 4; step += 1) h.noise(400)
    expect(await h.world.engine.sweep()).toEqual({ reclaimed: 1, dispatched: 1 })

    const next = h.world.tree.node(h.id)?.claimedBy ?? ''
    expect(next).not.toBe('')
    expect(next).not.toBe(h.claim)
    // One start per dispatch: the reclaim did not leave the old worker running behind the new one.
    expect(h.world.started).toEqual([h.claim, next])
    // The interrupted worker can no longer settle the node it lost...
    const late = await h.world.tree.submitResult(h.id, h.claim, 'too late')
    expect(late.ok).toBe(false)
    expect(late.ok ? '' : late.code).toBe('not-owner')
    // ...and the live binding was not disturbed by its attempt.
    expect(h.world.tree.node(h.id)?.claimedBy).toBe(next)
    expect(h.world.tree.node(h.id)?.attempts).toBe(2)
  })

  it('⑤ leaves a `hung` node immediately dispatchable: no budget charge, no cooldown', async () => {
    const h = await hungWorld({ staleMs: 1_000 })
    for (let step = 0; step < 4; step += 1) h.noise(400)
    await h.world.engine.reclaimStale()
    expect(h.world.tree.node(h.id)).toMatchObject({ failures: 0, spawnFailures: 0, stalls: 0 })
    // The cooldown belongs to failed STARTS alone; a hung round must not inherit one.
    expect(h.world.tree.nextDispatchable()?.id).toBe(h.id)
    expect(await h.world.engine.pump()).toBe(1)
    expect(h.world.started).toHaveLength(2)
  })

  it('reclaims as `hung` once the round cap is exceeded, even while output keeps arriving', async () => {
    // The cap is the backstop no timestamp can veto: a round that runs past it is taken back
    // whatever the worker reports. Here the stale window is nowhere near — only the cap fires.
    const h = await hungWorld({ staleMs: 1_000_000, roundMs: 5_000 })
    for (let round = 0; round < 6; round += 1) h.output(1_000)
    expect(h.world.tree.node(h.id)?.progressAt).toBe(h.world.tree.node(h.id)?.activityAt)
    expect(await h.world.engine.reclaimStale()).toBe(1)
    expect(h.world.interrupted).toEqual([h.claim])
    expect(h.world.hung).toHaveLength(1)
    expect(h.world.hung[0]).toMatchObject({ bound: 'round', ranMs: 6_000 })
    // Still budget-free: hitting the cap is an apparatus event, not a failed mission.
    expect(h.world.tree.node(h.id)).toMatchObject({ failures: 0, spawnFailures: 0, stalls: 0 })
  })

  /**
   * The N2 half: hung still charges no budget, but it can no longer repeat forever in silence. The
   * streak is durable, cleared by production, and at the engine's floor it routes the node to the
   * owner through the SAME channel the stall heads-up uses.
   */
  it('① escalates a hung STREAK to the owner exactly once, at the threshold', async () => {
    const h = await hungWorld({ staleMs: 1_000 })
    const hangOnce = async (): Promise<void> => {
      // Past the stale window in steps, each carrying a noise event: alive, never producing.
      for (let step = 0; step < 4; step += 1) h.noise(400)
      await h.world.engine.sweep()
    }

    await hangOnce()
    await hangOnce()
    // Two in a row: below the floor, so the owner is not paged yet — and each round is still logged.
    expect(h.world.tree.node(h.id)?.hungCount).toBe(2)
    expect(h.world.stalled).toEqual([])
    expect(h.world.hung).toHaveLength(2)
    expect(h.world.hung[1]?.hungCount).toBe(2)

    await hangOnce()
    const node = h.world.tree.node(h.id)
    expect(node?.hungCount).toBe(CAPACITY.maxHungsBeforeReport)
    expect(isTroubledNode(node!)).toBe(true)
    expect(h.world.stalled).toHaveLength(1)
    // One vocabulary with the stall heads-up: the same report type, naming the cause and the streak.
    expect(h.world.stalled[0]).toMatchObject({ nodeId: h.id, cause: 'hung', hungs: 3 })
    // The streak is not a budget: nothing was charged on the way there.
    expect(node).toMatchObject({ failures: 0, spawnFailures: 0, stalls: 0 })

    // A fourth hang advances the counter but NOT the message: the durable marker keeps it to one.
    await hangOnce()
    expect(h.world.tree.node(h.id)?.hungCount).toBe(4)
    expect(h.world.stalled).toHaveLength(1)
  })

  it('② clears the hang streak as soon as the worker produces something', async () => {
    const h = await hungWorld({ staleMs: 1_000 })
    const hangOnce = async (): Promise<void> => {
      for (let step = 0; step < 4; step += 1) h.noise(400)
      await h.world.engine.sweep()
    }
    await hangOnce()
    await hangOnce()
    expect(h.world.tree.node(h.id)?.hungCount).toBe(2)

    // Real output is the one event that proves the round was not merely retrying: the streak resets
    // and the node stays the very binding it was.
    h.output(100)
    expect(h.world.tree.node(h.id)?.hungCount).toBe(0)
    expect(h.world.stalled).toEqual([])
    // The next hang starts the streak over from 1 rather than resuming at 3.
    h.noise(4_000)
    expect(await h.world.engine.reclaimStale()).toBe(1)
    expect(h.world.tree.node(h.id)?.hungCount).toBe(1)
    expect(h.world.stalled).toEqual([])
  })

  it('③ honours a mission’s declared round-cap relaxation, and never shortens the configured cap', async () => {
    let value = 1_000_000
    const world = makeWorld({ maxConcurrent: 1, staleMs: 1_000_000, roundMs: 5_000, clock: () => value })
    // A heavy mission declares 20 s for itself; the engine's cap is 5 s.
    const created = await world.tree.createRoot({
      ownerSessionId: 'owner',
      title: 'heavy',
      description: 'd',
      analysis: [],
      roundMs: 20_000,
    })
    if (!created.ok) throw new Error('root failed')
    const id = created.value.id
    await world.engine.pump()

    value += 6_000
    // Past the configured cap, well inside the declared one: the declaration bought it that room.
    expect(await world.engine.reclaimStale()).toBe(0)
    expect(world.tree.node(id)?.status).toBe('running')

    value += 15_000
    // Past the declaration too: the round bound fires, exactly as the configured cap would have.
    expect(await world.engine.reclaimStale()).toBe(1)
    expect(world.hung[0]).toMatchObject({ nodeId: id, bound: 'round' })

    // Relaxation ONLY: a node asking for a SHORTER round than the machine's is a no-op, so a model
    // cannot set itself a small countdown and have the engine take its work back on demand.
    const short = makeWorld({ maxConcurrent: 1, staleMs: 1_000_000, roundMs: 5_000, clock: () => value })
    const other = await short.tree.createRoot({
      ownerSessionId: 'owner',
      title: 'impatient',
      description: 'd',
      analysis: [],
      roundMs: 1_000,
    })
    if (!other.ok) throw new Error('root failed')
    await short.engine.pump()
    value += 6_000
    expect(await short.engine.reclaimStale()).toBe(1)
    expect(short.hung[0]).toMatchObject({ nodeId: other.value.id, bound: 'round' })
  })
})

/**
 * The dispatch pass must prefer CONTINUING a demoted worker session over starting a fresh one, and
 * the three host answers must lead to three different actions. The host itself (adoption, guard,
 * delivery) is exercised in the plugin's `cold-resume` cases; what is pinned HERE is the engine's
 * side of the contract.
 */
describe('cold continuation', () => {
  /** Persist a `running` binding and reopen the store, as a process restart does: `open()` demotes
   *  the node and parks the worker id in `lastWorkerId`. */
  async function demoted(workerId: string): Promise<{ tree: MissionTree; rootId: string }> {
    const store = memoryStore()
    const deps = {
      isAgentLive: (sessionId: string) => sessionId === 'owner',
      probeOwner: () => Promise.resolve({ kind: 'exists' as const }),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'root0001',
    }
    const first = new MissionTree(store, deps)
    const created = await first.createRoot({
      ownerSessionId: 'owner',
      title: 'continued',
      description: 'd',
      analysis: [],
    })
    if (!created.ok) throw new Error('root failed')
    await first.dispatch(created.value.id, workerId)
    const reopened = new MissionTree(store, deps)
    await reopened.open()
    if (reopened.node(created.value.id)?.lastWorkerId !== workerId) {
      throw new Error('the continuation handle was not recorded on open')
    }
    return { tree: reopened, rootId: created.value.id }
  }

  /** An engine over a demoted tree, with a host that answers continuation attempts `answer`. */
  function engineWith(
    tree: MissionTree,
    answer: (input: { nodeId: string; workerId: string }) => Promise<ResumeOutcome>,
  ): { engine: MissionEngine; started: string[]; attempted: { nodeId: string; workerId: string }[] } {
    const started: string[] = []
    const attempted: { nodeId: string; workerId: string }[] = []
    let sequence = 0
    const engine = new MissionEngine(
      tree,
      {
        reserveClaimId: () => `mission-fresh-${String(++sequence)}`,
        releaseClaimId: () => undefined,
        startWorker: ({ claimId }) => {
          started.push(claimId)
          return Promise.resolve()
        },
        resumeWorker: async (input) => {
          attempted.push({ nodeId: input.node.id, workerId: input.workerId })
          return answer({ nodeId: input.node.id, workerId: input.workerId })
        },
        interruptWorker: () => Promise.resolve(),
        notifyOwner: () => undefined,
      },
      { ...OPEN_GATE, maxConcurrent: 4, staleMs: 60_000, roundMs: DEFAULT_ENGINE_OPTIONS.roundMs, now: () => 1 },
    )
    return { engine, started, attempted }
  }

  it('continues the recorded session instead of starting a fresh worker', async () => {
    const { tree, rootId } = await demoted('mission-old')
    const { engine, started, attempted } = engineWith(tree, async ({ nodeId, workerId }) => {
      const adopted = await tree.adoptContinuation(nodeId, workerId)
      return adopted.ok ? 'resumed' : 'skip'
    })

    expect(await engine.pump()).toBe(1)
    expect(attempted).toEqual([{ nodeId: rootId, workerId: 'mission-old' }])
    // Bound to the OLD session at the next attempt, and nobody was spawned.
    expect(started).toEqual([])
    expect(tree.node(rootId)?.claimedBy).toBe('mission-old')
    expect(tree.node(rootId)?.attempts).toBe(2)
    expect(tree.node(rootId)?.lastWorkerId).toBeNull()
  })

  it('starts nobody when the continuation reports skip', async () => {
    const { tree, rootId } = await demoted('mission-old')
    const { engine, started, attempted } = engineWith(tree, async () => 'skip')

    expect(await engine.pump()).toBe(0)
    expect(attempted).toHaveLength(1)
    // "skip" is not "failed": a fresh executor on top of a session another delivery owns is the
    // double run the answer exists to prevent. The node is left for the next pass.
    expect(started).toEqual([])
    expect(tree.node(rootId)?.status).toBe('interrupted')
    expect(tree.node(rootId)?.lastWorkerId).toBe('mission-old')
    expect(tree.node(rootId)?.attempts).toBe(1)
  })

  it('takes the ordinary fresh path, in the same pass, when the continuation fails', async () => {
    const { tree, rootId } = await demoted('mission-old')
    const { engine, started } = engineWith(tree, async ({ nodeId, workerId }) => {
      const adopted = await tree.adoptContinuation(nodeId, workerId)
      if (!adopted.ok) return 'skip'
      await tree.reclaim(nodeId, 'wake-failed')
      return 'failed'
    })

    expect(await engine.pump()).toBe(1)
    expect(started).toEqual(['mission-fresh-1'])
    expect(tree.node(rootId)?.status).toBe('running')
    expect(tree.node(rootId)?.claimedBy).toBe('mission-fresh-1')
    // The refused delivery charged neither budget, and the handle is spent.
    expect(tree.node(rootId)?.failures).toBe(0)
    expect(tree.node(rootId)?.spawnFailures).toBe(0)
    expect(tree.node(rootId)?.lastWorkerId).toBeNull()
  })
})
