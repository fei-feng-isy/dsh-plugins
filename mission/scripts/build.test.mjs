#!/usr/bin/env node
/**
 * Self-tests for `mission/scripts/build.mjs`'s WINDOWS launch fix.
 *
 * The build spawned `node_modules/.bin/tsc` and `.bin/esbuild` directly. On Windows those names are
 * the sh shims and the runnable launchers are `tsc.cmd` / `tsc.ps1`; spawning a `.cmd` without a
 * shell throws EINVAL on Node ≥ 18.20.2 / 20.12.2 / 21.7.2 (the CVE-2024-27980 fix), so `pnpm -C
 * mission build` / `typecheck` could not start the compiler there at all. `binLaunch` names the
 * platform's file — `<name>.cmd` on win32 — AND asks for the shell, which is the only combination
 * Windows accepts.
 *
 * `[win]` — this asserts the SHAPE (and the argument quoting that `shell: true` now requires); a
 * real Windows box still has to confirm `tsc.cmd` / `esbuild.cmd` actually run. The win32 branch is
 * reachable from Linux because the platform is injected, not read from the host.
 *
 *   node mission/scripts/build.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { binLaunch, quoteForCmd } from './build.mjs'

const script = fileURLToPath(import.meta.url)
const buildScript = resolve(dirname(script), 'build.mjs')
const fakeDir = '/tmp/mission-build-fixture'

test('build: POSIX launches the .bin shim directly, with no shell', () => {
  const args = ['-p', join(fakeDir, 'tsconfig.json'), '--noEmit']
  for (const platform of ['linux', 'darwin']) {
    const launch = binLaunch(fakeDir, 'tsc', args, platform)
    assert.equal(launch.command, join(fakeDir, 'node_modules', '.bin', 'tsc'))
    assert.deepEqual(launch.args, args)
    assert.deepEqual(launch.options, {}, `${platform} must not go through a shell`)
  }
})

test('build: win32 launches <name>.cmd through a shell (the EINVAL fix)', () => {
  const launch = binLaunch(fakeDir, 'tsc', ['-p', 'tsconfig.json'], 'win32')
  assert.equal(launch.command, join(fakeDir, 'node_modules', '.bin', 'tsc.cmd'))
  assert.equal(launch.options.shell, true, 'a .cmd cannot be spawned without a shell')
  assert.deepEqual(launch.args, ['-p', 'tsconfig.json'])

  // Same rule for the bundler, which hard-codes the name.
  const esbuild = binLaunch(fakeDir, 'esbuild', ['--bundle', 'lib/index.js'], 'win32')
  assert.equal(esbuild.command, join(fakeDir, 'node_modules', '.bin', 'esbuild.cmd'))
  assert.equal(esbuild.options.shell, true)

  // The command itself is quoted when its path would split the cmd.exe line.
  const spaced = binLaunch('C:\\Users\\Foo Bar', 'tsc', ['-p', 'tsconfig.json'], 'win32')
  assert.match(spaced.command, /^".*tsc\.cmd"$/u)
  assert.equal(binLaunch('C:\\Users\\Foo Bar', 'tsc', ['-p', 'tsconfig.json'], 'linux').command,
    join('C:\\Users\\Foo Bar', 'node_modules', '.bin', 'tsc'))
})

test('build: win32 quotes arguments before handing them to cmd.exe', () => {
  // `shell: true` joins the line itself, so a workspace under a path with a space would split.
  const launch = binLaunch(fakeDir, 'tsc', ['-p', 'C:\\Users\\Foo Bar\\tsconfig.json'], 'win32')
  assert.deepEqual(launch.args, ['-p', '"C:\\Users\\Foo Bar\\tsconfig.json"'])
  // A POSIX run has no shell, so the same argument is passed through untouched.
  const posix = binLaunch(fakeDir, 'tsc', ['-p', 'C:\\Users\\Foo Bar\\tsconfig.json'], 'linux')
  assert.deepEqual(posix.args, ['-p', 'C:\\Users\\Foo Bar\\tsconfig.json'])
})

test('build: quoteForCmd leaves simple args alone and neutralises cmd metacharacters', () => {
  assert.equal(quoteForCmd('-p'), '-p')
  assert.equal(quoteForCmd('tsconfig.json'), 'tsconfig.json')
  assert.equal(quoteForCmd('C:\\a b\\tsconfig.json'), '"C:\\a b\\tsconfig.json"')
  assert.equal(quoteForCmd('a&b'), '"a&b"')
  assert.equal(quoteForCmd('a|b'), '"a|b"')
  assert.equal(quoteForCmd('a"b'), '"a""b"')
})

test('build: importing the module runs no build (only the CLI entry does)', () => {
  const probe = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `await import(${JSON.stringify(pathToFileURL(buildScript).href)}); console.log('IMPORTED-NO-BUILD')`,
  ], { encoding: 'utf8' })
  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`
  assert.equal(probe.status, 0, output)
  assert.match(probe.stdout, /IMPORTED-NO-BUILD/u)
  // A build would have printed `▶ build …` / `build: ok`; an import must print neither.
  assert.doesNotMatch(output, /build: ok/u)
  assert.doesNotMatch(output, /▶ /u)
})
