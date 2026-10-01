#!/usr/bin/env node
/**
 * Link the DSH peer packages (`@deepseek-ai/dsh-*` / cordis / schemastery) into a plugin's
 * `packages/plugin/node_modules` — FROM THE INSTALLED dsh, and from nowhere else. ONE implementation
 * for both plugin trees.
 *
 * The peers' transitive dependencies are not all npm-published, so pnpm never installs them
 * (`autoInstallPeers: false`). This script symlinks the copies the running dsh itself uses
 * (`npm i -g @deepseek-ai/dsh`, discovered via `npm root -g`), so a plugin shares cordis/schemastery
 * object identity with its host: `ctx.typert.register` and the tool registries are keyed by object
 * identity, and linking one copy while running another silently mismatches. Compiling is therefore
 * against the dsh you actually run, and it needs **no harness source checkout**.
 *
 *   node scripts/link-dsh.mjs                  # the globally installed dsh
 *   node scripts/link-dsh.mjs --runtime <dir>  # an explicit installation
 *   node scripts/link-dsh.mjs --no-bake        # link only; do not write the "compiled against" record
 *
 * `--no-bake` is for callers that LINK but do not COMPILE (`typecheck`, `link-profile`): a run that
 * emits nothing must not re-certify a stale `lib/index.js` against a dsh it was never compiled with.
 *
 * A MISSING peer is a FAILURE, not a skip, and that policy is now single for both trees: the list IS
 * the build's compile surface, and a build that silently drops one compiles against nothing for it
 * while `pack-plugin` can only notice the loss when the package happens to be in `VERSION_PACKAGES`.
 * Fail-closed was chosen over the old `warn + skip` (mem) because a build that cannot resolve a
 * declared dsh peer is precisely the state the artifact must not be certified from.
 *
 * After linking it bakes what it just linked into `packages/plugin/lib/dsh-build.json`
 * (`scripts/lib/build-versions.mjs`), so the startup gate can say which dsh this artifact was
 * COMPILED against instead of falling back to a peer range's floor.
 *
 * @module scripts/lib/link-dsh
 */
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { installedDshDir } from './harness-path.mjs'
import { makeBuildVersions } from './build-versions.mjs'

/** Flags that take no value. */
export const LINK_DSH_FLAGS = ['--runtime', '--no-bake']

/**
 * Parse `link-dsh`'s argv. `--runtime` takes one optional positional directory; everything else is a
 * flag, and an unknown one (or a stray positional) is an error rather than a silent no-op.
 * @returns `{ runtime, noBake }` where `runtime` is the raw `--runtime` value (possibly `undefined`).
 */
export function parseLinkDshArgs(argv) {
  const runtimeIndex = argv.indexOf('--runtime')
  for (const [index, arg] of argv.entries()) {
    if (arg.startsWith('--') && !LINK_DSH_FLAGS.includes(arg)) {
      console.error(`link-dsh: unknown option ${arg}`)
      process.exit(2)
    }
    if (!arg.startsWith('--') && argv[index - 1] !== '--runtime') {
      console.error(`link-dsh: unexpected argument ${arg}`)
      process.exit(2)
    }
  }
  const value = runtimeIndex >= 0 ? argv[runtimeIndex + 1] : undefined
  return { runtime: value !== undefined && !value.startsWith('--') ? value : undefined, noBake: argv.includes('--no-bake') }
}

/**
 * The `@deepseek-ai` directory to link from: the `--runtime` installation, else the installed dsh.
 * @returns the directory, or `undefined` when the global npm root cannot be discovered.
 */
export function resolveDshSource(runtime) {
  if (runtime !== undefined) {
    return runtime.endsWith('@deepseek-ai') ? runtime : join(runtime, 'node_modules', '@deepseek-ai')
  }
  const dir = installedDshDir()
  return dir === undefined ? undefined : join(dir, 'node_modules', '@deepseek-ai')
}

/**
 * Run one tree's link step.
 *
 * @param options.repo - the plugin tree root (`<repo>/mem` or `<repo>/mission`).
 * @param options.links - the `@deepseek-ai/*` short names this tree compiles against.
 * @param options.argv - defaults to `process.argv.slice(2)`.
 * @param options.sourceLabel - how the resolved install is announced (e.g. `installed dsh peers`).
 * @param options.bakeNote - the parenthetical that follows the bake line.
 * @param options.beforeLink - `({ source }) => void`, after the install is resolved, before linking
 *   (a tree's own cross-checks).
 * @param options.afterLink - `({ source, target }) => void`, after linking, before baking (a tree's
 *   own published stubs).
 */
export function runLinkDsh({
  repo,
  links,
  argv = process.argv.slice(2),
  sourceLabel = 'installed dsh',
  bakeNote,
  beforeLink,
  afterLink,
}) {
  const { runtime, noBake } = parseLinkDshArgs(argv)
  const target = join(repo, 'packages', 'plugin', 'node_modules', '@deepseek-ai')

  const source = resolveDshSource(runtime)
  if (source === undefined) {
    console.error('link-dsh: cannot discover the global npm root; pass --runtime <dshDir>')
    process.exit(1)
  }
  if (!existsSync(source)) {
    console.error(`link-dsh: the installed dsh packages were not found at ${source}`)
    console.error('  install it first: npm i -g @deepseek-ai/dsh')
    process.exit(1)
  }
  console.log(`${sourceLabel}: ${source}`)

  beforeLink?.({ source })

  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  let linked = 0
  let firstLinked
  const missing = []
  for (const name of links) {
    const from = join(source, name)
    if (!existsSync(from)) {
      missing.push(name)
      continue
    }
    const to = join(target, name)
    symlinkSync(from, to, 'dir')
    firstLinked ??= to
    linked += 1
  }
  if (missing.length > 0) {
    console.error(`link-dsh: ${String(missing.length)} declared peer(s) are missing from ${source}:`)
    for (const name of missing) console.error(`  @deepseek-ai/${name}`)
    console.error('  this dsh install is older or partial than the peer set this plugin declares;')
    console.error('  install a matching dsh (npm i -g @deepseek-ai/dsh) or fix the declared peers')
    process.exit(1)
  }

  console.log(`link-dsh: linked ${String(linked)} package(s) into packages/plugin/node_modules`)
  if (firstLinked !== undefined) console.log(`  ${readlinkSync(firstLinked)}`)

  afterLink?.({ source, target })

  if (noBake) {
    console.log('link-dsh: --no-bake — left the baked build versions untouched (this run emits no artifact)')
    return
  }
  try {
    const { file, versions } = makeBuildVersions(repo).writeBuildVersions()
    console.log(
      `build-versions: baked ${String(Object.keys(versions).length)} linked dsh version(s) into ${file}`
      + (bakeNote === undefined ? '' : ` ${bakeNote}`),
    )
  } catch (error) {
    console.warn(`link-dsh: could not bake the linked versions (${error instanceof Error ? error.message : String(error)})`)
  }
}
