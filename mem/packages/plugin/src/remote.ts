/**
 * Hand-written Typert wire faces for the `avantfMem` Remote namespace.
 *
 * DSH packages normally ship generator-produced faces (`typert.host.js` /
 * `typert.remote-client.js`), but the Typert generator runs only inside the
 * harness workspace. Both faces are therefore hand-written here, following the
 * generator's exact conventions: zod v4 strict codecs, one `args` object
 * parameter per method, `<pkg>#<namespace>/<method>` invocation ids, and a host
 * contribution registered through `ctx.typert.register()` (the documented
 * path for hand-written wire schemas, see `@deepseek-ai/dsh-typert-loader`).
 *
 * The five methods mirror the five agent tools (remember/recall/admin/kb/query)
 * so the 记忆/知识 tabs can do full CRUD + KB management. Args carry the merged
 * optional field set of the contract's action unions; the HOST re-validates
 * every payload with the contract zod schema before dispatch, so the wire face
 * only needs to guarantee JSON shape sanity. Five methods have no tool behind
 * them — `openDoc` (the 知识 tab's 「编辑」/「打开目录」 buttons), `classifySource`
 * and `browseDir` (its source input and 选择 picker), `kbDomains` (its domain
 * dropdown) and `kbAddDomain` (its 「+」 next to that dropdown).
 *
 * The host half consumes `hostContribution`; the client half mounts
 * `clientContribution` via `ctx.remote.$mount()`.
 */
