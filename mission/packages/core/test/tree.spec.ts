/**
 * Work-tree behaviour: the state machine, the two terminal tools' mutual
 * exclusion, capacities, and the reconcile rules that keep `running` honest.
 *
 * The tree is exercised with an in-memory store, so these are the rules
 * themselves — no harness, no engine, no model.
 */
import { describe, expect, it } from 'vitest'
import { CAPACITY, MissionTree, isMaterialChange, nodeFingerprint, type NodeRecord, type TreeState, type TreeStore } from '../src/index.js'

/** An in-memory store that records exactly what was persisted. */
function memoryStore(): TreeStore & { documents: Map<string, TreeState> } {
  const documents = new Map<string, TreeState>()
  return {
    documents,
    loadAll: () => Promise.resolve([...documents.values()].map(clone)),
    put: (state) => {
      documents.set(state.tree.rootId, clone(state))
      return Promise.resolve()
    },
    remove: (rootId) => {
      documents.delete(rootId)
      return Promise.resolve()
    },
  }
}

function clone(state: TreeState): TreeState {
  return { tree: state.tree, nodes: new Map(state.nodes) }
}

/** A tree with a controllable clock, live set and id sequence. `unobservable` models a host that
 * cannot answer the ownership question at all (a session store refusing an old log), which must
 * stay distinct from a session that is genuinely gone. */
function makeTree(options: { live?: Set<string>; owners?: Set<string>; unobservable?: Set<string>; spill?: boolean } = {}) {
  const store = memoryStore()
  const live = options.live ?? new Set<string>(['owner'])
  const owners = options.owners ?? new Set<string>(['owner'])
  const unobservable = options.unobservable ?? new Set<string>()
  let tick = 0
  let sequence = 0
  const tree = new MissionTree(store, {
    isAgentLive: (sessionId) => live.has(sessionId),
    probeOwner: (sessionId) =>
      Promise.resolve(
        unobservable.has(sessionId)
          ? { kind: 'unobservable' as const, detail: `stubbed: cannot read ${sessionId}` }
          : owners.has(sessionId)
            ? { kind: 'exists' as const }
            : { kind: 'missing' as const },
      ),
    spill: (text) =>
      Promise.resolve(
        options.spill === false
          ? null
          : { locator: `spill:${String(text.length)}`, hint: 'read it with the read tool' },
      ),
    now: () => (tick += 1),
    newId: () => `n${String(++sequence).padStart(4, '0')}`,
  })
  return { tree, store, live, owners, unobservable }
}

async function rootOf(tree: MissionTree): Promise<string> {
  const created = await tree.createRoot({
    ownerSessionId: 'owner',
    title: 'Root mission',
    description: 'Do the whole thing',
    analysis: ['the owner already knows this'],
  })
  if (!created.ok) throw new Error('root creation failed')
  return created.value.id
}

/**
 * The only legal prelude to `decompose`: the holding dispatch writes its own analysis
 * first, and the tree's gate then admits the split.
 *
 * Every decomposition case goes through here because the gate is a precondition of the
 * verb rather than an optional step. The gate itself — refused before any side effect,
 * re-closed on a fresh dispatch, blank analysis refused — has its own cases in the
 * `analysis and the decompose gate` block at the end of this file; these call sites are
 * about what the split DOES.
 */
async function noteAndSplit(
  tree: MissionTree,
  nodeId: string,
  callerSessionId: string,
  children: Parameters<MissionTree['decompose']>[2],
): Promise<Awaited<ReturnType<MissionTree['decompose']>>> {
  const noted = await tree.recordAnalysis(nodeId, callerSessionId, '这次为什么拆：缺一个前置事实')
  if (!noted.ok) throw new Error(`recordAnalysis failed: ${noted.code} ${noted.message}`)
  return tree.decompose(nodeId, callerSessionId, children)
}

describe('createRoot', () => {
  it('creates a ready root carrying the owner analysis as context', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    const node = tree.node(id)
    expect(node?.status).toBe('ready')
    expect(node?.depth).toBe(1)
    expect(node?.context).toEqual(['the owner already knows this'])
    expect(node?.parentId).toBeNull()
  })

  it('persists the tree document on creation', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    expect(store.documents.has(id)).toBe(true)
  })
})

describe('dispatch', () => {
  it('binds the claim and counts the attempt', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    const decision = await tree.dispatch(id, 'mission-1')
    expect(decision.ok).toBe(true)
    const node = tree.node(id)
    expect(node?.status).toBe('running')
    expect(node?.claimedBy).toBe('mission-1')
    expect(node?.attempts).toBe(1)
  })

  it('refuses a node whose worker is still live', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    const again = await tree.dispatch(id, 'mission-2')
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.code).toBe('not-dispatchable')
  })

  it('reclaims and re-dispatches a node whose worker is gone', async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')

    // A running node with a dead worker is not a candidate yet: it must be
    // reclaimed first, which is what the engine's sweep does.
    live.delete('mission-1')
    expect(tree.nextDispatchable()).toBeUndefined()
    const reclaimed = await tree.reclaim(id)
    expect(reclaimed.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('interrupted')
    expect(tree.nextDispatchable()?.id).toBe(id)

    const again = await tree.dispatch(id, 'mission-2')
    expect(again.ok).toBe(true)
    expect(tree.node(id)?.attempts).toBe(2)
  })

  it('refuses a reclaim whose expected holder no longer holds the node', async () => {
    // The compare-and-swap the engine's concurrent sweep relies on: `reclaimStale` judges a node from
    // a snapshot taken OUTSIDE the lock and then awaits `interruptWorker`, so a second sweep may have
    // reclaimed and re-dispatched it by the time the first one acts. Without this rejection the stale
    // verdict unbinds the live worker and charges `failures` a second time for one attempt.
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')

    const stale = await tree.reclaim(id, 'stalled', 'mission-other')
    expect(stale.ok).toBe(false)
    expect(stale.ok === false && stale.code).toBe('not-dispatchable')
    // Nothing moved: the real holder is intact and no budget was charged.
    expect(tree.node(id)?.status).toBe('running')
    expect(tree.node(id)?.claimedBy).toBe('mission-1')
    expect(tree.node(id)?.failures).toBe(0)
    expect(tree.node(id)?.stalls).toBe(0)

    // The same pass's own holder still reclaims normally.
    const fresh = await tree.reclaim(id, 'stalled', 'mission-1')
    expect(fresh.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('interrupted')
    expect(tree.node(id)?.stalls).toBe(1)
  })

  it(`fails a node after ${String(CAPACITY.maxAttempts)} failed executions`, async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    for (let attempt = 0; attempt < CAPACITY.maxAttempts; attempt += 1) {
      const claim = `mission-${String(attempt)}`
      const dispatched = await tree.dispatch(id, claim)
      expect(dispatched.ok).toBe(true)
      live.delete(claim)
      await tree.reclaim(id)
      live.add(claim)
    }
    const last = await tree.dispatch(id, 'mission-final')
    expect(last.ok).toBe(false)
    expect(tree.node(id)?.status).toBe('failed')
  })
})

describe('the failure budget', () => {
  it('never charges a successful aggregate round, so multi-round convergence survives', async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    // More rounds than the budget: each one dispatches, splits off a prerequisite, and
    // completes it — every round SUCCEEDS, so under the old attempts-based ceiling the node
    // would have been failed around round 5, while the failure budget stays untouched.
    const rounds = CAPACITY.maxAttempts + 2
    for (let round = 0; round < rounds; round += 1) {
      const claim = `mission-a${String(round)}`
      live.add(claim)
      const dispatched = await tree.dispatch(id, claim)
      expect(dispatched.ok, `round ${String(round)} dispatch`).toBe(true)

      await tree.recordAnalysis(id, claim, `round ${String(round)}: still missing a prerequisite`)
      const split = await tree.decompose(id, claim, [
        { title: `prerequisite ${String(round)}`, description: 'd', context: ['needed'] },
      ])
      if (!split.ok) throw new Error(`round ${String(round)} decompose: ${split.message}`)
      const child = split.value.created[0]
      if (child === undefined) throw new Error(`round ${String(round)} created no child`)

      const childClaim = `mission-c${String(round)}`
      live.add(childClaim)
      await tree.dispatch(child, childClaim)
      await tree.submitResult(child, childClaim, 'done')

      const node = tree.node(id)
      expect(node?.status, `round ${String(round)} parent`).toBe('ready')
      expect(node?.failures).toBe(0)
    }
    const final = tree.node(id)
    expect(final?.status).not.toBe('failed')
    expect(final?.attempts).toBe(rounds)
  })

  it('charges a vanished worker to the budget and re-dispatches it at once', async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    live.add('mission-1')
    await tree.dispatch(id, 'mission-1')
    live.delete('mission-1')
    await tree.reclaim(id)
    const node = tree.node(id)
    expect(node?.failures).toBe(1)
    expect(node?.spawnFailures).toBe(0)
    // A mission failure is not an infrastructure failure: no cooldown, straight back to the pool.
    expect(tree.nextDispatchable()?.id).toBe(id)
  })

  it('charges a failed start to spawnFailures, not the budget, and cools the node down', async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    live.add('mission-1')
    await tree.dispatch(id, 'mission-1')
    const reclaimed = await tree.reclaim(id, 'spawn-failed')
    expect(reclaimed.ok).toBe(true)
    const node = tree.node(id)
    expect(node?.status).toBe('interrupted')
    expect(node?.spawnFailures).toBe(1)
    expect(node?.failures).toBe(0)
    // The cooldown holds it out of the pool even though it is interrupted and unclaimed:
    // a transient runtime outage must not be re-dispatched on the very next pump.
    expect(tree.nextDispatchable()).toBeUndefined()
  })

  it(`fails a node whose worker can never be started, without touching the budget`, async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    for (let attempt = 0; attempt < CAPACITY.maxAttempts; attempt += 1) {
      const claim = `mission-s${String(attempt)}`
      live.add(claim)
      const dispatched = await tree.dispatch(id, claim)
      expect(dispatched.ok, `dispatch ${String(attempt)}`).toBe(true)
      await tree.reclaim(id, 'spawn-failed')
    }
    const last = await tree.dispatch(id, 'mission-final')
    expect(last.ok).toBe(false)
    const node = tree.node(id)
    expect(node?.status).toBe('failed')
    expect(node?.failures).toBe(0)
  })

  it('clears the spawn-failure streak once a worker starts', async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    live.add('mission-1')
    await tree.dispatch(id, 'mission-1')
    await tree.reclaim(id, 'spawn-failed')
    expect(tree.node(id)?.spawnFailures).toBe(1)
    // A later successful start forgets the outage, so the node is not left one failed
    // start away from a spawn-failure fail.
    live.add('mission-2')
    await tree.dispatch(id, 'mission-2')
    tree.noteSpawnSuccess(id)
    expect(tree.node(id)?.spawnFailures).toBe(0)
  })
})

