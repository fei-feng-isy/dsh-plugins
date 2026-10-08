/**
 * Environment initialisation for the mission plugin through `@avantf/dsh-plugin-base`: the family
 * base contains BOTH the startup provisioning framework AND the compatibility gate, so the
 * runtime-only breakage a hand-written Typert wire face is exposed to is judged by a module the
 * inlined bootstrap already loaded — no `mission:compat` item, no npm download, no managed
 * `~/.avantf/env/compat/**`.
 * The base is never statically imported (a value import would throw before the inlined bootstrap
 * ran), and nothing here refuses the mount: "cannot tell" is a WARNING with the plugin intact,
 * only a PROVEN break (`probe-failed`) refuses.
 * @module @avantf/dsh-mission/envinit
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadFramework } from './envinit-bootstrap.js'
import { createLoadCache, gateOrDegrade, loadGuarded, type DegradeWords } from './interface_gate.js'
import { hostContribution } from './wire.js'

/** The framework package, as declared in this plugin's `peerDependencies`. */
const FRAMEWORK_PACKAGE = '@avantf/dsh-plugin-base'

/** The framework's module shape; `import type` only — the value is always loaded dynamically. */
type EnvinitModule = typeof import('@avantf/dsh-plugin-base')

/**
 * The family base, named once more where the gate reports on it. It is the SAME package as
 * {@link FRAMEWORK_PACKAGE}: the base carries the former environment framework AND the former
 * `@avantf/dsh-compat`, which is why the gate needs no item and no second import.
 */
const COMPAT_PACKAGE = '@avantf/dsh-plugin-base'

/** This plugin's package id — probe keys and the post-registration check use it. */
const PACKAGE_ID = '@avantf/dsh-mission'

/**
 * Packages released in lockstep with dsh, so their version says which dsh this build was made for.
 * This must list every `@deepseek-ai/dsh-*` entry `link-dsh.mjs` bakes into `dsh-build.json`, not
 * just the two the wire face imports: `pack-plugin.mjs` fails the release otherwise. A mismatch
 * stays a WARNING, never a refusal — `load` is decided by the proven-incompatibility list.
 */
const VERSION_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-spill',
  // Not listed: `dsh-storage`. It is a transitive dependency of the declared `dsh-storage-domain`, not
  // part of this plugin's compile surface, and `link-dsh.mjs` no longer links it (see the note there).
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
  // Listed although it is NOT a declared peer — deliberately, and measured: `src/index.ts` imports it
  // TYPE-ONLY for the `ctx.typert.register` augmentation, so it is part of what this build compiles
  // against and its version belongs in the drift report. Declaring it in `devDependencies` (tried
  // 2026-10-02, then reverted) makes `pnpm install` place the REGISTRY copy in `node_modules`, which
  // shadows the copy `link-dsh.mjs` links from the INSTALLED dsh — and at the declared dsh floor that
  // augmentation is gone: `pnpm check:old-dsh mission` fails with
  // `src/index.ts(274,14): error TS2339: Property 'register' does not exist on type 'TypertRegistryContract'`.
  // So the linked copy is the one that must win; the gate's `LINKS` list and this entry are the pair
  // that stays in sync instead. `readDeclaredVersions` reads only `peerDependencies`, so for this one
  // entry the per-package comparison falls back to the baked version — the report stays a WARNING
  // either way, and no load decision depends on it.
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-util-values',
]

const OWN_PREFIX = 'compat:'

/** The services this plugin calls: `required` is this plugin's refusal policy; `typert` and
 * `commands` are optional because the engine degrades without them. */
interface ServiceContract {
  readonly name: string
  readonly required: boolean
  readonly methods: readonly string[]
}

const SERVICE_CONTRACTS: readonly ServiceContract[] = [
  { name: 'tools', required: true, methods: ['register'] },
  { name: 'systemPrompt', required: true, methods: ['section', 'context', 'getSectionOrder'] },
  { name: 'storageDomain', required: true, methods: ['open'] },
  { name: 'subagents', required: true, methods: ['startContinuable', 'sendMessage', 'interrupt'] },
  { name: 'agents', required: false, methods: ['get'] },
  { name: 'commands', required: false, methods: ['register'] },
  { name: 'typert', required: false, methods: ['register', 'get'] },
]

// The events this plugin listens to — reported, never verified: a listener for a name the host no
// longer emits registers happily and never runs, which here is a wake-up that silently never fires.
const REQUIRED_EVENTS: readonly string[] = [
  'agent/created',
  'agent/disposed',
  'system-prompt/assemble',
  'subagent/end',
  'session/event',
  'agent/pre-step',
]

