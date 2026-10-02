/**
 * Write-side evaluation: the deterministic half of the memory lifecycle (DESIGN §20).
 *
 * The retrieval suite grades what comes OUT of the store; nothing graded what goes IN. Write
 * behavior is where the invariants live (exact dedupe, one revision per supersede step,
 * conflicts logged and retired, archive/restore round trips), and unlike answer quality it
 * needs no model and no judge.
 *
 * TWO metrics, deliberately orthogonal (the reference design's split, and the reason it works):
 *
 *  - `action_success` — the STRUCTURAL operation the case exists for happened (a revision was
 *    archived, a pair was opened, a pair was closed). Counts only; it never looks at content.
 *  - `information_integrity` — every statement survives EXACTLY ONCE (live, or archived when the
 *    case says it was retired). Content only; it never looks at counts.
 *
 * Keeping them apart is the point: an update that archives the old revision but loses a fact it
 * carried passes the action metric and fails integrity, and a single blended score would hide
 * which half broke. Both are pure functions over an observation, so the grader is deterministic
 * and needs no live store — only the scenarios that produce the observations do.
 *
 * The identity token is supplied by the observation, NOT parsed out of the fact text. Carrying
 * it in the text looks natural and is a trap: the token ends up inside the subject/predicate/
 * object the detector parses, and the case silently stops exercising the signal it exists for
 * (measured: an in-text token suppressed the polarity conflict in 4 of 5 placements). A label
 * the store never interprets — `category` — is stable across extractor changes.
 */

/** What a case is about. `expect_action` is structural only; `live` is content only. */
export interface WriteCase {
  id: string
  /** Identity tokens the LIVE corpus must carry exactly once. */
  live: string[]
  /** Tokens that must no longer be live (their statements were superseded/retracted). */
  retired?: string[]
  /** Structural claims about the state after the scenario. */
  expect_action?: {
    /** Rows in the supersede chain of the fact the scenario follows. */
    revision_chain?: number
    /**
     * OPEN conflicts naming the facts THIS case names (`live` + `retired`) — never the whole
     * store: the scenarios share one, so a store-wide count would make a case's verdict depend
     * on which cases ran before it. That is not hypothetical — a store-wide
     * `archived_reason_count` held only because its case ran first.
     */
    open_conflicts?: number
    /** Facts whose archive reason is this value. Omit together with the count to assert "any". */
    archived_reason?: string
    /**
     * How many archived facts carry `archived_reason` (default 1), or — when `archived_reason`
     * is omitted — how many carry ANY reason. The standalone form is what "nothing was
     * archived" needs, and it must actually be checked: gating the count on `archived_reason`
     * made the standalone form a silent no-op.
     *
     * Counted over the facts THIS CASE names (`live` + `retired`), never over the whole store:
     * the scenarios share one store, so a store-wide count would make a case's result depend on
     * which cases ran before it.
     */
    archived_reason_count?: number
  }
}

/** What the store actually looks like after the scenario ran. */
export interface WriteObservation {
  /** Identity tokens seen in ACTIVE facts, with their occurrence count. */
  live: Map<string, number>
  /** Identity tokens seen in ARCHIVED facts. */
  archived: Set<string>
  /** Archive reason per fact, tagged with the fact's identity token (see `WriteCase.live`). */
  archive_reasons: { token: string; reason: string }[]
  open_conflicts: number
  /** Length of the supersede chain rooted at the scenario's fact, when the case asks. */
  revision_chain?: number
}

interface WriteCaseResult {
  id: string
  action_success: boolean
  information_integrity: boolean
  /** Human-readable explanation, so a failure says WHICH half broke and how. */
  detail: string
}

export interface WriteReport {
  cases: WriteCaseResult[]
  action_success_rate: number
  information_integrity_rate: number
}

