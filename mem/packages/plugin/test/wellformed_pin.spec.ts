/**
 * The well-formed helpers, pinned ACROSS trees.
 *
 * `AGENTS.md` says the well-formed repair has two copies — the base kit is the ORIGINAL
 * (`base/plugin-base/src/kit/wellformed.ts`, interface v2) and `@avantf/mem-contract` keeps a
 * dependency-free MIRROR, because the engine, the CLI and the MCP server have no DSH host and never
 * load the base — and that this kind of mirror is pinned by a test that takes the REAL linked
 * implementation (`family_pin.spec.ts` is the precedent). This is that test for the text repair:
 * every case below drives the linked `@avantf/dsh-plugin-base` and the mirror on the SAME samples
 * and compares value for value. A mock would only prove the mock is self-consistent, so there is
 * none here.
 *
 * What is compared, and where the boundary is:
 *
 *  - the WELL-FORMED layer (no NFC): the base's `wellFormedText` against the mirror's read side,
 *    which by construction is the same repair;
 *  - the WRITE wrapper: the mirror's `toWellFormedText` must equal the base's `wellFormedText`
 *    followed by `normalize('NFC')`. NFC is mem's PERSISTENCE policy, not the base's, so the base
 *    release that fixes the surrogate repair can never move it;
 *  - the RECURSIVE read side on JSON-shaped values: nested arrays/objects (including object KEYS),
 *    null-prototype records, and the non-string types a `JsonValue` can hold. That is the exact
 *    domain `render.ts` / the MCP face is typed for. NON-plain records (`Map`, a class instance)
 *    are deliberately outside it: the base hands them back by identity while the mirror rebuilds
 *    them, and neither can reach a model face from a `JsonValue`.
 *  - IDEMPOTENCE on both sides.
 *
 * CI has no DSH host, so when the base cannot be linked the tests are SKIPPED with the reason below
 * (never silently passing); the development tree links it and really runs them.
 *
 * @module test/wellformed_pin
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as mirror from '@avantf/mem-contract'

/** The linked base module, or `undefined` when this checkout has no host to link. */
type BaseModule = typeof import('@avantf/dsh-plugin-base')

/** Load the linked base without failing the whole spec when there is none (CI). */
async function loadLinkedBase(): Promise<BaseModule | undefined> {
  try {
    return await import('@avantf/dsh-plugin-base')
  } catch {
    return undefined
  }
}

/** The REAL linked base — the original of the mirror. */
const kit = await loadLinkedBase()

if (kit === undefined) {
  console.warn(
    '[wellformed_pin] SKIPPED — @avantf/dsh-plugin-base is not linked in this checkout (CI has no '
    + 'DSH host), so the cross-tree pin has no real implementation to compare against. The '
    + 'development tree links the workspace base and runs every case below.',
  )
}

/** U+FFFD REPLACEMENT CHARACTER: what a lone surrogate becomes. */
const REPLACEMENT = '\uFFFD'
/** A lone HIGH surrogate (`D800–DBFF`, no low half follows). */
const LONE_HIGH = '\uD800'
/** A lone LOW surrogate (`DC00–DFFF`, no high half precedes). */
const LONE_LOW = '\uDC00'
/** The HIGH half of an emoji, on its own — "half an emoji". */
const HALF_EMOJI = '\uD83D'
/** The LOW half of an emoji, on its own. */
const HALF_EMOJI_LOW = '\uDE42'
/** A complete emoji (`U+1F642`): a real surrogate pair, must survive byte-for-byte. */
const EMOJI = '\u{1F642}'
/** `U+20000` (𠀀), a CJK Extension B ideograph: a real pair, not a defect. */
const CJK_EXT_B = '\u{20000}'
/** Quote, backslash, newline, tab, carriage return — none a surrogate, all must be untouched. */
const METACHARS = '"quoted" \\ backslash \n newline \t tab \r return'
/** Two HIGH halves in a row: a split pair is two lone surrogates, never one pair. */
const SPLIT_PAIR = `${LONE_HIGH}${LONE_HIGH}`
/** A LOW half followed by a HIGH half does not pair up either. */
const LOW_THEN_HIGH = `${LONE_LOW}${LONE_HIGH}`
/** A combining sequence: the one input where the WRITE wrapper's NFC is observable. */
const COMBINING = 'e\u0301'

/** Every string sample the two implementations must agree on, value for value. */
const STRING_SAMPLES: readonly string[] = [
  LONE_HIGH,
  LONE_LOW,
  `a${LONE_HIGH}b`,
  `a${LONE_LOW}b`,
  HALF_EMOJI,
  HALF_EMOJI_LOW,
  `${LONE_HIGH}x${HALF_EMOJI}`,
  EMOJI,
  CJK_EXT_B,
  `${EMOJI}${CJK_EXT_B}`,
  METACHARS,
  SPLIT_PAIR,
  LOW_THEN_HIGH,
  COMBINING,
  '',
]

/** A null-prototype record with a lone surrogate in BOTH a key and a value. */
const NULL_PROTO = Object.assign(Object.create(null) as Record<string, unknown>, {
  [`k${LONE_HIGH}`]: LONE_LOW,
  ok: EMOJI,
})

