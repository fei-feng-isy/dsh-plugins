/**
 * The ONE vector-space repair flow both stores run.
 *
 * Changing the embedding space (model, width, pooling, normalization, input window, weights) is a
 * DATA MIGRATION: persisted vectors keep decoding but live in another model's coordinates, so the
 * semantic leg must not serve them. `common.ts` owns the cheap DETECTION (`reportStaleVectors`); this
 * module owns the REPAIR — a bounded, resumable, switchable loop that re-encodes the corpus in
 * slices and yields the event loop between them.
 *
 * It is a template method implemented by COMPOSITION (AGENTS.md / the design note in
 * `docs/vector-repair-shared-flow.md`): the skeleton lives here as free functions, each store
 * supplies a {@link VectorRepairTarget} adapter. No common base class — the two stores are separate
 * databases with separate DAOs, and a base class would be a structural rewrite of two hub files.
 *
 * What is shared, and therefore must never be copied back into `store/memory.ts` /
 * `store/knowledge.ts`: the batch size, the `yieldToEventLoop` call, the stop / resume / no-progress
 * rules, the `semantic.auto_migrate` decision, the `dry_run` split, the order invariant
 * (unusable bytes leave first, then re-encode), the warmup policy and the four log kinds.
 *
 * What stays in the stores (correct differences, DESIGN §2.3): the DAO calls and row shapes, the
 * `conflict_checked` re-queue on the memory side, the `content_hash` reuse and failure counting on
 * the knowledge side, the HRR column, and which live index a row is added to.
 *
 * @module store/vector_repair
 */
import type {
  AvantfLogger,
  VectorMigrationOutcome,
  VectorMigrationProgress,
  VectorsFixReport,
  VectorsFixStoreReport,
} from '@avantf/mem-contract'
import { describeError } from '@avantf/mem-contract'
import type { VectorStore } from '@avantf/mem-retrieval'
import { retrievalLogger } from '@avantf/mem-retrieval'
import { float32ToBytes, isPreFingerprintSpace, reloadVectorIndex } from '../db/vectors.js'
import { reportStaleVectors, yieldToEventLoop, type StaleVectorCounts } from './common.js'

/** The two stores this flow can drive. */
export type VectorRepairStore = 'memory' | 'knowledge'

/**
 * Rows one background vector-space migration slice may re-encode.
 *
 * Small on purpose: the point of batching is that a query arriving mid-migration waits for at most
 * one ONNX forward pass batch, not for a whole corpus. At ~30 ms per bge-base-zh encode a batch of 16
 * is well under a second of contested model time, and the event loop is yielded between batches
 * (`yieldToEventLoop`). The value is a default, not a promise — `migrateVectorSlice` takes whatever
 * the caller needs.
 */
export const DEFAULT_VECTOR_MIGRATION_BATCH = 16

/**
 * What one store's persisted-vector scan found, before any write.
 *
 * `stale` and `space_stale` mirror the cheap detection counts (`StaleVectorCounts`); `missing` is
 * "ACTIVE row with no persisted vector at all" — the third reason the semantic leg cannot use a row.
 */
export interface VectorsClassification {
  /** ACTIVE rows whose persisted vector has the wrong width (it cannot even be decoded). */
  stale: number
  /** ACTIVE rows whose usable-width vector was recorded in another space. */
  space_stale: number
  /** ACTIVE rows with no persisted vector at all. */
  missing: number
  /**
   * Ids whose unusable bytes must leave the store before a re-encode picks them up (the `limit`
   * passed to {@link VectorRepairTarget.classifyVectors} is applied). Knowledge overwrites vectors
   * in place, so it reports none.
   */
  dropIds: readonly number[]
  /**
   * Usable persisted vectors absent from the LIVE index, decoded and ready to re-add. Only stores
   * whose diagnose surface tracks the live index report this (memory); knowledge rebuilds its index
   * at open and keeps it in sync on every write, so it omits the property entirely.
   */
  unindexed?: readonly { id: number; vec: Float32Array }[]
}

/**
 * One store's half of the repair flow — the "key methods" of the template.
 *
 * Every method is a PRIMITIVE the store can answer from its own DAO; none of them contains the
 * loop, the batch size or the switch logic (those are in this module, once).
 */
