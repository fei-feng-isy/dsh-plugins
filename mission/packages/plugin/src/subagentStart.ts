/**
 * The ONE place that knows which `subagents` start shape this host speaks.
 *
 * WHY THIS MODULE EXISTS. dsh changed the start API inside a minor line: `@deepseek-ai/dsh-subagent`
 * 0.2.0-rc.2 exposes `ctx.subagents.startContinuable(spec)`; the 0.2.1-rc.2 build MERGED that method
 * into `startActivation(spec)`, which carries the same continuable lifecycle but requires a
 * `delivery: 'parent' | 'caller'` policy and no longer accepts `toolFilter`/`persona` on the request
 * (its own `tool-subagent` now throws for those, directing callers to an Agent Preset). The published
 * dsh is still 0.2.0-rc.2, so BOTH shapes have to work — refusing either one would either break today's
 * users (old shape) or refuse to mount on the new host (new shape).
 *
 * The gate cannot express "either method": `ServiceContract.methods` is a flat list where every entry
 * is required. So the two start methods are NOT part of the contract (see `envinit.ts`); `sendMessage`
 * and `interrupt` are (byte-identical in both versions, so a mismatch there is still a proven break).
 * The start shape is detected here, at mount time, and a host with neither is reported loudly with the
 * dispatch path degraded rather than the whole plugin refused — the tree, panel, commands and prompt
 * guidance keep working, and a dispatch says why it cannot start a worker.
 *
 * @module @avantf/dsh-mission/subagentStart
 */

/** The minimal structural view of the two APIs this module calls. Kept local on purpose: this is a
 *  runtime protocol, not a compile-time dependency on one dsh version (the plugin's peers are a
 *  window, and the window includes both shapes). */
type AnyFunction = (...args: never[]) => unknown

interface SubagentsService {
  readonly startActivation?: AnyFunction
  readonly startContinuable?: AnyFunction
}

/** Which start method the mounted host speaks. */
export type StartShape = 'startActivation' | 'startContinuable' | 'none'

/** One dispatch: what the tree knows about the worker it wants to start. */
export interface StartRequest {
  /** The backend name. */
  readonly provider: string
  /** Catalog label, e.g. `mission <nodeId>`. */
  readonly label: string
  /** The reserved child session id (the claim id). */
  readonly childId: string
  /** The worker's initial prompt. */
  readonly prompt: readonly unknown[]
  /** The exact live parent Agent. */
  readonly parent: unknown
  /** Tool names the child must not see. Dropped on a host whose start shape no longer carries them. */
  readonly deny: readonly string[]
  readonly signal: AbortSignal
}

export interface StartOutcome {
  readonly childId: string
  readonly messageId?: string
}

export interface StartAdapter {
  /** Which shape was detected; `none` means the host cannot start a worker. */
  readonly shape: StartShape
  /** Whether the start shape still carries a per-child tool filter (0.2.0-rc.2: yes; 0.2.1-rc.2: no). */
  readonly carriesToolFilter: boolean
  /**
   * Start one worker.
   * @throws when the host cannot start workers at all, or when the host rejects the start.
   */
  start(request: StartRequest): Promise<StartOutcome>
}

/**
 * What a start attempt on a host with NO start method reports. Distinct from a refused filter (which
 * the host throws) and from a failed spawn (which charges `spawnFailures`): nothing was attempted, so
 * the dispatcher's own "cannot start" path owns the message.
 */
export const NO_START_METHOD = 'avantf-mission: this host\'s subagents service exposes neither startActivation nor startContinuable'

/** Detect the shape from a live service. Tolerant by construction: a proxy that throws on access
 *  (an unavailable service) is `none`, never an exception out of mount. */
export function detectStartShape(service: unknown): StartShape {
  const read = (name: 'startActivation' | 'startContinuable'): boolean => {
    try {
      return typeof (service as SubagentsService | undefined)?.[name] === 'function'
    } catch {
      return false
    }
  }
  if (read('startActivation')) return 'startActivation'
  if (read('startContinuable')) return 'startContinuable'
  return 'none'
}

/**
 * Build the adapter for the mounted service.
 *
 * The mapping between the two shapes is deliberate and minimal:
 *  - `delivery: 'parent'` is the new explicit form of what `startContinuable` always did: the child is
 *    a continuable child of this parent (its result notifies the model, and the parent keeps the
 *    handle for a later `sendMessage` wake). `childId` is the reserved claim id in both shapes, and it
 *    is also what selects the continuable/`prepareContinuable` path on the new shape.
 *  - `toolFilter` has no equivalent in the new shape; passing it would be silently ignored (the new
 *    start path never reads it), and the new host's own guidance is an Agent Preset. The trade is
 *    recorded once by the caller (`carriesToolFilter`), not silently claimed.
 *
 * @param service - the live `ctx.subagents`.
 * @returns the adapter; `shape` is `none` when neither method is callable.
 */
export function createStartAdapter(service: unknown): StartAdapter {
  const shape = detectStartShape(service)
  /** Read the bound method for the detected shape on every call: the service may finish binding after
   *  the plugin's apply (a host that mounts it later), and a captured function would freeze the empty
   *  answer. */
  const methodOf = (): AnyFunction | undefined => {
    if (shape === 'none') return undefined
    return (service as SubagentsService | undefined)?.[shape]
  }
  return {
    shape,
    carriesToolFilter: shape === 'startContinuable',
    async start(request: StartRequest): Promise<StartOutcome> {
      const method = methodOf()
      if (typeof method !== 'function') throw new Error(NO_START_METHOD)
      const call = method as (this: unknown, spec: unknown) => Promise<unknown>
      const requestBody = {
        prompt: request.prompt,
        parent: request.parent,
        // An empty deny list would be a materialized-empty mistake: omit it. Only sent where the shape
        // reads it (`startContinuable`); the new shape would ignore it, so sending it would imply a
        // restriction the host never applied.
        ...request.deny.length === 0 || shape !== 'startContinuable' ? {} : { toolFilter: { deny: [...request.deny] } },
      }
      const spec = shape === 'startActivation'
        ? {
            provider: request.provider,
            label: request.label,
            childId: request.childId,
            request: requestBody,
            signal: request.signal,
            // The continuable child of THIS parent: result notifies the model and a later sendMessage
            // reaches the same durable child — the semantics `startContinuable` had implicitly.
            delivery: 'parent' as const,
          }
        : {
            provider: request.provider,
            label: request.label,
            childId: request.childId,
            request: requestBody,
            signal: request.signal,
          }
      const started = await call.call(service, spec) as { childId?: unknown; messageId?: unknown }
      return {
        childId: typeof started.childId === 'string' ? started.childId : request.childId,
        ...typeof started.messageId === 'string' ? { messageId: started.messageId } : {},
      }
    },
  }
}
