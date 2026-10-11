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
import type { FactSourceView } from '@avantf/mem-contract'
import type { Db } from '../port.js'

/**
 * The kind axis is the CONTRACT's, not a second list: `FactSourceView['kind']` is what `admin detail`
 * renders and what the writer below records, so deriving the type from it is what makes "the closed
 * vocabulary" one thing. (Before, the array here and the union in `types.ts` were two independent
 * spellings that happened to agree.)
 */
export type FactSourceKind = FactSourceView['kind']

/**
 * The closed `kind` vocabulary, spelled once so the store and the tests share it.
 *
 * The `satisfies` pins every member to the contract's union; the `Exclude` below pins the other
 * direction, so a kind the contract ADDS fails to compile here instead of silently never being
 * recorded.
 */
export const FACT_SOURCE_KINDS = ['session', 'kb_doc', 'tool', 'manual'] as const satisfies readonly FactSourceKind[]

/**
 * Compile-time completeness pin: `FACT_SOURCE_KINDS` spells every kind the contract can return.
 *
 * The tuple wrapping (`[T] extends [never]`) stops the conditional from DISTRIBUTING over `never`,
 * which would make the declared type `never` and reject the `true` even in the exhaustive case.
 */
type UnspelledKind = Exclude<FactSourceKind, (typeof FACT_SOURCE_KINDS)[number]>
const EVERY_CONTRACT_KIND_IS_SPELLED: [UnspelledKind] extends [never] ? true : never = true

/**
 * The FALLBACK kind: a `source_ref` without a recognized `kind:` prefix is `manual` with the
 * reference kept VERBATIM (the tool contract says so, and "no shape guessing" is the point).
 */
export const FACT_SOURCE_FALLBACK_KIND = 'manual' as const satisfies FactSourceKind

/**
 * The kinds that act as a PREFIX — the vocabulary minus its own fallback, so a kind the contract adds
 * joins the prefix table by itself (via {@link FACT_SOURCE_KINDS}) and cannot be forgotten here.
 */
const FACT_SOURCE_PREFIX_KINDS: readonly string[] = FACT_SOURCE_KINDS.filter(
  (kind) => kind !== FACT_SOURCE_FALLBACK_KIND,
)

/** One provenance row as the read surfaces render it. */
export interface FactSource {
  kind: FactSourceKind
  ref: string
}

/**
 * Derive `(kind, ref)` from the single `source_ref` the write face accepts.
 *
 * The tool takes ONE string (the plan adds no second parameter), so the kind axis is spelled by a
 * `kind:` prefix — `session:…` / `kb_doc:…` / `tool:…` — and anything else, INCLUDING the fallback
 * kind's own name, is `manual` with the reference kept VERBATIM. No shape guessing: a bare
 * `domain:source:title` becomes a `manual` source whose ref is exactly what the caller wrote, which
 * is strictly more honest than inventing a category from how the string looks.
 *
 * The prefix table comes from {@link FACT_SOURCE_KINDS} (see {@link FACT_SOURCE_PREFIX_KINDS}) rather
 * than from a hand-written alternation, which is what keeps the recognized set and the recorded set
 * from being two lists.
 */
export function classifySourceRef(sourceRef: string): { kind: FactSourceKind; ref: string } {
  const separator = sourceRef.indexOf(':')
  if (separator > 0) {
    const prefix = sourceRef.slice(0, separator)
    const ref = sourceRef.slice(separator + 1)
    if (ref !== '' && FACT_SOURCE_PREFIX_KINDS.includes(prefix)) {
      return { kind: prefix as FactSourceKind, ref }
    }
  }
  return { kind: FACT_SOURCE_FALLBACK_KIND, ref: sourceRef }
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
