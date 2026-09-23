/**
 * `@avantf/dsh-work` — the DSH-side half of the work-tree engine: a host service owning the tree,
 * storage and dispatch loop, the owner's tool surface, a guidance context, and a pre-step hook that
 * decides what a proposed step carries to the model.
 *
 * The hook makes wake-ups free by emptying the batch when there is nothing to act on (an empty batch
 * opens no step). It must never REFUSE the step: that ends the turn and would cut a tool-calling
 * step off from its own result.
 *
 * @module @avantf/dsh-work
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-spill'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: merges `register` onto `ctx.typert`; without this import the augmentation is not in the program.
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { AvantfWorkHost } from './host.js'
import { defineWorkTools } from './tools.js'
import {
  GUIDANCE_CONTEXT_ORDER,
  WORK_TREE_GUIDANCE,
  buildGuidanceText,
  guidanceTextWarnings,
  promptDir,
  promptFileSpecs,
} from './prompt.js'
import { OWNER_TOOL_DENY, visibleTo } from './faces.js'
import { archiveWorkers, bytes, removeWorker, workerSessions, type ArchiveRegistry } from './workerSessions.js'
import { hostContribution } from './wire.js'
import { createLogger } from './log.js'
import {
  loadCompat,
  provision,
  registerCompatMegaphone,
  verifyRegisteredFaces,
} from './envinit.js'

export const name = 'avantf-work'

// A title is one line by convention (the work chain renders one per ancestor), so a pasted paragraph must not become one.
const TITLE_MAX = 80

// Every service this plugin needs, gating `apply`: subagents (work units), storageDomain (the tree),
// systemPrompt (guidance), tools (model surface), agents (liveness), commands (`/work`).
export const inject = [
  'tools',
  'agents',
  'subagents',
  'systemPrompt',
  'storageDomain',
  'commands',
  'timer',
  // The host face of the browser half's Remote namespace; absent in a headless deployment.
  'typert',
]

export interface Config {
  /** Dispatch ceiling; omitted means "CPU cores minus one", leaving the host a core for its own turns. */
  maxConcurrent?: number
  /** Silence before a worker is treated as stuck (default 30 min, floor 1 min), measured from its
   * last durable activity so a legitimately long step does not count as no progress. */
  staleMs?: number
  /** Root of the session store `/archive` and `/clean` act on (default `<dsh home>/sessions`); only a
   * directory directly under it named exactly a session id is ever touched, so a wrong value removes nothing. */
  sessionsRoot?: string
  /** The avantf data home (default `$AVANTF_HOME`, else `~/.avantf`). Only its `prompts/` subdirectory
   * is used — the shared directory holding every avantf plugin's editable system-prompt text. */
  dataHome?: string
}

export const Config: z<Config> = z.object({
  maxConcurrent: z.natural(),
  staleMs: z.natural(),
  sessionsRoot: z.string(),
  dataHome: z.string(),
})

// Re-exported for readability: a second definition here would drift from the one the host applies.
export { WORKER_TOOL_DENY } from './faces.js'

/** This plugin's own wake signal: a trigger to open a turn, never content. */
function isOwnWake(message: UserMessage): boolean {
  const source = message.source as { kind?: string; plugin?: string }
  return source.kind === 'plugin' && source.plugin === name
}

// Results travel through the tree, so the worker's own closing words are dropped; only our workers qualify.
function isWorkerNotice(message: UserMessage, host: AvantfWorkHost): boolean {
  const source = message.source as { kind?: string; senderSessionId?: string }
  return source.kind === 'subagent-settled'
    && typeof source.senderSessionId === 'string'
    && host.isWorkerClaim(source.senderSessionId)
}

// Structural rather than `Agent['inbox']` so an agent-shaped stub degrades to "no queued input"
// instead of throwing inside `agent/pre-step`, where a throw fails the whole turn.
interface PendingInbox {
  readonly nextStep: readonly UserMessage[]
  readonly nextTurn: readonly UserMessage[]
  remove(messageId: UserMessage['id']): boolean
}

function pendingInboxOf(agent: Agent): PendingInbox | undefined {
  return (agent as { inbox?: PendingInbox }).inbox
}

