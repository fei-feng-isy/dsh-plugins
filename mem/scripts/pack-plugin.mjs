#!/usr/bin/env node
/**
 * Pack `@avantf/dsh-mem` as the ONE package a user installs, and assert it is self-contained.
 *
 * The plugin's Node half IS the product: the engine (`@avantf/mem-contract` → `@avantf/mem-core`
 * → `@avantf/mem`) is inlined by the harness tsdown preset BECAUSE it sits in `devDependencies`
 * (production sections stay imports, everything else inlines). That makes "is this a single
 * installable package?" a property of two artifacts — the manifest and `lib/index.js` — that no
 * type-checker or test can see: moving an engine package back into `dependencies` un-inlines it
 * and the package still builds, still passes the mount smoke in THIS repo, and then fails on a
 * user's machine with `Cannot find package '@avantf/mem'`. Hence the assertions below, run against
 * the packed tarball (what the registry would serve), not just the checkout.
 *
 * `pnpm pack` is required rather than `npm pack`: it rewrites `catalog:` / `workspace:` into real
 * ranges, and the tarball's manifest is one of the things asserted.
 *
 * Usage:
 *   pnpm pack:plugin               # pack into dist/ + assertions (no harness needed)
 *   pnpm pack:plugin --mount       # + extract the tarball into a scratch DSH profile and mount it
 *   pnpm pack:plugin --out <dir>   # pack destination (default: <repo>/dist)
 *   pnpm pack:plugin --keep        # keep the scratch profile when --mount fails
 *
 * Run `pnpm build:dsh` first (this script never builds): `lib/index.js` must be the artifact the
 * assertions describe. `--mount` needs the installed global dsh (the peers a real profile would
 * resolve), exactly like `scripts/link-dsh.mjs`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readBootstrapVersion } from '../../scripts/lib/bootstrap-version.mjs'
import { withWorkspaceVersions } from '../../scripts/lib/versions.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))

/**
 * The vendored bootstrap and its inlining marker, read once.
 *
 * The marker is DERIVED, not hardcoded: 0.1.1 dropped every control-plane literal the old
 * `.envinit/framework` marker was written against, so a framework release that changes what the
 * bootstrap carries must need only a re-vendored copy here, not an edit to this gate.
 */
const vendoredPath = join(pluginDir, 'src', 'envinit-bootstrap.js')
const vendoredBootstrap = existsSync(vendoredPath) ? readFileSync(vendoredPath, 'utf8') : undefined
const inliningMarker = vendoredBootstrap === undefined
  ? undefined
  : /supportedRange\s*=\s*['"]([^'"]+)['"]/.exec(vendoredBootstrap)?.[1]

const args = process.argv.slice(2)
const mount = args.includes('--mount')
const keep = args.includes('--keep')
const outIndex = args.indexOf('--out')
if (outIndex >= 0 && args[outIndex + 1] === undefined) {
  console.error('pack-plugin: --out needs a directory')
  process.exit(2)
}
const outDir = outIndex >= 0 ? resolve(args[outIndex + 1]) : join(repo, 'dist')
if (outDir === resolve('/')) {
  console.error('pack-plugin: refusing to pack into /')
  process.exit(2)
}

const problems = []
const notes = []
function fail(message) { problems.push(message) }
function note(message) { notes.push(message) }

/**
 * The ONE `@avantf/*` package allowed in a runtime section — and only in `peerDependencies`.
 *
 * `@avantf/dsh-plugin-base` is the family base (environment initialisation + compatibility gate +
 * shared kit): a peer the host provides, loaded at startup through the inlined bootstrap (never by
 * package specifier, or a broken tree would throw before the bootstrap ran). Every OTHER `@avantf/*`
 * name is engine code that must arrive inlined in `lib/index.js`. The base itself is a workspace link
 * during development (`base/plugin-base`) and a registry range in the packed manifest, so a surviving
 * import of it is an error too.
 */
const FRAMEWORK_PEER = '@avantf/dsh-plugin-base'

/**
 * A unique string in the base kit's `PromptFiles` writer.
 *
 * The kit (prompt files, logger, family paths, wire codec helpers) is consumed at RUNTIME off the
 * base module so that fixing a shared helper takes ONE base release — no plugin rebuild. Inlining it
 * back into a bundle would silently break that promise and nothing else in the artifact would show
 * it, so its presence is a build error on both halves.
 */
