/**
 * The trust heartbeat: the interval beat that advances the active-day clock and performs the
 * settle / forget / idle / purge sweeps (TRUST_MODEL.md §5), shared by the DSH plugin and the MCP
 * server.
 *
 * The two surfaces used to install it separately, and the copies drifted in exactly the places a
 * copy drifts: the wording of the failure line and the work each beat does after the tick. The tick
 * itself — the one thing that MUST be identical, because it is the trust clock — is what lives
 * here. The differences are data: {@link TrustHeartbeatOptions.onBeat} is the extra work (the plugin
 * sweeps entities and retries the vector migration), {@link TrustHeartbeatOptions.tickFailed} is how
 * that surface names a failed sweep.
 *
 * `heartbeatMinutes <= 0` is the caller's decision, not this function's: a surface that disables the
 * beat also decides whether it logs the interval line.
 *
 * Zero dependencies beyond `setInterval` so it stays in the engine (the plugin's index and the MCP
 * entry both consume it).
 */

/** A single beat's worth of the trust clock, plus the two per-surface differences. */
export interface TrustHeartbeatOptions {
  /** The store whose active-day clock advances on presence. */
  readonly memory: { trustTick(): void }
  /** Where a failed sweep is reported. Never allowed to make the beat itself throw. */
  readonly logger: { warn(message: string): void }
  /** Minutes between beats. The caller does not install the beat unless this is positive. */
  readonly heartbeatMinutes: number
  /** Extra per-beat work, run after the tick and OUTSIDE its catch (a failure here is the caller's). */
  readonly onBeat?: () => void
  /**
   * How this surface names a failed tick, given the caught value's message. Optional so the default
   * (`trust tick failed: …`) holds for a caller that has no opinion.
   */
  readonly tickFailed?: (message: string) => string
}

/** The generic one-line reason for a caught value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Install the heartbeat and return its disposer.
 *
 * A `trustTick` that throws is warned about and swallowed: a failed sweep must never take the host
 * or the server down, and it must not be invisible either — a trust clock that stopped advancing
 * shows up much later as facts that never settle, forget or purge. The timer is `unref`'d where the
 * runtime supports it, so it never holds a process open by itself.
 */
export function installTrustHeartbeat(options: TrustHeartbeatOptions): () => void {
  const timer = setInterval(() => {
    try {
      options.memory.trustTick()
    } catch (error) {
      options.logger.warn((options.tickFailed ?? ((message) => `trust tick failed: ${message}`))(messageOf(error)))
    }
    options.onBeat?.()
  }, options.heartbeatMinutes * 60_000)
  const unref = (timer as unknown as { unref?: () => void }).unref
  if (typeof unref === 'function') unref.call(timer)
  return () => clearInterval(timer as unknown as ReturnType<typeof setInterval>)
}
