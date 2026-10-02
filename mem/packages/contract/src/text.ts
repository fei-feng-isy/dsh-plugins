/**
 * Well-formedness of every string mem stores or shows a model.
 *
 * The defect this module exists for is ONE shape: a lone surrogate — a UTF-16 code unit in the
 * `D800–DFFF` range with no partner. A string carrying one is not a valid Unicode scalar sequence,
 * and `JSON.stringify` happily emits it as the escape `"\ud800"`: JavaScript's own `JSON.parse`
 * accepts that, so the defect passes every check inside this repository, while a strict parser
 * (Rust's `serde_json`, JSON Schema validators, most non-JS consumers) rejects the whole document.
 * The same half-code-unit also poisons FTS, embeddings and the UI. `String.prototype.toWellFormed`
 * (Node ≥20, present in this repo's Node ≥22.15) replaces each lone surrogate with U+FFFD, which is
 * exactly the repair wanted.
 *
 * Two directions, two functions, deliberately NOT one:
 *
 *  - {@link toWellFormedText} is the WRITE side. It additionally applies `normalize('NFC')`, because
 *    Unicode equivalence is a persistence concern: two spellings of the same text must not become
 *    two rows, two FTS terms or two entities. Every store write and every derived string (entity
 *    names, SPO slots) goes through it BEFORE it is persisted.
 *  - {@link toWellFormedDeep} is the READ side. It never changes anything except lone surrogates,
 *    and it walks the result value so that data this process did not just write — a row written by
 *    an older build or a foreign driver, a string the tokenizer derived — still serializes to JSON
 *    every strict parser accepts. Applying NFC here would silently rewrite history for display, so
 *    it does not.
 *
 * @module contract/text
 */

/**
 * The ONE write-side normalization: well-formed, and NFC.
 *
 * Called at the store write entries (never at each individual string field), so a fix here lands
 * everywhere at once.
 */
export function toWellFormedText(value: string): string {
  return value.toWellFormed().normalize('NFC')
}

/** {@link toWellFormedText} over a batch (entity names, caller paths, …). */
export function toWellFormedTexts(values: readonly string[]): string[] {
  return values.map(toWellFormedText)
}

/**
 * The read-side twin: a structurally identical value in which every string is well-formed.
 *
 * Recursion rules, and they are deliberately narrow: only strings are touched
 * (`toWellFormed()` — no NFC, see the module note), arrays are mapped, and plain-ish objects are
 * rebuilt with well-formed keys and values. Everything else — numbers, booleans, `null`,
 * `undefined`, functions, symbols — is returned as-is, so this can never change a value's JSON
 * meaning. An object WITH a `toJSON` method (`Date`, `Buffer`, `RegExp`, …) is handed back
 * untouched, because `JSON.stringify` itself would serialize it through that method; cloning its
 * enumerable own properties instead would turn a `Date` into `{}`.
 *
 * Object KEYS are normalized too: a lone surrogate in a property name is emitted verbatim by
 * `JSON.stringify` (the replacer form of this fix cannot repair it, which is why this clones),
 * and it breaks a strict parser just the same.
 */
export function toWellFormedDeep<T>(value: T): T {
  if (typeof value === 'string') return value.toWellFormed() as unknown as T
  if (Array.isArray(value)) return value.map((item: unknown) => toWellFormedDeep(item)) as unknown as T
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON !== 'function') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key.toWellFormed()] = toWellFormedDeep(item)
    return out as unknown as T
  }
  return value
}
