/**
 * The HOST half of session continuation: waking a session that already knows the mission instead of
 * starting a fresh executor.
 *
 * Two wakes share this file because they share the whole protocol — guard, ADOPT, DELIVER, and a
 * refusal that is never allowed to spawn on top of a live binding:
 *
 * - the PARKED wake — the executor that decomposed a node parked itself on it, and is woken (by the
 *   owner's pre-step, the one turn where the authorizing parent is guaranteed materialized) once
 *   every child is terminal;
 * - the COLD wake — a restart demoted a `running` node and left `lastWorkerId`, so the engine's
 *   dispatch pass first tries to continue that session before reserving a claim for a new one.
 *
 * Why this is its own module rather than four methods on the host: it is a clean, self-contained
 * concern (the core-side `continuation.ts` delta, the `adoptParked`/`adoptContinuation` tree
 * transitions, and this delivery seam are the three halves of one feature), and the host is the
 * plugin's only continuously growing hub. `host.ts` keeps thin delegations and hands in exactly the
 * state below — the same shape `workerSessions.ts` uses for its commands, so "what this needs from
 * the host" is explicit rather than "everything on `this`".
 *
 * The delivery rides `ctx.subagents.sendMessage` to a child that may not be resident: `dsh-subagent`'s
 * `materialize` ("create OR resume one child Agent") calls `agents.resume({ resumeSessionId })`, the
 * same code path for "the residency was released" and "the process restarted and the session is being
 * rebuilt from disk". There is no second protocol here, and no new session API.
 *
 * Host-side state is passed by reference on purpose: the wake guards (`wakingClaims`) and the claim
 * sets are the SAME objects the rest of the host reads, so a wake delivered from here is seen by the
 * sweep exactly as it was before the extraction.
 *
 * @module @avantf/dsh-mission/coldResume
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentSendMessageOptions } from '@deepseek-ai/dsh-subagent'
import {
  buildWorkerPrompt,
  isMaterialChange,
  type DispatchView,
  type MissionEngine,
  type MissionTree,
  type NodeRecord,
  type ResumeOutcome,
  type ResumeWorkerInput,
  type WellFormedSource,
} from '@avantf/mission-core'
import { newClaimId } from './claims.js'
import type { MissionLogger } from './log.js'

/**
 * What the two wakes need from the host. Declared as a narrow port (not `this`) so the module cannot
 * reach into anything else — every member below is read by the moves, and nothing here is a
 * convenience accessor.
 */
