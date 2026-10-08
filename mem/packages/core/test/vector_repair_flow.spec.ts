import { describe, it, expect } from 'vitest'
import {
  driveVectorRepair,
  repairVectorSlice,
  type VectorRepairTarget,
  type VectorsClassification,
} from '../src/store/vector_repair.js'
import type { StaleVectorCounts } from '../src/store/common.js'
import type { AvantfLogger } from '@avantf/mem-contract'

/**
 * The THIRD adapter: a fake store that satisfies `VectorRepairTarget` and nothing else.
 *
 * This is the proof of the design claim in `docs/vector-repair-shared-flow.md` §2.5 — "adding a new
 * library means writing an adapter, not touching the flow". The two real stores' specs cover their
 * own DAO half; the batch / stop / resume / no-progress / switch / dry-run BOUNDARIES live here,
 * driven by an adapter that shares no code with either store.
 */
class FakeStore implements VectorRepairTarget {
  readonly store = 'memory' as const
  readonly manualEntry = '`fake vectors --fix`'
  /** The raw configured value; `false` is the only thing that turns the automatic half off. */
  autoMigrateValue: boolean | undefined = true
  available = true
  /** `true` = a slice that classifies work but encodes none of it (the no-progress shape). */
  stalls = false
  stale: number
  spaceStale: number
  missing: number
  readonly unindexedRows: readonly { id: number; vec: Float32Array }[] | undefined
  readonly drops: number[][] = []
  readonly encodes: number[] = []
  readonly reindexed: number[] = []
  warmups = 0

  constructor(opts: { stale?: number; spaceStale?: number; missing?: number; unindexed?: number } = {}) {
    this.stale = opts.stale ?? 0
    this.spaceStale = opts.spaceStale ?? 0
    this.missing = opts.missing ?? 0
    this.unindexedRows = opts.unindexed === undefined
      ? undefined
      : Array.from({ length: opts.unindexed }, (_, i) => ({ id: i + 1, vec: new Float32Array(4) }))
  }

  vectorSpace(): string { return 'v2/fake/fake/4@p=mean;n=1;w=0' }
  semanticAvailable(): boolean { return this.available }
  autoMigrate(): boolean | undefined { return this.autoMigrateValue }
  vectorSpaceHealth(): StaleVectorCounts { return { stale: this.stale, space_stale: this.spaceStale, legacy: 0 } }
  missingVectorCount(): number { return this.missing }

  classifyVectors(limit: number): VectorsClassification {
    const dropIds = [
      ...Array.from({ length: this.stale }, (_, i) => i + 1),
      ...Array.from({ length: this.spaceStale }, (_, i) => 1000 + i),
    ].slice(0, limit)
    return {
      stale: this.stale,
      space_stale: this.spaceStale,
      missing: this.missing,
      dropIds,
      ...(this.unindexedRows === undefined ? {} : { unindexed: this.unindexedRows }),
    }
  }

  reindexUsable(rows: readonly { id: number; vec: Float32Array }[]): number {
    this.reindexed.push(rows.length)
    return rows.length
  }

  dropVectors(ids: readonly number[]): number {
    this.drops.push([...ids])
    const fromStale = Math.min(ids.length, this.stale)
    this.stale -= fromStale
    const fromSpace = Math.min(ids.length - fromStale, this.spaceStale)
    this.spaceStale -= fromSpace
    this.missing += fromStale + fromSpace
    return fromStale + fromSpace
  }

  async reencodeVectors(limit: number): Promise<{ encoded: number; failed: number }> {
    this.encodes.push(limit)
    if (this.stalls) return { encoded: 0, failed: Math.min(limit, this.missing) }
    const n = Math.min(limit, this.missing)
    this.missing -= n
    return { encoded: n, failed: 0 }
  }

  async warmup(): Promise<boolean> { this.warmups += 1; return this.available }
}

class CapturingLogger implements AvantfLogger {
  readonly lines: string[] = []
  info(message: string): void { this.lines.push(`INFO ${message}`) }
  warn(message: string): void { this.lines.push(`WARN ${message}`) }
  error(message: string): void { this.lines.push(`ERROR ${message}`) }
}

