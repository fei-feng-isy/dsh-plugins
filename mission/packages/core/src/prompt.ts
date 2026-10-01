/**
 * Worker prompt construction: one template, branching on the node's state for the trailing section; the tail is derived from the node at dispatch time, exists only in this dispatch's input and never enters a conversation.
 * @module @avantf/mission-core/prompt
 */
import { CAPACITY, TERMINAL, type DispatchView, type NodeRecord } from './types.js'

/** Node statuses in the language the model reads. */
const STATUS_ZH: Record<string, string> = {
  blocked: '等待子任务',
  ready: '待执行',
  running: '执行中',
  interrupted: '已中断',
  done: '已完成',
  failed: '已失败',
}

/** One node status in the language the model and the panel read. */
export function statusLabel(status: string | undefined): string {
  if (status === undefined) return '?'
  return STATUS_ZH[status] ?? status
}

/**
 * Whether ONE node carries trouble worth telling the owner about: three durable, never-reset
 * histories — silent reclaims (`stalls`), failed attempts (`failures`), starts that never got a
 * worker (`spawnFailures`) — each at the ENGINE's own floor.
 *
 * ONE definition, because three channels ask this question: the owner-facing flag below, the stall
 * heads-up (`reportStall`), and the failed-start heads-up. They used to disagree — the flag counted
 * `spawnFailures` while the stall gate did not — so a mission that could not get a worker started read
 * as 「反复出过问题」 in `list_missions` and the owner was never told why. Splitting the predicate out is
 * what makes "both channels speak one vocabulary" true by construction rather than by comment.
 */
export function isTroubledNode(node: NodeRecord): boolean {
  return node.stalls >= CAPACITY.maxStallsBeforeReport
    || node.failures >= CAPACITY.maxAttempts - 1
    || node.spawnFailures >= CAPACITY.maxAttempts - 1
}

/**
 * Whether a mission should read as TROUBLED to its owner: some unfinished node trips {@link isTroubledNode}.
 * The wording has to say this is HISTORY, because a flag that never clears would invite the owner to steer or cancel a mission that is running fine, and both actions are destructive.
 * Deliberately NOT here: which mission it was, how often, and how much budget is left — those belong to the engine's retry policy, and the owner's two actions (`adjust_mission`, `cancel_mission`) take the whole mission, not a node inside it.
 */
export function isTroubled(nodes: readonly NodeRecord[]): boolean {
  return nodes.some((node) => !TERMINAL.has(node.status) && isTroubledNode(node))
}

/** The basic facts a mission-chain entry carries — deliberately not the full content; a correction is rendered here as well as on its own node because corrections are written on the ROOT, and the chain is the only channel that reaches every dispatch. */
function chainLine(node: NodeRecord): string {
  const reason = node.context.length > 0 ? ` — ${node.context[0]}` : ''
  const corrections = node.corrections.length > 0
    ? ` ｜ 纠偏：${node.corrections.join('；')}`
    : ''
  return `- [${node.id}] ${node.title}${reason}${corrections}`
}

/** The full block for the node being executed right now. */
function currentNodeBlock(node: NodeRecord): string {
  const lines: string[] = [
    `id: ${node.id}`,
    `标题: ${node.title}`,
    `内容: ${node.description}`,
  ]
  if (node.context.length > 0) {
    lines.push('背景:')
    for (const fact of node.context) lines.push(`  - ${fact}`)
  }
  if (node.corrections.length > 0) {
    lines.push('纠偏:')
    for (const correction of node.corrections) lines.push(`  - ${correction}`)
  }
  analysisSection(node, lines)
  // Say how many FAILED EXECUTIONS remain, not how many times this node was dispatched: `attempts` counts every dispatch, including successful aggregate/convergence rounds. Silence when nothing has failed, so a first dispatch is not invited to pace itself against a clock it cannot see.
  if (node.failures > 0) {
    const left = Math.max(CAPACITY.maxAttempts - node.failures, 0)
    lines.push(left === 0
      ? '执行预算已用尽：本次执行若仍无结果，本任务将被判为失败'
      : `之前有 ${node.failures} 次执行没有交出结果；再失败 ${left} 次，本任务将被判为失败`)
  }
  return lines.join('\n')
}

