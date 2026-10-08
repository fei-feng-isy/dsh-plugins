/**
 * The two shared leg SOURCES in `store/legs.ts` — §4.6.1 (`ftsLeg`) and §4.6.2 (`semanticLeg`).
 *
 * The extraction is PURE STRUCTURE: `MemoryStore.ftsPath` and `KnowledgeStore.ftsPath` were the
 * same flow twice (MATCH with negated bm25, else the `substringTerms` LIKE fallback with `rank`),
 * and the two `semanticPath`s were the same encode → dimension-check → over-fetch → empty-out →
 * filter → map flow with only the filter differing. As in `legs.spec.ts`, the honest proof is a
 * DIFFERENTIAL test: the pre-extraction bodies are reproduced VERBATIM below as golden references,
 * and the shared functions are asserted equal to them on the same primitives — entry order included,
 * because `Map` insertion order is part of the contract. Each path gets its OWN spy, so "what the
 * shared flow issued" is asserted without the reference run blurring the call log. Specific numbers
 * are asserted alongside the reference so a change that moved BOTH sides cannot pass silently.
 */
import { describe, it, expect } from 'vitest'
import { ftsLeg, semanticLeg, type FtsLegOptions } from '../src/store/legs.js'
import { buildFtsQuery } from '../src/db/tokenizer.js'
import { substringTerms } from '../src/store/lexical.js'
import { RetrievalInputError } from '../src/store/hybrid.js'

/** A byte-level snapshot of a score map: ids, scores and INSERTION order. */
function snap(scores: Map<number, number>): string {
  return JSON.stringify([...scores.entries()])
}

// ─── golden reference: the pre-extraction `ftsPath` flow, verbatim ──────────────────────────────

function refFtsPath<Scope>(o: FtsLegOptions<Scope>): Map<number, number> {
  const ftsQuery = buildFtsQuery(o.query, o.tokenizer)
  if (ftsQuery) {
    const rows = o.search(ftsQuery, o.scope, o.cap)
    // FTS5 bm25() is negative (more negative = better match); negate so higher = better.
    return new Map(rows.map((r) => [r.id, -r.rank]))
  }
  const terms = substringTerms(o.query)
  if (terms.length === 0) return new Map()
  const rows = o.substringSearch(terms, o.scope, o.cap)
  return new Map(rows.map((r) => [r.id, r.rank]))
}

interface FtsCalls {
  search: { ftsQuery: string; scope: unknown; limit: number }[]
  substring: { terms: readonly string[]; scope: unknown; limit: number }[]
}

/** One fresh spy adapter set: `search` answers `[9, 3]`, `substringSearch` answers `[5, 2]`. */
function ftsSpy<Scope>(): {
  calls: FtsCalls
  opts: Pick<FtsLegOptions<Scope>, 'search' | 'substringSearch'>
} {
  const calls: FtsCalls = { search: [], substring: [] }
  return {
    calls,
    opts: {
      search: (ftsQuery, scope, limit) => {
        calls.search.push({ ftsQuery, scope, limit })
        return [{ id: 9, rank: -4.2 }, { id: 3, rank: -1.1 }]
      },
      substringSearch: (terms, scope, limit) => {
        calls.substring.push({ terms, scope, limit })
        return [{ id: 5, rank: 2 }, { id: 2, rank: 1 }]
      },
    },
  }
}

