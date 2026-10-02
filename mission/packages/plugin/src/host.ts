/**
 * The plugin's host service: everything that touches DSH — storage domain, dispatch loop, worker
 * materialization, liveness, spilling, and the pre-step question. Work-tree logic lives in
 * `@avantf/mission-core`.
 *
 * @module @avantf/dsh-mission/host
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
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
  LOCAL_WELL_FORMED,
  TERMINAL,
  buildProgressLine,
  buildWorkerPrompt,
  defaultNewId,
  detectConcurrency,
  isMaterialChange,
  isTroubled,
  spillPointer,
  statusLabel,
  MissionEngine,
  MissionTree,
  type ChildSpec,
  type ContinuationDelta,
  type DispatchView,
  type HungReport,
  type MutationResult,
  type NodeRecord,
  type OrphanedTree,
  type OwnerProbe,
  type ResumeOutcome,
  type ResumeWorkerInput,
  type SpilledText,
  type StallReport,
  type TreeRecord,
  type WellFormedSource,
} from '@avantf/mission-core'
import { workDomain, TREES_TABLE } from './domain.js'
import { createLogger, type MissionLogger } from './log.js'
import { NAMESPACE, SNAPSHOT_WIRE_VERSION } from './wire.js'
import { OWN_WAKE_SOURCE_KIND } from './source.js'
import { createTreeStore, type TreesTable } from './store.js'

/** The child-side face; both tool faces live in one place, `./faces.js`. */
export { WORKER_TOOL_DENY } from './faces.js'

const WORKER_PROVIDER = 'spawn'

/** Delegated mission unit, not a top-level session: `origin` names the session kind and
 *  `delegationDepth` its distance from the root; either one is enough. */
function isSubagentSession(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
}

const SWEEP_INTERVAL_MS = 60_000

/** How often a background sweep that keeps failing may say so: the first failure always speaks, then
 *  at most one line per window carrying the count it folded in. A 60 s interval against a full disk
 *  would otherwise be 1440 identical lines a day. */
const SWEEP_FAILURE_WARN_MS = 10 * 60_000

/** How long a durable owner-existence answer is trusted; a deleted session's trees retire within this window. */
const OWNER_CHECK_TTL_MS = 5 * 60_000

/** Floor for the configured round ceiling (`roundMs`). Ten minutes is already far past the size of
 *  any step a mission is meant to run in one round, so a smaller value can only be a mistake; the
 *  floor and the warning are what turn that mistake into a bounded one, exactly as `staleWindowMs`
 *  does for `staleMs`. */
const ROUND_FLOOR_MS = 10 * 60_000

/** Whether the tree owner should be allowed into a proposed step. */
export interface AdmitDecision {
  readonly admit: boolean
  readonly reason: string
}

/**
 * The worker session CURRENTLY bound to a node, as an address a reader may open — the one field the
 * panel's "jump to the executor" link needs.
 *
 * Only a real binding counts: `null` when the node is not bound (never dispatched, reclaimed,
 * failed), and `null` for a blank string too. It is never the node id dressed up as a session id.
 * A reclaimed node's PREVIOUS session (`lastWorkerId`) is deliberately NOT exposed here: it may no
 * longer exist, and a link a reader can press that answers "no such session" is worse than no link.
 */
function workerSessionIdOf(node: NodeRecord): string | null {
  return node.claimedBy === null || node.claimedBy === '' ? null : node.claimedBy
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
  /** The owner's corrections, newest last. Carried in the ROW projection (unlike `description` and
   *  the submitted result) because a row has to say the mission was steered: `title` is frozen at
   *  creation, so a corrected mission otherwise reads as "goal X, result of Y" with nothing between
   *  them to explain the difference. The texts are few and short, and a row renders only the count. */
  readonly corrections: readonly string[]
  readonly status: string
  readonly attempts: number
  readonly createdAt: number
  readonly hasResult: boolean
  readonly resultRef: string | null
  /** The session executing this node right now, or `null` when none is bound (see `workerSessionIdOf`). */
  readonly workerSessionId: string | null
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
  /** The submitted conclusion, when there is one (inline; a long one is truncated). */
  readonly result: string | null
  /** Where a spilled full result lives, joined with its retrieval hint. */
  readonly resultPointer: string | null
  /** The session executing this node right now, or `null` when none is bound (see `workerSessionIdOf`). */
  readonly workerSessionId: string | null
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

/** One tree summarized for the owner-facing tools. */
export interface MissionSummary {
  readonly tree: TreeRecord
  readonly root: NodeRecord | undefined
  readonly counts: Readonly<Record<string, number>>
  /** Whether the owner closed the tree out; its results stay readable. */
  readonly closed: boolean
  /**
   * Whether this mission carries a HISTORY of trouble (stalls/failures at the engine's floors). The
   * counters never reset, so it stays true for the mission's life — hence the past tense. The one engine
   * state an owner tool surfaces (only one it can act on); per-state `counts` stay for the human-facing
   * surfaces — the `/mission` command and the "任务" view.
   */
  readonly troubled: boolean
}

/** One orphaned tree as `/clean orphans` renders it: the durable record, the probe that says why,
 *  and the root's status. `unobservable` is the operator's business; `missing` is already cleaned
 *  by the next reconciliation and is listed only so the count adds up. */
export interface OrphanTreeReport {
  readonly rootId: string
  readonly ownerSessionId: string
  readonly createdAt: number
  readonly closedAt: number | null
  /** The root mission's status at read time, so a closed-but-orphaned tree reads differently. */
  readonly rootStatus: string
  readonly probe: OwnerProbe
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    avantfMission: AvantfMissionHost
  }
}

export interface HostOptions {
  /** Dispatch ceiling; omitted means "CPU cores minus one". */
  readonly maxConcurrent?: number
  /** How long a worker may produce nothing before it counts as stuck. */
  readonly staleMs?: number
  /** Wall-clock ceiling on one dispatch round, however much it keeps reporting; omitted means one hour. */
  readonly roundMs?: number
}

export class AvantfMissionHost extends TypertRemoteService {
  private tree?: MissionTree
  private engine?: MissionEngine
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
   * Sessions whose WAKE is in flight: live from the adoption that binds them until the resumed
   * agent is observed, the delivery reports a failure, or the engine gives up on the binding.
   *
   * Two wakes use this one guard, for the same reason — the target session is IDLE, so the liveness
   * check alone reads a freshly adopted binding as vanished:
   *
   * - a PARKED session (it decomposed and ended its turn, which is exactly what "parked" means);
   * - a session recorded in `lastWorkerId` that a restart demoted (`cold wake`).
   *
   * The sweep triggered by the LAST CHILD's own `subagent/end` runs in the same moment as the
   * owner's wake, so without this guard it reclaims the binding the wake is delivering into: the
   * cold resume still lands, the old executor burns a whole extra round, and its `submit_mission` is
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
  /** Recent durable owner-probe answers, so a sweep cannot hammer storage. `unobservable` is cached
   *  like any other verdict for the TTL; a delete re-probes fresh rather than trusting it. */
  private readonly ownerChecks = new Map<string, { at: number; probe: OwnerProbe }>()
  /** The orphan set the last aggregate report described, so a sweep that changes nothing is silent.
   *  Missing trees are absent from it: reconciliation destroys them in the same pass that reports. */
  private orphanReportSignature: string | undefined
  /** Parked nodes the owner has already been told about. `reportParkedReady` fires on every pump, so
   *  without this the owner's inbox accumulates one wake per pass; an entry is dropped when the node
   *  leaves the parked state, so it never outlives its condition. In-memory on purpose: after a restart
   *  one extra signal is harmless. */
  private readonly parkedSignaled = new Set<string>()
  /** Sweep failures fold into the next warning; `undefined` means none has been logged yet. */
  private sweepFailureWarnedAt: number | undefined
  private sweepFailuresSinceWarn = 0

