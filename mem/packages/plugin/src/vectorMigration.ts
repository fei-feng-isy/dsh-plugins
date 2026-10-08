/**
 * The plugin's lifecycle for the bounded, resumable background migration of persisted vectors into
 * the current embedding space.
 *
 * Changing the embedding space (default model, width, pooling, normalization, input window, weights)
 * is a DATA MIGRATION, not a config tweak: every persisted vector still decodes, but in another
 * model's coordinates, so the semantic leg must not serve it. Measured on the real library after the
 * 512→768 default-model swap, 78 of 80 ACTIVE facts fell out of the semantic leg and retrieval
 * degraded to lexical+entity with no error anywhere — the stores' open-time warning now says so, and
 * this module is what repairs it without the operator having to know `vectors --fix` exists.
 *
 * The FLOW lives in the engine, once, for both stores (`@avantf/mem`'s `store/vector_repair.ts`:
 * batch size, event-loop yield, stop / resume / no-progress rules, the `semantic.auto_migrate`
 * decision and the four store-named log kinds). It is driven for BOTH stores — memory and knowledge
 * — in one pass, because one embedding space is configured for the whole runtime: the knowledge
 * store used to be left behind, silently, with only a manual `kb_reindex` able to fix it.
 *
 * This module owns only the process LIFECYCLE: one start, one stop, and "never an unhandled
 * rejection". It sits BEHIND the startup gate (`awaitStartupGate`, see index.ts): the model warm and
 * this first batch must not land in the boot window (DESIGN §20.14).
 *
 * Deliberately no state: what still needs migrating is derived from the databases on every pass —
 * and the adapters are created ONCE so the shared flow's once-per-process `auto_migrate` warning is
 * genuinely once per process, not once per heartbeat.
 */
import { driveVectorRepairs, type AvantfRuntime } from '@avantf/mem'
import type { AvantfLogger } from '@avantf/mem-contract'

export interface VectorMigrationHandle {
  /**
   * Run one migration pass. Quiet no-op when both stores are already current, when a pass is already
   * running, or after {@link stop}. Failures never escape: they are logged and left for the next
   * heartbeat to retry.
   */
  start(): void
  /** Stop a running pass at its next batch boundary; later `start()` calls are no-ops. */
  stop(): void
  /** `true` while a pass is in flight. */
  readonly running: boolean
}

export function createVectorMigration(opts: {
  rt: AvantfRuntime
  logger: AvantfLogger
  /** False once the plugin's fiber is disposed (profile reload / unload). */
  isActive: () => boolean
  /** Rows per batch; the engine's `DEFAULT_VECTOR_MIGRATION_BATCH` when omitted. */
  batchSize?: number
}): VectorMigrationHandle {
  const { rt, logger } = opts
  // Created once: the flow keys its "already warned that auto_migrate is off" on the adapter
  // identity, so a fresh adapter per heartbeat would repeat the warning on every beat.
  const targets = [rt.memory.vectorRepairTarget(), rt.knowledge.vectorRepairTarget()]
  let running = false
  let stopped = false

  const run = async (): Promise<void> => {
    if (rt.closed || !opts.isActive()) return
    await driveVectorRepairs(targets, {
      ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
      shouldStop: () => stopped || rt.closed || !opts.isActive(),
      log: logger,
    })
  }

  return {
    start(): void {
      if (stopped || running) return
      running = true
      void run()
        .catch((error: unknown) => {
          // The shared flow handles its own batch failures; this is the belt-and-braces catch for
          // the detection read itself (a closed database during unmount). Never an unhandled
          // rejection — that would take the host down (see AGENTS "家族的统一失败口径").
          logger.warn(`vector migration failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => { running = false })
    },
    stop(): void { stopped = true },
    get running(): boolean { return running },
  }
}