const KIT_MARKER = 'prompt file was blank and has been filled'

/**
 * The framework contract, asserted on both the checkout's bundle and the packed tarball's bytes.
 *
 * A textual check on purpose: `tsc` erases `import type`, so any framework specifier left in an
 * emitted artifact is a value import — the one shape that would make the plugin unloadable exactly
 * when the dependency tree is broken.
 */
function assertFrameworkInlining(label, code) {
  if (specifiersIn(code).includes(FRAMEWORK_PEER)) {
    fail(`${label}: imports "${FRAMEWORK_PEER}" by specifier — the framework is loaded through the inlined bootstrap, never imported`)
  }
  if (code.includes(KIT_MARKER)) {
    fail(`${label}: carries the base kit's implementation ("${KIT_MARKER}") — shared helpers are consumed from the base at runtime, never inlined`)
  }
  if (/(?:from|import\s*\()\s*['"][^'"]*envinit-bootstrap\.js['"]/.test(code)) {
    fail(`${label}: the vendored bootstrap is still a relative import — it was not inlined`)
  }
  if (vendoredBootstrap === undefined) {
    fail(`${label}: ${vendoredPath} is missing — run \`node scripts/link-envinit.mjs\``)
  } else if (inliningMarker === undefined) {
    fail(`${label}: ${vendoredPath} has no supportedRange literal to look for in the bundle`)
  } else if (!code.includes(inliningMarker)) {
    fail(`${label}: the inlined bootstrap is missing (no supportedRange ${inliningMarker} literal)`)
  }
}

/**
 * The inlined bootstrap must be the SAME framework version this checkout installed — the task's
 * "inline version == installed framework version" assertion, and the one shape a stale `lib/` (built
 * before the framework moved) would otherwise pass: the bundle still carries a bootstrap, just not
 * the one the manifest's peer range and `pnpm install` describe.
 */
function assertFrameworkVersionMatchesInstall(nodeCode) {
  const installedManifest = join(pluginDir, 'node_modules', FRAMEWORK_PEER, 'package.json')
  if (!existsSync(installedManifest)) {
    fail(`the installed ${FRAMEWORK_PEER} is missing — run \`pnpm install\` (the framework is a registry peer plus devDependency)`)
    return
  }
  const installedVersion = JSON.parse(readFileSync(installedManifest, 'utf8')).version
  const installedBootstrap = join(pluginDir, 'node_modules', FRAMEWORK_PEER, 'dist', 'bootstrap.js')
  if (!existsSync(installedBootstrap)) {
    fail(`${FRAMEWORK_PEER} ${String(installedVersion)} carries no dist/bootstrap.js — the install is not a built framework`)
    return
  }
  const installedVendored = readBootstrapVersion(installedBootstrap)
  if (installedVendored !== installedVersion) {
    fail(`the installed ${FRAMEWORK_PEER}'s bootstrap declares ${String(installedVendored)} but its package.json is ${String(installedVersion)}`)
  }
  const inlined = readBootstrapVersion(vendoredPath)
  if (inlined !== installedVersion) {
    fail(`the inlined bootstrap declares ${String(inlined)} but the installed ${FRAMEWORK_PEER} is ${String(installedVersion)} — re-vendor with \`node scripts/link-envinit.mjs\` and rebuild`)
  }
  // The bundle embeds the bootstrap TEXT, so the marker must also be the installed version's. A
  // mismatch here means lib/index.js is a stale build even when src/ was re-vendored afterwards.
  if (inliningMarker !== undefined && !nodeCode.includes(inliningMarker)) {
    fail(`lib/index.js does not carry the installed ${FRAMEWORK_PEER}@${String(installedVersion)} bootstrap (no supportedRange ${inliningMarker} literal) — rebuild with \`pnpm build:dsh\``)
  }
}

/** Run a command, inheriting stdio; returns the exit status (never throws). */
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: repo, stdio: 'inherit', ...options })
  if (result.error) throw new Error(`cannot run ${command}: ${result.error.message}`)
  return result.status
}