  private readonly log: MissionLogger

  /**
   * @param wellFormed - the family's well-formed repair, resolved by `apply()` from the loaded base
   * kit (`resolveWellFormed(compat?.kit)`) and defaulted to the core's local copy. It is threaded to
   * the three boundaries this host owns — the tree's inbound funnel (via `TreeDeps.wellFormed`), the
   * worker prompt and the progress line (via `buildWorkerPrompt`'s third argument), and the model
   * tool results (read by `defineWorkTools`) — so one resolution decides all of them.
   */
  constructor(
    ctx: Context,
    options: HostOptions = {},
    log?: MissionLogger,
    wellFormed: WellFormedSource = LOCAL_WELL_FORMED,
  ) {
    // `TypertRemoteService` registers the service under this key AND binds it as a Remote namespace.
    super(ctx, NAMESPACE)
    this.maxConcurrent = options.maxConcurrent
    this.staleMs = options.staleMs
    this.roundMs = options.roundMs
    this.wellFormed = wellFormed
    this.log = log ?? createLogger(ctx.logger)
  }

  /** The repair pair every model-visible boundary of this host uses; see the constructor. */
  readonly wellFormed: WellFormedSource

  private readonly maxConcurrent: number | undefined
  private readonly staleMs: number | undefined
  private readonly roundMs: number | undefined
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