import { z } from 'zod'
import type {
  InvocationDescriptor,
  InvocationParameterDescriptor,
  TypertCodec,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
// The application envelope shape the marker rides on; type-only, so the client bundle still pulls
// no contract runtime from here.
import type { RemoteErr, RemoteOk } from '@avantf/mem-contract'
// The registry package augments TypertRegistryContract (host register) from its
// main entry; import the module type so the augmentation joins the program.
import type {} from '@deepseek-ai/dsh-typert-registry'

const PACKAGE = '@avantf/dsh-mem'
const NAMESPACE = 'avantfMem'

const endpointId = (method: string): string => `${PACKAGE}#${NAMESPACE}/${method}`
const fieldSymbol = (method: string, field: string): string => `${PACKAGE}#${NAMESPACE}/${method}:${field}`
const resultSymbol = (method: string): string => fieldSymbol(method, 'result')

/**
 * zod v4 strict codec envelope the Typert boundary validates with.
 *
 * Carries BOTH members on purpose: the host's validator moved from `codec.schema.parse` (0.1.5) to
 * `codec.create()` (0.1.6), and each generation checks only its own. One shape therefore serves
 * either host.
 *
 * Kept LOCAL — a two-line mirror of the base kit's `strictCodec`, not a runtime call — on purpose:
 * the Remote face is built at module load and must exist even when the base cannot be loaded at all,
 * so its construction may not depend on a runtime `import()` of the base. This is the "mirrors a
 * convention, so changing it takes a plugin release" side of the rule in the root AGENTS.md; the
 * shared, fixable-by-a-base-release code lives in `@avantf/dsh-plugin-base`'s kit.
 */
function strict(schema: z.ZodType, typeSymbol: string): {
  mode: 'strict'
  typeSymbol: string
  schema: z.ZodType
  create: () => z.ZodType
} {
  return { mode: 'strict', typeSymbol, schema, create: () => schema }
}

/** One JSON wire parameter; optional parameters accept a missing wire field. */
function parameter(
  method: string,
  name: string,
  schema: z.ZodType,
  acceptsUndefined?: true,
): InvocationParameterDescriptor {
  return {
    name,
    wire: name,
    source: 'json',
    codec: strict(schema, fieldSymbol(method, name)),
    ...(acceptsUndefined === undefined ? {} : { acceptsUndefined }),
  }
}

const text = z.string()
// Optional wire fields are written as `X.optional()`, NOT `z.union([z.undefined(), X])`. The two
// accept the same payloads, but the union is invisible to the HOST's JSON-Schema projector:
// `z.toJSONSchema()` throws "Undefined cannot be represented in JSON Schema" over it, and the
// startup compatibility gate projects the REAL wire face through that host method — so the union
// form made a healthy host read as an incompatible one. `.optional()` projects to a non-required
// property, which is exactly what these fields are.
const count = z.number().int().optional()
const optionalText = z.string().optional()
const bool = z.boolean().optional()
const textArray = z.array(z.string()).optional()

/** One direct Remote method carrying a single `args` object parameter. */
function direct(method: string, args: z.ZodType): InvocationDescriptor {
  return {
    id: endpointId(method),
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: [parameter(method, 'args', args)],
    // The runtime's result shapes vary by store backend and evolve fast;
    // keep the boundary tolerant (`z.any()` never rejects a host reply).
    result: strict(z.any(), resultSymbol(method)),
  }
}

export const descriptors: readonly InvocationDescriptor[] = [
  // remember: add/update/remove/helpful/unhelpful (action defaults to 'add' host-side)
  direct('remember', z.object({
    action: optionalText.optional(),
    content: optionalText.optional(),
    fact_id: count.optional(),
    category: optionalText.optional(),
    ttl_days: count.optional(),
    reason: optionalText.optional(),
    // P-08 / P-13 (batch 1): optional write-side extras. Declared here because a strict codec drops
    // an undeclared key silently; NOT a wire bump — the BUMP RULE bumps only for a new/removed
    // `@Remote` method or a removed payload field the other half dereferences (see WIRE_VERSION).
    source_ref: optionalText.optional(),
    event_date: optionalText.optional(),
    valid_until: optionalText.optional(),
  })),
  // recall: search/ask/chain/probe/reason/related/contradict (defaults to 'search')
  direct('recall', z.object({
    action: optionalText.optional(),
    query: optionalText.optional(),
    entity: optionalText.optional(),
    entities: textArray.optional(),
    subj: optionalText.optional(),
    pred: optionalText.optional(),
    obj: optionalText.optional(),
    second_pred: optionalText.optional(),
    category: optionalText.optional(),
    // P-08: provenance filter (`fact_sources.ref`); P-01: per-leg evidence. Both optional and both
    // `declared ⊇ contract` fields (see `test/remote_wire.spec.ts`).
    source: optionalText.optional(),
    include_scores: bool.optional(),
    limit: count.optional(),
    max_tokens: count.optional(),
    // `strict` / `loose` (see `FLOOR_PROFILES`): the client's 查询 panel sends this when the user
    // switches to 宽松, and the contract validates the value host-side. Declared here because a
    // strict codec PARSES these args and a zod object drops an undeclared key silently.
    floors: optionalText.optional(),
  })),
  // admin: stats/list/detail/archive/restore/vectors_*/contradict_*/maintenance (defaults to 'list')
  //
  // Every field the client sends must be declared here: a strict codec PARSES the args before they
  // go out (harness `api/gateway` `parseInput`), and a zod object drops unknown keys — a missing
  // field is not an error, it is a silently emptied request that then fails contract validation
  // host-side. That is exactly how the three 矛盾裁决 buttons shipped broken: `contradiction_id`,
  // `resolution` and `loser_fact_id` were never declared, so only `{action}` reached the host.
  // `test/remote_wire.spec.ts` pins the invariant that actually generalises — declared ⊇ the
  // contract union's fields — because "declared ⊇ what the client source sends" has blind spots a
  // wrapper function (`kbCall(label, args)`) or a conditional spread hides.
  direct('admin', z.object({
    action: optionalText.optional(),
    fact_id: count.optional(),
    category: optionalText.optional(),
    status: optionalText.optional(),
    // P-08: reverse provenance lookup on `admin list`.
    source: optionalText.optional(),
    limit: count.optional(),
    offset: count.optional(),
    reason: optionalText.optional(),
    dry_run: bool.optional(),
    // `vectors_fix`: narrow the repair to one library (`memory` / `knowledge`); omitted = both.
    store: optionalText.optional(),
    contradiction_id: count.optional(),
    resolution: optionalText.optional(),
    loser_fact_id: count.optional(),
  })),
  // kb: ingest/import/list/detail/remove/reindex/sync (action REQUIRED — no safe default)
  //
  // `overwrite` is a field of THIS face only: the UI's 入库 form sends it after the user confirms
  // the collision dialog, and the CLI after `--overwrite`. It is deliberately NOT a field of
  // `KB_ADD_TOOL.input`, so the add-only mode cannot leak into the model's view.
  //
  // `adopt` is the 知识 tab's 「认领文件」 button: sync one document whose frontmatter was destroyed
  // by a whole-file overwrite, accepting the store's guess about which row it belongs to. It was
  // missing from this face, so the button sent `{action:'sync', doc_id}` and reported
  // 「认领完成：0 篇」 — the fourth field to ship silently undeclared.
  direct('kb', z.object({
    action: optionalText.optional(),
    text: optionalText.optional(),
    source_uri: optionalText.optional(),
    domain: optionalText.optional(),
    source: optionalText.optional(),
    title: optionalText.optional(),
    paths: textArray.optional(),
    doc_id: count.optional(),
    limit: count.optional(),
    offset: count.optional(),
    dry_run: bool.optional(),
    overwrite: bool.optional(),
    adopt: bool.optional(),
  })),
  // query: cross-store retrieval
  direct('query', z.object({
    query: text,
    kind: optionalText.optional(),
    domain: optionalText.optional(),
    source: optionalText.optional(),
    limit: count.optional(),
    max_tokens: count.optional(),
    // P-01: the 查询 panel asks for per-leg evidence explicitly; the default (absent) keeps the
    // envelope byte-identical for every other caller.
    include_scores: bool.optional(),
    // Same field as `recall`'s: the 查询 panel's 严格/宽松 control. See `FLOOR_PROFILES`.
    floors: optionalText.optional(),
  })),
  // classifySource / browseDir: UI-only. The 知识 tab has ONE source input, so the host has to say
  // what a string IS (URL / file / directory / missing / pasted text) and let the user browse for a
  // path — a browser can check `^https?://` and nothing else, and only the host may stat a path.
  direct('classifySource', z.object({ text: optionalText.optional() })),
  direct('browseDir', z.object({ path: optionalText.optional() })),
  // kbDomains: UI-only. The 知识 tab's domain control is a picker, and the two halves of its option
  // list — the configured `knowledge.domains` allowlist and the domains already in the library —
  // live host-side, so the client asks for the union instead of guessing it.
  direct('kbDomains', z.object({})),
  // kbAddDomain: UI-only (no agent tool mirrors it, deliberately — an autonomous writer is where
  // domain sprawl would come from). Appends the name to the store config's `domains` allowlist and
  // to the live set, and answers with the new catalog so the picker can select it.
  direct('kbAddDomain', z.object({ domain: text })),
  // openDoc: UI-only (no agent tool mirrors it) — hand one managed document file, or the
  // directory holding it, to the user's editor. The host resolves the path from `doc_id`, so the
  // client never supplies a path the host would have to trust.
  direct('openDoc', z.object({
    doc_id: count,
    target: optionalText.optional(),
  })),
]

/** Client face: mounted by the client half through `ctx.remote.$mount()`. */
export const clientContribution: TypertRemoteContribution = {
  package: PACKAGE,
  descriptors,
}

/**
 * The revision of the Remote FACE `descriptors` publishes.
 *
 * WHY THIS EXISTS. The two halves of this plugin do not update together: the browser bundle is
 * re-read on every page load, the host half only when `dsh web` starts. So a rebuilt client
 * routinely talks to a host process loaded before a method existed, and the gateway answers an
 * unpublished method with an HTTP 404 — which reads exactly like "the record or the file is gone",
 * the two things it does NOT mean. Mission paid this tuition with a measured 404
 * (`SNAPSHOT_WIRE_VERSION`); mem has the same skew with no marker at all. The host now stamps this
 * number onto every application envelope (see `wireOk`/`wireErr`), and the client half reads it back
 * (contract's `unwrapRemoteEnvelope`) so it can refuse to SEND a call the host cannot have, and say
 * "restart dsh web" instead of surfacing a bare 404.
 *
 * WHY THE ENVELOPE AND NOT ONE METHOD'S PAYLOAD. Mission's `snapshot` is the panel's one entry point,
 * so its marker rides that payload. mem has no such method: the 记忆 tab opens with `admin.list` and
 * the 知识 tab with `kb.list`/`kb.domains`, either can be first, and neither is mandatory. The one
 * object EVERY answer shares is the application envelope, so the revision rides there — same
 * guarantee, stamped in the one place every method already goes through (`wireOk`/`wireErr`).
 *
 * BUMP RULE. Bump on every added/removed `@Remote` method — the number tracks the SET of methods the
 * face publishes. Do NOT bump for a new optional FIELD: a `.default(...)`-carrying schema (and the
 * `acceptsUndefined` parameters) already absorb that across the gap. DO bump for a REMOVED payload
 * field that the other half dereferences — nothing absorbs a removal, and an old client still reading
 * it would render garbage (see revision 2). When you add a method, also declare
 * `export const <NAME>_WIRE_VERSION = <new value>` beside this constant and gate the client call on it
 * (`client/wire.ts` `hostSupports` / `staleHostText`), exactly as mission's
 * `EXECUTOR_LOOKUP_WIRE_VERSION` does.
 *
 * ABSENT MEANS OLD. An old host sends no `wire` at all; the client must treat that as "older than the
 * marker", never as a decode failure — the answer is still readable.
 *
 * Revision history:
 * - 1: the first marker. The face at this point is the ten methods in `descriptors`
 *   (remember / recall / admin / kb / query + openDoc / classifySource / browseDir / kbDomains /
 *   kbAddDomain), all of which predate the marker — so nothing is gated on revision 1; the mechanism
 *   exists for the NEXT method.
 * - 2: the rerank capability was removed (0.5.0). This changed NO `@Remote` method, but it removed the
 *   `rerank_used` / `rerank_fallback` / `rerank_truncated` fields from the retrieval-health payload
 *   that `admin.stats` answers — fields the client half dereferenced. A rebuilt client talking to an
 *   old host (or the reverse) therefore has to be reported as skew, not silently render `NaN`.
 */
export const WIRE_VERSION = 2

/**
 * The successful application envelope, with the wire revision stamped on.
 *
 * A helper rather than a literal at each return site (the shared `call` covers the five tool-backed
 * methods; the five UI-only methods return directly): "every answer carries the marker" is then a
 * property of the code, not of six copies staying in step. The result is structurally the contract's
 * `RemoteOk`.
 */
export function wireOk<T>(value: T): RemoteOk<T> {
  return { ok: true, value, wire: WIRE_VERSION }
}

/**
 * The failed application envelope, with the wire revision stamped on.
 *
 * Takes the failure body already built (`{ok:false, error}` / validation's `{ok:false,error,violations}`)
 * so the message and violations keep coming from their existing single sources.
 */
export function wireErr(failure: Omit<RemoteErr, 'wire'>): RemoteErr {
  return { ...failure, wire: WIRE_VERSION }
}

/**
 * One schema entry for the host registry.
 *
 * Declared STRUCTURALLY rather than by importing the registry's own type, because that type moved
 * under us: 0.1.5 has `TypertSchema{name, schema}` and 0.1.6+ has `TypertSchemaFactory{name, create}`
 * (0.1.7 dropped `TypertSchema` from the module altogether). Carrying BOTH members is what lets one
 * artifact register on either generation — 0.1.5 reads `schema`, 0.1.6+ calls `create()` — so the
 * shape is named here and the value is structurally assignable to either revision's entry type.
 */
interface DeclaredSchema {
  readonly name: string
  readonly schema: z.ZodType
  readonly create: () => z.ZodType
}

/** The zod schema a strict codec carries, whichever generation's codec type is in play. */
function codecSchema(codec: unknown): z.ZodType {
  // Our own `strict()` always puts `schema` on the value, so this is the local schema even when the
  // HOST's `TypertCodec` no longer names that member (0.1.7 removed it from the type; the value a
  // plugin builds still carries it, which is exactly what keeps 0.1.5 hosts validating).
  return (codec as { readonly schema: z.ZodType }).schema
}

/** Declare one registered wire schema: the factory 0.1.6+ calls, plus the schema 0.1.5 reads. */
function declared(name: string, schema: z.ZodType): DeclaredSchema {
  return { name, schema, create: () => schema }
}

/**
 * Host face: registered by the host half through `ctx.typert.register()`.
 *
 * The schema values are named `z.ZodType` — this package's own zod — not the registry's field type,
 * for two reasons. There are two PHYSICALLY different zod copies in play (the workspace catalog's and
 * the one inside the installed harness build), so no imported field type can be both correct and
 * stable; and the registry's field type is generation-specific (`TypertSchema['schema']` in 0.1.5,
 * `TypertSchemaFactory['create']`'s return in 0.1.6+, the name gone in 0.1.7), so naming it is what
 * broke this file's compilation on 0.1.7. The two copies are structurally identical, which is why the
 * declared entries stay assignable to whichever entry type the installed host declares.
 */
export const hostContribution: TypertContribution = {
  package: PACKAGE,
  face: 'host',
  schemas: descriptors.flatMap((descriptor): DeclaredSchema[] => [
    ...descriptor.parameters.map(parameter => declared(
      `${descriptor.method}${parameter.name}`,
      codecSchema((parameter.codec as Extract<TypertCodec, { mode: 'strict' }>)),
    )),
    declared(
      `${descriptor.method}Result`,
      codecSchema((descriptor.result as Extract<TypertCodec, { mode: 'strict' }>)),
    ),
  ]),
  model: {
    services: [
      {
        key: 'avantfMemory',
        exportName: 'avantfMemory',
        description: 'avantf-mem runtime facade: memory store, knowledge store, ingestion, lifecycle, cross-retrieval router',
        summary: 'avantf-mem engine runtime',
        tags: [],
        members: [],
        types: [],
      },
      {
        key: NAMESPACE,
        exportName: NAMESPACE,
        description: 'Client Remote namespace: remember / recall / admin / kb / query over the avantf-mem stores',
        summary: 'avantf-mem client remote',
        tags: [],
        members: descriptors.map(descriptor => ({
          kind: 'method',
          name: descriptor.method,
          signature: '(args: object) => Promise<unknown>',
        })),
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: descriptors,
}
