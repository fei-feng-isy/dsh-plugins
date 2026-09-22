#!/usr/bin/env node
/**
 * Post-build assertion: the base's ONE inlined piece really is inlined, the base itself is still
 * external, and none of the base's shared KIT got copied into the plugin bundle.
 *
 * Run after `tsdown` (from `scripts/build-plugin.mjs`). The base ships the framework half of the gate
 * as `assertEnvinitArtifacts()` (DESIGN §12 «内联边界» / §13.6), so those checks are the base's own,
 * not a re-implementation — plus three local ones the base cannot make for us:
 *
 *   - `lib/index.js` must no longer name the vendored bootstrap as an import (a leftover relative
 *     specifier means `tsdown` did not consume it: the runtime would then look for a file that the
 *     published tarball's node half does not carry);
 *   - `lib/index.js` must CONTAIN an inlining marker derived from the **vendored** bootstrap — its
 *     `supportedRange` literal — which is what proves the copy actually made it into the bundle
 *     rather than being tree-shaken away. Deriving the marker means a base release that changes what
 *     the bootstrap carries (0.1.1 dropped every control-plane literal) needs only the vendored copy
 *     re-taken, not this script edited.
 *   - NEITHER half may carry the base KIT's implementation. The kit (prompt files, logger, family
 *     paths, wire codec helpers) is consumed at RUNTIME off the base module, so "fix a shared helper"
 *     takes one base release and no plugin rebuild; inlining it would silently break that promise, and
 *     a bundle does not otherwise show it. The check keys off a unique literal from the kit's
 *     prompt-file writer.
 *
 *   node scripts/assert-envinit-artifacts.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const artifacts = ['lib/index.js', 'lib/client.js']
const FRAMEWORK = '@avantf/dsh-plugin-base'
/** A unique string in the base kit's `PromptFiles` writer — its presence means the kit was inlined. */
const KIT_MARKER = 'prompt file was blank and has been filled'

const missing = artifacts.filter((rel) => !existsSync(join(pluginDir, rel)))
if (missing.length > 0) {
  console.error(`assert-envinit-artifacts: missing ${missing.join(', ')} — build the plugin first`)
  process.exit(1)
}

const presetPath = join(pluginDir, 'node_modules', FRAMEWORK, 'dist', 'preset.js')
if (!existsSync(presetPath)) {
  console.error(`assert-envinit-artifacts: ${FRAMEWORK} is not installed at ${dirname(presetPath)}`)
  console.error('  fix: pnpm install && pnpm --filter @avantf/dsh-plugin-base run build')
  process.exit(1)
}
const { assertEnvinitArtifacts, assertEnvinitPresetChecks } = await import(pathToFileURL(presetPath).href)

const problems = []
const node = readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8')
const client = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')
if (/from\s*['"][^'"]*envinit-bootstrap\.js['"]/.test(node) || /import\s*\(\s*['"][^'"]*envinit-bootstrap\.js['"]/.test(node)) {
  problems.push('lib/index.js still imports the vendored bootstrap by relative path — it was not inlined')
}
// The base is reached through the inlined bootstrap only: ANY surviving specifier import (static or
// dynamic) would throw during module evaluation, exactly when the base is missing — the broken-tree
// case the bootstrap exists for.
const specifier = FRAMEWORK.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const importsFramework = new RegExp(`(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)['"]${specifier}(?:['"/])`)
for (const [label, code] of [['lib/index.js', node], ['lib/client.js', client]]) {
  if (importsFramework.test(code)) {
    problems.push(`${label} imports "${FRAMEWORK}" by specifier — the base is loaded through the inlined bootstrap, never imported`)
  }
  if (code.includes(KIT_MARKER)) {
    problems.push(`${label} carries the base kit's implementation ("${KIT_MARKER}") — shared helpers must be consumed from the base at runtime, never inlined`)
  }
}
const vendoredPath = join(pluginDir, 'src', 'envinit-bootstrap.js')
const vendored = existsSync(vendoredPath) ? readFileSync(vendoredPath, 'utf8') : undefined
const marker = vendored === undefined ? undefined : /supportedRange\s*=\s*['"]([^'"]+)['"]/.exec(vendored)?.[1]
if (vendored === undefined) {
  problems.push(`${vendoredPath} is missing — run scripts/link-envinit.mjs`)
} else if (marker === undefined) {
  problems.push(`${vendoredPath} has no supportedRange literal to look for in the bundle`)
} else if (!node.includes(marker)) {
  problems.push(`lib/index.js does not contain the inlined bootstrap (no supportedRange ${marker} literal)`)
}
if (!node.includes(FRAMEWORK)) {
  problems.push(`lib/index.js never names ${FRAMEWORK} — the loader cannot be reporting which package it needs`)
}

try {
  assertEnvinitPresetChecks(assertEnvinitArtifacts({
    artifacts: [join(pluginDir, 'lib', 'index.js')],
    clientArtifacts: [join(pluginDir, 'lib', 'client.js')],
  }))
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error))
}

for (const problem of problems) console.error(`  FAIL ${problem}`)
if (problems.length > 0) {
  console.error('assert-envinit-artifacts: FAILED')
  process.exit(1)
}
console.log(`assert-envinit-artifacts: ok — bootstrap inlined into lib/index.js, ${FRAMEWORK} external, no kit copy, lib/client.js clean`)
