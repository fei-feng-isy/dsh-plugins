/**
 * An idle-event-loop gate for startup work that would otherwise compete with the host's boot.
 *
 * Measured reason this exists: nodejieba parses its dictionary SYNCHRONOUSLY on the main thread
 * (~1.2 s), so firing that warm-up during the host's own startup makes the two fight for one thread.
 * In `dsh web` the harness printed its listen URL 0.09 s after our "tokenizer ready" line — our parse
 * was the last thing gating startup. Waiting for an idle turn moves the parse to the first quiet
 * moment (right after boot) while still warming it before a user asks anything.
 *
 * @module idle
 */

/**
 * How long the loop must serve a timer on time before it counts as idle.
 *
 * 300 ms, not a token dozen: the point is to stay out of the way of the FIRST PAGE LOAD, which
 * arrives within a few hundred milliseconds of the harness printing its URL (the web app opens the
 * browser) and then fetches the index plus ~58 combo resources. Measured with a 50 ms window the
 * parse still started at 3.29 s — exactly the URL line — so the page load would have queued behind
 * its 1.2 s. A 300 ms window spans the gaps between those requests and parses after the burst.
 */
export const IDLE_QUIET_MS = 300

/** A timer this late means the loop was blocked by other work (host boot, a large import…). */
export const IDLE_TOLERANCE_MS = 15

/** Hard cap: warm anyway after this, so a permanently busy host still gets a tokenizer. */
export const IDLE_MAX_WAIT_MS = 10_000

/**
 * Resolve once the event loop has been idle for `quietMs`, or after `maxWaitMs`. Returns the wait.
 *
 * A timer that fires within {@link IDLE_TOLERANCE_MS} of its deadline is the signal: during a
 * CPU-bound boot they fire hundreds of milliseconds late, and once boot settles they fire on time.
 */
export async function whenEventLoopIdle(quietMs = IDLE_QUIET_MS, maxWaitMs = IDLE_MAX_WAIT_MS): Promise<number> {
  const started = Date.now()
  for (;;) {
    // Only attempt a full quiet window: clamping the sleep below `quietMs` would make its own
    // deadline meaningless (lateness would read as zero while the loop was never idle).
    if (maxWaitMs - (Date.now() - started) < quietMs) return Date.now() - started
    const tickStart = Date.now()
    await new Promise<void>((resolve) => { setTimeout(resolve, quietMs) })
    if (Date.now() - tickStart - quietMs <= IDLE_TOLERANCE_MS) return Date.now() - started
  }
}
