/**
 * Hand-written Typert wire faces (host and client): the generator only runs inside the
 * harness workspace, and both halves import this one module so the two faces cannot drift.
 * @module @avantf/dsh-mission/wire
 */
import { z, type ZodType } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

export const PACKAGE = '@avantf/dsh-mission'

/** The Cordis service key that doubles as the Remote namespace. */
export const NAMESPACE = 'avantfMission'

/**
 * One `strict` codec: the schema plus the symbol the generator would name.
 *
 * Carries BOTH members on purpose. The host's validator moved from `codec.schema.parse` (dsh 0.1.5)
 * to `codec.create()` (0.1.6), and each generation checks only its own — so a codec missing one of
 * them makes a healthy host read as an incompatible one, and the failure shows up as a REFUSED mount
 * rather than as a missing neighbour. The memory plugin (@avantf/dsh-mem) carries the same pair; it
 * was measured there first, and this copy had drifted.
 */
function strict(schema: ZodType, typeSymbol: string): {
  mode: 'strict'
  typeSymbol: string
  schema: ZodType
  create: () => ZodType
} {
  return { mode: 'strict', typeSymbol, schema, create: () => schema }
}

/** Assemble one descriptor; `parameters` entries are ordered wire fields named after them. */
function direct(
  method: string,
  args: ZodType,
  parameters: readonly { name: string; schema: ZodType; acceptsUndefined?: true }[] = [],
  options: { readonly stream?: true } = {},
): InvocationDescriptor {
  const base = `${PACKAGE}#${NAMESPACE}/${method}`
  return {
    id: base,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    // A stream method takes the transport's cancellation signal as its final Host
    // parameter (never a wire arg), the way the harness's `session/control` does.
    ...options.stream === true
      ? { mode: 'stream' as const, cancellation: { parameter: 'signal' as const } }
      : {},
    invocation: { kind: 'direct' },
    parameters: [
      { name: 'args', wire: 'args', source: 'json' as const, codec: strict(args, `${base}:args`) },
      ...parameters.map((parameter) => ({
        name: parameter.name,
        wire: parameter.name,
        source: 'json' as const,
        codec: strict(parameter.schema, `${base}:${parameter.name}`),
        ...parameter.acceptsUndefined === undefined ? {} : { acceptsUndefined: parameter.acceptsUndefined },
      })),
    ],
    result: strict(z.any(), `${base}:result`),
  } as unknown as InvocationDescriptor
}

/** Wire schemas by contribution name, kept beside the descriptors because a descriptor's codec is opaque. */
/**
 * Declared structurally, not imported: the registry's model type differs between the
 * harness checkout (types) and the published package (runtime), and this plugin runs
 * against both.
 */
interface DeclaredSchema {
  readonly name: string
  readonly schema: ZodType
  /** Materialize the schema, as the registry's factory contract requires. */
  readonly create: () => ZodType
}

const declaredSchemas: DeclaredSchema[] = []

function declare(name: string, schema: ZodType): DeclaredSchema {
  return { name, schema, create: () => schema }
}

/**
 * Why a node is queued instead of running (see `@avantf/mission-core`'s `WaitingFor`). `.nullable()`
 * with a `.default(null)` so an older host that omits it reads as "nothing is holding it back".
 */
const waitingForSchema = z.object({
  reason: z.enum(['capacity', 'unit', 'slot']),
  resource: z.enum(['cpu', 'memory']).optional(),
  needed: z.number().optional(),
  available: z.number().optional(),
  unit: z.string().optional(),
})

/**
 * One node as the summary wire carries it — the row projection. No `description`: rows
 * do not render it and this schema is re-sent on every engine change.
 */
const nodeSchema = z.object({
  id: z.string(),
  /** Born-under parent; `children` is the dependency edge. */
  parentId: z.string().nullable(),
  children: z.array(z.string()),
  depth: z.number(),
  title: z.string(),
  context: z.array(z.string()),
  // In the row projection on purpose: a row marks a steered mission, because the title it renders is
  // the goal as created and a correction is the only thing explaining a differing result.
  corrections: z.array(z.string()),
  status: z.string(),
  attempts: z.number(),
  createdAt: z.number(),
  hasResult: z.boolean(),
  resultRef: z.string().nullable(),
  // The LAST session that ran this node — what the node-id entry opens. DECLARED here on purpose: a
  // `strict` codec DROPS keys it does not name, so a field the host added and this schema forgot would
  // vanish between the two halves — the failure this plugin has already paid for once. `.default(null)`
  // rather than a plain required field: an OLDER host simply omits it, and "no executor to open" is the
  // right reading of that payload, where failing the whole snapshot read would blank a panel that is
  // otherwise fine (`corrections` is required because its absence would crash the render; this one only
  // removes a link).
  workerSessionId: z.string().nullable().default(null),
  /** Whether that session is still running (`.default(false)`: absent on an older host), so the
   *  node-id link can say 进行中 rather than 已结束. */
  workerLive: z.boolean().default(false),
  /** Declared capacity weight; an older host omits it and the default 1 is the honest reading. */
  weight: z.number().default(1),
  /** Why the engine has not dispatched this node; `null` = nothing is holding it back. */
  waitingFor: waitingForSchema.nullable().default(null),
})

