/**
 * The dispatch loop: pure host code that scans the tree, dispatches mission units and reclaims nodes whose worker vanished; it never calls a model.
 * @module @avantf/mission-core/engine
 */
import { MissionTree } from './tree.js'
import { judgeWorker, type LivenessBound, type LivenessVerdict } from './liveness.js'
import { isTroubledNode } from './prompt.js'
import {
  CAPACITY_CEILING,
  DEFAULT_CAPACITY_WAIT_MS,
  DEFAULT_MIN_FREE_MEMORY_BYTES,
} from './capacity.js'
import type { CapacityPolicy, DeferredCandidate } from './dispatch.js'
import type { ResourceProbe } from './resources.js'
import { CAPACITY, TERMINAL, type NodeRecord, type WaitingFor } from './types.js'

/** Resume a worker for one node; the engine awaits only the reservation, not the worker. */
export interface StartWorkerInput {
  readonly node: NodeRecord
  /** The session id reserved for this dispatch, already bound on the node. */
  readonly claimId: string
  /**
   * How long the CAPACITY gate deferred this node before this dispatch picked it up, in ms. Read
   * from the engine's own aging clock at the moment the candidate was selected — the same
   * `capacityWaits` bookkeeping `waitingFor` is built from — so the prompt's "it queued for N" can
   * never disagree with the panel's queue marker. `0`/absent means the node never waited for
   * capacity, and the prompt then says nothing about a queue.
   */
  readonly waitedMs?: number
}