describe('the tree-size backstop', () => {
  /**
   * A tree seeded just under the cap, so a split can be pushed over it without hundreds
   * of real rounds.
   *
   * The filler nodes are TERMINAL children of the root: terminal ones do not block the
   * parent (that would be `has-children`, a different refusal), but they still count toward
   * the tree's size and are collectable as siblings by the dedup scope. The root is seeded
   * claimed and running so the split's own gates (holder + written analysis) are already met.
   */
  async function seededTree(extraIds: string[]): Promise<{ tree: MissionTree; rootId: string; documents: ReturnType<typeof memoryStore>['documents'] }> {
    const store = memoryStore()
    const tree = new MissionTree(store, {
      isAgentLive: (sessionId) => sessionId === 'mission-root',
      probeOwner: () => Promise.resolve({ kind: 'exists' }),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: (() => {
        let sequence = 0
        return () => `n${String(++sequence).padStart(4, '0')}`
      })(),
    })
    const rootId = await rootOf(tree)
    const root = tree.node(rootId)
    if (root === undefined) throw new Error('no root')
    // The seeded filler is named `fill-*` so the tree's own id allocator still has room:
    // a constant `newId` would make `allocateId` exhaust its retries against the root's id.
    const nodes = new Map<string, typeof root>()
    const children: string[] = []
    for (const id of extraIds) {
      children.push(id)
      nodes.set(id, { ...root, id, title: id, children: [], status: 'done', hasResult: true, result: 'done' })
    }
    nodes.set(rootId, { ...root, status: 'running', claimedBy: 'mission-root', children })
    store.documents.set(rootId, {
      tree: { rootId, ownerSessionId: 'owner', createdAt: 1, closedAt: null, reportedAt: null },
      nodes: nodes as unknown as TreeState['nodes'],
    })
    await tree.open()
    return { tree, rootId, documents: store.documents }
  }

  it('refuses a split that would push the tree past its cap', async () => {
    // 1 root + 197 terminal children = 198 nodes; three new ones would make 201.
    const filler = Array.from({ length: CAPACITY.maxNodesPerTree - 3 }, (_, i) => `fill-${String(i)}`)
    const { tree, rootId } = await seededTree(filler)
    expect(tree.nodesOf(rootId)).toHaveLength(CAPACITY.maxNodesPerTree - 2)

    const refused = await noteAndSplit(tree, rootId, 'mission-root', [
      { title: 'one', description: 'd', context: [] },
      { title: 'two', description: 'd', context: [] },
      { title: 'three', description: 'd', context: [] },
    ])
    expect(refused.ok, JSON.stringify(refused)).toBe(false)
    expect(!refused.ok && refused.code).toBe('node-limit')
    // Nothing was created: a refused split has no side effect.
    expect(tree.nodesOf(rootId)).toHaveLength(CAPACITY.maxNodesPerTree - 2)
  })

  it('counts only the children a split ADDS, so reuse still fits under the cap', async () => {
    // 1 root + 198 terminal children = 199. Two children — but one of them reuses an
    // existing prerequisite (same title AND description), so the call ADDS exactly one node
    // (200, at the cap). Counting the raw arity would refuse a split that fits.
    const filler = Array.from({ length: CAPACITY.maxNodesPerTree - 3 }, (_, i) => `fill-${String(i)}`)
    const { tree, rootId } = await seededTree([...filler, 'shared'])
    // One of the filler children carries the reusable node's title and description.
    const reusable = tree.nodesOf(rootId).find((node) => node.id === 'shared')
    expect(reusable?.title).toBe('shared')
    expect(tree.nodesOf(rootId)).toHaveLength(CAPACITY.maxNodesPerTree - 1)

    const accepted = await noteAndSplit(tree, rootId, 'mission-root', [
      { title: 'shared', description: reusable?.description ?? '', context: ['why'] },
      { title: 'brand new', description: 'd', context: [] },
    ])
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true)
    expect(accepted.ok && accepted.value.reused).toEqual(['shared'])
    // Still exactly one node titled 'shared': the reuse really reused.
    expect(tree.nodesOf(rootId).filter((node) => node.title === 'shared')).toHaveLength(1)
    expect(tree.nodesOf(rootId)).toHaveLength(CAPACITY.maxNodesPerTree)
  })
  it('counts a spec repeated inside ONE call once, so the cap cannot refuse a legal split', async () => {
    // 1 root + 198 = 199 nodes: one more fits, two would not. The call names the same spec twice, and
    // the loop reuses the node its own first occurrence creates — so it ADDS one. The pre-pass used to
    // charge two (it put a `'pending'` placeholder where the loop puts the created id, and
    // `findEquivalent` cannot resolve a placeholder), refusing a decompose that fits and reporting a
    // wrong number while doing it.
    const filler = Array.from({ length: CAPACITY.maxNodesPerTree - 2 }, (_, i) => `fill-${String(i)}`)
    const { tree, rootId } = await seededTree(filler)
    expect(tree.nodesOf(rootId)).toHaveLength(CAPACITY.maxNodesPerTree - 1)

    const accepted = await noteAndSplit(tree, rootId, 'mission-root', [
      { title: 'twice', description: 'same', context: [] },
      { title: 'TWICE', description: 'same ', context: [] },
    ])
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true)
    // One node created, and the second spec reused it (the loop reports the same id in both lists).
    expect(accepted.ok && accepted.value.created).toHaveLength(1)
    expect(accepted.ok && accepted.value.reused).toEqual(accepted.ok ? accepted.value.created : [])
    expect(tree.nodesOf(rootId).filter((node) => node.title.toLowerCase() === 'twice')).toHaveLength(1)
    expect(tree.nodesOf(rootId)).toHaveLength(CAPACITY.maxNodesPerTree)
  })
})

describe('the parked-session address', () => {
  /** A parent that decomposed once, with one terminal child: parked and waiting. */
  async function parkedParent(): Promise<{ tree: MissionTree; id: string; child: string }> {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-p1')
    const split = await noteAndSplit(tree, id, 'mission-p1', [
      { title: 'prerequisite', description: 'd', context: [] },
    ])
    if (!split.ok) throw new Error('decompose failed')
    const child = split.value.created[0] as string
    await tree.dispatch(child, 'mission-c1')
    await tree.submitResult(child, 'mission-c1', 'done')
    return { tree, id, child }
  }

  it('records the decomposing session and releases the claim, as before', async () => {
    const { tree, id } = await parkedParent()
    const node = tree.node(id)
    expect(node?.parkedWorker).toBe('mission-p1')
    // The claim is released exactly as it always was: nothing about "held" changed.
    expect(node?.claimedBy).toBeNull()
    // Children all terminal → the convergence pass is due.
    expect(node?.status).toBe('ready')
  })

  it('keeps a parked node out of the dispatch pool, and lets it back in once spent', async () => {
    // This is the difference between a live feature and dead code: `decompose_mission` is
    // followed by a synchronous `pump()` in the host, so a parked node offered here would
    // be handed to a brand new session before any wake could happen.
    const { tree, id } = await parkedParent()
    expect(tree.parkedReadyNodes().map((node) => node.id)).toEqual([id])
    // The scoped form is what a per-owner caller (the host's wake, the engine's report) uses;
    // an unrelated root id must come back empty rather than leaking a sibling tree's node.
    expect(tree.parkedReadyNodes(id).map((node) => node.id)).toEqual([id])
    expect(tree.parkedReadyNodes('no-such-root')).toEqual([])
    expect(tree.nextDispatchable()).toBeUndefined()

    // A fresh dispatch consumes the address — that is the fallback path.
    const dispatched = await tree.dispatch(id, 'mission-fresh')
    expect(dispatched.ok).toBe(true)
    expect(tree.node(id)?.parkedWorker).toBeNull()
  })

  it('adopts the parked session under its own id and consumes the address', async () => {
    const { tree, id } = await parkedParent()
    const adopted = await tree.adoptParked(id, 'mission-p1')
    expect(adopted.ok).toBe(true)
    expect(adopted.ok && adopted.value.node.claimedBy).toBe('mission-p1')
    expect(tree.node(id)?.parkedWorker).toBeNull()
    expect(tree.node(id)?.status).toBe('running')
    // The wake is a dispatch round like any other: `attempts` moves (the `note_mission` gate
    // reads it), and no failure budget is touched — waking is not failing.
    expect(tree.node(id)?.attempts).toBe(2)
    expect(tree.node(id)?.failures).toBe(0)
    expect(tree.node(id)?.spawnFailures).toBe(0)
  })

  it('refuses to adopt a session that no longer owns the node, with no effect', async () => {
    const { tree, id } = await parkedParent()
    const wrong = await tree.adoptParked(id, 'mission-somebody-else')
    expect(wrong.ok).toBe(false)
    expect(tree.node(id)?.parkedWorker).toBe('mission-p1')
    expect(tree.node(id)?.claimedBy).toBeNull()

    // And once the address is spent, the same call refuses too.
    await tree.dispatch(id, 'mission-fresh')
    const late = await tree.adoptParked(id, 'mission-p1')
    expect(late.ok).toBe(false)
  })

  it('undoes a failed adoption without charging any budget', async () => {
    // Delivery failed: the address is consumed and the node goes back to the pool as an
    // ordinary candidate. `spawn-failed` would be wrong twice over — it would burn the
    // start-failure budget on a cleaned-up session AND its cooldown would delay the very
    // fallback it exists to enable.
    const { tree, id } = await parkedParent()
    await tree.adoptParked(id, 'mission-p1')
    const undone = await tree.reclaim(id, 'wake-failed')
    expect(undone.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('ready')
    expect(tree.node(id)?.claimedBy).toBeNull()
    expect(tree.node(id)?.failures).toBe(0)
    expect(tree.node(id)?.spawnFailures).toBe(0)
    // Immediately dispatchable: no cooldown, because `spawnFailures` stayed at zero.
    expect(tree.nextDispatchable()?.id).toBe(id)
  })
})

describe('progress and stalls', () => {
  it('keeps observed activity in memory until the next flush', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')

    tree.touchProgress(id, 500)
    expect(tree.node(id)?.progressAt).toBe(500)
    // A worker appends far more events than a tree document should be written for,
    // so the durable copy only catches up at the flush.
    expect(store.documents.get(id)?.nodes.get(id)?.progressAt).not.toBe(500)

    await tree.flushProgress()
    expect(store.documents.get(id)?.nodes.get(id)?.progressAt).toBe(500)
  })

  it('ignores activity that is not newer, and activity for a node nobody runs', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    const at = tree.node(id)?.progressAt ?? 0

    tree.touchProgress(id, at)
    tree.touchProgress(id, at - 1)
    expect(tree.node(id)?.progressAt).toBe(at)

    await tree.submitResult(id, 'mission-1', 'done')
    tree.touchProgress(id, at + 10_000)
    expect(tree.node(id)?.progressAt).toBe(at)
  })

  it('counts a silent reclaim as a stall, and a vanished worker as nothing', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    await tree.reclaim(id)
    expect(tree.node(id)?.stalls).toBe(0)

    await tree.dispatch(id, 'mission-2')
    const stalled = await tree.reclaim(id, 'stalled')
    expect(stalled.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('interrupted')
    expect(tree.node(id)?.stalls).toBe(1)
  })

  it('lets the owner be told about one node’s stalls exactly once', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')

    expect(await tree.claimStallReport(id)).toBe(true)
    expect(await tree.claimStallReport(id)).toBe(false)
    expect(tree.node(id)?.stalledNotifiedAt).not.toBeNull()
    expect(store.documents.get(id)?.nodes.get(id)?.stalledNotifiedAt).not.toBeNull()
  })

  it('finds the node a worker session holds', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    expect(tree.nodeHeldBy('mission-1')?.id).toBe(id)
    expect(tree.nodeHeldBy('someone-else')).toBeUndefined()
  })
})

