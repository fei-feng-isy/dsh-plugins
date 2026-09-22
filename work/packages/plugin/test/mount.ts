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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AvantfWorkHost } from '../src/host.js'
import { apply as applyPlugin, inject, name } from '../src/index.js'

// The plugin's environment initialisation loads the family base `@avantf/dsh-plugin-base` through the
// inlined bootstrap and keeps the family root under `$AVANTF_HOME`. A test must not touch the real
// root or the network: point the root at a throwaway directory. The base itself IS installed (it is a
// devDependency), so the gate runs here exactly as it does in a real profile and this harness's
// service stubs are what it judges. `loadCompat` degrades to "gate ABSENT" only when the base cannot
// be loaded at all, which `mount-anyway.spec.ts` and the mount smoke's negative profile cover.
process.env['AVANTF_HOME'] = mkdtempSync(join(tmpdir(), 'avantf-work-test-home-'))

/** The runtime-context snapshot the system-prompt projection appends per step. */
export const SNAPSHOT_SOURCE = { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }

export interface Message {
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
export interface StubInbox {
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
 * The prompt's `本工作` block always starts with `id: <node>`, so this is the same datum the
 * worker reads — no parallel bookkeeping that could drift from what was actually sent.
 */
export function nodeIdOfPrompt(prompt: string): string | undefined {
  return /(?:^|\n)id: ([0-9a-f]{8})(?:\n|$)/u.exec(prompt)?.[1]
}

/** The runtime-context snapshot the system-prompt projection appends to every step. */
const SNAPSHOT: Message = {
  id: 'runtime-context-snapshot',
  content: [{ type: 'text', text: 'guidance' }],
  source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' },
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
  host: AvantfWorkHost
  owner: StubAgent
  dispatched: Dispatched[]
  interrupts: string[]
  /** Scoped restrictions the host applied through an agent's own context. */
  restrictions: { agentId: string; filter: { deny?: readonly string[]; allow?: readonly string[] } }[]
  /** What `sessionQuery.listSessions()` reports, for `/archive` and `/clean` tests. */
  listedSessions: { header: Record<string, unknown>; live: boolean }[]
  /** Messages the host steered to a worker, in order. */
  sent: { from: string; targetId: string; text: string }[]
  registered: {
    name: string
    description?: string
    /** The JSON Schema the model receives; carried because its text is model-facing too. */
    parameters?: Record<string, unknown>
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
  spill: { saved: string[]; locator: string; hint: string }
  /** Run one pre-step through the real event chain. */
  preStep: (payload: {
    agent: StubAgent
    messages: Message[]
    next: () => Promise<{ kind: 'enter'; messages: Message[] }>
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
  nodeFor: (nodeId: string) => import('@avantf/work-core').NodeRecord | undefined
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
     * Make `typert.register` throw, as a registry whose contribution shape moved
     * between harness revisions does. `apply` must contain it.
     */
    typertThrows?: boolean
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
  const sessions = new Set<string>(['owner'])
  /** Sessions `listSessions()` reports; tests push entries to exercise the commands. */
  const listedSessions: { header: Record<string, unknown>; live: boolean }[] = []
  const live = new Map<string, StubAgent>()
  const spill = { saved: [] as string[], locator: 'spill://work-result', hint: 'read it with the read tool' }

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
  const storageDomainService = {
    open: (spec: { name: string }) => {
      if (open) throw new Error(`domain '${spec.name}' is already open`)
      open = true
      domainOpens += 1
      return Promise.resolve({
        table: () => ({
          get: (key: string) => records.get(key),
          entries: () => records.entries(),
          put: (key: string, value: unknown) => {
            records.set(key, value)
            return Promise.resolve()
          },
          delete: (key: string) => Promise.resolve(records.delete(key)),
          get size() {
            return records.size
          },
        }),
        close: () => {
          open = false
          return Promise.resolve()
        },
      })
    },
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
  ctx.provide('sessionQuery', {
    // Stored sessions, as `/archive` and `/clean` enumerate them. Empty unless a test
    // wants otherwise; the mount harness has no session store behind it.
    listSessions: () => Promise.resolve(listedSessions),
    observeSession: (sessionId: string) => {
      if (!sessions.has(sessionId)) {
        const error = new Error(`session "${sessionId}" not found`) as Error & { code: string }
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        return Promise.reject(error)
      }
      return Promise.resolve({ header: {}, [Symbol.dispose]: () => undefined })
    },
  })
  if (options.spill !== false) {
    ctx.provide('spillStore', {
      saveText: (input: { content: string }) => {
        spill.saved.push(input.content)
        return Promise.resolve({ locator: spill.locator, bytes: input.content.length, retrievalHint: spill.hint })
      },
    })
  }

  await ctx.plugin({ name, inject, apply: applyPlugin }, {})
  const host = ctx.get('avantfWork') as unknown as AvantfWorkHost
  await host.whenReady()

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
  }): Promise<{ kind: string; messages?: Message[] }> =>
    dispatch(
      'agent/pre-step',
      {
        agent: payload.agent,
        messages: payload.messages,
        turn: 1,
        step: 1,
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
    spill,
    preStep,
    typertContributions,
    domainOpens,
    typertError,
    executorOf,
    parkedWorkerOf: (nodeId: string) => host.parkedWorkerOf(nodeId),
    nodeFor: (nodeId: string) => host.nodeFor(nodeId),
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
 * `note_work` / `submit_work` ask when they authorize on `claimedBy`.
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
 * The two-step open of the split gate: `note_work` on the held work, then
 * `decompose_work`.
 *
 * `decompose_work` refuses a round that has not written its own analysis, so this is the
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
    'note_work',
    { node_id: nodeId, analysis: options.note ?? '这次为什么拆：缺一个前置事实' },
    worker,
  )
  if (!noted.ok) throw new Error(`note_work failed: ${noted.summary}`)
  return callTool(
    mounted,
    'decompose_work',
    { node_id: nodeId, children },
    worker,
    options.concludeTurn === undefined ? {} : { concludeTurn: options.concludeTurn },
  )
}
