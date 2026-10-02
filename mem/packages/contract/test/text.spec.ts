/**
 * The contract-side well-formedness helpers: the one write entry and the recursive read-side twin.
 *
 * Assertions are deliberately made on the JSON ROUND TRIP, not only on the helper's return value:
 * the property that matters is "whatever a strict JSON parser receives is well-formed", and it is
 * the escaped text that a non-JS parser sees.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { adoptWellFormed, toWellFormedDeep, toWellFormedText, toWellFormedTexts } from '../src/text.js'

/** Lone high surrogate (half of an astral pair). */
const HALF_HIGH = '\uD800'
/** Lone low surrogate (the other half). */
const HALF_LOW = '\uDC00'
/** The high half of 🐟 — a pair split down the middle. */
const HALF_EMOJI = '\uD83D'
/** A complete astral emoji. */
const EMOJI = '🐟'
/** CJK Unified Ideographs Extension B (astral). */
const CJK_EXT_B = '𠀀'
/** Every JSON metacharacter family in one string. */
const METACHARS = '"quoted" \\ backslash \n newline \t tab'

const REPLACEMENT = '\uFFFD'

/**
 * Assert every string reachable in `value` is well-formed, reporting where it is not.
 *
 * This is what "strictly parseable" means for the payload: JSON.parse accepting the text is NOT
 * enough (it accepts `"\ud800"`), so the parsed value is walked.
 */