  /** Wall-clock ceiling on one dispatch round. Deliberately generous, and floored like `staleMs`:
   *  it is the backstop for a worker that keeps being HEARD FROM (retries, route snapshots) while
   *  producing nothing, so a small configured value must not interrupt a round that is merely slow.
   *
   *  The floor is `max(10 min, staleMs)`, not a bare constant: a round cap BELOW the output window
   *  would fire before `stalled` ever can, which would quietly retire the rule that a repeatedly
   *  silent node runs out of failure budget. Tying it to the window the caller actually configured
   *  keeps that rule true for every configuration, not just the defaults. `staleMs` is passed in so
   *  the two windows are resolved from ONE reading (and one warning) during open. */
  roundWindowMs(staleMs: number = this.staleWindowMs()): number {
    const floor = Math.max(ROUND_FLOOR_MS, staleMs)
    const configured = this.roundMs
    if (configured === undefined) return Math.max(DEFAULT_ENGINE_OPTIONS.roundMs, floor)
    if (configured < floor) {
      this.log.warn(`roundMs ${String(configured)} is below the ${String(floor)} ms floor; using the floor`)
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
    this.log.info('start-up: opening the mission-tree storage domain')
    const opened = await this.ctx.storageDomain.open(workDomain)
    this.domain = opened as unknown as { close(): Promise<void> }
    const table = (opened as unknown as { table(name: string): TreesTable }).table(TREES_TABLE)
    const store = createTreeStore(table)

    // The tree is constructed with its store so every mutation has somewhere to land.
    const tree = new MissionTree(store, {
      isAgentLive: (sessionId) => this.workerLive(sessionId),
      probeOwner: (sessionId) => this.ownerProbe(sessionId),
      spill: (text) => this.spillText(text),
      now: () => Date.now(),
      newId: () => defaultNewId(),
      // The inbound funnel takes the same repair the outbound boundaries do, so text entering the
      // tree and text leaving it can never disagree about what "well-formed" means.
      wellFormed: this.wellFormed,
    })
    this.tree = tree

    // Resolve both windows from ONE reading, so a below-floor `staleMs` warns once and the round
    // cap is derived from the value the engine will actually use.
    const staleMs = this.staleWindowMs()
    this.engine = new MissionEngine(
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
        resumeWorker: (input) => this.resumeWorker(input),
        interruptWorker: (sessionId) => this.interruptWorker(sessionId),
        notifyOwner: (rootId, reason) => this.notifyOwner(rootId, reason),
        notifyStalled: (info) => this.notifyStalled(info),
        notifyHung: (info) => this.reportHung(info),
        notifyParkedReady: (nodes) => this.notifyParkedReady(nodes),
        reportDispatchFailure: (nodeId, error) => {
          this.trace(`dispatch of ${nodeId} failed: ${String(error)}`)
          this.log.warn(`dispatch of ${nodeId} failed: ${String(error)}`)
        },
        trace: (message) => this.trace(message),
      },
      { maxConcurrent: this.concurrency(), staleMs, roundMs: this.roundWindowMs(staleMs) },
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
    await this.reconcileOrphans()
    // `ctx.interval` is the timer plugin's effect-scoped timer, cancelled when the fiber unloads.
    this.sweepDispose = this.ctx.interval(() => {
      void this.sweep().catch((error: unknown) => { this.reportSweepFailure(error) })
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
      controller.abort(new Error('avantf-mission: plugin unloading'))
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
      await this.reconcileOrphans()
    }
    const result = await this.engine.sweep()
    if (result.reclaimed > 0) {
      this.log.info(`sweep: reclaimed ${String(result.reclaimed)} node(s) whose executor vanished`)
    }
    // A sweep is the engine acting on its own — the one change no session-side signal can carry.
    if (result.reclaimed + result.dispatched > 0) this.announceAllTrees()
    return result
  }

  /**
   * Report a background sweep that threw. The chain the two fire-and-forget callers start is not
   * cosmetic: it flushes progress (a durable write), probes storage for orphans and then reclaims
   * and dispatches. Silently swallowing it hid a store that refuses `put` (a full disk, a domain
   * gone) failing once a minute with zero evidence. Rate-limited, because the same condition
   * repeats on every 60 s tick: the first failure speaks, later ones fold into one line per window.
   */
  private reportSweepFailure(error: unknown): void {
    this.sweepFailuresSinceWarn += 1
    const now = Date.now()
    if (this.sweepFailureWarnedAt !== undefined && now - this.sweepFailureWarnedAt < SWEEP_FAILURE_WARN_MS) {
      return
    }
    const folded = this.sweepFailuresSinceWarn
    this.sweepFailureWarnedAt = now
    this.sweepFailuresSinceWarn = 0
    const detail = error instanceof Error ? error.message : String(error)
    this.log.warn(
      `sweep failed${folded > 1 ? ` (${String(folded)} failures since the last report)` : ''}: ${detail}`,
    )
  }

  // ── orphans: what the engine destroys, and what only a person may ────────

  /** Every tree whose owner session did not resolve to `exists`, with the probe that says why.
   *  `fresh` bypasses the probe cache: a listing a person acts on must not be up to five minutes
   *  stale about whether a session came back. The startup/sweep path keeps the cache, because it
   *  asks the same question about the same trees every sixty seconds. */
  async orphanTreeReports(options: { fresh?: boolean } = {}): Promise<readonly OrphanTreeReport[]> {
    const tree = this.tree
    if (tree === undefined) return []
    const orphans: readonly OrphanedTree[] = options.fresh === true
      ? await this.probeEveryTreeFresh()
      : await tree.orphanedTrees()
    return orphans.map((entry) => this.orphanReportOf(entry))
  }

  /** Re-probe ONE tree's owner from durable storage, ignoring the cache: the check a delete must
   *  make, so a session that came back between the listing and the delete keeps its tree.
   *  `undefined` means the tree is gone (already destroyed, or an id that never named one). */
  async probeOrphanTree(rootId: string): Promise<OrphanTreeReport | undefined> {
    const tree = this.tree
    if (tree === undefined) return undefined
    const record = tree.treeOf(rootId)
    if (record === undefined) return undefined
    const probe = await this.ownerProbe(record.ownerSessionId, { fresh: true })
    return this.orphanReportOf({ tree: record, probe })
  }

  /** Destroy one orphan tree: stop the workers it still holds, then remove it through the store.
   *  Refuses nothing — the caller has already re-probed the owner and may only reach here for a
   *  tree whose owner is missing or unobservable. */
  async destroyOrphanTree(rootId: string): Promise<boolean> {
    const tree = this.tree
    if (tree === undefined) return false
    const record = tree.treeOf(rootId)
    if (record === undefined) return false
    for (const node of tree.heldByLiveWorkers(rootId)) {
      if (node.claimedBy !== null) await this.interruptWorker(node.claimedBy, record.ownerSessionId)
    }
    await tree.destroyTree(rootId)
    this.announceOwner(record.ownerSessionId)
    return true
  }

  /** Destroy the trees of owners that are PROVEN gone, and report the orphan set as one line.
   *  Returns the destroyed root ids (the shape the engine's reconcile has always had). */
  private async reconcileOrphans(): Promise<readonly string[]> {
    if (this.engine === undefined || this.tree === undefined) return []
    // Probed BEFORE the destruction: the missing trees are gone afterwards, and the operator is owed
    // both counts. The engine re-probes inside its own call, which the cache answers for free.
    const before = await this.orphanTreeReports()
    const destroyed = await this.engine.reconcileOrphans()
    this.reportOrphans(before, destroyed)
    return destroyed
  }

  /** The orphan set, probed one tree at a time with the cache bypassed. */
  private async probeEveryTreeFresh(): Promise<readonly OrphanedTree[]> {
    const tree = this.tree
    if (tree === undefined) return []
    const orphaned: OrphanedTree[] = []
    for (const record of tree.trees()) {
      const probe = await this.ownerProbe(record.ownerSessionId, { fresh: true })
      if (probe.kind !== 'exists') orphaned.push({ tree: record, probe })
    }
    return orphaned
  }

  private orphanReportOf(entry: OrphanedTree): OrphanTreeReport {
    const root = this.tree?.node(entry.tree.rootId)
    return {
      rootId: entry.tree.rootId,
      ownerSessionId: entry.tree.ownerSessionId,
      createdAt: entry.tree.createdAt,
      closedAt: entry.tree.closedAt,
      rootStatus: root?.status ?? 'missing',
      probe: entry.probe,
    }
  }

  /** ONE line per distinct orphan set — never one per tree. The per-tree WARN this replaces was the
   *  noise the user saw on every start: twelve old trees, twelve lines, for one host-side condition.
   *  WARN when somebody has to decide (`unobservable`); INFO when reconciliation already cleaned up. */
  private reportOrphans(orphans: readonly OrphanTreeReport[], destroyed: readonly string[]): void {
    if (orphans.length === 0) {
      this.orphanReportSignature = undefined
      return
    }
    const unobservable = orphans.filter((entry) => entry.probe.kind === 'unobservable')
    const missing = orphans.length - unobservable.length
    // What the set will look like once reconciliation has destroyed the missing ones; comparing
    // against that keeps the next sweep silent instead of re-announcing the same survivors.
    const after = `0:${unobservable.map((entry) => entry.rootId).sort().join(',')}`
    if (after === this.orphanReportSignature) return
    this.orphanReportSignature = after
    const parts = [
      unobservable.length > 0 ? `unobservable tree(s): ${idList(unobservable.map((entry) => entry.rootId))}` : '',
      destroyed.length > 0 ? `destroyed ${String(destroyed.length)} tree(s) whose owner session is gone: ${idList(destroyed)}` : '',
    ].filter((part) => part !== '')
    const line = `orphans: ${String(orphans.length)} tree(s) belong to sessions that cannot be observed `
      + `(unobservable: ${String(unobservable.length)}, missing: ${String(missing)}); run /clean orphans`
    if (unobservable.length > 0) this.log.warn(`${line} — ${parts.join('; ')}`)
    else this.log.info(`${line} — ${parts.join('; ')}`)
  }

  /** Record one worker's activity if the session is ours. The feed carries every session in the
   *  process, so the claim check comes first; only "making no progress" is a stall.
   *
   *  The check is `isWorkerClaim`, NOT membership in `issuedClaims`: that set is in-memory and is
   *  never refilled from the durable tree at start-up, while `MissionTree.reconcileOnOpen` explicitly
   *  keeps a hot-reload survivor `running` and resets its clocks. A worker that survived the
   *  reload therefore had every later progress event dropped, and after `staleMs` was interrupted and
   *  reclaimed as stalled — burning one attempt and a `failures` slot on a worker that was working.
   *  `nodeHeldBy` below still requires an actual binding, so the shape check cannot touch a stranger.
   *
   *  `output` is the CLASSIFICATION the caller made (see `workerEvents.ts`): every event is recorded
   *  as life (`touchActivity`), but only real output moves the clock the stale check reads. That
   *  split is what turns "the worker is still answering retries" from evidence of progress into what
   *  it is — a worker the engine should reclaim as `hung`. */
  touchWorkerProgress(sessionId: string, at: number, output: boolean): void {
    if (!this.isWorkerClaim(sessionId)) return
    const tree = this.tree
    if (tree === undefined) return
    const node = tree.nodeHeldBy(sessionId)
    if (node === undefined) return
    if (output) tree.touchProgress(node.id, at)
    else tree.touchActivity(node.id, at)
  }

  /** A subagent run ended. For one of our workers this is the earliest moment its node can be judged —
   *  reclaim now, not at the next sweep; the claim check comes first so foreign runs cost nothing. */
  onSubagentEnd(childSessionId: string): void {
    if (!this.isWorkerClaim(childSessionId)) return
    // Settlement and binding are different records; let the sweep resolve liveness instead. A
    // failure here is reported rather than swallowed: see `reportSweepFailure`.
    void this.sweep().catch((error: unknown) => { this.reportSweepFailure(error) })
  }

  /**
   * Whether a claim resolves to a worker that is alive, still starting, or being WOKEN. A continuable
   * child materializes asynchronously, and treating that window as "vanished" made a sweep reclaim the
   * starting worker, re-dispatch, and leave the first with every `submit_mission` refused — two LLM runs
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
   * Steer one RUNNING root mission: record the correction and, when somebody holds it, hand it over now.
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
    if (node === undefined) return { ok: false, code: 'not-found', message: `任务 ${rootId} 不存在` }
    if (node.id !== node.rootId) {
      return { ok: false, code: 'not-root', message: `${rootId} 不是根任务；纠偏只发给根任务` }
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
        // Durable delivery watermark: that executor has now READ this correction, so a later cold
        // wake of the same session must not argue it a second time. Advanced only after the
        // delivery was ACCEPTED — a failed or skipped delivery leaves every correction pending,
        // which is also the reading a fresh executor needs (it has seen none of them).
        await tree
          .markCorrectionsDelivered(rootId, corrected.value.corrections.length)
          .catch((error: unknown) => {
            // The correction itself is already durable; the watermark only sharpens a later wake.
            this.log.warn(`correction on ${rootId}: could not record its delivery mark — ${String(error)}`)
          })
      } catch (error: unknown) {
        // The record is durable; losing the live delivery costs timeliness, never the correction.
        this.log.warn(`correction on ${rootId} could not reach ${holder}: ${String(error)}`)
      }
    } else {
      this.log.info(`correction recorded on ${rootId}; the executor will read it on its next dispatch`)
    }

    // The consequence is the ENGINE's, not a model-facing verb (the reasoning that keeps `reclaim_work`
    // off the tool face): the unfinished sub-missions are voided, so the mission comes straight back for
    // re-planning with the correction in context. Finished ones keep their results.
    const voided = await this.cancelSubworks(agent, rootId)
    if (!voided.ok && voided.code !== 'nothing-to-cancel') {
      this.log.warn(`correction on ${rootId}: could not void its sub-missions — ${voided.message}`)
    }
    return { ok: true, value: { delivered, voided: voided.ok ? voided.value.length : 0 } }
  }

  /**
   * Cancel the sub-tree below one held node. Live holders are captured BEFORE the mutation clears them,
   * or a cancelled worker keeps burning a model call whose `submit_mission` can only be refused.
   */
  async cancelSubworks(agent: Agent, nodeId: string): Promise<MutationResult<readonly string[]>> {
    const tree = this.requireTree()
    const node = tree.node(nodeId)
    if (node === undefined) return { ok: false, code: 'not-found', message: `任务 ${nodeId} 不存在` }
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

  /** Root a new mission. `unit` is the scope the mission will modify (a directory or file), or
   *  `undefined`/blank for none: a tree whose root declares a scope serializes every one of its
   *  executors against any other `running` mission declaring the same scope, across trees. */
  async createWork(
    agent: Agent,
    title: string,
    description: string,
    analysis: readonly string[],
    unit?: string | null,
  ): Promise<MutationResult<NodeRecord>> {
    const tree = this.requireTree()
    // Only a top-level session roots a tree: a self-rooted mission would be an executor nobody dispatches or reclaims.
    if (!this.canCreateTree(agent)) {
      return {
        ok: false,
        code: 'no-authority',
        message: '执行者不能自己建任务；把结果报回你手上那个任务',
      }
    }
    const result = await tree.createRoot({
      ownerSessionId: agent.id,
      title,
      description,
      analysis,
      unit: unit ?? null,
    })
    if (result.ok) {
      this.log.info(`create_mission: root ${result.value.id} "${result.value.title}" owned by ${agent.id}`)
      this.engine?.forgetReport(result.value.id)
      await this.pump()
      this.announceTree(result.value.id)
    } else {
      this.log.warn(`create_mission refused for ${agent.id}: ${result.code} — ${result.message}`)
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
        `note_mission: ${nodeId} analysis recorded on attempt ${String(recorded.value.analysisAttempt)}`
        + ` (${String(recorded.value.analysisNotes.length)} note(s) held)`,
      )
      this.announceNode(nodeId)
    } else {
      this.log.warn(`note_mission refused on ${nodeId} by ${agent.id}: ${recorded.code} — ${recorded.message}`)
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
        `decompose_mission: ${nodeId} -> created [${result.value.created.join(', ')}]`
        + (result.value.reused.length > 0 ? ` reused [${result.value.reused.join(', ')}]` : ''),
      )
      await this.pump()
      this.announceNode(nodeId)
    } else {
      this.log.warn(`decompose_mission refused on ${nodeId} by ${agent.id}: ${result.code} — ${result.message}`)
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
        `submit_mission: ${nodeId} done (${String(result.length)} chars)`
        + (submitted.value.parentReady ? '; parent now aggregates' : ''),
      )
      // The owner's read is deliberately NOT marked here — that would defeat the finish gate.
      await this.pump()
      this.announceNode(nodeId)
    } else {
      this.log.warn(`submit_mission refused on ${nodeId} by ${agent.id}: ${submitted.code} — ${submitted.message}`)
    }
    return submitted
  }

