#!/usr/bin/env node
/**
 * Prove a package still passes its LOCAL gates on the OLDEST dsh the family declares.
 *
 * WHY THIS EXISTS. Every LOCAL gate compiles, links and mounts against whatever dsh this machine has
 * installed (`npm i -g @deepseek-ai/dsh`), and the startup gate compares the version the artifact was
 * COMPILED against with what its own links resolve. That makes "does it still work on an older host"
 * invisible from a newer machine: nothing but a human running it there stands between a change and a
 * broken floor. This script is that human — it installs the family's declared floor as a throwaway
 * closure, redirects each package's `link-dsh` at it, runs the same LOCAL steps that package's
 * `release:check` runs, then puts the machine back.
 *
 * WHY THE REDIRECT LOOKS LIKE THIS. `link-dsh` resolves the install with `npm root -g` (work's also
 * takes `--runtime`, but its build calls the bare form). So the closure is assembled as a fake global
 * root — `<cache>/root/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai` → `<cache>/set` —
 * and every step runs with `npm_config_prefix` pointed at it. The closure pins every
 * `@deepseek-ai/dsh*` to the floor and `cordis`/`schemastery` to the versions linked HERE, so the A/B
 * differs only in the dsh packages themselves.
 *
 * Usage:
 *   node scripts/check-old-dsh.mjs <base|mem|work> [--floor <version>] [--fresh] [--list]
 *
 * The floor defaults to the dsh peer ranges the PLUGINS declare (base declares no dsh peers of its
 * own — it is loaded by them — so it shares the family floor they name). The closure is cached under
 * `$TMPDIR/avantf-old-dsh-<floor>` and reused while its marker matches. Exits non-zero if any step
 * fails. The machine is restored (relink + rebuild against the installed dsh) even then, so a failed
 * run never leaves a package compiled against the floor.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

/** One package's LOCAL steps: `[label, command, args, cwd]`, mirroring its own `release:check`. */
const GROUPS = {
  base: {
    package: 'base/plugin-base',
    steps: [
      // Explicit even though `typecheck`/`test` also link: work's `typecheck` does NOT, so the step
      // belongs to the gate rather than to each package's script shape.
      ['link the DSH peers at the floor', process.execPath, ['scripts/link-dsh.mjs'], 'base/plugin-base'],
      ['typecheck (src + tests) at the floor', pnpm, ['run', 'typecheck'], 'base/plugin-base'],
      ['build at the floor', pnpm, ['run', 'build'], 'base/plugin-base'],
      ['test at the floor', pnpm, ['run', 'test'], 'base/plugin-base'],
    ],
    restore: [
      ['restore: link-dsh (installed dsh)', process.execPath, ['scripts/link-dsh.mjs'], 'base/plugin-base'],
      ['restore: build (installed dsh)', pnpm, ['run', 'build'], 'base/plugin-base'],
    ],
  },
  mem: {
    package: 'mem/packages/plugin',
    steps: [
      ['link the DSH peers at the floor', process.execPath, ['scripts/link-dsh.mjs'], 'mem'],
      ['plugin typecheck (src + tests) at the floor', pnpm, ['run', 'typecheck:dsh'], 'mem'],
      ['plugin build + test:dsh + mount smoke at the floor', pnpm, ['run', 'build:dsh'], 'mem'],
    ],
    restore: [
      ['restore: link-dsh (installed dsh)', process.execPath, ['scripts/link-dsh.mjs'], 'mem'],
      ['restore: rebuild the plugin (installed dsh)', pnpm, ['-C', 'packages/plugin', 'run', 'build'], 'mem'],
    ],
  },
  work: {
    package: 'work/packages/plugin',
    steps: [
      ['link the DSH peers at the floor', process.execPath, ['scripts/link-dsh.mjs'], 'work'],
      ['typecheck (src + tests) at the floor', pnpm, ['run', 'typecheck'], 'work'],
      ['build + tests + mount smoke at the floor', pnpm, ['run', 'build:dsh'], 'work'],
    ],
    restore: [
      ['restore: link-dsh (installed dsh)', process.execPath, ['scripts/link-dsh.mjs', '--runtime'], 'work'],
      ['restore: rebuild (installed dsh)', process.execPath, ['scripts/build-plugin.mjs'], 'work'],
    ],
  },
}

