/**
 * Where the plugin gets its well-formed repair from — base kit first, local copy as the degradation.
 *
 * The repair itself (lone surrogates → U+FFFD) is the family's single worst serialization defect and
 * is documented in full in the core's `wellformed.ts`; this module only decides WHICH implementation
 * the plugin uses:
 *
 *  - if the base module the inlined bootstrap loaded carries BOTH `wellFormedText` and
 *    `wellFormedDeep` (interface v2), those are used — the canonical implementation, fixable with one
 *    base release per the root `AGENTS.md`;
 *  - otherwise (base absent, or older than v2) the plugin uses the core's local copy,
 *    `LOCAL_WELL_FORMED`. That is a documented DEGRADATION, never a refusal: the plugin mounts in
 *    full and still repairs every model-visible boundary.
 *
 * The judgement is deliberately "is this FUNCTION present", NOT "what interface generation is this".
 * A base that carries the two members is usable whatever it calls itself, and a base that does not
 * is a fallback — the runtime interface gate elsewhere in `envinit.ts` owns the generation question,
 * and its own outcome (no kit at all) reaches here as `undefined`, which this function degrades.
 *
 * Nothing here imports the base: the kit arrives as an argument, taken off the module the bootstrap
 * loaded at runtime (see the module note in `src/envinit.ts` and root `AGENTS.md`).
 *
 * @module @avantf/dsh-mission/wellformed
 */
import { LOCAL_WELL_FORMED, type WellFormedSource } from '@avantf/mission-core'

/**
 * The slice of the loaded base kit this decision needs. Both members are optional because the point
 * of the runtime check is that a base older than interface v2 simply does not have them.
 */
export interface WellFormedKit {
  readonly wellFormedText?: unknown
  readonly wellFormedDeep?: unknown
}

/**
 * Take the repair pair off the loaded base kit, or fall back to the local copy.
 *
 * Both members must be functions to count as "the base provides it": a half-populated module is not
 * a usable source, and mixing one half from the base with one half locally could give two different
 * answers to the same question. The fallback is total — this never throws and never returns
 * `undefined`.
 */
export function resolveWellFormed(kit: WellFormedKit | undefined): WellFormedSource {
  const text = kit?.wellFormedText
  const deep = kit?.wellFormedDeep
  if (typeof text === 'function' && typeof deep === 'function') {
    return {
      text: text as WellFormedSource['text'],
      deep: deep as WellFormedSource['deep'],
    }
  }
  return LOCAL_WELL_FORMED
}
