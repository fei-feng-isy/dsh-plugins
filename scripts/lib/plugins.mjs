/**
 * The plugin set — DISCOVERED, never listed.
 *
 * A plugin tree is any top-level directory whose `package.json` defines a `build:dsh` script: that
 * script is the tree's own build entry point, and it is the only thing the workspace dispatcher
 * (`pnpm build:dsh <target>`, `scripts/build-dsh.mjs`) needs. Adding `notes/` with its own build
 * scripts therefore makes `pnpm build:dsh notes` work **without touching any file here** — which is
 * the whole point of discovering instead of listing. `id` is the directory name, i.e. the CLI target.
 *
 * The gates read the same set, so a new plugin cannot be left behind by one of them:
 * `scripts/prove-base-swap.mjs` proves the base-swap property for every discovered tree. The extra
 * family-layout facts that gate needs (`<tree>/packages/plugin`, `<tree>/scripts/mount-smoke.mjs`)
 * are derived here too, and REPORTED by that gate when a tree does not follow the layout yet — a
 * missing layout must never make `pnpm build:dsh` itself fail for that tree.
 *
 * One gate needs MORE than the plugin set: the boundary guard must also scan the base, which is not
 * a plugin (see `discoverGuardTrees()`). `discoverPlugins()` stays plugin-only so the build
 * dispatcher and the release gates are never handed the base as a plugin.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root — this file is `scripts/lib/plugins.mjs`. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The family base's package name: the ONE package a plugin takes shared code from at runtime. */
export const BASE_PACKAGE = '@avantf/dsh-plugin-base'

/**
 * Where a build may put the vendored bootstrap it inlined. Shared on purpose — it is a probe list, so
 * a plugin that emits `lib/types/…` (mem) and one that emits `lib/…` (work) both resolve.
 */
export const BOOTSTRAP_CANDIDATES = ['lib/types/envinit-bootstrap.js', 'lib/envinit-bootstrap.js']

const IGNORED_DIRS = new Set(['node_modules'])

function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Every plugin tree, in a stable (id-sorted) order:
 *
 *   { id, tree, packageDir, name }
 *
 * `tree` is always set. `packageDir`/`name` come from the family layout
 * (`<tree>/packages/plugin/package.json`) and are `undefined` for a tree that does not follow it yet.
 */
export function discoverPlugins() {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name))
    .map((entry) => ({ id: entry.name, tree: join(repoRoot, entry.name) }))
    .filter((candidate) => {
      const build = readManifest(join(candidate.tree, 'package.json'))?.scripts?.['build:dsh']
      return typeof build === 'string' && build.trim().length > 0
    })
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => {
      const packageDir = join(candidate.tree, 'packages/plugin')
      const manifest = readManifest(join(packageDir, 'package.json'))
      return {
        ...candidate,
        packageDir: manifest === undefined ? undefined : packageDir,
        name: manifest?.name ?? `@avantf/dsh-${candidate.id}`,
      }
    })
}

/** The base (the one package named `@avantf/dsh-plugin-base`), found under `base/` by its name. */
export function discoverBase() {
  const baseRoot = join(repoRoot, 'base')
  if (!existsSync(baseRoot)) return undefined
  const candidates = readdirSync(baseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of candidates) {
    const dir = join(baseRoot, entry.name)
    const manifest = readManifest(join(dir, 'package.json'))
    if (manifest?.name === BASE_PACKAGE) return { dir, name: manifest.name, version: manifest.version }
  }
  return undefined
}

/**
 * The family base as a SCAN tree, or `undefined` when there is no base.
 *
 * The base is deliberately NOT part of `discoverPlugins()`: `base/` carries no manifest of its own
 * (the package is `base/plugin-base/`), so the plugin rule (`<dir>/package.json` defines `build:dsh`)
 * cannot see it — and that is correct for the build dispatcher, `release-check` and the generators,
 * which must never mistake the base for a plugin. It was also why the base had NO gate at all: the
 * boundary rules were derived from `discoverPlugins()`, so "a plugin tree must never be imported
 * from the base" (AGENTS.md) was invisible (review §3 工具链). The guard scans the base through this
 * entry and recognises it by `isBase`.
 *
 * `packageDir` is the directory that carries the base manifest (`base/plugin-base`), so the guard's
 * "a tree that follows the family layout must yield real sources" check applies to the base too.
 */
export function discoverBaseTree() {
  const base = discoverBase()
  if (base === undefined) return undefined
  return { id: 'base', tree: join(repoRoot, 'base'), packageDir: base.dir, name: base.name, isBase: true }
}

/**
 * The trees the BOUNDARY guard scans: the base plus every discovered plugin tree.
 *
 * Kept separate from `discoverPlugins()` on purpose — see `discoverBaseTree()`. Only the guard needs
 * the `base` ← plugin direction checked in both directions; giving the base to the build dispatcher
 * would make it build the base as if it were a plugin.
 */
export function discoverGuardTrees() {
  const base = discoverBaseTree()
  return base === undefined ? discoverPlugins() : [base, ...discoverPlugins()]
}
