/**
 * Work-tree vocabulary: node states, capacities, durable record shapes. The tree is the only
 * authoritative state holder — every execution reads what it needs from the node it was
 * dispatched for, never from an agent's conversation.
 *
 * @module @avantf/mission-core/types
 */

export type NodeStatus =
  /** Has non-terminal children; not dispatchable. */
  | 'blocked'
  /** The only spawnable status: no children yet, or all terminal. */
  | 'ready'
  /** Dispatched; `claimedBy` holds the worker. */
  | 'running'
  /** Worker vanished without submitting; dispatchable again. */
  | 'interrupted'
  /** Terminal: a result was submitted. */
  | 'done'
  /** Terminal: attempts exhausted, or rejected by a capacity check. */
  | 'failed'

/** Terminal statuses never change again. */
export const TERMINAL: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['done', 'failed'])

export const DISPATCHABLE: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['ready', 'interrupted'])

/** Capacities: exported so the tools and the engine validate against ONE source. */
export const CAPACITY = {
  /** Root is depth 1, so depth 8 allows at most seven consecutive decompositions. */
  maxDepth: 8,
  maxChildrenPerDecompose: 6,
  /** Backstop ceiling on one tree's size, checked before a `decompose` commits: depth (8) ×
   * children (6) leaves the count bounded but enormous, and the depth limit does not fire until
   * the eighth level. */
  maxNodesPerTree: 200,
  /** Execution-failure ceiling: a node reclaimed (vanished or stalled) this many times fails;
   * successful rounds do not count. The same ceiling bounds consecutive failed STARTS
   * (`spawnFailures`), tracked separately so an outage is not charged against the mission. */
  maxAttempts: 5,
  /** A node reclaimed for silence this many times gets a heads-up, not a decision request — the
   * engine recovers on its own, which is why it waits for a repeat. */
  maxStallsBeforeReport: 2,
  /** Longer results are spilled to the store; the node keeps the summary. */
  maxInlineResultChars: 2000,
} as const

export interface TreeRecord {
  /** Root node id; also the tree's id. */
  readonly rootId: string
  /** The agent that created the root: no other agent sees the tree, and the tree is destroyed
   * when this session stops existing. */
  readonly ownerSessionId: string
  readonly createdAt: number
  /** When the owner closed the tree out (`finish_mission`); `null` while open. Closing is archival —
   * nodes and results stay, but the tree leaves the guidance and the wake decision. */
  readonly closedAt: number | null
  /** When the owner was woken about this tree reaching a terminal state. Durable on purpose: an
   * in-memory guard re-reports on every dispatch pass after a restart. */
  readonly reportedAt: number | null
}

/**
 * What one dispatch's prompt showed its session, frozen so a LATER wake can subtract it: "what has
 * changed since this session last read this mission?" It is a snapshot of the node's ACCUMULATING
 * channels, not of its execution state — the execution state is the binding's business.
 *
 * Every component exists for one consumer; none is decoration:
 *
 * - `corrections` — the second half of "corrections this session has NOT seen" (the delivery
 *   watermark is the first). Both are needed: a FRESH spawn renders every correction but does not
 *   advance the watermark, so a watermark-only reading would call those corrections unseen forever
 *   and route every corrected mission to a fresh executor instead of continuing it.
 * - `notes` — how many analysis entries existed when the prompt was built; entries beyond it are the
 *   ones appended while this session held the node, which is what the delta reports.
 * - `terminalChildren` — for the delta's wording only ("N 子任务达到终态"). Deliberately NOT part of
 *   the material-change judgement, because for a PARKED session "all children terminal" is the
 *   trigger of the wake itself (see `isMaterialChange`).
 * - `fingerprint` — title+description at dispatch. A changed headline means this session would be
 *   resuming a mission it was never handed.
 * - `attempts` — the dispatch generation this prompt was built under, compared against
 *   `analysisAttempt` to tell whether the node's latest note belongs to THIS dispatch.
 *
 * Missing on a record written before the field existed: that reads as "no baseline", which a wake
 * must treat as UNKNOWN rather than as "nothing changed" (see `computeContinuationDelta`).
 */
export interface DispatchBaseline {
  readonly corrections: number
  readonly notes: number
  readonly terminalChildren: number
  readonly fingerprint: string
  readonly attempts: number
}

