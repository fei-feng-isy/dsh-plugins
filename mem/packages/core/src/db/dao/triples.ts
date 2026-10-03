/**
 * `triples` — the SPO graph behind `ask` / `chain`, the structural contradiction signals and
 * the supersede cleanup.
 *
 * The two structural lookups are exported as SQL builders so that the statement whose QUERY PLAN
 * matters (they must seek a triples index and never scan) is the very one production runs, not a
 * copy of it kept somewhere else.
 */
import type { Db } from '../port.js'
import { inList } from '../chunk.js'

interface TripleRow {
  subj: string
  pred: string
  obj: string
  confidence: number
}

/**
 * Structural lookup ①: same (subj, obj), opposite polarity.
 *
 * JOIN, never `fact_id IN (SELECT fact_id FROM facts WHERE status='active')`: the IN-subquery
 * makes SQLite materialize EVERY active fact id on each call, so the cost tracked the corpus
 * instead of the match set — measured 202 ms with ZERO matches on a 300k-triple corpus, paid
 * by every `remember`. The join keeps the plan on `idx_triples_subj` and checks the (indexed)
 * status per candidate row: 0.18 ms, and it does not depend on planner statistics.
 */
export function polarityLookupSql(predCount: number): string {
  // NOT routed through `inList`: this builder returns SQL text only, so the caller cannot bind the
  // padded values. `predCount` is a fixed predicate list from the config (not data), so its width is
  // already a single cache key.
  const placeholders = Array.from({ length: predCount }, () => '?').join(',')
  return `SELECT DISTINCT t.fact_id AS fact_id
            FROM triples t
            JOIN facts f ON f.fact_id = t.fact_id AND f.status = 'active'
           WHERE t.subj = ? AND t.obj = ? AND t.pred IN (${placeholders}) AND t.fact_id != ?`
}

/** Structural lookup ②: same (subj, pred), different object. Same rewrite as above. */
export function sameSubjPredLookupSql(): string {
  return `SELECT DISTINCT t.fact_id AS fact_id
            FROM triples t
            JOIN facts f ON f.fact_id = t.fact_id AND f.status = 'active'
           WHERE t.subj = ? AND t.pred = ? AND t.obj != ? AND t.fact_id != ?`
}

/** The optional `subj`/`pred`/`obj` slots an `ask` pattern may fill. */
interface TriplePatternParts {
  subj?: string
  pred?: string
  obj?: string
}

export class TriplesDao {
  constructor(private readonly db: Db) {}

