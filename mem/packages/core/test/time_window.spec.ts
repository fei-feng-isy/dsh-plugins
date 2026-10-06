/**
 * P-11 · the Chinese time-window query, in two halves.
 *
 *  1. **The parser** (`store/time_window.ts`) is a pure function of `(text, now)`; every boundary
 *     case the plan names is pinned here with an injected clock ("pinned_now") — month ends,
 *     cross-year, single/double digits, the `最近N天` Chinese numerals, and the quarter words it
 *     must REFUSE rather than guess.
 *  2. **The leg** is verified as a LEG, not a filter: with `retriever.time_window` on, a window
 *     query's gold fact improves (top-1 and top-3), the union does not shrink (an out-of-window
 *     fact the semantic leg found is still returned), a query with no time word is byte-identical
 *     to the leg-off answer, and a fact with no event time is never a candidate — there is no
 *     `created_at` fallback.
 *
 * The off-by-default proof lives where the requirement puts it: the frozen 41-query
 * `eval_zh.spec.ts` aggregate and the identity check, which this spec does not duplicate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SemanticBackend } from '@avantf/mem-retrieval'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { DAY_MS, localDayString, parseCount, parseTimeWindow, windowDayBounds } from '../src/store/time_window.js'

// ─── 1. the parser ────────────────────────────────────────────────────────────

/** Pinned clock: 2026-10-15 (a Thursday). Every relative rule is asserted against THIS date. */
const PINNED = new Date(2026, 9, 15, 10, 30)
const bounds = (text: string, now: Date = PINNED) => {
  const w = parseTimeWindow(text, now)
  if (w === undefined) throw new Error(`expected a window for ${text}`)
  return windowDayBounds(w)
}
const rule = (text: string, now: Date = PINNED) => parseTimeWindow(text, now)?.rule

