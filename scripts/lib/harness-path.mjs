#!/usr/bin/env node
/**
 * Locate the two DSH installations the merged workspace may care about — ONE copy for `base/`, `mem/`
 * and `work/` (it used to live twice, in `avantf-mem/scripts/harness-path.mjs` and
 * `avantf-work/scripts/harness-path.mjs`).
 *
 * **The installed dsh is what everything is built against.** Every plugin resolves its
 * `@deepseek-ai/*` peers from the global dsh (`npm root -g`), so `link-dsh.mjs` / `mount-smoke.mjs` /
 * `build:dsh` need nothing else. The client preset is the verbatim copy pinned under
 * `mem/packages/plugin/vendor/dsh-client-preset/`.
 *
 * **A harness source checkout is OPTIONAL and never used to compile.** It is consulted by exactly one
 * thing: the preset-drift cross-check, and by `mount-smoke.mjs` when it is asked to run without
 * `--runtime`. Discovery is relative to the MERGED repository root (candidates 2–4 used to be relative
 * to each plugin's own repo root; in one workspace the shared root is the only anchor that resolves).
 *
 *   1. `DSHHARNESS` (explicit override; a wrong value means "no checkout", not a fallback)
 *   2. `<repo>/../harness/deepseek-harness`
 *   3. `<repo>/../deepseek-harness`
 *   4. `<repo>/../../harness/deepseek-harness`
 *   5. `$HOME/sources/harness/deepseek-harness`
 *   6. `$HOME/opensource/harness/deepseek-harness`
 *
 * A candidate only counts when it looks like a harness checkout, so a stray directory cannot be
 * mistaken for one.
 */
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The merged repository root — this file lives in `<repo>/scripts/lib/`. */
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Vendored peers + the core package a harness checkout is recognised by. */
function isHarness(dir) {
  return existsSync(join(dir, 'vendor', 'cordis'))
    && existsSync(join(dir, 'vendor', 'schemastery'))
    && existsSync(join(dir, 'packages', 'core', 'tools'))
}

/** Candidate checkout roots, in precedence order, anchored at `repoRoot`. */
export function harnessCandidates(repoRoot = repo) {
  const home = homedir()
  return [
    resolve(repoRoot, '..', 'harness', 'deepseek-harness'),
    resolve(repoRoot, '..', 'deepseek-harness'),
    resolve(repoRoot, '..', '..', 'harness', 'deepseek-harness'),
    join(home, 'sources', 'harness', 'deepseek-harness'),
    join(home, 'opensource', 'harness', 'deepseek-harness'),
  ]
}

/**
 * The harness checkout root, or `undefined` when none is discoverable. Nothing that compiles may rely
 * on it, and a missing checkout is never an error (only the optional cross-checks want to know).
 */
export function findHarness(repoRoot = repo) {
  const env = process.env['DSHHARNESS']
  if (env) {
    const dir = resolve(env)
    return isHarness(dir) ? dir : undefined
  }
  return harnessCandidates(repoRoot).find(isHarness)
}

/** The installed dsh package directory (`npm root -g`/`@deepseek-ai/dsh`), or `undefined`. */
export function installedDshDir() {
  try {
    return join(execSync('npm root -g', { encoding: 'utf8' }).trim(), '@deepseek-ai', 'dsh')
  } catch {
    return undefined
  }
}

/** Return the harness checkout root, or exit(1) with an actionable message; `label` prefixes the diagnostic. */
export function resolveHarness(repoRoot = repo, label = 'build') {
  const env = process.env['DSHHARNESS']
  if (env) {
    const dir = resolve(env)
    if (isHarness(dir)) return dir
    console.error(`${label}: DSHHARNESS=${env} is not a deepseek-harness checkout`)
    console.error(`  (looked for ${join(dir, 'vendor', 'cordis')} and ${join(dir, 'packages', 'core', 'tools')})`)
    process.exit(1)
  }
  const tried = harnessCandidates(repoRoot)
  for (const dir of tried) if (isHarness(dir)) return dir
  console.error(`${label}: cannot find the deepseek-harness source checkout`)
  console.error('  tried:')
  for (const dir of tried) console.error(`    ${dir}`)
  console.error('  point at yours explicitly: DSHHARNESS=<path to deepseek-harness> node scripts/mount-smoke.mjs')
  process.exit(1)
}
