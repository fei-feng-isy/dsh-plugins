/**
 * This plugin's consumption of the base's runtime interface gate.
 *
 * The DECISION lives in the base — `checkInterface` + `readInterfaceRequirement`, members of the v1
 * `.` surface (root `AGENTS.md`: knowledge that CAN be fixed by one base release lives in the base).
 * What cannot live there is the one question this file answers: "does the base I loaded even HAVE the
 * gate?" A base too old to carry it must not stop the plugin from mounting, so the fallback belongs
 * to the consumer, per the family's rule for knowledge that must survive an old base.
 *
 * Nothing here throws. The startup caller turns every non-`ok` verdict into one WARNING; an
 * `incompatible` verdict additionally withholds the base's shared capabilities — the prompt layer
 * uses this plugin's own built-in defaults, the compatibility gate is skipped and provisioning takes
 * the legacy path — but the plugin ALWAYS mounts (tools, service, Remote and UI stay registered).
 * "Cannot tell" is never "incompatible": it warns and uses the base normally.
 *
 * **This file is a SHARED SHIM and must stay byte-identical in BOTH plugins** — only the `@module`
 * line below differs. Everything here is the consumption contract and the ONE verdict→decision
 * mapping; nothing in it is plugin-specific by construction. What IS plugin-specific (which text the
 * prompt layer falls back to, which resources take the legacy path) belongs in that plugin's own
 * `envinit.ts`, never here. `base/plugin-base/test/interface_consumers.spec.ts` pins the two copies
 * against each other, so a divergence is a red test instead of two shims that drifted.
 *
 * @module @avantf/dsh-mission/interface_gate
 */
import type { InterfaceVerdict } from '@avantf/dsh-plugin-base'

/** The slice of the loaded base this consumer reads; every member is optional and read guarded. */
export interface InterfaceGateModule {
  readonly INTERFACE_VERSION?: unknown
  readonly checkInterface?: unknown
  readonly readInterfaceRequirement?: unknown
}

type Check = (required: number, module: InterfaceGateModule) => InterfaceVerdict
type Read = (url: URL | string) => { readonly baseVersion: string; readonly interfaceVersion: number } | undefined

/** Read one member without letting a hostile module's getter escape. */
function member(module: unknown, name: keyof InterfaceGateModule): unknown {
  try {
    return (module as Record<string, unknown> | null)?.[name]
  } catch {
    return undefined
  }
}

function cannotTell(reason: string): InterfaceVerdict {
  return { status: 'cannot-tell', reason }
}

/**
 * Whether the base's shared capabilities may be used under `verdict`.
 *
 * The ONE mapping from the gate's verdict to the loader's decision, exported so it is asserted
 * directly and the loader and its test cannot drift: only `incompatible` withholds the base;
 * `cannot-tell` does not, because it is not a negative answer. A `false` here is still a DEGRADATION
 * (own prompt defaults, gate skipped, legacy provisioning), never a refused mount.
 */
export function baseIsUsable(verdict: InterfaceVerdict): boolean {
  return verdict.status !== 'incompatible'
}

/**
 * Where the build's bake record sits when no explicit URL is given: beside the built ENTRY
 * (`lib/index.js`), which is where `scripts/link-envinit.mjs` writes it. A per-file `tsc` emit of
 * this module lives one directory below that entry and looks one level up; the first readable record
 * wins. Under `vitest` (running from `src/`) neither exists, which is the correct "not baked".
 */
const BAKED_CANDIDATES: readonly string[] = ['./interface-version.json', '../interface-version.json']

/**
 * Read this artifact's baked requirement through the loaded base's own reader.
 * @param read - the base's `readInterfaceRequirement`, taken off the loaded module.
 * @param bakedUrl - test seam: read EXACTLY this record instead of walking {@link BAKED_CANDIDATES}.
 */
function requirementOf(read: Read, bakedUrl?: URL | string): { readonly interfaceVersion: number } | undefined {
  const candidates = bakedUrl === undefined ? BAKED_CANDIDATES.map((relative) => new URL(relative, import.meta.url)) : [bakedUrl]
  for (const url of candidates) {
    let requirement: unknown
    try {
      requirement = read(url)
    } catch {
      continue
    }
    const version = (requirement as { readonly interfaceVersion?: unknown } | null | undefined)?.interfaceVersion
    if (typeof version === 'number' && Number.isInteger(version) && version > 0) return { interfaceVersion: version }
  }
  return undefined
}

/**
 * Ask the loaded base whether it implements the interface generation this artifact was built for.
 *
 * @param module - the loaded base module (only `checkInterface` / `readInterfaceRequirement` are
 *   touched, each through a guarded read).
 * @param bakedUrl - test seam: the bake record to read; production leaves it undefined.
 * @returns a verdict that is never `incompatible` unless BOTH sides were readable and differ, and
 *   never a throw.
 */
export function interfaceVerdict(module: unknown, bakedUrl?: URL | string): InterfaceVerdict {
  const check = member(module, 'checkInterface')
  const read = member(module, 'readInterfaceRequirement')
  if (typeof check !== 'function' || typeof read !== 'function') {
    return cannotTell(
      'the loaded base has no interface gate (checkInterface / readInterfaceRequirement missing) — it predates the runtime interface contract, so which generation it implements cannot be told',
    )
  }
  const requirement = requirementOf(read as Read, bakedUrl)
  if (requirement === undefined) {
    return cannotTell('this build has no baked interface requirement (lib/interface-version.json is missing or malformed), so the runtime interface gate cannot run')
  }
  let verdict: unknown
  try {
    verdict = (check as Check)(requirement.interfaceVersion, module as InterfaceGateModule)
  } catch {
    return cannotTell('the loaded base threw while judging the interface generation')
  }
  const status = (verdict as { readonly status?: unknown } | null | undefined)?.status
  if (status !== 'ok' && status !== 'incompatible' && status !== 'cannot-tell') {
    return cannotTell('the loaded base returned no usable interface verdict')
  }
  return verdict as InterfaceVerdict
}

/**
 * Whether a Cordis context is still alive.
 *
 * Cordis clears `fiber.uid` on disposal, and every later context call then throws
 * `INACTIVE_EFFECT`. `apply` awaits environment preparation, so a profile reload or unload can land
 * inside that window and half-register a plugin (the Remote face cannot be rolled back). A fiberless
 * stub counts as active: an unknown shape is "cannot tell", never "disposed".
 *
 * Generic Cordis liveness rather than interface-gate knowledge — but the two plugins' startup paths
 * share it byte-for-byte, so it lives with their one shared shim, where the two readings of "is my
 * context alive" cannot drift.
 */
export function stillActive(ctx: unknown): boolean {
  const fiber = (ctx as { readonly fiber?: { readonly uid?: unknown } } | null | undefined)?.fiber
  return fiber === undefined || fiber.uid !== null
}
