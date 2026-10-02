/**
 * The model-facing tool surface: every mutation is validated against node state inside
 * the tree, so a wrong call returns a stable refusal code instead of a thrown error or a
 * partial write. Parameter schemas are written INLINE so `required: true` survives as a
 * literal; the helper below exists only to bind that inference.
 * @module @avantf/dsh-mission/tools
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  defineTool,
  type GenericCallView,
  type ParameterSchemaSpec,
  type ToolCallView,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { CAPACITY, spillPointer, statusLabel, type Refusal, type WellFormedSource } from '@avantf/mission-core'
import type { AvantfMissionHost } from './host.js'

/** The one result shape every tool returns, surfaced as the terminal text block. */
export interface MissionToolResult {
  ok: boolean
  summary: string
  data?: JsonValue
}

/** The output contract `defineTool` is given: every tool's answer is one text block. */
interface ToolOutput {
  readonly schema: { readonly type: 'object'; readonly additionalProperties: true }
  readonly render: (args: unknown, value: JsonValue) => { type: 'text'; text: string }[]
}

/**
 * The OUTBOUND boundary for tool results (the `mission_result` / `list_missions` / … answers).
 *
 * Every tool answer becomes one text block, either its `summary` or the JSON text of the whole
 * value. BOTH branches must be well-formed, so the value is repaired RECURSIVELY FIRST and only then
 * turned into text: a lone surrogate that `JSON.stringify` emits verbatim as `"\ud800"` makes a
 * strict consumer (`printf '"\\ud800"' | jq .` → `parse error: Invalid \uXXXX\uXXXX surrogate pair
 * escape`; Python's `json.load` accepts it but `print` raises `UnicodeEncodeError`) reject the whole
 * document, while JavaScript's own `JSON.parse` accepts it — which is exactly why this boundary is
 * the responsible one instead of a test.
 *
 * Repairing the VALUE before stringifying also covers data this process did not just write: a tree
 * persisted by an older build (before the inbound funnel existed), or a string a foreign writer put
 * there. `wellFormed` is the host's resolved pair — the loaded base kit when available, the local
 * degradation copy otherwise.
 */
function outputFor(wellFormed: WellFormedSource): ToolOutput {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args: unknown, value: JsonValue): { type: 'text'; text: string }[] => {
      const repaired = wellFormed.deep(value)
      const summary = (repaired as Record<string, JsonValue>)['summary']
      return [{ type: 'text', text: typeof summary === 'string' ? summary : JSON.stringify(repaired) }]
    },
  }
}

/**
 * Convert `defineTool`'s contract into the uniform shape every tool shares:
 * `Record<string, unknown>` arguments and a `MissionToolResult` result. The conversion is
 * asserted, not re-derived — the schemas that reach the model are exactly the ones written.
 */
function workTool(host: AvantfMissionHost, options: {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  presentCall?: (args: Record<string, unknown>) => ToolCallView | undefined
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<MissionToolResult>
}): ToolDefinition {
  return (defineTool as unknown as (definition: typeof options & { output: ToolOutput }) => ToolDefinition)({
    ...options,
    output: outputFor(host.wellFormed),
  })
}

function present(title: string, args: Record<string, unknown>): ToolCallView {
  return { card: 'generic', title, kind: 'other', rawInput: args as JsonValue } as GenericCallView
}

function fail(refusal: Refusal): MissionToolResult {
  return { ok: false, summary: refusal.message, data: { code: refusal.code } }
}

const NO_CALLER: MissionToolResult = {
  ok: false,
  summary: '这个工具必须由 agent 调用。',
  data: { code: 'no-caller' },
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  // Only the truly EMPTY string is refused here. Blank-but-not-empty text is the ENGINE's to judge —
  // it has the field's meaning and a refusal code to say so (`no-analysis`, `blank-text`) — and
  // collapsing the two layers here would leave those codes with no reachable producer.
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`mission tool: parameter "${key}" must be a non-empty string`)
  }
  return value
}

