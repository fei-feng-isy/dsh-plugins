/**
 * Startup compatibility gate for DSH plugins.
 *
 * A DSH plugin's whole API surface is DSH's, and dsh moves fast: a renamed method or a
 * moved registry contract has no fallback. Without a gate the failure modes are the bad
 * ones — a throw halfway through `apply` (half a mounted plugin), or a plugin that mounts
 * and is silently inert (tools registered nowhere, a wake gate never entered).
 *
 * So the gate runs FIRST in `apply()` and answers one question: is the host API this build
 * was written against actually here? Three rules, in the order they matter:
 *
 *   - **proven break** (a required service or method is gone, or a registry refused or
 *     dropped a declaration shaped like the real one) → `load: false`: register nothing,
 *     log the diagnosis, and (optionally) keep one command that reports it to the user.
 *   - **risk signal** (the version this build's own links resolve to differs from the one it was
 *     compiled against, or a version cannot be resolved) → a warning, never a refusal. A version
 *     difference has never by itself made a plugin wrong, and refusing on one would take a
 *     working plugin out of a deployment that merely upgraded.
 *   - **undeterminable** (event names: nothing inside a plugin can prove the host still
 *     EMITS them) → recorded in the report, never blocking. "Cannot tell" is not
 *     "incompatible".
 *
 * The version comparison has a deliberate BOUNDARY: it covers this artifact against the dsh ITS
 * LINKS point at, and never the identity of the process it is loaded into. A plugin cannot observe
 * its host's version (no service exposes it), so a checkout host sharing an installed dsh with the
 * plugin prints the INSTALLED version — a boundary, not a bug. See `README.md` «已知边界».
 *
 * The caller supplies a {@link CompatSpec} — what IT calls, which packages identify the
 * host, which schemas and tools must be visible afterwards. The rules are a pure function
 * of plain evidence ({@link verdictOf}), so they are unit-tested without a host.
 *
 * Nothing here throws. A probe that explodes is a FAILED probe, not a crash.
 *
 * @module @avantf/dsh-plugin-base
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Every line this module logs carries this token, so a support question can be answered
 * with one grep of the host log.
 */
export const COMPAT_PREFIX = 'compat:'

/** What the gate needs from a live context: one service lookup. Cordis's `Context` satisfies it. */
export interface CompatContext {
  get(name: string): unknown
}

/** One service a plugin calls, and the methods it calls on it. */
export interface ServiceContract {
  readonly name: string
  /**
   * `true` ⇒ refuse to load when it (or one of its methods) is gone. This is the CALLER's refusal
   * policy, not cordis's `inject`: cordis has no optional injection, so a service the plugin can
   * degrade without is read with `ctx.get()` and declared here as `required: false`.
   */
  readonly required: boolean
  readonly methods: readonly string[]
}

/** What a plugin declares about itself, so the rules can stay generic. */
export interface CompatSpec {
  /** The plugin's package id: probe keys and the post-registration check are `<id>#<name>`. */
  readonly packageId: string
  readonly services: readonly ServiceContract[]
  /**
   * Package released in lockstep with dsh → the version THIS BUILD was compiled against. Feed it
   * {@link readBuildVersions} over the JSON the build baked next to the entry, with the peer range's
   * floor ({@link readDeclaredVersions}) as the per-package fallback: a range floor is a lower bound
   * the artifact tolerates, not "the dsh I built against".
   */
  readonly declared: Readonly<Record<string, string | undefined>>
  /**
   * What THIS BUILD's links resolve to, read by the CALLER from its own module URL
   * (`readRuntimeVersions(packages, import.meta.url)`). It is NOT the host's identity — a plugin
   * cannot observe that; see the module header. Omitted ⇒ this package resolves them, which is only
   * as good as the links IT has.
   */
  readonly runtime?: Readonly<Record<string, string | undefined>>
  /** Whether `ctx.interval` (the timer plugin's effect-scoped timer) is needed. */
  readonly needsInterval?: boolean
  /**
   * Build the throwaway tool the tools probe registers, e.g.
   * `toolProbeDeclaration(defineTool)`. Omitted ⇒ that probe is skipped ("not probed", never a break).
   */
  readonly probeTool?: () => unknown
  /**
   * Build the throwaway Typert contribution the wire probe registers. **Pass your real declaration**
   * (`() => myContribution`), so a pass proves the registration you are about to perform. Omitted ⇒
   * the wire contract is not probed at all (recorded as a note, never a refusal).
   *
   * The rule is absolute, and it is not a style note: this package once shipped a MINIMAL stand-in
   * (one schema, no invocations, no codecs) as the convenient default, and a live 0.1.6 host proved
   * the cost — the stand-in passed (it carried no codec to validate) while the plugin's REAL
   * contribution threw on `strict codec has no create() factory` halfway through `apply`. A probe
   * that is not the real declaration turns "the host API moved" into a half-mounted plugin, which is
   * the one outcome this gate exists to prevent.
   */
  readonly probeTypert?: (packageId: string) => unknown
  /** Wire schema names to verify after registration; omitted means "no post-registration check". */
  readonly schemaNames?: readonly string[]
  /** Events the plugin listens to. Reported as an unprovable limit, never checked. */
  readonly events?: readonly string[]
}

