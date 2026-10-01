#!/usr/bin/env node
/**
 * Pack `@avantf/dsh-mem` as the ONE package a user installs, and assert it is self-contained.
 *
 * The plugin's Node half IS the product: the engine (`@avantf/mem-contract` → `@avantf/mem-core`
 * → `@avantf/mem`) is inlined by the harness tsdown preset BECAUSE it sits in `devDependencies`
 * (production sections stay imports, everything else inlines). That makes "is this a single
 * installable package?" a property of two artifacts — the manifest and `lib/index.js` — that no
 * type-checker or test can see: moving an engine package back into `dependencies` un-inlines it and
 * the package still builds, still passes the mount smoke in THIS repo, and then fails on a user's
 * machine with `Cannot find package '@avantf/mem'`.
 *
 * The ASSERTIONS now live in `scripts/lib/pack-plugin.mjs` (shared with `mission/`, which runs the
 * same union — mem's stray/self-containment/`workspace:` checks and mission's shipped-file peer,
 * bake↔VERSION_PACKAGES and relative-closure checks). This file supplies mem's shape: the bootstrap
 * is INLINED into the entry, the engine's declarations are carried into `lib/engine/`.
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
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withWorkspaceVersions } from '../../scripts/lib/versions.mjs'
import { assertCheckout, assertTarball, clearTarballs, mountAllVariants, parsePackArgs, report } from '../../scripts/lib/pack-plugin.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const production = { ...manifest.dependencies, ...manifest.optionalDependencies }

const config = {
  repo,
  pluginDir,
  entry: 'lib/index.js',
  clientEntry: 'lib/client.js',
  /** mem's bundler carries the vendored bootstrap TEXT into the entry. */
  bootstrap: 'inlined',
  bootstrapFile: 'lib/envinit-bootstrap.js',
  /** The engine's declarations are repointed and carried here. */
  carriedTypesDir: 'lib/engine',
  /**
   * `lib/types/**\/*.js` (+ its `.js.map`) is the tsc INTERMEDIATE the tsdown preset consumes: a build
   * input, not a published surface. `package.json`'s `files` negations keep it out of the tarball;
   * this regex makes a `files` edit that lets it back in a STRAY (a hard failure), never a silent ship.
   * `lib/client.js.map` is deliberately not shipped: the client bundle keeps its sourcemap for local
   * debugging, so its trailing `sourceMappingURL` comment dangles on purpose.
   */
  libAllow: /^package\/lib\/(index\.js|client\.js|dsh-build\.json|interface-version\.json|types\/.*\.d\.ts(?:\.map)?|engine\/.*\.d\.ts)$/,
  requiredEntries: [
    'package/lib/index.js',
    'package/lib/client.js',
    'package/lib/types/index.d.ts',
    'package/lib/dsh-build.json',
    'package/lib/interface-version.json',
    'package/README.md',
    'package/LICENSE',
  ],
  versionPackagesFile: 'src/provision.ts',
  /**
   * mem bakes EVERY linked `dsh-*` package (so the file cannot drift from what was linked) while its
   * gate compares the two `provision.ts` names. The reverse check — every package the gate names is
   * baked — is the one a silent floor fallback would defeat, and it runs here; the forward one would
   * demand editing `provision.ts`, which is outside this convergence.
   */
  allowBakedSuperset: true,
}

const { mount, keep, outDir } = parsePackArgs(process.argv.slice(2), { defaultOutDir: join(repo, 'dist') })
clearTarballs(outDir)

const problems = [...assertCheckout(config).problems]

// ── pack ────────────────────────────────────────────────────────────────────────────────────────
console.log(`\n▶ pnpm pack → ${outDir}`)
// `pnpm pack` rewrites `workspace:*` into the TARGET's version, and the engines deliberately carry none
// in the tree (the version is recorded once, in this package's manifest) — so the private targets get it
// materialized for the duration of the pack and lose it again right after. Nothing is committed;
// `version:check` fails on a leftover. `{ group: 'mem' }` narrows that to THIS tree's private packages:
// the default spans every group, so a `mem` pack would briefly stamp its version onto mission's
// manifests too (the M7 defect).
const packStatus = withWorkspaceVersions(resolve(repo, '..'), manifest.version, () =>
  spawnSync('pnpm', ['--filter', manifest.name, 'pack', '--pack-destination', outDir], { cwd: repo, stdio: 'inherit', env: process.env }), { group: 'mem' })
if (packStatus.status !== 0) problems.push('pnpm pack failed')

// pnpm names the tarball after the manifest, so the expected path is known rather than guessed.
const tarball = join(outDir, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`)
if (!existsSync(tarball)) {
  console.error(`pack-plugin: expected ${tarball} — check the pnpm pack output above`)
  process.exit(1)
}
problems.push(...assertTarball(config, tarball).problems)

// ── optional: mount the packed copy in a scratch DSH profile ──────────────────────────────────
const notes = []
if (mount && problems.length === 0) {
  // Peers come from the installed dsh — the same copies a live profile would hand the plugin.
  const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim()
  const runtimeSource = join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
  mountAllVariants({
    tarball,
    repo,
    keep,
    fail: (message) => problems.push(message),
    note: (message) => notes.push(message),
    scratchPrefix: 'avf-pack-mount-',
    smokeArgs: [],
    absentEnv: 'AVANTF_ENVINIT_ABSENT',
    packageDirName: 'dsh-mem',
    prepare({ scratch, linkBase, note }) {
      // The runtime externals an npm install would have put next to the package. Every `@avantf/*`
      // ENGINE name stays unlinked on purpose: a leaked engine import must fail to resolve.
      for (const name of Object.keys(production)) {
        const from = join(pluginDir, 'node_modules', name)
        if (!existsSync(from)) { note(`scratch: ${name} is not installed here — the mount may degrade`); continue }
        mkdirSync(dirname(join(scratch, 'node_modules', name)), { recursive: true })
        symlinkSync(from, join(scratch, 'node_modules', name))
      }
      // The base peer. Linked (resolvable) or absent (unresolvable), never both: the variant's whole
      // point is which of the two bootstrap paths runs.
      if (linkBase) {
        const from = join(pluginDir, 'node_modules', '@avantf/dsh-plugin-base')
        if (!existsSync(from)) note('scratch: @avantf/dsh-plugin-base is not installed here — the mount will take the legacy path')
        else symlinkSync(from, join(scratch, 'node_modules', '@avantf', 'dsh-plugin-base'))
      }
      mkdirSync(join(scratch, 'node_modules', '@deepseek-ai'), { recursive: true })
      for (const name of ['cordis', 'schemastery', 'dsh-tools', 'dsh-system-prompt', 'dsh-typert-protocol', 'dsh-typert-registry', 'dsh-util-values']) {
        const from = join(runtimeSource, name)
        if (!existsSync(from)) { note(`scratch: @deepseek-ai/${name} not found in ${runtimeSource}`); continue }
        symlinkSync(from, join(scratch, 'node_modules', '@deepseek-ai', name))
      }
    },
  })
}

report(problems, notes, `PACK OK — single installable package: ${tarball}`)
if (!mount) console.log('  (static assertions only; add --mount to install-and-mount the tarball)')
