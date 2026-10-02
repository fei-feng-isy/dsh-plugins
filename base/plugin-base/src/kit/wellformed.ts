/**
 * Well-formed text — the ONE repair for the family's single worst serialization defect, a LONE
 * SURROGATE.
 *
 * The defect has exactly one shape: a UTF-16 code unit in `D800–DFFF` with no partner (an unpaired
 * high half, an unpaired low half, or half of an emoji). Such a string is not a valid Unicode scalar
 * sequence, yet `JSON.stringify` emits it verbatim as the escape `"\ud800"`. JavaScript's own
 * `JSON.parse` accepts that, so EVERY test in this repository passes while a strict parser rejects the
 * whole document — measured, not theorized:
 *
 *   - `printf '"\\ud800"' | jq .` → `jq: parse error: Invalid \uXXXX\uXXXX surrogate pair escape`;
 *   - Python's `json.load` accepts the document but `print` raises
 *     `UnicodeEncodeError: surrogates not allowed`;
 *   - the same half-code-unit also poisons FTS indexes, embeddings and the UI.
 *
 * The repair is `String.prototype.toWellFormed()` (Node ≥20, present in this repo's Node ≥22.15): it
 * replaces each lone surrogate with U+FFFD (`�`). {@link wellFormedText} uses the engine's own
 * implementation when it exists and an EQUIVALENT `charCodeAt` scan when it does not, so an older Node
 * degrades in behaviour, never in availability ({@link scanAndRepair}).
 *
 * WHERE this belongs — the two boundaries where a model can see a string:
 *
 *   - the INBOUND boundary, before a caller-supplied string is persisted or indexed (store writes,
 *     entity names, caller paths);
 *   - the OUTBOUND boundary, before a value is serialized for a model (tool results, JSON payloads,
 *     rendered records).
 *
 * This module is well-formedness ONLY, deliberately: it repairs lone surrogates and touches nothing
 * else. Unicode normalization (`normalize('NFC')`) is a PERSISTENCE policy — "two spellings of the
 * same text must not become two rows / two FTS terms" — and stays with the caller that owns that
 * policy (mem's write entry layers it on top of {@link wellFormedText}); applying it here to data this
 * process did not just write would silently rewrite history for display.
 *
 * Both members are PURE and type-preserving: same input, same output, no I/O, no global state, and
 * every non-string value comes back untouched (see {@link wellFormedDeep}). They are part of the shared
 * kit so one base release fixes every consumer; a plugin that cannot reach the base keeps a local
 * fallback copy as its documented degradation path (root `AGENTS.md`).
 *
 * @module @avantf/dsh-plugin-base/kit/wellformed
 */

/** U+FFFD REPLACEMENT CHARACTER: what a lone surrogate becomes. */
const REPLACEMENT = '\uFFFD'

/** A high surrogate: the FIRST half of an astral pair (`D800–DBFF`). */
const HIGH_MIN = 0xd800
const HIGH_MAX = 0xdbff

/** A low surrogate: the SECOND half of an astral pair (`DC00–DFFF`). */
const LOW_MIN = 0xdc00
const LOW_MAX = 0xdfff

/** The engine's own `String.prototype.toWellFormed`, or `undefined` (a pre-ES2024 runtime). */
function nativeToWellFormed(): ((this: string) => string) | undefined {
  try {
    // Typed loosely on purpose: the repo compiles against `lib: es2023` (this must also run on older
    // Node), so the ES2024 member is read structurally rather than named.
    const candidate = (String.prototype as { toWellFormed?: unknown }).toWellFormed
    return typeof candidate === 'function' ? (candidate as (this: string) => string) : undefined
  } catch {
    return undefined
  }
}

/**
 * The local equivalent of `String.prototype.toWellFormed()`: one `charCodeAt` pass that copies paired
 * code units as-is and substitutes U+FFFD for each unpaired one. Not exported — it is the fallback of
 * {@link wellFormedText}, and its behaviour is pinned by the same assertions as the native path (the
 * test deletes `String.prototype.toWellFormed`, so both paths run the identical expectations).
 */
function scanAndRepair(text: string): string {
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= HIGH_MIN && unit <= HIGH_MAX) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : -1
      if (next >= LOW_MIN && next <= LOW_MAX) {
        out += text.slice(index, index + 2) // a real pair: both units, unchanged
        index += 1
        continue
      }
      out += REPLACEMENT // unpaired high: no low half follows
      continue
    }
    if (unit >= LOW_MIN && unit <= LOW_MAX) {
      out += REPLACEMENT // unpaired low: no high half preceded it (a paired one was consumed above)
      continue
    }
    out += text.slice(index, index + 1)
  }
  return out
}

/**
 * Make ONE string well-formed: every lone surrogate becomes U+FFFD, every properly paired surrogate
 * (a complete emoji, a CJK Extension B character) and every other code point is returned unchanged.
 *
 * Uses the engine's `String.prototype.toWellFormed()` when available and {@link scanAndRepair}
 * otherwise; both produce the same result, so a pre-ES2024 Node never throws here.
 *
 * Idempotent (`wellFormedText(wellFormedText(x)) === wellFormedText(x)`) and pure — no I/O, no
 * mutation, no normalization: quotes, backslashes, newlines and tabs come back byte-for-byte.
 *
 * @param text - the string to repair; anything else is the caller's type error (see the recursive
 * {@link wellFormedDeep}, which leaves non-strings alone).
 */
export function wellFormedText(text: string): string {
  const native = nativeToWellFormed()
  if (native !== undefined) return native.call(text)
  return scanAndRepair(text)
}

/**
 * {@link wellFormedText} over a JSON-shaped value, so a whole result can be handed to a strict parser.
 *
 * Recursion rules, deliberately narrow — this member may repair strings but must never change a
 * value's TYPE:
 *
 *  - strings are repaired with {@link wellFormedText};
 *  - arrays are mapped (a new array; the input is never mutated);
 *  - PLAIN records are rebuilt with well-formed keys and values. "Plain" means the prototype is
 *    `Object.prototype` (an object literal) or `null` (`Object.create(null)`), and the object carries
 *    no `toJSON` custom serialization. Object KEYS are repaired too: `JSON.stringify` emits a lone
 *    surrogate in a property name verbatim, which breaks a strict parser exactly the same way, and a
 *    replacer cannot fix keys, which is why this clones;
 *  - EVERYTHING ELSE — numbers, booleans, `null`, `undefined`, bigints, symbols, functions, and every
 *    object that is not a plain record (`Date`, `RegExp`, `Map`, a class instance, anything with a
 *    `toJSON`) — is returned AS-IS, by identity. A `Date` must not become `{}`, which is what cloning
 *    its enumerable properties would do, and a class instance must not lose its prototype.
 *
 * Pure and type-preserving: the result is structurally identical to the input apart from lone
 * surrogates, and the input value is never mutated.
 *
 * @param value - the JSON-shaped value to repair.
 */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === 'string') return wellFormedText(value) as unknown as T
  if (Array.isArray(value)) return value.map((item: unknown) => wellFormedDeep(item)) as unknown as T
  if (value !== null && typeof value === 'object' && isPlainRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[wellFormedText(key)] = wellFormedDeep(item)
    return out as unknown as T
  }
  return value
}

/**
 * Whether `value` is a JSON-shaped plain record: an object literal (`Object.prototype`) or a
 * null-prototype map (`Object.create(null)`), with no `toJSON` custom serialization. Everything else
 * is a different type and is left alone — see {@link wellFormedDeep}.
 */
function isPlainRecord(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  return typeof (value as { toJSON?: unknown }).toJSON !== 'function'
}
