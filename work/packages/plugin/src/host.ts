/**
 * The plugin's host service: everything that touches DSH — storage domain, dispatch loop, worker
 * materialization, liveness, spilling, and the pre-step question. Work-tree logic lives in
 * `@avantf/work-core`.
 *
 * @module @avantf/dsh-work/host
 */
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SpillStore } from '@deepseek-ai/dsh-spill'
import { OWNER_TOOL_DENY, WORKER_TOOL_DENY } from './faces.js'
import { isWorkerClaimId, newClaimId } from './claims.js'
import {
  CAPACITY,
  DEFAULT_ENGINE_OPTIONS,
  TERMINAL,
  buildProgressLine,
  buildWorkerPrompt,
  defaultNewId,
  detectConcurrency,
  isTroubled,
  spillPointer,
  statusLabel,
  WorkEngine,
  WorkTree,
  type ChildSpec,
  type MutationResult,
  type NodeRecord,
  type SpilledText,
  type StallReport,
  type TreeRecord,
} from '@avantf/work-core'
import { workDomain, TREES_TABLE } from './domain.js'
import { createLogger, type WorkLogger } from './log.js'
import { NAMESPACE } from './wire.js'
import { createTreeStore, type TreesTable } from './store.js'

/** The child-side face; both tool faces live in one place, `./faces.js`. */
export { WORKER_TOOL_DENY } from './faces.js'

const WORKER_PROVIDER = 'spawn'

/** Delegated work unit, not a top-level session: `origin` names the session kind and
 *  `delegationDepth` its distance from the root; either one is enough. */
function isSubagentSession(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

const SWEEP_INTERVAL_MS = 60_000

/** How long a durable owner-existence answer is trusted; a deleted session's trees retire within this window. */
const OWNER_CHECK_TTL_MS = 5 * 60_000

/** Whether the tree owner should be allowed into a proposed step. */
export interface AdmitDecision {
  readonly admit: boolean
  readonly reason: string
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
  readonly context: readonly string[]
  readonly status: string
  readonly attempts: number
  readonly createdAt: number
  readonly hasResult: boolean
  readonly resultRef: string | null
}

/** One work's full detail, as the expanded row renders it. */
export interface NodeDetail {
  readonly id: string
  readonly rootId: string
  readonly title: string
  readonly description: string
  readonly context: readonly string[]
  /** What this work's executors recorded, oldest first; exposed so an operator reads the judgement a
   *  re-dispatched executor sees (the panel does not render it yet). */
  readonly analysisNotes: readonly string[]
  /** The dispatch (`attempts`) that wrote the last entry; `0` when none. */
  readonly analysisAttempt: number
  readonly status: string
  readonly attempts: number
  readonly depth: number
  /** The submitted conclusion, when there is one (inline; a long one is truncated). */
  readonly result: string | null
  /** Where a spilled full result lives, joined with its retrieval hint. */
  readonly resultPointer: string | null
}

/** One sub-work of a node, with the conclusion it submitted. */
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

/** One tree summarized for the owner-facing tools. */
export interface WorkSummary {
  readonly tree: TreeRecord
  readonly root: NodeRecord | undefined
  readonly counts: Readonly<Record<string, number>>
  /** Whether the owner closed the tree out; its results stay readable. */
  readonly closed: boolean
  /**
   * Whether this work carries a HISTORY of trouble (stalls/failures at the engine's floors). The
   * counters never reset, so it stays true for the work's life — hence the past tense. The one engine
   * state an owner tool surfaces (only one it can act on); per-state `counts` stay for the human-facing
   * surfaces — the `/work` command and the "工作" view.
   */
  readonly troubled: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    avantfWork: AvantfWorkHost
  }
}

export interface HostOptions {
  /** Dispatch ceiling; omitted means "CPU cores minus one". */
  readonly maxConcurrent?: number
  /** How long a worker may be silent before it counts as stuck. */
  readonly staleMs?: number
}

export class AvantfWorkHost extends TypertRemoteService {
  private tree?: WorkTree
  private engine?: WorkEngine
  private domain?: { close(): Promise<void> }
  private sweepDispose?: () => void
  private readonly workerAborts = new Map<string, AbortController>()
  /** Every child session id reserved for a worker, for the process lifetime: answers "is this settling
   *  agent one of ours?" even after the node's binding is gone. */
  private readonly issuedClaims = new Set<string>()
  /** Owner session ids this host has dispatched a worker for (hook scoping). */
  private readonly dispatchedFor = new Set<string>()
  /** Claims bound but not yet accepted by the child. A worker is "live" from reservation: a sweep in
   *  that gap would otherwise reclaim a starting worker and pay for a duplicate run per node. */
  private readonly startingClaims = new Set<string>()
  /**
   * Parked sessions whose WAKE is in flight: live from the adoption that binds them until the resumed
   * agent is observed, the delivery reports a failure, or the engine gives up on the binding.
   *
   * A parked session is IDLE by definition — `decompose_work` ends the executor's turn, which is
   * exactly what "parked" means — so the liveness check alone reads a freshly adopted binding as
   * vanished. The sweep triggered by the LAST CHILD's own `subagent/end` runs in the same moment as
   * the owner's wake, so without this guard it reclaims the binding the wake is delivering into: the
   * cold resume still lands, the old executor burns a whole extra round, and its `submit_work` is
   * refused because the node was already re-dispatched to a fresh claim. Measured in a real run
   * (2026-09-22): 8 wasted minutes, two `not-owner` refusals, and `attempts`/`failures` charged an
   * extra time each — the failures are the dangerous half, because they spend the budget that ends a
   * node.
   */
  private readonly wakingClaims = new Set<string>()
  /** Per-owner change counters and the open `watch` streams waiting on them: how "the tree changed"
   *  reaches the browser without polling or session-log writes. */
  private readonly revisions = new Map<string, number>()
  private readonly waiters = new Map<string, Set<() => void>>()
  /** Recent durable owner-existence answers, so a sweep cannot hammer storage. */
  private readonly ownerChecks = new Map<string, { at: number; exists: boolean }>()
  /** Parked nodes the owner has already been told about. `reportParkedReady` fires on every pump, so
   *  without this the owner's inbox accumulates one wake per pass; an entry is dropped when the node
   *  leaves the parked state, so it never outlives its condition. In-memory on purpose: after a restart
   *  one extra signal is harmless. */
  private readonly parkedSignaled = new Set<string>()

  private readonly log: WorkLogger

  constructor(ctx: Context, options: HostOptions = {}, log?: WorkLogger) {
    // `TypertRemoteService` registers the service under this key AND binds it as a Remote namespace.
    super(ctx, NAMESPACE)
    this.maxConcurrent = options.maxConcurrent
    this.staleMs = options.staleMs
    this.log = log ?? createLogger(ctx.logger)
  }

  private readonly maxConcurrent: number | undefined
  private readonly staleMs: number | undefined
  private ready: Promise<void> = Promise.resolve()

  /** Record the start-up promise for a caller that wants a fully opened tree; the tools never need it,
   *  but a composition or test may. */
  markReady(ready: Promise<void>): void {
    this.ready = ready
  }