/** Package name of a bare specifier (`@scope/name/sub` → `@scope/name`). */
function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Every bare specifier a bundle reaches at runtime: static imports, re-exports, dynamic imports, requires. */
function specifiersIn(code) {
  const found = new Set()
  for (const pattern of [
    /^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm,
    /^\s*export\s[^;]*?from\s*["']([^"']+)["']/gm,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) found.add(match[1])
  }
  return [...found].sort()
}

/**
 * Assert one shipped file only reaches specifiers a user's install can answer for.
 *
 * The `@avantf/*` rule is the load-bearing one and it is reported separately: a DSH user installs
 * THIS one package, so the engine (`@avantf/mem`, `@avantf/mem-contract`, `@avantf/mem-core`) must
 * arrive inlined in the bundles and carried into `lib/engine/` for the declarations — a surviving
 * `@avantf/*` specifier means it did not. There is no family exception any more: the framework is a
 * peer loaded through the inlined bootstrap, and the compatibility base is provisioned by it.
 *
 * Two callers pass different shape expectations:
 *   - the two BUNDLES: relative specifiers are an error (the artifact must be a single file) and the
 *     framework peer may not appear at all (it is reached only through the inlined bootstrap).
 *   - a shipped DECLARATION file: relative specifiers are expected (the closure check below resolves
 *     them) and the framework peer is a legitimate type import — it is the one published `@avantf/*`
 *     package a consumer resolves.
 */
function assertSelfContained(label, code, declared, { client, allowFramework = false, allowRelative = false, types = false }) {
  for (const specifier of specifiersIn(code)) {
    const name = packageName(specifier)
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (!allowRelative) fail(`${label}: relative specifier "${specifier}" — the artifact must be a single file`)
      continue
    }
    if (specifier.startsWith('@avantf/')) {
      if (allowFramework && name === FRAMEWORK_PEER) continue
      fail(types
        ? `${label}: names "${specifier}" — a shipped declaration may only reference the ${FRAMEWORK_PEER} peer; carry the engine's declarations and repoint (see scripts/carry-engine-types.mjs)`
        : `${label}: imports "${specifier}" — the engine is not inlined (keep @avantf/* in devDependencies)`)
      continue
    }
    if (specifier.startsWith('node:') || declared.has(name)) continue
    // The browser half may only reach the loader module table: @deepseek-ai rows and the react
    // family. A require() the table cannot answer is a guaranteed runtime throw, so anything else
    // is a build error even though the node half would resolve it from node_modules.
    if (client && (name === 'react' || name === 'react-dom' || name.startsWith('@deepseek-ai/'))) continue
    // A declaration may type-import ANY harness module: the host provides the whole `@deepseek-ai/*`
    // module tree (they are all optional peers, and a `import type {}` used only to reach an
    // augmentation is erased from the bundle but kept in the `.d.ts`). Requiring a manifest entry here
    // would force a peer-declaration change for a type-only edge; the load-bearing rule for
    // declarations is the `@avantf/*` one above.
    if (types && name.startsWith('@deepseek-ai/')) continue
    fail(`${label}: imports "${specifier}" but no dependency/peer declares it`)
  }
}

/** Every declared production dependency must actually be reached, or the user installs dead weight. */
function assertNoDeadDependencies(label, code, declared) {
  const reached = new Set(specifiersIn(code).map(packageName))
  for (const name of declared) {
    if (!reached.has(name)) fail(`${label}: "${name}" is declared but never imported — drop it from the production sections`)
  }
}

const artifacts = ['lib/index.js', 'lib/client.js']
for (const rel of artifacts) {
  if (!existsSync(join(pluginDir, rel))) {
    console.error(`pack-plugin: ${rel} is missing — run \`pnpm build:dsh\` first`)
    process.exit(1)
  }
}

