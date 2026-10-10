/**
 * The two tool faces, split so neither caller carries the other's tools: an executor's
 * rides `toolFilter.deny` on dispatch, the owner's is applied at `agent/created` and in the
 * assembly waterfall. Hiding is usability only — the refusals stay the boundary.
 * @module @avantf/dsh-mission/faces
 */

export const OWNER_TOOL_DENY: readonly string[] = [
  'note_mission',
  'decompose_mission',
  'submit_mission',
]

/**
 * Everything an executor must not hold, grouped by WHY it is dangerous here:
 *
 * - `send_message` delivers into sessions outside this mission — the owner's included, which is how an
 *   executor would report around the tree instead of through `submit_mission`. That is the bypass
 *   `submit_mission` alone cannot prevent, and the reason this name stays.
 * - `create_goal` / `get_goal` / `update_goal` are the OWNER's: an executor that can read or rewrite
 *   the goal it is judged against is answering to a different objective than the one the tree
 *   dispatched, and `dsh-tool-goal`'s static section rides the owner's preset into the executor
 *   (the Known limit at the end of `prompt.ts` records that residue).
 * - the last six are the owner's mission-tree face; an executor touches the tree only through
 *   `note_mission` / `decompose_mission` / `submit_mission`.
 *
 * `subagent` / `subagent_fork` are deliberately ABSENT: spawning a child is how one node works in
 * parallel INTERNALLY, and the tree only ever reads nodes and results — a child the engine cannot see
 * cannot break convergence. What an executor gives up by spawning is attribution/observability, not the
 * tree's integrity, and `submit_mission` stays the one exit either way. Because `send_message` IS denied,
 * the worker prompt tells it to take parallel results synchronously (`run_in_background: false`).
 *
 * `note_mission` is deliberately absent — `decompose_mission` needs it.
 */
export const WORKER_TOOL_DENY: readonly string[] = [
  'send_message',
  'create_goal',
  'get_goal',
  'update_goal',
  'create_mission',
  'adjust_mission',
  'mission_result',
  'list_missions',
  'finish_mission',
  'cancel_mission',
]

export function visibleTo<T extends { readonly name: string }>(
  tools: readonly T[],
  hidden: readonly string[],
): T[] {
  const drop = new Set(hidden)
  return tools.filter((tool) => !drop.has(tool.name))
}