/** The earlier rounds' own analysis, crossing the boundary between the session that attempted the node and the FRESH session that later judges it; it rides inside the 「本任务」 block, before the children results, because it is a premise of reading them, and it is absent when no notes were recorded. */
function analysisSection(node: NodeRecord, lines: string[]): void {
  if (node.analysisNotes.length === 0) return
  lines.push('执行本任务时写下的分析（由上一次执行本任务的执行者记录）：')
  for (const note of node.analysisNotes) lines.push(`  - ${note}`)
}

/**
 * Where a spilled full result lives, with the backend's own retrieval guidance; one definition for both renderers — the worker prompt and `mission_result` — because a locator without its hint is a pointer nobody can follow.
 */
export function spillPointer(node: NodeRecord): string {
  if (node.resultRef === null) return ''
  return node.resultHint === null ? node.resultRef : `${node.resultRef} — ${node.resultHint}`
}

/** Children conclusions, used only when the node is an aggregate. */
function childrenBlock(view: DispatchView): string {
  const lines: string[] = ['子任务结果：']
  for (const child of view.children) {
    const body = child.hasResult ? (child.result ?? '（空结果）') : '（未提交结果）'
    const pointer = spillPointer(child)
    const ref = pointer === '' ? '' : `\n  完整结果：${pointer}`
    // The status is part of the fact: a cancelled child and a child that simply never wrote a result read identically otherwise, and the judge has to tell them apart.
    lines.push(`- [${child.id}] ${child.title}（${statusLabel(child.status)}）：${body}${ref}`)
  }
  return lines.join('\n')
}

const EXECUTE_TAIL = [
  '你只负责这一个任务。做完，或说清缺什么，然后停。',
  '',
  '按这个顺序做：',
  '1. 直接尝试完成。多数任务按给定信息就能做完。',
  '2. 如果卡在某个必须先解决的前提上：先用 `note_mission` 写下这次分析（缺什么前提、排除了哪条路以及为什么、前置任务完成后要判断什么），再用 `decompose_mission` 建出前置任务，并在每个子任务的 context 里写清它为什么需要。然后停 —— 引擎会派发它们，做完后本任务会被重新派发。',
  '',
  '3. 如果上面有纠偏消息、或发现原方向作废：按新方向重新规划。要拆解时先重新 `note_mission`（新方向不需要拆解时直接',
  '   `submit_mission`）。已经有子任务时说明它们都已终态，直接重新拆解即可。然后停。',
  '',
  '每次执行只有一个结局：',
  '- `submit_mission(node_id, result)`：任务完成。',
  '- `decompose_mission(node_id, children)`：需要前置条件；本任务等它们终态后会被重新派发。',
  '',
  '不要等，不要找别的任务，不要打听进度，也不要替子任务干活。',
].join('\n')

const AGGREGATE_TAIL_PREFIX = [
  '子任务都已终态。',
  '',
  '这个任务之前被拆成了子任务，你来判断它是否达成。先读「执行本任务时写下的分析」——那是上一次执行本任务时留下的判断依据，再读子任务结果：',
  '- 目标已达成 → `submit_mission(node_id, <结论>)`。',
  '- 还缺东西 → 先用 `note_mission` 写下你这一轮的分析（这次为什么还缺、排除了哪条路以及为什么、重新拆解后要判断什么），再用 `decompose_mission(node_id, children)` 建出剩余前置任务，每个子任务写清为什么需要。',
  '',
  '不要重做子任务，只做判断与收敛。背景里有纠偏消息时，按它重新判断方向（需要时按上面的顺序重新拆解）。',
].join('\n')

