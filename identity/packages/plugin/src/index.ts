/**
 * `@avantf/dsh-identity` — the host half.
 *
 * The mechanism is the spec's §3.2 and nothing else:
 *
 *   ① an ordinary section named `avantf:identity` is registered in the HARNESS IDENTITY's own slot
 *      (`getSectionOrder('HARNESS_IDENTITY')` → -1000), whose text is the three files rendered;
 *   ② a `system-prompt/assemble` waterfall listener removes TWO NAMED sections
 *      (`harness:identity`, `deployment:persona-prefix`) and changes nothing else.
 *
 * `complete: true` is deliberately NOT used: that flag replaces the WHOLE section list, which would
 * take the ~20 capability-guidance sections the rest of the deployment registers with it. The
 * waterfall's return value is authoritative exactly because no complete section is registered.
 *
 * Scope: `replaceScope: 'session'` (the default) stops at the main agent, so a delegated child keeps
 * its native identity — including the persona `dsh-subagent` gives it. That is `isMainAgent` below,
 * and it is asserted byte-for-byte in `test/mechanism.spec.ts`.
 *
 * @module @avantf/dsh-identity
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import { PERSONA_PREFIX_SECTION, type AssembleContext, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { loadBase } from './base.js'
import { IdentityGateway } from './gateway.js'
import { stillActive } from './interface_gate.js'
import { createLogger, type IdentityLogger } from './log.js'
import { resolveDataHomeMirror } from './paths.js'
import { resolveAssetsDir } from './presets.js'
import { SessionFreeze } from './session-freeze.js'
import { IdentityState, type IdentitySettings } from './state.js'
import { volatileValue } from './volatile.js'
import { hostContribution } from './wire.js'

/** Cordis plugin name; matches the row id in the profile and the settings namespace. */
export const name = 'avantf-identity'

/**
 * The prompt service is the ONLY required service: without it there is no mechanism to install, and
 * `typert` / `settings` / `profileContext` are all read optionally so a headless composition (and the
 * mechanism spec's bare Context) mounts in full.
 */
export const inject = ['systemPrompt']

/** The section this plugin owns, and the two the default `drop` list names. */
export const OWN_SECTION = 'avantf:identity'
/** The harness identity's section name. A literal upstream (`PromptSectionOrderName` is a NUMBER), pinned by a spec. */
export const HARNESS_IDENTITY_SECTION = 'harness:identity'
/** The default drop list: the two identity-bearing sections, never the persona SUFFIX (it is information). */
export const DEFAULT_DROP: readonly string[] = [HARNESS_IDENTITY_SECTION, PERSONA_PREFIX_SECTION]
/** The default byte budget for the rendered identity. `0` disables the budget. */
export const DEFAULT_MAX_BYTES = 65536

export interface Config {
  /** The master switch: `true` replaces the identity, `false` (the default) leaves the prompt native. */
  enabled?: Volatile<boolean | undefined>
  /** Whether `{{variable}}` references in the files are interpolated (default false: the file is literal text). */
  interpolate?: Volatile<boolean | undefined>
  /** `session` (default) replaces the main agent's identity only; `all` also replaces delegated children's. */
  replaceScope?: Volatile<'session' | 'all' | undefined>
  /** The section NAMES the waterfall removes when the switch is on. */
  drop?: Volatile<readonly string[] | undefined>
  /** Byte budget for the rendered identity; over it, the text is truncated with a visible notice. */
  maxBytes?: Volatile<number | undefined>
  /** Overrides the profile name when no `profileContext` is present (default: the profile context's name, else `default`). */
  profile?: Volatile<string | undefined>
  /** Layer ② of the family data-root rule, BELOW `$AVANTF_HOME`. */
  dataHome?: Volatile<string | undefined>
  /** The preset last applied through the settings page (recorded; empty means "custom"). */
  activePreset?: Volatile<string | undefined>
  /** The locale that preset was applied in, so a language change can offer a re-apply. */
  activeLocale?: Volatile<string | undefined>
}

export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  interpolate: z.boolean().default(false).volatile(),
  replaceScope: z.union([z.const('session'), z.const('all')]).default('session').volatile(),
  drop: z.array(z.string()).default([...DEFAULT_DROP]).volatile(),
  maxBytes: z.natural().default(DEFAULT_MAX_BYTES).volatile(),
  profile: z.string().default('').volatile(),
  dataHome: z.string().default('').volatile(),
  activePreset: z.string().default('').volatile(),
  activeLocale: z.string().default('').volatile(),
})

/** The header of `AssembleContext.agent.session`, declared structurally: `dsh-agent` is not a peer. */
interface SessionHeaderLike {
  readonly origin?: string
  readonly delegationDepth?: number
}