export interface ColdResumeDeps {
  /** The tree, or `undefined` before start-up has opened one (the parked wake's early exit). */
  readonly tree: MissionTree | undefined
  /** The tree, throwing when start-up has not opened one (the cold wake's precondition). */
  requireTree(): MissionTree
  /** The engine, read for ONE admission-policy snapshot per parked-wake pass. */
  readonly engine: MissionEngine | undefined
  /** Live agents, by session id: the owner must be materialized before anything can be delivered. */
  readonly agents: { get(id: SessionId): Agent | undefined }
  /** The delivery seam; a non-resident child is materialized (or resumed) by the runtime. */
  readonly subagents: {
    sendMessage(
      sender: Agent,
      targetId: SessionId,
      content: ContentBlock[],
      options: SubagentSendMessageOptions,
    ): Promise<unknown>
  }
  readonly log: MissionLogger
  readonly wellFormed: WellFormedSource
  /** Sessions whose wake is in flight; live from the adoption until the resumed agent is observed. */
  readonly wakingClaims: Set<string>
  /** Parked nodes the owner has already been told about; dropped when the node is actually woken. */
  readonly parkedSignaled: Set<string>
  /** Owner sessions this host has dispatched a worker for (hook scoping). */
  readonly dispatchedFor: Set<string>
  /** Every claim id this process has issued. */
  readonly issuedClaims: Set<string>
  /** Claims bound but not yet accepted by the child. */
  readonly startingClaims: Set<string>
  trace(message: string): void
  /** Publish a change for one tree, by its root id. */
  announceTree(rootId: string): void
  /** Clear the starting guard for a claim whose start attempt is over. */
  endStartAttempt(claimId: string): void
  /** Stamp the prompt a session was just handed; tolerant, and defined on the host (`startWorker`
   *  uses it too). */
  recordBaseline(nodeId: string, holder: string): Promise<void>
  /** Start a fresh executor; the callers here deliberately do not await it. */
  startWorker(node: NodeRecord, claimId: string): Promise<void>
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
 *
 * Both binding paths go through the ENGINE's admission policy (`engine.admissionPolicy()`), not a
 * host-side reading of capacity: the parked wake is the most common binding path there is (an owner's
 * pre-step), and it used to adopt with no policy at all, which means no capacity recheck and a
 * machine that could be oversubscribed by wakes while the dispatch loop carefully respected the
 * gate. A refusal is the same deferral every other path gets: the node stays `ready`, the address
 * stays on it, nothing is charged, and the next pass retries.
 */
export async function wakeParkedWorkers(deps: ColdResumeDeps, agent?: Agent): Promise<number> {
  const tree = deps.tree
  if (tree === undefined) return 0
  // ONE snapshot for this pass, exactly as `MissionEngine.pass` builds one per iteration.
  const capacity = deps.engine?.admissionPolicy()
  let woken = 0
  for (const node of tree.parkedReadyNodes()) {
    // A step may only start mission for trees its session owns: otherwise any owner's step could wake
    // another owner's parked worker. The leak is one of reach, and a tree is visible only to its owner.
    if (agent !== undefined && tree.treeOf(node.rootId)?.ownerSessionId !== agent.id) continue
    const workerId = node.parkedWorker
    if (workerId === null) continue
    // Nothing can be woken without the owner, so bail out BEFORE adoption: adopting then failing to
    // deliver would consume the address and turn "the owner is away" into "start a fresh session".
    if (deps.agents.get(SessionId(tree.treeOf(node.rootId)?.ownerSessionId ?? '')) === undefined) {
      continue
    }
    // The node is about to be owned by an IDLE session, so it must count as live BEFORE the adoption
    // lands: the sweep that the last child's own `subagent/end` triggers runs concurrently with this
    // loop, and `heldByLiveWorkers` cannot see an idle parked session (see `workerLive`).
    deps.wakingClaims.add(workerId)
    let handedOff = false
    try {
      const adopted = await tree.adoptParked(node.id, workerId, capacity)
      if (!adopted.ok) {
        // A `capacity-busy` (or `unit-busy`) refusal is a deferral, not a failed wake: the address
        // stays on the node and the next owner step tries again.
        deps.trace(`wake refused ${node.id}: ${adopted.code}`)
        continue
      }
      deps.parkedSignaled.delete(node.id)
      if (await wakeParkedWorker(deps, adopted.value.node, workerId)) {
        woken += 1
        // The guard stays until `workerLive` observes the resumed agent: the delivery resolving is
        // not the same event as the agent being registered, and the sweep may land in between.
        handedOff = true
        deps.dispatchedFor.add(tree.treeOf(node.rootId)?.ownerSessionId ?? '')
        deps.announceTree(node.rootId)
        continue
      }
      // Delivery failed: give the node back — but only if this adoption still holds it. The delivery
      // awaited, so a sweep or another pass may already have re-bound the node; reverting then would
      // unbind a live worker (whose `submit_mission` would answer `not-owner`) and hand the node to a
      // second executor. A fresh claim is reserved here so a cleaned-up session costs one round trip,
      // not one pass.
      await tree.reclaim(node.id, 'wake-failed', workerId).catch(() => undefined)
      const claimId = newClaimId()
      deps.issuedClaims.add(claimId)
      deps.startingClaims.add(claimId)
      const dispatched = await tree.dispatch(node.id, claimId, capacity)
      if (!dispatched.ok) {
        deps.endStartAttempt(claimId)
        continue
      }
      void deps.startWorker(dispatched.value.node, claimId).catch((error: unknown) => {
        deps.log.warn(`dispatch of ${node.id} failed: ${String(error)}`)
      })
    } finally {
      // Every exit but a successful hand-off drops the guard here. A successful one is kept until the
      // agent is observed (or the engine gives up on the binding and interrupts it) — dropping it on
      // the delivery's own resolution would reopen exactly the window it exists to close.
      if (!handedOff) deps.wakingClaims.delete(workerId)
    }
  }
  return woken
}

/** Deliver the ordinary dispatch prompt, read fresh: a sibling result may have arrived since the
 *  children landed. `@returns` whether delivery was accepted (false means "start a fresh one"). */
async function wakeParkedWorker(deps: ColdResumeDeps, node: NodeRecord, workerId: string): Promise<boolean> {
  const tree = deps.requireTree()
  const owned = tree.treeOf(node.rootId)
  if (owned === undefined) return false
  // The worker's recorded direct parent is the tree owner, and `authorizeLineage` accepts nobody else.
  const parent = deps.agents.get(SessionId(owned.ownerSessionId))
  if (parent === undefined) {
    deps.log.info(`owner ${owned.ownerSessionId} is not live; ${node.id} cannot be woken`)
    return false
  }
  const view = tree.view(node.id)
  if (view === undefined) return false
  const prompt = buildWorkerPrompt(view, {}, deps.wellFormed)
  const delivered = await deliverPrompt(deps, {
    parent,
    workerId,
    nodeId: node.id,
    prompt,
    // A cleaned-up session or one the runtime refuses to resume: no retry and no failure counter is
    // touched — `note_mission` carries the hand-off, so a fresh session is a complete answer.
    failed: (error) => {
      deps.log.warn(`wake of ${workerId} for ${node.id} failed; starting a fresh executor: ${String(error)}`)
    },
  })
  if (delivered) {
    deps.log.info(`woke ${workerId} for ${node.id} (its children are all terminal)`)
  }
  return delivered
}

/**
 * The DELIVERY skeleton the two wakes share: send the prompt to the (possibly non-resident) child,
 * then stamp the baseline the next wake will subtract from.
 *
 * What differs between the walks stays in the callers: the prompt itself (a parked wake reads the
 * ordinary dispatch prompt; a continuation reduces corrections and prepends the delta), the failure
 * wording (each walk names its own), and the continuation's extra durable mark. The ORDER does not
 * differ and is the whole reason this is one function: the baseline is stamped only after the
 * delivery resolved — a refused prompt was never read, and nothing may claim it was.
 */
async function deliverPrompt(
  deps: ColdResumeDeps,
  input: {
    readonly parent: Agent
    readonly workerId: string
    readonly nodeId: string
    readonly prompt: string
    /** The caller's own failure line; the skeleton owns only that there IS one. */
    readonly failed: (error: unknown) => void
    /** Extra work once the prompt is known read; its own failures are its own concern. */
    readonly afterBaseline?: () => Promise<void>
  },
): Promise<boolean> {
  try {
    await deps.subagents.sendMessage(
      input.parent,
      SessionId(input.workerId),
      [{ type: 'text', text: input.prompt }],
      { signal: new AbortController().signal },
    )
  } catch (error: unknown) {
    input.failed(error)
    return false
  }
  // A parked/resumed session is a continuation too: the round this prompt opens is what its NEXT
  // wake must subtract from, not the dispatch that parked it. Stamped only now that it was read.
  await deps.recordBaseline(input.nodeId, input.workerId)
  await input.afterBaseline?.()
  return true
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
export async function resumeWorker(deps: ColdResumeDeps, input: ResumeWorkerInput): Promise<ResumeOutcome> {
  const tree = deps.requireTree()
  const { node, workerId } = input
  // A delivery for this very session is already in flight. Spawning on top of it is the exact
  // "cold resume lands + a fresh executor starts" double run this answer exists to prevent.
  if (deps.wakingClaims.has(workerId)) return 'skip'
  const owned = tree.treeOf(node.rootId)
  if (owned === undefined) return 'skip'
  // The owner is the child's recorded direct parent, and the only sender `authorizeLineage`
  // accepts. Without it nothing can be resumed, so the handle stays on the node and the next pass
  // retries — the same "owner away means this waits" rule the parked wake follows.
  const parent = deps.agents.get(SessionId(owned.ownerSessionId))
  if (parent === undefined) {
    deps.log.info(`owner ${owned.ownerSessionId} is not live; ${node.id} cannot be continued yet`)
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
      deps.log.warn(`continuation of ${node.id}: could not spend its handle — ${String(error)}`)
    })
    deps.trace(`continuation of ${node.id} declined: the mission changed materially since ${workerId} last read it`)
    deps.log.info(`not continuing ${node.id} in ${workerId}: the mission changed materially; starting a fresh executor`)
    return 'failed'
  }

