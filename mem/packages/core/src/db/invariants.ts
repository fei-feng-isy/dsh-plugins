/**
 * P-07 validity invariants, as SQL an operator (or a test) can run against a database.
 *
 * The batch-1 fields are DISPLAY/AUDIT data — no retrieval leg reads them — so nothing in the read
 * path would notice if a write stopped stamping them. These two statements are the check that
 * cannot be satisfied vacuously: each has a planted-violation test in
 * `test/fact_provenance.spec.ts` proving it reports a real inconsistency.
 *
 * ① The two SEMANTIC retirement paths (`update`'s supersede and a `true_positive` contradiction
 *    verdict) archive a fact because it stopped being true. Both must leave an end time, or the
 *    audit trail says "retired, cause known, end unknown". Lifecycle archival (`ttl` / `forgot` /
 *    `idle` / `manual`) is deliberately NOT in the set: those are retention decisions, not statements
 *    about when the fact stopped being true.
 *
 * ② A known end cannot precede a known start.
 */
import type { Db } from './port.js'

/** Facts retired by a semantic path (`replaced` / `contradiction`) without a recorded end time. */
export const RETIRED_WITHOUT_VALID_TO_SQL = `SELECT COUNT(*) AS n FROM facts
  WHERE status = 'archived' AND archive_reason IN ('replaced', 'contradiction') AND valid_to IS NULL`

/** Rows whose known end precedes their known start. */
export const VALID_TO_BEFORE_VALID_FROM_SQL = `SELECT COUNT(*) AS n FROM facts
  WHERE valid_from IS NOT NULL AND valid_to IS NOT NULL AND valid_to < valid_from`

/** Every P-07 invariant, evaluated. All-zero is the healthy state. */
export function validityInvariantViolations(db: Db): { retired_without_valid_to: number; valid_to_before_valid_from: number } {
  return {
    retired_without_valid_to: Number(db.prepare<{ n: number }>(RETIRED_WITHOUT_VALID_TO_SQL).get()?.n ?? 0),
    valid_to_before_valid_from: Number(db.prepare<{ n: number }>(VALID_TO_BEFORE_VALID_FROM_SQL).get()?.n ?? 0),
  }
}
