/**
 * Human-readable mission timing, shared by BOTH halves of the plugin: the host's tool answers and
 * `/mission` line, and the browser panel's row and detail header. It is a separate, dependency-free
 * module on purpose — the client bundle must not pull `@avantf/mission-core` in, and a second,
 * hand-copied formatter would drift from the host's exactly the way `STATUS_LABEL` nearly did (see
 * the note in `client/MissionTreeView.tsx`).
 *
 * Timestamps are LOCAL time (`MM-DD HH:MM`), never bare ISO: the reader is a person looking at their
 * own machine's clock, and the plugin's whole surface is Chinese. Durations are coarse on purpose
 * (`45s`, `2m10s`, `1h5m`, `2d3h`) — this answers "when did it start and how long did it take", not
 * "how many milliseconds".
 *
 * @module @avantf/dsh-mission/timeFormat
 */

/** The three instants a caller must supply. A node record satisfies it structurally; the client's
 *  wire view does too, and an older host that omitted the newer fields reads as `undefined`, which
 *  every function here treats exactly like `null`. `createdAt` is optional only because the detail
 *  wire field itself is optional across versions; the engine always records it. */
export interface TimingFields {
  readonly createdAt?: number | null
  readonly dispatchedAt?: number | null
  readonly endedAt?: number | null
}

/** `MM-DD HH:MM` in the LOCAL timezone. */
export function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * A coarse, human duration: seconds below a minute, then minutes, hours and days, each with the next
 * smaller unit only when it is non-zero. Negative input (a clock that ran backwards) reads as `0s`
 * rather than as a negative duration.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${String(total)}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) {
    const seconds = total % 60
    return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m${String(seconds)}s`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const restMinutes = minutes % 60
    return restMinutes === 0 ? `${String(hours)}h` : `${String(hours)}h${String(restMinutes)}m`
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${String(days)}d` : `${String(days)}d${String(restHours)}h`
}

/** Normalize the optional wire fields: `undefined` and `null` both mean "not recorded". */
function instantOf(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** `受理 <clock>`, or `受理 —` when the record predates the field. */
function acceptedLabel(node: TimingFields): string {
  const created = instantOf(node.createdAt)
  return `受理 ${created === null ? '—' : formatClock(created)}`
}

function dispatchedOf(node: TimingFields): number | null {
  return instantOf(node.dispatchedAt)
}

function endedOf(node: TimingFields): number | null {
  return instantOf(node.endedAt)
}

/**
 * The full sentence the tool answers and `/mission` carry, in the exact shape the task asks for:
 *
 * - never dispatched → `等待中（受理 10-03 17:20）` — the queue is still open, so there is no queue
 *   duration to state, only the instant it was accepted;
 * - dispatched, not ended → `派发 10-03 17:21（排队 45s）→ 进行中`;
 * - terminal after a run → `派发 10-03 17:21（排队 45s）→ 结束 10-03 17:23（耗时 2m10s）`;
 * - terminal without ever running (cancelled in the queue) → `等待中（受理 …, 结束 …，未派发）`, which
 *   says plainly that the duration it did spend was NOT execution.
 */
export function describeTiming(node: TimingFields): string {
  const created = instantOf(node.createdAt)
  const dispatched = dispatchedOf(node)
  const ended = endedOf(node)
  if (dispatched === null) {
    if (ended === null) return `等待中（${acceptedLabel(node)}）`
    return `等待中（${acceptedLabel(node)}，结束 ${formatClock(ended)}，未派发）`
  }
  const queued = created === null ? null : dispatched - created
  const head = `派发 ${formatClock(dispatched)}（排队 ${queued === null ? '未记录' : formatDuration(queued)}）`
  if (ended === null) return `${head} → 进行中`
  return `${head} → 结束 ${formatClock(ended)}（耗时 ${formatDuration(ended - dispatched)}）`
}

/**
 * The row's compact marker, or `undefined` when the row already says everything (a node that has not
 * been dispatched yet is covered by the 排队中/等容量 marker). Kept small because a row is a line:
 * a terminal node shows HOW LONG it took, a dispatched-but-unfinished one shows WHEN it started.
 */
export function timingBadge(node: TimingFields): string | undefined {
  const dispatched = dispatchedOf(node)
  const ended = endedOf(node)
  if (ended !== null) {
    return dispatched === null ? '未派发' : `耗时 ${formatDuration(ended - dispatched)}`
  }
  return dispatched === null ? undefined : `起 ${formatClock(dispatched)}`
}

/**
 * The detail dialog's line: every instant spelled out, with 「—」 for one that was never recorded.
 * Deliberately not {@link describeTiming}: a dialog is read after the fact and benefits from the three
 * instants side by side, including the accepted-for one, which the one-line tool answer omits when the
 * mission ran.
 */
export function timingDetail(node: TimingFields): string {
  const dispatched = dispatchedOf(node)
  const ended = endedOf(node)
  const parts = [acceptedLabel(node)]
  parts.push(dispatched === null ? '派发 —' : `派发 ${formatClock(dispatched)}`)
  parts.push(ended === null ? '结束 —' : `结束 ${formatClock(ended)}`)
  return parts.join(' ｜ ')
}
