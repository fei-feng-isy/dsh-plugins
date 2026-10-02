/**
 * zod → DSH parameter schema derivation for the agent tools.
 *
 * Deliberately free of `@deepseek-ai/*` imports: everything it needs — the contract's tool
 * specs, hence the zod schemas — comes from `@avantf/mem-contract`, so this module can be read
 * and exercised without a harness checkout or an installed `dsh`.
 *
 * Two things keep this honest across a zod upgrade. First, the field-level mapping goes through
 * zod's OWN converter (`z.toJSONSchema`, the same one the contract's MCP derivation uses)
 * instead of reading `typeName`/`checks`/`shape` by hand, so there is one mechanism and not two
 * hand-rolled ones. Second, only the union/object structure is read off the internals
 * (`def.options` / `def.shape` / a literal's `def.values`) — and a wrong internal read degrades
 * SILENTLY: every field would flatten to `{type:'string'}` and no type error would appear, which
 * is why the derived shape is asserted by the test suite rather than eyeballed.
 */
import { z } from 'zod'
import { mergedFieldDescription, type ToolSpec } from '@avantf/mem-contract'

type ParamSpec = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  required?: true
  enum?: readonly string[]
  items?: ParamSpec
}

/** The slice of zod v4's `def` this derivation reads (structure only, never type tags). */
interface ZodDef {
  type?: string
  shape?: Record<string, unknown>
  options?: unknown[]
  /** A literal's / enum's values; v4 keeps them in an array. */
  values?: unknown
}

function zodDef(schema: unknown): ZodDef {
  return (schema as { def?: ZodDef } | undefined)?.def ?? {}
}

/**
 * One field as JSON Schema, or `undefined` when `schema` is not a zod schema at all.
 *
 * `io: 'input'` matches how these schemas are actually used (arguments coming IN), and
 * `unrepresentable: 'any'` turns a future unrepresentable schema into a permissive object
 * instead of a throw at import time.
 */
function jsonSchemaOf(schema: unknown): Record<string, unknown> | undefined {
  if (typeof (schema as { safeParse?: unknown } | undefined)?.safeParse !== 'function') return undefined
  try {
    return z.toJSONSchema(schema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Nearest `description` on a schema (wrappers included — the converter already unwrapped them). */
export function schemaDescription(schema: unknown): string | undefined {
  const description = jsonSchemaOf(schema)?.['description']
  return typeof description === 'string' && description.length > 0 ? description : undefined
}

/** JSON Schema → DSH parameter spec. Recurses on `items`, which is itself JSON Schema. */
function jsonToSpec(js: Record<string, unknown>): ParamSpec {
  const type = js['type']
  let spec: ParamSpec
  if (type === 'integer') spec = { type: 'integer' }
  else if (type === 'number') spec = { type: 'number' }
  else if (type === 'boolean') spec = { type: 'boolean' }
  else if (type === 'array') spec = { type: 'array', items: jsonToSpec((js['items'] as Record<string, unknown> | undefined) ?? {}) }
  else if (type === 'object') spec = { type: 'object' }
  else if (Array.isArray(js['enum'])) spec = { type: 'string', enum: (js['enum'] as unknown[]).map(String) }
  // A string literal arrives as `const`, not `enum`: keep the old shape (`enum: [value]`).
  else if (typeof js['const'] === 'string') spec = { type: 'string', enum: [js['const']] }
  else if (typeof js['const'] === 'number') spec = { type: 'number' }
  else if (typeof js['const'] === 'boolean') spec = { type: 'boolean' }
  else spec = { type: 'string' }
  const description = js['description']
  return typeof description === 'string' && description.length > 0 ? { ...spec, description } : spec
}

export function zodToSpec(schema: unknown): ParamSpec {
  return jsonToSpec(jsonSchemaOf(schema) ?? {})
}

/** Materialize one zod object branch's fields, or undefined for a non-object. */
function branchShape(schema: unknown): Record<string, unknown> | undefined {
  return zodDef(schema).shape
}

/**
 * Flatten a tool input schema into DSH's implicit parameter map. A discriminated
 * union contributes one required `action` enum plus the merged field set (fields
 * stay optional at the schema level because requiredness differs per action; the
 * per-action requirement is stated in each field's description and enforced by
 * `spec.input` validation before dispatch). A plain object marks its own required
 * fields directly.
 *
 * The merged descriptions come from the contract's {@link mergedFieldDescription}, the SAME
 * function `toolInputJsonSchema` uses for the MCP surface. Taking each field's first branch
 * verbatim is what made the two model-facing surfaces disagree: `mem_admin`'s `fact_id` said
 * "action=detail 时必填" on this surface while the MCP schema said
 * "【detail/archive/restore/pin/unpin 必填】" — so a model calling `archive` without it had to
 * learn the requirement from a `violations` retry. Both surfaces now read the same merged
 * descriptions, which is what keeps them in agreement field for field.
 */
export function flattenToolSpec(spec: ToolSpec): Record<string, ParamSpec> {
  const input = spec.input as unknown
  const def = zodDef(input)
  const properties: Record<string, ParamSpec> = {}
  let actions: string[] = []

  if (Array.isArray(def.options)) {
    // The union's fields are declared one branch at a time, so a field's real action set is the
    // union over the branches that require it — collected here, applied below.
    const requiredIn = new Map<string, string[]>()
    for (const branch of def.options) {
      const shape = branchShape(branch)
      if (shape === undefined) continue
      const actionSchema = shape['action']
      const literal = actionSchema === undefined ? undefined : (zodDef(actionSchema).values as unknown[] | undefined)?.[0]
      const action = typeof literal === 'string' ? literal : undefined
      if (action !== undefined && !actions.includes(action)) actions = [...actions, action]
      for (const [key, fieldSchema] of Object.entries(shape)) {
        if (key === 'action') continue
        if (properties[key] === undefined) properties[key] = zodToSpec(fieldSchema)
        if (action === undefined) continue
        const optional = (fieldSchema as { isOptional?: () => boolean }).isOptional?.() ?? false
        if (!optional) requiredIn.set(key, [...(requiredIn.get(key) ?? []), action])
      }
    }
    for (const [key, paramSpec] of Object.entries(properties)) {
      const description = mergedFieldDescription(paramSpec.description, requiredIn.get(key) ?? [])
      properties[key] = description === undefined ? paramSpec : { ...paramSpec, description }
    }
  } else {
    const shape = branchShape(input)
    if (shape !== undefined) {
      for (const [key, fieldSchema] of Object.entries(shape)) {
        const paramSpec = zodToSpec(fieldSchema)
        const optional = (fieldSchema as { isOptional?: () => boolean }).isOptional?.() ?? false
        properties[key] = optional ? paramSpec : { ...paramSpec, required: true }
      }
    }
  }

  if (actions.length > 0) {
    properties['action'] = {
      type: 'string',
      required: true,
      enum: actions,
      description: `要执行的操作，取值：${actions.join(' | ')}。每个操作需要哪些字段见各字段说明。`,
    }
  }
  return properties
}
