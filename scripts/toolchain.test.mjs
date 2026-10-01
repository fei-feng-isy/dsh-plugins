#!/usr/bin/env node
/**
 * Self-tests for the three toolchain fixes of W2-E, all on CONSTRUCTED input (no build, no registry,
 * no workspace mutation):
 *
 *   1. `check-old-dsh.mjs` — the throwaway closure is keyed by `(group, floor)`, so two groups gating
 *      the same floor in parallel own disjoint scratch roots and cannot delete each other's closure
 *      or fake global root; and the fake global root's LAYOUT is asked of `npm root -g` instead of
 *      being assumed to be the POSIX `lib/node_modules` (review §3 工具链).
 *   2. `mem/scripts/check-preset-drift.mjs` — a file missing on the VENDORED side returns the drift
 *      warning (naming the file) instead of throwing ENOENT through `link-dsh` / `mem release:check`.
 *   3. `scripts/boundary-guard.mjs` — the base is scanned, and a reverse import from the base into a
 *      plugin tree is a violation, while the base's own files are exempt from the "no value import of
 *      the base" rule (which is about plugins) and a plugin importing the base stays legal.
 *
 *   node scripts/toolchain.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { cacheRootFor, fakeDshDir, groupRoots, npmGlobalRoot } from './check-old-dsh.mjs'
import { judgeTrees } from './boundary-guard.mjs'
import { discoverGuardTrees, discoverPlugins } from './lib/plugins.mjs'
import { PRESET_FILES, presetDriftWarning } from '../mem/scripts/check-preset-drift.mjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function makeTemp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ── 1 · check-old-dsh: per-group scratch roots + npm-reported global root layout ───────────────────

test('check-old-dsh: the cache key carries the GROUP, not only the floor', () => {
  const floor = '0.9.9-rc.1'
  const base = cacheRootFor(floor, 'base')
  const mem = cacheRootFor(floor, 'mem')
  assert.notEqual(base, mem, 'two groups on the SAME floor must not share one cache root')
  assert.ok(base.startsWith(tmpdir()))
  assert.ok(base.includes('base') && base.includes(floor))
  assert.ok(mem.includes('mem') && mem.includes(floor))

  // The old shape was `avantf-old-dsh-<floor>` for every group — that one string is the collision.
  const shared = join(tmpdir(), `avantf-old-dsh-${floor}`)
  assert.notEqual(base, shared)
  assert.notEqual(mem, shared)

  const roots = groupRoots(floor, 'base')
  assert.equal(roots.setDir, join(base, 'set'))
  assert.equal(roots.rootDir, join(base, 'root'))
  assert.equal(roots.marker, join(base, 'set', '.floor'))
})

test('check-old-dsh: a run of one group deletes only its own scratch roots', () => {
  const floor = '0.9.9-rc.2'
  const base = groupRoots(floor, 'base')
  const mem = groupRoots(floor, 'mem')
  const sentinel = (roots, label) => {
    mkdirSync(roots.setDir, { recursive: true })
    mkdirSync(roots.rootDir, { recursive: true })
    writeFileSync(join(roots.setDir, 'closure.txt'), label)
    writeFileSync(join(roots.rootDir, 'prefix.txt'), label)
  }
  try {
    sentinel(base, 'base')
    sentinel(mem, 'mem')

    // Exactly the two deletions a `base` run performs: `installClosure()` wipes its set dir before
    // installing, and the fake global root is rebuilt under its own root dir on every run.
    rmSync(base.setDir, { recursive: true, force: true })
    rmSync(base.rootDir, { recursive: true, force: true })

    assert.equal(existsSync(join(base.setDir, 'closure.txt')), false)
    assert.equal(existsSync(join(base.rootDir, 'prefix.txt')), false)
    // ...and the parallel group's closure + live symlink farm are untouched.
    assert.equal(existsSync(join(mem.setDir, 'closure.txt')), true, 'the other group lost its closure')
    assert.equal(existsSync(join(mem.rootDir, 'prefix.txt')), true, 'the other group lost its fake global root')
  } finally {
    rmSync(base.cache, { recursive: true, force: true })
    rmSync(mem.cache, { recursive: true, force: true })
  }
})

test('check-old-dsh: the fake global root is laid out where `npm root -g` says', () => {
  const prefix = makeTemp('old-dsh-prefix-')
  try {
    const reported = spawnSync(npm, ['root', '-g'], {
      encoding: 'utf8', env: { ...process.env, npm_config_prefix: prefix },
    })
    assert.equal(reported.status, 0, `\`${npm} root -g\` must answer: ${reported.stderr ?? ''}`)
    const expected = reported.stdout.trim()
    assert.notEqual(expected, '')

    // The script asks npm instead of assuming `<prefix>/lib/node_modules`; on win32 npm reports
    // `<prefix>/node_modules` and the assumption pointed the redirect at a directory nothing reads
    // (`[win]` 待 Windows 实机复核).
    assert.equal(npmGlobalRoot(prefix), expected)
    assert.equal(fakeDshDir(prefix), join(expected, '@deepseek-ai', 'dsh'))
    assert.ok(expected.startsWith(prefix), 'npm answers under the throwaway prefix')
  } finally {
    rmSync(prefix, { recursive: true, force: true })
  }
})

// ── 2 · check-preset-drift: a missing VENDORED file is a warning, never a throw ────────────────────

/** Write every preset file into both the vendored and the checkout fixture, byte-identical. */
function writePresetFixtures() {
  const vendor = makeTemp('preset-vendor-')
  const harness = makeTemp('preset-harness-')
  for (const { vendored, harness: checkoutPath } of PRESET_FILES) {
    const body = `// fixture for ${vendored}\n`
    for (const file of [join(vendor, vendored), join(harness, checkoutPath)]) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, body)
    }
  }
  return { vendor, harness }
}