/** Coarse outcome of one gate run. */
export type CompatStatus = 'ok' | 'version-mismatch' | 'version-unknown' | 'probe-skipped' | 'probe-failed'

/** One service as the live context answers for it. */
export interface ServiceProbe {
  readonly name: string
  readonly required: boolean
  readonly present: boolean
  /** Methods the plugin calls that the mounted service does not expose. */
  readonly missing: readonly string[]
}

/** One registry probe: what was tried, and what came back. */
export interface ProbeOutcome {
  /** The registry exposed the query surface, so the probe actually ran. */
  readonly ran: boolean
  readonly passed: boolean
  /** Expected-vs-actual detail, one entry per failed step (empty when it passed). */
  readonly problems: readonly string[]
}

/** One version comparison: what this build was compiled against vs what its own links resolve now. */
export interface VersionProbe {
  readonly package: string
  /**
   * The version this build was compiled against: the exact one baked into the build when there is a
   * `dsh-build.json` next to the entry, else the peer range's floor (`^0.1.5-rc.2` → `0.1.5-rc.2`).
   */
  readonly declared: string | undefined
  /** What this build's own links resolve to NOW. The host's identity is never observed. */
  readonly runtime: string | undefined
}

/** Everything the verdict needs, as plain data. */
export interface CompatEvidence {
  readonly services: readonly ServiceProbe[]
  /** `ctx.interval` — the timer plugin's effect-scoped timer, which the sweep may need. */
  readonly interval: boolean
  /** Whether the caller needs that timer (a plugin with no sweep does not). */
  readonly needsInterval: boolean
  readonly toolsProbe: ProbeOutcome | undefined
  readonly typertProbe: ProbeOutcome | undefined
  readonly versions: readonly VersionProbe[]
  /** Events the caller listens to; reported as unprovable, never blocking. */
  readonly events: readonly string[]
}

/** One line to log; `error` marks a proven break. */
export interface CompatLine {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
}

/** The decision `apply` branches on, plus everything worth printing. */
export interface CompatVerdict {
  /** `false` ⇒ refuse to load: register nothing. */
  readonly load: boolean
  /** No active probe could run: the surface checks still happened, but nothing was proven either way. */
  readonly skipped: boolean
  readonly status: CompatStatus
  readonly problems: readonly string[]
  readonly warnings: readonly string[]
  readonly notes: readonly string[]
  readonly lines: readonly CompatLine[]
  /** One line for the `load: false` case (empty otherwise), for an envelope or a command. */
  readonly reason: string
}

/** Minimal logging surface the caller supplies (the plugin's own logger satisfies it). */
export interface CompatLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

/** A JSON object, as opposed to `null` / an array / a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Best-effort one-line reason for a caught value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Turn one declared peer range into the version FLOOR it names.
 *
 * The `declared` side's FALLBACK, used only when a build left no baked version
 * ({@link readBuildVersions}). Only the floor is read — a caret range's upper bound is a promise
 * about the future, while the floor is the exact release the range was written against.
 *
 * Compound ranges are the everyday form (`>=4.4.3 <5`, `>=0.1.5-rc.2 <0.2.0`), so the FIRST
 * comparator is read and its trailing bounds are ignored: spacing, a `<`/`<=` bound, or a `||`
 * alternative must not turn a readable floor into `undefined`. A range whose first comparator is
 * itself an upper bound (`<2.0.0`, `<=2.0.0`), a tag (`latest`), or a protocol (`workspace:`) names
 * no floor and yields `undefined`, which reports as unverified rather than as a mismatch.
 * @param range - the peer range as written in `package.json`.
 * @returns the version, or `undefined` when it cannot be read out.
 */
export function floorOf(range: string | undefined): string | undefined {
  if (range === undefined) return undefined
  // `[\^~]`, `>=`, `>`, `=` and a bare version are all lower bounds; `<` and `<=` are deliberately
  // absent from the operator set, so they fail the match instead of being read as a floor. The token
  // stops at whitespace or at an operator, so `4.4.3<5` reads as `4.4.3` too.
  const match = /^\s*(?:[\^~]|>=?|=)?\s*v?(\d[0-9A-Za-z.+-]*)/u.exec(range)
  return match?.[1]
}

/**
 * Read the version FLOORS a caller declares for the packages that identify the host.
 *
 * Taken from the caller's own `package.json` peer ranges, so the value travels with the artifact (a
 * plugin's manifest ships with it) and cannot drift away from the contract it declares. A floor is a
 * LOWER BOUND, which is why this is the fallback and not the preferred source: it cannot say which
 * release the artifact was actually compiled against. {@link readBuildVersions} reads that, and falls
 * back to these floors only for packages its build did not bake.
 * @param manifestUrl - the caller's `package.json` (`new URL('../package.json', import.meta.url)`).
 * @param packages - the packages to read, usually `['@deepseek-ai/dsh-tools', ...]`.
 * @returns one entry per package; `undefined` means the manifest declares nothing for it.
 */