describe('deleting a finished tree', () => {
  /** A root with one child, both driven to `done`, returning their ids. */
  async function finishedPair(tree: MissionTree): Promise<{ root: string; child: string }> {
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    await noteAndSplit(tree, root, 'mission-root', [{ title: 'child', description: 'd', context: [] }])
    const child = tree.nodesOf(root).find((node) => node.parentId === root)
    if (child === undefined) throw new Error('child missing')
    await tree.dispatch(child.id, 'mission-child')
    await tree.submitResult(child.id, 'mission-child', 'child done')
    await tree.dispatch(root, 'mission-aggregate')
    await tree.submitResult(root, 'mission-aggregate', 'root done')
    return { root, child: child.id }
  }

  it('removes the tree, every node of it and its stored record', async () => {
    const { tree, store } = makeTree()
    const { root, child } = await finishedPair(tree)

    const deleted = await tree.deleteTree(root)
    expect(deleted.ok).toBe(true)
    // The whole tree, not just the node that was named.
    expect(deleted.ok === true && [...deleted.value].sort()).toEqual([root, child].sort())
    expect(tree.trees()).toHaveLength(0)
    expect(tree.node(root)).toBeUndefined()
    expect(tree.node(child)).toBeUndefined()
    expect(store.documents.has(root)).toBe(false)
  })

  it('refuses a tree that is still running, and points at cancel_mission', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')

    const refused = await tree.deleteTree(root)
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('not-deletable')
    expect(refused.ok === false && refused.message).toContain('只有已结束的任务能删除')
    expect(refused.ok === false && refused.message).toContain('cancel_mission')
    expect(tree.node(root)).toBeDefined()
  })

  it('deletes a tree whose root failed, which is how a cancelled tree leaves', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.cancelTree(root, 'owner')

    const deleted = await tree.deleteTree(root)
    expect(deleted.ok).toBe(true)
    expect(tree.trees()).toHaveLength(0)
  })

  it('refuses a node id that is not a tree root', async () => {
    // A node is not an addressable deletion target: the tree is.
    const { tree } = makeTree()
    const { child } = await finishedPair(tree)

    const refused = await tree.deleteTree(child)
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('not-found')
  })

  it('leaves the other trees alone', async () => {
    const { tree } = makeTree()
    const { root } = await finishedPair(tree)
    const other = await tree.createRoot({
      ownerSessionId: 'owner2', title: 'other', description: 'd', analysis: [],
    })
    if (!other.ok) throw new Error('second root failed')

    await tree.deleteTree(root)
    expect(tree.trees()).toHaveLength(1)
    expect(tree.node(other.value.id)).toBeDefined()
  })
})

describe('decompose and submit are mutually exclusive', () => {
  it('blocks the parent and makes children dispatchable', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    const split = await noteAndSplit(tree, id, 'mission-1', [
      { title: 'Find callers', description: 'list them', context: ['needed to size the change'] },
      { title: 'Write the shim', description: 'compat layer', context: ['avoid a flag day'] },
    ])
    expect(split.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('blocked')
    expect(tree.node(id)?.claimedBy).toBeNull()
    const ready = tree.nodesOf(id).filter((node) => node.status === 'ready')
    expect(ready).toHaveLength(2)
  })

  it('refuses decompose from a worker that does not hold the node', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    // Direct, not through `noteAndSplit`: a stranger cannot even open the analysis gate,
    // and the point here is the OWNERSHIP refusal answering first.
    const wrong = await tree.decompose(id, 'someone-else', [
      { title: 'x', description: 'y', context: [] },
    ])
    expect(wrong.ok).toBe(false)
    expect(wrong.ok === false && wrong.code).toBe('not-owner')
  })

  it('lets the aggregate pass submit the conclusion', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    await noteAndSplit(tree, id, 'mission-1', [{ title: 'child', description: 'd', context: [] }])
    // Decomposing releases the claim: the worker that split the mission is done with
    // it, and the node waits for its children.
    const stale = await tree.submitResult(id, 'mission-1', 'done')
    expect(stale.ok).toBe(false)
    expect(stale.ok === false && stale.code).toBe('not-owner')

    const child = tree.nodesOf(id).find((node) => node.parentId === id)
    if (child === undefined) throw new Error('child missing')
    await tree.dispatch(child.id, 'mission-child')
    await tree.submitResult(child.id, 'mission-child', 'child done')
    expect(tree.node(id)?.status).toBe('ready')

    // The aggregate pass is a real dispatch: it reads the children's conclusions
    // and states the outcome — this is how a decomposed node reaches `done`.
    await tree.dispatch(id, 'mission-aggregate')
    const asAggregate = await tree.submitResult(id, 'mission-aggregate', 'the conclusion')
    expect(asAggregate.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('done')
    expect(tree.node(id)?.result).toBe('the conclusion')
  })

  it('lets an aggregate that is still unsatisfied decompose again', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    const first = await noteAndSplit(tree, id, 'mission-1', [{ title: 'child', description: 'd', context: [] }])
    if (!first.ok) throw new Error('decompose failed')
    const child = first.value.created[0] as string
    await tree.dispatch(child, 'mission-child')
    await tree.submitResult(child, 'mission-child', 'partial')

    // The convergence pass judged the objective unmet and named what is missing.
    await tree.dispatch(id, 'mission-aggregate')
    const again = await noteAndSplit(tree, id, 'mission-aggregate', [
      { title: 'follow-up', description: 'finish it', context: ['the first result is partial'] },
    ])
    expect(again.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('blocked')
    expect(tree.node(id)?.children).toHaveLength(2)
  })

  it('refuses decompose once a worker submitted, by ownership first', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    await tree.submitResult(id, 'mission-1', 'done')
    // Submitting clears the claim, so the same worker no longer owns the node;
    // whatever the reason reported, the split must not happen. Called directly rather
    // than through `noteAndSplit` because the analysis gate can no longer be opened —
    // that refusal is covered by its own cases further down.
    const late = await tree.decompose(id, 'mission-1', [{ title: 'child', description: 'd', context: [] }])
    expect(late.ok).toBe(false)
    expect(tree.node(id)?.children).toHaveLength(0)
    expect(tree.node(id)?.status).toBe('done')
  })
})

