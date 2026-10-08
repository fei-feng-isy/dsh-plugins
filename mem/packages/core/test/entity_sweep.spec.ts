/**
 * The SHARED entity-version sweep, driven by a THIRD adapter that is neither store.
 *
 * This is the structural proof the convergence asks for (`docs/vector-repair-shared-flow.md` §2.5):
 * the batch loop, the budget clamp, the in-flight guard, the per-row failure isolation and the
 * `{rebuilt, deferred, skipped}` report all live in `store/entity_sweep.ts`, so a new store needs an
 * adapter and no change to any flow. The fake below is deliberately small and synthetic — the job
 * here is the CONTRACT, not a corpus; each real store's own semantics are pinned by its own suite.
 *
 * The two things a fake must get right, or the test proves nothing:
 *  1. the write is not observable until `extractAndWriteEntities` runs (the fake stamps the version
 *     inside it), which is what makes `rebuilt` and `deferred` mean something;
 *  2. concurrent calls are possible in ONE tick, so the guard is exercised with a real suspended
 *     promise rather than a re-entrant call.
 */
import { describe, it, expect } from 'vitest'
import {
  ENTITY_SWEEP_BATCH,
  sweepVersionedEntities,
  type EntitySweepRow,
  type EntitySweepTarget,
} from '../src/store/entity_sweep.js'

/** The extraction rules' version, as a store would hold it. */
const CURRENT = 7

/** One row of the fake aggregate: id, text, the rules that produced its derived rows, and a counter. */
interface FakeRow extends EntitySweepRow {
  id: number
  text: string
  version: number
  /** How many times this row was re-extracted (the "did the pass touch it" probe). */
  rebuilt: number
}

/**
 * A minimal aggregate: `rows` of text with a version stamp, plus the two stale reads the contract
 * asks for. `failing` makes one row's write throw, so row-level isolation is observable.
 */
class FakeTarget implements EntitySweepTarget<FakeRow> {
  readonly kind = 'fake'
  readonly predicate = 'entities_version'
  /** Rows reported to `onRowError`, in order. */
  readonly errors: { id: number; message: string }[] = []
  /** Every `staleEntityBatch` limit the loop asked for, in order. */
  readonly limits: number[] = []
  /** Resolved by the test when a pending `extractAndWriteEntities` may finish. */
  gate: Promise<void> = Promise.resolve()
  /** Rows this target's write refuses, so row-level isolation is observable. */
  private readonly failing: ReadonlySet<number>

  constructor(
    readonly rows: FakeRow[],
    failing: ReadonlySet<number> = new Set(),
  ) {
    this.failing = failing
  }

  private stale(): FakeRow[] {
    return this.rows.filter((r) => r.version < CURRENT).sort((a, b) => a.id - b.id)
  }

  staleEntityBatch(limit: number): { total: number; rows: readonly FakeRow[] } {
    this.limits.push(limit)
    const stale = this.stale()
    return { total: stale.length, rows: stale.slice(0, limit) }
  }

  staleEntityCount(): number {
    return this.stale().length
  }

  async extractAndWriteEntities(row: FakeRow): Promise<void> {
    await this.gate
    if (this.failing.has(row.id)) throw new Error(`row ${String(row.id)} is unwritable`)
    row.rebuilt += 1
    row.version = CURRENT
  }

  onRowError(row: FakeRow, error: unknown): void {
    this.errors.push({ id: row.id, message: error instanceof Error ? error.message : String(error) })
  }
}

function rows(...specs: [id: number, text: string, version?: number][]): FakeRow[] {
  return specs.map(([id, text, version = 0]) => ({ id, text, version, rebuilt: 0 }))
}

