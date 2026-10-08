/**
 * Fixtures shared by the mission plugin's wake tests.
 *
 * Two things live here because two suites need the SAME one and a second copy would drift:
 *
 * - documents written by the REAL tree code and seeded into a mount before it opens, which is how a
 *   test models a process restart. `persistedTree` describes one persisted moment through options;
 *   `sealedTree` is the same idea as a small builder, for states that are defined by the ORDER of
 *   their steps (a baseline stamped before or after a correction is a different history).
 * - `parkedRoot`, the harness flow up to "a parent decomposed and every child is terminal", which is
 *   the trigger a parked wake exists for.
 */
import { MissionTree, type TreeState, type TreeStore } from '@avantf/mission-core'
import { toDocument } from '../src/store.js'
import type { TreeDocument } from '../src/domain.js'
import { agent, callTool, executorFor, noteAndSplit, type Mounted } from './mount.js'

/** An in-memory store as a throwaway generation of the tree sees it: it only writes the record. */
function memoryStore(): { store: TreeStore; latest: () => TreeState | undefined } {
  let latest: TreeState | undefined
  return {
    store: {
      loadAll: () => Promise.resolve(latest === undefined ? [] : [latest]),
      put: (state) => {
        latest = state
        return Promise.resolve()
      },
      remove: () => {
        latest = undefined
        return Promise.resolve()
      },
    },
    latest: () => latest,
  }
}

/** A worker claim id of the shape this plugin mints, so the stubs treat it like one of ours. */
export const WORKER = 'mission-aaaa1111'

/** One macrotask turn. The engine starts workers fire-and-forget, so the baseline stamp that follows
 *  a start (and the dispatch record itself) needs a turn before a test may read it. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * One durable document written by the REAL tree code, so the fixture cannot drift from the shape
 * the engine persists. `dispatched: false` leaves the node `ready` (a mission never started).
 *
 * `nodeId` exists for a case that seeds MORE than one document into one store: the default is fixed,
 * and two documents sharing a node id would be two trees with colliding node ids (the store is keyed
 * by ROOT id, so the trees themselves are distinct).
 */
export async function persistedTree(input: {
  workerId: string
  dispatched?: boolean
  corrections?: readonly string[]
  deliveredUpTo?: number
  /** The root/node id the fixture mints; default `root0001`. */
  nodeId?: string
}): Promise<TreeDocument> {
  const { store, latest } = memoryStore()
  const newId = input.nodeId ?? 'root0001'
  const tree = new MissionTree(store, {
    // Nothing is materialized in this throwaway generation; it only writes the durable record.
    isAgentLive: () => false,
    probeOwner: () => Promise.resolve({ kind: 'exists' }),
    spill: () => Promise.resolve(null),
    now: () => 1,
    newId: () => newId,
  })
  const created = await tree.createRoot({
    ownerSessionId: 'owner',
    title: '冷唤醒任务',
    description: '接住上一次执行的上下文',
    analysis: [],
  })
  if (!created.ok) throw new Error(`root creation failed: ${created.message}`)
  const rootId = created.value.id
  if (input.dispatched !== false) {
    const dispatched = await tree.dispatch(rootId, input.workerId)
    if (!dispatched.ok) throw new Error(`dispatch failed: ${dispatched.message}`)
  }
  for (const text of input.corrections ?? []) {
    const corrected = await tree.correct(rootId, 'owner', text)
    if (!corrected.ok) throw new Error(`correction failed: ${corrected.message}`)
  }
  if (input.deliveredUpTo !== undefined) await tree.markCorrectionsDelivered(rootId, input.deliveredUpTo)
  if (latest() === undefined) throw new Error('the fixture persisted nothing')
  return toDocument(latest() as TreeState)
}

/**
 * A tree document under construction, one REAL tree mutation per step. The point of the builder over
 * `persistedTree` is that the ORDER carries meaning: a baseline stamped before a correction says the
 * session read the correction; stamped after the note it says the note was not part of the delta.
 */
interface SealedTree {
  readonly rootId: string
  /** Reclaim the binding and dispatch the node again, as a second round in the same node's life. */
  redispatch(workerId: string): Promise<void>
  /** `note_mission` by the session the node is currently bound to. */
  note(text: string): Promise<void>
  /** `note_mission` by an EXPLICIT session — how a fixture builds "somebody else advanced this node". */
  noteAs(sessionId: string, text: string): Promise<void>
  /** The owner's `adjust_mission` correction, recorded while the node is bound. */
  correct(text: string): Promise<void>
  /** The dispatch baseline, as the host stamps it for the CURRENT binding. */
  stamp(): Promise<void>
  /** Move the delivery watermark, as a live steer does. */
  delivered(upTo: number): Promise<void>
  document(): TreeDocument
  /** The same document as an earlier release wrote it: the fields added since are ABSENT, not
   *  `null`/`0`. A JSON round trip makes "absent" a real property of the fixture. */
  legacyDocument(): TreeDocument
}

