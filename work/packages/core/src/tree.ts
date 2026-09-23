/**
 * The work tree: the only authoritative state holder. Mutations are serialized through one
 * promise chain, so "inspect → mark → dispatch" is atomic without an explicit lock primitive;
 * nodes are immutable values, replaced and flushed to the store before the lock is released.
 *
 * @module @avantf/work-core/tree
 */
import { statusLabel } from './prompt.js'
import {
  CAPACITY,
  DISPATCHABLE,
  TERMINAL,
  accept,
  refuse,
  type ChildSpec,
  type DecomposeOutcome,
  type DispatchView,
  type MutationResult,
  type NodeRecord,
  type NodeStatus,
  type TreeRecord,
} from './types.js'

export interface TreeState {
  tree: TreeRecord
  nodes: Map<string, NodeRecord>
}

/** Durable sink for tree records; the store owns batching and durability. */
export interface TreeStore {
  /** Every persisted tree document, for startup reconciliation. */
  loadAll(): Promise<TreeState[]>
  /** Persist one tree document. Resolves once the write is durable. */
  put(state: TreeState): Promise<void>
  remove(rootId: string): Promise<void>
}

/** One persisted spill artifact: where it is, and how to read it back. */
export interface SpilledText {
  /** Opaque model-facing locator produced by the storage backend. */
  readonly locator: string
  /** The backend's retrieval guidance, shown next to the locator. */
  readonly hint: string
}

/** Injected environment facts; the core never imports the harness. */
export interface TreeDeps {
  isAgentLive(sessionId: string): boolean
  /** Whether a session still EXISTS, asked of durable storage rather than the live registry: an
   * agent is materialized on demand, so right after a restart a live check is false. Ownership is
   * decided by this one. */
  ownerExists(sessionId: string): Promise<boolean>
  /** Persist an over-long result, or return `null` when no spill backend is configured — the node
   * then keeps the full text inline, because a locator nobody can resolve loses the tail. */
  spill(text: string): Promise<SpilledText | null>
  /** Clock, injectable for tests. */
  now(): number
  /** Id generator, injectable for tests. */
  newId(): string
}

export interface CreateRootInput {
  readonly ownerSessionId: string
  readonly title: string
  readonly description: string
  /** The owner's initial analysis; stored as the root's background facts. */
  readonly analysis: readonly string[]
}

export interface DispatchDecision {
  readonly view: DispatchView
  /** The child session id reserved for this dispatch, already bound on the node. */
  readonly claimId: string
}

const MAX_ID_ATTEMPTS = 8

/** Cooldown after a dispatch fails to START a worker, so a transient runtime outage cannot burn a
 * node's whole budget in a few pump cycles: exponential in the consecutive spawn failures, capped
 * so a node still retries within minutes. */
const SPAWN_BACKOFF_BASE_MS = 30_000
const SPAWN_BACKOFF_MAX_MS = 10 * 60_000

function spawnBackoffMs(n: number): number {
  if (n <= 0) return 0
  return Math.min(SPAWN_BACKOFF_BASE_MS * 2 ** (n - 1), SPAWN_BACKOFF_MAX_MS)
}

/** Random 8-hex-char id, matching the short ids the tools expose. `crypto` is reached through a
 * typed globals lookup because the core is built without DOM or Node ambient types. */
