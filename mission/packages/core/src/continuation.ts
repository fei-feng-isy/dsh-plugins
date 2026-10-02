/**
 * Continuation drift: what changed on a node since the prompt its session was handed, and the
 * threshold at which continuing that session stops being honest.
 *
 * The question this answers is "what does a COLD WAKE owe the session it is about to resume?" A
 * parked session is woken while its own picture is still current (it parked cleanly one turn ago);
 * a session that was interrupted mid-thought may wake up over a node that moved underneath it. The
 * delta is that difference, computed by subtracting the dispatch baseline the session's own prompt
 * left behind.
 *
 * @module @avantf/mission-core/continuation
 */
import type { DispatchBaseline, NodeRecord } from './types.js'

/** The node's accumulating channels as the delta reads them. */
export interface ContinuationDelta {
  /** `false` when the node carries no baseline (a record written before the field existed, or one
   * whose prompt was never built by this plugin). The counts below are then the conservative
   * reading — never "nothing changed" — and the wake renders an honest caveat instead. */
  readonly baselineKnown: boolean
  /** Corrections this session has NOT seen, in order. The union of two marks: the delivery
   * watermark (`correctionsDeliveredUpTo`, advanced by a live steer or by a previous wake) and the
   * baseline's own count (everything that already existed when this session's prompt was built and
   * was therefore rendered into it). Taking the LATER of the two is what keeps a fresh spawn's
   * corrections from being reported as unseen forever. On an unknown baseline it falls back to the
   * watermark alone, which is exactly the previous generation's reading. */
  readonly corrections: readonly string[]
  /** Notes appended to the node since the baseline. Only a session that held the node can append,
   * so these are normally the interrupted attempt's OWN notes — reported back so the resumed
   * session sees what it had already concluded. */
  readonly notes: readonly string[]
  /** Children that reached a terminal state since the baseline. Rendered, never a reason to refuse
   * the continuation; `0` when the baseline is unknown. */
  readonly terminalChildren: number
  /** Whether title or description changed since the baseline; `false` when unknown. */
  readonly titleOrContentChanged: boolean
  /** The node's latest analysis was written by somebody OTHER than the session this baseline belongs
   * to, and the node carries notes at all. It is the closest thing the record has to "another
   * executor has been writing this node's judgement", which is a freshness signal the next wake must
   * not ignore.
   *
   * Compared by IDENTITY (`analysisAuthor` vs the baseline's `holder`) whenever both are known: the
   * generation number alone misreads the common case this field exists for — a session's OWN note
   * outliving its dispatch, which happens to every parent that wrote its analysis and decomposed.
   * When either side is missing (a record written before the fields existed) it falls back to the
   * generation comparison (`analysisAttempt` vs `baseline.attempts`), which is the conservative
   * reading: a false positive only costs a fresh executor. */
  readonly analysisFromAnotherDispatch: boolean
}

/**
 * The identity-or-generation reading behind {@link ContinuationDelta.analysisFromAnotherDispatch}.
 * Split out so the one subtle rule — identity when both sides are known, the previous generation's
 * comparison otherwise — is stated once.
 */
function analysisFromAnotherDispatch(node: NodeRecord, baseline: DispatchBaseline): boolean {
  if (node.analysisNotes.length === 0) return false
  const author = node.analysisAuthor
  const holder = baseline.holder
  if (author !== null && author !== undefined && holder !== null && holder !== undefined) {
    return author !== holder
  }
  return node.analysisAttempt !== baseline.attempts
}

/**
 * A compact fingerprint of the mission HEADLINE (title + description), hashed rather than stored
 * verbatim because a description can be long and this rides every node record; the fingerprint is
 * only ever COMPARED, never read. Two 32-bit FNV-1a passes with different seeds (64 bits together)
 * are far more than the "did somebody rewrite this mission" question needs, and the core stays
 * dependency-free — it is deliberately built without `node:crypto`.
 */
