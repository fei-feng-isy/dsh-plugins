#!/usr/bin/env node
/**
 * Real-Cordis mount smoke for `@avantf/dsh-identity`: loads the plugin in an actual
 * `@deepseek-ai/cordis` Context alongside the REAL `@deepseek-ai/dsh-system-prompt` service, and
 * asserts what a mount can prove without a model:
 *
 *   - the plugin mounts and publishes its `avantfIdentity` Remote service;
 *   - the `avantf:identity` section is registered at the harness identity's own order (-1000);
 *   - the built-in presets are materialized under `<data home>/identity/presets/`, missing-only (an
 *     edited file survives);
 *   - the waterfall mechanism: disabled ⇒ the assembly is byte-identical to native; enabled ⇒ exactly
 *     `harness:identity` + `deployment:persona-prefix` disappear (all other sections, `tools` and
 *     `contexts` byte-identical), the identity section sits FIRST, and a delegated child assembly is
 *     byte-identical to native.
 *
 * Requires the built artifacts (`pnpm build`). Peers resolve from the plugin's own
 * `node_modules/@deepseek-ai` links (`node scripts/link-dsh.mjs --runtime`) — no harness checkout.
 *
 * PACKED-ARTIFACT MODE — `AVANTF_PLUGIN_DIR` (the extracted tarball's package directory) plus
 * `AVANTF_MOUNT_SCRATCH` (a profile the caller already prepared) makes this run link NOTHING and drive
 * only the mount, so a leaked `@avantf/*` import has nothing to resolve. `pack-plugin.mjs --mount` is
 * the caller.
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const packagedDir = process.env['AVANTF_PLUGIN_DIR']
const preparedScratch = process.env['AVANTF_MOUNT_SCRATCH']
const pluginDir = packagedDir ?? join(repo, 'packages', 'plugin')
const packagedProfile = packagedDir !== undefined && preparedScratch !== undefined

const scratch = preparedScratch ?? mkdtempSync(join(tmpdir(), 'avantf-identity-mount-'))
const ownsScratch = preparedScratch === undefined
const dataHome = join(scratch, 'data')
const PROFILE = 'web'
mkdirSync(join(scratch, 'node_modules', '@deepseek-ai'), { recursive: true })
mkdirSync(join(scratch, 'node_modules', '@avantf'), { recursive: true })
mkdirSync(dataHome, { recursive: true })

// Point the family root (`$AVANTF_HOME`) at the scratch tree so a smoke never touches the real one.
process.env['AVANTF_HOME'] = dataHome

// ── which profile this run is ─────────────────────────────────────────────────
const entryRequire = createRequire(join(pluginDir, 'lib', 'index.js'))
const baseDir = (() => {
  try {
    return dirname(entryRequire.resolve('@avantf/dsh-plugin-base/package.json'))
  } catch {
    return undefined
  }
})()
const absentRequested = process.env['AVANTF_COMPAT_ABSENT'] === '1'
const baseReady = baseDir !== undefined && existsSync(join(baseDir, 'dist', 'index.js'))
if (!baseReady && !absentRequested) {
  console.error(`mount-smoke: @avantf/dsh-plugin-base is not installed/built for the plugin (${baseDir ?? `unresolved from ${join(pluginDir, 'lib', 'index.js')}`})`)
  console.error('  without it the inlined bootstrap only warns and the plugin mounts degraded,')
  console.error('  which is not what this smoke verifies. Run: pnpm install && pnpm build:base')
  console.error('  to exercise the documented degrade path instead:')
  console.error('    AVANTF_COMPAT_ABSENT=1 node scripts/mount-smoke.mjs --runtime')
  process.exit(1)
}
if (baseReady && absentRequested) {
  console.warn(`mount-smoke: AVANTF_COMPAT_ABSENT=1 — loading from ${packagedProfile ? 'a profile with no base linked' : 'a copy with no base in reach'}`)
}
const gateOn = !absentRequested

// ── resolution ────────────────────────────────────────────────────────────────
const runtimePeers = join(pluginDir, 'node_modules', '@deepseek-ai')
const peersDir = packagedProfile ? join(scratch, 'node_modules', '@deepseek-ai') : runtimePeers

if (!packagedProfile) {
  if (!existsSync(runtimePeers)) {
    console.error('mount-smoke: the @deepseek-ai peers are not linked — run `node scripts/link-dsh.mjs --runtime` (or pnpm build:dsh) first')
    process.exit(1)
  }
  for (const name of readdirSync(runtimePeers)) {
    symlinkSync(join(runtimePeers, name), join(scratch, 'node_modules', '@deepseek-ai', name), 'dir')
  }
  symlinkSync(join(pluginDir, 'node_modules', 'zod'), join(scratch, 'node_modules', 'zod'), 'dir')
  if (!absentRequested) {
    symlinkSync(join(pluginDir, 'node_modules', '@avantf', 'dsh-plugin-base'), join(scratch, 'node_modules', '@avantf', 'dsh-plugin-base'), 'dir')
  }
}

/**
 * The plugin artifact to load.
 *
 * NORMAL: the built artifact in place, so the base resolves from the plugin's own install.
 * ABSENT (workspace): a COPY of the same built artifact one level under the scratch tree where no
 * `@avantf/dsh-plugin-base` exists, which is what makes "the base is missing" true rather than
 * simulated.
 */
