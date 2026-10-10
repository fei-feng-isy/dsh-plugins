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
 * The loader SKELETON the two startups share lives here too: the once-per-process cache
 * ({@link createLoadCache}), the guard that turns any throw into one warning
 * ({@link loadGuarded}), and the gate→decision step ({@link gateOrDegrade}). Those sentences are
 * observably NOT the same in the two plugins, so every shared function takes them as
 * {@link DegradeWords}: the shim owns the mechanism, the caller owns the wording, and the two trees'
 * `envinit.spec.ts` pin each plugin's own text verbatim.
 *
 * @module @avantf/dsh-identity/interface_gate
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

/** The logging surface the shared loader helpers need; both plugins' loggers satisfy it. */
export interface GateLogger {
  warn(message: string): void
}

/** Emit a warning without ever letting the logger turn it into a crash. */
function warn(log: GateLogger | undefined, message: string): void {
  try {
    log?.warn(message)
  } catch {
    // A logger that throws is not evidence of anything.
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The two sentences the shared loader may NOT own, because the plugins word them differently: mem
 * says the FRAMEWORK is skipped and names legacy provisioning among the withheld capabilities,
 * mission says the COMPATIBILITY GATE is skipped and names none. Neither is drift — both are read by
 * an operator — so the caller passes them in and the shared code interpolates them verbatim.
 */
export interface DegradeWords {
  /** This module's warning token, so one grep finds every startup line: `envinit:` / `compat:`. */
  readonly prefix: string
  /** The tail after "environment initialisation failed (...); " in the guarded-load failure line. */
  readonly loadFailure: string
  /** The parenthetical after "the base's shared capabilities are NOT used (" in the incompatible line. */
  readonly withheld: string
}

/**
 * Run the runtime interface gate and answer whether the loaded base's shared capabilities may be
 * used.
 *
 * `false` is a DEGRADATION the caller answers by taking its own full-degradation route (no runtime,
 * own prompt defaults, the compatibility gate skipped, legacy provisioning) — never a refused mount,
 * and never a throw. `cannot-tell` warns and answers `true`: "cannot tell" is not a negative answer,
 * so the base is used normally. The verdict's own reason is the base's; only the surrounding sentence
 * is the caller's ({@link DegradeWords}).
 */
export function gateOrDegrade(module: unknown, log: GateLogger | undefined, words: DegradeWords): boolean {
  const verdict = interfaceVerdict(module)
  if (!baseIsUsable(verdict)) {
    warn(
      log,
      `${words.prefix} WARNING — interface: ${verdict.reason ?? 'the loaded base implements another interface generation'};`
      + ` the base's shared capabilities are NOT used (${words.withheld}) and the plugin mounts anyway`,
    )
    return false
  }
  if (verdict.status === 'cannot-tell') {
    warn(
      log,
      `${words.prefix} WARNING — interface: ${verdict.reason ?? 'the interface generation cannot be told'}; using the loaded base anyway ("cannot tell" is never "incompatible")`,
    )
  }
  return true
}

/**
 * The guard that makes a loader's "never throws" true: every failure is one warning plus
 * `undefined`. The caller owns the sentence's tail (`words`) and its own cache discipline — a
 * FAILED load is not cached, so this must return `undefined` rather than reject (see
 * {@link createLoadCache}).
 */
export async function loadGuarded<O, T>(
  options: O,
  loadOnce: (options: O) => Promise<T | undefined>,
  log: GateLogger | undefined,
  words: DegradeWords,
): Promise<T | undefined> {
  try {
    return await loadOnce(options)
  } catch (error) {
    warn(
      log,
      `${words.prefix} WARNING — environment initialisation failed (${reasonOf(error)}); ${words.loadFailure}`,
    )
    return undefined
  }
}

/** The per-process result of a guarded load: `load` is idempotent, `clear` is for disposal. */
export interface LoadCache<O, T> {
  load(options: O): Promise<T | undefined>
  /** Drop the result and the in-flight promise, so the next `load` runs again (unmount/reload). */
  clear(): void
}

/**
 * Wrap a guarded loader in the cache discipline both startups share: the first call runs it, every
 * later and concurrent call shares its result, and a FAILED load is NOT cached. A failure is "cannot
 * tell", not a verdict — and it may be transient (offline at boot, a half-written install) — so a
 * profile reload, or a second instance in the same process, retries instead of replaying the first
 * failure for the whole process lifetime.
 */
export function createLoadCache<O, T>(guarded: (options: O) => Promise<T | undefined>): LoadCache<O, T> {
  let loaded: T | undefined
  let loading: Promise<T | undefined> | undefined
  return {
    load(options: O): Promise<T | undefined> {
      if (loaded !== undefined) return Promise.resolve(loaded)
      if (loading !== undefined) return loading
      loading = guarded(options).then(
        (runtime) => {
          if (runtime === undefined) loading = undefined
          else loaded = runtime
          return runtime
        },
        () => {
          loading = undefined
          return undefined
        },
      )
      return loading
    },
    clear(): void {
      loaded = undefined
      loading = undefined
    },
  }
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