describe('shared entity-version sweep (fake adapter)', () => {
  it('rebuilds every stale row in one pass, then reports nothing left', async () => {
    const target = new FakeTarget(rows([1, 'a'], [2, 'b'], [3, 'c']))
    const first = await sweepVersionedEntities(target, {})
    expect(first).toEqual({ rebuilt: 3, deferred: 0, skipped: false })
    expect(target.rows.map((r) => r.version)).toEqual([CURRENT, CURRENT, CURRENT])
    expect(target.errors).toEqual([])

    // Idempotent: the stamps are the state, so a second pass selects nothing.
    const second = await sweepVersionedEntities(target, {})
    expect(second).toEqual({ rebuilt: 0, deferred: 0, skipped: false })
    expect(target.rows.map((r) => r.rebuilt)).toEqual([1, 1, 1])
  })

  it('bounds the pass by the budget and reports what it deferred', async () => {
    const target = new FakeTarget(rows([1, 'a'], [2, 'b'], [3, 'c']))
    expect(await sweepVersionedEntities(target, {}, { budget: 2 })).toEqual({ rebuilt: 2, deferred: 1, skipped: false })
    // The NEXT pass finishes the corpus — the loop is resumable from the stamps alone.
    expect(await sweepVersionedEntities(target, {}, { budget: 2 })).toEqual({ rebuilt: 1, deferred: 0, skipped: false })
  })

  it('clamps the budget at 0 — a negative LIMIT must not become "the whole corpus"', async () => {
    // SQLite reads `LIMIT -1` as unbounded, so the clamp is a real guard, not a formality: the two
    // runs below must behave as "do nothing", never as "drain everything".
    const negative = new FakeTarget(rows([1, 'a'], [2, 'b']))
    expect(await sweepVersionedEntities(negative, {}, { budget: -1 })).toEqual({ rebuilt: 0, deferred: 2, skipped: false })
    expect(negative.rows.map((r) => r.rebuilt)).toEqual([0, 0])

    const zero = new FakeTarget(rows([1, 'a'], [2, 'b']))
    expect(await sweepVersionedEntities(zero, {}, { budget: 0 })).toEqual({ rebuilt: 0, deferred: 2, skipped: false })
    expect(zero.rows.map((r) => r.rebuilt)).toEqual([0, 0])
  })

  it('defaults the budget to ENTITY_SWEEP_BATCH (the shared default the CLI re-exports)', async () => {
    expect(ENTITY_SWEEP_BATCH).toBe(2000)
    const target = new FakeTarget(rows([1, 'a']))
    await sweepVersionedEntities(target, {})
    expect(target.limits).toEqual([ENTITY_SWEEP_BATCH])
  })

  it('stops at the next row boundary when shouldStop turns true', async () => {
    const target = new FakeTarget(rows([1, 'a'], [2, 'b'], [3, 'c']))
    let visited = 0
    const report = await sweepVersionedEntities(target, {}, {
      // Stop after the first row: the remaining two must be left stale (this is the plugin-unload /
      // runtime-closed path — stopping is not an error and the corpus is still drained next time).
      shouldStop: () => { visited += 1; return visited >= 2 },
    })
    expect(report).toEqual({ rebuilt: 1, deferred: 2, skipped: false })
    expect(target.rows.map((r) => r.version)).toEqual([CURRENT, 0, 0])
  })

  it('isolates a failing row: not rebuilt, still deferred, and reported per row', async () => {
    const target = new FakeTarget(rows([1, 'a'], [2, 'b'], [3, 'c']), new Set([2]))
    const report = await sweepVersionedEntities(target, {})
    // The failure does NOT abort the batch: row 3 is still rebuilt.
    expect(report).toEqual({ rebuilt: 2, deferred: 1, skipped: false })
    expect(target.rows.map((r) => r.version)).toEqual([CURRENT, 0, CURRENT])
    expect(target.errors).toEqual([{ id: 2, message: 'row 2 is unwritable' }])
  })

  it('leaves a failed row selectable for the NEXT pass (deferred means retryable)', async () => {
    const target = new FakeTarget(rows([1, 'a'], [2, 'b'], [3, 'c']), new Set([2]))
    expect(await sweepVersionedEntities(target, {})).toEqual({ rebuilt: 2, deferred: 1, skipped: false })
    // The failing row still carries the old stamp AND was not counted as rebuilt, so it is exactly
    // what the next pass selects again — while the rows that succeeded are not.
    const second = new FakeTarget(target.rows, new Set([2]))
    expect(await sweepVersionedEntities(second, {})).toEqual({ rebuilt: 0, deferred: 1, skipped: false })
    expect(second.errors).toEqual([{ id: 2, message: 'row 2 is unwritable' }])
  })

  it('reports skipped when a pass is already in flight, and keeps the deferred count current', async () => {
    // The guard is the SHARED identity a store keeps for its lifetime (a field — see the class
    // comments in both stores); two calls passing different objects are two different stores and
    // must NOT block each other (see the last case).
    const guard = {}
    const target = new FakeTarget(rows([1, 'a'], [2, 'b'], [3, 'c']))
    let release = (): void => {}
    target.gate = new Promise<void>((resolve) => { release = resolve })

    const running = sweepVersionedEntities(target, guard)
    // Yield once so the first call has taken the guard and is parked inside row 1's write.
    await Promise.resolve()
    // The overlapped call does no work at all — that is what the guard buys — but its report still
    // carries the current count, because the selection ran before the guard was tested.
    const overlapped = await sweepVersionedEntities(target, guard, { budget: 1 })
    release()
    expect(overlapped).toEqual({ rebuilt: 0, deferred: 3, skipped: true })
    expect(await running).toEqual({ rebuilt: 3, deferred: 0, skipped: false })
    // The overlapped call asked for the count only; it never selected rows to rebuild.
    expect(target.limits).toEqual([ENTITY_SWEEP_BATCH])
  })

  it('lets two stores sweep concurrently (the guard is per identity, not global)', async () => {
    const other = new FakeTarget(rows([1, 'a']))
    const mine = new FakeTarget(rows([1, 'b']))
    expect(await Promise.all([
      sweepVersionedEntities(other, {}),
      sweepVersionedEntities(mine, {}),
    ])).toEqual([
      { rebuilt: 1, deferred: 0, skipped: false },
      { rebuilt: 1, deferred: 0, skipped: false },
    ])
  })

  it('lets a second pass run once the first has finished (the guard is released)', async () => {
    const guard = {}
    const target = new FakeTarget(rows([1, 'a']))
    await sweepVersionedEntities(target, guard)
    target.rows[0]!.version = 0
    expect(await sweepVersionedEntities(target, guard)).toEqual({ rebuilt: 1, deferred: 0, skipped: false })
  })
})