// ── the base's gate surface, declared structurally ─────────────────────────────────
// `@avantf/dsh-plugin-base` is loaded through the inlined bootstrap and never imported by specifier,
// so the slice this module uses is described here; the real module satisfies it. `import type` above
// is the compiler's view of the same surface, and `pack-plugin` asserts no value import survives.

export interface CompatContext {
  get(name: string): unknown
}

export interface CompatLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** What this plugin declares about itself, so the base's rules stay generic. */
interface CompatSpec {
  readonly packageId: string
  readonly services: readonly ServiceContract[]
  readonly declared: Readonly<Record<string, string | undefined>>
  readonly runtime?: Readonly<Record<string, string | undefined>>
  readonly probeTool?: () => unknown
  readonly probeTypert?: (packageId: string) => unknown
  readonly schemaNames?: readonly string[]
  readonly events?: readonly string[]
  readonly needsInterval?: boolean
}

interface CompatLine {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
}

export interface CompatVerdict {
  readonly load: boolean
  readonly skipped: boolean
  readonly status: string
  readonly problems: readonly string[]
  readonly warnings: readonly string[]
  readonly notes: readonly string[]
  readonly lines: readonly CompatLine[]
  readonly reason: string
}

export interface CompatModule {
  readonly COMPAT_PREFIX: string
  readonly BUILD_VERSIONS_FILE: string
  provision(ctx: CompatContext, log: CompatLogger, spec: CompatSpec): CompatVerdict
  compatReport(verdict: CompatVerdict, words: {
    readonly heading: string
    readonly fix: string
    readonly warningsLabel: string
    readonly warnings: readonly string[]
    /** Only present when the loaded base is new enough to accept it; see `compatReport`. */
    readonly logPointer?: (prefix: string) => string
  }): string
  registerMegaphone(input: {
    readonly ctx: CompatContext
    readonly log: CompatLogger
    readonly command: { readonly name: string; readonly description: string }
    readonly text: string
  }): void
  schemaNamesFrom(contribution: unknown): readonly string[]
  verifyRegisteredFaces(input: {
    readonly ctx: CompatContext
    readonly packageId: string
    readonly schemaNames?: readonly string[]
    readonly toolNames: readonly string[]
    readonly log: CompatLogger
  }): { readonly missing: readonly string[] }
  readDeclaredVersions(manifestUrl: string | URL, packages: readonly string[]): Record<string, string | undefined>
  readBuildVersions(
    buildUrl: string | URL,
    packages: readonly string[],
    fallback?: Readonly<Record<string, string | undefined>>,
  ): Record<string, string | undefined>
  readRuntimeVersions(packages: readonly string[], base?: string | URL): Record<string, string | undefined>
  toolProbeDeclaration(defineTool: (options: unknown) => unknown): () => unknown
}

/** The loaded base, with everything derived from it for THIS plugin. */
export interface CompatRuntime {
  readonly module: CompatModule
  /**
   * The loaded base module itself — the runtime source of the shared KIT (prompt files, logger,
   * family paths). `undefined` only in the test seam that injects a partial module; the real load
   * always has it. A capability missing here is a DEGRADATION, never a refusal.
   */
  readonly kit: EnvinitModule | undefined
  readonly prefix: string
  readonly spec: CompatSpec
  readonly schemaNames: readonly string[]
}

