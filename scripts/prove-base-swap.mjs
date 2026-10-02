#!/usr/bin/env node
/**
 * Prove the merge's central claim: **swapping ONLY the base is enough**.
 *
 * The whole point of putting envinit + compat + the shared kit into ONE published package
 * (`@avantf/dsh-plugin-base`) is that a fix to shared code or shared business logic ships as one base
 * release — no plugin rebuild, no plugin republish. That is a property of the built artifacts, not of
 * the source layout, so it has to be proven on the artifacts:
 *
 *   A. **The shared logic cannot have been inlined.** The built plugin bundle contains neither a
 *      static import of the base nor the kit's own declarations, and it does contain the inlined
 *      zero-dependency bootstrap. So whatever shared behaviour exists at runtime can only come from a
 *      base resolved through the plugin's `node_modules`.
 *
 *   B. **A swapped base is what the plugin's own loader reaches.** Using the plugin's BUILT bootstrap
 *      file (the exact copy the bundle inlined) in a scratch tree whose
 *      `node_modules/@avantf/dsh-plugin-base` is a shim around the workspace base, the script loads the
 *      base through `loadFramework()` — the plugin's real load path — and asserts:
 *        - the module it got back IS the shim (identity marker), i.e. resolution went through
 *          `node_modules`, not a baked path;
 *        - prompt-file read/write missions through the base's `PromptFiles` and the shim recorded the
 *          call (so the capability came from the swapped base);
 *        - the data-root / family-root resolvers mission and were recorded too.
 *      The plugin artifact's sha256 is asserted unchanged across the run: nothing was rebuilt.
 *
 *   C. (**`--mount`**) the two plugins' own mount smokes run afterwards, i.e. the full Cordis mount
 *      against the built plugin and the workspace base. This is the end-to-end half; A+B are the
 *      "only the base changed" half that the smokes cannot express.
 *
 * Usage:
 *   node scripts/prove-base-swap.mjs                 # A + B (needs the base built; plugin artifacts optional with --allow-unbuilt)
 *   node scripts/prove-base-swap.mjs --mount         # A + B + the two mount smokes
 *   node scripts/prove-base-swap.mjs --allow-unbuilt # dev convenience: use the vendored src/ bootstrap when lib/ is not built yet
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { BOOTSTRAP_CANDIDATES, discoverBase, discoverPlugins, repoRoot as repo } from './lib/plugins.mjs'

/** The plugin set is DISCOVERED, so a new plugin tree is proven without editing this script. */
const PLUGINS = discoverPlugins()
const BASE = discoverBase()
if (BASE === undefined) {
  console.error('prove-base-swap: no package named @avantf/dsh-plugin-base under base/')
  process.exit(1)
}
const BASE_DIR = BASE.dir
const BASE_DIST = join(BASE_DIR, 'dist', 'index.js')

const argv = process.argv.slice(2)
const known = new Set(['--mount', '--allow-unbuilt', '--help', '-h'])
const unknown = argv.filter((flag) => !known.has(flag))
if (unknown.length > 0) {
  console.error(`prove-base-swap: unknown option ${unknown.join(', ')}`)
  console.error('usage: node scripts/prove-base-swap.mjs [--mount] [--allow-unbuilt]')
  process.exit(2)
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/prove-base-swap.mjs [--mount] [--allow-unbuilt]')
  process.exit(0)
}
const runMount = argv.includes('--mount')
const allowUnbuilt = argv.includes('--allow-unbuilt')

const problems = []
const notes = []
const fail = (message) => problems.push(message)
const note = (message) => notes.push(message)

// ── inputs ───────────────────────────────────────────────────────────────────────────────────────
if (!existsSync(BASE_DIST)) {
  console.error('prove-base-swap: the base is not built.')
  console.error('  fix: pnpm build:dsh base')
  process.exit(1)
}
const baseManifest = JSON.parse(readFileSync(join(BASE_DIR, 'package.json'), 'utf8'))
const baseVersion = baseManifest.version
note(`workspace base: ${baseManifest.name}@${String(baseVersion)}`)

/** sha256 of a file, used to prove the plugin artifacts are untouched (nothing was rebuilt). */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * The kit symbol names that would only be in a plugin bundle if the kit had been INLINED.
 *
 * Derived, not hardcoded: every declaration `base/plugin-base/src/kit/**` exports, MINUS every name
 * that the plugin's own tree already declares (an engine package's `expandHome`, the mission plugin's
 * `resolveDataHome` fallback, …). Those are legitimate local code, not a base copy; everything left is
 * a name no plugin has any business defining itself.
 */