const argv = process.argv.slice(2)
const known = ['--floor', '--fresh', '--list', '--help', '-h']
const positional = argv.filter((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--floor')
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/check-old-dsh.mjs <base|mem|work> [--floor <version>] [--fresh] [--list]')
  process.exit(0)
}
for (const arg of argv) {
  if (arg.startsWith('--') && !known.includes(arg)) fail(`unknown option ${arg}`)
}
const groupName = positional[0]
if (groupName === undefined || !Object.hasOwn(GROUPS, groupName)) {
  fail(`pass a package to gate: ${Object.keys(GROUPS).join(' | ')}`)
}
const group = GROUPS[groupName]
const fresh = argv.includes('--fresh')
const floorIndex = argv.indexOf('--floor')
const explicitFloor = floorIndex >= 0 ? argv[floorIndex + 1] : undefined
if (floorIndex >= 0 && (explicitFloor === undefined || explicitFloor.startsWith('--'))) {
  fail('--floor needs a version')
}

function fail(message) {
  console.error(`check-old-dsh: ${message}`)
  process.exit(1)
}

function readManifest(path) {
  return JSON.parse(readFileSync(join(workspace, path, 'package.json'), 'utf8'))
}

/** The version a declared range tolerates at its lowest (`^0.1.5-rc.2 || ^0.1.7-rc.2` → `0.1.5-rc.2`). */
function floorOf(range) {
  if (typeof range !== 'string') return undefined
  return /^\s*(?:[\^~]|>=?|=)?\s*v?(\d[0-9A-Za-z.+-]*)/u.exec(range)?.[1]
}

/** The family floor: every `@deepseek-ai/dsh*` peer range in the two plugins, which must agree. */
const dshPeers = []
for (const path of ['mem/packages/plugin', 'work/packages/plugin']) {
  for (const [name, range] of Object.entries(readManifest(path).peerDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/dsh')) dshPeers.push([name, range])
  }
}
const floors = new Set(dshPeers.map(([, range]) => floorOf(range)).filter((floor) => floor !== undefined))
if (floors.size === 0) fail('no @deepseek-ai/dsh* peer range to read the floor from')
if (floors.size > 1 && explicitFloor === undefined) {
  fail(`the dsh peers declare ${floors.size} different floors (${[...floors].join(', ')}); pass --floor`)
}
const floor = explicitFloor ?? [...floors][0]

if (argv.includes('--list')) {
  console.log(`group: ${groupName} (${group.package})`)
  console.log(`floor: ${floor}`)
  for (const [name, range] of dshPeers) console.log(`  ${name.replace('@deepseek-ai/', '')} ${range}`)
  process.exit(0)
}

/** A version linked into this package right now — pinned in the closure so only dsh* varies. */
function linkedVersion(name) {
  const path = join(workspace, group.package, 'node_modules', '@deepseek-ai', name, 'package.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : undefined
}

const cache = join(tmpdir(), `avantf-old-dsh-${floor}`)
const setDir = join(cache, 'set')
const rootDir = join(cache, 'root')
const marker = join(setDir, '.floor')

function run(label, command, commandArgs, cwd = '.', env = process.env) {
  console.log(`\n▶ ${label}`)
  const result = spawnSync(command, commandArgs, { cwd: join(workspace, cwd), stdio: 'inherit', env })
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

function versionFrom(dir, name) {
  const path = join(dir, 'node_modules', name, 'package.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : undefined
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
    const version = versionFrom(setDir, name)
    if (version !== floor) fail(`${name} resolved to ${String(version)} instead of ${floor}`)
  }
  writeFileSync(marker, `${floor}\n`)
}

const cached = existsSync(marker) && readFileSync(marker, 'utf8').trim() === floor
if (fresh || !cached || !existsSync(join(setDir, 'node_modules', '@deepseek-ai', 'dsh-tools'))) installClosure()
else console.log(`using the cached ${floor} closure at ${setDir}`)

// The fake global root `link-dsh` finds through `npm root -g` once npm_config_prefix is set.
rmSync(rootDir, { recursive: true, force: true })
const fakeDsh = join(rootDir, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(fakeDsh, 'node_modules'), { recursive: true })
symlinkSync(join(setDir, 'node_modules', '@deepseek-ai'), join(fakeDsh, 'node_modules', '@deepseek-ai'))

const floorEnv = { ...process.env, npm_config_prefix: rootDir }

console.log(`\nold-dsh gate — ${groupName} at floor ${floor}`)
const results = []
for (const [label, command, args, cwd] of group.steps) results.push([label, run(label, command, args, cwd, floorEnv)])

// Put the machine back FIRST, so a failing step still leaves a tree compiled against what it runs.
console.log('\n▶ restore against the installed dsh')
let restored = true
for (const [label, command, args, cwd] of group.restore) {
  if (!run(label, command, args, cwd)) restored = false
}

console.log(`\n──────── old-dsh gate summary (${groupName}) ────────`)
for (const [label, ok] of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
console.log(`  ${restored ? 'ok  ' : 'FAIL'} machine restored (relink + rebuild against the installed dsh)`)
const passed = results.every(([, ok]) => ok) && restored
console.log(passed ? `\nold-dsh gate PASSED (${groupName}, floor ${floor})` : `\nold-dsh gate FAILED (${groupName}, floor ${floor})`)
process.exit(passed ? 0 : 1)