// ── the checkout's artifact ───────────────────────────────────────────────────────────────────
const production = { ...manifest.dependencies, ...manifest.optionalDependencies }
const declaredNames = new Set([...Object.keys(production), ...Object.keys(manifest.peerDependencies ?? {})])
if (manifest.dependencies?.[FRAMEWORK_PEER] !== undefined || manifest.optionalDependencies?.[FRAMEWORK_PEER] !== undefined) {
  fail(`manifest: "${FRAMEWORK_PEER}" is a runtime dependency — it must be a PEER (a second copy under the plugin would be a different framework)`)
}
if (manifest.peerDependencies?.[FRAMEWORK_PEER] === undefined) {
  fail(`manifest: "${FRAMEWORK_PEER}" is not declared in peerDependencies`)
}
for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    if (name.startsWith('@avantf/') && name !== FRAMEWORK_PEER) {
      fail(`manifest: "${name}" is in ${section} — the engine must stay a devDependency`)
    }
  }
}
const nodeCode = readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8')
const clientCode = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')
assertSelfContained('lib/index.js', nodeCode, declaredNames, { client: false })
assertSelfContained('lib/client.js', clientCode, declaredNames, { client: true })
assertNoDeadDependencies('lib/index.js', nodeCode, new Set(Object.keys(production)))
assertFrameworkInlining('lib/index.js', nodeCode)
assertFrameworkVersionMatchesInstall(nodeCode)
if (specifiersIn(clientCode).some((specifier) => specifier.startsWith('@avantf/'))) {
  fail('lib/client.js: the browser half must not reach any @avantf/* package')
}
if (clientCode.includes(KIT_MARKER)) {
  fail(`lib/client.js: carries the base kit's implementation ("${KIT_MARKER}") — the browser half must not inline the kit`)
}

// ── pack ──────────────────────────────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true })
console.log(`\n▶ pnpm pack → ${outDir}`)
// `pnpm pack` rewrites `workspace:*` into the TARGET's version, and the engines deliberately carry none
// in the tree (the version is recorded once, in this package's manifest) — so the private targets get it
// materialized for the duration of the pack and lose it again right after. Nothing is committed;
// `version:check` fails on a leftover. `{ group: 'mem' }` narrows that to THIS tree's private packages:
// the default spans every group, so a `mem` pack would briefly stamp its version onto mission's
// manifests too (the M7 defect).
const packStatus = withWorkspaceVersions(resolve(repo, '..'), manifest.version, () =>
  run('pnpm', ['--filter', manifest.name, 'pack', '--pack-destination', outDir]), { group: 'mem' })
if (packStatus !== 0) {
  console.error('pack-plugin: pnpm pack failed')
  process.exit(1)
}
// pnpm names the tarball after the manifest, so the expected path is known rather than guessed.
const tarball = join(outDir, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`)
if (!existsSync(tarball)) {
  console.error(`pack-plugin: expected ${tarball} — check the pnpm pack output above`)
  process.exit(1)
}

// ── the tarball's bytes: the surface the registry would serve ─────────────────────────────────
function tarFile(entry) {
  const result = spawnSync('tar', ['-xzOf', tarball, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`cannot read ${entry} from ${tarball}`)
  return result.stdout
}
const packed = JSON.parse(tarFile('package/package.json'))
// `devDependencies` deliberately are NOT asserted: `pnpm pack` rewrites the release manifest's
// `workspace:*` engine entries into plain versions (`@avantf/mem: 0.1.0`), so the packed manifest
// carries build-time traces of packages that are not on npm. That is harmless — npm never installs a
// dependency's devDependencies — and removing them would need a hand-rebuilt tarball. The production
// sections below are the ones a consumer's install resolves.
for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const name of Object.keys(packed[section] ?? {})) {
    if (name.startsWith('@avantf/') && name !== FRAMEWORK_PEER) {
      fail(`tarball ${section}: "${name}" is an engine package — it must ship inlined, so the packed package depends on nothing under @avantf/ except the ${FRAMEWORK_PEER} peer`)
    }
  }
}
// Same sections, same packages — the ranges differ by design, because pnpm resolves `catalog:`
// into a real range, and the loop below asserts that no placeholder survived the pack.
for (const section of ['dependencies', 'optionalDependencies']) {
  const expected = Object.keys(manifest[section] ?? {}).sort().join(', ')
  const actual = Object.keys(packed[section] ?? {}).sort().join(', ')
  if (actual !== expected) fail(`tarball ${section} is "${actual}" but the manifest declares "${expected}"`)
}
for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
  for (const [name, range] of Object.entries(packed[section] ?? {})) {
    // `link:`/`file:` too: the workspace resolves `@avantf/dsh-plugin-base` from a sibling checkout during
    // development, and a tarball carrying that is unpublishable. Publish the base BEFORE the plugin.
    if (typeof range === 'string' && /^(catalog:|workspace:|link:|file:)/.test(range)) {
      fail(`tarball ${section}: "${name}": "${range}" is a workspace-only specifier — publish the sibling and pin a registry range first`)
    }
  }
}
if (!(packed.files ?? []).includes('lib')) fail('tarball manifest: `files` does not include lib')
for (const [label, value] of [['main', packed.main], ['types', packed.types]]) {
  if (typeof value !== 'string' || !value.startsWith('lib/')) fail(`tarball manifest: ${label} must point into lib/`)
}
if (packed.exports?.['./client'] === undefined) fail('tarball manifest: exports["./client"] is missing (the browser half)')
if (packed.dsh?.client?.platform !== 'web') fail('tarball manifest: dsh.client.platform must be "web"')
// The npm page is the package's OWN README: assert it ships and that its title names this package.
// (`files` lists README.md, so a missing one means the package directory lost it — and a copy/rename
// slip would publish another package's page; nothing else in this chain would notice either.)
const readme = tarFile('package/README.md')
if (readme.trim() === '') {
  fail(`${tarball}: missing README.md — the npm page has to be the package's own README`)
} else if (readme.split('\n')[0]?.trim() !== `# ${String(packed.name)}`) {
  fail(`${tarball}: README.md starts with ${JSON.stringify(readme.split('\n')[0])}, expected "# ${String(packed.name)}"`)
}

