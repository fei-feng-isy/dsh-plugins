/**
 * The client half's own vocabulary, declared here rather than imported from
 * `@avantf/mission-core`: the browser bundle must not pull the host engine in.
 * @module @avantf/dsh-mission/client/contract
 */

/**
 * Why a node is queued instead of running, as the host reports it. The browser half's own copy (it
 * must not import the engine); `null`/absent on the node means nothing is holding it back.
 */
export interface WaitingForView {
  readonly reason: 'capacity' | 'unit' | 'slot' | 'aging'
  /** Which capacity signal, when `reason` is `capacity`: compute units or the free-memory floor. */
  readonly resource?: 'cpu' | 'memory'
  readonly needed?: number
  readonly available?: number
  readonly unit?: string
}

export interface MissionNodeView {
  readonly id: string
  /** Where the node was born; `children` is the dependency edge it is rendered by. */
  readonly parentId: string | null
  /** The ids this node depends on (a reused prerequisite appears in several parents). */
  readonly children: readonly string[]
  readonly depth: number
  readonly title: string
  /** Why this mission exists (written by whoever decomposed its parent). In the ROW projection the
   *  texts are no longer carried (a current host sends `[]`); the detail dialog has every one. A
   *  non-empty array is what an OLDER host still sends, and {@link contextCount} falls back to it. */
  readonly context: readonly string[]
  /** How many premises the mission carries — the row's marker. The detail dialog renders the texts. */
  readonly contextCount?: number
  /** The owner's corrections, newest last. A row renders the count as a "steered" marker: the title
   *  above is the goal as created, so a corrected mission needs this to be readable at all. Capped to
   *  the newest few by a current host; {@link correctionCount} is the true number. */
  readonly corrections: readonly string[]
  /** The owner's FULL correction count, including any past the row cap. Optional so a client built
   *  before this field still renders (the badge falls back to `corrections.length`). */
  readonly correctionCount?: number
  readonly status: string
  readonly attempts: number
  readonly createdAt: number
  /** When this node was FIRST dispatched, or `null` while it is still queued. Optional because an
   *  older host does not send it, and absence reads exactly like `null` (= never dispatched). */
  readonly dispatchedAt?: number | null
  /** When this node reached a terminal status, or `null` while it is still in play. Optional for the
   *  same reason as {@link dispatchedAt}. */
  readonly endedAt?: number | null
  readonly hasResult: boolean
  readonly resultRef: string | null
  /** The session that ran this node LAST, or `null` when none ever did. Carried in the ROW
   *  projection as well as the detail so a row can offer "open the executor" without a second read.
   *  It is a DISPLAY address kept after the session ended (the panel's node-id entry opens it), so it
   *  is not the same thing as "is running now" — that is {@link workerLive}. */
  readonly workerSessionId: string | null
  /** Whether {@link workerSessionId} is still running: the node-id entry uses it to say 进行中 or
   *  已结束. Optional because an older host does not send it, and absence reads as "not live". */
  readonly workerLive?: boolean
  /** Whether {@link workerSessionId} was RELEASED off disk by the host's cleanup pipeline. Optional
   *  on purpose, and absence reads as `false` = "not known to be released", which is exactly today's
   *  behaviour: the entry TRIES the handle. A host that does send it `true` means the session is gone,
   *  so a click must not open anything — it renders the explanation instead.
   *
   *  Deliberately NOT derived from {@link workerLive}: a finished mission's session is not live but is
   *  still perfectly openable (that is the whole point of the display handle), so "已结束" and "已被
   *  回收" are two different states and the entry treats them differently. */
  readonly workerReleased?: boolean
  /** Declared capacity weight (cores-equivalent); an older host omits it and reads as 1. */
  readonly weight?: number
  /** Why this node is queued; absent/`null` means nothing is holding it back. */
  readonly waitingFor?: WaitingForView | null
}

export interface MissionTreeViewData {
  readonly rootId: string
  readonly nodes: readonly MissionNodeView[]
  /** Epoch millis when the owner archived the tree; `null` while it is live. */
  readonly closedAt: number | null
}

export interface MissionSnapshot {
  readonly trees: readonly MissionTreeViewData[]
  /**
   * The host's reported wire revision (`wire.ts`'s `SNAPSHOT_WIRE_VERSION`), carried forward so a
   * later click can refuse to call a method this host never registered. `undefined` means the host
   * predates the marker, which is the same vintage as the oldest revision.
   */
  readonly wire?: number
  /**
   * A version-skew note from the host half — set when the payload's `wire` marker is absent (older
   * host) or unknown (newer host). The trees are still rendered: the marker is a note, not a failure.
   */
  readonly skew?: string
}

export interface MissionSnapshotState {
  readonly data: MissionSnapshot | undefined
  readonly loading: boolean
  readonly error: string | undefined
  readonly refresh: () => Promise<void>
}

