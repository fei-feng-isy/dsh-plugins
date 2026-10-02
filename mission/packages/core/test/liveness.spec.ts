/**
 * The liveness judgement itself: which window fires, and — the compatibility half — how a record
 * written before `activityAt` existed is read.
 *
 * The engine cases in `engine.spec.ts` drive the real tree; these pin the pure decision, because the
 * legacy fallback is exactly the kind of branch that a state-machine test can exercise without
 * noticing it took the other path.
 */
import { describe, expect, it } from 'vitest'
import { heardAt, judgeWorker, producedAt, type NodeRecord } from '../src/index.js'

/** A running node, complete enough for the pure judgement. */
function node(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id: 'n0001',
    rootId: 'n0001',
    parentId: null,
    title: 'Root mission',
    description: 'd',
    unit: null,
    context: [],
    corrections: [],
    correctionsDeliveredUpTo: 0,
    analysisNotes: [],
    analysisAttempt: 0,
    status: 'running',
    createdAt: 0,
    depth: 1,
    claimedBy: 'mission-1',
    claimedAt: 1_000,
    attempts: 1,
    failures: 0,
    spawnFailures: 0,
    parkedWorker: null,
    lastWorkerId: null,
    dispatchBaseline: null,
    progressAt: 1_000,
    activityAt: 1_000,
    stalls: 0,
    stalledNotifiedAt: null,
    result: null,
    hasResult: false,
    resultReadAt: null,
    resultRef: null,
    resultHint: null,
    children: [],
    updatedAt: 0,
    ...overrides,
  }
}

const WINDOWS = { staleMs: 100, roundMs: 10_000 }

describe('reading the two clocks', () => {
  it('falls back to the dispatch for both, so a node that never reported is not "silent since 0"', () => {
    const fresh = node({ activityAt: 0, progressAt: 0 })
    expect(heardAt(fresh)).toBe(1_000)
    expect(producedAt(fresh)).toBe(1_000)
  })

  it('reads a record written before `activityAt` existed exactly as the previous build did', () => {
    // The previous build refreshed `progressAt` on ANY event and compared only that. A legacy
    // record therefore has no way to say "output" versus "noise": with no `activityAt`, both clocks
    // fall back to `progressAt`, so a fresh timestamp reads as productive (no false `hung`) and a
    // stale one still reads as silence (`stalled`, the original verdict and the original charge).
    const legacy = node({ activityAt: 0, progressAt: 1_050 })
    expect(judgeWorker(legacy, 1_060, WINDOWS)).toBeUndefined()
    expect(judgeWorker(legacy, 1_200, WINDOWS)).toMatchObject({ cause: 'stalled', bound: 'silence', silentMs: 150 })

    // `Math.max(undefined, …)` is NaN and would compare false against every window, keeping a dead
    // node running forever — which is why the fallback is a real number, not the raw field.
    expect(judgeWorker(node({ activityAt: undefined as unknown as number }), 1_200, WINDOWS))
      .toMatchObject({ cause: 'stalled' })
  })

  it('orders the bounds: silence first, then the round cap, then the output window', () => {
    // Nothing heard at all: `stalled`, even though the round cap is also exceeded.
    expect(judgeWorker(node({ progressAt: 0, activityAt: 0 }), 20_000, WINDOWS))
      .toMatchObject({ cause: 'stalled', bound: 'silence' })
    // Heard from, but past the round cap: the cap is what fired, not the (also exceeded) idle window.
    const noisy = node({ claimedAt: 0, progressAt: 0, activityAt: 20_000 })
    expect(judgeWorker(noisy, 20_000, WINDOWS)).toMatchObject({ cause: 'hung', bound: 'round', ranMs: 20_000 })
    // Heard from, inside the round: the idle output window is the only bound left.
    const idle = node({ claimedAt: 0, progressAt: 0, activityAt: 20_000 })
    expect(judgeWorker(idle, 20_000, { staleMs: 100, roundMs: 1_000_000 }))
      .toMatchObject({ cause: 'hung', bound: 'output', idleMs: 20_000 })
  })
})
