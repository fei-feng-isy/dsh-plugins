/**
 * The corpus reconciler's two non-obvious rules, driven WITHOUT mounting the plugin.
 *
 * The defect this file pins: an in-flight pass used to check the stop flag only ONCE, at its start.
 * `stop()` (the unmount effect) closes the databases right after setting it, and the pass then kept
 * calling `sync()` for every remaining changed document — writes against a closed store. Every
 * `await` boundary now re-checks, and the trailing timer is cancelled.
 *
 * The clock and timers are INJECTED, so "the throttle scheduled exactly one trailing check" and "the
 * stop cancelled it" are exact assertions rather than races against real elapsed milliseconds.
 */
import { describe, expect, it } from 'vitest'
import { createCorpusReconciler, type ReconcileDeps } from '../src/reconcile.js'

/** A promise a test resolves by hand, so a pass can be stopped mid-`await`. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** A corpus double recording every call, with the first sync optionally gated. */
function corpusDouble(options: { drift?: () => { changed: number[]; missing: number[]; fileSetChanged: boolean }; gate?: Promise<void> } = {}) {
  const synced: Array<{ docId?: number }> = []
  const driftCalls: string[] = []
  return {
    synced,
    driftCalls,
    corpus: {
      sync: async (o: { docId?: number }) => {
        synced.push(o)
        if (synced.length === 1 && options.gate !== undefined) await options.gate
      },
      corpusDrift: () => {
        driftCalls.push('drift')
        return options.drift?.() ?? { changed: [], missing: [], fileSetChanged: false }
      },
    },
  }
}

describe('the corpus reconciler', () => {
  it('a FULL pass checks the stop flag after its await: no baseline read, no further work', async () => {
    const gate = deferred()
    const { synced, driftCalls, corpus } = corpusDouble({ gate: gate.promise })
    const reconciler = createCorpusReconciler({ corpus, minIntervalMs: 1000, onError: () => { throw new Error('unexpected') } })

    const pass = reconciler.request(true)
    // The sweep started synchronously and is parked on the gate (`sync({})` = the full sweep).
    expect(synced).toEqual([{}])
    expect(reconciler.running).toBe(true)

    // The unmount lands while the sweep is in flight; the databases are closed right after.
    reconciler.stop()
    gate.resolve()
    await pass

    // Nothing touched the corpus again — in particular the post-sync baseline read.
    expect(driftCalls).toHaveLength(0)
    expect(synced).toEqual([{}])
    expect(reconciler.running).toBe(false)
  })

  it('a non-full pass stops between changed documents instead of syncing the rest', async () => {
    const gate = deferred()
    const { synced, corpus } = corpusDouble({
      drift: () => ({ changed: [1, 2, 3], missing: [], fileSetChanged: false }),
      gate: gate.promise,
    })
    const reconciler = createCorpusReconciler({ corpus, minIntervalMs: 0, onError: () => { throw new Error('unexpected') } })

    const pass = reconciler.request(false)
    expect(synced).toEqual([{ docId: 1 }])
    reconciler.stop()
    gate.resolve()
    await pass

    // Documents 2 and 3 were never synced: the loop exits at the await boundary.
    expect(synced).toEqual([{ docId: 1 }])
  })

  it('a corpus-level change escalates to the full sweep, which also stops at its await', async () => {
    const gate = deferred()
    const { synced, corpus } = corpusDouble({
      drift: () => ({ changed: [], missing: [7], fileSetChanged: true }),
      gate: gate.promise,
    })
    const reconciler = createCorpusReconciler({ corpus, minIntervalMs: 0, onError: () => { throw new Error('unexpected') } })

    const pass = reconciler.request(false)
    expect(synced).toEqual([{}])
    reconciler.stop()
    gate.resolve()
    await pass
    expect(synced).toEqual([{}])
  })

  it('throttles to ONE trailing check and stop() cancels it', async () => {
    let clock = 10_000
    const timers: Array<{ fn: () => void; ms: number }> = []
    const cancelled: unknown[] = []
    const { driftCalls, corpus } = corpusDouble()
    const reconciler = createCorpusReconciler({
      corpus,
      minIntervalMs: 2000,
      onError: () => { throw new Error('unexpected') },
      now: () => clock,
      schedule: (fn, ms) => { const handle = { fn, ms }; timers.push(handle); return handle as unknown as ReturnType<typeof setTimeout> },
      cancel: (handle) => { cancelled.push(handle) },
    })

    // The window is open: this pass really runs and takes the throttle baseline.
    await reconciler.request(false)
    expect(driftCalls).toHaveLength(1)

    // Inside the window: exactly one trailing check is scheduled, no matter how many calls arrive.
    clock = 10_500
    await reconciler.request(false)
    await reconciler.request(false)
    expect(timers).toHaveLength(1)
    expect(timers[0]?.ms).toBe(1500)
    expect(driftCalls).toHaveLength(1)

    // Unmount: the trailing check is cancelled, and a later request (or the stale callback) does
    // nothing at all.
    reconciler.stop()
    expect(cancelled).toEqual([timers[0]])
    timers[0]?.fn()
    await reconciler.request(true)
    expect(driftCalls).toHaveLength(1)
    expect(reconciler.running).toBe(false)
  })

  it('routes a failed pass to onError, never rethrows, and clears `running`', async () => {
    const errors: unknown[] = []
    const reconciler = createCorpusReconciler({
      corpus: {
        sync: async () => { throw new Error('database is closed') },
        corpusDrift: () => ({ changed: [], missing: [], fileSetChanged: false }),
      },
      minIntervalMs: 0,
      onError: (error) => { errors.push(error) },
    } satisfies ReconcileDeps)

    await expect(reconciler.request(true)).resolves.toBeUndefined()
    expect((errors[0] as Error).message).toBe('database is closed')
    expect(reconciler.running).toBe(false)
  })
})
