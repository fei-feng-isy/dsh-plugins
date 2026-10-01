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
 *   - BOTH stores apply the same rule and report the same effective values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecallHit, RecallResult } from '@avantf/mem-contract'
import type { SemanticBackend } from '@avantf/mem-core'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import {
  applyScoreFloor,
  applyTermFloor,
  countMatchedTerms,
  mergeFloorDrops,
  passesFloor,
  resolveFloors,
  totalFloorDrops,
} from '../src/store/floors.js'
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
      const none = await memSearch(rt, 'zzzzz', 2)
      expect(none.hits).toHaveLength(0)
      expect(none.dropped_by_floor?.semantic).toBe(3)
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
      expect(floored.result.floors).toEqual({ semantic: 0.5, fts: 2, jaccard: 0.2 })
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

  it('distinguishes "the floors removed every candidate" from "there was no candidate"', async () => {
    // The whole point of reporting `dropped_by_floor` next to the hits: an empty result has two
    // readings an operator must be able to tell apart.
    const fake = fakeSemantic({ zzzzz: unitWithCos(1, 1) }) // facts default to `e1` ⇒ cosine 0
    const rt = buildRuntime({ dataHome: dir, semantic: fake.backend })
    try {
      const noCandidates = await memSearch(rt, 'zzzzz', 5)
      expect(noCandidates.hits).toHaveLength(0)
      expect(noCandidates.dropped_by_floor).toEqual({ semantic: 0, fts: 0, jaccard: 0, hrr: 0 })
      expect(noCandidates.floors).toEqual({ semantic: 0.5, fts: 2, jaccard: 0.2 })
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

async function memSearch(rt: AvantfRuntime, query: string, limit: number): Promise<RecallResult> {
  return await rt.recall({ action: 'search', query, limit }) as RecallResult
}

function textsOf(hits: RecallResult['hits']): string[] {
  return hits.map((h) => h.text)
}

async function ingest(rt: AvantfRuntime, text: string, source: string): Promise<void> {
  await rt.kb({ action: 'ingest', text, domain: 'tech', source, title: source })
}

async function kbSearch(rt: AvantfRuntime, query: string, limit: number): Promise<{ hits: RecallHit[]; result: HybridResult<RecallHit> }> {
  let result: HybridResult<RecallHit> | undefined
  const hits = await rt.knowledge.search(query, { limit, onResult: (r) => { result = r } })
  if (result === undefined) throw new Error('onResult was not called')
  return { hits, result }
}