export async function sealedTree(workerId: string): Promise<SealedTree> {
  const { store, latest } = memoryStore()
  const tree = new MissionTree(store, {
    isAgentLive: () => false,
    probeOwner: () => Promise.resolve({ kind: 'exists' }),
    spill: () => Promise.resolve(null),
    now: () => 1,
    newId: () => 'root0001',
  })
  const created = await tree.createRoot({
    ownerSessionId: 'owner',
    title: '冷唤醒任务',
    description: '接住上一次执行的上下文',
    analysis: [],
  })
  if (!created.ok) throw new Error(`root creation failed: ${created.message}`)
  const rootId = created.value.id
  const dispatched = await tree.dispatch(rootId, workerId)
  if (!dispatched.ok) throw new Error(`dispatch failed: ${dispatched.message}`)

  const document = (): TreeDocument => {
    const state = latest()
    if (state === undefined) throw new Error('the fixture persisted nothing')
    return toDocument(state)
  }
  const stripBaseline = (source: TreeDocument): TreeDocument => {
    const clone = JSON.parse(JSON.stringify(source)) as {
      tree: TreeDocument['tree']
      nodes: Record<string, Record<string, unknown>>
    }
    for (const node of Object.values(clone.nodes)) {
      delete node['lastWorkerId']
      delete node['correctionsDeliveredUpTo']
      delete node['dispatchBaseline']
      // The two dispatch clocks shipped later still: a document from before them has neither, and the
      // whole point of this fixture is to make "absent" a real property of the record.
      delete node['dispatchedAt']
      delete node['endedAt']
    }
    return clone as unknown as TreeDocument
  }
  return {
    rootId,
    redispatch: async (next) => {
      const reclaimed = await tree.reclaim(rootId, 'vanished')
      if (!reclaimed.ok) throw new Error(`reclaim failed: ${reclaimed.message}`)
      const again = await tree.dispatch(rootId, next)
      if (!again.ok) throw new Error(`re-dispatch failed: ${again.message}`)
    },
    note: async (text) => {
      const noted = await tree.recordAnalysis(rootId, workerId, text)
      if (!noted.ok) throw new Error(`note_mission failed: ${noted.message}`)
    },
    noteAs: async (sessionId, text) => {
      const noted = await tree.recordAnalysis(rootId, sessionId, text)
      if (!noted.ok) throw new Error(`note_mission failed: ${noted.message}`)
    },
    correct: async (text) => {
      const corrected = await tree.correct(rootId, 'owner', text)
      if (!corrected.ok) throw new Error(`correction failed: ${corrected.message}`)
    },
    stamp: async () => {
      const stamped = await tree.recordDispatchBaseline(rootId, workerId)
      if (!stamped) throw new Error('the fixture could not stamp its baseline')
    },
    delivered: (upTo) => tree.markCorrectionsDelivered(rootId, upTo),
    document,
    legacyDocument: () => stripBaseline(document()),
  }
}

/** The same document as an earlier release would have written it: the added fields are ABSENT. */
export function asLegacy(document: TreeDocument): TreeDocument {
  const clone = JSON.parse(JSON.stringify(document)) as {
    tree: TreeDocument['tree']
    nodes: Record<string, Record<string, unknown>>
  }
  for (const node of Object.values(clone.nodes)) {
    delete node['lastWorkerId']
    delete node['correctionsDeliveredUpTo']
    delete node['dispatchBaseline']
    delete node['dispatchedAt']
    delete node['endedAt']
  }
  return clone as unknown as TreeDocument
}

/** A tree with one node that decomposed and whose children are all terminal. */
export async function parkedRoot(
  mounted: Mounted,
  owner: ReturnType<typeof agent> = mounted.owner,
): Promise<{
  root: string
  rootWorker: ReturnType<typeof agent>
  child: string
}> {
  const created = await callTool(
    mounted,
    'create_mission',
    { title: 'T', description: 'd', analysis: ['because'] },
    owner,
  )
  const root = String(created.data?.root_id ?? '')
  await mounted.flush()
  // The dispatch baseline is stamped just after the start; wait for it so a case that reads the node's
  // drift sees the baseline the host really wrote instead of racing it.
  await settle()
  const rootWorker = agent(String(mounted.dispatched.at(-1)?.childId ?? ''))
  const split = await noteAndSplit(
    mounted,
    root,
    [{ title: 'sub', description: 'd', context: ['why'] }],
    rootWorker,
  )
  const child = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
  await mounted.flush()
  await callTool(mounted, 'submit_mission', { node_id: child, result: 'child conclusion' }, executorFor(mounted, child))
  await mounted.flush()
  return { root, rootWorker, child }
}
