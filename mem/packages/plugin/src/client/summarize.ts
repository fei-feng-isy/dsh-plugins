/**
 * Short, page-friendly rendering of a tool result — never a JSON wall.
 *
 * Lives in its own module (no React, no CSS) so it can be unit-tested: it is the only
 * place that decides what a settings-page notice says, and its branch list is exactly
 * the set of result shapes the host can return. Both regressions it has had were wrong
 * BRANCHES (an `imported`/`failed` payload and a plain fact write each fell through to
 * the raw `JSON.stringify` fallback), which inspection catches and tests catch faster.
 */

/** How many conflict ids a notice names before collapsing the rest into a count. */
const MAX_LISTED_CONFLICTS = 3

/**
 * A tool result that carries contradictions detected while writing. The host caps the list
 * (it is a model-facing payload), but that cap is still far too many ids for one line of
 * page text — and a malformed entry must degrade to a readable notice, not throw inside the
 * render path.
 */
function conflictSummary(contradictions: unknown): string | undefined {
  if (!Array.isArray(contradictions) || contradictions.length === 0) return undefined
  const all = contradictions as { contradiction_id?: unknown; other_fact_id?: unknown; score?: unknown }[]
  const listed = all
    .slice(0, MAX_LISTED_CONFLICTS)
    .map((c) => {
      const score = typeof c.score === 'number' ? c.score.toFixed(2) : '?'
      // The pair id is the handle a verdict takes, so the notice names it — the operator (or the
      // model reading this line) can then act without a second lookup. Absent on a payload from
      // an older host, which is why it is optional rather than required.
      const pair = typeof c.contradiction_id === 'number' ? `（矛盾 #${String(c.contradiction_id)}）` : ''
      return `#${String(c.other_fact_id)} @${score}${pair}`
    })
    .join('、')
  const more = all.length > MAX_LISTED_CONFLICTS ? '…' : ''
  return `：检出 ${String(all.length)} 处冲突（${listed}${more}），见下方「查看未处理矛盾」`
}

export function summarize(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return `：共 ${String(value.length)} 项`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>

    // A write that contradicts existing facts says so — the page must not report a
    // bare "完成" for an edit that just logged a conflict.
    const conflict = conflictSummary(record['contradictions'])
    if (conflict !== undefined) return conflict

    // A plain fact write has nothing to add: the caller's label already reads
    // "更新 #9 完成", and without this branch the raw AddResult would fall through to
    // the JSON.stringify fallback below — the JSON wall this function exists to avoid.
    if ('is_new' in record) return ''

    // `kb_import`: report the other two halves too — "导入 N 个文件" alone hid both the failures
    // and (before `skipped` existed) the files the directory walk ignored by format.
    if (Array.isArray(record['imported'])) {
      const failed = Array.isArray(record['failed']) ? record['failed'].length : 0
      const skipped = typeof record['skipped_total'] === 'number' ? record['skipped_total'] : 0
      return `：成功 ${String(record['imported'].length)} 个`
        + (failed > 0 ? `，失败 ${String(failed)} 个（见返回详情）` : '')
        + (skipped > 0 ? `，跳过 ${String(skipped)} 个非文本文件` : '')
    }
    if ('chunks' in record) return `：${String(record['chunks'])} 个切片`
    if ('doc_id' in record) return `：doc_id=${String(record['doc_id'])}`
    if ('removed' in record) return `：${record['removed'] === true ? '已删除' : '未找到'}`
    if ('error' in record) return `：${String(record['error'])}`
  }
  try {
    const text = JSON.stringify(value)
    return text.length > 160 ? `：${text.slice(0, 160)}…` : `：${text}`
  } catch {
    return ''
  }
}
