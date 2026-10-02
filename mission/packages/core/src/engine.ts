/**
 * The dispatch loop: pure host code that scans the tree, dispatches mission units and reclaims nodes whose worker vanished; it never calls a model.
 * @module @avantf/mission-core/engine
 */
import { MissionTree } from './tree.js'
import { judgeWorker, type LivenessBound, type LivenessVerdict } from './liveness.js'
import { isTroubledNode } from './prompt.js'
import { CAPACITY, TERMINAL, type NodeRecord } from './types.js'

/** Resume a worker for one node; the engine awaits only the reservation, not the worker. */
export interface StartWorkerInput {
  readonly node: NodeRecord
  /** The session id reserved for this dispatch, already bound on the node. */
  readonly claimId: string
}

/** One node the host should try to CONTINUE in the session it was interrupted in (a cold wake). */
export interface ResumeWorkerInput {
  readonly node: NodeRecord
  /** The session id recorded in `lastWorkerId`: the address to deliver to, and the identity the
   *  adoption binds if the delivery is accepted. */
  readonly workerId: string
}

/**
 * What a continuation attempt resolved to. Three answers, not a boolean, because "nothing to do" is
 * not "it failed": when another delivery already owns the session, starting a fresh executor on top
 * of it is precisely the double run this guard exists to prevent.
 *
 * - `resumed` — the node is bound to `workerId` and the prompt was accepted; the caller counts one
 *   dispatch and starts nobody.
 * - `failed` — the continuation is not going to happen: either the delivery was refused and the
 *   host has already undone its own adoption (`reclaim(..., 'wake-failed')`, which charges no
 *   budget), or the host declined it BEFORE adopting because the node drifted too far from what that
 *   session last read (a material change; see `continuation`). Either way the caller takes the
 *   ordinary fresh path with a newly reserved claim, which is the complete answer: a new executor
 *   reads every correction and every note.
 * - `skip` — the node must be left exactly as it is: a wake for that session is in flight, the owner
 *   is not materialized, or the node's state moved under us. Never a reason to spawn.
 */
export type ResumeOutcome = 'resumed' | 'failed' | 'skip'

export interface EngineHooks {
  /** Reserve a child session id without creating it, which closes the spawn/bind window: the node is bound before anything is materialized. Pair with {@link releaseClaimId}: a claim reserved for a dispatch that is then refused was never bound and must be handed back, or it stays "live" as a ghost forever. */
  reserveClaimId(): string
  /** Hand back a claim reserved by {@link reserveClaimId} whose dispatch did not happen; nothing was materialized for it. */
  releaseClaimId(claimId: string): void
  /** Materialize the worker for a dispatched node and deliver its prompt; the prompt is built HERE from `tree.view(node.id)`, because a sibling result may have landed since the dispatch decision. */
  startWorker(input: StartWorkerInput): Promise<void>
  /**
   * Try to CONTINUE a node in the session it was interrupted in, instead of starting a fresh one
   * (a cold wake). The host owns this because only it can reach `ctx.subagents`, and the delivery
   * must be sent by the child's live direct parent (`authorizeLineage`).
   *
   * Called BEFORE a claim is reserved, so a continuation that lands consumes no claim id and a
   * fallback reserves one exactly as any other dispatch does. See {@link ResumeOutcome} for the
   * contract, including the rule that `skip` must never be answered with a spawn.
   *
   * Priority when several addresses apply — documented because it is a decision, not an accident:
   * a parked session wins (it is an ALIVE continuation waiting to be woken), then this cold
   * continuation, then a fresh spawn (`nextDispatchable` already excludes parked nodes).
   */
  resumeWorker?(input: ResumeWorkerInput): Promise<ResumeOutcome>
  /** Stop a worker believed to be stuck. */
  interruptWorker(sessionId: string): Promise<void>
  /** Deliver a one-line signal to the tree owner; it carries no content — the guidance layer does. */
  notifyOwner(rootId: string, reason: string): void
  /** Heads-up that one node keeps going silent, so the owner can decide whether to intervene — deliberately separate from {@link notifyOwner}, which means "a tree reached a terminal state". */
  notifyStalled?(info: StallReport): void
  /**
   * Diagnostic sink for a `hung` reclaim: the worker was still alive but had produced nothing for a
   * whole window (or exceeded the round cap), so the engine interrupted it and re-queued the node
   * WITHOUT charging any budget. Nothing here is a decision for the owner — an apparatus outage is
   * not a mission failure — so this exists to be LOGGED, not to wake anybody.
   */
  notifyHung?(info: HungReport): void
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

/** What a `hung` reclaim looked like, for the engine's diagnostic log. It carries no owner-facing
 *  message: `hung` is deliberately NOT an `isTroubled` signal (see {@link isTroubledNode}). */
export interface HungReport {
  readonly rootId: string
  readonly nodeId: string
  readonly title: string
  readonly attempts: number
  readonly failures: number
  readonly stalls: number
  /** Which bound fired: the `staleMs` output window, or the `roundMs` ceiling. */
  readonly bound: Extract<LivenessBound, 'output' | 'round'>
  /** ms since the dispatch that opened this round. */
  readonly ranMs: number
  /** ms since the worker last produced anything. */
  readonly idleMs: number
}

export interface EngineOptions {
  /** Dispatch ceiling. Values above this wait for the next pump. */
  readonly maxConcurrent: number
  /** How long a worker may produce NOTHING before it is considered stuck (see `liveness.ts`). */
  readonly staleMs: number
  /** Wall-clock ceiling on one dispatch: past this the node is reclaimed as `hung` no matter how
   *  many events refreshed its timestamps. The backstop against a transport that retries forever. */
  readonly roundMs: number
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
  /** One hour: deliberately generous, because it is the backstop that a worker's own timestamps
   *  cannot veto — a round that legitimately needs longer than this is not what the engine is for. */
  roundMs: 60 * 60 * 1000,
}

export class MissionEngine {
  private pumping = false
  private pumpRequested = false