/**
 * Decode one STRUCTURED argument that may have arrived as its JSON text: the transport has
 * been observed handing an array parameter over as the string of its JSON text, which the
 * host validator rejects before `execute` runs. The declarations below accept both shapes
 * (`oneOf`); a string parameter must never be JSON-decoded.
 */
export function structuredArg(args: Record<string, unknown>, key: string): unknown {
  const value = args[key]
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

/** Split a plain-text list argument: one item per line, bullets and blank lines ignored. */
export function textLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^[-*•]\s*/u, ''))
    .filter((line) => line.length > 0)
}

/** Read an optional string-array argument, accepting the array, its JSON text, or one item per line. */
export function strList(args: Record<string, unknown>, key: string): string[] {
  const value = structuredArg(args, key)
  if (value === undefined) return []
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') return textLines(value)
  throw new Error(`mission tool: parameter "${key}" must be an array of strings`)
}

/**
 * Read an optional scope argument (`unit`). Three outcomes, and the difference is load-bearing:
 *
 * - absent (or not a string) → `undefined`: "nothing declared", which for a root means no lease and
 *   for a decomposed child means INHERIT the parent's scope (the safe default);
 * - a blank string → `null`: an explicit opt-OUT, so a child of a scoped mission can still say "this
 *   one touches nothing shared";
 * - anything else → the trimmed scope, the lease key itself.
 */
export function optionalUnit(args: Record<string, unknown>, key: string): string | null | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Read an optional capacity weight ("about how many cores will this occupy"). `undefined` means the
 * caller said nothing — which for BOTH a root and a child is the default 1, never an inherited
 * value (see `@avantf/mission-core`'s `normalizeWeight`). Out-of-range and dirty values are handled
 * by the core's clamp, so an unparseable string here is the only thing dropped, and it is dropped to
 * "said nothing" rather than to a guessed number.
 */
export function optionalWeight(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Read an optional round-cap relaxation (ms). Same reading as {@link optionalWeight}: a missing or
 * unparseable argument means the caller said nothing, which keeps the engine's configured cap. A
 * number that is not positive is dropped HERE as well as in the core normalizer, so a model that
 * writes `0` (or a negative) gets the default rather than an empty round window.
 */
export function optionalRoundMs(args: Record<string, unknown>, key: string): number | undefined {
  const value = optionalWeight(args, key)
  return value !== undefined && value > 0 ? value : undefined
}

/** Read the child-mission array of `decompose_mission`, accepting the array or its JSON text. */
export function childSpecs(args: Record<string, unknown>): {
  title: string
  description: string
  context: string[]
  unit?: string | null
  weight?: number
  roundMs?: number | null
}[] {
  const value = structuredArg(args, 'children')
  if (!Array.isArray(value)) throw new Error('mission tool: parameter "children" must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`mission tool: children[${String(index)}] must be an object`)
    }
    const record = entry as Record<string, unknown>
    const title = record['title']
    const description = record['description']
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error(`mission tool: children[${String(index)}].title must be a non-empty string`)
    }
    if (typeof description !== 'string' || description.length === 0) {
      throw new Error(`mission tool: children[${String(index)}].description must be a non-empty string`)
    }
    const context = structuredArg(record, 'context')
    const unit = optionalUnit(record, 'unit')
    const weight = optionalWeight(record, 'weight')
    const roundMs = optionalRoundMs(record, 'roundMs')
    return {
      title,
      description,
      context: Array.isArray(context)
        ? context.filter((item): item is string => typeof item === 'string')
        : typeof context === 'string' ? textLines(context) : [],
      ...unit === undefined ? {} : { unit },
      ...weight === undefined ? {} : { weight },
      ...roundMs === undefined ? {} : { roundMs },
    }
  })
}