describe('P-11 中文时间解析（纯函数，pinned_now 注入）', () => {
  it('parses the absolute forms, single and double digits alike', () => {
    expect(rule('2026年3月5日做了什么')).toBe('yyyy年m月d日')
    expect(bounds('2026年3月5日做了什么')).toEqual({ from: '2026-03-05', to: '2026-03-05' })
    expect(bounds('2026年12月25日')).toEqual({ from: '2026-12-25', to: '2026-12-25' })
    // `25号` is NOT in the shipped table (the spike parses `日` only), and a refusal is the honest
    // boundary: it must not silently fall through to a wider rule.
    expect(parseTimeWindow('2026年12月25号', PINNED)).toBeUndefined()
    expect(rule('2026-3-5 的记录')).toBe('yyyy-m-d')
    expect(bounds('2026-3-5 的记录')).toEqual({ from: '2026-03-05', to: '2026-03-05' })
    expect(bounds('2026/03/05')).toEqual({ from: '2026-03-05', to: '2026-03-05' })
    expect(rule('2026年3月')).toBe('yyyy年m月')
    expect(bounds('2026年3月')).toEqual({ from: '2026-03-01', to: '2026-03-31' })
    expect(bounds('2026年2月')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  it('resolves m月d日 against the INJECTED year, never the wall clock', () => {
    expect(bounds('3月5日')).toEqual({ from: '2026-03-05', to: '2026-03-05' })
    expect(bounds('3月5日', new Date(2027, 0, 2))).toEqual({ from: '2027-03-05', to: '2027-03-05' })
    expect(bounds('12月31日')).toEqual({ from: '2026-12-31', to: '2026-12-31' })
  })

  it('crosses the year boundary for 上个月 / 去年', () => {
    // `now` is January: "last month" is the PREVIOUS December, not December of the same year.
    expect(bounds('上个月做了什么', new Date(2026, 0, 15))).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(bounds('去年', new Date(2026, 0, 1))).toEqual({ from: '2025-01-01', to: '2025-12-31' })
  })

  it('lands on the real month end (2026-02 has 28 days) and never leaks the 1st of the next month', () => {
    expect(bounds('上个月', new Date(2026, 2, 31))).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(bounds('这个月', new Date(2026, 2, 31))).toEqual({ from: '2026-03-01', to: '2026-03-31' })
  })

  it('parses today / yesterday / the day before, and the week windows, off the pinned clock', () => {
    expect(bounds('今天做了什么')).toEqual({ from: '2026-10-15', to: '2026-10-15' })
    expect(bounds('昨天做了什么')).toEqual({ from: '2026-10-14', to: '2026-10-14' })
    expect(bounds('前天做了什么')).toEqual({ from: '2026-10-13', to: '2026-10-13' })
    // 2026-10-15 is a Thursday; the week starts Monday.
    expect(rule('本周做了什么')).toBe('本周')
    expect(bounds('本周做了什么')).toEqual({ from: '2026-10-12', to: '2026-10-18' })
    expect(rule('上周做了什么')).toBe('上周')
    expect(bounds('上周做了什么')).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(bounds('今年')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })

  it('reads 最近N天 with arabic AND Chinese numerals', () => {
    const today = '2026-10-15'
    const threeAgo = localDayString(PINNED.getTime() - 3 * DAY_MS)
    expect(rule('最近三天做了什么')).toBe('最近N天')
    expect(bounds('最近三天做了什么')).toEqual({ from: threeAgo, to: today })
    expect(bounds('最近 3 天做了什么')).toEqual({ from: threeAgo, to: today })
    expect(bounds('最近十天做了什么')).toEqual({ from: localDayString(PINNED.getTime() - 10 * DAY_MS), to: today })
    expect(bounds('最近二十一天做了什么')).toEqual({ from: localDayString(PINNED.getTime() - 21 * DAY_MS), to: today })
    // …and the fixed-length forms keep the spike's rules.
    expect(rule('最近一周做了什么')).toBe('最近一周')
    expect(bounds('最近一周做了什么')).toEqual({ from: localDayString(PINNED.getTime() - 7 * DAY_MS), to: today })
  })

  it('parses the numeral grammar directly, and refuses what it cannot read', () => {
    expect(parseCount('3')).toBe(3)
    expect(parseCount('三')).toBe(3)
    expect(parseCount('两')).toBe(2)
    expect(parseCount('十')).toBe(10)
    expect(parseCount('十三')).toBe(13)
    expect(parseCount('三十')).toBe(30)
    expect(parseCount('二十一')).toBe(21)
    expect(parseCount('零')).toBeUndefined()
    expect(parseCount('abc')).toBeUndefined()
    expect(parseCount('100')).toBeUndefined()
  })

  it('REFUSES quarter words instead of guessing a window', () => {
    // A wrong window silently boosts wrong facts; no window leaves the other legs untouched.
    expect(parseTimeWindow('上季度做了什么', PINNED)).toBeUndefined()
    expect(parseTimeWindow('第三季度做了什么', PINNED)).toBeUndefined()
    expect(parseTimeWindow('2026年第三季度做了什么', PINNED)).toBeUndefined()
    expect(parseTimeWindow('本季度复盘', PINNED)).toBeUndefined()
  })

  it('returns undefined for text with no expression at all', () => {
    expect(parseTimeWindow('支付网关怎么配置', PINNED)).toBeUndefined()
    expect(parseTimeWindow('', PINNED)).toBeUndefined()
  })
})

// ─── 2. the leg ───────────────────────────────────────────────────────────────

const DIM = 768

/**
 * A deterministic stand-in for the embedder: `encode(text)` returns a unit vector whose dot product
 * with the pinned query axis is the recorded cosine. Facts absent from the table get the ZERO
 * vector (cosine 0), which every floor drops — so the ranking below is exactly the arithmetic in
 * the numbers, with no model and no download.
 */
function cosineStub(cosines: Readonly<Record<string, number>>): SemanticBackend {
  const encode = async (text: string): Promise<Float32Array> => {
    const v = new Float32Array(DIM)
    const c = cosines[text]
    if (c === undefined) return v
    v[0] = c
    v[1] = Math.sqrt(Math.max(0, 1 - c * c))
    return v
  }
  return {
    name: 'p11-cosine-stub',
    dim: DIM,
    encode,
    encodeBatch: async (texts: string[]) => Promise.all(texts.map((t) => encode(t))),
    isAvailable: () => true,
  }
}

/** No model, no vectors at all — the FTS/entity/time legs only. */
function neverWarm(): SemanticBackend {
  return {
    name: 'p11-never-warm',
    dim: DIM,
    encode: async () => { throw new Error('no model') },
    encodeBatch: async () => { throw new Error('no model') },
    isAvailable: () => false,
  }
}

/** The window query: an ABSOLUTE expression, so the leg's answer cannot move with the wall clock. */
const WINDOW_QUERY = '2026年9月做了什么'
const GOLD = '完成了支付网关的重构'
const HIGHEST = '完成了报表系统的重构'
const SECOND = '完成了缓存层的重构'
const NO_EVENT = '完成了鉴权模块的重构'
const OTHER = '完成了调度器的重构'

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-time-window-'))
  rt = buildRuntime({
    dataHome: dir,
    memoryDbPath: join(dir, 'memory.db'),
    semantic: cosineStub({ [WINDOW_QUERY]: 1, [GOLD]: 0.55, [HIGHEST]: 0.65, [SECOND]: 0.6, [NO_EVENT]: 0.58, [OTHER]: 0.56 }),
  })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

const ids = (r: { hits: { ref_id: number }[] }): number[] => r.hits.map((h) => h.ref_id)
const ranked = (r: { hits: { ref_id: number; score: number }[] }) => r.hits.map((h) => `${String(h.ref_id)}:${h.score}`)

describe('P-11 时间窗腿（默认关；共享 jaccard 权重位，一腿而非过滤器）', () => {
  it('improves top-1 and top-3 on the window query, and never shrinks the union', async () => {
    const gold = (await rt.remember({ action: 'add', content: GOLD, event_date: '2026-09-15' })).fact_id
    const highest = (await rt.remember({ action: 'add', content: HIGHEST, event_date: '2026-10-15' })).fact_id
    const second = (await rt.remember({ action: 'add', content: SECOND, event_date: '2026-08-15' })).fact_id
    const noEvent = (await rt.remember({ action: 'add', content: NO_EVENT })).fact_id
    const other = (await rt.remember({ action: 'add', content: OTHER })).fact_id

    // Leg OFF (the shipped default): the strongest cosine wins and the gold is out of the top 3.
    const off = await rt.memory.search({ query: WINDOW_QUERY, limit: 3 })
    expect(ids(off), 'leg off: the gold is below the top 3').not.toContain(gold)
    expect(ids(off)[0], 'leg off: top-1 is the strongest-cosine fact, not the gold').toBe(highest)

    // Leg ON.
    rt.config.common.retriever.time_window = true
    const on = await rt.memory.search({ query: WINDOW_QUERY, limit: 3 })
    expect(ids(on)[0], 'leg on: the in-window gold is top-1').toBe(gold)
    expect(ids(on), 'leg on: the gold is in the top 3').toContain(gold)

    // …and it is a LEG, not a filter: the full pool still holds every fact the other legs found.
    const full = await rt.memory.search({ query: WINDOW_QUERY, limit: 10 })
    expect(new Set(ids(full))).toEqual(new Set([gold, highest, second, noEvent, other]))

    // The reported weights stay the 3-key contract (the leg shares the jaccard slot).
    expect(Object.keys(on.weights).sort()).toEqual(['fts', 'jaccard', 'semantic'])
    expect(on.weights.jaccard).toBe(rt.config.common.retriever.weight_jaccard)
  })

  it('is present in BOTH passes of the self-reference augmentation (the by-index merge contract)', async () => {
    const gold = (await rt.remember({ action: 'add', content: GOLD, event_date: '2026-09-15' })).fact_id
    await rt.remember({ action: 'add', content: HIGHEST, event_date: '2026-10-15' })
    rt.config.common.retriever.time_window = true

    // Arm 1: the ORIGINAL carries the window and the rewrite does not. The leg must survive the
    // index-wise union even though the second run contributes an empty map.
    const originalWindowed = await rt.memory.search({
      query: WINDOW_QUERY, limit: 3, rewriteQuery: (q) => (q === WINDOW_QUERY ? '用户是谁' : undefined),
    })
    expect(ids(originalWindowed)[0], 'the original run\'s window still promotes the gold').toBe(gold)

    // Arm 2: the REWRITE carries the window and the original does not — the merged leg must pick the
    // rewrite's candidates up at the SAME index (a query-gated append would misalign the two runs).
    const rewriteWindowed = await rt.memory.search({ query: '我是谁？', limit: 3, rewriteQuery: () => WINDOW_QUERY })
    expect(ids(rewriteWindowed)[0], 'the rewrite run\'s window is merged, not dropped').toBe(gold)
  })

  it('leaves a query with NO time word byte-identical (guards the no-time-word regression net)', async () => {
    await rt.remember({ action: 'add', content: GOLD, event_date: '2026-09-15' })
    await rt.remember({ action: 'add', content: HIGHEST, event_date: '2026-10-15' })
    await rt.remember({ action: 'add', content: SECOND, event_date: '2026-08-15' })

    const query = '支付网关的重构'
    expect(parseTimeWindow(query), 'the guard query really carries no time expression').toBeUndefined()
    const off = await rt.memory.search({ query, limit: 5 })
    rt.config.common.retriever.time_window = true
    const on = await rt.memory.search({ query, limit: 5 })
    expect(ranked(on), 'the leg contributes an EMPTY map, so ids and scores are unchanged').toEqual(ranked(off))
  })

  it('does not rescue an unrelated query (empty stays empty)', async () => {
    await rt.remember({ action: 'add', content: GOLD, event_date: '2026-09-15' })
    const off = await rt.memory.search({ query: '量子纠缠', limit: 5 })
    expect(ids(off), 'the unrelated guard is empty with the leg off').toHaveLength(0)
    rt.config.common.retriever.time_window = true
    const on = await rt.memory.search({ query: '量子纠缠', limit: 5 })
    expect(ids(on), 'and still empty with it on (no time word)').toHaveLength(0)
  })

  it('keeps a fact with no event time visible to the other legs, and out of the window leg', async () => {
    const inWindow = (await rt.remember({ action: 'add', content: GOLD, event_date: '2026-09-15' })).fact_id
    const noEvent = (await rt.remember({ action: 'add', content: NO_EVENT })).fact_id
    rt.config.common.retriever.time_window = true
    // The no-event fact is still returned by the semantic leg for a query it matches…
    const related = await rt.memory.search({ query: '2026年9月做了什么', limit: 10 })
    expect(ids(related)).toContain(noEvent)
    // …and the admin coverage the operator uses to decide whether to enable the leg is readable.
    const stats = rt.admin({ action: 'stats' })
    expect(stats.validity.active).toBe(2)
    expect(stats.validity.facts_with_valid_from).toBe(1)
    expect(stats.validity.coverage).toBeCloseTo(0.5, 10)
    expect(inWindow).toBeGreaterThan(0)
  })
})

describe('P-11 时间窗腿只读 valid_from（不回退 created_at）', () => {
  it('accepts a full ISO timestamp and REFUSES a non-padded date instead of mis-binning it', async () => {
    const d = mkdtempSync(join(tmpdir(), 'avantf-time-window-shape-'))
    const store = buildRuntime({ dataHome: d, memoryDbPath: join(d, 'memory.db'), semantic: neverWarm() })
    try {
      // Fixture self-check: the non-padded form really is storable (Date.parse accepts it), so the
      // guard below is testing something that can actually occur, not a shape the write path rejects.
      expect(Number.isNaN(Date.parse('2026-9-5')), 'non-padded dates survive the write-side check').toBe(false)
      const stamped = (await store.remember({
        action: 'add', content: '发布窗口的记录一', event_date: '2026-09-15T09:30:00+08:00',
      })).fact_id
      const nonPadded = (await store.remember({
        action: 'add', content: '发布窗口的记录二', event_date: '2026-9-5',
      })).fact_id

      store.config.common.retriever.time_window = true
      const on = await store.memory.search({ query: '2026年9月做了什么', limit: 10 })
      expect(ids(on), 'the day-prefix of a full ISO timestamp lands in the window').toContain(stamped)
      // `2026-9-5` sorts after `2026-09-30` as a string; the GLOB shape guard keeps it out.
      expect(ids(on), 'a non-canonical prefix is excluded, not binned into September').not.toContain(nonPadded)
    } finally {
      store.shutdown()
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('a fact created today with no event time is not a "今天" candidate', async () => {
    const d = mkdtempSync(join(tmpdir(), 'avantf-time-window-fallback-'))
    const store = buildRuntime({ dataHome: d, memoryDbPath: join(d, 'memory.db'), semantic: neverWarm() })
    try {
      const today = localDayString(Date.now())
      const dated = (await store.remember({ action: 'add', content: '今天上线了新的调度器', event_date: today })).fact_id
      const createdToday = (await store.remember({ action: 'add', content: '今天修复了缓存穿透' })).fact_id

      // Off: nothing lexical matches, and the leg is off — empty.
      const off = await store.memory.search({ query: '今天做了什么', limit: 5 })
      expect(ids(off), 'leg off: no leg can see either fact').toHaveLength(0)

      // On: the EVENT time is the only admissible signal, so the dated fact comes back and the
      // fact that merely happens to have been WRITTEN today does not.
      store.config.common.retriever.time_window = true
      const on = await store.memory.search({ query: '今天做了什么', limit: 5 })
      expect(ids(on), 'the dated fact is served by the window leg').toContain(dated)
      expect(ids(on), 'created_at is NOT an event time — no fallback').not.toContain(createdToday)
    } finally {
      store.shutdown()
      rmSync(d, { recursive: true, force: true })
    }
  })
})