function expectWellFormedEverywhere(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    expect(value.isWellFormed(), `${path} is not well-formed: ${JSON.stringify(value)}`).toBe(true)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => expectWellFormedEverywhere(item, `${path}[${i}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      expect(key.isWellFormed(), `${path} key is not well-formed`).toBe(true)
      expectWellFormedEverywhere(item, `${path}.${key}`)
    }
  }
}

describe('toWellFormedText (write side)', () => {
  it('replaces both kinds of lone surrogate with U+FFFD', () => {
    expect(toWellFormedText(`a${HALF_HIGH}b`)).toBe(`a${REPLACEMENT}b`)
    expect(toWellFormedText(`a${HALF_LOW}b`)).toBe(`a${REPLACEMENT}b`)
    // Two HIGH halves in a row: neither has a partner, so BOTH are repaired (a high immediately
    // followed by a low would be a complete astral pair and must survive — asserted below).
    expect(toWellFormedText(`a${HALF_HIGH}${HALF_HIGH}b`)).toBe(`a${REPLACEMENT}${REPLACEMENT}b`)
    expect(toWellFormedText(`a${HALF_LOW}${HALF_LOW}b`)).toBe(`a${REPLACEMENT}${REPLACEMENT}b`)
    // A SPLIT pair (high half then a different high half) is two lone surrogates.
    expect(toWellFormedText(`${HALF_HIGH}x${HALF_EMOJI}`)).toBe(`${REPLACEMENT}x${REPLACEMENT}`)
    // A MATCHING pair is a real astral character (U+10000) and is left alone.
    expect(toWellFormedText(`a${HALF_HIGH}${HALF_LOW}b`)).toBe('a𐀀b')
  })

  it('leaves complete astral characters and JSON metacharacters untouched', () => {
    expect(toWellFormedText(`${EMOJI}${CJK_EXT_B}`)).toBe(`${EMOJI}${CJK_EXT_B}`)
    expect(toWellFormedText(METACHARS)).toBe(METACHARS)
  })

  it('composes to NFC (two spellings must not become two rows)', () => {
    expect(toWellFormedText('e\u0301')).toBe('\u00e9')
    expect(toWellFormedText('e\u0301').length).toBe(1)
  })

  it('maps a batch', () => {
    expect(toWellFormedTexts([HALF_HIGH, EMOJI, 'e\u0301'])).toEqual([REPLACEMENT, EMOJI, '\u00e9'])
  })
})

describe('toWellFormedDeep (read side)', () => {
  it('repairs strings in nested arrays and objects, and object keys', () => {
    const payload = {
      content: `历史${HALF_HIGH}坏数据${HALF_LOW}结尾`,
      entities: [`${HALF_HIGH}ent`, EMOJI, CJK_EXT_B],
      triples: [{ subj: HALF_LOW, pred: `p${HALF_EMOJI}`, obj: METACHARS }],
      nested: { deep: [{ text: HALF_HIGH }] },
      [`key${HALF_HIGH}`]: 'value',
    }
    const repaired = toWellFormedDeep(payload)
    // Nothing was structurally changed…
    expect(repaired.nested.deep[0]!.text).toBe(REPLACEMENT)
    expect(repaired.entities[1]).toBe(EMOJI)
    expect(repaired.triples[0]!.obj).toBe(METACHARS)
    // …every key and value is well-formed…
    expectWellFormedEverywhere(repaired)
    // …and what a strict parser actually receives is too.
    expectWellFormedEverywhere(JSON.parse(JSON.stringify(repaired)))
    // The un-repaired payload demonstrably is NOT (this is the defect being closed).
    expect(JSON.stringify(payload)).toContain('\\ud800')
  })

  it('does not touch non-string values', () => {
    const date = new Date('2026-01-02T03:04:05.000Z')
    const payload = { n: 3.5, b: true, z: null, u: undefined, arr: [1, false, null], date }
    const out = toWellFormedDeep(payload)
    expect(out.n).toBe(3.5)
    expect(out.b).toBe(true)
    expect(out.z).toBeNull()
    expect(out.arr).toEqual([1, false, null])
    // An object with `toJSON` is handed to JSON.stringify as-is (cloning it would turn a Date into {}).
    expect(out.date).toBe(date)
    expect(JSON.parse(JSON.stringify(out)).date).toBe('2026-01-02T03:04:05.000Z')
  })

  it('is idempotent', () => {
    const once = toWellFormedDeep({ a: `x${HALF_HIGH}y`, k: HALF_LOW })
    expect(toWellFormedDeep(once)).toEqual(once)
  })
})

/**
 * The host seam: the DSH plugin hands the module the bootstrap loaded in at mount, and this module
 * uses the base kit's implementation when it carries one. The cases below are the TWO degradation
 * routes the family requires to stay total — "the base is absent" (the loader returned `undefined`)
 * and "the base predates the v2 helpers" (a v1-shaped module with neither member) — plus the
 * hostile-module guard. All three must leave the mirror in force; none may throw. The switch is a
 * per-member `typeof` check, never an interface-generation comparison.
 */
describe('adoptWellFormed — the base kit when it has the members, the mirror otherwise', () => {
  beforeEach(() => { adoptWellFormed(undefined) })
  afterEach(() => { adoptWellFormed(undefined) })

  it('installs both members when the kit carries them', () => {
    const kit = {
      wellFormedText: (value: string): string => `T:${value}`,
      wellFormedDeep: (value: unknown): unknown => `D:${String(value)}`,
    }
    expect(adoptWellFormed(kit)).toEqual({ text: true, deep: true })
    // The write wrapper still applies NFC on top of whatever well-formed layer is installed.
    expect(toWellFormedText('x')).toBe('T:x')
    expect(toWellFormedText('e\u0301')).toBe('T:e\u0301'.normalize('NFC'))
    expect(toWellFormedDeep({ a: 1 })).toBe('D:[object Object]')
  })

  it('adopts each member independently — a partial kit keeps the mirror for the other side', () => {
    expect(adoptWellFormed({ wellFormedText: (value: string): string => `T:${value}` })).toEqual({ text: true, deep: false })
    // The deep side is the mirror walk, but it reads the installed string layer at every call —
    // values AND object keys.
    expect(toWellFormedDeep({ a: 'x' })).toEqual({ 'T:a': 'T:x' })
    expect(toWellFormedDeep(['x', 1])).toEqual(['T:x', 1])
    // Re-adopting nothing restores BOTH defaults.
    expect(adoptWellFormed(undefined)).toEqual({ text: false, deep: false })
    expect(toWellFormedText('x')).toBe('x')
    expect(toWellFormedDeep({ a: 'x' })).toEqual({ a: 'x' })
  })

  it('leaves the mirror in force when the base is ABSENT (`env` is undefined at the call site)', () => {
    expect(adoptWellFormed(undefined)).toEqual({ text: false, deep: false })
    // Exactly the mirror's documented semantics: write = well-formed + NFC…
    expect(toWellFormedText(`a${HALF_HIGH}b`)).toBe(`a${REPLACEMENT}b`)
    expect(toWellFormedText('e\u0301')).toBe('\u00e9')
    // …read = lone surrogates only, no NFC, recursing through arrays, plain objects and keys.
    expect(toWellFormedDeep({ a: `x${HALF_HIGH}y`, [`k${HALF_LOW}`]: 'e\u0301' }))
      .toEqual({ a: `x${REPLACEMENT}y`, [`k${REPLACEMENT}`]: 'e\u0301' })
  })

  it('leaves the mirror in force for a v1 base — the v2 members are an OPTIONAL capability', () => {
    // A base that predates the helpers reports its own generation and carries no such member: the
    // plugin must NOT read that as "incompatible", it simply keeps the mirror (and the interface
    // gate's own v1 handling is what withholds the rest of the base — never a refused mount).
    expect(adoptWellFormed({ INTERFACE_VERSION: 1 })).toEqual({ text: false, deep: false })
    expect(toWellFormedText(`a${HALF_HIGH}b`)).toBe(`a${REPLACEMENT}b`)
    expect(toWellFormedDeep([`x${HALF_LOW}`])).toEqual([`x${REPLACEMENT}`])
  })

  it('never throws on a hostile module — every read is guarded', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('shape mismatch') } })
    expect(() => adoptWellFormed(hostile)).not.toThrow()
    expect(adoptWellFormed(hostile)).toEqual({ text: false, deep: false })
    expect(toWellFormedText(`a${HALF_HIGH}b`)).toBe(`a${REPLACEMENT}b`)
  })
})
