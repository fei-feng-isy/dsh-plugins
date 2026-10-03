/**
 * `@avantf/dsh-mission` — the DSH-side half of the mission-tree engine: a host service owning the tree,
 * storage and dispatch loop, the owner's tool surface, a guidance context, and a pre-step hook that
 * decides what a proposed step carries to the model.
 *
 * The hook makes wake-ups free by emptying the batch when there is nothing to act on (an empty batch
 * opens no step). It must never REFUSE the step: that ends the turn and would cut a tool-calling
 * step off from its own result.
 *
 * @module @avantf/dsh-mission
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
import { AvantfMissionHost, type OrphanTreeReport, type OwnerProbe } from './host.js'
import { isOutputEvent } from './workerEvents.js'
import { defineWorkTools } from './tools.js'
import {
  GUIDANCE_CONTEXT_ORDER,
  MISSION_TREE_GUIDANCE,
  PROMPT_NAMESPACE,
  buildGuidanceText,
  guidanceTextWarnings,
  promptDir,
  promptFileSpecs,
} from './prompt.js'
import { OWNER_TOOL_DENY, visibleTo } from './faces.js'
import {
  archiveWorkers,
  bytes,
  cleanWorkers,
  foreignWorkerIds,
  ghostArchiveIds,
  reconcileArchivedGhosts,
  workerRetention,
  workerSessions,
  type ArchiveRegistry,
  type GhostReconcile,
  type SessionCorpus,
  type StoredSession,
  type WorkerCleanup,
  type WorkerSession,
} from './workerSessions.js'
import { listProjectionCacheIds } from './projectionCache.js'
import { isWorkerClaimId } from './claims.js'
import { descriptors, hostContribution, SNAPSHOT_WIRE_VERSION } from './wire.js'
import { OWN_WAKE_SOURCE_KIND } from './source.js'
import { createLogger } from './log.js'
import { resolveWellFormed } from './wellformed.js'
import {
  loadCompat,
  provision,
  registerCompatMegaphone,
  verifyRegisteredFaces,
} from './envinit.js'

export const name = 'avantf-mission'

// A title is one line by convention (the mission chain renders one per ancestor), so a pasted paragraph must not become one.
const TITLE_MAX = 80

/**
 * How many SETTLED worker sessions automatic retention keeps per owner session: newest by
 * `header.createdAt` first, live workers not counted. `0` (or a negative value) turns the automatic
 * policy off — "keep all", never "keep none"; `/clean archive all` is the manual full clean.
 */
const DEFAULT_KEEP_WORKERS = 10

/** Why a tree counts as an orphan, as `/clean orphans` groups and renders it: the operator reads the
 *  difference between a session that is GONE (reconciled automatically) and a host that cannot answer
 *  (waiting on a person) in this one string. */
function orphanReason(probe: OwnerProbe): string {
  if (probe.kind === 'missing') return '不存在（owner 会话确实不存在）'
  if (probe.kind === 'unobservable') return `不可观测：${probe.detail}`
  return 'owner 会话存在'
}

/**
 * `$DSH_HOME` when the host set it, `~/.dsh` otherwise — the rule the launcher, `scripts/link-profile.mjs`
 * and `scripts/workspace-doctor.mjs` already apply.
 *
 * DSH Desktop is why this is not simply `homedir()`: it runs the profile with `DSH_HOME` pointing at
 * the user's harness home (usually `<home>/.dsh`, but a configured location is the norm there), and a
 * session store read from the WRONG root is not an error — `/archive` and `/clean` would simply never
 * find one of this plugin's own workers, or look at a tree that belongs to another installation.
 */
function dshHome(): string {
  const configured = process.env['DSH_HOME']?.trim()
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
}

// Every service this plugin needs, gating `apply`: subagents (mission units), storageDomain (the tree),
// systemPrompt (guidance), tools (model surface), agents (liveness), commands (`/mission`).
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
  /** Slot ceiling on the NUMBER of concurrent units; omitted means "CPU cores minus one". Capacity is
   *  the master gate: a dispatch needs BOTH room in capacity and a free slot. */
  maxConcurrent?: number
  /** Capacity gate in cores-equivalent. Omitted means "derive from this machine"
   *  (`os.availableParallelism()` → `os.cpus().length` → 4, minus one reserved core, clamped 1..64);
   *  an explicit value is used as given. */
  capacity?: number
  /** How long a node may be repeatedly deferred by the capacity gate before it reserves the machine
   *  (no new admissions until it fits); default 5 min, floor 1 min. */
  capacityWaitMs?: number
  /** Free-memory floor in bytes: below it dispatch is DEFERRED (never refused). Default 256 MiB;
   *  `0` disables the gate. */
  minFreeMemoryBytes?: number
  /** How long a worker may produce NOTHING before it is treated as stuck (default 30 min, floor
   * 1 min), measured from its last real output so a legitimately long step does not count as no
   * progress. Transport-layer noise (provider retries, route snapshots) does not refresh it. */
  staleMs?: number
  /** Wall-clock ceiling on one dispatch round (default 1 hour, floor 10 min or `staleMs`, whichever
   * is larger). Past it the node is reclaimed as `hung` — alive but unproductive — no matter how many
   * events refreshed its timestamps; a smaller value is raised to the floor with a warning. */
  roundMs?: number
  /** Root of the session store `/archive` and `/clean` act on (default `<dsh home>/sessions`); only a
   * directory directly under it named exactly a session id is ever touched, so a wrong value removes nothing. */
  sessionsRoot?: string
  /** Root of the host's projection-cache record directory `/clean` prunes alongside a released
   *  session (default `<dsh home>/storages/session_projcache/sessions`). Only a file named exactly
   *  `mission-<8 hex>.json` is ever touched, so a wrong value removes nothing. */
  projectionCacheRoot?: string
  /** How many SETTLED (finished) worker sessions to keep per owner session; older ones are released
   *  automatically at mount and on every sweep. Default 10. Live workers never count against it and
   *  are never released. `0` disables automatic retention entirely (keep everything); it does NOT
   *  mean "keep none" — the manual `/clean archive all` is what releases every settled worker. */
  keepWorkers?: number
  /** The avantf data home (default `$AVANTF_HOME`, else `~/.avantf`). Only its `prompts/` subdirectory
   * is used — the shared directory holding every avantf plugin's editable system-prompt text. */
  dataHome?: string
}

