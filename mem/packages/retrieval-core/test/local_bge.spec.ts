import { describe, it, expect, afterEach, vi } from 'vitest'
import { LocalBgeBackend, type PipeFactory, type PipelineFn } from '../src/adapters/local_bge.js'
import { ENSURE_WARM_FLOOR_MS } from '../src/adapters/warm_gate.js'
import { setRetrievalLogger } from '../src/log.js'
import { resetRetrievalHealth, retrievalHealth } from '../src/stats.js'
import { DEFAULT_MODEL_WINDOW, estimateTokens } from '../src/text_budget.js'
import type { AvantfLogger } from '@avantf/mem-contract'

/**
 * The suite-wide env (vitest.config.ts) disables downloads, which deliberately
 * makes the retry gate inert — a local-only miss cannot recover. The tests that
 * exercise retrying opt back in.
 */
function downloads(enabled: boolean): void {
  process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = enabled ? '1' : '0'
}

function collectingLogger(): { logger: AvantfLogger; lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
  }
}

/** A pipeline factory that fails the first `failAfter` attempts like a blocked mirror. */
function flaky(failAfter: number): { factory: PipeFactory; attempts: () => number } {
  let attempts = 0
  const factory: PipeFactory = async () => {
    attempts += 1
    if (attempts <= failAfter) {
      const cause = Object.assign(
        new Error('Connect Timeout Error (attempted address: hf-mirror.com:443, timeout: 10000ms)'),
        { code: 'UND_ERR_CONNECT_TIMEOUT' },
      )
      throw new TypeError('fetch failed', { cause })
    }
    return async () => ({ data: new Float32Array([1, 2, 3]) })
  }
  return { factory, attempts: () => attempts }
}

afterEach(() => {
  downloads(false)
  setRetrievalLogger()
  vi.useRealTimers()
})

describe('LocalBgeBackend warmup retry', () => {
  it('re-attempts a failed warmup on ensureWarm, once the floor has elapsed', async () => {
    downloads(true)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { factory, attempts } = flaky(1)
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: true }, factory)

    await backend.warmUp()
    expect(backend.isAvailable()).toBe(false)
    expect(attempts()).toBe(1)

    // Inside the floor nothing happens: a dead mirror must not be re-probed per query.
    backend.ensureWarm()
    expect(attempts()).toBe(1)

    // Past the floor: exactly one more attempt, and it recovers.
    vi.setSystemTime(Date.now() + ENSURE_WARM_FLOOR_MS + 1)
    backend.ensureWarm()
    await backend.warmUp()
    expect(attempts()).toBe(2)
    expect(backend.isAvailable()).toBe(true)
  })

  it('does not stack attempts while one is already in flight', async () => {
    downloads(true)
    let calls = 0
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: true }, async () => {
      calls += 1
      return new Promise(() => {}) // never settles: the attempt stays in flight
    })
    backend.ensureWarm()
    backend.ensureWarm()
    expect(calls).toBe(1)
  })

  it('stays inert when downloads are disabled, because a local-only miss is deterministic', async () => {
    downloads(false)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { factory, attempts } = flaky(99)
    const backend = new LocalBgeBackend('test-model', 3, {}, factory)

    await backend.warmUp()
    expect(attempts()).toBe(1)

    vi.setSystemTime(Date.now() + ENSURE_WARM_FLOOR_MS + 1)
    backend.ensureWarm()
    expect(attempts()).toBe(1)
    expect(backend.isAvailable()).toBe(false)
  })

  it('logs the whole cause chain instead of a bare "fetch failed"', async () => {
    downloads(true)
    const { logger, lines } = collectingLogger()
    setRetrievalLogger(logger)
    const { factory } = flaky(99)
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: true }, factory)

    await backend.warmUp()
    const joined = lines.join('\n')
    expect(joined).toContain('fetch failed <- Connect Timeout Error (attempted address: hf-mirror.com:443, timeout: 10000ms) [UND_ERR_CONNECT_TIMEOUT]')
    expect(joined).toContain('will retry on the next retrieval')
  })
})

/**
 * `deferWarm` (M1): when the family framework is installing the model into the managed root, the
 * runtime must not start its own fetch from the constructor — that races the install and leaves a
 * second copy behind. The opt-out must not lose the model: `encode()` warms lazily.
 */
