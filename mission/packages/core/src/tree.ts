/**
 * The mission tree: the only authoritative state holder. Mutations are serialized through one
 * promise chain, so "inspect → mark → dispatch" is atomic without an explicit lock primitive;
 * nodes are immutable values, replaced and flushed to the store before the lock is released.
 *
 * @module @avantf/mission-core/tree
 */
import { statusLabel } from './prompt.js'
import {
  computeContinuationDelta,
  nodeFingerprint,
  type ContinuationDelta,
} from './continuation.js'
import {
  byCreatedAtThenId,
  capacityWaitingFor,
  normalizeUnit,
  planDispatch,
  resolveChildUnit,
  resolveChildWeight,
  unitHolder,
  type CapacityPolicy,
  type DispatchPlan,
  type DispatchScope,
} from './dispatch.js'
import { normalizeWeight } from './capacity.js'
import { storedTime } from './liveness.js'
import { LOCAL_WELL_FORMED, type WellFormedSource } from './wellformed.js'
import {
  CAPACITY,
  DISPATCHABLE,
  TERMINAL,
  accept,
  refuse,
  type ChildSpec,
  type DecomposeOutcome,
  type DispatchBaseline,
  type DispatchView,
  type MutationResult,
  type NodeRecord,
  type NodeStatus,
  type Refusal,
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

/**
 * What asking durable storage about an owner session resolved to. Three states, not a boolean:
 * "cannot tell" and "gone" demand different actions — a gone owner's tree is destroyed, an
 * opaque host must never be allowed to destroy mission (a stray tree is recoverable, destroyed mission
 * is not), yet the operator still has to hear about it.
 */
export type OwnerProbe =
  | { readonly kind: 'exists' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unobservable'; readonly detail: string }

/** One tree whose owner did not resolve to `exists`, with the probe that explains why. */
export interface OrphanedTree {
  readonly tree: TreeRecord
  readonly probe: OwnerProbe
}

/** Injected environment facts; the core never imports the harness. */
export interface TreeDeps {
  isAgentLive(sessionId: string): boolean
  /** Whether a session still EXISTS, asked of durable storage rather than the live registry: an
   * agent is materialized on demand, so right after a restart a live check is false. Ownership is
   * decided by this one. `unobservable` is a THIRD answer, not a synonym for either. */
  probeOwner(sessionId: string): Promise<OwnerProbe>
  /** Persist an over-long result, or return `null` when no spill backend is configured — the node
   * then keeps the full text inline, because a locator nobody can resolve loses the tail. */
  spill(text: string): Promise<SpilledText | null>
  /** Clock, injectable for tests. */
  now(): number
  /** Id generator, injectable for tests. */
  newId(): string
  /**
   * The family's well-formed repair, injected by the plugin from the LOADED BASE KIT (interface v2,
   * `wellFormedText` / `wellFormedDeep`). Absent means the base could not provide it — base missing,
   * or older than v2 — and the tree uses its own {@link LOCAL_WELL_FORMED} copy instead. This is a
   * degradation, never a refusal: a tree with no injected source still mounts and still repairs.
   */
  readonly wellFormed?: WellFormedSource
}

export interface CreateRootInput {
  readonly ownerSessionId: string
  readonly title: string
  readonly description: string
  /** The owner's initial analysis; stored as the root's background facts. */
  readonly analysis: readonly string[]
  /** The scope this mission will modify (a directory or file), or `undefined`/blank for none. The
   * root has no parent to inherit from, so this is the only declaration site for a tree's unit. */
  readonly unit?: string | null
  /** This mission's declared capacity weight (cores-equivalent); `undefined` reads as the default 1.
   * The root has no parent to inherit from. */
  readonly weight?: number
}

export interface DispatchDecision {
  readonly view: DispatchView
  /** The child session id reserved for this dispatch, already bound on the node. */
  readonly claimId: string
}

const MAX_ID_ATTEMPTS = 8

/**
 * Whether text carries nothing but whitespace. The tool layer refuses only the truly EMPTY string, so
 * blank text used to arrive here and be persisted as a title, a result or a correction — then rendered
 * back into every later dispatch. The judgement belongs HERE, next to `no-analysis`, because the code
 * that says why has to have a producer.
 */
function isBlank(text: string): boolean {
  return text.trim().length === 0
}

/** Random 8-hex-char id, matching the short ids the tools expose. `crypto` is reached through a
 * typed globals lookup because the core is built without DOM or Node ambient types. */
export function defaultNewId(): string {
  const bytes = new Uint8Array(4)
  const crypto = (globalThis as Record<string, unknown>)['crypto'] as
    | { getRandomValues<T extends ArrayBufferView>(array: T): T }
    | undefined
  if (crypto === undefined) throw new Error('avantf-mission: no crypto.getRandomValues available')
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
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

/** A count this code could have written: a non-negative integer. Anything else is not believed. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * A persisted baseline, validated back into shape. A record written before the field existed has
 * `undefined` there; a hand-edited or partially-written one could have an object missing a
 * component. Both read as `null` (= "no baseline", i.e. UNKNOWN) rather than as a snapshot with
 * invented numbers: a fabricated baseline is worse than no baseline, because the delta would then
 * claim to know what the session saw when nobody does.
 */
function asBaseline(value: unknown): DispatchBaseline | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as Partial<DispatchBaseline>
  if (
    !isCount(candidate.corrections)
    || !isCount(candidate.notes)
    || !isCount(candidate.terminalChildren)
    || typeof candidate.fingerprint !== 'string'
    || !isCount(candidate.attempts)
  ) {
    return null
  }
  // The SAME object when it is already in shape, so `normalizeLoaded`'s identity check still holds
  // for a current document (opening one must not allocate a copy of every node).
  return candidate as DispatchBaseline
}

/**
 * Bring a record written before a field existed up to the current shape at the ONE boundary where
 * durable records enter memory. `corrections`'s comment is the reason fields are ADDED rather than
 * renamed; this is the other half of that contract — a missing field must read as its documented
 * default, never as `undefined`. A node whose `lastWorkerId` is `undefined` would satisfy
 * `!== null` and be treated as "there is a resumable handle"; a missing watermark must read as `0`
 * (= nothing delivered yet), the conservative direction, because a correction silently skipped is a
 * direction the owner gave that nobody ever reads; a missing `dispatchBaseline` must read as `null`
 * (= UNKNOWN drift), never as "nothing changed"; a missing `unit` must read as `null` (= no lease),
 * never as an invented scope that would serialize the mission against a resource it never named.
 *
 * Returns the SAME object when nothing changed, so opening a current document does not churn it.
 */
function normalizeLoaded(node: NodeRecord): NodeRecord {
  const legacy = node as NodeRecord & {
    lastWorkerId?: string | null
    executorSessionId?: string | null
    correctionsDeliveredUpTo?: number
    dispatchBaseline?: unknown
    unit?: unknown
    weight?: unknown
    activityAt?: number
  }
  const lastWorkerId = legacy.lastWorkerId ?? null
  // A record written before the display handle existed reads as "no executor to open". `?? null`
  // rather than a check for `undefined`: the reader is a UI link, and an invented session id would
  // be offered as a clickable address that goes nowhere.
  const executorSessionId = legacy.executorSessionId ?? null
  const correctionsDeliveredUpTo = legacy.correctionsDeliveredUpTo ?? 0
  const dispatchBaseline = asBaseline(legacy.dispatchBaseline)
  // A record written before `unit` existed, or one whose value is not a string at all, reads as "no
  // scope declared" — the only safe direction: an invented scope would either serialize the mission
  // against strangers or hand it a lease nobody wrote.
  const unit = typeof legacy.unit === 'string' && legacy.unit.trim().length > 0
    ? legacy.unit.trim()
    : null
  // A record written before `weight` existed — or one carrying a dirty value — reads as the default
  // 1, the ordinary slot. A dirty value must never make the node invisible to the gate: `NaN` would
  // compare false against every bound and let an unbounded mission through.
  const weight = normalizeWeight(legacy.weight)
  // A record written before `activityAt` existed reads as 0 = "no event ever observed". Its
  // `progressAt` was refreshed by ANY event back then, so the liveness readers fall back to
  // `progressAt` for both clocks and judge it exactly as the previous build did (plus the round
  // cap). A missing value must never read as `undefined`: `Math.max(undefined, …)` is `NaN`, which
  // keeps a node running forever.
  const activityAt = storedTime(legacy.activityAt)
  if (
    lastWorkerId === node.lastWorkerId
    && executorSessionId === node.executorSessionId
    && correctionsDeliveredUpTo === node.correctionsDeliveredUpTo
    && dispatchBaseline === node.dispatchBaseline
    && unit === node.unit
    && weight === node.weight
    && activityAt === node.activityAt
  ) {
    return node
  }
  return {
    ...node,
    lastWorkerId,
    executorSessionId,
    correctionsDeliveredUpTo,
    dispatchBaseline,
    unit,
    weight,
    activityAt,
  }
}

export class MissionTree {
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

  /**
   * The repair pair every INBOUND write uses: the base kit the plugin injected, or the local
   * degradation copy. ONE accessor, so "which implementation" is decided in one place and every
   * write-path entry below asks the same question.
   */
  private get wellFormed(): WellFormedSource {
    return this.deps.wellFormed ?? LOCAL_WELL_FORMED
  }

  /** Attach the durable store. A plugin can only open its storage domain inside `apply`, so the
   * tree is constructed first and wired before any read; `open()` fails loudly without one. */
  attachStore(store: TreeStore): void {
    this.store = store
  }

  private requireStore(): TreeStore {
    if (this.store === undefined) {
      throw new Error('avantf-mission: mission tree has no store attached')
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
        reconciled.set(id, this.reconcileOnOpen(normalizeLoaded(node)))
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

  /**
   * Three outcomes on open, decided by what the durable record says and what this process can see:
   *
   * 1. SURVIVOR — `running` and the worker IS materialized (hot reload): keep the binding, only
   *    reset `progressAt`, or a long run looks silent from the moment we open.
   * 2. CONTINUABLE — `running` but the worker is not materialized in THIS process (a restart or a
   *    crash): demote to `interrupted`, but FIRST park `claimedBy` in `lastWorkerId`. The binding is
   *    the only place that session id was recorded, so dropping it here is what made every restart
   *    unable to do anything but start over.
   * 3. NO HANDLE — not `running`: nothing to do, and `lastWorkerId` (if any) is already spent.
   *
   * The survivor branch is deliberately unchanged: a live binding is authoritative, and a stale
   * handle left beside it is only ever consulted by `adoptContinuation`, which requires the node to
   * be dispatchable — a `running` node never is.
   */
  private reconcileOnOpen(node: NodeRecord): NodeRecord {
    if (node.status !== 'running') return node
    // A record written before the display handle existed has `claimedBy` as its only trace of the
    // executor; remembering it here is what lets a session that survived a restart (or one that was
    // interrupted by it) still be opened from the panel. A current record already carries it.
    const executorSessionId = node.executorSessionId ?? node.claimedBy
    if (node.claimedBy !== null && this.deps.isAgentLive(node.claimedBy)) {
      // Hot-reload survivor: reset the clocks, or a long run looks silent from the moment we open.
      const at = this.deps.now()
      return { ...node, executorSessionId, progressAt: at, activityAt: at }
    }
    return {
      ...node,
      // Only when there is something to remember: a `running` record with no holder keeps any
      // earlier handle rather than erasing it.
      lastWorkerId: node.claimedBy ?? node.lastWorkerId,
      executorSessionId,
      status: 'interrupted',
      claimedBy: null,
      updatedAt: this.deps.now(),
    }
  }

  /** Trees whose owner session did not resolve to `exists`, each with the probe that says why.
   * Asked of durable storage rather than the live registry, so a restart keeps its trees and only a
   * genuinely deleted session loses them. `missing` and `unobservable` are reported separately: the
   * caller decides what may be destroyed (see `MissionEngine.reconcileOrphans`). */
  async orphanedTrees(): Promise<readonly OrphanedTree[]> {
    const orphaned: OrphanedTree[] = []
    for (const state of this.states.values()) {
      const probe = await this.deps.probeOwner(state.tree.ownerSessionId)
      if (probe.kind !== 'exists') orphaned.push({ tree: state.tree, probe })
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

  /** What changed on this node since the prompt its bound session was handed (see
   * `@avantf/mission-core/continuation`). Read-only and synchronous, because the wake path consults
   * it before it adopts anything: a refusal that has already consumed an address is a refusal that
   * cannot be undone.
   *
   * `undefined` when the node does not exist; a node that merely has no baseline still answers, with
   * `baselineKnown: false` — "unknown" is a fact the caller renders, not an error. */
  continuationDelta(nodeId: string): ContinuationDelta | undefined {
    const found = this.locate(nodeId)
    if (found === undefined) return undefined
    const { node } = found
    return computeContinuationDelta(node, this.terminalChildren(node).length)
  }

  /** The next node to dispatch: `ready`/`interrupted`, oldest first across trees, excluding ones
   * whose binding still resolves to a live agent. A vanished worker's node is reclaimed by the
   * engine's sweep before it becomes a candidate again.
   *
   * The selection itself — ordering, parked/backoff rules and the unit-lease skip — lives in
   * `@avantf/mission-core/dispatch`; this is the state access, and the lease side of it is
   * re-checked atomically at every transition into `running` below, so a race that slips past this
   * filter is refused rather than run. The optional `capacity` policy arms the capacity gate; without
   * it this is exactly the pre-capacity contract. */
  nextDispatchable(
    exclude: ReadonlySet<string> = new Set(),
    capacity?: CapacityPolicy,
  ): NodeRecord | undefined {
    return this.planDispatch(exclude, capacity).selected
  }

  /** The full admission plan (see `@avantf/mission-core/dispatch`): the node to dispatch AND every
   *  candidate left waiting with its reason. The engine uses the latter half for `waitingFor` and for
   *  the aging bookkeeping; tree-level callers that only need the answer use `nextDispatchable`. */
  planDispatch(
    exclude: ReadonlySet<string> = new Set(),
    capacity?: CapacityPolicy,
  ): DispatchPlan {
    const scopes: DispatchScope[] = [...this.states.values()]
    return planDispatch(scopes, {
      exclude,
      now: capacity?.now ?? this.deps.now(),
      isAgentLive: (sessionId) => this.deps.isAgentLive(sessionId),
      ...capacity === undefined ? {} : { capacity },
    })
  }

  /**
   * What the capacity gate currently has in flight, in the SAME definition `inFlightCount` uses: a
   * node counts once it is BOUND (`running` with a `claimedBy`), not once its worker materializes, so
   * a pass cannot over-subscribe the pool by dispatching into a lazily-created child.
   */
  runningLoad(): { count: number; weight: number } {
    let count = 0
    let weight = 0
    for (const state of this.states.values()) {
      if (state.tree.closedAt !== null) continue
      for (const node of state.nodes.values()) {
        if (node.status !== 'running' || node.claimedBy === null) continue
        count += 1
        weight += normalizeWeight(node.weight)
      }
    }
    return { count, weight }
  }

  /**
   * The lease check shared by all three transitions INTO `running` (`dispatch`, `adoptParked`,
   * `adoptContinuation`). It has to be re-made here, under the tree lock, and not only in
   * `nextDispatchable`: the wake paths bind from a snapshot taken outside it, and two passes can
   * interleave between "this unit looked free" and "mark it running".
   *
   * `undefined` means the unit is free (or the node declared none — the no-op case that keeps
   * undeclared records byte-for-byte as they behaved before leases existed). Reached through
   * {@link admissionRefusal}, which pairs it with the capacity recheck; the capacity gate has the
   * same snapshot problem and is re-made in the same breath.
   */
  private unitRefusal(node: NodeRecord): Refusal | undefined {
    if (node.unit === null) return undefined
    const holder = unitHolder(this.states.values(), node.unit, node.id)
    if (holder === undefined) return undefined
    return refuse(
      'unit-busy',
      `任务 ${node.id} 要改动的范围「${node.unit}」正被任务 ${holder.id}（"${holder.title}"）占用：`
      + '同一范围同一时刻只有一个任务在跑',
    )
  }

  /**
   * The capacity counterpart of {@link unitRefusal}, re-made under the tree lock at every transition
   * INTO `running`. `planDispatch` decides from a snapshot taken OUTSIDE the lock, so two passes can
   * each see an empty machine and both bind; the arithmetic therefore has to be re-run here, in the
   * same place the unit lease is, and through the SAME judgement the plan uses
   * ({@link capacityWaitingFor}) so the two can never drift.
   *
   * The policy supplies the machine's capacity, the slot ceiling and (when the host set it) the
   * machine-wide block. Its `runningCount`/`runningWeight` are the CALLER'S SNAPSHOT and are
   * deliberately ignored: trusting them is the very TOCTOU this closes. `undefined` policy means the
   * caller opted out of the gate entirely — the pre-capacity contract, unchanged.
   *
   * The refusal is a DEFERRAL in the strictest sense (`capacity-busy`): the node stays `ready` and
   * NOTHING is charged — no `attempts`, `failures`, `spawnFailures`, no cooldown, no stall. See
   * {@link RefusalCode}.
   */
  private capacityRefusal(node: NodeRecord, policy?: CapacityPolicy): Refusal | undefined {
    if (policy === undefined) return undefined
    const load = this.runningLoad()
    const waiting = policy.globalBlock ?? capacityWaitingFor(node, {
      capacity: policy.capacity,
      maxConcurrent: policy.maxConcurrent,
      runningCount: load.count,
      runningWeight: load.weight,
    })
    if (waiting === undefined) return undefined
    const detail = waiting.reason === 'slot'
      ? `并发槽位已满（${load.count}/${policy.maxConcurrent}）`
      : waiting.resource === 'memory'
        ? '机器可用内存低于下限'
        : `机器容量不足（需 ${normalizeWeight(node.weight)}，当前已用 ${load.weight}/${policy.capacity}）`
    return refuse('capacity-busy', `任务 ${node.id} 暂不派发：${detail}；这是排队等待，不是失败`)
  }

  /**
   * The two RESOURCE admissions every transition into `running` must re-make under the tree lock:
   * the unit lease first (a scope conflict), then capacity (the machine). Kept in ONE call site per
   * transition so "what has to be rechecked before binding" is named once and the two checks cannot
   * drift or be reordered by accident. Budgets are deliberately NOT here: a spent budget is a
   * FAILURE (`failExhausted`), while both of these are "not yet" and must charge nothing.
   */
  private admissionRefusal(node: NodeRecord, capacity?: CapacityPolicy): Refusal | undefined {
    return this.unitRefusal(node) ?? this.capacityRefusal(node, capacity)
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
  async adoptParked(
    nodeId: string,
    workerId: string,
    capacity?: CapacityPolicy,
  ): Promise<MutationResult<DispatchView>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.parkedWorker === null || node.parkedWorker !== workerId) {
        // Address consumed elsewhere or never pointed here; refusing is the whole guard against
        // waking a session that no longer owns this node.
        return refuse('not-dispatchable', `任务 ${nodeId} 没有停在 ${workerId}`)
      }
      // Must honour exactly the `parkedReadyNodes` condition, or the gate admits a step this refuses.
      // Deliberately asymmetric with `dispatch`: the failure BUDGETS are NOT consulted, because the
      // parked session already knows what the children were for; the next `dispatch` still sees them.
      // The resource gate below is optional and only a caller that supplies its policy gets the
      // capacity recheck — the wake path has no plan snapshot, so it passes none.
      if (node.status !== 'ready') {
        return refuse('not-dispatchable', `任务 ${nodeId} 处于 ${statusLabel(node.status)}，不能唤醒`)
      }
      if (node.claimedBy !== null && this.deps.isAgentLive(node.claimedBy)) {
        return refuse('not-dispatchable', `任务 ${nodeId} 仍被一个在运行的执行者持有`)
      }
      const busy = this.admissionRefusal(node, capacity)
      if (busy !== undefined) return busy
      const at = this.deps.now()
      const updated = this.replace(state, node, {
        status: 'running',
        claimedBy: workerId,
        claimedAt: at,
        attempts: node.attempts + 1,
        progressAt: at,
        activityAt: at,
        parkedWorker: null,
        // The display handle: kept after this dispatch ends, unlike `claimedBy`.
        executorSessionId: workerId,
      })
      await this.flush(state.tree.rootId)
      return accept({
        node: updated,
        chain: this.chainOf(updated),
        children: updated.children.length > 0 ? this.terminalChildren(updated) : [],
      })
    })
  }

  /**
   * Claim a node FOR the lost session recorded in `lastWorkerId`, so its next execution CONTINUES
   * that session (a cold wake) rather than starting a fresh executor. The continuation counterpart
   * of {@link adoptParked}, and the same shape: no new claim id is reserved — the identity IS the
   * recorded session — and the handle is consumed in the same locked step.
   *
   * Why the ceilings ARE consulted here, unlike for a parked adoption: a continuation IS a
   * dispatch. It hands work to a model and advances `attempts`, so a node whose failure budget is
   * spent must fail here exactly as `dispatch` would fail it, instead of being resurrected.
   *
   * The handle is CONSUMED (`lastWorkerId = null`) rather than kept: this dispatch either continues
   * that session or — through `reclaim(..., 'wake-failed')` — falls back to a fresh one, and neither
   * outcome may try the same address again. A runtime that refused the resume once will refuse it
   * again; the fallback is the complete answer (`note_mission` is the cross-session hand-off).
   */
  async adoptContinuation(
    nodeId: string,
    workerId: string,
    capacity?: CapacityPolicy,
  ): Promise<MutationResult<DispatchView>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.parkedWorker !== null) {
        // A parked session is an ALIVE continuation; it owns this node's next dispatch (and
        // `nextDispatchable` excludes the node for exactly that reason). Refusing keeps the two
        // address kinds from overwriting each other.
        return refuse('not-dispatchable', `任务 ${nodeId} 停在 ${node.parkedWorker}，走唤醒路径`)
      }
      if (node.lastWorkerId !== workerId) {
        return refuse(
          'not-dispatchable',
          `任务 ${nodeId} 的可接续会话已从 ${workerId} 变为 ${String(node.lastWorkerId)}`,
        )
      }
      if (TERMINAL.has(node.status)) {
        return refuse('terminal', `任务 ${nodeId} 处于 ${statusLabel(node.status)}，不能被接续`)
      }
      if (!DISPATCHABLE.has(node.status)) {
        return refuse('not-dispatchable', `任务 ${nodeId} 处于 ${statusLabel(node.status)}，不可接续`)
      }
      if (node.claimedBy !== null && this.deps.isAgentLive(node.claimedBy)) {
        return refuse('not-dispatchable', `任务 ${nodeId} 仍被一个在运行的执行者持有`)
      }
      // The resource gate is checked BEFORE the budgets: a unit held by somebody else, or a machine
      // that cannot fit this weight, is a "not yet" — not a failure — and must not spend the node's
      // budget or fail it. Capacity joins the lease here for the same reason the lease is here at
      // all: the plan that selected this candidate ran outside the lock.
      const busy = this.admissionRefusal(node, capacity)
      if (busy !== undefined) return busy
      // Same budgets as `dispatch`, and the same refusal shape: a continuation that cannot be
      // attempted must not silently skip the ceiling.
      if (node.failures >= CAPACITY.maxAttempts) {
        return this.failExhausted(state, node, `已用完 ${CAPACITY.maxAttempts} 次执行（反复失败）`)
      }
      if (node.spawnFailures >= CAPACITY.maxAttempts) {
        return this.failExhausted(state, node, `连续 ${CAPACITY.maxAttempts} 次无法启动执行者`)
      }
      const at = this.deps.now()
      const updated = this.replace(state, node, {
        status: 'running',
        claimedBy: workerId,
        claimedAt: at,
        attempts: node.attempts + 1,
        // Fresh windows: the previous attempt's activity says nothing about this one.
        progressAt: at,
        activityAt: at,
        lastWorkerId: null,
        // Last attempt wins: the continuation replaces the previous executor as the one to open.
        executorSessionId: workerId,
      })
      await this.flush(state.tree.rootId)
      return accept({
        node: updated,
        chain: this.chainOf(updated),
        children: updated.children.length > 0 ? this.terminalChildren(updated) : [],
      })
    })
  }

  /**
   * Stamp the node with what the prompt just handed to the session showed it: the snapshot a later
   * cold wake subtracts. The HOST owns the moment (it calls this once the delivery resolved, at each
   * of its three prompt sites), because only the host knows a prompt was actually read — a dispatch
   * that never produced, or never delivered, a prompt must leave no baseline claiming otherwise.
   *
   * GUARDED on the live binding: between the delivery and this call, a sweep can reclaim the node
   * (or another pass can re-dispatch it), and a baseline that says "this session saw this" must
   * belong to the dispatch that is actually bound. A stamp that loses that race is refused
   * silently: the wake that later reads a stale-or-missing baseline takes the conservative path,
   * while a wrongly stamped one would under-report the drift to a live session.
   *
   * Tolerant rather than a mutation result, like {@link markCorrectionsDelivered}: it is bookkeeping
   * about a prompt that already exists, and the caller can do nothing useful with a refusal. The
   * return value exists so the caller (and tests) can tell a stamp from a lost race.
   */
  async recordDispatchBaseline(nodeId: string, holder: string): Promise<boolean> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return false
      const { state, node } = found
      if (node.status !== 'running' || node.claimedBy !== holder) return false
      this.replace(state, node, {
        dispatchBaseline: {
          corrections: node.corrections.length,
          notes: node.analysisNotes.length,
          terminalChildren: this.terminalChildren(node).length,
          fingerprint: nodeFingerprint(node.title, node.description),
          // The generation this prompt is being built under, i.e. the value `recordAnalysis` stamps
          // onto a note written by this very dispatch.
          attempts: node.attempts,
        },
      })
      await this.flush(state.tree.rootId)
      return true
    })
  }

  /**
   * Spend a continuation handle WITHOUT using it, so the node's next dispatch starts fresh. Used
   * when the drift since that session's prompt is material (`isMaterialChange`): the address is not
   * worth spending, and leaving it would make every later pass re-decide the same thing.
   *
   * No status change, no budget, no cooldown — the caller's ordinary `dispatch` follows in the same
   * engine pass. The baseline is left alone: the fresh dispatch stamps its own, which is the whole
   * point of replacing the session.
   */
  async abandonContinuation(nodeId: string, workerId: string): Promise<MutationResult<NodeRecord>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.lastWorkerId !== workerId) {
        // The handle moved, or somebody else already spent it: nothing here is ours to clear, and
        // the caller's fallback is still correct because the node is a candidate either way.
        return refuse(
          'not-dispatchable',
          `任务 ${nodeId} 的可接续会话已从 ${workerId} 变为 ${String(node.lastWorkerId)}`,
        )
      }
      const updated = this.replace(state, node, { lastWorkerId: null })
      await this.flush(state.tree.rootId)
      return accept(updated)
    })
  }

  /** Nodes bound to a worker and not yet resolved, deliberately NOT filtered by worker liveness:
   * a reserved claim id is not an agent until the child materializes, so counting only live
   * holders would let a second dispatch pass in the same tick over-subscribe the pool. Derived from
   * {@link runningLoad} so the slot count and the capacity weight can never disagree about who is
   * in flight. */
  inFlightCount(): number {
    return this.runningLoad().count
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
      // INBOUND, the `create_mission` path. This is the ONE point where these fields enter the tree,
      // so one recursive repair on the whole input covers title / description / analysis / unit
      // together — a field added to the input shape cannot be forgotten here. The repair is
      // well-formedness only (no NFC; see the module note in `wellformed.ts`).
      const safe = this.wellFormed.deep(input)
      // Before the id is allocated: a refused root must not consume one.
      if (isBlank(safe.title)) return refuse('blank-text', '任务标题不能只有空白')
      if (isBlank(safe.description)) return refuse('blank-text', '任务内容不能只有空白')
      const now = this.deps.now()
      const id = this.allocateId(new Set())
      if (id === undefined) {
        return refuse('node-limit', '无法分配唯一的任务 id')
      }
      const node = this.makeNode({
        id,
        rootId: id,
        parentId: null,
        title: safe.title,
        description: safe.description,
        context: safe.analysis,
        unit: normalizeUnit(safe.unit),
        weight: safe.weight,
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
    /** Already resolved (root: declared-or-none; child: inherited-or-overridden). */
    readonly unit: string | null
    /** Declared capacity weight; `undefined` reads as the default 1. */
    readonly weight?: number
    readonly depth: number
    readonly now: number
  }): NodeRecord {
    return {
      id: input.id,
      rootId: input.rootId,
      parentId: input.parentId,
      title: input.title,
      description: input.description,
      unit: input.unit,
      weight: normalizeWeight(input.weight),
      context: [...input.context],
      corrections: [],
      correctionsDeliveredUpTo: 0,
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
      lastWorkerId: null,
      // Nothing has run this node yet, so there is no session to open.
      executorSessionId: null,
      // No prompt has been built for this node yet, so there is nothing to subtract later.
      dispatchBaseline: null,
      progressAt: 0,
      activityAt: 0,
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
   * `note_mission` gate reads; the failed ceiling rides `failures` instead, so a successful aggregate
   * round is never charged against it. */
  async dispatch(
    nodeId: string,
    claimId: string,
    capacity?: CapacityPolicy,
  ): Promise<MutationResult<DispatchView>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
      const { state, node } = found
      if (TERMINAL.has(node.status)) {
        return refuse('terminal', `任务 ${nodeId} 处于 ${statusLabel(node.status)}，不能被派发`)
      }
      if (!DISPATCHABLE.has(node.status)) {
        return refuse('not-dispatchable', `任务 ${nodeId} 处于 ${statusLabel(node.status)}，不可派发`)
      }
      if (node.claimedBy !== null && this.deps.isAgentLive(node.claimedBy)) {
        return refuse('not-dispatchable', `任务 ${nodeId} 仍被一个在运行的执行者持有`)
      }
      // The resource gate is checked BEFORE the budgets, and the lease half of it is the
      // ACQUISITION point: from here the node holds its unit until it leaves `running`, which is the
      // whole mutual-exclusion rule. The capacity half re-runs the plan's own judgement against the
      // LIVE load, because the plan that selected this node read a snapshot taken outside this lock
      // — two passes can otherwise both see an empty machine and both bind.
      const busy = this.admissionRefusal(node, capacity)
      if (busy !== undefined) return busy
      // Budget is `failures` (reclaims without a result), NOT `attempts`: a successful
      // aggregate/convergence round dispatches again without failing.
      if (node.failures >= CAPACITY.maxAttempts) {
        return this.failExhausted(state, node, `已用完 ${CAPACITY.maxAttempts} 次执行（反复失败）`)
      }
      // Cannot even start a worker is an infrastructure failure, budgeted separately from the
      // mission's execution failures.
      if (node.spawnFailures >= CAPACITY.maxAttempts) {
        return this.failExhausted(state, node, `连续 ${CAPACITY.maxAttempts} 次无法启动执行者`)
      }
      const at = this.deps.now()
      const updated = this.replace(state, node, {
        status: 'running',
        claimedBy: claimId,
        claimedAt: at,
        attempts: node.attempts + 1,
        // Fresh windows: the previous attempt's activity says nothing about this one. Both clocks
        // start together, so a just-dispatched node is neither silent nor unproductive.
        progressAt: at,
        activityAt: at,
        // This dispatch did not adopt the parked session, so its address is spent.
        parkedWorker: null,
        // The display handle: last attempt wins, and it survives this attempt's terminal state.
        executorSessionId: claimId,
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
    return refuse('not-dispatchable', `任务 ${node.id} ${reason}，标记为失败`)
  }

  /** Return a dispatched node to the pool; `cause` decides which budget the reclaim charges.
   * `vanished`/`stalled`: a worker ran (or was starting) without a result — charges `failures`,
   * and only `stalled` also increments `stalls`. `spawn-failed`: no worker ever started — charges
   * `spawnFailures` and pushes the next dispatch back by a cooldown. `wake-failed`: an adoption
   * that could not be delivered — back to `ready`, charging neither budget, so the caller's fresh
   * dispatch proceeds. `hung`: the worker was still alive but produced nothing for a whole window
   * (or exceeded the round cap) — like `wake-failed` it charges NEITHER budget and adds no cooldown,
   * because an apparatus outage is not a failed mission and must not spend the budget that ends the
   * node; unlike `wake-failed` it lands in `interrupted`, the ordinary re-queue. `attempts` is never
   * rolled back: it is the `note_mission` generation marker, not a budget.
   *
   * Every arm leaves `running`, so this is one of the paths that RELEASES the node's unit lease
   * (the lease is the set of `running` nodes' units, never a separate table — see `dispatch.ts`).
   *
   * `expectedHolder` is a compare-and-swap for a caller that judged the node from a snapshot taken
   * OUTSIDE this lock — `MissionEngine.reclaimStale` takes one, then awaits `interruptWorker` per
   * node. If a second sweep reclaimed and re-dispatched the node in that window, the binding has
   * moved on and this stale verdict must be refused: acting on it would unbind a LIVE worker (whose
   * `submit_mission` then answers `not-owner`) and charge `failures` a second time for one attempt.
   * `undefined` means "no expectation" — the callers that act on a value they just read use that. */
  async reclaim(
    nodeId: string,
    cause: 'vanished' | 'stalled' | 'hung' | 'spawn-failed' | 'wake-failed' = 'vanished',
    expectedHolder?: string | null,
  ): Promise<MutationResult<NodeRecord>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.status !== 'running') {
        return refuse('not-dispatchable', `任务 ${nodeId} 处于 ${statusLabel(node.status)}，并非运行中`)
      }
      if (expectedHolder !== undefined && node.claimedBy !== expectedHolder) {
        return refuse(
          'not-dispatchable',
          `任务 ${nodeId} 的持有者已从 ${String(expectedHolder)} 变为 ${String(node.claimedBy)}；这次回收已过期`,
        )
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
        // `hung` charges NEITHER budget and no cooldown: the worker was alive, so this is an
        // apparatus outage, and retries must not eat the budget that ends the node (`wake-failed`
        // set the same precedent). `failures` stays for missions that actually failed; a worker
        // merely vanishing is already not the node's fault.
        ...(cause === 'spawn-failed'
          ? { spawnFailures: node.spawnFailures + 1 }
          : cause === 'hung'
            ? {}
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

  /** Record that one worker PRODUCED something — model output, a tool call, a tool result — on a
   * hot path from the worker's durable append feed, so it updates memory only. This is the clock the
   * stale check reads: output is also evidence of life, so one write moves `activityAt` too. A
   * timestamp not newer than what we have is ignored, which makes racing a dispatch safe. */
  touchProgress(nodeId: string, at: number): void {
    const found = this.locate(nodeId)
    if (found === undefined) return
    const { state, node } = found
    if (node.status !== 'running' || at <= node.progressAt) return
    this.replace(state, node, { progressAt: at, activityAt: Math.max(at, storedTime(node.activityAt)) })
    this.progressDirty.add(state.tree.rootId)
  }

  /** Record that a worker's session emitted SOME event without claiming it produced anything: the
   *  transport-layer half of liveness. It moves only `activityAt`, so a worker whose events are all
   *  retries and route snapshots is still heard from (never `stalled`) while `progressAt` stays
   *  where its last real output left it — exactly the "alive but unproductive" state that
   *  `judgeWorker` reclaims as `hung`. */
  touchActivity(nodeId: string, at: number): void {
    const found = this.locate(nodeId)
    if (found === undefined) return
    const { state, node } = found
    if (node.status !== 'running' || at <= storedTime(node.activityAt)) return
    this.replace(state, node, { activityAt: at })
    this.progressDirty.add(state.tree.rootId)
  }

  /** Persist progress observed since the last flush, coalesced on purpose: writing the whole tree
   * document per worker event would cost more than the mission it guards. The usual lock keeps a
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
      // INBOUND, the `note_mission` path: the ONE string this write path stores.
      const noteText = this.wellFormed.text(analysis)
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.claimedBy !== callerSessionId) {
        return refuse('not-owner', `任务 ${nodeId} 不是由你持有`)
      }
      if (TERMINAL.has(node.status)) {
        return refuse('terminal', `任务 ${nodeId} 处于 ${statusLabel(node.status)}；终态任务不能再写分析`)
      }
      const notes = analysisLines(noteText)
      if (notes.length === 0) {
        return refuse('no-analysis', '分析不能为空：写清缺什么前提、排除了哪条路以及为什么、子任务结果回来后要判断什么')
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
   * `recordAnalysis`; this only checks the splitting dispatch wrote its own.
   *
   * Leaving `running` here is also what RELEASES this node's unit lease, and the children created
   * below inherit that unit unless they declare their own — so the same-scope siblings the split
   * just created are serialized against each other by the same state rule (see `dispatch.ts`). */
  async decompose(
    nodeId: string,
    callerSessionId: string,
    children: readonly ChildSpec[],
  ): Promise<MutationResult<DecomposeOutcome>> {
    return this.withLock(async () => {
      // INBOUND, the `decompose_mission` path: ONE repair on the whole children array covers every
      // child's title / description / context / unit. It runs BEFORE the dedup scan below, so two
      // spellings of the same child that differ only by a lone surrogate cannot create two nodes.
      const specs = this.wellFormed.deep(children)
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.claimedBy !== callerSessionId) {
        return refuse('not-owner', `任务 ${nodeId} 不是由你持有`)
      }
      if (TERMINAL.has(node.status)) {
        return refuse('terminal', `任务 ${nodeId} 处于 ${statusLabel(node.status)}；终态任务不能再拆解`)
      }
      // Checked before producing anything: a refused split must leave no child, no attempt and no
      // released claim behind.
      if (node.analysisAttempt !== node.attempts) {
        return refuse(
          'analysis-missing',
          `任务 ${nodeId} 这次派发还没写下为什么拆；先用 note_mission 写下这次的分析，再拆解`,
        )
      }
      if (specs.length === 0) {
        return refuse('no-children', '拆解至少要给一个子任务')
      }
      if (specs.length > CAPACITY.maxChildrenPerDecompose) {
        return refuse(
          'too-many-children',
          `一次拆解最多 ${CAPACITY.maxChildrenPerDecompose} 个子任务，收到 ${specs.length} 个`,
        )
      }
      const unfinished = this.pendingChildren(node, state)
      if (unfinished.length > 0) {
        return refuse(
          'has-children',
          `任务 ${nodeId} 还有 ${unfinished.length} 个子任务没完成；等它们完成`,
        )
      }
      if (node.depth >= CAPACITY.maxDepth) {
        return refuse(
          'depth-exceeded',
          `任务 ${nodeId} 已在深度 ${node.depth}，深度上限是 ${CAPACITY.maxDepth} —— 这一层不能再拆：`
          + '直接 submit_mission 给结论，把缺的前提写进结果',
        )
      }
      const created: string[] = []
      const reused: string[] = []
      const next = new Map(state.nodes)
      const taken = new Set(next.keys())
      const now = this.deps.now()
      const added = this.countNewChildren(next, node, specs)
      if (state.nodes.size + added > CAPACITY.maxNodesPerTree) {
        return refuse(
          'node-limit',
          `这棵树已有 ${String(state.nodes.size)} 个任务，再加 ${String(added)} 个会超过上限 `
          + `${String(CAPACITY.maxNodesPerTree)}；把一个任务拆小一点再继续`,
        )
      }
      for (const spec of specs) {
        const existing = this.findEquivalent(next, node, spec.title, spec.description, created)
        if (existing !== undefined) {
          reused.push(existing.id)
          // A shared prerequisite gains a second reason to exist; the "why" is all a child inherits.
          // Its `unit` is deliberately left alone too: it is the scope that node declared when it was
          // created, it may already be running under that lease elsewhere, and rewriting it would
          // change a resource the node is holding.
          const merged = withAddedContext(existing, spec.context)
          if (merged !== undefined) next.set(existing.id, merged)
          continue
        }
        const id = this.allocateId(taken)
        if (id === undefined) {
          // Refuse the whole call: dropping one prerequisite would leave the parent blocked on a
          // mission nobody ever created.
          return refuse('node-limit', `无法为子任务「${spec.title}」分配 id`)
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
            // Declared, or inherited from the parent — the safe default (same-scope siblings then
            // serialize). An explicit blank on the spec is the deliberate opt-OUT.
            unit: resolveChildUnit(node.unit, spec.unit),
            // Weight is deliberately NOT inherited: `undefined` on the spec means the default 1.
            weight: resolveChildWeight(spec.weight),
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
      // INBOUND, the `submit_mission` path: the ONE string this write path stores. Repaired before
      // the length check so the spill decision is made on the final bytes.
      const safeResult = this.wellFormed.text(result)
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
      const { state, node } = found
      if (node.claimedBy !== callerSessionId) {
        return refuse('not-owner', `任务 ${nodeId} 不是由你持有`)
      }
      if (TERMINAL.has(node.status)) {
        return refuse('terminal', `任务 ${nodeId} 已经是 ${statusLabel(node.status)}`)
      }
      const unfinished = this.pendingChildren(node, state)
      if (unfinished.length > 0) {
        return refuse(
          'has-children',
          `任务 ${nodeId} 还有 ${unfinished.length} 个子任务没完成；等它们终态后再判断`,
        )
      }
      // Same rule as `no-analysis`, one field over: a blank "result" is a submission with nothing in
      // it, and it used to be stored, shown as the conclusion, and read by the judging round.
      if (isBlank(safeResult)) return refuse('blank-text', '结果不能只有空白')

      let inline = safeResult
      let ref: string | null = null
      let hint: string | null = null
      if (safeResult.length > CAPACITY.maxInlineResultChars) {
        const spilled = await this.deps.spill(safeResult)
        if (spilled !== null) {
          ref = spilled.locator
          hint = spilled.hint
          // The inline TAIL is repaired again: this `slice` can land between the two halves of an
          // astral character and manufacture a lone surrogate out of a well-formed result.
          inline = this.wellFormed.text(safeResult.slice(0, CAPACITY.maxInlineResultChars))
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
   * `corrections`, NOT in `context`: `context` is the decomposer's "why this mission exists", while a
   * correction is the owner's instruction about mission already handed out — a different author and a
   * different lifetime. (Rendering them together once made every correction invisible to every
   * descendant, because the chain line only carries `context[0]`.) Either way it is a durable block
   * that every later dispatch of this node renders, so it survives a reclaim, a retry and the
   * aggregate round rather than living in one worker's inbox. */
  async correct(nodeId: string, callerSessionId: string, text: string): Promise<MutationResult<NodeRecord>> {
    return this.withLock(async () => {
      // INBOUND, the `adjust_mission` path: repair BEFORE the duplicate check, so the same correction
      // cannot be appended twice because one copy carried a lone surrogate.
      const safeText = this.wellFormed.text(text)
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
      const { state, node } = found
      if (state.tree.ownerSessionId !== callerSessionId) {
        return refuse('not-owner', '只有创建这个任务的会话才能纠偏')
      }
      if (state.tree.closedAt !== null || TERMINAL.has(node.status)) {
        return refuse('terminal', `任务 ${nodeId} 处于 ${statusLabel(node.status)}；已结束的任务不能纠偏`)
      }
      // A blank correction would be stored and then rendered onto the node's own block AND onto the
      // mission-chain line of every descendant — a line that says nothing, in the one channel that
      // reaches every dispatch.
      if (isBlank(safeText)) return refuse('blank-text', '纠偏内容不能只有空白')
      if (node.corrections.includes(safeText)) return accept(node)
      const updated = this.replace(state, node, { corrections: [...node.corrections, safeText] })
      await this.flush(node.rootId)
      return accept(updated)
    })
  }

  /**
   * Advance the durable delivery watermark of {@link NodeRecord.correctionsDeliveredUpTo}: the
   * first `upTo` corrections have been confirmed READ by the session that holds this node (either
   * a live steer, or a cold-wake prompt that carried them). What it buys is the restart case — a
   * mark kept only in memory is empty exactly when the wake that needs it happens.
   *
   * Deliberately tolerant rather than a mutation result: this is bookkeeping ABOUT a delivery that
   * already happened, so it is monotone (a raced, older report can never pull the mark back) and
   * clamped to the array's own length (a report that outran a concurrent append cannot make a later
   * wake skip a correction nobody read). A no-op returns without writing.
   */
  async markCorrectionsDelivered(nodeId: string, upTo: number): Promise<void> {
    await this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return
      const { state, node } = found
      const next = Math.min(Math.max(node.correctionsDeliveredUpTo, upTo), node.corrections.length)
      if (next === node.correctionsDeliveredUpTo) return
      this.replace(state, node, { correctionsDeliveredUpTo: next })
      await this.flush(state.tree.rootId)
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
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
      const { state, node } = found
      if (state.tree.ownerSessionId !== callerSessionId && node.claimedBy !== callerSessionId) {
        return refuse('not-owner', `任务 ${node.rootId} 的创建者、或持有 ${nodeId} 的执行者，才能取消它的子任务`)
      }
      if (state.tree.closedAt !== null) {
        return refuse('terminal', `任务 ${node.rootId} 已归档；不能再取消它的子任务`)
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
          result: descendant.result ?? '被父任务取消',
          hasResult: true,
          claimedBy: null,
          // Terminal: a parked address on a cancelled node is spent.
          parkedWorker: null,
          updatedAt: now,
        }
        next.set(id, updated)
        touched.push(updated)
      }
      if (touched.length === 0) return refuse('nothing-to-cancel', `任务 ${nodeId} 没有未完成的子任务`)
      this.states.set(node.rootId, { tree: state.tree, nodes: next })
      // Seed from every PARENT of every cancelled node: a reused prerequisite is shared, and
      // cancelling it can strand its other parents in `blocked`, which nothing else recomputes.
      const seeds = [nodeId, ...touched.flatMap((entry) => this.parentsOf(next, entry.id))]
      this.propagateFrom({ tree: state.tree, nodes: next }, seeds)
      await this.flush(node.rootId)
      return accept(touched)
    })
  }

  /** Record that the owner read a terminal result; unlocks `finish_mission`. */
  async markResultRead(nodeId: string): Promise<MutationResult<NodeRecord>> {
    return this.withLock(async () => {
      const found = this.locate(nodeId)
      if (found === undefined) return refuse('not-found', `任务 ${nodeId} 不存在`)
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
      if (state === undefined) return refuse('not-found', `任务 ${rootId} 不存在`)
      if (state.tree.ownerSessionId !== callerSessionId) {
        return refuse('not-owner', '只有创建这个任务的会话才能收尾')
      }
      const root = state.nodes.get(rootId)
      if (root === undefined) return refuse('not-found', `任务 ${rootId} 没有根任务`)
      if (state.tree.closedAt !== null) return accept(root)
      if (!TERMINAL.has(root.status)) {
        return refuse('not-dispatchable', `任务 ${rootId} 处于 ${statusLabel(root.status)}；还不能收尾`)
      }
      if (root.resultReadAt === null) {
        return refuse('unread-result', '收尾前先用 mission_result 读根结果')
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
      if (state === undefined) return refuse('not-found', `任务 ${rootId} 不存在`)
      if (state.tree.ownerSessionId !== callerSessionId) {
        return refuse('not-owner', '只有创建这个任务的会话才能取消')
      }
      if (state.tree.closedAt !== null) {
        return refuse('terminal', `任务 ${rootId} 已归档；不能再取消`)
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
   * `cancel_mission`); `finish_mission` archives instead. */
  async deleteTree(rootId: string): Promise<MutationResult<readonly string[]>> {
    const state = this.states.get(rootId)
    if (state === undefined) return refuse('not-found', `任务 ${rootId} 不存在`)
    const root = state.nodes.get(rootId)
    if (root === undefined) return refuse('not-found', `任务 ${rootId} 没有根任务`)
    if (!TERMINAL.has(root.status)) {
      return refuse(
        'not-deletable',
        `任务 ${rootId} 处于 ${statusLabel(root.status)}；只有已结束的任务能删除（还在跑的用 cancel_mission 结束）`,
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
   * `ready` — an ordinary mission, not a parent stuck waiting for premises that no longer exist. */
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
   * many unrelated missions wear), and a false reuse hands a later branch a RESULT answering a
   * different question, so a title match with a different description is created as new mission. */
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
    // sub-mission it already has.
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