export interface VectorRepairTarget {
  readonly store: VectorRepairStore
  /** The manual entry the stale-vector warning points at, as the operator would type it. */
  readonly manualEntry: string
  /** The representation fingerprint this store writes into now. */
  vectorSpace(): string
  /** Is the embedding model loaded RIGHT NOW? (Never warms — the flow owns the warmup policy.) */
  semanticAvailable(): boolean
  /** The RAW `semantic.auto_migrate` value; the flow decides what it means (`!== false`). */
  autoMigrate(): boolean | undefined
  /** Cheap `{ stale, space_stale, legacy? }` — blob LENGTHS only, never decodes. */
  vectorSpaceHealth(): StaleVectorCounts
  /** Cheap count of ACTIVE rows with no persisted vector (part of `remaining`). */
  missingVectorCount(): number
  /** One scan classifying what needs dropping and re-encoding; `limit` bounds `dropIds`. */
  classifyVectors(limit: number): VectorsClassification
  /**
   * Optional: put usable persisted vectors missing from the live index back into it, returning how
   * many were added. Called with the slice of {@link VectorsClassification.unindexed} the current
   * `limit` allows, so the flow does not re-scan the corpus for it.
   */
  reindexUsable?(rows: readonly { id: number; vec: Float32Array }[]): number
  /** Clear unusable bytes (table + live index); returns how many rows were actually cleared. */
  dropVectors(ids: readonly number[]): number
  /** Encode + persist up to `limit` rows into the current space, one row isolated at a time. */
  reencodeVectors(limit: number): Promise<{ encoded: number; failed: number }>
  /** Optional: wait for the embedding model (explicit repair only; the background never waits). */
  warmup?(): Promise<boolean>
}

/** A persisted vector row as read back from a store, for the shared open-time load. */
export interface PersistedVectorRow {
  id: number
  vec: Uint8Array | null
  embedding_model?: string | null
}

/**
 * Rebuild one store's live vstore from its persisted rows, count what is unusable in the current
 * space, and say so once — the shared "open for business" step both stores used to write twice.
 *
 * The owning store's ONLY half is the row read (`facts.activeVectorRows()` /
 * `chunks.vectorRows()`); the reload, the count and the loud warning are one implementation, so a
 * change to what counts as stale cannot land on one store only (the incident this exists for: the
 * memory store checked the SPACE while knowledge checked only the WIDTH, so a model swap mixed two
 * spaces in one index until someone happened to run `kb_reindex`).
 */
export function loadVectorIndex(opts: {
  store: VectorRepairStore
  vstore: VectorStore
  rows: readonly PersistedVectorRow[]
  space: string
  manualEntry: string
}): StaleVectorCounts {
  reloadVectorIndex(opts.vstore, opts.rows, opts.store)
  // Both halves of "the embedding space changed": a width that no longer fits and a recorded space
  // from another model (same width = still ranked, but in another model's coordinates). Reading the
  // blob LENGTH is enough for the first and never decodes.
  const expectedBytes = opts.vstore.dim * 4
  let stale = 0
  let spaceStale = 0
  let legacy = 0
  for (const row of opts.rows) {
    if (row.vec === null || row.vec.byteLength !== expectedBytes) {
      stale++
      continue
    }
    if (row.embedding_model !== opts.space) {
      spaceStale++
      if (isPreFingerprintSpace(row.embedding_model)) legacy++
    }
  }
  reportStaleVectors(opts.store, opts.space, { stale, space_stale: spaceStale, legacy }, opts.manualEntry)
  return { stale, space_stale: spaceStale, legacy }
}

/** One row the shared encode flow should turn into a vector. */
export interface VectorEncodeRow {
  id: number
  text: string
}

/** One encoded row ready to be persisted. */
export interface EncodedVector {
  id: number
  bytes: Buffer
}

/**
 * One store's half of {@link encodeAndPersist}: how to encode, where the live index is, and how a
 * group of vectors is persisted.
 */
export interface EncodeWriteTarget {
  readonly store: VectorRepairStore
  /** The space recorded beside every persisted vector. */
  readonly space: string
  /** One text → vector. Throwing skips that row (never the group). */
  encode(text: string): Promise<Float32Array>
  /** Add a freshly encoded vector to THIS store's live index. */
  add(id: number, vec: Float32Array): void
  /**
   * Persist one group of encoded rows. Throwing fails the WHOLE group, which is what lets the store
   * decide how to reconcile its live index (see {@link onWriteError}).
   */
  write(rows: readonly EncodedVector[]): void
  /** Rows per `write` call (default 1). Knowledge uses its measured `WRITE_BATCH`. */
  readonly writeBatch?: number
  /** Called once per row whose encode (or live-index add) failed. */
  onRowError?(row: VectorEncodeRow, error: unknown): void
  /** Called once per group whose `write` failed, with the rows that never reached the database. */
  onWriteError?(rows: readonly EncodedVector[], error: unknown): void
}

