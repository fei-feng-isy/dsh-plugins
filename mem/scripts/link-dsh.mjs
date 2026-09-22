#!/usr/bin/env node
/**
 * Link the DSH peer packages (@deepseek-ai/dsh-* / cordis / schemastery) into the
 * plugin's node_modules — FROM THE INSTALLED dsh, and from nowhere else.
 *
 * The peers' transitive dependencies are not all npm-published, so pnpm never
 * installs them (`autoInstallPeers: false`). This script symlinks the copies the
 * running dsh itself uses (`npm i -g @deepseek-ai/dsh`, discovered via
 * `npm root -g`), so the plugin shares cordis/schemastery object identity with
 * its host: `ctx.typert.register` and the tool registries are keyed by object
 * identity, and linking one copy while running another silently mismatches.
 *
 * Compiling is therefore against the dsh you actually run, and it needs **no
 * harness source checkout**: the plugin's client preset is the verbatim copy
 * pinned under `packages/plugin/vendor/dsh-client-preset/`.
 *
 * It also publishes the manifest stub the VENDORED preset globs for: the preset
 * derives its repository root from its own location
 * (`packages/plugin/vendor/dsh-client-preset/`) and resolves the package
 * manifest under THAT root, so `packages/client/avantf-dsh-mem/package.json`
 * (a symlink to this plugin's manifest) is published there.
 *
 * Usage: node scripts/link-dsh.mjs      (takes no options)
 *
 * After linking, it also bakes what it just linked into
 * `packages/plugin/lib/dsh-build.json` (`scripts/build-versions.mjs`), so the
 * startup gate can say which dsh this artifact was COMPILED against instead of
 * falling back to a peer range's floor.
 */
import { mkdirSync, symlinkSync, existsSync, rmSync, lstatSync, readlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedDshDir, findHarness } from '../../scripts/lib/harness-path.mjs'
import { presetDriftWarning } from './check-preset-drift.mjs'
import { writeBuildVersions } from './build-versions.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
if (argv.length > 0) {
  console.error(`link-dsh: unknown option ${argv.join(', ')}`)
  console.error('usage: node scripts/link-dsh.mjs')
  process.exit(2)
}

/** The peer packages the plugin imports; every one must come from the installed dsh. */
const links = [
  'cordis',
  'schemastery',
  'dsh-tools',
  // The plugin contributes one system-prompt section, so it type-checks against the prompt
  // registry's `Context` augmentation. Type-only: nothing of this package reaches the bundle.
  'dsh-system-prompt',
  'dsh-typert-protocol',
  'dsh-typert-registry',
  'dsh-util-values',
]

/** The directory holding the installed dsh's @deepseek-ai packages. */
const dshDir = installedDshDir()
const source = dshDir === undefined ? undefined : join(dshDir, 'node_modules', '@deepseek-ai')
if (source === undefined || !existsSync(source)) {
  console.error(`link-dsh: the installed dsh packages were not found${source === undefined ? '' : ` at ${source}`}`)
  console.error('  install it first: npm i -g @deepseek-ai/dsh')
  process.exit(1)
}
console.log(`installed dsh peers: ${source}`)

// Compiling no longer touches a checkout, so a checkout is only ever the OPTIONAL cross-check for
// the pinned client preset. When one is present, say (loudly) if the pin has drifted; a checkout
// legitimately moves ahead between re-alignments, hence a warning and not a failure.
const harness = findHarness()
const presetDrift = harness === undefined ? undefined : presetDriftWarning(harness)
if (presetDrift !== undefined) console.warn(`link-dsh: WARNING: ${presetDrift}`)

const dir = join(repo, 'packages', 'plugin', 'node_modules', '@deepseek-ai')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
for (const name of links) {
  const target = join(source, name)
  if (!existsSync(target)) { console.warn(`skip ${name}: missing ${target}`); continue }
  symlinkSync(target, join(dir, name))
  console.log(`linked @deepseek-ai/${name} -> ${target}`)
}

// The VENDORED client preset (packages/plugin/vendor/dsh-client-preset) derives its repository
// root from its own location — `<vendor>/dsh-client-preset/` — and globs the manifest under THAT
// root. Publish the stub there: it is a symlink to this plugin's package.json, so the
// production-section rules tsdown derives stay a property of the one real manifest.
publishStub(join(repo, 'packages', 'plugin', 'vendor', 'dsh-client-preset'))

/**
 * Bake what was just linked: these ARE the versions this build compiles against, and the startup
 * gate's `declared` side must be that exact set rather than a peer range's floor. The tsdown node-face
 * pass runs with `clean: false`, so writing before the bundle survives it.
 */
try {
  const { file, versions } = writeBuildVersions()
  console.log(
    `build-versions: baked ${String(Object.keys(versions).length)} linked dsh version(s) into ${file} `
    + `(the startup gate's "compiled against" side)`,
  )
} catch (error) {
  console.warn(`link-dsh: could not bake the linked versions (${error instanceof Error ? error.message : String(error)})`)
}

console.log('\nDone. The plugin now resolves its DSH peers from the installed dsh.')

/**
 * Publish the client preset's manifest stub (a symlink to this plugin's manifest) under the
 * preset root. Idempotent: an already-correct symlink is left alone.
 */
function publishStub(presetRoot) {
  const stub = join(presetRoot, 'packages', 'client', 'avantf-dsh-mem')
  mkdirSync(stub, { recursive: true })
  const stubManifest = join(stub, 'package.json')
  const manifest = join(repo, 'packages', 'plugin', 'package.json')
  let current
  try { current = lstatSync(stubManifest).isSymbolicLink() ? resolve(dirname(stubManifest), readlinkSync(stubManifest)) : undefined } catch { current = undefined }
  if (current === manifest) {
    console.log(`vendored preset stub already published: ${stub}/package.json -> packages/plugin/package.json`)
  } else {
    rmSync(stubManifest, { force: true })
    symlinkSync(manifest, stubManifest)
    console.log(`published vendored preset stub ${stub}/package.json -> packages/plugin/package.json`)
  }
}
