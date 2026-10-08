/**
 * A real Cordis mount of the plugin over stubbed DSH services.
 *
 * The stubs mirror the service surfaces the plugin actually uses, so a wrong call
 * shape fails here instead of in a live profile — and unlike the mount smoke, the
 * pre-step default is the one the agent loop really produces (`[...claimed,
 * runtimeContextSnapshot]`), which is the part that hid two defects.
 */
import { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { MissionTree } from '@avantf/mission-core'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AvantfMissionHost } from '../src/host.js'
import { createTreeStore, type TreesTable } from '../src/store.js'
import type { TreeDocument } from '../src/domain.js'
import { apply as applyPlugin, inject, name } from '../src/index.js'
import { checkEventFilters, type SentEventFilter } from './sessionQueryContract.js'

// The plugin's environment initialisation loads the family base `@avantf/dsh-plugin-base` through the
// inlined bootstrap and keeps the family root under `$AVANTF_HOME`. A test must not touch the real
// root or the network: point the root at a throwaway directory. The base itself IS installed (it is a
// devDependency), so the gate runs here exactly as it does in a real profile and this harness's
// service stubs are what it judges. `loadCompat` degrades to "gate ABSENT" only when the base cannot
// be loaded at all, which `mount-anyway.spec.ts` and the mount smoke's negative profile cover.
process.env['AVANTF_HOME'] = mkdtempSync(join(tmpdir(), 'avantf-mission-test-home-'))

/** The runtime-context snapshot the system-prompt projection appends per step. */
export const SNAPSHOT_SOURCE = {
  kind: 'runtime-context',
  form: 'snapshot',
  sections: [{ name: 'avantf-mission', text: 'guidance' }],
}

interface Message {
  id: string
  content: { type: 'text'; text: string }[]
  source: Record<string, unknown>
}

/** A user-role message shaped like the ones the loop hands to a pre-step listener. */
export function message(id: string, source: Record<string, unknown>, text = 'hello'): Message {
  return { id, content: [{ type: 'text', text }], source }
}

/** What the agent loop's built-in `next` returns: inbox messages plus the snapshot. */
export function loopNext(claimed: readonly Message[], snapshot?: Message) {
  return () =>
    Promise.resolve({
      kind: 'enter' as const,
      messages: snapshot === undefined ? [...claimed] : [...claimed, snapshot],
    })
}

/** The pending-input half of the loop's inbox the gate may read and mutate. */
interface StubInbox {
  nextTurn: Message[]
  nextStep: Message[]
  /** Queue one message at a boundary, the way `followup`/`steer` do. */
  append: (target: 'next-turn' | 'next-step', message: Message) => void
  /** Remove one pending message; false when it was no longer pending. */
  remove: (messageId: string) => boolean
}

export interface StubAgent {
  id: string
  /** The agent-scoped context, as `tools.restrict()` requires. Set by `mount()`. */
  ctx?: { get: (name: string) => unknown }
  header: { origin?: 'subagent'; delegationDepth?: number }
  session: { header: { origin?: 'subagent'; delegationDepth?: number } }
  inbox: StubInbox
  followup: (input: Message) => void
  received: Message[]
}

export function agent(id: string, header: StubAgent['header'] = {}): StubAgent {
  const received: Message[] = []
  const nextTurn: Message[] = []
  const nextStep: Message[] = []
  return {
    id,
    header,
    session: { header },
    received,
    inbox: {
      nextTurn,
      nextStep,
      append: (target, message) => {
        const list = target === 'next-turn' ? nextTurn : nextStep
        list.push(message)
      },
      remove: (messageId) => {
        for (const list of [nextStep, nextTurn]) {
          const index = list.findIndex((entry) => entry.id === messageId)
          if (index >= 0) {
            list.splice(index, 1)
            return true
          }
        }
        return false
      },
    },
    followup: (input) => {
      received.push(input)
    },
  }
}

/**
 * The node id a dispatch/wake prompt is for.
 *
 * The prompt's `本任务` block always starts with `id: <node>`, so this is the same datum the
 * worker reads — no parallel bookkeeping that could drift from what was actually sent.
 */
function nodeIdOfPrompt(prompt: string): string | undefined {
  return /(?:^|\n)id: ([0-9a-f]{8})(?:\n|$)/u.exec(prompt)?.[1]
}

/** The runtime-context snapshot the system-prompt projection appends to every step. */
const SNAPSHOT: Message = {
  id: 'runtime-context-snapshot',
  content: [{ type: 'text', text: 'guidance' }],
  source: SNAPSHOT_SOURCE,
}

export interface Dispatched {
  provider: string
  label: string
  childId: string
  prompt: string
  toolFilter?: { deny?: readonly string[] }
  parentId: string
}

/** One stored record set, standing in for the durable domain. */
type Records = Map<string, unknown>

