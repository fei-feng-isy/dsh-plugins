/**
 * The shared retrieval orchestration (`store/hybrid.ts`).
 *
 * Both stores used to carry their own copy of this flow, and the copies drifted: the `NaN` limit
 * guard, `retriever.over_fetch_factor`, the capped-leg counter and the rerank flags each existed on
 * the memory side only. What is pinned here is therefore the behaviour that MUST be identical for
 * both stores — plus the leg isolation that neither had (a throwing leg used to take the whole query
 * down, because `Promise.all` has no per-leg catch on the read path).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetRetrievalHealth, retrievalHealth, setRetrievalLogger } from '@avantf/mem-core'
import type { Reranker, SemanticBackend } from '@avantf/mem-core'
import type { Config } from '@avantf/mem-contract'
import { loadConfig } from '../src/config/loader.js'
import {
  hybridSearch,
  RetrievalInputError,
  type HybridContext,
  type HybridDeps,
  type HybridLeg,
} from '../src/store/hybrid.js'

interface TestHit {
  id: number
  text: string
  score: number
}

const semantic: SemanticBackend = {
  name: 'fake',
  dim: 4,
  encode: async () => new Float32Array(4),
  encodeBatch: async () => [],
  isAvailable: () => true,
}

/** Unavailable, so `rerankHits` is a pass-through and the fused order is what the caller sees. */
const reranker: Reranker = {
  name: 'none',
  rerank: async (_query, candidates) => candidates.map((c) => c.id),
  isAvailable: () => false,
}

let dir: string
let config: Config
let warnings: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avf-hybrid-'))
  config = loadConfig({ dataHome: dir }).common
  warnings = []
  resetRetrievalHealth()
  setRetrievalLogger({
    info(): void {},
    warn(message: string): void { warnings.push(message) },
    error(): void {},
  })
})
afterEach(() => {
  setRetrievalLogger(undefined)
  resetRetrievalHealth()
  rmSync(dir, { recursive: true, force: true })
})

/** Deps whose legs are supplied per case; texts/hits are the trivial id→text mapping. */
function deps(
  legs: (ctx: HybridContext) => readonly (HybridLeg | Promise<HybridLeg>)[],
  onReturn?: (kept: readonly TestHit[]) => void,
): HybridDeps<TestHit> {
  return {
    kind: 'memory',
    config,
    semantic,
    reranker,
    legs: async (ctx) => legs(ctx),
    texts: (ids) => new Map(ids.map((id) => [id, `文本 ${String(id)}`])),
    hits: (ranked, texts) => ranked.map((h) => ({ id: h.id, text: texts.get(h.id) ?? '', score: h.score })),
    ...(onReturn === undefined ? {} : { onReturn }),
  }
}

function leg(scores: Record<number, number>, weight = 1, capped = false): HybridLeg {
  return { weight, scores: new Map(Object.entries(scores).map(([k, v]) => [Number(k), v])), ...(capped ? { capped } : {}) }
}

