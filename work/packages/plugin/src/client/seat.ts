/**
 * Reading the HOST's seat hooks defensively.
 *
 * The seat hands this plugin the installed runtime's own snapshot shapes, and this plugin only
 * DECLARES them structurally — nothing here is checked against the host at mount time. A field the
 * running dsh no longer has makes the selector throw, and the selectors below are called in a
 * component body: the shell's slot error boundary then renders an empty `<div>` (no text at all) and
 * does not retry within the session, so the panel stays blank while every host-side gate is green.
 *
 * That is not hypothetical: dsh 0.1.6 dropped `SessionSnapshot.queue`, and the declared peer range
 * (`^0.1.5-rc.2`) admits 0.1.6. The compat gate covers the host half only — services, typert faces,
 * the version table — so the browser half's seat props need their own guard, and it is this file:
 * every field read off a seat hook goes through a reader, and an absent field yields a NEUTRAL
 * constant (not a fresh value per render, so the derived revision stays stable instead of flapping).
 */

/** What this plugin reads off the seat's session snapshot. Every field is optional: the host owns it. */
export interface SeatSessionView {
  readonly queue?: readonly unknown[]
  readonly running?: boolean
}

/** What this plugin reads off the seat's chat snapshot. */
export interface SeatChatView {
  readonly order?: readonly string[]
}

/** How many prompts the session has queued, or -1 when the running dsh exposes no queue. */
export function queuedCount(session: SeatSessionView | undefined): number {
  return Array.isArray(session?.queue) ? session.queue.length : -1
}

/** Whether the session is running; an absent (or non-boolean) field reads as "not running". */
export function isRunning(session: SeatSessionView | undefined): boolean {
  return session?.running === true
}

/** How many chat nodes the seat holds, or -1 when it exposes no order. */
export function chatNodeCount(chat: SeatChatView | undefined): number {
  return Array.isArray(chat?.order) ? chat.order.length : -1
}
