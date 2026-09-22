/**
 * Typert wire conventions shared by the family's plugins.
 *
 * A DSH plugin's Remote face is hand-written here (the Typert generator runs only inside the harness
 * workspace), and both plugins independently arrived at the same conventions. The GENERATOR-level
 * parts live here once; the descriptor assembly stays per plugin because the two really differ (the
 * work engine adds `stream`/cancellation methods, the memory plugin has a `parameter()` helper with
 * `acceptsUndefined`). Only the genuinely identical part is hoisted — a fake abstraction with a bag
 * of switches would be worse than the duplication it removes.
 *
 * The type-symbol convention is `<package>#<namespace>/<method>:<field>`; the probe, the runtime
 * registry and the report all key off it, so it must not drift between the two plugins.
 *
 * @module @avantf/dsh-plugin-base/kit/typert
 */
import type { ZodType } from 'zod'

/**
 * One `strict` codec: the schema plus the symbol the generator would name.
 *
 * Carries BOTH members on purpose. The host's validator moved from `codec.schema.parse` (dsh 0.1.5)
 * to `codec.create()` (0.1.6), and each generation checks only its own — so a codec missing one of
 * them makes a healthy host read as an incompatible one, and the failure shows up as a REFUSED mount
 * rather than as a missing neighbour. Measured on the memory plugin first; the work copy had drifted
 * to the one-member shape and was fixed to match. Do not "simplify" this back.
 */
export interface StrictCodec {
  readonly mode: 'strict'
  readonly typeSymbol: string
  readonly schema: ZodType
  readonly create: () => ZodType
}

/** Build one strict codec; `typeSymbol` is the `<package>#<namespace>/<method>:<field>` name. */
export function strictCodec(schema: ZodType, typeSymbol: string): StrictCodec {
  return { mode: 'strict', typeSymbol, schema, create: () => schema }
}

/** The invocation id of one method: `<package>#<namespace>/<method>`. */
export function endpointId(pkg: string, namespace: string, method: string): string {
  return `${pkg}#${namespace}/${method}`
}

/** The type symbol of one field of one method. */
export function fieldSymbol(pkg: string, namespace: string, method: string, field: string): string {
  return `${endpointId(pkg, namespace, method)}:${field}`
}

/** The type symbol of a method's result. */
export function resultSymbol(pkg: string, namespace: string, method: string): string {
  return fieldSymbol(pkg, namespace, method, 'result')
}
