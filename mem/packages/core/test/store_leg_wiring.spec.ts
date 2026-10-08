/**
 * Store-level WIRING of the shared leg flows (`store/legs.ts`).
 *
 * `legs_sources.spec.ts` proves the shared `ftsLeg` / `semanticLeg` behave like the two
 * implementations they replaced. This file proves the OTHER half of the convergence: that each
 * store's thin forward hands those flows the right primitives — its own DAO, its own tokenizer,
 * the scope in the right ARGUMENT ORDER (`(category, cap, source)` for memory vs
 * `(domain, source, cap)` for knowledge), `max(50, k)`, and the filter that encodes the store's own
 * visibility rule (memory always filters through the DB; knowledge short-circuits without a scope).
 *
 * WHY IT IS WORTH A FILE. A swapped pair of arguments or a dropped `cap` in an eight-line forward is
 * invisible to a shared-function test and to type checking (every parameter is a string or a number),
 * and it would silently narrow or widen EVERY fts/semantic query of that store. The expectations here
 * are computed from the DAO directly — the intended wiring written out a second time — and compared
 * byte for byte (ids, scores, insertion order).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import type { SemanticBackend, VectorStore } from '@avantf/mem-retrieval'
import { buildFtsQuery } from '../src/db/tokenizer.js'
import { substringTerms } from '../src/store/lexical.js'
import { RetrievalInputError } from '../src/store/hybrid.js'
import { allowAnyDomain } from './helpers.js'

/** `buildRuntime` refuses a semantic override whose width differs from `config.semantic.dim`. */
const DIM = 768

/**
 * Deterministic, distinct vectors: encoding a text yields the same coordinates as the row whose text
 * embeds the same characters, so "which ids come back" is a property of the fixture, not of chance.
 */
function vectorOf(text: string): Float32Array {
  const vec = new Float32Array(DIM)
  for (let i = 0; i < text.length; i++) vec[(text.charCodeAt(i) + i) % DIM] += 1
  let norm = 0
  for (const value of vec) norm += value * value
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < DIM; i++) vec[i] /= norm
  return vec
}

const fakeSemantic: SemanticBackend = {
  name: 'fake_wiring',
  dim: DIM,
  isAvailable: () => true,
  encode: async (text: string) => vectorOf(text),
  encodeBatch: async (texts: readonly string[]) => texts.map((text) => vectorOf(text)),
}

/** The private surface this spec asserts on (the repo's established `as unknown as` test seam). */
interface MemoryInternals {
  readonly ftsTokenizer: unknown
  readonly facts: {
    ftsSearch(ftsQuery: string, category?: string, limit?: number, source?: string): { id: number; rank: number }[]
    ftsSubstringSearch(terms: readonly string[], category?: string, limit?: number, source?: string): { id: number; rank: number }[]
  }
  readonly vstore: VectorStore
  ftsPath(query: string, category: string | undefined, cap: number, source?: string): Map<number, number>
  semanticPath(
    query: string,
    category: string | undefined,
    k: number,
    queryVector?: Float32Array,
    onVector?: (vec: Float32Array) => void,
    source?: string,
  ): Promise<Map<number, number>>
}

interface KnowledgeInternals {
  readonly ftsTokenizer: unknown
  readonly chunks: {
    ftsSearch(ftsQuery: string, domain?: string, source?: string, limit?: number): { id: number; rank: number }[]
    ftsSubstringSearch(terms: readonly string[], domain?: string, source?: string, limit?: number): { id: number; rank: number }[]
    meta(ids: readonly number[]): { chunk_id: number; domain: string; source: string }[]
  }
  readonly vstore: VectorStore
  ftsPath(query: string, domain: string | undefined, source: string | undefined, cap: number): Map<number, number>
  semanticPath(
    query: string,
    k: number,
    opts?: { domain?: string; source?: string },
    queryVector?: Float32Array,
    onVector?: (vec: Float32Array) => void,
  ): Promise<Map<number, number>>
}

function openRuntime(): { rt: AvantfRuntime; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'avf-leg-wiring-'))
  allowAnyDomain(home)
  const rt = buildRuntime({ dataHome: home, memoryDbPath: join(home, 'memory.db'), semantic: fakeSemantic })
  return { rt, home }
}

