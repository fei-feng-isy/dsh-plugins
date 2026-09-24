/**
 * The dispatch loop: capacity, reclamation and owner notification.
 *
 * The engine is exercised with a stubbed worker starter, so these are the
 * decisions it makes — how many workers it starts, which bindings it reclaims,
 * whom it wakes — with no harness and no model.
 */
import { describe, expect, it } from 'vitest'
import { WorkEngine, WorkTree, type StallReport, type TreeState, type TreeStore } from '../src/index.js'

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
  clock?: () => number
  sessions?: Set<string>
  /** Owner sessions the host cannot answer for at all: orphaned, but never destroyed. */
  unobservable?: Set<string>
  materializeLazily?: boolean
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
  let sequence = 0
  let tick = 0
  const tree = new WorkTree(store, {
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
  const engine = new WorkEngine(
    tree,
    {
      reserveClaimId: () => {
        const claimId = `work-${String(++sequence)}`
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
      interruptWorker: (sessionId) => {
        interrupted.push(sessionId)
        return Promise.resolve()
      },
      notifyOwner: (rootId, reason) => notified.push(`${rootId}:${reason}`),
      notifyStalled: (info) => stalled.push(info),
    },
    { maxConcurrent: options.maxConcurrent, staleMs: options.staleMs ?? 60_000, now: options.clock },
  )
  /** Let every lazily created worker become a live agent (the next tick). */
  const materialize = (): void => {
    for (const claimId of pending) live.add(claimId)
    pending.clear()
  }
  return { tree, engine, live, started, reserved, released, interrupted, notified, stalled, store, materialize }
}

async function roots(tree: WorkTree, count: number, owner = 'owner'): Promise<string[]> {
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
    await world.tree.dispatch(gone, 'work-gone')
    world.live.add('work-gone')

    expect(await world.engine.reconcileOrphans()).toEqual([gone])
    expect(world.interrupted).toEqual(['work-gone'])
    expect(world.tree.treeOf(gone)).toBeUndefined()
    expect(world.tree.treeOf(kept)).toBeDefined()
    // "Cannot tell" is not "gone": the opaque tree keeps its owner's work.
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
    await world.tree.dispatch(rootId, 'work-terminal')
    await world.tree.submitResult(rootId, 'work-terminal', 'done')

    await world.engine.pump()
    await world.engine.pump()
    await world.engine.pump()
    expect(world.notified).toEqual([`${rootId}:done`])

    // A fresh engine over the same durable state must not re-report: the marker
    // lives on the tree, not in the engine that happened to observe it.
    const restarted = new WorkEngine(
      world.tree,
      {
        reserveClaimId: () => 'work-restarted',
        releaseClaimId: () => undefined,
        startWorker: () => Promise.resolve(),
        interruptWorker: () => Promise.resolve(),
        notifyOwner: (id, reason) => world.notified.push(`${id}:${reason}`),
      },
      { maxConcurrent: 1, staleMs: 60_000 },
    )
    await restarted.pump()
    await restarted.pump()
    expect(world.notified).toEqual([`${rootId}:done`])
  })

  it('wakes again after the marker is cleared for a re-rooted tree', async () => {
    const world = makeWorld({ maxConcurrent: 1 })
    const [rootId] = await roots(world.tree, 1)
    if (rootId === undefined) throw new Error('no root')
    await world.tree.dispatch(rootId, 'work-a')
    await world.tree.submitResult(rootId, 'work-a', 'done')
    await world.engine.pump()
    expect(world.notified).toHaveLength(1)

    // Clearing is what a caller does when the same root becomes work again.
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
