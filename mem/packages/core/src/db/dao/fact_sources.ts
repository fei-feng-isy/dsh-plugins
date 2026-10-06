/**
 * `fact_sources` — where a memory fact came from (P-08).
 *
 * One row per `(fact_id, kind, ref)`. `kind` is a closed vocabulary (`session` / `kb_doc` /
 * `tool` / `manual`) so a reader can trust what a reference IS; `ref` is opaque to this layer
 * (a session id, a document id, a tool name, or a free-form note).
 *
 * The SQL lives here like every other aggregate. The store decides WHICH source a write carries
 * (and refuses to invent one when the caller gave none); the DAO only records and reads rows.
 */
import type { Db } from '../port.js'

/** The closed `kind` vocabulary, spelled once so the store and the tests share it. */
export const FACT_SOURCE_KINDS = ['session', 'kb_doc', 'tool', 'manual'] as const
export type FactSourceKind = (typeof FACT_SOURCE_KINDS)[number]

/** One provenance row as the read surfaces render it. */
export interface FactSource {
  kind: FactSourceKind
  ref: string
}

/**
 * Derive `(kind, ref)` from the single `source_ref` the write face accepts.
 *
 * The tool takes ONE string (the plan adds no second parameter), so the kind axis is spelled by a
 * `kind:` prefix — `session:…` / `kb_doc:…` / `tool:…` — and anything else is `manual` with the
 * reference kept VERBATIM. No shape guessing: a bare `domain:source:title` becomes a `manual`
 * source whose ref is exactly what the caller wrote, which is strictly more honest than inventing
 * a category from how the string looks.
 */
export function classifySourceRef(sourceRef: string): { kind: FactSourceKind; ref: string } {
  const match = /^(session|kb_doc|tool):(.+)$/s.exec(sourceRef)
  if (match !== null && match[2] !== undefined) {
    return { kind: match[1] as FactSourceKind, ref: match[2] }
  }
  return { kind: 'manual', ref: sourceRef }
}

export class FactSourcesDao {
  constructor(private readonly db: Db) {}

  /**
   * Record one source on one fact. Idempotent by the composite PRIMARY KEY: a repeated write of
   * the same `(kind, ref)` is a no-op, so a caller can safely re-assert provenance.
   */
  insert(factId: number, kind: FactSourceKind, ref: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO fact_sources (fact_id, kind, ref) VALUES (?, ?, ?)')
      .run(factId, kind, ref)
  }

  /** The sources of one fact; empty when no `source_ref` was ever given. */
  listForFact(factId: number): FactSource[] {
    return this.db
      .prepare<{ kind: FactSourceKind; ref: string }>(
        'SELECT kind, ref FROM fact_sources WHERE fact_id = ? ORDER BY kind ASC, ref ASC',
      )
      .all(factId)
      .map((row) => ({ kind: row.kind, ref: row.ref }))
  }

  /**
   * Coverage over the ACTIVE corpus: how many active facts carry at least one source.
   *
   * The `EXISTS` (rather than `COUNT(DISTINCT)` over a join) keeps the numerator cheap and — more
   * importantly — makes "a fact with three sources" count once, which is what coverage means.
   */
  activeCoverage(): { active: number; facts_with_source: number } {
    const active = Number(
      this.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM facts WHERE status = 'active'").get()?.n ?? 0,
    )
    const covered = Number(
      this.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n FROM facts f WHERE f.status = 'active'
             AND EXISTS (SELECT 1 FROM fact_sources fs WHERE fs.fact_id = f.fact_id)`,
        )
        .get()?.n ?? 0,
    )
    return { active, facts_with_source: covered }
  }
}
