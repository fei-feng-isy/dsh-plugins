import { describe, it, expect } from 'vitest'
import {
  CJK_TOKENS_PER_CHAR,
  DEFAULT_MODEL_WINDOW,
  declaredWindowOf,
  estimateTokens,
  resolveWindow,
  truncateToTokens,
  windowChars,
} from '../src/text_budget.js'

describe('estimateTokens', () => {
  it('counts CJK per character and Latin per four characters', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('中文事实')).toBe(4)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('ignores whitespace and mixes the two alphabets', () => {
    expect(estimateTokens('a b c')).toBe(1) // 3 non-space chars → ceil(3/4)
    expect(estimateTokens('中文 ab')).toBe(3) // 2 CJK + ceil(2/4)
    expect(estimateTokens('   ')).toBe(0)
  })

  it('counts an astral character once (code-point walk, not UTF-16 units)', () => {
    expect(estimateTokens('🙂')).toBe(1) // one non-CJK code point, not two surrogates
  })

  it('counts CJK punctuation per character, not at the Latin ratio', () => {
    // 。、《》 and the fullwidth ，！？；： cost one token each in a char-level CJK tokenizer. Leaving
    // them out UNDER-estimated Chinese text — the opposite of this module's stated bias — while
    // `BREAK` already treated the very same characters as first-class clause boundaries.
    expect(estimateTokens('中文。')).toBe(3)
    expect(estimateTokens('《事实》')).toBe(4)
    expect(estimateTokens('，！？；：、')).toBe(6)
  })
})

describe('truncateToTokens', () => {
  it('leaves text inside the budget untouched', () => {
    const out = truncateToTokens('短文本', 64)
    expect(out).toEqual({ text: '短文本', truncated: false, omittedTokens: 0 })
  })

  it('bounds oversize text and reports what it dropped', () => {
    const text = '中'.repeat(400)
    const out = truncateToTokens(text, 100)
    expect(out.truncated).toBe(true)
    expect(out.omittedTokens).toBeGreaterThan(0)
    // The estimate INCLUDING the marker must fit, or the guard would be pointless.
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(100)
    expect(out.text.endsWith('…')).toBe(true)
  })

  it('prefers a sentence boundary near the cut instead of cutting mid-sentence', () => {
    const text = `${'中'.repeat(60)}。${'文'.repeat(60)}`
    const out = truncateToTokens(text, 70)
    expect(out.truncated).toBe(true)
    expect(out.text.endsWith('。…')).toBe(true)
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(70)
  })

  it('is deterministic and never exceeds a one-token budget', () => {
    const text = 'abc'.repeat(50)
    const first = truncateToTokens(text, 1)
    expect(first.truncated).toBe(true)
    expect(estimateTokens(first.text)).toBeLessThanOrEqual(1)
    expect(truncateToTokens(text, 1).text).toBe(first.text)
  })
})

describe('resolveWindow', () => {
  it('auto (0) uses the declared window, then the fallback', () => {
    expect(resolveWindow(0, 512)).toBe(512)
    expect(resolveWindow(0, undefined)).toBe(DEFAULT_MODEL_WINDOW)
  })

  it('an explicit cap wins, but never exceeds what the model can read', () => {
    expect(resolveWindow(1024, 512)).toBe(512) // clamp: the model is the hard limit
    expect(resolveWindow(256, 512)).toBe(256) // a smaller cap is an operator choice
    expect(resolveWindow(256, undefined)).toBe(256)
  })

  it('treats a sentinel model_max_length as not declared', () => {
    expect(resolveWindow(0, 1e30)).toBe(DEFAULT_MODEL_WINDOW)
    expect(resolveWindow(300, Number.NaN)).toBe(300)
  })
})

describe('declaredWindowOf', () => {
  it('reads the tokenizer window off a pipeline, tolerating its absence', () => {
    expect(declaredWindowOf({ tokenizer: { model_max_length: 512 } })).toBe(512)
    expect(declaredWindowOf({ tokenizer: { model_max_length: 1e30 } })).toBeUndefined()
    expect(declaredWindowOf({ tokenizer: {} })).toBeUndefined()
    expect(declaredWindowOf({})).toBeUndefined()
    expect(declaredWindowOf(null)).toBeUndefined()
    expect(declaredWindowOf(undefined)).toBeUndefined()
  })
})

describe('windowChars', () => {
  it('derives the CJK character budget of a window (the chunk_size rationale)', () => {
    expect(windowChars(512)).toBe(510)
    expect(windowChars(512) * CJK_TOKENS_PER_CHAR).toBeLessThanOrEqual(512)
    expect(windowChars(64, 2)).toBe(62)
  })
})
