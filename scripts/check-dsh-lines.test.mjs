#!/usr/bin/env node
/**
 * Self-tests for `scripts/check-dsh-lines.mjs`'s WINDOWS launch fix.
 *
 * On Windows `npm` is a `.cmd` shim and Node refuses to spawn one without a shell (CVE-2024-27980),
 * so the gate's three `execFileSync('npm', …)` calls — `npm root -g` (finding the semver to judge
 * with), `npm view` (the published versions) and `npm config get registry` — all failed with EINVAL
 * there, and the whole gate died before it judged anything. The fix names the platform's file
 * (`npm.cmd` on win32) instead of reaching for a shell.
 *
 * `[win]` — the *shape* is asserted here; a real Windows box still has to confirm that `npm.cmd`
 * launches. The win32 branch is reachable from Linux precisely because the choice is a function of
 * an injected platform, not a constant read from the host.
 *
 *   node scripts/check-dsh-lines.test.mjs
 *
 * No network: the end-to-end case uses `--fixture`, and the one external fact is `npm root -g`
 * (which the fixture path exercises just as the registry path does).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { npmCommand } from './check-dsh-lines.mjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('check-dsh-lines: win32 runs `npm.cmd`; POSIX runs `npm`', () => {
  assert.equal(npmCommand('win32'), 'npm.cmd')
  assert.equal(npmCommand('linux'), 'npm')
  assert.equal(npmCommand('darwin'), 'npm')
  // The default is the host's platform, so the executable itself is unchanged on non-Windows.
  assert.equal(npmCommand(), process.platform === 'win32' ? 'npm.cmd' : 'npm')
})

test('check-dsh-lines: importing the module runs no gate (only `main()` does)', () => {
  // The import above already proves it: the module performs no `npm` call, no registry read and no
  // `process.exit` at import time, which is what lets one test the platform choice at all.
  assert.equal(typeof npmCommand, 'function')
})

test('check-dsh-lines: the wrapped executable still judges a fixture end to end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lines-self-'))
  const file = join(dir, 'in-step.json')
  writeFileSync(file, JSON.stringify({
    declared: {
      '@avantf/dsh-mem': ['^0.2.0-rc.2', '^0.3.0-rc.1'],
      '@avantf/dsh-mission': ['^0.2.0-rc.2', '^0.3.0-rc.1'],
    },
    versions: ['0.2.0-rc.2', '0.3.0-rc.1'],
    tags: { latest: '0.3.0-rc.1' },
  }, null, 2))
  try {
    const result = spawnSync(
      process.execPath,
      [join(workspace, 'scripts', 'check-dsh-lines.mjs'), '--fixture', file],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`)
    assert.match(result.stdout, /check-dsh-lines: ok/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