const contents = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).stdout.split('\n')
for (const entry of ['package/lib/index.js', 'package/lib/client.js', 'package/lib/types/index.d.ts', 'package/lib/dsh-build.json', 'package/lib/interface-version.json', 'package/README.md', 'package/LICENSE']) {
  if (!contents.includes(entry)) fail(`tarball is missing ${entry}`)
}
// `lib/` is however many files the LAST tsdown run left there, and tsdown does not clean it: a build
// made with a different manifest section split emits extra chunks (a code-split optional dependency,
// a shared runtime), and the next build leaves them behind. They are unreferenced by the bundles, so
// nothing else notices — they just ride along. Pin the shipped set instead.
//
// `dsh-build.json` and `interface-version.json` are NOT strays: the former is written deliberately by
// `scripts/build-versions.mjs`, the latter by `scripts/link-envinit.mjs`, and `lib/index.js` reads both
// at startup (the compatibility gate's "compiled against" side and the interface generation this build
// was written for). They must ship with the package — hence the presence checks above as well as the
// exemptions here.
//
// Two exclusions are deliberate and load-bearing:
//
//   * `lib/types/**/*.js` (+ its `.js.map`) is the tsc INTERMEDIATE the tsdown preset consumes (its
//     node entry is `lib/types/index.js`). It is a build input, not a published surface: it still
//     names the engine by package specifier, and shipping it would leak dead code AND give the
//     declaration scan below a second thing to fix. `package.json`'s `files` negations keep it out of
//     the tarball; this regex makes a `files` edit that lets it back in a STRAY (a hard failure),
//     never a silent ship.
//   * `lib/client.js.map` is deliberately NOT shipped. The client bundle keeps its sourcemap so local
//     debugging still works, so `lib/client.js` ends in `//# sourceMappingURL=client.js.map` — an
//     intentionally dangling comment, not a file someone forgot to include. The map is ~636 KB of
//     inlined `sourcesContent` (zod internals + plugin sources) no consumer reads; 0.3.1 shipped it.
const LIB_OK = /^package\/lib\/(index\.js|client\.js|dsh-build\.json|interface-version\.json|types\/.*\.d\.ts(?:\.map)?|engine\/.*\.d\.ts)$/
const strays = contents.filter((entry) => entry.startsWith('package/lib/') && !LIB_OK.test(entry))
if (strays.length > 0) {
  fail(`tarball carries ${String(strays.length)} file(s) under lib/ that no bundle references (a stale build — rerun \`pnpm build:dsh\` on a clean lib/): ${strays.join(', ')}`)
}
const packedDeclared = new Set([...Object.keys(packed.dependencies ?? {}), ...Object.keys(packed.optionalDependencies ?? {}),
  ...Object.keys(packed.peerDependencies ?? {})])
