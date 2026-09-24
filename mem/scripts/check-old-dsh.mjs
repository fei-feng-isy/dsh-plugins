#!/usr/bin/env node
/**
 * Prove this checkout still passes its LOCAL gates on the OLDEST dsh its own manifest declares.
 *
 * WHY THIS EXISTS. The startup gate compares the version this build was COMPILED against (baked into
 * `lib/dsh-build.json`, always whatever machine built it) with what the artifact's own links resolve
 * to. That makes "does the plugin still work on an older host" invisible from a newer machine: the
 * only thing standing between a change and a broken floor is that somebody actually runs it there.
 * This script is that somebody — it installs the peer range's FLOOR as a throwaway closure, redirects
 * `scripts/link-dsh.mjs` at it, runs the same LOCAL steps `release:check` runs, then puts the machine
 * back the way it was.
 *
 * WHY THE REDIRECT LOOKS LIKE THIS. `link-dsh.mjs` takes no options: it resolves the installed dsh
 * with `npm root -g` and insists the peers come from ONE install (cordis/schemastery identity is what
 * the registries are keyed on). So the closure is assembled as a fake global root —
 * `<cache>/root/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai` → `<cache>/set/...` — and
 * every step runs with `npm_config_prefix` pointed at it. The closure pins every `@deepseek-ai/dsh*`
 * to the floor, and pins `cordis`/`schemastery` to the versions linked HERE, so the A/B differs only
 * in the dsh packages themselves.
 *
 * Usage:
 *   node scripts/check-old-dsh.mjs                 # floor from the plugin's own dsh peer ranges
 *   node scripts/check-old-dsh.mjs --floor 0.1.5-rc.2
 *   node scripts/check-old-dsh.mjs --list          # print the floor and exit
 *   node scripts/check-old-dsh.mjs --fresh         # reinstall the cached closure
 *
 * The closure is cached under `$TMPDIR/avantf-old-dsh-<floor>` and reused while its marker matches.
 * Exits non-zero if any step fails. The machine is restored (link + rebuild against the installed
 * dsh) even then, so a failed run never leaves the tree compiled against the floor.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const argv = process.argv.slice(2)
const known = ['--floor', '--fresh', '--list', '--help', '-h']
for (const [index, arg] of argv.entries()) {
  if (!arg.startsWith('--')) {
    if (argv[index - 1] !== '--floor') fail(`unexpected argument ${arg}`)
    continue
  }
  if (!known.includes(arg)) fail(`unknown option ${arg}`)
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/check-old-dsh.mjs [--floor <version>] [--fresh] [--list]')
  process.exit(0)
}
const fresh = argv.includes('--fresh')
const floorArgIndex = argv.indexOf('--floor')
const explicitFloor = floorArgIndex >= 0 ? argv[floorArgIndex + 1] : undefined
if (floorArgIndex >= 0 && (explicitFloor === undefined || explicitFloor.startsWith('--'))) {
  fail('--floor needs a version')
}

function fail(message) {
  console.error(`check-old-dsh: ${message}`)
  process.exit(1)
}

/** The version a declared range tolerates at its lowest, from the plugin's own peer ranges. */
function floorOf(range) {
  if (typeof range !== 'string') return undefined
  return /^\s*(?:[\^~]|>=?|=)?\s*v?(\d[0-9A-Za-z.+-]*)/u.exec(range)?.[1]
}

const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const dshPeers = Object.entries(manifest.peerDependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
const floors = new Set()
for (const [name, range] of dshPeers) {
  const floor = floorOf(range)
  if (floor === undefined) fail(`${name} declares no usable floor: "${String(range)}"`)
  floors.add(floor)
}
if (floors.size === 0) fail('the plugin manifest declares no @deepseek-ai/dsh* peers to test against')
if (floors.size > 1 && explicitFloor === undefined) {
  fail(`the dsh peers declare ${floors.size} different floors (${[...floors].join(', ')}); pass --floor`)
}
const floor = explicitFloor ?? [...floors][0]

if (argv.includes('--list')) {
  console.log(`floor: ${floor}`)
  for (const [name, range] of dshPeers) console.log(`  ${name.replace('@deepseek-ai/', '')} ${range}`)
  process.exit(0)
}

/** The versions linked into the plugin right now — pinned in the closure so only dsh* varies. */
function linkedVersion(name) {
  const path = join(pluginDir, 'node_modules', '@deepseek-ai', name, 'package.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')).version
}

const cache = join(tmpdir(), `avantf-old-dsh-${floor}`)
const setDir = join(cache, 'set')
const rootDir = join(cache, 'root')
const marker = join(setDir, '.floor')

function run(label, command, commandArgs, env) {
  console.log(`\n▶ ${label}`)
  const result = spawnSync(command, commandArgs, { cwd: repo, stdio: 'inherit', env })
  if (result.error !== undefined) {
    console.log(`  FAIL ${label}: cannot run ${command} (${result.error.message})`)
    return false
  }
  if (result.status !== 0) {
    console.log(`  FAIL ${label}: exited with code ${String(result.status)}`)
    return false
  }
  console.log(`  ok   ${label}`)
  return true
}

