import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRuntime, type AvantfRuntime } from '../src/index.js'
import { gradedTerms, looksRelevant, relevanceTerms, substringTerms } from '../src/store/lexical.js'
import { loadEvalCases } from '../src/eval/loader.js'
import { allowAnyDomain } from './helpers.js'

/**
 * The bar behind the plugin's conditional hints (DESIGN §12).
 *
 * The unit cases pin the SHAPE (what counts as a term, and that one term is not evidence); the
 * end-to-end cases pin the measured behaviour on a real store, which is the only place the claim
 * "this store holds something relevant" can be checked against actual text.
 */
describe('relevanceTerms', () => {
  it('takes latin/digit words of >= 5 chars and every CJK 3-gram', () => {
    // `write`/`test` are exactly what the length floor exists to remove: they matched an unrelated
    // English question against the real memory store of 34 Chinese facts.
    const terms = relevanceTerms('cgroup v2 unit test this for 内存保护 memory')
    expect(terms).toContain('cgroup')
    expect(terms).toContain('memory')
    // The floor removes the generic short words that made an unrelated English question match the
    // real memory store. `write` (5 chars) is NOT removed — it is admitted and simply fails to
    // clear the two-term bar on its own, which is why the bar and the floor are both needed.
    for (const short of ['unit', 'test', 'this', 'for', 'v2']) expect(terms).not.toContain(short)
    // The trigram tokenizer cannot express a shorter CJK term, so 3-grams are the unit.
    expect(terms).toEqual(expect.arrayContaining(['内存保', '存保护']))
    expect(terms).not.toContain('内存')
  })

  it('dedupes and bounds the number of terms', () => {
    expect(relevanceTerms('cgroup cgroup CGROUP')).toEqual(['cgroup'])
    expect(relevanceTerms('一'.repeat(200)).length).toBeLessThanOrEqual(24)
  })

  it('returns nothing for input with no expressible term', () => {
    expect(relevanceTerms('a b 好')).toEqual([])
  })
})

/**
 * The SHORT-QUERY fallback (task E1). `relevanceTerms` is deliberately unchanged — the conditional
 * hint still probes the index only — and the leg-side term set is `gradedTerms`, which is
 * `relevanceTerms` verbatim unless the query has NO indexed term at all. These are the invariants
 * that keep the labelled set stable: any query that produced a term before produces exactly the
 * same terms now.
 */
describe('gradedTerms (short-CJK fallback)', () => {
  it('substringTerms takes exactly the 2-char CJK runs — not 1-char, not latin, not 3+', () => {
    expect(substringTerms('李娜')).toEqual(['李娜'])
    expect(substringTerms('李娜 张伟')).toEqual(['李娜', '张伟'])
    expect(substringTerms('李娜负责支付网关')).toEqual([]) // 6-char run: 3-grams are the index's unit
    // A single character is not evidence (the same reason `looksRelevant` needs two terms).
    expect(substringTerms('李')).toEqual([])
    expect(substringTerms('ab 好')).toEqual([])
    expect(substringTerms('李娜 李娜')).toEqual(['李娜']) // deduped
    // A 4-char run is NOT two 2-char terms: the run length decides, not the substring search.
    expect(substringTerms('李娜李娜')).toEqual([])
  })

  it('gradedTerms returns the INDEX terms whenever the query has any of them', () => {
    // The fallback is whole-query, not per run: a mixed text keeps only its trigrams, so a measured
    // query can never gain a substring term (and `applyTermFloor` can never grade it differently).
    expect(gradedTerms('支付网关')).toEqual(relevanceTerms('支付网关'))
    expect(gradedTerms('缓存失效 李娜')).toEqual(relevanceTerms('缓存失效 李娜'))
    expect(gradedTerms('cgroup v2 的内存保护')).toEqual(relevanceTerms('cgroup v2 的内存保护'))
    // No indexed term → the 2-char runs themselves; no term of either kind → nothing (not graded).
    expect(gradedTerms('李娜')).toEqual(['李娜'])
    expect(gradedTerms('a b 好')).toEqual([])
  })

  it('REGRESSION: every query of the frozen 41 that has an indexed term is bit-identical', () => {
    // Machine-checked "long queries do not move": `gradedTerms(q) === relevanceTerms(q)` for every
    // query the frozen set measures through the indexed path. The only queries that differ are the
    // 2-char ones that had NO leg at all.
    const here = dirname(fileURLToPath(import.meta.url))
    const cases = loadEvalCases(join(here, 'fixtures', 'eval_zh_relations.jsonl'))
    const queries = cases.flatMap((c) => c.queries.map((q) => q.query))
    const changed = queries.filter((q) => JSON.stringify(gradedTerms(q)) !== JSON.stringify(relevanceTerms(q)))
    const expectedChanged = queries.filter((q) => relevanceTerms(q).length === 0 && substringTerms(q).length > 0)
    expect(new Set(changed)).toEqual(new Set(expectedChanged))
    expect(changed.length, 'the frozen set has 2-char queries whose only term is the fallback').toBeGreaterThan(0)
    expect(changed.every((q) => (q.match(/[\u4e00-\u9fff]/g) ?? []).length === 2)).toBe(true)
  })
})

