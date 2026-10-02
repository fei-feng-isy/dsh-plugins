/**
 * The well-formed-text kit: one string repair and its JSON-shaped recursive twin.
 *
 * The defect this pins is invisible to JavaScript's own parser: `JSON.stringify` emits a lone
 * surrogate as the escape `"\ud800"`, `JSON.parse` accepts it, and a strict parser (jq, Python's
 * stdout, `serde_json`) rejects the whole document. So these tests do NOT ask `JSON.parse` whether the
 * text is fine — they scan the serialized text for a surrogate escape and the repaired strings for an
 * unpaired code unit, which is the property `JSON.parse` cannot see.
 *
 * The single-string contract lives in ONE function ({@link expectStringContract}) so the native
 * `String.prototype.toWellFormed` path and the local `charCodeAt` fallback run the byte-identical
 * assertions. "Equivalent fallback" is only meaningful if the same expectations pass on both.
 *
 * @module test/wellformed
 */
import { describe, expect, it } from 'vitest'
import { wellFormedDeep, wellFormedText } from '../src/kit/wellformed.js'

/** U+FFFD REPLACEMENT CHARACTER. */
const REPLACEMENT = '\uFFFD'
/** A lone HIGH surrogate (`D800–DBFF`, no low half follows). */
const LONE_HIGH = '\uD800'
/** A lone LOW surrogate (`DC00–DFFF`, no high half precedes). */
const LONE_LOW = '\uDC00'
/** The HIGH half of the emoji below, on its own — "half an emoji". */
const HALF_EMOJI = '\uD83D'
/** A complete emoji (`U+1F642`): a real surrogate pair, must survive byte-for-byte. */
const EMOJI = '\u{1F642}'
/** `U+20000` (𠀀), a CJK Extension B ideograph: a real pair, not a defect. */
const CJK_EXT_B = '\u{20000}'
/** Quote, backslash, newline, tab — none of them a surrogate, all must be untouched. */
const METACHARS = '"\\\n\t'

/** `String.prototype` seen structurally: the repo compiles against `lib: es2023`. */
type WellFormedPrototype = {
  toWellFormed?: (this: string) => string
  isWellFormed?: (this: string) => boolean
}

/**
 * The COMPLETE behavioural contract of the single-string repair, as a function of the implementation.
 */
function expectStringContract(repair: (text: string) => string): void {
  // both kinds of lone surrogate become U+FFFD
  expect(repair(LONE_HIGH)).toBe(REPLACEMENT)
  expect(repair(LONE_LOW)).toBe(REPLACEMENT)
  expect(repair(`a${LONE_HIGH}b`)).toBe(`a${REPLACEMENT}b`)
  expect(repair(`a${LONE_LOW}b`)).toBe(`a${REPLACEMENT}b`)
  // half an emoji: the unpaired high, and separately its unpaired low
  expect(repair(HALF_EMOJI)).toBe(REPLACEMENT)
  expect(repair('\uDE42')).toBe(REPLACEMENT)
  // a complete emoji and a CJK Extension B character are REAL pairs and must survive unchanged
  expect(repair(EMOJI)).toBe(EMOJI)
  expect(repair(CJK_EXT_B)).toBe(CJK_EXT_B)
  expect(repair(`${EMOJI}${CJK_EXT_B}`)).toBe(`${EMOJI}${CJK_EXT_B}`)
  // quotes / backslashes / newlines / tabs are not surrogates
  expect(repair(METACHARS)).toBe(METACHARS)
  // a SPLIT pair is two lone surrogates, never one pair
  expect(repair(`${LONE_HIGH}${LONE_HIGH}`)).toBe(`${REPLACEMENT}${REPLACEMENT}`)
  expect(repair(`${LONE_LOW}${LONE_LOW}`)).toBe(`${REPLACEMENT}${REPLACEMENT}`)
  expect(repair(`${LONE_HIGH}x${HALF_EMOJI}`)).toBe(`${REPLACEMENT}x${REPLACEMENT}`)
  // a LOW half followed by a HIGH half does not pair up either
  expect(repair(`${LONE_LOW}${LONE_HIGH}`)).toBe(`${REPLACEMENT}${REPLACEMENT}`)
  // idempotent
  const once = repair(`a${LONE_HIGH}b${HALF_EMOJI}c`)
  expect(repair(once)).toBe(once)
  expect(repair(repair(METACHARS))).toBe(METACHARS)
  // empty stays empty
  expect(repair('')).toBe('')
}

/**
 * Run `run` with the engine's `String.prototype.toWellFormed` removed, restoring it afterwards — the
 * stub switch that drives the LOCAL fallback through the very same code path a pre-ES2024 Node takes.
 */
function withoutNativeToWellFormed(run: () => void): void {
  const prototype = String.prototype as WellFormedPrototype
  const native = prototype.toWellFormed
  expect(native, 'the fallback test is only meaningful on an engine that HAS the native member').toBeTypeOf('function')
  delete prototype.toWellFormed
  try {
    expect(prototype.toWellFormed).toBeUndefined()
    run()
  } finally {
    if (native !== undefined) prototype.toWellFormed = native
  }
}

/** `\uD800`–`\uDFFF` written as a JSON escape — exactly what a strict parser refuses. */
const SURROGATE_ESCAPE = /\\u[dD][89abAB][0-9a-fA-F]{2}/u

/** Assert `text` carries no UNPAIRED UTF-16 code unit, with an independent scan (not the builtin). */
function expectNoLoneSurrogate(text: string, label: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : -1
      expect(next >= 0xdc00 && next <= 0xdfff, `${label}: unpaired high surrogate at ${String(index)} (${JSON.stringify(text)})`).toBe(true)
      index += 1
      continue
    }
    expect(unit < 0xdc00 || unit > 0xdfff, `${label}: unpaired low surrogate at ${String(index)} (${JSON.stringify(text)})`).toBe(true)
  }
}

