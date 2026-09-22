import { describe, it, expect } from 'vitest'
import { summarize } from '../src/client/summarize.js'

/**
 * What a settings-page notice reads. Every branch here is a result shape the host can
 * actually return, so a new shape that falls through to the `JSON.stringify` fallback
 * shows up as a JSON wall in the UI rather than as a test failure — hence the pins.
 */
describe('settings-page result summary', () => {
  it('renders nothing for an empty payload', () => {
    expect(summarize(null)).toBe('')
    expect(summarize(undefined)).toBe('')
  })

  it('counts a bare array', () => {
    expect(summarize([1, 2, 3])).toBe('：共 3 项')
    expect(summarize([])).toBe('：共 0 项')
  })

  it('renders a plain fact write as NOTHING (the label already names the fact)', () => {
    // The regression this pins: without the `is_new` branch the raw AddResult fell
    // through to JSON.stringify, so every edit ended with a JSON wall.
    expect(summarize({ fact_id: 9, is_new: true, revived: false, entities: ['老王'] })).toBe('')
    expect(summarize({ fact_id: 9, is_new: false, revived: true, entities: [] })).toBe('')
  })

  it('reports contradictions detected while writing, instead of the bare 完成', () => {
    const text = summarize({
      fact_id: 9,
      is_new: true,
      revived: false,
      entities: [],
      contradictions: [{ other_fact_id: 4, score: 0.95 }],
    })
    expect(text).toContain('检出 1 处冲突')
    expect(text).toContain('#4 @0.95')
    expect(text).toContain('查看未处理矛盾')
    // an empty list is not a conflict
    expect(summarize({ fact_id: 9, is_new: true, contradictions: [] })).toBe('')
  })

  it('names the pair id a verdict takes, when the host sends one', () => {
    // The write payload carries `contradiction_id` (the handle `contradict_resolve` takes), so the
    // notice names it and the reader does not have to look the pair up again.
    const withId = summarize({
      fact_id: 9,
      is_new: true,
      contradictions: [{ contradiction_id: 3, other_fact_id: 4, score: 0.95 }],
    })
    expect(withId).toContain('#4 @0.95（矛盾 #3）')

    // A payload from an older host carries no id: keep the readable notice, never "undefined".
    const withoutId = summarize({ fact_id: 9, is_new: true, contradictions: [{ other_fact_id: 4, score: 0.95 }] })
    expect(withoutId).toContain('#4 @0.95')
    expect(withoutId).not.toContain('矛盾 #')
  })

  it('collapses a long conflict list instead of printing every id', () => {
    // The host caps the payload (model-facing), but 20 ids is still not page text.
    const many = Array.from({ length: 20 }, (_, i) => ({ other_fact_id: i + 1, score: 0.9 - i * 0.01 }))
    const text = summarize({ fact_id: 99, is_new: true, contradictions: many })
    expect(text).toContain('检出 20 处冲突')
    expect(text).toContain('#1 @0.90')
    expect(text).toContain('#3 @0.88')
    expect(text).not.toContain('#4 @') // capped at three ids
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(120)
  })

  it('renders a malformed conflict entry without throwing', () => {
    // `score` comes off the wire; a missing one must not crash the render path with
    // "toFixed is not a function" (it used to be called unconditionally).
    const text = summarize({ fact_id: 9, is_new: true, contradictions: [{ other_fact_id: 7 }] })
    expect(text).toContain('#7 @?')
  })

  it('reports both halves of a batch import', () => {
    expect(summarize({ imported: [{}, {}], failed: [] })).toBe('：成功 2 个')
    const partial = summarize({ imported: [{}], failed: [{ path: 'x.md', error: 'EACCES' }] })
    expect(partial).toContain('成功 1 个')
    expect(partial).toContain('失败 1 个')
    // a payload that carries `imported` must never be summarised as a JSON blob
    expect(partial).not.toContain('{')
  })

  it('renders the other single-purpose results', () => {
    expect(summarize({ chunks: 7 })).toBe('：7 个切片')
    // `chunks` is tested first, so an ingest result reports its chunk count, not its id.
    expect(summarize({ doc_id: 3, chunks: 2 })).toBe('：2 个切片')
    expect(summarize({ doc_id: 3 })).toBe('：doc_id=3')
    expect(summarize({ removed: true })).toBe('：已删除')
    expect(summarize({ removed: false })).toBe('：未找到')
    expect(summarize({ error: 'boom' })).toBe('：boom')
  })

  it('falls back to a TRUNCATED json rendering for an unknown object', () => {
    const text = summarize({ something: 'x'.repeat(400) })
    expect(text.startsWith('：{')).toBe(true)
    expect(text.length).toBeLessThan(180)
    expect(text.endsWith('…')).toBe(true)
  })

  it('never throws on a circular payload', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(summarize(cyclic)).toBe('')
  })
})