describe('LocalBgeBackend deferred warm', () => {
  /** A factory that counts invocations and hands back a working single-text pipeline. */
  function counting(): { factory: PipeFactory; calls: () => number } {
    let calls = 0
    const factory: PipeFactory = async () => {
      calls += 1
      return async () => ({ data: new Float32Array([1, 2, 3]) })
    }
    return { factory, calls: () => calls }
  }

  it('does not warm in the constructor when deferWarm is set, and warms on first encode', async () => {
    downloads(false)
    const { factory, calls } = counting()
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: false, deferWarm: true }, factory)

    expect(calls()).toBe(0)
    expect(backend.isAvailable()).toBe(false)

    const vec = await backend.encode('延迟预热')
    expect(calls()).toBe(1)
    expect(vec.length).toBe(3)
    expect(backend.isAvailable()).toBe(true)
  })

  it('keeps the eager constructor warm by default (CLI / MCP / direct construction)', async () => {
    downloads(false)
    const { factory, calls } = counting()
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: false }, factory)
    await backend.warmUp()
    expect(calls()).toBe(1)
    expect(backend.isAvailable()).toBe(true)
  })
})

/**
 * The input-window guard (DESIGN §20).
 *
 * transformers.js truncates past `model_max_length` WITHOUT an error, so the adapter must
 * bound the text itself and report it — otherwise a store gets indexed with a large part of
 * every chunk missing from its vector and nothing anywhere says so.
 */
describe('LocalBgeBackend input window', () => {
  /** A pipeline whose tokenizer declares `window`, recording every text it is asked to encode. */
  function windowedFactory(seen: string[], window?: number): PipeFactory {
    return async () => {
      const fn = (async (text: string) => {
        seen.push(text)
        return { data: new Float32Array([1, 2, 3]) }
      }) as PipelineFn
      if (window !== undefined) {
        (fn as unknown as { tokenizer: { model_max_length: number } }).tokenizer = { model_max_length: window }
      }
      return fn
    }
  }

  it('bounds the text to the declared window and counts the truncation', async () => {
    resetRetrievalHealth()
    const { logger, lines } = collectingLogger()
    setRetrievalLogger(logger)
    const seen: string[] = []
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: false }, windowedFactory(seen, 32))

    await backend.encode('中'.repeat(200))
    expect(seen).toHaveLength(1)
    expect(estimateTokens(seen[0])).toBeLessThanOrEqual(32)
    expect(seen[0].endsWith('…')).toBe(true)
    expect(retrievalHealth().embedding_truncated).toBe(1)
    expect(lines.filter((l) => l.includes('exceeded the 32-token window'))).toHaveLength(1)
  })

  it('warns once per process, not once per chunk', async () => {
    resetRetrievalHealth()
    const { logger, lines } = collectingLogger()
    setRetrievalLogger(logger)
    const seen: string[] = []
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: false }, windowedFactory(seen, 16))

    await backend.encode('中'.repeat(100))
    await backend.encode('文'.repeat(100))
    expect(seen).toHaveLength(2)
    expect(lines.filter((l) => l.includes('exceeded the'))).toHaveLength(1)
    expect(retrievalHealth().embedding_truncated).toBe(2)
  })

  it('lets an explicit cap shrink the budget but never widen it past the model', async () => {
    resetRetrievalHealth()
    const narrow: string[] = []
    const capped = new LocalBgeBackend('test-model', 3, { autoDownload: false, maxInputTokens: 8 }, windowedFactory(narrow, 64))
    await capped.encode('中'.repeat(100))
    expect(estimateTokens(narrow[0])).toBeLessThanOrEqual(8)

    const wide: string[] = []
    const clamped = new LocalBgeBackend('test-model', 3, { autoDownload: false, maxInputTokens: 4096 }, windowedFactory(wide, 16))
    await clamped.encode('中'.repeat(100))
    expect(estimateTokens(wide[0])).toBeLessThanOrEqual(16)
  })

  it('falls back to the default window when the pipeline declares none', async () => {
    resetRetrievalHealth()
    const seen: string[] = []
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: false }, windowedFactory(seen))
    await backend.encode('中'.repeat(DEFAULT_MODEL_WINDOW + 50))
    expect(estimateTokens(seen[0])).toBeLessThanOrEqual(DEFAULT_MODEL_WINDOW)
    expect(retrievalHealth().embedding_truncated).toBe(1)
  })

  it('does not touch text that already fits (facts and queries stay verbatim)', async () => {
    resetRetrievalHealth()
    const seen: string[] = []
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: false }, windowedFactory(seen, 512))
    await backend.encode('项目使用 PostgreSQL 16')
    expect(seen[0]).toBe('项目使用 PostgreSQL 16')
    expect(retrievalHealth().embedding_truncated).toBe(0)
  })
})