/**
 * Whether this assembly belongs to the MAIN agent.
 *
 * `dsh-subagent` marks a delegated child with `origin: 'subagent'` and a non-zero `delegationDepth`;
 * either is enough to leave it alone. An unknown shape is "cannot tell", and "cannot tell" counts as
 * MAIN: the switch is the user's instruction about their own session, and a shape we do not recognize
 * is not evidence that we are looking at a child.
 */
export function isMainAgent(context: AssembleContext): boolean {
  const agent = (context as AssembleContext & {
    readonly agent?: { readonly session?: { readonly header?: SessionHeaderLike } }
  }).agent
  const header = agent?.session?.header
  return header?.origin !== 'subagent' && (header?.delegationDepth ?? 0) === 0
}

/**
 * The freeze key for one assembly: the agent's session object, taken structurally because `dsh-agent`
 * is not a peer (`assembleContextFor` passes the agent as both `agent` and `scope`). `undefined` means
 * the assembly is not tied to a session, and then the text is read live.
 */
export function sessionKeyOf(context: AssembleContext): object | undefined {
  const agent = (context as AssembleContext & { readonly agent?: { readonly session?: unknown } }).agent
  const session = agent?.session
  return session !== null && typeof session === 'object' ? session : undefined
}

/** The profile name the host is running, when the composition says so. */
function profileContextName(ctx: Context): string | undefined {
  try {
    const profileContext = ctx.get('profileContext') as { readonly name?: unknown } | undefined
    const value = profileContext?.name
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/** This package's version, read beside the entry; `unknown` when the record is unreachable. */
function packageVersion(): string {
  for (const relative of ['../package.json']) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
    } catch {
      // Fall through to the next candidate.
    }
  }
  return 'unknown'
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Start-up, AFTER everything that must be registered has been registered. Never rejects: every
 * environment failure is one warning, and the plugin is already mounted and working when it happens.
 */
async function initialize(options: {
  readonly ctx: Context
  readonly state: IdentityState
  readonly settings: () => IdentitySettings
  readonly log: IdentityLogger
}): Promise<void> {
  const { ctx, state, settings, log } = options
  try {
    const base = await loadBase({ log })
    if (!stillActive(ctx)) {
      log.warn('unmounted while preparing the environment; leaving the data home as it was resolved')
      return
    }
    const resolve = base?.dataHome ?? resolveDataHomeMirror
    state.setDataHome(resolve({ configured: settings().dataHome }))
    log.info(base === undefined
      ? `data home resolved by this plugin's own mirror: ${state.dataHome}`
      : `data home resolved by @avantf/dsh-plugin-base: ${state.dataHome}`)
    const assetsDir = resolveAssetsDir()
    if (assetsDir === undefined) {
      log.warn('the built-in preset assets are missing from this build; no preset was released')
      return
    }
    const provisioned = state.provision(assetsDir)
    log.info(`preset library ready at ${state.presetsDir} (released: ${provisioned.copied.length === 0 ? 'nothing new' : provisioned.copied.join(', ')})`)
  } catch (error) {
    // Belt and braces: nothing above should throw, and if it does the plugin still mounts.
    log.warn(`startup initialisation failed (${reasonOf(error)}); the plugin mounts with the data home it can resolve`)
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const log = createLogger(ctx.logger)

  /**
   * One live snapshot of the Config, read at the moment of use. The volatile fields are READ through
   * their references (`volatileValue`) precisely so the switch takes effect without a restart: a
   * captured boolean would freeze the value this mount started with.
   */
  const settings = (): IdentitySettings => ({
    enabled: volatileValue(config.enabled, false),
    interpolate: volatileValue(config.interpolate, false),
    replaceScope: volatileValue(config.replaceScope, 'session'),
    drop: volatileValue(config.drop, DEFAULT_DROP),
    maxBytes: volatileValue(config.maxBytes, DEFAULT_MAX_BYTES),
    profile: volatileValue(config.profile, ''),
    dataHome: volatileValue(config.dataHome, ''),
    activePreset: volatileValue(config.activePreset, ''),
    activeLocale: volatileValue(config.activeLocale, ''),
  })

  const state = new IdentityState({
    // The provisional answer, replaced by the base's own rule once it is loaded: the family mirror is
    // what the base would say with no base present, so nothing is invented in the meantime.
    dataHome: resolveDataHomeMirror({ configured: settings().dataHome }),
    profile: () => profileContextName(ctx) ?? settings().profile,
    maxBytes: () => settings().maxBytes,
    version: packageVersion(),
    logger: log,
  })

  log.info(`mounting: enabled=${String(settings().enabled)} profile=${state.profile} assets=${String(resolveAssetsDir() ?? 'MISSING')}`)

  // ── ① the identity section, in the harness identity's own slot ────────────────────────────────
  // An ordinary section: no `complete`. Its text is evaluated at EVERY assembly — but read from disk
  // only ONCE PER SESSION (`SessionFreeze`), so applying a preset or editing the files mid-session
  // cannot rewrite the prompt of the conversation that is already running; the next session reads the
  // files again. The switch is frozen with it: `sectionText` returns `''` when it was off at session
  // start, and that `''` is what the session keeps.
  //
  // Held in a VARIABLE rather than passed as a fresh object literal ON PURPOSE: `PromptSection.
  // interpolate` does not exist on the dsh 0.1.5 line (it arrives by 0.1.7), and TypeScript's
  // excess-property check rejects a fresh literal against that older, narrower type. A variable is
  // structurally assignable to it, so ONE source compiles against every declared peer line; a host
  // that predates the field ignores it and interpolates by its own (strict) rules — the README states
  // that exactly, because there it cannot be turned off. (The text PROVIDER form, by contrast, is on
  // every declared line including 0.1.5 — checked against the floor's own `.d.ts`.)
  const freeze = new SessionFreeze()
  const ownSection = {
    name: OWN_SECTION,
    order: ctx.systemPrompt.getSectionOrder('HARNESS_IDENTITY'),
    interpolate: settings().interpolate,
    text: (context: AssembleContext) => freeze.text(sessionKeyOf(context), () => state.sectionText(settings().enabled)),
  }
  ctx.effect(() => ctx.systemPrompt.section(ownSection), 'avantf-identity:section')

  // ── ② the named waterfall filter ──────────────────────────────────────────────────────────────
  // `await next()` FIRST: a cordis waterfall listener that does not call `next` vetoes the whole chain,
  // and the outermost return value is the final assembly. Only the named sections are dropped — every
  // other section, plus `tools`, `contexts` and `variables`, passes through untouched.
  ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly> => {
    const out = await next()
    const snapshot = settings()
    const own = out.sections.find((section) => section.name === OWN_SECTION)
    // The decision follows the SECTION TEXT, not the live switch: that text is this session's frozen
    // identity, and `''` in it already means "the switch was off when this session started". Reading the
    // live `enabled` here would let a mid-session flip drop our section and bring the native identity
    // back — the prompt would change under the reader after all, which is what the freeze prevents.
    const applicable = own !== undefined
      && own.text.length > 0
      && (snapshot.replaceScope === 'all' || isMainAgent(context))
    const drop = new Set<string>(applicable ? snapshot.drop : [OWN_SECTION])
    if (drop.size === 0) return out
    const sections = out.sections.filter((section) => !drop.has(section.name))
    // Identity when nothing matched: returning the same object keeps the waterfall free of churn on
    // the common (switch off) path.
    return sections.length === out.sections.length ? out : { ...out, sections }
  })

  // ── ③ the host face of the Remote namespace ───────────────────────────────────────────────────
  // Publishing the service is unconditional: the mount smoke (and any headless probe) reads it, and a
  // composition with no typert registry must still mount. Only the registry call is guarded.
  new IdentityGateway(ctx, state, settings, log)
  const typert = ctx.get('typert') as { register?: (contribution: unknown) => unknown } | undefined
  if (typert === undefined || typeof typert.register !== 'function') {
    log.warn('no typert registry mounted; the settings page will report it instead of reading the identity files')
  } else {
    try {
      typert.register(hostContribution)
      log.info(`typert host face registered (namespace avantfIdentity, ${String((hostContribution as unknown as { invocations?: readonly unknown[] }).invocations?.length ?? 0)} invocations)`)
    } catch (error) {
      log.error(`typert host face FAILED to register: the settings page will report it; the prompt mechanism mounts anyway — ${reasonOf(error)}`)
    }
  }

  // ── ④ the whole page is ours: turn the host's auto-generated form off ─────────────────────────
  // The volatile fields are still readable/writable through `configForms`; what is suppressed is the
  // Plugins page's second, redundant rendering of the same config.
  ctx.inject(['settings'], (child: Context) => {
    child.effect(() => {
      // Read structurally rather than through the `settings` service augmentation: this plugin declares
      // no `dsh-settings` peer, and the ONE call it makes is `configure`. A host whose settings service
      // has a different shape degrades to "the auto form stays on", which is cosmetic.
      const forms = child.get('settings') as
        | { configure?: (presentation: { auto?: boolean }, owner?: unknown) => (() => void) | void }
        | undefined
      if (forms === undefined || typeof forms.configure !== 'function') return () => undefined
      return forms.configure({ auto: false }, ctx.fiber) ?? (() => undefined)
    }, 'avantf-identity:no-auto-form')
  })

  // ── ⑤ environment preparation, awaited so `apply` never leaves a rejection behind ─────────────
  await initialize({ ctx, state, settings, log })
}