describe('capacities', () => {
  it(`refuses a node at depth ${String(CAPACITY.maxDepth)}`, async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    let current = root
    for (let level = 1; level < CAPACITY.maxDepth; level += 1) {
      const claim = `chain-${String(level)}`
      await tree.dispatch(current, claim)
      const split = await noteAndSplit(tree, current, claim, [
        { title: `level ${String(level + 1)}`, description: 'd', context: [] },
      ])
      expect(split.ok).toBe(true)
      if (!split.ok) return
      current = split.value.created[0] as string
    }
    const holder = `chain-${String(CAPACITY.maxDepth)}`
    await tree.dispatch(current, holder)
    const tooDeep = await noteAndSplit(tree, current, holder, [
      { title: 'one more', description: 'd', context: [] },
    ])
    expect(tooDeep.ok).toBe(false)
    expect(tooDeep.ok === false && tooDeep.code).toBe('depth-exceeded')
  })

  it(`refuses more than ${String(CAPACITY.maxChildrenPerDecompose)} children`, async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    const tooMany = await noteAndSplit(tree, 
      id,
      'mission-1',
      Array.from({ length: CAPACITY.maxChildrenPerDecompose + 1 }, (_, index) => ({
        title: `child ${String(index)}`,
        description: 'd',
        context: [],
      })),
    )
    expect(tooMany.ok).toBe(false)
    expect(tooMany.ok === false && tooMany.code).toBe('too-many-children')
  })

  it('reuses a prerequisite another branch already created', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    const branches = await noteAndSplit(tree, root, 'mission-root', [
      { title: 'branch A', description: 'd', context: [] },
      { title: 'branch B', description: 'd', context: [] },
    ])
    if (!branches.ok) throw new Error('decompose failed')
    const [a, b] = branches.value.created as [string, string]

    await tree.dispatch(a, 'mission-a')
    const first = await noteAndSplit(tree, a, 'mission-a', [
      { title: 'Find callers', description: 'd', context: ['A needs them sized'] },
    ])
    expect(first.ok).toBe(true)
    const shared = first.ok ? (first.value.created[0] as string) : ''

    // Branch B independently discovers the same gap: it must reuse the node A
    // created rather than duplicate the mission.
    await tree.dispatch(b, 'mission-b')
    const second = await noteAndSplit(tree, b, 'mission-b', [
      { title: '  find   CALLERS ', description: 'd', context: ['B needs them listed'] },
    ])
    expect(second.ok).toBe(true)
    expect(second.ok && second.value.created).toHaveLength(0)
    expect(second.ok && second.value.reused).toEqual([shared])

    // Both branches wait on the one node, and both become ready when it lands.
    expect(tree.node(a)?.status).toBe('blocked')
    expect(tree.node(b)?.status).toBe('blocked')
    expect(tree.node(shared)?.context).toEqual(['A needs them sized', 'B needs them listed'])
    await tree.dispatch(shared, 'mission-shared')
    await tree.submitResult(shared, 'mission-shared', 'twelve callers')
    expect(tree.node(a)?.status).toBe('ready')
    expect(tree.node(b)?.status).toBe('ready')
  })

  it('does not reuse on a title alone: same title, different mission stays separate', async () => {
    // Titles are not unique in practice ("补充测试" can name unrelated missions in two branches).
    // A false reuse hands the later branch a node whose RESULT answers a different question,
    // and nothing in the tree shows that it did — so the match covers the description too.
    // The whitespace-insensitive match still applies, and reuse still fires within one call.
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    const branches = await noteAndSplit(tree, root, 'mission-root', [
      { title: 'branch A', description: 'd', context: [] },
      { title: 'branch B', description: 'd', context: [] },
    ])
    if (!branches.ok) throw new Error('decompose failed')
    const [a, b] = branches.value.created as [string, string]

    // A names two different missions that share a title, plus a whitespace variant of the
    // first: exactly one reuse (the variant) and one new node (the different mission).
    await tree.dispatch(a, 'mission-a')
    const split = await noteAndSplit(tree, a, 'mission-a', [
      { title: '补充测试', description: '补上 HTTP 层的边界用例', context: [] },
      { title: '  补充测试 ', description: ' 补上 HTTP 层的边界用例  ', context: ['还要覆盖超时'] },
      { title: '补充测试', description: '补上解析器的边界用例', context: [] },
    ])
    expect(split.ok, JSON.stringify(split)).toBe(true)
    if (!split.ok) return
    expect(split.value.created).toHaveLength(2)
    expect(split.value.reused).toHaveLength(1)
    expect(tree.nodesOf(root).filter((node) => node.title.trim() === '补充测试')).toHaveLength(2)

    // B independently needs the FIRST one: same title AND same description → reuse, from
    // another branch's subtree (which is what the dedup exists for).
    const before = tree.nodesOf(root).length
    const dispatched = await tree.dispatch(b, 'mission-b')
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
    const again = await noteAndSplit(tree, b, 'mission-b', [
      { title: '补充测试', description: '补上 HTTP 层的边界用例', context: ['B 也要'] },
    ])
    expect(again.ok && again.value.created).toHaveLength(0)
    expect(again.ok && again.value.reused).toHaveLength(1)
    expect(tree.nodesOf(root)).toHaveLength(before)
  })

  it('makes a parent immediately ready when the reused prerequisite is already done', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    const branches = await noteAndSplit(tree, root, 'mission-root', [
      { title: 'branch A', description: 'd', context: [] },
      { title: 'branch B', description: 'd', context: [] },
    ])
    if (!branches.ok) throw new Error('decompose failed')
    const [a, b] = branches.value.created as [string, string]

    // A finishes the prerequisite before B ever asks for it.
    await tree.dispatch(a, 'mission-a')
    const doneA = await noteAndSplit(tree, a, 'mission-a', [
      { title: 'find callers', description: 'd', context: [] },
    ])
    if (!doneA.ok) throw new Error('decompose failed')
    const shared = doneA.value.created[0] as string
    await tree.dispatch(shared, 'mission-shared')
    await tree.submitResult(shared, 'mission-shared', 'twelve callers')

    // B reuses a satisfied prerequisite: it must not wait on anything.
    await tree.dispatch(b, 'mission-b')
    const doneB = await noteAndSplit(tree, b, 'mission-b', [
      { title: 'Find callers', description: 'd', context: [] },
    ])
    expect(doneB.ok && doneB.value.reused).toEqual([shared])
    expect(tree.node(b)?.status).toBe('ready')
  })

  it('never reuses the node itself or an ancestor', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    const first = await noteAndSplit(tree, root, 'mission-root', [
      { title: 'Find callers', description: 'd', context: [] },
    ])
    if (!first.ok) throw new Error('decompose failed')
    const child = first.value.created[0] as string
    await tree.dispatch(child, 'mission-child')

    // Its own title and its ancestor's: both would make the node contain itself.
    const split = await noteAndSplit(tree, child, 'mission-child', [
      { title: '  FIND   callers ', description: 'd', context: [] },
      { title: 'Root mission', description: 'd', context: [] },
      { title: 'sibling of the first', description: 'd', context: [] },
    ])
    expect(split.ok).toBe(true)
    if (!split.ok) return
    expect(split.value.reused).toEqual([])
    expect(split.value.created).toHaveLength(3)
    const [selfTitle, ancestorTitle, twinTitle] = split.value.created as [string, string, string]
    expect(tree.node(child)?.children).not.toContain(child)
    expect(tree.node(child)?.children).not.toContain(root)
    // The twin is a legitimate reuse: this very call already created it.
    expect(tree.node(selfTitle)?.title).toBe('  FIND   callers ')
    expect(tree.node(ancestorTitle)?.title).toBe('Root mission')
    expect(tree.node(twinTitle)?.parentId).toBe(child)

    // Within one call, a repeated title reuses the child created moments ago.
    const rootAgain = await tree.createRoot({
      ownerSessionId: 'owner',
      title: 'Another root',
      description: 'd',
      analysis: [],
    })
    if (!rootAgain.ok) throw new Error('root failed')
    await tree.dispatch(rootAgain.value.id, 'mission-2')
    const twins = await noteAndSplit(tree, rootAgain.value.id, 'mission-2', [
      { title: 'same thing', description: 'd', context: [] },
      { title: 'SAME THING', description: 'd', context: [] },
    ])
    expect(twins.ok && twins.value.created).toHaveLength(1)
    expect(twins.ok && twins.value.reused).toHaveLength(1)
  })
})

describe('aggregation readiness', () => {
  it('returns the parent to ready once every child is terminal', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    const split = await noteAndSplit(tree, root, 'mission-root', [
      { title: 'a', description: 'd', context: [] },
      { title: 'b', description: 'd', context: [] },
    ])
    if (!split.ok) throw new Error('decompose failed')
    const [first, second] = split.value.created as [string, string]

    await tree.dispatch(first, 'mission-a')
    const doneA = await tree.submitResult(first, 'mission-a', 'a is done')
    expect(doneA.ok && doneA.value.parentReady).toBe(false)
    expect(tree.node(root)?.status).toBe('blocked')

    await tree.dispatch(second, 'mission-b')
    const doneB = await tree.submitResult(second, 'mission-b', 'b is done')
    expect(doneB.ok && doneB.value.parentReady).toBe(true)
    expect(tree.node(root)?.status).toBe('ready')
  })

  it('exposes terminal children only for an aggregate', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    await noteAndSplit(tree, root, 'mission-root', [{ title: 'a', description: 'd', context: [] }])
    const child = tree.nodesOf(root).find((node) => node.parentId === root)
    expect(child).toBeDefined()
    await tree.dispatch(child?.id ?? '', 'mission-a')
    await tree.submitResult(child?.id ?? '', 'mission-a', 'result text')
    const view = tree.view(root)
    expect(view?.children).toHaveLength(1)
    expect(view?.children[0]?.result).toBe('result text')
  })

  it('spills an over-long result and keeps a pointer WITH its retrieval hint', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    const long = 'x'.repeat(CAPACITY.maxInlineResultChars + 100)
    const submitted = await tree.submitResult(id, 'mission-1', long)
    expect(submitted.ok).toBe(true)
    const node = tree.node(id)
    expect(node?.resultRef).toBe(`spill:${String(long.length)}`)
    expect(node?.resultHint).toBe('read it with the read tool')
    expect(node?.result).toHaveLength(CAPACITY.maxInlineResultChars)
  })

  it('keeps the whole result inline when no spill backend exists', async () => {
    // A locator nobody can resolve loses the tail outright, so degrading to a
    // larger node is the correct fallback.
    const { tree } = makeTree({ spill: false })
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    const long = 'x'.repeat(CAPACITY.maxInlineResultChars + 100)
    const submitted = await tree.submitResult(id, 'mission-1', long)
    expect(submitted.ok).toBe(true)
    expect(tree.node(id)?.result).toHaveLength(long.length)
    expect(tree.node(id)?.resultRef).toBeNull()
    expect(tree.node(id)?.resultHint).toBeNull()
  })
})