export function readDeclaredVersions(
  manifestUrl: string | URL,
  packages: readonly string[],
): Record<string, string | undefined> {
  let peers: Record<string, string> = {}
  try {
    const path = manifestUrl instanceof URL ? fileURLToPath(manifestUrl) : manifestUrl
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { peerDependencies?: Record<string, string> }
    peers = parsed.peerDependencies ?? {}
  } catch {
    // An unreadable manifest is not a verdict: every version reads as "unknown", which never blocks.
  }
  const declared: Record<string, string | undefined> = {}
  for (const name of packages) declared[name] = floorOf(peers[name])
  return declared
}

/**
 * The file a build bakes its exact versions into, next to the built entry.
 *
 * Named once here so the producer (a repo's build script) and the consumer (its `provision.ts`)
 * cannot disagree about where it lives. It is a plain JSON object of `package → version`.
 */
export const BUILD_VERSIONS_FILE = 'dsh-build.json'

/**
 * Read the exact versions THIS BUILD was compiled against, out of the JSON its build emitted.
 *
 * The `declared` side's PREFERRED source. A peer range only records a floor — the lowest release the
 * artifact tolerates — so after an in-place upgrade of the installed dsh it says nothing about the
 * copy this build actually linked and compiled against, and the comparison degrades to a weak one.
 * The build knows that copy exactly, so it bakes it next to the entry (`lib/dsh-build.json`) and this
 * reads it back from `new URL('./dsh-build.json', import.meta.url)`.
 *
 * The file is OPTIONAL by design: a dev tree, a test run and a build made before this file existed
 * all lack it, and none of them may crash or invent a version. The fallback is per PACKAGE rather
 * than all-or-nothing, so a partially written file still reports honestly for the entries it has.
 * @param buildUrl - where the build wrote the JSON (`new URL('./dsh-build.json', import.meta.url)`).
 * @param packages - the packages to read, usually `['@deepseek-ai/dsh-tools', ...]`.
 * @param fallback - per-package value for entries the file has none for (the peer floors).
 * @returns one entry per package; `undefined` means neither source has a version.
 */
export function readBuildVersions(
  buildUrl: string | URL,
  packages: readonly string[],
  fallback: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  let baked: Record<string, unknown> = {}
  try {
    const path = buildUrl instanceof URL ? fileURLToPath(buildUrl) : buildUrl
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isRecord(parsed)) baked = parsed
  } catch {
    // No baked file (or one that is not a JSON object) is not a verdict: every package falls back.
  }
  const versions: Record<string, string | undefined> = {}
  for (const name of packages) {
    const value = baked[name]
    versions[name] = typeof value === 'string' && value !== '' ? value : fallback[name]
  }
  return versions
}

/**
 * Resolve the version of a peer copy THIS BUILD's links point at.
 *
 * This is the `runtime` side: it answers "what do this artifact's own links resolve to", NOT "which
 * host is running". The two coincide when the plugin shares the host's copy, and diverge whenever
 * the links point elsewhere — a checkout host loading a plugin linked to an installed dsh is the
 * everyday case. Nothing inside a plugin can observe the host's own version (no dsh service exposes
 * it), so the log wording never claims to; see `README.md` «已知边界».
 *
 * A plugin cannot resolve `@deepseek-ai/dsh/package.json` (the core package is not in its
 * `node_modules`), but the packages below ship in lockstep with it and ARE resolvable
 * through the same links the rest of the plugin uses. Any failure is "unknown", never a
 * throw.
 * `base` decides WHOSE links are used. It defaults to this package, which is right when this package
 * is the only consumer — but a plugin should pass its own `import.meta.url`: the packages that
 * identify the host are ITS peers, and the shared package may not be able to see all of them.
 * @param name - the peer package.
 * @param base - module URL to resolve from (defaults to this package).
 * @returns the version string, or `undefined`.
 */
