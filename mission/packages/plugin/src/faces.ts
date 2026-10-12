/**
 * The two tool faces, split so neither caller carries the other's tools: an executor's
 * rides `toolFilter.deny` on dispatch, the owner's is INSTALLED in that agent's own tool
 * scope when the agent appears, with the assembly waterfall as the stateless backstop.
 * Hiding is usability only — the refusals stay the boundary.
 * @module @avantf/dsh-mission/faces
 */

/**
 * What an OWNER must not see: the executor half, which a session that roots trees can never call.
 * The name is read the other way round by the worker-side tables below — this is the deny list
 * applied when the caller is the owner.
 *
 * Since the face is installed per agent scope (see {@link MISSION_FACE_TOOLS}), this list is what
 * the owner's live `restrict()` and the assembly waterfall filter out; it is NOT a registration
 * list any more.
 */
export const OWNER_TOOL_DENY: readonly string[] = [
  'note_mission',
  'decompose_mission',
  'submit_mission',
]

/**
 * The owner half of the mission-tree face: the six tools a session that can root a tree gets
 * REGISTERED in its own scope. Also the deny list for a WORKER (see {@link WORKER_TOOL_DENY}).
 *
 * This is the positive install list: `index.ts` registers exactly these into the owner agent's
 * `agent.ctx.tools.register`, so a session that is neither owner nor worker never sees them at all.
 */
export const OWNER_FACE_TOOLS: readonly string[] = [
  'create_mission',
  'adjust_mission',
  'mission_result',
  'list_missions',
  'finish_mission',
  'cancel_mission',
]

/** The executor half: the three tools a dispatched worker gets registered in its own scope. */
export const WORKER_FACE_TOOLS: readonly string[] = [...OWNER_TOOL_DENY]

/** Every mission-tree tool this plugin registers — the two faces, whichever scope they land in. */
export const MISSION_TOOL_NAMES: readonly string[] = [...OWNER_FACE_TOOLS, ...WORKER_FACE_TOOLS]

/** What a session IS for the tool face: it may root trees, it is one of our dispatched workers, or
 *  it is neither (a teammate, another plugin's child, anyone who is not part of a mission tree). */
export type MissionSessionRole = 'owner' | 'worker' | 'other'

/** The two halves a session can be given, as {@link missionFaceOf} decides. */
export type MissionFace = Exclude<MissionSessionRole, 'other'>

/**
 * Whether this session gets a face at all, and which one.
 *
 * ONE judgement for the whole plugin: the registration (`index.ts`'s `installFace`), the live owner
 * restriction and the assembly waterfall all read this, so the schema a model sees and the scope it
 * was registered in cannot disagree. `canCreateTree` is the authority check the tools themselves
 * use; `isWorkerClaim` is the id-shape check that recognizes every worker this plugin ever minted.
 * Anything else is `undefined` — a teammate subagent carries no mission tool at all.
 */
export function missionFaceOf(judge: {
  canCreateTree(agent: never): boolean
  isWorkerClaim(sessionId: string): boolean
}, agent: { id: string }): MissionFace | undefined {
  if (judge.canCreateTree(agent as never)) return 'owner'
  return judge.isWorkerClaim(agent.id) ? 'worker' : undefined
}

/** The tools one face registers, as a positive list. */
export function faceTools(face: MissionFace): readonly string[] {
  return face === 'owner' ? OWNER_FACE_TOOLS : WORKER_FACE_TOOLS
}

/**
 * The mission tools a session of this role must NOT be shown.
 *
 * The assembly waterfall's half of the judgement: an owner loses the executor half, one of our
 * workers loses the owner half, and a session that is neither loses both. It stays even though the
 * registration above already decides what a live scope holds — the waterfall also runs for an agent
 * this plugin never saw created (a restored/harness-owned session) and for runtimes whose scoped
 * registry is unavailable, where hiding is the only thing left. Visibility only: the refusals inside
 * the tool bodies stay the boundary.
 */
export function hiddenMissionTools(role: MissionSessionRole): readonly string[] {
  switch (role) {
    case 'owner': return OWNER_TOOL_DENY
    case 'worker': return OWNER_FACE_TOOLS
    case 'other': return MISSION_TOOL_NAMES
  }
}

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
  ...OWNER_FACE_TOOLS,
]

export function visibleTo<T extends { readonly name: string }>(
  tools: readonly T[],
  hidden: readonly string[],
): T[] {
  const drop = new Set(hidden)
  return tools.filter((tool) => !drop.has(tool.name))
}