describe('reconcile on open', () => {
  it('reclaims a binding whose agent no longer exists', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-gone')

    // A fresh process: same durable state, the worker is gone, the owner is back.
    const reopened = new MissionTree(store, {
      isAgentLive: (sessionId) => sessionId === 'owner',
      probeOwner: () => Promise.resolve({ kind: 'exists' }),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'fresh',
    })
    await reopened.open()
    expect(reopened.node(id)?.status).toBe('interrupted')
    expect(reopened.nextDispatchable()?.id).toBe(id)
  })

  it('keeps a binding whose agent is still live (hot reload)', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-live')

    const reopened = new MissionTree(store, {
      isAgentLive: (sessionId) => sessionId === 'mission-live' || sessionId === 'owner',
      probeOwner: () => Promise.resolve({ kind: 'exists' }),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'fresh',
    })
    await reopened.open()
    expect(reopened.node(id)?.status).toBe('running')
    expect(reopened.nextDispatchable()).toBeUndefined()
  })

  it('does not dispatch a tree whose owner is not live yet', async () => {
    // A restarted host has no live agents until a client opens the session; the
    // tree must wait rather than burn its attempts on workers it cannot start.
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    const reopened = new MissionTree(store, {
      isAgentLive: () => false,
      probeOwner: () => Promise.resolve({ kind: 'exists' }),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'fresh',
    })
    await reopened.open()
    expect(reopened.node(id)?.status).toBe('ready')
    expect(reopened.nextDispatchable()).toBeUndefined()
  })

  it('reports a tree whose owner session is gone, and keeps one whose session exists', async () => {
    const gone = makeTree()
    await rootOf(gone.tree)
    const reopened = new MissionTree(gone.store, {
      isAgentLive: () => false,
      probeOwner: () => Promise.resolve({ kind: 'missing' }),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'fresh',
    })
    await reopened.open()
    const orphans = await reopened.orphanedTrees()
    expect(orphans).toHaveLength(1)
    expect(orphans[0]?.probe).toEqual({ kind: 'missing' })
    await reopened.destroyTree(orphans[0]?.tree.rootId ?? '')
    expect(reopened.trees()).toHaveLength(0)
    expect(gone.store.documents.size).toBe(0)

    // The same durable state with the session still on disk: the tree survives a
    // restart, which is the whole point of asking storage instead of the registry.
    const kept = makeTree()
    await rootOf(kept.tree)
    const survivor = new MissionTree(kept.store, {
      isAgentLive: () => false,
      probeOwner: () => Promise.resolve({ kind: 'exists' }),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'fresh',
    })
    await survivor.open()
    expect(await survivor.orphanedTrees()).toHaveLength(0)
    expect(survivor.trees()).toHaveLength(1)
  })

  it('separates the three owner states, carrying the detail for an unobservable one', async () => {
    // Three owners, one per verdict: gone, opaque, and present. The middle one is the
    // regression guard — "cannot tell" must not collapse into either yes or no.
    const world = makeTree({ owners: new Set(['owner']), unobservable: new Set(['opaque']) })
    await rootOf(world.tree)
    await world.tree.createRoot({ ownerSessionId: 'gone', title: 'g', description: 'd', analysis: [] })
    await world.tree.createRoot({ ownerSessionId: 'opaque', title: 'o', description: 'd', analysis: [] })

    const orphans = await world.tree.orphanedTrees()
    const byOwner = new Map(orphans.map((entry) => [entry.tree.ownerSessionId, entry.probe]))
    expect(byOwner.get('owner')).toBeUndefined()
    expect(byOwner.get('gone')).toEqual({ kind: 'missing' })
    expect(byOwner.get('opaque')).toEqual({ kind: 'unobservable', detail: 'stubbed: cannot read opaque' })
  })
})

describe('finish and cancel', () => {
  it('refuses to finish before the result is read', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    await tree.submitResult(id, 'mission-1', 'the answer')

    const early = await tree.finish(id, 'owner')
    expect(early.ok).toBe(false)
    expect(early.ok === false && early.code).toBe('unread-result')

    await tree.markResultRead(id)
    const ok = await tree.finish(id, 'owner')
    expect(ok.ok).toBe(true)
  })

  it('refuses a foreign session and honours the owner', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    const foreign = await tree.finish(id, 'intruder')
    expect(foreign.ok).toBe(false)
    expect(foreign.ok === false && foreign.code).toBe('not-owner')
  })

  it('closes a failed root too, and retires the tree from the pool', async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    // Exhaust the attempts: the root ends `failed`, which is exactly the tree the
    // owner must be told about and then retire.
    for (let attempt = 0; attempt < CAPACITY.maxAttempts; attempt += 1) {
      const claim = `mission-${String(attempt)}`
      await tree.dispatch(id, claim)
      live.delete(claim)
      await tree.reclaim(id)
      live.add(claim)
    }
    await tree.dispatch(id, 'mission-final')
    expect(tree.node(id)?.status).toBe('failed')

    const unread = await tree.finish(id, 'owner')
    expect(unread.ok === false && unread.code).toBe('unread-result')
    await tree.markResultRead(id)
    expect((await tree.finish(id, 'owner')).ok).toBe(true)
    expect(tree.treeOf(id)?.closedAt).not.toBeNull()
    // Archived: never dispatched again, and no longer counted in the rollup.
    expect(tree.nextDispatchable()).toBeUndefined()
    expect(tree.summary().trees).toBe(0)
    expect(tree.nodesOf(id)).toHaveLength(1)
  })

  it('fails every unfinished node on cancel and keeps submitted results', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    const split = await noteAndSplit(tree, root, 'mission-root', [
      { title: 'a', description: 'd', context: [] },
      { title: 'b', description: 'd', context: [] },
    ])
    if (!split.ok) throw new Error('decompose failed')
    const [first, second] = split.value.created as [string, string]
    await tree.dispatch(first, 'mission-a')
    await tree.submitResult(first, 'mission-a', 'kept')

    const cancelled = await tree.cancelTree(root, 'owner')
    expect(cancelled.ok).toBe(true)
    expect(tree.node(first)?.status).toBe('done')
    expect(tree.node(first)?.result).toBe('kept')
    expect(tree.node(second)?.status).toBe('failed')
    expect(tree.node(root)?.status).toBe('failed')
  })
})

describe('convergence', () => {
  /**
   * The acceptance case the whole design exists for: a three-level tree where a
   * node is attempted, decomposes, gets its conclusions, and the root submits.
   * Before this test existed the aggregate pass could neither submit nor
   * decompose, so every decomposed node died at its attempt ceiling.
   */
  it('runs a three-level tree to a done root', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)

    // 1. The root is attempted, hits a prerequisite, and decomposes.
    await tree.dispatch(root, 'w-root-1')
    const level2 = await noteAndSplit(tree, root, 'w-root-1', [
      { title: 'survey', description: 'find the callers', context: ['the root needs them'] },
      { title: 'design', description: 'pick the shape', context: ['the root needs a shape'] },
    ])
    if (!level2.ok) throw new Error('decompose failed')
    const [survey, design] = level2.value.created as [string, string]

    // 2. `survey` cannot finish either: it decomposes one level deeper.
    await tree.dispatch(survey, 'w-survey-1')
    const level3 = await noteAndSplit(tree, survey, 'w-survey-1', [
      { title: 'grep', description: 'list call sites', context: ['the survey needs the list'] },
    ])
    if (!level3.ok) throw new Error('decompose failed')
    const grep = level3.value.created[0] as string

    // 3. The deepest node finishes; its parent aggregates and converges.
    await tree.dispatch(grep, 'w-grep')
    await tree.submitResult(grep, 'w-grep', 'twelve call sites')
    expect(tree.node(survey)?.status).toBe('ready')
    await tree.dispatch(survey, 'w-survey-2')
    const surveyed = await tree.submitResult(survey, 'w-survey-2', 'callers: twelve, all in api/')
    expect(surveyed.ok && surveyed.value.parentReady).toBe(false)

    // 4. The sibling finishes; now the root is an aggregate.
    await tree.dispatch(design, 'w-design')
    await tree.submitResult(design, 'w-design', 'one shim, deleted next release')
    expect(tree.node(root)?.status).toBe('ready')

    // 5. The root's convergence pass submits the conclusion.
    await tree.dispatch(root, 'w-root-2')
    const done = await tree.submitResult(root, 'w-root-2', 'migration planned')
    expect(done.ok && done.value.parentReady).toBe(false)
    expect(tree.node(root)?.status).toBe('done')

    // 6. The owner reads and closes it out.
    expect((await tree.markResultRead(root)).ok).toBe(true)
    expect((await tree.finish(root, 'owner')).ok).toBe(true)
    expect(tree.treeOf(root)?.closedAt).not.toBeNull()
  })
})

describe('dispatch ordering', () => {
  it('picks the oldest candidate across trees', async () => {
    const { tree } = makeTree()
    const first = await rootOf(tree)
    const second = await rootOf(tree)
    expect(first).not.toBe(second)
    // The second root is newer, so the first must win regardless of insertion order.
    expect(tree.nextDispatchable()?.id).toBe(first)
  })

  it('skips candidates in the exclusion set', async () => {
    const { tree } = makeTree()
    const first = await rootOf(tree)
    const second = await rootOf(tree)
    expect(tree.nextDispatchable(new Set([first]))?.id).toBe(second)
  })
})