/**
 * What an executor at the depth ceiling has to know BEFORE it plans a decomposition, because the engine
 * refuses one there (`depth-exceeded`) and that refusal is otherwise the only place the fact exists.
 * Without this line the executor burns a turn on `note_mission` + `decompose_mission`, and a node that never
 * recovers is reclaimed as `stalled` — a structural ceiling gets recorded as an executor that hung.
 * Appended to BOTH tails: an aggregate at the ceiling has the same trap (`还缺东西 → decompose_mission`).
 */
function depthCeilingLine(): string {
  return `⚠ 本任务已在深度上限（第 ${String(CAPACITY.maxDepth)} 层），引擎不会再接受拆解：不要再 note_mission + decompose_mission，`
    + '直接把结论 `submit_mission` 交上来；确实做不完，就把「缺什么前提、已经排除了哪条路」写进结果，交给上一层去拆。'
}

/**
 * Build the complete prompt for one dispatch; the mission chain carries only titles and one-line context, so its size is bounded by the depth limit, and the full `description`/`context` is included for the current node only.
 * The tail branches on the CHILDREN in the view, not on the node's status: the prompt is built after `dispatch()` has already marked the node `running`, so a status test can never see the aggregate case, and a `failed` node is never dispatched at all.
 */
export function buildWorkerPrompt(view: DispatchView): string {
  const { node, chain, children } = view
  const sections: string[] = []

  if (chain.length > 0) {
    sections.push(['任务链（根任务 → 本任务）：', ...chain.map(chainLine)].join('\n'))
  }

  sections.push(['本任务：', currentNodeBlock(node)].join('\n'))

  // `children` holds exactly the node's terminal children, so a non-empty view means the aggregate pass.
  if (children.length > 0) {
    sections.push(childrenBlock(view))
    sections.push(AGGREGATE_TAIL_PREFIX)
  } else {
    sections.push(EXECUTE_TAIL)
  }

  // The ceiling is a dispatch-time fact, so it is stated here rather than discovered by refusal.
  if (node.depth >= CAPACITY.maxDepth) sections.push(depthCeilingLine())

  return sections.join('\n\n')
}

/**
 * The compact per-tree progress line the guidance layer carries; every clause is anchored so it stays true when read late — the counts are a statement about a moment, not about "now".
 * Granularity is deliberate: the owner is told WHETHER mission is still running and WHETHER any of it has a history of trouble, never how the mission is distributed across states, because no owner action depends on that distribution, so a per-state breakdown would only invite it to reason about a layer it cannot touch.
 * Trouble is the one fact that changes what it should do, and it is counted in WORKS, not in nodes, so the size of anything stays inside the engine.
 */
export function buildProgressLine(input: {
  readonly roots: readonly NodeRecord[]
  /** How many missions have not finished yet. */
  readonly ongoing: number
  /** Whether any unfinished mission carries a history of stalls or failures at the engine's floors. */
  readonly troubled: boolean
}): string {
  const parts: string[] = []
  if (input.ongoing > 0) {
    parts.push(`${input.ongoing} 个进行中${input.troubled ? '（反复出过问题）' : ''}`)
  }
  const converged = input.roots.filter((root) => root.status === 'done' || root.status === 'failed')
  const terminal = converged.map((root) => `[${root.id}] ${root.title}：${statusLabel(root.status)}`)
  const summary = parts.length > 0
    ? parts.join('，')
    : input.roots.length > 0 ? '暂无进行中的' : '暂无任务'
  const lines = [`任务：${summary}。`]
  if (terminal.length > 0) {
    lines.push(`已结束的任务：${terminal.join(' | ')}`)
    lines.push('用 mission_result(root_id) 读完整结论；交付后用 finish_mission(root_id) 收尾。')
  } else {
    lines.push('用 mission_result(node_id) 读完整结论；用 create_mission 建新的活。')
  }
  return lines.join('\n')
}