export function defineWorkTools(host: AvantfMissionHost): ToolDefinition[] {
  const createWork = workTool(host, {
    name: 'create_mission',
    description: [
      '建一个任务交给引擎执行：独立的、需要调研的、多步的、要跑一阵的、需要逐步分解的、',
      '碰多个文件或系统的，都算。',
      '',
      '判据是"这件事能不能连验收标准一起交出去"，不是"它复不复杂"：不需要拆的任务同样适合交给它 ——',
      '派一个执行者做完，它跨会话活着、结果落在任务上；需要拆的就交给执行者拆出前置任务，',
      '由引擎逐级派下去。',
      '',
      '任务跨会话持久化，由引擎逐级派给一次性执行者：看不到本对话、不能追问，结束后也不会',
      '再收到你的消息。需要这些、或需要脚本化扇出的任务，不适合用它；但"我已经想清楚了、',
      '步骤很明确"不在这个名单里 —— 那正是它接得最稳的一类。',
      '',
      '`unit` 写这件事将要改动的范围（一个目录或文件）。同一个范围，同一时刻只有一个任务在跑 ——',
      '会改到同一处、又不能同时改的任务，就靠它错开；不写表示不占用任何范围，任务之间互不影响。',
      '写相对仓库根的目录路径，如 `mission/packages/core`：同一个范围要写成同一个字符串（大小写、',
      '分隔符、结尾斜杠不同都算同一个范围），但父目录与它下面的文件算两个范围，不会互相排斥。',
      '',
      '`weight` 写这件事大约会占几核：整机按这个数分配同时能跑多少任务。不写就是普通任务（按 1 核算）——',
      '吃满多核的任务（跑构建、训练、大规模测试）才需要写大一点，写小了会让它和别人挤在一起。',
      '',
      '`roundMs` 写这件事单轮最多能跑多久（毫秒），用来放宽引擎的轮级上限（默认 1 小时）。一般不用写；',
      '确实有单步要跑一小时以上（整仓构建、大训练、长压测）才写大一点——不写就按默认上限，超时会被当作',
      '卡住中断重排。上限最多放宽到 24 小时。',
    ].join('\n'),
    parameters: {
      title: { type: 'string', required: true, description: '一行命名这件事。' },
      description: {
        type: 'string',
        required: true,
        description: '要达成什么，写成执行者能独立看懂的目标。',
      },
      analysis: {
        description: '你的初始判断：方向、约束、已知事实。一条一项。可给数组（推荐）、数组的 JSON 文本、或一行一条的文本。',
        oneOf: [
          { type: 'array', items: { type: 'string' } },
          { type: 'string' },
        ],
      },
      unit: {
        type: 'string',
        description: '这件事将要改动的范围（一个目录或文件），写相对仓库根的路径，如 `mission/packages/core`。同一范围同一时刻只有一个任务在跑；不写表示不占用范围。',
      },
      weight: {
        type: 'number',
        description: '这件事大约会占几核（整机按它决定同时跑几个任务）。不写按 1 核算。',
      },
      roundMs: {
        type: 'number',
        description: '这件事单轮最多能跑多久（毫秒），用来放宽默认 1 小时的轮级上限；最多放宽到 24 小时。有单步超过一小时的重活才写。',
      },
    },
    presentCall: (args) => present('create_mission', args),
    async execute(args, exec): Promise<MissionToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const result = await host.createWork(
        agent,
        str(args, 'title'),
        str(args, 'description'),
        strList(args, 'analysis'),
        optionalUnit(args, 'unit'),
        optionalWeight(args, 'weight'),
        optionalRoundMs(args, 'roundMs'),
      )
      if (!result.ok) return fail(result)
      return {
        ok: true,
        summary: `已建任务 [${result.value.id}]「${result.value.title}」，引擎开始派活。`,
        data: { root_id: result.value.id },
      }
    },
  })

  const decomposeWork = workTool(host, {
    name: 'decompose_mission',
    description: [
      '把当前任务拆成它依赖的前置任务。每个子任务的 `context` 写清它为什么需要。',
      '',
      '拆解之前必须先用 `note_mission` 写下这次为什么拆；没写会被拒。',
      '',
      '子任务的 `unit` 不写就继承当前任务改动的范围：同一范围同一时刻只有一个任务在跑，',
      '所以要并行改不同地方的子任务，给它们各自写清自己的 `unit`。',
      '',
      '子任务的 `weight` 不继承当前任务，不写就按 1 核算：父任务吃满多核，不代表它的每个前置任务都吃满。',
      '',
      '子任务的 `roundMs`（单轮最多跑多久，毫秒）同样不继承当前任务，不写就按引擎默认上限（1 小时）。',
    ].join('\n'),
    parameters: {
      node_id: { type: 'string', required: true, description: '你正在做的任务 id。' },
      children: {
        required: true,
        description: `前置任务列表，最多 ${String(CAPACITY.maxChildrenPerDecompose)} 个。也可给它的 JSON 文本。`,
        oneOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true, description: '一行命名这个前置任务。' },
                description: { type: 'string', required: true, description: '要达成什么。' },
                context: {
                  oneOf: [
                    { type: 'array', items: { type: 'string' } },
                    { type: 'string' },
                  ],
                  description: '为什么需要这个前置任务，至少一条。可给数组或一行一条的文本。',
                },
                unit: {
                  type: 'string',
                  description: '这个前置任务要改动的范围（一个目录或文件），写相对仓库根的路径，如 `mission/packages/core`。不写就继承当前任务的范围；同一范围同一时刻只有一个任务在跑。',
                },
                weight: {
                  type: 'number',
                  description: '这个前置任务大约会占几核。不写按 1 核算，不继承当前任务的估值。',
                },
                roundMs: {
                  type: 'number',
                  description: '这个前置任务单轮最多跑多久（毫秒），放宽默认 1 小时的轮级上限，最多 24 小时。不写按默认，不继承当前任务。',
                },
              },
            },
          },
          { type: 'string' },
        ],
      },
    },
    presentCall: (args) => present('decompose_mission', args),
    async execute(args, exec): Promise<MissionToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const result = await host.decompose(agent, str(args, 'node_id'), childSpecs(args))
      if (!result.ok) return fail(result)
      // The worker's part is over: the engine owns the children now, and ending
      // the turn here saves the model round-trip that would only restate it.
      exec.concludeTurn()
      const { created, reused } = result.value
      const parts = [`已把 ${str(args, 'node_id')} 拆成 ${String(created.length)} 个前置任务。`]
      if (created.length > 0) parts.push(`新建：${created.join('、')}。`)
      if (reused.length > 0) parts.push(`复用已有：${reused.join('、')}。`)
      parts.push('引擎将派发它们；到此为止。')
      return { ok: true, summary: parts.join(' '), data: { created: [...created], reused: [...reused] } }
    },
  })

  const noteWork = workTool(host, {
    name: 'note_mission',
    description: [
      '写下你这次执行当前任务的判断：为什么还没做完、缺什么前提、已经排除了哪条路以及为什么、下一步要判断什么。',
      '',
      '要拆解当前任务时，先调用它；`decompose_mission` 会检查这次派发是否已经写过。',
      '写下的内容会留在任务上，本任务被重新派发时（包括子任务都完成后的判断）由下一次执行读到。',
    ].join('\n'),
    parameters: {
      node_id: { type: 'string', required: true, description: '你正在做的任务 id。' },
      analysis: {
        type: 'string',
        required: true,
        description: '这次的分析：缺什么前提、排除了哪条路以及为什么、子任务结果回来后要判断什么。一条一行。',
      },
    },
    presentCall: (args) => present('note_mission', args),
    async execute(args, exec): Promise<MissionToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const nodeId = str(args, 'node_id')
      const recorded = await host.recordAnalysis(agent, nodeId, str(args, 'analysis'))
      if (!recorded.ok) return fail(recorded)
      // NOT concluded: writing the analysis is a step inside the attempt, and the
      // executor still has to finish it (usually with `decompose_mission`).
      return {
        ok: true,
        summary: `已把任务 ${nodeId} 这次的分析记在任务上；下一次执行本任务时会读到。`,
        data: { node_id: nodeId, analysis_attempt: recorded.value.analysisAttempt },
      }
    },
  })

  const submitWork = workTool(host, {
    name: 'submit_mission',
    description: [
      '提交当前任务的结果。结果里写清结论与支持它的事实。有未完成子任务时不能提交。',
    ].join('\n'),
    parameters: {
      node_id: { type: 'string', required: true, description: '你正在做的任务 id。' },
      result: {
        type: 'string',
        required: true,
        description: '完成的结果：结论 + 父任务判断所需的事实。',
      },
    },
    presentCall: (args) => present('submit_mission', args),
    async execute(args, exec): Promise<MissionToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const nodeId = str(args, 'node_id')
      const result = await host.submitResult(agent, nodeId, str(args, 'result'))
      if (!result.ok) return fail(result)
      // The node is terminal and the engine has been pumped: this turn has
      // nothing left to do, so it ends here.
      exec.concludeTurn()
      return {
        ok: true,
        summary: result.value.parentReady
          ? `任务 ${nodeId} 已完成。父任务已集齐全部子任务结果，接下来会被派发。`
          : `任务 ${nodeId} 已完成。`,
        data: { node_id: nodeId, parent_ready: result.value.parentReady },
      }
    },
  })

  const workResult = workTool(host, {
    name: 'mission_result',
    description: [
      '读一个任务的完整结果。',
    ].join('\n'),
    parameters: {
      node_id: { type: 'string', required: true, description: '要读结果的任务 id。' },
    },
    presentCall: (args) => present('mission_result', args),
    async execute(args, exec): Promise<MissionToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const result = await host.readResult(agent, str(args, 'node_id'))
      if (!result.ok) return fail(result)
      const node = result.value
      const body = node.result ?? '（空结果）'
      const spilled = spillPointer(node)
      const pointer = spilled === '' ? '' : `\n\n完整结果落盘于：${spilled}`
      // Read BEFORE the result on purpose: the title above is the goal as the owner created it, and
      // a corrected mission's result answers a later direction. Without this the two read as a mismatch
      // — and this is the only place the owner can recover a correction made in an earlier session.
      const corrections = node.corrections.length === 0
        ? ''
        : `\n\n纠偏（按先后顺序）：\n${node.corrections.map((entry) => `- ${entry}`).join('\n')}`
      // Flattened into a plain JSON object on purpose: the tool result's `data` is a `JsonValue`, and
      // the engine's `WaitingFor` interface has no index signature.
      const waiting = host.waitingForOf(node.id)
      return {
        ok: true,
        summary: `[${node.id}] ${node.title} — ${node.status}${corrections}\n\n${body}${pointer}`,
        data: {
          node_id: node.id,
          title: node.title,
          status: node.status,
          weight: node.weight,
          // Carried even though a result read is terminal-only (so this is `null` in practice): the
          // projection is the node's, and a consumer must not have to know which reader filled it.
          waiting_for: waiting === null ? null : {
            reason: waiting.reason,
            ...waiting.resource === undefined ? {} : { resource: waiting.resource },
            ...waiting.needed === undefined ? {} : { needed: waiting.needed },
            ...waiting.available === undefined ? {} : { available: waiting.available },
            ...waiting.unit === undefined ? {} : { unit: waiting.unit },
          },
          corrections: [...node.corrections],
          result: node.result,
          result_ref: node.resultRef,
          result_hint: node.resultHint,
        },
      }
    },
  })

  const listWorks = workTool(host, {
    name: 'list_missions',
    description: [
      '列出你拥有的任务：每个任务一行，带它的 id、状态和标题。',
      '',
      '一个任务的进展只有两种值得知道的情况：还在跑，或者反复出过问题。标出后者时你能做的是',
      '调整方向（`adjust_mission`）或取消它（`cancel_mission`）—— 任务内部怎么拆、每个部分',
      '什么状态，引擎自己管，你没有对它内部动手的工具。',
    ].join('\n'),
    parameters: {},
    presentCall: (args) => present('list_missions', args),
    execute(_args, exec): Promise<MissionToolResult> {
      const agent = exec.agent
      if (agent === undefined) return Promise.resolve(NO_CALLER)
      const missions = host.listWorks(agent)
      if (missions.length === 0) {
        return Promise.resolve({ ok: true, summary: '本会话没有任务。' })
      }
      const lines = missions.map((mission) => {
        const closed = mission.closed ? ' [已归档]' : ''
        const troubled = mission.troubled ? '（反复出过问题）' : ''
        return `[${mission.tree.rootId}] ${statusLabel(mission.root?.status)} — ${mission.root?.title ?? '（根任务缺失）'}${closed}${troubled}`
      })
      return Promise.resolve({
        ok: true,
        summary: `共 ${String(missions.length)} 个任务：\n${lines.join('\n')}`,
        data: {
          missions: missions.map((mission) => ({
            root_id: mission.tree.rootId,
            status: mission.root?.status ?? null,
            title: mission.root?.title ?? null,
            closed: mission.closed,
            troubled: mission.troubled,
          })),
        },
      })
    },
  })

  const finishWork = workTool(host, {
    name: 'finish_mission',
    description: [
      '收尾一个你拥有的任务。前提：根任务已有结果，且已用 `mission_result` 读过它。',
    ].join('\n'),
    parameters: {
      root_id: { type: 'string', required: true, description: '要收尾哪个任务。' },
    },
    presentCall: (args) => present('finish_mission', args),
    async execute(args, exec): Promise<MissionToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const rootId = str(args, 'root_id')
      const result = await host.finishWork(agent, rootId)
      if (!result.ok) return fail(result)
      return { ok: true, summary: `任务 ${rootId} 已关闭。`, data: { root_id: rootId } }
    },
  })

  const cancelWork = workTool(host, {
    name: 'cancel_mission',
    description: [
      '取消一个你拥有的任务（未完成的子任务记为失败，执行者停止；已提交的结果保留）。',
    ].join('\n'),
    parameters: {
      root_id: { type: 'string', required: true, description: '要取消哪个任务。' },
    },
    presentCall: (args) => present('cancel_mission', args),
    async execute(args, exec): Promise<MissionToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const rootId = str(args, 'root_id')
      const result = await host.cancelWork(agent, rootId)
      if (!result.ok) return fail(result)
      return {
        ok: true,
        summary: `已取消任务 ${rootId}：${String(result.value.length)} 个未完成的任务记为失败，运行中的执行者已停止。`,
        data: { root_id: rootId, failed_nodes: result.value.length },
      }
    },
  })

  const adjustWork = workTool(host, {
    name: 'adjust_mission',
    description: [
      '调整一个**尚未结束的**根任务（只对根任务有效）：写清哪里不对、应该改成什么。',
      '调整后，该任务名下**还没完成**的子任务会被作废，任务按新方向重新规划；已完成的不受影响。',
    ].join('\n'),
    parameters: {
      root_id: { type: 'string', required: true, description: '要调整的根任务 id。' },
      adjustment: { type: 'string', required: true, description: '哪里不对、应该改成什么。' },
    },
    presentCall: (args) => present('adjust_mission', args),
    async execute(args, exec): Promise<MissionToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const rootId = str(args, 'root_id')
      const result = await host.adjustWork(agent, rootId, str(args, 'adjustment'))
      if (!result.ok) return fail(result)
      const parts = [
        result.value.delivered
          ? `纠偏消息已记录并投递给正在执行 ${rootId} 的执行者。`
          : `纠偏消息已记录到任务 ${rootId}，下一次派发时读到。`,
      ]
      if (result.value.voided > 0) {
        parts.push(`作废了 ${String(result.value.voided)} 个未完成的子任务，任务将按新方向重新规划。`)
      }
      return {
        ok: true,
        summary: parts.join(''),
        data: { root_id: rootId, delivered: result.value.delivered, voided: result.value.voided },
      }
    },
  })

  return [
    createWork,
    adjustWork,
    noteWork,
    decomposeWork,
    submitWork,
    workResult,
    listWorks,
    finishWork,
    cancelWork,
  ]
}
