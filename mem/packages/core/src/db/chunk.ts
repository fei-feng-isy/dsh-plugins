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
export const SQL_PARAM_BATCH = 500

/** Split `items` into consecutive batches of at most `size` (an empty list yields none). */
export function batches<T>(items: readonly T[], size = SQL_PARAM_BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