export interface Mounted {
  ctx: Context
  host: AvantfMissionHost
  owner: StubAgent
  dispatched: Dispatched[]
  interrupts: string[]
  /** Scoped restrictions the host applied through an agent's own context. */
  restrictions: { agentId: string; filter: { deny?: readonly string[]; allow?: readonly string[] } }[]
  /** What `sessionQuery.listSessions()` reports, for `/archive` and `/clean` tests. */
  listedSessions: { header: Record<string, unknown>; live: boolean }[]
  /**
   * W18: the session LOG behind each stored session id, as `sessionQuery.filterEvents()` answers it.
   * A test adds one to make a historical node's executor resolvable; the server side reads these
   * only from the `resolveExecutorSession` Remote method, which only a click invokes.
   */
  workerSessions: Map<string, { time: number; text: string }[]>
  /** Session ids whose `filterEvents` was called, in order — the spy the loading cases assert on. */
  sessionLogReads: string[]
  /**
   * Clauses `filterEvents` received that are NOT real `SessionEventResultFilter` objects. A tuple
   * here is the W20 defect; every spec that resolves an executor asserts this stays empty, so a
   * wrong shape fails the case that sent it instead of returning `[]` and looking like a miss.
   */
  sessionFilterViolations: string[]
  /** How many times `sessionQuery.listSessions()` was called — the metadata half of the same spy. */
  sessionListCalls: () => number
  /** Messages the host steered to a worker, in order. */
  sent: { from: string; targetId: string; text: string }[]
  registered: {
    name: string
    description?: string
    /** The JSON Schema the model receives; carried because its text is model-facing too. */
    parameters?: Record<string, unknown>
    /** The tool's output contract: where the terminal text block the model reads is produced. Carried
     *  because that text is a model-visible boundary in its own right (a lone surrogate in it makes a
     *  strict consumer reject the whole document). */
    output?: { render: (args: unknown, value: unknown) => readonly { type: string; text: string }[] }
    execute: (args: unknown, exec: unknown) => Promise<unknown>
  }[]
  contexts: { name: string; text: (context: { agent?: unknown }) => string }[]
  sections: { name: string; order: number; text: (context: { agent?: unknown }) => string }[]
  commands: {
    name: string
    description: string
    input?: { hint?: string }
    handler: (invocation: {
      agent: StubAgent
      rawInput: string
      commandId: string
      attachments: never[]
      signal: AbortSignal
    }) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string }
  }[]
  /** Run one registered slash command the way the client runtime does. */
  runCommand: (name: string, rawInput: string, agent?: StubAgent) => Promise<{ kind: string; text?: string }>
  owners: Set<string>
  sessions: Set<string>
  /**
   * Session ids whose owner probe FAILS with an error that is not "not found", as a session store
   * refusing an old log does. Mutable, so a test can turn a session opaque after the mount.
   */
  unobservableSessions: Set<string>
  /** Session ids the workspace registry reports as archived. Mutable, for `/clean archive all`. */
  archivedSessions: Set<string>
  /**
   * Every `archiveSession` / `unarchiveSession` call the fake registry received, in order, as
   * `archive:<id>` / `unarchive:<id>` — the sequence the three-step cleanup lifecycle is asserted on.
   */
  registryCalls: string[]
  /** The root ids of the trees seeded by `options.seedTrees`, in the order they were seeded. */
  seededRoots: string[]
  /** Materialize one session away, as a delete would: the next probe cannot see it live. */
  dropLive: (sessionId: string) => void
  spill: { saved: string[]; locator: string; hint: string }
  /** Run one pre-step through the real event chain. */
  preStep: (payload: {
    agent: StubAgent
    messages: Message[]
    next: () => Promise<{ kind: 'enter'; messages: Message[] }>
    /** The turn to report (default 1). */
    turn?: number
    /** The 1-based step to report (default 1). A step after the turn's first is what the loop
     *  proposes at a tool-call boundary, where a claimed batch may carry steering and an empty batch
     *  means "the model still has a tool result to read". */
    step?: number
  }) => Promise<{ kind: string; messages?: Message[] }>
  /**
   * The session currently executing each node, and the prompt it last received.
   *
   * Use this (not `dispatched.at(-1)`) whenever a test needs "the worker for node X": a
   * woken parent keeps its session, so the newest dispatch can belong to another node.
   */
  executorOf: Map<string, { sessionId: string; prompt: string }>
  /** The parked-session address on a node, or `null` when it holds none. */
  parkedWorkerOf: (nodeId: string) => string | null | undefined
  /** One node's durable record, as stored. */
  nodeFor: (nodeId: string) => import('@avantf/mission-core').NodeRecord | undefined
  /** One stored tree document exactly as the store holds it: how a test asserts what was PERSISTED
   *  (a durable mark) rather than what is merely in memory. */
  stored: (rootId: string) => TreeDocument | undefined
  /** Materialize the owner away, as a restart or an idle host would. */
  dropOwner: () => void
  /**
   * A second top-level session, registered as an owner.
   *
   * `makeLive` models a WORKER (its descriptor carries the subagent header), so it cannot be
   * used to stand up another owner's tree.
   */
  makeOwner: (sessionId: string) => StubAgent
  /**
   * Give the owner one step, which is when the host wakes parked sessions.
   *
   * In a live profile the owner gets such a step whenever the engine's wake reaches it; a
   * test drives it explicitly so the wake does not depend on unrelated harness mechanics.
   */
  wake: () => Promise<void>
  /** Dispatch a stored tree the way the engine would, through the subagent stub. */
  flush: () => Promise<void>
  /**
   * Register a live agent under one session id.
   *
   * The engine resolves worker liveness through `ctx.agents.get`, so a test that
   * wants a dispatched worker to keep holding its node — rather than being
   * reclaimed as vanished — has to put it in the registry.
   */
  makeLive: (sessionId: string) => StubAgent
  /** Let every start held by `deferStart` finish (the child accepts its prompt). */
  releaseStarts: () => void
  /** Let every delivery held by `deferSend` finish (the message reaches the child). */
  releaseSends: () => void
  /** Host-facing Typert contributions the plugin registered. */
  typertContributions: unknown[]
  /** How many times the storage domain was opened — one per successful mount. */
  domainOpens: number
  /**
   * The error the typert stub threw, when the mount asked it to throw.
   *
   * Carried so a caller can prove its case actually armed the failure instead of silently
   * exercising the healthy path.
   */
  typertError: unknown
}

