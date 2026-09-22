/**
 * Work-tree behaviour: the state machine, the two terminal tools' mutual
 * exclusion, capacities, and the reconcile rules that keep `running` honest.
 *
 * The tree is exercised with an in-memory store, so these are the rules
 * themselves — no harness, no engine, no model.
 */
import { describe, expect, it } from 'vitest'
import { CAPACITY, WorkTree, type TreeState, type TreeStore } from '../src/index.js'

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

/** A tree with a controllable clock, live set and id sequence. */
function makeTree(options: { live?: Set<string>; owners?: Set<string>; spill?: boolean } = {}) {
  const store = memoryStore()
  const live = options.live ?? new Set<string>(['owner'])
  const owners = options.owners ?? new Set<string>(['owner'])
  let tick = 0
  let sequence = 0
  const tree = new WorkTree(store, {
    isAgentLive: (sessionId) => live.has(sessionId),
    ownerExists: (sessionId) => Promise.resolve(owners.has(sessionId)),
    spill: (text) =>
      Promise.resolve(
        options.spill === false
          ? null
          : { locator: `spill:${String(text.length)}`, hint: 'read it with the read tool' },
      ),
    now: () => (tick += 1),
    newId: () => `n${String(++sequence).padStart(4, '0')}`,
  })
  return { tree, store, live, owners }
}