describe('corrections and sub-mission cancellation', () => {
  it('records a correction on the node, once', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')

    const first = await tree.correct(root, 'owner', '方向不对')
    expect(first.ok).toBe(true)
    // Corrections live in their own field: `context` is the decomposer's "why this exists".
    expect(tree.node(root)?.corrections).toEqual(['方向不对'])
    expect(tree.node(root)?.context).not.toContain('方向不对')
    await tree.correct(root, 'owner', '方向不对')
    expect(tree.node(root)?.corrections).toHaveLength(1)
  })

  it('refuses a correction from another session, and on a finished mission', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')

    const stranger = await tree.correct(root, 'someone-else', 'x')
    expect(stranger.ok).toBe(false)
    expect(stranger.ok === false && stranger.code).toBe('not-owner')

    await tree.cancelTree(root, 'owner')
    const finished = await tree.correct(root, 'owner', 'x')
    expect(finished.ok).toBe(false)
    expect(finished.ok === false && finished.code).toBe('terminal')
  })

  it('cancels the whole sub-tree below a held node, and nothing else', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    await noteAndSplit(tree, root, 'mission-root', [
      { title: 'A', description: 'a', context: ['why'] },
      { title: 'B', description: 'b', context: ['why'] },
    ])
    const a = tree.nodesOf(root).find((node) => node.title === 'A')
    const b = tree.nodesOf(root).find((node) => node.title === 'B')
    if (a === undefined || b === undefined) throw new Error('children missing')
    await tree.dispatch(a.id, 'mission-a')
    await noteAndSplit(tree, a.id, 'mission-a', [{ title: 'A1', description: 'x', context: [] }])
    const a1 = tree.nodesOf(root).find((node) => node.title === 'A1')
    if (a1 === undefined) throw new Error('grandchild missing')

    // The tree OWNER is the caller that can reach this: the root is blocked on its children,
    // so it holds no claim and there is no executor to ask.
    const cancelled = await tree.cancelSubworks(root, 'owner')
    expect(cancelled.ok).toBe(true)
    expect(cancelled.ok === true && [...cancelled.value].map((node) => node.id).sort())
      .toEqual([a.id, a1.id, b.id].sort())
    for (const id of [a.id, a1.id, b.id]) {
      expect(tree.node(id)?.status).toBe('failed')
      expect(tree.node(id)?.result).toBe('被父任务取消')
      expect(tree.node(id)?.claimedBy).toBeNull()
    }
    // The node itself is untouched and, with nothing pending below it, ready for its
    // convergence pass. It goes through the WAKE path, not the dispatch pool: the session
    // that decomposed here is parked on the node and must be the one to judge what happened
    // to the children it created (`nextDispatchable` deliberately excludes parked nodes).
    expect(tree.node(root)?.claimedBy).toBeNull()
    expect(tree.node(root)?.status).toBe('ready')
    expect(tree.parkedReadyNodes().map((node) => node.id)).toEqual([root])
    expect(tree.nextDispatchable()).toBeUndefined()
  })

  it('refuses cancellation from anyone but the owner or the holder', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    await noteAndSplit(tree, root, 'mission-root', [{ title: 'A', description: 'a', context: ['why'] }])

    const refused = await tree.cancelSubworks(root, 'someone-else')
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('not-owner')
    expect(tree.nodesOf(root).filter((node) => node.status === 'failed')).toHaveLength(0)
  })

  it('recomputes EVERY parent of a shared prerequisite, not just the one it started from', async () => {
    // A reused prerequisite is listed by several parents. Cancelling one branch's sub-tree used
    // to strand the other parent in `blocked` forever — not dispatchable, and nothing else
    // recomputed it — so the whole tree could never converge.
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')
    await noteAndSplit(tree, root, 'mission-root', [
      { title: 'P', description: 'p', context: ['why'] },
      { title: 'Q', description: 'q', context: ['why'] },
    ])
    const p = tree.nodesOf(root).find((node) => node.title === 'P')
    const q = tree.nodesOf(root).find((node) => node.title === 'Q')
    if (p === undefined || q === undefined) throw new Error('branches missing')
    await tree.dispatch(p.id, 'mission-p')
    await noteAndSplit(tree, p.id, 'mission-p', [{ title: 'X', description: 'x', context: ['why'] }])
    const x = tree.nodesOf(root).find((node) => node.title === 'X')
    if (x === undefined) throw new Error('shared missing')
    // Q names the same prerequisite, so the dedup reuses P's node.
    await tree.dispatch(q.id, 'mission-q')
    const reused = await noteAndSplit(tree, q.id, 'mission-q', [{ title: 'X', description: 'x', context: ['why'] }])
    expect(reused.ok === true && reused.value.reused).toEqual([x.id])

    const cancelled = await tree.cancelSubworks(q.id, 'owner')
    expect(cancelled.ok === true && cancelled.value.map((node) => node.id)).toEqual([x.id])
    expect(tree.node(x.id)?.status).toBe('failed')
    // BOTH parents were blocked on the shared prerequisite, so both are now ready for a
    // convergence pass — and both are parked on the session that decomposed them, so they
    // leave the pool through the wake path rather than being dispatched fresh.
    expect(tree.node(p.id)?.status).toBe('ready')
    expect(tree.node(q.id)?.status).toBe('ready')
    expect([...tree.parkedReadyNodes()].map((node) => node.id).sort()).toEqual([p.id, q.id].sort())
    expect(tree.nextDispatchable()).toBeUndefined()
  })

  it('refuses when nothing below is unfinished', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'mission-root')

    const refused = await tree.cancelSubworks(root, 'mission-root')
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('nothing-to-cancel')
  })
})

describe('analysis and the decompose gate', () => {
  it('records one entry per non-blank line, trimmed, attributed to the current dispatch', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')

    const recorded = await tree.recordAnalysis(id, 'mission-1', '  缺前置事实：先拿到调用点清单  \n\n  再判断改动范围\n')
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) return
    expect(recorded.value.analysisNotes).toEqual(['缺前置事实：先拿到调用点清单', '再判断改动范围'])
    expect(recorded.value.analysisAttempt).toBe(1)
    // The write is durable, not just in memory.
    expect(tree.node(id)?.analysisNotes).toHaveLength(2)
  })

  it('appends without duplicating, and re-stamps the NEW dispatch', async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    await tree.recordAnalysis(id, 'mission-1', '结论 A\n结论 B')
    // The same text again is a no-op entry-wise, but it still stamps this dispatch.
    await tree.recordAnalysis(id, 'mission-1', '结论 A')

    live.delete('mission-1')
    await tree.reclaim(id)
    await tree.dispatch(id, 'mission-2')
    const again = await tree.recordAnalysis(id, 'mission-2', '结论 A\n结论 C')
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.analysisNotes).toEqual(['结论 A', '结论 B', '结论 C'])
    expect(again.value.analysisAttempt).toBe(2)
  })

  it('refuses a caller that does not hold the mission', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    const stranger = await tree.recordAnalysis(id, 'someone-else', '让我也记一笔')
    expect(stranger.ok).toBe(false)
    expect(stranger.ok === false && stranger.code).toBe('not-owner')
    expect(tree.node(id)?.analysisNotes).toEqual([])
  })

  it('refuses blank text, and a terminal mission', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    const blank = await tree.recordAnalysis(id, 'mission-1', '   \n\n\t ')
    expect(blank.ok).toBe(false)
    expect(blank.ok === false && blank.code).toBe('no-analysis')

    // A terminal mission is reachable only through the aggregate pass, and that pass
    // clears the claim on success — so what a later `recordAnalysis` gets is the
    // ownership refusal, with the terminal rule standing behind it as the guard for
    // a node failed while still claimed (see `dispatch`'s attempt exhaustion).
    await tree.recordAnalysis(id, 'mission-1', '先写下这一轮的分析')
    await tree.decompose(id, 'mission-1', [{ title: 'child', description: 'd', context: [] }])
    const child = tree.nodesOf(id).find((node) => node.parentId === id)
    if (child === undefined) throw new Error('child missing')
    await tree.dispatch(child.id, 'mission-child')
    await tree.submitResult(child.id, 'mission-child', 'child done')
    await tree.dispatch(id, 'mission-aggregate')
    await tree.submitResult(id, 'mission-aggregate', 'done')
    expect(tree.node(id)?.status).toBe('done')
    expect(tree.node(id)?.claimedBy).toBeNull()
    const late = await tree.recordAnalysis(id, 'mission-aggregate', '太晚了')
    expect(late.ok).toBe(false)
    expect(late.ok === false && late.code).toBe('not-owner')
    // Nothing was written by either refused call.
    expect(tree.node(id)?.analysisNotes).toEqual(['先写下这一轮的分析'])
  })

  it('makes the node carry empty analysis fields from birth', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    expect(tree.node(id)?.analysisNotes).toEqual([])
    expect(tree.node(id)?.analysisAttempt).toBe(0)
  })

  it('refuses a split that has not written THIS dispatch analysis, with zero side effects', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')

    const refused = await tree.decompose(id, 'mission-1', [{ title: 'child', description: 'd', context: ['why'] }])
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('analysis-missing')
    expect(refused.ok === false && refused.message).toContain('note_mission')
    // No child, no attempt burned, the caller still holds the mission.
    expect(tree.node(id)?.children).toEqual([])
    expect(tree.node(id)?.attempts).toBe(1)
    expect(tree.node(id)?.status).toBe('running')
    expect(tree.node(id)?.claimedBy).toBe('mission-1')
    expect(tree.nodesOf(id)).toHaveLength(1)
  })

  it('admits the split once this dispatch wrote its analysis, and closes again after a re-dispatch', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    await tree.recordAnalysis(id, 'mission-1', '第一次为什么拆')
    const first = await tree.decompose(id, 'mission-1', [{ title: 'child', description: 'd', context: [] }])
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const child = first.value.created[0] as string
    await tree.dispatch(child, 'mission-child')
    await tree.submitResult(child, 'mission-child', 'partial')

    // The aggregate pass is a NEW dispatch under a NEW claim: the note that justified
    // the first split is not an argument for the second.
    await tree.dispatch(id, 'mission-aggregate')
    const refused = await tree.decompose(id, 'mission-aggregate', [
      { title: 'follow-up', description: 'finish it', context: [] },
    ])
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('analysis-missing')

    await tree.recordAnalysis(id, 'mission-aggregate', '这次为什么还缺')
    const again = await tree.decompose(id, 'mission-aggregate', [
      { title: 'follow-up', description: 'finish it', context: [] },
    ])
    expect(again.ok).toBe(true)
    expect(tree.node(id)?.analysisNotes).toEqual(['第一次为什么拆', '这次为什么还缺'])
    expect(tree.node(id)?.analysisAttempt).toBe(2)
  })
})