describe('hybridSearch', () => {
  it('fuses the legs and returns them best-first', async () => {
    const result = await hybridSearch(deps(() => [leg({ 1: 0.9, 2: 0.5 }), leg({ 2: 0.8, 3: 0.1 }, 0.5)]), { query: '查询' })
    expect(result.hits.map((h) => h.id)).toEqual([2, 1, 3])
    expect(result.degraded).toBe(false)
    expect(result.weights).toEqual({
      semantic: config.retriever.weight_semantic,
      fts: config.retriever.weight_fts,
      jaccard: config.retriever.weight_jaccard,
    })
  })

  it('isolates a leg that throws: the others still answer, and the failure is logged', async () => {
    // The read path had no per-leg catch (the write path did), so an inference-time failure — an ONNX
    // error, an OOM — cost the caller the FTS and entity legs as well.
    const result = await hybridSearch(
      deps(() => [leg({ 1: 0.9, 2: 0.5 }), Promise.reject(new Error('模型推理炸了'))]),
      { query: '查询' },
    )
    expect(result.hits.map((h) => h.id)).toEqual([1, 2])
    expect(warnings.join()).toContain('模型推理炸了')
    expect(warnings.join()).toContain('已跳过该腿')
  })

  it('isolates a failure in the leg SETUP, answering empty rather than throwing', async () => {
    const failing: HybridDeps<TestHit> = {
      ...deps(() => []),
      legs: async () => { throw new Error('实体抽取炸了') },
    }
    const result = await hybridSearch(failing, { query: '查询' })
    expect(result.hits).toEqual([])
    expect(warnings.join()).toContain('实体抽取炸了')
  })

  it('rethrows a caller input error instead of degrading away a misconfiguration', async () => {
    // A wrong-width query vector means the caller encoded with a DIFFERENT backend; answering from
    // the other legs would hide that for the rest of the session.
    const failing: HybridDeps<TestHit> = {
      ...deps(() => []),
      legs: async () => [Promise.reject(new RetrievalInputError('queryVector 维度不符：8 != 512'))],
    }
    await expect(hybridSearch(failing, { query: '查询' })).rejects.toThrow(/queryVector 维度不符/)
  })

  it('replaces a non-finite limit with the default instead of feeding it to a leg', async () => {
    // `NaN` reached a store's SQL `LIMIT` and threw, which took the whole cross-store query down
    // (`Promise.all` over both stores). The guard has to be here, not per store, because both stores
    // are awaited together.
    const seen: HybridContext[] = []
    const result = await hybridSearch(
      deps((ctx) => { seen.push(ctx); return [leg({ 1: 0.9 })] }),
      { query: '查询', limit: Number.NaN },
    )
    expect(seen[0].limit).toBe(10)
    expect(result.hits).toHaveLength(1)
  })

  it('derives the pool from the configured over-fetch factor, for both stores alike', async () => {
    // Knowledge used to hardcode `limit * 3` while memory read `over_fetch_factor`, so one knob meant
    // two different things.
    const seen: HybridContext[] = []
    await hybridSearch(deps((ctx) => { seen.push(ctx); return [] }), { query: '查询', limit: 4 })
    expect(seen[0].overFetch).toBe(4 * config.retriever.over_fetch_factor)
    // An explicit request still wins, and is never smaller than the limit.
    const explicit: HybridContext[] = []
    await hybridSearch(deps((ctx) => { explicit.push(ctx); return [] }), { query: '查询', limit: 4, overFetch: 2 })
    expect(explicit[0].overFetch).toBe(4)
  })

  it('hands the legs the degraded weights when the semantic backend is down', async () => {
    const seen: HybridContext[] = []
    const down: HybridDeps<TestHit> = {
      ...deps((ctx) => { seen.push(ctx); return [] }),
      semantic: { ...semantic, isAvailable: () => false },
    }
    const result = await hybridSearch(down, { query: '查询' })
    expect(seen[0].semAvail).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.weights).not.toEqual({
      semantic: config.retriever.weight_semantic,
      fts: config.retriever.weight_fts,
      jaccard: config.retriever.weight_jaccard,
    })
  })

  it('reports the effective floors and per-leg floor drops, and counts them in health', async () => {
    const result = await hybridSearch(deps(() => [
      { ...leg({ 1: 0.9 }), leg: 'semantic', droppedByFloor: 2 },
      { ...leg({ 2: 0.5 }), leg: 'fts', droppedByFloor: 1 },
      { ...leg({ 3: 0.4 }), leg: 'jaccard', droppedByFloor: 0 },
      // The HRR probe shares the Jaccard floor and is attributed separately without double-counting.
      { ...leg({ 4: 0.1 }), leg: 'hrr' },
    ]), { query: '查询' })
    expect(result.floors).toEqual({
      semantic: config.retriever.min_semantic_similarity,
      fts: config.retriever.min_fts_terms,
      jaccard: config.retriever.min_jaccard,
    })
    expect(result.dropped_by_floor).toEqual({ semantic: 2, fts: 1, jaccard: 0, hrr: 0 })
    expect(retrievalHealth().candidates_dropped_by_floor).toBe(3)
  })

  it('relaxes the FTS floor to 1 when the semantic backend is down (0 stays off)', async () => {
    const seen: HybridContext[] = []
    const down: HybridDeps<TestHit> = {
      ...deps((ctx) => { seen.push(ctx); return [] }),
      semantic: { ...semantic, isAvailable: () => false },
    }
    const result = await hybridSearch(down, { query: '查询' })
    expect(seen[0].floors.fts).toBe(1)
    expect(result.floors.fts).toBe(1)

    config.retriever.min_fts_terms = 0
    const off: HybridContext[] = []
    await hybridSearch({ ...down, legs: async (ctx) => { off.push(ctx); return [] } }, { query: '查询' })
    expect(off[0].floors.fts).toBe(0)
  })

  it('counts a leg that came back exactly at the cap', async () => {
    expect(retrievalHealth().legs_capped).toBe(0)
    await hybridSearch(deps(() => [leg({ 1: 0.9 }), leg({ 2: 0.5 }, 1, true)]), { query: '查询' })
    expect(retrievalHealth().legs_capped).toBe(1)
  })

  it('reports the retrieval event unless the caller is fusing legs into one question', async () => {
    await hybridSearch(deps(() => [leg({ 1: 0.9 })]), { query: '查询' })
    expect(retrievalHealth().queries).toBe(1)
    await hybridSearch(deps(() => [leg({ 1: 0.9 })]), { query: '查询', recordStats: false })
    expect(retrievalHealth().queries).toBe(1)
  })

  it('calls onReturn with what the caller RECEIVES, after the output budget', async () => {
    // Reinforcing the pre-budget list rewarded facts the caller never read: the budget empties the
    // tail it cannot afford, but their dormancy clock was refreshed and their trust bonus spent all
    // the same. `onReturn` sees the budgeted list, so a store can reinforce only what was delivered.
    let returned: readonly TestHit[] = []
    const many = Object.fromEntries(Array.from({ length: 40 }, (_unused, i) => [i + 1, 1 - i * 0.01]))
    const result = await hybridSearch(deps(() => [leg(many)], (kept) => { returned = kept }), {
      query: '查询',
      limit: 40,
      maxTokens: 30,
    })
    // The budget shortens rather than drops: every hit survives, the unaffordable tail emptied.
    expect(result.hits).toHaveLength(40)
    expect(result.used_tokens).toBeLessThanOrEqual(30)
    expect(result.hits.some((h) => h.truncated === true)).toBe(true)
    expect(result.hits.filter((h) => h.text === '').length).toBeGreaterThan(0)
    // The hook receives exactly the returned list — the budgeted one, not the ranked one.
    expect(returned).toBe(result.hits)
  })

  it('skips the budget pass entirely when it is unlimited', async () => {
    const result = await hybridSearch(deps(() => [leg({ 1: 0.9, 2: 0.5 })]), { query: '查询', maxTokens: 0 })
    expect(result.used_tokens).toBe(0)
    expect(result.hits).toHaveLength(2)
  })
})