  // Live from here on: an idle session reads as "vanished" to the sweep (see `workerLive`).
  deps.wakingClaims.add(workerId)
  try {
    const adopted = await tree.adoptContinuation(node.id, workerId, input.capacity)
    if (!adopted.ok) {
      // The handle moved, the node left the dispatchable states, or another pass bound it. None of
      // those is a reason to spawn: whoever moved it owns the node now. A `capacity-busy` refusal
      // is the same answer — the node stays ready with its handle intact and the next pass retries
      // it — because a machine that filled up is not a failed continuation.
      deps.trace(`continuation refused ${node.id}: ${adopted.code}`)
      deps.wakingClaims.delete(workerId)
      return 'skip'
    }
    deps.dispatchedFor.add(owned.ownerSessionId)
    if (await deliverContinuation(deps, adopted.value, workerId, parent, input.waitedMs ?? 0)) {
      deps.announceTree(node.rootId)
      deps.log.info(`continued ${node.id} in ${workerId} (its earlier execution was interrupted)`)
      // The guard stays until `workerLive` observes the resumed agent: the delivery resolving is
      // not the same event as the agent being registered, and the sweep may land in between.
      return 'resumed'
    }
    // The delivery was refused: undo the adoption and hand the node back for the fresh path. The
    // guard goes FIRST — it would otherwise answer "live" for a session nobody holds any more.
    // `workerId` is the expectation: the delivery awaited, so if a sweep or another pass re-bound
    // the node meanwhile, this stale undo must be refused rather than unbind a live worker.
    deps.wakingClaims.delete(workerId)
    await tree.reclaim(node.id, 'wake-failed', workerId).catch(() => undefined)
    return 'failed'
  } catch (error: unknown) {
    // An UNEXPECTED failure (a store that refuses `put`): never let it escape into the dispatch
    // pass, and never leave a binding nobody will deliver into. Either the adoption landed — then
    // undo it — or it did not, in which case the reclaim is refused as a no-op; both leave the
    // node ready for the caller's ordinary fresh path.
    deps.wakingClaims.delete(workerId)
    await tree.reclaim(node.id, 'wake-failed', workerId).catch(() => undefined)
    deps.log.warn(`continuation of ${node.id} failed unexpectedly; starting a fresh executor: ${String(error)}`)
    return 'failed'
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
async function deliverContinuation(
  deps: ColdResumeDeps,
  view: DispatchView,
  workerId: string,
  parent: Agent,
  waitedMs = 0,
): Promise<boolean> {
  const node = view.node
  // Read on the ADOPTED view so the delta, the correction slice and the prompt all describe one
  // and the same node state. A vanished node has no delta and needs none: the adoption already
  // failed and the caller is on its way to the fresh path.
  const drift = deps.requireTree().continuationDelta(node.id)
  const undelivered = drift?.corrections ?? node.corrections.slice(node.correctionsDeliveredUpTo)
  const prompt = buildWorkerPrompt(view, {
    resumed: true,
    corrections: undelivered,
    ...(drift === undefined ? {} : { delta: drift }),
    ...(waitedMs > 0 ? { capacityWaitedMs: waitedMs } : {}),
  }, deps.wellFormed)
  return await deliverPrompt(deps, {
    parent,
    workerId,
    nodeId: node.id,
    prompt,
    // A cleaned-up session or one the runtime refuses to resume: no retry and no failure counter
    // is touched — a fresh session is a complete answer.
    failed: (error) => {
      deps.log.warn(`continuation of ${node.id} in ${workerId} failed; starting a fresh executor: ${String(error)}`)
    },
    // Those corrections have now been READ by the session they were addressed to. Advancing the
    // durable mark HERE (never when the prompt is merely built) is what keeps a later wake from
    // repeating them; it is monotone, so a raced, older report cannot pull it back. Stamped with the
    // prompt itself, after the baseline: this session's NEXT wake subtracts from what it is being
    // read here, not from the original dispatch.
    afterBaseline: async () => {
      await deps.requireTree()
        .markCorrectionsDelivered(node.id, node.corrections.length)
        .catch((error: unknown) => {
          deps.log.warn(`continuation of ${node.id}: could not record its correction mark — ${String(error)}`)
        })
    },
  })
}
