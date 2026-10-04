/**
 * 方案 A / A② — query-side self-reference rewriting (`store/self_query.ts`), its AUGMENTATION in
 * `store/hybrid.ts`, and the conditional hint's reuse of the same table (`runtime.relevance`).
 *
 * The frozen eval sentinel (`eval_zh.spec.ts`) proves the END-TO-END effect on the pathological
 * fixture. This file pins the pieces that fixture cannot see up close:
 *
 *   - the closed table itself (one canonical rewrite per intent, `undefined` otherwise);
 *   - "augment, never replace": each leg's raw scores are UNIONED (max), and a disabled table is the
 *     pre-A path;
 *   - "never narrows": a MISCONFIGURED table (one that matches a non-self query too) can only ADD
 *     candidates — every hit the original query produced is still there;
 *   - "non-self queries unchanged": a handful of queries drawn from the frozen set produce identical
 *     ids / order / scores with and without the table (the table is the identity there);
 *   - A②: a first-person question the lexical probe scores 0 against fires the hint through the
 *     rewrite, while a non-self text's verdict is exactly the raw probe's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Reranker, SemanticBackend } from '@avantf/mem-retrieval'
import { loadConfig } from '../src/config/loader.js'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { selfQueryRewrite, SELF_QUERY_RULES } from '../src/store/self_query.js'
import { looksRelevant } from '../src/store/lexical.js'
import { hybridSearch, type HybridContext, type HybridDeps, type HybridLeg } from '../src/store/hybrid.js'
import { loadEvalCases } from '../src/eval/loader.js'
import { allowAnyDomain } from './helpers.js'

const here = dirname(fileURLToPath(import.meta.url))

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

describe('store/self_query (the closed intent table)', () => {
  it('maps each self-reference variant to exactly ONE canonical third-person rewrite', () => {
    expect(selfQueryRewrite('我是谁？')).toBe('用户是谁')
    expect(selfQueryRewrite('本人是谁')).toBe('用户是谁')
    expect(selfQueryRewrite('我叫什么')).toBe('用户的名字')
    expect(selfQueryRewrite('我叫啥')).toBe('用户的名字')
    expect(selfQueryRewrite('我的名字是什么')).toBe('用户的名字')
    expect(selfQueryRewrite('我是做什么的')).toBe('用户是做什么的')
    expect(selfQueryRewrite('我是干啥的')).toBe('用户是做什么的')
    expect(selfQueryRewrite('我在哪')).toBe('用户在哪里')
    expect(selfQueryRewrite('我的偏好')).toBe('用户的偏好')
  })

  it('returns undefined for anything that is not first-person self-reference', () => {
    // Already third person — rewriting it would be a no-op the caller must not pay a second leg run for.
    expect(selfQueryRewrite('用户是谁')).toBeUndefined()
    expect(selfQueryRewrite('用户的名字')).toBeUndefined()
    expect(selfQueryRewrite('插件的安装方法')).toBeUndefined()
    expect(selfQueryRewrite('他是谁')).toBeUndefined()
    expect(selfQueryRewrite('')).toBeUndefined()
    expect(selfQueryRewrite('   ')).toBeUndefined()
  })

  it('is a closed set: every rule carries exactly one rewrite and the rewrites are third-person', () => {
    expect(SELF_QUERY_RULES.length).toBeGreaterThan(0)
    for (const rule of SELF_QUERY_RULES) {
      expect(rule.cues.length).toBeGreaterThan(0)
      expect(rule.rewrite.startsWith('用户')).toBe(true)
    }
  })
})

let dir: string
let config: ReturnType<typeof loadConfig>['common']

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-self-query-'))
  allowAnyDomain(dir)
  config = loadConfig({ dataHome: dir }).common
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Deps whose ONE leg's scores depend on the query text actually handed to the store. */
function deps(legScores: (ctx: HybridContext) => Record<number, number>): HybridDeps<TestHit> {
  return {
    kind: 'memory',
    config,
    semantic,
    reranker,
    legs: async (ctx) => [{ weight: 1, scores: new Map(Object.entries(legScores(ctx)).map(([k, v]) => [Number(k), v])) } as HybridLeg],
    texts: (ids) => new Map(ids.map((id) => [id, `文本 ${String(id)}`])),
    hits: (ranked, texts) => ranked.map((h) => ({ id: h.id, text: texts.get(h.id) ?? '', score: h.score })),
  }
}

