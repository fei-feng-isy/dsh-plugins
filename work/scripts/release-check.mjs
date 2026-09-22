#!/usr/bin/env node
/**
 * The gate to run before releasing: typecheck, build, test, verify, pack.
 *
 * Deliberately sequential and fail-fast — a release check that keeps going after a failure reports
 * symptoms instead of the first cause. Each package's binary runs from that package's directory (the
 * workspace install skips dependency build scripts). Both link-touching steps link the INSTALLED dsh
 * and leave it linked: these are the links the running profile resolves on its next load, so pointing
 * them at a harness checkout would hand it a second cordis / zod.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** One step: a label, the command, its args, and where to run it. */
const steps = [
  ['typecheck', process.execPath, [join(repo, 'scripts', 'typecheck.mjs')], repo],
  ['build:dsh', process.execPath, [join(repo, 'scripts', 'build-plugin.mjs')], repo],
  [
    'test core',
    join(repo, 'packages/core/node_modules/.bin/vitest'),
    ['run'],
    join(repo, 'packages/core'),
  ],
  [
    'test plugin',
    join(repo, 'packages/plugin/node_modules/.bin/vitest'),
    ['run'],
    join(repo, 'packages/plugin'),
  ],
  ['client smoke', process.execPath, [join(repo, 'scripts', 'client-smoke.mjs')], repo],
  ['pack', process.execPath, [join(repo, 'scripts', 'pack-plugin.mjs')], repo],
]

for (const [label, command, args, cwd] of steps) {
  console.log(`\n▶ ${label}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.error) {
    console.error(`  cannot run ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`\nrelease:check FAILED at: ${label}`)
    process.exit(result.status ?? 1)
  }
}

// The packed artifacts must be installable: `pnpm pack` rewrites `catalog:` / `workspace:*` into
// registry ranges while `npm pack` copies `package.json` verbatim, so checking the CONTENT is what
// stops an uninstallable tarball from silently coming back — swapping the command is not a test.
const releaseDir = join(repo, 'release')
const tarballs = readdirSync(releaseDir).filter((name) => name.endsWith('.tgz'))
if (tarballs.length === 0) {
  console.error('\nrelease:check FAILED: packing produced no tarball')
  process.exit(1)
}
for (const name of tarballs) {
  const read = spawnSync('tar', ['-xzOf', join(releaseDir, name), 'package/package.json'], {
    encoding: 'utf8',
  })
  if (read.status !== 0) {
    console.error(`\nrelease:check FAILED: cannot read ${name}: ${read.stderr ?? read.error?.message}`)
    process.exit(1)
  }
  for (const protocol of ['catalog:', 'workspace:']) {
    if (read.stdout.includes(`"${protocol}`)) {
      console.error(
        `\nrelease:check FAILED: ${name} still declares ${protocol} — pack with pnpm, not npm`,
      )
      process.exit(1)
    }
  }
  // A `link:` / `file:` specifier means the artifact still points at a local checkout — the one
  // thing a published tarball must never do. `pnpm pack` rewrites `workspace:*` into a registry
  // range, so a `link:` here can only come from a hand-edited manifest (or a local path that
  // slipped into peer/devDependencies), and it is not installable outside this machine.
  // `@avantf/dsh-plugin-base` in particular must resolve from the registry; the publish order is
  // base FIRST, then this plugin, and the release script asserts a compatible base is already there.
  for (const protocol of ['link:', 'file:']) {
    if (read.stdout.includes(`"${protocol}`)) {
      console.error(
        `\nrelease:check FAILED: ${name} declares a ${protocol} dependency — a published artifact must resolve its peers from the registry`,
      )
      process.exit(1)
    }
  }
  console.log(`  ok   ${name} carries registry ranges`)
}

console.log('\nrelease:check ok')