describe('shared vector-repair flow, driven by a third-party adapter', () => {
  it('applies the batch limit and the drop-before-encode order in one slice', async () => {
    const fake = new FakeStore({ stale: 10 })
    const { report, remaining } = await repairVectorSlice(fake, { dryRun: false, limit: 3 })
    expect(fake.drops).toEqual([[1, 2, 3]])
    expect(fake.encodes).toEqual([3])
    expect(report).toMatchObject({ stale: 10, space_stale: 0, dropped: 3, encoded: 3, failed: 0 })
    expect(remaining).toBe(7)
  })

  it('loops bounded slices until the store is current', async () => {
    const fake = new FakeStore({ stale: 7 })
    const logger = new CapturingLogger()
    const outcome = await driveVectorRepair(fake, { batchSize: 2, log: logger })
    // Four bounded slices; the last one drains the single row that was left.
    expect(fake.encodes).toEqual([2, 2, 2, 2])
    expect(outcome).toMatchObject({ enabled: true, remaining: 0, migrated: 7, dropped: 7 })
    // The four log kinds carry the store name.
    expect(logger.lines.some((l) => l.includes('memory vector migration') && l.includes('older embedding space'))).toBe(true)
    expect(logger.lines.some((l) => l.includes('re-encoded 2/7'))).toBe(true)
    expect(logger.lines.some((l) => l.includes('complete'))).toBe(true)
  })

  it('stops at the next batch boundary when shouldStop turns true', async () => {
    const fake = new FakeStore({ stale: 10 })
    const logger = new CapturingLogger()
    const outcome = await driveVectorRepair(fake, {
      batchSize: 2,
      log: logger,
      shouldStop: () => fake.encodes.length >= 1,
    })
    expect(fake.encodes).toEqual([2])
    expect(outcome).toMatchObject({ remaining: 8, migrated: 2 })
    // A stopped pass is not a failure and must not claim completion.
    expect(logger.lines.some((l) => l.includes('complete'))).toBe(false)
    expect(logger.lines.some((l) => l.includes('next heartbeat retries'))).toBe(false)
  })

  it('stops this pass on no progress instead of spinning on the same rows', async () => {
    const fake = new FakeStore({ missing: 5 })
    fake.stalls = true
    const logger = new CapturingLogger()
    const outcome = await driveVectorRepair(fake, { batchSize: 2, log: logger })
    expect(fake.encodes).toEqual([2]) // ONE slice, then the no-progress rule fires
    expect(outcome).toMatchObject({ remaining: 5, migrated: 0 })
    // Rows with NO vector are reported as that, not as "an older embedding space".
    expect(logger.lines.some((l) => l.includes('have no vector at all'))).toBe(true)
    expect(logger.lines.some((l) => l.startsWith('WARN') && l.includes('still cannot be used by the semantic leg'))).toBe(true)
  })

  it('honours auto_migrate: false — zero writes, one warning per adapter', async () => {
    const fake = new FakeStore({ stale: 4 })
    fake.autoMigrateValue = false
    const logger = new CapturingLogger()
    const first = await driveVectorRepair(fake, { batchSize: 2, log: logger })
    const second = await driveVectorRepair(fake, { batchSize: 2, log: logger })
    expect(first).toMatchObject({ enabled: false, migrated: 0, remaining: 4 })
    expect(second).toMatchObject({ enabled: false, migrated: 0, remaining: 4 })
    expect(fake.drops).toEqual([])
    expect(fake.encodes).toEqual([])
    expect(logger.lines.filter((l) => l.includes('auto_migrate` is off')).length).toBe(1)
  })

  it('a dry run writes nothing and never warms the model', async () => {
    const fake = new FakeStore({ stale: 5 })
    fake.available = false
    const { report, remaining } = await repairVectorSlice(fake, { dryRun: true })
    expect(report).toMatchObject({ stale: 5, dropped: 0, encoded: 0, semantic_available: false, would_warm: true })
    expect(remaining).toBe(5)
    expect(fake.drops).toEqual([])
    expect(fake.encodes).toEqual([])
    expect(fake.warmups).toBe(0)
  })

  it('counts a store with no vector at all as remaining', async () => {
    const fake = new FakeStore({ missing: 5 })
    const { report, remaining } = await repairVectorSlice(fake, { dryRun: false, limit: 2 })
    expect(report).toMatchObject({ missing: 5, encoded: 2 })
    expect(remaining).toBe(3)
  })

  it('re-adds usable persisted vectors within the same limit, without re-scanning', async () => {
    const fake = new FakeStore({ unindexed: 10 })
    const { report } = await repairVectorSlice(fake, { dryRun: false, limit: 3 })
    expect(fake.reindexed).toEqual([3])
    expect(report).toMatchObject({ unindexed: 10, reindexed: 3, encoded: 0 })
    // A store that does not track its live index omits the fields entirely.
    const knowledgeLike = new FakeStore({})
    const { report: thin } = await repairVectorSlice(knowledgeLike, { dryRun: false, limit: 3 })
    expect('unindexed' in thin).toBe(false)
    expect('reindexed' in thin).toBe(false)
  })

  it('warms only for an explicit repair, and reports it in the preview', async () => {
    const fake = new FakeStore({ missing: 1 })
    fake.available = false
    const real = await repairVectorSlice(fake, { dryRun: false })
    expect(fake.warmups).toBe(1)
    expect(real.report.semantic_available).toBe(false) // the fake cannot actually warm
    expect(real.report.would_warm).toBe(true)
  })
})