/**
 * `encodeBatch` (DESIGN §8).
 *
 * Production ingest deliberately does NOT call it: a batched pass pads every item to the longest
 * one in its group, and real chunks (53–550 chars, median 303) lose more to that padding than they
 * win back in per-call overhead (measured per text: serial 31.2 ms, document-order batch 55.7 ms,
 * length-sorted batch 31.9 ms). The method stays on the interface because a caller whose texts are
 * uniform and short does win (9.96 → 6.71 ms/text at ~100 chars), so its three load-bearing
 * properties are pinned here: the caller's order comes back, groups are length-homogeneous, and
 * anything the model cannot answer as a batch degrades to per-text encodes instead of to garbage.
 */
describe('LocalBgeBackend encodeBatch', () => {
  /** A fake pipeline whose vector identifies its input: `[length, char0, char1]` (dim = 3). */
  function identifying(): { factory: PipeFactory; batches: string[][] } {
    const batches: string[][] = []
    const vec = (t: string): number[] => [t.length, t.charCodeAt(0) || 0, t.charCodeAt(1) || 0]
    const factory: PipeFactory = async () => async (text) => {
      if (Array.isArray(text)) {
        batches.push([...text])
        return { data: new Float32Array(text.flatMap(vec)), dims: [text.length, 3] }
      }
      return { data: new Float32Array(vec(text)) }
    }
    return { factory, batches }
  }

  it('restores the caller order after length-sorting the model call', async () => {
    const { factory, batches } = identifying()
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: false }, factory)

    const texts = ['a'.repeat(11), 'bbbbb', 'cccccccc'] // 11, 5, 8 — deliberately unsorted
    const out = await backend.encodeBatch(texts)

    expect(await backend.encodeBatch([])).toEqual([])
    expect(out.map((v) => v.length)).toEqual([3, 3, 3])
    expect(out.map((v) => Array.from(v))).toEqual([[11, 97, 97], [5, 98, 98], [8, 99, 99]])
    // ONE model call, longest last: sorting happens inside the batch, not by reordering the answer.
    expect(batches).toHaveLength(1)
    expect(batches[0]!.map((t) => t.length)).toEqual([5, 8, 11])
  })

  it('packs length-homogeneous groups of at most 16 and splits the rest', async () => {
    const { factory, batches } = identifying()
    const backend = new LocalBgeBackend('test-model', 3, { autoDownload: false }, factory)

    const texts = Array.from({ length: 20 }, (_, i) => 'x'.repeat(40 - i)) // 40..21, descending
    const out = await backend.encodeBatch(texts)

    expect(batches.map((b) => b.length)).toEqual([16, 4])
    for (const batch of batches) {
      const lengths = batch.map((t) => t.length)
      expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
    }
    expect(out.map((v) => v[0])).toEqual(texts.map((t) => t.length))
  })

  it('degrades to per-text encodes when the model cannot answer a batch', async () => {
    for (const mode of ['throws-on-array', 'no-shape'] as const) {
      const seen: (string | string[])[] = []
      const vec = (t: string): number[] => [t.length, t.charCodeAt(0) || 0, t.charCodeAt(1) || 0]
      const factory: PipeFactory = async () => async (text) => {
        seen.push(text)
        if (Array.isArray(text)) {
          // A single-string-only fake, or a binding that answers one vector per call with no shape:
          // guessing `rows = texts.length` here would slice that one vector into N garbage ones.
          if (mode === 'throws-on-array') throw new TypeError('fake pipeline accepts one text at a time')
          return { data: new Float32Array(text.length * 3) }
        }
        return { data: new Float32Array(vec(text)) }
      }
      const backend = new LocalBgeBackend('test-model', 3, { autoDownload: false }, factory)

      const texts = ['aa', 'bbbb']
      const out = await backend.encodeBatch(texts)

      expect(out.map((v) => Array.from(v)), mode).toEqual([[2, 97, 97], [4, 98, 98]])
      expect(seen.filter((t) => Array.isArray(t)), mode).toHaveLength(1)
      expect(seen.filter((t) => typeof t === 'string'), mode).toEqual(texts)
    }
  })
})