/**
 * Content half: every statement survives EXACTLY ONCE, and in the state the case claims.
 *
 * `live` tokens must be active exactly once (a duplicate revision is a second copy of a
 * statement; a vanished one is data loss), `retired` tokens must exist in the archive and not
 * in the live corpus. Checking the archive too is what makes this half able to fail on its own:
 * "the update happened but the old revision and its content are simply gone" is an action
 * success and an integrity failure, which is exactly the case the split exists to expose.
 */
function informationIntegrity(c: WriteCase, obs: WriteObservation): { ok: boolean; detail: string } {
  const missing: string[] = []
  const duplicated: string[] = []
  for (const token of c.live) {
    const n = obs.live.get(token) ?? 0
    if (n === 0) missing.push(token)
    else if (n > 1) duplicated.push(`${token}×${String(n)}`)
  }
  const stillLive = (c.retired ?? []).filter((token) => (obs.live.get(token) ?? 0) > 0)
  const lost = (c.retired ?? []).filter((token) => !obs.archived.has(token))
  const problems: string[] = []
  if (missing.length) problems.push(`missing ${missing.join(',')}`)
  if (duplicated.length) problems.push(`duplicated ${duplicated.join(',')}`)
  if (stillLive.length) problems.push(`retired-but-live ${stillLive.join(',')}`)
  if (lost.length) problems.push(`retired-but-lost ${lost.join(',')}`)
  return { ok: problems.length === 0, detail: problems.join('; ') }
}

/** Structure half: the operation the case exists for actually happened. */
function actionSuccess(c: WriteCase, obs: WriteObservation): { ok: boolean; detail: string } {
  const e = c.expect_action
  if (e === undefined) return { ok: true, detail: '' }
  const problems: string[] = []
  if (e.revision_chain !== undefined && obs.revision_chain !== e.revision_chain) {
    problems.push(`revision_chain=${String(obs.revision_chain ?? -1)} expected ${String(e.revision_chain)}`)
  }
  if (e.open_conflicts !== undefined && obs.open_conflicts !== e.open_conflicts) {
    problems.push(`open_conflicts=${String(obs.open_conflicts)} expected ${String(e.open_conflicts)}`)
  }
  if (e.archived_reason !== undefined || e.archived_reason_count !== undefined) {
    // Scoped to this case's own facts: the scenarios share a store, and a store-wide count would
    // make the result depend on the order the cases ran in.
    const mine = new Set([...c.live, ...(c.retired ?? [])])
    const relevant = obs.archive_reasons.filter((a) => mine.has(a.token))
    const n = e.archived_reason === undefined
      ? relevant.filter((a) => a.reason.length > 0).length
      : relevant.filter((a) => a.reason === e.archived_reason).length
    const expected = e.archived_reason_count ?? 1
    if (n !== expected) {
      problems.push(`archived_reason(${e.archived_reason ?? 'any'})=${String(n)} expected ${String(expected)}`)
    }
  }
  return { ok: problems.length === 0, detail: problems.join('; ') }
}

function gradeWriteCase(c: WriteCase, obs: WriteObservation): WriteCaseResult {
  const action = actionSuccess(c, obs)
  const integrity = informationIntegrity(c, obs)
  const parts = [action.detail, integrity.detail].filter((p) => p.length > 0)
  return {
    id: c.id,
    action_success: action.ok,
    information_integrity: integrity.ok,
    detail: parts.join(' | ') || 'ok',
  }
}

export function gradeWriteCases(cases: WriteCase[], observations: Map<string, WriteObservation>): WriteReport {
  const results = cases.map((c) => {
    const obs = observations.get(c.id)
    if (obs === undefined) {
      return { id: c.id, action_success: false, information_integrity: false, detail: 'no observation recorded' }
    }
    return gradeWriteCase(c, obs)
  })
  const rate = (pick: (r: WriteCaseResult) => boolean): number =>
    results.length === 0 ? 1 : results.filter(pick).length / results.length
  return {
    cases: results,
    action_success_rate: rate((r) => r.action_success),
    information_integrity_rate: rate((r) => r.information_integrity),
  }
}