export interface NodeRecord {
  readonly id: string
  readonly rootId: string
  /** The parent that created this node; `null` for the root. Provenance only: dedup reuse can list
   * a node under several parents' `children` while it keeps the `parentId` it was born under. */
  readonly parentId: string | null
  readonly title: string
  readonly description: string
  /** Background facts: why this mission exists (written by the decomposer), or the owner's initial
   * analysis for a root — the only channel carrying the vertical "why" down the mission chain. */
  readonly context: readonly string[]
  /** The owner's corrections for this mission, newest last. The name is load-bearing because the
   * field is persisted: renaming it would make every earlier correction load as absent. Separate
   * from `context` on purpose — different author and lifetime. */
  readonly corrections: readonly string[]
  /** Delivery watermark for {@link corrections}: how many LEADING entries are confirmed delivered
   * to the executor that was holding this node. What it decides is the WAKE message — a cold resume
   * renders only `corrections.slice(correctionsDeliveredUpTo)`, because the corrections already
   * handed to that very session must not be argued to it a second time. A FRESH executor ignores
   * the watermark entirely and sees every correction: it has read none of them.
   *
   * `0` means "nothing is confirmed delivered", which is also what a record written before this
   * field existed loads as — the conservative reading, since a silently skipped correction is a
   * direction the owner gave that nobody ever reads. Monotone: a raced, older report can never pull
   * it back. Kept as a NUMBER beside the text array rather than turning `corrections` into objects,
   * because changing that array's shape would make every historical correction load as absent. */
  readonly correctionsDeliveredUpTo: number
  /** What this mission's executors recorded with `note_mission`, oldest first. The durable channel
   * across sessions: the round that judges the mission is a fresh session reading only this node's
   * prompt, and notes are appended, never replaced. */
  readonly analysisNotes: readonly string[]
  /** The `attempts` value of the dispatch that wrote the LAST entry; `0` when none. `decompose`
   * compares it against the current `attempts`, so an executor cannot inherit a justification
   * written by an earlier round. */
  readonly analysisAttempt: number
  readonly status: NodeStatus
  readonly createdAt: number
  readonly depth: number
  /** Durable binding to the worker session id, persisted so a hot reload can tell "someone is
   * still on this"; the agent's existence is always resolved live, never asserted from here. */
  readonly claimedBy: string | null
  readonly claimedAt: number
  readonly attempts: number
  /** Execution-failure budget: how many times this node's worker was reclaimed (vanished or
   * stalled) without producing a result. Separate from `attempts`, which counts EVERY dispatch —
   * including successful aggregate/convergence rounds — so succeeding never burns this budget. */
  readonly failures: number
  /** How many times in a row a dispatch failed to even START a worker (the runtime refused, or the
   * tool filter could not be applied). An infrastructure failure, so it is budgeted separately
   * from `failures` and pushes the next dispatch back by a cooldown; a successful start resets it. */
  readonly spawnFailures: number
  /** The worker session that PARKED this node by decomposing it — a wake-up ADDRESS, not a claim:
   * `claimedBy` is cleared exactly as usual, and the address is consumed by the next dispatch
   * (adopted, or replaced by a fresh session). `nextDispatchable` excludes a parked node, because
   * `decompose_mission` is followed by a synchronous `pump()` that would otherwise pre-empt the wake. */
  readonly parkedWorker: string | null
  /** The session id of the worker most recently bound to this node, kept when the binding is
   * dropped by an INTERRUPTION rather than by a clean hand-off — i.e. `reconcileOnOpen` demoting a
   * `running` node whose worker is not materialized in this process (a restart or a crash), which
   * is exactly when `claimedBy` alone loses the address for good. The next dispatch of this node
   * first tries to CONTINUE that session (cold wake) instead of starting a fresh executor; a
   * delivery the runtime refuses falls back to a brand-new session with no budget charged.
   *
   * Deliberately NOT the same thing as `parkedWorker`, and neither may overwrite the other:
   * a parked worker is an ALIVE, actively waiting continuation (it decomposed and expects to be
   * woken in the same run); `lastWorkerId` is a handle to a session that may no longer exist, and
   * the cold resume that reaches it is allowed to fail. Only `reconcileOnOpen` writes it, and only
   * `adoptContinuation` consumes it — a same-process reclaim does not, so ordinary re-dispatch
   * behaviour is untouched. `null` for a node that was never dispatched or whose handle was spent,
   * which is also the value a record written before this field existed loads as. */
  readonly lastWorkerId: string | null
  /** What the prompt of the LAST dispatch showed its session, stamped by the host the moment that
   * prompt was ACCEPTED (not when the node was bound: a dispatch whose prompt was never built or
   * never delivered must not leave a baseline claiming the session read something). The cold wake
   * subtracts it to get the delta it renders, and the same delta decides whether continuing is honest
   * at all; a FRESH spawn ignores it entirely, because a new executor has read nothing.
   *
   * Deliberately NOT the same thing as `analysisAttempt` (that is `note_mission`'s generation gate)
   * and NOT derived from `correctionsDeliveredUpTo` (that is one half of the correction story, and
   * the weaker half — see {@link DispatchBaseline}). `null` for a node never dispatched by a host
   * that stamps baselines, which is also the value a record written before this field existed loads
   * as; that direction is the safe one, because "unknown" renders an honest caveat and never a
   * fabricated "nothing changed". */
  readonly dispatchBaseline: DispatchBaseline | null
  /** When this node's worker was last seen doing something. Bumped by durable activity in the
   * worker's own session, which keeps a long but ACTIVE run safe from the stale check (it compares
   * its window against this, not `claimedAt`); `0` means never observed and falls back to `claimedAt`. */
  readonly progressAt: number
  /** Times this node was reclaimed because its worker went silent past the stale window; a worker
   * that merely vanished is not the node's fault and does not count here. */
  readonly stalls: number
  /** When the owner was told this node keeps stalling; `null` until then. Durable for the same
   * reason as `TreeRecord.reportedAt`: an in-memory memo is empty after a restart. */
  readonly stalledNotifiedAt: number | null
  /** Inline result (the summary when the full text was spilled). */
  readonly result: string | null
  /** Distinguishes "no result written" from "an empty result was written". */
  readonly hasResult: boolean
  readonly resultReadAt: number | null
  readonly resultRef: string | null
  /** The backend's retrieval guidance for `resultRef`, persisted because a locator without its
   * hint leaves the reader unable to fetch the full text. `null` when nothing was spilled. */
  readonly resultHint: string | null
  /** Child ids in decomposition order. */
  readonly children: readonly string[]
  readonly updatedAt: number
}

