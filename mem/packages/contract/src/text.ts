/**
 * Well-formedness of every string mem stores or shows a model — the mem-side MIRROR.
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
 * ── THE ORIGINAL IS THE BASE KIT ──────────────────────────────────────────────────────────────
 *
 * `base/plugin-base/src/kit/wellformed.ts` owns `wellFormedText` / `wellFormedDeep` (interface v2)
 * and is the copy ONE base release fixes for the whole family. This module is its **deliberate
 * mirror**, in the same sense as `./family.ts` (whose original is the base's `kit/family.ts`): the
 * engine (`@avantf/mem`) and the CLI / MCP faces have **no DSH host and never load the base**
 * (`AGENTS.md`), so they cannot reach the original and keep a dependency-free copy as their
 * documented degradation path. The cross-tree test
 * `mem/packages/plugin/test/wellformed_pin.spec.ts` takes the REAL linked base and compares it with
 * this mirror on one set of samples (the precedent is `family_pin.spec.ts`); **do not change one
 * side without the other**.
 *
 * ── WHO RUNS: the base when a host installed it, the mirror otherwise ─────────────────────────
 *
 * This module is also the ONE place the DSH plugin can hand the base's implementation in:
 * {@link adoptWellFormed} takes the module the bootstrap loaded and swaps the two functions for the
 * base's, falling back per member when it does not carry them. The switch is deliberately
 * **"does the loaded module HAVE the function"** (a `typeof` read of each member, guarded against a
 * hostile getter) — never an interface-generation check, so a base that predates the v2 helpers
 * (generation v1) simply keeps the mirror and the plugin still mounts completely. Nothing here can
 * throw or refuse a mount.
 *
 * Two directions, two functions, deliberately NOT one:
 *
 *  - {@link toWellFormedText} is the WRITE side. It additionally applies `normalize('NFC')`, because
 *    Unicode equivalence is a persistence concern: two spellings of the same text must not become
 *    two rows, two FTS terms or two entities. Every store write and every derived string (entity
 *    names, SPO slots) goes through it BEFORE it is persisted. **NFC is mem's policy, not the
 *    well-formed layer's**: the base's `wellFormedText` does NOT normalize, and when it is adopted
 *    the write wrapper here is exactly `base.wellFormedText(value).normalize('NFC')`.
 *  - {@link toWellFormedDeep} is the READ side. It never changes anything except lone surrogates,
 *    and it walks the result value so that data this process did not just write — a row written by
 *    an older build or a foreign driver, a string the tokenizer derived — still serializes to JSON
 *    every strict parser accepts. Applying NFC here would silently rewrite history for display, so
 *    it does not.
 *
 * @module contract/text
 */

/** The well-formed-only repair (NO NFC): what {@link adoptWellFormed} swaps. */
type TextRepair = (value: string) => string

/** The recursive twin of {@link TextRepair}: what {@link adoptWellFormed} swaps. */
type DeepRepair = <T>(value: T) => T

/**
 * The engine's own well-formed layer, and the default: `String.prototype.toWellFormed()` — the
 * exact call this module has always made (Node ≥20; the repo floor is ≥22.15).
 */
const nativeText: TextRepair = (value) => value.toWellFormed()

/** The well-formed layer in force. {@link adoptWellFormed} replaces it with the base's. */
let repairText: TextRepair = nativeText

/**
 * The local recursion behind {@link toWellFormedDeep} — the mirror's read side.
 *
 * Recursion rules, and they are deliberately narrow: only strings are touched
 * ({@link repairText} — no NFC, see the module note), arrays are mapped, and objects that carry no
 * `toJSON` are rebuilt with well-formed keys and values. Everything else — numbers, booleans,
 * `null`, `undefined`, functions, symbols — is returned as-is, so this can never change a value's
 * JSON meaning. An object WITH a `toJSON` method (`Date`, `Buffer`, `RegExp`, …) is handed back
 * untouched, because `JSON.stringify` itself would serialize it through that method; cloning its
 * enumerable own properties instead would turn a `Date` into `{}`.
 *
 * Object KEYS are normalized too: a lone surrogate in a property name is emitted verbatim by
 * `JSON.stringify` (the replacer form of this fix cannot repair it, which is why this clones),
 * and it breaks a strict parser just the same.
 *
 * It reads {@link repairText} at every call, so a host that installs a well-formed string layer
 * without a recursive one still gets it used throughout the walk.
 */
function mirrorDeep<T>(value: T): T {
  if (typeof value === 'string') return repairText(value) as unknown as T
  if (Array.isArray(value)) return value.map((item: unknown) => mirrorDeep(item)) as unknown as T
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON !== 'function') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[repairText(key)] = mirrorDeep(item)
    return out as unknown as T
  }
  return value
}

/** The recursive repair in force. {@link adoptWellFormed} replaces it with the base's. */
let repairDeep: DeepRepair = mirrorDeep

/**
 * The ONE write-side normalization: well-formed, and NFC.
 *
 * Called at the store write entries (never at each individual string field), so a fix here lands
 * everywhere at once.
 */
export function toWellFormedText(value: string): string {
  return repairText(value).normalize('NFC')
}

/** {@link toWellFormedText} over a batch (entity names, caller paths, …). */
export function toWellFormedTexts(values: readonly string[]): string[] {
  return values.map(toWellFormedText)
}

/**
 * The read-side twin: a structurally identical value in which every string is well-formed.
 *
 * Delegates to {@link repairDeep}: the local {@link mirrorDeep} until a host installs the base's
 * `wellFormedDeep` through {@link adoptWellFormed}, which is the same walk (see the module note).
 */
export function toWellFormedDeep<T>(value: T): T {
  return repairDeep(value)
}

/** The slice of a loaded base {@link adoptWellFormed} reads; both members are optional. */
export interface WellFormedKit {
  readonly wellFormedText?: unknown
  readonly wellFormedDeep?: unknown
}

/** Which of the two repairs came from the kit (`false` = the mirror is in force for it). */
export interface WellFormedSource {
  readonly text: boolean
  readonly deep: boolean
}

/** Read one member without letting a hostile module's getter escape. */
function member(module: unknown, name: keyof WellFormedKit): unknown {
  try {
    return (module as Record<string, unknown> | null)?.[name]
  } catch {
    return undefined
  }
}

/**
 * Prefer the loaded base's well-formed helpers; fall back to this mirror for whatever it lacks.
 *
 * The plugin calls this ONCE at mount with the module the bootstrap loaded (`env?.kit`). The
 * decision per member is a `typeof` check — the v2 members are an OPTIONAL capability, and a base
 * that predates them (interface v1) or a module with none of them leaves both repairs on the mirror.
 * It is total: a hostile module reads as "reports none", nothing throws, and a mount is never
 * refused or changed by the outcome.
 *
 * Calling it AGAIN replaces whatever was installed before, so passing `undefined` restores the
 * mirror (the CLI / MCP faces never call it at all and keep the mirror for their whole life).
 *
 * @param kit - the loaded base module (or anything else; only the two members are read).
 * @returns which repair each side came from, for the caller's log line.
 */
export function adoptWellFormed(kit: unknown): WellFormedSource {
  const kitText = member(kit, 'wellFormedText')
  const kitDeep = member(kit, 'wellFormedDeep')
  const text = typeof kitText === 'function'
  const deep = typeof kitDeep === 'function'
  repairText = text ? (kitText as TextRepair) : nativeText
  repairDeep = deep ? (kitDeep as DeepRepair) : mirrorDeep
  return { text, deep }
}
