/**
 * Trouble vocabulary: one node status in the language the model and the panel read, and the ONE
 * predicate that decides whether a node carries trouble worth reporting.
 *
 * It lives in its own module because neither member is a RENDERING concern, even though both used to
 * sit inside `prompt.ts`:
 *
 * - `statusLabel` is what every refusal the STATE MACHINE writes names a status with
 *   (`tree.ts`: "任务 X 处于「执行中」，不能…") — the state machine reaching up into the prompt
 *   renderer for a word is a layer inversion, not a dependency it needs.
 * - `isTroubledNode` is the ENGINE's reading of a durable record, shared by four channels (the
 *   owner-facing `isTroubled` flag, and the stall / repeated-hang / failed-start heads-ups), none of
 *   which is a prompt.
 *
 * `prompt.ts` still owns the text that RENDERS trouble; it imports this module, never the other way
 * round.
 *
 * @module @avantf/mission-core/trouble
 */
import { CAPACITY, type NodeRecord } from './types.js'

/** Node statuses in the language the model reads. */
const STATUS_ZH: Record<string, string> = {
  blocked: '等待子任务',
  ready: '待执行',
  running: '执行中',
  interrupted: '已中断',
  done: '已完成',
  failed: '已失败',
}

/** One node status in the language the model and the panel read. */
export function statusLabel(status: string | undefined): string {
  if (status === undefined) return '?'
  return STATUS_ZH[status] ?? status
}

/**
 * Whether ONE node carries trouble worth telling the owner about: four durable counters, each at the
 * ENGINE's own floor — silent reclaims (`stalls`), consecutive hangs (`hungCount`), failed attempts
 * (`failures`), starts that never got a worker (`spawnFailures`).
 *
 * ONE definition, because four channels ask this question: the owner-facing flag (`isTroubled`), and
 * the three heads-ups (`escalateTrouble` for stalls and repeated hangs, and the failed-start one in
 * the host). They used to disagree — the flag counted `spawnFailures` while the stall gate did not —
 * so a mission that could not get a worker started read as 「反复出过问题」 in `list_missions` and the
 * owner was never told why. Splitting the predicate out is what makes "both channels speak one
 * vocabulary" true by construction rather than by comment.
 *
 * `hungCount` is the one member that is a STREAK rather than a history: any real output clears it, so
 * a node that hung three times and then made progress stops reading as troubled. That is deliberate —
 * the flag answers "is this happening to it NOW", and the other three counters (`stalls`, `failures`,
 * `spawnFailures`) are the ones that never clear.
 */
export function isTroubledNode(node: NodeRecord): boolean {
  return node.stalls >= CAPACITY.maxStallsBeforeReport
    || node.hungCount >= CAPACITY.maxHungsBeforeReport
    || node.failures >= CAPACITY.maxAttempts - 1
    || node.spawnFailures >= CAPACITY.maxAttempts - 1
}
