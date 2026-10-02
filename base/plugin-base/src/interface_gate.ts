/**
 * The RUNTIME interface gate — the decision half of the family's compatibility contract.
 *
 * `INTERFACE_VERSION` (see {@link INTERFACE_VERSION} in `./interface.js`) is the generation number of
 * the `.` surface; the plugins BAKE the generation they were built for into their artifact
 * (`lib/interface-version.json`, written by each tree's `scripts/link-envinit.mjs`) and, at startup,
 * compare it with the number the base they actually loaded reports. This module is that comparison.
 *
 * It lives in the BASE, not in each plugin, for the same reason the rest of the shared kit does
 * (root `AGENTS.md`: "can this knowledge be fixed by one base release?"): the verdict semantics are
 * now the family's MAIN contract, so a wrong direction, an unguarded property read or a thrown error
 * must be fixable with one base release, not two plugin rebuilds. The plugins keep only the
 * consumption: read their own bake through {@link readInterfaceRequirement}, call
 * {@link checkInterface}, and act on the verdict.
 *
 * Two properties are absolute, and both are why this is a pure function rather than a live check:
 *
 *  - **It never throws.** A gate that throws while deciding would reject a mount it is not allowed to
 *    reject. A module whose property access throws (the "hostile module" the plugins' loaders are
 *    built to survive) reads as "reports no INTERFACE_VERSION", i.e. `cannot-tell`.
 *  - **Only MISSING members are unsafe.** The two directions are NOT symmetric. A build that needs a
 *    generation the loaded base has not reached (`loaded < required`) may ask for members that do not
 *    exist — that is `incompatible`. A build that meets a NEWER base (`loaded > required`) is the
 *    family's safe case: a generation must not take away a member an older build CONSUMES. That case
 *    is `ok` + a `warning`, never a degradation — a new generation must not downgrade anyone, which is
 *    the whole point of the rule. "In range but another generation" is the one case `supportedRange`
 *    cannot see, so this gate must see it.
 *
 * The "does not take away a consumed member" premise is not prose: it is asserted mechanically where
 * the generations are declared, and the shape of the proof depends on the kind of transition:
 *
 *  - an ADDITIVE generation states `Vn extends Vn-1` and the snapshot gate checks the name superset
 *    (`v1 → v2`, INTERFACE.md §5);
 *  - a PRUNING generation (`v2 → v3`, INTERFACE.md §9) instead proves `Vn-1 = Vn ⊎ PRUNED` plus that
 *    every `PRUNED` name has zero consumers across the two plugin trees
 *    (`test/public-surface.spec.ts`), and `test/interface_gate.spec.ts` pins it against the real module.
 *
 * The `loaded > required` branch below is admissible ONLY while one of those proofs holds. A generation
 * that drops a name WITH a consumer would fail the pruning proof, and that is the signal it must not be
 * waved through as `ok`.
 *
 * @module @avantf/dsh-plugin-base/interface_gate
 */
import { readFileSync } from 'node:fs'

/**
 * The interface generation a plugin artifact was baked for — the base's side of the contract.
 *
 * `scripts/lib/interface-version.mjs` writes it beside the built entry; the base reads it back here
 * so both plugins share ONE reader (and ONE definition of "malformed", which is `undefined`).
 */
export interface InterfaceRequirement {
  /** The base package version the bake was taken from, so a diagnostic can name it. */
  readonly baseVersion: string
  /** The `INTERFACE_VERSION` of the base the artifact was built against. */
  readonly interfaceVersion: number
}

/**
 * What {@link checkInterface} decided.
 *
 * `ok` — both sides were readable and the loaded base can serve this build: either the generations are
 * equal, or the loaded base is NEWER and the newer generation provably keeps every member a consumer
 * uses (the additive superset for v1 → v2; the pruning proof for v2 → v3).
 * Use the base normally; if {@link InterfaceVerdict.warning} is set, log it as one WARNING first.
 * `incompatible` — both sides were readable and the loaded base is OLDER than the build, so the members
 * this build requires may be missing; a caller must NOT use the base's shared capabilities. The family
 * invariant still holds: this is a degradation, never a refused mount.
 * `cannot-tell` — at least one side could not be read. "Cannot tell" is never "incompatible": the
 * caller warns and uses the base normally.
 */