export async function mount(
  options: {
    tools?: string[]
    spill?: boolean
    /**
     * Names the runtime REFUSES to restrict, as `tools.restrict()` does for a tool
     * the child cannot inherit (an agent-plane registration). Modelling it is what
     * makes the dispatch fallback testable.
     */
    unrestrictable?: string[]
    /**
     * Keep every worker start pending until the test releases it.
     *
     * Real `startContinuable` resolves only once the child has accepted its prompt, so
     * the window between binding and registration is observable; a test that sweeps
     * inside it is the regression guard for "that worker is not gone, it is starting".
     */
    deferStart?: boolean
    /**
     * Make every `subagents.startContinuable` reject, as an outage does. Charged to `spawnFailures`
     * rather than the mission's own failure budget, and the host owes the owner a heads-up once the
     * streak reaches the engine's floor.
     */
    failStart?: boolean
    /**
     * Hand out the spilled artifact's real PATH, as `dsh-spill-local` does, instead of the opaque
     * `spill://` locator. Only a test that reads a spill back through the host needs the shape.
     */
    spillToDisk?: boolean
    /**
     * Make `typert.register` throw, as a registry whose contribution shape moved
     * between harness revisions does. `apply` must contain it.
     */
    typertThrows?: boolean
    /**
     * Make `storageDomain.open` reject: the storage domain cannot be opened at all. The plugin must
     * still mount DEGRADED — tools registered, each answering the reason, no unhandled rejection.
     */
    failDomainOpen?: boolean
    /**
     * Do NOT await `host.whenReady()` before returning. The production `apply` never awaits start-up;
     * this reproduces that shape so a start-up failure would be observable as an unhandled rejection.
     */
    awaitReady?: boolean
    /**
     * Make `subagents.sendMessage` reject, as waking a parked session does when the session
     * was cleaned up or the runtime refuses to resume it. The wake must degrade to a fresh
     * session, never fail the tree.
     */
    failSend?: boolean
    /**
     * Hold every `subagents.sendMessage` open until `releaseSends()`.
     *
     * A wake is ADOPT-then-DELIVER, and the sweep triggered by the last child's own
     * `subagent/end` runs inside that gap: proving the guard needs a test that can stop there.
     */
    deferSend?: boolean
    /**
     * More session ids `observeSession` resolves as existing (the durable store's answer), on top of
     * `owner`. Mutable afterwards through `mounted.sessions`, so a test can make a session vanish.
     */
    sessions?: readonly string[]
    /** Session ids whose probe fails with a non-"not found" error: orphaned but never destroyed. */
    unobservableSessions?: readonly string[]
    /**
     * Seed one tree per owner session into the durable store BEFORE the plugin opens it, so start-up
     * reconciliation (orphan destruction, the aggregate report) runs against them exactly as after a
     * restart. The generated root ids come back as `mounted.seededRoots`.
     */
    seedTrees?: readonly string[]
    /**
     * Raw durable documents written into the store BEFORE the plugin opens it — how a test models a
     * RESTART: a document produced by an earlier generation, possibly missing fields added since.
     * Unlike `seedTrees` this bypasses `createRoot`, which is the point: only then can a fixture be
     * a record the CURRENT code would never write.
     */
    seedDocuments?: readonly TreeDocument[]
    /** Mount a workspace registry whose archive set is `mounted.archivedSessions`. */
    workspaceRegistry?: boolean
    /**
     * Ids already archived BEFORE the plugin opens, as a restart over a registry that kept markers
     * whose session records `/clean` released in an earlier run does. This is what the mount-time
     * ghost reconciliation (and only it) is allowed to lift.
     */
    archivedSessions?: readonly string[]
    /** Make `unarchiveSession` reject, as a registry write refused at the wrong moment would. */
    unarchiveThrows?: boolean
    /**
     * Mount WITHOUT the optional `sessionQuery` service, as a headless deployment (or a host whose
     * session store is not composed) does. The click-time executor lookup must degrade to "cannot
     * look up" rather than throw, and nothing else in the plugin may notice.
     */
    noSessionQuery?: boolean
    /** Plugin config, so a test can point `sessionsRoot` at a throwaway directory. */
    pluginConfig?: Record<string, unknown>
    /**
     * Stored sessions present BEFORE the plugin opens, as `sessionQuery.listSessions()` reports them.
     * The mount-time automatic retention pass reads the listing while it runs, so a case about that
     * pass has to seed here; a test that exercises the commands pushes onto `mounted.listedSessions`
     * after mount instead.
     */
    seedListedSessions?: readonly { header: Record<string, unknown>; live: boolean }[]
  } = {},
): Promise<Mounted> {
  const records: Records = new Map()
  const dispatched: Dispatched[] = []
  /**
   * The session that currently executes each node, and the prompt it last received.
   *
   * A node's executor is no longer always the most recent dispatch: once a parent parks and
   * is WOKEN, the same session keeps the node, so `dispatched.at(-1)` belongs to some other
   * node. Tests ask by node id instead.
   */
  const executorOf = new Map<string, { sessionId: string; prompt: string }>()
  const interrupts: string[] = []
  const restrictions: Mounted['restrictions'] = []
  const sent: Mounted['sent'] = []
  /** Starts held open by `deferStart`, released by the returned `releaseStarts`. */
  const pendingStarts: (() => void)[] = []
  /** Deliveries held open by `deferSend`, released by the returned `releaseSends`. */
  const pendingSends: (() => void)[] = []
  const registered: Mounted['registered'] = []
  const contexts: Mounted['contexts'] = []
  const sections: Mounted['sections'] = []
  const commands: {
    name: string
    description: string
    input?: { hint?: string }
    handler: (invocation: {
      agent: StubAgent
      rawInput: string
      commandId: string
      attachments: never[]
      signal: AbortSignal
    }) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string }
  }[] = []
  const owners = new Set<string>(['owner'])
  const sessions = new Set<string>(['owner', ...(options.sessions ?? [])])
  const unobservableSessions = new Set<string>(options.unobservableSessions ?? [])
  const archivedSessions = new Set<string>(options.archivedSessions ?? [])
  /** Registry calls in order, so the archive → release → unarchive lifecycle is assertable. */
  const registryCalls: string[] = []
  const seededRoots: string[] = []
  /** Sessions `listSessions()` reports; tests push entries to exercise the commands. */
  const listedSessions: { header: Record<string, unknown>; live: boolean }[] = [...(options.seedListedSessions ?? [])]
  /** Session logs, keyed by session id; only `resolveExecutorSession` reads them. */
  const workerSessions = new Map<string, { time: number; text: string }[]>()
  const sessionLogReads: string[] = []
  const sessionFilterViolations: string[] = []
  let sessionListCalls = 0
  const live = new Map<string, StubAgent>()
  const spill = { saved: [] as string[], locator: 'spill://mission-result', hint: 'read it with the read tool' }
  /** Real spill files written by `saveText` when `spillToDisk` is on; removed by `dispose`. */
  const spillFiles: string[] = []

  const owner = agent('owner')
  // An agent-scoped tool face: `restrict()` is only legal on a scoped context, and this
  // records what the host asked for.
  owner.ctx = {
    get: (name: string) => name === 'tools'
      ? {
        restrict: (filter: { deny?: readonly string[]; allow?: readonly string[] }) => {
          restrictions.push({ agentId: owner.id, filter })
          return () => undefined
        },
      }
      : undefined,
  }
  live.set(owner.id, owner)

  const toolNames = new Set(options.tools ?? ['send_message', 'subagent', 'subagent_fork', 'create_goal', 'get_goal', 'update_goal'])
  const toolsService = {
    register: (definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
      registered.push(definition)
      // Withdraw by IDENTITY: the compatibility gate registers a throwaway `__dshCompatProbe` and
      // immediately disposes it, so a disposer that ignored its argument would leave a tenth tool in
      // `registered` and make every "exactly nine tools" assertion fail for the wrong reason.
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    // Visibility per agent, as the real registry answers it: the deployment's own tools
    // PLUS whatever this plugin has registered by now (a face list is filtered through
    // this before `restrict()` is called, because an unknown name throws).
    get: (toolName: string) => (
      toolNames.has(toolName) || registered.some((entry) => entry.name === toolName)
        ? { name: toolName }
        : undefined
    ),
  }

  let open = false
  let domainOpens = 0
  // The one table over `records`, shared by the domain stub and by `seedTrees`: seeding goes through
  // the same store shape the plugin will open, so a seeded document is byte-for-byte what a restart
  // would have loaded.
  const table: TreesTable = {
    get: (key) => records.get(key) as ReturnType<TreesTable['get']>,
    entries: () => records.entries() as ReturnType<TreesTable['entries']>,
    put: (key, value) => {
      records.set(key, value)
      return Promise.resolve()
    },
    delete: (key: string) => Promise.resolve(records.delete(key)),
    get size() {
      return records.size
    },
  }
  const storageDomainService = {
    open: (spec: { name: string }) => {
      // The one failure the DEGRADED mount exists for: the domain cannot be opened at all (a locked or
      // corrupt backend, a storage service that is down). The rejection is what `host.start()` must
      // absorb into `degradedReason()` without leaving an unhandled rejection behind.
      if (options.failDomainOpen === true) {
        return Promise.reject(new Error(`domain '${spec.name}' could not be opened`))
      }
      if (open) throw new Error(`domain '${spec.name}' is already open`)
      open = true
      domainOpens += 1
      return Promise.resolve({
        table: () => table,
        close: () => {
          open = false
          return Promise.resolve()
        },
      })
    },
  }

  if (options.seedTrees !== undefined) {
    // A throwaway tree over the same store: `createRoot` is the only place a VALID tree document is
    // built, so seeding through it keeps the fixture honest instead of hand-rolling node records.
    let seeded = 0
    const beforeOpen = new MissionTree(createTreeStore(table), {
      isAgentLive: () => false,
      probeOwner: () => Promise.resolve({ kind: 'exists' }),
      spill: () => Promise.resolve(null),
      now: () => Date.now(),
      newId: () => (seeded += 1).toString(16).padStart(8, '0'),
    })
    for (const ownerSessionId of options.seedTrees) {
      const created = await beforeOpen.createRoot({
        ownerSessionId,
        title: `seeded ${ownerSessionId}`,
        description: 'seeded before the plugin opened its store',
        analysis: [],
      })
      if (!created.ok) throw new Error(`seeding a tree for ${ownerSessionId} failed`)
      seededRoots.push(created.value.id)
    }
  }

  // Documents written by an earlier generation, dropped in verbatim: the plugin's open() is what
  // reconciles them, exactly as it would after a restart.
  for (const document of options.seedDocuments ?? []) {
    records.set(document.tree.rootId, document)
  }

  const ctx = new Context()
  ctx.provide('tools', toolsService)
  ctx.provide('agents', { get: (id: string) => live.get(id) })
  ctx.provide('subagents', {
    // Steering one running worker: the correction path.
    sendMessage: (
      sender: { id: string },
      targetId: string,
      content: { text?: string }[],
      _options: unknown,
    ) => {
      const text = content.map((block) => block.text ?? '').join('')
      if (options.failSend === true) {
        return Promise.reject(new Error('subagent is not resumable'))
      }
      sent.push({ from: sender.id, targetId, text })
      const wokenNode = nodeIdOfPrompt(text)
      if (wokenNode !== undefined) executorOf.set(wokenNode, { sessionId: targetId, prompt: text })
      if (options.deferSend === true) {
        return new Promise<string>((resolve) => {
          pendingSends.push(() => { resolve('m1') })
        })
      }
      return Promise.resolve('m1')
    },
    startContinuable: (spec: {
      provider: string
      label: string
      childId: string
      request: { prompt: { text: string }[]; parent: StubAgent; toolFilter?: { deny?: readonly string[] } }
    }) => {
      // An outage: nothing can be materialized. Rejected before the dispatch is recorded, because
      // no worker ever started — which is exactly what `spawnFailures` counts.
      if (options.failStart === true) {
        return Promise.reject(new Error('stubbed: no worker could be started'))
      }
      const refused = (spec.request.toolFilter?.deny ?? []).filter((name) =>
        (options.unrestrictable ?? []).includes(name),
      )
      if (refused.length > 0) {
        // The shape of the real failure, so the host's recovery path is exercised.
        return Promise.reject(
          new Error(
            `tools.restrict() names unknown global tool${refused.length > 1 ? 's' : ''} `
            + `${refused.map((name) => `"${name}"`).join(', ')}; known global tools: (stubbed)`,
          ),
        )
      }
      const prompt = spec.request.prompt.map((block) => block.text).join('')
      const nodeId = nodeIdOfPrompt(prompt)
      if (nodeId !== undefined) executorOf.set(nodeId, { sessionId: spec.childId, prompt })
      dispatched.push({
        provider: spec.provider,
        label: spec.label,
        childId: spec.childId,
        prompt,
        ...spec.request.toolFilter === undefined ? {} : { toolFilter: spec.request.toolFilter },
        parentId: spec.request.parent.id,
      })
      const started = { childId: spec.childId, messageId: 'm1' }
      if (options.deferStart !== true) return Promise.resolve(started)
      // Held open until the test releases it: the child has been bound but has not
      // accepted its prompt, which is the window the host must read as "starting".
      return new Promise<typeof started>((resolve) => {
        pendingStarts.push(() => { resolve(started) })
      })
    },
    interrupt: (sessionId: string) => {
      interrupts.push(sessionId)
    },
  })
  ctx.provide('systemPrompt', {
    context: (contribution: Mounted['contexts'][number]) => {
      contexts.push(contribution)
      return () => undefined
    },
    section: (contribution: Mounted['sections'][number]) => {
      sections.push(contribution)
      return () => undefined
    },
    getSectionOrder: (name: string) => (name === 'TOOL_JOBS' ? 1600 : 2400),
    getContextOrder: () => 120,
  })
  ctx.provide('storageDomain', storageDomainService)
  ctx.provide('commands', {
    // `unknown`: the plugin registers a full CommandDefinition, whose handler type
    // the stub does not need to restate. The registered value is what the tests
    // invoke through `runCommand`.
    register: (definition: unknown) => {
      commands.push(definition as (typeof commands)[number])
      return () => undefined
    },
  })
  ctx.provide('timer', { interval: () => () => undefined })
  // The Typert registry: the plugin registers its host-facing wire schema here,
  // and the browser half looks the namespace up through the gateway at runtime.
  const typertContributions: unknown[] = []
  let typertError: unknown
  ctx.provide('typert', {
    register: (contribution: unknown) => {
      if (options.typertThrows === true) {
        typertError = new Error('typert registry is broken: unknown contribution shape')
        throw typertError
      }
      typertContributions.push(contribution)
      return () => undefined
    },
  })
  ctx.mixin('timer', ['interval'])
  // The optional session-history service. `noSessionQuery` models a deployment without it (the
  // mount must still work, and the click-time lookup must say "cannot look up" rather than throw).
  if (options.noSessionQuery !== true) ctx.provide('sessionQuery', {
    // Stored sessions, as `/archive` and `/clean` enumerate them. Empty unless a test
    // wants otherwise; the mount harness has no session store behind it.
    listSessions: () => {
      sessionListCalls += 1
      return Promise.resolve(listedSessions)
    },
    // W18: the event scan the click-time executor lookup runs. The clauses are the REAL
    // `{kind:'time'|'text'}` objects (`executorSession.ts` sends those two), and `checkEventFilters`
    // records a tuple as the contract violation it is — the fake no longer restates the guess that
    // made the W20 outage pass a green suite.
    filterEvents: (sessionId: string, filters: readonly SentEventFilter[]) => {
      sessionLogReads.push(sessionId)
      const clauses = checkEventFilters(filters, (detail) => sessionFilterViolations.push(detail))
      const time = clauses.find((clause) => clause.kind === 'time')
      const text = clauses.find((clause) => clause.kind === 'text')
      const from = time?.kind === 'time' ? time.from ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY
      const to = time?.kind === 'time' ? time.to ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
      const wanted = text?.kind === 'text' ? text.text : undefined
      const events = workerSessions.get(sessionId) ?? []
      return Promise.resolve(
        events
          .filter((event) => event.time >= from && event.time <= to)
          .filter((event) => typeof wanted !== 'string' || event.text.includes(wanted))
          .map((event) => ({ sessionId, seq: 0, type: 'user/message', time: event.time, surface: 'current', text: event.text })),
      )
    },
    observeSession: (sessionId: string) => {
      if (unobservableSessions.has(sessionId)) {
        // The shape of a host-side failure that is NOT "not found" (a session-store migration
        // refusing an old log): the owner's trees must survive it, and be reported instead.
        return Promise.reject(new Error(`stubbed: session store cannot read "${sessionId}"`))
      }
      if (!sessions.has(sessionId)) {
        const error = new Error(`session "${sessionId}" not found`) as Error & { code: string }
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        return Promise.reject(error)
      }
      return Promise.resolve({ header: {}, [Symbol.dispose]: () => undefined })
    },
  })
  if (options.workspaceRegistry === true) {
    // The durable archive marker `/clean`'s `all` target reads; absent unless a test asks for it,
    // because a headless deployment really has none and the commands must degrade without it.
    ctx.provide('workspaceRegistry', {
      get archivedSessionIds() {
        return [...archivedSessions]
      },
      archiveSession: (id: string) => {
        registryCalls.push(`archive:${String(id)}`)
        archivedSessions.add(String(id))
        return Promise.resolve()
      },
      // Mirrors the real host: dropping an id from the set, idempotent, and no existence check.
      unarchiveSession: (id: string) => {
        registryCalls.push(`unarchive:${String(id)}`)
        if (options.unarchiveThrows === true) {
          return Promise.reject(new Error('stubbed: registry write refused'))
        }
        archivedSessions.delete(String(id))
        return Promise.resolve()
      },
    })
  }
  if (options.spill !== false) {
    ctx.provide('spillStore', {
      saveText: (input: { content: string }) => {
        spill.saved.push(input.content)
        // The DEFAULT locator is the opaque `spill://` form, which is the contract: a locator is the
        // backend's, and nothing may assume it is a path. `spillToDisk` models `dsh-spill-local`,
        // the one backend that does hand out a path, for the test that reads a spill back.
        if (options.spillToDisk === true) {
          const file = join(mkdtempSync(join(tmpdir(), 'avantf-mission-spill-')), 'result.txt')
          writeFileSync(file, input.content, 'utf8')
          spillFiles.push(file)
          return Promise.resolve({ locator: file, bytes: input.content.length, retrievalHint: spill.hint })
        }
        return Promise.resolve({ locator: spill.locator, bytes: input.content.length, retrievalHint: spill.hint })
      },
    })
  }

  await ctx.plugin({ name, inject, apply: applyPlugin }, {
    // A test must NEVER read (or delete from) the developer's real projection cache, and an
    // unspecified root would default to `<DSH_HOME>/storages/session_projcache/sessions`. Point it
    // at a path that cannot exist; a case that wants residue passes its own `projectionCacheRoot`.
    projectionCacheRoot: join(tmpdir(), 'avantf-mission-projcache-absent'),
    ...options.pluginConfig,
  })
  const host = ctx.get('avantfMission') as unknown as AvantfMissionHost
  // Most tests want a fully opened engine. `awaitReady: false` is for the DEGRADED-mount case: it
  // reproduces the real fire-and-forget shape, where `apply` kicks `start()` off and NOTHING awaits
  // it, so a rejected start would surface as an unhandled rejection before the test reads anything.
  if (options.awaitReady !== false) await host.whenReady()

  // The stubs carry only the fields the plugin reads, so the typed overload (which
  // wants a real Agent and UserMessage[]) does not apply at this boundary. Going
  // through the event service is what makes this a test of the registered hook and
  // not of a listener captured by hand.
  const dispatch = ctx.waterfall.bind(ctx) as unknown as (
    name: string,
    payload: unknown,
    next: () => Promise<unknown>,
  ) => Promise<{ kind: string; messages?: Message[] }>

  const preStep = async (payload: {
    agent: StubAgent
    messages: Message[]
    next: () => Promise<{ kind: 'enter'; messages: Message[] }>
    turn?: number
    step?: number
  }): Promise<{ kind: string; messages?: Message[] }> =>
    dispatch(
      'agent/pre-step',
      {
        agent: payload.agent,
        messages: payload.messages,
        turn: payload.turn ?? 1,
        step: payload.step ?? 1,
        signal: new AbortController().signal,
      },
      payload.next,
    )

  return {
    ctx,
    host,
    owner,
    dispatched,
    interrupts,
    registered,
    restrictions,
    sent,
    listedSessions,
    workerSessions,
    sessionLogReads,
    sessionFilterViolations,
    sessionListCalls: () => sessionListCalls,
    contexts,
    sections,
    commands,
    runCommand: async (commandName, rawInput, caller = owner) => {
      const definition = commands.find((entry) => entry.name === commandName)
      if (definition === undefined) throw new Error(`command /${commandName} is not registered`)
      return definition.handler({
        agent: caller,
        rawInput,
        commandId: 'cmd-1',
        attachments: [],
        signal: new AbortController().signal,
      })
    },
    owners,
    sessions,
    unobservableSessions,
    archivedSessions,
    registryCalls,
    seededRoots,
    dropLive: (sessionId: string) => {
      live.delete(sessionId)
    },
    spill,
    preStep,
    typertContributions,
    domainOpens,
    typertError,
    executorOf,
    parkedWorkerOf: (nodeId: string) => host.parkedWorkerOf(nodeId),
    nodeFor: (nodeId: string) => host.nodeFor(nodeId),
    stored: (rootId: string) => records.get(rootId) as TreeDocument | undefined,
    makeOwner: (sessionId: string) => {
      // A SECOND top-level session: the harness's `makeLive` stamps the 'owner' descriptor on
      // whatever it is given, which models a worker, not another owner. Cross-owner surfaces
      // (tree visibility, wake scope) need a real second owner, so this builds one and gives it
      // the scoped tool face a root session has.
      const second = agent(sessionId)
      second.ctx = {
        get: (name: string) => name === 'tools'
          ? { restrict: () => () => undefined }
          : undefined,
      }
      live.set(sessionId, second)
      owners.add(sessionId)
      return second
    },
    dropOwner: () => {
      // "The owner is not materialized": remove it from the registry the host reads liveness
      // from, WITHOUT disposing the stub the test still holds.
      live.delete(owner.id)
    },
    wake: async () => {
      // Drive one OWNER step. The host wakes parked sessions from the owner's pre-step and
      // nowhere else, so a test that wants the convergence pass to start has to give the owner
      // the step it would get in a live profile.
      //
      // The batch carries the runtime-context SNAPSHOT, because a live owner's does: any owner
      // with an open tree gets a guidance contribution, so bucket ② of the gate returns early
      // on essentially every real step. A helper that stubbed an empty batch would exercise
      // only the branch real profiles never take — the exact blind spot `prestep.spec.ts`
      // warns about.
      await preStep({
        agent: owner,
        messages: [SNAPSHOT],
        next: () => Promise.resolve({ kind: 'enter' as const, messages: [SNAPSHOT] }),
      })
    },
    flush: () => host.pump().then(() => undefined),
    makeLive: (sessionId: string) => {
      const live_agent = agent(sessionId)
      live.set(sessionId, live_agent)
      return live_agent
    },
    releaseStarts: () => {
      for (const release of pendingStarts.splice(0)) release()
    },
    releaseSends: () => {
      for (const release of pendingSends.splice(0)) release()
    },
  }
}

