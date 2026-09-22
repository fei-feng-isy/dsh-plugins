import { describe, it, expect, beforeAll, vi } from 'vitest'
import { extractEntities, extractTriples, jiebaAvailable } from '../src/entities/extract.js'

let hasJieba = false
beforeAll(async () => {
  hasJieba = await jiebaAvailable()
})

describe('entity extraction', () => {
  it('extracts entities from a Chinese sentence', async () => {
    const ents = await extractEntities('张伟管理李娜')
    const names = ents.map((e) => e.name)
    expect(names).toContain('张伟')
    expect(names).toContain('李娜')
  })

  it('extracts latin entities from a tech fact', async () => {
    const ents = await extractEntities('项目使用 PostgreSQL 14')
    const names = ents.map((e) => e.name)
    expect(names.some((n) => n.toLowerCase().includes('postgresql'))).toBe(true)
  })
})

/**
 * The load is memoized as a PROMISE, and that only shows under CONCURRENCY: a result-level memo
 * answers every sequential call from its cache too, so a sequential test passes either way. The
 * fresh module registry is what makes this discriminating — it resets the memo, so the two calls
 * below are the first ones and the count proves whether they SHARED a parse.
 *
 * Measured before the fix: two concurrent callers = 2 parses (2436 ms against 1091 ms for one).
 * The startup deferral in `modelBootstrap` widens the window this happens in, which is why it is
 * pinned rather than left to the profile.
 */
describe('jieba load memoization', () => {
  it('parses the dictionary ONCE for concurrent callers, and not again afterwards', async () => {
    vi.resetModules()
    const fresh = await import('../src/entities/extract.js')
    expect(fresh.jiebaLoadAttempts(), 'a fresh registry must start at zero').toBe(0)

    await Promise.all([fresh.jiebaAvailable(), fresh.tagText('张伟管理李娜')])
    expect(fresh.jiebaLoadAttempts(), 'concurrent callers must share one parse').toBe(1)

    await fresh.tagText('陈静负责发布窗口')
    expect(fresh.jiebaLoadAttempts(), 'and a later call must reuse it').toBe(1)
  })
})

describe('triple extraction', () => {
  it('extracts a clean NP-V-NP triple', async () => {
    if (!hasJieba) return // skip if nodejieba not available
    const triples = await extractTriples('张伟管理李娜')
    expect(triples.length).toBeGreaterThan(0)
    const t = triples[0]
    expect(t.subj).toBe('张伟')
    expect(t.pred).toBe('管理')
    expect(t.obj).toBe('李娜')
  })

  it('keeps negation in the predicate', async () => {
    if (!hasJieba) return
    const triples = await extractTriples('老王不喜欢冗长的解释')
    const t = triples.find((x) => x.pred.includes('喜欢'))
    expect(t?.subj).toBe('老王')
    expect(t?.pred).toContain('不')
  })

  it('strips aspect marker 了', async () => {
    if (!hasJieba) return
    const triples = await extractTriples('陈静加入了平台组')
    const t = triples.find((x) => x.pred === '加入')
    expect(t?.subj).toBe('陈静')
    expect(t?.obj).toContain('平台')
  })

  it('returns [] when jieba is unavailable', async () => {
    // This test exercises the fallback path by calling with an empty string.
    const triples = await extractTriples('')
    expect(triples.length).toBe(0)
  })
})