async function rootOf(tree: WorkTree): Promise<string> {
  const created = await tree.createRoot({
    ownerSessionId: 'owner',
    title: 'Root work',
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
  tree: WorkTree,
  nodeId: string,
  callerSessionId: string,
  children: Parameters<WorkTree['decompose']>[2],
): Promise<Awaited<ReturnType<WorkTree['decompose']>>> {
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
    const decision = await tree.dispatch(id, 'work-1')
    expect(decision.ok).toBe(true)
    const node = tree.node(id)
    expect(node?.status).toBe('running')
    expect(node?.claimedBy).toBe('work-1')
    expect(node?.attempts).toBe(1)
  })

  it('refuses a node whose worker is still live', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')
    const again = await tree.dispatch(id, 'work-2')
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.code).toBe('not-dispatchable')
  })

  it('reclaims and re-dispatches a node whose worker is gone', async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')

    // A running node with a dead worker is not a candidate yet: it must be
    // reclaimed first, which is what the engine's sweep does.
    live.delete('work-1')
    expect(tree.nextDispatchable()).toBeUndefined()
    const reclaimed = await tree.reclaim(id)
    expect(reclaimed.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('interrupted')
    expect(tree.nextDispatchable()?.id).toBe(id)

    const again = await tree.dispatch(id, 'work-2')
    expect(again.ok).toBe(true)
    expect(tree.node(id)?.attempts).toBe(2)
  })

  it(`fails a node after ${String(CAPACITY.maxAttempts)} failed executions`, async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    for (let attempt = 0; attempt < CAPACITY.maxAttempts; attempt += 1) {
      const claim = `work-${String(attempt)}`
      const dispatched = await tree.dispatch(id, claim)
      expect(dispatched.ok).toBe(true)
      live.delete(claim)
      await tree.reclaim(id)
      live.add(claim)
    }
    const last = await tree.dispatch(id, 'work-final')
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
      const claim = `work-a${String(round)}`
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

      const childClaim = `work-c${String(round)}`
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
    live.add('work-1')
    await tree.dispatch(id, 'work-1')
    live.delete('work-1')
    await tree.reclaim(id)
    const node = tree.node(id)
    expect(node?.failures).toBe(1)
    expect(node?.spawnFailures).toBe(0)
    // A work failure is not an infrastructure failure: no cooldown, straight back to the pool.
    expect(tree.nextDispatchable()?.id).toBe(id)
  })

  it('charges a failed start to spawnFailures, not the budget, and cools the node down', async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    live.add('work-1')
    await tree.dispatch(id, 'work-1')
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
      const claim = `work-s${String(attempt)}`
      live.add(claim)
      const dispatched = await tree.dispatch(id, claim)
      expect(dispatched.ok, `dispatch ${String(attempt)}`).toBe(true)
      await tree.reclaim(id, 'spawn-failed')
    }
    const last = await tree.dispatch(id, 'work-final')
    expect(last.ok).toBe(false)
    const node = tree.node(id)
    expect(node?.status).toBe('failed')
    expect(node?.failures).toBe(0)
  })

  it('clears the spawn-failure streak once a worker starts', async () => {
    const { tree, live } = makeTree()
    const id = await rootOf(tree)
    live.add('work-1')
    await tree.dispatch(id, 'work-1')
    await tree.reclaim(id, 'spawn-failed')
    expect(tree.node(id)?.spawnFailures).toBe(1)
    // A later successful start forgets the outage, so the node is not left one failed
    // start away from a spawn-failure fail.
    live.add('work-2')
    await tree.dispatch(id, 'work-2')
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
  async function seededTree(extraIds: string[]): Promise<{ tree: WorkTree; rootId: string; documents: ReturnType<typeof memoryStore>['documents'] }> {
    const store = memoryStore()
    const tree = new WorkTree(store, {
      isAgentLive: (sessionId) => sessionId === 'work-root',
      ownerExists: () => Promise.resolve(true),
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
    nodes.set(rootId, { ...root, status: 'running', claimedBy: 'work-root', children })
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

    const refused = await noteAndSplit(tree, rootId, 'work-root', [
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

    const accepted = await noteAndSplit(tree, rootId, 'work-root', [
      { title: 'shared', description: reusable?.description ?? '', context: ['why'] },
      { title: 'brand new', description: 'd', context: [] },
    ])
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true)
    expect(accepted.ok && accepted.value.reused).toEqual(['shared'])
    // Still exactly one node titled 'shared': the reuse really reused.
    expect(tree.nodesOf(rootId).filter((node) => node.title === 'shared')).toHaveLength(1)
    expect(tree.nodesOf(rootId)).toHaveLength(CAPACITY.maxNodesPerTree)
  })
})

describe('the parked-session address', () => {
  /** A parent that decomposed once, with one terminal child: parked and waiting. */
  async function parkedParent(): Promise<{ tree: WorkTree; id: string; child: string }> {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-p1')
    const split = await noteAndSplit(tree, id, 'work-p1', [
      { title: 'prerequisite', description: 'd', context: [] },
    ])
    if (!split.ok) throw new Error('decompose failed')
    const child = split.value.created[0] as string
    await tree.dispatch(child, 'work-c1')
    await tree.submitResult(child, 'work-c1', 'done')
    return { tree, id, child }
  }

  it('records the decomposing session and releases the claim, as before', async () => {
    const { tree, id } = await parkedParent()
    const node = tree.node(id)
    expect(node?.parkedWorker).toBe('work-p1')
    // The claim is released exactly as it always was: nothing about "held" changed.
    expect(node?.claimedBy).toBeNull()
    // Children all terminal → the convergence pass is due.
    expect(node?.status).toBe('ready')
  })

  it('keeps a parked node out of the dispatch pool, and lets it back in once spent', async () => {
    // This is the difference between a live feature and dead code: `decompose_work` is
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
    const dispatched = await tree.dispatch(id, 'work-fresh')
    expect(dispatched.ok).toBe(true)
    expect(tree.node(id)?.parkedWorker).toBeNull()
  })

  it('adopts the parked session under its own id and consumes the address', async () => {
    const { tree, id } = await parkedParent()
    const adopted = await tree.adoptParked(id, 'work-p1')
    expect(adopted.ok).toBe(true)
    expect(adopted.ok && adopted.value.node.claimedBy).toBe('work-p1')
    expect(tree.node(id)?.parkedWorker).toBeNull()
    expect(tree.node(id)?.status).toBe('running')
    // The wake is a dispatch round like any other: `attempts` moves (the `note_work` gate
    // reads it), and no failure budget is touched — waking is not failing.
    expect(tree.node(id)?.attempts).toBe(2)
    expect(tree.node(id)?.failures).toBe(0)
    expect(tree.node(id)?.spawnFailures).toBe(0)
  })

  it('refuses to adopt a session that no longer owns the node, with no effect', async () => {
    const { tree, id } = await parkedParent()
    const wrong = await tree.adoptParked(id, 'work-somebody-else')
    expect(wrong.ok).toBe(false)
    expect(tree.node(id)?.parkedWorker).toBe('work-p1')
    expect(tree.node(id)?.claimedBy).toBeNull()

    // And once the address is spent, the same call refuses too.
    await tree.dispatch(id, 'work-fresh')
    const late = await tree.adoptParked(id, 'work-p1')
    expect(late.ok).toBe(false)
  })

  it('undoes a failed adoption without charging any budget', async () => {
    // Delivery failed: the address is consumed and the node goes back to the pool as an
    // ordinary candidate. `spawn-failed` would be wrong twice over — it would burn the
    // start-failure budget on a cleaned-up session AND its cooldown would delay the very
    // fallback it exists to enable.
    const { tree, id } = await parkedParent()
    await tree.adoptParked(id, 'work-p1')
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
    await tree.dispatch(id, 'work-1')

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
    await tree.dispatch(id, 'work-1')
    const at = tree.node(id)?.progressAt ?? 0

    tree.touchProgress(id, at)
    tree.touchProgress(id, at - 1)
    expect(tree.node(id)?.progressAt).toBe(at)

    await tree.submitResult(id, 'work-1', 'done')
    tree.touchProgress(id, at + 10_000)
    expect(tree.node(id)?.progressAt).toBe(at)
  })

  it('counts a silent reclaim as a stall, and a vanished worker as nothing', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')
    await tree.reclaim(id)
    expect(tree.node(id)?.stalls).toBe(0)

    await tree.dispatch(id, 'work-2')
    const stalled = await tree.reclaim(id, 'stalled')
    expect(stalled.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('interrupted')
    expect(tree.node(id)?.stalls).toBe(1)
  })

  it('lets the owner be told about one node’s stalls exactly once', async () => {
    const { tree, store } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')

    expect(await tree.claimStallReport(id)).toBe(true)
    expect(await tree.claimStallReport(id)).toBe(false)
    expect(tree.node(id)?.stalledNotifiedAt).not.toBeNull()
    expect(store.documents.get(id)?.nodes.get(id)?.stalledNotifiedAt).not.toBeNull()
  })

  it('finds the node a worker session holds', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')
    expect(tree.nodeHeldBy('work-1')?.id).toBe(id)
    expect(tree.nodeHeldBy('someone-else')).toBeUndefined()
  })
})

describe('deleting a finished tree', () => {
  /** A root with one child, both driven to `done`, returning their ids. */
  async function finishedPair(tree: WorkTree): Promise<{ root: string; child: string }> {
    const root = await rootOf(tree)
    await tree.dispatch(root, 'work-root')
    await noteAndSplit(tree, root, 'work-root', [{ title: 'child', description: 'd', context: [] }])
    const child = tree.nodesOf(root).find((node) => node.parentId === root)
    if (child === undefined) throw new Error('child missing')
    await tree.dispatch(child.id, 'work-child')
    await tree.submitResult(child.id, 'work-child', 'child done')
    await tree.dispatch(root, 'work-aggregate')
    await tree.submitResult(root, 'work-aggregate', 'root done')
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

  it('refuses a tree that is still running, and points at cancel_work', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'work-root')

    const refused = await tree.deleteTree(root)
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('not-deletable')
    expect(refused.ok === false && refused.message).toContain('只有已结束的工作能删除')
    expect(refused.ok === false && refused.message).toContain('cancel_work')
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
    await tree.dispatch(id, 'work-1')
    const split = await noteAndSplit(tree, id, 'work-1', [
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
    await tree.dispatch(id, 'work-1')
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
    await tree.dispatch(id, 'work-1')
    await noteAndSplit(tree, id, 'work-1', [{ title: 'child', description: 'd', context: [] }])
    // Decomposing releases the claim: the worker that split the work is done with
    // it, and the node waits for its children.
    const stale = await tree.submitResult(id, 'work-1', 'done')
    expect(stale.ok).toBe(false)
    expect(stale.ok === false && stale.code).toBe('not-owner')

    const child = tree.nodesOf(id).find((node) => node.parentId === id)
    if (child === undefined) throw new Error('child missing')
    await tree.dispatch(child.id, 'work-child')
    await tree.submitResult(child.id, 'work-child', 'child done')
    expect(tree.node(id)?.status).toBe('ready')

    // The aggregate pass is a real dispatch: it reads the children's conclusions
    // and states the outcome — this is how a decomposed node reaches `done`.
    await tree.dispatch(id, 'work-aggregate')
    const asAggregate = await tree.submitResult(id, 'work-aggregate', 'the conclusion')
    expect(asAggregate.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('done')
    expect(tree.node(id)?.result).toBe('the conclusion')
  })

  it('lets an aggregate that is still unsatisfied decompose again', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')
    const first = await noteAndSplit(tree, id, 'work-1', [{ title: 'child', description: 'd', context: [] }])
    if (!first.ok) throw new Error('decompose failed')
    const child = first.value.created[0] as string
    await tree.dispatch(child, 'work-child')
    await tree.submitResult(child, 'work-child', 'partial')

    // The convergence pass judged the objective unmet and named what is missing.
    await tree.dispatch(id, 'work-aggregate')
    const again = await noteAndSplit(tree, id, 'work-aggregate', [
      { title: 'follow-up', description: 'finish it', context: ['the first result is partial'] },
    ])
    expect(again.ok).toBe(true)
    expect(tree.node(id)?.status).toBe('blocked')
    expect(tree.node(id)?.children).toHaveLength(2)
  })

  it('refuses decompose once a worker submitted, by ownership first', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')
    await tree.submitResult(id, 'work-1', 'done')
    // Submitting clears the claim, so the same worker no longer owns the node;
    // whatever the reason reported, the split must not happen. Called directly rather
    // than through `noteAndSplit` because the analysis gate can no longer be opened —
    // that refusal is covered by its own cases further down.
    const late = await tree.decompose(id, 'work-1', [{ title: 'child', description: 'd', context: [] }])
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
    await tree.dispatch(id, 'work-1')
    const tooMany = await noteAndSplit(tree, 
      id,
      'work-1',
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
    await tree.dispatch(root, 'work-root')
    const branches = await noteAndSplit(tree, root, 'work-root', [
      { title: 'branch A', description: 'd', context: [] },
      { title: 'branch B', description: 'd', context: [] },
    ])
    if (!branches.ok) throw new Error('decompose failed')
    const [a, b] = branches.value.created as [string, string]

    await tree.dispatch(a, 'work-a')
    const first = await noteAndSplit(tree, a, 'work-a', [
      { title: 'Find callers', description: 'd', context: ['A needs them sized'] },
    ])
    expect(first.ok).toBe(true)
    const shared = first.ok ? (first.value.created[0] as string) : ''

    // Branch B independently discovers the same gap: it must reuse the node A
    // created rather than duplicate the work.
    await tree.dispatch(b, 'work-b')
    const second = await noteAndSplit(tree, b, 'work-b', [
      { title: '  find   CALLERS ', description: 'd', context: ['B needs them listed'] },
    ])
    expect(second.ok).toBe(true)
    expect(second.ok && second.value.created).toHaveLength(0)
    expect(second.ok && second.value.reused).toEqual([shared])

    // Both branches wait on the one node, and both become ready when it lands.
    expect(tree.node(a)?.status).toBe('blocked')
    expect(tree.node(b)?.status).toBe('blocked')
    expect(tree.node(shared)?.context).toEqual(['A needs them sized', 'B needs them listed'])
    await tree.dispatch(shared, 'work-shared')
    await tree.submitResult(shared, 'work-shared', 'twelve callers')
    expect(tree.node(a)?.status).toBe('ready')
    expect(tree.node(b)?.status).toBe('ready')
  })

  it('does not reuse on a title alone: same title, different work stays separate', async () => {
    // Titles are not unique in practice ("补充测试" can name unrelated works in two branches).
    // A false reuse hands the later branch a node whose RESULT answers a different question,
    // and nothing in the tree shows that it did — so the match covers the description too.
    // The whitespace-insensitive match still applies, and reuse still fires within one call.
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'work-root')
    const branches = await noteAndSplit(tree, root, 'work-root', [
      { title: 'branch A', description: 'd', context: [] },
      { title: 'branch B', description: 'd', context: [] },
    ])
    if (!branches.ok) throw new Error('decompose failed')
    const [a, b] = branches.value.created as [string, string]

    // A names two different works that share a title, plus a whitespace variant of the
    // first: exactly one reuse (the variant) and one new node (the different work).
    await tree.dispatch(a, 'work-a')
    const split = await noteAndSplit(tree, a, 'work-a', [
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
    const dispatched = await tree.dispatch(b, 'work-b')
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
    const again = await noteAndSplit(tree, b, 'work-b', [
      { title: '补充测试', description: '补上 HTTP 层的边界用例', context: ['B 也要'] },
    ])
    expect(again.ok && again.value.created).toHaveLength(0)
    expect(again.ok && again.value.reused).toHaveLength(1)
    expect(tree.nodesOf(root)).toHaveLength(before)
  })

  it('makes a parent immediately ready when the reused prerequisite is already done', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'work-root')
    const branches = await noteAndSplit(tree, root, 'work-root', [
      { title: 'branch A', description: 'd', context: [] },
      { title: 'branch B', description: 'd', context: [] },
    ])
    if (!branches.ok) throw new Error('decompose failed')
    const [a, b] = branches.value.created as [string, string]

    // A finishes the prerequisite before B ever asks for it.
    await tree.dispatch(a, 'work-a')
    const doneA = await noteAndSplit(tree, a, 'work-a', [
      { title: 'find callers', description: 'd', context: [] },
    ])
    if (!doneA.ok) throw new Error('decompose failed')
    const shared = doneA.value.created[0] as string
    await tree.dispatch(shared, 'work-shared')
    await tree.submitResult(shared, 'work-shared', 'twelve callers')

    // B reuses a satisfied prerequisite: it must not wait on anything.
    await tree.dispatch(b, 'work-b')
    const doneB = await noteAndSplit(tree, b, 'work-b', [
      { title: 'Find callers', description: 'd', context: [] },
    ])
    expect(doneB.ok && doneB.value.reused).toEqual([shared])
    expect(tree.node(b)?.status).toBe('ready')
  })

  it('never reuses the node itself or an ancestor', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'work-root')
    const first = await noteAndSplit(tree, root, 'work-root', [
      { title: 'Find callers', description: 'd', context: [] },
    ])
    if (!first.ok) throw new Error('decompose failed')
    const child = first.value.created[0] as string
    await tree.dispatch(child, 'work-child')

    // Its own title and its ancestor's: both would make the node contain itself.
    const split = await noteAndSplit(tree, child, 'work-child', [
      { title: '  FIND   callers ', description: 'd', context: [] },
      { title: 'Root work', description: 'd', context: [] },
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
    expect(tree.node(ancestorTitle)?.title).toBe('Root work')
    expect(tree.node(twinTitle)?.parentId).toBe(child)

    // Within one call, a repeated title reuses the child created moments ago.
    const rootAgain = await tree.createRoot({
      ownerSessionId: 'owner',
      title: 'Another root',
      description: 'd',
      analysis: [],
    })
    if (!rootAgain.ok) throw new Error('root failed')
    await tree.dispatch(rootAgain.value.id, 'work-2')
    const twins = await noteAndSplit(tree, rootAgain.value.id, 'work-2', [
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
    await tree.dispatch(root, 'work-root')
    const split = await noteAndSplit(tree, root, 'work-root', [
      { title: 'a', description: 'd', context: [] },
      { title: 'b', description: 'd', context: [] },
    ])
    if (!split.ok) throw new Error('decompose failed')
    const [first, second] = split.value.created as [string, string]

    await tree.dispatch(first, 'work-a')
    const doneA = await tree.submitResult(first, 'work-a', 'a is done')
    expect(doneA.ok && doneA.value.parentReady).toBe(false)
    expect(tree.node(root)?.status).toBe('blocked')

    await tree.dispatch(second, 'work-b')
    const doneB = await tree.submitResult(second, 'work-b', 'b is done')
    expect(doneB.ok && doneB.value.parentReady).toBe(true)
    expect(tree.node(root)?.status).toBe('ready')
  })

  it('exposes terminal children only for an aggregate', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'work-root')
    await noteAndSplit(tree, root, 'work-root', [{ title: 'a', description: 'd', context: [] }])
    const child = tree.nodesOf(root).find((node) => node.parentId === root)
    expect(child).toBeDefined()
    await tree.dispatch(child?.id ?? '', 'work-a')
    await tree.submitResult(child?.id ?? '', 'work-a', 'result text')
    const view = tree.view(root)
    expect(view?.children).toHaveLength(1)
    expect(view?.children[0]?.result).toBe('result text')
  })

  it('spills an over-long result and keeps a pointer WITH its retrieval hint', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')
    const long = 'x'.repeat(CAPACITY.maxInlineResultChars + 100)
    const submitted = await tree.submitResult(id, 'work-1', long)
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
    await tree.dispatch(id, 'work-1')
    const long = 'x'.repeat(CAPACITY.maxInlineResultChars + 100)
    const submitted = await tree.submitResult(id, 'work-1', long)
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
    await tree.dispatch(id, 'work-gone')

    // A fresh process: same durable state, the worker is gone, the owner is back.
    const reopened = new WorkTree(store, {
      isAgentLive: (sessionId) => sessionId === 'owner',
      ownerExists: () => Promise.resolve(true),
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
    await tree.dispatch(id, 'work-live')

    const reopened = new WorkTree(store, {
      isAgentLive: (sessionId) => sessionId === 'work-live' || sessionId === 'owner',
      ownerExists: () => Promise.resolve(true),
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
    const reopened = new WorkTree(store, {
      isAgentLive: () => false,
      ownerExists: () => Promise.resolve(true),
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
    const reopened = new WorkTree(gone.store, {
      isAgentLive: () => false,
      ownerExists: () => Promise.resolve(false),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'fresh',
    })
    await reopened.open()
    const orphans = await reopened.orphanedTrees()
    expect(orphans).toHaveLength(1)
    await reopened.destroyTree(orphans[0]?.rootId ?? '')
    expect(reopened.trees()).toHaveLength(0)
    expect(gone.store.documents.size).toBe(0)

    // The same durable state with the session still on disk: the tree survives a
    // restart, which is the whole point of asking storage instead of the registry.
    const kept = makeTree()
    await rootOf(kept.tree)
    const survivor = new WorkTree(kept.store, {
      isAgentLive: () => false,
      ownerExists: () => Promise.resolve(true),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'fresh',
    })
    await survivor.open()
    expect(await survivor.orphanedTrees()).toHaveLength(0)
    expect(survivor.trees()).toHaveLength(1)
  })
})

describe('finish and cancel', () => {
  it('refuses to finish before the result is read', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')
    await tree.submitResult(id, 'work-1', 'the answer')

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
      const claim = `work-${String(attempt)}`
      await tree.dispatch(id, claim)
      live.delete(claim)
      await tree.reclaim(id)
      live.add(claim)
    }
    await tree.dispatch(id, 'work-final')
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
    await tree.dispatch(root, 'work-root')
    const split = await noteAndSplit(tree, root, 'work-root', [
      { title: 'a', description: 'd', context: [] },
      { title: 'b', description: 'd', context: [] },
    ])
    if (!split.ok) throw new Error('decompose failed')
    const [first, second] = split.value.created as [string, string]
    await tree.dispatch(first, 'work-a')
    await tree.submitResult(first, 'work-a', 'kept')

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

describe('corrections and sub-work cancellation', () => {
  it('records a correction on the node, once', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'work-root')

    const first = await tree.correct(root, 'owner', '方向不对')
    expect(first.ok).toBe(true)
    // Corrections live in their own field: `context` is the decomposer's "why this exists".
    expect(tree.node(root)?.corrections).toEqual(['方向不对'])
    expect(tree.node(root)?.context).not.toContain('方向不对')
    await tree.correct(root, 'owner', '方向不对')
    expect(tree.node(root)?.corrections).toHaveLength(1)
  })

  it('refuses a correction from another session, and on a finished work', async () => {
    const { tree } = makeTree()
    const root = await rootOf(tree)
    await tree.dispatch(root, 'work-root')

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
    await tree.dispatch(root, 'work-root')
    await noteAndSplit(tree, root, 'work-root', [
      { title: 'A', description: 'a', context: ['why'] },
      { title: 'B', description: 'b', context: ['why'] },
    ])
    const a = tree.nodesOf(root).find((node) => node.title === 'A')
    const b = tree.nodesOf(root).find((node) => node.title === 'B')
    if (a === undefined || b === undefined) throw new Error('children missing')
    await tree.dispatch(a.id, 'work-a')
    await noteAndSplit(tree, a.id, 'work-a', [{ title: 'A1', description: 'x', context: [] }])
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
      expect(tree.node(id)?.result).toBe('被父工作取消')
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
    await tree.dispatch(root, 'work-root')
    await noteAndSplit(tree, root, 'work-root', [{ title: 'A', description: 'a', context: ['why'] }])

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
    await tree.dispatch(root, 'work-root')
    await noteAndSplit(tree, root, 'work-root', [
      { title: 'P', description: 'p', context: ['why'] },
      { title: 'Q', description: 'q', context: ['why'] },
    ])
    const p = tree.nodesOf(root).find((node) => node.title === 'P')
    const q = tree.nodesOf(root).find((node) => node.title === 'Q')
    if (p === undefined || q === undefined) throw new Error('branches missing')
    await tree.dispatch(p.id, 'work-p')
    await noteAndSplit(tree, p.id, 'work-p', [{ title: 'X', description: 'x', context: ['why'] }])
    const x = tree.nodesOf(root).find((node) => node.title === 'X')
    if (x === undefined) throw new Error('shared missing')
    // Q names the same prerequisite, so the dedup reuses P's node.
    await tree.dispatch(q.id, 'work-q')
    const reused = await noteAndSplit(tree, q.id, 'work-q', [{ title: 'X', description: 'x', context: ['why'] }])
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
    await tree.dispatch(root, 'work-root')

    const refused = await tree.cancelSubworks(root, 'work-root')
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('nothing-to-cancel')
  })
})

describe('analysis and the decompose gate', () => {
  it('records one entry per non-blank line, trimmed, attributed to the current dispatch', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')

    const recorded = await tree.recordAnalysis(id, 'work-1', '  缺前置事实：先拿到调用点清单  \n\n  再判断改动范围\n')
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
    await tree.dispatch(id, 'work-1')
    await tree.recordAnalysis(id, 'work-1', '结论 A\n结论 B')
    // The same text again is a no-op entry-wise, but it still stamps this dispatch.
    await tree.recordAnalysis(id, 'work-1', '结论 A')

    live.delete('work-1')
    await tree.reclaim(id)
    await tree.dispatch(id, 'work-2')
    const again = await tree.recordAnalysis(id, 'work-2', '结论 A\n结论 C')
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.analysisNotes).toEqual(['结论 A', '结论 B', '结论 C'])
    expect(again.value.analysisAttempt).toBe(2)
  })

  it('refuses a caller that does not hold the work', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')
    const stranger = await tree.recordAnalysis(id, 'someone-else', '让我也记一笔')
    expect(stranger.ok).toBe(false)
    expect(stranger.ok === false && stranger.code).toBe('not-owner')
    expect(tree.node(id)?.analysisNotes).toEqual([])
  })

  it('refuses blank text, and a terminal work', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')
    const blank = await tree.recordAnalysis(id, 'work-1', '   \n\n\t ')
    expect(blank.ok).toBe(false)
    expect(blank.ok === false && blank.code).toBe('no-analysis')

    // A terminal work is reachable only through the aggregate pass, and that pass
    // clears the claim on success — so what a later `recordAnalysis` gets is the
    // ownership refusal, with the terminal rule standing behind it as the guard for
    // a node failed while still claimed (see `dispatch`'s attempt exhaustion).
    await tree.recordAnalysis(id, 'work-1', '先写下这一轮的分析')
    await tree.decompose(id, 'work-1', [{ title: 'child', description: 'd', context: [] }])
    const child = tree.nodesOf(id).find((node) => node.parentId === id)
    if (child === undefined) throw new Error('child missing')
    await tree.dispatch(child.id, 'work-child')
    await tree.submitResult(child.id, 'work-child', 'child done')
    await tree.dispatch(id, 'work-aggregate')
    await tree.submitResult(id, 'work-aggregate', 'done')
    expect(tree.node(id)?.status).toBe('done')
    expect(tree.node(id)?.claimedBy).toBeNull()
    const late = await tree.recordAnalysis(id, 'work-aggregate', '太晚了')
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
    await tree.dispatch(id, 'work-1')

    const refused = await tree.decompose(id, 'work-1', [{ title: 'child', description: 'd', context: ['why'] }])
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('analysis-missing')
    expect(refused.ok === false && refused.message).toContain('note_work')
    // No child, no attempt burned, the caller still holds the work.
    expect(tree.node(id)?.children).toEqual([])
    expect(tree.node(id)?.attempts).toBe(1)
    expect(tree.node(id)?.status).toBe('running')
    expect(tree.node(id)?.claimedBy).toBe('work-1')
    expect(tree.nodesOf(id)).toHaveLength(1)
  })

  it('admits the split once this dispatch wrote its analysis, and closes again after a re-dispatch', async () => {
    const { tree } = makeTree()
    const id = await rootOf(tree)
    await tree.dispatch(id, 'work-1')
    await tree.recordAnalysis(id, 'work-1', '第一次为什么拆')
    const first = await tree.decompose(id, 'work-1', [{ title: 'child', description: 'd', context: [] }])
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const child = first.value.created[0] as string
    await tree.dispatch(child, 'work-child')
    await tree.submitResult(child, 'work-child', 'partial')

    // The aggregate pass is a NEW dispatch under a NEW claim: the note that justified
    // the first split is not an argument for the second.
    await tree.dispatch(id, 'work-aggregate')
    const refused = await tree.decompose(id, 'work-aggregate', [
      { title: 'follow-up', description: 'finish it', context: [] },
    ])
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.code).toBe('analysis-missing')

    await tree.recordAnalysis(id, 'work-aggregate', '这次为什么还缺')
    const again = await tree.decompose(id, 'work-aggregate', [
      { title: 'follow-up', description: 'finish it', context: [] },
    ])
    expect(again.ok).toBe(true)
    expect(tree.node(id)?.analysisNotes).toEqual(['第一次为什么拆', '这次为什么还缺'])
    expect(tree.node(id)?.analysisAttempt).toBe(2)
  })
})
