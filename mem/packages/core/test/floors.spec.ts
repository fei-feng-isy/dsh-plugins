/**
 * Relevance floors (`retriever.min_semantic_similarity` / `min_fts_terms` / `min_jaccard`).
 *
 * The floors are absolute cutoffs on each leg's OWN raw score, applied before fusion — the fused
 * score is per-query relative (see `store/floors.ts`), so a threshold there would mean a different
 * thing every query. What is pinned here:
 *
 *   - `0` = that leg is off (the escape hatch), for every floor;
 *   - a candidate EQUAL to its floor is KEPT (only strictly-lower is dropped);
 *   - the FTS floor is judged PER ROW (distinct query terms the row hits), not per query;
 *   - with the semantic backend down the FTS floor's effective value relaxes to 1, and a configured
 *     `0` stays off;
 *   - an OMITTED profile runs one relaxed pass when the strict pass returned nothing while having
 *     dropped candidates (the 「我是谁」 fix: the answering fact scored 0.444 against a 0.5 floor);
 *     an explicit `'strict'` / `'loose'` profile suppresses that retry, and a retry that changes
 *     nothing leaves the strict (bit-identical) result in place;
 *   - the relaxed floors are 0.40 / 1 / 0 — ABOVE the measured unrelated-query ceiling (0.384), so a
 *     genuinely unrelated question still comes back empty under both profiles;
 *   - the FTS bar is clamped to the terms the query can actually produce, so a 3-char CJK query (one
 *     trigram) is not judged against an unreachable `min_fts_terms: 2`;
 *   - BOTH stores apply the same rule and report the same effective values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FloorProfile, RecallHit, RecallResult } from '@avantf/mem-contract'
import type { SemanticBackend } from '@avantf/mem-core'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import {
  LOOSE_FLOORS,
  applyScoreFloor,
  applyTermFloor,
  countMatchedTerms,
  effectiveTermFloor,
  mergeFloorDrops,
  passesFloor,
  resolveFloors,
  totalFloorDrops,
} from '../src/store/floors.js'
import { relevanceTerms } from '../src/store/lexical.js'
import type { HybridResult } from '../src/store/hybrid.js'
import { allowAnyDomain } from './helpers.js'

const DIM = 512

/** A unit vector whose dot product with `e0` is exactly `cos`. */
function unitWithCos(cos: number, index: number): Float32Array {
  const v = new Float32Array(DIM)
  v[0] = cos
  v[index] = Math.sqrt(Math.max(0, 1 - cos * cos))
  return v
}

const DEFAULT_VEC = unitWithCos(0, 1)

