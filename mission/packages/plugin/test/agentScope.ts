/**
 * The scoped tool registry the mount fixture stands up, as the real harness registry behaves.
 *
 * This is NOT a mock of the plugin: it is the fixture's model of dsh's `tools` service, and the
 * contract it mirrors is the one the plugin's whole face story depends on (dsh `tools` + `dsh-scope`):
 *
 *  - `register` through an agent's own context puts a definition in that ONE scope's layer
 *    (`ScopedLayers.effect(ctx, …)` keys the layer by `scopeOf(ctx)`), so no child inherits it and a
 *    one-argument `get(name)` cannot see it;
 *  - `get(name, scope)` resolves the scope's own layer first (scoped shadows global), then the global
 *    layer, with the scope's restrictions applied to what it INHERITS;
 *  - `restrict()` accepts only names present in the GLOBAL layer — a scope-local name throws
 *    "unknown global tool" — and masks what the scope inherits, never its own registrations;
 *  - a scope's layer is released with the registration's own disposer (the registry's effect owns it).
 *
 * The real registry is not reachable from a spec (it is built by the host composition), so the
 * fixture states the contract here, once, instead of each spec guessing a shape.
 */

/** A tool definition as the harness registry holds it. */
export interface ToolDefinition {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  output?: { render: (args: unknown, value: unknown) => readonly { type: string; text: string }[] }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** One agent's OWN tools registry, as `agent.ctx.get('tools')` answers it. */
export interface ScopedTools {
  register(definition: ToolDefinition): () => void
  restrict(filter: { deny?: readonly string[]; allow?: readonly string[] }): () => void
  get(name: string, scope?: unknown): unknown
}

/** The scoped context one agent stub carries: `agent.ctx.get('tools')` is all the plugin asks for. */
export interface AgentScopedContext {
  get(name: string): unknown
}

/** One tool a face registered INTO a scope: the ledger `agent/disposed` and `ctx.effect` must unwind. */
export interface ScopedRegistration {
  /** The agent OBJECT the face was installed on: per-mount views filter by identity, not by id. */
  agent: { id: string }
  agentId: string
  name: string
}

export interface AgentScopeFixture {
  /** The scoped registry one agent's context hands out. */
  contextOf(subject: { id: string }): AgentScopedContext
  /** The effective view, as the real `tools` service answers it: omitted scope = the global layer. */
  get(name: string, scope?: unknown): unknown
  /** The names currently in ONE scope's own layer, sorted. */
  ownNamesOf(subject: { id: string }): string[]
  /** Every scoped registration, in order. */
  registrations(): ScopedRegistration[]
  /** Clear this registry's lifecycle for a NEW mount: see `bindInstaller`. */
  startMount(): void
  /** Every live restriction, keyed by the agent it was applied to. */
  restrictions(): { agent: { id: string }; agentId: string; filter: { deny?: readonly string[]; allow?: readonly string[] } }[]
  /** The global layer, for the top-level service the plugin's compat probe registers through. */
  global: {
    register(definition: ToolDefinition): () => void
    get(name: string): unknown
  }
  /** Whether a subject counts as announced (a second `announce` is refused). */
  isAnnounced(subject: { id: string }): boolean
  /**
   * Record one announcement. The caller emits `agent/created` itself so the plugin's OWN listener
   * installs the face; the recorded entry is what `bindInstaller` replays for an agent that was
   * announced before the plugin mounted.
   */
  markAnnounced(subject: { id: string }): void
  /** The plugin's own installer, bound once it has mounted (`index.ts`'s `makeFaceInstaller`). */
  bindInstaller(install: ((agent: unknown) => void) | undefined): void
  /**
   * The plugin's own idempotency ledger, handed over with the installer. The mount fixture clears it
   * at the START of a mount (in the seam's `install` call, before `apply` sweeps the registry): the
   * fixture's registry outlives one `mount()`, and the previous mount's ledger would otherwise make
   * this mount's first announcement look "already installed".
   */
  bindInstalled(installed: Map<string, (() => void)[]>): void
  /** The bound ledger, keyed by agent id; empty until the plugin mounts. */
  installedLedger(): Map<string, (() => void)[]>
  /**
   * Forget one agent's announcement, as the real registry does when the entry is removed: the id may
   * be re-announced later (a released worker session restarted under the same claim id), and that
   * second announcement installs its face again.
   */
  forgetAnnouncement(subject: { id: string }): void
  /**
   * The harness's union ledger sink: called for EVERY scoped registration and, on disposal, for the
   * names no scope holds any more. A spec's `callTool` reads that ledger (never the global layer), so
   * a worker tool is callable by name without pretending it was registered globally.
   */
  setRegisterSink(sink: {
    registered: (definition: ToolDefinition) => void
    withdrawn: (definition: ToolDefinition) => void
  }): void
}

/**
 * Build the registry. The installer is BOUND LATER (`index.ts`'s `apply` publishes the one
 * `makeFaceInstaller` returns through the test seam); agents announced before that are replayed into
 * it on binding, which is how the fixture's stubs — announced before the plugin's first line — still
 * get a face.
 *
 * `extraToolNames` is the deployment's OWN tool names (the harness's `send_message` / `subagent` /
 * goal tools): they live in the global layer in a real composition, so `deniableFor` (which compares
 * the parent-scoped and global reads) finds them there. `onRegister` is the harness's UNION ledger —
 * every definition that exists anywhere, so a spec can call a worker tool by name without knowing
 * which scope holds it; it is NOT a global registration.
 */
export function createAgentScopes(options: {
  extraToolNames?: ReadonlySet<string>
  onRegister?: (definition: ToolDefinition) => void
  onWithdraw?: (definition: ToolDefinition) => void
} = {}): AgentScopeFixture {
  /** Global layer: what a one-argument `get(name)` sees. */
  const globalTools = new Map<string, ToolDefinition>()
  /** One layer per agent, keyed by the agent OBJECT (`ScopeKey` is whatever `agent.ctx` was minted from). */
  const layers = new Map<{ id: string }, Map<string, ToolDefinition>>()
  /** Restrictions per agent, as the real registry applies them to the INHERITED surface only. */
  const restrictions = new Map<{ id: string }, { deny?: readonly string[]; allow?: readonly string[] }>()
  const scoped: ScopedRegistration[] = []
  /** Ids already announced: `AgentRegistry.announce` refuses a second call for one agent. */
  const announced = new Set<string>()
  /** Announcements, kept in order so a late-bound installer can be replayed over them. */
  const order: { id: string }[] = []
  /** The plugin's idempotency ledger; see `bindInstalled`. */
  let installed: Map<string, (() => void)[]> | undefined

  const contextOf = (subject: { id: string }): AgentScopedContext => {
    const layer = layers.get(subject) ?? new Map<string, ToolDefinition>()
    layers.set(subject, layer)
    const tools: ScopedTools = {
      register: (definition) => {
        // A SCOPED registration goes into that ONE scope's layer and nowhere else: the real registry's
        // global layer never learns the name, which is exactly why a one-argument `get(name)` cannot
        // see it and why `restrict()` cannot name it.
        layer.set(definition.name, definition)
        scoped.push({ agent: subject, agentId: subject.id, name: definition.name })
        options.onRegister?.(definition)
        return () => {
          layer.delete(definition.name)
          const index = scoped.findIndex((entry) => entry.agentId === subject.id && entry.name === definition.name)
          if (index >= 0) scoped.splice(index, 1)
          options.onWithdraw?.(definition)
        }
      },
      restrict: (filter) => {
        const named = [...filter.allow ?? [], ...filter.deny ?? []]
        const unknown = named.filter((name) => !globalTools.has(name))
        if (unknown.length > 0) {
          throw new Error(
            `tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} `
            + `${unknown.map((name) => `"${name}"`).join(', ')}; known global tools: `
            + `${[...globalTools.keys()].sort().join(', ') || '(none)'}`,
          )
        }
        restrictions.set(subject, filter)
        return () => { restrictions.delete(subject) }
      },
      get: (name, scope) => resolve(name, scope),
    }
    return { get: (name) => (name === 'tools' ? tools : undefined) }
  }

  /** The scope's own layer shadows the global one; a restriction masks what the scope inherits. */
  function resolve(name: string, scope?: unknown): unknown {
    if (scope !== undefined) {
      const own = layers.get(scope as { id: string })?.get(name)
      if (own !== undefined) return own
      const blocked = restrictions.get(scope as { id: string })
      if (blocked?.deny?.includes(name) === true) return undefined
      if (blocked?.allow !== undefined && !blocked.allow.includes(name)) return undefined
    }
    if (options.extraToolNames?.has(name) === true) return { name }
    return globalTools.get(name)
  }

  return {
    contextOf,
    get: (name, scope) => resolve(name, scope),
    ownNamesOf: (subject) => [...(layers.get(subject)?.keys() ?? [])].sort(),
    registrations: () => scoped.map((entry) => ({ ...entry })),
    startMount: () => {
      // Only the idempotency ledger is reset here. The announcement set is NOT: an agent announced
      // before this plugin mounted (the fixture builds the owner first) did pass `agent/created` in the
      // real registry, and `bindInstaller` replays exactly those into the new installer. Clearing them
      // here would drop that replay and leave every pre-mount stub faceless.
      installed?.clear()
    },
    restrictions: () => [...restrictions.entries()].map(([subject, filter]) => ({
      agent: subject,
      agentId: subject.id,
      filter,
    })),
    global: {
      register: (definition) => {
        globalTools.set(definition.name, definition)
        return () => { globalTools.delete(definition.name) }
      },
      get: (name) => globalTools.get(name),
    },
    isAnnounced: (subject) => announced.has(subject.id),
    markAnnounced: (subject) => {
      if (announced.has(subject.id)) return
      announced.add(subject.id)
      order.push(subject)
    },
    bindInstalled: (next) => { installed = next },
    installedLedger: () => installed ?? new Map<string, (() => void)[]>(),
    bindInstaller: (next) => {
      // A NEW mount is a new registry lifecycle: the shared registry outlives one `mount()`, so the
      // previous mount's id-keyed announcement set AND its idempotency ledger must not decide this
      // one's faces (the owner id is 'owner' in every mount). Agents the CALLER already put in its
      // registry are re-installed below, so the ledger is rebuilt rather than merely dropped.
      // Layers and registrations are keyed by agent OBJECT, so a previous mount's entries are
      // unreachable on their own; only the announcements listed here are replayed.
      const announcedSoFar = [...order]
      announced.clear()
      order.length = 0
      if (next !== undefined) {
        for (const subject of announcedSoFar) {
          announced.add(subject.id)
          order.push(subject)
          next(subject)
        }
      }
    },
    setRegisterSink: (sink) => {
      options.onRegister = sink.registered
      options.onWithdraw = sink.withdrawn
    },
    forgetAnnouncement: (subject) => {
      announced.delete(subject.id)
      const at = order.findIndex((entry) => entry.id === subject.id)
      if (at >= 0) order.splice(at, 1)
    },
  }
}

/**
 * Plus the ONE registry every stub in this harness shares, and the harness's union ledger.
 *
 * The registry is module-level, not per-`mount()`, because an agent OBJECT is the SCOPE KEY the
 * plugin's `installFace` addresses: the specs build their own stubs (`agent('mission-…')`,
 * `executorFor(...)`) and hand them to tool calls, so "the layer the plugin registered into" and
 * "the layer the test looks up" have to be the same registry. `mount()` binds the plugin's installer
 * here once it has mounted; before that a scope resolves only to the global layer, which is the
 * honest state of a registry with no plugin behind it.
 */
const shared = createAgentScopes()

/** The shared registry, for the fixture and for the specs that drive tool calls directly. */
export function sharedAgentScopes(): AgentScopeFixture {
  return shared
}