let pluginEntry = join(pluginDir, 'lib', 'index.js')
if (absentRequested && !packagedProfile) {
  const copy = join(scratch, 'plugin')
  mkdirSync(copy, { recursive: true })
  cpSync(join(pluginDir, 'lib'), join(copy, 'lib'), { recursive: true })
  cpSync(join(pluginDir, 'package.json'), join(copy, 'package.json'))
  pluginEntry = join(copy, 'lib', 'index.js')
}

const { Context } = require(join(peersDir, 'cordis'))
const promptModule = await import(pathToFileURL(join(peersDir, 'dsh-system-prompt', 'lib', 'index.js')).href)
const SystemPrompt = promptModule.default
const PERSONA_PREFIX_SECTION = promptModule.PERSONA_PREFIX_SECTION
const plugin = await import(pathToFileURL(pluginEntry).href)

// ── the profile's identity files (written BEFORE the mount: the section reads the disk) ─────────
const profileDir = join(dataHome, 'identity', 'profiles', PROFILE)
mkdirSync(profileDir, { recursive: true })
const IDENTITY_TEXT = '你是「小身份」。\n\n' + '语气温和，先说结论。\n\n' + '禁止编造事实。'
writeFileSync(join(profileDir, 'IDENTITY.md'), '你是「小身份」。\n', 'utf8')
writeFileSync(join(profileDir, 'SOUL.md'), '语气温和，先说结论。\n', 'utf8')
writeFileSync(join(profileDir, 'RULES.md'), '禁止编造事实。\n', 'utf8')

// A pre-existing preset file the materializer must never overwrite.
const editedPreset = join(dataHome, 'identity', 'presets', 'assistant', 'zh', 'SOUL.md')
mkdirSync(dirname(editedPreset), { recursive: true })
writeFileSync(editedPreset, 'USER EDITED PRESET\n', 'utf8')

// ── the stand-ins for the deployment ─────────────────────────────────────────
const NATIVE_PERSONA = 'You are a coding agent powered by the {{model}} model.'
const SUFFIX = 'Your working directory is {{cwd}}.'
const OTHERS = [
  ['plan:policy', 500, 'Plan-mode policy prose.'],
  ['team:policy', 600, 'Agent Teams policy prose.'],
  ['tool:bash', 1000, 'bash tool guidance'],
  ['tool:fs', 1100, 'read tool guidance'],
  ['tool:jobs', 1600, 'jobs tool guidance'],
  ['tool:web', 2000, 'web tool guidance'],
  ['tool:workflow', 2600, 'workflow tool guidance'],
  ['tool:subagent', 2800, 'subagent tool guidance'],
  ['mcp:servers', 3100, 'mcp guidance'],
  ['tools:sdk', 5000, 'tools sdk guidance'],
  ['harness:source', 10000, 'The DeepSeek Harness implementation checkout is at /x.'],
  ['app:web-surface', 10100, 'web surface prose'],
]
function otherPackages() {
  return {
    name: 'other-packages',
    inject: ['systemPrompt'],
    apply(ctx) {
      for (const [name, order, text] of OTHERS) {
        ctx.effect(() => ctx.systemPrompt.section({ name, order, text }), `other:${name}`)
      }
      ctx.effect(() => ctx.systemPrompt.tools(() => ({
        schemas: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }],
      })), 'other:tools')
      ctx.effect(() => ctx.systemPrompt.context({ name: 'sandbox-policy', order: 110, text: 'sandbox: danger-full-access' }), 'other:context')
    },
  }
}

const MAIN = { agent: { session: { header: { cwd: '/w', isSeeded: true } } } }
const CHILD = { agent: { session: { header: { cwd: '/w', origin: 'subagent', delegationDepth: 1, parentSession: 's0' } } } }
const names = (a) => a.sections.map((s) => s.name)
// Assembled sections carry only { name, text } — no order — so a byte diff is name+text.
const shapes = (a) => JSON.stringify(a.sections.map((s) => [s.name, s.text]))
  + '|tools:' + JSON.stringify(a.tools) + '|ctx:' + JSON.stringify(a.contexts)

const stderr = []
const realConsoleError = console.error.bind(console)
console.error = (...args) => { stderr.push(args.map(String).join(' ')); realConsoleError(...args) }

/** Mount the real prompt service + the stand-in packages + (optionally) this plugin. */
async function boot(enabled) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: NATIVE_PERSONA, personaSuffix: SUFFIX })
  await ctx.plugin(otherPackages())
  ctx.provide('typert', { register: () => () => undefined })
  ctx.provide('profileContext', { name: PROFILE, dir: scratch, patchPath: join(scratch, 'cordis.patch.yml'), home: scratch })
  if (enabled !== undefined) {
    await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, {
      enabled,
      interpolate: false,
      replaceScope: 'session',
      drop: ['harness:identity', 'deployment:persona-prefix'],
      maxBytes: 65536,
    })
  }
  return ctx
}

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(`${label}${detail === undefined ? '' : `: ${detail}`}`)
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