assertSelfContained('tarball:lib/index.js', tarFile('package/lib/index.js'), packedDeclared, { client: false })
assertSelfContained('tarball:lib/client.js', tarFile('package/lib/client.js'), packedDeclared, { client: true })
assertFrameworkInlining('tarball:lib/index.js', tarFile('package/lib/index.js'))
{
  const packedClient = tarFile('package/lib/client.js')
  if (specifiersIn(packedClient).some((specifier) => specifier.startsWith('@avantf/'))) {
    fail('tarball:lib/client.js: the browser half must not reach any @avantf/* package')
  }
  if (packedClient.includes(KIT_MARKER)) {
    fail(`tarball:lib/client.js: carries the base kit's implementation ("${KIT_MARKER}") — the browser half must not inline the kit`)
  }
}

// ── the shipped DECLARATION surface ────────────────────────────────────────────────────────────
// `exports["."].types` and `exports["./client"].types` point into `lib/types/**`, and the engine's
// declarations are carried next to it under `lib/engine/**`. Every specifier in there is resolved by
// the CONSUMER's type-checker, so it must name only what their install provides: the base peer,
// `@deepseek-ai/*` peers, `zod`, and relative paths inside this package. Both extensions are scanned
// on purpose: if a `.js` intermediate ever slips past `files`, this fails it rather than shipping an
// engine package name inside the tarball. This is the gate H2 shipped past.
const shippedDeclarations = contents
  .filter((entry) => /^package\/lib\/(?:types|engine)\/.*\.(?:d\.ts|js)$/.test(entry))
for (const entry of shippedDeclarations) {
  assertSelfContained(`tarball:${entry}`, tarFile(entry), packedDeclared, { client: false, allowFramework: true, allowRelative: true, types: true })
}
// Non-vacuity, tied to a declaration the presence check above already requires: `lib/types/index.d.ts`
// imports engine types, so a tarball with no carried engine declaration is a broken build, not a
// clean one.
const shippedEngine = shippedDeclarations.filter((entry) => entry.startsWith('package/lib/engine/'))
if (shippedEngine.length === 0) {
  fail('tarball: no lib/engine/**/*.d.ts shipped — `scripts/carry-engine-types.mjs` did not run (or `files` dropped it), so the declared types still point at unpublished packages')
}
// The repointing is only correct if every relative specifier it produced lands on a file the tarball
// ALSO carries. Nothing above checks the other end (declaration scan skips relative specifiers on
// purpose), so a partial copy or a `files` pattern that dropped a subdirectory would ship a specifier
// that resolves to nothing. Ported from `mission/scripts/pack-plugin.mjs` §2b.
const shippedEntries = new Set(contents)
const dangling = []
let relativeSpecifiers = 0
for (const entry of shippedDeclarations) {
  for (const specifier of specifiersIn(tarFile(entry))) {
    if (!specifier.startsWith('.')) continue
    relativeSpecifiers += 1
    const target = posix.normalize(posix.join(posix.dirname(entry), specifier))
    const candidates = specifier.endsWith('.js')
      ? [target, target.replace(/\.js$/u, '.d.ts'), `${target}.d.ts`]
      : [target, `${target}.d.ts`, `${target}/index.js`, `${target}/index.d.ts`]
    if (!candidates.some((candidate) => shippedEntries.has(candidate))) dangling.push(`${entry} → ${specifier}`)
  }
}
if (relativeSpecifiers === 0 && shippedEngine.length > 0) {
  fail('tarball: the shipped declaration tree carries lib/engine/ but no relative specifier was found — the closure scan is broken, not the package')
}
if (dangling.length > 0) {
  fail(`tarball: ${String(dangling.length)} dangling relative import(s) in the shipped declarations — a repoint or a \`files\` pattern would ship a specifier that resolves to nothing: ${dangling.slice(0, 5).join(', ')}`)
}

if (packed.peerDependencies?.[FRAMEWORK_PEER] === undefined) {
  fail(`tarball manifest: "${FRAMEWORK_PEER}" must be a peerDependency (the host provides the framework)`)
}