/**
 * The cold wake: an interruption that only a restart can cause must not throw the worker session
 * away. `reconcileOnOpen` demotes the `running` node, but parks its session id in `lastWorkerId`
 * first; the next dispatch tries to continue that session and falls back to a fresh one on refusal,
 * charging nothing for the attempt.
 */
function reopen(
  store: TreeStore,
  options: { live?: readonly string[] } = {},
): MissionTree {
  const live = new Set(options.live ?? ['owner'])
  return new MissionTree(store, {
    isAgentLive: (sessionId) => live.has(sessionId),
    probeOwner: () => Promise.resolve({ kind: 'exists' }),
    spill: () => Promise.resolve(null),
    now: () => 1,
    newId: () => 'fresh',
  })
}

/** The persisted document with a field ABSENT, as an earlier release wrote it. */
function withoutField(state: TreeState, nodeId: string, field: string): TreeState {
  const nodes = new Map(state.nodes)
  const stripped: Record<string, unknown> = { ...nodes.get(nodeId) }
  delete stripped[field]
  nodes.set(nodeId, stripped as unknown as NodeRecord)
  return { tree: state.tree, nodes }
}

/** The persisted document with one field REPLACED, however malformed a fixture needs it. */
function withField(state: TreeState, nodeId: string, field: string, value: unknown): TreeState {
  const nodes = new Map(state.nodes)
  nodes.set(nodeId, { ...nodes.get(nodeId), [field]: value } as unknown as NodeRecord)
  return { tree: state.tree, nodes }
}

describe('the dispatch baseline', () => {
  it('stamps the live dispatch at the prompt, and refuses anybody else', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    // A node nothing has been dispatched for has nothing to subtract later.
    expect(tree.node(id)?.dispatchBaseline).toBeNull()
    await tree.dispatch(id, 'mission-1')

    // The baseline belongs to the dispatch that is BOUND: a stamp from anyone else (a re-dispatched
    // node still carrying an old holder, a lost race with a sweep) must not land.
    expect(await tree.recordDispatchBaseline(id, 'mission-other')).toBe(false)
    expect(tree.node(id)?.dispatchBaseline).toBeNull()

    expect(await tree.recordDispatchBaseline(id, 'mission-1')).toBe(true)
    const baseline = tree.node(id)?.dispatchBaseline
    expect(baseline?.attempts).toBe(1)
    expect(baseline?.corrections).toBe(0)
    expect(baseline?.notes).toBe(0)
    expect(baseline?.terminalChildren).toBe(0)
    expect(baseline?.fingerprint).toBe(nodeFingerprint('Root mission', 'Do the whole thing'))

    // Once the node is no longer running under that holder, the prompt is history: no more stamps.
    await tree.reclaim(id, 'vanished')
    expect(await tree.recordDispatchBaseline(id, 'mission-1')).toBe(false)
  })

  it('reads a missing or truncated baseline as UNKNOWN, never as "nothing changed"', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-legacy')
    await tree.recordDispatchBaseline(id, 'mission-legacy')
    const state = store.documents.get(id)
    if (state === undefined) throw new Error('nothing was persisted')

    // Absent: the field did not exist yet.
    store.documents.set(id, withoutField(state, id, 'dispatchBaseline'))
    let reopened = reopen(store)
    await reopened.open()
    expect(reopened.node(id)?.dispatchBaseline).toBeNull()
    expect(reopened.continuationDelta(id)?.baselineKnown).toBe(false)

    // Present but truncated: a half-read snapshot is worse than none, so it is discarded too.
    store.documents.set(id, withField(state, id, 'dispatchBaseline', { corrections: 1 }))
    reopened = reopen(store)
    await reopened.open()
    expect(reopened.node(id)?.dispatchBaseline).toBeNull()
    expect(reopened.continuationDelta(id)?.baselineKnown).toBe(false)
  })

  it('spends a handle without dispatching, charging nothing', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-gone')
    const reopened = reopen(store)
    await reopened.open()
    expect(reopened.node(id)?.lastWorkerId).toBe('mission-gone')

    // A handle that is not the one on the node is not this caller's to spend.
    expect((await reopened.abandonContinuation(id, 'mission-other')).ok).toBe(false)
    expect(reopened.node(id)?.lastWorkerId).toBe('mission-gone')

    const spent = await reopened.abandonContinuation(id, 'mission-gone')
    expect(spent.ok).toBe(true)
    const node = reopened.node(id)
    expect(node?.lastWorkerId).toBeNull()
    // Exactly where it was: the handle is spent, no dispatch happened, no budget moved. The fresh
    // path picks the node up from here.
    expect(node?.status).toBe('interrupted')
    expect(node?.attempts).toBe(1)
    expect(node?.failures).toBe(0)
    expect(node?.spawnFailures).toBe(0)
    expect((await reopened.adoptContinuation(id, 'mission-gone')).ok).toBe(false)
  })

  it('counts terminal children as drift but never as a reason to refuse a parked wake', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-parked')
    await tree.recordDispatchBaseline(id, 'mission-parked')
    const split = await noteAndSplit(tree, id, 'mission-parked', [
      { title: 'child', description: 'd', context: [] },
    ])
    const child = split.ok ? split.value.created[0] ?? '' : ''
    await tree.dispatch(child, 'mission-child')
    await tree.submitResult(child, 'mission-child', 'child conclusion')

    // The parent is parked-ready: every child terminal, and the session that decomposed it waiting.
    expect(tree.parkedReadyNodes().map((node) => node.id)).toEqual([id])
    const parked = tree.continuationDelta(id)
    expect(parked?.baselineKnown).toBe(true)
    expect(parked?.terminalChildren).toBe(1)
    expect(parked?.notes).toEqual(['这次为什么拆：缺一个前置事实'])
    // The engine's own trigger for the wake must not read as drift — otherwise no parked session
    // would ever be woken, and `session-continuation.spec.ts` would be testing a dead path.
    expect(parked).toBeDefined()
    expect(isMaterialChange(parked!)).toBe(false)
  })

  it('treats an unread correction as drift, and one the prompt already carried as nothing', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    await tree.recordDispatchBaseline(id, 'mission-1')
    await tree.correct(id, 'owner', '改成先做 C')

    const arrived = tree.continuationDelta(id)
    expect(arrived?.corrections).toEqual(['改成先做 C'])
    expect(isMaterialChange(arrived!)).toBe(true)

    // Delivered live to the holder: that session has read it, so continuing it is honest again. This
    // is the second half of the correction arithmetic — the watermark.
    await tree.markCorrectionsDelivered(id, 1)
    const read = tree.continuationDelta(id)
    expect(read?.corrections).toEqual([])
    expect(isMaterialChange(read!)).toBe(false)

    // And a correction that existed BEFORE the prompt is not drift, even though a fresh spawn never
    // advances the watermark: the prompt rendered it, which is what the baseline's count records.
    const second = makeTree()
    const other = await rootOf(second.tree)
    await second.tree.correct(other, 'owner', '先做 A')
    await second.tree.dispatch(other, 'mission-2')
    await second.tree.recordDispatchBaseline(other, 'mission-2')
    const carried = second.tree.continuationDelta(other)
    expect(second.tree.node(other)?.correctionsDeliveredUpTo).toBe(0)
    expect(carried?.corrections).toEqual([])
    expect(isMaterialChange(carried!)).toBe(false)
  })

  it('reports a node whose latest note belongs to an earlier dispatch', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    await tree.recordDispatchBaseline(id, 'mission-1')
    const split = await noteAndSplit(tree, id, 'mission-1', [
      { title: 'child', description: 'd', context: [] },
    ])
    const child = split.ok ? split.value.created[0] ?? '' : ''
    await tree.dispatch(child, 'mission-child')
    await tree.submitResult(child, 'mission-child', 'child conclusion')

    // Same dispatch wrote the note: the node's judgement is this session's own.
    const own = tree.continuationDelta(id)
    expect(own?.analysisFromAnotherDispatch).toBe(false)

    // The parked session is adopted for its convergence round (attempts 2) and its new prompt is
    // stamped. The note on the node still belongs to dispatch 1, so the node's judgement channel has
    // moved without the session that is now bound — the conservative "somebody else is writing here"
    // reading, which is exactly what `analysisAttempt` exists to answer.
    await tree.adoptParked(id, 'mission-1')
    await tree.recordDispatchBaseline(id, 'mission-1')
    const foreign = tree.continuationDelta(id)
    expect(foreign?.analysisFromAnotherDispatch).toBe(true)
    expect(isMaterialChange(foreign!)).toBe(true)
  })
})

