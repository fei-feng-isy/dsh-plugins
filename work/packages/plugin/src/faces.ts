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
 * Everything an executor must not hold, grouped by WHY it is dangerous here:
 *
 * - `subagent` / `subagent_fork` start work the TREE cannot see (no node, no result, no convergence),
 *   and `send_message` delivers into sessions outside this work — the owner's included, which is how an
 *   executor would report around the tree instead of through `submit_work`.
 * - `create_goal` / `get_goal` / `update_goal` are the OWNER's: an executor that can read or rewrite
 *   the goal it is judged against is answering to a different objective than the one the tree
 *   dispatched, and `dsh-tool-goal`'s static section rides the owner's preset into the executor
 *   (the Known limit at the end of `prompt.ts` records that residue).
 * - the last six are the owner's work-tree face; an executor touches the tree only through
 *   `note_work` / `decompose_work` / `submit_work`.
 *
 * Only `subagent` / `subagent_fork` actually SPAWN a session — the rest are refusals of access, not
 * of spawning, and the comment here used to claim otherwise for all six.
 *
 * `note_work` is deliberately absent — `decompose_work` needs it.
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