  /** Read a node's result, recording the read so the finish gate can open. */
  async readResult(agent: Agent, nodeId: string): Promise<MutationResult<NodeRecord>> {
    const tree = this.requireTree()
    const node = tree.node(nodeId)
    if (node === undefined) {
      return { ok: false, code: 'not-found', message: `任务 ${nodeId} 不存在` }
    }
    const owner = tree.treeOf(node.rootId)
    if (owner !== undefined && owner.ownerSessionId !== agent.id) {
      return { ok: false, code: 'not-owner', message: '这个任务属于别的会话' }
    }
    if (node.status !== 'done' && node.status !== 'failed') {
      return { ok: false, code: 'not-dispatchable', message: `任务 ${nodeId} 处于 ${statusLabel(node.status)}；还没有结果` }
    }
    await tree.markResultRead(nodeId)
    const refreshed = tree.node(nodeId)
    return refreshed === undefined
      ? { ok: false, code: 'not-found', message: `任务 ${nodeId} 已消失` }
      : { ok: true, value: refreshed }
  }

  /** Trees owned by one session, newest first, with status rollups and closure. */
  listWorks(agent: Agent): readonly MissionSummary[] {
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
    const tree = this.requireTree()
    // The same two checks `adjust_mission` makes, in the same order: "this node is not a root" is not
    // "no such mission", and a child id reported as 不存在 sends the owner hunting for a typo that is
    // not there. What was wrong was only the message — `tree.finish` looks the ROOT up by id, so a
    // child fell through to `not-found`.
    const node = tree.node(rootId)
    if (node === undefined) return { ok: false, code: 'not-found', message: `任务 ${rootId} 不存在` }
    if (node.id !== node.rootId) {
      return { ok: false, code: 'not-root', message: `${rootId} 不是根任务；收尾只对根任务` }
    }
    const result = await tree.finish(rootId, agent.id)
    if (result.ok) {
      this.log.info(`finish_mission: tree ${rootId} archived by ${agent.id}`)
      this.announceTree(rootId)
    } else {
      this.log.warn(`finish_mission refused on ${rootId} by ${agent.id}: ${result.code} — ${result.message}`)
    }
    return result
  }