/** One node the host should try to CONTINUE in the session it was interrupted in (a cold wake). */
export interface ResumeWorkerInput {
  readonly node: NodeRecord
  /** The session id recorded in `lastWorkerId`: the address to deliver to, and the identity the
   *  adoption binds if the delivery is accepted. */
  readonly workerId: string
  /**
   * The capacity policy this candidate was selected under. The host hands it straight to
   * `adoptContinuation`, so the adoption re-runs the plan's own judgement against the live load
   * under the tree lock exactly as `dispatch` does — a continuation is a dispatch and must not bind
   * past a machine that filled up between the plan and the adoption. Absent means the caller opted
   * out of the gate (the wake paths that have no plan snapshot pass nothing).
   */
  readonly capacity?: CapacityPolicy
  /** The capacity wait this candidate served before being selected; see {@link StartWorkerInput}. */
  readonly waitedMs?: number
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
   * A dispatch was DEFERRED by the capacity gate (never refused). Rate-limited by the engine, one
   * line per node per minute, so a queue waiting on a heavy mission does not flood the log while
   * still remaining diagnosable. The host formats and logs it.
   */
  notifyDeferred?(info: DispatchDeferral): void
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

/** Why a dispatch is waiting, for the engine's rate-limited diagnostic log. This is NOT an
 *  `isTroubled` signal: ordinary queuing is not "keeps going wrong". */
export interface DispatchDeferral {
  readonly nodeId: string
  readonly rootId: string
  readonly title: string
  readonly waitingFor: WaitingFor
  /** Weight of the deferred node (`capacity` reason). */
  readonly needed: number
  readonly capacity: number
  readonly running: number
  /** How long the capacity gate has been deferring this node; `0` for a non-capacity reason. */
  readonly waitedMs: number
  /** True when this node has aged into a reservation (no new admissions until it fits). */
  readonly reserved: boolean
}

export interface EngineOptions {
  /**
   * Backstop on the NUMBER of running units: with `capacity` it makes up the two-part admission
   * rule. Capacity is the MASTER gate (how much work the machine can carry); this only stops a flood
   * of weight-1 missions from opening more sessions than anyone wants. Both must admit a candidate.
   */
  readonly maxConcurrent: number
  /**
   * Master gate: how many capacity units (cores-equivalent, the same unit as `NodeRecord.weight`)
   * may run at once. Required, because the core must not guess at the hardware — the host derives it
   * (configured → `os.availableParallelism()` → `os.cpus().length` → 4, minus one reserved core) and
   * injects the number, which is also what makes every scheduling decision deterministic in tests.
   */
  readonly capacity: number
  /**
   * How long a node may be repeatedly deferred by the capacity gate before it RESERVES the machine
   * (no new admissions until it fits). See `capacity.ts` for the value and its rationale.
   */
  readonly capacityWaitMs: number
  /**
   * Free-memory floor, in bytes, enforced through {@link ResourceProbe.memoryBudget}: below it the
   * gate DEFERS dispatch (never refuses). `0` disables the gate; the probe itself is optional, and a
   * probe that does not implement `memoryBudget` leaves this gate inactive (the v1 degradation path).
   */
  readonly minFreeMemoryBytes: number
  /** Machine reader, injected by the host. Absent means "no resource signal": the memory floor is
   *  then the only gate this could arm, and with no probe it is inactive. */
  readonly probe?: ResourceProbe
  /** How long a worker may produce NOTHING before it is considered stuck (see `liveness.ts`). */
  readonly staleMs: number
  /** Wall-clock ceiling on one dispatch: past this the node is reclaimed as `hung` no matter how
   *  many events refreshed its timestamps. The backstop against a transport that retries forever. */
  readonly roundMs: number
  /** Clock for the stale check and the capacity aging window, injectable so tests can move time
   *  instead of waiting for it; production leaves it at `Date.now`. */
  readonly now?: () => number
}

/**
 * Advisory parallelism for a core that has no Node API of its own (the core builds without Node
 * types, so the real machine reading is the HOST's job — see `resource.ts` and the plugin's probe).
 *
 * The lookup order is deliberate: `navigator.hardwareConcurrency` when a DOM-shaped global is
 * present, then the family's old fallback of 4. An earlier build tried
 * `process.availableParallelism?.()` here and that was DEAD CODE: Node has never exposed that member
 * on `process` — the real API is `os.availableParallelism()`, which the host now calls. Core callers
 * that need the machine number must inject `EngineOptions.capacity`; this function only exists so
 * `DEFAULT_ENGINE_OPTIONS` (and any non-Node embedder) has a sane advisory value.
 */
export function detectConcurrency(): number {
  const globals = globalThis as Record<string, unknown>
  const navigator = globals['navigator'] as { hardwareConcurrency?: number } | undefined
  const cores = navigator?.hardwareConcurrency ?? 4
  if (!Number.isFinite(cores) || cores < 1) return 1
  return Math.max(1, Math.floor(cores) - 1)
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  maxConcurrent: detectConcurrency(),
  /**
   * Deliberately the CEILING, i.e. an effectively open gate: the capacity the engine is supposed to
   * gate on is the MACHINE's, and only the host can read the machine. A caller that constructs an
   * engine without injecting `capacity` therefore keeps the pre-capacity behaviour (`maxConcurrent`
   * alone) instead of being silently capped by a guess; the plugin always injects the derived value.
   */
  capacity: CAPACITY_CEILING,
  capacityWaitMs: DEFAULT_CAPACITY_WAIT_MS,
  minFreeMemoryBytes: DEFAULT_MIN_FREE_MEMORY_BYTES,
  staleMs: 30 * 60 * 1000,
  /** One hour: deliberately generous, because it is the backstop that a worker's own timestamps
   *  cannot veto — a round that legitimately needs longer than this is not what the engine is for. */
  roundMs: 60 * 60 * 1000,
}

/**
 * Rate limit on the deferral log: while the capacity gate holds a node back, its `dispatch deferred`
 * line is emitted at most once per minute. The condition repeats on every pass (a completion, a
 * sweep, a signal), so without this one queued mission would flood the log.
 */
const DEFER_LOG_INTERVAL_MS = 60_000

export class MissionEngine {
  private pumping = false
  private pumpRequested = false
  /** Node id → when the capacity gate first deferred it. In-memory on purpose: a restart loses the
   *  aging clock, which re-arms it (one extra wait window) — never a correctness loss. */
  private readonly capacityWaits = new Map<string, number>()
  /** The live `waitingFor` projection, refreshed at the end of every pass: node id → reason, or
   *  absent for a node nothing is holding back. */
  private readonly waiting = new Map<string, WaitingFor>()
  /** Last time each node's deferral was logged, for the rate limit. */
  private readonly deferredLogged = new Map<string, number>()
  /** Nodes whose RESERVATION transition has already been logged. A reservation overrides the rate
   *  limit: it changes what the engine admits, so it must not be swallowed by a recent deferral line. */
  private readonly reservedLogged = new Set<string>()

  constructor(
    private readonly tree: MissionTree,
    private readonly hooks: EngineHooks,
    private readonly options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
  ) {}

  /** Why one node has not been dispatched, or `null` when nothing is holding it back. The projection
   *  is read by the host for `mission_result` and the panel; it is live state, never persisted. */
  waitingFor(nodeId: string): WaitingFor | null {
    return this.waiting.get(nodeId) ?? null
  }