describe('hybridSearch augmentation (方案 A)', () => {
  it('runs the original AND the rewrite, unioning each leg (max, never summed)', async () => {
    const d = deps((ctx): Record<number, number> => (ctx.query === '用户是谁' ? { 2: 0.8, 3: 0.4 } : { 1: 0.9, 2: 0.5 }))
    const result = await hybridSearch(d, { query: '我是谁', limit: 10 })
    expect(result.hits.map((h) => h.id)).toEqual([1, 2, 3])
    // id 2's raw leg score is max(0.5, 0.8) = 0.8 — the MAX of the two runs, not their sum.
    expect(result.hits.find((h) => h.id === 2)?.score).toBeCloseTo(0.8 / 0.9, 6)
  })

  it('a disabled table is the pre-A path (one leg run, on the original query only)', async () => {
    const calls: string[] = []
    const d = deps((ctx) => { calls.push(ctx.query); return { 1: 0.9, 2: 0.5 } })
    const result = await hybridSearch(d, { query: '我是谁', limit: 10, rewriteQuery: () => undefined })
    expect(calls).toEqual(['我是谁'])
    expect(result.hits.map((h) => h.id)).toEqual([1, 2])
  })

  it('the DEFAULT table runs the original and the rewrite (two leg runs)', async () => {
    const calls: string[] = []
    const d = deps((ctx) => { calls.push(ctx.query); return { 1: 0.9 } })
    await hybridSearch(d, { query: '我是谁', limit: 10 })
    expect([...calls].sort()).toEqual(['我是谁', '用户是谁'])
  })

  it('grades each run by ITS OWN reachability clamp (the FTS bar cannot be inherited)', async () => {
    // 2026-10-04 事故（AGENTS.md「分布敏感 / 碰撞敏感」）。`我是谁？` 只产出 ONE trigram，改写
    // `用户是谁` 产出 TWO，而文档语义是「对**被评分的那条文本**取 `min(configured, termCount)`」。
    // 两遍共用原查询解析出的门槛时，改写那一遍就被压到 1：一个只命中 `用户是` 的无关联长笔记拿到了
    // FTS 腿的头（权重 × 1.0），反压 `改写` 自己排在第一的身份事实。这条直接钉住「每一遍用自己的
    // 词元数」——把修复回退（两遍都传 termCount(query)）就会红。
    config.retriever.min_fts_terms = 2
    const seen: { query: string; fts: number }[] = []
    const d: HybridDeps<TestHit> = {
      ...deps(() => ({ 1: 1 })),
      legs: async (ctx) => {
        seen.push({ query: ctx.query, fts: ctx.floors.fts })
        return [{ weight: 1, scores: new Map([[1, 1]]) } as HybridLeg]
      },
    }
    const result = await hybridSearch(d, { query: '我是谁？', limit: 5 })
    expect(seen.find((s) => s.query === '我是谁？')?.fts, '原查询只有 1 个词元 → 门槛 1').toBe(1)
    expect(seen.find((s) => s.query === '用户是谁')?.fts, '改写有 2 个词元 → 门槛 2').toBe(2)
    // 对外报告的是用户自己那条查询的门槛（改写那一遍只会更严，绝不会更松）。
    expect(result.floors.fts).toBe(1)

    // 反向：改写比原查询**更短**时，它自己的可达门槛更低（`min(configured, 2)`），但那一遍被抬到
    // 报告门槛 — 增广不能放进比用户自己那条查询更弱的词法证据，且这样 `floors` 永不夸大已施加的门槛。
    config.retriever.min_fts_terms = 3
    const seen2: { query: string; fts: number }[] = []
    const d2: HybridDeps<TestHit> = {
      ...deps(() => ({ 1: 1 })),
      legs: async (ctx) => {
        seen2.push({ query: ctx.query, fts: ctx.floors.fts })
        return [{ weight: 1, scores: new Map([[1, 1]]) } as HybridLeg]
      },
    }
    const result2 = await hybridSearch(d2, { query: '我是什么人', limit: 5 })
    expect(seen2.find((s) => s.query === '我是什么人')?.fts, '原查询 3 个词元 → 门槛 3').toBe(3)
    expect(seen2.find((s) => s.query === '用户是谁')?.fts, '改写只有 2 个词元，但不得低于报告门槛 3').toBe(3)
    expect(result2.floors.fts).toBe(3)
  })

  it('a MISCONFIGURED table can only ADD: every hit of the raw query survives', async () => {
    const query = '插件怎么安装'
    // A deliberately wrong table: this query is not self-referential, yet the table rewrites it.
    const misconfigured = (): string => '用户是谁'
    const d = deps((ctx): Record<number, number> => (ctx.query === '用户是谁' ? { 2: 0.8, 3: 0.4 } : { 1: 0.9, 2: 0.5 }))

    const without = await hybridSearch(d, { query, limit: 10, rewriteQuery: () => undefined })
    const withMisconfigured = await hybridSearch(d, { query, limit: 10, rewriteQuery: misconfigured })

    const before = without.hits.map((h) => h.id)
    const after = withMisconfigured.hits.map((h) => h.id)
    // Superset (never narrower) and strictly bigger (the false positive DID add recall).
    expect(before.every((id) => after.includes(id))).toBe(true)
    expect(after.length).toBeGreaterThan(before.length)
    // The original top-1 is still present and still ahead of the candidate the rewrite added below it.
    expect(after.slice(0, before.length)).toEqual(before)
  })

  it('the original query keeps the vector it was handed; only the rewrite encodes itself', async () => {
    // A caller-supplied vector belongs to the ORIGINAL text. The rewrite must not be scored with it,
    // so the store is handed `queryVector` exactly once (for the original run) and encodes the rewrite.
    const seenVectors: (Float32Array | undefined)[] = []
    const d: HybridDeps<TestHit> = {
      ...deps(() => ({ 1: 1 })),
      legs: async (ctx) => {
        seenVectors.push(ctx.queryVector)
        return [{ weight: 1, scores: new Map([[1, 1]]) } as HybridLeg]
      },
    }
    const original = new Float32Array([1, 0, 0, 0])
    await hybridSearch(d, { query: '我是谁', limit: 5, queryVector: original, rewriteQuery: () => '用户是谁' })
    // Both runs happened (concurrently, so the order is not pinned); the caller's vector went to
    // exactly one of them and the rewrite got none.
    expect(seenVectors).toHaveLength(2)
    expect(seenVectors.filter((v) => v === original)).toHaveLength(1)
    expect(seenVectors.filter((v) => v === undefined)).toHaveLength(1)
  })
})

