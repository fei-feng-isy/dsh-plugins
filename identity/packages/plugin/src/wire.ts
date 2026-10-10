/**
 * Hand-written Typert wire faces (host and client): the generator only runs inside the harness
 * workspace, and both halves import this one module so the two faces cannot drift.
 * @module @avantf/dsh-identity/wire
 */
// Namespace import, not `import { z }`: a named import of `z` drags zod's whole locale namespace into
// the browser bundle (the same trap the sibling trees measured — 264 KB of the ~535 KB bundle). The
// type is pulled separately so it costs nothing at runtime.
import * as z from 'zod'
import type { ZodType } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

export const PACKAGE = '@avantf/dsh-identity'

/** The Cordis service key that doubles as the Remote namespace. */
export const NAMESPACE = 'avantfIdentity'

/**
 * One `strict` codec: the schema plus the symbol the generator would name.
 *
 * Carries BOTH members on purpose. The host's validator moved from `codec.schema.parse` (dsh 0.1.5) to
 * `codec.create()` (0.1.6), and each generation checks only its own — so a codec missing one of them
 * makes a healthy host read as an incompatible one, and the failure shows up as a REFUSED mount rather
 * than as a missing neighbour.
 */
function strict(schema: ZodType, typeSymbol: string): {
  mode: 'strict'
  typeSymbol: string
  schema: ZodType
  create: () => ZodType
} {
  return { mode: 'strict', typeSymbol, schema, create: () => schema }
}

const endpointId = (method: string): string => `${PACKAGE}#${NAMESPACE}/${method}`
const fieldSymbol = (method: string, field: string): string => `${PACKAGE}#${NAMESPACE}/${method}:${field}`

/**
 * One direct Remote method carrying a single `args` object parameter.
 *
 * The mirror of `mem/packages/plugin/src/remote.ts`'s `direct`, and kept LOCAL for the same reason: the
 * wire face is built at module load and must exist even when the base cannot be loaded at all, so its
 * construction may not depend on a runtime `import()` of the base. Changing this convention therefore
 * takes a plugin release — a deliberate, recorded trade (root `AGENTS.md`, "共享逻辑").
 *
 * `result` stays `z.any()`: a result codec that rejected a host reply would blank the panel, and the
 * per-method result SCHEMAS declared below are what the registry and the compatibility gate project.
 */
function direct(method: string, args: ZodType): InvocationDescriptor {
  return {
    id: endpointId(method),
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'args', wire: 'args', source: 'json', codec: strict(args, fieldSymbol(method, 'args')) }],
    result: strict(z.any(), fieldSymbol(method, 'result')),
  } as unknown as InvocationDescriptor
}

/**
 * One direct Remote method with NO parameters at all.
 *
 * A method whose host signature takes nothing (`listPresets()`, `readProfile()`) must declare nothing
 * either. Declaring an empty `args` parameter made every call fail with `gateway/arguments-invalid`:
 * the gateway prefers the descriptor derived from the HOST METHOD'S SIGNATURE for that endpoint, whose
 * `parameters` is `[]`, and the extra `args` key the client sent was then rejected as
 * `unexpected "args"`. Measured on the live profile; `status(args)` was unaffected, which is what
 * pointed at the difference.
 */
function directNoArgs(method: string): InvocationDescriptor {
  return {
    id: endpointId(method),
    service: NAMESPACE,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: [],
    result: strict(z.any(), fieldSymbol(method, 'result')),
  } as unknown as InvocationDescriptor
}

// Optional wire fields are written as `X.optional()`, NOT `z.union([z.undefined(), X])`: the two accept
// the same payloads, but the union makes the HOST's JSON-Schema projector throw, and the startup
// compatibility gate projects the real wire face through it — a healthy host then reads as an
// incompatible one.
const optionalText = z.string().optional()
const text = z.string()

