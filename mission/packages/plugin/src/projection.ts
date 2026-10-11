/**
 * The READ projections: the row/detail views the browser half renders, computed from a tree snapshot.
 *
 * WHY THIS MODULE EXISTS. These were ~300 lines inside `host.ts`, the plugin's largest file and the one
 * that holds the storage domain, the dispatch loop and every DSH-touching seam. They share none of that:
 * every function here is PURE — a `MissionTree` value in, plain data out — with the two live facts they
 * need (`waitingForOf`, and the ownership guard `ownedBy`) passed in explicitly instead of read off a
 * service instance. That is what makes them testable against a tree fixture with no context, no logger,
 * no IO and no side effects, and it is why `host.ts` keeps only thin same-named delegates.
 *
 * @module @avantf/dsh-mission/projection
 */
import { spillPointer, type MissionTree, type NodeRecord, type WaitingFor } from '@avantf/mission-core'
import { ROW_CORRECTIONS_MAX } from './wire.js'

/**
 * The LAST executor session a node was dispatched to, as an address a reader may open — the one
 * field the panel's "click the node id to open the session that ran it" needs.
 *
 * Read from the PERSISTED display handle (`executorSessionId`, written at every transition into
 * `running` and kept afterwards), not from `claimedBy`: a finished mission is exactly when a reader
 * wants to open the session that ran it, and `claimedBy` has been cleared by then. `null` when the
 * node was never dispatched (or the field is blank), and never the node id dressed up as a session
 * id. `workerLive` (see {@link workerLiveOf}) is what tells the two cases apart on screen.
 */
export function workerSessionIdOf(node: NodeRecord): string | null {
  const id = node.executorSessionId
  return id === null || id === '' ? null : id
}

/** Whether the executor handle above is the node's CURRENT, still-running binding, so the panel can
 *  label the link 进行中 / 已结束. False for every terminal, reclaimed or never-dispatched node: the
 *  handle is then a display address for a session that has stopped, not a live executor. */
export function workerLiveOf(node: NodeRecord): boolean {
  return node.status === 'running'
    && node.claimedBy !== null
    && node.claimedBy === node.executorSessionId
}

/**
 * Whether the executor handle above names a session that was RELEASED off disk, so the panel must
 * explain that instead of jumping. Read from the persisted mark rather than derived: only the cleanup
 * pipeline knows a session is gone, and a node that still names its executor is otherwise
 * indistinguishable from one whose session has been deleted (the handle is kept either way — see
 * `NodeRecord.executorReleasedAt`).
 *
 * `false` for every record written before the mark existed, which is the whole compatibility story:
 * an old document reads as "not released", and the click behaves exactly as it does today.
 */
export function workerReleasedOf(node: NodeRecord): boolean {
  return node.executorReleasedAt !== null
}

/** One node as the browser half renders it — the ROW projection. Deliberately without `description`
 *  or the submitted result: both are re-sent on every engine change and a row renders neither. */
