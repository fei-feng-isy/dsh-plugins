#!/usr/bin/env node
/**
 * Remove this workspace's build output and caches — and nothing else.
 *
 * The merged repository holds three package groups (`base/*`, `mem/packages/*`, `work/packages/*`),
 * each with its own `lib/` or `dist/`. A blanket recursive delete of every `lib` and `dist` directory
 * is how a clean script deletes a hand-written directory that happened to be named `dist`; this one
 * only touches those groups, only removes a `release/` directory's `*.tgz` (the `release/README.md`
 * files are tracked source), refuses to follow a symlink, and prints what it removes.
 *
 * Usage:
 *   node scripts/clean.mjs                 # remove build output + caches
 *   node scripts/clean.mjs --dry-run       # print, remove nothing
 *   node scripts/clean.mjs --group work    # only one package group (`base` | `mem` | `work`)
 *
 * `--group` is what a subtree's own `pnpm clean` uses: a hand-written recursive delete in a manifest
 * is neither portable nor aware of the release-tarball rule below, and that subtree should not have to
 * clean its SIBLINGS to get one implementation.
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const groupIndex = process.argv.indexOf('--group')
const groupFilter = groupIndex === -1 ? undefined : process.argv[groupIndex + 1]

/** The parent directory of each package group, keyed by the name `--group` takes. */
const GROUPS = new Map([
  ['base', 'base'],
  ['mem', 'mem/packages'],
  ['work', 'work/packages'],
])
if (groupFilter !== undefined && !GROUPS.has(groupFilter)) {
  console.error(`clean: unknown group '${String(groupFilter)}' (expected ${[...GROUPS.keys()].join(', ')})`)
  process.exit(2)
}
const GROUP_PARENTS = [...GROUPS.entries()].filter(([name]) => groupFilter === undefined || name === groupFilter).map(([, parent]) => parent)
const OUTPUT_DIRS = ['lib', 'dist']
const CACHE_DIRS = ['coverage', '.vitest']
const NODE_CACHE_DIRS = ['.cache', '.vite']

let removed = 0
function remove(path) {
  if (!existsSync(path)) return
  // Never follow a symlink: a linked checkout would turn `clean` into "delete someone else's build".
  if (lstatSync(path).isSymbolicLink()) {
    console.log(`  skip  ${relative(repo, path)} (symlink)`)
    return
  }
  console.log(`  ${dryRun ? 'would remove' : 'remove'}  ${relative(repo, path)}`)
  removed += 1
  if (!dryRun) rmSync(path, { recursive: true, force: true })
}

for (const parent of GROUP_PARENTS) {
  const root = join(repo, parent)
  if (!existsSync(root)) continue
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkg = join(root, entry.name)
    if (!existsSync(join(pkg, 'package.json'))) continue
    for (const output of OUTPUT_DIRS) remove(join(pkg, output))
    for (const cache of CACHE_DIRS) remove(join(pkg, cache))
    for (const cache of NODE_CACHE_DIRS) remove(join(pkg, 'node_modules', cache))
    // A release directory is tracked source except for the packed tarballs.
    const release = join(pkg, 'release')
    if (existsSync(release)) {
      for (const name of readdirSync(release)) {
        if (name.endsWith('.tgz')) remove(join(release, name))
      }
    }
  }
}
for (const cache of NODE_CACHE_DIRS) remove(join(repo, 'node_modules', cache))

console.log(`\nclean ${dryRun ? 'dry-run' : 'ok'} — ${removed} path${removed === 1 ? '' : 's'}`)