const treeSchema = z.object({
  rootId: z.string(),
  nodes: z.array(nodeSchema),
  closedAt: z.number().nullable(),
})

/**
 * The wire surface: `snapshot` the summary, `detail` one node's full record, `result` the FULL text
 * behind a spilled one (on demand — a reader asks for it, the panel never prefetches it), `delete`
 * one finished tree, `watch` a revision on every change (the engine pushing, not polling), and
 * `resolveExecutorSession` the CLICK-TIME lookup of a historical node's executor session (W18 — it
 * reads session logs, so it is deliberately NOT part of any render path).
 * Every method carries a session id because a Remote invocation has no caller identity.
 */
export const descriptors: readonly InvocationDescriptor[] = [
  direct('snapshot', z.object({ sessionId: z.string().optional() })),
  direct('detail', z.object({ sessionId: z.string().optional(), nodeId: z.string() })),
  direct('result', z.object({ sessionId: z.string().optional(), nodeId: z.string() })),
  direct('delete', z.object({ sessionId: z.string().optional(), rootId: z.string() })),
  direct('resolveExecutorSession', z.object({ sessionId: z.string().optional(), nodeId: z.string() })),
  direct('watch', z.object({ sessionId: z.string().optional() }), [], { stream: true }),
]

/**
 * The `snapshot` result, mirrored by the client-side contract.
 *
 * THE VERSION FIELD. `snapshot` is the panel's ONE entry point (every other call is on demand behind a
 * click), so the version marker lives here and nowhere else: one number that tells the browser half
 * which host it is talking to, without adding a field to every method's arguments.
 *
 * `wire` is a plain optional number, NOT `z.literal(...)`: an unrecognized revision has to reach the
 * client as a HINT (`client/api.ts` compares it against `SNAPSHOT_WIRE_VERSION`), and a literal would
 * make `safeParse` fail and blank the whole panel — exactly the degradation the marker exists to
 * avoid. Absent means "an older host that predates the marker": still readable, with a hint.
 *
 * WHY ADDING A REMOTE **MUST** BUMP THIS. The marker only pays for itself if it tracks the SET OF
 * METHODS the host publishes, not the shape of one payload. The two halves of this plugin do not
 * update together — the browser bundle is re-read on every page load, the host half only when `dsh
 * web` starts — so a rebuilt client routinely talks to a host process loaded before the new method
 * existed. The gateway answers a method that host never published with an HTTP 404, which reads
 * exactly like "the mission or the file is gone" (measured: clicking the historical node `059f56ed`).
 * A bumped revision is what lets the client refuse to make that call at all (`client/api.ts` gates
 * the click-time lookup on {@link EXECUTOR_LOOKUP_WIRE_VERSION}). Bump on every added/removed
 * `@Remote` method; do NOT bump for a new optional FIELD, which a `.default(...)`-carrying schema
 * already absorbs across the gap.
 *
 * Revision history:
 * - 1: `snapshot` / `detail` / `result` / `delete` / `watch`.
 * - 2: `resolveExecutorSession` added (W18) — it shipped WITHOUT this bump, which is the defect the
 *   revision repairs.
 */
export const SNAPSHOT_WIRE_VERSION = 2

/**
 * The wire revision that FIRST carried `resolveExecutorSession`. A host reporting less than this — or
 * reporting no `wire` at all, i.e. one older than the marker — has never registered the method, so
 * `fetchExecutorSession` refuses to SEND the call and says that restarting dsh fixes it. Kept here
 * beside {@link SNAPSHOT_WIRE_VERSION} so the two revisions are read together; the current client
 * advertises the newer one.
 */
export const EXECUTOR_LOOKUP_WIRE_VERSION = 2

export const snapshotResultSchema = z.object({
  wire: z.number().optional(),
  trees: z.array(treeSchema),
})

/**
 * One node's full result: the text plus, when it could not be read back, the reason. A failure is a
 * message rather than a thrown error for the same reason `delete`'s is — "the locator is not a file
 * this host can read" is an answer the pane has to be able to show beside the locator it keeps.
 */