describe('non-self queries from the frozen set are unchanged (方案 A: no rewrite ⇒ no second run)', () => {
  it('returns identical ids / order / scores with and without the table', async () => {
    const cases = loadEvalCases(join(here, 'fixtures', 'eval_zh_relations.jsonl'))
    const queries = cases
      .filter((c) => !c.tags.includes('self_query'))
      .flatMap((c) => c.queries.map((q) => q.query))
      .slice(0, 8)

    const rt: AvantfRuntime = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      await rt.remember({ action: 'add', content: '用户的名字是张三。' })
      await rt.remember({ action: 'add', content: '插件的安装方法写在 README 里，先装依赖再构建。' })
      await rt.remember({ action: 'add', content: '生产环境的部署流程已经冻结，回滚脚本要演练。' })
      for (const query of queries) {
        expect(selfQueryRewrite(query), `${query} 不是自指问句`).toBeUndefined()
        const withTable = await rt.memory.search({ query, limit: 5 })
        const preA = await rt.memory.search({ query, limit: 5, rewriteQuery: () => undefined })
        expect(withTable.hits, query).toEqual(preA.hits)
        expect(withTable.dropped_by_floor, query).toEqual(preA.dropped_by_floor)
        expect(withTable.floors, query).toEqual(preA.floors)
      }
    } finally {
      rt.shutdown()
    }
  })
})

describe('runtime.relevance reuses the same table (方案 A②)', () => {
  it('fires for a first-person question the raw lexical probe scores 0 on, and leaves non-self text alone', async () => {
    const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      await rt.remember({ action: 'add', content: '用户的名字是张三。' })
      await rt.remember({ action: 'add', content: '缓存策略统一改为写穿，热点键过期时间随机抖动。' })

      // The pre-A failure, stated at the probe: the first-person question shares no trigram with the
      // third-person fact, so the store holds 0 of its terms.
      expect(rt.memory.lexicalProbe('我叫什么', 2).matched).toBe(0)
      expect(looksRelevant(rt.memory.lexicalProbe('我叫什么', 2))).toBe(false)
      // …and the SAME table the retrieval path uses recovers it: `用户的名字` matches 3 terms.
      expect(rt.relevance('我叫什么')).toBe(true)
      expect(rt.relevance('我的名字')).toBe(true)

      // Non-self text: the verdict is EXACTLY the raw probe's — the rewrite branch never runs.
      for (const text of ['插件的安装方法', '缓存策略', '用户的名字是啥', '今天天气怎么样']) {
        expect(selfQueryRewrite(text), text).toBeUndefined()
        expect(rt.relevance(text), text).toBe(looksRelevant(rt.memory.lexicalProbe(text, 2)))
      }
      // A genuine two-term lexical hit still fires, unaffected by this change.
      expect(rt.relevance('缓存策略统一')).toBe(true)
    } finally {
      rt.shutdown()
    }
  })
})