// ── optional: mount the packed copy in a scratch DSH profile ──────────────────────────────────
if (mount && problems.length === 0) {
  // Peers come from the installed dsh — the same copies a live profile would hand the plugin.
  const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim()
  const runtimeSource = join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')

  /**
   * Extract the packed tarball into a scratch profile and run the mount smoke.
   *
   * `linkBase` prepares the profile the inlined bootstrap needs: it symlinks
   * `@avantf/dsh-plugin-base` into `scratch/node_modules/@avantf/` so the bootstrap's `createRequire`
   * resolves it — the base ARRIVES WITH its own compatibility gate, so the smoke then runs the gate
   * straight off that copy and prints `compat: ok` (there is nothing to seed). Without it nothing in
   * the profile can resolve the base, so the smoke is told so (`AVANTF_ENVINIT_ABSENT=1`) and asserts
   * the WARNING plus the legacy `provision:` sweep — the end-to-end proof of the acceptance rule
   * ("no base → still mounts").
   */
  function mountVariant(label, { linkBase }) {
    const scratch = mkdtempSync(join(tmpdir(), 'avf-pack-mount-'))
    const scope = join(scratch, 'node_modules', '@avantf')
    mkdirSync(scope, { recursive: true })
    console.log(`\n▶ [${label}] extract ${tarball}\n  → ${scratch}/node_modules/@avantf/dsh-mem`)
    if (run('tar', ['-xzf', tarball, '-C', scope], { cwd: scratch }) !== 0) throw new Error('cannot extract the tarball')
    renameSync(join(scope, 'package'), join(scope, 'dsh-mem'))
    // The runtime externals an npm install would have put next to the package (the pnpm store copies
    // this workspace already has). Every `@avantf/*` ENGINE name stays unlinked on purpose: a leaked
    // engine import must fail to resolve. The base is a PEER, linked separately below.
    for (const name of Object.keys(production)) {
      const from = join(pluginDir, 'node_modules', name)
      if (!existsSync(from)) { note(`scratch[${label}]: ${name} is not installed here — the mount may degrade`); continue }
      mkdirSync(dirname(join(scratch, 'node_modules', name)), { recursive: true })
      symlinkSync(from, join(scratch, 'node_modules', name))
    }
    // The base peer. Linked (resolvable) or absent (unresolvable), never both: the variant's whole
    // point is which of the two bootstrap paths runs.
    if (linkBase) {
      const from = join(pluginDir, 'node_modules', FRAMEWORK_PEER)
      if (!existsSync(from)) {
        note(`scratch[${label}]: ${FRAMEWORK_PEER} is not installed here — the mount will take the legacy path`)
      } else {
        symlinkSync(from, join(scratch, 'node_modules', FRAMEWORK_PEER))
      }
    }
    mkdirSync(join(scratch, 'node_modules', '@deepseek-ai'), { recursive: true })
    for (const name of ['cordis', 'schemastery', 'dsh-tools', 'dsh-system-prompt', 'dsh-typert-protocol', 'dsh-typert-registry', 'dsh-util-values']) {
      const from = join(runtimeSource, name)
      if (!existsSync(from)) { note(`scratch[${label}]: @deepseek-ai/${name} not found in ${runtimeSource}`); continue }
      symlinkSync(from, join(scratch, 'node_modules', '@deepseek-ai', name))
    }
    const status = run(process.execPath, [join(repo, 'scripts', 'mount-smoke.mjs')], {
      env: {
        ...process.env,
        AVANTF_PLUGIN_DIR: join(scope, 'dsh-mem'),
        AVANTF_MOUNT_SCRATCH: scratch,
        // The base is NOT linked: the smoke must assert the base-unavailable warning and the legacy
        // sweep.
        ...(linkBase ? {} : { AVANTF_ENVINIT_ABSENT: '1' }),
      },
    })
    if (status !== 0) fail(`the packed tarball did not mount [${label}] (see the mount smoke output above)`)
    if (status !== 0 && keep) note(`scratch[${label}] kept: ${scratch}`)
    else rmSync(scratch, { recursive: true, force: true })
  }

  // The two bootstrap paths a user's install can take: the base linked (the gate runs off it) and
  // nothing able to resolve it (the plugin must still mount through the legacy sweep).
  mountVariant('base linked', { linkBase: true })
  // Nothing can resolve the base: the plugin must STILL mount (legacy sweep, everything registered)
  // and print the `envinit: WARNING — @avantf/dsh-plugin-base could not be made available`.
  mountVariant('base unresolvable', { linkBase: false })
}

for (const message of notes) console.log(`note: ${message}`)
if (problems.length > 0) {
  console.error('\npack-plugin FAILED:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`\n✓ PACK OK — single installable package: ${tarball}`)
if (!mount) console.log('  (static assertions only; add --mount to install-and-mount the tarball)')
