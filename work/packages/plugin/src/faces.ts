/**
 * The two tool faces, split so neither caller carries the other's tools: an executor's
 * rides `toolFilter.deny` on dispatch, the owner's is applied at `agent/created` and in the
 * assembly waterfall. Hiding is usability only — the refusals stay the boundary.
 * @module @avantf/dsh-work/faces
 */

export const OWNER_TOOL_DENY: readonly string[] = [
  'note_work',
  'decompose_work',
  'submit_work',
]

/**
 * Everything an executor must not hold: the first six spawn work the tree cannot see, and
 * the rest is the owner's face. `note_work` is deliberately absent — `decompose_work` needs it.
 */
export const WORKER_TOOL_DENY: readonly string[] = [
  'send_message',
  'subagent',
  'subagent_fork',
  'create_goal',
  'get_goal',
  'update_goal',
  'create_work',
  'adjust_work',
  'work_result',
  'list_works',
  'finish_work',
  'cancel_work',
]

export function visibleTo<T extends { readonly name: string }>(
  tools: readonly T[],
  hidden: readonly string[],
): T[] {
  const drop = new Set(hidden)
  return tools.filter((tool) => !drop.has(tool.name))
}
