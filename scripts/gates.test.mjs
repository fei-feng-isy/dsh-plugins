#!/usr/bin/env node
/**
 * Self-tests for the PURE logic the root gates are built from.
 *
 * The root `scripts/` have no test runner of their own, and two of these assertions are exactly the
 * kind that must be proven on constructed input: "does the version materializer touch a second
 * group's manifests?" and "does one tree missing a dsh line fail the gate?". So the decisions live in
 * `scripts/lib/` (versions.mjs, gates.mjs, published-base.mjs, pack-plugin.mjs) and this file replays
 * them — M7 (group-scoped version materialization), §2.2-2 (the base peer↔dev pair), M8 (per-tree
 * dsh-line coverage), M10 (the plugin prepublishOnly wiring), N15 (the plugin half of the one-zod rule,
 * for BOTH trees), R1 (the published base's interface generation vs the plugin's bake) and S2 (the
 * documented-count observation a pack prints — silent on agreement or a missing input).
 *
 *   node scripts/gates.test.mjs
 *
 * No workspace build, no registry: the only external facts are `git` (the version state is read from
 * tracked manifests) and a semver implementation (the installed dsh's own copy, so the dsh-line
 * judgement is replayed against the same semver the boot gate uses). The R1 executable cases run
 * `release-check --fixture`, so even the end-to-end replay never opens a socket.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { baseDependencyProblems, judgeDshLines, requiredPeerProblems } from './lib/gates.mjs'
import {
  INTERFACE_RECORD_PATH,
  INTERFACE_SOURCE_PATH,
  interfaceGenerationFromSource,
  interfaceGenerationVerdict,
  publishedInterfaceGeneration,
  readTarballEntry,
} from './lib/published-base.mjs'
import { execToolSync } from './lib/win-spawn.mjs'
import { arrayEntries, documentedCountMismatches, exportedSymbolNames, shippedDeclarationNote, unconsumedExports, versionPackageNames } from './lib/pack-plugin.mjs'
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
    devDependencies: { [BASE]: '>=3.0.0 <4.0.0', '@avantf/mem-retrieval': 'workspace:*' },
  })
  write('mem/packages/core/package.json', { name: '@avantf/mem-retrieval', private: true })
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

// ── N15 · the one-zod rule reaches the plugin PUBLISH manifest, not just catalog and base ──────────

test('N15: a host-provided dependency must stay a REQUIRED peer, in peerDependencies only', () => {
  // BOTH trees: a host install is judged by whichever manifest it reads, so each must declare the
  // same disposition — zod required, in peerDependencies, never nested. (`^4.4.3` and `>=4.4.3 <5`
  // both pass: the rule is about WHERE zod comes from, not the spelling of the range.)
  for (const name of ['@avantf/dsh-mem', '@avantf/dsh-mission']) {
    assert.deepEqual(requiredPeerProblems(name, {
      peerDependencies: { zod: '>=4.4.3 <5' },
    }, 'zod'), [], name)

    // Moved into `dependencies`: the installer nests a second copy beside the host's.
    const moved = requiredPeerProblems(name, { dependencies: { zod: '>=4.4.3 <5' } }, 'zod')
    assert.match(moved.join('\n'), /does not declare zod in peerDependencies/u)
    assert.match(moved.join('\n'), /SECOND copy/u)

    // Present as a peer, but optional: the host is not required to provide it.
    const optional = requiredPeerProblems(name, {
      peerDependencies: { zod: '>=4.4.3 <5' }, peerDependenciesMeta: { zod: { optional: true } },
    }, 'zod')
    assert.match(optional.join('\n'), /OPTIONAL peer/u)

    // Both at once: a peer AND a nested runtime copy — the exact drift the rule exists for.
    const both = requiredPeerProblems(name, {
      peerDependencies: { zod: '>=4.4.3 <5' }, dependencies: { zod: '^4.6.5' },
    }, 'zod')
    assert.match(both.join('\n'), /lists zod in dependencies/u)
    assert.match(both.join('\n'), /SECOND copy/u)

    const optionalDependency = requiredPeerProblems(name, {
      peerDependencies: { zod: '>=4.4.3 <5' }, optionalDependencies: { zod: '^4.6.5' },
    }, 'zod')
    assert.match(optionalDependency.join('\n'), /optionalDependencies/u)
  }
})

test('N15: the REAL manifests of BOTH trees get their single zod from the host', () => {
  for (const dir of ['mem/packages/plugin', 'mission/packages/plugin']) {
    const manifest = JSON.parse(readFileSync(join(workspace, dir, 'package.json'), 'utf8'))
    assert.deepEqual(
      requiredPeerProblems(manifest.name, manifest, 'zod'),
      [],
      `${dir} must take zod as a required peer (S1 aligned mission with mem — both use it at runtime)`,
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

// ── R1 · the published base's INTERFACE GENERATION, not just its version range ────────────────────

/**
 * A minimal ustar+gzip tarball — enough to exercise `readTarballEntry` (`npm pack` writes exactly this
 * shape for short paths: regular files, octal `size`, NUL padding).
 */