test('check-preset-drift: all files equal → no warning', () => {
  const { vendor, harness } = writePresetFixtures()
  try {
    assert.equal(presetDriftWarning(harness, vendor), undefined)
  } finally {
    rmSync(vendor, { recursive: true, force: true })
    rmSync(harness, { recursive: true, force: true })
  }
})

test('check-preset-drift: a missing VENDORED file warns (and names it) instead of throwing', () => {
  const { vendor, harness } = writePresetFixtures()
  const victim = PRESET_FILES[2].vendored
  try {
    rmSync(join(vendor, victim))
    let warning
    assert.doesNotThrow(() => { warning = presetDriftWarning(harness, vendor) })
    assert.equal(typeof warning, 'string', 'a deleted vendored file must produce the warning, not a throw')
    assert.ok(warning.includes(victim), `the warning must name ${victim}: ${warning}`)
    assert.match(warning, /vendored file\(s\) missing from packages\/plugin\/vendor\/dsh-client-preset/u)
    // A missing vendored file is not reported as a CHECKOUT problem.
    assert.doesNotMatch(warning, /missing from the checkout/u)
  } finally {
    rmSync(vendor, { recursive: true, force: true })
    rmSync(harness, { recursive: true, force: true })
  }
})

test('check-preset-drift: a missing CHECKOUT file still warns, as before', () => {
  const { vendor, harness } = writePresetFixtures()
  const victim = PRESET_FILES[0].harness
  try {
    rmSync(join(harness, victim))
    const warning = presetDriftWarning(harness, vendor)
    assert.equal(typeof warning, 'string')
    assert.ok(warning.includes(victim))
    assert.match(warning, /missing from the checkout/u)
  } finally {
    rmSync(vendor, { recursive: true, force: true })
    rmSync(harness, { recursive: true, force: true })
  }
})

// ── 3 · boundary-guard: the base is scanned, and a reverse import fails ───────────────────────────

test('boundary-guard: discovery hands the base to the guard but never to the build dispatcher', () => {
  assert.ok(discoverPlugins().every((tree) => tree.id !== 'base'), 'the base is not a plugin tree')
  const trees = discoverGuardTrees()
  assert.equal(trees[0].id, 'base')
  assert.equal(trees[0].isBase, true)
  assert.deepEqual(trees.slice(1).map((tree) => tree.id), discoverPlugins().map((tree) => tree.id))
})

test('boundary-guard: a reverse import from the base is a violation (constructed trees)', () => {
  const root = makeTemp('boundary-')
  const write = (relative, body) => {
    const file = join(root, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
    return file
  }
  try {
    // base: a reverse import into a plugin tree (FORBIDDEN, and previously unscanned), an escape by
    // relative path (rule 2 applies), and a value import of the base by the base itself (NOT rule 3).
    const baseForeign = write('base/src/evil.ts', "import { y } from '@avantf/dsh-mem'\nexport const z = y\n")
    const baseEscape = write('base/src/escape.ts', "import { q } from '../../../elsewhere/thing.js'\nexport const e = q\n")
    const baseSelf = write('base/src/self.ts', "import { b } from '@avantf/dsh-plugin-base'\nexport const s = b\n")
    // plugins: taking the base by VALUE in a bundled file is still the rule 3 failure; `import type` is not.
    const memTypeOnly = write('mem/packages/plugin/src/type-only.ts', "import type { A } from '@avantf/dsh-plugin-base'\nexport type B = A\n")
    const memValue = write('mem/packages/plugin/src/value.ts', "import { A } from '@avantf/dsh-plugin-base'\nexport const b = A\n")

    const trees = [
      { id: 'base', tree: join(root, 'base'), packages: new Set(['@avantf/dsh-plugin-base']), files: [baseForeign, baseEscape, baseSelf], isBase: true },
      { id: 'mem', tree: join(root, 'mem'), packages: new Set(['@avantf/dsh-mem']), files: [memTypeOnly, memValue] },
    ]

    const problems = judgeTrees(trees, root)
    const joined = problems.join('\n')

    // The base → plugin import is reported...
    assert.match(joined, /base\/src\/evil\.ts → @avantf\/dsh-mem \(a package of mem\//u)
    // ...the relative escape is reported...
    assert.match(joined, /base\/src\/escape\.ts → \.\.\/\.\.\/\.\.\/elsewhere\/thing\.js/u)
    // ...the plugin's value import of the base is reported (rule 3 unchanged for plugins)...
    assert.match(joined, /mem\/packages\/plugin\/src\/value\.ts → @avantf\/dsh-plugin-base/u)
    // ...and the two legal shapes are NOT: the base's own file may import the base by value (rule 3 is
    // about plugins), and a plugin may always take the base (type-only or not, rule 1).
    assert.doesNotMatch(joined, /base\/src\/self\.ts/u)
    assert.doesNotMatch(joined, /mem\/packages\/plugin\/src\/type-only\.ts/u)
    assert.equal(problems.length, 3, `expected exactly 3 violations:\n${joined}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('boundary-guard: the real workspace is clean with the base included', () => {
  const result = spawnSync(process.execPath, [join(workspace, 'scripts', 'boundary-guard.mjs'), '--verbose'], {
    cwd: workspace, encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, output)
  assert.match(output, /scan {2}base:/u, 'the base must be scanned')
  assert.match(output, /boundary-guard ok/u)
})