/**
 * Encode rows one at a time, add each to the live index, and persist them in groups.
 *
 * The shared skeleton: serial encode (a MEASURED decision for chunks — a padded batched forward pass
 * is 1.79x slower on real 53–550 character chunks), `add` right after a successful encode, one
 * `write` call per `writeBatch` rows, per-row isolation of encode failures, per-group isolation of
 * write failures, and the `{ encoded, failed }` count.
 *
 * What stays with the store: the backend call, the live index, the write statement, the replay of a
 * failed group, and the summary log — the memory store logs per row and keeps a half-written index
 * (documented as the benign direction for it), the knowledge store evicts the group so both sides
 * agree that the vectors are missing.
 */
export async function encodeAndPersist(
  rows: readonly VectorEncodeRow[],
  target: EncodeWriteTarget,
): Promise<{ encoded: number; failed: number }> {
  const every = Math.max(1, Math.floor(target.writeBatch ?? 1))
  let encoded = 0
  let failed = 0
  for (let i = 0; i < rows.length; i += every) {
    const group = rows.slice(i, i + every)
    const writes: EncodedVector[] = []
    for (const row of group) {
      try {
        const vec = await target.encode(row.text)
        target.add(row.id, vec)
        writes.push({ id: row.id, bytes: float32ToBytes(vec) })
      } catch (error) {
        failed += 1
        target.onRowError?.(row, error)
      }
    }
    if (!writes.length) continue
    try {
      target.write(writes)
      encoded += writes.length
    } catch (error) {
      failed += writes.length
      target.onWriteError?.(writes, error)
    }
  }
  return { encoded, failed }
}

/**
 * ONE bounded slice of the repair: re-add unusable-but-readable vectors that the live index lost,
 * drop the rows a re-encode has to replace, then encode up to `limit` missing/foreign rows.
 *
 * `limit` is what makes the SAME logic usable as a background migration: one call is a bounded unit
 * of work the caller can yield between. The explicit fix passes no limit (the operator action drains
 * everything); the background drive passes its batch size.
 *
 * The ORDER is an invariant: unusable bytes leave the table and the live index first, so a
 * re-encode can pick them up and a process that dies mid-migration leaves at most one batch
 * vector-less — exactly the `missing` rows the next run resumes on.
 */
export async function repairVectorSlice(
  target: VectorRepairTarget,
  opts: { dryRun: boolean; limit?: number },
): Promise<{ report: VectorsFixStoreReport; remaining: number }> {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY
  const c = target.classifyVectors(limit)
  const loadedNow = target.semanticAvailable()
  let semAvailable = loadedNow
  // An explicit repair is the one call site worth *waiting* for the model: a bare availability read
  // would make the fix a silent no-op right after a failed bootstrap. The background drive never
  // warms (it must not download inside a heartbeat).
  if (!semAvailable && !opts.dryRun && target.warmup !== undefined) semAvailable = await target.warmup()
  // Reported for BOTH modes, and computed BEFORE the warmup: a dry run cannot know whether a warmup
  // would succeed (it must not download), so "the model is not loaded" is not the same answer as
  // "the repair cannot run".
  const wouldWarm = !loadedNow
  // What the semantic leg still cannot use, derived from THIS slice's classification (no second full
  // scan per batch): dropped rows leave `stale`/`space_stale` and enter `missing`, so only `encoded`
  // moves the sum.
  const remainingOf = (encoded: number): number =>
    Math.max(0, c.stale + c.space_stale + c.missing - encoded)
  const base = {
    stale: c.stale,
    space_stale: c.space_stale,
    missing: c.missing,
    semantic_available: semAvailable,
    would_warm: wouldWarm,
  }
  if (opts.dryRun) {
    return {
      report: {
        ...base,
        ...(c.unindexed === undefined ? {} : { unindexed: c.unindexed.length, reindexed: 0 }),
        dropped: 0,
        encoded: 0,
        failed: 0,
      },
      remaining: remainingOf(0),
    }
  }

  let reindexed = 0
  if (c.unindexed !== undefined) reindexed = target.reindexUsable?.(c.unindexed.slice(0, limit)) ?? 0
  let dropped = 0
  if (semAvailable && c.dropIds.length > 0) dropped = target.dropVectors(c.dropIds)
  const { encoded, failed } = semAvailable
    ? await target.reencodeVectors(limit)
    : { encoded: 0, failed: 0 }
  return {
    report: {
      ...base,
      ...(c.unindexed === undefined ? {} : { unindexed: c.unindexed.length, reindexed }),
      dropped,
      encoded,
      failed,
    },
    remaining: remainingOf(encoded),
  }
}

