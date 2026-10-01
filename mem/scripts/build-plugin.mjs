#!/usr/bin/env node
/**
 * Build the DSH plugin — first compile or rebuild, auto-detected.
 *
 * `pnpm build:dsh` is the single entry point:
 *
 *   lib/ missing          → FIRST COMPILE: install deps if needed, build the engine
 *                           packages from scratch, then the plugin.
 *   lib/ already present  → REBUILD: only the engine packages whose `src/` is newer
 *                           than their `lib/` are rebuilt, then the plugin.
 *
 * The plugin ships TWO faces and they do not take effect the same way
 * (README «DSH 插件：改完源码后怎么编译、怎么生效»):
 *
 *   lib/index.js   host half    — imported once by the dsh process at profile boot,
 *                                so it needs a dsh RESTART
 *   lib/client.js  browser half — stat-polled by `client-hmr` (500 ms) through
 *                                `/plugins/events`, so a rebuild alone hot-reloads it
 *
 * There is ONE way the plugin's `@deepseek-ai/*` peers are resolved: from the
 * INSTALLED global dsh (`scripts/link-dsh.mjs`), because a live profile loads the
 * plugin against that same copy (shared cordis/schemastery identity). `tsc`
 * therefore type-checks against the dsh you actually run, and tsdown's client
 * preset is the copy pinned under `packages/plugin/vendor/dsh-client-preset/` —
 * so a build needs NO harness source checkout at all.
 *
 * The browser half alone (tsdown, no type-check, no mount smoke) has its own
 * escape hatch: `pnpm -C packages/plugin run bundle`.
 *
 *   pnpm build:dsh                 # auto: first compile or rebuild
 *   pnpm build:dsh --fresh         # force the first-compile path
 *   pnpm build:dsh --skip-deps     # never touch the engine packages
 *   pnpm build:dsh --no-verify     # skip the mount smoke
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnToolSync } from '../../scripts/lib/win-spawn.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const pluginDir = join(repo, 'packages', 'plugin')
/**
 * Engine packages `pnpm build` covers, derived from what this checkout has: the release tree ships
 * fewer packages than this one (cli/mcp are development-only), and listing a missing one would make
 * the staleness check report it as stale forever.
 */
const ENGINE_PACKAGES = readdirSync(join(repo, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'plugin')
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(repo, 'packages', name, 'package.json')))
  .sort()
/** Both faces must exist for the plugin to count as compiled. */
const ARTIFACTS = ['lib/index.js', 'lib/client.js']
/**
 * The spec that proves the peer-facing half loads. It exists only in the development tree (the
 * projection strips `test/**`), which is exactly what the local test gate keys off.
 */
const PEER_SPEC = join(pluginDir, 'test', 'provision.spec.ts')

const flags = new Set(process.argv.slice(2))
const known = ['--fresh', '--skip-deps', '--no-verify', '--help', '-h']
const usage = 'usage: node scripts/build-plugin.mjs [--fresh] [--skip-deps] [--no-verify]'
const unknown = [...flags].filter((f) => !known.includes(f))
if (unknown.length > 0) {
  console.error(`build-plugin: unknown option ${unknown.join(', ')}\n`)
  console.error(usage)
  process.exit(2)
}
if (flags.has('--help') || flags.has('-h')) {
  console.log(usage)
  process.exit(0)
}

const skipDeps = flags.has('--skip-deps')
const skipVerify = flags.has('--no-verify')
const compiled = ARTIFACTS.every((rel) => existsSync(join(pluginDir, rel)))
const mode = flags.has('--fresh') || !compiled ? 'fresh' : 'rebuild'

/** Run one step, inheriting stdio; throws on a non-zero exit. */
function run(label, command, commandArgs, env = process.env) {
  console.log(`\n▶ ${label}`)
  console.log(`  $ ${[command, ...commandArgs].join(' ')}`)
  const result = spawnToolSync(command, commandArgs, { cwd: repo, stdio: 'inherit', env })
  if (result.error) throw new Error(`${label}: cannot run ${command} (${result.error.message})`)
  if (result.status !== 0) throw new Error(`${label}: exited with code ${String(result.status)}`)
}

/** Newest mtime (ms) of any file under `dir`, or 0 when it does not exist. */
function newestMtime(dir) {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs)
  }
  return newest
}

/** An engine package is stale when its build output is missing or older than its sources. */
function stale(name) {
  const pkg = join(repo, 'packages', name)
  const lib = join(pkg, 'lib', 'index.js')
  if (!existsSync(lib)) return true
  return newestMtime(join(pkg, 'src')) > statSync(lib).mtimeMs
}

/** `lib/<name>` size + mtime, for the closing summary. */
function artifact(rel) {
  const path = join(pluginDir, rel)
  if (!existsSync(path)) return { rel, missing: true }
  const stat = statSync(path)
  const local = new Date(stat.mtimeMs)
  const pad = (n) => String(n).padStart(2, '0')
  return {
    rel,
    bytes: stat.size,
    mtime: `${String(local.getFullYear())}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} `
      + `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`,
  }
}