function inlinedKitMarkers(plugin) {
  const kitDir = join(BASE_DIR, 'src', 'kit')
  const exported = new Set()
  for (const entry of readdirSync(kitDir)) {
    if (!entry.endsWith('.ts')) continue
    const text = readFileSync(join(kitDir, entry), 'utf8')
    for (const match of text.matchAll(/\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) {
      exported.add(match[1])
    }
  }
  const local = new Set()
  /**
   * Only SOURCE counts as a local declaration: a test stub (`class PromptFiles` in a spec) or a build
   * script is never bundled, so it must not excuse an inlined kit declaration.
   */
  const SKIP = new Set(['node_modules', 'lib', 'dist', 'release', 'vendor', 'test', 'tests', 'scripts', 'docs', '.git', '.vitest'])
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(entry.name)) continue
      if (/\.spec\.[cm]?[jt]sx?$/u.test(entry.name)) continue
      const text = readFileSync(path, 'utf8')
      for (const name of exported) {
        if (new RegExp(`\\b(?:class|function|const|let|var)\\s+${name}\\b`, 'u').test(text)) local.add(name)
      }
    }
  }
  walk(plugin.tree)
  return [...exported].filter((name) => !local.has(name)).sort()
}

// ── A. the bundle cannot contain the shared logic ────────────────────────────────────────────────
const bundles = new Map()
for (const plugin of PLUGINS) {
  if (plugin.packageDir === undefined) {
    fail(`${plugin.id}: no packages/plugin/package.json — the family layout expects one publishable plugin package per tree; nothing to prove for it`)
    continue
  }
  const bundle = join(plugin.packageDir, 'lib/index.js')
  if (!existsSync(bundle)) {
    if (allowUnbuilt) {
      note(`${plugin.name}: lib/index.js is not built (--allow-unbuilt) — static checks skipped`)
      continue
    }
    fail(`${plugin.name} is not built (${relative(repo, bundle)} is missing)\n    fix: pnpm build:dsh ${plugin.id}`)
    continue
  }
  const text = readFileSync(bundle, 'utf8')
  bundles.set(plugin.name, { bundle, text, hash: sha256(bundle) })

  // A static import would break the whole plugin module when the base is absent — the exact failure
  // the family forbids. (The bootstrap's own `import(variable)` is not a literal specifier.)
  if (/(?:^|[;\n}])\s*import[^;]*?from\s*['"]@avantf\/dsh-plugin-base(?:[/'"])/mu.test(text)
    || /import\s*\(\s*['"]@avantf\/dsh-plugin-base['"]\s*\)/u.test(text)) {
    fail(`${plugin.name}: lib/index.js imports the base by specifier — it must load it only through the inlined bootstrap`)
  }
  // The kit's ENTRY module identifier must never appear: an inlined copy or a subpath import both
  // leave this string behind, and either one means "a base fix needs a plugin release".
  for (const identifier of ['@avantf/dsh-plugin-base/kit', 'dsh-plugin-base/kit', 'kit/index.js']) {
    if (text.includes(identifier)) {
      fail(`${plugin.name}: lib/index.js names the kit entry module (${identifier}) — the kit must be consumed at runtime, never inlined or imported by subpath`)
    }
  }
  // Kit declarations that no plugin declares itself.
  const markers = inlinedKitMarkers(plugin)
  const inlined = markers.filter((name) => new RegExp(`\\b(?:class|function)\\s+${name}\\b`, 'u').test(text))
  if (inlined.length > 0) {
    fail(
      `${plugin.name}: lib/index.js defines kit symbol(s) ${inlined.join(', ')} — the kit was inlined; `
      + 'a shared-code fix would then need a plugin rebuild',
    )
  }
  note(`${plugin.name}: no static base import, no kit entry identifier, no inlined kit declaration (${markers.length} marker names checked)`)

  // The host entry must be the BUNDLED artifact, and self-contained except for the inlined bootstrap.
  // Every check above also passes on a bare `tsc` emit of `src` (no static base import, no inlined kit)
  // — which is exactly what a package-level `build` that stops at `tsc` leaves in `lib/index.js`, and
  // that file is not what the host loads. `pnpm -r build` runs each package's own `build`, so this is a
  // real state to catch here rather than in a pack gate much later.
  const relatives = [...text.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/gu)].map((match) => match[1])
  const strays = [...new Set(relatives.filter((specifier) => !specifier.includes('envinit-bootstrap')))]
  if (strays.length > 0) {
    fail(
      `${plugin.name}: lib/index.js imports sibling module(s) ${strays.slice(0, 5).join(', ')} — it is not the `
      + `bundled host entry (run \`pnpm build:dsh ${plugin.id}\`; a package-level \`tsc\` build does not bundle)`,
    )
  }
}

/**
 * The plugin's BUILT envinit loader (`lib/envinit.js`, or `lib/types/envinit.js` for the tsdown
 * layout). This is the artifact the host actually runs, so the interface-degrade decision below is
 * proven on it rather than on a source-level reimplementation.
 */
async function builtLoader(plugin) {
  for (const relative of ['lib/envinit.js', 'lib/types/envinit.js']) {
    const candidate = join(plugin.packageDir, relative)
    if (existsSync(candidate)) return await import(pathToFileURL(candidate).href)
  }
  return undefined
}

/** Run one of the loader's two entry points (`loadEnvinit` / `loadCompat`) and never throw. */
async function runLoader(loader, options) {
  const load = loader.loadEnvinit ?? loader.loadCompat
  if (typeof load !== 'function') return { problem: 'the built loader exports neither loadEnvinit nor loadCompat' }
  try {
    return { runtime: await load(options) }
  } catch (error) {
    return { problem: `the loader threw (${error instanceof Error ? error.message : String(error)})` }
  }
}

// ── B. a swapped base is what the plugin's own loader reaches ────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'avantf-base-swap-'))
try {
  for (const plugin of PLUGINS) {
    // Already reported in A: a tree that does not follow the family layout has nothing to prove here.
    if (plugin.packageDir === undefined) continue
    let bootstrap
    let bootstrapOrigin
    for (const relativeBootstrap of BOOTSTRAP_CANDIDATES) {
      const candidate = join(plugin.packageDir, relativeBootstrap)
      if (existsSync(candidate)) {
        bootstrap = candidate
        bootstrapOrigin = 'built artifact'
        break
      }
    }
    if (bootstrap === undefined && allowUnbuilt) {
      const candidate = join(plugin.packageDir, 'src/envinit-bootstrap.js')
      if (existsSync(candidate)) {
        bootstrap = candidate
        bootstrapOrigin = 'src (--allow-unbuilt)'
      }
    }
    if (bootstrap === undefined) {
      fail(`${plugin.name}: no built bootstrap found (looked for ${BOOTSTRAP_CANDIDATES.join(', ')})\n    fix: pnpm build:dsh ${plugin.id}`)
      continue
    }

    const root = join(scratch, plugin.name.replace(/[@/]/gu, '_'))
    const bootstrapCopy = join(root, BOOTSTRAP_CANDIDATES.find((b) => bootstrap.endsWith(b)) ?? BOOTSTRAP_CANDIDATES[1])
    mkdirSync(dirname(bootstrapCopy), { recursive: true })
    writeFileSync(bootstrapCopy, readFileSync(bootstrap))

    // The swapped base: a shim package that re-exports the WORKSPACE base and records every kit call.
    const marker = `swap-${sha256(bootstrap).slice(0, 12)}`
    const shimDir = join(root, 'node_modules/@avantf/dsh-plugin-base')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(join(shimDir, 'package.json'), `${JSON.stringify({
      name: '@avantf/dsh-plugin-base',
      version: baseVersion,
      type: 'module',
      exports: { '.': './index.js', './package.json': './package.json' },
    }, null, 2)}\n`)
    const realUrl = pathToFileURL(BASE_DIST).href
    writeFileSync(join(shimDir, 'index.js'), [
      `// The swapped base for ${plugin.name}: the workspace base, wrapped so provenance is observable.`,
      `import * as real from ${JSON.stringify(realUrl)}`,
      `export * from ${JSON.stringify(realUrl)}`,
      `export const __AVANTF_SWAP_MARKER__ = ${JSON.stringify(marker)}`,
      'export const __AVANTF_SWAP_CALLS__ = []',
      'export function resolveDataHome(...args) { __AVANTF_SWAP_CALLS__.push("resolveDataHome"); return real.resolveDataHome(...args) }',
      'export function familyHome(...args) { __AVANTF_SWAP_CALLS__.push("familyHome"); return real.familyHome(...args) }',
      'export function checkInterface(...args) { __AVANTF_SWAP_CALLS__.push("checkInterface"); return real.checkInterface(...args) }',
      'export function readInterfaceRequirement(...args) { __AVANTF_SWAP_CALLS__.push("readInterfaceRequirement"); return real.readInterfaceRequirement(...args) }',
      'export class PromptFiles extends real.PromptFiles {',
      '  constructor(options) { super(options); __AVANTF_SWAP_CALLS__.push("PromptFiles") }',
      '}',
      '',
    ].join('\n'))

    const { loadFramework } = await import(pathToFileURL(bootstrapCopy).href)
    const framework = await loadFramework({})
    if (framework === undefined) {
      fail(`${plugin.name}: the built bootstrap could not load the swapped base (loadFramework returned undefined)`)
      continue
    }
    if (framework.__AVANTF_SWAP_MARKER__ !== marker) {
      fail(`${plugin.name}: the loaded base is not the swapped one (identity marker absent) — resolution bypassed node_modules`)
      continue
    }
    if (typeof framework.PromptFiles !== 'function' || typeof framework.resolveDataHome !== 'function' || typeof framework.familyHome !== 'function') {
      fail(`${plugin.name}: the swapped base does not expose the kit (PromptFiles / resolveDataHome / familyHome)`)
      continue
    }

    // Prompt files: the base's PromptFiles must materialize a missing file and read an edited one.
    const prompts = join(root, 'prompts')
    const files = new framework.PromptFiles({ dir: prompts })
    const spec = [{ file: 'swap-proof.md', fallback: 'BUILT-IN DEFAULT' }]
    const created = files.load(spec)[0]
    const readBack = readFileSync(join(prompts, 'swap-proof.md'), 'utf8').trim()
    writeFileSync(join(prompts, 'swap-proof.md'), 'EDITED BY THE USER\n')
    const edited = files.load(spec)[0]
    if (created?.source !== 'default' || created?.wrote !== true || readBack !== 'BUILT-IN DEFAULT') {
      fail(`${plugin.name}: the base's PromptFiles did not create the missing prompt file (source=${String(created?.source)}, wrote=${String(created?.wrote)})`)
    }
    if (edited?.source !== 'file' || edited?.text !== 'EDITED BY THE USER') {
      fail(`${plugin.name}: the base's PromptFiles did not read the user-edited prompt file back (source=${String(edited?.source)})`)
    }

    // Root resolution: the data root honours an explicit value / $AVANTF_HOME / the configured layer,
    // the family root keeps the two apart exactly as documented. `resolveDataHome` takes the family's
    // NAMED slot object — never positional arguments — so a caller cannot put the configured value in
    // the explicit slot by accident.
    const dataHome = join(root, 'data-home')
    const family = join(root, 'family-home')
    if (framework.resolveDataHome({ env: { AVANTF_HOME: dataHome } }) !== dataHome) {
      fail(`${plugin.name}: the base's resolveDataHome ignored $AVANTF_HOME`)
    }
    if (framework.resolveDataHome({ env: { AVANTF_HOME: family }, configured: dataHome }) !== family) {
      fail(`${plugin.name}: the base's resolveDataHome let the configured layer outrank $AVANTF_HOME`)
    }
    if (framework.resolveDataHome({ env: {}, configured: dataHome }) !== dataHome) {
      fail(`${plugin.name}: the base's resolveDataHome ignored the configured layer`)
    }
    if (framework.familyHome({ AVANTF_HOME: family }) !== family) {
      fail(`${plugin.name}: the base's familyHome ignored $AVANTF_HOME`)
    }
    const expectedDefaultFamily = join(homedir(), '.avantf', 'env')
    if (framework.familyHome({}) !== expectedDefaultFamily) {
      fail(`${plugin.name}: the base's familyHome default is ${String(framework.familyHome({}))}, expected ${expectedDefaultFamily}`)
    }

    // Provenance: the shim's wrappers are what ran, so these capabilities came from the SWAPPED base.
    const calls = framework.__AVANTF_SWAP_CALLS__ ?? []
    for (const wanted of ['PromptFiles', 'resolveDataHome', 'familyHome']) {
      if (!calls.includes(wanted)) fail(`${plugin.name}: ${wanted} was not served by the swapped base (provenance check)`)
    }

    // The runtime INTERFACE GATE is the family's main contract now, and it too is SERVED BY THE
    // SWAPPED BASE. Two things are proven here: the gate functions come off the swapped module (their
    // wrappers recorded the calls), and the plugin's OWN BUILT loader DEGRADES — withholds the base
    // and warns — when the generations differ, instead of refusing the mount (the family invariant:
    // only a proven host break refuses). The control run below shows the same loader ACCEPTS a
    // matching generation, so "degrade" is not "always undefined".
    if (typeof framework.checkInterface !== 'function' || typeof framework.readInterfaceRequirement !== 'function') {
      fail(`${plugin.name}: the swapped base does not expose the interface gate (checkInterface / readInterfaceRequirement)`)
      continue
    }
    const bakedPath = join(plugin.packageDir, 'lib', 'interface-version.json')
    const requirement = framework.readInterfaceRequirement(pathToFileURL(bakedPath))
    if (requirement === undefined) {
      fail(`${plugin.name}: the swapped base could not read the plugin's bake record at ${bakedPath}`)
      continue
    }
    if (framework.checkInterface(requirement.interfaceVersion, framework).status !== 'ok') {
      fail(`${plugin.name}: the swapped base judged its own generation as not-ok`)
    }
    const otherGeneration = { ...framework, INTERFACE_VERSION: requirement.interfaceVersion + 1 }
    if (framework.checkInterface(requirement.interfaceVersion, otherGeneration).status !== 'incompatible') {
      fail(`${plugin.name}: a different INTERFACE_VERSION was not judged incompatible`)
    }

    const loader = await builtLoader(plugin)
    if (loader === undefined) {
      fail(`${plugin.name}: no built envinit loader found (lib/envinit.js or lib/types/envinit.js)`)
      continue
    }
    const runOnce = async (module) => {
      const warnings = []
      const log = {
        debug: () => undefined,
        info: () => undefined,
        warn: (message) => { warnings.push(String(message)) },
        error: () => undefined,
      }
      const outcome = await runLoader(loader, { log, home: join(root, 'envinit-home'), framework: module })
      return { ...outcome, warnings }
    }

    const degraded = await runOnce(otherGeneration)
    if (degraded.problem !== undefined) {
      fail(`${plugin.name}: an interface mismatch made the built loader THROW (${degraded.problem}) — it must degrade, never refuse`)
    } else if (degraded.runtime !== undefined) {
      fail(`${plugin.name}: an interface mismatch did NOT withhold the base (the built loader returned a runtime)`)
    }
    if (!degraded.warnings.join('\n').includes('shared capabilities are NOT used')) {
      fail(`${plugin.name}: an interface mismatch emitted no "shared capabilities are NOT used" WARNING`)
    }

    const accepted = await runOnce({ ...framework })
    if (accepted.problem !== undefined) {
      fail(`${plugin.name}: a matching interface made the built loader throw (${accepted.problem})`)
    } else if (accepted.runtime === undefined) {
      fail(`${plugin.name}: a matching interface was not accepted (the built loader returned undefined) — the gate refuses too much`)
    } else {
      accepted.runtime.dispose?.()
    }

    for (const wanted of ['checkInterface', 'readInterfaceRequirement']) {
      if (!calls.includes(wanted)) fail(`${plugin.name}: ${wanted} was not served by the swapped base (provenance check)`)
    }
    note(`${plugin.name}: bootstrap (${bootstrapOrigin}) loaded the swapped base; prompt read/write + root resolution + the interface gate served by it`)
  }

  // Nothing was rebuilt: the plugin artifacts are byte-identical to when the run started.
  for (const [name, before] of bundles) {
    const after = sha256(before.bundle)
    if (after !== before.hash) fail(`${name}: lib/index.js changed during the proof — the artifact was rebuilt`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ── C. the full mount, on demand ─────────────────────────────────────────────────────────────────
if (runMount) {
  for (const plugin of PLUGINS) {
    // Family layout: each tree owns its mount smoke. A tree without one is a REPORTED gap, never a
    // silent skip — the smoke is what proves the plugin mounts in a real Cordis context.
    const smoke = join(plugin.tree, 'scripts/mount-smoke.mjs')
    if (!existsSync(smoke)) {
      fail(`${plugin.name}: mount smoke not found at ${relative(repo, smoke)}`)
      continue
    }
    console.log(`\n▶ ${plugin.name}: mount smoke (built plugin + workspace base)`)
    const result = spawnSync(process.execPath, [smoke], { cwd: repo, stdio: 'inherit', env: process.env })
    if (result.status !== 0) fail(`${plugin.name}: mount smoke failed (exit ${String(result.status)})`)
  }
} else {
  note(`mount smoke skipped — re-run with --mount for the full Cordis mount of every discovered plugin (${PLUGINS.map((plugin) => plugin.id).join(', ')})`)
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
for (const line of notes) console.log(`  note  ${line}`)
for (const problem of problems) console.error(`  FAIL  ${problem}`)
if (problems.length > 0) {
  console.error(`\nprove-base-swap: FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nprove-base-swap ok — the plugins take shared logic from the base at runtime; swapping the base needs no plugin rebuild')