/**
 * ONE bounded slice of the background migration — the unit the drive (and the tests) step.
 *
 * Resumability is a property of the DATABASE, not of this process: every slice re-derives what is
 * stale from the persisted width/space, so a restart simply continues where the last slice stopped.
 */
export async function migrateVectorSlice(
  target: VectorRepairTarget,
  batchSize = DEFAULT_VECTOR_MIGRATION_BATCH,
): Promise<VectorMigrationProgress> {
  const size = Math.max(1, Math.floor(batchSize))
  const { report, remaining } = await repairVectorSlice(target, { dryRun: false, limit: size })
  return {
    remaining,
    migrated: report.encoded,
    dropped: report.dropped,
    reindexed: report.reindexed ?? 0,
    semantic_available: report.semantic_available,
  }
}

/** ACTIVE rows the semantic leg still cannot use (old width, old space, or no vector at all). */
function migrationRemaining(target: VectorRepairTarget): number {
  const health = target.vectorSpaceHealth()
  return health.stale + health.space_stale + target.missingVectorCount()
}

/** Options for the background drive; the four log kinds go to `log` (the host logger by default). */
export interface DriveVectorRepairOptions {
  batchSize?: number
  /** Plugin unmount / runtime shutdown: stop at the next batch boundary. */
  shouldStop?: () => boolean
  onProgress?: (progress: VectorMigrationOutcome) => void
  /** Log sink; `retrievalLogger()` (the host logger once the runtime installed it) when omitted. */
  log?: AvantfLogger
}

/** The `auto_migrate: false` warning is one per process per store, like the startup warning. */
const disabledWarned = new WeakSet<VectorRepairTarget>()

/**
 * Drive the bounded background migration for one store until it is current, the model is
 * unavailable, or `shouldStop()` turns true (plugin unmount / process shutdown). A batch FAILURE
 * never rejects: it is logged and reported as `remaining > 0`, which is what makes the next
 * heartbeat a retry. Never blocks the event loop for longer than one batch.
 *
 * Honours `semantic.auto_migrate` (default on) — the switch exists so a host that must not spend CPU
 * on background re-encoding can leave the loud warning and the manual entry as the only path. The
 * switch is read through the adapter so a new store cannot forget it.
 */
