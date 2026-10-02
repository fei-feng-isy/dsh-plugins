/**
 * Where the test doubles check the REAL `sessionQuery.filterEvents` contract instead of re-stating a
 * guess at it.
 *
 * W20: the lazy executor lookup sent filter TUPLES (`['time', from, to]`, `['text', …]`) while the
 * real contract is an OBJECT union — `{kind:'time',from,to}` / `{kind:'text',text}`
 * (`@deepseek-ai/dsh-session-query`'s `SessionEventResultFilter`, which
 * `materializeSessionEventResultFilters` validates before any log is read). The doubles had been
 * written against the same tuple guess, so for a whole round every historical executor looked up as
 * `not-found` with the suite green. The doubles now validate the shape they receive and report every
 * clause that is not a real one; the specs assert no such report, so a tuple fails the test that sent
 * it instead of quietly returning `[]`.
 *
 * @module test/sessionQueryContract
 */

/** The clauses this plugin sends, structurally the two members of the real union that it uses. */
export type SentEventFilter =
  | { readonly kind: 'time'; readonly from?: number; readonly to?: number }
  | { readonly kind: 'text'; readonly text: string }

/**
 * Validate a received `filters` argument against the real object union, reporting every clause that
 * is not one. Returns the clauses it could read, so a double can still apply them (to whatever
 * degree it understands) while the caller records the violation.
 *
 * A tuple clause is reported by name: that is the W20 defect, and a bare "unknown kind" would hide
 * which wrong shape came back.
 */
export function checkEventFilters(
  raw: unknown,
  onViolation: (detail: string) => void,
): readonly SentEventFilter[] {
  if (!Array.isArray(raw)) {
    onViolation(`filterEvents filters must be an array of clauses, got ${typeof raw}`)
    return []
  }
  for (const clause of raw) {
    const isObject = clause !== null && typeof clause === 'object' && !Array.isArray(clause)
    const kind = isObject ? (clause as { kind?: unknown }).kind : undefined
    if (kind === 'time') {
      const range = clause as { from?: unknown; to?: unknown }
      if (range.from !== undefined && typeof range.from !== 'number') {
        onViolation(`time filter "from" must be a number, got ${typeof range.from}`)
      }
      if (range.to !== undefined && typeof range.to !== 'number') {
        onViolation(`time filter "to" must be a number, got ${typeof range.to}`)
      }
      continue
    }
    if (kind === 'text') {
      if (typeof (clause as { text?: unknown }).text !== 'string') {
        onViolation('text filter "text" must be a string')
      }
      continue
    }
    onViolation(
      Array.isArray(clause)
        ? `filterEvents received a TUPLE clause ${JSON.stringify(clause)}; the real contract is the`
          + " {kind:'time'|'text'} object union (the W20 bug)"
        : `filterEvents received an unknown clause kind ${JSON.stringify(kind)}`,
    )
  }
  return raw as readonly SentEventFilter[]
}