export interface NodeView {
  readonly id: string
  /** Where this node was BORN (`null` for a root), NOT the dependency edge: a reused prerequisite
   *  keeps its birth parent while appearing in several parents' `children` — read the graph via `children`. */
  readonly parentId: string | null
  /** The ids this node actually depends on — the authoritative edge (see `parentId`). */
  readonly children: readonly string[]
  readonly depth: number
  readonly title: string
  /** Legacy: the row sends `[]` (the texts are in {@link NodeDetail.context}); an OLDER host still
   *  sends them, which is why the field is still on the wire. Read the count, not this. */
  readonly context: readonly string[]
  /** How many premises this mission carries. The row renders the count; the texts are in the detail. */
  readonly contextCount: number
  /** The owner's corrections, newest last. Carried in the ROW projection (unlike `description` and
   *  the submitted result) because a row has to say the mission was steered: `title` is frozen at
   *  creation, so a corrected mission otherwise reads as "goal X, result of Y" with nothing between
   *  them to explain the difference. Bounded to the newest {@link ROW_CORRECTIONS_MAX}: a row renders
   *  only the count, and every text is in the detail. */
  readonly corrections: readonly string[]
  /** The owner's FULL correction count, independent of the capped array above. */
  readonly correctionCount: number
  readonly status: string
  readonly attempts: number
  readonly createdAt: number
  /** When this node was FIRST dispatched, or `null` while it is still queued (see
   *  `@avantf/mission-core`'s `NodeRecord.dispatchedAt`). Carried in the ROW projection: the row's
   *  compact timing marker is derived from it, and an older host omitting it reads as `null`. */
  readonly dispatchedAt: number | null
  /** When this node entered a terminal status, or `null` while it is still in play. Carried in the
   *  ROW projection for the same reason as {@link dispatchedAt}. */
  readonly endedAt: number | null
  readonly hasResult: boolean
  readonly resultRef: string | null
  /** The session that ran this node LAST, or `null` when none ever did (see `workerSessionIdOf`). */
  readonly workerSessionId: string | null
  /** Whether that handle is still running (see `workerLiveOf`), so the panel can say 进行中 / 已结束. */
  readonly workerLive: boolean
  /** Whether that handle's session was RELEASED off disk by the cleanup pipeline (see
   *  `workerReleasedOf`). The ROW carries it because the click it must change lives here: a released
   *  handle is never opened, and the explanation is rendered beside the id that was clicked. */
  readonly workerReleased: boolean
  /** Declared capacity weight (cores-equivalent); persisted, so it survives a restart. */
  readonly weight: number
  /** Why the engine has not dispatched this node yet, or `null`. Carried in the ROW projection
   *  because a queued mission that looks identical to a ready one is exactly the confusion the
   *  `waitingFor` projection exists to remove. */
  readonly waitingFor: WaitingFor | null
}

/** One mission's full detail, as the expanded row renders it. */
export interface NodeDetail {
  readonly id: string
  readonly rootId: string
  readonly title: string
  readonly description: string
  readonly context: readonly string[]
  /** The owner's corrections, newest last: the direction changes this mission has been given, in the
   *  order they arrived. Rendered as its own block so the goal above and the result below are read
   *  in the light of them, and so a mission can be traced back to why it ended up where it did. */
  readonly corrections: readonly string[]
  /** What this mission's executors recorded, oldest first; exposed so an operator reads the judgement a
   *  re-dispatched executor sees (the panel does not render it yet). */
  readonly analysisNotes: readonly string[]
  /** The dispatch (`attempts`) that wrote the last entry; `0` when none. */
  readonly analysisAttempt: number
  readonly status: string
  readonly attempts: number
  readonly depth: number
  /** When this node was accepted into the tree. Carried in the detail projection (not the row) because
   *  the dialog's full timing line is the only place the 受理 instant is shown. */
  readonly createdAt: number
  /** When this node was FIRST dispatched, or `null` while it is still queued. The detail dialog shows
   *  it beside `createdAt`/`endedAt`; the row carries the compact form. */
  readonly dispatchedAt: number | null
  /** When this node entered a terminal status, or `null` while it is still in play. */
  readonly endedAt: number | null
  /** The submitted conclusion, when there is one (inline; a long one is truncated). */
  readonly result: string | null
  /** Where a spilled full result lives, joined with its retrieval hint. */
  readonly resultPointer: string | null
  /** The session that ran this node LAST, or `null` when none ever did (see `workerSessionIdOf`). */
  readonly workerSessionId: string | null
  /** Whether that handle is still running (see `workerLiveOf`), so the panel can say 进行中 / 已结束. */
  readonly workerLive: boolean
  /** Whether that handle's session was released off disk (see the row projection's copy). Carried in
   *  the detail too because the dialog's heading id is the same entry as the tree header's. */
  readonly workerReleased: boolean
  /** Declared capacity weight (cores-equivalent). */
  readonly weight: number
  /** Why this node is queued rather than running, or `null`. */
  readonly waitingFor: WaitingFor | null
}

/** One sub-mission of a node, with the conclusion it submitted. */
export interface NodeDetailChild {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly result: string | null
  readonly resultPointer: string | null
}

/** One tree with its nodes, as the browser half renders it. */
export interface TreeView {
  readonly rootId: string
  readonly nodes: readonly NodeView[]
  readonly closedAt: number | null
}

/** The detail read's three outcomes in one shape: a node, a refusal, or neither. */
export interface NodeDetailOutcome {
  readonly node?: NodeDetail
  readonly children: readonly NodeDetailChild[]
  readonly error?: string
}