describe('ftsLeg = 抽取前的两份 ftsPath（逐字节差分）', () => {
  it('MATCH 分支取负 bm25，保持行序（不排序），并把 cap 透传', () => {
    const shared = ftsSpy<{ category?: string; source?: string }>()
    const reference = ftsSpy<{ category?: string; source?: string }>()
    const scope = { category: 'general', source: 's1' }
    const base = { query: '缓存策略', cap: 7, scope, tokenizer: 'trigram' } as const
    const actual = ftsLeg({ ...base, ...shared.opts })
    // The specific sign/order contract, asserted independently of the reference.
    expect(snap(actual)).toBe(JSON.stringify([[9, 4.2], [3, 1.1]]))
    expect(snap(actual)).toBe(snap(refFtsPath({ ...base, ...reference.opts })))
    expect(shared.calls.search).toEqual([{ ftsQuery: '"缓存策" OR "存策略"', scope, limit: 7 }])
    expect(shared.calls.substring).toHaveLength(0)
    // Rows came back 9 then 3; the leg must NOT re-sort by score.
    expect([...actual.keys()]).toEqual([9, 3])
  })

  it('短查询回退用 LIKE 的 rank 原样（同为 higher=better），词表逐字来自 substringTerms', () => {
    const shared = ftsSpy<{ domain?: string; source?: string }>()
    const reference = ftsSpy<{ domain?: string; source?: string }>()
    const scope = { domain: 'tech', source: undefined }
    const base = { query: '缓存', cap: 4, scope, tokenizer: 'trigram' } as const
    // Sanity for the branch: a 2-char CJK run is not expressible by the trigram MATCH builder.
    expect(buildFtsQuery(base.query, base.tokenizer)).toBeNull()
    const actual = ftsLeg({ ...base, ...shared.opts })
    expect(snap(actual)).toBe(JSON.stringify([[5, 2], [2, 1]]))
    expect(snap(actual)).toBe(snap(refFtsPath({ ...base, ...reference.opts })))
    expect(shared.calls.substring).toEqual([{ terms: ['缓存'], scope, limit: 4 }])
    expect(shared.calls.search).toHaveLength(0)
  })

  it('无可回退词（空表）时返回空 Map 且不查询任何 DAO', () => {
    const shared = ftsSpy<{ category?: string }>()
    const reference = ftsSpy<{ category?: string }>()
    const base = { query: 'ab', cap: 5, scope: { category: 'c' }, tokenizer: 'trigram' } as const
    expect(buildFtsQuery(base.query, base.tokenizer)).toBeNull()
    expect(substringTerms(base.query)).toEqual([])
    const actual = ftsLeg({ ...base, ...shared.opts })
    expect(actual.size).toBe(0)
    expect(snap(actual)).toBe(snap(refFtsPath({ ...base, ...reference.opts })))
    expect(shared.calls.search).toHaveLength(0)
    expect(shared.calls.substring).toHaveLength(0)
  })

  it('tokenizer 与 scope 是调用方的：同一 query 在 unicode61 下走 MATCH 分支', () => {
    const shared = ftsSpy<{ category?: string }>()
    const reference = ftsSpy<{ category?: string }>()
    // unicode61 admits a 2-char latin token, so the MATCH branch fires where trigram would fall back.
    const base = { query: 'ab', cap: 3, scope: { category: 'c' }, tokenizer: 'unicode61' } as const
    expect(buildFtsQuery(base.query, base.tokenizer)).toBe('"ab"')
    expect(snap(ftsLeg({ ...base, ...shared.opts }))).toBe(snap(refFtsPath({ ...base, ...reference.opts })))
    expect(shared.calls.search).toEqual([{ ftsQuery: '"ab"', scope: base.scope, limit: 3 }])
  })
})

// ─── golden references: the two pre-extraction `semanticPath` flows, verbatim ───────────────────

interface SemanticDeps {
  encode: (query: string) => Promise<Float32Array>
  dim: number
  topk: (vec: Float32Array, k: number) => { id: number; score: number }[]
}

/** `MemoryStore.semanticPath` BEFORE the extraction (verbatim flow). */
async function refMemorySemanticPath(
  query: string,
  category: string | undefined,
  k: number,
  queryVector: Float32Array | undefined,
  onVector: ((vec: Float32Array) => void) | undefined,
  source: string | undefined,
  d: SemanticDeps & { activeIdsIn: (ids: readonly number[], category?: string, source?: string) => number[] },
): Promise<Map<number, number>> {
  const vec = queryVector ?? await d.encode(query)
  if (vec.length !== d.dim) {
    throw new RetrievalInputError(`queryVector 维度不符：${vec.length} != ${d.dim}`)
  }
  onVector?.(vec)
  const topk = d.topk(vec, Math.max(50, k))
  if (!topk.length) return new Map()
  const allowed = new Set(d.activeIdsIn(topk.map((t) => t.id), category, source))
  const out = new Map<number, number>()
  for (const t of topk) if (allowed.has(t.id)) out.set(t.id, t.score)
  return out
}

interface ChunkMeta {
  chunk_id: number
  domain: string
  source: string
}

