#!/usr/bin/env node
/**
 * The gate to run before publishing: typecheck, build, test, pack.
 *
 * Deliberately sequential and fail-fast: a release check that keeps going after a failure reports
 * a pile of symptoms instead of the first cause.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath
const bin = name => join(repo, 'node_modules', '.bin', name)

const steps = [
  ['link-dsh', node, [join(repo, 'scripts', 'link-dsh.mjs')]],
  ['typecheck', bin('tsc'), ['-p', 'tsconfig.test.json']],
  ['build', bin('tsc'), ['-p', 'tsconfig.json']],
  ['test', bin('vitest'), ['run']],
  ['pack', node, [join(repo, 'scripts', 'pack.mjs')]],
  // LAST on purpose: it relinks to the oldest dsh the family declares, re-runs the local steps
  // against it, and restores the machine (relink + rebuild) — so it must not run before `pack`.
  ['old-dsh gate (LOCAL: the declared dsh floor)', node, [join(repo, '..', '..', 'scripts', 'check-old-dsh.mjs'), 'base']],
]

for (const [label, command, args] of steps) {
  console.log(`\n▶ ${label}`)
  const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit', env: process.env })
  if (result.error) {
    console.error(`release-check: cannot run ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`release-check: FAILED at ${label}`)
    process.exit(result.status ?? 1)
  }
}
console.log('\nrelease-check ok')
