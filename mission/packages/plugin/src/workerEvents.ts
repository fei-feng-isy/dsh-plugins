/**
 * Which durable session events count as a worker's OUTPUT, as opposed to a mere sign of life.
 *
 * The engine's stale check compares its window against `progressAt`, so the question this module
 * answers is "does this event prove the MISSION moved?", not "is the session object alive?" — any
 * event proves the latter, and the host records that separately (see `MissionTree.touchActivity`).
 *
 * The rule is an ALLOWLIST on purpose, not a denylist of "retry noise". The harness keeps growing
 * `SessionEventMap` (plugins may merge their own types), and an unknown type is not evidence of
 * work. Missing a genuinely productive type costs only that a long run is judged by the round cap
 * instead of by its output — bounded, logged, budget-free; letting one more noise type through the
 * other way is the W8 failure this exists to fix (2026-10-02: a node stayed `running` for 7.5 hours
 * while transport retries refreshed its timestamp every minute).
 *
 * The three types allowed, and why each is production rather than plumbing:
 *
 * - `assistant/message` — the model's committed output for a step ("Assembled assistant message for
 *   one step, carrying the step's usage"). This is the mission's work arriving.
 * - `tool/call` — the model asked for one tool with its argument JSON: a decision and an action.
 * - `tool/result` — a completed tool call's result. Durable work product; the strongest evidence.
 *
 * Everything else is excluded deliberately. The ones that actually kept W8 alive are
 * `assistant/attempt` — "one model attempt that committed no surface message", i.e. a failed,
 * retried, cancelled or stream-errored attempt — and the log-only route snapshots `request/header`
 * / `request/context`, which are appended per request, retries included. Boundary markers
 * (`turn/*`, `step/*`), prompt plumbing (`system/message`, `developer/message`) and delivered input
 * (`user/message`) are not output either: a worker that only receives messages and starts steps is
 * exactly the "alive but producing nothing" state the `hung` cause reclaims.
 *
 * @module @avantf/dsh-mission/workerEvents
 */

const OUTPUT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'assistant/message',
  'tool/call',
  'tool/result',
])

/** Whether one durable session event is output, rather than a retry that merely proves the session is alive. */
export function isOutputEvent(event: { readonly type?: string }): boolean {
  return event.type !== undefined && OUTPUT_EVENT_TYPES.has(event.type)
}