export async function driveVectorRepair(
  target: VectorRepairTarget,
  opts: DriveVectorRepairOptions = {},
): Promise<VectorMigrationOutcome> {
  const log = opts.log ?? retrievalLogger()
  const stopped = (): boolean => opts.shouldStop?.() === true
  // The ONE place `semantic.auto_migrate` means anything: default on, only an explicit `false` turns
  // the automatic half off. Each store hands over the raw configured value.
  const enabled = target.autoMigrate() !== false
  const snapshot = (): VectorMigrationOutcome => ({
    enabled,
    remaining: migrationRemaining(target),
    migrated: 0,
    dropped: 0,
    reindexed: 0,
    semantic_available: target.semanticAvailable(),
  })
  const initial = snapshot()
  if (stopped()) return initial
  const health = target.vectorSpaceHealth()
  // "Belongs to an older embedding space" and "has no vector at all" are different degradations with
  // the same consequence (the semantic leg cannot use the row). `remaining` counts both — the store's
  // `migrateVectors` always did — so the LOG has to name the one that actually applies.
  const isSpaceChange = health.stale + health.space_stale > 0
  if (!enabled) {
    if (initial.remaining > 0 && !disabledWarned.has(target)) {
      disabledWarned.add(target)
      log.warn(
        `${target.store} vector migration: ${String(initial.remaining)} ACTIVE vector(s) `
        + `${isSpaceChange ? 'belong to an older embedding space' : 'have no vector at all'} and `
        + '`semantic.auto_migrate` is off — the semantic leg stays blind to them; run '
        + `${target.manualEntry} or set \`semantic.auto_migrate: true\``,
      )
    }
    return initial
  }
  if (initial.remaining === 0) return initial

  const startedAt = Date.now()
  log.info(
    isSpaceChange
      ? `${target.store} vector migration: ${String(initial.remaining)} ACTIVE vector(s) belong to an older embedding space `
        + `(${String(health.space_stale)} same-width, another representation, ${String(health.stale)} wrong-width) — re-encoding in the background `
        + '(a representation change — model, pooling, normalization, input window or weights — migrates the whole corpus once)'
      : `${target.store} vector migration: ${String(initial.remaining)} ACTIVE row(s) have no vector at all — encoding them in the background`,
  )
  let migrated = 0
  let dropped = 0
  let reindexed = 0
  let last = initial
  for (;;) {
    if (stopped()) break
    let step: VectorMigrationProgress
    try {
      step = await migrateVectorSlice(target, opts.batchSize)
    } catch (error) {
      log.warn(
        `${target.store} vector migration: batch failed (${describeError(error)}) — ${String(migrationRemaining(target))} `
        + 'vector(s) still cannot be used by the semantic leg; the next pass retries',
      )
      break
    }
    migrated += step.migrated
    dropped += step.dropped
    reindexed += step.reindexed
    last = { ...step, enabled, migrated, dropped, reindexed }
    opts.onProgress?.(last)
    log.info(
      `${target.store} vector migration: re-encoded ${String(migrated)}/${String(initial.remaining)} (${String(step.remaining)} left)`,
    )
    // No progress means the model is not available (or a write failed): stop this pass and let the
    // caller's next heartbeat retry, instead of spinning on the same rows.
    if (step.migrated === 0 && step.dropped === 0 && step.reindexed === 0) break
    if (last.remaining === 0) break
    await yieldToEventLoop()
  }
  if (last.remaining === 0) {
    log.info(
      `${target.store} vector migration: complete — ${String(migrated)} vector(s) re-encoded in `
      + `${String(Date.now() - startedAt)}ms; the semantic leg is current`,
    )
  } else if (!stopped()) {
    log.warn(
      `${target.store} vector migration: ${String(last.remaining)} vector(s) still cannot be used by the semantic leg `
      + `(the embedding model may be unavailable) — the next heartbeat retries; manual entry ${target.manualEntry}`,
    )
  }
  return last
}

/**
 * Drive every store in order. A stop request keeps the drive from starting another store, but each
 * store still answers with its snapshot (so the caller can report what is left everywhere).
 */
export async function driveVectorRepairs(
  targets: readonly VectorRepairTarget[],
  opts: DriveVectorRepairOptions = {},
): Promise<VectorMigrationOutcome[]> {
  const outcomes: VectorMigrationOutcome[] = []
  for (const target of targets) outcomes.push(await driveVectorRepair(target, opts))
  return outcomes
}

/**
 * The explicit, unbounded repair behind `mem_admin vectors_fix` / `avantf-mem vectors --fix`,
 * covering one or both stores.
 *
 * `store` selects a single store (omitted = both); `dry_run` previews every count without writing —
 * and without loading the model (so a preview also reports `would_warm`). The top-level
 * `semantic_available` is AND over the selected stores: `false` means at least one store's repair
 * could not encode anything.
 */
export async function vectorsFix(
  targets: Partial<Record<VectorRepairStore, VectorRepairTarget>>,
  opts: { dryRun: boolean; store?: VectorRepairStore },
): Promise<VectorsFixReport> {
  const stores: Partial<Record<VectorRepairStore, VectorsFixStoreReport>> = {}
  let semanticAvailable = true
  for (const kind of ['memory', 'knowledge'] as const) {
    if (opts.store !== undefined && opts.store !== kind) continue
    const target = targets[kind]
    if (target === undefined) continue
    const { report } = await repairVectorSlice(target, { dryRun: opts.dryRun })
    stores[kind] = report
    semanticAvailable = semanticAvailable && report.semantic_available
  }
  return { stores, semantic_available: semanticAvailable, dry_run: opts.dryRun }
}
