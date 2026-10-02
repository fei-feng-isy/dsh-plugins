/**
 * The liveness verdict for ONE running node: is its worker still making progress, or has the round
 * become something the engine must take back?
 *
 * Two clocks, because "no events" and "no output" are different failures — and conflating them is
 * what let a transport-layer hang sit `running` for 7.5 hours (2026-10-02):
 *
 * - `progressAt` — the last PRODUCTION: the model's committed output (`assistant/message`), a tool
 *   it asked for (`tool/call`), or a tool that finished (`tool/result`). The plugin classifies the
 *   host's durable event feed (see its `workerEvents` module) and only those refresh it.
 * - `activityAt` — the last durable event of ANY kind, including transport-layer noise: provider
 *   retry attempts (`assistant/attempt`) and the log-only per-request route snapshots
 *   (`request/header`, `request/context`). Noise proves the session object is alive; it does not
 *   prove the mission moved.
 *
 * Three bounds come out of that, in this order:
 *
 * - **silence** (`now - max(activityAt, progressAt, claimedAt) > staleMs`) → `stalled`. Nothing was
 *   heard at all. This is the original verdict with its original budget charge, and it is checked
 *   first so a node the old build would have called silent is still called silent.
 * - **round** (`now - claimedAt > roundMs`) → `hung`. A wall-clock ceiling on the dispatch itself,
 *   which no timestamp can veto. It fires before the output bound on purpose: when a productive
 *   worker reaches it, "the round hit its ceiling" is the accurate description, not "no output".
 * - **output** (activity fresh but `now - (progressAt || claimedAt) > staleMs`) → `hung`. The W8
 *   shape exactly: the worker keeps being heard from while producing nothing.
 *
 * Both `hung` bounds are reclaimed WITHOUT charging the failure budget: a stuck provider is not a
 * failed mission, and letting retries eat the budget would turn a recoverable node `failed`.
 *
 * A record written before `activityAt` existed has no value there, and its `progressAt` was
 * refreshed by ANY event. {@link heardAt}/{@link producedAt} then fall back to `progressAt` for
 * both clocks, so such a node is judged exactly as the previous build judged it — plus the round
 * cap, which is the one bound that still catches the old records.
 *
 * @module @avantf/mission-core/liveness
 */
import type { NodeRecord } from './types.js'

/** Why a running node's worker must be taken back. `stalled` charges the failure budget; `hung` does not. */
export type ReclaimCause = 'stalled' | 'hung'

/** Which bound produced a `hung` (or `stalled`) verdict. */
export type LivenessBound = 'silence' | 'output' | 'round'

export interface LivenessVerdict {
  readonly cause: ReclaimCause
  readonly bound: LivenessBound
  /** ms since the worker was last heard from at all. */
  readonly silentMs: number
  /** ms since the worker last PRODUCED something. */
  readonly idleMs: number
  /** ms since the dispatch that opened this round. */
  readonly ranMs: number
}

export interface LivenessWindows {
  readonly staleMs: number
  readonly roundMs: number
}

/** A timestamp as stored. A record written before the field existed has `undefined` at runtime even
 *  though the type says `number`, and `Math.max(undefined, …)` is `NaN` — which would compare false
 *  against every window and keep a dead node running forever. */
export function storedTime(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** When the worker was last heard from at all; the dispatch that opened the round is the floor, so
 *  a node that never reported anything is "silent since it started" rather than "silent since 0". */
export function heardAt(node: NodeRecord): number {
  return Math.max(storedTime(node.activityAt), storedTime(node.progressAt), node.claimedAt)
}

/** When the worker last PRODUCED something. Falls back to the dispatch: a node that has produced
 *  nothing yet has been unproductive since it was bound, which is the reading `hung` needs. */
export function producedAt(node: NodeRecord): number {
  const produced = storedTime(node.progressAt)
  return produced > 0 ? produced : node.claimedAt
}

/** The verdict for one running node, or `undefined` when it is still doing fine. */
export function judgeWorker(
  node: NodeRecord,
  at: number,
  windows: LivenessWindows,
): LivenessVerdict | undefined {
  const silentMs = at - heardAt(node)
  const idleMs = at - producedAt(node)
  const ranMs = at - node.claimedAt
  if (silentMs > windows.staleMs) {
    return { cause: 'stalled', bound: 'silence', silentMs, idleMs, ranMs }
  }
  if (ranMs > windows.roundMs) {
    return { cause: 'hung', bound: 'round', silentMs, idleMs, ranMs }
  }
  if (idleMs > windows.staleMs) {
    return { cause: 'hung', bound: 'output', silentMs, idleMs, ranMs }
  }
  return undefined
}