export function defaultNewId(): string {
  const bytes = new Uint8Array(4)
  const crypto = (globalThis as Record<string, unknown>)['crypto'] as
    | { getRandomValues<T extends ArrayBufferView>(array: T): T }
    | undefined
  if (crypto === undefined) throw new Error('avantf-work: no crypto.getRandomValues available')
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Order candidates: oldest first (cross-tree fairness), then by id for stability. */
function byCreatedAtThenId(a: NodeRecord, b: NodeRecord): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Normalize for equivalence comparison during decomposition dedup. */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/** The identity the decomposition dedup compares on — exactly what {@link findEquivalent} matches. */
function childIdentity(title: string, description: string): string {
  return `${normalizeTitle(title)}\u0000${normalizeTitle(description)}`
}

/** Add only the new background facts to a reused node; `undefined` when none. */
function withAddedContext(node: NodeRecord, facts: readonly string[]): NodeRecord | undefined {
  const added = facts.filter((fact) => !node.context.includes(fact))
  return added.length === 0 ? undefined : { ...node, context: [...node.context, ...added] }
}

/** Split an analysis text into the entries a node stores: one per non-blank trimmed line, because
 * a model's short paragraph rendered as a single prompt bullet is unreadable. Blank-only text
 * yields `[]`, which the caller turns into a refusal. */
function analysisLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Append only the notes this node does not carry yet, in order: a re-run reaching the same
 * conclusion must not pile up the same paragraph, while a genuinely new judgement is a new entry. */
function appendNotes(notes: readonly string[], added: readonly string[]): readonly string[] {
  return [...notes, ...added.filter((note) => !notes.includes(note))]
}

export class WorkTree {
  private readonly states = new Map<string, TreeState>()
  private chain: Promise<unknown> = Promise.resolve()
  private store: TreeStore | undefined
  /** Trees whose in-memory progress moved since the last durable flush. */
  private readonly progressDirty = new Set<string>()

  constructor(
    store: TreeStore | undefined,
    private readonly deps: TreeDeps,
  ) {
    this.store = store
  }

  /** Attach the durable store. A plugin can only open its storage domain inside `apply`, so the
   * tree is constructed first and wired before any read; `open()` fails loudly without one. */
  attachStore(store: TreeStore): void {
    this.store = store
  }

  private requireStore(): TreeStore {
    if (this.store === undefined) {
      throw new Error('avantf-work: work tree has no store attached')
    }
    return this.store
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Load every persisted tree and reconcile bindings against live agents: a `running` node whose
   * `claimedBy` no longer resolves is reclaimed as `interrupted`, restart and hot reload alike. */
  async open(): Promise<void> {
    const loaded = await this.requireStore().loadAll()
    this.states.clear()
    for (const state of loaded) {
      const reconciled = new Map<string, NodeRecord>()
      for (const [id, node] of state.nodes) {
        reconciled.set(id, this.reconcileOnOpen(node))
      }
      this.states.set(state.tree.rootId, { tree: state.tree, nodes: reconciled })
    }
    // Persist reconciliations so a crash cannot leave durable `running` records at odds with memory.
    for (const state of this.states.values()) {
      if ([...state.nodes.values()].some((n) => n.status === 'interrupted')) {
        await this.requireStore().put(state)
      }
    }
  }

  private reconcileOnOpen(node: NodeRecord): NodeRecord {
    if (node.status !== 'running') return node
    if (node.claimedBy !== null && this.deps.isAgentLive(node.claimedBy)) {
      // Hot-reload survivor: reset progressAt, or a long run looks silent from the moment we open.
      return { ...node, progressAt: this.deps.now() }
    }
    return { ...node, status: 'interrupted', claimedBy: null, updatedAt: this.deps.now() }
  }

  /** Trees whose owner session no longer exists, asked of durable storage rather than the live
   * registry, so a restart keeps its trees and only a genuinely deleted session loses them. */
  async orphanedTrees(): Promise<TreeRecord[]> {
    const orphaned: TreeRecord[] = []
    for (const state of this.states.values()) {
      if (!(await this.deps.ownerExists(state.tree.ownerSessionId))) orphaned.push(state.tree)
    }
    return orphaned
  }

  async destroyTree(rootId: string): Promise<void> {
    await this.withLock(async () => {
      if (!this.states.has(rootId)) return
      this.states.delete(rootId)
      await this.requireStore().remove(rootId)
    })
  }

  // ── reads (synchronous: the in-memory view is authoritative while open) ──

  treeOf(rootId: string): TreeRecord | undefined {
    return this.states.get(rootId)?.tree
  }

  node(id: string): NodeRecord | undefined {
    for (const state of this.states.values()) {
      const found = state.nodes.get(id)
      if (found !== undefined) return found
    }
    return undefined
  }

  /** Claim the right to report one tree's terminal state: true exactly once per transition,
   * durably, so an engine restart cannot produce a second wake. */
  async claimReport(rootId: string): Promise<boolean> {
    return this.withLock(async () => {
      const state = this.states.get(rootId)
      if (state === undefined) return false
      if (state.tree.reportedAt !== null) return false
      this.states.set(rootId, {
        tree: { ...state.tree, reportedAt: this.deps.now() },
        nodes: state.nodes,
      })
      await this.flush(rootId)
      return true
    })
  }

  /** Allow a later terminal transition of the same tree to be reported again. */
  async clearReport(rootId: string): Promise<void> {
    await this.withLock(async () => {
      const state = this.states.get(rootId)
      if (state === undefined || state.tree.reportedAt === null) return
      this.states.set(rootId, { tree: { ...state.tree, reportedAt: null }, nodes: state.nodes })
      await this.flush(rootId)
    })
  }

  trees(): readonly TreeRecord[] {
    return [...this.states.values()].map((s) => s.tree).sort((a, b) => a.createdAt - b.createdAt)
  }

  nodesOf(rootId: string): readonly NodeRecord[] {
    const state = this.states.get(rootId)
    if (state === undefined) return []
    return [...state.nodes.values()].sort(byCreatedAtThenId)
  }

  /** Ancestors of a node, root → parent. */
  chainOf(node: NodeRecord): readonly NodeRecord[] {
    const state = this.states.get(node.rootId)
    if (state === undefined) return []
    const chain: NodeRecord[] = []
    let cursor = node.parentId
    while (cursor !== null) {
      const parent = state.nodes.get(cursor)
      if (parent === undefined) break
      chain.push(parent)
      cursor = parent.parentId
    }
    return chain.reverse()
  }

  /** The current dispatch view for one node. Built at spawn time, not dispatch time, so the prompt
   * reflects children results that landed between the dispatch decision and the spawn. */
  view(nodeId: string): DispatchView | undefined {
    const found = this.locate(nodeId)
    if (found === undefined) return undefined
    const { node } = found
    return {
      node,
      chain: this.chainOf(node),
      children: node.children.length > 0 ? this.terminalChildren(node) : [],
    }
  }

  /** Terminal children of an aggregate, in decomposition order. */
  terminalChildren(node: NodeRecord): readonly NodeRecord[] {
    const state = this.states.get(node.rootId)
    if (state === undefined) return []
    return node.children
      .map((id) => state.nodes.get(id))
      .filter((child): child is NodeRecord => child !== undefined && TERMINAL.has(child.status))
  }

  /** The next node to dispatch: `ready`/`interrupted`, oldest first across trees, excluding ones
   * whose binding still resolves to a live agent. A vanished worker's node is reclaimed by the
   * engine's sweep before it becomes a candidate again. */
  nextDispatchable(exclude: ReadonlySet<string> = new Set()): NodeRecord | undefined {
    const now = this.deps.now()
    const candidates: NodeRecord[] = []
    for (const state of this.states.values()) {
      // A closed tree is archived: it is never dispatched again.
      if (state.tree.closedAt !== null) continue
      // No live owner means no parent for a worker, so dispatching would only burn attempts on
      // spawns that cannot happen; the tree waits for its owner to come back.
      if (!this.deps.isAgentLive(state.tree.ownerSessionId)) continue
      for (const node of state.nodes.values()) {
        if (exclude.has(node.id)) continue
        if (!DISPATCHABLE.has(node.status)) continue
        if (node.claimedBy !== null && this.deps.isAgentLive(node.claimedBy)) continue
        // A parked node has a session waiting to be woken, and `decompose_work` is followed by a
        // synchronous `pump()`, so offering it here would consume the address before the owner's
        // turn could wake it — the wake path would be unreachable.
        if (node.parkedWorker !== null) continue
        // Cooling down after a failed START: `claimedAt` is that dispatch's time, so the backoff
        // is waited out rather than re-failing on every pump until the budget burns.
        if (node.spawnFailures > 0 && now - node.claimedAt < spawnBackoffMs(node.spawnFailures)) continue
        candidates.push(node)
      }
    }
    candidates.sort(byCreatedAtThenId)
    return candidates[0]
  }

  /** Nodes waiting for their parked session to be woken: `ready` with a recorded address, i.e. all
   * children terminal and a session to continue in. The owner's wake gate admits on this. */
  parkedReadyNodes(rootId?: string): readonly NodeRecord[] {
    const scoped = rootId === undefined
      ? [...this.states.values()]
      : [this.states.get(rootId)].filter((state): state is TreeState => state !== undefined)
    const parked: NodeRecord[] = []
    for (const state of scoped) {
      if (state.tree.closedAt !== null) continue
      for (const node of state.nodes.values()) {
        if (node.status === 'ready' && node.parkedWorker !== null) parked.push(node)
      }
    }
    return parked
  }

  /** Claim a parked node FOR its parked session so it can be woken rather than replaced. Unlike
   * `dispatch` it reserves no new claim id — the identity is the parked session — and consumes
   * `parkedWorker` in the same locked step, so a concurrent pass cannot both adopt and re-dispatch
   * it. The claim must land BEFORE the wake is delivered, because a woken session may submit or
   * decompose immediately and both authorize on `claimedBy`; a failed delivery is undone by a
   * `reclaim(..., 'wake-failed')`. */
  async adoptParked(nodeId: string, workerId: string): Promise<MutationResult<DispatchView>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `工作 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.parkedWorker === null || node.parkedWorker !== workerId) {
        // Address consumed elsewhere or never pointed here; refusing is the whole guard against
        // waking a session that no longer owns this node.
        return refuse('not-dispatchable', `工作 ${nodeId} 没有停在 ${workerId}`)
      }
      // Must honour exactly the `parkedReadyNodes` condition, or the gate admits a step this refuses.
      // Deliberately asymmetric with `dispatch`: the ceilings are NOT consulted, because the parked
      // session already knows what the children were for; the next `dispatch` still sees them.
      if (node.status !== 'ready') {
        return refuse('not-dispatchable', `工作 ${nodeId} 处于 ${statusLabel(node.status)}，不能唤醒`)
      }
      if (node.claimedBy !== null && this.deps.isAgentLive(node.claimedBy)) {
        return refuse('not-dispatchable', `工作 ${nodeId} 仍被一个在运行的执行者持有`)
      }
      const updated = this.replace(state, node, {
        status: 'running',
        claimedBy: workerId,
        claimedAt: this.deps.now(),
        attempts: node.attempts + 1,
        progressAt: this.deps.now(),
        parkedWorker: null,
      })
      await this.flush(state.tree.rootId)
      return accept({
        node: updated,
        chain: this.chainOf(updated),
        children: updated.children.length > 0 ? this.terminalChildren(updated) : [],
      })
    })
  }

  /** Nodes bound to a worker and not yet resolved, deliberately NOT filtered by worker liveness:
   * a reserved claim id is not an agent until the child materializes, so counting only live
   * holders would let a second dispatch pass in the same tick over-subscribe the pool. */
  inFlightCount(): number {
    let count = 0
    for (const state of this.states.values()) {
      // A closed tree is archived, so its nodes must not hold a concurrency slot (as in nextDispatchable).
      if (state.tree.closedAt !== null) continue
      for (const node of state.nodes.values()) {
        if (node.status === 'running' && node.claimedBy !== null) count += 1
      }
    }
    return count
  }

  /** Roll up every OPEN tree into the counts the guidance layer renders; closed trees are archived
   * and no longer echo into the owner's prompt. */
  summary(): { trees: number; ready: number; running: number; blocked: number; done: number; failed: number } {
    let ready = 0
    let running = 0
    let blocked = 0
    let done = 0
    let failed = 0
    let trees = 0
    for (const state of this.states.values()) {
      if (state.tree.closedAt !== null) continue
      trees += 1
      for (const node of state.nodes.values()) {
        switch (node.status) {
          case 'ready':
          case 'interrupted':
            ready += 1
            break
          case 'running':
            running += 1
            break
          case 'blocked':
            blocked += 1
            break
          case 'done':
            done += 1
            break
          case 'failed':
            failed += 1
            break
        }
      }
    }
    return { trees, ready, running, blocked, done, failed }
  }

  // ── mutations ────────────────────────────────────────────────────────────

  async createRoot(input: CreateRootInput): Promise<MutationResult<NodeRecord>> {
    return this.withLock(async () => {
      const now = this.deps.now()
      const id = this.allocateId(new Set())
      if (id === undefined) {
        return refuse('node-limit', '无法分配唯一的工作 id')
      }
      const node = this.makeNode({
        id,
        rootId: id,
        parentId: null,
        title: input.title,
        description: input.description,
        context: input.analysis,
        depth: 1,
        now,
      })
      this.states.set(id, {
        tree: {
          rootId: id,
          ownerSessionId: input.ownerSessionId,
          createdAt: now,
          closedAt: null,
          reportedAt: null,
        },
        nodes: new Map([[id, node]]),
      })
      await this.flush(id)
      return accept(node)
    })
  }

  /** Allocate an id not present in the tree (and not already reserved this call). */
  private allocateId(taken: ReadonlySet<string>): string | undefined {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = this.deps.newId()
      if (!taken.has(id) && this.node(id) === undefined) return id
    }
    return undefined
  }

  /** One fresh node record; the only place node defaults are written. */
  private makeNode(input: {
    readonly id: string
    readonly rootId: string
    readonly parentId: string | null
    readonly title: string
    readonly description: string
    readonly context: readonly string[]
    readonly depth: number
    readonly now: number
  }): NodeRecord {
    return {
      id: input.id,
      rootId: input.rootId,
      parentId: input.parentId,
      title: input.title,
      description: input.description,
      context: [...input.context],
      corrections: [],
      analysisNotes: [],
      analysisAttempt: 0,
      status: 'ready',
      createdAt: input.now,
      depth: input.depth,
      claimedBy: null,
      claimedAt: 0,
      attempts: 0,
      failures: 0,
      spawnFailures: 0,
      parkedWorker: null,
      progressAt: 0,
      stalls: 0,
      stalledNotifiedAt: null,
      result: null,
      hasResult: false,
      resultReadAt: null,
      resultRef: null,
      resultHint: null,
      children: [],
      updatedAt: input.now,
    }
  }

  /** Mark one node dispatched and bind it to a reserved child session id, in the same locked step
   * as the dispatch decision, so two engine passes cannot both dispatch it. `attempts` increments
   * on every dispatch (the aggregate pass counts as one) and is the generation marker the
   * `note_work` gate reads; the failed ceiling rides `failures` instead, so a successful aggregate
   * round is never charged against it. */
  async dispatch(nodeId: string, claimId: string): Promise<MutationResult<DispatchView>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `工作 ${nodeId} 不存在`)
      const { state, node } = found
      if (TERMINAL.has(node.status)) {
        return refuse('terminal', `工作 ${nodeId} 处于 ${statusLabel(node.status)}，不能被派发`)
      }
      if (!DISPATCHABLE.has(node.status)) {
        return refuse('not-dispatchable', `工作 ${nodeId} 处于 ${statusLabel(node.status)}，不可派发`)
      }
      if (node.claimedBy !== null && this.deps.isAgentLive(node.claimedBy)) {
        return refuse('not-dispatchable', `工作 ${nodeId} 仍被一个在运行的执行者持有`)
      }
      // Budget is `failures` (reclaims without a result), NOT `attempts`: a successful
      // aggregate/convergence round dispatches again without failing.
      if (node.failures >= CAPACITY.maxAttempts) {
        return this.failExhausted(state, node, `已用完 ${CAPACITY.maxAttempts} 次执行（反复失败）`)
      }
      // Cannot even start a worker is an infrastructure failure, budgeted separately from the
      // work's execution failures.
      if (node.spawnFailures >= CAPACITY.maxAttempts) {
        return this.failExhausted(state, node, `连续 ${CAPACITY.maxAttempts} 次无法启动执行者`)
      }
      const updated = this.replace(state, node, {
        status: 'running',
        claimedBy: claimId,
        claimedAt: this.deps.now(),
        attempts: node.attempts + 1,
        // Fresh silence window: the previous attempt's activity says nothing about this one.
        progressAt: this.deps.now(),
        // This dispatch did not adopt the parked session, so its address is spent.
        parkedWorker: null,
      })
      await this.flush(state.tree.rootId)
      return accept({
        node: updated,
        chain: this.chainOf(updated),
        children: updated.children.length > 0 ? this.terminalChildren(updated) : [],
      })
    })
  }

  /** Fail a node whose budget ran out and refuse the dispatch, so the owner is told (the engine
   * reports terminal roots) and the node never re-enters the candidate pool. */
  private async failExhausted(
    state: TreeState,
    node: NodeRecord,
    reason: string,
  ): Promise<MutationResult<DispatchView>> {
    this.replace(state, node, {
      status: 'failed',
      claimedBy: null,
      hasResult: true,
      result: node.result ?? reason,
      // Terminal: a parked address is spent either way.
      parkedWorker: null,
    })
    await this.flush(state.tree.rootId)
    return refuse('not-dispatchable', `工作 ${node.id} ${reason}，标记为失败`)
  }

  /** Return a dispatched node to the pool; `cause` decides which budget the reclaim charges.
   * `vanished`/`stalled`: a worker ran (or was starting) without a result — charges `failures`,
   * and only `stalled` also increments `stalls`. `spawn-failed`: no worker ever started — charges
   * `spawnFailures` and pushes the next dispatch back by a cooldown. `wake-failed`: an adoption
   * that could not be delivered — back to `ready`, charging neither budget, so the caller's fresh
   * dispatch proceeds. `attempts` is never rolled back: it is the `note_work` generation marker,
   * not a budget. */
  async reclaim(
    nodeId: string,
    cause: 'vanished' | 'stalled' | 'spawn-failed' | 'wake-failed' = 'vanished',
  ): Promise<MutationResult<NodeRecord>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `工作 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.status !== 'running') {
        return refuse('not-dispatchable', `工作 ${nodeId} 处于 ${statusLabel(node.status)}，并非运行中`)
      }
      if (cause === 'wake-failed') {
        // Undo the adoption: the address is already consumed, so the node is an ordinary `ready`
        // candidate again — exactly what the caller's fresh dispatch needs.
        const reverted = this.replace(state, node, {
          status: 'ready',
          claimedBy: null,
          parkedWorker: null,
        })
        await this.flush(state.tree.rootId)
        return accept(reverted)
      }
      const updated = this.replace(state, node, {
        status: 'interrupted',
        claimedBy: null,
        ...(cause === 'stalled' ? { stalls: node.stalls + 1 } : {}),
        ...(cause === 'spawn-failed'
          ? { spawnFailures: node.spawnFailures + 1 }
          : { failures: node.failures + 1 }),
      })
      await this.flush(state.tree.rootId)
      return accept(updated)
    })
  }

  /** Clear the spawn-failure counter after a worker started successfully: the budget is for
   * CONSECUTIVE start failures. Memory-only between flushes is fine — a dispatch flush follows. */
  noteSpawnSuccess(nodeId: string): void {
    const found = this.locate(nodeId)
    if (found === undefined) return
    const { state, node } = found
    if (node.spawnFailures === 0) return
    this.replace(state, node, { spawnFailures: 0 })
    this.progressDirty.add(state.tree.rootId)
  }

  /** Record worker activity for one node, on a hot path from the worker's durable append feed, so
   * it updates memory only. A timestamp not newer than what we have is ignored, which makes racing
   * a dispatch safe. */
  touchProgress(nodeId: string, at: number): void {
    const found = this.locate(nodeId)
    if (found === undefined) return
    const { state, node } = found
    if (node.status !== 'running' || at <= node.progressAt) return
    this.replace(state, node, { progressAt: at })
    this.progressDirty.add(state.tree.rootId)
  }

  /** Persist progress observed since the last flush, coalesced on purpose: writing the whole tree
   * document per worker event would cost more than the work it guards. The usual lock keeps a
   * stale document from landing after a newer one. */
  async flushProgress(): Promise<void> {
    if (this.progressDirty.size === 0) return
    await this.withLock(async () => {
      const roots = [...this.progressDirty]
      this.progressDirty.clear()
      for (const rootId of roots) {
        if (this.states.has(rootId)) await this.flush(rootId)
      }
    })
  }

  /** Claim the right to tell the owner about one node's stalls: true exactly once per node,
   * durably, the same contract as `claimReport`. */
  async claimStallReport(nodeId: string): Promise<boolean> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return false
      const { state, node } = found
      if (node.stalledNotifiedAt !== null) return false
      this.replace(state, node, { stalledNotifiedAt: this.deps.now() })
      await this.flush(state.tree.rootId)
      return true
    })
  }

  nodeHeldBy(sessionId: string): NodeRecord | undefined {
    for (const state of this.states.values()) {
      for (const node of state.nodes.values()) {
        if (node.claimedBy === sessionId) return node
      }
    }
    return undefined
  }

  /** Record the holding executor's own analysis, attributed to the `attempts` value it is running
   * under — that attribution is what `decompose` checks, so notes inherited from an earlier round
   * do not authorize a split. Text is appended (duplicates dropped) and kept for every later
   * dispatch. Refused on a terminal node. */
  async recordAnalysis(
    nodeId: string,
    callerSessionId: string,
    analysis: string,
  ): Promise<MutationResult<NodeRecord>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `工作 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.claimedBy !== callerSessionId) {
        return refuse('not-owner', `工作 ${nodeId} 不是由你持有`)
      }
      if (TERMINAL.has(node.status)) {
        return refuse('terminal', `工作 ${nodeId} 处于 ${statusLabel(node.status)}；终态工作不能再写分析`)
      }
      const notes = analysisLines(analysis)
      if (notes.length === 0) {
        return refuse('no-analysis', '分析不能为空：写清缺什么前提、排除了哪条路以及为什么、子工作结果回来后要判断什么')
      }
      const updated = this.replace(state, node, {
        analysisNotes: appendNotes(node.analysisNotes, notes),
        analysisAttempt: node.attempts,
      })
      await this.flush(state.tree.rootId)
      return accept(updated)
    })
  }

  /** Split a node into children: a first decomposition, or a re-decomposition of an aggregate whose
   * children are all terminal — the pass that read their conclusions and judged the objective
   * unmet. A node with UNFINISHED children is refused. `submitResult` and `decompose` stay mutually
   * exclusive through node state, never prompt discipline. The analysis is written earlier by
   * `recordAnalysis`; this only checks the splitting dispatch wrote its own. */
  async decompose(
    nodeId: string,
    callerSessionId: string,
    children: readonly ChildSpec[],
  ): Promise<MutationResult<DecomposeOutcome>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `工作 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.claimedBy !== callerSessionId) {
        return refuse('not-owner', `工作 ${nodeId} 不是由你持有`)
      }
      if (TERMINAL.has(node.status)) {
        return refuse('terminal', `工作 ${nodeId} 处于 ${statusLabel(node.status)}；终态工作不能再拆解`)
      }
      // Checked before producing anything: a refused split must leave no child, no attempt and no
      // released claim behind.
      if (node.analysisAttempt !== node.attempts) {
        return refuse(
          'analysis-missing',
          `工作 ${nodeId} 这次派发还没写下为什么拆；先用 note_work 写下这次的分析，再拆解`,
        )
      }
      if (children.length === 0) {
        return refuse('no-children', '拆解至少要给一个子工作')
      }
      if (children.length > CAPACITY.maxChildrenPerDecompose) {
        return refuse(
          'too-many-children',
          `一次拆解最多 ${CAPACITY.maxChildrenPerDecompose} 个子工作，收到 ${children.length} 个`,
        )
      }
      const unfinished = this.pendingChildren(node, state)
      if (unfinished.length > 0) {
        return refuse(
          'has-children',
          `工作 ${nodeId} 还有 ${unfinished.length} 个子工作没完成；等它们完成`,
        )
      }
      if (node.depth >= CAPACITY.maxDepth) {
        return refuse(
          'depth-exceeded',
          `工作 ${nodeId} 已在深度 ${node.depth}，深度上限是 ${CAPACITY.maxDepth} —— 这一层不能再拆：`
          + '直接 submit_work 给结论，把缺的前提写进结果',
        )
      }
      const created: string[] = []
      const reused: string[] = []
      const next = new Map(state.nodes)
      const taken = new Set(next.keys())
      const now = this.deps.now()
      const added = this.countNewChildren(next, node, children)
      if (state.nodes.size + added > CAPACITY.maxNodesPerTree) {
        return refuse(
          'node-limit',
          `这棵树已有 ${String(state.nodes.size)} 个工作，再加 ${String(added)} 个会超过上限 `
          + `${String(CAPACITY.maxNodesPerTree)}；把一个工作拆小一点再继续`,
        )
      }
      for (const spec of children) {
        const existing = this.findEquivalent(next, node, spec.title, spec.description, created)
        if (existing !== undefined) {
          reused.push(existing.id)
          // A shared prerequisite gains a second reason to exist; the "why" is all a child inherits.
          const merged = withAddedContext(existing, spec.context)
          if (merged !== undefined) next.set(existing.id, merged)
          continue
        }
        const id = this.allocateId(taken)
        if (id === undefined) {
          // Refuse the whole call: dropping one prerequisite would leave the parent blocked on a
          // work nobody ever created.
          return refuse('node-limit', `无法为子工作「${spec.title}」分配 id`)
        }
        taken.add(id)
        next.set(
          id,
          this.makeNode({
            id,
            rootId: node.rootId,
            parentId: node.id,
            title: spec.title,
            description: spec.description,
            context: spec.context,
            depth: node.depth + 1,
            now,
          }),
        )
        created.push(id)
      }

      const linked = [...node.children]
      for (const id of [...created, ...reused]) if (!linked.includes(id)) linked.push(id)
      const parent: NodeRecord = {
        ...node,
        children: linked,
        // A reused child may already be terminal, so readiness is computed rather than assumed.
        status: this.aggregateStatus(next, { ...node, children: linked }),
        claimedBy: null,
        // Keep the decomposing session as a wake-up address; the claim is still released, so the
        // convergence pass can continue in the session that knows why (consumed by the next dispatch).
        parkedWorker: callerSessionId,
        updatedAt: now,
      }
      next.set(node.id, parent)
      this.states.set(node.rootId, { tree: state.tree, nodes: next })
      await this.flush(node.rootId)
      return accept({ created, reused })
    })
  }

  /** Submit a terminal result; rejected while any child is unfinished. An aggregate (every child
   * terminal) DOES submit — that pass reads the conclusions and states the outcome, which is how a
   * decomposed node reaches `done` and the tree converges. */
  async submitResult(
    nodeId: string,
    callerSessionId: string,
    result: string,
  ): Promise<MutationResult<{ node: NodeRecord; parentReady: boolean }>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `工作 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.claimedBy !== callerSessionId) {
        return refuse('not-owner', `工作 ${nodeId} 不是由你持有`)
      }
      if (TERMINAL.has(node.status)) {
        return refuse('terminal', `工作 ${nodeId} 已经是 ${statusLabel(node.status)}`)
      }
      const unfinished = this.pendingChildren(node, state)
      if (unfinished.length > 0) {
        return refuse(
          'has-children',
          `工作 ${nodeId} 还有 ${unfinished.length} 个子工作没完成；等它们终态后再判断`,
        )
      }

      let inline = result
      let ref: string | null = null
      let hint: string | null = null
      if (result.length > CAPACITY.maxInlineResultChars) {
        const spilled = await this.deps.spill(result)
        if (spilled !== null) {
          ref = spilled.locator
          hint = spilled.hint
          inline = result.slice(0, CAPACITY.maxInlineResultChars)
        }
        // No backend: keep the whole text on the node rather than an unresolvable locator.
      }
      const updated = this.replace(state, node, {
        status: 'done',
        result: inline,
        hasResult: true,
        resultRef: ref,
        resultHint: hint,
        resultReadAt: null,
        claimedBy: null,
      })
      const parentReady = this.recomputeAncestors(state, updated.id)
      await this.flush(state.tree.rootId)
      return accept({ node: updated, parentReady })
    })
  }

  /** Record one correction, on the tree owner's authority only. The text lands in the node's
   * `context`, the durable block every later dispatch of that node renders, so it survives a
   * reclaim, a retry and the aggregate round rather than living in one worker's inbox. */
  async correct(nodeId: string, callerSessionId: string, text: string): Promise<MutationResult<NodeRecord>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `工作 ${nodeId} 不存在`)
      const { state, node } = found
      if (state.tree.ownerSessionId !== callerSessionId) {
        return refuse('not-owner', '只有创建这个工作的会话才能纠偏')
      }
      if (state.tree.closedAt !== null || TERMINAL.has(node.status)) {
        return refuse('terminal', `工作 ${nodeId} 处于 ${statusLabel(node.status)}；已结束的工作不能纠偏`)
      }
      if (node.corrections.includes(text)) return accept(node)
      const updated = this.replace(state, node, { corrections: [...node.corrections, text] })
      await this.flush(node.rootId)
      return accept(updated)
    })
  }

  /** Cancel everything BELOW one node, strictly downward: the node itself, its ancestors and its
   * siblings are untouched, and the cancelled nodes become `failed` so the node's aggregate pass
   * becomes dispatchable again. The tree owner is the caller that matters, because a node with
   * unfinished children is `blocked` and holds no claim. */
  async cancelSubworks(
    nodeId: string,
    callerSessionId: string,
    onReclaim?: (claimId: string) => void,
  ): Promise<MutationResult<readonly NodeRecord[]>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `工作 ${nodeId} 不存在`)
      const { state, node } = found
      if (state.tree.ownerSessionId !== callerSessionId && node.claimedBy !== callerSessionId) {
        return refuse('not-owner', `工作 ${node.rootId} 的创建者、或持有 ${nodeId} 的执行者，才能取消它的子工作`)
      }
      if (state.tree.closedAt !== null) {
        return refuse('terminal', `工作 ${node.rootId} 已归档；不能再取消它的子工作`)
      }
      const now = this.deps.now()
      const next = new Map(state.nodes)
      const touched: NodeRecord[] = []
      const queue = [...node.children]
      const seen = new Set<string>()
      while (queue.length > 0) {
        const id = queue.shift() ?? ''
        if (seen.has(id)) continue
        seen.add(id)
        const descendant = next.get(id)
        if (descendant === undefined) continue
        queue.push(...descendant.children)
        if (TERMINAL.has(descendant.status)) continue
        // Reported INSIDE the lock: acting after the fact leaves a worker burning a model call
        // whose submission can only be refused, and a `decompose` could add a child nobody stopped.
        if (descendant.claimedBy !== null) onReclaim?.(descendant.claimedBy)
        const updated: NodeRecord = {
          ...descendant,
          status: 'failed',
          // `hasResult` too, or the summary renders "（未提交结果）" and the reason never reaches the model.
          result: descendant.result ?? '被父工作取消',
          hasResult: true,
          claimedBy: null,
          // Terminal: a parked address on a cancelled node is spent.
          parkedWorker: null,
          updatedAt: now,
        }
        next.set(id, updated)
        touched.push(updated)
      }
      if (touched.length === 0) return refuse('nothing-to-cancel', `工作 ${nodeId} 没有未完成的子工作`)
      this.states.set(node.rootId, { tree: state.tree, nodes: next })
      // Seed from every PARENT of every cancelled node: a reused prerequisite is shared, and
      // cancelling it can strand its other parents in `blocked`, which nothing else recomputes.
      const seeds = [nodeId, ...touched.flatMap((entry) => this.parentsOf(next, entry.id))]
      this.propagateFrom({ tree: state.tree, nodes: next }, seeds)
      await this.flush(node.rootId)
      return accept(touched)
    })
  }

  /** Record that the owner read a terminal result; unlocks `finish_work`. */
  async markResultRead(nodeId: string): Promise<MutationResult<NodeRecord>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `工作 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.resultReadAt !== null) return accept(node)
      const updated = this.replace(state, node, { resultReadAt: this.deps.now() })
      await this.flush(state.tree.rootId)
      return accept(updated)
    })
  }

  /** Close a tree out on the owner's authority; refused while results are unread or the root is not
   * terminal. Either terminal root may be closed — a `failed` root must be reported then retired.
   * Closing is archival: nodes, results and readers are untouched. */
  async finish(rootId: string, callerSessionId: string): Promise<MutationResult<NodeRecord>> {
    return this.withLock(async () => {
      const state = this.states.get(rootId)
      if (state === undefined) return refuse('not-found', `工作 ${rootId} 不存在`)
      if (state.tree.ownerSessionId !== callerSessionId) {
        return refuse('not-owner', '只有创建这个工作的会话才能收尾')
      }
      const root = state.nodes.get(rootId)
      if (root === undefined) return refuse('not-found', `工作 ${rootId} 没有根工作`)
      if (state.tree.closedAt !== null) return accept(root)
      if (!TERMINAL.has(root.status)) {
        return refuse('not-dispatchable', `工作 ${rootId} 处于 ${statusLabel(root.status)}；还不能收尾`)
      }
      if (root.resultReadAt === null) {
        return refuse('unread-result', '收尾前先用 work_result 读根结果')
      }
      const now = this.deps.now()
      const next = new Map(state.nodes)
      const updated: NodeRecord = { ...root, updatedAt: now }
      next.set(rootId, updated)
      this.states.set(rootId, { tree: { ...state.tree, closedAt: now }, nodes: next })
      await this.flush(rootId)
      return accept(updated)
    })
  }

  /** Cancel a whole tree: mark every non-terminal node cancelled-as-failed. */
  async cancelTree(
    rootId: string,
    callerSessionId: string,
    onReclaim?: (claimId: string) => void,
  ): Promise<MutationResult<readonly NodeRecord[]>> {
    return this.withLock(async () => {
      const state = this.states.get(rootId)
      if (state === undefined) return refuse('not-found', `工作 ${rootId} 不存在`)
      if (state.tree.ownerSessionId !== callerSessionId) {
        return refuse('not-owner', '只有创建这个工作的会话才能取消')
      }
      if (state.tree.closedAt !== null) {
        return refuse('terminal', `工作 ${rootId} 已归档；不能再取消`)
      }
      const now = this.deps.now()
      const touched: NodeRecord[] = []
      const next = new Map(state.nodes)
      for (const [id, node] of next) {
        if (TERMINAL.has(node.status)) continue
        if (node.claimedBy !== null) onReclaim?.(node.claimedBy)
        const updated: NodeRecord = {
          ...node,
          status: 'failed',
          // The reason IS a result: without this flag the summary renders "（未提交结果）" and the
          // model never learns it was cancelled.
          hasResult: true,
          result: node.result ?? '已取消',
          claimedBy: null,
          // The whole tree is voided: no session is waiting to converge on anything.
          parkedWorker: null,
          updatedAt: now,
        }
        next.set(id, updated)
        touched.push(updated)
      }
      this.states.set(rootId, { tree: state.tree, nodes: next })
      await this.flush(rootId)
      return accept(touched)
    })
  }

  /** Delete one whole tree. The unit is the TREE, not the node: its siblings' premises, the
   * aggregate story and the tree's identity all live in the same record, so pruning one node out of
   * a live tree would leave a tree that cannot converge. A live tree is refused (ending one early is
   * `cancel_work`); `finish_work` archives instead. */
  async deleteTree(rootId: string): Promise<MutationResult<readonly string[]>> {
    const state = this.states.get(rootId)
    if (state === undefined) return refuse('not-found', `工作 ${rootId} 不存在`)
    const root = state.nodes.get(rootId)
    if (root === undefined) return refuse('not-found', `工作 ${rootId} 没有根工作`)
    if (!TERMINAL.has(root.status)) {
      return refuse(
        'not-deletable',
        `工作 ${rootId} 处于 ${statusLabel(root.status)}；只有已结束的工作能删除（还在跑的用 cancel_work 结束）`,
      )
    }
    const removed = [...state.nodes.keys()]
    // Outside the lock, because `destroyTree` takes it itself; the check above is the same
    // synchronous turn, so nothing can slip in between.
    await this.destroyTree(rootId)
    return accept(removed)
  }

  /** Nodes a live worker still holds, for cancellation to interrupt. */
  heldByLiveWorkers(rootId?: string): readonly NodeRecord[] {
    const scoped = rootId === undefined ? [...this.states.values()] : [this.states.get(rootId)].filter((s): s is TreeState => s !== undefined)
    const held: NodeRecord[] = []
    for (const state of scoped) {
      for (const node of state.nodes.values()) {
        if (node.status === 'running' && node.claimedBy !== null && this.deps.isAgentLive(node.claimedBy)) {
          held.push(node)
        }
      }
    }
    return held
  }

  // ── internals ────────────────────────────────────────────────────────────

  private locate(nodeId: string): { state: TreeState; node: NodeRecord } | undefined {
    for (const state of this.states.values()) {
      const node = state.nodes.get(nodeId)
      if (node !== undefined) return { state, node }
    }
    return undefined
  }

  private replace(state: TreeState, node: NodeRecord, patch: Partial<NodeRecord>): NodeRecord {
    const updated: NodeRecord = { ...node, ...patch, updatedAt: this.deps.now() }
    const next = new Map(state.nodes)
    next.set(node.id, updated)
    this.states.set(state.tree.rootId, { tree: state.tree, nodes: next })
    return updated
  }

  /** A node's aggregate status: `ready` once every child is terminal. No children at all is also
   * `ready` — an ordinary work, not a parent stuck waiting for premises that no longer exist. */
  private aggregateStatus(nodes: ReadonlyMap<string, NodeRecord>, node: NodeRecord): NodeStatus {
    const children = node.children
      .map((id) => nodes.get(id))
      .filter((child): child is NodeRecord => child !== undefined)
    if (children.length === 0) return 'ready'
    return children.every((child) => TERMINAL.has(child.status)) ? 'ready' : 'blocked'
  }

  private pendingChildren(node: NodeRecord, state: TreeState): readonly NodeRecord[] {
    return node.children
      .map((id) => state.nodes.get(id))
      .filter((child): child is NodeRecord => child !== undefined && !TERMINAL.has(child.status))
  }

  /** Every node that lists `id` as a child; a reused prerequisite has more than one. */
  private parentsOf(nodes: ReadonlyMap<string, NodeRecord>, id: string): readonly string[] {
    const parents: string[] = []
    for (const node of nodes.values()) if (node.children.includes(id)) parents.push(node.id)
    return parents
  }

  /** Propagate aggregate readiness up the dependency graph after a node changed, starting from
   * EVERY parent that lists it (dedup reuse can give it several) rather than the `parentId` chain.
   * A branch stops at an unchanged status, since an unchanged node cannot change its parents.
   * Returns whether some parent is now ready, i.e. the engine has an aggregate to dispatch. */
  private recomputeAncestors(state: TreeState, changedNodeId: string): boolean {
    const nodes = this.states.get(state.tree.rootId)?.nodes ?? state.nodes
    return this.propagateFrom(state, this.parentsOf(nodes, changedNodeId))
  }

  /** Recompute the given nodes' aggregate statuses and spread any change upward — the shared walk
   * behind `recomputeAncestors` and deletion, for callers that already know what was touched. */
  private propagateFrom(state: TreeState, start: readonly string[]): boolean {
    const next = new Map(this.states.get(state.tree.rootId)?.nodes ?? state.nodes)
    const queue: string[] = [...start]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const id = queue.shift() ?? ''
      if (visited.has(id)) continue
      visited.add(id)
      const node = next.get(id)
      if (node === undefined) continue
      const status = this.aggregateStatus(next, node)
      const changed = node.status !== status && !TERMINAL.has(node.status) && node.claimedBy === null
      if (changed) next.set(id, { ...node, status, updatedAt: this.deps.now() })
      if (changed) queue.push(...this.parentsOf(next, id))
    }
    this.states.set(state.tree.rootId, { tree: state.tree, nodes: next })
    return start.some((id) => {
      const parent = next.get(id)
      return parent !== undefined && this.aggregateStatus(next, parent) === 'ready'
    })
  }

  /** Dedup inside the decomposer's own neighborhood — its siblings' subtrees plus its own — never
   * the whole tree, and never the node itself or an ancestor, which would close a cycle.
   * Equivalence is the normalized TITLE and DESCRIPTION: a shared title is common ("补充测试" is one
   * many unrelated works wear), and a false reuse hands a later branch a RESULT answering a
   * different question, so a title match with a different description is created as new work. */
  private findEquivalent(
    nodes: ReadonlyMap<string, NodeRecord>,
    parent: NodeRecord,
    title: string,
    description: string,
    pending: readonly string[] = [],
  ): NodeRecord | undefined {
    const wanted = normalizeTitle(title)
    const wantedDescription = normalizeTitle(description)
    const seen = new Set<string>([parent.id])
    const scope: NodeRecord[] = []
    const collect = (id: string): void => {
      if (seen.has(id)) return
      const node = nodes.get(id)
      if (node === undefined) return
      seen.add(id)
      scope.push(node)
      for (const childId of node.children) collect(childId)
    }
    // Siblings of the new child: an aggregate re-decomposing must not duplicate a
    // sub-work it already has.
    for (const id of [...parent.children, ...pending]) collect(id)
    // Siblings of the decomposer, with their whole subtrees: two branches
    // independently discovering the same prerequisite is the duplicate this
    // dedup exists for.
    const grandParentId = parent.parentId
    const grandParent = grandParentId === null ? undefined : nodes.get(grandParentId)
    for (const siblingId of grandParent?.children ?? []) {
      if (siblingId !== parent.id) collect(siblingId)
    }
    return scope.find((candidate) => normalizeTitle(candidate.title) === wanted
      && normalizeTitle(candidate.description) === wantedDescription)
  }

  /** How many of these specs would actually ADD a node: a child that reuses an existing
   * prerequisite must not be counted, or the ceiling would fire on the engine's own reuse path.
   * A pre-pass, not a gate in the loop, because a refusal must leave no child behind.
   *
   * It has to answer the SAME question the loop answers, including the one case the loop handles
   * through its `created` list: a spec repeated inside ONE call reuses the node that call is about to
   * create. This used to push a `'pending'` placeholder into the equivalent-scope, and
   * `findEquivalent` resolves ids with `nodes.get(id)` → `undefined`, so the repeat was charged as a
   * second new node and a legal decomposition was refused with a wrong number (`node-limit`). */
  private countNewChildren(
    nodes: ReadonlyMap<string, NodeRecord>,
    parent: NodeRecord,
    specs: readonly ChildSpec[],
  ): number {
    const planned = new Set<string>()
    let added = 0
    for (const spec of specs) {
      const identity = childIdentity(spec.title, spec.description)
      if (planned.has(identity)) continue
      if (this.findEquivalent(nodes, parent, spec.title, spec.description) !== undefined) continue
      planned.add(identity)
      added += 1
    }
    return added
  }

  private async flush(rootId: string): Promise<void> {
    const state = this.states.get(rootId)
    if (state === undefined) return
    await this.requireStore().put(state)
  }

  /** Serialize one mutation against every other mutation. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    // Keep the chain alive regardless of individual failures.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