  constructor(
    private readonly tree: MissionTree,
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
   * Reclaim nodes whose worker is gone or stuck; liveness is the primary signal, and the windows
   * only cover "alive but not useful".
   *
   * The judgement is `judgeWorker` (see `liveness.ts`): silence measured from the last event at all
   * is `stalled` and charges the failure budget exactly as before; a worker that keeps being heard
   * from while producing NOTHING for `staleMs`, or that exceeds the round cap, is `hung` and charges
   * nothing. Both interrupt the live binding before reclaiming, and both go through the same
   * compare-and-swap `MissionTree.reclaim`, so a verdict judged against a snapshot taken outside
   * the tree lock cannot strip a fresh binding or charge one attempt twice.
   */
  async reclaimStale(): Promise<number> {
    const now = this.options.now?.() ?? Date.now()
    const windows = { staleMs: this.options.staleMs, roundMs: this.options.roundMs }
    let reclaimed = 0
    for (const root of this.tree.trees()) {
      // Resolve the tree's live holders once: one scan per tree, not one per node.
      const held = new Set(this.tree.heldByLiveWorkers(root.rootId).map((node) => node.id))
      for (const node of this.tree.nodesOf(root.rootId)) {
        if (node.status !== 'running') continue
        const holder = node.claimedBy
        if (holder !== null && held.has(node.id)) {
          const verdict = judgeWorker(node, now, windows)
          if (verdict === undefined) continue
          await this.hooks.interruptWorker(holder)
          // The holder from THIS pass's snapshot, checked under the tree lock: an `interruptWorker`
          // wait can span a whole second sweep that reclaimed and re-dispatched the node, and acting
          // on the stale verdict would strip the fresh binding and charge `failures` twice.
          const result = await this.tree.reclaim(node.id, verdict.cause, holder)
          if (!result.ok) continue
          reclaimed += 1
          if (verdict.cause === 'stalled') await this.reportStall(result.value, verdict.silentMs)
          else this.reportHung(result.value, verdict)
          continue
        }
        // No live holder: the worker vanished. Same CAS as above, with the snapshot's holder
        // (`null` included) as the expectation.
        const result = await this.tree.reclaim(node.id, 'vanished', holder)
        if (result.ok) reclaimed += 1
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

  /** Tell the host a node was reclaimed as `hung`, so the event is diagnosable. Deliberately no
   *  owner wake and no durable marker: this is apparatus trouble, the engine recovered on its own,
   *  and the `isTroubled` flag is reserved for facts the owner can act on. */
  private reportHung(node: NodeRecord, verdict: LivenessVerdict): void {
    const notify = this.hooks.notifyHung
    if (notify === undefined) return
    notify({
      rootId: node.rootId,
      nodeId: node.id,
      title: node.title,
      attempts: node.attempts,
      failures: node.failures,
      stalls: node.stalls,
      // `stalled` is handled above, so only the two hung bounds reach here.
      bound: verdict.bound === 'round' ? 'round' : 'output',
      ranMs: verdict.ranMs,
      idleMs: verdict.idleMs,
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
   * Room for more workers: `MissionTree.inFlightCount` counts BOUND nodes, the binding landing inside the dispatch call, so no separate tally is needed and a second pass in the same tick cannot over-subscribe.
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
      // Reserved before anything can start for it: a `skip`ped continuation must not be re-selected
      // in this same pass either, or the pass would spin on the same node.
      reserved.add(candidate.id)

      // CONTINUATION FIRST (a cold wake). A node reclaimed by an ordinary sweep has no handle, so
      // this branch is reached only for a binding an interruption demoted (`reconcileOnOpen`), which
      // is the case the previous generation could only answer with a fresh session.
      if (candidate.lastWorkerId !== null && this.hooks.resumeWorker !== undefined) {
        const outcome = await this.hooks.resumeWorker({ node: candidate, workerId: candidate.lastWorkerId })
        if (outcome === 'resumed') {
          // Bound and delivered: one dispatch, and deliberately no `startWorker`.
          dispatched += 1
          continue
        }
        if (outcome === 'skip') {
          // Nothing was bound and nothing must be spawned: another delivery owns the session, or the
          // state moved. Leave it for the next pass.
          this.hooks.trace?.(`continuation of ${candidate.id} deferred`)
          continue
        }
        // 'failed': the host has already undone the adoption, so the ordinary fresh path below is
        // the complete answer — with no budget charged and no cooldown, because "the session is gone
        // or refuses to resume" is neither a mission failure nor an infrastructure outage.
      }

      const claimId = this.hooks.reserveClaimId()
      const decision = await this.tree.dispatch(candidate.id, claimId)
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
