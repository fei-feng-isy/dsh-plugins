#!/usr/bin/env node
/**
 * Self-tests for `scripts/check-dsh-lines.mjs`'s WINDOWS launch shape.
 *
 * On Windows `npm` is a `.cmd` shim and Node refuses to spawn one without a shell (CVE-2024-27980),
 * so the gate's three `npm` calls — `npm root -g` (finding the semver to judge with), `npm view` (the
 * published versions) and `npm config get registry` — all failed there. Naming the platform's file
 * (`npm.cmd`) is NOT a fix: measured on Windows node v25.2.1, the no-shell `.cmd` spawn is still
 * EINVAL, `{ shell: true }` works but emits DEP0190, and `cmd.exe /c npm.cmd …` works with no warning.
 * So the gate now runs through `scripts/lib/win-spawn.mjs` and this file pins that shape.
 *
 * `[win]` — the *shape* is asserted here; a real Windows box still has to confirm the launch end to
 * end (`pnpm -C base/plugin-base test`, `pnpm build:dsh`). The win32 branch is reachable from Linux
 * precisely because the choice is a function of an injected platform, not a constant read from the host.
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

import { npmInvocation, toolInvocation } from './lib/win-spawn.mjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('check-dsh-lines: npm launches as `cmd.exe /c npm.cmd` on win32 and as `npm` on POSIX', () => {
  // win32: `cmd.exe` with the real argv — NO shell, which is what avoids DEP0190's unescaped join.
  const win = npmInvocation('win32', ['root', '-g'])
  assert.equal(win.command, 'cmd.exe')
  assert.deepEqual(win.args, ['/c', 'npm.cmd', 'root', '-g'])
  assert.equal(win.shell, false)
  // POSIX: the tool's own name, args untouched, still no shell.
  for (const platform of ['linux', 'darwin']) {
    const posix = npmInvocation(platform, ['root', '-g'])
    assert.equal(posix.command, 'npm')
    assert.deepEqual(posix.args, ['root', '-g'])
    assert.equal(posix.shell, false)
  }
  // Any other `.cmd`-shimmed tool takes the same route (`pnpm` is the other one this repo spawns)…
  assert.deepEqual(toolInvocation('win32', 'pnpm', ['run', 'build']), {
    command: 'cmd.exe', args: ['/c', 'pnpm.cmd', 'run', 'build'], shell: false,
  })
  assert.deepEqual(toolInvocation('linux', 'pnpm', ['run', 'build']), {
    command: 'pnpm', args: ['run', 'build'], shell: false,
  })
  // …and a path is never rewritten: `node.exe` / an absolute `.cmd` shim must survive intact.
  assert.deepEqual(toolInvocation('win32', 'C:\\nodejs\\node.exe', ['x.mjs']), {
    command: 'C:\\nodejs\\node.exe', args: ['x.mjs'], shell: false,
  })
  assert.deepEqual(toolInvocation('win32', 'C:\\p\\node_modules\\.bin\\tsc.cmd', ['-p', '.']), {
    command: 'cmd.exe', args: ['/c', 'C:\\p\\node_modules\\.bin\\tsc.cmd', '-p', '.'], shell: false,
  })
  // The default is the host's platform, so the executable itself is unchanged on non-Windows.
  assert.deepEqual(npmInvocation(), toolInvocation(process.platform, 'npm', []))
})

test('check-dsh-lines: importing the module runs no gate (only `main()` does)', async () => {
  // The import above already proves the launch helper is side-effect free; this asserts the same for
  // the gate itself — no `npm` call, no registry read and no `process.exit` at import time, which is
  // what lets the shape be tested without a network or a registry.
  const module = await import('./check-dsh-lines.mjs')
  assert.equal(typeof module, 'object')
  assert.equal(module.npmCommand, undefined, 'the local win32 copy is gone: the shape lives in lib/win-spawn.mjs')
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
