/**
 * The two prompt contributions this plugin makes.
 *
 * The guidance TEXT is user-editable: its body lives in `<data home>/prompts/mission-tree-guide.md` —
 * the SHARED family prompt directory, where the memory plugin keeps its `mem-*` files — and the
 * constant below is both the built-in default and what a missing/blank file is filled with. The
 * section's identity — name and order — stays in code, so editing a file cannot move the section in
 * the prompt. The loader itself is generic and lives in the BASE (`@avantf/dsh-plugin-base`'s
 * `PromptFiles`), because "ensure the file exists, otherwise use the default" is the same flow for
 * every plugin and the family must be able to fix it with one base release. This module only owns
 * the identity and the default body, and it imports the loader's TYPES only: the value is taken off
 * the dynamically-loaded base at apply time, so the plugin mounts even when the base does not.
 *
 * @module @avantf/dsh-mission/prompt
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LoadedPromptText, PromptFileSpec } from '@avantf/dsh-plugin-base'

/**
 * Static, not per-turn: it describes the DECISION (is this mission tree-shaped?) and what an
 * executor can see, both true before any tree exists, and it names no tool this plugin does
 * not own. The executor boundary is stated as one-shot, blind to the conversation, unreachable
 * afterwards, so a reader can place `create_mission` without being taught tools they may not have.
 */
export const MISSION_TREE_GUIDANCE = [
  '`create_mission` 用来把一件任务交给引擎执行：独立的、需要调研的、多步的、要跑一阵的、需要逐步分解的、碰多个文件或系统的，都算。',
  '判据是"这件事能不能连验收标准一起交出去"，不是"它复不复杂"：不需要拆的任务同样适合交给它 —— 派一个执行者做完，它跨会话活着、结果落在任务上，你这一轮就此结束；需要拆的就交给执行者拆出前置任务，由引擎逐级派下去。',
  '',
  '这里的「任务」是本插件自己的概念：跨会话持久化，由引擎逐级派给一次性执行者。',
  '',
  '建完之后：不要自己去做已经交出去的那些任务，也不要轮询；引擎自己派活，并在根任务收敛时唤醒你。',
  '',
  '任务跑起来后如果方向要改：用 `adjust_mission(root_id, …)` 调整根任务（只对根任务有效），消息会直接投递给正在执行它的执行者。',
  '调整后，它名下还没完成的子任务会被作废，整个任务按新方向重新规划；已完成的不受影响。没有未完成的子任务时，它就是一条投递给执行者的消息。',
  '',
  '执行者是一次性的：看不到本对话、不能追问，结束后也不会再收到你的消息。需要这些、或需要脚本化扇出的任务，不适合用 `create_mission`；但"我已经想清楚了、步骤很明确"不在这个名单里 —— 那正是它接得最稳的一类。',
].join('\n')

/** One section and the file its text may be edited in; the file name is the loader's handle. */
export interface PromptFileEntry {
  readonly file: string
  /** The built-in default body — code-owned, never read from the file. */
  readonly fallback: string
}

/**
 * Where the section's text comes from: `mission-tree-guide.md` inside the SHARED family prompt
 * directory (`<data home>/prompts`; the memory plugin keeps its `mem-*` files beside it).
 *
 * The FILE owns the text; the CODE keeps the identity — the section's name and its order
 * (`getSectionOrder('TOOL_JOBS')`) are set in `index.ts` and cannot be changed from disk. A `.md`
 * this manifest does not list is ignored: it is not a section, and another plugin's file must never
 * be mistaken for one of ours.
 */
export const PROMPT_FILES: readonly PromptFileEntry[] = [
  { file: 'mission-tree-guide.md', fallback: MISSION_TREE_GUIDANCE },
]

/**
 * The prompt directory: the SHARED family directory `<data home>/prompts`.
 *
 * Every avantf plugin writes its model-facing text there and owns a prefix — `mission-*` here, `mem-*`
 * in the memory plugin (whose own section file is `mission-tree-guide.md`'s sibling) — so a deployment
 * can find, diff and back up all of it in one place without any plugin having to guess which files
 * are its own. The data home follows the FAMILY's layer order, the same one the memory engine uses
 * (root `AGENTS.md` 「边界与路径」): an explicit caller value → `$AVANTF_HOME` → the configured
 * `dataHome` → `~/.avantf`.
 *
 * The configured value is passed as its OWN NAMED layer, NOT as the explicit one. Handing a
 * schema-defaulted config value to the explicit slot promotes layer ② above layer ④ and makes
 * `$AVANTF_HOME` dead whenever a config file merely mentions `dataHome` — which is how the two
 * halves of the family ended up resolving the same config to different directories.
 */