// A notice left pending is worse than noise: it becomes a later turn's entire batch and sits in
// front of whatever the user queued after it (results travel through the tree, not this message).
function discardQueuedNotices(agent: Agent, host: AvantfWorkHost): void {
  const inbox = pendingInboxOf(agent)
  if (inbox === undefined) return
  for (const message of [...inbox.nextStep, ...inbox.nextTurn]) {
    if (isWorkerNotice(message, host)) inbox.remove(message.id)
  }
}

// A wake is a trigger, never content, so exactly one is enough to open the turn that reads the
// guidance; more would only open a turn that gets emptied again. `keepOne: false` (nothing
// actionable) drops every queued wake, since the guidance will say it all again anyway.
function discardQueuedWakes(agent: Agent, _host: AvantfWorkHost, keepOne: boolean): void {
  const inbox = pendingInboxOf(agent)
  if (inbox === undefined) return
  let kept = false
  for (const message of [...inbox.nextStep, ...inbox.nextTurn]) {
    if (!isOwnWake(message)) continue
    if (keepOne && !kept) {
      kept = true
      continue
    }
    inbox.remove(message.id)
  }
}

// A step that ends instead of entering would strand input queued behind a claimed signal (the loop
// stops the driver without re-reading the inbox, and nothing wakes it for already-queued input). The
// message is REMOVED here because the step that returns it delivers it: left pending it would be claimed twice.
function takeQueuedInput(agent: Agent, host: AvantfWorkHost): UserMessage | undefined {
  const inbox = pendingInboxOf(agent)
  if (inbox === undefined) return undefined
  for (const message of [...inbox.nextStep, ...inbox.nextTurn]) {
    if (isOwnWake(message) || isWorkerNotice(message, host)) continue
    return inbox.remove(message.id) ? message : undefined
  }
  return undefined
}


