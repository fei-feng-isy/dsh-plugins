/**
 * This plugin's compatibility spec, and the wiring that runs it.
 *
 * The rules, the probes, the report and the post-registration check all live in the family base
 * `@avantf/dsh-plugin-base` — its `compat` module, which used to be the separate
 * `@avantf/dsh-compat` package, shipped in the one base release. What stays here is only what is true
 * of THIS plugin: the services and methods it calls, the dsh packages that identify the host, the
 * wire schema names and tool names that must be visible afterwards, the events it listens to, and the
 * Chinese report a user reads. See `DESIGN.md` §12.1.
 *
 * **Who obtains the base.** Not this module. The base IS the framework the inlined bootstrap resolves
 * and loads at startup (`src/envinit.ts`), and the compatibility gate arrives WITH it: there is no
 * `mem:compat` manifest item, no npm download and no managed `<home>/compat/**` copy any more. This
 * module is handed the loaded module and derives everything from it.
 *
 * The base therefore has NO import path of its own here — not even a dynamic one. A static `import`
 * would throw `ERR_MODULE_NOT_FOUND` while the artifact was being evaluated (the base is a PEER, not
 * a runtime dependency of the published plugin), and a bare dynamic `import()` would bypass the module
 * the bootstrap already resolved. The plugin only ever sees the module object it was handed.
 *
 * The plugin computes the gate's verdict here and hands it to the engine as plain data
 * (`{ load, status, reason }`), so the inlined engine bundle never imports the base either.
 *
 * @module @avantf/dsh-mem/provision
 */
import type {
  CompatContext,
  CompatEvidence,
  CompatLogger,
  CompatSpec,
  CompatVerdict,
  ServiceContract,
} from '@avantf/dsh-plugin-base'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { hostContribution } from './remote.js'

export type { CompatEvidence, CompatVerdict }

/** The base package, typed but never imported (see the module note). */
export type CompatModule = typeof import('@avantf/dsh-plugin-base')

/** The base package id, named here so the gate's messages need no import of it. */
export const COMPAT_PACKAGE = '@avantf/dsh-plugin-base'

/**
 * The services this plugin calls, with the methods it calls on them.
 *
 * `required` is this plugin's REFUSAL policy, not cordis's `inject`: `typert` is injected (the real
 * wire face is registered at mount) yet a composition without the registry must still mount the
 * memory tools, so its absence is a note rather than a refusal. Optional services are read with
 * `ctx.get()`.
 *
 * `tools` lists only `register` because that is the one method this plugin calls; the post-load
 * check reads `get`, but guards it and degrades to "not verified", so demanding it here would refuse
 * a host this plugin can still drive.
 */
export const SERVICE_CONTRACTS: readonly ServiceContract[] = [
  { name: 'tools', required: true, methods: ['register'] },
  { name: 'systemPrompt', required: true, methods: ['section', 'context'] },
  { name: 'typert', required: false, methods: ['register', 'get', 'list', 'listPackages', 'toJSONSchema'] },
  // Read with `ctx.get()` only by the refusal megaphone; a host without it must not become a refusal.
  { name: 'commands', required: false, methods: ['register'] },
]

/**
 * The events this plugin listens to — reported, never verified.
 *
 * A listener for a name the host no longer emits registers happily and then never runs: the house
 * hints would simply stop appearing. Nothing inside a plugin can prove the host still emits a name,
 * so the list is a known limit the gate records and the running dsh version is the operator's signal.
 */
export const REQUIRED_EVENTS: readonly string[] = ['agent/inbox/inserted', 'tools/result']

/** Packages released in lockstep with dsh; their version says which dsh is running. */
export const VERSION_PACKAGES: readonly string[] = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol']

/** This plugin's npm package id, which names the probe and verification keys. */
const PACKAGE_ID = String((hostContribution as unknown as { package?: unknown }).package ?? '@avantf/dsh-mem')

/** The base loaded once, with everything derived from it for THIS plugin. */
export interface CompatRuntime {
  readonly module: CompatModule
  /** The base's log token (`compat:`). */
  readonly prefix: string
  /** Everything the shared gate needs to judge this plugin. */
  readonly spec: CompatSpec
  /** The schema names this plugin's wire face declares, derived from the contribution itself. */
  readonly schemaNames: readonly string[]
}

/** The gate's outcome. */
export interface CompatRun {
  /** The verdict `apply` branches on. Plain data — the engine's provisioning guard reads it too. */
  readonly verdict: CompatVerdict
}

/** Best-effort one-line reason for a caught value. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Emit a warning without ever letting the logger turn it into a crash. */
export function warn(log: CompatLogger | undefined, message: string): void {
  try {
    log?.warn(message)
  } catch {
    // A logger that throws is not evidence of anything.
  }
}

/**
 * Build the plugin-specific half of the gate from a loaded base.
 *
 * Called ONCE per process (the loaded runtime is cached by `src/envinit.ts`), which is what makes the
 * lazy construction equivalent to the module-level constants it replaces — `readBuildVersions` still
 * reads the baked `lib/dsh-build.json` beside the built entry, falling back per package to the peer
 * range floor when it is absent (a dev tree, a test run).
 */
