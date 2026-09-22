import { describe, it, expect, afterEach, vi } from 'vitest'
import { LocalReranker, MIN_DOC_TOKENS, type ClassifyFn, type RerankerPipeFactory } from '../src/adapters/local_reranker.js'
import { ENSURE_WARM_FLOOR_MS } from '../src/adapters/warm_gate.js'
import { setRetrievalLogger } from '../src/log.js'
import { resetRetrievalHealth, retrievalHealth } from '../src/stats.js'
import { estimateTokens } from '../src/text_budget.js'
import type { AvantfLogger } from '@avantf/mem-contract'

function collectingLogger(): { logger: AvantfLogger; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
  }
}

describe('LocalReranker (injected pipeline)', () => {
  it('keeps (query, document) pairs intact and orders by {label,score} output', async () => {
    const seen: [string, string][][] = []
    const reranker = new LocalReranker('test-reranker', { autoDownload: false }, async () => {
      return async (pairs) => {
        seen.push(pairs)
        // score by document length so the order is deterministic: 'xyz'(3) > 'abcd'(4)? no: pick length===2 best
        return pairs.map(([q, d]) => ({ label: 'LABEL_0', score: d.length === 2 ? 0.9 : 0.1 }))
      }
    })
    await reranker.warmUp()
    expect(reranker.isAvailable()).toBe(true)

    const order = await reranker.rerank('查询', [
      { id: 1, text: 'abcd' },
      { id: 2, text: 'xy' },
      { id: 3, text: 'abcdef' },
    ])
    // Every pipeline input is a real pair whose first element is the query.
    expect(seen.length).toBe(1)
    for (const pair of seen[0]) {
      expect(pair).toHaveLength(2)
      expect(pair[0]).toBe('查询')
    }
    expect(seen[0].map(p => p[1])).toEqual(['abcd', 'xy', 'abcdef'])
    // id 2 ('xy', score 0.9) must rank first.
    expect(order[0]).toBe(2)
    expect(order).toHaveLength(3)
  })

  it('degrades to identity order when the model cannot load', async () => {
    const reranker = new LocalReranker('test-reranker', { autoDownload: false }, async () => {
      throw new Error('model missing')
    })
    await reranker.warmUp()
    expect(reranker.isAvailable()).toBe(false)
    const order = await reranker.rerank('q', [{ id: 7, text: 'a' }, { id: 8, text: 'b' }])
    expect(order).toEqual([7, 8])
  })

  it('falls back to fused order when inference throws mid-flight', async () => {
    const reranker = new LocalReranker('test-reranker', { autoDownload: false }, async () => {
      return async () => {
        throw new Error('inference exploded')
      }
    })
    await reranker.warmUp()
    const order = await reranker.rerank('q', [{ id: 3, text: 'a' }, { id: 1, text: 'b' }])
    expect(order).toEqual([3, 1])
  })
})

describe('LocalReranker warmup retry', () => {
  afterEach(() => {
    process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = '0'
    vi.useRealTimers()
  })

  it('re-attempts a failed warmup through ensureWarm, throttled by the floor', async () => {
    process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = '1'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    let attempts = 0
    const reranker = new LocalReranker('test-reranker', { autoDownload: true }, async () => {
      attempts += 1
      if (attempts === 1) throw new Error('mirror down')
      return async () => []
    })

    await reranker.warmUp()
    expect(reranker.isAvailable()).toBe(false)

    reranker.ensureWarm()
    expect(attempts).toBe(1)

    vi.setSystemTime(Date.now() + ENSURE_WARM_FLOOR_MS + 1)
    reranker.ensureWarm()
    await reranker.warmUp()
    expect(attempts).toBe(2)
    expect(reranker.isAvailable()).toBe(true)
  })
})

/**
 * The reranker twin of the embedder's `deferWarm` (M1): while the family framework owns the model
 * root, neither adapter may start a fetch from its constructor.
 */