/** Every JSON-shaped value sample, including the non-string types and the nested shapes. */
const VALUE_SAMPLES: readonly unknown[] = [
  // nested arrays/objects, with a lone surrogate in a key, a value and a nested slot
  { [`k${LONE_HIGH}`]: [`a${LONE_LOW}b`, { deep: HALF_EMOJI }], fine: EMOJI, n: 7 },
  [LONE_HIGH, [LONE_LOW, { [`k${HALF_EMOJI}`]: '' }]],
  NULL_PROTO,
  // non-string types: numbers, booleans, null, undefined, and a toJSON object (Date)
  { n: 3.5, b: true, z: null, u: undefined, arr: [1, false, null], date: new Date('2026-01-02T03:04:05.000Z') },
  EMOJI,
  LONE_HIGH,
  42,
  null,
  undefined,
]

/** Everything below needs the real, linked base; without it the suite is skipped (see the header). */
describe.skipIf(kit === undefined)('the well-formed helpers agree across the tree', () => {
  const base = kit as BaseModule

  // The mirror is the state the pin compares, so undo any adoption a previous case left behind.
  beforeEach(() => { mirror.adoptWellFormed(undefined) })
  afterEach(() => { mirror.adoptWellFormed(undefined) })

  it('the linked base carries the v2 pair this mirror is pinned against', () => {
    expect(typeof base.wellFormedText).toBe('function')
    expect(typeof base.wellFormedDeep).toBe('function')
  })

  it('the well-formed (no NFC) layer agrees on every string sample', () => {
    for (const sample of STRING_SAMPLES) {
      const label = JSON.stringify(sample)
      // The mirror's READ side is its well-formed layer (no NFC); the base's `wellFormedText` is the
      // reference for that layer.
      expect(mirror.toWellFormedDeep(sample), `read/well-formed ${label}`).toBe(base.wellFormedText(sample))
      // The WRITE wrapper is that layer + NFC. NFC is mem's policy, so it is applied on THIS side of
      // the tree and the base release that fixes the repair can never change it.
      expect(mirror.toWellFormedText(sample), `write (well-formed + NFC) ${label}`)
        .toBe(base.wellFormedText(sample).normalize('NFC'))
    }
    // The combining sequence is the case that makes the two statements above genuinely different.
    expect(mirror.toWellFormedText(COMBINING)).toBe('\u00e9')
    expect(base.wellFormedText(COMBINING)).toBe(COMBINING)
  })

  it('the recursive read side agrees on nested arrays/objects and non-string types', () => {
    for (const value of VALUE_SAMPLES) {
      const label = JSON.stringify(value) ?? String(value)
      expect(mirror.toWellFormedDeep(value), label).toEqual(base.wellFormedDeep(value))
      expect(JSON.stringify(mirror.toWellFormedDeep(value)), label).toBe(JSON.stringify(base.wellFormedDeep(value)))
    }
    // The repaired nested payload really is well-formed, and the raw one demonstrably is not.
    const dirty = VALUE_SAMPLES[0]
    expect(JSON.stringify(dirty)).toContain('\\ud800')
    expect(JSON.stringify(mirror.toWellFormedDeep(dirty))).not.toContain('\\ud800')
    expect(JSON.stringify(base.wellFormedDeep(dirty))).not.toContain('\\ud800')
  })

  it('both sides hand non-string types back by identity', () => {
    const date = new Date('2026-01-02T03:04:05.000Z')
    const fn = (): number => 42
    const withToJson = { toJSON: () => ({}) as unknown }
    for (const value of [42, 1.5, true, false, null, undefined, fn, date, withToJson]) {
      expect(base.wellFormedDeep(value)).toBe(value)
      expect(mirror.toWellFormedDeep(value)).toBe(value)
    }
  })

  it('both sides are idempotent', () => {
    for (const sample of STRING_SAMPLES) {
      expect(mirror.toWellFormedText(mirror.toWellFormedText(sample))).toBe(mirror.toWellFormedText(sample))
      expect(base.wellFormedText(base.wellFormedText(sample))).toBe(base.wellFormedText(sample))
    }
    const value = { [`k${LONE_HIGH}`]: [{ v: HALF_EMOJI }, EMOJI, null], tail: LONE_LOW }
    expect(mirror.toWellFormedDeep(mirror.toWellFormedDeep(value))).toEqual(mirror.toWellFormedDeep(value))
    expect(base.wellFormedDeep(base.wellFormedDeep(value))).toEqual(base.wellFormedDeep(value))
    expect(mirror.toWellFormedDeep(mirror.toWellFormedDeep(NULL_PROTO))).toEqual(mirror.toWellFormedDeep(NULL_PROTO))
  })

  it('adopting the real base keeps both layers equal to it on the mem domain', () => {
    // This is the plugin's own consumption call (`adoptWellFormed(env?.kit)` in `index.ts`), driven
    // with the REAL module: after it, the write entry and the model-facing boundary run the base's
    // implementation (with mem's NFC kept on the write side), not the mirror.
    expect(mirror.adoptWellFormed(base)).toEqual({ text: true, deep: true })
    for (const sample of STRING_SAMPLES) {
      expect(mirror.toWellFormedText(sample)).toBe(base.wellFormedText(sample).normalize('NFC'))
      expect(mirror.toWellFormedDeep(sample)).toBe(base.wellFormedText(sample))
    }
    for (const value of VALUE_SAMPLES) {
      expect(mirror.toWellFormedDeep(value)).toEqual(base.wellFormedDeep(value))
    }
  })
})
