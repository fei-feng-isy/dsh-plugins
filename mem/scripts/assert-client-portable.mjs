#!/usr/bin/env node
/**
 * Post-build gate: the on-disk `lib/client.js` is PORTABLE across build
 * directories, and still shaped like a DSH client bundle.
 *
 * The same rule runs inside the bundler (`packages/plugin/tsdown.config.ts`
 * asserts the emitted chunk) and here; both call the one implementation in
 * `scripts/client-portable.mjs`, so there is a single definition of what
 * "portable" means:
 *
 *   - the artifact must not contain this checkout's absolute root (the leak the
 *     projection makes visible: dev checkout vs. the projected release checkout);
 *   - every CSS virtual module id must be RELATIVE, not absolute — that is the
 *     mechanism that keeps lightningcss's `[hash]_[local]` class hashes, and
 *     Rolldown's verbatim `//#region` marker, independent of the checkout path;
 *   - the `window.__ModuleLoader__.load(...)` handoff, the plugin-owned style
 *     injection, the `data-plugin-css` dedup key and the CSS Modules class map
 *     must all still be there, and every class-map value must appear in the CSS
 *     text injected next to it.
 *
 * It is deliberately general: it scans for the roots derived from this script's
 * own location and for the class map the style injector itself emits — no file
 * name, no hash value and no build directory is hardcoded.
 *
 * Byte-for-byte CROSS-DIRECTORY reproduction cannot be proven by one build, so
 * it stays a pre-release manual step:
 *
 *   cp -a <repo> /tmp/dsh-repro-a && cp -a <repo> /tmp/dsh-repro-b
 *   pnpm -C /tmp/dsh-repro-a/mem build:dsh && pnpm -C /tmp/dsh-repro-b/mem build:dsh
 *   sha256sum /tmp/dsh-repro-{a,b}/mem/packages/plugin/lib/client.js   # identical
 *
 *   node scripts/assert-client-portable.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientArtifactProblems } from './client-portable.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = join(repo, 'packages', 'plugin', 'lib', 'client.js')

if (!existsSync(artifact)) {
  console.error(`assert-client-portable: ${artifact} is missing — build the plugin first`)
  process.exit(1)
}

// Both roots are derived, never spelled out: the mem tree and the workspace root
// above it. A build at any other absolute directory would leak ITS root instead,
// which is exactly what the cross-directory reproduction step checks.
const roots = [repo, resolve(repo, '..')]
const problems = clientArtifactProblems(readFileSync(artifact, 'utf8'), roots)

for (const problem of problems) console.error(`  FAIL ${problem}`)
if (problems.length > 0) {
  console.error('assert-client-portable: FAILED')
  process.exit(1)
}
console.log(`assert-client-portable: ok — lib/client.js is path-independent (no build root, relative CSS ids, class map ↔ injected CSS)`)