/**
 * The two live facts `detailOf` needs, passed in so the module holds no service instance.
 *
 * `ownedBy` is the host's node-addressed ownership guard (`ownedNodeFor`): "the node's tree exists and
 * belongs to `sessionId`". It stays in `host.ts` because the WRITE paths (delete / markExecutorReleased
 * / resolveExecutorSession) share the same decision; passing it here keeps one rule, not two.
 */
export interface DetailDependencies {
  readonly ownedBy: (node: NodeRecord, sessionId: string | undefined) => boolean
  /** The engine's live `waitingFor` for one node, or `null` when the engine is not up yet or nothing
   *  is holding the node back. One accessor, so the row projection, the detail read and the tool
   *  result cannot disagree about why a mission is queued. */
  readonly waitingForOf: (nodeId: string) => WaitingFor | null
}

/** Trees one session owns, flattened the way the view renders them. */
export function treesForSession(
  tree: MissionTree | undefined,
  sessionId: string | undefined,
  waitingForOf: (nodeId: string) => WaitingFor | null,
): readonly TreeView[] {
  if (sessionId === undefined || sessionId === '') return []
  if (tree === undefined) return []
  return tree
    .trees()
    .filter((entry) => entry.ownerSessionId === sessionId)
    .map((entry) => ({
      rootId: entry.rootId,
      closedAt: entry.closedAt,
      nodes: tree.nodesOf(entry.rootId).map((node) => ({
        id: node.id,
        parentId: node.parentId,
        children: node.children,
        depth: node.depth,
        title: node.title,
        // The row projection carries COUNTS of the premise set, not the texts: see `wire.ts`'s
        // context rule. `context: []` is the legacy-compatibility shape (an older client still
        // requires the field); a current client derives the badge from `contextCount`.
        context: [],
        contextCount: node.context.length,
        corrections: node.corrections.slice(-ROW_CORRECTIONS_MAX),
        correctionCount: node.corrections.length,
        status: node.status,
        attempts: node.attempts,
        createdAt: node.createdAt,
        dispatchedAt: node.dispatchedAt,
        endedAt: node.endedAt,
        hasResult: node.hasResult,
        resultRef: node.resultRef,
        workerSessionId: workerSessionIdOf(node),
        workerLive: workerLiveOf(node),
        workerReleased: workerReleasedOf(node),
        weight: node.weight,
        waitingFor: waitingForOf(node.id),
      })),
    }))
    .reverse()
}

/**
 * One node's full detail: a second read rather than more snapshot, since results run to 2 KB and the
 * summary is re-read on every change. Children's results feed an aggregate's conclusion.
 *
 * Kept synchronous so a test can call it directly — the host's `@Remote('detail')` wraps it.
 */
export function detailOf(
  tree: MissionTree | undefined,
  sessionId: string | undefined,
  nodeId: string,
  dependencies: DetailDependencies,
): NodeDetailOutcome {
  if (tree === undefined) return { children: [], error: '任务引擎尚未启动' }
  const node = tree.node(nodeId)
  if (node === undefined) return { children: [], error: `任务 ${nodeId} 不存在` }
  if (!dependencies.ownedBy(node, sessionId)) {
    return { children: [], error: '这个任务属于别的会话' }
  }
  // By `children`, not `parentId`: a reused prerequisite was born under another parent.
  const children = node.children
    .map((id) => tree.node(id))
    .filter((child): child is NodeRecord => child !== undefined)
    .map((child) => ({
      id: child.id,
      title: child.title,
      status: child.status,
      result: child.result,
      resultPointer: child.resultRef === null ? null : spillPointer(child),
    }))
  return {
    node: {
      id: node.id,
      rootId: node.rootId,
      title: node.title,
      description: node.description,
      context: node.context,
      corrections: node.corrections,
      analysisNotes: node.analysisNotes,
      analysisAttempt: node.analysisAttempt,
      status: node.status,
      attempts: node.attempts,
      depth: node.depth,
      createdAt: node.createdAt,
      dispatchedAt: node.dispatchedAt,
      endedAt: node.endedAt,
      result: node.result,
      resultPointer: node.resultRef === null ? null : spillPointer(node),
      workerSessionId: workerSessionIdOf(node),
      workerLive: workerLiveOf(node),
      workerReleased: workerReleasedOf(node),
      weight: node.weight,
      waitingFor: dependencies.waitingForOf(node.id),
    },
    children,
  }
}