  /** Idempotent insert for a fact's extracted triples. */
  insertMany(factId: number, triples: readonly { subj: string; pred: string; obj: string; confidence: number; source: string }[]): void {
    if (!triples.length) return
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO triples (fact_id, subj, pred, obj, confidence, source) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const triple of triples) insert.run(factId, triple.subj, triple.pred, triple.obj, triple.confidence, triple.source)
  }

  /** The fact's triples, in insertion order (detail view). */
  listForFact(factId: number): TripleRow[] {
    return this.db
      .prepare<TripleRow>('SELECT subj, pred, obj, confidence FROM triples WHERE fact_id = ? ORDER BY triple_id')
      .all(factId)
  }

  /** Minimal projection the contradiction detector reads. */
  getByFact(factId: number): { subj: string; pred: string; obj: string }[] {
    return this.db.prepare<{ subj: string; pred: string; obj: string }>('SELECT subj, pred, obj FROM triples WHERE fact_id = ?').all(factId)
  }

  /** Drop a fact's triples — the superseded revision leaves the live graph. */
  deleteForFact(factId: number): void {
    this.db.prepare('DELETE FROM triples WHERE fact_id = ?').run(factId)
  }

  findPolarityCounterparts(subj: string, obj: string, preds: readonly string[], excludeFactId: number): { fact_id: number }[] {
    if (!preds.length) return []
    return this.db.prepare<{ fact_id: number }>(polarityLookupSql(preds.length)).all(subj, obj, ...preds, excludeFactId)
  }

  findSameSubjPredOtherObj(subj: string, pred: string, obj: string, excludeFactId: number): { fact_id: number }[] {
    return this.db.prepare<{ fact_id: number }>(sameSubjPredLookupSql()).all(subj, pred, obj, excludeFactId)
  }

  /**
   * First hop of `chain`: the objects reachable from `subj` (optionally via one predicate).
   *
   * JOIN, not `fact_id IN (SELECT … WHERE status='active')` — the same shape {@link polarityLookupSql}
   * documents as a measured 202 ms on a 300k-triple corpus with zero matches, because the subquery
   * materializes EVERY active fact id per call. The chain path paid that on every hop.
   */
  objectsForSubject(subj: string, pred?: string): string[] {
    const midClause = pred ? 'AND t.pred = ?' : ''
    const params = pred ? [subj, pred] : [subj]
    return this.db
      .prepare<{ obj: string }>(
        `SELECT DISTINCT t.obj AS obj FROM triples t
           JOIN facts fa ON fa.fact_id = t.fact_id
          WHERE fa.status = 'active' AND t.subj = ? ${midClause}`,
      )
      .all(...params)
      .map((row) => row.obj)
  }

  /**
   * Second hop of `chain`: active facts whose subject is one of the mid names.
   *
   * JOIN for the same reason as {@link objectsForSubject}.
   */
  activeFactsBySubject(subjs: readonly string[], secondPred?: string): number[] {
    if (!subjs.length) return []
    const { placeholders, values } = inList(subjs)
    const secondClause = secondPred ? 'AND t.pred = ?' : ''
    const params = secondPred ? [...values, secondPred] : [...values]
    return this.db
      .prepare<{ fact_id: number }>(
        `SELECT DISTINCT t.fact_id AS fact_id FROM triples t
           JOIN facts fa ON fa.fact_id = t.fact_id
          WHERE fa.status = 'active' AND t.subj IN (${placeholders}) ${secondClause}`,
      )
      .all(...params)
      .map((row) => row.fact_id)
  }

  /** Active facts whose triple matches every given slot exactly (`ask`, exact layer). */
  activeFactsMatchingExact(parts: TriplePatternParts): number[] {
    const { where, params } = patternClause(parts, '=')
    if (!where.length) return []
    return this.db
      .prepare<{ fact_id: number }>(
        `SELECT t.fact_id AS fact_id FROM triples t
           JOIN facts fa ON fa.fact_id = t.fact_id
          WHERE fa.status = 'active' AND ${where.join(' AND ')}`,
      )
      .all(...params)
      .map((row) => row.fact_id)
  }

  /** Same, with `=` relaxed to `LIKE %term%` (`ask`, recall-recovery layer). */
  activeFactsMatchingLike(parts: TriplePatternParts): number[] {
    const { where, params } = patternClause(parts, 'LIKE')
    if (!where.length) return []
    return this.db
      .prepare<{ fact_id: number }>(
        `SELECT t.fact_id AS fact_id FROM triples t
           JOIN facts fa ON fa.fact_id = t.fact_id
          WHERE fa.status = 'active' AND ${where.join(' AND ')}`,
      )
      .all(...params)
      .map((row) => row.fact_id)
  }
}

/** `%term%` with LIKE metacharacters escaped (the caller passes raw user text). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Build the WHERE fragment for an `ask` pattern. Weighting stays in the store: this only
 * knows how to express the three slots.
 */
function patternClause(parts: TriplePatternParts, mode: '=' | 'LIKE'): { where: string[]; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  for (const slot of ['subj', 'pred', 'obj'] as const) {
    const value = parts[slot]
    if (!value) continue
    if (mode === '=') {
      where.push(`t.${slot} = ?`)
      params.push(value)
    } else {
      where.push(`t.${slot} LIKE ? ESCAPE '\\'`)
      params.push(`%${escapeLike(value)}%`)
    }
  }
  return { where, params }
}