describe('wellFormedText — one string', () => {
  it('repairs with the engine\'s own String.prototype.toWellFormed when it exists', () => {
    const native = (String.prototype as WellFormedPrototype).toWellFormed
    expect(native, 'Node >= 20 (this repo is >= 22) provides toWellFormed').toBeTypeOf('function')
    expectStringContract(wellFormedText)
  })

  it('runs the SAME contract from the local charCodeAt scan when toWellFormed is absent', () => {
    withoutNativeToWellFormed(() => {
      expectStringContract(wellFormedText)
    })
  })

  it('agrees with the engine builtin on every sample', () => {
    const native = (String.prototype as WellFormedPrototype).toWellFormed
    if (typeof native !== 'function') return // an older engine only has the local scan
    for (const sample of [LONE_HIGH, LONE_LOW, HALF_EMOJI, '\uDE42', EMOJI, CJK_EXT_B, METACHARS, `${LONE_HIGH}x${HALF_EMOJI}`, `${LONE_LOW}${LONE_HIGH}`]) {
      expect(wellFormedText(sample)).toBe(native.call(sample))
    }
  })

  it('leaves the result well-formed even when the input was the worst case', () => {
    expectNoLoneSurrogate(wellFormedText(`k${LONE_HIGH}:${HALF_EMOJI}:${LONE_LOW}`), 'wellFormedText')
    expectNoLoneSurrogate(wellFormedText(METACHARS), 'wellFormedText')
  })
})

describe('wellFormedDeep — JSON-shaped values', () => {
  it('repairs strings nested in arrays and plain objects, including object KEYS', () => {
    const input = {
      [`k${LONE_HIGH}`]: [`a${LONE_LOW}b`, { deep: HALF_EMOJI }],
      fine: EMOJI,
      n: 7,
    }
    expect(wellFormedDeep(input)).toEqual({
      [`k${REPLACEMENT}`]: [`a${REPLACEMENT}b`, { deep: REPLACEMENT }],
      fine: EMOJI,
      n: 7,
    })
  })

  it('repairs a lone top-level string', () => {
    expect(wellFormedDeep(`a${LONE_HIGH}b`)).toBe(`a${REPLACEMENT}b`)
  })

  it('rebuilds a null-prototype record too', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, {
      [`k${LONE_HIGH}`]: LONE_LOW,
      ok: EMOJI,
    })
    expect(wellFormedDeep(input)).toEqual({ [`k${REPLACEMENT}`]: REPLACEMENT, ok: EMOJI })
  })

  it('never changes a non-string type — identity, not just equality', () => {
    const fn = (): number => 42
    const symbol = Symbol('s')
    const date = new Date('2020-01-02T03:04:05.000Z')
    const map = new Map([['a', 1]])
    const regexp = /x/u
    const withToJson = { toJSON: () => ({}) as unknown }
    class Box {
      constructor(readonly value: string) {}
    }
    // Even a lone surrogate INSIDE a class instance stops here: a class instance is not a plain
    // record, so repairing it would change its type. The model-visible boundary serializes plain
    // JSON, which is what this member is for.
    const box = new Box(`a${LONE_HIGH}b`)
    const samples: readonly unknown[] = [42, 1.5, true, false, null, undefined, 10n, symbol, fn, date, map, regexp, withToJson, box]
    for (const sample of samples) expect(wellFormedDeep(sample)).toBe(sample)
  })

  it('does not mutate the input value', () => {
    const input = { a: [`x${LONE_HIGH}y`], [`k${LONE_HIGH}`]: LONE_LOW }
    const before = JSON.stringify(input)
    const output = wellFormedDeep(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(output).not.toBe(input)
  })

  it('is idempotent and structurally stable', () => {
    const input = { [`k${LONE_HIGH}`]: [{ v: HALF_EMOJI }, EMOJI, null], tail: `${LONE_LOW}` }
    const once = wellFormedDeep(input)
    const twice = wellFormedDeep(once)
    expect(twice).toEqual(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('repairs deeply through the local scan when the native member is absent', () => {
    withoutNativeToWellFormed(() => {
      expect(wellFormedDeep({ [`k${LONE_HIGH}`]: [`a${LONE_LOW}b`, HALF_EMOJI] })).toEqual({
        [`k${REPLACEMENT}`]: [`a${REPLACEMENT}b`, REPLACEMENT],
      })
    })
  })

  it('serializes without the lone-surrogate escape a strict parser rejects', () => {
    const dirty = { [`k${LONE_HIGH}`]: [`a${LONE_LOW}b`, HALF_EMOJI], ok: EMOJI, cjk: CJK_EXT_B, n: 1 }
    // The defect is real and this repository's own parser cannot see it: the raw payload carries the
    // `\ud800`-style escape that jq / Python / serde_json refuse…
    expect(SURROGATE_ESCAPE.test(JSON.stringify(dirty))).toBe(true)
    // …and after the repair there is none left, while the genuine emoji / CJK pairs survive.
    const clean = JSON.stringify(wellFormedDeep(dirty))
    expect(SURROGATE_ESCAPE.test(clean)).toBe(false)
    expect(clean).toContain(EMOJI)
    expect(clean).toContain(CJK_EXT_B)
    // The serialized text is also free of unpaired code units, scanned independently.
    expectNoLoneSurrogate(clean, 'wellFormedDeep')
    const repaired = wellFormedDeep(dirty) as Record<string, unknown>
    const nested = repaired[`k${REPLACEMENT}`] as readonly string[]
    expectNoLoneSurrogate(nested[0] ?? '', 'nested string')
  })
})