// Cordis clears `fiber.uid` on disposal and later context calls throw `INACTIVE_EFFECT`; `apply`
// awaits environment preparation, so a reload can land in that window. A fiberless stub counts as active.
function stillActive(ctx: Context): boolean {
  const fiber = (ctx as unknown as { fiber?: { uid: number | null } }).fiber
  return fiber === undefined || fiber.uid !== null
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  // Own sink mirroring the host logger to stderr: the harness logger is buffered, so without this a mount is unverifiable from outside.
  const log = createLogger(ctx.logger)
  log.info(`mounting: config=${JSON.stringify(config)} inject=${inject.join(',')}`)

  // ── environment initialisation, FIRST ───────────────────────────────────
  // The framework's fixed sequence ends in the plugin's own pre-mount check: the compatibility gate,
  // run before anything is registered so "do not load" costs nothing to unwind. It never refuses for
  // "cannot tell" (a warning, and the plugin mounts intact); only a PROVEN break refuses.
  const compat = await loadCompat({ log })

  // The await above can last the whole startup budget (15 s on a first run), during which an unload
  // clears this fiber's uid; re-assert liveness and stop cleanly rather than half-registering.
  if (!stillActive(ctx)) {
    log.warn('unmounted while preparing the environment; stopping before registering anything')
    return
  }

  if (compat === undefined) {
    log.warn('the dsh compatibility gate is ABSENT (@avantf/dsh-plugin-base unavailable — see the `compat:` warnings above); mounting the full plugin anyway')
  } else {
    const verdict = provision(ctx, log, compat)
    if (!verdict.load) {
      registerCompatMegaphone(ctx, verdict, log, compat)
      log.warn('plugin not loaded: the host dsh API is incompatible (compat check above) — nothing was registered')
      return
    }
  }

  // Publishes itself from its `Service` base under the plugin's own scope, so it leaves with the fiber.
  const host = new AvantfWorkHost(ctx, config, log)

  // The host face of this plugin's Remote namespace: registered rather than shipped as a generated
  // `./typert` export, because the Typert generator only runs inside the harness workspace. Guarded,
  // since a composition without the registry must still mount the work engine.
  const typert = ctx.get('typert')
  if (typert === undefined) {
    log.warn('no typert registry mounted; the 工作 view will report it instead of reading the tree')
  } else {
    // Contained on purpose: a rejected `apply` does not roll back the whole config tree, but an
    // uncaught failure here can travel up to the startup audit (or the config hot-reload transaction)
    // and take down neighbouring plugins. A registry that surprises us on registration is not a
    // PROVEN host incompatibility (the gate already ruled that out), so warn loudly and mount the rest.
    try {
      typert.register(hostContribution)
      log.info(
        `typert host face registered (namespace avantfWork, ${
          String((hostContribution as unknown as { invocations?: readonly unknown[] }).invocations?.length ?? 0)
        } invocations: snapshot, detail, result, delete, watch)`,
      )
    } catch (error: unknown) {
      log.error(
        'typert host face FAILED to register: the 工作 view will report it instead of reading the tree; '
        + `the work engine and its tools mount anyway — ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      )
    }
  }

  // Start-up is asynchronous and awaited by the first caller that needs it; the outcome is logged on
  // both paths, since a silent failure makes "the tools exist but nothing dispatches" undiagnosable.
  // The failure must be loud but never an unhandled rejection, which dsh exits the process on.
  const ready = host.start().catch((error: unknown) => {
    log.error(`start-up FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    throw error
  })
  ctx.effect(() => () => {
    log.info('unmounting')
    void host.stop()
  }, 'avantf-work.lifecycle')

  // ── model surface ───────────────────────────────────────────────────────
  const tools = defineWorkTools(host)
  for (const tool of tools) {
    ctx.tools.register(tool)
  }
  log.info(`registered ${String(tools.length)} tools: ${tools.map((tool) => tool.name).join(', ')}`)

  // The gate's second phase: warn-only, since the plugin is mounted and a silently dropped schema or
  // tool is exactly what nothing else would report.
  if (compat !== undefined) {
    verifyRegisteredFaces({ ctx, toolNames: tools.map((tool) => tool.name), log, compat })
  }

  // ── the two tool faces ──────────────────────────────────────────────────
  // An executor's face rides the dispatch request; the OWNER side has no creation window to hook, so
  // it is applied when the agent appears, with the assembly waterfall as a backstop. Both are
  // usability, not authorization: the refusals in the tool bodies stay the boundary.
  const ownerFaces = new Map<string, () => void>()
  const applyOwnerFace = (agent: Agent): void => {
    if (ownerFaces.has(agent.id) || !host.canCreateTree(agent)) return
    const scoped = agent.ctx.get('tools')
    if (scoped === undefined) return
    const hidden = host.ownerFaceFor(agent)
    if (hidden.length === 0) return
    try {
      ownerFaces.set(agent.id, scoped.restrict({ deny: [...hidden] }))
    } catch (error: unknown) {
      // `restrict()` refuses a name it cannot see; the assembly filter still keeps it out of the schema.
      log.warn(`cannot restrict the owner face for ${agent.id}: ${String(error)}`)
      ownerFaces.set(agent.id, () => undefined)
    }
  }

  // The explicit `return undefined` is the dsh listener contract: waterfall listeners are typed
  // `undefined | Promise<undefined>`, so a `void` body is a TS2345 at the registration site.
  ctx.on('agent/created', ({ agent }) => { applyOwnerFace(agent); return undefined })
  ctx.on('agent/disposed', ({ agent }) => {
    ownerFaces.get(agent.id)?.()
    ownerFaces.delete(agent.id)
  })
  ctx.effect(() => () => {
    for (const dispose of ownerFaces.values()) dispose()
    ownerFaces.clear()
  }, 'avantf-work.tool-faces')

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined || !host.canCreateTree(agent)) return assembled
    applyOwnerFace(agent)
    return { ...assembled, tools: visibleTo(assembled.tools, OWNER_TOOL_DENY) }
  })

  // ── the routing policy: when a tree is the right shape ──────────────────
  // A static section placed with the tool guidance (`TOOL_JOBS`) because that is what it is. The
  // provider returns '' for a session that may not root a tree, and the assembler drops empty sections.
  //
  // The TEXT is the user's to edit: `work-tree-guide.md` under the SHARED family prompt directory
  // `<data home>/prompts` (the memory plugin keeps its `mem-*` files in the same place), ensured and
  // read by the generic `PromptFiles` HERE, once — an edit takes effect on the next start, which
  // keeps "what is in the prompt" the same for the whole life of the process. The section's name and
  // order stay in this file, so editing the file cannot move it in the prompt.
  // The loader AND the data-home resolution come from the BASE at runtime (the same module the
  // bootstrap loaded for the gate): fixing the shared prompt layer or a path convention takes one
  // base release, not a plugin rebuild. DEGRADATION, when the base is unavailable: the section text
  // falls back to this plugin's OWN built-in default and nothing is written to disk.
  const kit = compat?.kit
  const promptDirPath = promptDir(config.dataHome, process.env, kit?.resolveDataHome)
  const loadedPrompts = kit?.PromptFiles === undefined
    ? promptFileSpecs().map((spec) => ({
        file: spec.file,
        path: join(promptDirPath, spec.file),
        text: spec.fallback,
        source: 'default' as const,
        wrote: false,
      }))
    : new kit.PromptFiles({ dir: promptDirPath, logger: log }).load(promptFileSpecs())
  const guidanceText = buildGuidanceText(loadedPrompts)
  for (const warning of guidanceTextWarnings(guidanceText)) log.warn(`prompt text: ${warning}`)
  log.info(`prompt files: ${promptDirPath} (work-tree-guide.md${guidanceText === WORK_TREE_GUIDANCE ? ':default' : ':file'})`)
  ctx.systemPrompt.section({
    name: 'avantf:work-tree-guide',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
    text: (context) => {
      const agent = context.agent
      if (agent === undefined || !host.canCreateTree(agent)) return ''
      return guidanceText
    },
  })

  // ── what the owner's own trees are doing right now ──────────────────────
  ctx.systemPrompt.context({
    name: 'avantf:work-tree',
    order: GUIDANCE_CONTEXT_ORDER,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''
      if (!host.ownsTrees(agent)) return ''
      return host.guidanceFor(agent)
    },
  })

  // ── worker lifecycle: the earliest moment a node can be judged ──────────
  ctx.on('subagent/end', (info) => {
    host.onSubagentEnd(info.id)
  })

  // ── worker progress: what separates "slow" from "stuck" ─────────────────
  // Every durable append refreshes that node's silence window, so a long execution that keeps
  // working is never mistaken for stalled; the feed carries every session, so the host filters by claim.
  ctx.on('session/event', (session, event) => {
    host.touchWorkerProgress(session.id, event.time)
  })

  // ── the pre-step gate ───────────────────────────────────────────────────
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision

    // Only a session this plugin acts for is gated; other agents keep normal step semantics.
    if (!host.ownsTrees(agent)) return decision

    // Housekeeping first: notices would otherwise become a later turn's whole content, and at most
    // one of our wakes may stay pending — none once there is nothing left for the owner to act on.
    discardQueuedNotices(agent, host)
    const actionable = host.admitStep(agent).admit
    discardQueuedWakes(agent, host, actionable)

    // ⓪ Wake parked workers here, BEFORE every return below: the owner is the authorizing parent the
    //    continuation protocol needs and this is the one moment it is guaranteed materialized. The
    //    placement is load-bearing because bucket ② returns early on essentially every real step, so
    //    a wake after that return would never run. Only when admitted and tree-owning; a failed wake
    //    degrades to a fresh session inside the host.
    if (actionable && host.canCreateTree(agent)) await host.wakeParkedWorkers(agent)

    // ① Drop a settled worker's closing words: results travel through the tree. Filter
    //    `decision.messages`, the array the loop appends — the payload `messages` lacks the
    //    runtime-context snapshot, so rebuilding from it would silently drop the guidance.
    const kept = decision.messages.filter((message) => !isWorkerNotice(message, host))

    // ② Anything else in the batch always reaches the model; our wake is dropped as redundant,
    //    since it carries no content and something else already keeps the turn alive.
    const content = kept.filter((message) => !isOwnWake(message))
    if (content.length > 0) return { ...decision, messages: content }

    // ③ Only our own signal — or an empty batch — is left. Neither may be refused: `reject` ends the
    //    turn, so a tool-calling step would never read its own result, and the driver stops without
    //    re-reading the inbox, stranding input queued behind the signal. So: keep the signal only when
    //    the engine still has work, serve a queued message in this step, and otherwise empty the batch
    //    so the step closes without a model call.
    const admitted = actionable ? kept : []
    const queued = takeQueuedInput(agent, host)
    return queued === undefined
      ? { ...decision, messages: admitted }
      : { ...decision, messages: [...admitted, queued] }
  })

  // ── `/archive` and `/clean`: the worker logs behind the trees ─────────────
  // Workers are real sessions, so they accumulate one directory per dispatch. Archiving goes through
  // the workspace registry; removing has no harness API and is done here against the session store,
  // with the guardrails in `workerSessions.ts` — ours only, settled only, and for `all` archived only.
  const registryOf = (): ArchiveRegistry | undefined =>
    ctx.get('workspaceRegistry') as ArchiveRegistry | undefined
  const sessionDeps = {
    list: async () => {
      const query = ctx.get('sessionQuery')
      if (query === undefined) return []
      return (await query.listSessions()).map((record) => ({
        header: {
          id: String(record.header.id),
          createdAt: record.header.createdAt,
          ...record.header.origin === undefined ? {} : { origin: record.header.origin },
          ...record.header.delegationDepth === undefined ? {} : { delegationDepth: record.header.delegationDepth },
          ...record.header.parentSession === undefined ? {} : { parentSession: String(record.header.parentSession) },
        },
        live: record.live,
      }))
    },
    archive: async (id: string) => {
      const registry = registryOf()
      if (registry === undefined) throw new Error('workspace registry is not mounted')
      await registry.archiveSession(SessionId(id))
    },
    isLive: (id: string) => ctx.get('agents')?.get(SessionId(id)) !== undefined,
    sessionsRoot: config.sessionsRoot ?? join(homedir(), '.dsh', 'sessions'),
  }

  ctx.commands.register({
    name: 'archive',
    description: '归档本会话已完成的 worker 会话记录（只标记归档，不释放磁盘；释放用 /clean）。',
    handler: async ({ agent }) => {
      if (registryOf() === undefined) {
        return { kind: 'error', text: '这个部署没有挂载 workspace registry，无法归档。' }
      }
      const archivedIds = new Set((registryOf()?.archivedSessionIds ?? []).map((id) => String(id)))
      const result = await archiveWorkers(sessionDeps, agent.id, (id) => archivedIds.has(id))
      if (result.archived.length === 0) {
        return {
          kind: 'success',
          text: `没有需要归档的 work 会话（已归档或仍在运行 ${String(result.skipped.length)} 个）。`,
        }
      }
      log.info(`/archive from ${agent.id}: ${String(result.archived.length)} session(s)`)
      return {
        kind: 'success',
        text: [
          `已归档 ${String(result.archived.length)} 个 work 会话：`,
          ...result.archived.map((id) => `  ${id}`),
          '归档只是标记（不释放磁盘）。要释放磁盘请执行 /clean all。',
        ].join('\n'),
      }
    },
  })

  ctx.commands.register({
    name: 'clean',
    description: '清理 worker 会话记录以释放磁盘：all 清理所有已归档的，或给一个 worker 会话 id 只清理它。',
    input: { hint: '[all|work-xxxxxxxx]' },
    handler: async ({ agent, rawInput }) => {
      const request = rawInput.trim()
      const workers = await workerSessions(sessionDeps, agent.id)
      if (workers.length === 0) {
        return { kind: 'success', text: '本会话没有 work 会话记录。' }
      }
      const archivedIds = new Set((registryOf()?.archivedSessionIds ?? []).map((id) => String(id)))
      const target = (worker: (typeof workers)[number]): boolean => !worker.live

      if (request.length === 0) {
        // No argument is the dry run: what `/clean all` would remove, and what it skips.
        const ready = workers.filter((worker) => target(worker) && archivedIds.has(worker.id))
        const pending = workers.filter((worker) => target(worker) && !archivedIds.has(worker.id))
        return {
          kind: 'success',
          text: [
            `可清理（已归档）${String(ready.length)} 个，共 ${bytes(ready.reduce((sum, w) => sum + w.bytes, 0))}：`,
            ...ready.map((worker) => `  ${worker.id}  ${bytes(worker.bytes)}`),
            pending.length === 0
              ? ''
              : `另有 ${String(pending.length)} 个已完成但未归档，先执行 /archive 再清理（或用 /clean <id> 单独指定）。`,
            '执行 /clean all 清理上面这些；/clean <work-xxxxxxxx> 只清理一个。',
          ].filter((line) => line !== '').join('\n'),
        }
      }

      if (request === 'all') {
        const doomed = workers.filter((worker) => target(worker) && archivedIds.has(worker.id))
        if (doomed.length === 0) {
          return { kind: 'success', text: '没有已归档的 work 会话可清理（先 /archive）。' }
        }
        let freed = 0
        const removed: string[] = []
        for (const worker of doomed) {
          freed += removeWorker(worker)
          removed.push(worker.id)
        }
        log.info(`/clean all from ${agent.id}: removed ${String(removed.length)} session(s), ${bytes(freed)}`)
        return {
          kind: 'success',
          text: [
            `已清理 ${String(removed.length)} 个 work 会话，释放约 ${bytes(freed)}：`,
            ...removed.map((id) => `  ${id}`),
          ].join('\n'),
        }
      }

      const named = workers.find((worker) => worker.id === request)
      if (named === undefined) {
        return { kind: 'error', text: `${request} 不是本会话的 work 会话（用 /clean 看清单）。` }
      }
      if (named.live) {
        return { kind: 'error', text: `${request} 还在运行，不能清理。` }
      }
      const freed = removeWorker(named)
      log.info(`/clean ${named.id} from ${agent.id}: ${bytes(freed)}`)
      return { kind: 'success', text: `已清理 ${named.id}，释放约 ${bytes(freed)}。` }
    },
  })

  // ── `/work` ──────────────────────────────────────────────────────────────
  ctx.commands.register({
    name: 'work',
    // 面向使用者（命令面板是中文界面），所以这条描述也用中文；`hint` 保持英文占位符
    // 的形状 —— 它是待填的参数，不是说明文字。
    description: '列出本会话拥有的工作；命令后面跟文本时，用这段文本建一个根工作。',
    input: { hint: '[工作描述]' },
    handler: async ({ agent, rawInput }) => {
      // The registry hands back the text after the command name INCLUDING its whitespace.
      const request = rawInput.trim()

      if (request.length === 0) {
        const text = host.describe(agent)
        log.info(`/work (list) from ${agent.id}`)
        return { kind: 'success', text }
      }

      if (request === 'list' || request === 'ls') {
        log.info(`/work (list) from ${agent.id}`)
        return { kind: 'success', text: host.describe(agent) }
      }

      // First line names the root; the rest, if any, is its description. A root created here carries
      // no owner analysis, and the first executor is told exactly that by the prompt it receives.
      const [firstLine = '', ...rest] = request.split('\n')
      const title = firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine
      const description = rest.length > 0 ? request : firstLine

      const result = await host.createWork(agent, title, description, [])
      if (!result.ok) {
        log.warn(`/work create refused for ${agent.id}: ${result.code} — ${result.message}`)
        return { kind: 'error', text: `创建工作失败（${result.code}）：${result.message}` }
      }
      const rootId = result.value.id
      log.info(`/work (create) from ${agent.id}: root ${rootId} "${title}"`)
      return {
        kind: 'success',
        text: `已创建工作 [${rootId}]「${title}」。引擎已开始派活；用 /work 看进度。`,
      }
    },
  })

  log.info(
    `mounted: /work command, ${String(tools.length)} tools (/archive, /clean), guidance context, pre-step gate`,
  )

  host.markReady(ready)
}

export { defineWorkTools } from './tools.js'
export { AvantfWorkHost } from './host.js'