describe('looksRelevant', () => {
  it('needs TWO distinct terms: one hit is what a common word produces', () => {
    expect(looksRelevant({ terms: 5, matched: 1 })).toBe(false)
    expect(looksRelevant({ terms: 5, matched: 2 })).toBe(true)
    expect(looksRelevant({ terms: 0, matched: 0 })).toBe(false)
  })
})

describe('lexicalProbe short-circuit (R2-5)', () => {
  it('stops at `stopAt` while the default still returns the exact count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-probe-'))
    allowAnyDomain(dir)
    const rt = buildRuntime({ dataHome: dir, logger: { info() {}, warn() {}, error() {} } })
    try {
      await rt.knowledge.ingest(
        'Cgroup v2 的内存保护：memory.min 是硬保护，memory.low 是软保护，OOM 时回收。',
        'os',
        'summary',
        '综述',
      )
      const query = 'cgroup v2 的内存保护 memory.min memory.low'
      // The exact count is what the module comment's calibration records; `relevance()` only asks
      // "≥ 2?", so it passes a stopAt and spares the rest of the lookups on the synchronous path.
      expect(rt.knowledge.lexicalProbe(query).matched).toBeGreaterThan(2)
      expect(rt.knowledge.lexicalProbe(query, 2)).toMatchObject({ matched: 2 })
    } finally {
      rt.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('AvantfRuntime.relevance (the plugin-internal boolean answer)', () => {
  let dir: string
  let rt: AvantfRuntime

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'avantf-lexical-'))
    allowAnyDomain(dir)
    rt = buildRuntime({ dataHome: dir, logger: { info() {}, warn() {}, error() {} } })
  })
  afterEach(() => {
    rt.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('answers false for an empty store, and never throws', async () => {
    expect(rt.relevance('cgroup v2 的内存保护 memory.min memory.low')).toBe(false)
    expect(rt.relevance('')).toBe(false)
  })

  it('answers true from wherever the content actually is', async () => {
    await rt.knowledge.ingest('Cgroup v2 的内存保护：memory.min 是硬保护，memory.low 是软保护。', 'os', 'summary', 'Cgroup v2 综述')
    // Knowledge alone, then memory added on top: both answer `true` — which store matched is not a
    // distinction anything downstream consumes (`kb_query` retrieves from both).
    expect(rt.relevance('cgroup v2 的内存保护 memory.min memory.low')).toBe(true)
    // A question the document does not cover stays silent — the whole point of the bar.
    expect(rt.relevance('帮我重构这个函数的错误处理')).toBe(false)

    // `add` is async: probing before it resolves reads the store before the write lands.
    await rt.memory.add('内核参数 cgroup 的 memory.min 用于硬保护关键进程的内存', 'config')
    expect(rt.relevance('cgroup 的 memory.min 是怎么保护内存的')).toBe(true)
  })

  it('does not fire on a single shared term (the conservative half of the trade)', async () => {
    await rt.memory.add('内核参数 cgroup 的 memory.min 用于硬保护关键进程的内存', 'config')
    // Nothing here is expressible: `内存保` is a 3-gram the fact does not contain, and a lone
    // matching term is not evidence anyway.
    expect(rt.relevance('内存保')).toBe(false)
  })
})