export const resultTextSchema = z.object({
  text: z.string(),
  error: z.string().optional(),
})

/**
 * The ids that went away, or why none did: `error` is a message, not a thrown failure,
 * because "this mission is still running" is an answer the button should be able to show.
 */
export const deleteResultSchema = z.object({
  deleted: z.array(z.string()),
  error: z.string().optional(),
})

const detailNodeSchema = z.object({
  id: z.string(),
  rootId: z.string(),
  title: z.string(),
  description: z.string(),
  context: z.array(z.string()),
  /** The owner's corrections, newest last — the direction changes this mission was given. */
  corrections: z.array(z.string()),
  // Carried so the wire shape matches the host's `NodeDetail`; a strict codec rejects extras.
  analysisNotes: z.array(z.string()),
  analysisAttempt: z.number(),
  status: z.string(),
  attempts: z.number(),
  depth: z.number(),
  /** Submitted conclusion, when there is one (inline; a long one is truncated). */
  result: z.string().nullable(),
  /** Where a spilled full result lives, already joined with its retrieval hint. */
  resultPointer: z.string().nullable(),
  /** The session that ran this node LAST; `null` (or, from an older host, absent) means none ever did. */
  workerSessionId: z.string().nullable().default(null),
  /** Whether that session is still running, so the link can say 进行中 / 已结束. `.default(false)`
   *  for the same reason as the id: an older host omits it, and "a stopped session" is the honest
   *  reading of a payload that cannot say otherwise. */
  workerLive: z.boolean().default(false),
  /** Declared capacity weight; older host → default 1. */
  weight: z.number().default(1),
  /** Why this node is queued; `null` = nothing holding it back. */
  waitingFor: waitingForSchema.nullable().default(null),
})

export const detailResultSchema = z.object({
  node: detailNodeSchema.optional(),
  /** The results the node's own sub-missions submitted — what an aggregate consumed. */
  children: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    result: z.string().nullable(),
    resultPointer: z.string().nullable(),
  })),
  error: z.string().optional(),
})

/**
 * What a click-time executor lookup answered. `sessionId` is present only when the lookup RESOLVED
 * one; `status` names the three ways it did not, and `error` carries the host's own words when they
 * vary ("sessionQuery is not mounted", "reading the session list failed"). Absent `status` is the
 * one backward-compatible reading: an OLDER host (one that predates this method) has no such reply
 * at all, so the client says "the two halves are out of step" rather than guessing a reason.
 */
export const executorSessionResultSchema = z.object({
  sessionId: z.string().optional(),
  status: z.enum(['resolved', 'never-dispatched', 'not-found', 'unsupported']).optional(),
  error: z.string().optional(),
})

/** One `watch` frame: only a revision, never the tree. */
export const watchFrameSchema = z.object({ revision: z.number() })

declaredSchemas.push(
  declare('snapshotargs', z.object({ sessionId: z.string().optional() })),
  declare('snapshotResult', snapshotResultSchema),
  declare('deleteargs', z.object({ sessionId: z.string().optional(), rootId: z.string() })),
  declare('deleteResult', deleteResultSchema),
  declare('detailargs', z.object({ sessionId: z.string().optional(), nodeId: z.string() })),
  declare('detailResult', detailResultSchema),
  declare('resultargs', z.object({ sessionId: z.string().optional(), nodeId: z.string() })),
  declare('resultText', resultTextSchema),
  declare('resolveExecutorSessionargs', z.object({ sessionId: z.string().optional(), nodeId: z.string() })),
  declare('executorSessionResult', executorSessionResultSchema),
  declare('watchargs', z.object({ sessionId: z.string().optional() })),
  declare('watchFrame', watchFrameSchema),
)

const model = {
  services: [
    {
      key: NAMESPACE,
      exportName: NAMESPACE,
      description: 'Work-tree engine: the trees one session owns, their nodes and statuses',
      summary: 'avantf-mission mission tree',
      tags: [] as string[],
      members: [] as string[],
      types: [] as string[],
    },
  ],
  // Empty on purpose, but declared: the client mount reads every field of the model.
  events: [] as string[],
  objects: [] as string[],
}

/** The host face: schemas plus the service model, registered through `ctx.typert.register()`. */
export const hostContribution = {
  package: PACKAGE,
  face: 'host',
  schemas: declaredSchemas,
  model,
  invocations: descriptors,
} as never

/** The client face: the same descriptors, mounted through `ctx.remote.$mount()`. */
export const clientContribution = {
  package: PACKAGE,
  descriptors,
} as never

export { snapshotResultSchema as resultSchema }