interface CompatLoadOptions {
  readonly log?: CompatLogger
  /** Test seam: the loaded base module, instead of bootstrapping it from this plugin's install. */
  readonly framework?: EnvinitModule
  /**
   * Test seam: a structural stand-in for the gate half of the base, so the refusal / megaphone /
   * post-registration shapes can be driven without a real host. The kit still comes from the module
   * {@link CompatLoadOptions.framework} names.
   */
  readonly compatModule?: CompatModule
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warn(log: CompatLogger | undefined, message: string): void {
  try {
    log?.warn(message)
  } catch {
    // A logger that throws is not evidence of anything.
  }
}
function runtimeFrom(module: CompatModule, kit?: EnvinitModule): CompatRuntime {
  const manifestUrl = new URL('../package.json', import.meta.url)
  const peerFloors = module.readDeclaredVersions(manifestUrl, VERSION_PACKAGES)
  const buildVersionsUrl = new URL(`./${module.BUILD_VERSIONS_FILE}`, import.meta.url)
  const schemaNames = module.schemaNamesFrom(hostContribution)
  const spec: CompatSpec = {
    packageId: PACKAGE_ID,
    services: SERVICE_CONTRACTS,
    // The version THIS BUILD was compiled against, falling back per package to the peer range floor.
    declared: module.readBuildVersions(buildVersionsUrl, VERSION_PACKAGES, peerFloors),
    runtime: module.readRuntimeVersions(VERSION_PACKAGES, import.meta.url),
    probeTool: module.toolProbeDeclaration(defineTool as unknown as (options: unknown) => unknown),
    // The probe IS the real host face, codecs and all: a probe that merely RESEMBLED it once
    // reported `ok` on a host whose codec contract had moved, and the real registration then threw.
    probeTypert: () => hostContribution,
    schemaNames,
    events: REQUIRED_EVENTS,
    // `host.ts` arms the sweep with `ctx.interval(...)` inside `start()`; injecting the `timer`
    // service does not put the mixin on the context, so the gate would pass a host that throws later.
    needsInterval: true,
  }
  return { module, kit, prefix: module.COMPAT_PREFIX, spec, schemaNames }
}

/**
 * The plugin-specific halves of the shared loader's sentences: mission says the COMPATIBILITY GATE
 * is skipped and names no legacy provisioning path. The mechanism is the shim's (`interface_gate.ts`),
 * the wording is this plugin's.
 */
const DEGRADE_WORDS: DegradeWords = {
  prefix: OWN_PREFIX,
  loadFailure: 'the compatibility gate is SKIPPED and the plugin will mount anyway',
  withheld: 'own prompt defaults, gate skipped',
}

/**
 * The gate runtime, cached once per process through the shared cache discipline: a FAILED load is
 * NOT cached, so a reload or a second instance retries instead of replaying the first failure for
 * the process lifetime.
 *
 * `loadGuarded` is what makes "never throws" true here: a shape mismatch or throw from a
 * framework/base whose declarations this plugin does not own would otherwise reject `apply`, which
 * Cordis answers by disposing the fiber — no service, no tools, not one warning.
 */
const cache = createLoadCache<CompatLoadOptions, CompatRuntime>((options) =>
  loadGuarded(options, loadCompatOnce, options.log, DEGRADE_WORDS),
)

/**
 * Ensure the framework, then the base, then this plugin's gate runtime. Never throws: it returns
 * `undefined` when the gate cannot run, and the caller then warns and mounts because a missing gate
 * is "cannot tell". Cached, so the spec is built once per process.
 */
export function loadCompat(options: CompatLoadOptions = {}): Promise<CompatRuntime | undefined> {
  return cache.load(options)
}

async function loadCompatOnce(options: CompatLoadOptions): Promise<CompatRuntime | undefined> {
  // Bootstrap → the base module (the package manager's copy, zero download). The declared range is
  // not judged here; the base package itself IS the source of the gate now.
  const framework = options.framework ?? await loadFramework<EnvinitModule>({
    logger: {
      warn: (message) => { warn(options.log, `${FRAMEWORK_PACKAGE}: ${message}`) },
      info: (message) => { options.log?.info(`${FRAMEWORK_PACKAGE}: ${message}`) },
    },
  })
  if (framework === undefined) {
    warn(
      options.log,
      `${OWN_PREFIX} WARNING — ${FRAMEWORK_PACKAGE} could not be made available; the compatibility gate is SKIPPED and the plugin mounts anyway`,
    )
    return undefined
  }
  // The RUNTIME interface gate, on its own axis: the generation this artifact was baked for versus the
  // one the loaded base reports. The DECISION is the base's (`checkInterface` plus its one reader of
  // the bake record); this plugin only consumes it. Package versions move every release and stay the
  // install-time gate (the peer range), so the generation number is the axis that means "the kit and
  // gate helper set I was written against is the one I loaded". The step itself is the shared shim's
  // (`gateOrDegrade`); this plugin supplies only its own wording (`DEGRADE_WORDS`).
  //
  // Why `incompatible` now DEGRADES rather than merely warning: the interface is the family's MAIN
  // contract, so a base from another generation is not one whose shared capabilities this build may
  // use. Taking the same route as "the base is unavailable" withholds them — the prompt layer falls
  // back to this plugin's own default text and the gate is skipped — while the mount itself (tools,
  // service, prompt sections, Remote, UI) always continues: only a PROVEN host break refuses, and a
  // generation mismatch is not one. `cannot-tell` (no gate on the loaded base, no bake record) warns
  // and uses the base anyway; "cannot tell" is never "incompatible".
  if (!gateOrDegrade(framework, options.log, DEGRADE_WORDS)) return undefined
  // The gate IS the base: `@avantf/dsh-plugin-base` carries the former environment framework AND the
  // former `@avantf/dsh-compat`. There is no `mission:compat` item to declare, nothing to download and
  // no managed `~/.avantf/env/compat/**`; a failure here degrades to a WARNING and the plugin still
  // mounts (see the module note: "cannot tell" is never "incompatible").
  try {
    // Only the TEST SEAM is cast. `options.compatModule` is a partial module by construction — but
    // `framework` is the REAL thing, and laundering it through `unknown` on its way into a hand-written
    // `CompatModule` meant the compiler checked nothing: every gate signature (`provision`,
    // `compatReport`, `registerMegaphone`, `schemaNamesFrom`, `verifyRegisteredFaces`, the
    // `read*Versions` family) could change and this file would still build. The kit half is typed the
    // same way through `EnvinitModule`, so the two halves behave alike only if this assignment is a
    // real structural check of mission's `CompatModule` against what base actually exports.
    const gate: CompatModule = options.compatModule ?? framework
    const runtime = runtimeFrom(gate, framework)
    return runtime
  } catch (error) {
    warn(
      options.log,
      `${OWN_PREFIX} WARNING — the ${COMPAT_PACKAGE} compatibility gate could not be initialised (${reasonOf(error)}); the compatibility gate is SKIPPED and the plugin will mount anyway`,
    )
    return undefined
  }
}

/** The "the check itself failed" outcome: keep loading, say why. */
function cannotDetermine(error: unknown, log: CompatLogger, prefix: string): CompatVerdict {
  const message = `${prefix} WARNING — the compatibility check itself failed (${reasonOf(error)}); loading anyway`
  warn(log, message)
  return {
    load: true,
    skipped: true,
    status: 'probe-skipped',
    problems: [],
    warnings: [message],
    notes: ['the check itself failed'],
    lines: [{ level: 'warn', message }],
    reason: '',
  }
}

/** Run the gate FIRST in `apply()`: on a refusal nothing is registered yet, so "do not load" costs nothing to unwind; never throws. */
export function provision(ctx: CompatContext, log: CompatLogger, compat: CompatRuntime): CompatVerdict {
  try {
    const verdict = compat.module.provision(ctx, log, compat.spec)
    return verdict
  } catch (error) {
    return cannotDetermine(error, log, compat.prefix)
  }
}

/** Keep one `/mission` command reporting the refusal; guarded, because on the REFUSAL path the report
 * is the user's only channel and a shape mismatch must not reject `apply` and take it down. */
export function registerCompatMegaphone(ctx: CompatContext, verdict: CompatVerdict, log: CompatLogger, compat: CompatRuntime): void {
  try {
    compat.module.registerMegaphone({
      ctx,
      log,
      command: { name: 'mission', description: '报告任务插件为何未加载（兼容性检查未通过）' },
      text: compat.module.compatReport(verdict, {
        heading: '任务插件未加载：与当前 dsh 的兼容性检查未通过，插件已拒绝加载（不注册服务、工具、prompt 段与真实 typert face）。',
        warningsLabel: '风险提示：',
        warnings: verdict.warnings,
        fix: '修复：换到本插件声明兼容的 dsh 版本，或升级本插件到与当前 dsh 匹配的版本。',
        logPointer: (prefix) => `完整诊断见宿主日志里 ${prefix} 开头的行。`,
      }),
    })
  } catch (error) {
    warn(log, `${compat.prefix} WARNING — the refusal report could not be registered (${reasonOf(error)}); the plugin still refused to load`)
  }
}

/** Second phase: every real registration must be visible afterwards; warn-only, since the plugin is
 * mounted by now and no clean "do not load" is left. */
export function verifyRegisteredFaces(input: {
  readonly ctx: CompatContext
  readonly toolNames: readonly string[]
  readonly log: CompatLogger
  readonly compat: CompatRuntime
}): { readonly missing: readonly string[] } {
  try {
    return input.compat.module.verifyRegisteredFaces({
      ctx: input.ctx,
      packageId: input.compat.spec.packageId,
      schemaNames: input.compat.schemaNames,
      toolNames: input.toolNames,
      log: input.log,
    })
  } catch (error) {
    input.log.warn(`${input.compat.prefix} WARNING — the post-registration check itself failed (${reasonOf(error)})`)
    return { missing: [] }
  }
}
