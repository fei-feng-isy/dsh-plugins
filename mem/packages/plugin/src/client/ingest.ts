/**
 * The 知识 tab's 入库 result: did it land, or is the host asking whether to REPLACE?
 *
 * Kept as pure functions (no React, no Remote) so the decision is unit-testable, matching
 * `domains.ts`'s `checkNewDomain`. The host answers an unconfirmed collision with a
 * `KbConflictReport` and writes NOTHING, so the client's job is exactly two steps: recognise the
 * report, and phrase the question. The wiring that asks the user and re-sends with
 * `overwrite: true` lives in `index.ts` (pinned by a source guard in `test/ingest.spec.ts`).
 *
 * The confirm text is capped at 8 documents: a directory import that collides with the whole
 * library must produce a readable question, not a wall. The counts say what the rest are.
 */
import type { KbConflictReport } from '@avantf/mem-contract'

/** How many colliding documents the confirm dialog names before it summarizes the rest. */
const CONFLICT_LISTED = 8

/**
 * The host's collision report, or `null` for any other payload.
 *
 * Validated structurally rather than by a bare cast: the value crossed the Remote wire, and a
 * truncated/garbled payload must fall through to the ordinary "完成" path instead of being shown
 * as a confirmation for a conflict that was never reported.
 */
export function ingestConflict(value: unknown): KbConflictReport | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record['conflict'] !== true) return null
  if (!Array.isArray(record['conflicts'])) return null
  return record as unknown as KbConflictReport
}

/** The question the 「入库」 form asks before re-running the SAME request with `overwrite`. */
export function conflictMessage(report: KbConflictReport): string {
  const listed = report.conflicts.slice(0, CONFLICT_LISTED)
  const lines = listed.map((conflict) => `· doc_id=${String(conflict.doc_id)}「${conflict.title}」\n  ${conflict.path}`)
  const rest = report.conflicts.length - listed.length
  return `已存在同名文档：将覆盖 ${String(report.would_overwrite)} 篇 / 新增 ${String(report.would_add)} 篇。`
    + '\n\n确认覆盖以下文档？\n' + lines.join('\n')
    + (rest > 0 ? `\n… 另有 ${String(rest)} 篇` : '')
    + '\n\n选择「取消」不会写入任何内容。'
}