export function promptDir(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
  /**
   * The resolver to use — the BASE's `resolveDataHome` at runtime when the base is available.
   * Defaults to the local fallback below, which is what a base-less mount uses. Its input is the
   * family's NAMED slot object, so a caller cannot put the configured value in the explicit slot by
   * accident — the mistake that once made `$AVANTF_HOME` dead on this side of the family.
   */
  resolve: (input: {
    readonly explicit?: string
    readonly env?: Record<string, string | undefined>
    readonly configured?: string
  }) => string = resolveDataHome,
): string {
  return join(resolve({ explicit: undefined, env, configured }), 'prompts')
}

/**
 * The data home, with `~/` (and a bare `~`) expanded: ⑤ explicit → ④ `$AVANTF_HOME` → ② the
 * configured value → `~/.avantf`. The base-less fallback for {@link promptDir}, with the same NAMED
 * slots as the base's `resolveDataHome` — the two must give the same answer, which
 * `test/prompt_files.spec.ts` (the wiring) and `mem/packages/plugin/test/family_pin.spec.ts` (the
 * cross-tree pin) both assert.
 */
export function resolveDataHome(input: {
  readonly explicit?: string
  readonly env?: Record<string, string | undefined>
  readonly configured?: string
} = {}): string {
  const layer5 = input.explicit?.trim() ?? ''
  const env = input.env ?? process.env
  const fromEnv = env['AVANTF_HOME']?.trim() ?? ''
  const layer2 = input.configured?.trim() ?? ''
  const base = layer5 !== '' ? layer5 : fromEnv !== '' ? fromEnv : layer2 !== '' ? layer2 : join(homedir(), '.avantf')
  if (base === '~') return homedir()
  return base.startsWith('~/') ? join(homedir(), base.slice(2)) : base
}

/** The generic loader's input: which file, and the body to write/use when it is missing or blank. */
export function promptFileSpecs(): PromptFileSpec[] {
  return PROMPT_FILES.map(({ file, fallback }) => ({ file, fallback }))
}

/**
 * The text to register for the guidance section: what the file says, or the built-in default when it
 * was not loaded. A file with content is injected exactly as written.
 */
export function buildGuidanceText(loaded: readonly LoadedPromptText[]): string {
  const entry = loaded.find((candidate) => candidate.file === PROMPT_FILES[0]?.file)
  return entry?.text ?? MISSION_TREE_GUIDANCE
}

/** The wording the model must not read (`wording.spec.ts` guards the default against it). */
export const GUIDANCE_TREE_WORDS = ['任务树', '子树', '整棵树', '棵树', '节点', '树'] as const

/** The built-in default's length; the spec asserts the default stays under it. */
export const GUIDANCE_BUDGET = 1200

/**
 * What is worth saying about text the USER wrote — as warnings, never as edits.
 *
 * The default is held to hard rules by `guidance.spec.ts` / `wording.spec.ts` (no tree vocabulary,
 * a budget, only this plugin's own tools). An edited file cannot be held to them — it is the user's
 * prompt — but the tree vocabulary is a MEASURED regression (it invites reading a mission as a
 * container of nodes), so one line in the log is cheap and a silently worse prompt is not. Nothing
 * is truncated and nothing is refused: the file is injected exactly as written.
 */
export function guidanceTextWarnings(text: string): string[] {
  const out: string[] = []
  if (text.length >= GUIDANCE_BUDGET) {
    out.push(
      `avantf:mission-tree-guide is ${String(text.length)} chars (every model step carries it; the built-in default is ${String(MISSION_TREE_GUIDANCE.length)})`,
    )
  }
  // The words nest (`任务树` contains `树`), so one line naming everything found beats one line each.
  const found = GUIDANCE_TREE_WORDS.filter((word) => text.includes(word))
  if (found.length > 0) {
    out.push(
      `avantf:mission-tree-guide says ${found.map((word) => `「${word}」`).join('、')}; the model reads missions, not the shape they grow into`,
    )
  }
  return out
}

// Runtime contexts concatenate in ascending order, so a smaller number renders earlier; the
// todo layer takes an even smaller order, which is how "todo outranks the mission tree" is expressed.
export const GUIDANCE_CONTEXT_ORDER = 40

/**
 * Known limit: a worker reads `dsh-tool-goal`'s static section but holds none of its tools, since
 * the section has no scope check and a worker joins the owner's preset composition. Shadowing it
 * is not a clean fix — a same-name section replaces the owner's contribution too, and the goal
 * package does not export its text. Accepted: `tools.restrict()` makes an attempted call fail as
 * `UNKNOWN_TOOL`, so the whole cost is one wasted turn; the proper fix belongs upstream.
 */