describe('LocalReranker deferred warm', () => {
  function counting(): { factory: RerankerPipeFactory; calls: () => number } {
    let calls = 0
    const factory: RerankerPipeFactory = async () => {
      calls += 1
      return async (pairs) => pairs.map(() => ({ label: 'LABEL_0', score: 0.5 }))
    }
    return { factory, calls: () => calls }
  }

  it('does not warm in the constructor when deferWarm is set, and warms on first rerank', async () => {
    process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = '0'
    const { factory, calls } = counting()
    const reranker = new LocalReranker('test-reranker', { autoDownload: false, deferWarm: true }, factory)

    expect(calls()).toBe(0)
    expect(reranker.isAvailable()).toBe(false)

    const order = await reranker.rerank('q', [{ id: 1, text: 'aa' }, { id: 2, text: 'bb' }])
    expect(calls()).toBe(1)
    expect(reranker.isAvailable()).toBe(true)
    expect(order).toHaveLength(2)
  })

  it('keeps the eager constructor warm by default', async () => {
    process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = '0'
    const { factory, calls } = counting()
    const reranker = new LocalReranker('test-reranker', { autoDownload: false }, factory)
    await reranker.warmUp()
    expect(calls()).toBe(1)
    expect(reranker.isAvailable()).toBe(true)
  })
})

/**
 * The pair budget (DESIGN §20). A cross-encoder scores `[query, document]` as ONE sequence,
 * so the 512-token window is shared with the query — an 800-character chunk has less room here
 * than in `encode()`, and transformers.js truncates the overflow silently.
 */
describe('LocalReranker pair budget', () => {
  function pairFactory(seen: [string, string][], window?: number): RerankerPipeFactory {
    return async () => {
      const fn = (async (pairs: [string, string][]) => {
        seen.push(...pairs)
        return pairs.map(() => ({ label: 'LABEL_0', score: 0.5 }))
      }) as ClassifyFn
      if (window !== undefined) {
        (fn as unknown as { tokenizer: { model_max_length: number } }).tokenizer = { model_max_length: window }
      }
      return fn
    }
  }

  it('bounds the document against the window minus what the query spends', async () => {
    resetRetrievalHealth()
    const { logger, lines } = collectingLogger()
    setRetrievalLogger(logger)
    const seen: [string, string][] = []
    const reranker = new LocalReranker('test-reranker', { autoDownload: false }, pairFactory(seen, 40))

    const query = '部署失败怎么排查'
    await reranker.rerank(query, [{ id: 1, text: '文'.repeat(300) }])

    expect(seen).toHaveLength(1)
    const [sentQuery, sentDoc] = seen[0]
    // The question is never truncated; the document absorbs the whole budget.
    expect(sentQuery).toBe(query)
    expect(sentDoc.length).toBeLessThan(300)
    expect(estimateTokens(sentDoc)).toBeLessThanOrEqual(40 - estimateTokens(query) - 3)
    expect(retrievalHealth().rerank_truncated).toBe(1)
    expect(lines.filter((l) => l.includes('pair exceeded the 40-token window'))).toHaveLength(1)
  })

  it('leaves documents that fit untouched and never counts them', async () => {
    resetRetrievalHealth()
    const seen: [string, string][] = []
    const reranker = new LocalReranker('test-reranker', { autoDownload: false }, pairFactory(seen, 512))
    await reranker.rerank('查询', [{ id: 1, text: 'abcd' }])
    expect(seen[0][1]).toBe('abcd')
    expect(retrievalHealth().rerank_truncated).toBe(0)
  })

  it('keeps a degenerate document when the query alone nearly fills the window', async () => {
    resetRetrievalHealth()
    const seen: [string, string][] = []
    const reranker = new LocalReranker('test-reranker', { autoDownload: false }, pairFactory(seen, 24))
    await reranker.rerank('问'.repeat(23), [{ id: 1, text: '文'.repeat(80) }])
    // MIN_DOC_TOKENS floor: better a short document than an empty one.
    expect(seen[0][1].length).toBeGreaterThan(0)
    expect(estimateTokens(seen[0][1])).toBeLessThanOrEqual(MIN_DOC_TOKENS)
  })
})