/** Every `@deepseek-ai/dsh*` name in a node_modules tree, nested installs included. */
function dshPackageNames(nodeModules, names = new Set()) {
  let entries
  try {
    entries = readdirSync(nodeModules, { withFileTypes: true })
  } catch {
    return names
  }
  for (const entry of entries) {
    if (entry.name.startsWith('@')) {
      const scope = join(nodeModules, entry.name)
      for (const pkg of readdirSync(scope, { withFileTypes: true })) {
        const name = `${entry.name}/${pkg.name}`
        if (name.startsWith('@deepseek-ai/dsh')) names.add(name)
        dshPackageNames(join(scope, pkg.name, 'node_modules'), names)
      }
      continue
    }
    dshPackageNames(join(nodeModules, entry.name, 'node_modules'), names)
  }
  return names
}

function installClosure() {
  console.log(`\n▶ install the dsh closure at the floor (${floor}) — once, then cached in ${cache}`)
  rmSync(setDir, { recursive: true, force: true })
  mkdirSync(setDir, { recursive: true })
  const project = { name: `avantf-old-dsh-${floor}`, private: true, dependencies: { '@deepseek-ai/dsh': floor } }
  writeFileSync(join(setDir, 'package.json'), `${JSON.stringify(project, null, 2)}\n`)
  // Pass 1 gets a tree; pass 2 pins every dsh package in it to the floor. The umbrella's own ranges
  // are `^<floor>`, so npm would otherwise resolve the transitive ones to the newest release.
  const first = spawnSync('npm', ['i', '--prefix', setDir, '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: setDir, stdio: 'inherit' })
  if (first.status !== 0) fail(`npm could not install @deepseek-ai/dsh@${floor} (is that release published?)`)
  const overrides = {}
  for (const name of dshPackageNames(join(setDir, 'node_modules'))) overrides[name] = floor
  for (const name of ['cordis', 'schemastery']) {
    const version = linkedVersion(name)
    if (version !== undefined) overrides[`@deepseek-ai/${name}`] = version
  }
  console.log(`  pinning ${String(Object.keys(overrides).length)} package(s) to ${floor}`)
  writeFileSync(join(setDir, 'package.json'), `${JSON.stringify({ ...project, overrides }, null, 2)}\n`)
  rmSync(join(setDir, 'node_modules'), { recursive: true, force: true })
  rmSync(join(setDir, 'package-lock.json'), { force: true })
  const second = spawnSync('npm', ['i', '--prefix', setDir, '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: setDir, stdio: 'inherit' })
  if (second.status !== 0) fail(`npm could not install the pinned ${floor} closure (see its output above)`)
  for (const [name] of dshPeers) {
    const version = linkedVersionFrom(setDir, name)
    if (version !== floor) fail(`${name} resolved to ${String(version)} instead of ${floor}`)
  }
  writeFileSync(marker, `${floor}\n`)
}

/** A version read from the closure rather than from the plugin's links. */
function linkedVersionFrom(dir, name) {
  const path = join(dir, 'node_modules', name, 'package.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : undefined
}

const cached = existsSync(marker) && readFileSync(marker, 'utf8').trim() === floor
if (fresh || !cached || !existsSync(join(setDir, 'node_modules', '@deepseek-ai', 'dsh-tools'))) installClosure()
else console.log(`using the cached ${floor} closure at ${setDir}`)

// The fake global root `link-dsh.mjs` will find through `npm root -g` once npm_config_prefix is set.
rmSync(rootDir, { recursive: true, force: true })
const fakeDsh = join(rootDir, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(fakeDsh, 'node_modules'), { recursive: true })
symlinkSync(join(setDir, 'node_modules', '@deepseek-ai'), join(fakeDsh, 'node_modules', '@deepseek-ai'))

/** `npm_config_prefix` redirects `npm root -g` in every child, `link-dsh.mjs` included. */
const floorEnv = { ...process.env, npm_config_prefix: rootDir }
const steps = [
  ['link the plugin at the floor', process.execPath, ['scripts/link-dsh.mjs']],
  ['plugin typecheck (src + tests) at the floor', pnpm, ['typecheck:dsh']],
  ['plugin build + test:dsh + mount smoke at the floor', pnpm, ['build:dsh']],
]

console.log(`\nold-dsh gate — floor ${floor} (${String(dshPeers.length)} declared dsh peer(s))`)
const results = []
for (const [label, command, commandArgs] of steps) results.push([label, run(label, command, commandArgs, floorEnv)])

// Put the machine back FIRST, so a failing step still leaves a tree compiled against what it runs.
console.log('\n▶ restore: link + rebuild against the installed dsh')
const restored = run('restore: link-dsh (installed dsh)', process.execPath, ['scripts/link-dsh.mjs'], process.env)
  && run('restore: rebuild the plugin (installed dsh)', pnpm, ['-C', 'packages/plugin', 'run', 'build'], process.env)

console.log('\n──────── old-dsh gate summary ────────')
for (const [label, ok] of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
console.log(`  ${restored ? 'ok  ' : 'FAIL'} machine restored (link + rebuild against the installed dsh)`)
const passed = results.every(([, ok]) => ok) && restored
console.log(passed ? `\nold-dsh gate PASSED (floor ${floor})` : `\nold-dsh gate FAILED (floor ${floor})`)
process.exit(passed ? 0 : 1)