/** The methods the browser half may call; every field it sends must be declared here. */
export const descriptors: readonly InvocationDescriptor[] = [
  direct('status', z.object({ locale: optionalText })),
  directNoArgs('listPresets'),
  directNoArgs('readProfile'),
  direct('writeProfileFile', z.object({ name: text, text: text })),
  direct('applyPreset', z.object({ id: text, locale: optionalText })),
  direct('saveAsPreset', z.object({ id: text, locale: optionalText })),
  direct('readPreset', z.object({ id: text, locale: optionalText })),
  direct('writePresetFile', z.object({ id: text, name: text, text: text, locale: optionalText })),
  direct('deletePreset', z.object({ id: text })),
]

/** One identity file on the wire. */
const fileTextSchema = z.object({
  name: text,
  file: text,
  text: text,
  present: z.boolean(),
  bytes: z.number(),
})

/** One identity file's status on the wire (no text: the page reads text on demand). */
const fileStatusSchema = z.object({
  name: text,
  file: text,
  path: text,
  present: z.boolean(),
  bytes: z.number(),
})

/** One preset in the library list. */
const presetSummarySchema = z.object({
  id: text,
  locales: z.array(text),
  active: z.boolean(),
})

/**
 * The settings page's ONE entry point: everything the header renders, so a page load is one call.
 * Every field is declared — a strict codec drops what it does not name.
 */
export const statusResultSchema = z.object({
  enabled: z.boolean(),
  profile: text,
  dataHome: text,
  identityDir: text,
  presetsDir: text,
  fileCount: z.number(),
  totalBytes: z.number(),
  maxBytes: z.number(),
  interpolate: z.boolean(),
  replaceScope: text,
  drop: z.array(text),
  fallbackToNative: z.boolean(),
  activePreset: text,
  activeLocale: text,
  locale: text,
  localeSource: text,
  files: z.array(fileStatusSchema),
  presets: z.array(presetSummarySchema),
})

export const profileResultSchema = z.object({
  profile: text,
  identityDir: text,
  totalBytes: z.number(),
  files: z.array(fileTextSchema),
})

export const presetResultSchema = z.object({
  found: z.boolean(),
  id: text,
  requestedLocale: text,
  resolvedLocale: text,
  fellBack: z.boolean(),
  files: z.array(fileTextSchema),
})

/** The answer to every write/delete action: `ok`, plus what the page needs to explain a refusal. */
export const writeResultSchema = z.object({
  ok: z.boolean(),
  error: optionalText,
  resolvedLocale: optionalText,
  fellBack: z.boolean().optional(),
  files: z.array(text).optional(),
})

/** The names the registry (and the compatibility gate's schema probe) sees. */
interface DeclaredSchema {
  readonly name: string
  readonly schema: ZodType
  readonly create: () => ZodType
}

const declaredSchemas: DeclaredSchema[] = []
const declare = (name: string, schema: ZodType): DeclaredSchema => ({ name, schema, create: () => schema })

declaredSchemas.push(
  declare('statusargs', z.object({ locale: optionalText })),
  declare('statusResult', statusResultSchema),
  declare('profileResult', profileResultSchema),
  declare('writeProfileFileargs', z.object({ name: text, text: text })),
  declare('writeResult', writeResultSchema),
  declare('applyPresetargs', z.object({ id: text, locale: optionalText })),
  declare('saveAsPresetargs', z.object({ id: text, locale: optionalText })),
  declare('readPresetargs', z.object({ id: text, locale: optionalText })),
  declare('presetResult', presetResultSchema),
  declare('writePresetFileargs', z.object({ id: text, name: text, text: text, locale: optionalText })),
  declare('deletePresetargs', z.object({ id: text })),
)

const model = {
  services: [
    {
      key: NAMESPACE,
      exportName: NAMESPACE,
      description: 'Identity files: the profile identity, its built-in/edited presets, and the replacement switch',
      summary: 'avantf-identity identity files',
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