/** Replace one method on an internals object, capture its arguments, restore after (`this` preserved). */
function spyMethod(target: object, key: string, calls: unknown[][]): () => void {
  const holder = target as Record<string, unknown>
  const original = holder[key] as (...args: unknown[]) => unknown
  holder[key] = function spied(this: unknown, ...args: unknown[]): unknown {
    calls.push(args)
    return original.apply(this, args)
  }
  return () => { holder[key] = original }
}

const asMap = (rows: readonly { id: number; rank: number }[], negate: boolean): Map<number, number> =>
  new Map(rows.map((row) => [row.id, negate ? -row.rank : row.rank]))

describe('memory: the fts leg forward keeps its DAO, tokenizer, scope ORDER and cap', () => {
  it('MATCH branch, scope filter, cap and the short-query LIKE fallback all match the DAO called directly', async () => {
    const { rt, home } = openRuntime()
    try {
      const m = rt.memory as unknown as MemoryInternals
      await rt.memory.add('缓存策略：内存回收与页缓存的关系', 'catA', undefined, { sourceRef: 'srcA' })
      await rt.memory.add('缓存策略：另一条同类事实', 'catB', undefined, { sourceRef: 'srcA' })
      await rt.memory.add('缓存策略：第三条事实', 'catA', undefined, { sourceRef: 'srcB' })

      const query = '缓存策略'
      const ftsQuery = buildFtsQuery(query, m.ftsTokenizer as never)
      expect(ftsQuery).not.toBeNull()

      // (1) the intended wiring, written out through the DAO: (query, category, cap, source)
      const expectedCategory = asMap(m.facts.ftsSearch(ftsQuery as string, 'catA', 20, undefined), true)
      expect([...m.ftsPath(query, 'catA', 20)]).toEqual([...expectedCategory])
      // the filter really narrows (a dropped scope would return every category)
      expect(m.ftsPath(query, undefined, 20).size).toBeGreaterThan(expectedCategory.size)

      // (2) the SOURCE argument is in the fourth position, not the third
      const expectedSource = asMap(m.facts.ftsSearch(ftsQuery as string, 'catA', 20, 'srcB'), true)
      expect([...m.ftsPath(query, 'catA', 20, 'srcB')]).toEqual([...expectedSource])
      expect(expectedSource.size).toBeLessThan(expectedCategory.size)

      // (3) the CAP is forwarded (and lands in the DAO's LIMIT)
      const capped = asMap(m.facts.ftsSearch(ftsQuery as string, undefined, 1, undefined), true)
      expect([...m.ftsPath(query, undefined, 1)]).toEqual([...capped])
      expect(capped.size).toBe(1)

      // (4) a two-character CJK query has no expressible term: the LIKE fallback, ranked by `rank`
      const narrow = '缓存'
      expect(buildFtsQuery(narrow, m.ftsTokenizer as never)).toBeNull()
      const expectedLike = asMap(m.facts.ftsSubstringSearch(substringTerms(narrow), undefined, 20, undefined), false)
      expect([...m.ftsPath(narrow, undefined, 20)]).toEqual([...expectedLike])
      expect(expectedLike.size).toBeGreaterThan(0)
    } finally {
      rt.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('memory: the semantic leg forward keeps dim, topk(50), the filter and the vector publish', () => {
  it('asks the vstore for max(50, k), publishes the query vector and filters through the DB', async () => {
    const { rt, home } = openRuntime()
    try {
      const m = rt.memory as unknown as MemoryInternals
      await rt.memory.add('缓存策略：内存回收与页缓存的关系', 'catA')
      await rt.memory.add('缓存策略：另一条同类事实', 'catB')

      const topkCalls: unknown[][] = []
      const restore = spyMethod(m.vstore, 'topk', topkCalls)
      try {
        const published: Float32Array[] = []
        const scoped = await m.semanticPath('缓存策略', 'catA', 5, undefined, (vec) => published.push(vec))
        // max(50, k) is the pool floor the old code used, so a small k still ranks against 50 candidates
        expect(topkCalls.map((args) => args[1])).toEqual([50])
        expect(published).toHaveLength(1)
        expect(published[0]).toEqual(vectorOf('缓存策略'))

        // the category filter runs BEFORE the leg hands its map over: catB is in the pool, not in the result
        const all = await m.semanticPath('缓存策略', undefined, 5)
        expect(all.size).toBeGreaterThan(scoped.size)
        expect(topkCalls.map((args) => args[1])).toEqual([50, 50])

        // a bigger k widens the pool instead of being clamped to 50
        await m.semanticPath('缓存策略', undefined, 80)
        expect(topkCalls.map((args) => args[1])).toEqual([50, 50, 80])

        // and the scores are the vstore's own, for exactly the surviving ids
        const pool = m.vstore.topk(vectorOf('缓存策略'), 50)
        const allowed = new Set(all.keys())
        expect([...all]).toEqual(pool.filter((entry) => allowed.has(entry.id)).map((entry) => [entry.id, entry.score]))
      } finally {
        restore()
      }

      // a caller-supplied vector of the wrong width is an INPUT error, with the exact message
      await expect(m.semanticPath('缓存策略', undefined, 5, new Float32Array(3)))
        .rejects.toThrow(RetrievalInputError)
      await expect(m.semanticPath('缓存策略', undefined, 5, new Float32Array(3)))
        .rejects.toThrow(/queryVector 维度不符：3 != 768/)
    } finally {
      rt.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('knowledge: the fts leg forward keeps (domain, source, cap) — a swap would change the answer', () => {
  it('domain, source and cap each reach the DAO in their own position', async () => {
    const { rt, home } = openRuntime()
    try {
      const k = rt.knowledge as unknown as KnowledgeInternals
      await rt.knowledge.ingest('缓存策略：内存回收与页缓存的关系。', 'domA', 'srcA')
      await rt.knowledge.ingest('缓存策略：另一篇文档里的同类段落。', 'domB', 'srcA')
      await rt.knowledge.ingest('缓存策略：第三篇文档。', 'domA', 'srcB')

      const query = '缓存策略'
      const ftsQuery = buildFtsQuery(query, k.ftsTokenizer as never)
      expect(ftsQuery).not.toBeNull()

      // the wiring is (domain, source, cap) — NOT memory's (category, cap, source)
      const expectedDomain = asMap(k.chunks.ftsSearch(ftsQuery as string, 'domA', undefined, 20), true)
      expect([...k.ftsPath(query, 'domA', undefined, 20)]).toEqual([...expectedDomain])
      expect(k.ftsPath(query, undefined, undefined, 20).size).toBeGreaterThan(expectedDomain.size)

      const expectedSource = asMap(k.chunks.ftsSearch(ftsQuery as string, 'domA', 'srcB', 20), true)
      expect([...k.ftsPath(query, 'domA', 'srcB', 20)]).toEqual([...expectedSource])
      expect(expectedSource.size).toBeLessThan(expectedDomain.size)

      const capped = asMap(k.chunks.ftsSearch(ftsQuery as string, undefined, undefined, 1), true)
      expect([...k.ftsPath(query, undefined, undefined, 1)]).toEqual([...capped])
      expect(capped.size).toBe(1)
    } finally {
      rt.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('knowledge: the semantic leg forward keeps the no-scope short-circuit and the scoped filter', () => {
  it('skips the metadata lookup entirely without a scope, and applies it with one', async () => {
    const { rt, home } = openRuntime()
    try {
      const k = rt.knowledge as unknown as KnowledgeInternals
      await rt.knowledge.ingest('缓存策略：内存回收与页缓存的关系。', 'domA', 'srcA')
      await rt.knowledge.ingest('缓存策略：另一篇文档里的同类段落。', 'domB', 'srcA')

      const metaCalls: unknown[][] = []
      const topkCalls: unknown[][] = []
      const restoreTopk = spyMethod(k.vstore, 'topk', topkCalls)
      const restoreMeta = spyMethod(k.chunks, 'meta', metaCalls)
      try {
        const unscoped = await k.semanticPath('缓存策略', 5)
        // the short-circuit: no scope requested ⇒ every pool entry survives, and the DB is never read
        expect(metaCalls).toHaveLength(0)
        expect(topkCalls.map((args) => args[1])).toEqual([50])
        expect(unscoped.size).toBe(k.vstore.topk(vectorOf('缓存策略'), 50).length)

        const scoped = await k.semanticPath('缓存策略', 5, { domain: 'domA' })
        // one batched lookup — not one per candidate — and the scope really narrows the pool
        expect(metaCalls).toHaveLength(1)
        expect(metaCalls[0][0]).toEqual([...unscoped.keys()])
        expect(scoped.size).toBeLessThan(unscoped.size)
        expect([...scoped.keys()].every((id) => unscoped.has(id))).toBe(true)
      } finally {
        restoreMeta()
        restoreTopk()
      }
    } finally {
      rt.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
