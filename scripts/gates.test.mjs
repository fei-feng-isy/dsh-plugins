#!/usr/bin/env node
/**
 * Self-tests for the PURE logic the root gates are built from.
 *
 * The root `scripts/` have no test runner of their own, and two of these assertions are exactly the
 * kind that must be proven on constructed input: "does the version materializer touch a second
 * group's manifests?" and "does one tree missing a dsh line fail the gate?". So the decisions live in
 * `scripts/lib/` (versions.mjs, gates.mjs) and this file replays them — M7 (group-scoped version
 * materialization), §2.2-2 (the base peer↔dev pair), M8 (per-tree dsh-line coverage), and M10 (the
 * plugin prepublishOnly wiring).
 *
 *   node scripts/gates.test.mjs
 *
 * No workspace build, no registry: the only external facts are `git` (the version state is read from
 * tracked manifests) and a semver implementation (the installed dsh's own copy, so the dsh-line
 * judgement is replayed against the same semver the boot gate uses).
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { baseDependencyProblems, judgeDshLines } from './lib/gates.mjs'
import { execToolSync } from './lib/win-spawn.mjs'
import { groupWorkspaceTargets, workspaceTargets, withWorkspaceVersions } from './lib/versions.mjs'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = '@avantf/dsh-plugin-base'

// ── M7 · the version materializer writes ONLY the declared group's manifests ─────────────────────

/**
 * A minimal two-group workspace with one private workspace-protocol target per group, as a real git
 * repository: `groupManifests` reads the TRACKED manifests, so the fixture has to be committed to the
 * index or nothing would be found.
 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-versions-'))
  const write = (relative, manifest) => {
    const file = join(root, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  write('base/plugin-base/package.json', { name: BASE, version: '3.0.0' })
  write('mem/package.json', { name: 'mem-workspace', private: true })
  write('mem/packages/plugin/package.json', {
    name: '@avantf/dsh-mem',
    version: '1.2.3',
    peerDependencies: { [BASE]: '>=3.0.0 <4.0.0' },
    devDependencies: { [BASE]: '>=3.0.0 <4.0.0', '@avantf/mem-core': 'workspace:*' },
  })
  write('mem/packages/core/package.json', { name: '@avantf/mem-core', private: true })
  write('mission/package.json', { name: 'mission-workspace', private: true })
  write('mission/packages/plugin/package.json', {
    name: '@avantf/dsh-mission',
    version: '2.0.0',
    peerDependencies: { [BASE]: '>=3.0.0 <4.0.0' },
    devDependencies: { [BASE]: '>=3.0.0 <4.0.0', '@avantf/mission-core': 'workspace:*' },
  })
  write('mission/packages/core/package.json', { name: '@avantf/mission-core', private: true })
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

function withWorkspace(run) {
  const root = makeWorkspace()
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('M7: { group } materializes only that group, and restores the files byte for byte', () => {
  withWorkspace((root) => {
    // The all-group scan (kept only for reporting) really does reach both trees — the defect.
    assert.deepEqual(
      workspaceTargets(root).targets.map((target) => target.file),
      ['mem/packages/core/package.json', 'mission/packages/core/package.json'],
    )
    assert.deepEqual(
      groupWorkspaceTargets(root, 'mem').targets.map((target) => target.file),
      ['mem/packages/core/package.json'],
    )
    assert.deepEqual(groupWorkspaceTargets(root, 'mem').problems, [])

    const memCore = join(root, 'mem/packages/core/package.json')
    const missionCore = join(root, 'mission/packages/core/package.json')
    const memBefore = readFileSync(memCore, 'utf8')
    const missionBefore = readFileSync(missionCore, 'utf8')

    let ran = false
    withWorkspaceVersions(root, '9.9.9', () => {
      ran = true
      assert.equal(JSON.parse(readFileSync(memCore, 'utf8')).version, '9.9.9')
      assert.equal(JSON.parse(readFileSync(missionCore, 'utf8')).version, undefined)
    }, { group: 'mem' })
    assert.equal(ran, true)
    // Restored byte for byte on the way out — including the other tree, which was never touched.
    assert.equal(readFileSync(memCore, 'utf8'), memBefore)
    assert.equal(readFileSync(missionCore, 'utf8'), missionBefore)
  })
})

test('M7: an explicit { targets } result is honoured and stays inside its group', () => {
  withWorkspace((root) => {
    const memCore = join(root, 'mem/packages/core/package.json')
    const missionCore = join(root, 'mission/packages/core/package.json')
    const memBefore = readFileSync(memCore, 'utf8')
    withWorkspaceVersions(root, '8.8.8', () => {
      assert.equal(JSON.parse(readFileSync(missionCore, 'utf8')).version, '8.8.8')
      assert.equal(JSON.parse(readFileSync(memCore, 'utf8')).version, undefined)
    }, { targets: groupWorkspaceTargets(root, 'mission') })
    assert.equal(readFileSync(memCore, 'utf8'), memBefore)
  })
})

test('M7: calling with no { group } refuses to cross groups instead of guessing', () => {
  withWorkspace((root) => {
    const memCore = join(root, 'mem/packages/core/package.json')
    const before = readFileSync(memCore, 'utf8')
    assert.throws(
      () => withWorkspaceVersions(root, '9.9.9', () => {}),
      /no \{ group \} given[\s\S]*span 2 groups \(mem, mission\)[\s\S]*M7/u,
    )
    // The throw happens BEFORE anything is written.
    assert.equal(readFileSync(memCore, 'utf8'), before)
  })
})

// ── §2.2-2 · the base peer↔devDependencies pair, asserted on both sides ───────────────────────────

test('release-check: the dev half of the base wiring is asserted, not just the peer half', () => {
  const peer = '>=0.3.0 <1.0.0'
  assert.deepEqual(baseDependencyProblems('@avantf/dsh-mem', {
    peerDependencies: { [BASE]: peer }, devDependencies: { [BASE]: peer },
  }, BASE).problems, [])

  const noDev = baseDependencyProblems('@avantf/dsh-mem', { peerDependencies: { [BASE]: peer } }, BASE)
  assert.match(noDev.problems.join('\n'), /does not declare .* in devDependencies/u)

  const drifted = baseDependencyProblems('@avantf/dsh-mem', {
    peerDependencies: { [BASE]: peer }, devDependencies: { [BASE]: '^0.3.0' },
  }, BASE)
  assert.match(drifted.problems.join('\n'), /SAME range/u)

  const localDev = baseDependencyProblems('@avantf/dsh-mem', {
    peerDependencies: { [BASE]: peer }, devDependencies: { [BASE]: 'workspace:*' },
  }, BASE)
  assert.match(localDev.problems.join('\n'), /plain registry range/u)

  const noPeer = baseDependencyProblems('@avantf/dsh-mem', { devDependencies: { [BASE]: peer } }, BASE)
  assert.match(noPeer.problems.join('\n'), /does not declare .* in peerDependencies/u)
  assert.equal(noPeer.peer, undefined)

  const localPeer = baseDependencyProblems('@avantf/dsh-mem', {
    peerDependencies: { [BASE]: 'file:../base' }, devDependencies: { [BASE]: 'file:../base' },
  }, BASE)
  assert.match(localPeer.problems.join('\n'), /publishable registry range/u)
  assert.equal(localPeer.peer, undefined)
})

test('release-check: the two REAL plugin manifests declare a matching base pair', () => {
  for (const dir of ['mem/packages/plugin', 'mission/packages/plugin']) {
    const manifest = JSON.parse(readFileSync(join(workspace, dir, 'package.json'), 'utf8'))
    assert.deepEqual(
      baseDependencyProblems(manifest.name, manifest, BASE).problems,
      [],
      `${dir} must declare ${BASE} with the same range in peerDependencies and devDependencies`,
    )
  }
})

// ── M8 · a line ONE tree misses is a failure, even when the union covers it ──────────────────────

test('M8: per-tree coverage fails when a single tree misses, unlike the old union', () => {
  const semver = loadSemver()
  const mem = '@avantf/dsh-mem'
  const mission = '@avantf/dsh-mission'
  const versions = ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.9', '0.3.0-rc.1', '0.3.0-rc.2']
  const tags = { latest: '0.3.0-rc.2', next: '0.3.0-rc.1' }

  // Both trees in step: every version covered, no failure, no divergence.
  const both = judgeDshLines({
    declared: new Map([[mem, ['^0.2.0-rc.2', '^0.3.0-rc.1']], [mission, ['^0.2.0-rc.2', '^0.3.0-rc.1']]]),
    versions, tags, semver,
  })
  assert.deepEqual(both.uncoveredTags, [])
  assert.deepEqual(both.missingLines, [])
  assert.deepEqual(both.higherUncovered, [])
  assert.equal(both.declaredDivergence, false)

  // mem has the 0.3 clause, mission does not. The union covered every version, so the old
  // `covered.length === 0` test printed ok; per-tree judgement must fail on mission.
  const memAhead = judgeDshLines({
    declared: new Map([[mem, ['^0.2.0-rc.2', '^0.3.0-rc.1']], [mission, ['^0.2.0-rc.2']]]),
    versions, tags, semver,
  })
  assert.deepEqual(memAhead.missingLines.map((entry) => entry.line), ['0.3'])
  assert.deepEqual(memAhead.missingLines[0].missing, [mission])
  assert.deepEqual(memAhead.missingLines[0].covered, [mem])
  // 0.3 is not `higherUncovered`: another tree DOES cover it — that is exactly the drift shape.
  assert.deepEqual(memAhead.higherUncovered, [])
  assert.deepEqual(memAhead.uncoveredTags.map((row) => row.tag), ['latest', 'next'])
  assert.deepEqual(memAhead.uncoveredTags[0].missing, [mission])
  assert.equal(memAhead.declaredDivergence, true)

  // A brand-new line NO tree covers is still fatal (every row would be disabled).
  const newLine = judgeDshLines({
    declared: new Map([[mem, ['^0.2.0-rc.2', '^0.3.0-rc.1']], [mission, ['^0.2.0-rc.2', '^0.3.0-rc.1']]]),
    versions: [...versions, '0.4.0'], tags: { latest: '0.4.0' }, semver,
  })
  assert.deepEqual(newLine.missingLines, [])
  assert.deepEqual(newLine.higherUncovered.map((entry) => entry.line), ['0.4'])
  assert.deepEqual(newLine.uncoveredTags.map((row) => row.tag), ['latest'])

  // Historical lines below the highest fully-covered line stay notes: 0.0.x is nobody's, and the
  // covered dist-tag does not make them fatal.
  const history = judgeDshLines({
    declared: new Map([[mem, ['^0.2.0-rc.2', '^0.3.0-rc.1']], [mission, ['^0.2.0-rc.2', '^0.3.0-rc.1']]]),
    versions: [...versions, '0.0.1'], tags: { latest: '0.3.0-rc.2' }, semver,
  })
  assert.ok(history.lines.some((entry) => entry.line === '0.0' && entry.missing.length > 0))
  assert.deepEqual(history.missingLines, [])
  assert.deepEqual(history.higherUncovered, [])
  assert.deepEqual(history.uncoveredTags, [])
})

test('M8: the executable itself exits 1 when exactly one tree misses (fixture, no network)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lines-'))
  const script = join(workspace, 'scripts', 'check-dsh-lines.mjs')
  const run = (fixture) => {
    const file = join(dir, `${fixture.name}.json`)
    writeFileSync(file, JSON.stringify(fixture.body, null, 2))
    return spawnSync(process.execPath, [script, '--fixture', file], { encoding: 'utf8' })
  }
  try {
    // mem has the 0.3 clause, mission does not: the union covered 0.3, so the OLD gate printed ok.
    const failed = run({
      name: 'mem-ahead',
      body: {
        declared: { '@avantf/dsh-mem': ['^0.2.0-rc.2', '^0.3.0-rc.1'], '@avantf/dsh-mission': ['^0.2.0-rc.2'] },
        versions: ['0.2.0-rc.2', '0.2.9', '0.3.0-rc.1'],
        tags: { latest: '0.3.0-rc.1' },
      },
    })
    assert.equal(failed.status, 1, `one tree missing a line must exit 1\n${failed.stdout}`)
    assert.match(failed.stdout, /有树覆盖、另一棵树漏的线/u)
    assert.match(failed.stdout, /缺：@avantf\/dsh-mission/u)
    assert.match(failed.stdout, /需要处理/u)
    assert.doesNotMatch(failed.stdout, /check-dsh-lines: ok/u)

    // A new line nobody declared is fatal too, through the other failure shape.
    const newLine = run({
      name: 'new-line',
      body: {
        declared: {
          '@avantf/dsh-mem': ['^0.2.0-rc.2', '^0.3.0-rc.1'],
          '@avantf/dsh-mission': ['^0.2.0-rc.2', '^0.3.0-rc.1'],
        },
        versions: ['0.2.0-rc.2', '0.3.0-rc.1', '0.4.0'],
        tags: { latest: '0.4.0' },
      },
    })
    assert.equal(newLine.status, 1, `a fresh uncovered line must exit 1\n${newLine.stdout}`)
    assert.match(newLine.stdout, /没有任何树覆盖的线/u)

    // The same versions, both trees in step: green.
    const green = run({
      name: 'in-step',
      body: {
        declared: {
          '@avantf/dsh-mem': ['^0.2.0-rc.2', '^0.3.0-rc.1'],
          '@avantf/dsh-mission': ['^0.2.0-rc.2', '^0.3.0-rc.1'],
        },
        versions: ['0.2.0-rc.2', '0.2.9', '0.3.0-rc.1'],
        tags: { latest: '0.3.0-rc.1' },
      },
    })
    assert.equal(green.status, 0, `both trees in step must pass\n${green.stdout}`)
    assert.match(green.stdout, /check-dsh-lines: ok/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── M10 · both plugins run their own packer before publishing ─────────────────────────────────────

test('M10: both plugins declare prepublishOnly → their pack-plugin.mjs, with no recursion', () => {
  for (const dir of ['mem/packages/plugin', 'mission/packages/plugin']) {
    const manifest = JSON.parse(readFileSync(join(workspace, dir, 'package.json'), 'utf8'))
    const script = manifest.scripts?.prepublishOnly
    assert.equal(script, 'node ../../scripts/pack-plugin.mjs', `${dir} must run its packer before publishing`)
    assert.ok(existsSync(join(workspace, dir, '..', '..', 'scripts', 'pack-plugin.mjs')), `${dir}: the packer must exist`)
    // `prepublishOnly` must not call `publish`/`pnpm publish`: that is the recursion.
    assert.doesNotMatch(script, /publish/u)
  }
})

/**
 * The semver the dsh boot gate judges with. Same preference order as `check-dsh-lines.mjs`: the
 * workspace's own resolved copy first (present after `pnpm install`), then the installed dsh's.
 */
function loadSemver() {
  const require = createRequire(import.meta.url)
  const candidates = []
  const pnpmStore = join(workspace, 'node_modules', '.pnpm')
  if (existsSync(pnpmStore)) {
    for (const entry of readdirSync(pnpmStore)) {
      if (/^semver@7\./u.test(entry)) candidates.push(join(pnpmStore, entry, 'node_modules', 'semver'))
    }
  }
  candidates.push(join(workspace, 'node_modules', 'semver'))
  try {
    const globalRoot = execToolSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    candidates.push(join(globalRoot, '@deepseek-ai/dsh', 'node_modules', 'semver'))
  } catch {}
  for (const candidate of candidates) {
    try {
      const semver = require(candidate)
      if (typeof semver.satisfies === 'function' && typeof semver.parse === 'function') return semver
    } catch {}
  }
  throw new Error('gates.test: no semver found to judge the dsh lines with (run `pnpm install`)')
}