/** `KnowledgeStore.semanticPath` BEFORE the extraction (verbatim flow). */
async function refKnowledgeSemanticPath(
  query: string,
  k: number,
  opts: { domain?: string; source?: string } | undefined,
  queryVector: Float32Array | undefined,
  onVector: ((vec: Float32Array) => void) | undefined,
  d: SemanticDeps & { meta: (ids: readonly number[]) => ChunkMeta[] },
): Promise<Map<number, number>> {
  const vec = queryVector ?? await d.encode(query)
  if (vec.length !== d.dim) {
    throw new RetrievalInputError(`queryVector 维度不符：${vec.length} != ${d.dim}`)
  }
  onVector?.(vec)
  const topk = d.topk(vec, Math.max(50, k))
  if (!topk.length) return new Map()
  if (!opts?.domain && !opts?.source) return new Map(topk.map((t) => [t.id, t.score]))
  const meta = new Map(d.meta(topk.map((t) => t.id)).map((r) => [r.chunk_id, r]))
  const out = new Map<number, number>()
  for (const t of topk) {
    const r = meta.get(t.id)
    if (!r) continue
    if (opts.domain && r.domain !== opts.domain) continue
    if (opts.source && r.source !== opts.source) continue
    out.set(t.id, t.score)
  }
  return out
}

const DIM = 8
const VEC = new Float32Array(DIM).fill(0.25)
const POOL = [{ id: 4, score: 0.9 }, { id: 7, score: 0.7 }, { id: 2, score: 0.5 }, { id: 9, score: 0.3 }]

/** One fresh `topk` spy: it always returns {@link POOL} and records the `k` it was asked for. */
function topkSpy(): { calls: number[]; topk: SemanticDeps['topk'] } {
  const calls: number[] = []
  return {
    calls,
    topk: (_vec, k) => {
      calls.push(k)
      return POOL
    },
  }
}

const enc = async (): Promise<Float32Array> => VEC