  /** Diagnostic sink for dispatch decisions: the host logger is buffered in some compositions, so a
   *  mount test needs an observable channel. Unset means silent. */
  onDispatchTrace?: (message: string) => void

  private trace(message: string): void {
    this.onDispatchTrace?.(message)
  }

  /** Resolve once storage is open, trees are loaded and orphans reconciled. */
  whenReady(): Promise<void> {
    return this.ready
  }

  /** Workers allowed at once: the configured value, or cores minus one (the owner's own turns are not
   *  the only agent here). */
  concurrency(): number {
    if (this.maxConcurrent !== undefined && this.maxConcurrent > 0) return this.maxConcurrent
    return detectConcurrency()
  }

  /** Silent time before the engine calls a worker stuck. The 60 s floor exists because the check rides
   *  a 60-second sweep: a shorter window would interrupt every worker on its first pass. */
  staleWindowMs(): number {
    const configured = this.staleMs
    if (configured === undefined) return DEFAULT_ENGINE_OPTIONS.staleMs
    const floor = 60_000
    if (configured < floor) {
      this.log.warn(`staleMs ${String(configured)} is below the ${String(floor)} ms floor; using the floor`)
      return floor
    }
    return configured
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Open storage, reconcile, and arm the sweep. Runs inside `apply` so an environmental failure fails
   *  the plugin row loudly rather than leaving tools that answer "not ready"; the domain opens exactly
   *  once (`storage-domain` refuses a second open). */
  async start(): Promise<void> {
    // Idempotent: opening the domain twice would fail with `already-open`, the guard against two owners.
    if (this.starting !== undefined) return this.starting
    const starting = this.open().catch((error: unknown) => {
      // A failure on a disposed fiber is teardown noise, not a verdict: `apply` never awaits this
      // promise, so an unhandled rejection becomes dsh's fatal load failure. `open()` guards what it
      // can see; this covers the orderings it cannot.
      if (!this.stillActive()) {
        this.log.warn(`start-up did not finish before unmount; ignored: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      throw error
    })
    this.starting = starting
    return starting
  }

  private starting?: Promise<void>

  private async open(): Promise<void> {
    this.log.info('start-up: opening the work-tree storage domain')
    const opened = await this.ctx.storageDomain.open(workDomain)
    this.domain = opened as unknown as { close(): Promise<void> }
    const table = (opened as unknown as { table(name: string): TreesTable }).table(TREES_TABLE)
    const store = createTreeStore(table)

    // The tree is constructed with its store so every mutation has somewhere to land.
    const tree = new WorkTree(store, {
      isAgentLive: (sessionId) => this.workerLive(sessionId),
      ownerExists: (sessionId) => this.ownerExists(sessionId),
      spill: (text) => this.spillText(text),
      now: () => Date.now(),
      newId: () => defaultNewId(),
    })
    this.tree = tree

    this.engine = new WorkEngine(
      tree,
      {
        reserveClaimId: () => {
          const claimId = newClaimId()
          this.issuedClaims.add(claimId)
          // Bound before it exists: count it live until the child accepts its prompt, or a sweep reclaims it.
          this.startingClaims.add(claimId)
          return claimId
        },
        releaseClaimId: (claimId) => this.releaseUnboundClaim(claimId),
        startWorker: (input) => this.startWorker(input.node, input.claimId),
        interruptWorker: (sessionId) => this.interruptWorker(sessionId),
        notifyOwner: (rootId, reason) => this.notifyOwner(rootId, reason),
        notifyStalled: (info) => this.notifyStalled(info),
        notifyParkedReady: (nodes) => this.notifyParkedReady(nodes),
        reportDispatchFailure: (nodeId, error) => {
          this.trace(`dispatch of ${nodeId} failed: ${String(error)}`)
          this.log.warn(`dispatch of ${nodeId} failed: ${String(error)}`)
        },
        trace: (message) => this.trace(message),
      },
      { maxConcurrent: this.concurrency(), staleMs: this.staleWindowMs() },
    )

    await tree.open()

    // This start-up can still be in flight when the plugin is unmounted. `stop()` runs before
    // `this.domain` is assigned, so it closes nothing; every later `ctx` access on the disposed fiber
    // throws `INACTIVE_EFFECT`, which with no handler becomes the process's fatal load failure — so
    // abort cleanly and close the domain we opened.
    if (!this.stillActive()) {
      this.log.info('start-up: context went inactive mid-open; aborting before reconcile')
      await this.domain?.close().catch(() => undefined)
      this.domain = undefined
      return
    }

    const trees = tree.trees()
    // Rebuilt from the trees, the durable record of ownership: without this, `ownsTrees()` is false for
    // pre-restart owners until they dispatch again, disabling the pre-step gate and the guidance layer.
    for (const entry of trees) this.dispatchedFor.add(entry.ownerSessionId)
    const nodes = trees.reduce((total, entry) => total + tree.nodesOf(entry.rootId).length, 0)
    this.log.info(
      `start-up: loaded ${String(trees.length)} tree(s), ${String(nodes)} node(s)`
      + (trees.length === 0 ? ' (none persisted yet)' : ''),
    )
    const orphans = await this.engine.reconcileOrphans()
    if (orphans.length > 0) {
      this.log.warn(`start-up: destroyed ${String(orphans.length)} tree(s) whose owner session is gone: ${orphans.join(', ')}`)
    }
    // `ctx.interval` is the timer plugin's effect-scoped timer, cancelled when the fiber unloads.
    this.sweepDispose = this.ctx.interval(() => {
      void this.sweep().catch(() => undefined)
    }, SWEEP_INTERVAL_MS)
    this.log.info(
      `engine ready: concurrency=${String(this.concurrency())} depth=${String(CAPACITY.maxDepth)}`
      + ` failure-budget=${String(CAPACITY.maxAttempts)} children<=${String(CAPACITY.maxChildrenPerDecompose)}`,
    )
  }

  /** Whether this plugin's Cordis fiber is still active: Cordis clears `fiber.uid` on disposal, after
   *  which a required-service read throws `INACTIVE_EFFECT`. Reads the FIBER-SCOPED `this.ctx` from
   *  construction; a context without a readable fiber (a test stub) counts as active. */
  private stillActive(): boolean {
    const fiber = (this.ctx as unknown as { fiber?: { uid: number | null } }).fiber
    return fiber === undefined || fiber.uid !== null
  }

  async stop(): Promise<void> {
    this.sweepDispose?.()
    this.sweepDispose = undefined
    // The controller owns only the start; an accepted worker is stopped through `subagents.interrupt`.
    for (const controller of this.workerAborts.values()) {
      controller.abort(new Error('avantf-work: plugin unloading'))
    }
    this.workerAborts.clear()
    this.issuedClaims.clear()
    this.startingClaims.clear()
    this.wakingClaims.clear()
    this.dispatchedFor.clear()
    this.ownerChecks.clear()
    await this.domain?.close().catch(() => undefined)
    this.domain = undefined
  }

  // ── engine driving ───────────────────────────────────────────────────────

  /** Run one dispatch pass. Every trigger funnels here. */
  async pump(): Promise<number> {
    return this.engine === undefined ? 0 : this.engine.pump()
  }

  /** Reclaim vanished bindings, then dispatch. Called on worker lifecycle edges (a `running` node may
   *  have lost its worker without submitting) and by the periodic sweep. */
  async sweep(): Promise<{ reclaimed: number; dispatched: number }> {
    if (this.engine === undefined) return { reclaimed: 0, dispatched: 0 }
    if (this.tree !== undefined) {
      // Progress is in memory between flushes; persist it before this pass judges anyone against it.
      await this.tree.flushProgress()
      await this.engine.reconcileOrphans()
    }
    const result = await this.engine.sweep()
    if (result.reclaimed > 0) {
      this.log.info(`sweep: reclaimed ${String(result.reclaimed)} node(s) whose executor vanished`)
    }
    // A sweep is the engine acting on its own — the one change no session-side signal can carry.
    if (result.reclaimed + result.dispatched > 0) this.announceAllTrees()
    return result
  }

  /** Record one worker's activity if the session is ours. The feed carries every session in the
   *  process, so the claim check comes first; only "making no progress" is a stall. */
  touchWorkerProgress(sessionId: string, at: number): void {
    if (!this.issuedClaims.has(sessionId)) return
    const tree = this.tree
    if (tree === undefined) return
    const node = tree.nodeHeldBy(sessionId)
    if (node !== undefined) tree.touchProgress(node.id, at)
  }

  /** A subagent run ended. For one of our workers this is the earliest moment its node can be judged —
   *  reclaim now, not at the next sweep; the claim check comes first so foreign runs cost nothing. */
  onSubagentEnd(childSessionId: string): void {
    if (!this.isWorkerClaim(childSessionId)) return
    // Settlement and binding are different records; let the sweep resolve liveness instead.
    void this.sweep().catch(() => undefined)
  }

  /**
   * Whether a claim resolves to a worker that is alive, still starting, or being WOKEN. A continuable
   * child materializes asynchronously, and treating that window as "vanished" made a sweep reclaim the
   * starting worker, re-dispatch, and leave the first with every `submit_work` refused — two LLM runs
   * for one attempt. A claim is live from reservation until the child accepts its prompt.
   *
   * The parked case is the same window with a different cause: the session is idle (that is what
   * parking means) while the wake is being delivered, so a claim is live from the adoption until the
   * resumed agent shows up. Seeing the agent ends the guard — it must not outlive the evidence.
   */
  workerLive(sessionId: string): boolean {
    if (this.startingClaims.has(sessionId)) return true
    if (this.ctx.agents.get(SessionId(sessionId)) !== undefined) {
      this.wakingClaims.delete(sessionId)
      return true
    }
    return this.wakingClaims.has(sessionId)
  }

  /**
   * Steer one RUNNING root work: record the correction and, when somebody holds it, hand it over now.
   * The record is durable (a root outlives each dispatch while waiting for children); the live message
   * reaches the executor already running. A finished root has nothing to steer and a non-root is
   * refused — the owner steers what it handed out, not somebody's sub-tree.
   */
  async adjustWork(
    agent: Agent,
    rootId: string,
    adjustment: string,
  ): Promise<MutationResult<{ readonly delivered: boolean; readonly voided: number }>> {
    const tree = this.requireTree()
    const node = tree.node(rootId)
    if (node === undefined) return { ok: false, code: 'not-found', message: `工作 ${rootId} 不存在` }
    if (node.id !== node.rootId) {
      return { ok: false, code: 'not-root', message: `${rootId} 不是根工作；纠偏只发给根工作` }
    }
    const corrected = await tree.correct(rootId, agent.id, adjustment)
    if (!corrected.ok) return corrected
    // Announced because `corrections` is part of the node projection the panel renders.
    this.announceTree(rootId)

    // From the mutation's own result: the earlier snapshot read is not this function's to trust.
    const holder = corrected.value.claimedBy
    let delivered = false
    if (holder !== null && this.workerLive(holder)) {
      try {
        await this.ctx.subagents.sendMessage(
          agent,
          SessionId(holder),
          [{ type: 'text', text: `纠偏：${adjustment}` }],
          // Delivery owns the operation only until the child's inbox accepts it; a fresh signal suffices.
          { signal: new AbortController().signal },
        )
        delivered = true
        this.log.info(`correction on ${rootId} delivered to ${holder}`)
      } catch (error: unknown) {
        // The record is durable; losing the live delivery costs timeliness, never the correction.
        this.log.warn(`correction on ${rootId} could not reach ${holder}: ${String(error)}`)
      }
    } else {
      this.log.info(`correction recorded on ${rootId}; the executor will read it on its next dispatch`)
    }

    // The consequence is the ENGINE's, not a model-facing verb (the reasoning that keeps `reclaim_work`
    // off the tool face): the unfinished sub-works are voided, so the work comes straight back for
    // re-planning with the correction in context. Finished ones keep their results.
    const voided = await this.cancelSubworks(agent, rootId)
    if (!voided.ok && voided.code !== 'nothing-to-cancel') {
      this.log.warn(`correction on ${rootId}: could not void its sub-works — ${voided.message}`)
    }
    return { ok: true, value: { delivered, voided: voided.ok ? voided.value.length : 0 } }
  }

  /**
   * Cancel the sub-tree below one held node. Live holders are captured BEFORE the mutation clears them,
   * or a cancelled worker keeps burning a model call whose `submit_work` can only be refused.
   */
  async cancelSubworks(agent: Agent, nodeId: string): Promise<MutationResult<readonly string[]>> {
    const tree = this.requireTree()
    const node = tree.node(nodeId)
    if (node === undefined) return { ok: false, code: 'not-found', message: `工作 ${nodeId} 不存在` }
    // The owner is carried along: interruption is authorized by the worker's exact direct parent, which the node stops naming once cancelled.
    const owner = tree.treeOf(node.rootId)?.ownerSessionId
    const holders: { worker: string; owner: string }[] = []
    const cancelled = await tree.cancelSubworks(nodeId, agent.id, (worker) => {
      // Collected INSIDE the lock, so a `decompose` landing in between cannot leave a cancelled worker running.
      if (owner !== undefined) holders.push({ worker, owner })
    })
    if (!cancelled.ok) return cancelled
    for (const holder of holders) await this.interruptWorker(holder.worker, holder.owner)
    await this.pump()
    this.announceTree(node.rootId)
    this.log.info(
      `cancel_subworks on ${nodeId} by ${agent.id}: ${String(cancelled.value.length)} node(s) failed, `
      + `${String(holders.length)} executor(s) stopped`,
    )
    return { ok: true, value: cancelled.value.map((entry) => entry.id) }
  }

  /** Whether a session id is a worker this host dispatched (this or a past generation). */
  isWorkerClaim(sessionId: string): boolean {
    // The shape check subsumes a tree scan: every id this plugin binds is minted by `newClaimId()`.
    if (this.issuedClaims.has(sessionId)) return true
    return isWorkerClaimId(sessionId)
  }

  // ── tool-facing API ──────────────────────────────────────────────────────

  async createWork(
    agent: Agent,
    title: string,
    description: string,
    analysis: readonly string[],
  ): Promise<MutationResult<NodeRecord>> {
    const tree = this.requireTree()
    // Only a top-level session roots a tree: a self-rooted work would be an executor nobody dispatches or reclaims.
    if (!this.canCreateTree(agent)) {
      return {
        ok: false,
        code: 'no-authority',
        message: '执行者不能自己建工作；把结果报回你手上那个工作',
      }
    }
    const result = await tree.createRoot({
      ownerSessionId: agent.id,
      title,
      description,
      analysis,
    })
    if (result.ok) {
      this.log.info(`create_work: root ${result.value.id} "${result.value.title}" owned by ${agent.id}`)
      this.engine?.forgetReport(result.value.id)
      await this.pump()
      this.announceTree(result.value.id)
    } else {
      this.log.warn(`create_work refused for ${agent.id}: ${result.code} — ${result.message}`)
    }
    return result
  }

  /** The node is the durable carrier: the writing round is gone by the aggregate pass, which reads the
   *  node's prompt. The write also stamps the `attempts` that `decompose` checks. */
  async recordAnalysis(
    agent: Agent,
    nodeId: string,
    analysis: string,
  ): Promise<MutationResult<NodeRecord>> {
    const recorded = await this.requireTree().recordAnalysis(nodeId, agent.id, analysis)
    if (recorded.ok) {
      this.log.info(
        `note_work: ${nodeId} analysis recorded on attempt ${String(recorded.value.analysisAttempt)}`
        + ` (${String(recorded.value.analysisNotes.length)} note(s) held)`,
      )
      this.announceNode(nodeId)
    } else {
      this.log.warn(`note_work refused on ${nodeId} by ${agent.id}: ${recorded.code} — ${recorded.message}`)
    }
    return recorded
  }

  async decompose(
    agent: Agent,
    nodeId: string,
    children: readonly ChildSpec[],
  ): Promise<MutationResult<{ created: readonly string[]; reused: readonly string[] }>> {
    const result = await this.requireTree().decompose(nodeId, agent.id, children)
    if (result.ok) {
      this.log.info(
        `decompose_work: ${nodeId} -> created [${result.value.created.join(', ')}]`
        + (result.value.reused.length > 0 ? ` reused [${result.value.reused.join(', ')}]` : ''),
      )
      await this.pump()
      this.announceNode(nodeId)
    } else {
      this.log.warn(`decompose_work refused on ${nodeId} by ${agent.id}: ${result.code} — ${result.message}`)
    }
    return result
  }

  async submitResult(
    agent: Agent,
    nodeId: string,
    result: string,
  ): Promise<MutationResult<{ node: NodeRecord; parentReady: boolean }>> {
    const submitted = await this.requireTree().submitResult(nodeId, agent.id, result)
    if (submitted.ok) {
      this.log.info(
        `submit_work: ${nodeId} done (${String(result.length)} chars)`
        + (submitted.value.parentReady ? '; parent now aggregates' : ''),
      )
      // The owner's read is deliberately NOT marked here — that would defeat the finish gate.
      await this.pump()
      this.announceNode(nodeId)
    } else {
      this.log.warn(`submit_work refused on ${nodeId} by ${agent.id}: ${submitted.code} — ${submitted.message}`)
    }
    return submitted
  }

  /** Read a node's result, recording the read so the finish gate can open. */
  async readResult(agent: Agent, nodeId: string): Promise<MutationResult<NodeRecord>> {
    const tree = this.requireTree()
    const node = tree.node(nodeId)
    if (node === undefined) {
      return { ok: false, code: 'not-found', message: `工作 ${nodeId} 不存在` }
    }
    const owner = tree.treeOf(node.rootId)
    if (owner !== undefined && owner.ownerSessionId !== agent.id) {
      return { ok: false, code: 'not-owner', message: '这个工作属于别的会话' }
    }
    if (node.status !== 'done' && node.status !== 'failed') {
      return { ok: false, code: 'not-dispatchable', message: `工作 ${nodeId} 处于 ${statusLabel(node.status)}；还没有结果` }
    }
    await tree.markResultRead(nodeId)
    const refreshed = tree.node(nodeId)
    return refreshed === undefined
      ? { ok: false, code: 'not-found', message: `工作 ${nodeId} 已消失` }
      : { ok: true, value: refreshed }
  }

  /** Trees owned by one session, newest first, with status rollups and closure. */
  listWorks(agent: Agent): readonly WorkSummary[] {
    const tree = this.requireTree()
    return tree
      .trees()
      .filter((entry) => entry.ownerSessionId === agent.id)
      .map((entry) => {
        const nodes = tree.nodesOf(entry.rootId)
        const counts: Record<string, number> = {}
        for (const node of nodes) counts[node.status] = (counts[node.status] ?? 0) + 1
        return {
          tree: entry,
          root: nodes.find((node) => node.id === entry.rootId),
          counts,
          closed: entry.closedAt !== null,
          troubled: isTroubled(nodes),
        }
      })
      .reverse()
  }

  async finishWork(agent: Agent, rootId: string): Promise<MutationResult<NodeRecord>> {
    const result = await this.requireTree().finish(rootId, agent.id)
    if (result.ok) {
      this.log.info(`finish_work: tree ${rootId} archived by ${agent.id}`)
      this.announceTree(rootId)
    } else {
      this.log.warn(`finish_work refused on ${rootId} by ${agent.id}: ${result.code} — ${result.message}`)
    }
    return result
  }

  async cancelWork(agent: Agent, rootId: string): Promise<MutationResult<readonly NodeRecord[]>> {
    const tree = this.requireTree()
    // Ownership BEFORE any side effect: interrupting executors is observable and irreversible, so a
    // refused call must not have touched anybody's worker (`cancelTree` re-checks, too late).
    const owner = tree.treeOf(rootId)
    if (owner === undefined) return { ok: false, code: 'not-found', message: `工作 ${rootId} 不存在` }
    if (owner.ownerSessionId !== agent.id) {
      this.log.warn(`cancel_work refused on ${rootId}: caller ${agent.id} is not the tree owner`)
      return { ok: false, code: 'not-owner', message: '只有创建这个工作的会话才能取消' }
    }
    const holders: string[] = []
    const result = await tree.cancelTree(rootId, agent.id, (worker) => { holders.push(worker) })
    // Pass the owner explicitly: `cancelTree` cleared every `claimedBy` inside the lock, so a
    // `findHolderTree` lookup would be empty and the real `subagents.interrupt` skipped.
    for (const worker of holders) await this.interruptWorker(worker, owner.ownerSessionId)
    if (result.ok) {
      // "requested", not "stopped": `interruptWorker` contains its own delivery failure, so this reports
      // what was attempted rather than a stop that may not have happened.
      this.log.info(`cancel_work: tree ${rootId} cancelled by ${agent.id} (interrupt requested for ${String(holders.length)} executor(s))`)
      this.announceTree(rootId)
    } else {
      this.log.warn(`cancel_work refused on ${rootId} by ${agent.id}: ${result.code} — ${result.message}`)
    }
    return result
  }

  // ── pre-step decision ────────────────────────────────────────────────────

  /**
   * Whether a proposed step should reach the model. The wake carries only a signal, so this decides on
   * STATE: a tree this session owns must have something actionable. Otherwise the step is refused,
   * which also discards the trigger message.
   */
  admitStep(agent: Agent): AdmitDecision {
    const tree = this.tree
    if (tree === undefined) return { admit: false, reason: 'work tree not started' }
    const owned = tree
      .trees()
      .filter((entry) => entry.ownerSessionId === agent.id && entry.closedAt === null)
    if (owned.length === 0) return { admit: false, reason: 'no open tree owned by this session' }
    for (const entry of owned) {
      const actionable = tree
        .nodesOf(entry.rootId)
        .filter((node) => node.status === 'ready' || node.status === 'interrupted' || node.status === 'done' || node.status === 'failed')
      if (actionable.length > 0) {
        return { admit: true, reason: `${actionable.length} actionable node(s) in tree ${entry.rootId}` }
      }
    }
    return { admit: false, reason: 'trees owned but nothing actionable' }
  }

  /** Whether this plugin's wake/notice filtering applies: a session that owns a tree (closed included —
   *  its worker may still settle) or one this host dispatched for. */
  ownsTrees(agent: Agent): boolean {
    if (this.dispatchedFor.has(agent.id)) return true
    return this.tree?.trees().some((entry) => entry.ownerSessionId === agent.id) ?? false
  }

  /** Whether this agent may root a tree. One predicate for the tool's authority check and the prompt
   *  section that teaches it: a session that cannot root must not be told how. */
  canCreateTree(agent: Agent): boolean {
    return !isSubagentSession(agent)
  }

  /**
   * The guidance text for one owner, or `''` when it has nothing open. Closed trees are left out: their
   * conclusions live in `work_result`, and re-stating a finished tree is the snapshot churn the anchored
   * wording avoids. Granularity matches `list_works`: running count plus trouble history, nothing deeper.
   */
  guidanceFor(agent: Agent): string {
    const tree = this.tree
    if (tree === undefined) return ''
    const owned = tree
      .trees()
      .filter((entry) => entry.ownerSessionId === agent.id && entry.closedAt === null)
    if (owned.length === 0) return ''
    let ongoing = 0
    let troubled = false
    const roots: NodeRecord[] = []
    for (const entry of owned) {
      const nodes = tree.nodesOf(entry.rootId)
      // The one fact the owner can act on; how often, and where, stays in the engine.
      if (isTroubled(nodes)) troubled = true
      const root = nodes.find((node) => node.id === entry.rootId)
      if (root === undefined) continue
      roots.push(root)
      if (!TERMINAL.has(root.status)) ongoing += 1
    }
    return buildProgressLine({ roots, ongoing, troubled })
  }

  /**
   * Everything the "工作" view renders for one session: one Remote method, so the client makes one call.
   * The session id IS a parameter because a Remote invocation carries no caller identity; the trust
   * model is "the local UI asks for the session it is showing", in the user's own host process.
   */
  @Remote('snapshot')
  snapshot(args: { sessionId?: string }): Promise<{ trees: readonly TreeView[] }> {
    return Promise.resolve({ trees: this.treesForSession(args.sessionId) })
  }

  /** One node's full detail: a second read rather than more snapshot, since results run to 2 KB and the
   *  summary is re-read on every change. Children's results feed an aggregate's conclusion. */
  @Remote('detail')
  detail(args: { sessionId?: string; nodeId: string }): Promise<{
    node?: NodeDetail
    children: readonly NodeDetailChild[]
    error?: string
  }> {
    return Promise.resolve(this.detailOf(args.sessionId, args.nodeId))
  }

  /** The detail read itself, kept synchronous so a test can call it directly. */
  detailOf(sessionId: string | undefined, nodeId: string): {
    node?: NodeDetail
    children: readonly NodeDetailChild[]
    error?: string
  } {
    const tree = this.tree
    if (tree === undefined) return { children: [], error: '工作引擎尚未启动' }
    const node = tree.node(nodeId)
    if (node === undefined) return { children: [], error: `工作 ${nodeId} 不存在` }
    const owner = tree.treeOf(node.rootId)
    if (sessionId === undefined || owner === undefined || owner.ownerSessionId !== sessionId) {
      return { children: [], error: '这个工作属于别的会话' }
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
        analysisNotes: node.analysisNotes,
        analysisAttempt: node.analysisAttempt,
        status: node.status,
        attempts: node.attempts,
        depth: node.depth,
        result: node.result,
        resultPointer: node.resultRef === null ? null : spillPointer(node),
      },
      children,
    }
  }

  /** Delete one WHOLE tree — the panel's "remove this work" (the argument is a root id; a node is not an
   *  addressable target). `finish_work` is the other ending and keeps the record (archived). */
  @Remote('delete')
  async delete(args: { sessionId?: string; rootId: string }): Promise<{ deleted: readonly string[]; error?: string }> {
    const tree = this.tree
    if (tree === undefined) return { deleted: [], error: '工作引擎尚未启动' }
    const record = tree.treeOf(args.rootId)
    if (record === undefined) return { deleted: [], error: `工作 ${args.rootId} 不存在` }
    if (args.sessionId === undefined || record.ownerSessionId !== args.sessionId) {
      this.log.warn(`delete refused on ${args.rootId}: caller ${String(args.sessionId)} is not the tree owner`)
      return { deleted: [], error: '这个工作属于别的会话' }
    }
    const result = await tree.deleteTree(args.rootId)
    if (!result.ok) {
      this.log.warn(`delete refused on ${args.rootId}: ${result.code} — ${result.message}`)
      return { deleted: [], error: result.message }
    }
    this.log.info(
      `delete: removed tree ${args.rootId} with ${String(result.value.length)} node(s)`,
    )
    // By owner, not root id: the tree is gone from the store, so a root lookup would find nothing.
    this.announceOwner(record.ownerSessionId)
    return { deleted: result.value }
  }

  @Remote({ mode: 'stream' })
  async *watch(args: { sessionId?: string }, signal: AbortSignal): AsyncGenerator<{ revision: number }> {
    const owner = args.sessionId
    if (owner === undefined || owner === '') return
    // The opening frame is contract: it tells the panel the stream is live, so a silent stream can be replaced by the timer fallback.
    let seen = -1
    while (!signal.aborted) {
      const revision = this.revisions.get(owner) ?? 0
      if (revision !== seen) {
        seen = revision
        yield { revision }
      }
      await this.nextChange(owner, signal)
    }
  }

  /** Publish one change to every open stream of an owner. In-memory on purpose: a lost revision costs a
   *  re-read, never correctness — nothing but the tree is authoritative. */
  private announceOwner(ownerSessionId: string): void {
    this.revisions.set(ownerSessionId, (this.revisions.get(ownerSessionId) ?? 0) + 1)
    const waiting = this.waiters.get(ownerSessionId)
    if (waiting === undefined) return
    for (const wake of [...waiting]) wake()
  }

  /** Publish a change for one tree, by its root id. */
  private announceTree(rootId: string): void {
    const owner = this.tree?.treeOf(rootId)?.ownerSessionId
    if (owner !== undefined) this.announceOwner(owner)
  }

  /** Publish a change for every tree the engine may have moved. */
  private announceAllTrees(): void {
    for (const tree of this.tree?.trees() ?? []) this.announceTree(tree.rootId)
  }

  /** Publish a change for the tree that holds one node. */
  private announceNode(nodeId: string): void {
    const rootId = this.tree?.node(nodeId)?.rootId
    if (rootId !== undefined) this.announceTree(rootId)
  }

  /** Resolve on the next change for one owner, or as soon as the caller aborts. */
  private nextChange(ownerSessionId: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiting = this.waiters.get(ownerSessionId) ?? new Set<() => void>()
      const wake = (): void => {
        waiting.delete(wake)
        signal.removeEventListener('abort', wake)
        resolve()
      }
      waiting.add(wake)
      this.waiters.set(ownerSessionId, waiting)
      signal.addEventListener('abort', wake, { once: true })
    })
  }

  /** Trees one session owns, flattened the way the view renders them. */
  treesForSession(sessionId: string | undefined): readonly TreeView[] {
    if (sessionId === undefined || sessionId === '') return []
    const tree = this.tree
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
          context: node.context,
          status: node.status,
          attempts: node.attempts,
          createdAt: node.createdAt,
          hasResult: node.hasResult,
          resultRef: node.resultRef,
        })),
      }))
      .reverse()
  }

  /** Rollup of every tree this session owns, for diagnostics and tests. */
  summary(agent: Agent): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const work of this.listWorks(agent)) {
      for (const [status, count] of Object.entries(work.counts)) {
        counts[status] = (counts[status] ?? 0) + count
      }
    }
    return counts
  }

  /** Snapshot for the `/work` command. */
  describe(agent: Agent): string {
    const works = this.listWorks(agent)
    if (works.length === 0) return '本会话没有工作。'
    const lines: string[] = [`共 ${works.length} 个工作：`]
    for (const work of works) {
      const counts = Object.entries(work.counts)
        .map(([status, count]) => `${count} ${statusLabel(status)}`)
        .join('，')
      const closed = work.closed ? ' [已归档]' : ''
      lines.push(
        `- [${work.tree.rootId}] ${work.root?.title ?? '（根工作缺失）'} — ${statusLabel(work.root?.status)}${closed}（${counts}）`,
      )
    }
    return lines.join('\n')
  }

  // ── internals ────────────────────────────────────────────────────────────

  private requireTree(): WorkTree {
    if (this.tree === undefined) throw new Error('avantf-work: 工作引擎尚未启动')
    return this.tree
  }

  /**
   * What every exit of one start attempt must leave behind. A claim left in `startingClaims` reports its
   * node live forever — a ghost holds a concurrency slot until the stall window — so both maps are
   * cleared from every exit through this one definition.
   */
  private endStartAttempt(claimId: string): void {
    this.workerAborts.delete(claimId)
    this.startingClaims.delete(claimId)
  }

  /**
   * Hand back a claim reserved for a dispatch that was then REFUSED: it was never bound to a node and
   * no child was ever created for it, so it must neither stay "live" (a ghost in `startingClaims`
   * reports its lane occupied) nor stay remembered as one of ours — nothing will ever settle under it.
   */
  private releaseUnboundClaim(claimId: string): void {
    this.endStartAttempt(claimId)
    this.issuedClaims.delete(claimId)
  }

  /** The parked-session address on one node, or `null`; exposed for tests proving a wake did NOT consume it. */
  parkedWorkerOf(nodeId: string): string | null | undefined {
    return this.tree?.node(nodeId)?.parkedWorker
  }

  /** Test seam: the real code clears an entry only when the node leaves the parked state, so a test
   *  driving ONE `notifyParkedReady` batch must remove its own setup's entries. */
  forgetParkedSignals(): void {
    this.parkedSignaled.clear()
  }

  /** Test seam: how many claim ids are remembered and how many count as live-but-still-starting. A
   *  dispatch that was REFUSED must add to neither — otherwise the reservation leaks one per refusal. */
  claimCounts(): { issued: number; starting: number } {
    return { issued: this.issuedClaims.size, starting: this.startingClaims.size }
  }

  /** The parked-and-ready nodes of one tree (test seam; the engine uses the tree's own query). */
  parkedReadyNodesOf(rootId: string): readonly NodeRecord[] {
    return this.tree?.parkedReadyNodes(rootId) ?? []
  }

  /** One node's durable record as stored; for tests proving a wake charged NO budget. */
  nodeFor(nodeId: string): NodeRecord | undefined {
    return this.tree?.node(nodeId)
  }
  /**
   * Report the parked nodes whose children have all landed as ONE owner signal. Batched on purpose: an
   * owner returning offline can find several ready at once, and one wake per node would be a storm.
   * Delivery is per owner and state-based, so a pass with nothing to act on is dropped by the pre-step
   * gate at zero model cost.
   */
  notifyParkedReady(nodes: readonly NodeRecord[]): void {
    const tree = this.tree
    if (tree === undefined) return
    // Prune anything no longer parked, so a later park of the same node reports again.
    const stillParked = new Set(nodes.map((node) => node.id))
    for (const id of [...this.parkedSignaled]) if (!stillParked.has(id)) this.parkedSignaled.delete(id)

    // Group by OWNER, not by batch: a message must never describe another session's work, and one
    // owner's delivery must not mark another owner's nodes as "told" forever.
    const byOwner = new Map<string, NodeRecord[]>()
    for (const node of nodes) {
      if (this.parkedSignaled.has(node.id)) continue
      const ownerSessionId = tree.treeOf(node.rootId)?.ownerSessionId
      if (ownerSessionId === undefined) continue
      const group = byOwner.get(ownerSessionId)
      if (group === undefined) byOwner.set(ownerSessionId, [node])
      else group.push(node)
    }

    for (const group of byOwner.values()) {
      const first = group[0]
      const rootId = first?.rootId
      if (first === undefined || rootId === undefined) continue
      const summary = group.length === 1
        ? `工作 ${first.id}（"${first.title}"）`
        : `${String(group.length)} 个工作`
      const delivered = this.deliverToOwner(
        rootId,
        `${summary}的子工作都已终态，引擎将唤醒它的执行者继续判断。`,
        `parked-ready on ${rootId} reported to the owner`,
      )
      // Marked only on delivery, so an offline owner is told when it comes back.
      if (!delivered) continue
      for (const node of group) this.parkedSignaled.add(node.id)
    }
  }

  /**
   * Wake every parked session whose children have landed. Called from the owner's pre-step, and only
   * there: that turn is the one place the owner is guaranteed materialized, and the only Agent the
   * continuation protocol accepts as the authorizing parent (`authorizeLineage`).
   *
   * Order per node is fixed: ADOPT (bind `claimedBy`) before delivering — a woken session can call
   * `submit_work` immediately, which authorizes on `claimedBy === caller`. A failed delivery gets no
   * retry: undo the adoption (`wake-failed`, charging neither failure counter, no cooldown) and
   * dispatch fresh; `attempts` advances, being the `note_work` generation marker, not a budget.
   */
  async wakeParkedWorkers(agent?: Agent): Promise<number> {
    const tree = this.tree
    if (tree === undefined) return 0
    let woken = 0
    for (const node of tree.parkedReadyNodes()) {
      // A step may only start work for trees its session owns: otherwise any owner's step could wake
      // another owner's parked worker. The leak is one of reach, and a tree is visible only to its owner.
      if (agent !== undefined && tree.treeOf(node.rootId)?.ownerSessionId !== agent.id) continue
      const workerId = node.parkedWorker
      if (workerId === null) continue
      // Nothing can be woken without the owner, so bail out BEFORE adoption: adopting then failing to
      // deliver would consume the address and turn "the owner is away" into "start a fresh session".
      if (this.ctx.agents.get(SessionId(tree.treeOf(node.rootId)?.ownerSessionId ?? '')) === undefined) {
        continue
      }
      // The node is about to be owned by an IDLE session, so it must count as live BEFORE the adoption
      // lands: the sweep that the last child's own `subagent/end` triggers runs concurrently with this
      // loop, and `heldByLiveWorkers` cannot see an idle parked session (see `workerLive`).
      this.wakingClaims.add(workerId)
      let handedOff = false
      try {
        const adopted = await tree.adoptParked(node.id, workerId)
        if (!adopted.ok) {
          this.trace(`wake refused ${node.id}: ${adopted.code}`)
          continue
        }
        this.parkedSignaled.delete(node.id)
        if (await this.wakeParkedWorker(adopted.value.node, workerId)) {
          woken += 1
          // The guard stays until `workerLive` observes the resumed agent: the delivery resolving is
          // not the same event as the agent being registered, and the sweep may land in between.
          handedOff = true
          this.dispatchedFor.add(tree.treeOf(node.rootId)?.ownerSessionId ?? '')
          this.announceTree(node.rootId)
          continue
        }
        // Delivery failed: give the node back. A fresh claim is reserved here so a cleaned-up session
        // costs one round trip, not one pass.
        await tree.reclaim(node.id, 'wake-failed').catch(() => undefined)
        const claimId = newClaimId()
        this.issuedClaims.add(claimId)
        this.startingClaims.add(claimId)
        const dispatched = await tree.dispatch(node.id, claimId)
        if (!dispatched.ok) {
          this.endStartAttempt(claimId)
          continue
        }
        void this.startWorker(dispatched.value.node, claimId).catch((error: unknown) => {
          this.log.warn(`dispatch of ${node.id} failed: ${String(error)}`)
        })
      } finally {
        // Every exit but a successful hand-off drops the guard here. A successful one is kept until the
        // agent is observed (or the engine gives up on the binding and interrupts it) — dropping it on
        // the delivery's own resolution would reopen exactly the window it exists to close.
        if (!handedOff) this.wakingClaims.delete(workerId)
      }
    }
    return woken
  }

  /** Deliver the ordinary dispatch prompt, read fresh: a sibling result may have arrived since the
   *  children landed. `@returns` whether delivery was accepted (false means "start a fresh one"). */
  private async wakeParkedWorker(node: NodeRecord, workerId: string): Promise<boolean> {
    const tree = this.requireTree()
    const owned = tree.treeOf(node.rootId)
    if (owned === undefined) return false
    // The worker's recorded direct parent is the tree owner, and `authorizeLineage` accepts nobody else.
    const parent = this.ctx.agents.get(SessionId(owned.ownerSessionId))
    if (parent === undefined) {
      this.log.info(`owner ${owned.ownerSessionId} is not live; ${node.id} cannot be woken`)
      return false
    }
    const view = tree.view(node.id)
    if (view === undefined) return false
    try {
      await this.ctx.subagents.sendMessage(
        parent,
        SessionId(workerId),
        [{ type: 'text', text: buildWorkerPrompt(view) }],
        { signal: new AbortController().signal },
      )
      this.log.info(`woke ${workerId} for ${node.id} (its children are all terminal)`)
      return true
    } catch (error: unknown) {
      // A cleaned-up session or one the runtime refuses to resume: no retry and no failure counter is
      // touched — `note_work` carries the hand-off, so a fresh session is a complete answer.
      this.log.warn(`wake of ${workerId} for ${node.id} failed; starting a fresh executor: ${String(error)}`)
      return false
    }
  }

  private async startWorker(node: NodeRecord, claimId: string): Promise<void> {
    const tree = this.requireTree()
    const owned = tree.treeOf(node.rootId)
    if (owned === undefined) {
      this.trace(`no tree for node ${node.id}; skipping dispatch`)
      this.endStartAttempt(claimId)
      return
    }
    const parent = this.ctx.agents.get(SessionId(owned.ownerSessionId))
    this.trace(`startWorker ${node.id} owner=${owned.ownerSessionId} parent=${parent === undefined ? 'missing' : 'ok'}`)
    if (parent === undefined) {
      // Owner gone: the node stays bound and orphan reconciliation removes the tree next sweep.
      this.log.info(`owner ${owned.ownerSessionId} is not live; ${node.id} stays bound`)
      this.endStartAttempt(claimId)
      return
    }
    // Built now, not at dispatch time: a sibling result may have landed in between.
    const view = tree.view(node.id)
    if (view === undefined) {
      this.trace(`node ${node.id} vanished before dispatch`)
      this.endStartAttempt(claimId)
      return
    }
    const prompt = buildWorkerPrompt(view)
    this.dispatchedFor.add(owned.ownerSessionId)

    const controller = new AbortController()
    this.workerAborts.set(claimId, controller)
    try {
      await this.startChild(node.id, claimId, parent, prompt, this.deniableFor(parent), controller.signal)
      // The worker materialized: clear any earlier spawn-failure streak.
      tree.noteSpawnSuccess(node.id)
      this.log.info(`dispatched ${node.id} as ${claimId}`)
      this.announceTree(node.rootId)
    } catch (error) {
      this.log.warn(`dispatch of ${node.id} failed: ${String(error)}`)
      // Charged to `spawnFailures`, not the work's `failures` budget: the node never got a worker. The
      // reclaim also starts the cooldown that holds it out of the next few pumps.
      await tree.reclaim(node.id, 'spawn-failed').catch(() => undefined)
    } finally {
      this.endStartAttempt(claimId)
    }
  }

  /**
   * Start one child, dropping tool names the runtime refuses to restrict. The runtime's answer is
   * authoritative and the pre-check cannot be exact: a child inherits its parent's PRESET composition,
   * not the parent agent's own scope, so a name the parent can see may still fail the whole filter for
   * the child. Dropping it loses isolation, which beats a tree that cannot dispatch at all.
   */
  private async startChild(
    nodeId: string,
    claimId: string,
    parent: Agent,
    prompt: string,
    deny: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    const start = (names: readonly string[]): Promise<unknown> =>
      this.ctx.subagents.startContinuable({
        provider: WORKER_PROVIDER,
        label: `work ${nodeId}`,
        childId: SessionId(claimId),
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent,
          // An empty deny list would be a materialized-empty mistake: omit it.
          ...names.length === 0 ? {} : { toolFilter: { deny: [...names] } },
        },
        signal,
      })

    try {
      await start(deny)
    } catch (error) {
      const refused = refusedToolNames(error, deny)
      if (refused.length === 0) throw error
      const kept = deny.filter((name) => !refused.includes(name))
      this.log.warn(
        `tool filter cannot name ${refused.join(', ')} for a worker; dispatching ${nodeId} without ${kept.length === deny.length ? 'a filter' : 'them'}`,
      )
      await start(kept)
    }
  }

  /**
   * The subset of one face's names this deployment offers. `toolFilter` (and `restrict()`) THROWS on a
   * name no tool provides, so a hardcoded list would fail every dispatch in a composition without (say)
   * the goal tools. Names a child cannot inherit are caught by the retry in `startChild`.
   */
  private deniableFor(parent: Agent, names: readonly string[] = WORKER_TOOL_DENY): string[] {
    const tools = this.ctx.get('tools')
    if (tools === undefined) return []
    return names.filter((name) => tools.get(name, parent) !== undefined)
  }

  /** The owner-side face: executor-only tools, filtered to the names this deployment offers
   *  (`restrict()` throws, and one throw would cost the owner its whole turn). */
  ownerFaceFor(agent: Agent): readonly string[] {
    return this.deniableFor(agent, OWNER_TOOL_DENY)
  }

  private async interruptWorker(sessionId: string, ownerSessionId?: string): Promise<void> {
    // The engine is giving up on this binding (stalled or cancelled), so a wake guard outliving it
    // would be a ghost that keeps answering "live" for an id no node holds.
    this.wakingClaims.delete(sessionId)
    this.workerAborts.get(sessionId)?.abort(new Error('avantf-work: worker reclaimed'))
    this.workerAborts.delete(sessionId)
    // Interruption is authorized by the exact direct parent, so the owning session is the credential;
    // recover it from the tree unless the caller knows it (a cancelled node no longer names its worker).
    const holder = ownerSessionId ?? this.findHolderTree(sessionId)
    if (holder === undefined) return
    try {
      this.ctx.subagents.interrupt(SessionId(sessionId), {
        kind: 'user',
        parentSessionId: SessionId(holder),
      })
    } catch {
      // An already-gone worker needs no interruption.
    }
  }

  /** The owner session of the tree that holds a given worker, if any. */
  private findHolderTree(workerSessionId: string): string | undefined {
    const tree = this.tree
    if (tree === undefined) return undefined
    for (const owned of tree.trees()) {
      for (const node of tree.nodesOf(owned.rootId)) {
        if (node.claimedBy === workerSessionId) return owned.ownerSessionId
      }
    }
    return undefined
  }

  /** Wake the owner: the message carries a signal only, the guidance layer supplying the content. */
  private notifyOwner(rootId: string, reason: string): void {
    this.deliverToOwner(
      rootId,
      `工作 ${rootId} 已结束（${statusLabel(reason)}）。`,
      `root ${rootId} reached ${reason}`,
    )
  }

  /** Tell the owner that one node keeps going silent. A heads-up, not a request: the engine has already
   *  interrupted the worker and re-queued the work. */
  private notifyStalled(info: StallReport): void {
    const minutes = Math.max(1, Math.round(info.silentMs / 60_000))
    // Quote the FAILURE budget, not the dispatch count: `attempts` also rises on rounds that succeed,
    // so "第 N 次派发（上限 5）" could read "第 7 次…上限 5" on a node that is converging fine.
    const left = Math.max(CAPACITY.maxAttempts - info.failures, 0)
    const budget = left === 0
      ? `失败预算已用尽（${String(CAPACITY.maxAttempts)} 次），本次再没有结果即判失败`
      : `已失败 ${String(info.failures)} 次，再失败 ${String(left)} 次即判失败（上限 ${String(CAPACITY.maxAttempts)}）`
    this.deliverToOwner(
      info.rootId,
      `工作 ${info.nodeId}（"${info.title}"）已有 ${String(minutes)} 分钟没有进展，执行者已被中断、`
      + `工作已重新入队（第 ${String(info.attempts + 1)} 次派发）—— ${budget}。`,
      `stall on ${info.nodeId} reported to the owner`,
    )
  }

  private deliverToOwner(rootId: string, text: string, why: string): boolean {
    const tree = this.tree
    if (tree === undefined) return false
    const owned = tree.treeOf(rootId)
    if (owned === undefined) return false
    const owner = this.ctx.agents.get(SessionId(owned.ownerSessionId))
    if (owner === undefined) {
      // Owner not materialized now; the state stays on the tree and the guidance reports it next run.
      this.log.warn(`${why}, but owner ${owned.ownerSessionId} is not live; message deferred`)
      return false
    }
    owner.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'avantf-work' },
      }),
    )
    this.log.info(`${why}; woke owner ${owned.ownerSessionId}`)
    return true
  }

  /** Persist an over-long result and hand back its locator WITH the backend's retrieval guidance: a
   *  locator alone leaves the reader unable to fetch the text. No backend returns `null`. */
  private async spillText(text: string): Promise<SpilledText | null> {
    const store = this.ctx.get('spillStore') as SpillStore | undefined
    if (store === undefined) return null
    const ref = await store.saveText({
      owner: { sessionId: SessionId('avantf-work') },
      source: {
        kind: 'tool',
        toolName: 'submit_result',
        callId: ToolCallId(defaultNewId()),
        label: 'full-result',
      },
      suggestedName: 'work-result.txt',
      content: text,
    })
    return { locator: String(ref.locator), hint: ref.retrievalHint }
  }

  /**
   * Whether the tree's owner still exists, by the fact of its session. The agent registry is the wrong
   * question: agents are materialized on demand, so right after a restart every owner is absent from it
   * while its session data is intact — treating that as "gone" would destroy every tree. `sessionQuery`
   * answers the durable question instead, live-preferred; every uncertain outcome resolves to "exists".
   */
  private async ownerExists(sessionId: string): Promise<boolean> {
    // A live agent's session obviously exists — the common case, no persistence read.
    if (this.ctx.agents.get(SessionId(sessionId)) !== undefined) return true

    const cached = this.ownerChecks.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < OWNER_CHECK_TTL_MS) return cached.exists

    const exists = await this.probeOwner(sessionId)
    this.ownerChecks.set(sessionId, { at: Date.now(), exists })
    return exists
  }

  /** Ask durable storage whether the session exists; every uncertain outcome resolves to `true` (a stray
   *  tree is recoverable, destroyed work is not). */
  private async probeOwner(sessionId: string): Promise<boolean> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      // No durable reader mounted: nothing can tell "deleted" from "not opened yet", so keep the trees;
      // the cost is a tree that never dispatches, not one that gets destroyed.
      return true
    }
    try {
      const observation = await query.observeSession(SessionId(sessionId), { projectionMode: 'none' })
      observation[Symbol.dispose]()
      return true
    } catch (error) {
      if (isSessionNotFound(error)) return false
      this.log.warn(`cannot resolve session ${sessionId} (${String(error)}); keeping its trees`)
      return true
    }
  }
}

/** Whether an error is session-query's "this session does not exist anywhere". */
function isSessionNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'SESSION_QUERY_SESSION_NOT_FOUND'
}

/** The names a failed child start refused. Only names this plugin asked to deny are returned, so
 *  unrelated quoted text in the failure message cannot silently strip the filter. */
function refusedToolNames(error: unknown, deny: readonly string[]): readonly string[] {
  const message = String(error)
  // Either phrase identifies the refusal; a wrapper that rephrases one still keeps the other.
  if (!message.includes('tools.restrict()') && !message.includes('unknown global tool')) return []
  const named = [...message.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? '')
  return named.filter((name) => deny.includes(name))
}

export type { NodeRecord, TreeRecord }
