import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateTokens, resetRetrievalHealth, type SemanticBackend } from '@avantf/mem-core'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { allowAnyDomain } from './helpers.js'

/**
 * Retrieval output budget + health counters (DESIGN §20).
 *
 * `limit` bounds how many hits, never how much TEXT; these tests pin the second bound and the
 * visibility of it (`truncated`), plus the counters that make a degradation noticeable.
 */
let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-budget-'))
  allowAnyDomain(dir) // the fixtures' own domain names, not the shipped allowlist
  resetRetrievalHealth() // the counters are process-wide; each case starts from zero
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/** A document long enough to produce several chunks, so a result has more text than a budget. */
const LONG_DOC = ['网关的部署与回滚流程说明。'.repeat(20), '发布窗口固定在每周二晚间。'.repeat(20), '回滚由值班同学手动触发。'.repeat(20)].join('\n\n')

async function stats(): Promise<{ retrieval: { queries: number; zero_result_rate: number; output_truncated: number; semantic_live_rate: number; by_kind: Record<string, { queries: number }> } }> {
  return (rt.admin({ action: 'stats' }) as unknown as { retrieval: never })
}

describe('retrieval output budget', () => {
  it('bounds the text of a result and marks what it shortened', async () => {
    await rt.remember({ action: 'add', content: '网关由平台组维护，发布窗口在周二。' })
    await rt.kb({ action: 'ingest', text: LONG_DOC, domain: 'tech', source: 'gw.md' })

    const res = await rt.query({ query: '网关', limit: 10, max_tokens: 40 })
    expect(res.hits.length).toBeGreaterThan(0)
    const total = res.hits.reduce((n, h) => n + estimateTokens(h.text), 0)
    expect(total).toBeLessThanOrEqual(40)
    expect(res.hits.some((h) => h.truncated === true)).toBe(true)
    // Provenance survives truncation: the caller can still fetch the full text.
    for (const hit of res.hits) expect(hit.source_ref).toMatch(/^(memory:fact:|tech:)/)
  })

  it('max_tokens: 0 lifts the budget for a caller that wants everything', async () => {
    await rt.kb({ action: 'ingest', text: LONG_DOC, domain: 'tech', source: 'gw.md' })
    const res = await rt.query({ query: '网关', limit: 10, max_tokens: 0 })
    const kbHits = res.hits.filter((h) => h.kind === 'doc_chunk')
    expect(kbHits.length).toBeGreaterThan(0)
    expect(kbHits.every((h) => h.truncated !== true)).toBe(true)
    expect(kbHits.map((h) => h.text).join('')).toContain('部署与回滚')
  })

  it('budgets the MERGED result of a cross query, not each leg separately', async () => {
    await rt.remember({ action: 'add', content: '网关由平台组维护，发布窗口在周二。' })
    await rt.kb({ action: 'ingest', text: LONG_DOC, domain: 'tech', source: 'gw.md' })
    const res = await rt.query({ query: '网关', limit: 10, max_tokens: 50 })
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits.reduce((n, h) => n + estimateTokens(h.text), 0)).toBeLessThanOrEqual(50)
  })

  it('uses the configured default when the caller stays quiet', async () => {
    // The default is generous (8000 tokens), so an ordinary result is untouched — the budget is
    // a backstop against a broad query, not a trimmer that changes normal behavior.
    await rt.kb({ action: 'ingest', text: LONG_DOC, domain: 'tech', source: 'gw.md' })
    const res = await rt.query({ query: '网关', limit: 10 })
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits.every((h) => h.truncated !== true)).toBe(true)
  })
})

describe('retrieval health counters', () => {
  it('counts a user query once: cross queries are ONE event, not one per leg', async () => {
    await rt.kb({ action: 'ingest', text: LONG_DOC, domain: 'tech', source: 'gw.md' })

    const before = await stats()
    expect(before.retrieval.queries).toBe(0)

    await rt.recall({ action: 'search', query: '网关', limit: 10 })
    await rt.query({ query: '网关', limit: 10, max_tokens: 20 }) // truncates the long chunks
    await rt.recall({ action: 'search', query: '不存在的词', limit: 5 })
    const after = await stats()

    // 2 memory searches + 1 cross query. The cross query's two legs are NOT counted separately:
    // otherwise `queries`/`avg_latency`/`zero_result_rate` describe legs, not questions.
    expect(after.retrieval.queries).toBe(3)
    expect(after.retrieval.by_kind['memory']?.queries).toBe(2)
    expect(after.retrieval.by_kind['cross']?.queries).toBe(1)
    expect(after.retrieval.by_kind['knowledge']).toBeUndefined()
    expect(after.retrieval.output_truncated).toBeGreaterThanOrEqual(1)
    // The suite runs with the model disabled, so the semantic leg is honestly reported as down.
    expect(after.retrieval.semantic_live_rate).toBe(0)
  })

  it('counts a zero-result KNOWLEDGE query (the early return used to skip the counter)', async () => {
    await rt.kb({ action: 'ingest', text: LONG_DOC, domain: 'tech', source: 'gw.md' })
    await rt.knowledge.search('完全不存在的词汇组合', {})
    const after = await stats()
    expect(after.retrieval.by_kind['knowledge']?.queries).toBe(1)
    expect(after.retrieval.zero_result_rate).toBe(1)
  })

  it('counts a zero-result CROSS query, including when only the knowledge leg was asked', async () => {
    await rt.kb({ action: 'ingest', text: LONG_DOC, domain: 'tech', source: 'gw.md' })
    await rt.query({ query: '完全不存在的词汇组合', limit: 5, kind: 'doc_chunk' })
    const after = await stats()
    expect(after.retrieval.queries).toBe(1)
    expect(after.retrieval.zero_result_rate).toBe(1)
  })

  it('reports the semantic leg as LIVE, not only as degraded', async () => {
    // Every other suite here runs with the model disabled (auto-download off), so
    // `semantic_live_rate` was only ever asserted at 0 — the branch that answers "is the
    // semantic leg actually up?" had no coverage at all. Injected through the documented
    // `buildRuntime({ semantic })` seam, which is exactly the difference under test.
    class AlwaysWarm implements SemanticBackend {
      readonly name = 'always_warm'
      readonly dim = 512
      isAvailable(): boolean { return true }
      async encode(): Promise<Float32Array> {
        const vec = new Float32Array(this.dim)
        vec[0] = 1
        return vec
      }
      async encodeBatch(texts: string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map(() => this.encode()))
      }
    }

    const live = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: new AlwaysWarm() })
    try {
      await live.remember({ action: 'add', content: '网关由平台组维护。' })
      const res = await live.recall({ action: 'search', query: '网关' })
      expect(res.degraded).toBe(false)

      const health = live.admin({ action: 'stats' }) as unknown as { retrieval: { queries: number; semantic_live_rate: number } }
      expect(health.retrieval.queries).toBeGreaterThan(0)
      expect(health.retrieval.semantic_live_rate).toBe(1)
    } finally {
      live.shutdown()
    }
  })

  it('survives a restart through the stats side table', async () => {
    await rt.remember({ action: 'add', content: '网关由平台组维护。' })
    await rt.recall({ action: 'search', query: '网关', limit: 5 })
    const before = await stats()
    expect(before.retrieval.queries).toBeGreaterThan(0)

    rt.shutdown()
    resetRetrievalHealth() // simulate a fresh process: only the persisted snapshot can restore
    rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    const after = await stats()
    expect(after.retrieval.queries).toBeGreaterThanOrEqual(before.retrieval.queries)
    expect(after.retrieval.by_kind['memory']?.queries).toBeGreaterThanOrEqual(1)
  })
})
