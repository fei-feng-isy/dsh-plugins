/**
 * Work-tree vocabulary: node states, capacities, durable record shapes. The tree is the only
 * authoritative state holder — every execution reads what it needs from the node it was
 * dispatched for, never from an agent's conversation.
 *
 * @module @avantf/work-core/types
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
   * (`spawnFailures`), tracked separately so an outage is not charged against the work. */
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
  /** When the owner closed the tree out (`finish_work`); `null` while open. Closing is archival —
   * nodes and results stay, but the tree leaves the guidance and the wake decision. */
  readonly closedAt: number | null
  /** When the owner was woken about this tree reaching a terminal state. Durable on purpose: an
   * in-memory guard re-reports on every dispatch pass after a restart. */
  readonly reportedAt: number | null
}

export interface NodeRecord {
  readonly id: string
  readonly rootId: string
  /** The parent that created this node; `null` for the root. Provenance only: dedup reuse can list
   * a node under several parents' `children` while it keeps the `parentId` it was born under. */
  readonly parentId: string | null
  readonly title: string
  readonly description: string
  /** Background facts: why this work exists (written by the decomposer), or the owner's initial
   * analysis for a root — the only channel carrying the vertical "why" down the work chain. */
  readonly context: readonly string[]
  /** The owner's corrections for this work, newest last. The name is load-bearing because the
   * field is persisted: renaming it would make every earlier correction load as absent. Separate
   * from `context` on purpose — different author and lifetime. */
  readonly corrections: readonly string[]
  /** What this work's executors recorded with `note_work`, oldest first. The durable channel
   * across sessions: the round that judges the work is a fresh session reading only this node's
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
   * `decompose_work` is followed by a synchronous `pump()` that would otherwise pre-empt the wake. */
  readonly parkedWorker: string | null
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

/** A dispatch candidate: the node plus its resolved work chain and, exactly when the node is a
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
  /** `note_work` was given text with no non-blank line, so there is nothing to record. */
  | 'no-analysis'
  /** `decompose_work` was called by a dispatch that has not written its own analysis: a split
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