export const Config: z<Config> = z.object({
  maxConcurrent: z.natural(),
  capacity: z.natural(),
  capacityWaitMs: z.natural(),
  minFreeMemoryBytes: z.natural(),
  staleMs: z.natural(),
  roundMs: z.natural(),
  sessionsRoot: z.string(),
  projectionCacheRoot: z.string(),
  keepWorkers: z.natural(),
  dataHome: z.string(),
})

// Re-exported for readability: a second definition here would drift from the one the host applies.
export { WORKER_TOOL_DENY } from './faces.js'

/** This plugin's own wake signal: a trigger to open a turn, never content. */
function isOwnWake(message: UserMessage): boolean {
  const source = message.source as { kind?: string; plugin?: string }
  // The released `plugin` wrapper is still recognized: a session written under an older host keeps
  // that shape until the V3→V4 migration rewrites it, and a plugin update must not read its own
  // pending wake as someone else's user text in the meantime.
  return source.kind === OWN_WAKE_SOURCE_KIND
    || (source.kind === 'plugin' && source.plugin === name)
}

// Results travel through the tree, so the worker's own closing words are dropped; only our workers qualify.
function isWorkerNotice(message: UserMessage, host: AvantfMissionHost): boolean {
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
function discardQueuedNotices(agent: Agent, host: AvantfMissionHost): void {
  const inbox = pendingInboxOf(agent)
  if (inbox === undefined) return
  for (const message of [...inbox.nextStep, ...inbox.nextTurn]) {
    if (isWorkerNotice(message, host)) inbox.remove(message.id)
  }
}

// A wake is a trigger, never content, so exactly one is enough to open the turn that reads the
// guidance; more would only open a turn that gets emptied again. `keepOne: false` (nothing
// actionable) drops every queued wake, since the guidance will say it all again anyway.
function discardQueuedWakes(agent: Agent, _host: AvantfMissionHost, keepOne: boolean): void {
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
function takeQueuedInput(agent: Agent, host: AvantfMissionHost): UserMessage | undefined {
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

  // The family's well-formed repair, taken off the base module the bootstrap loaded. The judgement
  // is "does the loaded kit carry the two functions" (interface v2), NOT "which generation is it":
  // a base that lacks them (absent, or older than v2) degrades to the core's local copy and the
  // plugin still mounts in full — never a refusal, and never a degradation of the MOUNT.
  const wellFormed = resolveWellFormed(compat?.kit)

  // Publishes itself from its `Service` base under the plugin's own scope, so it leaves with the fiber.
  const host = new AvantfMissionHost(ctx, config, log, wellFormed)

  // The host face of this plugin's Remote namespace: registered rather than shipped as a generated
  // `./typert` export, because the Typert generator only runs inside the harness workspace. Guarded,
  // since a composition without the registry must still mount the mission engine.
  const typert = ctx.get('typert')
  if (typert === undefined) {
    log.warn('no typert registry mounted; the 任务 view will report it instead of reading the tree')
  } else {
    // Contained on purpose: a rejected `apply` does not roll back the whole config tree, but an
    // uncaught failure here can travel up to the startup audit (or the config hot-reload transaction)
    // and take down neighbouring plugins. A registry that surprises us on registration is not a
    // PROVEN host incompatibility (the gate already ruled that out), so warn loudly and mount the rest.
    try {
      typert.register(hostContribution)
      log.info(
        `typert host face registered (namespace avantfMission, ${
          String((hostContribution as unknown as { invocations?: readonly unknown[] }).invocations?.length ?? 0)
        } invocations: snapshot, detail, result, delete, cleanFinished, resolveExecutorSession, watch)`,
      )
      // One line that settles "which half is stale?" without a debugger: the two halves of this plugin
      // update on different schedules (the browser bundle per page load, this face only when `dsh web`
      // starts), and a client that asks for a method this process never published gets an HTTP 404 that
      // reads like a missing mission. Log the revision, the METHOD SET actually published, and the
      // module the host loaded — so a mismatch is answered by the terminal, not by a bisect.
      log.info(
        `typert host face: wire ${String(SNAPSHOT_WIRE_VERSION)}, `
        + `${String(descriptors.length)} methods (${descriptors.map(descriptor => descriptor.method).join(', ')}); `
        + `module ${import.meta.url}`,
      )
    } catch (error: unknown) {
      log.error(
        'typert host face FAILED to register: the 任务 view will report it instead of reading the tree; '
        + `the mission engine and its tools mount anyway — ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      )
    }
  }

  // Start-up is asynchronous and awaited by the first caller that needs it. `host.start()` NEVER
  // rejects (see its own doc): a storage failure is absorbed there into a DEGRADED mount — one loud
  // ERROR naming the cause, the tools answering the reason, the process untouched. Awaiting it here
  // or re-throwing would be an unhandled rejection (a process-level fatal on every generation) or a
  // failed plugin row; both are the outcomes this mount exists to avoid.
  const ready = host.start()
  ctx.effect(() => () => {
    log.info('unmounting')
    void host.stop()
  }, 'avantf-mission.lifecycle')

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
  }, 'avantf-mission.tool-faces')

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
  // The TEXT is the user's to edit: `mission-tree-guide.md` under the SHARED family prompt directory
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
    : new kit.PromptFiles({ dir: promptDirPath, logger: log, namespace: PROMPT_NAMESPACE }).load(promptFileSpecs())
  const guidanceText = buildGuidanceText(loadedPrompts)
  for (const warning of guidanceTextWarnings(guidanceText)) log.warn(`prompt text: ${warning}`)
  log.info(`prompt files: ${promptDirPath} (mission-tree-guide.md${guidanceText === MISSION_TREE_GUIDANCE ? ':default' : ':file'})`)
  ctx.systemPrompt.section({
    name: 'avantf:mission-tree-guide',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
    text: (context) => {
      const agent = context.agent
      if (agent === undefined || !host.canCreateTree(agent)) return ''
      return guidanceText
    },
  })

  // ── what the owner's own trees are doing right now ──────────────────────
  ctx.systemPrompt.context({
    name: 'avantf:mission-tree',
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
  // Every durable append records that the worker was HEARD FROM, but only real output (model
  // output, a tool call, a tool result — see `workerEvents.ts`) refreshes the silence window, so a
  // provider that only retries can no longer keep a stuck worker looking alive. The feed carries
  // every session, so the host filters by claim.
  ctx.on('session/event', (session, event) => {
    host.touchWorkerProgress(session.id, event.time, isOutputEvent(event))
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
    //    the engine still has mission, serve a queued message in this step, and otherwise empty the batch
    //    so the step closes without a model call.
    const admitted = actionable ? kept : []
    const queued = takeQueuedInput(agent, host)
    return queued === undefined
      ? { ...decision, messages: admitted }
      : { ...decision, messages: [...admitted, queued] }
  })

  // ── `/archive` and `/clean`: worker logs and orphan trees ────────────────
  // Workers are real sessions, so they accumulate one directory per dispatch. Archiving goes through
  // the workspace registry; removing has no harness API and is done here against the session store,
  // with the guardrails in `workerSessions.ts` — ours only, settled only, and ARCHIVE BEFORE REMOVE:
  // `/clean archive` archives a settled worker and only then deletes it, in one pass, so a person does
  // not have to run `/archive` first. A live worker is never interrupted and another session's worker
  // is never touched. Orphan trees are the other scope: their owner session is gone or unobservable,
  // which is the one case where this command may touch a tree belonging to another session.
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
    // Step 3 of the cleanup lifecycle: lift the marker once the record is gone. Best-effort by
    // construction — `cleanWorkers` reports a rejection instead of undoing the deletion.
    unarchive: async (id: string) => {
      const registry = registryOf()
      if (registry === undefined) throw new Error('workspace registry is not mounted')
      if (registry.unarchiveSession === undefined) throw new Error('workspace registry has no unarchiveSession')
      await registry.unarchiveSession(SessionId(id))
    },
    isLive: (id: string) => ctx.get('agents')?.get(SessionId(id)) !== undefined,
    sessionsRoot: config.sessionsRoot ?? join(dshHome(), 'sessions'),
    // The host keeps a disposed session's projection checkpoint (and exposes no eviction API), so a
    // released worker still reads back as a subagent until this file is gone. Same derivation as the
    // host's storage root; a wrong value can only fail to delete, never delete the wrong thing.
    projectionCacheRoot: config.projectionCacheRoot
      ?? join(dshHome(), 'storages', 'session_projcache', 'sessions'),
  }

  // Automatic retention: keep the newest N settled workers PER OWNER SESSION. `0` (or a negative
  // configured value) disables the policy; it never means "keep none" (see `DEFAULT_KEEP_WORKERS`).
  const keepWorkers = config.keepWorkers ?? DEFAULT_KEEP_WORKERS

  /** The ids the workspace registry reports as archived; empty without a registry. */
  const archivedIds = (): ReadonlySet<string> =>
    new Set((registryOf()?.archivedSessionIds ?? []).map((id) => String(id)))

  /**
   * The live-preferred session corpus, for the ghost pass. `readable: false` when there is no
   * session query at all: absence must be PROVEN before an archive marker is lifted, so an
   * unaskable corpus reconciles nothing rather than treating "no answer" as "no record".
   */
  const sessionCorpus = async (): Promise<SessionCorpus> => {
    if (ctx.get('sessionQuery') === undefined) return { readable: false, known: new Set() }
    const records = await sessionDeps.list()
    return { readable: true, known: new Set(records.map((record) => record.header.id)) }
  }

  /** Ghost markers to show in a read-only listing; empty without a registry or anything archived. */
  const listedGhosts = async (archived: ReadonlySet<string>): Promise<readonly string[]> => {
    if (![...archived].some((id) => isWorkerClaimId(id))) return []
    const corpus = await sessionCorpus()
    if (!corpus.readable) return []
    return ghostArchiveIds(archived, corpus.known, sessionDeps.sessionsRoot)
  }

  /**
   * The one-shot reconciliation of what older cleanups left behind. Two layers, one pass:
   *
   *  - **projection-cache residue** — the pass's PRIMARY input is the cache directory itself, not
   *    the archive set. `/clean` now unarchives after releasing a record, so the archive set can be
   *    empty while residue persists; enumerating the cache directory and asking "is the record
   *    proven gone?" (corpus AND sessions root both silent) is what actually clears the invisible
   *    workers. Registry-independent, so it runs even without a workspace registry.
   *  - **ghost archive markers** — archived, mission-shaped ids whose records are gone, lifted via
   *    the host's idempotent `unarchiveSession` when a registry provides it.
   *
   * Runs once at mount and again inside `/clean archive all`. Never throws (the mount call wraps it
   * anyway); every failure is reported, never fatal.
   */
  const reconcileGhosts = async (): Promise<GhostReconcile> => {
    const registry = registryOf()
    const archived = archivedIds()
    const markers = [...archived].some((id) => isWorkerClaimId(id))
    const canUnarchive = registry !== undefined && registry.unarchiveSession !== undefined
    const residue = listProjectionCacheIds(sessionDeps.projectionCacheRoot)
    // NOTHING to consider (no residue file, no mission-shaped archive marker): do not read the
    // session corpus at all. An ordinary mount must keep its zero-session-read cost — only a mount
    // that actually has something to reconcile pays for the proof of absence.
    if (residue.length === 0 && !markers) {
      return { released: [], failed: [], purged: [], purgeFailures: [], supported: canUnarchive, readable: true }
    }
    if (registry !== undefined && markers && !canUnarchive) {
      log.warn('workspace registry has no unarchiveSession; archived ids whose records are gone '
        + 'cannot be reconciled and will keep showing in the subagent list')
    }
    const corpus = await sessionCorpus()
    // Without a usable unarchive API the marker half is skipped, but the residue purge still runs:
    // proving a record gone needs no archive marker, only the corpus and the sessions root.
    const result = await reconcileArchivedGhosts(sessionDeps, canUnarchive ? archived : new Set(), corpus)
    if (result.released.length > 0) {
      log.info(`ghost archive reconciliation: released ${String(result.released.length)} id(s): `
        + result.released.join(', '))
    }
    for (const failure of result.failed) {
      log.warn(`ghost archive reconciliation failed for ${failure.id}: ${failure.reason}`)
    }
    if (result.purged.length > 0) {
      log.info(`projection-cache residue: removed ${String(result.purged.length)} file(s): `
        + result.purged.join(', '))
    }
    for (const failure of result.purgeFailures) {
      log.warn(`projection-cache residue removal failed for ${failure.id}: ${failure.reason}`)
    }
    // Only warn when something WOULD have been considered: a silent, residue-free headless mount
    // should not print a "skipped" line on every start.
    if (!result.readable && (markers || listProjectionCacheIds(sessionDeps.projectionCacheRoot).length > 0)) {
      log.warn('worker residue reconciliation skipped: no sessionQuery, so absence cannot be proven')
    }
    return result
  }

  /** No registry means no archive marker, and no archive marker means no release: said out loud. */
  const NO_REGISTRY = '这个部署没有挂载 workspace registry，无法归档 ⇒ 无法清理。'

  /**
   * Automatic retention for ONE owner session: keep the newest `keepWorkers` SETTLED worker sessions
   * and release the rest through the same archive → delete → unarchive → projection-cache purge
   * pipeline `/clean archive` uses (`cleanWorkers` with `retain`). Live workers are excluded from the
   * count and never touched. Best-effort by construction: every failure is a warning, and the caller
   * (mount or sweep) is never affected. `undefined` when the policy is off or nothing can be archived.
   */
  const retainWorkersFor = async (ownerId: string, all?: readonly StoredSession[]): Promise<WorkerCleanup | undefined> => {
    if (keepWorkers <= 0 || registryOf() === undefined) return undefined
    try {
      const result = await cleanWorkers(sessionDeps, ownerId, (id) => archivedIds().has(id), {
        retain: keepWorkers,
        ...all === undefined ? {} : { all },
        // The decision needs no sizes, and the sessions this pass KEEPS must not be walked at all:
        // only what is actually released is measured (see `cleanWorkers`).
        measureBytes: false,
      })
      if (result.cleaned.length > 0) {
        log.info(
          `retention: ${ownerId} kept the newest ${String(keepWorkers)} settled worker(s), `
          + `released ${String(result.cleaned.length)}: ${result.cleaned.map((entry) => entry.id).join(', ')}`,
        )
      }
      for (const failure of result.refused) {
        log.warn(`retention: ${failure.id} kept, archive failed — ${failure.reason}`)
      }
      for (const failure of result.unarchiveFailures) {
        log.warn(`retention: ${failure.id} released, but unarchive failed — ${failure.reason}`)
      }
      for (const failure of result.purgeFailures) {
        log.warn(`retention: ${failure.id} released, but projection cache purge failed — ${failure.reason}`)
      }
      return result
    } catch (error: unknown) {
      log.warn(`retention pass for ${ownerId} failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * The automatic retention pass over EVERY owner session the task library knows about.
   *
   * THREE gates keep it off the hot path, because it used to be the heaviest periodic IO this plugin
   * does — one full `listSessions` per owner, per sweep (60 s tick AND every `subagent/end`):
   *
   *  - **one listing** — sessions are listed ONCE and the same corpus is handed to every owner, so
   *    the cost stops scaling with owner count;
   *  - **only after a settlement** — `host.workerSettlementCount` is monotonic and the pass skips a
   *    sweep entirely when no worker settled since it last ran (the mount pass runs unconditionally,
   *    since a restart resets the counter and may have old records to release);
   *  - **debounced** — a burst of workers settling together coalesces into one pass.
   *
   * An OVERDUE run (nothing for {@link RETENTION_MAX_QUIET_MS}) is the backstop: a host that never
   * emits `subagent/end` would otherwise never settle, and a worker that settled without that event
   * would never be seen. Ten minutes of quiet costs one listing.
   *
   * Each owner is handled independently — one owner's failure never stops another's pass — and the
   * deferred run catches its own rejection, since nothing awaits a timer callback.
   */
  const RETENTION_DEBOUNCE_MS = 2_000
  const RETENTION_MAX_QUIET_MS = 10 * 60_000
  let retentionTimer: ReturnType<typeof setTimeout> | undefined
  let retentionRunning = false
  let retentionPending = false
  let retentionSeenSettlements = 0
  let retentionLastRunAt = Date.now()
  /** The mount pass must run even with zero settlements; later passes are settlement-gated. */
  let retentionForce = true

  const runRetention = async (): Promise<void> => {
    if (retentionRunning) {
      retentionPending = true
      return
    }
    retentionRunning = true
    retentionLastRunAt = Date.now()
    try {
      const owners = host.ownerSessionIds()
      if (owners.length === 0) return
      const all = await sessionDeps.list()
      for (const ownerId of owners) await retainWorkersFor(ownerId, all)
    } finally {
      retentionRunning = false
      if (retentionPending) {
        retentionPending = false
        scheduleRetention()
      }
    }
  }

  function scheduleRetention(): void {
    if (retentionTimer !== undefined) return
    retentionTimer = setTimeout(() => {
      retentionTimer = undefined
      void runRetention().catch((error: unknown) => {
        log.warn(`retention pass failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, RETENTION_DEBOUNCE_MS)
  }

  const retentionPass = (): void => {
    if (keepWorkers <= 0) return
    const settled = host.workerSettlementCount
    const overdue = Date.now() - retentionLastRunAt >= RETENTION_MAX_QUIET_MS
    if (!retentionForce && !overdue && settled === retentionSeenSettlements) return
    retentionForce = false
    retentionSeenSettlements = settled
    scheduleRetention()
  }

  // The sweep half of the trigger pair. Registered here (after the pass is defined); the interval
  // armed by `host.start()` fires well after mount.
  host.onSweep(retentionPass)

  /** The `archive` scope as a read-only listing: what a cleanup pass would free, and what it would skip. */
  const archiveScopeLines = (
    workers: readonly WorkerSession[],
    archived: ReadonlySet<string>,
    listing: { readonly archivable: boolean; readonly foreign: readonly string[]; readonly ghosts: readonly string[] },
  ): string[] => {
    // The retention picture is shown SEPARATELY from the manual scope: "what automatic retention
    // would release" and "what /clean archive all would release" are two different numbers, and a
    // person staring at a list that stops at N has to be able to see why it stops there.
    const retention = workerRetention(workers, keepWorkers)
    const ready = retention.settled
    const running = retention.live
    return [
      ...(retention.enabled
        ? [
            `保留策略：每属主会话保留最新 ${String(keepWorkers)} 个已完成 worker（先归档 → 再释放 → 最后取消归档；live 不计入名额、永不清理）。`,
            `已完成 worker：${String(ready.length)} 个（保留最新 ${String(keepWorkers)} → 可自动清理 ${String(retention.releasable.length)} 个）`,
          ]
        : ['保留策略已关闭（keepWorkers=0）：不按数量自动释放；要全清用 /clean archive all。']),
      `正在执行：${String(running.length)} 个（不计入保留名额、不会被清理）`,
      `手动 /clean archive all 可清理（本会话全部已完成）${String(ready.length)} 个，共 ${bytes(ready.reduce((sum, worker) => sum + worker.bytes, 0))}：`,
      ...ready.map((worker) =>
        `  ${worker.id}  ${bytes(worker.bytes)}  （${archived.has(worker.id) ? '已归档，记录仍在' : '已完成未归档，清理时先归档'}）`),
      // A separate class, not a worker: the record is GONE, only the archive marker survives. Shown
      // apart from "已完成未归档" because the action differs — nothing to delete, only to reconcile.
      ...(listing.ghosts.length === 0
        ? []
        : [
            `已归档但记录已不在（幽灵）${String(listing.ghosts.length)} 个（会话记录已释放，只剩归档标记；`
            + '/clean archive all 或下次挂载会取消归档）：',
            ...listing.ghosts.map((id) => `  ${id}`),
          ]),
      ...(running.length === 0
        ? []
        : [`因仍在运行跳过 ${String(running.length)} 个：`, ...running.map((worker) => `  ${worker.id}`)]),
      ...(listing.foreign.length === 0
        ? []
        : [`不属于本会话跳过 ${String(listing.foreign.length)} 个：`, ...listing.foreign.map((id) => `  ${id}`)]),
      ...(listing.archivable ? [] : [NO_REGISTRY]),
      '清理是三步：标记归档 → 释放记录 → 取消归档。执行 /clean archive all 一趟完成；'
      + '/clean archive <mission-xxxxxxxx> 只清理一个。',
    ]
  }

  /** What one cleanup pass did, in the buckets the guardrails produce. */
  const cleanupScopeLines = (result: WorkerCleanup): string[] => {
    const lines: string[] = []
    if (result.cleaned.length > 0) {
      const freed = result.cleaned.reduce((sum, entry) => sum + entry.freed, 0)
      lines.push(`已归档并清理 ${String(result.cleaned.length)} 个 mission 会话，释放约 ${bytes(freed)}：`)
      for (const entry of result.cleaned) {
        lines.push(`  ${entry.id}  ${bytes(entry.freed)}  （${entry.archivedNow ? '本次归档' : '原本已归档'}）`)
      }
    }
    if (result.unarchiveFailures.length > 0) {
      // The deletion stands: the files are gone, so only the marker outlived them.
      lines.push(`已删除但取消归档失败 ${String(result.unarchiveFailures.length)} 个`
        + '（记录已释放，归档标记会留到下次挂载对账）：')
      for (const entry of result.unarchiveFailures) lines.push(`  ${entry.id}：${entry.reason}`)
    }
    if (result.refused.length > 0) {
      lines.push(`归档失败，记录保留 ${String(result.refused.length)} 个：`)
      for (const entry of result.refused) lines.push(`  ${entry.id}：${entry.reason}`)
    }
    if (result.running.length > 0) {
      lines.push(`因仍在运行跳过 ${String(result.running.length)} 个：`, ...result.running.map((id) => `  ${id}`))
    }
    if (result.foreign.length > 0) {
      lines.push(`不属于本会话跳过 ${String(result.foreign.length)} 个：`, ...result.foreign.map((id) => `  ${id}`))
    }
    return lines
  }

  /** What the ghost reconcile pass found, as an output section: absent when it released nothing. */
  const ghostScopeLines = (result: GhostReconcile): string[] => {
    if (result.released.length === 0) return []
    return [
      `对账清理了 ${String(result.released.length)} 个幽灵 id（已归档但记录已不存在）：`,
      ...result.released.map((id) => `  ${id}`),
    ]
  }

  /**
   * Projection-cache residue removed, as its own section with its own count — reported SEPARATELY
   * from the released records, because the two are different layers and a person reading "released
   * N" must be able to see that the layer below it was cleared too.
   */
  const purgeScopeLines = (purged: readonly string[]): string[] => {
    if (purged.length === 0) return []
    return [
      `清理残留投影缓存 ${String(purged.length)} 个（宿主保留已释放会话的投影缓存且无驱逐 API，释放记录时一并删除）：`,
      ...purged.map((id) => `  ${id}`),
    ]
  }

  /**
   * The `missions` scope, read-only: the CLOSED trees a batch pass would delete, and the trees that
   * are skipped because they were never retired through `finish_mission`. This is the boundary the
   * operator has to see: a task TREE (this plugin's record) is a different thing from the worker
   * SESSION logs `/clean archive` releases, and only a closed tree is a batch-clean candidate.
   */
  const missionsListLines = (finished: readonly string[], ongoing: readonly string[]): string[] => {
    const lines: string[] = []
    if (finished.length === 0) {
      lines.push(ongoing.length === 0
        ? '没有可清理的已完成任务。'
        : `没有可清理的已完成任务（跳过 ${String(ongoing.length)} 棵仍在进行）。`)
    } else {
      lines.push(`可清理的已完成任务 ${String(finished.length)} 棵：`)
      for (const id of finished) lines.push(`  ${id}`)
      lines.push('执行 /clean missions all 清理上面这些（只删本会话已关闭的任务树，不动 worker 会话记录）。')
    }
    if (ongoing.length > 0) {
      lines.push(`未收尾跳过 ${String(ongoing.length)} 棵（仍在进行或尚未 finish_mission）：`)
      for (const id of ongoing) lines.push(`  ${id}`)
    }
    return lines
  }

  /** What one `/clean missions all` pass did, in the two buckets the guardrails produce. */
  const missionsCleanupLines = (deleted: readonly string[], skipped: readonly string[]): string[] => {
    const lines: string[] = []
    if (deleted.length === 0) {
      lines.push(skipped.length === 0
        ? '没有可清理的已完成任务。'
        : `没有可清理的已完成任务（跳过 ${String(skipped.length)} 棵仍在进行）。`)
    } else {
      lines.push(`已清理 ${String(deleted.length)} 棵已完成任务（跳过 ${String(skipped.length)} 棵仍在进行）：`)
      for (const id of deleted) lines.push(`  ${id}`)
    }
    if (skipped.length > 0) {
      lines.push(`未收尾跳过 ${String(skipped.length)} 棵（仍在进行或尚未 finish_mission）：`)
      for (const id of skipped) lines.push(`  ${id}`)
    }
    return lines
  }

  /** The `orphans` scope as a read-only listing, grouped by the reason each probe came back with. */
  const orphanScopeLines = (orphans: readonly OrphanTreeReport[]): string[] => {
    const groups = new Map<string, OrphanTreeReport[]>()
    for (const entry of orphans) {
      const reason = orphanReason(entry.probe)
      groups.set(reason, [...(groups.get(reason) ?? []), entry])
    }
    const lines = [`孤儿任务树 ${String(orphans.length)} 棵（按原因分组）：`]
    for (const [reason, entries] of groups) {
      lines.push(`  ${reason}（${String(entries.length)} 棵）：`)
      for (const entry of entries) {
        const state = entry.closedAt === null ? '未收尾' : '已归档'
        const created = new Date(entry.createdAt).toISOString()
        const closed = entry.closedAt === null ? '' : ` · 闭合 ${new Date(entry.closedAt).toISOString()}`
        lines.push(`    ${entry.rootId} · ${state} · 创建 ${created}${closed} · ${reason}`)
      }
    }
    lines.push('执行 /clean orphans all 清理上面这些；/clean orphans <root-xxxxxxxx> 只清理一棵。')
    return lines
  }

  /** Delete the named trees, re-probing each owner FIRST: a listing is a report, never authorization.
   *  A tree whose session came back — or that is already gone — is skipped, and the reply says so. */
  const removeOrphanTrees = async (
    callerId: string,
    rootIds: readonly string[],
  ) => {
    const removed: OrphanTreeReport[] = []
    const skipped: string[] = []
    for (const rootId of rootIds) {
      const report = await host.probeOrphanTree(rootId)
      if (report === undefined) {
        skipped.push(`${rootId}（任务树已不存在）`)
        continue
      }
      if (report.probe.kind === 'exists') {
        skipped.push(`${rootId}（owner 会话已可观测，跳过）`)
        continue
      }
      await host.destroyOrphanTree(rootId)
      removed.push(report)
    }
    const count = (kind: OwnerProbe['kind']): number =>
      removed.filter((entry) => entry.probe.kind === kind).length
    // Audit trail: who asked, how many went, and by which verdict — the only record of a destructive
    // act that leaves no session log behind. The skipped list is what goes after `skipped`: it used to
    // print `removed`'s ids there, so the one durable record of the act named the wrong trees.
    log.info(
      `/clean orphans from ${callerId}: removed ${String(removed.length)} tree(s) `
      + `(missing: ${String(count('missing'))}, unobservable: ${String(count('unobservable'))}), `
      + `skipped ${String(skipped.length)}: ${skipped.join(', ')}`,
    )
    if (removed.length === 0) {
      return {
        kind: 'error' as const,
        text: ['没有删除任何任务树：', ...skipped.map((line) => `  ${line}`)].join('\n'),
      }
    }
    return {
      kind: 'success' as const,
      text: [
        `已清理 ${String(removed.length)} 棵孤儿任务树（不存在 ${String(count('missing'))}、`
        + `不可观测 ${String(count('unobservable'))}）：`,
        ...removed.map((entry) => `  ${entry.rootId}`),
        ...(skipped.length === 0 ? [] : [`跳过 ${String(skipped.length)} 棵：`, ...skipped.map((line) => `  ${line}`)]),
      ].join('\n'),
    }
  }

  ctx.commands.register({
    name: 'archive',
    description: '归档本会话已完成的 worker 会话记录（只标记归档，不释放磁盘；释放用 /clean archive）。',
    handler: async ({ agent }) => {
      if (registryOf() === undefined) {
        return { kind: 'error', text: '这个部署没有挂载 workspace registry，无法归档。' }
      }
      const archived = archivedIds()
      const result = await archiveWorkers(sessionDeps, agent.id, (id) => archived.has(id))
      if (result.archived.length === 0) {
        return {
          kind: 'success',
          text: `没有需要归档的 mission 会话（已归档或仍在运行 ${String(result.skipped.length)} 个）。`,
        }
      }
      log.info(`/archive from ${agent.id}: ${String(result.archived.length)} session(s)`)
      return {
        kind: 'success',
        text: [
          `已归档 ${String(result.archived.length)} 个 mission 会话：`,
          ...result.archived.map((id) => `  ${id}`),
          '归档只是标记（不释放磁盘）。要释放磁盘请执行 /clean archive all。',
        ].join('\n'),
      }
    },
  })

  ctx.commands.register({
    name: 'clean',
    // The three scopes are the command's whole grammar, so the description names all of them and
    // states the rule that is easy to get wrong: no argument only LISTS; deleting needs a scope AND
    // a target.
    description: '清理 worker 会话记录、已完成任务或孤儿记录：archive 作用域清理本会话已完成的 worker 会话记录'
      + '（先归档、再释放、最后取消归档，三步一趟完成；运行中的永不触碰）；'
      + 'missions 作用域删除本会话已关闭（finish_mission 收尾）的已完成任务记录，只删任务记录、不动 worker 会话记录，用 all 一次清掉；'
      + 'orphans 作用域针对 owner 会话已不存在或不可观测的孤儿记录。'
      + '无参只列不删；删除必须同时给作用域与目标（archive/orphans 接受 all 或具体 id，missions 只接受 all）。',
    input: { hint: '[archive [all|mission-xxxxxxxx] | missions [all] | orphans [all|root-xxxxxxxx]]' },
    handler: async ({ agent, rawInput }) => {
      const words = rawInput.trim().split(/\s+/u).filter((word) => word.length > 0)
      const [scope = '', target = '', ...extra] = words

      // No argument is the read-only overview: all three scopes, nothing removed.
      if (scope === '') {
        const workers = await workerSessions(sessionDeps, agent.id)
        const archived = archivedIds()
        const ghosts = await listedGhosts(archived)
        const orphans = await host.orphanTreeReports({ fresh: true })
        const finished = host.finishedTreeIds(agent.id)
        const ongoing = host.ownedTreeIds(agent.id).filter((id) => !finished.includes(id))
        if (workers.length === 0 && orphans.length === 0 && ghosts.length === 0 && finished.length === 0) {
          return { kind: 'success', text: '本会话没有 mission 会话记录，也没有孤儿任务树或已完成任务。' }
        }
        log.info(
          `/clean (list) from ${agent.id}: ${String(workers.length)} session record(s), `
          + `${String(orphans.length)} orphan tree(s), ${String(ghosts.length)} ghost archive marker(s), `
          + `${String(finished.length)} closed tree(s)`,
        )
        return {
          kind: 'success',
          text: [
            '任务会话记录（archive 作用域）：',
            ...archiveScopeLines(workers, archived, {
              archivable: registryOf() !== undefined,
              foreign: await foreignWorkerIds(sessionDeps, agent.id),
              ghosts,
            }),
            // Absent rather than empty when there is nothing to say: an "orphans: 0" section is noise.
            ...(finished.length === 0 ? [] : ['', '本会话任务树（missions 作用域）：', ...missionsListLines(finished, ongoing)]),
            ...(orphans.length === 0 ? [] : ['', ...orphanScopeLines(orphans)]),
          ].join('\n'),
        }
      }

      // One command, one spelling. The pre-scope forms (`/clean all`, `/clean <id>`) are ERRORS that
      // name their replacement — never silent aliases, because two spellings for one intent is what
      // this grammar exists to remove.
      if (scope !== 'archive' && scope !== 'orphans' && scope !== 'missions') {
        return {
          kind: 'error',
          text: scope === 'all'
            ? '作用域必填：改用 /clean archive all（已完成会话记录）、/clean missions all（本会话已完成任务树）或 /clean orphans all（孤儿任务树）。'
            : `作用域必填：改用 /clean archive ${scope}（已完成会话记录）、/clean missions（已完成任务树）或 /clean orphans <root-xxxxxxxx>（孤儿树）。`,
        }
      }
      if (extra.length > 0) {
        return { kind: 'error', text: `参数太多：/clean ${scope} 只接受 all 或一个 id。` }
      }

      if (scope === 'missions') {
        const finished = host.finishedTreeIds(agent.id)
        const ongoing = host.ownedTreeIds(agent.id).filter((id) => !finished.includes(id))
        if (target === '') {
          // The read-only dry run. Same two buckets the delete reports, so a listing and a pass agree.
          log.info(`/clean missions (list) from ${agent.id}: ${String(finished.length)} closed, ${String(ongoing.length)} open`)
          return { kind: 'success', text: missionsListLines(finished, ongoing).join('\n') }
        }
        if (target !== 'all') {
          return {
            kind: 'error',
            text: `missions 只接受 all（批量删除本会话已关闭的任务树）：/clean missions all。`
              + `要删单独一棵（含已完成未收尾的）用任务面板上的「删除」。`,
          }
        }
        const result = await host.cleanFinished({ sessionId: agent.id })
        log.info(
          `/clean missions all from ${agent.id}: removed ${String(result.deleted.length)} tree(s), `
          + `skipped ${String(result.skipped.length)} not-closed tree(s)`,
        )
        return { kind: 'success', text: missionsCleanupLines(result.deleted, result.skipped).join('\n') }
      }

      if (scope === 'orphans') {
        if (target === '') {
          const orphans = await host.orphanTreeReports({ fresh: true })
          if (orphans.length === 0) return { kind: 'success', text: '没有孤儿任务树。' }
          log.info(`/clean orphans (list) from ${agent.id}: ${String(orphans.length)} tree(s)`)
          return { kind: 'success', text: orphanScopeLines(orphans).join('\n') }
        }
        if (target === 'all') {
          // The candidate set; every member is re-probed below before anything is destroyed.
          const listed = await host.orphanTreeReports({ fresh: true })
          if (listed.length === 0) return { kind: 'success', text: '没有孤儿任务树可清理。' }
          return await removeOrphanTrees(agent.id, listed.map((entry) => entry.rootId))
        }
        return await removeOrphanTrees(agent.id, [target])
      }

      // ── archive scope ────────────────────────────────────────────────────
      // Ours only, settled only. Every candidate is archived FIRST and removed only once that
      // succeeded, so one `/clean` finishes the job that used to need `/archive` then `/clean`.
      if (target === '') {
        // The archive scope's read-only listing — the dry run, with its scope spelled out.
        const workers = await workerSessions(sessionDeps, agent.id)
        const archived = archivedIds()
        const ghosts = await listedGhosts(archived)
        if (workers.length === 0 && ghosts.length === 0) {
          return { kind: 'success', text: '本会话没有 mission 会话记录。' }
        }
        return {
          kind: 'success',
          text: archiveScopeLines(workers, archived, {
            archivable: registryOf() !== undefined,
            foreign: await foreignWorkerIds(sessionDeps, agent.id),
            ghosts,
          }).join('\n'),
        }
      }
      if (registryOf() === undefined) return { kind: 'error', text: NO_REGISTRY }

      if (target === 'all') {
        const result = await cleanWorkers(sessionDeps, agent.id, (id) => archivedIds().has(id))
        // The same pass also reconciles what EARLIER runs left behind: `cleanWorkers` lifted the
        // markers of what it removed just now, cleared their projection-cache residue, and this
        // clears the historical ghosts and any residue whose record the corpus/sessions root no
        // longer knows. Both counts are reported separately, records first, residue second.
        const ghosts = await reconcileGhosts()
        const purged = [...result.purged, ...ghosts.purged]
        if (result.cleaned.length === 0 && result.refused.length === 0) {
          return {
            kind: 'success',
            text: ['没有可清理的 mission 会话。', ...cleanupScopeLines(result), ...ghostScopeLines(ghosts),
              ...purgeScopeLines(purged)].join('\n'),
          }
        }
        log.info(
          `/clean archive all from ${agent.id}: archived+removed ${String(result.cleaned.length)}, `
          + `archive failed ${String(result.refused.length)}, unarchive failed ${String(result.unarchiveFailures.length)}, `
          + `ghosts released ${String(ghosts.released.length)}, cache purged ${String(purged.length)}, `
          + `running ${String(result.running.length)}, foreign ${String(result.foreign.length)}`,
        )
        return {
          kind: result.cleaned.length === 0 ? 'error' : 'success',
          text: [...cleanupScopeLines(result), ...ghostScopeLines(ghosts), ...purgeScopeLines(purged)].join('\n'),
        }
      }

      // A named record is looked up ONLY among this session's own workers, so a `/clean archive <id>`
      // can never reach another session's log. (The orphans scope is the one deliberate exception,
      // and only for a tree whose owner is missing or unobservable.)
      const named = await cleanWorkers(sessionDeps, agent.id, (id) => archivedIds().has(id), { only: target })
      const done = named.cleaned[0]
      if (done !== undefined) {
        log.info(`/clean archive ${done.id} from ${agent.id}: ${bytes(done.freed)}`)
        // Step 3 is best-effort: a failed unarchive is only ever reported, never a reason to undo the
        // deletion — the files are gone, and keeping the marker is the worse outcome (a ghost id).
        const unarchiveFailure = named.unarchiveFailures[0]
        if (unarchiveFailure !== undefined) {
          log.warn(`/clean archive ${unarchiveFailure.id} from ${agent.id}: deleted, but unarchive failed — `
            + unarchiveFailure.reason)
        }
        return {
          kind: 'success',
          text: [
            `已归档并清理 ${done.id}，释放约 ${bytes(done.freed)}（${done.archivedNow ? '本次归档' : '原本已归档'}）。`,
            ...(unarchiveFailure === undefined
              ? []
              : [`取消归档失败（记录已释放，标记留到下次挂载对账）：${unarchiveFailure.reason}`]),
            ...purgeScopeLines(named.purged),
          ].join('\n'),
        }
      }
      const refused = named.refused[0]
      if (refused !== undefined) {
        log.warn(`/clean archive ${refused.id} from ${agent.id}: archive failed — ${refused.reason}`)
        return { kind: 'error', text: `${refused.id} 归档失败，记录保留未清理：${refused.reason}` }
      }
      if (named.running.includes(target)) {
        return { kind: 'error', text: `${target} 还在运行，不能清理。` }
      }
      return { kind: 'error', text: `${target} 不是本会话的 mission 会话（用 /clean archive 看清单）。` }
    },
  })

  // ── `/mission` ──────────────────────────────────────────────────────────────
  ctx.commands.register({
    name: 'mission',
    // 面向使用者（命令面板是中文界面），所以这条描述也用中文；`hint` 保持英文占位符
    // 的形状 —— 它是待填的参数，不是说明文字。
    description: '列出本会话拥有的任务；命令后面跟文本时，用这段文本建一个根任务。',
    input: { hint: '[任务描述]' },
    handler: async ({ agent, rawInput }) => {
      // DEGRADED mount (storage never opened): the command surface is still registered, so it reports
      // the reason through its ordinary error shape instead of throwing out of `requireTree()`.
      const degraded = host.degradedReason()
      if (degraded !== undefined) {
        log.warn(`/mission refused: the engine is not ready — ${degraded}`)
        return {
          kind: 'error',
          text: `任务引擎未就绪（存储域未能打开）：${degraded}\n修复后重启 dsh 即可恢复。`,
        }
      }

      // INBOUND, the `/mission` command's text entry: this ONE string feeds the root's title, its
      // description and the echo below, so it is repaired once here (the same rule as the tool
      // entries; the tree repairs again on the way in, idempotently).
      const request = wellFormed.text(rawInput).trim()

      if (request.length === 0) {
        const text = host.describe(agent)
        log.info(`/mission (list) from ${agent.id}`)
        return { kind: 'success', text }
      }

      if (request === 'list' || request === 'ls') {
        log.info(`/mission (list) from ${agent.id}`)
        return { kind: 'success', text: host.describe(agent) }
      }

      // First line names the root; the rest, if any, is its description. A root created here carries
      // no owner analysis, and the first executor is told exactly that by the prompt it receives.
      const [firstLine = '', ...rest] = request.split('\n')
      // The `TITLE_MAX` slice can land BETWEEN the two halves of an astral character and manufacture
      // a lone surrogate out of text that arrived well-formed — the same "truncation creates the
      // defect" case as `submitResult`'s spilled inline tail, so the result is repaired again.
      const truncated = firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine
      const title = wellFormed.text(truncated)
      const description = rest.length > 0 ? request : firstLine

      const result = await host.createWork(agent, title, description, [])
      if (!result.ok) {
        log.warn(`/mission create refused for ${agent.id}: ${result.code} — ${result.message}`)
        return { kind: 'error', text: `创建任务失败（${result.code}）：${result.message}` }
      }
      const rootId = result.value.id
      log.info(`/mission (create) from ${agent.id}: root ${rootId} "${title}"`)
      return {
        kind: 'success',
        text: `已创建任务 [${rootId}]「${title}」。引擎已开始派活；用 /mission 看进度。`,
      }
    },
  })

  // ── ghost archive reconciliation, once per mount ─────────────────────────
  // Archived worker ids whose records `/clean` released in an earlier run stayed in the registry's
  // archive set, and every surface reading that set (the subagent list above all) kept showing them.
  // The pass is narrow by construction (see `reconcileArchivedGhosts`) and cannot throw out of this
  // mount: a storage hiccup here is a warning, never a failed plugin row.
  try {
    await reconcileGhosts()
  } catch (error: unknown) {
    log.warn(`ghost archive reconciliation at mount failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // ── automatic worker retention, once per mount ───────────────────────────
  // The tree — the only source of owner session ids — exists only after `start()` opened storage, so
  // this is chained on `ready`. It is deliberately NOT awaited: `apply` must resolve while storage is
  // still opening (a fast unmount lands inside that window — see `lifecycle-open.spec.ts`), and the
  // sweep listener registered above repeats the pass on every tick anyway. The chain ends in a catch,
  // so a failure is one warning and never an unhandled rejection (a process-level fatal).
  void ready
    .then(() => retentionPass())
    .catch((error: unknown) => {
      log.warn(`worker retention at mount failed: ${error instanceof Error ? error.message : String(error)}`)
    })

  log.info(
    `mounted: /mission command, ${String(tools.length)} tools (/archive, /clean), guidance context, pre-step gate`,
  )

  host.markReady(ready)
}

export { defineWorkTools } from './tools.js'
export { AvantfMissionHost } from './host.js'