  async cancelWork(agent: Agent, rootId: string): Promise<MutationResult<readonly NodeRecord[]>> {
    const tree = this.requireTree()
    // Ownership BEFORE any side effect: interrupting executors is observable and irreversible, so a
    // refused call must not have touched anybody's worker (`cancelTree` re-checks, too late).
    // Existence and root-ness first, for the same reason `finish_mission` does it: `treeOf` is keyed by
    // ROOT id, so a child id used to come back as 「任务 X 不存在」 about a node that plainly exists.
    const node = tree.node(rootId)
    if (node === undefined) return { ok: false, code: 'not-found', message: `任务 ${rootId} 不存在` }
    if (node.id !== node.rootId) {
      return { ok: false, code: 'not-root', message: `${rootId} 不是根任务；取消只对根任务` }
    }
    const owner = tree.treeOf(rootId)
    if (owner === undefined) return { ok: false, code: 'not-found', message: `任务 ${rootId} 不存在` }
    if (owner.ownerSessionId !== agent.id) {
      this.log.warn(`cancel_mission refused on ${rootId}: caller ${agent.id} is not the tree owner`)
      return { ok: false, code: 'not-owner', message: '只有创建这个任务的会话才能取消' }
    }
    const holders: string[] = []
    const result = await tree.cancelTree(rootId, agent.id, (worker) => { holders.push(worker) })
    // Pass the owner explicitly: `cancelTree` cleared every `claimedBy` inside the lock, so a
    // `findHolderTree` lookup would be empty and the real `subagents.interrupt` skipped.
    for (const worker of holders) await this.interruptWorker(worker, owner.ownerSessionId)
    if (result.ok) {
      // "requested", not "stopped": `interruptWorker` contains its own delivery failure, so this reports
      // what was attempted rather than a stop that may not have happened.
      this.log.info(`cancel_mission: tree ${rootId} cancelled by ${agent.id} (interrupt requested for ${String(holders.length)} executor(s))`)
      this.announceTree(rootId)
    } else {
      this.log.warn(`cancel_mission refused on ${rootId} by ${agent.id}: ${result.code} — ${result.message}`)
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
    if (tree === undefined) return { admit: false, reason: 'mission tree not started' }
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
   * conclusions live in `mission_result`, and re-stating a finished tree is the snapshot churn the anchored
   * wording avoids. Granularity matches `list_missions`: running count plus trouble history, nothing deeper.
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
    return buildProgressLine({ roots, ongoing, troubled }, this.wellFormed)
  }

  /**
   * Everything the "任务" view renders for one session: one Remote method, so the client makes one call.
   * The session id IS a parameter because a Remote invocation carries no caller identity; the trust
   * model is "the local UI asks for the session it is showing", in the user's own host process.
   *
   * `wire` is the panel's version marker (see `wire.ts`): the client reads it to say "the two halves
   * are out of step" instead of blanking the panel. `trees` keeps its shape, so an older client that
   * has never heard of `wire` simply drops the extra key.
   */
  @Remote('snapshot')
  snapshot(args: { sessionId?: string }): Promise<{ wire: number; trees: readonly TreeView[] }> {
    return Promise.resolve({ wire: SNAPSHOT_WIRE_VERSION, trees: this.treesForSession(args.sessionId) })
  }

  /**
   * One node's FULL result, read back from where an over-long one was spilled. On demand, never part
   * of `detail`: a result that was spilled is spilled because it is big, and `detail` is re-read on
   * every engine change while the dialog is open.
   *
   * The locator is the spill backend's, and the backend's contract says it is OPAQUE — `SpillStore`
   * defines `saveText` and nothing else, on purpose. The one backend in use (`dsh-spill-local`) hands
   * out an absolute path, so that is the case this reads; anything else answers with an error and the
   * pane keeps the locator for a reader that knows the substrate (which is what the locator is FOR).
   */
  @Remote('result')
  async result(args: { sessionId?: string; nodeId: string }): Promise<{ text: string; error?: string }> {
    const tree = this.tree
    if (tree === undefined) return { text: '', error: '任务引擎尚未启动' }
    const node = tree.node(args.nodeId)
    if (node === undefined) return { text: '', error: `任务 ${args.nodeId} 不存在` }
    const owner = tree.treeOf(node.rootId)
    if (args.sessionId === undefined || owner === undefined || owner.ownerSessionId !== args.sessionId) {
      return { text: '', error: '这个任务属于别的会话' }
    }
    // Never spilled: the node IS the whole result.
    if (node.resultRef === null) return { text: node.result ?? '' }
    if (!isAbsolute(node.resultRef)) {
      return { text: '', error: `完整结果不在本机文件系统上（${node.resultRef}），请用这个位置去取` }
    }
    try {
      return { text: await readFile(node.resultRef, 'utf8') }
    } catch (cause: unknown) {
      return { text: '', error: `读取完整结果失败：${cause instanceof Error ? cause.message : String(cause)}` }
    }
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
    if (tree === undefined) return { children: [], error: '任务引擎尚未启动' }
    const node = tree.node(nodeId)
    if (node === undefined) return { children: [], error: `任务 ${nodeId} 不存在` }
    const owner = tree.treeOf(node.rootId)
    if (sessionId === undefined || owner === undefined || owner.ownerSessionId !== sessionId) {
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
        result: node.result,
        resultPointer: node.resultRef === null ? null : spillPointer(node),
        workerSessionId: workerSessionIdOf(node),
      },
      children,
    }
  }

