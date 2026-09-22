/**
 * The model-facing tool surface: every mutation is validated against node state inside
 * the tree, so a wrong call returns a stable refusal code instead of a thrown error or a
 * partial write. Parameter schemas are written INLINE so `required: true` survives as a
 * literal; the helper below exists only to bind that inference.
 * @module @avantf/dsh-work/tools
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
import { CAPACITY, spillPointer, type Refusal } from '@avantf/work-core'
import type { AvantfWorkHost } from './host.js'

/** The one result shape every tool returns, surfaced as the terminal text block. */
export interface WorkToolResult {
  ok: boolean
  summary: string
  data?: JsonValue
}

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: JsonValue): { type: 'text'; text: string }[] => {
    const record = value as Record<string, JsonValue>
    const summary = record['summary']
    return [{ type: 'text', text: typeof summary === 'string' ? summary : JSON.stringify(value) }]
  },
} as const

/**
 * Convert `defineTool`'s contract into the uniform shape every tool shares:
 * `Record<string, unknown>` arguments and a `WorkToolResult` result. The conversion is
 * asserted, not re-derived — the schemas that reach the model are exactly the ones written.
 */
function workTool(options: {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  presentCall?: (args: Record<string, unknown>) => ToolCallView | undefined
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<WorkToolResult>
}): ToolDefinition {
  return (defineTool as unknown as (definition: typeof options & { output: typeof OUTPUT }) => ToolDefinition)({
    ...options,
    output: OUTPUT,
  })
}

function present(title: string, args: Record<string, unknown>): ToolCallView {
  return { card: 'generic', title, kind: 'other', rawInput: args as JsonValue } as GenericCallView
}

function fail(refusal: Refusal): WorkToolResult {
  return { ok: false, summary: refusal.message, data: { code: refusal.code } }
}

const STATUS_ZH: Record<string, string> = {
  blocked: '等待子工作',
  ready: '待执行',
  running: '执行中',
  interrupted: '已中断',
  done: '已完成',
  failed: '已失败',
}

function statusZh(status: string | undefined): string {
  if (status === undefined) return '?'
  return STATUS_ZH[status] ?? status
}

const NO_CALLER: WorkToolResult = {
  ok: false,
  summary: '这个工具必须由 agent 调用。',
  data: { code: 'no-caller' },
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`work tool: parameter "${key}" must be a non-empty string`)
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
  throw new Error(`work tool: parameter "${key}" must be an array of strings`)
}

/** Read the child-work array of `decompose_work`, accepting the array or its JSON text. */
export function childSpecs(args: Record<string, unknown>): { title: string; description: string; context: string[] }[] {
  const value = structuredArg(args, 'children')
  if (!Array.isArray(value)) throw new Error('work tool: parameter "children" must be an array')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`work tool: children[${String(index)}] must be an object`)
    }
    const record = entry as Record<string, unknown>
    const title = record['title']
    const description = record['description']
    if (typeof title !== 'string' || title.length === 0) {
      throw new Error(`work tool: children[${String(index)}].title must be a non-empty string`)
    }
    if (typeof description !== 'string' || description.length === 0) {
      throw new Error(`work tool: children[${String(index)}].description must be a non-empty string`)
    }
    const context = structuredArg(record, 'context')
    return {
      title,
      description,
      context: Array.isArray(context)
        ? context.filter((item): item is string => typeof item === 'string')
        : typeof context === 'string' ? textLines(context) : [],
    }
  })
}