  /** The capacity the engine is actually gating on, for diagnostics and tests. */
  capacity(): { capacity: number; maxConcurrent: number; runningCount: number; runningWeight: number } {
    const load = this.tree.runningLoad()
    return {
      capacity: this.options.capacity,
      maxConcurrent: this.options.maxConcurrent,
      runningCount: load.count,
      runningWeight: load.weight,
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

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
   * The machine-wide gates that do not depend on WHICH node is being considered: the free-memory
   * floor. Returns the `waitingFor` every candidate carries while it is set, or `undefined` when the
   * gate is open.
   *
   * A probe that does not implement `memoryBudget` leaves the gate inactive (v1: no platform
   * adapter). A probe that implements it and answers `null` means "cannot confirm the floor", and
   * that is a DEFER, not "plenty" — see `resource.ts`: no signal never relaxes scheduling.
   */
  private memoryFloor(): WaitingFor | undefined {
    const floor = this.options.minFreeMemoryBytes
    const read = this.options.probe?.memoryBudget
    if (read === undefined || floor <= 0) return undefined
    let budget: number | null
    try {
      budget = read.call(this.options.probe)
    } catch {
      budget = null
    }
    if (budget === null) return { reason: 'capacity', resource: 'memory' }
    if (budget >= floor) return undefined
    return { reason: 'capacity', resource: 'memory', needed: floor, available: budget }
  }

  /** The capacity arithmetic for this moment, built from the tree's live load. */
  private capacityPolicy(globalBlock: WaitingFor | undefined): CapacityPolicy {
    const load = this.tree.runningLoad()
    return {
      capacity: this.options.capacity,
      maxConcurrent: this.options.maxConcurrent,
      runningCount: load.count,
      runningWeight: load.weight,
      deferredSince: this.capacityWaits,
      agingMs: this.options.capacityWaitMs,
      now: this.now(),
      ...globalBlock === undefined ? {} : { globalBlock },
    }
  }

  private async pass(): Promise<number> {
    let dispatched = 0
    const reserved = new Set<string>()
    let planned: readonly DeferredCandidate[] = []
    let planReserved = false
    for (;;) {
      const block = this.memoryFloor()
      // ONE policy object per iteration, used BOTH to choose the candidate and to arm the tree's
      // lock-held recheck. Passing the same one is what makes the recheck idempotent for a node the
      // plan already admitted: it re-runs the same judgement against live state.
      const policy = this.capacityPolicy(block)
      const plan = this.tree.planDispatch(reserved, policy)
      planned = plan.deferred
      planReserved = plan.reserved
      // Aging bookkeeping: a node deferred FOR CAPACITY starts its clock the first time it is
      // skipped, and keeps it across passes; anything else (a unit holder, a full slot, a memory
      // floor) is not the node's capacity wait and must not reserve the machine on its behalf.
      // Memory-blocked passes age nothing at all (see `DispatchPlan`), including not RESETTING a
      // clock that a capacity wait already earned.
      if (block === undefined) {
        for (const entry of plan.deferred) {
          const cpuCapacity = entry.waitingFor.reason === 'capacity' && entry.waitingFor.resource !== 'memory'
          if (cpuCapacity) {
            if (!this.capacityWaits.has(entry.node.id)) this.capacityWaits.set(entry.node.id, this.now())
          } else {
            // The node is waiting on something else, so it is not accumulating capacity wait.
            this.capacityWaits.delete(entry.node.id)
          }
        }
      }
      const candidate = plan.selected
      if (candidate === undefined) {
        this.reportDeferrals(plan.deferred, plan.reserved)
        break
      }

      // Reserved before anything can start for it: a `skip`ped continuation must not be re-selected
      // in this same pass either, or the pass would spin on the same node.
      reserved.add(candidate.id)
      // The capacity wait this node served before being picked, read from the SAME aging clock the
      // gate (and `waitingFor`) is built from, and read BEFORE the entry below is dropped — that
      // drop is what makes this the last moment the fact exists. The same number goes to whichever
      // path delivers the prompt, so a continued session is told it exactly as a fresh one is.
      const deferredSince = this.capacityWaits.get(candidate.id)
      const waitedMs = deferredSince === undefined ? 0 : Math.max(0, policy.now - deferredSince)
      // It is being dispatched, so it is no longer waiting for capacity.
      this.capacityWaits.delete(candidate.id)

      // CONTINUATION FIRST (a cold wake). A node reclaimed by an ordinary sweep has no handle, so
      // this branch is reached only for a binding an interruption demoted (`reconcileOnOpen`), which
      // is the case the previous generation could only answer with a fresh session.
      if (candidate.lastWorkerId !== null && this.hooks.resumeWorker !== undefined) {
        const outcome = await this.hooks.resumeWorker({
          node: candidate,
          workerId: candidate.lastWorkerId,
          capacity: policy,
          waitedMs,
        })
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
      const decision = await this.tree.dispatch(candidate.id, claimId, policy)
      if (!decision.ok) {
        // Another pass won the race, or the node hit its attempt ceiling. The reservation never
        // reached a node, so it must go back: nothing will ever start (or settle) under that id.
        this.hooks.releaseClaimId(claimId)
        this.hooks.trace?.(`dispatch refused ${candidate.id}: ${decision.code}`)
        // A `capacity-busy` refusal is a DEFERRAL, never a dispatch failure: no budget was charged,
        // no worker started, and the node keeps its place in the queue. Hand it back to the plan (drop
        // this pass's reservation) so the very next iteration re-describes it through the ordinary
        // path — publishing its `waitingFor` and starting its aging clock there — instead of leaving
        // it "spoken for" with nothing shown. The re-plan runs against the LIVE load, which is the
        // same load the refusal just read, so it cannot select the node again in a loop.
        if (decision.code === 'capacity-busy') reserved.delete(candidate.id)
        continue
      }
      dispatched += 1
      void this.hooks
        .startWorker({ node: decision.value.node, claimId, waitedMs })
        .catch((error: unknown) => {
          // The node stays bound for the stale sweep to reclaim; reporting keeps one bad spawn from stalling the pass without hiding why it failed.
          this.hooks.reportDispatchFailure?.(decision.value.node.id, error)
        })
    }
    this.publishWaiting(planned, planReserved)
    return dispatched
  }

  /**
   * Publish the live `waitingFor` projection for the nodes a pass left behind, and drop entries for
   * nodes that are no longer waiting (dispatched, terminal, or blocked by something outside
   * admission). The map is the ONE place the host reads waiting state from, so it is rebuilt to
   * exactly the deferred set rather than accumulated across passes.
   */
  private publishWaiting(deferred: readonly DeferredCandidate[], _reserved: boolean): void {
    const block = this.memoryFloor()
    this.waiting.clear()
    const live = new Set<string>()
    for (const entry of deferred) {
      live.add(entry.node.id)
      // A machine-wide block overrides the per-node reason: it is why NOTHING can be dispatched.
      this.waiting.set(entry.node.id, block ?? entry.waitingFor)
    }
    // The aging clock describes a node that is STILL waiting; a node that left the queue (done,
    // decomposed, cancelled) must not carry a stale start time into a later re-appearance, or it
    // would reserve the machine instantly on a wait it never actually served.
    for (const id of [...this.capacityWaits.keys()]) if (!live.has(id)) this.capacityWaits.delete(id)
    for (const id of [...this.deferredLogged.keys()]) if (!live.has(id)) this.deferredLogged.delete(id)
    for (const id of [...this.reservedLogged]) if (!live.has(id)) this.reservedLogged.delete(id)
  }

  /**
   * The rate-limited deferral log: one line per node per minute while the capacity gate holds it
   * back. Deliberately not an owner wake and not an `isTroubled` fact — normal queuing is not a
   * problem the owner can act on.
   */
  private reportDeferrals(deferred: readonly DeferredCandidate[], reserved: boolean): void {
    const notify = this.hooks.notifyDeferred
    if (notify === undefined) return
    const now = this.now()
    const load = this.tree.runningLoad()
    for (const entry of deferred) {
      const waiting = entry.waitingFor
      if (waiting.reason !== 'capacity') continue
      const since = this.capacityWaits.get(entry.node.id)
      const last = this.deferredLogged.get(entry.node.id)
      const cpu = waiting.resource !== 'memory'
      const isReserved = reserved && cpu && since !== undefined && now - since >= this.options.capacityWaitMs
      const becomingReserved = isReserved && !this.reservedLogged.has(entry.node.id)
      if (!becomingReserved && last !== undefined && now - last < DEFER_LOG_INTERVAL_MS) continue
      if (isReserved) this.reservedLogged.add(entry.node.id)
      else this.reservedLogged.delete(entry.node.id)
      this.deferredLogged.set(entry.node.id, now)
      notify({
        nodeId: entry.node.id,
        rootId: entry.node.rootId,
        title: entry.node.title,
        waitingFor: waiting,
        needed: cpu ? entry.node.weight : (waiting.needed ?? 0),
        capacity: this.options.capacity,
        running: load.weight,
        waitedMs: cpu && since !== undefined ? Math.max(0, now - since) : 0,
        reserved: isReserved,
      })
    }
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