/**
 * The session currently executing `nodeId`, as an agent.
 *
 * A node's executor is not always the newest dispatch: a parent that decomposed keeps its
 * session and is woken with it. Asking by node id is the honest question, and the same one
 * `note_mission` / `submit_mission` ask when they authorize on `claimedBy`.
 */
export function executorFor(mounted: Mounted, nodeId: string): StubAgent {
  return agent(mounted.executorOf.get(nodeId)?.sessionId ?? '')
}

/** The prompt that node's current executor last received (dispatch or wake). */
export function promptFor(mounted: Mounted, nodeId: string): string {
  return mounted.executorOf.get(nodeId)?.prompt ?? ''
}

/** Call one registered tool by name. */
export async function callTool(
  mounted: Mounted,
  toolName: string,
  args: Record<string, unknown>,
  caller: StubAgent,
  options: { concludeTurn?: () => void } = {},
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown> }> {
  const tool = mounted.registered.find((definition) => definition.name === toolName)
  if (tool === undefined) throw new Error(`tool ${toolName} is not registered`)
  return (await tool.execute(args, { agent: caller, concludeTurn: options.concludeTurn ?? (() => undefined) })) as {
    ok: boolean
    summary: string
    data?: Record<string, unknown>
  }
}

/**
 * Call one registered tool through the REGISTRY'S OWN argument validation.
 *
 * `callTool` runs the body directly, which is what most cases want; this one validates the
 * arguments against the tool's own compiled parameter schema first, so a case can prove that
 * the DECLARED shape (the `oneOf` on a structured parameter, a `required` flag) is what
 * admits or rejects a call. Without it a declaration could drift from the accessors and no
 * test would notice.
 */