console.log(`avantf-identity mount smoke (${packagedProfile ? 'packed artifact' : 'workspace build'}${gateOn ? '' : ', base ABSENT'})`)

const nativeCtx = await boot(undefined)
const offCtx = await boot(false)
const onCtx = await boot(true)

// ── the mount itself ─────────────────────────────────────────────────────────
const service = onCtx.get('avantfIdentity')
check('the avantfIdentity service is published', service !== undefined)
check('the service exposes every Remote method', [
  'status', 'listPresets', 'readProfile', 'writeProfileFile', 'applyPreset', 'saveAsPreset', 'readPreset', 'writePresetFile', 'deletePreset',
].every((method) => typeof service?.[method] === 'function'), Object.keys(service ?? {}).filter((k) => typeof service[k] === 'function').join(','))

const native = await nativeCtx.systemPrompt.assemble(MAIN)
check('native prompt starts with harness:identity', native.sections[0]?.name === 'harness:identity', names(native)[0])
check('native persona-prefix is the deployment sentence', native.sections.find((s) => s.name === PERSONA_PREFIX_SECTION)?.text === NATIVE_PERSONA)

const own = nativeCtx.systemPrompt
check('getSectionOrder("HARNESS_IDENTITY") === -1000', own.getSectionOrder('HARNESS_IDENTITY') === -1000)

// ── the base gate side ───────────────────────────────────────────────────────
const gateLines = stderr.join('\n')
check(
  gateOn
    ? 'the framework loaded — no degrade warning was emitted'
    : 'the base is out of reach: the documented degrade warning was emitted',
  gateOn
    ? !gateLines.includes('could not be made available') && !gateLines.includes('shared capabilities are NOT used')
    : gateLines.includes('could not be made available'),
  gateLines.split('\n').filter((line) => line.includes('envinit:')).slice(0, 2).join(' | '),
)

// ── provisioning ─────────────────────────────────────────────────────────────
const presetsRoot = join(dataHome, 'identity', 'presets')
let materialized = 0
for (const id of ['coder', 'assistant', 'analyst']) {
  for (const locale of ['zh', 'en']) {
    for (const file of ['IDENTITY', 'SOUL', 'RULES']) {
      if (existsSync(join(presetsRoot, id, locale, `${file}.md`))) materialized += 1
    }
  }
}
check('all 18 built-in preset resources are materialized', materialized === 18, `got ${String(materialized)}`)
check('the release marker records the provisioning', existsSync(join(dataHome, 'identity', '.provisioned')))
check(
  'materialization NEVER overwrites an existing file',
  readFileSync(editedPreset, 'utf8') === 'USER EDITED PRESET\n',
  JSON.stringify(readFileSync(editedPreset, 'utf8').slice(0, 40)),
)

// ── the mechanism ────────────────────────────────────────────────────────────
const off = await offCtx.systemPrompt.assemble(MAIN)
check('disabled ⇒ assembly byte-identical to native (name+text, tools, contexts)', shapes(off) === shapes(native))

const on = await onCtx.systemPrompt.assemble(MAIN)
check('enabled ⇒ harness:identity is gone', !names(on).includes('harness:identity'))
check('enabled ⇒ deployment:persona-prefix is gone', !names(on).includes(PERSONA_PREFIX_SECTION))
check('enabled ⇒ the identity section sits FIRST', on.sections[0]?.name === 'avantf:identity', names(on)[0])
check('enabled ⇒ the identity section carries the three files, in order', on.sections[0]?.text === IDENTITY_TEXT, JSON.stringify(on.sections[0]?.text))

const DROP = ['harness:identity', 'deployment:persona-prefix']
const survivorsNative = native.sections.filter((s) => !DROP.includes(s.name))
const survivorsOn = on.sections.filter((s) => s.name !== 'avantf:identity')
check(
  'enabled ⇒ every other section is byte-identical (name+text)',
  JSON.stringify(survivorsOn) === JSON.stringify(survivorsNative),
  `${String(survivorsOn.length)} sections compared`,
)
check('enabled ⇒ section count = native − 2 dropped + 1 added', on.sections.length === native.sections.length - 1)
check('enabled ⇒ tools untouched', JSON.stringify(on.tools) === JSON.stringify(native.tools))
check('enabled ⇒ contexts untouched', JSON.stringify(on.contexts) === JSON.stringify(native.contexts))

const childOn = await onCtx.systemPrompt.assemble(CHILD)
const childNative = await nativeCtx.systemPrompt.assemble(CHILD)
check('a delegated child is byte-identical to native', shapes(childOn) === shapes(childNative))
check('a delegated child keeps harness:identity', names(childOn).includes('harness:identity'))
check('a delegated child never sees the identity section', !names(childOn).includes('avantf:identity'))

// ── teardown ─────────────────────────────────────────────────────────────────
if (ownsScratch) rmSync(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\nMOUNT SMOKE FAILED (${String(failures.length)})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nMOUNT SMOKE OK')
process.exit(0)
