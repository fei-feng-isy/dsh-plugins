/**
 * Retry gate for the local model adapters.
 *
 * The model bootstrap runs exactly once, at startup (`warmModelsAsync`). When
 * that single attempt fails — an unreachable mirror, a poisoned DNS entry, a
 * proxy that is not up yet — nothing used to try again, so a long-lived host
 * stayed on the FTS+entity fallback forever, even after the network recovered
 * or the weights landed in the cache (`vectors_fix` kept reporting
 * `semantic_available: false` on a running plugin host).
 *
 * Call sites that only *observe* availability (hybrid search, best-effort
 * indexing) now ask for a retry through {@link WarmGate.nudge}. The gate is
 * deliberately timer-free: there is no background poll, no handle to dispose,
 * and no traffic while nothing is asking for semantic retrieval — recovery
 * happens on the next retrieval that needs it.
 */

/**
 * Minimum gap between two retry attempts triggered by observing call sites.
 * Comfortably above undici's 10 s connect timeout so a dead mirror is not
 * re-probed on every query, and short enough that a recovered network is picked
 * up without a restart.
 */
export const ENSURE_WARM_FLOOR_MS = 30_000

/** Throttles observing-call-site retries of a failed model warmup. */
export class WarmGate {
  private lastAttemptAt = 0

  /**
   * @param canAttempt whether a retry can still help. `false` makes the gate
   *   inert: with downloads disabled a miss is deterministic (only a local cache
   *   load is possible), so retrying would only add noise.
   */
  constructor(private readonly canAttempt: () => boolean) {}

  /**
   * Record that an attempt actually started. Called by the adapter's warmup so
   * the startup attempt also resets the floor — otherwise the first query after
   * a failed boot would immediately re-attempt.
   */
  markAttempt(now: number = Date.now()): void {
    this.lastAttemptAt = now
  }

  /**
   * Run `attempt` unless the floor has not elapsed. Non-blocking: the caller
   * passes a fire-and-forget trigger. Returns whether an attempt was started.
   */
  nudge(attempt: () => void, now: number = Date.now()): boolean {
    if (!this.canAttempt() || now - this.lastAttemptAt < ENSURE_WARM_FLOOR_MS) return false
    this.lastAttemptAt = now
    attempt()
    return true
  }
}
