#!/usr/bin/env node
/**
 * `pnpm build:dsh` — build the DSH plugins: all of them, or just the one you name.
 *
 *   pnpm build:dsh            # every plugin, in build order
 *   pnpm build:dsh mem        # the memory/knowledge plugin only
 *   pnpm build:dsh mission       # the mission-tree plugin only
 *   pnpm build:dsh base       # the base alone (tsc — no plugin bundle, no mount smoke)
 *
 * The plugin set is DISCOVERED (`scripts/lib/plugins.mjs`), not listed here: a plugin tree is a
 * top-level directory whose `package.json` defines a `build:dsh` script. Adding `notes/` with its own
 * build scripts makes `pnpm build:dsh notes` work with no change to this file — no registry to update,
 * no list to forget.
 *
 * This script only ROUTES. The actual build stays where it is — `mem/scripts/build-plugin.mjs`,
 * `mission/scripts/build-plugin.mjs`, the base's `tsc` — because each plugin's pipeline is genuinely its
 * own (mem: tsc + the pinned tsdown client preset; mission: tsc + esbuild + core-type relocation). What
 * a developer should not have to remember is WHICH tree to enter, and that is all this adds: one entry
 * point over the per-plugin ones, which keep working unchanged.
 *
 * Arguments after the target are forwarded to that plugin's own `build:dsh`, so its flags keep their
 * meaning: `pnpm build:dsh mem --fresh`, `pnpm build:dsh mission --skip-link`. With NO target they are
 * refused up front, because flags are per-plugin: `--fresh` is mem-only, and forwarding it to a plugin
 * that rejects it would abort the run after another plugin had already been rebuilt. What each plugin
 * accepts is its own business — ask it: `pnpm build:dsh mem --help`.
 */
import { join, relative } from 'node:path'
import { BASE_PACKAGE, discoverBase, discoverPlugins, repoRoot } from './lib/plugins.mjs'
import { spawnToolSync } from './lib/win-spawn.mjs'

const plugins = discoverPlugins()
const base = discoverBase()

const USAGE = `usage: pnpm build:dsh [target] [flags]

targets:
  (none)   every plugin, in build order: ${plugins.map((plugin) => plugin.id).join(', ') || '(none discovered)'}
           (each plugin build also builds the base)
${plugins.map((plugin) => `  ${plugin.id.padEnd(8)} ${plugin.name}, only`).join('\n')}
  base     the base alone (\`tsc\`; no plugin bundle, no mount smoke)

A plugin is any top-level directory whose package.json defines a \`build:dsh\` script — adding one
(e.g. \`notes/\`) makes \`pnpm build:dsh notes\` work with no change to this script.

flags after a target go to that plugin's own \`build:dsh\` (see \`pnpm build:dsh <target> --help\`);
with no target they are refused, because flags are per-plugin.
`

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const targets = argv.filter((arg) => !arg.startsWith('-'))
const flags = argv.filter((arg) => arg.startsWith('-'))
const isHelp = (flag) => flag === '--help' || flag === '-h'

function refuse(message) {
  console.error(`build:dsh: ${message}`)
  console.error(USAGE)
  process.exit(2)
}

// `--help` with no target is OUR help. With a target it belongs to that plugin's own `build:dsh`
// (`pnpm build:dsh mem --help` documents mem's `--fresh` / `--skip-deps`), so it is forwarded.
if (targets.length === 0 && flags.some(isHelp)) {
  console.log(USAGE)
  process.exit(0)
}

if (targets.length > 1) refuse(`one target at a time (got ${targets.join(', ')})`)
const target = targets[0] ?? 'all'
const known = new Set(['all', 'base', ...plugins.map((plugin) => plugin.id)])
if (!known.has(target)) {
  refuse(`unknown target '${target}' (expected all, base${plugins.map((plugin) => `, ${plugin.id}`).join('')})`)
}

/** The steps to run, in order: `pnpm -C <dir> <script> <flags>`. */
let steps
if (target === 'base') {
  // The base is a plain `tsc`: it has no flags of its own, and no plugin help to forward to.
  const own = flags.filter((flag) => !isHelp(flag))
  if (own.length > 0) refuse(`the base build takes no flags (got ${own.join(', ')})`)
  if (flags.some(isHelp)) {
    console.log(USAGE)
    process.exit(0)
  }
  if (base === undefined) refuse(`no package named ${BASE_PACKAGE} under base/ — nothing to build`)
  steps = [{ label: 'base', dir: relative(repoRoot, base.dir), script: 'build', flags: [] }]
} else if (target === 'all') {
  if (plugins.length === 0) {
    refuse('no plugin tree found — a plugin tree is a top-level directory with a `build:dsh` script')
  }
  if (flags.length > 0) {
    refuse(
      `${flags.join(', ')} is per-plugin — name the plugin that takes it, e.g. \`pnpm build:dsh ${plugins[0].id} ${flags[0]}\``,
    )
  }
  steps = plugins.map((plugin) => ({
    label: plugin.id,
    dir: relative(repoRoot, plugin.tree),
    script: 'build:dsh',
    flags: [],
  }))
} else {
  const plugin = plugins.find((candidate) => candidate.id === target)
  steps = [{ label: plugin.id, dir: relative(repoRoot, plugin.tree), script: 'build:dsh', flags }]
}

const started = Date.now()
for (const step of steps) {
  const command = ['pnpm', '-C', step.dir, step.script, ...step.flags].join(' ')
  console.log(`\n▶ build:dsh ${step.label}: ${command}`)
  const result = spawnToolSync('pnpm', ['-C', join(repoRoot, step.dir), step.script, ...step.flags], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) {
    console.error(`build:dsh: could not run pnpm (${result.error.message})`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`\nbuild:dsh: ${step.label} FAILED (exit ${String(result.status)}) — ${command}`)
    process.exit(result.status ?? 1)
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\nbuild:dsh: ok — ${steps.map((step) => step.label).join(', ')} (${seconds}s)`)