export async function callToolChecked(
  mounted: Mounted,
  toolName: string,
  args: Record<string, unknown>,
  caller: StubAgent,
  options: { concludeTurn?: () => void } = {},
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown> }> {
  const tool = mounted.registered.find((definition) => definition.name === toolName)
  if (tool === undefined) throw new Error(`tool ${toolName} is not registered`)
  const violations = validateJsonSchemaValue(tool.parameters as JsonSchemaNode, args)
  if (violations.length > 0) {
    throw new Error(`invalid arguments: ${violations.join('; ')}`)
  }
  return callTool(mounted, toolName, args, caller, options)
}

/**
 * The two-step open of the split gate: `note_mission` on the held mission, then
 * `decompose_mission`.
 *
 * `decompose_mission` refuses a round that has not written its own analysis, so this is the
 * shape every ordinary decomposition takes. Cases about the GATE itself call the two
 * tools directly; cases about what the split does go through here.
 */
export async function noteAndSplit(
  mounted: Mounted,
  nodeId: string,
  children: unknown,
  worker: StubAgent,
  options: { note?: string; concludeTurn?: () => void } = {},
): Promise<{ ok: boolean; summary: string; data?: Record<string, unknown> }> {
  const noted = await callTool(
    mounted,
    'note_mission',
    { node_id: nodeId, analysis: options.note ?? '这次为什么拆：缺一个前置事实' },
    worker,
  )
  if (!noted.ok) throw new Error(`note_mission failed: ${noted.summary}`)
  return callTool(
    mounted,
    'decompose_mission',
    { node_id: nodeId, children },
    worker,
    options.concludeTurn === undefined ? {} : { concludeTurn: options.concludeTurn },
  )
}
