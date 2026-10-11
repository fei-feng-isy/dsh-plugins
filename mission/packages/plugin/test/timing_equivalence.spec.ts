/**
 * The derived durations have TWO implementations, and this file holds them equal.
 *
 * `mission/packages/core/src/timing.ts` derives `queueMs` / `runMs` / `totalMs` from a node's three
 * instants, and its module comment claims the helpers are "the only arithmetic over them". That is
 * not literally true today: `../src/timeFormat.ts` subtracts the same instants itself
 * (`dispatched - created` for the queue, `ended - dispatched` for the run) because the client bundle
 * must not pull `@avantf/mission-core` in. Two hand-written arithmetics over the same record are
 * exactly the shape that drifts silently, so this file pins them together on the intersection of
 * their contracts: every legal record (all three instants recorded, never dispatched, or a clock that
 * ran backwards) must get the same answer from core and from the formatter.
 *
 * `core/test/timing.spec.ts` already proves the helpers' own numbers; this file adds the CROSS-MODULE
 * equivalence, so neither module can change its clamp, its null rule or its subtraction direction
 * without the other one turning red.
 *
 * It lives in the mission plugin's suite because that is the only place that can reach BOTH modules:
 * the base's suite is where cross-tree pins live, but a base test importing mission's source would
 * need a package dependency and a `rootDir` change. Reading core through `@avantf/mission-core` is
 * what every other test in this directory already does.
 */
import { describe, expect, it } from 'vitest'
import { queueMs, runMs, totalMs, type NodeTiming } from '@avantf/mission-core'
import { describeTiming, formatClock, formatDuration, timingBadge } from '../src/timeFormat.js'

/** A fixed epoch, so nothing here reads a clock. */
const BASE = 1_700_000_000_000

/**
 * The legal shapes both contracts can express (core requires `createdAt` to be recorded, and the
 * engine always writes it). `skewed*` are the clock-ran-backwards shapes; `cancelled` is the one
 * terminal record with no execution to measure.
 */
const NODES = {
  queued: { createdAt: BASE, dispatchedAt: null, endedAt: null },
  running: { createdAt: BASE, dispatchedAt: BASE + 45_000, endedAt: null },
  finished: { createdAt: BASE, dispatchedAt: BASE + 45_000, endedAt: BASE + 175_000 },
  cancelled: { createdAt: BASE, dispatchedAt: null, endedAt: BASE + 600_000 },
  skewedRun: { createdAt: BASE, dispatchedAt: BASE + 45_000, endedAt: BASE + 40_000 },
  skewedQueue: { createdAt: BASE + 90_000, dispatchedAt: BASE + 45_000, endedAt: BASE + 175_000 },
  skewedBoth: { createdAt: BASE + 90_000, dispatchedAt: BASE + 45_000, endedAt: BASE + 40_000 },
} satisfies Record<string, NodeTiming>

/** The run duration `timeFormat` rendered, or `undefined` when it rendered none. */
function renderedRun(node: NodeTiming): string | undefined {
  const badge = timingBadge(node)
  return badge?.startsWith('耗时 ') === true ? badge.slice('耗时 '.length) : undefined
}

/**
 * The queue duration `timeFormat` rendered, or `undefined` when it rendered none. `未记录` is the
 * formatter's way of saying "there is no arithmetic to do", so it reads as absent here.
 */
function renderedQueue(node: NodeTiming): string | undefined {
  const match = /（排队 ([^）]*)/u.exec(describeTiming(node))
  const value = match?.[1]
  return value === undefined || value === '未记录' ? undefined : value
}

describe('core timing and the plugin formatter compute the same durations', () => {
  it('does the same subtraction for a record both halves can read', () => {
    const node = NODES.finished
    const dispatched = node.dispatchedAt
    const ended = node.endedAt
    if (dispatched === null || ended === null) throw new Error('fixture must be fully stamped')
    // The three expressions `timeFormat` performs, asserted against core's answers.
    expect(queueMs(node)).toBe(dispatched - node.createdAt)
    expect(runMs(node)).toBe(ended - dispatched)
    expect(totalMs(node)).toBe(ended - node.createdAt)
  })

  it('renders the run duration core computes, and renders none where core says null', () => {
    for (const [name, node] of Object.entries(NODES)) {
      const measured = runMs(node)
      const rendered = renderedRun(node)
      if (measured === null) {
        expect(rendered, `${name}: core has no run duration, but the badge printed one`).toBeUndefined()
      } else {
        expect(rendered, `${name}: the badge must agree with core's runMs`).toBe(formatDuration(measured))
      }
    }
  })

  it('renders the queue duration core computes, and renders none where core says null', () => {
    for (const [name, node] of Object.entries(NODES)) {
      const measured = queueMs(node)
      const rendered = renderedQueue(node)
      if (measured === null) {
        expect(rendered, `${name}: core has no queue duration, but the sentence printed one`).toBeUndefined()
      } else {
        expect(rendered, `${name}: the sentence must agree with core's queueMs`).toBe(formatDuration(measured))
      }
    }
  })

  it('measures the whole span core measures, and keeps a live record null', () => {
    for (const [name, node] of Object.entries(NODES)) {
      const span = totalMs(node)
      if (node.endedAt === null) {
        expect(span, `${name}: a record still in play has no total`).toBeNull()
        continue
      }
      expect(span, `${name}: totalMs is ended − createdAt, clamped once`).toBe(Math.max(0, node.endedAt - node.createdAt))
      // When the clock never ran backwards, the span is exactly the two pieces timeFormat renders;
      // the only way they can disagree is one half being clamped or rounded differently.
      if (node.dispatchedAt !== null && node.createdAt <= node.dispatchedAt && node.dispatchedAt <= node.endedAt) {
        const queued = queueMs(node)
        const ran = runMs(node)
        if (queued === null || ran === null) throw new Error(`${name}: a monotonic stamped record ignores no half`)
        expect(span, `${name}: total must be queue + run when nothing was clamped`).toBe(queued + ran)
      }
    }
  })

  it('pins the two boundaries: never dispatched, and a backwards clock', () => {
    // Cancelled in the queue: core has NO run duration but DOES have a total; timeFormat shows the
    // end instant and says 未派发 rather than inventing an execution.
    const cancelled = NODES.cancelled
    const end = cancelled.endedAt
    if (end === null) throw new Error('fixture must be ended')
    expect(runMs(cancelled)).toBeNull()
    expect(totalMs(cancelled)).toBe(600_000)
    expect(timingBadge(cancelled)).toBe('未派发')
    expect(describeTiming(cancelled)).toContain(formatClock(end))
    expect(describeTiming(cancelled)).not.toContain('耗时')

    // A clock that ran backwards: both halves clamp to 0 — literal `0s`, so removing the clamp (or
    // flipping a subtraction) fails here rather than passing on a shared formatter.
    const skewed = NODES.skewedBoth
    expect(queueMs(skewed)).toBe(0)
    expect(runMs(skewed)).toBe(0)
    expect(totalMs(skewed)).toBe(0)
    expect(renderedQueue(skewed)).toBe('0s')
    expect(renderedRun(skewed)).toBe('0s')
    expect(timingBadge(skewed)).toBe('耗时 0s')
    expect(describeTiming(skewed)).toContain('排队 0s')
    expect(describeTiming(skewed)).toContain('耗时 0s')
  })
})
