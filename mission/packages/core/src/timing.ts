/**
 * The DERIVED half of a node's three timestamps: how long it queued, how long it ran, and how long
 * it existed. The three canonical instants live on {@link NodeRecord} (`createdAt` / `dispatchedAt`
 * / `endedAt`); these helpers are the only arithmetic over them, so a display, a tool answer and a
 * test cannot each round or clamp a duration their own way.
 *
 * Nothing here reads a clock: every quantity is a function of the record alone. A live "how long has
 * this been waiting" is deliberately NOT offered — a duration that grows between renders belongs to
 * the renderer, and inventing one here would make a persisted value look like a clock reading.
 *
 * @module @avantf/mission-core/timing
 */

/** The three instants, in the minimal shape every reader of them shares. */
export interface NodeTiming {
  readonly createdAt: number
  readonly dispatchedAt: number | null
  readonly endedAt: number | null
}

/**
 * How long this node QUEUED before its first dispatch: `dispatchedAt − createdAt`. `null` when it
 * has never been dispatched — the honest answer, since the wait is still going and its end is not
 * recorded. Never negative: a clock that went backwards is clamped to 0 rather than shown as a
 * time-travelling queue.
 */
export function queueMs(node: NodeTiming): number | null {
  if (node.dispatchedAt === null) return null
  return Math.max(0, node.dispatchedAt - node.createdAt)
}

/**
 * How long this node's executor ran: `endedAt − dispatchedAt`. `null` while it is still running or
 * queued, and also for the one terminal case that has no execution to measure — a node cancelled
 * before it ever ran (`dispatchedAt === null`). Clamped to 0 for the same reason as {@link queueMs}.
 */
export function runMs(node: NodeTiming): number | null {
  if (node.dispatchedAt === null || node.endedAt === null) return null
  return Math.max(0, node.endedAt - node.dispatchedAt)
}

/**
 * How long this node has existed so far: `endedAt − createdAt` once terminal, and `null` while it is
 * still in play. Unlike {@link queueMs} and {@link runMs} this is defined even for a node that never
 * ran — a cancelled prerequisite still spent wall-clock time in the tree.
 */
export function totalMs(node: NodeTiming): number | null {
  if (node.endedAt === null) return null
  return Math.max(0, node.endedAt - node.createdAt)
}