export interface MissionNodeDetailView {
  readonly id: string
  readonly rootId: string
  readonly title: string
  readonly description: string
  /** Why this mission exists — the premise the decomposer attached (the owner's initial judgement,
   *  for a root). NOT the same as `description`, which is what the mission must achieve. */
  readonly context: readonly string[]
  /** What this mission's executors recorded with `note_mission` before splitting it: the blocker, the
   *  paths ruled out, what the prerequisites have to settle. Oldest first; appended, never replaced. */
  readonly analysisNotes: readonly string[]
  /** The `attempts` value of the dispatch that wrote the LAST analysis note; `0` when there is none. */
  readonly analysisAttempt: number
  /** The direction changes this mission was given, newest last — rendered between the goal and the
   *  result so the two can be read together rather than as a mismatch. */
  readonly corrections: readonly string[]
  readonly status: string
  readonly attempts: number
  readonly depth: number
  /** When this node was accepted into the tree. Optional: an older host does not send it, and the
   *  dialog's timing line then prints 「受理 —」 rather than invented epoch time. */
  readonly createdAt?: number | null
  /** When this node was FIRST dispatched, or `null` while it is still queued. The detail dialog shows
   *  the full 受理/派发/结束 line; the row shows the compact form. Optional for the same reason as the
   *  row projection's copy. */
  readonly dispatchedAt?: number | null
  /** When this node reached a terminal status, or `null` while it is still in play. */
  readonly endedAt?: number | null
  /** The mission's own submitted result, or null while it has not submitted one. */
  readonly result: string | null
  /** Where an oversized result was spilled, so the reader can still open it. */
  readonly resultPointer: string | null
  /** The session that ran this node LAST, or `null` when none ever did. This is the NODE's executor
   *  — a different id from `id`, which names the mission. A node whose attempt was reclaimed, or one
   *  that finished, still carries its LAST executor here on purpose: the panel's node-id entry opens
   *  that session, and a finished mission is exactly when a reader wants to look back at it. */
  readonly workerSessionId: string | null
  /** Whether {@link workerSessionId} is still running (see the row projection's copy). */
  readonly workerLive?: boolean
  /** Whether {@link workerSessionId} was released off disk (see the row projection's copy). Carried in
   *  the detail too because the dialog's heading id is the same entry as the tree header's. */
  readonly workerReleased?: boolean
  /** Declared capacity weight (cores-equivalent); an older host omits it and reads as 1. */
  readonly weight?: number
  /** Why this node is queued; absent/`null` means nothing is holding it back. */
  readonly waitingFor?: WaitingForView | null
}

export interface MissionNodeDetailChild {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly result: string | null
  readonly resultPointer: string | null
}

/** What a clicked row expands into. Read on demand, never part of the snapshot. */
export interface MissionNodeDetail {
  readonly node: MissionNodeDetailView
  readonly children: readonly MissionNodeDetailChild[]
}

/**
 * One worker session as the host's optional `uiWorkspace.openSession` takes it: the durable
 * parent/child address of a *continuable* subagent — the same target the main UI sends when a child
 * is picked from the "N 个子智能" dropdown. Declared structurally rather than imported from the
 * host's `dsh-api-session-controller` types, like the rest of this file: the browser bundle must not
 * take a dependency on a host package's client types.
 */
export interface WorkerSessionTarget {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly mode: 'continuable'
}

/**
 * What a CLICK-TIME executor lookup answered (W18), as the view consumes it. `resolved` carries the
 * session to open; the other three are the distinguishable ways there is nothing to open, which the
 * view renders as different sentences:
 *
 * - `never-dispatched` — the record proves no session ever ran this node;
 * - `not-found` — it ran once, and the session is gone (cleaned up, or its log is not on this host);
 * - `unsupported` — this host cannot look anything up at all (no session service, or an older host
 *   whose Remote face predates the method).
 */
export interface ExecutorSessionLookup {
  readonly status: 'resolved' | 'never-dispatched' | 'not-found' | 'unsupported'
  /** Present when `status` is `resolved`. */
  readonly sessionId?: string
  /** The host's own words when it has any (a missing service, a failed listing). */
  readonly error?: string
}

export interface MissionViewProps {
  /** Read the current snapshot and keep it updated. */
  readonly useSnapshot: () => MissionSnapshotState
  /** Delete one whole finished mission tree by root; rejects with the host's reason, which the view shows. */
  readonly onDeleteTree: (rootId: string) => Promise<void>
  /**
   * Delete EVERY closed (finish_mission-archived) tree this session owns, in one batch — the panel's
   * "清理已完成". ABSENT when this host has no such call (an older host): the button is then not
   * rendered at all rather than offered and doomed. Rejects with the host's reason, which the view
   * shows; resolves to the two root-id lists the host reported so the panel can say what happened.
   */
  readonly onCleanFinished?: () => Promise<{ deleted: readonly string[]; skipped: readonly string[] }>
  readonly loadDetail: (nodeId: string) => Promise<MissionNodeDetail>
  /** Read the FULL text behind a spilled result; rejects with the host's reason, which the pane shows. */
  readonly loadResult: (nodeId: string) => Promise<string>
  /** The owner session these trees belong to — the PARENT half of a worker-session address. */
  readonly sessionId: string
  /**
   * Ask the host to open the session that ran a mission. ABSENT when this host has no `uiWorkspace`
   * service — the id then renders as plain text, never as a dead link, and everything else in the
   * panel keeps working. `uiWorkspace` is fetched optionally for exactly this reason: a host without
   * it must still mount this plugin (see `client/index.ts`, and `inject` there deliberately omits it).
   */
  readonly openWorkerSession?: (target: WorkerSessionTarget) => void
  /**
   * Find the session that ran a node whose record has no handle (W18). Called ONLY from a click —
   * it is a Remote call whose server side lists sessions and reads a few logs, so nothing on the
   * render path may touch it. Rejecting means "the lookup itself failed"; a `not-found`/`unsupported`
   * ANSWER is a result, not an error.
   */
  readonly resolveWorkerSession?: (nodeId: string) => Promise<ExecutorSessionLookup>
}