export interface ChildSpec {
  readonly title: string
  readonly description: string
  readonly context: readonly string[]
}

/** Why a node stopped being dispatchable, for the failure report. */
export interface FailureInfo {
  readonly reason: string
  readonly at: number
}

/** A dispatch candidate: the node plus its resolved mission chain and, exactly when the node is a
 * ready aggregate, the current children results. */
export interface DispatchView {
  readonly node: NodeRecord
  /** Ancestors root → parent, each reduced to title + basic facts. */
  readonly chain: readonly NodeRecord[]
  /** Terminal children of an aggregate, in decomposition order. */
  readonly children: readonly NodeRecord[]
}

export interface DecomposeOutcome {
  readonly created: readonly string[]
  /** Children whose equivalent already existed in the subtree and were reused. */
  readonly reused: readonly string[]
}

/** Why a mutation was refused. Returned instead of thrown so tools can report it. */
export type RefusalCode =
  | 'not-found'
  | 'not-owner'
  | 'terminal'
  /** The node still has non-terminal children, so the mutation it refused must wait. */
  | 'has-children'
  | 'not-dispatchable'
  | 'depth-exceeded'
  | 'too-many-children'
  | 'no-children'
  /** Nothing below the node is unfinished, so there is nothing to cancel. */
  | 'nothing-to-cancel'
  | 'unread-result'
  /** The addressed node is not a root, and only a root takes the mutation. */
  | 'not-root'
  | 'node-limit'
  /** The node is not terminal, so it is not the owner's to delete. */
  | 'not-deletable'
  | 'closed'
  /** The caller is not a top-level session, so it has no authority to own a tree. */
  | 'no-authority'
  /** The tool was reached with no caller agent bound at all, so there is nobody to check authority
   *  against. Produced by the tool layer — the one place a call can arrive callerless — and listed
   *  here so a consumer that exhausts this union does not silently drop it. */
  | 'no-caller'
  /** `note_mission` was given text with no non-blank line, so there is nothing to record. */
  | 'no-analysis'
  /** A required text argument reached the engine containing nothing but whitespace. The tool layer's
   *  non-empty check only sees the EMPTY string, so without this a blank title, result or correction
   *  was accepted and persisted — then rendered back into every later dispatch. */
  | 'blank-text'
  /** `decompose_mission` was called by a dispatch that has not written its own analysis: a split
   * must be argued for by the round performing it, not inherited from an earlier one. */
  | 'analysis-missing'

/** A refused mutation, with a stable code the caller can branch on. */
export interface Refusal {
  readonly ok: false
  readonly code: RefusalCode
  readonly message: string
}

/** A successful mutation. */
export interface Accepted<T> {
  readonly ok: true
  readonly value: T
}

export type MutationResult<T> = Accepted<T> | Refusal

/** One tree as stored: identity plus nodes keyed by id. The durable and in-memory shapes are the
 * same value; the store validates on read and writes it whole. */
export interface TreeDocument {
  tree: TreeRecord
  nodes: Record<string, NodeRecord>
}

export function refuse(code: RefusalCode, message: string): Refusal {
  return { ok: false, code, message }
}

export function accept<T>(value: T): Accepted<T> {
  return { ok: true, value }
}
