/**
 * Retrieval health after the rerank removal (0.5.0).
 *
 * The three rerank counters (`rerank_used` / `rerank_fallback` / `rerank_truncated`) and the `rerank`
 * truncation kind were removed with the capability (docs/review/RETRIEVAL_RERANK_NECESSITY.md).
 * These are the NEGATIVE pins: the counters must not reappear on the persisted/UI payload, and the
 * truncation kind must not be accepted again. Re-adding them makes these red.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  recordRetrieval,
  recordTruncation,
  resetRetrievalHealth,
  retrievalHealth,
  retrievalHealthSummary,
} from '../src/stats.js'

afterEach(() => { resetRetrievalHealth() })

describe('retrieval health carries no rerank counters', () => {
  it('has no rerank_* key on the raw or the summary payload', () => {
    resetRetrievalHealth()
    recordRetrieval({ kind: 'memory', results: 2, latencyMs: 3, semanticLive: true })
    recordTruncation('embedding')
    recordTruncation('output')
    const keys = [...Object.keys(retrievalHealth()), ...Object.keys(retrievalHealthSummary())]
    expect(keys.filter((key) => key.startsWith('rerank'))).toEqual([])
    // The semantic/truncation counters that DID survive are still there, so this is not vacuous.
    expect(keys).toContain('semantic_live')
    expect(keys).toContain('embedding_truncated')
    expect(keys).toContain('output_truncated')
  })

  it('no longer accepts the removed `rerank` truncation kind', () => {
    // @ts-expect-error `rerank` was removed from `TruncationKind` in 0.5.0.
    recordTruncation('rerank')
    // Whatever the runtime does with the unknown string, it must not light up a rerank counter —
    // there is none left.
    expect(Object.keys(retrievalHealth()).filter((key) => key.startsWith('rerank'))).toEqual([])
  })
})