describe('the cold-wake handle', () => {
  it('parks the lost session on open, so the next dispatch can try to continue it', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-gone')
    // The handle is NOT written by an ordinary dispatch: a same-process reclaim must keep its
    // today's behaviour of simply re-dispatching.
    expect(tree.node(id)?.lastWorkerId).toBeNull()

    const reopened = reopen(store)
    await reopened.open()
    const node = reopened.node(id)
    expect(node?.status).toBe('interrupted')
    expect(node?.claimedBy).toBeNull()
    // The binding was the only place that session id existed, and it is now recoverable.
    expect(node?.lastWorkerId).toBe('mission-gone')
    // Still an ordinary dispatchable node: the continuation decision belongs to the engine.
    expect(reopened.nextDispatchable()?.id).toBe(id)
  })

  it('adopts the recorded session, counts one attempt and spends the handle', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-gone')
    const reopened = reopen(store)
    await reopened.open()

    const adopted = await reopened.adoptContinuation(id, 'mission-gone')
    expect(adopted.ok).toBe(true)
    const node = reopened.node(id)
    expect(node?.status).toBe('running')
    expect(node?.claimedBy).toBe('mission-gone')
    expect(node?.attempts).toBe(2)
    // Spent: a resume the runtime refused once must not be retried on every later dispatch.
    expect(node?.lastWorkerId).toBeNull()
    // And the same handle cannot be adopted twice.
    expect((await reopened.adoptContinuation(id, 'mission-gone')).ok).toBe(false)
  })

  it('refuses a handle that moved, with no effect at all', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-gone')
    const reopened = reopen(store)
    await reopened.open()

    const refused = await reopened.adoptContinuation(id, 'mission-other')
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('not-dispatchable')
    expect(reopened.node(id)?.status).toBe('interrupted')
    expect(reopened.node(id)?.lastWorkerId).toBe('mission-gone')
    expect(reopened.node(id)?.attempts).toBe(1)
  })

  it('refuses to continue a node a parked session is supposed to wake', async () => {
    // The two address kinds must not overwrite each other: a parked session is an ALIVE
    // continuation and owns the node's next dispatch.
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-1')
    await noteAndSplit(tree, id, 'mission-1', [{ title: 'child', description: 'd', context: [] }])
    expect(tree.node(id)?.parkedWorker).toBe('mission-1')

    const refused = await tree.adoptContinuation(id, 'mission-1')
    expect(refused.ok).toBe(false)
    expect(tree.node(id)?.parkedWorker).toBe('mission-1')
  })

  it('charges no budget when the continuation delivery is refused', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-gone')
    const reopened = reopen(store)
    await reopened.open()
    await reopened.adoptContinuation(id, 'mission-gone')

    const reverted = await reopened.reclaim(id, 'wake-failed')
    expect(reverted.ok).toBe(true)
    const node = reopened.node(id)
    expect(node?.status).toBe('ready')
    expect(node?.claimedBy).toBeNull()
    // `wake-failed` is neither a mission failure nor an infrastructure one; `attempts` is a
    // generation marker and never rolls back.
    expect(node?.failures).toBe(0)
    expect(node?.spawnFailures).toBe(0)
    expect(node?.attempts).toBe(2)
  })

  it('loads a record written before the continuation fields existed', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-legacy')
    const state = store.documents.get(id)
    if (state === undefined) throw new Error('nothing was persisted')
    store.documents.set(id, withoutField(withoutField(state, id, 'lastWorkerId'), id, 'correctionsDeliveredUpTo'))

    const reopened = reopen(store)
    await reopened.open()
    const node = reopened.node(id)
    // The handle is recovered from the binding the old record DOES have...
    expect(node?.lastWorkerId).toBe('mission-legacy')
    // ...and a missing watermark reads as "nothing delivered", so a wake still carries everything.
    expect(node?.correctionsDeliveredUpTo).toBe(0)
  })

  it('reads a never-dispatched legacy record as "no handle, nothing delivered"', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    const state = store.documents.get(id)
    if (state === undefined) throw new Error('nothing was persisted')
    store.documents.set(id, withoutField(withoutField(state, id, 'lastWorkerId'), id, 'correctionsDeliveredUpTo'))

    const reopened = reopen(store)
    await reopened.open()
    expect(reopened.node(id)?.lastWorkerId).toBeNull()
    expect(reopened.node(id)?.correctionsDeliveredUpTo).toBe(0)
  })
})

describe('the executor display handle', () => {
  it('is written at dispatch and KEPT after the node reaches a terminal state', async () => {
    // This is the whole point of a separate field: `claimedBy` is cleared by every exit from
    // `running`, so a finished mission would otherwise name nobody. `executorSessionId` survives.
    const { tree } = makeTree()
    const id = await rootOf(tree)

    expect(tree.node(id)?.executorSessionId).toBeNull()
    await tree.dispatch(id, 'mission-first')
    expect(tree.node(id)?.executorSessionId).toBe('mission-first')
    expect(tree.node(id)?.claimedBy).toBe('mission-first')

    await tree.submitResult(id, 'mission-first', 'done')
    expect(tree.node(id)?.status).toBe('done')
    expect(tree.node(id)?.claimedBy).toBeNull()
    expect(tree.node(id)?.executorSessionId).toBe('mission-first')
  })

  it('keeps it across a reclaim too, and the LAST attempt wins', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'mission-first')
    await tree.reclaim(id, 'vanished')
    // A reclaim leaves the node dispatchable again; the handle still names who ran last.
    expect(tree.node(id)?.status).toBe('interrupted')
    expect(tree.node(id)?.executorSessionId).toBe('mission-first')

    await tree.dispatch(id, 'mission-second')
    // Only the LAST attempt: the projection carries one string, never a history array.
    expect(tree.node(id)?.executorSessionId).toBe('mission-second')
  })

  it('is written by BOTH adoption paths, not just by a fresh dispatch', async () => {
    // A record from a build without the display handle, parked as a cold-wake continuation: the
    // binding is cleared, the handle is the only address, and the display field is absent.
    const continuable = makeTree()
    const cid = await rootOf(continuable.tree)
    await continuable.tree.dispatch(cid, 'mission-cold')
    const cstate = continuable.store.documents.get(cid)
    if (cstate === undefined) throw new Error('nothing was persisted')
    const cnodes = new Map(cstate.nodes)
    const cnode = { ...cnodes.get(cid)!, claimedBy: null, status: 'interrupted' as const, lastWorkerId: 'mission-cold' }
    delete (cnode as unknown as Record<string, unknown>)['executorSessionId']
    cnodes.set(cid, cnode)
    continuable.store.documents.set(cid, { tree: cstate.tree, nodes: cnodes })

    const cold = reopen(continuable.store)
    await cold.open()
    expect(cold.node(cid)?.executorSessionId).toBeNull()
    await cold.adoptContinuation(cid, 'mission-cold')
    expect(cold.node(cid)?.executorSessionId).toBe('mission-cold')

    // And the parked-adoption path: a `ready` node with a live parked address.
    const parked = makeTree()
    const pid = await rootOf(parked.tree)
    await parked.tree.dispatch(pid, 'mission-parked')
    const pstate = parked.store.documents.get(pid)
    if (pstate === undefined) throw new Error('nothing was persisted')
    const pnodes = new Map(pstate.nodes)
    const pnode = { ...pnodes.get(pid)!, claimedBy: null, status: 'ready' as const, parkedWorker: 'mission-parked' }
    delete (pnode as unknown as Record<string, unknown>)['executorSessionId']
    pnodes.set(pid, pnode)
    parked.store.documents.set(pid, { tree: pstate.tree, nodes: pnodes })

    const reopened = reopen(parked.store)
    await reopened.open()
    expect(reopened.node(pid)?.executorSessionId).toBeNull()
    await reopened.adoptParked(pid, 'mission-parked')
    expect(reopened.node(pid)?.executorSessionId).toBe('mission-parked')
  })

  it('✓ reads a record written before the field existed as "no handle", and recovers a legacy running one from its binding', async () => {
    // Two directions, both with a record from an earlier release:
    // (a) a never-dispatched node has no binding to recover from → null (no link, no invented id);
    // (b) a RUNNING node's `claimedBy` is the only trace of the executor → recovered on open, so a
    //     session that ran before the upgrade is still openable from the panel.
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    const state = store.documents.get(id)
    if (state === undefined) throw new Error('nothing was persisted')
    store.documents.set(id, withoutField(state, id, 'executorSessionId'))

    const neverDispatched = reopen(store)
    await neverDispatched.open()
    expect(neverDispatched.node(id)?.executorSessionId).toBeNull()

    await tree.dispatch(id, 'mission-legacy')
    const dispatched = store.documents.get(id)
    if (dispatched === undefined) throw new Error('nothing was persisted')
    store.documents.set(id, withoutField(dispatched, id, 'executorSessionId'))

    const reopened = reopen(store)
    await reopened.open()
    // Rewritten as a running record: the display handle is recovered from the binding before the
    // demotion clears it, exactly as `lastWorkerId` is.
    expect(reopened.node(id)?.executorSessionId).toBe('mission-legacy')
  })
})

describe('the correction delivery watermark', () => {
  it('is monotone and clamped to the corrections actually recorded', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.correct(id, 'owner', 'A')
    await tree.correct(id, 'owner', 'B')
    expect(tree.node(id)?.correctionsDeliveredUpTo).toBe(0)

    await tree.markCorrectionsDelivered(id, 1)
    expect(tree.node(id)?.correctionsDeliveredUpTo).toBe(1)
    // A raced, older report cannot pull the mark back...
    await tree.markCorrectionsDelivered(id, 0)
    expect(tree.node(id)?.correctionsDeliveredUpTo).toBe(1)
    // ...and a report that outran a concurrent append cannot skip a correction nobody read.
    await tree.markCorrectionsDelivered(id, 99)
    expect(tree.node(id)?.correctionsDeliveredUpTo).toBe(2)
  })

  it('survives a restart, which is the whole reason it is durable', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.correct(id, 'owner', 'A')
    await tree.correct(id, 'owner', 'B')
    await tree.markCorrectionsDelivered(id, 1)

    const reopened = reopen(store)
    await reopened.open()
    expect(reopened.node(id)?.correctionsDeliveredUpTo).toBe(1)
  })
})
