/**
 * The continuation delta: what a cold wake owes the session it is resuming, and the threshold at
 * which continuing that session stops being honest.
 *
 * These are pure-function cases — the snapshot arithmetic plus the material-change judgement — so
 * they can put the node into states a live tree only reaches through a whole restart. The tree-side
 * plumbing (who stamps a baseline, who spends a handle) lives in `tree.spec.ts`, and the wake itself
 * in the plugin's `continuation-delta.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  computeContinuationDelta,
  isMaterialChange,
  nodeFingerprint,
  type DispatchBaseline,
  type NodeRecord,
} from '../src/index.js'

function node(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id: 'n0001',
    rootId: 'n0001',
    parentId: null,
    title: 'Root mission',
    description: 'Do the whole thing',
    unit: null,
    context: [],
    corrections: [],
    correctionsDeliveredUpTo: 0,
    analysisNotes: [],
    analysisAttempt: 0,
    status: 'interrupted',
    createdAt: 1,
    depth: 1,
    claimedBy: null,
    claimedAt: 0,
    attempts: 1,
    failures: 0,
    spawnFailures: 0,
    parkedWorker: null,
    lastWorkerId: 'mission-aaaa1111',
    dispatchBaseline: null,
    progressAt: 0,
    activityAt: 0,
    stalls: 0,
    stalledNotifiedAt: null,
    result: null,
    hasResult: false,
    resultReadAt: null,
    resultRef: null,
    resultHint: null,
    children: [],
    updatedAt: 1,
    ...overrides,
  }
}

/** The node as its own last dispatch left it: the baseline matches, nothing has moved since.
 *  `baseline` overrides describe what the PROMPT carried, which is how a test says what arrived
 *  afterwards (e.g. a correction appended after the snapshot). */
function dispatched(
  overrides: Partial<NodeRecord> = {},
  baseline: Partial<DispatchBaseline> = {},
): NodeRecord {
  const base = node(overrides)
  return {
    ...base,
    dispatchBaseline: {
      corrections: base.corrections.length,
      notes: 0,
      terminalChildren: 0,
      fingerprint: nodeFingerprint(base.title, base.description),
      attempts: base.attempts,
      ...baseline,
    },
  }
}

describe('the mission fingerprint', () => {
  it('is stable for one headline and differs as soon as either half moves', () => {
    const base = nodeFingerprint('Root mission', 'Do the whole thing')
    expect(nodeFingerprint('Root mission', 'Do the whole thing')).toBe(base)
    expect(nodeFingerprint('Root mission!', 'Do the whole thing')).not.toBe(base)
    expect(nodeFingerprint('Root mission', 'Do the whole thing!')).not.toBe(base)
    // The separator is load-bearing: without it these two headline pairs would collide.
    expect(nodeFingerprint('a', 'bc')).not.toBe(nodeFingerprint('ab', 'c'))
  })
})

describe('subtracting the baseline', () => {
  it('reads a record without one as UNKNOWN, not as "nothing changed"', () => {
    const delta = computeContinuationDelta(node({ corrections: ['一条没人读过的纠偏'] }), 0)
    expect(delta.baselineKnown).toBe(false)
    // Unknown falls back to the watermark reading the previous generation used, so the correction is
    // still carried; what it must not do is claim to know the notes/children/headline story.
    expect(delta.corrections).toEqual(['一条没人读过的纠偏'])
    expect(delta.notes).toEqual([])
    expect(delta.terminalChildren).toBe(0)
    expect(delta.titleOrContentChanged).toBe(false)
  })

  it('reports only the corrections that arrived after the prompt, not what the prompt carried', () => {
    // The session read everything that existed when its prompt was built, so those are NOT drift —
    // even though a fresh spawn never advances the delivery watermark (which is exactly why the
    // baseline's own count is part of this arithmetic).
    const now = ['先做 A', '再做 B', '改成先做 C']
    const carried = computeContinuationDelta(
      dispatched({ corrections: now, correctionsDeliveredUpTo: 0 }, { corrections: 3 }),
      0,
    )
    expect(carried.corrections).toEqual([])

    // A correction that lands while the session is away is drift...
    const arrived = computeContinuationDelta(
      dispatched({ corrections: now, correctionsDeliveredUpTo: 0 }, { corrections: 2 }),
      0,
    )
    expect(arrived.corrections).toEqual(['改成先做 C'])

    // ...unless it was delivered live to the holder, in which case the watermark already covers it.
    const deliveredLive = computeContinuationDelta(
      dispatched({ corrections: now, correctionsDeliveredUpTo: 3 }, { corrections: 2 }),
      0,
    )
    expect(deliveredLive.corrections).toEqual([])
  })

  it('counts the notes appended while the session held the node', () => {
    const delta = computeContinuationDelta(
      dispatched({ analysisNotes: ['前一任的结论', '这一轮的结论'], analysisAttempt: 1 }),
      0,
    )
    expect(delta.notes).toEqual(['前一任的结论', '这一轮的结论'])
    expect(delta.analysisFromAnotherDispatch).toBe(false)
  })

  it('counts only the children that BECAME terminal, and never goes negative', () => {
    const baseline = dispatched().dispatchBaseline
    const withThree = node({ dispatchBaseline: { ...baseline!, terminalChildren: 1 } })
    expect(computeContinuationDelta(withThree, 4).terminalChildren).toBe(3)
    // A reused child can shrink the live reading below the snapshot; drift is a floor at zero, not a
    // negative number rendered into a prompt.
    expect(computeContinuationDelta(withThree, 0).terminalChildren).toBe(0)
  })

  it('sees a re-defined mission through the headline fingerprint', () => {
    const was = { fingerprint: nodeFingerprint('Root mission', 'Do the whole thing') }
    expect(computeContinuationDelta(dispatched(), 0).titleOrContentChanged).toBe(false)
    expect(computeContinuationDelta(dispatched({ title: '换了个目标' }, was), 0).titleOrContentChanged).toBe(true)
    expect(computeContinuationDelta(dispatched({ description: '换成别的验收标准' }, was), 0).titleOrContentChanged).toBe(true)
  })
})

