/**
 * Page merging for the two list tabs.
 *
 * Kept out of `client/index.ts` so it can be tested without a DOM (the same reason `summarize.ts`
 * lives on its own): these two functions are where page drift is handled, and page drift is the
 * kind of bug that only shows up as a React key warning plus a row nobody can scroll to.
 *
 * @module client/paging
 */

/**
 * Append one page of facts, dropping ids already present.
 *
 * `admin.list` pages by `OFFSET` over `created_at DESC`, and `created_at` has second precision: a
 * fact written (or archived) between two requests shifts every later row by one, so the next page
 * repeats a row that is already on screen. The duplicate is not cosmetic — it is a React key
 * collision (`key={fact_id}`) and a row that can never be scrolled to.
 */
export function mergePage<T extends { fact_id: number }>(previous: T[], page: T[]): T[] {
  return mergeById(previous, page, row => row.fact_id)
}

/**
 * Append one page of documents, dropping ids already present.
 *
 * Same window shift as `mergePage`: `kb.list` pages by `OFFSET` over `updated_at DESC`, which also
 * has second precision, and a document ingested between two requests repeats a row.
 */
export function mergeDocs<T extends { doc_id: number }>(previous: T[], page: T[]): T[] {
  return mergeById(previous, page, row => row.doc_id)
}

/** Append the rows whose id is not already loaded, preserving order; identity when nothing is new. */
function mergeById<T>(previous: T[], page: T[], idOf: (row: T) => number): T[] {
  const seen = new Set(previous.map(idOf))
  const added = page.filter(row => !seen.has(idOf(row)))
  return added.length === 0 ? previous : [...previous, ...added]
}