/** A deterministic in-memory embedder: known texts map to known cosines, everything else to `e1`. */
function fakeSemantic(vectors: Record<string, Float32Array>): {
  backend: SemanticBackend
  setAvailable(value: boolean): void
} {
  let available = true
  const encode = async (text: string): Promise<Float32Array> => vectors[text] ?? DEFAULT_VEC
  return {
    backend: {
      name: 'fake',
      dim: DIM,
      encode,
      encodeBatch: async (texts: string[]) => Promise.all(texts.map((t) => encode(t))),
      isAvailable: () => available,
    },
    setAvailable: (value: boolean) => { available = value },
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-floors-'))
  allowAnyDomain(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('store/floors (pure)', () => {
  it('resolveFloors relaxes the FTS floor to 1 only when the semantic leg is down', () => {
    const retriever = { min_semantic_similarity: 0.5, min_fts_terms: 2, min_jaccard: 0.2 }
    expect(resolveFloors(retriever, true)).toEqual({ semantic: 0.5, fts: 2, jaccard: 0.2 })
    expect(resolveFloors(retriever, false)).toEqual({ semantic: 0.5, fts: 1, jaccard: 0.2 })
    // 0 is the operator's escape hatch and survives the relaxation.
    expect(resolveFloors({ ...retriever, min_fts_terms: 0 }, false).fts).toBe(0)
    // A higher configured bar still relaxes to exactly 1, not to its own value.
    expect(resolveFloors({ ...retriever, min_fts_terms: 4 }, false).fts).toBe(1)
  })

  it('passesFloor keeps EQUAL scores and treats 0 as off', () => {
    expect(passesFloor(0.2, 0)).toBe(true)
    expect(passesFloor(0, 0)).toBe(true)
    expect(passesFloor(0.2, 0.2)).toBe(true)
    expect(passesFloor(0.1999, 0.2)).toBe(false)
  })

  it('effectiveTermFloor clamps the FTS bar to the terms the query can produce', () => {
    // A 3-char CJK query is ONE trigram, so a configured bar of 2 was unreachable: the leg was empty
    // for that query by construction, not because the store held nothing.
    expect(relevanceTerms('网关是')).toHaveLength(1)
    expect(effectiveTermFloor(2, 1)).toBe(1)
    expect(effectiveTermFloor(2, 3)).toBe(2)
    // Not graded at all: `applyTermFloor` returns the set untouched and must keep reporting the
    // configured value (clamping it to 0 here would misdescribe what the caller reads).
    expect(effectiveTermFloor(2, 0)).toBe(2)
    expect(effectiveTermFloor(2, undefined)).toBe(2)
    // 0 is the off switch and survives the clamp.
    expect(effectiveTermFloor(0, 1)).toBe(0)
  })

  it('resolveFloors: explicit profiles are strict/relaxed, and FTS is clamped', () => {
    const retriever = { min_semantic_similarity: 0.5, min_fts_terms: 2, min_jaccard: 0.2 }
    // The two explicit profiles. The relaxed semantic bar sits ABOVE the measured unrelated-query
    // ceiling (0.384) and BELOW the pronoun-query top-1 (0.444): the pass must still be able to say
    // "nothing relevant", or the 4 unrelated samples would stop being empty under it.
    expect(resolveFloors(retriever, true, { profile: 'strict' })).toEqual({ semantic: 0.5, fts: 2, jaccard: 0.2 })
    expect(resolveFloors(retriever, true, { profile: 'loose' })).toEqual(LOOSE_FLOORS)
    expect(LOOSE_FLOORS.semantic).toBeGreaterThan(0.384)
    expect(LOOSE_FLOORS.semantic).toBeLessThan(0.444)
    // The relaxed pass can only RELAX: a leg the operator turned off (0) stays off, not gated at 0.4.
    expect(resolveFloors({ ...retriever, min_semantic_similarity: 0, min_jaccard: 0 }, true, { profile: 'loose' }))
      .toEqual({ semantic: 0, fts: 1, jaccard: 0 })
    // The reported FTS bar is the one the leg applies.
    expect(resolveFloors(retriever, true, { termCount: 1 }).fts).toBe(1)
    expect(resolveFloors(retriever, true, { profile: 'loose', termCount: 1 }).fts).toBe(1)
    // Degraded relaxation still comes first, and the clamp never raises it back.
    expect(resolveFloors(retriever, false, { termCount: 1 })).toEqual({ semantic: 0.5, fts: 1, jaccard: 0.2 })
  })

  it('applyScoreFloor drops strictly-lower entries, counts them, and is a no-op at 0', () => {
    const scores = new Map([[1, 0.7], [2, 0.5], [3, 0.499]])
    const off = applyScoreFloor(scores, 0)
    expect(off.dropped).toBe(0)
    expect(off.scores).toBe(scores) // untouched, not copied
    const floored = applyScoreFloor(scores, 0.5)
    expect([...floored.scores.keys()]).toEqual([1, 2]) // 0.5 == floor is kept
    expect(floored.dropped).toBe(1)
  })

  it('counts DISTINCT query terms per row (latin case-insensitively, CJK 3-grams)', () => {
    expect(countMatchedTerms('Write Gateway Config', ['write', 'gateway'])).toBe(2)
    expect(countMatchedTerms('gateway only', ['write', 'gateway'])).toBe(1)
    expect(countMatchedTerms('支付网关是入口', ['支付网', '付网关', '网关是'])).toBe(3)
    expect(countMatchedTerms('支付网关是入口', ['支付网', '付网关', '不存在的三元组'])).toBe(2)
    expect(countMatchedTerms('', ['write'])).toBe(0)
  })

  it('applyTermFloor is PER ROW, keeps an exact match, and skips a query with no usable terms', () => {
    const scores = new Map([[1, -1], [2, -2], [3, -3]])
    const texts = new Map([[1, 'write gateway config'], [2, 'gateway endpoint'], [3, 'write backlog']])
    const floored = applyTermFloor(scores, texts, 'write gateway', 2)
    expect([...floored.scores.keys()]).toEqual([1])
    expect(floored.dropped).toBe(2)
    // A query with NO relevance-grade term (`relevanceTerms` is empty) is not graded at all.
    const skipped = applyTermFloor(scores, texts, 'ok', 2)
    expect(skipped.dropped).toBe(0)
    expect(skipped.scores).toBe(scores)
    // 0 = off.
    expect(applyTermFloor(scores, texts, 'write gateway', 0).scores).toBe(scores)
  })

  it('applyTermFloor: a one-term CJK query is graded against that term, not an unreachable bar', () => {
    // THE STRUCTURAL BUG. `min_fts_terms: 2` asks for two distinct query terms, but 「网关是」 is one
    // trigram — the bar was unreachable and this leg was empty for every 3-char CJK query no matter
    // what the store held. The clamp makes the effective bar `min(configured, termCount)`.
    expect(relevanceTerms('网关是')).toHaveLength(1)
    const scores = new Map([[1, -1], [2, -2]])
    const texts = new Map([[1, '支付网关是入口'], [2, '网关头']])
    const floored = applyTermFloor(scores, texts, '网关是', 2)
    expect([...floored.scores.keys()]).toEqual([1]) // 2 would have dropped the only reachable row too
    expect(floored.dropped).toBe(1)
    // A query with two terms keeps the configured bar.
    expect(applyTermFloor(new Map([[1, -1]]), new Map([[1, 'gateway only']]), 'write gateway', 2).dropped).toBe(1)
  })

  it('mergeFloorDrops/totalFloorDrops sum per leg and tolerate absent reports', () => {
    const merged = mergeFloorDrops(
      { semantic: 1, fts: 2, jaccard: 0, hrr: 0 },
      undefined,
      { semantic: 0, fts: 0, jaccard: 3, hrr: 1 },
    )
    expect(merged).toEqual({ semantic: 1, fts: 2, jaccard: 3, hrr: 1 })
    expect(totalFloorDrops(merged)).toBe(7)
  })
})

describe('the floors through BOTH stores', () => {
  it('memory: the semantic floor drops below, keeps equal, and 0 is off', async () => {
    const fake = fakeSemantic({
      zzzzz: unitWithCos(1, 1),
      aaaaa: unitWithCos(0.5, 1),
      bbbbb: unitWithCos(0.49, 2),
      ccccc: unitWithCos(0.7, 3),
    })
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      const ids: number[] = []
      for (const text of ['aaaaa', 'bbbbb', 'ccccc']) ids.push((await rt.remember({ action: 'add', content: text })).fact_id)
      setWeights(rt, { semantic: 1, fts: 0, jaccard: 0 })

      setFloors(rt, { semantic: 0 })
      const all = await memSearch(rt, 'zzzzz', 3)
      expect(all.dropped_by_floor?.semantic).toBe(0)
      expect(textsOf(all.hits)).toEqual(['ccccc', 'aaaaa', 'bbbbb'])

      setFloors(rt, { semantic: 0.5 })
      const kept = await memSearch(rt, 'zzzzz', 2)
      expect(kept.floors?.semantic).toBe(0.5)
      expect(kept.dropped_by_floor?.semantic).toBe(1) // 0.49 < 0.5
      expect(textsOf(kept.hits)).toEqual(['ccccc', 'aaaaa']) // 0.5 == floor survives

      // `min_semantic_similarity` is a float32 cosine, so "equal" is only exact for values a
      // float32 can hold (0.5 above); the predicate itself is pinned by `passesFloor`. What this
      // step proves is the shape: raising the bar to 0.6 drops the 0.5 candidate, keeps 0.7.
      setFloors(rt, { semantic: 0.6 })
      const higher = await memSearch(rt, 'zzzzz', 2)
      expect(textsOf(higher.hits)).toEqual(['ccccc'])
      expect(higher.dropped_by_floor?.semantic).toBe(2)

      setFloors(rt, { semantic: 0.71 })
      // Explicit `strict`: no automatic relaxed pass, so the honest "the floors removed all three"
      // answer comes back. The OMITTED profile would retry at 0.40 and recover them (pinned by the
      // retry tests below) — which is exactly why the UI sends a profile explicitly.
      const none = await memSearch(rt, 'zzzzz', 2, 'strict')
      expect(none.hits).toHaveLength(0)
      expect(none.dropped_by_floor?.semantic).toBe(3)
      expect(none.relaxed).toBeUndefined()
    } finally {
      rt.shutdown()
    }
  })

  it('memory: an OMITTED profile relaxes ONCE when the strict floors empty the result', async () => {
    const fake = fakeSemantic({
      zzzzz: unitWithCos(1, 1),
      aaaaa: unitWithCos(0.44, 1), // above the relaxed bar (0.40)
      bbbbb: unitWithCos(0.3, 2), // below it
    })
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      for (const text of ['aaaaa', 'bbbbb']) await rt.remember({ action: 'add', content: text })
      setWeights(rt, { semantic: 1, fts: 0, jaccard: 0 })
      setFloors(rt, { semantic: 0.5 })

      const strict = await memSearch(rt, 'zzzzz', 5, 'strict')
      expect(strict.hits).toHaveLength(0)
      // `fts` is 1, not the configured 2: 「zzzzz」 is ONE latin term, and the reported floors are the
      // values actually applied (the reachability clamp). The 35-query eval comment and DESIGN §20.19
      // record the same movement.
      expect(strict.floors).toEqual({ semantic: 0.5, fts: 1, jaccard: 0.2 })
      expect(strict.dropped_by_floor?.semantic).toBe(2)
      expect(strict.relaxed).toBeUndefined()

      // The default policy retries once at 0.40: 0.44 comes back, 0.30 does not. The reported floors
      // and drops are the RELAXED pass's — the values actually applied to these hits.
      const relaxed = await memSearch(rt, 'zzzzz', 5)
      expect(textsOf(relaxed.hits)).toEqual(['aaaaa'])
      expect(relaxed.relaxed).toBe(true)
      expect(relaxed.floors?.semantic).toBe(0.4)
      expect(relaxed.dropped_by_floor?.semantic).toBe(1)

      // An explicit `loose` produces the same hits but is NOT marked `relaxed`: the caller asked for
      // the relaxed profile, so nothing was relaxed behind its back.
      const loose = await memSearch(rt, 'zzzzz', 5, 'loose')
      expect(textsOf(loose.hits)).toEqual(['aaaaa'])
      expect(loose.relaxed).toBeUndefined()
      expect(loose.floors?.semantic).toBe(0.4)
    } finally {
      rt.shutdown()
    }
  })

  it('memory: a retry that changes nothing returns the STRICT result untouched', async () => {
    // 0.30 is below even the relaxed bar (0.40), so the second pass cannot help. Returning the strict
    // result is what keeps an empty query bit-identical to what it was before the retry rule existed
    // — including its honest "the floors removed N" report.
    const fake = fakeSemantic({ qqqqq: unitWithCos(1, 1), aaaaa: unitWithCos(0.3, 1) })
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      await rt.remember({ action: 'add', content: 'aaaaa' })
      setWeights(rt, { semantic: 1, fts: 0, jaccard: 0 })
      setFloors(rt, { semantic: 0.5 })
      const omitted = await memSearch(rt, 'qqqqq', 5)
      const strict = await memSearch(rt, 'qqqqq', 5, 'strict')
      expect(omitted).toEqual(strict)
      expect(omitted.relaxed).toBeUndefined()
      expect(omitted.dropped_by_floor?.semantic).toBe(1)
    } finally {
      rt.shutdown()
    }
  })

  it('memory: the measured 「我是谁」 band — unrelated samples stay empty in BOTH profiles', async () => {
    // The calibration this rule is built on, reproduced exactly: the fact that answers 「我是谁」
    // scores 0.444 against it, while the four unrelated samples top out at 0.384. The fake embedder
    // puts the fact on e0 and each query on its OWN orthogonal axis, so the dot products are the
    // measured cosines.
    const fact = '用户的名字是冯飞。'
    const fake = fakeSemantic({
      [fact]: unitWithCos(1, 1),
      '我是谁': unitWithCos(0.444, 1),
      '我的名字': unitWithCos(0.6, 1),
      '如何给三文鱼去骨': unitWithCos(0.3, 2),
      '量子色动力学里的渐近自由': unitWithCos(0.384, 3),
      '宋朝科举制度的演变': unitWithCos(0.315, 4),
      '怎么训练边牧接飞盘': unitWithCos(0.351, 5),
    })
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      await rt.remember({ action: 'add', content: fact })
      setWeights(rt, { semantic: 1, fts: 0, jaccard: 0 })
      setFloors(rt, { semantic: 0.5, fts: 2, jaccard: 0.2 })

      for (const unrelated of ['如何给三文鱼去骨', '量子色动力学里的渐近自由', '宋朝科举制度的演变', '怎么训练边牧接飞盘']) {
        const strict = await memSearch(rt, unrelated, 5, 'strict')
        const omitted = await memSearch(rt, unrelated, 5)
        const loose = await memSearch(rt, unrelated, 5, 'loose')
        expect(strict.hits, unrelated).toHaveLength(0)
        expect(loose.hits, unrelated).toHaveLength(0)
        // The relaxed bar (0.40) is above the 0.384 ceiling, so the default policy finds nothing on
        // its retry and hands back the strict result unchanged.
        expect(omitted, unrelated).toEqual(strict)
      }

      // A query that CLEARS the strict floors is never retried, so its result set is exactly what it
      // was before this rule existed (no archive tail, no extra candidates).
      const relatedOmitted = await memSearch(rt, '我的名字', 5)
      const relatedStrict = await memSearch(rt, '我的名字', 5, 'strict')
      expect(textsOf(relatedOmitted.hits)).toEqual([fact])
      expect(relatedOmitted).toEqual(relatedStrict)
      expect(relatedOmitted.relaxed).toBeUndefined()

      // 「我是谁」: empty strict (0.444 < 0.5), answered by the relaxed pass (0.444 >= 0.40).
      const strict = await memSearch(rt, '我是谁', 5, 'strict')
      expect(strict.hits).toHaveLength(0)
      expect(strict.dropped_by_floor?.semantic).toBe(1)
      expect(textsOf((await memSearch(rt, '我是谁', 5, 'loose')).hits)).toEqual([fact])
      const omitted = await memSearch(rt, '我是谁', 5)
      expect(textsOf(omitted.hits)).toEqual([fact])
      expect(omitted.relaxed).toBe(true)
      expect(omitted.floors?.semantic).toBe(0.4)
    } finally {
      rt.shutdown()
    }
  })

  it('memory: the FTS floor is per ROW, and the degraded bar is 1', async () => {
    const fake = fakeSemantic({})
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      for (const text of ['write gateway config', 'gateway endpoint', 'write backlog']) {
        await rt.remember({ action: 'add', content: text })
      }
      setWeights(rt, { semantic: 0, fts: 1, jaccard: 0 })
      setFloors(rt, { semantic: 0, fts: 2, jaccard: 0 })

      const strict = await memSearch(rt, 'write gateway', 1)
      expect(strict.floors?.fts).toBe(2)
      // Only the row hitting BOTH distinct terms survives; each one-term row is a separate drop.
      expect(strict.dropped_by_floor?.fts).toBe(2)
      expect(textsOf(strict.hits)).toEqual(['write gateway config'])

      setFloors(rt, { fts: 1 })
      const relaxed = await memSearch(rt, 'write gateway', 3)
      expect(relaxed.dropped_by_floor?.fts).toBe(0)
      expect(textsOf(relaxed.hits).sort()).toEqual(['gateway endpoint', 'write backlog', 'write gateway config'])

      // Semantic down: the CONFIGURED 2 is relaxed to 1 (not left at 2), 0 stays off.
      setFloors(rt, { fts: 2 })
      fake.setAvailable(false)
      const degraded = await memSearch(rt, 'write gateway', 3)
      expect(degraded.degraded).toBe(true)
      expect(degraded.floors?.fts).toBe(1)
      expect(degraded.dropped_by_floor?.fts).toBe(0)
      setFloors(rt, { fts: 0 })
      expect((await memSearch(rt, 'write gateway', 3)).floors?.fts).toBe(0)
    } finally {
      rt.shutdown()
    }
  })

  it('memory: a 3-char CJK query is graded against its ONE trigram, not an unreachable 2', async () => {
    const fake = fakeSemantic({})
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      await rt.remember({ action: 'add', content: '支付网关是入口' })
      await rt.remember({ action: 'add', content: '网关头' })
      setWeights(rt, { semantic: 0, fts: 1, jaccard: 0 })
      // The semantic backend is LIVE (the fake is available), so the configured 2 is NOT degraded to
      // 1 — the reachability clamp is the only thing that can make this leg answer.
      setFloors(rt, { semantic: 0.5, fts: 2, jaccard: 0.2 })

      const result = await memSearch(rt, '网关是', 5, 'strict')
      expect(relevanceTerms('网关是')).toHaveLength(1)
      // Reported as APPLIED (clamped to the one reachable trigram), not as configured.
      expect(result.floors?.fts).toBe(1)
      // Every row that reaches the FTS leg matched its own single term, so the clamped bar drops
      // none of them; the pre-fix bar of 2 dropped all of them and emptied the leg.
      expect(result.dropped_by_floor?.fts).toBe(0)
      expect(result.hits[0]?.text).toBe('支付网关是入口')

      // 0 is still "off" (the clamp must not raise it to 1).
      setFloors(rt, { fts: 0 })
      expect((await memSearch(rt, '网关是', 5, 'strict')).floors?.fts).toBe(0)
    } finally {
      rt.shutdown()
    }
  })

  it('memory: the Jaccard floor drops a below-floor neighbour and keeps an exact match', async () => {
    const fake = fakeSemantic({})
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      const texts = ['alpha beta gamma', 'alpha delta epsilon zeta', 'alpha beta delta epsilon', 'alpha delta epsilon']
      for (const text of texts) await rt.remember({ action: 'add', content: text })
      setWeights(rt, { semantic: 0, fts: 0, jaccard: 1 })
      setFloors(rt, { semantic: 0, fts: 0, jaccard: 0.2 })

      // Query entities {alpha,beta,gamma}: A = 1.0, B = 1/6, C = 0.4, D = 1/5 == the floor.
      const result = await memSearch(rt, 'alpha beta gamma', 3)
      expect(result.floors?.jaccard).toBe(0.2)
      expect(result.dropped_by_floor?.jaccard).toBe(1) // only B (0.1667) is below
      expect(textsOf(result.hits)).toEqual(['alpha beta gamma', 'alpha beta delta epsilon', 'alpha delta epsilon'])

      setFloors(rt, { jaccard: 0 })
      const off = await memSearch(rt, 'alpha beta gamma', 1)
      expect(off.dropped_by_floor?.jaccard).toBe(0)
      expect(textsOf(off.hits)).toEqual(['alpha beta gamma'])
    } finally {
      rt.shutdown()
    }
  })

  it('knowledge: the same floors apply, report the same effective values, and relax identically', async () => {
    const fake = fakeSemantic({
      zzzzz: unitWithCos(1, 1),
      aaaaa: unitWithCos(0.5, 1),
      bbbbb: unitWithCos(0.49, 2),
      ccccc: unitWithCos(0.7, 3),
    })
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      await ingest(rt, 'aaaaa', 'a.md')
      await ingest(rt, 'bbbbb', 'b.md')
      await ingest(rt, 'ccccc', 'c.md')
      setWeights(rt, { semantic: 1, fts: 0, jaccard: 0 })
      setFloors(rt, { semantic: 0.5, fts: 2, jaccard: 0.2 })

      const floored = await kbSearch(rt, 'zzzzz', 2)
      // `fts` is 1 because 「zzzzz」 is a single latin term: the reported value is the clamped one.
      expect(floored.result.floors).toEqual({ semantic: 0.5, fts: 1, jaccard: 0.2 })
      expect(floored.result.dropped_by_floor?.semantic).toBe(1)
      expect(floored.hits.map((h) => h.text)).toEqual(['ccccc', 'aaaaa'])

      // Per-row FTS floor on the knowledge side.
      await ingest(rt, 'write gateway config', 'w1.md')
      await ingest(rt, 'gateway endpoint', 'w2.md')
      await ingest(rt, 'write backlog', 'w3.md')
      setWeights(rt, { semantic: 0, fts: 1, jaccard: 0 })
      setFloors(rt, { semantic: 0, fts: 2, jaccard: 0 })
      const strict = await kbSearch(rt, 'write gateway', 1)
      expect(strict.result.dropped_by_floor?.fts).toBe(2)
      expect(strict.hits.map((h) => h.text)).toEqual(['write gateway config'])

      // Degraded: the configured 2 becomes 1 for the knowledge store too.
      fake.setAvailable(false)
      const degraded = await kbSearch(rt, 'write gateway', 3)
      expect(degraded.result.floors?.fts).toBe(1)
      expect(degraded.result.dropped_by_floor?.fts).toBe(0)
      expect(degraded.hits.length).toBeGreaterThanOrEqual(3)
    } finally {
      rt.shutdown()
    }
  })

  it('knowledge: the same retry rule applies (ONE relaxed pass when strict is empty)', async () => {
    const fake = fakeSemantic({
      zzzzz: unitWithCos(1, 1),
      aaaaa: unitWithCos(0.44, 1),
      bbbbb: unitWithCos(0.3, 2),
    })
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      await ingest(rt, 'aaaaa', 'a.md')
      await ingest(rt, 'bbbbb', 'b.md')
      setWeights(rt, { semantic: 1, fts: 0, jaccard: 0 })
      setFloors(rt, { semantic: 0.5, fts: 2, jaccard: 0.2 })

      const strict = await kbSearch(rt, 'zzzzz', 5, 'strict')
      expect(strict.hits).toHaveLength(0)
      expect(strict.result.floors?.semantic).toBe(0.5)
      expect(strict.result.dropped_by_floor?.semantic).toBe(2)

      const relaxed = await kbSearch(rt, 'zzzzz', 5)
      expect(relaxed.hits.map((h) => h.text)).toEqual(['aaaaa'])
      expect(relaxed.result.relaxed).toBe(true)
      expect(relaxed.result.floors?.semantic).toBe(0.4)
    } finally {
      rt.shutdown()
    }
  })

  it('distinguishes "the floors removed every candidate" from "there was no candidate"', async () => {
    // The whole point of reporting `dropped_by_floor` next to the hits: an empty result has two
    // readings an operator must be able to tell apart.
    const fake = fakeSemantic({ zzzzz: unitWithCos(1, 1) }) // facts default to `e1` ⇒ cosine 0
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      const noCandidates = await memSearch(rt, 'zzzzz', 5)
      expect(noCandidates.hits).toHaveLength(0)
      expect(noCandidates.dropped_by_floor).toEqual({ semantic: 0, fts: 0, jaccard: 0, hrr: 0 })
      // `fts` 1 = the clamped bar for a one-term query (see the reachability tests above).
      expect(noCandidates.floors).toEqual({ semantic: 0.5, fts: 1, jaccard: 0.2 })
      setWeights(rt, { semantic: 1, fts: 0, jaccard: 0 })

      await rt.remember({ action: 'add', content: 'aaaaa' })
      const floored = await memSearch(rt, 'zzzzz', 5)
      expect(floored.hits).toHaveLength(0)
      expect(floored.dropped_by_floor?.semantic).toBe(1)
    } finally {
      rt.shutdown()
    }
  })

  it('cross-store: the same query reports the SAME effective floors on both stores', async () => {
    const fake = fakeSemantic({ zzzzz: unitWithCos(1, 1), aaaaa: unitWithCos(0.5, 1) })
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      await rt.remember({ action: 'add', content: 'aaaaa' })
      await ingest(rt, 'aaaaa', 'a.md')
      setWeights(rt, { semantic: 1, fts: 0, jaccard: 0 })
      setFloors(rt, { semantic: 0.5, fts: 2, jaccard: 0.2 })
      const memory = await memSearch(rt, 'zzzzz', 2)
      const knowledge = await kbSearch(rt, 'zzzzz', 2)
      expect(knowledge.result.floors).toEqual(memory.floors)

      fake.setAvailable(false)
      const degradedMemory = await memSearch(rt, 'zzzzz', 2)
      const degradedKnowledge = await kbSearch(rt, 'zzzzz', 2)
      expect(degradedKnowledge.result.floors).toEqual(degradedMemory.floors)
      expect(degradedMemory.floors?.fts).toBe(1)
    } finally {
      rt.shutdown()
    }
  })

  it('cross-store: the retry is decided on the MERGED result, never per store', async () => {
    // The knowledge side has a strong (strict-passing) hit and the memory side only a weak one. If
    // each store retried on its own, the memory leg would inject its relaxed fact into an answer the
    // knowledge leg filled strictly — the "archive in the tail" defect. The merged result is
    // non-empty, so no retry happens and the memory fact stays out.
    const fake = fakeSemantic({
      zzzzz: unitWithCos(1, 1),
      aaaaa: unitWithCos(0.44, 1), // memory fact: below the 0.5 strict floor
      ddddd: unitWithCos(0.7, 2), // knowledge chunk: clears it
    })
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      await rt.remember({ action: 'add', content: 'aaaaa' })
      await ingest(rt, 'ddddd', 'd.md')
      setWeights(rt, { semantic: 1, fts: 0, jaccard: 0 })
      setFloors(rt, { semantic: 0.5, fts: 2, jaccard: 0.2 })

      // A: the knowledge chunk clears the strict floors, so the MERGED result is non-empty and no
      // retry runs — the memory leg's weak fact stays out of the answer entirely.
      const merged = await rt.query({ query: 'zzzzz', limit: 10, domain: 'tech' })
      expect(merged.hits.map((h) => h.text)).toEqual(['ddddd'])
      expect(merged.relaxed).toBeUndefined()
      expect(merged.floors?.semantic).toBe(0.5)

      // B: memory only. The merged strict result is empty (the chunk is filtered out by `kind`) and
      // the memory leg reports a floored candidate, so the runtime runs ONE relaxed cross pass.
      const relaxed = await rt.query({ query: 'zzzzz', limit: 10, kind: 'fact' })
      expect(relaxed.hits.map((h) => h.text)).toEqual(['aaaaa'])
      expect(relaxed.relaxed).toBe(true)
      expect(relaxed.floors?.semantic).toBe(0.4)

      // C: an explicit strict profile suppresses the retry on the cross-store path too.
      const strict = await rt.query({ query: 'zzzzz', limit: 10, kind: 'fact', floors: 'strict' })
      expect(strict.hits).toHaveLength(0)
      expect(strict.relaxed).toBeUndefined()
      expect(strict.floors?.semantic).toBe(0.5)
    } finally {
      rt.shutdown()
    }
  })
})