console.log(`build-plugin: mode=${mode} (${compiled ? 'lib/ present' : 'lib/ missing'})`)

let failure
try {
  if (mode === 'fresh') {
    // The marker is the PLUGIN's own node_modules: in the merged workspace a root `pnpm install` links
    // it (and the engine packages), while `mem/` itself is not a workspace project and never gets a
    // `node_modules/` of its own — checking that path would re-run an install on every fresh build.
    if (!existsSync(join(pluginDir, 'node_modules'))) run('install workspace dependencies', pnpm, ['install'])
    if (!skipDeps) run('build the engine packages (first compile)', pnpm, ['build'])
  } else if (!skipDeps) {
    const outdated = ENGINE_PACKAGES.filter(stale)
    if (outdated.length > 0) run(`rebuild the stale engine packages (${outdated.join(', ')})`, pnpm, ['build'])
    else console.log('\n▶ engine packages are up to date — skipped')
  }
  // Link the peers from the INSTALLED dsh and leave them there: that is the copy the running host
  // loads, so `tsc` type-checks against exactly what the plugin will share object identity with.
  run('link the plugin to the installed dsh', process.execPath, ['scripts/link-dsh.mjs'])
  // The family base (`@avantf/dsh-plugin-base`) is the workspace-linked peer. `pnpm build:dsh` built
  // it first; this vendors `bootstrap.js` — the one piece the plugin inlines — from that built copy.
  run('vendor @avantf/dsh-plugin-base bootstrap (from the workspace base build)', process.execPath, ['scripts/link-envinit.mjs'])
  run('build the plugin (tsc + tsdown → lib/index.js + lib/client.js)', pnpm, ['-C', 'packages/plugin', 'run', 'build'])
  // The artifact half of the base inlining gate: bootstrap really inlined, the base still external,
  // no kit copy inlined, client half clean.
  run('assert the base inlining (envinit artifacts)', process.execPath, ['scripts/assert-envinit-artifacts.mjs'])
  // The second artifact gate: lib/client.js must be path-independent, so the dev checkout and the
  // projected release checkout emit byte-identical bytes. The same rule also runs inside tsdown
  // (`packages/plugin/tsdown.config.ts`, on the emitted chunk); both call `scripts/client-portable.mjs`.
  run('assert the client artifact is path-independent', process.execPath, ['scripts/assert-client-portable.mjs'])
  // The unit tests that LOAD a `@deepseek-ai/*` peer (`test/provision.spec.ts` + `test/envinit.spec.ts`).
  // They are excluded from the default `vitest run` (`packages/plugin/vitest.config.ts` explains why:
  // CI has no peers, so a default run there would fail to even load them) — which makes this local
  // step the ONLY place they run, right after `link-dsh` linked the peers from the installed dsh.
  //
  // The RELEASE tree ships no test sources (`test/**` is projected away) and therefore no `vitest`,
  // while the root manifest still carries a `test:dsh` script — running it there died with
  // `sh: 1: vitest: not found`, failing `release:check` inside `build:dsh`. The step is a local
  // development gate, so it is skipped LOUDLY when the specs are not in this checkout. Whether the
  // projection is right is the dev tree's business (`pnpm release:check` there runs it in full).
  if (!existsSync(PEER_SPEC)) {
    console.log(`\n▶ plugin unit tests that need the DSH peers — SKIPPED: ${PEER_SPEC} is not in this checkout (the release tree ships no test sources)`)
  } else {
    run('plugin unit tests that need the DSH peers (pnpm test:dsh)', pnpm, ['test:dsh'])
  }
} catch (error) {
  failure = error
}

if (!failure && !skipVerify) {
  try {
    run('mount smoke (real Cordis context + gateway round-trip)', process.execPath, ['scripts/mount-smoke.mjs'])
  } catch (error) {
    failure = error
  }
}

if (failure) {
  console.error(`\n✗ ${mode === 'fresh' ? 'first compile' : mode} failed: ${failure.message}`)
  process.exit(1)
}

console.log(`\n✓ plugin ${mode === 'fresh' ? 'compiled (first time)' : 'rebuilt'}`)
for (const rel of ARTIFACTS) {
  const info = artifact(rel)
  console.log(`  ${info.missing ? `${rel.padEnd(14)} MISSING` : `${rel.padEnd(14)} ${String(info.bytes).padStart(8)} bytes  ${info.mtime}`}`)
}
console.log('  DSH peers      the installed dsh (scripts/link-dsh.mjs)')
console.log('\n  Restart dsh for the host half (lib/index.js); the browser half hot-reloads by itself.')
console.log('  UI-only change: `pnpm -C packages/plugin run bundle` rebuilds lib/client.js (tsdown only, no type-check).')