export function defineWorkTools(host: AvantfWorkHost): ToolDefinition[] {
  const createWork = workTool({
    name: 'create_work',
    description: [
      '建一个工作交给引擎执行：独立的、需要调研的、多步的、要跑一阵的、需要逐步分解的、',
      '碰多个文件或系统的，都算。',
      '',
      '判据是"这件事能不能连验收标准一起交出去"，不是"它复不复杂"：不需要拆的工作同样适合交给它 ——',
      '派一个执行者做完，它跨会话活着、结果落在工作上；需要拆的就交给执行者拆出前置工作，',
      '由引擎逐级派下去。',
      '',
      '工作跨会话持久化，由引擎逐级派给一次性执行者：看不到本对话、不能追问，结束后也不会',
      '再收到你的消息。需要这些、或需要脚本化扇出的工作，不适合用它；但"我已经想清楚了、',
      '步骤很明确"不在这个名单里 —— 那正是它接得最稳的一类。',
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
    },
    presentCall: (args) => present('create_work', args),
    async execute(args, exec): Promise<WorkToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const result = await host.createWork(
        agent,
        str(args, 'title'),
        str(args, 'description'),
        strList(args, 'analysis'),
      )
      if (!result.ok) return fail(result)
      return {
        ok: true,
        summary: `已建工作 [${result.value.id}]「${result.value.title}」，引擎开始派活。`,
        data: { root_id: result.value.id },
      }
    },
  })

  const decomposeWork = workTool({
    name: 'decompose_work',
    description: [
      '把当前工作拆成它依赖的前置工作。每个子工作的 `context` 写清它为什么需要。',
      '',
      '拆解之前必须先用 `note_work` 写下这次为什么拆；没写会被拒。',
    ].join('\n'),
    parameters: {
      node_id: { type: 'string', required: true, description: '你正在做的工作 id。' },
      children: {
        required: true,
        description: `前置工作列表，最多 ${String(CAPACITY.maxChildrenPerDecompose)} 个。也可给它的 JSON 文本。`,
        oneOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true, description: '一行命名这个前置工作。' },
                description: { type: 'string', required: true, description: '要达成什么。' },
                context: {
                  oneOf: [
                    { type: 'array', items: { type: 'string' } },
                    { type: 'string' },
                  ],
                  description: '为什么需要这个前置工作，至少一条。可给数组或一行一条的文本。',
                },
              },
            },
          },
          { type: 'string' },
        ],
      },
    },
    presentCall: (args) => present('decompose_work', args),
    async execute(args, exec): Promise<WorkToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const result = await host.decompose(agent, str(args, 'node_id'), childSpecs(args))
      if (!result.ok) return fail(result)
      // The worker's part is over: the engine owns the children now, and ending
      // the turn here saves the model round-trip that would only restate it.
      exec.concludeTurn()
      const { created, reused } = result.value
      const parts = [`已把 ${str(args, 'node_id')} 拆成 ${String(created.length)} 个前置工作。`]
      if (created.length > 0) parts.push(`新建：${created.join('、')}。`)
      if (reused.length > 0) parts.push(`复用已有：${reused.join('、')}。`)
      parts.push('引擎将派发它们；到此为止。')
      return { ok: true, summary: parts.join(' '), data: { created: [...created], reused: [...reused] } }
    },
  })

  const noteWork = workTool({
    name: 'note_work',
    description: [
      '写下你这次执行当前工作的判断：为什么还没做完、缺什么前提、已经排除了哪条路以及为什么、下一步要判断什么。',
      '',
      '要拆解当前工作时，先调用它；`decompose_work` 会检查这次派发是否已经写过。',
      '写下的内容会留在工作上，本工作被重新派发时（包括子工作都完成后的判断）由下一次执行读到。',
    ].join('\n'),
    parameters: {
      node_id: { type: 'string', required: true, description: '你正在做的工作 id。' },
      analysis: {
        type: 'string',
        required: true,
        description: '这次的分析：缺什么前提、排除了哪条路以及为什么、子工作结果回来后要判断什么。一条一行。',
      },
    },
    presentCall: (args) => present('note_work', args),
    async execute(args, exec): Promise<WorkToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const nodeId = str(args, 'node_id')
      const recorded = await host.recordAnalysis(agent, nodeId, str(args, 'analysis'))
      if (!recorded.ok) return fail(recorded)
      // NOT concluded: writing the analysis is a step inside the attempt, and the
      // executor still has to finish it (usually with `decompose_work`).
      return {
        ok: true,
        summary: `已把工作 ${nodeId} 这次的分析记在工作上；下一次执行本工作时会读到。`,
        data: { node_id: nodeId, analysis_attempt: recorded.value.analysisAttempt },
      }
    },
  })

  const submitWork = workTool({
    name: 'submit_work',
    description: [
      '提交当前工作的结果。结果里写清结论与支持它的事实。有未完成子工作时不能提交。',
    ].join('\n'),
    parameters: {
      node_id: { type: 'string', required: true, description: '你正在做的工作 id。' },
      result: {
        type: 'string',
        required: true,
        description: '完成的结果：结论 + 父工作判断所需的事实。',
      },
    },
    presentCall: (args) => present('submit_work', args),
    async execute(args, exec): Promise<WorkToolResult> {
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
          ? `工作 ${nodeId} 已完成。父工作已集齐全部子工作结果，接下来会被派发。`
          : `工作 ${nodeId} 已完成。`,
        data: { node_id: nodeId, parent_ready: result.value.parentReady },
      }
    },
  })

  const workResult = workTool({
    name: 'work_result',
    description: [
      '读一个工作的完整结果。',
    ].join('\n'),
    parameters: {
      node_id: { type: 'string', required: true, description: '要读结果的工作 id。' },
    },
    presentCall: (args) => present('work_result', args),
    async execute(args, exec): Promise<WorkToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const result = await host.readResult(agent, str(args, 'node_id'))
      if (!result.ok) return fail(result)
      const node = result.value
      const body = node.result ?? '（空结果）'
      const spilled = spillPointer(node)
      const pointer = spilled === '' ? '' : `\n\n完整结果落盘于：${spilled}`
      return {
        ok: true,
        summary: `[${node.id}] ${node.title} — ${node.status}\n\n${body}${pointer}`,
        data: {
          node_id: node.id,
          title: node.title,
          status: node.status,
          result: node.result,
          result_ref: node.resultRef,
          result_hint: node.resultHint,
        },
      }
    },
  })

  const listWorks = workTool({
    name: 'list_works',
    description: [
      '列出你拥有的工作：每个工作一行，带它的 id、状态和标题。',
      '',
      '一个工作的进展只有两种值得知道的情况：还在跑，或者反复出过问题。标出后者时你能做的是',
      '调整方向（`adjust_work`）或取消它（`cancel_work`）—— 工作内部怎么拆、每个部分',
      '什么状态，引擎自己管，你没有对它内部动手的工具。',
    ].join('\n'),
    parameters: {},
    presentCall: (args) => present('list_works', args),
    execute(_args, exec): Promise<WorkToolResult> {
      const agent = exec.agent
      if (agent === undefined) return Promise.resolve(NO_CALLER)
      const works = host.listWorks(agent)
      if (works.length === 0) {
        return Promise.resolve({ ok: true, summary: '本会话没有工作。' })
      }
      const lines = works.map((work) => {
        const closed = work.closed ? ' [已归档]' : ''
        const troubled = work.troubled ? '（反复出过问题）' : ''
        return `[${work.tree.rootId}] ${statusZh(work.root?.status)} — ${work.root?.title ?? '（根工作缺失）'}${closed}${troubled}`
      })
      return Promise.resolve({
        ok: true,
        summary: `共 ${String(works.length)} 个工作：\n${lines.join('\n')}`,
        data: {
          works: works.map((work) => ({
            root_id: work.tree.rootId,
            status: work.root?.status ?? null,
            title: work.root?.title ?? null,
            closed: work.closed,
            troubled: work.troubled,
          })),
        },
      })
    },
  })

  const finishWork = workTool({
    name: 'finish_work',
    description: [
      '收尾一个你拥有的工作。前提：根工作已有结果，且已用 `work_result` 读过它。',
    ].join('\n'),
    parameters: {
      root_id: { type: 'string', required: true, description: '要收尾哪个工作。' },
    },
    presentCall: (args) => present('finish_work', args),
    async execute(args, exec): Promise<WorkToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const rootId = str(args, 'root_id')
      const result = await host.finishWork(agent, rootId)
      if (!result.ok) return fail(result)
      return { ok: true, summary: `工作 ${rootId} 已关闭。`, data: { root_id: rootId } }
    },
  })

  const cancelWork = workTool({
    name: 'cancel_work',
    description: [
      '取消一个你拥有的工作（未完成的子工作记为失败，执行者停止；已提交的结果保留）。',
    ].join('\n'),
    parameters: {
      root_id: { type: 'string', required: true, description: '要取消哪个工作。' },
    },
    presentCall: (args) => present('cancel_work', args),
    async execute(args, exec): Promise<WorkToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const rootId = str(args, 'root_id')
      const result = await host.cancelWork(agent, rootId)
      if (!result.ok) return fail(result)
      return {
        ok: true,
        summary: `已取消工作 ${rootId}：${String(result.value.length)} 个未完成的工作记为失败，运行中的执行者已停止。`,
        data: { root_id: rootId, failed_nodes: result.value.length },
      }
    },
  })

  const adjustWork = workTool({
    name: 'adjust_work',
    description: [
      '调整一个**尚未结束的**根工作（只对根工作有效）：写清哪里不对、应该改成什么。',
      '调整后，该工作名下**还没完成**的子工作会被作废，工作按新方向重新规划；已完成的不受影响。',
    ].join('\n'),
    parameters: {
      root_id: { type: 'string', required: true, description: '要调整的根工作 id。' },
      adjustment: { type: 'string', required: true, description: '哪里不对、应该改成什么。' },
    },
    presentCall: (args) => present('adjust_work', args),
    async execute(args, exec): Promise<WorkToolResult> {
      const agent = exec.agent
      if (agent === undefined) return NO_CALLER
      const rootId = str(args, 'root_id')
      const result = await host.adjustWork(agent, rootId, str(args, 'adjustment'))
      if (!result.ok) return fail(result)
      const parts = [
        result.value.delivered
          ? `纠偏消息已记录并投递给正在执行 ${rootId} 的执行者。`
          : `纠偏消息已记录到工作 ${rootId}，下一次派发时读到。`,
      ]
      if (result.value.voided > 0) {
        parts.push(`作废了 ${String(result.value.voided)} 个未完成的子工作，工作将按新方向重新规划。`)
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
