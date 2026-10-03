/**
 * Batch an id list for a SQL `IN (...)` clause.
 *
 * SQLite caps the number of bound parameters in one statement (SQLITE_MAX_VARIABLE_NUMBER,
 * 32 766 in the bundled build). A query whose id list can grow with the CORPUS rather than
 * with the request — `entityBags` on the write-path contradiction check, `filterActive` on
 * the catch-up sweep — will therefore hit "too many SQL variables" on a large store. The
 * write path swallows that as best-effort, so the symptom is a detection feature that
 * silently stops running instead of an error anyone notices.
 */

/** Parameters per statement — far below the engine limit, still one round trip per batch. */
const SQL_PARAM_BATCH = 500

/** Split `items` into consecutive batches of at most `size` (an empty list yields none). */
export function batches<T>(items: readonly T[], size = SQL_PARAM_BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * The `IN (…)` placeholder LADDER.
 *
 * The text of an `IN (?,?,…)` clause is part of the prepared-statement CACHE KEY (see
 * `db/sqlite.ts`), and the arity follows the DATA: a batched id list's last batch can be any width,
 * and the unbatched hit-set queries take whatever the caller passes. Left exact, those widths turn the
 * cache key space into thousands of one-use statements, and the cache's wholesale clear at its bound
 * then throws away the ~40 hot literal statements along with them (performance review §7.9 / P10).
 *
 * A key can only collapse if BOTH the placeholder text and the bound-parameter count are fixed for a
 * whole rung — padding the SQL with NULL literals would leave the text varying with the real arity.
 * So {@link inList} fixes the width to the next rung and pads the BOUND VALUES by repeating the last
 * one. Duplicates are inert in an `IN (…)`: `x IN (1,2,2)` is `x IN (1,2)`. The caller binds
 * `values`, not its original array.
 *
 * Above the last rung the exact width is used: those sites (a hit set, a predicate list) are bounded
 * by the caller, and padding an already-large list would only widen it.
 */
const IN_WIDTH_RUNGS = [8, 16, 32, 64, 128, 256, 512] as const

/** A fixed-width `IN (…)` fragment plus the exactly-matching bound values. */
export interface InList<T> {
  /** The `?,?,…` body to splice into `IN (${placeholders})` (or the literal `NULL` for an empty list). */
  placeholders: string
  /** The values to bind — the input, padded to the rung with repeats of its last element. */
  values: T[]
}

/**
 * Prepare a value list for an `IN (…)` clause at a ladder-rounded, cache-stable width.
 *
 * `count <= 0` yields `NULL` (matches nothing) rather than `IN ()`, a syntax error — callers guard
 * empty lists anyway; this is belt-and-braces.
 */
export function inList<T>(values: readonly T[]): InList<T> {
  const count = values.length
  if (count === 0) return { placeholders: 'NULL', values: [] }
  const rung = IN_WIDTH_RUNGS.find((width) => width >= count) ?? count
  const padded = rung === count ? [...values] : [...values, ...Array.from({ length: rung - count }, () => values[count - 1] as T)]
  return { placeholders: Array.from({ length: rung }, () => '?').join(','), values: padded }
}