// ─── helpers ───────────────────────────────────────────────────────────────

function setWeights(rt: AvantfRuntime, weights: { semantic: number; fts: number; jaccard: number }): void {
  Object.assign(rt.config.common.retriever, {
    weight_semantic: weights.semantic,
    weight_fts: weights.fts,
    weight_jaccard: weights.jaccard,
  })
}

function setFloors(rt: AvantfRuntime, floors: { semantic?: number; fts?: number; jaccard?: number }): void {
  if (floors.semantic !== undefined) rt.config.common.retriever.min_semantic_similarity = floors.semantic
  if (floors.fts !== undefined) rt.config.common.retriever.min_fts_terms = floors.fts
  if (floors.jaccard !== undefined) rt.config.common.retriever.min_jaccard = floors.jaccard
}

async function memSearch(rt: AvantfRuntime, query: string, limit: number, floors?: FloorProfile): Promise<RecallResult> {
  return await rt.recall({ action: 'search', query, limit, ...(floors === undefined ? {} : { floors }) }) as RecallResult
}

function textsOf(hits: RecallResult['hits']): string[] {
  return hits.map((h) => h.text)
}

async function ingest(rt: AvantfRuntime, text: string, source: string): Promise<void> {
  await rt.kb({ action: 'ingest', text, domain: 'tech', source, title: source })
}

async function kbSearch(
  rt: AvantfRuntime,
  query: string,
  limit: number,
  floors?: FloorProfile,
): Promise<{ hits: RecallHit[]; result: HybridResult<RecallHit> }> {
  let result: HybridResult<RecallHit> | undefined
  const hits = await rt.knowledge.search(query, { limit, ...(floors === undefined ? {} : { floors }), onResult: (r) => { result = r } })
  if (result === undefined) throw new Error('onResult was not called')
  return { hits, result }
}