export function resolveRuntimeVersion(name: string, base: string | URL = import.meta.url): string | undefined {
  try {
    const require = createRequire(base)
    // Built at runtime so a bundler cannot constant-fold it and resolve at build time.
    const manifest = require.resolve(`${name}/package.json`)
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask the live context for one entry per declared service.
 *
 * A service that is present but missing a method the caller declared is a BREAK, not a note: the
 * caller's code will call it. A service that is absent is a problem only when it is required.
 * @param ctx - the live context (structural).
 * @param contracts - what the caller calls.
 * @returns one probe per contract.
 */
export function checkServices(ctx: CompatContext, contracts: readonly ServiceContract[]): ServiceProbe[] {
  const services: ServiceProbe[] = []
  for (const contract of contracts) {
    let service: unknown
    try {
      service = ctx.get(contract.name)
    } catch {
      service = undefined
    }
    const missing = service === undefined || service === null
      ? [...contract.methods]
      : contract.methods.filter((method) => {
        try {
          return typeof (service as Record<string, unknown>)[method] !== 'function'
        } catch {
          // A service whose members throw on access exposes nothing usable.
          return true
        }
      })
    services.push({ name: contract.name, required: contract.required, present: service !== undefined, missing })
  }
  return services
}

/** Whether the timer plugin's effect-scoped timer is reachable as `ctx.interval`. */
export function checkInterval(ctx: CompatContext): boolean {
  try {
    return typeof (ctx as unknown as Record<string, unknown>)['interval'] === 'function'
  } catch {
    return false
  }
}

/**
 * The throwaway tool the probe registers: the same declaration shape `tools.ts` uses,
 * including the `output` contract the model-facing render depends on.
 *
 * Withdrawn in `finally`, so a successful probe leaves the registry exactly as it found
 * it (a failed withdrawal would show up as a tenth tool in the mount smoke).
 */
export const COMPAT_PROBE_TOOL = '__dshCompatProbe'

/**
 * The caller's declaration helper, typed loosely on purpose: naming `@deepseek-ai/dsh-tools`'s own
 * options type here is exactly the compile-time dependency on a dsh version this package avoids. The
 * literal below is verified against the REAL registry by this package's tests, so a wrong shape fails
 * there rather than silently.
 */
export type ToolDeclarationHelper = (options: any) => unknown

/**
 * Build the tools-probe declaration from the CALLER's own declaration helper.
 *
 * The helper is injected rather than imported on purpose. This package is a base module: pinning a
 * dsh version would make it stale with every dsh release, and a dsh-free source is what lets one copy
 * serve every plugin. The caller also happens to be the right owner — the probe must mirror the
 * declaration path the caller's REAL tools use, and only the caller has that helper.
 * @param defineTool - the caller's `defineTool` (from its own `@deepseek-ai/dsh-tools`).
 * @returns a zero-argument builder for `CompatSpec.probeTool`.
 */
export function toolProbeDeclaration(defineTool: ToolDeclarationHelper): () => unknown {
  return () => defineTool({
    name: COMPAT_PROBE_TOOL,
    description: 'compatibility probe (withdrawn immediately)',
    parameters: { probe: { type: 'string', required: true, description: 'probe' } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute: () => Promise.resolve({ ok: true }),
  })
}

/**
 * Register the probe tool, check the registry kept it, and withdraw it.
 *
 * What this proves that a method-presence check cannot: the registry ACCEPTED our
 * declaration shape and still lists it. It is the difference between "`register` is a
 * function" and "registering what we register missions".
 * @param registry - `ctx.tools`.
 * @returns the outcome; never throws.
 */
export function probeToolsRegistry(registry: unknown, buildProbe: (() => unknown) | undefined): ProbeOutcome {
  // No builder ⇒ nothing to prove: "not probed" keeps the plugin loading, and the caller's spec is
  // where that choice is visible.
  if (buildProbe === undefined) return { ran: false, passed: false, problems: [] }
  if (!isRecord(registry) || typeof registry['register'] !== 'function' || typeof registry['get'] !== 'function') {
    return { ran: false, passed: false, problems: [] }
  }
  const tools = registry as { register: (tool: unknown) => unknown; get: (name: string) => unknown }
  const problems: string[] = []
  let registered = false
  let dispose: unknown
  try {
    try {
      dispose = tools.register(buildProbe())
      registered = true
    } catch (error) {
      problems.push(`ctx.tools.register() refused a probe declaration: ${reasonOf(error)}`)
    }
    if (registered) {
      try {
        const found = tools.get(COMPAT_PROBE_TOOL)
        const name = isRecord(found) ? found['name'] : undefined
        if (name !== COMPAT_PROBE_TOOL) {
          problems.push(
            `the probe tool was not recorded: tools.get('${COMPAT_PROBE_TOOL}') answered ${
              found === undefined ? 'undefined' : `${typeof found} (name ${String(name)})`
            }`,
          )
        }
      } catch (error) {
        problems.push(`tools.get() threw for the probe tool: ${reasonOf(error)}`)
      }
    }
  } finally {
    if (typeof dispose === 'function') {
      try {
        const result = (dispose as () => unknown)()
        if (isRecord(result) && 'then' in result) void Promise.resolve(result).catch(() => undefined)
      } catch {
        problems.push('the probe tool could not be withdrawn (its disposer threw)')
      }
    }
  }
  return { ran: true, passed: problems.length === 0, problems }
}

/**
 * Register the caller's Typert declaration, verify the query surface, and withdraw it.
 *
 * The schema is a LIVE zod object, which is the point: `toJSONSchema` runs the HOST's
 * projector over OUR schema, the cross-copy step that breaks when the codec contract
 * moves (`TypertSchema{schema}` → `TypertSchemaFactory{create}` did exactly this once).
 * What is verified — the schema names AND the package face — is read off the declaration, so
 * handing over the real contribution makes a pass mean "the real registration will land too".
 * @param registry - `ctx.typert`.
 * @param packageId - this plugin's package id, which the probe key is built from.
 * @returns the outcome; never throws.
 */
export function probeTypertRegistry(
  registry: unknown,
  packageId: string,
  buildProbe: ((packageId: string) => unknown) | undefined,
): ProbeOutcome {
  // No declaration ⇒ nothing to prove. Reporting "not probed" keeps the plugin loading; inventing a
  // shape here is what produced a false `ok` on a host whose codec contract had moved.
  if (buildProbe === undefined) return { ran: false, passed: false, problems: [] }
  const required = ['register', 'get', 'list', 'listPackages', 'toJSONSchema']
  const host = isRecord(registry) ? registry : undefined
  if (host === undefined || required.some((method) => typeof host[method] !== 'function')) {
    return { ran: false, passed: false, problems: [] }
  }
  // The verification follows what the DECLARATION declares — never a name this function assumes. The
  // caller may hand over its real face (that is the recommended form), and a hardcoded schema name OR
  // face would then report "not recorded" about a registration that worked. The registry accepts two
  // faces (`host` and `client`), so the expected one is the declaration's, not this function's guess.
  const declaration = buildProbe(packageId)
  const expectedKeys = declaredSchemaKeys(packageId, schemaNamesFrom(declaration))
  const declaredFace = isRecord(declaration) && typeof declaration['face'] === 'string'
    ? declaration['face']
    : undefined
  const problems: string[] = []
  let registered = false
  let dispose: unknown
  try {
    try {
      dispose = (host['register'] as (value: unknown) => unknown)(declaration)
      registered = true
    } catch (error) {
      problems.push(`ctx.typert.register() refused a probe contribution: ${reasonOf(error)}`)
    }
    // The package face is verified for EVERY registered contribution, schema or not: a model-only
    // face declares no schema key to read back, and its registration still has to be visible.
    if (registered) {
      try {
        const packages = (host['listPackages'] as (filter?: unknown) => unknown)({ package: packageId })
        const listed = Array.isArray(packages)
          && packages.some((row) => isRecord(row)
            && row['package'] === packageId
            && (declaredFace === undefined || row['face'] === declaredFace))
        if (!listed) {
          problems.push(
            `listPackages({ package: '${packageId}' }) did not list the probe's ${declaredFace ?? 'registered'} face`,
          )
        }
      } catch (error) {
        problems.push(`listPackages() threw: ${reasonOf(error)}`)
      }
    }
    if (registered && expectedKeys.length > 0) {
      try {
        const listed = (host['list'] as (filter?: unknown) => unknown)({ package: packageId })
        const keys = Array.isArray(listed)
          ? listed.map((row) => (isRecord(row) ? row['key'] : undefined)).filter((value): value is string => typeof value === 'string')
          : []
        const absent = expectedKeys.filter((key) => !keys.includes(key))
        const first = expectedKeys[0] as string
        const viaGet = (host['get'] as (key: string) => unknown)(first)
        if (absent.length > 0 || viaGet === undefined) {
          problems.push(
            `declared schemas are missing after registration: [${absent.join(', ')}] (list keys = [${keys.join(', ')}])`,
          )
        }
      } catch (error) {
        problems.push(`the typert query surface threw for a declared key: ${reasonOf(error)}`)
      }
      try {
        const key = expectedKeys[0] as string
        const projected = (host['toJSONSchema'] as (key: string) => unknown)(key)
        if (!isRecord(projected)) {
          problems.push(`toJSONSchema('${key}') answered ${projected === undefined ? 'undefined' : typeof projected} instead of a JSON Schema object`)
        }
      } catch (error) {
        problems.push(`toJSONSchema() threw over our declared schema: ${reasonOf(error)}`)
      }
    }
  } finally {
    if (typeof dispose === 'function') {
      try {
        const result = (dispose as () => unknown)()
        if (isRecord(result) && 'then' in result) void Promise.resolve(result).catch(() => undefined)
      } catch {
        problems.push('the probe contribution could not be withdrawn (its disposer threw)')
      }
    }
  }
  return { ran: true, passed: problems.length === 0, problems }
}

/**
 * Resolve several versions at once, from one caller's links.
 *
 * "From one caller's links" is the whole boundary: these are the versions that caller resolves, not
 * the host's. Pass the caller's own `import.meta.url` so the answer covers its peers.
 * @param packages - the packages to resolve.
 * @param base - module URL to resolve from (defaults to this package).
 * @returns one entry per package; `undefined` means it could not be resolved.
 */
export function readRuntimeVersions(
  packages: readonly string[],
  base: string | URL = import.meta.url,
): Record<string, string | undefined> {
  const versions: Record<string, string | undefined> = {}
  for (const name of packages) versions[name] = resolveRuntimeVersion(name, base)
  return versions
}

/**
 * Read a live context into the plain evidence the rules consume.
 *
 * The probes are throwaway declarations shaped like the real ones: "`register` is a function" and
 * "registering what we register missions" are different claims, and only the second one catches a
 * moved contract.
 * @param ctx - the live context (structural: only `get` is used).
 * @param spec - what the caller declared about itself.
 * @returns the evidence.
 */
export function gatherEvidence(ctx: CompatContext, spec: CompatSpec): CompatEvidence {
  const versions = Object.entries(spec.declared).map(([name, declared]) => ({
    package: name,
    declared,
    runtime: spec.runtime?.[name] ?? resolveRuntimeVersion(name),
  }))
  const typert = ctx.get('typert')
  return {
    services: checkServices(ctx, spec.services),
    interval: checkInterval(ctx),
    needsInterval: spec.needsInterval === true,
    toolsProbe: probeToolsRegistry(ctx.get('tools'), spec.probeTool),
    typertProbe: typert === undefined || spec.probeTypert === undefined
      ? undefined
      : probeTypertRegistry(typert, spec.packageId, spec.probeTypert),
    versions,
    events: spec.events ?? [],
  }
}

/**
 * The rule set: plain evidence in, decision plus log lines out.
 *
 * Kept pure so every branch — including the ones a live host cannot be made to produce —
 * is unit-tested without a Context.
 *
 * Logging policy, so a healthy mount stays one line: warnings and problems are always
 * logged, and everything merely UNDETERMINABLE lands in `notes` — returned for tests and
 * support, not printed. A note is not a finding; the plugin that cannot probe a registry
 * still says so in the verdict the caller holds.
 * @param evidence - what {@link gatherEvidence} observed.
 * @returns the verdict.
 */
export function verdictOf(evidence: CompatEvidence): CompatVerdict {
  const problems: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  const lines: CompatLine[] = []

  for (const service of evidence.services) {
    if (!service.present) {
      if (service.required) {
        problems.push(`required service "${service.name}" is not mounted, and this plugin calls ${service.missing.join(', ')} on it`)
      } else {
        notes.push(`optional service "${service.name}" is not mounted; the engine degrades without it`)
      }
      continue
    }
    if (service.missing.length === 0) continue
    const detail = `"${service.name}" is mounted but exposes no ${service.missing.join(', ')}`
    if (service.required) problems.push(`required service ${detail}`)
    else notes.push(`optional service ${detail}; the feature that needs it degrades`)
  }

  if (evidence.needsInterval && !evidence.interval) {
    problems.push('ctx.interval() is not available (the injected timer plugin exposes no timer, and the sweep needs one)')
  }

  if (evidence.toolsProbe === undefined) {
    notes.push('the tools registry was not probed')
  } else if (!evidence.toolsProbe.ran) {
    notes.push('the tools registry exposes no register/get pair; the tool surface was not probed')
  } else {
    problems.push(...evidence.toolsProbe.problems)
  }

  if (evidence.typertProbe === undefined) {
    notes.push('no typert registry mounted; the 任务 view reports that instead of reading the tree')
  } else if (!evidence.typertProbe.ran) {
    notes.push('the typert registry exposes no query surface; the wire contract was not probed')
  } else {
    problems.push(...evidence.typertProbe.problems)
  }

  let versionDiffered = false
  let versionUnknown = false
  for (const version of evidence.versions) {
    if (version.declared === undefined || version.runtime === undefined) {
      // Neither half is evidence of anything: a version reads as `unknown` in the ok line, never as a
      // warning — a warning here would train the reader to ignore warnings.
      versionUnknown = true
      notes.push(version.declared === undefined
        ? `this build records no version for ${version.package} (neither a baked build version nor a peer floor), so its links could not be matched against it`
        : `this build's links resolve no ${version.package} (this build was compiled against ${version.declared})`)
      continue
    }
    if (version.runtime !== version.declared) {
      versionDiffered = true
      warnings.push(
        `this build was compiled against ${version.package} ${version.declared}, but its links now resolve to ${version.runtime} — rebuild against this machine's dsh (\`pnpm build:dsh\`)`,
      )
    }
  }

  if (evidence.events.length > 0) {
    notes.push(`event names cannot be proven from inside: ${evidence.events.join(', ')}`)
  }

  const load = problems.length === 0
  for (const warning of warnings) lines.push({ level: 'warn', message: `${COMPAT_PREFIX} WARNING — ${warning}` })
  for (const problem of problems) lines.push({ level: 'error', message: `${COMPAT_PREFIX} INCOMPATIBLE — ${problem}` })
  if (load) {
    const present = evidence.services.filter((service) => service.present).length
    const probed = [
      evidence.toolsProbe?.ran === true ? 'tools' : undefined,
      evidence.typertProbe?.ran === true ? 'typert' : undefined,
    ].filter((name): name is string => name !== undefined)
    // An unresolvable version reads as `unknown` here rather than as a warning line: that is where
    // the memory plugin puts it too, and it is the only place a healthy boot still says so.
    const versions = evidence.versions
      .map((version) => version.runtime === undefined
        ? `${version.package} unknown${version.declared === undefined ? '' : ` (compiled against ${version.declared})`}`
        : `${version.package} ${version.runtime}`)
      .join(', ')
    lines.push({
      level: 'info',
      // `dsh links:` — never `running`: these are the versions this artifact's OWN links resolve, and
      // the host's identity is not observable from inside a plugin (see the module header).
      message: `${COMPAT_PREFIX} ok — ${String(present)} service(s) present, probed ${probed.length === 0 ? 'no registry' : probed.join(' + ')}${versions === '' ? '' : `, dsh links: ${versions} (versions this build's own links resolve; the host identity is not observed)`}`,
    })
  } else {
    lines.push({
      level: 'error',
      message: `${COMPAT_PREFIX} REFUSING to load — ${String(problems.length)} proven incompatibility(ies). Rebuild against this machine's dsh (\`pnpm build:dsh\`) or install the @deepseek-ai/dsh this build declares.`,
    })
  }
  // `probe-failed` covers every PROVEN break — a service or method that is gone is the same finding
  // as a registry that refused our declaration: the host API is not the one this build needs.
  const skipped = evidence.toolsProbe?.ran !== true && evidence.typertProbe?.ran !== true
  // Precedence mirrors the family's gate: a proven break first, then the version signal, then "no
  // probe ran", then an unverifiable version, then healthy.
  const status: CompatStatus = !load
    ? 'probe-failed'
    : versionDiffered
      ? 'version-mismatch'
      : skipped
        ? 'probe-skipped'
        : versionUnknown ? 'version-unknown' : 'ok'
  return { load, skipped, status, problems, warnings, notes, lines, reason: load ? '' : problems.join('; ') }
}

/**
 * Run the check against a live context and log every line.
 *
 * Call this FIRST in `apply()`: on a refusal nothing has been registered yet, so "do not
 * load" costs nothing to unwind. Never throws — a check that cannot be performed leaves
 * the plugin loading, because "cannot tell" is not "incompatible".
 * @param ctx - the plugin's context.
 * @param log - the plugin's logger.
 * @returns the verdict `apply` branches on.
 */
export function provision(ctx: CompatContext, log: CompatLogger, spec: CompatSpec): CompatVerdict {
  let verdict: CompatVerdict
  try {
    verdict = verdictOf(gatherEvidence(ctx, spec))
  } catch (error) {
    const line: CompatLine = {
      level: 'warn',
      message: `${COMPAT_PREFIX} WARNING — the compatibility check itself failed (${reasonOf(error)}); loading anyway`,
    }
    log.warn(line.message)
    return {
      load: true,
      skipped: true,
      status: 'probe-skipped',
      problems: [],
      warnings: [line.message],
      notes: ['the check itself failed'],
      lines: [line],
      reason: '',
    }
  }
  for (const line of verdict.lines) log[line.level](line.message)
  return verdict
}

/**
 * The caller's copy for {@link compatReport}: the STRUCTURE is the base's, every string is the
 * caller's (see the function's note). Exported so the interface type
 * (`BaseRuntimeV1.compatReport`) can name the same shape the implementation takes — a second,
 * structurally-identical declaration would be exactly the kind of drift the interface snapshot exists
 * to catch.
 */
export interface CompatReportWords {
  readonly heading: string
  readonly fix: string
  readonly warningsLabel: string
  readonly warnings: readonly string[]
  /**
   * Optional because base is a published package: a plugin compiled against an earlier base does not
   * pass it, and the honest result is no tail line at all rather than one in a language it never
   * chose.
   */
  readonly logPointer?: (prefix: string) => string
}

/**
 * Build the standard refusal report, so every plugin says the same thing in its own words.
 *
 * The STRUCTURE belongs here (heading, problems, warnings, the fix, where the full log is); the
 * wording belongs to the caller, which passes every string in its own language. That includes the
 * last line — this used to be a hardcoded Chinese sentence, which meant a caller that had translated
 * everything else still got half a sentence in a language it never chose.
 *
 * `logPointer` is OPTIONAL because base is a published package: a plugin compiled against an earlier
 * base does not pass it, and the honest result for that caller is no tail line at all rather than one
 * in the wrong language.
 * @param verdict - the refusal to report.
 * @param words - the caller's copy.
 * @param words.logPointer - the caller's sentence for "the full diagnostics are the log lines that
 *   start with `<prefix>`"; receive the prefix so the sentence can place it naturally.
 * @returns the report text.
 */
export function compatReport(
  verdict: CompatVerdict,
  words: CompatReportWords,
): string {
  return [
    words.heading,
    '',
    ...verdict.problems.map((problem) => `- ${problem}`),
    '',
    ...(verdict.warnings.length === 0 ? [] : [words.warningsLabel, ...verdict.warnings.map((warning) => `- ${warning}`), '']),
    words.fix,
    ...(words.logPointer === undefined ? [] : [words.logPointer(COMPAT_PREFIX)]),
  ].join('\n')
}

/**
 * Keep one megaphone when a plugin refuses to load.
 *
 * Registering a command in a broken host is a judgment call: the plugin provides nothing else, and
 * the alternative is a user watching a surface that says "not available" with no way to ask why. A
 * host too broken to register one leaves the log as the only channel — which must not throw either.
 * @param input - the context, the logger, the command to register, and the text it should print.
 */
export function registerMegaphone(input: {
  readonly ctx: CompatContext
  readonly log: CompatLogger
  readonly command: { readonly name: string; readonly description: string }
  readonly text: string
}): void {
  try {
    const commands = input.ctx.get('commands')
    if (commands === undefined) throw new Error('the commands service is not mounted')
    ;(commands as { register: (definition: unknown) => unknown }).register({
      name: input.command.name,
      description: input.command.description,
      handler: () => Promise.resolve({ kind: 'error' as const, text: input.text }),
    })
    input.log.warn(`${COMPAT_PREFIX} registered a /${input.command.name} command that reports this refusal`)
  } catch (error) {
    input.log.warn(`${COMPAT_PREFIX} could not register the reporting command (${reasonOf(error)}); the log is the only report`)
  }
}

/**
 * The schema names a Typert contribution declares, read from the contribution itself.
 *
 * Derived, never hardcoded: a schema added to a wire face must widen the post-registration check on
 * its own.
 * @param contribution - the object passed to `register` (`{ schemas: [{ name }] }`).
 * @returns the names, in declaration order.
 */
export function schemaNamesFrom(contribution: unknown): string[] {
  const schemas = (isRecord(contribution) ? contribution['schemas'] : undefined)
  if (!Array.isArray(schemas)) return []
  return schemas
    .map((row) => (isRecord(row) && typeof row['name'] === 'string' ? row['name'] : undefined))
    .filter((name): name is string => name !== undefined)
}

/**
 * The registry keys those names become: `<packageId>#<name>`.
 * @param packageId - the contributing package.
 * @param names - the schema names.
 * @returns the keys the registry is expected to list.
 */
export function declaredSchemaKeys(packageId: string, names: readonly string[]): string[] {
  return names.map((name) => `${packageId}#${name}`)
}

/**
 * The SECOND phase: after the real faces registered, confirm every one of them is visible.
 *
 * The pre-load probe proves the declaration SHAPE is accepted; it cannot prove that all of the real
 * registrations landed. A silently dropped schema or tool fails exactly the way this whole module
 * exists to prevent — the panel renders nothing, or the model never sees a tool — with no error
 * anywhere. So the keys are counted by EXACT key after registration (never by a bare total, which
 * an un-withdrawn probe would inflate) and every tool name is read back.
 *
 * Warn-only, for the reason the memory plugin records for its own post-registration count: by now
 * the plugin is mounted, so there is no clean "do not load" left to take. Silent when everything is
 * there — a healthy boot keeps its single `compat: ok` line.
 *
 * Known limit: invocation ENDPOINTS are not observable through the documented query surface
 * (`list`/`listPackages` expose schemas and the package model only), so the four descriptors are
 * covered through the schema keys they use, not counted themselves.
 * @param input - the live context, the real tool names, and the logger.
 * @returns the registrations that did not show up (empty on success).
 */
export function verifyRegisteredFaces(input: {
  readonly ctx: CompatContext
  readonly packageId: string
  /** Wire schema names the caller registered; skipped when omitted. */
  readonly schemaNames?: readonly string[]
  readonly toolNames: readonly string[]
  readonly log: CompatLogger
}): { readonly missing: readonly string[] } {
  const expectedKeys = declaredSchemaKeys(input.packageId, input.schemaNames ?? [])
  const missing: string[] = []

  const typert = input.ctx.get('typert') as unknown
  if (isRecord(typert) && typeof typert['list'] === 'function') {
    try {
      const rows = (typert['list'] as (filter?: unknown) => unknown)({ package: input.packageId })
      const listed = new Set(
        (Array.isArray(rows) ? rows : [])
          .map((row) => (isRecord(row) ? row['key'] : undefined))
          .filter((key): key is string => typeof key === 'string'),
      )
      for (const key of expectedKeys) if (!listed.has(key)) missing.push(key)
    } catch (error) {
      input.log.warn(`${COMPAT_PREFIX} WARNING — the post-registration schema check could not run (${reasonOf(error)})`)
    }
  }

  const tools = input.ctx.get('tools') as unknown
  if (isRecord(tools) && typeof tools['get'] === 'function') {
    for (const name of input.toolNames) {
      try {
        if ((tools['get'] as (name: string) => unknown)(name) === undefined) missing.push(name)
      } catch {
        missing.push(name)
      }
    }
  }

  if (missing.length > 0) {
    input.log.warn(
      `${COMPAT_PREFIX} WARNING — ${String(missing.length)} of ${String(expectedKeys.length + input.toolNames.length)} `
      + `real registrations are not visible afterwards: ${missing.join(', ')} — the plugin is already mounted, so this is `
      + 'reported rather than undone; rebuild against this machine\'s dsh (`pnpm build:dsh`), restart `dsh`, and check again',
    )
  }
  return { missing }
}
