/**
 * The dispatch loop: pure host code that scans the tree, dispatches work units and reclaims nodes whose worker vanished; it never calls a model.
 * @module @avantf/work-core/engine
 */
import { WorkTree } from './tree.js'
import { isTroubledNode } from './prompt.js'
import { CAPACITY, TERMINAL, type NodeRecord } from './types.js'

/** Resume a worker for one node; the engine awaits only the reservation, not the worker. */
export interface StartWorkerInput {
  readonly node: NodeRecord
  /** The session id reserved for this dispatch, already bound on the node. */
  readonly claimId: string
}

export interface EngineHooks {
  /** Reserve a child session id without creating it, which closes the spawn/bind window: the node is bound before anything is materialized. Pair with {@link releaseClaimId}: a claim reserved for a dispatch that is then refused was never bound and must be handed back, or it stays "live" as a ghost forever. */
  reserveClaimId(): string
  /** Hand back a claim reserved by {@link reserveClaimId} whose dispatch did not happen; nothing was materialized for it. */
  releaseClaimId(claimId: string): void
  /** Materialize the worker for a dispatched node and deliver its prompt; the prompt is built HERE from `tree.view(node.id)`, because a sibling result may have landed since the dispatch decision. */
  startWorker(input: StartWorkerInput): Promise<void>
  /** Stop a worker believed to be stuck. */
  interruptWorker(sessionId: string): Promise<void>
  /** Deliver a one-line signal to the tree owner; it carries no content — the guidance layer does. */
  notifyOwner(rootId: string, reason: string): void
  /** Heads-up that one node keeps going silent, so the owner can decide whether to intervene — deliberately separate from {@link notifyOwner}, which means "a tree reached a terminal state". */
  notifyStalled?(info: StallReport): void
  /**
   * Report nodes waiting for a parked session to be woken; the engine cannot wake anything itself, because a wake is a delivery through `ctx.subagents` that only the host owns and must be authorized by the child's live direct parent.
   * Its whole job is to say a convergence pass is due on an idle session, as a BATCH: an owner that was offline can materialize with several parked nodes at once, and one wake per node would be a wake storm.
   * The host performs the actual wake inside the owner's next turn; a host that cannot wake leaves the address on the node, and this reports again on the next pass.
   */
  notifyParkedReady?(nodes: readonly NodeRecord[]): void
  reportDispatchFailure?(nodeId: string, error: unknown): void
  trace?(message: string): void
}

export interface StallReport {
  readonly rootId: string
  readonly nodeId: string
  readonly title: string
  /** Dispatches so far, NOT a budget: successful rounds — including aggregate/convergence passes — raise it too. */
  readonly attempts: number
  /** Failed executions so far, including the reclaim being reported; this is the counter the `failed` ceiling bounds. */
  readonly failures: number
  /** Reclaims for silence so far, including the one being reported. */
  readonly stalls: number
  readonly silentMs: number
}

export interface EngineOptions {
  /** Dispatch ceiling. Values above this wait for the next pump. */
  readonly maxConcurrent: number
  /** A dispatched node with no progress for this long is considered stuck. */
  readonly staleMs: number
  /** Clock for the stale check, injectable so tests can move time instead of waiting for it; production leaves it at `Date.now`. */
  readonly now?: () => number
}

/** Hardware parallelism, read without assuming a Node or DOM lib; the value is advisory (config can override it) and its absence is not an error. */
export function detectConcurrency(): number {
  const globals = globalThis as Record<string, unknown>
  const navigator = globals['navigator'] as { hardwareConcurrency?: number } | undefined
  const cores = navigator?.hardwareConcurrency ?? (globals['process'] as { availableParallelism?: () => number } | undefined)?.availableParallelism?.() ?? 4
  return Math.max(1, cores - 1)
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  maxConcurrent: detectConcurrency(),
  staleMs: 30 * 60 * 1000,
}

/** When a node's worker was last heard from: observed activity if there is any, otherwise the dispatch that opened this attempt. */
function silenceSince(node: NodeRecord): number {
  return node.progressAt > 0 ? node.progressAt : node.claimedAt
}

export class WorkEngine {
  private pumping = false
  private pumpRequested = false

  constructor(
    private readonly tree: WorkTree,
    private readonly hooks: EngineHooks,
    private readonly options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
  ) {}

  /** Run one dispatch pass; `dispatch()` decides and marks in the same await, so a second pass cannot see the same node as available and no batch bookkeeping is needed. */
  async pump(): Promise<number> {
    if (this.pumping) {
      // A pass is already running; run once more when it finishes so a trigger that arrived during the pass is never lost.
      this.pumpRequested = true
      return 0
    }
    this.pumping = true
    let dispatched = 0
    try {
      do {
        this.pumpRequested = false
        dispatched += await this.pass()
      } while (this.pumpRequested)
    } finally {
      this.pumping = false
    }
    await this.reportTerminalRoots()
    this.reportParkedReady()
    return dispatched
  }

  async sweep(): Promise<{ reclaimed: number; dispatched: number }> {
    const reclaimed = await this.reclaimStale()
    const dispatched = await this.pump()
    return { reclaimed, dispatched }
  }

