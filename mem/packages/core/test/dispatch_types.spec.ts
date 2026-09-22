import { describe, it, expect } from 'vitest'
import type { MemoryStore } from '../src/store/memory.js'
import type { RecallHitsResult } from '../src/runtime.js'

/**
 * Type-level proofs for the dispatch types (DESIGN §20.10).
 *
 * `buildRuntime` returns `{ ...api, recall: api.recall as RecallDispatch, … }`, and an `as`
 * bypasses verification — so a dispatch overload that names the WRONG result type compiles
 * perfectly and then lies to every caller. That is how `related` was declared as
 * `Promise<RecallResult>` while answering with entity counts.
 *
 * Overloads tied to a single store method (`StoreResult<Store, 'method'>`) cannot drift. What
 * still can is a GROUPED overload — one that promises the same shape for several actions — and
 * that is what these assertions cover. They are ordinary `expect`s so the proof is a runnable
 * test, not a type alias a later cleanup might delete as unused.
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** The awaited result of a store method, mirroring `StoreResult` in `runtime.ts`. */
type Result<M extends keyof MemoryStore> = Awaited<ReturnType<Extract<MemoryStore[M], (...args: never[]) => unknown>>>

describe('dispatch types', () => {
  it('groups search/probe/chain/reason only because they really answer alike', () => {
    // `probe` and `search` are the same store call; `chain` and `reason` are separate methods
    // that the grouped overload also covers. If one of them changes shape, this goes red and the
    // overload has to be split (or the group narrowed) instead of silently promising the old one.
    const agree: [
      Same<Result<'search'>, RecallHitsResult>,
      Same<Result<'chain'>, RecallHitsResult>,
      Same<Result<'reason'>, RecallHitsResult>,
    ] = [true, true, true]
    expect(agree).toEqual([true, true, true])
  })

  it('keeps the store results that are NOT hits distinct from the hits group', () => {
    // The negative control, so `Same` cannot be vacuously true: `related` answers with entity
    // counts and `listContradictions` with log rows. If a future "simplification" widens the hits
    // group to cover them, these flip to `true` and the group has to be narrowed again.
    //
    // `ask` is deliberately NOT here: the STORE's `ask` really does return `RecallResult`, and
    // only the dispatch wrapper widens it (`| DispatchError` for the "neither query nor tuple"
    // case). That difference lives in the overload, not in this comparison.
    const distinct: [Same<Result<'related'>, RecallHitsResult>, Same<Result<'listContradictions'>, RecallHitsResult>] = [false, false]
    expect(distinct).toEqual([false, false])
  })
})