function makeTarball(entries) {
  const blocks = []
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8')
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'utf8')
    header.write('0000000\0', 108, 8, 'utf8')
    header.write('0000000\0', 116, 8, 'utf8')
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
    header.write('00000000000\0', 136, 12, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    header.write('0', 156, 1, 'utf8')
    header.write('ustar\0', 257, 6, 'utf8')
    header.write('00', 263, 2, 'utf8')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function runReleaseCheck(args) {
  return spawnSync(process.execPath, [join(workspace, 'scripts', 'release-check.mjs'), ...args], { encoding: 'utf8' })
}

/** A temp directory whose `write(name, body)` produces a release-check `--fixture` file. */
function withFixtureDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-check-'))
  try {
    return run((name, body) => {
      const file = join(dir, `${name}.json`)
      writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
      return file
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('R1: the generation is read out of the unpacked base artifact, from its one true constant', () => {
  const tarball = makeTarball([
    ['package/package.json', '{"name":"@avantf/dsh-plugin-base","version":"0.3.1"}'],
    [INTERFACE_SOURCE_PATH, 'export const INTERFACE_VERSION = 1;\n'],
  ])
  assert.equal(readTarballEntry(tarball, INTERFACE_SOURCE_PATH), 'export const INTERFACE_VERSION = 1;\n')
  assert.equal(readTarballEntry(tarball, 'package/lib/interface-version.json'), undefined)
  assert.equal(readTarballEntry(tarball, 'package/dist/missing.js'), undefined)
  assert.equal(interfaceGenerationFromSource(readTarballEntry(tarball, INTERFACE_SOURCE_PATH)), 1)

  // Prose and the frozen name list mention the constant without defining it; only `NAME = <digits>`
  // counts, and a file claiming two different generations is not one generation.
  assert.equal(interfaceGenerationFromSource("'INTERFACE_VERSION',\n// see INTERFACE_VERSION\n"), undefined)
  assert.equal(interfaceGenerationFromSource('export const INTERFACE_VERSION = 2;\nINTERFACE_VERSION = 3;\n'), undefined)
  assert.equal(interfaceGenerationFromSource('export const INTERFACE_VERSION = 0;\n'), undefined)
})

test('R1: a published base generation comes from interface.js, or from the record when there is one', () => {
  const source = 'export const INTERFACE_VERSION = 2;\n'
  assert.deepEqual(publishedInterfaceGeneration({ source }), {
    status: 'ok', interfaceVersion: 2, baseVersion: undefined, from: [INTERFACE_SOURCE_PATH],
  })
  assert.deepEqual(publishedInterfaceGeneration({ record: '{"baseVersion":"0.3.2","interfaceVersion":2}\n' }), {
    status: 'ok', interfaceVersion: 2, baseVersion: '0.3.2', from: [INTERFACE_RECORD_PATH],
  })
  // Both present and agreeing: one number, and the record supplies the base version.
  const both = publishedInterfaceGeneration({ record: '{"baseVersion":"0.3.2","interfaceVersion":2}', source })
  assert.equal(both.status, 'ok')
  assert.equal(both.interfaceVersion, 2)
  assert.equal(both.baseVersion, '0.3.2')
  assert.deepEqual(both.from, [INTERFACE_RECORD_PATH, INTERFACE_SOURCE_PATH])
  // Both present and disagreeing: no number can be trusted.
  const conflict = publishedInterfaceGeneration({ record: '{"baseVersion":"0.3.2","interfaceVersion":3}', source })
  assert.equal(conflict.status, 'conflict')
  assert.match(conflict.detail, /interface generation 3/u)
  assert.match(conflict.detail, /says 2/u)
  // Neither usable.
  assert.equal(publishedInterfaceGeneration({}).status, 'unreadable')
  assert.equal(publishedInterfaceGeneration({ record: '{not json', source: '// no constant' }).status, 'unreadable')
})

test('R1: below the bake fails and names both generations; unreadable and offline only warn', () => {
  const bake = { baseVersion: '0.3.2', interfaceVersion: 2 }
  const judge = (published, extra = {}) =>
    interfaceGenerationVerdict({ plugin: '@avantf/dsh-mem', baseVersion: '0.3.1', published, bake, ...extra })

  const lower = judge({ status: 'ok', interfaceVersion: 1 })
  assert.equal(lower.level, 'fail')
  assert.match(lower.message, /interface generation 1/u)
  assert.match(lower.message, /generation 2/u)
  assert.match(lower.message, /pnpm -C base\/plugin-base publish/u)

  const equal = interfaceGenerationVerdict({
    plugin: '@avantf/dsh-mem', baseVersion: '0.3.2', published: { status: 'ok', interfaceVersion: 2 }, bake,
  })
  assert.equal(equal.level, 'ok')
  assert.match(equal.message, /0\.3\.2 carries interface generation 2/u)
  assert.match(equal.message, /built against generation 2/u)

  assert.equal(interfaceGenerationVerdict({
    plugin: '@avantf/dsh-mem', baseVersion: '0.4.0', published: { status: 'ok', interfaceVersion: 3 }, bake,
  }).level, 'ok')
  // --allow-missing-base downgrades ONLY the fatal case.
  assert.equal(judge({ status: 'ok', interfaceVersion: 1 }, { allowMissingBase: true }).level, 'warn')

  // "读不到" is a WARNING, never a red gate: unreadable artifact, no bake, no probe at all.
  assert.equal(judge({ status: 'unreadable', detail: 'nothing there' }).level, 'warn')
  assert.match(judge({ status: 'unreadable', detail: 'nothing there' }).message, /could not read the interface generation/u)
  assert.equal(interfaceGenerationVerdict({
    plugin: '@avantf/dsh-mem', baseVersion: '0.3.1', published: { status: 'ok', interfaceVersion: 1 }, bake: undefined,
  }).level, 'warn')
  assert.equal(interfaceGenerationVerdict({
    plugin: '@avantf/dsh-mem', baseVersion: '0.3.1', published: undefined, bake,
  }).level, 'warn')

  // A self-contradictory artifact is a real defect, not "unreadable".
  const conflict = judge({ status: 'conflict', detail: 'the record says 3, interface.js says 2' })
  assert.equal(conflict.level, 'fail')
  assert.match(conflict.message, /contradicts itself/u)
})

test('R1: the executable fails on a lower published generation and degrades to WARNING with --allow-missing-base', () => {
  const bake = JSON.parse(readFileSync(join(workspace, 'mem/packages/plugin/lib/interface-version.json'), 'utf8'))
  withFixtureDir((write) => {
    const low = write('low', {
      baseVersions: [{ version: '0.3.1' }],
      artifacts: { '0.3.1': { source: 'export const INTERFACE_VERSION = 1;\n' } },
    })
    const strict = runReleaseCheck(['--fixture', low])
    assert.equal(strict.status, 1, `a lower published generation must exit 1\n${strict.stdout}${strict.stderr}`)
    assert.match(strict.stderr, /carries interface generation 1/u)
    assert.match(strict.stderr, new RegExp(`generation ${bake.interfaceVersion}\\b`, 'u'))
    assert.match(strict.stderr, /pnpm -C base\/plugin-base publish/u)

    // The pre-publication dry run: the same finding, a WARNING, exit 0.
    const dry = runReleaseCheck(['--fixture', low, '--allow-missing-base'])
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`)
    assert.match(dry.stdout, /WARNING: @avantf\/dsh-mem: the published base 0\.3\.1 carries interface generation 1/u)
  })
})

test('R1: the executable passes when the published generation equals the bake and prints both sides', () => {
  const bake = JSON.parse(readFileSync(join(workspace, 'mem/packages/plugin/lib/interface-version.json'), 'utf8'))
  withFixtureDir((write) => {
    const same = write('same', {
      baseVersions: [{ version: '0.3.1' }],
      artifacts: { '0.3.1': { source: `export const INTERFACE_VERSION = ${bake.interfaceVersion};\n` } },
    })
    const run = runReleaseCheck(['--fixture', same])
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
    assert.match(run.stdout, /the published base 0\.3\.1 carries interface generation \d+/u)
    assert.match(run.stdout, new RegExp(`built against generation ${bake.interfaceVersion}\\b`, 'u'))
  })
})

test('R1: no published version in range keeps the existing missing-base semantics', () => {
  withFixtureDir((write) => {
    const outOfRange = write('out-of-range', { baseVersions: [{ version: '9.9.9' }] })
    const strict = runReleaseCheck(['--fixture', outOfRange])
    assert.equal(strict.status, 1, `${strict.stdout}${strict.stderr}`)
    assert.match(strict.stderr, /no version satisfies/u)
    assert.match(strict.stderr, /Fix: publish a @avantf\/dsh-plugin-base version inside/u)

    const dry = runReleaseCheck(['--fixture', outOfRange, '--allow-missing-base'])
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`)
    assert.match(dry.stdout, /WARNING: .*no version satisfies/u)
  })
})

test('R1: offline and an artifact that records nothing are WARNINGS, and the gate exits 0', () => {
  // --offline: the registry half is not verified at all, and must not turn the local gate red.
  const off = runReleaseCheck(['--offline'])
  assert.equal(off.status, 0, `${off.stdout}${off.stderr}`)
  assert.match(off.stdout, /WARNING: registry probe skipped \(--offline\)/u)

  // A published base whose tarball records no generation: same downgrade, even WITHOUT --offline.
  withFixtureDir((write) => {
    const unreadable = write('unreadable', {
      baseVersions: [{ version: '0.3.1' }],
      artifacts: { '0.3.1': {} },
    })
    const run = runReleaseCheck(['--fixture', unreadable])
    assert.equal(run.status, 0, `an unreadable generation must not fail the gate\n${run.stdout}${run.stderr}`)
    assert.match(run.stdout, /WARNING: @avantf\/dsh-mem: could not read the interface generation/u)
  })
})

// ── C5 · the dead-export OBSERVATION (printed by a pack, never a gate) ─────────────────────────────
//
// The count is only useful if it separates the two shapes at the boundary: a symbol SOMETHING in the
// repo uses is alive even when that use is inside its own module, while a symbol nothing but its own
// declaration mentions is what "sediment" means. Deliberate mirrors and the base's frozen interface
// members are excluded by name, since they have no in-repo consumer BY CONSTRUCTION.

test('C5: an exported symbol a source uses is consumed; one only its declaration mentions is not', () => {
  const declarations = [
    'export declare function used(): void;',
    'export declare function orphan(): void;',
    'export interface Config { maxConcurrent?: number }',
    'export type { MemoryStore, RecallOutcome as Recall } from "./engine/mem/index.js";',
    'export * from "./everything.js";',
    'export default class Whatever {}',
  ].join('\n')
  // `export *` names nothing and `export default` has no stable name; `as` publishes the rename.
  assert.deepEqual(exportedSymbolNames(declarations).sort(), ['Config', 'MemoryStore', 'Recall', 'orphan', 'used'])

  const sources = [
    // The declaration plus one in-module use: two whole-identifier mentions, so ALIVE.
    'export function used(): void {}\nused()\n',
    // Declared, and nothing else ever names `orphan` — one mention, the declaration itself.
    'export function orphan(): void {}\n',
  ]
  const result = unconsumedExports(declarations, sources)
  assert.equal(result.exported, 5)
  assert.equal(result.unconsumed, 4)
  assert.deepEqual(result.unconsumedNames, ['orphan', 'Config', 'MemoryStore', 'Recall'])
})

test('C5: the mirror/frozen names are excluded, and an unreadable artifact degrades to silence', () => {
  // `mirror` is unused in-repo but is a deliberate mirror of a frozen base member: never judged.
  const result = unconsumedExports(
    'export declare function orphan(): void;\nexport declare function mirror(): void;',
    ['export function orphan(): void {}\n'],
    { exclude: ['mirror'] },
  )
  assert.equal(result.exported, 2)
  assert.deepEqual(result.unconsumedNames, ['orphan'])

  // Reading the artifact throws: the observation returns nothing instead of failing the pack.
  assert.equal(
    shippedDeclarationNote({ repo: '/nonexistent' }, ['package/lib/types/index.d.ts'], () => { throw new Error('boom') }),
    undefined,
  )
  // No declaration entries at all, and no repo on the config: also silence, never a throw.
  assert.equal(shippedDeclarationNote({ repo: '/nonexistent' }, ['package/lib/index.js'], () => ''), undefined)
  assert.equal(shippedDeclarationNote({}, ['package/lib/types/index.d.ts'], () => 'export declare const a = 1;'), undefined)
})

// ── S2 · the documented-count OBSERVATION (printed by a pack, never a gate) ───────────────────────
//
// A shipped README IS the npm page: "8 个模型工具", "9 个模型工具 / 三条命令", a prompt-section count.
// Each number is produced by code in this repo, so a drift is visible — but this is a note, so the
// comparison has to separate three inputs: agree (silent), disagree (one line), and a MISSING input
// (silent, never a manufactured finding).

const countClaim = (text, measured, pattern = /(\d+)\s*个模型工具/u, label = 'mem README model tools') =>
  ({ label, text, pattern, measured })

test('S2: a documented count is reported only when both numbers are known and disagree', () => {
  // Agree: nothing printed.
  assert.deepEqual(documentedCountMismatches([countClaim('提供 8 个模型工具', 8)]), [])
  // Disagree: one line naming both numbers.
  const drifted = documentedCountMismatches([countClaim('提供 9 个模型工具', 8)])
  assert.equal(drifted.length, 1)
  assert.match(drifted[0], /mem README model tools: documented 9, measured 8/u)

  // A Chinese numeral is read the same way (`三段用法提示` = 3, `两条命令` = 2).
  const sections = /([一二三四五六七八九十两])\s*段用法提示/u
  assert.deepEqual(documentedCountMismatches([countClaim('三段用法提示', 3, sections)]), [])
  assert.match(
    documentedCountMismatches([countClaim('两段用法提示', 3, sections)])[0],
    /documented 2, measured 3/u,
  )

  // Missing input on EITHER side is silence, not a finding: the document could not be read, the
  // number is not stated, the count could not be measured, or the capture is not a count at all.
  assert.deepEqual(documentedCountMismatches([
    countClaim(undefined, 8),
    countClaim('这里没有数字', 8),
    countClaim('提供 8 个模型工具', undefined),
    countClaim('提供了若干模型工具', 8, /(若干)\s*个模型工具/u),
  ]), [])
})

test('S2: the measured count is read from the code, object entries with commas included', () => {
  assert.deepEqual(
    arrayEntries("export const TOOL_SPECS: ToolSpec[] = [\n  REMEMBER_TOOL,\n  RECALL_TOOL,\n  ADMIN_TOOL,\n]", 'TOOL_SPECS'),
    ['REMEMBER_TOOL', 'RECALL_TOOL', 'ADMIN_TOOL'],
  )
  // An object entry carries a comma of its own — it is ONE entry, not two (`PROMPT_FILES`).
  assert.deepEqual(
    arrayEntries("export const PROMPT_FILES = [\n  { file: 'a.md', section: A },\n  { file: 'b.md', section: B },\n]", 'PROMPT_FILES'),
    ["{ file: 'a.md', section: A }", "{ file: 'b.md', section: B }"],
  )
  // A declaration that is not there yields `undefined` — the claim goes silent, never a wrong count.
  assert.equal(arrayEntries('const OTHER: string[] = []', 'PROMPT_FILES'), undefined)
})

// ── M10 · both plugins run their own packer before publishing ─────────────────────────────────────

test('M10: both plugins declare prepublishOnly → (assert, then) their own packer, with no recursion', () => {
  for (const dir of ['mem/packages/plugin', 'mission/packages/plugin']) {
    const manifest = JSON.parse(readFileSync(join(workspace, dir, 'package.json'), 'utf8'))
    const script = manifest.scripts?.prepublishOnly
    // The packer is the load-bearing half and must stay LAST: it is what turns the tree into a tarball.
    assert.ok(
      typeof script === 'string' && script.endsWith('node ../../scripts/pack-plugin.mjs'),
      `${dir} must run its packer before publishing (found ${JSON.stringify(script)})`,
    )
    // RC projection was retired on 2026-10-03: the release invariants it enforced now run as a
    // pre-publish assertion. When present it must name THIS package — a copy-pasted hook that asserts
    // another package is a real hazard, and this is the only place that can catch it.
    const asserted = /prepublish-assert\.mjs --package (\S+)/u.exec(script)
    if (asserted !== null) {
      assert.equal(asserted[1], manifest.name, `${dir}: the pre-publish assertion must name this package`)
    }
    assert.ok(existsSync(join(workspace, dir, '..', '..', 'scripts', 'pack-plugin.mjs')), `${dir}: the packer must exist`)
    // `prepublishOnly` must not call `publish`/`pnpm publish`: that is the recursion. `\b` matters —
    // a bare `/publish/` also matches the `prepublish-assert` step we deliberately run first.
    assert.doesNotMatch(script, /\bpublish\b/u)
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

// ── VERSION_PACKAGES parsing · prose comments must not eat the list ───────────────────────────────
//
// Measured 2026-10-02: mission's `VERSION_PACKAGES` carries a note per unusual entry, and the
// apostrophe in "part of this plugin's compile surface" paired with the next quote — the gate then
// read 8 junk fragments and missed 8 real packages, failing a list that was in fact complete.

test('VERSION_PACKAGES: names survive prose comments, apostrophes included', () => {
  const body = `
  '@deepseek-ai/dsh-a',
  // Not listed: \`dsh-storage\`. It is a transitive dependency of the declared peer, not part of this
  // plugin's compile surface, and \`link-dsh.mjs\` no longer links it (see the note there).
  '@deepseek-ai/dsh-b',
  /* block note: don't parse this one either */
  '@deepseek-ai/dsh-c',
`
  assert.deepEqual(versionPackageNames(body), [
    '@deepseek-ai/dsh-a',
    '@deepseek-ai/dsh-b',
    '@deepseek-ai/dsh-c',
  ])
})

test('VERSION_PACKAGES: a real mission-style list parses to its declared entries only', () => {
  const source = readFileSync(join(workspace, 'mission/packages/plugin/src/envinit.ts'), 'utf8')
  const body = /const VERSION_PACKAGES: readonly string\[\] = \[([\s\S]*?)\]/u.exec(source)?.[1]
  assert.ok(body !== undefined, 'mission must still declare VERSION_PACKAGES')
  const names = versionPackageNames(body)
  assert.ok(names.length > 8, `expected a real list, got ${String(names.length)} names`)
  for (const name of names) {
    assert.match(name, /^@deepseek-ai\/[a-z-]+$/u, `${name} is not a package specifier — the parse drifted`)
  }
})