  /**
   * Reclaim nodes whose worker is gone or stuck; liveness is the primary signal, and the timeout only covers "alive but silent".
   * Silence is measured from the worker's last observed activity, not the dispatch, so a long execution that keeps appending is progress rather than grounds to throw the work away; a live binding is interrupted before it is reclaimed.
   */
  async reclaimStale(): Promise<number> {
    const now = this.options.now?.() ?? Date.now()
    let reclaimed = 0
    for (const root of this.tree.trees()) {
      // Resolve the tree's live holders once: one scan per tree, not one per node.
      const held = new Set(this.tree.heldByLiveWorkers(root.rootId).map((node) => node.id))
      for (const node of this.tree.nodesOf(root.rootId)) {
        if (node.status !== 'running') continue
        const holder = node.claimedBy
        const silentMs = now - silenceSince(node)
        const stalled = holder !== null && held.has(node.id) && silentMs > this.options.staleMs
        if (holder !== null && held.has(node.id)) {
          if (!stalled) continue
          await this.hooks.interruptWorker(holder)
        }
        const result = await this.tree.reclaim(node.id, stalled ? 'stalled' : 'vanished')
        if (!result.ok) continue
        reclaimed += 1
        if (stalled) await this.reportStall(result.value, silentMs)
      }
    }
    return reclaimed
  }

  /**
   * Tell the owner about a node that keeps going silent, but only when it is worth a turn of its own: the engine already recovered, so the message is a heads-up rather than a question.
   * Waiting for a repeat, or for a node about to run out of attempts, is what keeps a permanently flaky node from turning a sweep into a wake storm; the durable marker makes "once" true across restarts.
   */
  private async reportStall(node: NodeRecord, silentMs: number): Promise<void> {
    const notify = this.hooks.notifyStalled
    if (notify === undefined) return
    // The SAME floors the owner-facing `isTroubled` flag uses (see `isTroubledNode`), so the flag and
    // the message cannot report different things about one node. `failures`, not `attempts`: the
    // latter also rises on rounds that succeed.
    if (!isTroubledNode(node)) return
    if (!(await this.tree.claimStallReport(node.id))) return
    notify({
      rootId: node.rootId,
      nodeId: node.id,
      title: node.title,
      attempts: node.attempts,
      failures: node.failures,
      stalls: node.stalls,
      silentMs,
    })
  }

  /** Destroy trees whose owner session no longer exists: the owner is the authority over the tree, and a hot reload or host restart leaves it resolvable, so nothing is destroyed there. A tree whose owner merely cannot be OBSERVED is left alone and reported instead — the host being unable to answer is not evidence the owner is gone, and a destroyed tree cannot be recovered. */
  async reconcileOrphans(): Promise<readonly string[]> {
    const orphaned = await this.tree.orphanedTrees()
    const destroyed: string[] = []
    for (const { tree, probe } of orphaned) {
      if (probe.kind !== 'missing') continue
      for (const node of this.tree.heldByLiveWorkers(tree.rootId)) {
        if (node.claimedBy !== null) await this.hooks.interruptWorker(node.claimedBy)
      }
      await this.tree.destroyTree(tree.rootId)
      destroyed.push(tree.rootId)
    }
    return destroyed
  }

  /**
   * Room for more workers: `WorkTree.inFlightCount` counts BOUND nodes, the binding landing inside the dispatch call, so no separate tally is needed and a second pass in the same tick cannot over-subscribe.
   */
  private hasCapacity(): boolean {
    return this.tree.inFlightCount() < this.options.maxConcurrent
  }

  private async pass(): Promise<number> {
    let dispatched = 0
    const reserved = new Set<string>()
    while (this.hasCapacity()) {
      const candidate = this.tree.nextDispatchable(reserved)
      if (candidate === undefined) break
      const claimId = this.hooks.reserveClaimId()
      const decision = await this.tree.dispatch(candidate.id, claimId)
      reserved.add(candidate.id)
      if (!decision.ok) {
        // Another pass won the race, or the node hit its attempt ceiling. The reservation never
        // reached a node, so it must go back: nothing will ever start (or settle) under that id.
        this.hooks.releaseClaimId(claimId)
        this.hooks.trace?.(`dispatch refused ${candidate.id}: ${decision.code}`)
        continue
      }
      dispatched += 1
      void this.hooks
        .startWorker({ node: decision.value.node, claimId })
        .catch((error: unknown) => {
          // The node stays bound for the stale sweep to reclaim; reporting keeps one bad spawn from stalling the pass without hiding why it failed.
          this.hooks.reportDispatchFailure?.(decision.value.node.id, error)
        })
    }
    return dispatched
  }

  /** Report the parked-ready batch to the host after the dispatch loop; the wake itself is the host's job — see {@link EngineHooks.notifyParkedReady}. */
  private reportParkedReady(): void {
    const notify = this.hooks.notifyParkedReady
    if (notify === undefined) return
    const parked = this.tree.parkedReadyNodes()
    if (parked.length === 0) return
    notify(parked)
  }

  /**
   * Wake the owner about every terminal tree, exactly once each; dedup lives on the durable tree record (`claimReport`), because an in-memory set is empty after a restart and would re-report every tree that had ever reached a terminal state.
   */
  private async reportTerminalRoots(): Promise<void> {
    for (const tree of this.tree.trees()) {
      // Archival already told the owner: a closed tree is one the owner has seen and retired, so waking about it would be pure noise.
      if (tree.closedAt !== null) continue
      const root = this.tree.node(tree.rootId)
      if (root === undefined || !TERMINAL.has(root.status)) continue
      if (!(await this.tree.claimReport(tree.rootId))) continue
      this.hooks.notifyOwner(tree.rootId, root.status)
    }
  }

  /** Forget the report marker for a tree, so a re-rooted tree can report again. */
  forgetReport(rootId: string): void {
    void this.tree.clearReport(rootId)
  }
}

/** Exported for tests and the plugin's capacity reporting. */
export { CAPACITY }
