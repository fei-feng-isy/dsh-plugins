/**
 * The plugin's driver for the bounded, resumable background migration of persisted vectors into the
 * current embedding space.
 *
 * Changing the embedding space (default model, width, pooling, normalization) is a DATA MIGRATION,
 * not a config tweak: every persisted vector still decodes, but in another model's coordinates, so
 * the semantic leg must not serve it. Measured on the real library after the 512→768 default-model
 * swap, 78 of 80 ACTIVE facts fell out of the semantic leg and retrieval degraded to lexical+entity
 * with no error anywhere — the store's open-time warning now says so, and this module is what
 * repairs it without the operator having to know `vectors --fix` exists.
 *
 * It sits BEHIND the startup gate (`awaitStartupGate`, see index.ts): the model warm and this first
 * batch must not land in the boot window (DESIGN §20.14), and the tokenizer/model are the expensive
 * resources the gate exists to move out. The loop itself lives in the store
 * (`MemoryStore.migrateVectors`), which owns the batch size, the per-batch error handling and the
 * event-loop yield; this module owns the LOGGING (start / progress / end) and the lifecycle
 * (`shouldStop` = plugin disposed or runtime closed).
 *
 * Deliberately no new state in this file: what still needs migrating is derived from the database on
 * every pass, which is exactly what makes the migration resumable across a restart.
 */
import { type AvantfRuntime } from '@avantf/mem'
import type { AvantfLogger } from '@avantf/mem-contract'

export interface VectorMigrationHandle {
  /**
   * Run one migration pass. Quiet no-op when the store is already current, when a pass is already
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
  /** Rows per batch; the store's `DEFAULT_VECTOR_MIGRATION_BATCH` when omitted. */
  batchSize?: number
}): VectorMigrationHandle {
  const { rt, logger } = opts
  let running = false
  let stopped = false
  let warnedDisabled = false

  const run = async (): Promise<void> => {
    const health = rt.memory.vectorSpaceHealth()
    const pending = health.stale + health.space_stale
    if (pending === 0) return
    if (rt.closed || !opts.isActive()) return
    if (rt.config.common.semantic.auto_migrate === false) {
      // One warning per process: the store already emitted the loud startup line; this one names the
      // switch that is holding the repair back, and the manual entry.
      if (!warnedDisabled) {
        warnedDisabled = true
        logger.warn(
          `vector migration: ${String(pending)} ACTIVE vector(s) belong to an older embedding space and `
          + '`semantic.auto_migrate` is off — the semantic leg stays blind to them; run `avantf-mem vectors --fix` '
          + '(MCP/plugin: `mem_admin vectors_fix`) or set `semantic.auto_migrate: true`',
        )
      }
      return
    }
    const startedAt = Date.now()
    logger.info(
      `vector migration: ${String(pending)} ACTIVE vector(s) belong to an older embedding space `
      + `(${String(health.space_stale)} same-width, another representation, ${String(health.stale)} wrong-width) — re-encoding in the background `
      + '(a representation change — model, pooling, normalization, input window or weights — migrates the whole corpus once)',
    )
    const outcome = await rt.memory.migrateVectors({
      ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
      shouldStop: () => stopped || rt.closed || !opts.isActive(),
      onProgress: (progress) => {
        logger.info(
          `vector migration: re-encoded ${String(progress.migrated)}/${String(pending)} `
          + `(${String(progress.remaining)} left)`,
        )
      },
    })
    if (outcome.remaining === 0) {
      logger.info(
        `vector migration: complete — ${String(outcome.migrated)} vector(s) re-encoded in `
        + `${String(Date.now() - startedAt)}ms; the semantic leg is current`,
      )
      return
    }
    if (!stopped && !rt.closed && opts.isActive()) {
      logger.warn(
        `vector migration: ${String(outcome.remaining)} vector(s) still belong to an older embedding space `
        + '(the embedding model may be unavailable) — the next heartbeat retries; manual entry `avantf-mem vectors --fix`',
      )
    }
  }

  return {
    start(): void {
      if (stopped || running) return
      running = true
      void run()
        .catch((error: unknown) => {
          // `migrateVectors` handles its own batch failures; this is the belt-and-braces catch for the
          // detection read itself (a closed database during unmount). Never an unhandled rejection —
          // that would take the host down (see AGENTS "家族的统一失败口径").
          logger.warn(`vector migration failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => { running = false })
    },
    stop(): void { stopped = true },
    get running(): boolean { return running },
  }
}
