#!/usr/bin/env node
/**
 * Drift guard for the VENDORED DSH client tsdown preset.
 *
 * `pnpm build:dsh` / `pnpm release:check` compile through the pinned copy under
 * `packages/plugin/vendor/dsh-client-preset/` so they need no harness source checkout at all. That
 * copy is only trustworthy while it is byte-identical to its origin: the preset defines the browser
 * half's ABI (module-loader factory shape, platform module table, build-environment defines, CSS
 * pipeline), and the browser half has NO automated coverage — the mount smoke only exercises the
 * host half. A silent divergence can therefore ship a client bundle that fails to load at runtime.
 *
 * This script compares all 8 vendored files against the checkout, when one is discoverable:
 *
 *   harness present, all equal     → OK, exit 0 (prints the checkout revision)
 *   harness present, some differ   → WARNING naming every drifted file + both revisions, exit 1
 *   no harness discoverable        → note that there is nothing to compare, exit 0 (the machine
 *                                    where only the installed dsh exists — the guard never invents
 *                                    a failure)
 *
 * A file missing on EITHER side (a pruned checkout, or a deleted vendored file) is also "nothing to
 * compare": it is named in the warning, never thrown — the vendored side used to be read without an
 * existence check, so one removed file crashed `link-dsh` and `mem release:check` on the stack.
 *
 * It is an OPTIONAL cross-check, never a build input: nothing here is needed to compile.
 * `node scripts/check-preset-drift.mjs` runs it standalone. `link-dsh.mjs` and `release-check.mjs`
 * also call `presetDriftWarning()` and print its one-line warning through their existing
 * note/WARNING channels — a drift is a loud note there, not a gate failure, because a checkout
 * moving ahead of the pin is expected between re-alignments.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findHarness } from '../../scripts/lib/harness-path.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Root of the pinned mirror of the harness repository layout. */
const VENDOR_ROOT = join(repo, 'packages', 'plugin', 'vendor', 'dsh-client-preset')

/** Vendored path → harness path. This is the whole relative-import closure of the preset entry. */
export const PRESET_FILES = [
  { vendored: 'packages/client/tsdown.client.ts', harness: 'packages/client/tsdown.client.ts' },
  { vendored: 'packages/client/modules/src/client/manifest.ts', harness: 'packages/client/modules/src/client/manifest.ts' },
  { vendored: 'packages/client/modules/src/client/system.ts', harness: 'packages/client/modules/src/client/system.ts' },
  { vendored: 'packages/client/modules/src/client/entries.ts', harness: 'packages/client/modules/src/client/entries.ts' },
  { vendored: 'packages/client/modules/src/client/entry-lifecycle.ts', harness: 'packages/client/modules/src/client/entry-lifecycle.ts' },
  { vendored: 'packages/client/web/src/platform.ts', harness: 'packages/client/web/src/platform.ts' },
  { vendored: 'scripts/client-build-environment.ts', harness: 'scripts/client-build-environment.ts' },
  { vendored: 'scripts/bundle-input-isolation.ts', harness: 'scripts/bundle-input-isolation.ts' },
]

/** Revision this copy was taken from, read from ORIGIN.md so the two cannot disagree. */
function pinnedRevision(vendorRoot = VENDOR_ROOT) {
  try {
    return /\|\s*revision\s*\|\s*`([0-9a-f]{7,40})`/.exec(readFileSync(join(vendorRoot, 'ORIGIN.md'), 'utf8'))?.[1]
  } catch {
    return undefined
  }
}

/** HEAD of the checkout, or `undefined` when it is not a Git worktree. */
function checkoutRevision(harnessDir) {
  try {
    return execFileSync('git', ['-C', harnessDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/**
 * One-line drift warning, or `undefined` when every vendored file matches the checkout (or the
 * comparison cannot run because a file/checkout is missing).
 *
 * BOTH sides are existence-checked BEFORE either is read. A missing file on the vendored side used
 * to fall straight into `readFileSync` and throw ENOENT through every caller (`link-dsh.mjs` and
 * `mem release:check`) — the opposite of what this function's contract, and its header, promise: a
 * file that is missing on either side means "there is nothing to compare", which is reported as
 * `missing` in the returned warning, never as a stack trace (review §3 工具链).
 *
 * @param harnessDir - harness checkout root to compare against.
 * @param vendorRoot - vendored preset root; a seam so the missing-file branch can be exercised on a
 *   constructed tree (the default is the one real pin).
 */
export function presetDriftWarning(harnessDir, vendorRoot = VENDOR_ROOT) {
  const drifted = []
  const missing = []
  for (const { vendored, harness } of PRESET_FILES) {
    const local = join(vendorRoot, vendored)
    const origin = join(harnessDir, harness)
    if (!existsSync(local)) { missing.push({ side: 'vendored', path: vendored }); continue }
    if (!existsSync(origin)) { missing.push({ side: 'checkout', path: harness }); continue }
    if (!readFileSync(local).equals(readFileSync(origin))) drifted.push(vendored)
  }
  if (drifted.length === 0 && missing.length === 0) return undefined
  const pinned = pinnedRevision(vendorRoot) ?? '(unknown)'
  const current = checkoutRevision(harnessDir) ?? '(not a git checkout)'
  const absentFrom = (side) => missing.filter((entry) => entry.side === side).map((entry) => entry.path)
  const absentFromCheckout = absentFrom('checkout')
  const absentFromVendored = absentFrom('vendored')
  const detail = [
    drifted.length > 0 ? `${String(drifted.length)} of ${String(PRESET_FILES.length)} file(s) differ: ${drifted.join(', ')}` : undefined,
    absentFromCheckout.length > 0 ? `${String(absentFromCheckout.length)} file(s) missing from the checkout: ${absentFromCheckout.join(', ')}` : undefined,
    absentFromVendored.length > 0 ? `${String(absentFromVendored.length)} vendored file(s) missing from packages/plugin/vendor/dsh-client-preset: ${absentFromVendored.join(', ')}` : undefined,
  ].filter(Boolean).join('; ')
  return `the vendored client preset has drifted from the harness checkout — ${detail}.`
    + ` Vendored pins ${pinned}; checkout is ${current}.`
    + ' Re-align per packages/plugin/vendor/dsh-client-preset/ORIGIN.md and re-run the byte-equivalence proof'
    + ' (harness preset build vs vendored preset build must give the same lib/index.js + lib/client.js sha256).'
}

/** Standalone entry: report, and exit non-zero only on an actual drift. */
function main() {
  const harnessDir = findHarness()
  if (harnessDir === undefined) {
    console.log('check-preset-drift: no harness checkout discoverable — nothing to compare (only the installed dsh is present)')
    return 0
  }
  const warning = presetDriftWarning(harnessDir)
  if (warning === undefined) {
    console.log(`check-preset-drift: OK — ${String(PRESET_FILES.length)}/${String(PRESET_FILES.length)} vendored preset files are byte-identical to ${harnessDir}@${checkoutRevision(harnessDir) ?? '(unknown)'}`)
    return 0
  }
  console.error(`check-preset-drift: WARNING: ${warning}`)
  return 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
