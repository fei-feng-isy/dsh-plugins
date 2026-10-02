/**
 * Well-formed text — the mission tree's LOCAL copy of the family's lone-surrogate repair, and the
 * port the plugin injects the base's canonical implementation through.
 *
 * The defect has exactly one shape: a UTF-16 code unit in `D800–DFFF` with no partner (an unpaired
 * high half, an unpaired low half, or half of an emoji). Such a string is not a valid Unicode scalar
 * sequence, yet `JSON.stringify` emits it verbatim as the escape `"\ud800"`. JavaScript's own
 * `JSON.parse` accepts that, so every test in this repository passes while a strict parser rejects
 * the whole document — measured, not theorized:
 *
 *   - `printf '"\\ud800"' | jq .` → `parse error: Invalid \uXXXX\uXXXX surrogate pair escape`;
 *   - Python's `json.load` accepts the document but `print` raises
 *     `UnicodeEncodeError: surrogates not allowed`;
 *   - the same half-code-unit also poisons FTS indexes, embeddings and the UI.
 *
 * The repair is `String.prototype.toWellFormed()` (Node ≥20): it replaces each lone surrogate with
 * U+FFFD (`�`). {@link wellFormedText} uses the engine's own implementation when it exists and an
 * EQUIVALENT `charCodeAt` scan when it does not, so an older Node degrades in behaviour, never in
 * availability.
 *
 * ── this file is the DEGRADATION copy ───────────────────────────────────────────────────────────
 *
 * The CANONICAL implementation lives in the family base kit
 * (`@avantf/dsh-plugin-base` → `src/kit/wellformed.ts`, interface v2, exported as `wellFormedText` /
 * `wellFormedDeep`). The plugin loads that base at runtime and injects the loaded functions into the
 * core through {@link WellFormedSource} (`TreeDeps.wellFormed`, `buildWorkerPrompt`'s third argument,
 * `AvantfMissionHost.wellFormed`); {@link LOCAL_WELL_FORMED} is what runs only when the base is
 * absent or predates v2 and does not carry the two functions. Per the root `AGENTS.md`, fixing the
 * shared repair means one base release; this copy exists so a missing base still repairs instead of
 * mounting without any repair at all. The plugin must NEVER import the base by value — it takes both
 * halves off the module the inlined bootstrap loaded.
 *
 * ── NFC policy: well-formedness ONLY, deliberately no `normalize('NFC')` ─────────────────────────
 *
 * The base kit leaves Unicode normalization to the caller because it is a PERSISTENCE policy, and
 * mission declines to add it. Mission's inbound texts are PROSE (titles, descriptions, analyses,
 * results, corrections) that is rendered straight back to models; there is no index, no identity and
 * no equivalence class that needs canonical spelling. The one consumer that could want it —
 * decomposition dedup — compares trimmed, whitespace-collapsed, lowercased titles, which is already
 * a heuristic and deliberately does NOT equate different descriptions. Applying NFC on the way in
 * would silently rewrite the caller's own bytes, and mission has no caller that needs it; applying
 * it on the way out would rewrite history. So ONE function serves both directions (this symmetry is
 * also what makes the "inbound funnel" and the outbound fallback provably the same repair). A future
 * feature that needs canonical identity must make that a separate, explicit write-side policy.
 *
 * @module @avantf/mission-core/wellformed
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
    // Typed loosely on purpose: the core builds against `lib: ES2022` (this must also run on older
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
 * {@link wellFormedText}, and its behaviour is pinned by the same assertions as the native path.
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
 * otherwise; both produce the same result, so a pre-ES2024 Node never throws here. Idempotent and
 * pure: quotes, backslashes, newlines and tabs come back byte-for-byte, and no NFC is applied
 * (see the module note).
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
 *    surrogate in a property name verbatim, which breaks a strict parser exactly the same way;
 *  - EVERYTHING ELSE — numbers, booleans, `null`, `undefined`, bigints, symbols, functions, and every
 *    object that is not a plain record (`Date`, `RegExp`, `Map`, a class instance, anything with a
 *    `toJSON`) — is returned AS-IS, by identity.
 *
 * Pure and type-preserving: the result is structurally identical to the input apart from lone
 * surrogates, and the input value is never mutated.
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

/**
 * The pair of repairs every mission boundary needs. The plugin builds this from the base kit it
 * loaded (`{ text: kit.wellFormedText, deep: kit.wellFormedDeep }`) and injects it; the core defaults
 * to {@link LOCAL_WELL_FORMED}.
 *
 * The two members are separate because the boundaries are: a single model-written STRING (an
 * analysis, a result, a correction, a command line) needs `text`, while a record or array that is
 * about to be persisted or serialized (a `createRoot` input, a `children` array, a whole tool
 * result, a dispatch view) needs `deep`. Both are pure.
 */
export interface WellFormedSource {
  /** Repair one string (see {@link wellFormedText}). */
  readonly text: (value: string) => string
  /** Repair every string in a JSON-shaped value (see {@link wellFormedDeep}). */
  readonly deep: <T>(value: T) => T
}

/**
 * The degradation source: the local copy above. Used when the loaded base kit has no
 * `wellFormedText` / `wellFormedDeep` (base absent, or older than interface v2).
 */
export const LOCAL_WELL_FORMED: WellFormedSource = { text: wellFormedText, deep: wellFormedDeep }