export function nodeFingerprint(title: string, description: string): string {
  const text = `${title}\u0000${description}`
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193) >>> 0
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`
}

/**
 * Subtract the node's dispatch baseline from its current state. Pure, so the arithmetic is testable
 * without a tree.
 *
 * `terminalChildren` is passed in rather than read off the node because the node record carries
 * child IDS, not their statuses.
 */
export function computeContinuationDelta(node: NodeRecord, terminalChildren: number): ContinuationDelta {
  const baseline = node.dispatchBaseline
  if (baseline === null) {
    return {
      baselineKnown: false,
      corrections: node.corrections.slice(node.correctionsDeliveredUpTo),
      notes: [],
      terminalChildren: 0,
      titleOrContentChanged: false,
      analysisFromAnotherDispatch: false,
    }
  }
  // Both marks mean "this correction has already been put in front of the session": the watermark
  // is proof of a delivery, the baseline's count is proof the prompt carried it. The later of the
  // two is the conservative reading — it can only UNDER-report, and an under-reported correction is
  // still rendered by the ordinary `纠偏` block of the prompt.
  const delivered = Math.max(node.correctionsDeliveredUpTo, baseline.corrections)
  return {
    baselineKnown: true,
    corrections: node.corrections.slice(delivered),
    notes: node.analysisNotes.slice(baseline.notes),
    terminalChildren: Math.max(terminalChildren - baseline.terminalChildren, 0),
    titleOrContentChanged: nodeFingerprint(node.title, node.description) !== baseline.fingerprint,
    analysisFromAnotherDispatch: analysisFromAnotherDispatch(node, baseline),
  }
}

/**
 * Whether the drift since a session's own prompt is large enough that continuing it would be
 * dishonest, and a fresh executor is the better answer.
 *
 * The rule is a disjunction of STRONG signals, each of which already carries its own threshold; it
 * is deliberately not a weighted score, because every one of these means "this session's picture of
 * the mission cannot be trusted", and there is no reading under which two weak signals should
 * outvote one strong one.
 *
 * 1. `corrections` non-empty — the owner changed the direction of the mission while the session was
 *    away. The session's plan was built under the old direction, and a correction handed to a
 *    session that is already committed to a plan is exactly the case the fresh path is better at
 *    (the new executor reads the correction before it reads anything else). This is also why the
 *    delta's correction clause is normally empty: unread corrections do not reach the delta, they
 *    change the route.
 * 2. `analysisFromAnotherDispatch` — the node's latest analysis was written by somebody other than
 *    this session, i.e. the node's judgement channel has been advanced by a different executor.
 *    Conservative by construction: a false positive only costs a fresh executor, which is always a
 *    correct answer, while a false negative would resume a session over a judgement it never wrote.
 *    Compared by holder identity where the record carries it; the pre-identity generation comparison
 *    is the fallback (see the field's own note).
 * 3. `titleOrContentChanged` — the mission was re-defined under the session. It would be resuming a
 *    mission it was never handed.
 *
 * **`terminalChildren` is deliberately absent, and this is a hard requirement.** For a PARKED
 * session, "all children reached a terminal state" is not drift — it is the ENGINE's own trigger
 * for the wake (`decompose_mission` is followed by a synchronous `pump()`, so the parent parks the
 * moment its children are created). Counting it as material would demote every parked wake to a
 * fresh spawn and delete the feature the previous generation shipped. Excluding it here means the
 * exclusion survives even if a later change routes both wakes through one decision point; the
 * regression is pinned by a test on both sides (`the parked session is woken, not replaced`).
 *
 * An UNKNOWN baseline answers `false`: the caller continues the session and says so honestly (the
 * prompt renders "the drift cannot be determined, trust the current view over your memory"). The
 * opposite choice — treat unknown as material — would throw the session away on the one-time
 * migration of every in-flight mission, which is a permanent loss of context for a question the
 * prompt can answer in one sentence. That also settles the one signal an unknown baseline could
 * still offer: its `corrections` are the raw delivery-watermark tail, i.e. exactly what the previous
 * generation rendered into the wake, and a record from before the baseline existed must keep being
 * resumed on that reading rather than be re-judged by a rule it predates.
 */
export function isMaterialChange(delta: ContinuationDelta): boolean {
  if (!delta.baselineKnown) return false
  return delta.corrections.length > 0
    || delta.analysisFromAnotherDispatch
    || delta.titleOrContentChanged
}
