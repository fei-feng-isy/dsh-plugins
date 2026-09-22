import { describe, it, expect } from 'vitest'
import { crossQuery, normalizeMergedScores } from '../src/router.js'
import type { RecallHit, RecallResult } from '@avantf/mem-contract'

function fact(id: number, score: number): RecallHit {
  return { kind: 'fact', ref_id: id, text: `fact ${id}`, score, domain: null, source: null, source_ref: `memory:fact:${id}`, entities: [], created_at: '2026-01-01 00:00:00', updated_at: null }
}
function chunk(id: number, score: number, domain = 'tech', source = 'spec'): RecallHit {
  return { kind: 'doc_chunk', ref_id: id, text: `chunk ${id}`, score, domain, source, source_ref: `${domain}:${source}:${id}:0`, entities: [], created_at: '2026-01-01 00:00:00', updated_at: '2026-01-02 00:00:00' }
}
function mem(hits: RecallHit[]): RecallResult {
  return { hits, degraded: false, weights: { semantic: 0.55, fts: 0.3, jaccard: 0.15 } }
}

describe('crossQuery router', () => {
  it('min-max normalizes over the MERGED pool and ranks across stores', () => {
    const res = crossQuery(mem([fact(1, 0.8), fact(2, 0.6)]), [chunk(9, 0.4)], { limit: 10 })
    expect(res.hits).toHaveLength(3)
    expect(res.hits[0].ref_id).toBe(1)
    expect(res.hits[0].score).toBe(1) // max of merged pool
    expect(res.hits[2].score).toBe(0) // min of merged pool
    // degraded/weights inherited from the memory leg
    expect(res.degraded).toBe(false)
    expect(res.weights.semantic).toBe(0.55)
  })

  it('does NOT mutate the callers hit objects', () => {
    const hits = [fact(1, 0.8), fact(2, 0.6)]
    crossQuery(mem(hits), [chunk(9, 0.4)], { limit: 10 })
    expect(hits[0].score).toBe(0.8)
    expect(hits[1].score).toBe(0.6)
  })

  it('kind filter keeps only the requested store', () => {
    const onlyDocs = crossQuery(mem([fact(1, 0.8)]), [chunk(9, 0.4)], { kind: 'doc_chunk', limit: 10 })
    expect(onlyDocs.hits).toHaveLength(1)
    expect(onlyDocs.hits[0].kind).toBe('doc_chunk')
  })

  it('source filter survives a ":" inside the source or the domain', () => {
    const res = crossQuery(
      mem([fact(1, 0.9)]),
      [
        chunk(9, 0.4, 'tech', 'spec:v1.md'),
        chunk(10, 0.3, 'tech', 'readme'),
        chunk(11, 0.2, 'tech:backend', 'spec:v1.md'),
      ],
      { source: 'spec:v1.md', limit: 10 },
    )
    expect(res.hits.map((h) => h.ref_id).sort((a, b) => a - b)).toEqual([9, 11])
  })

  it('source filter matches a ":"-bearing source on a ":"-bearing domain', () => {
    // The old end-parsing relied on a `namespace` the store derived with split(':')[0],
    // so this pair (domain "a:b", source "src") silently matched nothing.
    const res = crossQuery(mem([fact(1, 0.9)]), [chunk(9, 0.4, 'a:b', 'src'), chunk(10, 0.3, 'a:b', 'other')], { source: 'src', limit: 10 })
    expect(res.hits.map((h) => h.ref_id)).toEqual([9])
  })

  it('domain filter keeps only that knowledge domain', () => {
    const res = crossQuery(mem([fact(1, 0.8)]), [chunk(9, 0.4, 'tech'), chunk(10, 0.3, 'ops')], { domain: 'tech', limit: 10 })
    expect(res.hits.map((h) => h.ref_id)).toEqual([9])
  })

  it('domain filter never matches memory facts, even for a domain named "memory"', () => {
    // Memory hits carry `source_ref = memory:fact:<id>` and a null domain; filtering
    // on the source_ref prefix used to leak the whole memory store into the result.
    const res = crossQuery(mem([fact(1, 0.9)]), [chunk(9, 0.4, 'tech')], { domain: 'memory', limit: 10 })
    expect(res.hits).toEqual([])
    expect(crossQuery(mem([fact(1, 0.9)]), [], { domain: 'memory', limit: 10 }).hits).toEqual([])
  })

  it('source filter keeps only doc chunks of that source (previously declared but ignored)', () => {
    const res = crossQuery(
      mem([fact(1, 0.9)]),
      [chunk(9, 0.4, 'tech', 'spec'), chunk(10, 0.3, 'tech', 'readme')],
      { source: 'readme', limit: 10 },
    )
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0].ref_id).toBe(10)
    expect(res.hits[0].source_ref).toBe('tech:readme:10:0')
  })

  it('empty pool short-circuits with inherited degradation info', () => {
    const res = crossQuery({ hits: [], degraded: true, weights: { semantic: 0, fts: 0.65, jaccard: 0.35 } }, [], { limit: 10, domain: 'nope' })
    expect(res.hits).toEqual([])
    expect(res.degraded).toBe(true)
  })

  it('keeps the RAW score when the merged pool has a collapsed range', () => {
    // Pinned decision, not an accident: one candidate (or several at the same score)
    // carries no ranking information, so rescaling would turn an absolute fused score
    // of 0.42 into a "perfect" 1.0. See `normalizeMergedScores`.
    expect(normalizeMergedScores([{ score: 0.42 }])).toEqual([{ score: 0.42 }])
    expect(normalizeMergedScores([{ score: 0.7 }, { score: 0.7 }])).toEqual([{ score: 0.7 }, { score: 0.7 }])
    expect(normalizeMergedScores([])).toEqual([])

    // …and the router agrees with it.
    const single = crossQuery(mem([]), [chunk(9, 0.42)], { limit: 10 })
    expect(single.hits.map((h) => h.score)).toEqual([0.42])
  })

  it('spans [0,1] when the merged pool does have a range', () => {
    const scaled = normalizeMergedScores([{ score: 0.2 }, { score: 0.6 }, { score: 1.0 }])
    expect(scaled[0].score).toBe(0)
    expect(scaled[1].score).toBeCloseTo(0.5, 9)
    expect(scaled[2].score).toBe(1)
  })

  it('limit truncates the merged ranking', () => {
    const res = crossQuery(mem([fact(1, 0.9), fact(2, 0.5)]), [chunk(9, 0.7)], { limit: 2 })
    expect(res.hits).toHaveLength(2)
    expect(res.hits.map((h) => h.ref_id)).toEqual([1, 9])
  })
})