describe('the material-change judgement', () => {
  it('calls an unread correction material, and a read one nothing at all', () => {
    // The prompt carried none, so the one on the node now arrived while the session was away.
    expect(isMaterialChange(computeContinuationDelta(
      dispatched({ corrections: ['改成先做 C'], correctionsDeliveredUpTo: 0 }, { corrections: 0 }),
      0,
    ))).toBe(true)
    // The same correction delivered live to the holder is already read; nothing changed for it.
    expect(isMaterialChange(computeContinuationDelta(
      dispatched({ corrections: ['改成先做 C'], correctionsDeliveredUpTo: 1 }, { corrections: 0 }),
      0,
    ))).toBe(false)
  })

  it('calls a note written under ANOTHER dispatch material', () => {
    // `attempts: 2` is the generation this session's prompt was built under; the node's latest note
    // was written under dispatch 1, i.e. the node's judgement channel moved without this session.
    const delta = computeContinuationDelta(
      dispatched({ analysisNotes: ['前任写的'], analysisAttempt: 1, attempts: 2 }),
      0,
    )
    expect(delta.analysisFromAnotherDispatch).toBe(true)
    expect(isMaterialChange(delta)).toBe(true)
  })

  it('never reads "no notes yet" as somebody else writing one', () => {
    // `analysisAttempt` is 0 when nothing was ever recorded, which differs from every dispatch's
    // `attempts` value; a bare node must not be judged material for that.
    const delta = computeContinuationDelta(dispatched({ analysisNotes: [], analysisAttempt: 0 }), 0)
    expect(delta.analysisFromAnotherDispatch).toBe(false)
    expect(isMaterialChange(delta)).toBe(false)
  })

  it('calls a re-defined mission material', () => {
    const redefined = dispatched(
      { title: '新目标' },
      { fingerprint: nodeFingerprint('Root mission', 'Do the whole thing') },
    )
    expect(isMaterialChange(computeContinuationDelta(redefined, 0))).toBe(true)
  })

  it('does NOT call terminal children material — a parked wake depends on that', () => {
    // This is the regression that protects the previous generation's feature. A parked session is
    // woken BECAUSE its children reached terminal state, so if that counted as drift the engine
    // would replace the parked session instead of waking it, and the feature would be dead.
    const parked = dispatched({
      parkedWorker: 'mission-aaaa1111',
      status: 'ready',
      analysisNotes: ['这次为什么拆：缺一个前置事实'],
      analysisAttempt: 1,
    })
    const delta = computeContinuationDelta(parked, 3)
    expect(delta.terminalChildren).toBe(3)
    expect(delta.baselineKnown).toBe(true)
    expect(isMaterialChange(delta)).toBe(false)
  })

  it('answers "not material" for an unknown baseline, because unknown is not evidence of change', () => {
    const delta = computeContinuationDelta(node({ corrections: [] }), 0)
    expect(delta.baselineKnown).toBe(false)
    // The wake CONTINUES the session and pays for it with an honest caveat in the prompt instead of
    // throwing away a session over a one-time migration gap (see `isMaterialChange`).
    expect(isMaterialChange(delta)).toBe(false)
  })
})
