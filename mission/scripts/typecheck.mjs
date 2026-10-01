#!/usr/bin/env node
/**
 * Type-check both packages in dependency order, as a thin wrapper over `build.mjs --typecheck` so the
 * two commands cannot drift. The check resolves against the INSTALLED dsh's declarations — what the live
 * profile runs — so it needs no harness checkout and cannot accept something the host would reject; the
 * peer links are left on the installed dsh, since a checkout linked there would hand the running host a
 * second cordis / zod.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function linkPeers() {
  const result = spawnSync(
    process.execPath,
    // `--no-bake`: this run emits nothing, so it must not rewrite the gate's "compiled against" record.
    [join(repo, 'scripts', 'link-dsh.mjs'), '--runtime', '--no-bake'],
    { cwd: repo, stdio: 'inherit', env: process.env },
  )
  return result.status === 0
}

if (!linkPeers()) {
  console.error('typecheck: could not link the installed dsh (`node scripts/link-dsh.mjs --runtime`)')
  process.exit(1)
}
// The framework peer must exist for `tsc` to resolve its types; check first (that mode catches a pruned
// link or a drifted bootstrap) and relink only when it fails, so `--check` stays a reachable path.
const envinitCheck = spawnSync(process.execPath, [join(repo, 'scripts', 'link-envinit.mjs'), '--check'], {
  cwd: repo,
  stdio: 'inherit',
  env: process.env,
})
if (envinitCheck.status !== 0) {
  const envinit = spawnSync(process.execPath, [join(repo, 'scripts', 'link-envinit.mjs')], {
    cwd: repo,
    stdio: 'inherit',
    env: process.env,
  })
  if (envinit.status !== 0) {
    console.error('typecheck: could not link @avantf/dsh-plugin-base (`node scripts/link-envinit.mjs`)')
    process.exit(1)
  }
}
const result = spawnSync(process.execPath, [join(repo, 'scripts', 'build.mjs'), '--typecheck'], {
  cwd: repo,
  stdio: 'inherit',
  env: process.env,
})
process.exit(result.status ?? 1)
