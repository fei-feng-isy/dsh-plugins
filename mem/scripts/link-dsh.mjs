#!/usr/bin/env node
/**
 * Link the DSH peer packages (@deepseek-ai/dsh-* / cordis / schemastery) into this plugin's
 * `packages/plugin/node_modules` — from the installed dsh, and from nowhere else. The shared
 * implementation (source resolution, the fail-closed missing-peer policy, the version bake) lives in
 * `scripts/lib/link-dsh.mjs`; this entry supplies mem's peer list and its two tree-specific extras.
 *
 * It also publishes the manifest stub the VENDORED client preset globs for: the preset derives its
 * repository root from its own location (`packages/plugin/vendor/dsh-client-preset/`) and resolves
 * the package manifest under THAT root, so `packages/client/avantf-dsh-mem/package.json` (a symlink
 * to this plugin's manifest) is published there.
 *
 * Usage: node scripts/link-dsh.mjs [--runtime <dir>] [--no-bake]
 */
import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findHarness } from '../../scripts/lib/harness-path.mjs'
import { runLinkDsh } from '../../scripts/lib/link-dsh.mjs'
import { presetDriftWarning } from './check-preset-drift.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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

runLinkDsh({
  repo,
  links,
  sourceLabel: 'installed dsh peers',
  bakeNote: '(the startup gate\'s "compiled against" side)',
  beforeLink() {
    // Compiling no longer touches a checkout, so a checkout is only ever the OPTIONAL cross-check for
    // the pinned client preset. When one is present, say (loudly) if the pin has drifted; a checkout
    // legitimately moves ahead between re-alignments, hence a warning and not a failure.
    const harness = findHarness()
    const presetDrift = harness === undefined ? undefined : presetDriftWarning(harness)
    if (presetDrift !== undefined) console.warn(`link-dsh: WARNING: ${presetDrift}`)
  },
  afterLink() {
    publishStub(join(repo, 'packages', 'plugin', 'vendor', 'dsh-client-preset'))
  },
})

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