  /** Delete one WHOLE tree — the panel's "remove this mission" (the argument is a root id; a node is not an
   *  addressable target). `finish_mission` is the other ending and keeps the record (archived). */
  @Remote('delete')
  async delete(args: { sessionId?: string; rootId: string }): Promise<{ deleted: readonly string[]; error?: string }> {
    const tree = this.tree
    if (tree === undefined) return { deleted: [], error: '任务引擎尚未启动' }
    const record = tree.treeOf(args.rootId)
    if (record === undefined) return { deleted: [], error: `任务 ${args.rootId} 不存在` }
    if (args.sessionId === undefined || record.ownerSessionId !== args.sessionId) {
      this.log.warn(`delete refused on ${args.rootId}: caller ${String(args.sessionId)} is not the tree owner`)
      return { deleted: [], error: '这个任务属于别的会话' }
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
          corrections: node.corrections,
          status: node.status,
          attempts: node.attempts,
          createdAt: node.createdAt,
          hasResult: node.hasResult,
          resultRef: node.resultRef,
          workerSessionId: workerSessionIdOf(node),
        })),
      }))
      .reverse()
  }

  /** Rollup of every tree this session owns, for diagnostics and tests. */
  summary(agent: Agent): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const mission of this.listWorks(agent)) {
      for (const [status, count] of Object.entries(mission.counts)) {
        counts[status] = (counts[status] ?? 0) + count
      }
    }
    return counts
  }

  /** Snapshot for the `/mission` command. */
  describe(agent: Agent): string {
    const missions = this.listWorks(agent)
    if (missions.length === 0) return '本会话没有任务。'
    const lines: string[] = [`共 ${missions.length} 个任务：`]
    for (const mission of missions) {
      const counts = Object.entries(mission.counts)
        .map(([status, count]) => `${count} ${statusLabel(status)}`)
        .join('，')
      const closed = mission.closed ? ' [已归档]' : ''
      // The correction count, not the texts: this line is an index. What was asked for is read in the
      // panel's detail or through `mission_result`, both of which carry the corrections themselves.
      const correctionCount = mission.root?.corrections.length ?? 0
      const corrected = correctionCount === 0 ? '' : ` ｜ 已纠偏 ${String(correctionCount)} 次`
      lines.push(
        `- [${mission.tree.rootId}] ${mission.root?.title ?? '（根任务缺失）'} — ${statusLabel(mission.root?.status)}${closed}（${counts}）${corrected}`,
      )
    }
    return lines.join('\n')
  }

  // ── internals ────────────────────────────────────────────────────────────

  private requireTree(): MissionTree {
    if (this.tree === undefined) throw new Error('avantf-mission: 任务引擎尚未启动')
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

  /**
   * The drift a cold wake of this node would report right now, or `undefined` when the node is gone.
   * Read-only and cheap: a test (and, later, the panel) can ask what the wake would say without
   * performing one. The DECISION to continue or replace lives in `resumeWorker`, which consults
   * `isMaterialChange` on exactly this value.
   */
  continuationDeltaOf(nodeId: string): ContinuationDelta | undefined {
    return this.tree?.continuationDelta(nodeId)
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

    // Group by OWNER, not by batch: a message must never describe another session's mission, and one
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
        ? `任务 ${first.id}（"${first.title}"）`
        : `${String(group.length)} 个任务`
      const delivered = this.deliverToOwner(
        rootId,
        `${summary}的子任务都已终态，引擎将唤醒它的执行者继续判断。`,
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
   * `submit_mission` immediately, which authorizes on `claimedBy === caller`. A failed delivery gets no
   * retry: undo the adoption (`wake-failed`, charging neither failure counter, no cooldown) and
   * dispatch fresh; `attempts` advances, being the `note_mission` generation marker, not a budget.
   */
  async wakeParkedWorkers(agent?: Agent): Promise<number> {
    const tree = this.tree
    if (tree === undefined) return 0
    let woken = 0
    for (const node of tree.parkedReadyNodes()) {
      // A step may only start mission for trees its session owns: otherwise any owner's step could wake
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
    const prompt = buildWorkerPrompt(view, {}, this.wellFormed)
    try {
      await this.ctx.subagents.sendMessage(
        parent,
        SessionId(workerId),
        [{ type: 'text', text: prompt }],
        { signal: new AbortController().signal },
      )
      // A parked session is a continuation too: the round this prompt opens is what its NEXT cold
      // wake must subtract from, not the dispatch that parked it. Stamped only now that it was read.
      await this.recordBaseline(node.id, workerId)
      this.log.info(`woke ${workerId} for ${node.id} (its children are all terminal)`)
      return true
    } catch (error: unknown) {
      // A cleaned-up session or one the runtime refuses to resume: no retry and no failure counter is
      // touched — `note_mission` carries the hand-off, so a fresh session is a complete answer.
      this.log.warn(`wake of ${workerId} for ${node.id} failed; starting a fresh executor: ${String(error)}`)
      return false
    }
  }

  /**
   * Try to continue a node in the session recorded when an interruption demoted it (`lastWorkerId`)
   * instead of starting a fresh executor — the "cold wake" of a mission that survived a restart.
   * Reached from the engine's dispatch pass, before any claim is reserved; returns whether the node
   * was dispatched by this call, must be left alone, or needs the ordinary fresh path.
   *
   * The delivery rides the seam the parked wake already uses: `ctx.subagents.sendMessage` to a
   * non-resident child goes through `dsh-subagent`'s `materialize` ("create OR resume one child
   * Agent"), which calls `agents.resume({ resumeSessionId: ... })`. That is the same code path for
   * "the residency was released" and "the process restarted and the session is being rebuilt from
   * disk", so there is no second protocol to invent here.
   *
   * Order per node is the parked wake's, for the same reason: GUARD → ADOPT → DELIVER. The guard has
   * to land BEFORE the adoption, because the target session is idle/unmaterialized by definition:
   * `heldByLiveWorkers` cannot see it, so the sweep fired by the previous run's own `subagent/end`
   * would strip the binding mid-delivery while the cold resume still lands — two executors for one
   * node, one wasted round, and `failures` charged for it.
   *
   * Failure is not a failure of the mission: the delivery being refused means "that session is
   * gone or not resumable", and a fresh executor is the complete answer (`note_mission` is the
   * hand-off). So the host undoes its own adoption with `wake-failed` — no budget, no cooldown —
   * and answers `failed`, and the engine immediately takes the ordinary path in the same pass.
   */
  private async resumeWorker(input: ResumeWorkerInput): Promise<ResumeOutcome> {
    const tree = this.requireTree()
    const { node, workerId } = input
    // A delivery for this very session is already in flight. Spawning on top of it is the exact
    // "cold resume lands + a fresh executor starts" double run this answer exists to prevent.
    if (this.wakingClaims.has(workerId)) return 'skip'
    const owned = tree.treeOf(node.rootId)
    if (owned === undefined) return 'skip'
    // The owner is the child's recorded direct parent, and the only sender `authorizeLineage`
    // accepts. Without it nothing can be resumed, so the handle stays on the node and the next pass
    // retries — the same "owner away means this waits" rule the parked wake follows.
    const parent = this.ctx.agents.get(SessionId(owned.ownerSessionId))
    if (parent === undefined) {
      this.log.info(`owner ${owned.ownerSessionId} is not live; ${node.id} cannot be continued yet`)
      return 'skip'
    }

    // MATERIAL DRIFT: the node moved enough that continuing this session would have it reason from
    // a picture we know is out of date (the owner changed the direction, somebody else advanced the
    // node's judgement, or the mission itself was re-defined). The address is SPENT rather than left
    // for the next pass, and the answer is `failed` so the engine's ORDINARY fresh path takes over
    // in this same pass — a fresh executor reads every correction, every note and every child
    // conclusion, so nothing is lost but the session's own history, which is the point.
    //
    // Guard first, and evaluated AFTER the owner check, exactly like the adoption below: without a
    // live owner a `failed` answer would fall through to a spawn that cannot happen, leaving the
    // node bound with no worker for the sweep to charge.
    const drift = tree.continuationDelta(node.id)
    if (drift !== undefined && isMaterialChange(drift)) {
      await tree.abandonContinuation(node.id, workerId).catch((error: unknown) => {
        this.log.warn(`continuation of ${node.id}: could not spend its handle — ${String(error)}`)
      })
      this.trace(`continuation of ${node.id} declined: the mission changed materially since ${workerId} last read it`)
      this.log.info(`not continuing ${node.id} in ${workerId}: the mission changed materially; starting a fresh executor`)
      return 'failed'
    }

    // Live from here on: an idle session reads as "vanished" to the sweep (see `workerLive`).
    this.wakingClaims.add(workerId)
    try {
      const adopted = await tree.adoptContinuation(node.id, workerId)
      if (!adopted.ok) {
        // The handle moved, the node left the dispatchable states, or another pass bound it. None of
        // those is a reason to spawn: whoever moved it owns the node now.
        this.trace(`continuation refused ${node.id}: ${adopted.code}`)
        this.wakingClaims.delete(workerId)
        return 'skip'
      }
      this.dispatchedFor.add(owned.ownerSessionId)
      if (await this.deliverContinuation(adopted.value, workerId, parent)) {
        this.announceTree(node.rootId)
        this.log.info(`continued ${node.id} in ${workerId} (its earlier execution was interrupted)`)
        // The guard stays until `workerLive` observes the resumed agent: the delivery resolving is
        // not the same event as the agent being registered, and the sweep may land in between.
        return 'resumed'
      }
      // The delivery was refused: undo the adoption and hand the node back for the fresh path. The
      // guard goes FIRST — it would otherwise answer "live" for a session nobody holds any more.
      this.wakingClaims.delete(workerId)
      await tree.reclaim(node.id, 'wake-failed').catch(() => undefined)
      return 'failed'
    } catch (error: unknown) {
      // An UNEXPECTED failure (a store that refuses `put`): never let it escape into the dispatch
      // pass, and never leave a binding nobody will deliver into. Either the adoption landed — then
      // undo it — or it did not, in which case the reclaim is refused as a no-op; both leave the
      // node ready for the caller's ordinary fresh path.
      this.wakingClaims.delete(workerId)
      await tree.reclaim(node.id, 'wake-failed').catch(() => undefined)
      this.log.warn(`continuation of ${node.id} failed unexpectedly; starting a fresh executor: ${String(error)}`)
      return 'failed'
    }
  }

  /**
   * Stamp the node with what the prompt that was just ACCEPTED shows the session, so a later cold
   * wake can subtract it (`continuation.ts`). Called at the three places that hand a session its
   * dispatch prompt, and only after the delivery resolved: a prompt the runtime refused was never
   * read, so nothing may claim otherwise — and the bound-but-not-started window (`startingClaims`)
   * must not grow an extra awaited writable step.
   *
   * Tolerant on purpose. This is bookkeeping ABOUT a prompt that already exists, so a refused or
   * failed stamp (the node was reclaimed and re-dispatched in between; the store refused the write)
   * must not fail the delivery. The cost is one conservative wake later: a missing baseline renders
   * "the drift cannot be determined", never "nothing changed".
   */
  private async recordBaseline(nodeId: string, holder: string): Promise<void> {
    try {
      const stamped = await this.requireTree().recordDispatchBaseline(nodeId, holder)
      if (!stamped) {
        this.trace(`no baseline stamped for ${nodeId}: ${holder} no longer holds it`)
      }
    } catch (error: unknown) {
      this.log.warn(`could not record the dispatch baseline for ${nodeId}: ${String(error)}`)
    }
  }

  /**
   * Deliver the continuation prompt to a session that is about to be cold-resumed. The view is the
   * ordinary dispatch view — mission chain, the node's own block, the children's conclusions — with
   * two deliberate differences from a fresh spawn: the node's corrections are reduced to the ones
   * this session has NOT been given yet, and the prompt opens with what changed since that session
   * last read this mission (the delta), so it can tell its own memory from the node's current state.
   *
   * `@returns` whether the delivery was accepted; false means "fall back to a fresh executor".
   */
  private async deliverContinuation(view: DispatchView, workerId: string, parent: Agent): Promise<boolean> {
    const node = view.node
    // Read on the ADOPTED view so the delta, the correction slice and the prompt all describe one
    // and the same node state. A vanished node has no delta and needs none: the adoption already
    // failed and the caller is on its way to the fresh path.
    const drift = this.requireTree().continuationDelta(node.id)
    const undelivered = drift?.corrections ?? node.corrections.slice(node.correctionsDeliveredUpTo)
    const prompt = buildWorkerPrompt(view, {
      resumed: true,
      corrections: undelivered,
      ...(drift === undefined ? {} : { delta: drift }),
    }, this.wellFormed)
    // Stamped with the prompt itself: this session's NEXT wake subtracts from what it is being read
    // here, not from the original dispatch, or the same drift would be reported to it twice. After
    // the delivery resolved — a refused prompt was never read, and the delivery must not carry an
    // extra awaited durable write.
    try {
      await this.ctx.subagents.sendMessage(
        parent,
        SessionId(workerId),
        [{ type: 'text', text: prompt }],
        { signal: new AbortController().signal },
      )
    } catch (error: unknown) {
      // A cleaned-up session or one the runtime refuses to resume: no retry and no failure counter
      // is touched — a fresh session is a complete answer.
      this.log.warn(`continuation of ${node.id} in ${workerId} failed; starting a fresh executor: ${String(error)}`)
      return false
    }
    await this.recordBaseline(node.id, workerId)
    // Those corrections have now been READ by the session they were addressed to. Advancing the
    // durable mark HERE (never when the prompt is merely built) is what keeps a later wake from
    // repeating them; it is monotone, so a raced, older report cannot pull it back.
    await this.requireTree()
      .markCorrectionsDelivered(node.id, node.corrections.length)
      .catch((error: unknown) => {
        this.log.warn(`continuation of ${node.id}: could not record its correction mark — ${String(error)}`)
      })
    return true
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
    const prompt = buildWorkerPrompt(view, {}, this.wellFormed)
    // Stamped only once the child accepts it (below): a prompt the runtime refused was never read.
    this.dispatchedFor.add(owned.ownerSessionId)

    const controller = new AbortController()
    this.workerAborts.set(claimId, controller)
    try {
      await this.startChild(node.id, claimId, parent, prompt, this.deniableFor(parent), controller.signal)
      // The child accepted the prompt: the start is OVER, so the "starting" guard is dropped here
      // rather than in the `finally` below. The baseline write that follows is bookkeeping about a
      // prompt that already exists, and it must not widen the bound-but-not-yet-live window that
      // guard exists to cover.
      this.endStartAttempt(claimId)
      // The worker materialized: clear any earlier spawn-failure streak.
      tree.noteSpawnSuccess(node.id)
      // What this session was shown, so an interruption followed by a cold wake can tell it exactly
      // what changed while it was gone.
      await this.recordBaseline(node.id, claimId)
      this.log.info(`dispatched ${node.id} as ${claimId}`)
      this.announceTree(node.rootId)
    } catch (error) {
      this.log.warn(`dispatch of ${node.id} failed: ${String(error)}`)
      // Charged to `spawnFailures`, not the mission's `failures` budget: the node never got a worker. The
      // reclaim also starts the cooldown that holds it out of the next few pumps.
      const reverted = await tree.reclaim(node.id, 'spawn-failed').catch(() => undefined)
      // A node that cannot even get a worker started is trouble the owner can act on, at the SAME floor
      // `isTroubledNode` reports at (one short of the ceiling that fails it). Without this it was the one
      // trouble `list_missions` flagged that never reached the owner as a message — the stall heads-up
      // cannot see it, because a spawn-failed node is never `running` and its sweep only visits those.
      if (reverted !== undefined && reverted.ok
        && reverted.value.spawnFailures >= CAPACITY.maxAttempts - 1
        // The same durable "told once" marker the stall heads-up uses: one node, one message about it,
        // whichever way it is failing.
        && await tree.claimStallReport(node.id)) {
        this.notifySpawnTrouble(reverted.value)
      }
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
        label: `mission ${nodeId}`,
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
    this.workerAborts.get(sessionId)?.abort(new Error('avantf-mission: worker reclaimed'))
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
      `任务 ${rootId} 已结束（${statusLabel(reason)}）。`,
      `root ${rootId} reached ${reason}`,
    )
  }

  /** Tell the owner that one node cannot get a worker started at all. Same shape as the stall heads-up
   *  — the engine keeps retrying on its own (with a cooldown), so this is information, not a request —
   *  and the same durable marker keeps either kind of trouble to one message per node. */
  private notifySpawnTrouble(node: NodeRecord): void {
    this.deliverToOwner(
      node.rootId,
      `任务 ${node.id}（"${node.title}"）连续 ${String(node.spawnFailures)} 次没能启动执行者，已按退避重试；`
      + `到 ${String(CAPACITY.maxAttempts)} 次仍起不来，这个任务会被判失败。`,
      `failed starts on ${node.id} reported to the owner`,
    )
  }

  /** Tell the owner that one node keeps going silent. A heads-up, not a request: the engine has already
   *  interrupted the worker and re-queued the mission. */
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
      `任务 ${info.nodeId}（"${info.title}"）已有 ${String(minutes)} 分钟没有进展，执行者已被中断、`
      + `任务已重新入队（第 ${String(info.attempts + 1)} 次派发）—— ${budget}。`,
      `stall on ${info.nodeId} reported to the owner`,
    )
  }

  /** Log a `hung` reclaim. The engine recovered on its own and charged nothing, so there is nothing
   *  for the owner to decide and no wake is sent — but the line MUST be there, or a provider that
   *  hangs (or only retries) every dispatch is invisible, which is exactly how W8 stayed unnoticed
   *  for 7.5 hours. */
  private reportHung(info: HungReport): void {
    const ranMin = Math.max(1, Math.round(info.ranMs / 60_000))
    const idleMin = Math.max(1, Math.round(info.idleMs / 60_000))
    const bound = info.bound === 'round'
      ? `round cap ${String(ranMin)} min`
      : `no output for ${String(idleMin)} min`
    this.trace(`hung: ${info.nodeId} reclaimed (${bound})`)
    this.log.warn(
      `hung: worker on ${info.nodeId} ("${info.title}") was alive but unproductive (${bound}, `
      + `attempt ${String(info.attempts)}); interrupted and re-queued without charging the failure budget`,
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
        source: { kind: OWN_WAKE_SOURCE_KIND },
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
      owner: { sessionId: SessionId('avantf-mission') },
      source: {
        kind: 'tool',
        toolName: 'submit_result',
        callId: ToolCallId(defaultNewId()),
        label: 'full-result',
      },
      suggestedName: 'mission-result.txt',
      content: text,
    })
    return { locator: String(ref.locator), hint: ref.retrievalHint }
  }

  /**
   * What durable storage says about the tree's owner, in three states rather than a boolean. The agent
   * registry is the wrong question: agents are materialized on demand, so right after a restart every
   * owner is absent from it while its session data is intact — treating that as "gone" would destroy
   * every tree. `sessionQuery` answers the durable question instead, live-preferred; "cannot tell" stays
   * its own answer (an opaque host is not evidence the owner is gone) and is only ever REPORTED.
   */
  private async ownerProbe(sessionId: string, options: { fresh?: boolean } = {}): Promise<OwnerProbe> {
    // A live agent's session obviously exists — the common case, no persistence read.
    if (this.ctx.agents.get(SessionId(sessionId)) !== undefined) return { kind: 'exists' }

    const cached = this.ownerChecks.get(sessionId)
    if (options.fresh !== true && cached !== undefined && Date.now() - cached.at < OWNER_CHECK_TTL_MS) {
      return cached.probe
    }

    const probe = await this.probeOwnerByStorage(sessionId)
    this.ownerChecks.set(sessionId, { at: Date.now(), probe })
    return probe
  }

  /** Ask durable storage whether the session exists. Only session-query's own "not found" means
   *  `missing`; every other failure is `unobservable`, carrying a one-line reason for the operator —
   *  NO log line here, because one line per tree per probe is exactly the noise the aggregate report
   *  replaced. */
  private async probeOwnerByStorage(sessionId: string): Promise<OwnerProbe> {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) {
      // No durable reader mounted: nothing can tell "deleted" from "not opened yet", so the tree is
      // kept and reported as unobservable rather than destroyed or silently called present.
      return { kind: 'unobservable', detail: 'sessionQuery is not mounted' }
    }
    try {
      const observation = await query.observeSession(SessionId(sessionId), { projectionMode: 'none' })
      observation[Symbol.dispose]()
      return { kind: 'exists' }
    } catch (error) {
      if (isSessionNotFound(error)) return { kind: 'missing' }
      return { kind: 'unobservable', detail: errorSummary(error) }
    }
  }
}

/** A one-line, length-capped reason for an unobservable owner; the aggregate report has one line for
 *  the whole set, so a verbose host error must not become several. */
function errorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const oneLine = raw.replace(/\s+/gu, ' ').trim()
  return oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine
}

/** A comma-joined id list capped for a log line: a hundred orphans must not print a hundred ids. */
function idList(ids: readonly string[], max = 20): string {
  if (ids.length <= max) return ids.join(', ')
  return `${ids.slice(0, max).join(', ')} …(+${String(ids.length - max)})`
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

export type { NodeRecord, TreeRecord, OwnerProbe }