export function runtimeFromCompat(module: CompatModule): CompatRuntime {
  const peerFloors = module.readDeclaredVersions(new URL('../package.json', import.meta.url), VERSION_PACKAGES)
  const buildVersionsUrl = new URL(`./${module.BUILD_VERSIONS_FILE}`, import.meta.url)
  const schemaNames = module.schemaNamesFrom(hostContribution)
  const spec: CompatSpec = {
    packageId: PACKAGE_ID,
    services: SERVICE_CONTRACTS,
    // The version THIS BUILD was compiled against: the exact one baked at build time, falling back
    // per package to the peer range floor. A range floor alone cannot say what the build linked.
    declared: module.readBuildVersions(buildVersionsUrl, VERSION_PACKAGES, peerFloors),
    // Resolved from THIS package's links: the packages that identify the host are its peers. Note
    // this is NOT the host's identity — see the base package's README «已知边界».
    runtime: module.readRuntimeVersions(VERSION_PACKAGES, import.meta.url),
    // The base package knows no dsh type, so the probe's declaration comes from here — the probe must
    // mirror the declaration path the REAL tools use.
    probeTool: module.toolProbeDeclaration(defineTool),
    // The wire probe IS the real host face, codecs and all. A probe that merely RESEMBLED it once
    // reported `ok` on a 0.1.6 host whose codec contract had moved, and the real registration then
    // threw halfway through `apply` — the half-mounted outcome this gate exists to prevent. Same
    // object, same host, so "the probe passed" now means "this registration passes".
    probeTypert: () => hostContribution,
    schemaNames,
    events: REQUIRED_EVENTS,
  }
  return { module, prefix: module.COMPAT_PREFIX, spec, schemaNames }
}

/** The "the check itself failed" outcome: keep loading, say why. */
function cannotDetermine(error: unknown, log: CompatLogger, prefix: string): CompatRun {
  const message = `${prefix} WARNING — the compatibility check itself failed (${reasonOf(error)}); loading anyway`
  warn(log, message)
  return {
    verdict: {
      load: true,
      skipped: true,
      status: 'probe-skipped',
      problems: [],
      warnings: [message],
      notes: ['the check itself failed'],
      lines: [{ level: 'warn', message }],
      reason: '',
    },
  }
}

/**
 * Run the gate. Call this FIRST in `apply()`: on a refusal nothing has been registered yet, so
 * "do not load" costs nothing to unwind. Never throws — not even with a throwing logger, because
 * "cannot tell" is not "incompatible".
 * @param ctx - the plugin's context.
 * @param log - the plugin's logger.
 * @param compat - the loaded gate runtime (see `src/envinit.ts`).
 * @param spec - what to judge (defaults to the runtime's spec; injectable so the version path is
 *   testable without a second host).
 * @returns the verdict `apply` branches on.
 */
export function provision(
  ctx: CompatContext,
  log: CompatLogger,
  compat: CompatRuntime,
  spec: CompatSpec = compat.spec,
): CompatRun {
  let evidence: CompatEvidence
  try {
    evidence = compat.module.gatherEvidence(ctx, spec)
  } catch (error) {
    return cannotDetermine(error, log, compat.prefix)
  }
  let verdict: CompatVerdict
  try {
    verdict = compat.module.verdictOf(evidence)
  } catch (error) {
    return cannotDetermine(error, log, compat.prefix)
  }
  for (const line of verdict.lines) {
    try {
      log[line.level](line.message)
    } catch {
      // A logger that throws must not turn a verdict into a crash.
    }
  }
  return { verdict }
}

/**
 * Keep one `/mem` command that reports a refusal.
 *
 * The plugin provides nothing else when it refuses, and the alternative is a user watching a tab
 * that never loads with no way to ask why.
 * @param ctx - the plugin's context.
 * @param verdict - the refusal to report.
 * @param log - the plugin's logger.
 * @param compat - the loaded gate runtime.
 */
export function registerCompatMegaphone(
  ctx: CompatContext,
  verdict: CompatVerdict,
  log: CompatLogger,
  compat: CompatRuntime,
): void {
  compat.module.registerMegaphone({
    ctx,
    log,
    command: { name: 'mem', description: '报告记忆插件为何未加载（兼容性检查未通过）' },
    text: compat.module.compatReport(verdict, {
      heading: '记忆插件未加载：与当前 dsh 的兼容性检查未通过，插件已拒绝加载（不注册服务、工具、prompt 段与真实 typert face）。',
      warningsLabel: '风险提示：',
      warnings: verdict.warnings,
      fix: '修复：在本仓库重建（`pnpm build:dsh`），或把 `@deepseek-ai/dsh` 换回本构建声明的版本。',
    }),
  })
}

/**
 * The second phase: every real registration must be visible afterwards.
 *
 * Warn-only by design — the plugin is mounted by now, so there is no clean "do not load" left to
 * take, and a silently dropped schema or tool is exactly what nothing else would report.
 * @param input - the live context, the real tool names, the logger, and the loaded gate runtime.
 * @returns the registrations that did not show up (empty on success).
 */
export function verifyRegisteredFaces(input: {
  readonly ctx: CompatContext
  readonly toolNames: readonly string[]
  readonly log: CompatLogger
  readonly compat: CompatRuntime
}): { readonly missing: readonly string[] } {
  return input.compat.module.verifyRegisteredFaces({
    ctx: input.ctx,
    log: input.log,
    packageId: input.compat.spec.packageId,
    schemaNames: input.compat.schemaNames,
    toolNames: input.toolNames,
  })
}
