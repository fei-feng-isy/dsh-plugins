#!/usr/bin/env node
/**
 * Build the DSH plugin end to end — `pnpm build:dsh` is the single entry point:
 *
 *   1. link the DSH peer packages from the INSTALLED dsh (never a harness checkout), so the plugin is
 *      compiled against exactly the declarations it shares with the running host;
 *   2. build the workspace in dependency order (`@avantf/mission-core`, then the plugin);
 *   3. bundle the browser half (esbuild, its own artifact contract);
 *   4. run the real-Cordis mount smoke against those same installed-dsh links.
 *
 * The links are left in place (the running profile resolves them on its next load, so ending on a
 * checkout would hand it a second cordis / zod).
 *
 *   pnpm build:dsh [--skip-link] [--no-verify]
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnToolSync } from '../../scripts/lib/win-spawn.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2))
const known = ['--skip-link', '--no-verify', '--help', '-h']
const unknown = [...flags].filter((flag) => !known.includes(flag))
if (unknown.length > 0) {
  console.error(`build:dsh: unknown option ${unknown.join(', ')}`)
  process.exit(2)
}
if (flags.has('--help') || flags.has('-h')) {
  console.log('usage: node scripts/build-plugin.mjs [--skip-link] [--no-verify]')
  console.log('  --skip-link   do not touch the peer links at all')
  console.log('  --no-verify   skip the mount smoke')
  process.exit(0)
}

const node = process.execPath
const skipLink = flags.has('--skip-link')

let failed = false

/** Run one step; failure is recorded (not thrown) so later diagnostics still run. */
function run(label, command, args) {
  console.log(`\n▶ ${label}`)
  const result = spawnToolSync(command, args, { cwd: repo, stdio: 'inherit', env: process.env })
  if (result.error) {
    console.error(`  cannot run ${command}: ${result.error.message}`)
    failed = true
    return
  }
  if (result.status !== 0) {
    console.error(`  step failed: ${label}`)
    failed = true
  }
}

if (!skipLink) {
  run(
    'link DSH peers (the installed dsh the live profile shares)',
    node,
    [join(repo, 'scripts', 'link-dsh.mjs'), '--runtime'],
  )
  // The framework is a peer too, and a devDependency whose range `pnpm-workspace.yaml`'s
  // `linkWorkspacePackages: true` resolves to the sibling `base/plugin-base` — not to a registry copy.
  // This vendors `bootstrap.js` (the one inlined piece) from that workspace link.
  run(
    'vendor @avantf/dsh-plugin-base bootstrap (from the install)',
    node,
    [join(repo, 'scripts', 'link-envinit.mjs')],
  )
}

if (!failed) {
  run('build workspace', node, [join(repo, 'scripts', 'build.mjs')])
  // The browser half is bundled separately: it has its own entry, its own externals
  // and a different artifact contract (`window.__ModuleLoader__.load`). Running it
  // after tsc means the client's types are already checked.
  run('build client half', node, [join(repo, 'scripts', 'build-client.mjs')])
}

if (!failed) {
  for (const artifact of [
    join(repo, 'packages', 'plugin', 'lib', 'index.js'),
    join(repo, 'packages', 'plugin', 'lib', 'client.js'),
  ]) {
    if (!existsSync(artifact)) {
      console.error(`build:dsh: missing artifact ${artifact}`)
      failed = true
    } else {
      console.log(`\nartifact: ${artifact}`)
    }
  }
}

if (!failed && !flags.has('--no-verify')) {
  run('mount smoke', node, [join(repo, 'scripts', 'mount-smoke.mjs'), '--runtime'])
}

console.log(`\nbuild:dsh: DSH peers = ${skipLink ? 'untouched' : 'the installed dsh'}`)
if (failed) {
  console.error('build:dsh: FAILED')
  process.exit(1)
}
console.log('build:dsh: ok')