export interface InterfaceVerdict {
  readonly status: 'ok' | 'incompatible' | 'cannot-tell'
  /** The generation the caller was built for, when it was readable. */
  readonly required?: number
  /** The generation the loaded module reported, when it was readable. */
  readonly loaded?: number
  /**
   * One sentence a caller can log verbatim — present whenever the status is not `ok`, and absent when
   * it is. The caller owns the wording around it (prefix, "mounting anyway", …).
   */
  readonly reason?: string
  /**
   * One sentence to log as a WARNING although the verdict is `ok` — present only for the accepted
   * `loaded > required` case (the newer-but-compatible rule), absent otherwise. It is separate from
   * {@link InterfaceVerdict.reason} because "ok but notable" and "not ok" are different outcomes: a
   * caller that logs `reason` only for a non-`ok` status stays correct, and the additive case still
   * gets its WARNING line.
   */
  readonly warning?: string
}

/**
 * Compare the interface generation a caller requires with the one a loaded module reports.
 *
 * Pure, total and asymmetric: it reads exactly one property, guards that read, and answers a verdict
 * for every input. Both arguments are trusted only as far as they can be read. `loaded < required` is
 * `incompatible` (the caller may need members that are gone/never existed); `loaded > required` is `ok`
 * plus a `warning`, on the generation-safety proof described in this module's header; equal is plain
 * `ok`.
 *
 * @param required - the generation the caller was built for (its baked `interfaceVersion`).
 * @param module - the loaded base module; only `INTERFACE_VERSION` is read.
 * @returns the verdict; `status` is `cannot-tell` for any side that could not be read.
 */
export function checkInterface(
  required: number,
  module: { readonly INTERFACE_VERSION?: unknown },
): InterfaceVerdict {
  // Guarded read: a module that throws on property access is "reports no INTERFACE_VERSION", not a
  // failure of the gate (and never a rejected mount).
  let loaded: unknown
  try {
    loaded = module.INTERFACE_VERSION
  } catch {
    loaded = undefined
  }
  const loadedVersion = typeof loaded === 'number' && Number.isInteger(loaded) && loaded > 0 ? loaded : undefined

  if (!Number.isInteger(required) || required <= 0) {
    return {
      status: 'cannot-tell',
      ...(loadedVersion === undefined ? {} : { loaded: loadedVersion }),
      reason: `this build has no usable baked interface generation (got ${JSON.stringify(required)}); the runtime interface gate cannot run`,
    }
  }
  if (loadedVersion === undefined) {
    return {
      status: 'cannot-tell',
      required,
      reason: 'the loaded base reports no INTERFACE_VERSION; which interface generation it implements cannot be told',
    }
  }
  if (loadedVersion === required) return { status: 'ok', required, loaded: loadedVersion }
  if (loadedVersion > required) {
    // The SAFE direction, admitted only on the mechanical superset proof (see the module header):
    // every member this older build requires still exists, so the base is used normally — the newer
    // generation's OWN members simply go unused by this build.
    return {
      status: 'ok',
      required,
      loaded: loadedVersion,
      warning: `the loaded base reports interface generation ${String(loadedVersion)}, newer than the ${String(required)} this build was written for (host base is newer); WARNING — generations are pure additions, so every member this build requires is present and the base is judged usable`,
    }
  }
  return {
    status: 'incompatible',
    required,
    loaded: loadedVersion,
    reason: `this build was written for interface generation ${String(required)} but the loaded base reports ${String(loadedVersion)} (older generation); the members this build requires may be missing, so the base's shared capabilities are not used`,
  }
}

/**
 * Read the interface requirement a plugin artifact was baked with.
 *
 * A missing, unreadable or malformed file is `undefined` — "not baked" — never a throw: every caller
 * is a startup path that must degrade to a warning, and a half-written record must not read as a
 * version. This is the reader the PLUGINS use on their startup path; the build-side link step reads
 * the same file with its own copy in `scripts/lib/interface-version.mjs` (it runs before the base it
 * is about to vendor is importable), and the two field names are the same fact.
 *
 * @param url - the record's location, normally `new URL('./interface-version.json', import.meta.url)`.
 * @returns `{ baseVersion, interfaceVersion }`, or `undefined`.
 */
export function readInterfaceRequirement(url: URL | string): InterfaceRequirement | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const baseVersion = record['baseVersion']
    const interfaceVersion = record['interfaceVersion']
    if (typeof baseVersion !== 'string' || baseVersion === '') return undefined
    if (typeof interfaceVersion !== 'number' || !Number.isInteger(interfaceVersion) || interfaceVersion <= 0) return undefined
    return { baseVersion, interfaceVersion }
  } catch {
    return undefined
  }
}
