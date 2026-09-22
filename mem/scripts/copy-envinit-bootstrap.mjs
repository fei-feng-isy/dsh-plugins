#!/usr/bin/env node
/**
 * Inline the family framework's bootstrap into the plugin build.
 *
 * The plugin's host half is bundled by `tsdown` from `lib/types/**` (tsc's output), and the ONE piece
 * the framework requires to be INLINED is `@avantf/dsh-plugin-base/bootstrap` — a self-contained file with
 * no relative imports and only `node:` builtins. Because it is copied rather than imported by package
 * specifier, it has to be present next to the tsc output BEFORE `tsdown` runs, so this script sits
 * between `tsc` and `tsdown` in `packages/plugin/package.json`'s `build`.
 *
 * It is also the build-time gate the framework asks every consumer for (DESIGN §13.6):
 *
 *   - the vendored copy matches the base this workspace is linked against (a silent drift would ship
 *     a bootstrap that installs a different base version than the one this build was checked with);
 *   - the base package is SELF-CONTAINED: no `dependencies`, and at most the shared `zod` PEER (the
 *     compat half needs it, the host provides it, and it is the same copy the plugin uses);
 *   - the plugin declares the base as a PEER with a real range (never `dependencies`, never `*`).
 *
 * The artifact-side half of the gate (bootstrap really inlined into `lib/index.js`, `@avantf/dsh-plugin-base`
 * still external, `lib/client.js` untouched) lives in `scripts/assert-envinit-artifacts.mjs`, which
 * runs after `tsdown`.
 *
 *   node scripts/copy-envinit-bootstrap.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readBootstrapVersion } from '../../scripts/lib/bootstrap-version.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const sourceJs = join(pluginDir, 'src', 'envinit-bootstrap.js')
const sourceDts = join(pluginDir, 'src', 'envinit-bootstrap.d.ts')
const outDir = join(pluginDir, 'lib', 'types')
const FRAMEWORK = '@avantf/dsh-plugin-base'

const problems = []
function fail(message) {
  problems.push(message)
}

if (!existsSync(sourceJs)) {
  fail(`missing vendored bootstrap ${sourceJs} — run: node scripts/link-envinit.mjs`)
}

const linkedManifest = join(pluginDir, 'node_modules', FRAMEWORK, 'package.json')
let frameworkVersion
if (!existsSync(linkedManifest)) {
  fail(`${FRAMEWORK} is not installed at ${linkedManifest}`)
} else {
  const manifest = JSON.parse(readFileSync(linkedManifest, 'utf8'))
  frameworkVersion = manifest.version
  // `dependencies` must be empty (the vendored bootstrap and the kit stand alone). A `zod` PEER is
  // allowed — it is the SAME copy the plugin and the host use (`catalog:` pins exactly one), and it is
  // what the compat half needs; any OTHER peer would not be provided by a plugin consumer.
  const runtimeDeps = Object.keys(manifest.dependencies ?? {})
  const unexpectedPeers = Object.keys(manifest.peerDependencies ?? {}).filter((name) => name !== 'zod')
  if (runtimeDeps.length > 0 || unexpectedPeers.length > 0) {
    fail(`${FRAMEWORK} must be self-contained (no dependencies, only the shared zod peer): dependencies=[${runtimeDeps.join(', ')}], peerDependencies=[${Object.keys(manifest.peerDependencies ?? {}).join(', ')}]`)
  }
}

const vendored = existsSync(sourceJs) ? readBootstrapVersion(sourceJs) : undefined
if (vendored === undefined) {
  fail(`${sourceJs} does not declare a VERSION`)
} else if (frameworkVersion !== undefined && vendored !== frameworkVersion) {
  fail(`vendored bootstrap is ${vendored} but ${FRAMEWORK} is ${frameworkVersion} — re-vendor: node scripts/link-envinit.mjs`)
}

const pluginManifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const peer = pluginManifest.peerDependencies?.[FRAMEWORK]
if (typeof peer !== 'string' || peer.trim() === '') {
  fail(`${FRAMEWORK} must be declared in packages/plugin/package.json peerDependencies`)
} else if (peer === '*' || /^(link|file|workspace):/.test(peer)) {
  fail(`peerDependencies["${FRAMEWORK}"] = ${peer} — a publishable range is required`)
} else if (vendored !== undefined && frameworkVersion !== undefined) {
  // The range and the inlined bootstrap must AGREE, checked with the framework's OWN predicate
  // (`satisfiesRange`, the same subset the bootstrap applies at startup). This is the check that
  // catches "the framework moved, the plugin's peer range did not": the bootstrap then refuses the
  // copy that is right there, falls back to the registry, and the plugin mounts on the legacy path
  // with only a runtime warning. Observed once for real (framework 0.1.0 vs peer `^0.0.0`).
  const semverUrl = pathToFileURL(join(dirname(linkedManifest), 'dist', 'semver.js')).href
  try {
    const semver = await import(semverUrl)
    if (!semver.satisfiesRange(vendored, peer)) {
      fail(`peerDependencies["${FRAMEWORK}"] = ${peer} does not accept the framework ${vendored} — bump the range with the framework`)
    }
  } catch (error) {
    fail(`cannot check ${peer} against ${vendored} (${error instanceof Error ? error.message : String(error)})`)
  }
}

for (const problem of problems) console.error(`  FAIL ${problem}`)
if (problems.length > 0) {
  console.error('copy-envinit-bootstrap: FAILED')
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
copyFileSync(sourceJs, join(outDir, 'envinit-bootstrap.js'))
// The declaration too, so the emitted `lib/types/envinit.d.ts` resolves its relative import when a
// consumer type-checks the published package (tsc does not emit inputs that are already `.d.ts`).
copyFileSync(sourceDts, join(outDir, 'envinit-bootstrap.d.ts'))
console.log(`copy-envinit-bootstrap: ok — bootstrap ${String(vendored)} (${FRAMEWORK} ${String(frameworkVersion)}) → lib/types/envinit-bootstrap.js`)