describe('semanticLeg = 抽取前的两份 semanticPath（逐字节差分）', () => {
  it('memory 形：DB 过滤后仍按 vstore 的池序映射 id→score', async () => {
    const shared = topkSpy()
    const reference = topkSpy()
    const sharedD = { encode: enc, dim: DIM, topk: shared.topk }
    const refD = { encode: enc, dim: DIM, topk: reference.topk }
    const activeIdsIn = (_ids: readonly number[], _c?: string, _s?: string): number[] => [4, 2, 9]
    const expected = await refMemorySemanticPath('q', 'general', 5, undefined, undefined, 's1', { ...refD, activeIdsIn })
    const actual = await semanticLeg({
      query: 'q', k: 5, ...sharedD,
      filterTopk: (ids) => new Set(activeIdsIn(ids, 'general', 's1')),
    })
    // 7 is filtered out; 4,2,9 keep the POOL's order (not the filter's return order).
    expect(snap(actual)).toBe(JSON.stringify([[4, 0.9], [2, 0.5], [9, 0.3]]))
    expect(snap(actual)).toBe(snap(expected))
    // The over-fetch is `max(50, k)` and the filter sees the WHOLE pool.
    expect(shared.calls).toEqual([50])
  })

  it('knowledge 形 · 无 scope：短路保留整池，底层 meta 查询一次都不跑', async () => {
    const shared = topkSpy()
    const reference = topkSpy()
    let metaCalls = 0
    const meta = (_ids: readonly number[]): ChunkMeta[] => {
      metaCalls += 1
      return []
    }
    const expected = await refKnowledgeSemanticPath('q', 3, undefined, undefined, undefined, {
      encode: enc, dim: DIM, topk: reference.topk, meta,
    })
    const actual = await semanticLeg({
      query: 'q', k: 3, encode: enc, dim: DIM, topk: shared.topk,
      // `undefined` IS the short-circuit (see `SemanticLegOptions.filterTopk`).
      filterTopk: () => undefined,
    })
    // The whole pool survives, in pool order — this is the optimization, asserted by call count too.
    expect(snap(actual)).toBe(JSON.stringify([[4, 0.9], [7, 0.7], [2, 0.5], [9, 0.3]]))
    expect(snap(actual)).toBe(snap(expected))
    expect(metaCalls).toBe(0) // neither path looked at meta: the short-circuit is the whole point
    expect(shared.calls).toEqual([50])
  })

  it('knowledge 形 · 有 scope：逐行比 domain/source，缺行的候选被丢掉', async () => {
    const shared = topkSpy()
    const reference = topkSpy()
    const metas: ChunkMeta[] = [
      { chunk_id: 4, domain: 'tech', source: 'a.md' },
      { chunk_id: 2, domain: 'ops', source: 'a.md' },
      { chunk_id: 9, domain: 'tech', source: 'b.md' },
      // 7 has no meta row at all.
    ]
    const meta = (_ids: readonly number[]): ChunkMeta[] => metas
    const opts = { domain: 'tech', source: 'a.md' }
    const expected = await refKnowledgeSemanticPath('q', 4, opts, undefined, undefined, {
      encode: enc, dim: DIM, topk: reference.topk, meta,
    })
    const actual = await semanticLeg({
      query: 'q', k: 4, encode: enc, dim: DIM, topk: shared.topk,
      filterTopk: (ids) => {
        const byId = new Map(meta(ids).map((r) => [r.chunk_id, r]))
        const keep = new Set<number>()
        for (const id of ids) {
          const r = byId.get(id)
          if (!r) continue
          if (opts.domain && r.domain !== opts.domain) continue
          if (opts.source && r.source !== opts.source) continue
          keep.add(id)
        }
        return keep
      },
    })
    expect(snap(actual)).toBe(JSON.stringify([[4, 0.9]]))
    expect(snap(actual)).toBe(snap(expected))
    expect(shared.calls).toEqual([50])
  })

  it('`max(50, k)` 是逐字的：k=5 → 50，k=80 → 80', async () => {
    for (const [k, expectedK] of [[5, 50], [80, 80]] as const) {
      const shared = topkSpy()
      const reference = topkSpy()
      const activeIdsIn = (): number[] => [4, 7, 2, 9]
      const actual = await semanticLeg({ query: 'q', k, encode: enc, dim: DIM, topk: shared.topk, filterTopk: () => undefined })
      const expected = await refMemorySemanticPath('q', undefined, k, undefined, undefined, undefined, {
        encode: enc, dim: DIM, topk: reference.topk, activeIdsIn,
      })
      expect(shared.calls).toEqual([expectedK])
      expect(snap(actual)).toBe(snap(expected))
    }
  })

  it('queryVector 短路编码；onVector 收到真正使用的那条向量（参考实现同值）', async () => {
    const shared = topkSpy()
    const reference = topkSpy()
    let encodes = 0
    const encode = async (): Promise<Float32Array> => {
      encodes += 1
      return VEC
    }
    const published: Float32Array[] = []
    const onVector = (v: Float32Array): void => { published.push(v) }
    const actual = await semanticLeg({
      query: 'q', k: 1, queryVector: VEC, onVector, encode, dim: DIM, topk: shared.topk, filterTopk: () => undefined,
    })
    const expected = await refMemorySemanticPath('q', undefined, 1, VEC, onVector, undefined, {
      encode, dim: DIM, topk: reference.topk, activeIdsIn: () => [4, 7, 2, 9],
    })
    expect(encodes).toBe(0)
    expect(published).toEqual([VEC, VEC]) // shared + reference, each published the injected vector
    expect(published[0]).toBe(VEC)
    expect(snap(actual)).toBe(snap(expected))
  })

  it('维度不符抛 RetrievalInputError，文案逐字；池子未被查询', async () => {
    const shared = topkSpy()
    const reference = topkSpy()
    const wrong = new Float32Array(3)
    const encode = async (): Promise<Float32Array> => wrong
    const message = 'queryVector 维度不符：3 != 8'
    await expect(semanticLeg({ query: 'q', k: 1, encode, dim: DIM, topk: shared.topk, filterTopk: () => undefined }))
      .rejects.toThrow(new RetrievalInputError(message))
    await expect(refMemorySemanticPath('q', undefined, 1, undefined, undefined, undefined, {
      encode, dim: DIM, topk: reference.topk, activeIdsIn: () => [],
    })).rejects.toThrow(new RetrievalInputError(message))
    await expect(semanticLeg({ query: 'q', k: 1, encode, dim: DIM, topk: shared.topk, filterTopk: () => undefined }))
      .rejects.toBeInstanceOf(RetrievalInputError)
    expect(shared.calls).toHaveLength(0)
    expect(reference.calls).toHaveLength(0)
  })

  it('空 topk 早退：不打过滤原语、返回空 Map', async () => {
    let filtered = 0
    const emptyTopk = (): { id: number; score: number }[] => []
    const actual = await semanticLeg({
      query: 'q', k: 9, encode: enc, dim: DIM, topk: emptyTopk,
      filterTopk: () => { filtered += 1; return undefined },
    })
    const expected = await refMemorySemanticPath('q', undefined, 9, undefined, undefined, undefined, {
      encode: enc, dim: DIM, topk: emptyTopk, activeIdsIn: () => [1],
    })
    expect(actual.size).toBe(0)
    expect(filtered).toBe(0)
    expect(snap(actual)).toBe(snap(expected))
  })
})
