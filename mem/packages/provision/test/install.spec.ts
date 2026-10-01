/**
 * The installer mechanism, end to end — against LOCAL fixtures only.
 *
 * These specs exist because the machine that has to be able to verify this cannot be assumed to
 * reach GitHub: every stage is exercised through a loopback HTTP server and in-process archives, so
 * "download → digest → extract → atomic publish → probe" is proven without a mirror, a proxy or a
 * DNS answer. The real pandoc is a separate, skippable spec (`pandoc.spec.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  artifactById,
  artifacts,
  ensure,
  installBinaryArtifact,
  ProvisionError,
  registerArtifact,
  registerPandocArtifact,
  resolveBinary,
  runProbe,
  silentLogger,
  type ArchivePack,
  type Artifact,
  type ProvisionConfig, requirePack } from '../src/index.js'
import { buildTarGzFixture, buildZipFixture, buildZipSlipFixture, startFixtureServer, type FixtureServer } from './helpers/archives.js'

/**
 * A synthetic artifact whose install/verify go through the REAL generic installer.
 *
 * Only the identity (id/version/title) and the pack are fixtures — the mechanism under test is
 * `installBinaryArtifact`, so stubbing `install` would test nothing but the stub.
 */
function makeArtifact(): Artifact {
  return {
    id: 'faketool',
    title: '夹具工具',
    version: '9.9',
    packs: {},
    isPresent: async () => false,
    install: async (ctx) => {
      await installBinaryArtifact({
        artifact: 'faketool',
        toolsDir: join(ctx.dir, '..', '..'),
        version: '9.9',
        binary: 'faketool',
        pack: requirePack(ctx, 'faketool'),
        config: ctx.config,
        logger: ctx.logger,
      })
    },
    verify: async (ctx) => {
      const probe = runProbe(join(ctx.dir, 'bin', 'faketool'), [])
      if (!probe.ok || !probe.output.includes('9.9')) {
        throw new Error(`夹具工具校验失败：${probe.output}`)
      }
    },
  }
}

let server: FixtureServer
let workspace: string

/**
 * The suite-wide `AVANTF_MEM_AUTO_DOWNLOAD=0` (see `vitest.config.ts`) keeps every OTHER spec
 * offline; these specs exist to exercise the download path, so they flip the switch for their own
 * duration. The bytes still come from the loopback fixture server, never the network.
 */
const previousAutoDownload = process.env['AVANTF_MEM_AUTO_DOWNLOAD']

beforeAll(async () => {
  process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = '1'
  server = await startFixtureServer()
  workspace = mkdtempSync(join(tmpdir(), 'avf-provision-spec-'))
  registerArtifact(makeArtifact())
})

afterAll(async () => {
  if (previousAutoDownload === undefined) delete process.env['AVANTF_MEM_AUTO_DOWNLOAD']
  else process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = previousAutoDownload
  await server.close()
  rmSync(workspace, { recursive: true, force: true })
})

/** The pack key for this machine (`linux-x64`), which is the only pack the fake artifact publishes. */
function fakeKey(): string {
  return `${process.platform}-${process.arch}`
}

/** Point the fake artifact's only pack at one fixture URL. */
function pointAt(fixture: { sha256: string; byteLength: number }, path: string, patch: Partial<ArchivePack> = {}): void {
  const artifact = artifactById('faketool')
  artifact.packs = {
    [fakeKey()]: {
      url: `${server.origin}${path}`,
      sha256: fixture.sha256,
      bytes: fixture.byteLength,
      format: 'tar.gz',
      binary: 'FIXTURE_ROOT/bin/faketool',
      ...patch,
    },
  }
}

/** A fresh tools directory plus the config that points at it. */
function fixtureSetup(options: { mirror?: string[] } = {}): { toolsDir: string; config: ProvisionConfig } {
  const toolsDir = mkdtempSync(join(workspace, 'tools-'))
  return { toolsDir, config: { dir: toolsDir, mirror: options.mirror ?? [], auto_install: true } }
}

/** Every path under `toolsDir`, relative, for "no residue" assertions. */
function treeOf(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      out.push(entry.isDirectory() ? `${rel}/` : rel)
      if (entry.isDirectory()) walk(join(current, entry.name), rel)
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out.sort()
}

describe('install: download → digest → extract → atomic publish', () => {
  it('installs a tar.gz into <id>/<version>/bin, verifies the digest, and leaves no scratch behind', async () => {
    const artifact = artifactById('faketool')
    const fixture = await buildTarGzFixture({ base: workspace, root: 'FIXTURE_ROOT', binary: 'faketool', version: '9.9' })
    server.put('/fake-9.9.tar.gz', fixture.bytes)
    pointAt(fixture, '/fake-9.9.tar.gz')
    const { toolsDir, config } = fixtureSetup()

    const result = await ensure('faketool', { toolsDir, config, logger: silentLogger, force: true })
    expect(result.ok).toBe(true)
    expect(result.source).toBe('installed')

    const binary = join(toolsDir, 'faketool', '9.9', 'bin', 'faketool')
    expect(existsSync(binary)).toBe(true)
    // The probe runs the installed file, so "installed" means "runs", not "a file exists".
    expect(runProbe(binary, []).output).toBe('faketool 9.9')
    // The scratch directory is gone: only the version directory remains.
    expect(treeOf(toolsDir)).toEqual(['faketool/', 'faketool/9.9/', 'faketool/9.9/bin/', 'faketool/9.9/bin/faketool'])
  })

  it('installs a zip through this package’s own extractor, finding the binary in a subdirectory', async () => {
    const fixture = await buildZipFixture({ base: workspace, binary: 'faketool', version: '9.9' })
    server.put('/fake-9.9.zip', fixture.bytes)
    pointAt(fixture, '/fake-9.9.zip', { format: 'zip', binary: 'release/bin/faketool' })
    const { toolsDir, config } = fixtureSetup()

    const result = await ensure('faketool', { toolsDir, config, logger: silentLogger, force: true })
    expect(result.ok).toBe(true)
    expect(existsSync(join(toolsDir, 'faketool', '9.9', 'bin', 'faketool'))).toBe(true)
  })
})

describe('sources: mirrors first, official last, every failure reported', () => {
  it('falls through a dead mirror to the next source and reports which were tried', async () => {
    const artifact = artifactById('faketool')
    const fixture = await buildTarGzFixture({ base: workspace, root: 'FIXTURE_ROOT', binary: 'faketool', version: '9.9' })
    server.put('/reachable.tar.gz', fixture.bytes)
    // The mirror template points at a path the server does not have (404); the official candidate
    // is the second entry, which is where the fixture really lives.
    pointAt(fixture, '/reachable.tar.gz')
    const { toolsDir, config } = fixtureSetup({ mirror: [`${server.origin}/missing-{file}`] })
    const result = await ensure('faketool', { toolsDir, config, logger: silentLogger, force: true })
    expect(result.ok).toBe(true)
    expect(server.requested).toContain('/missing-reachable.tar.gz')
    expect(server.requested).toContain('/reachable.tar.gz')
  })

  it('names every source it tried when none missions', async () => {
    const artifact = artifactById('faketool')
    const fixture = await buildTarGzFixture({ base: workspace, root: 'FIXTURE_ROOT', binary: 'faketool', version: '9.9' })
    pointAt(fixture, '/nowhere.tar.gz')
    const { toolsDir, config } = fixtureSetup({ mirror: [`${server.origin}/also-missing-{file}`] })
    const result = await ensure('faketool', { toolsDir, config, logger: silentLogger, force: true })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('所有下载源都失败')
    expect(result.error).toContain('/also-missing-nowhere.tar.gz')
    expect(result.error).toContain('/nowhere.tar.gz')
    expect(result.error).toContain('HTTP 404')
  })
})

describe('failure: a digest mismatch is a named error with no residue', () => {
  it('reports the digest step, and leaves the tools directory empty', async () => {
    const artifact = artifactById('faketool')
    const fixture = await buildTarGzFixture({ base: workspace, root: 'FIXTURE_ROOT', binary: 'faketool', version: '9.9' })
    server.put('/tampered.tar.gz', fixture.bytes)
    // Same bytes, wrong expected digest — what a tampered mirror or a stale cache looks like.
    pointAt({ ...fixture, sha256: 'a'.repeat(64) }, '/tampered.tar.gz')
    const { toolsDir, config } = fixtureSetup()

    const result = await ensure('faketool', { toolsDir, config, logger: silentLogger, force: true })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('verify-checksum')
    expect(result.error).toContain('sha256 不符')
    expect(result.error).toContain('a'.repeat(64))
    // No `faketool/` directory, no `.tmp/` — the scratch cleanup runs on the failure path too.
    expect(treeOf(toolsDir)).toEqual([])
  })

  it('reports a truncated download by its byte count, not merely as a mismatch', async () => {
    const artifact = artifactById('faketool')
    const fixture = await buildTarGzFixture({ base: workspace, root: 'FIXTURE_ROOT', binary: 'faketool', version: '9.9' })
    server.put('/truncated.tar.gz', fixture.bytes.subarray(0, 20))
    pointAt(fixture, '/truncated.tar.gz')
    const { toolsDir, config } = fixtureSetup()
    const result = await ensure('faketool', { toolsDir, config, logger: silentLogger, force: true })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('期望')
    expect(result.error).toContain('字节')
    expect(treeOf(toolsDir)).toEqual([])
  })
})

describe('failure: an archive that escapes the destination', () => {
  it('refuses a ZIP SLIP entry and cleans up every file it wrote', async () => {
    const artifact = artifactById('faketool')
    const fixture = await buildZipSlipFixture({ base: workspace })
    server.put('/slip.zip', fixture.bytes)
    pointAt(fixture, '/slip.zip', { format: 'zip' })
    const { toolsDir, config } = fixtureSetup()

    const result = await ensure('faketool', { toolsDir, config, logger: silentLogger, force: true })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('跳出目标目录')
    expect(treeOf(toolsDir)).toEqual([])
  })
})

describe('detection priority: explicit → managed → PATH', () => {
  it('takes an explicit path first, and reports a stale one instead of falling through', async () => {
    const artifact = artifactById('faketool')
    const fixture = await buildTarGzFixture({ base: workspace, root: 'FIXTURE_ROOT', binary: 'faketool', version: '9.9' })
    pointAt(fixture, '/unused.tar.gz')
    const { toolsDir } = fixtureSetup()
    const explicit = join(workspace, 'explicit-faketool')
    writeFileSync(explicit, '#!/bin/sh\necho "faketool 9.9"\n')
    chmodSync(explicit, 0o755)

    const spec = { binary: 'faketool', versionArgs: [], versionMarker: '9.9', envVar: 'AVANTF_FAKE_TOOL' }
    const resolved = resolveBinary(spec, { toolsDir, artifact, explicit })
    expect(resolved).toMatchObject({ ok: true, source: 'explicit', path: explicit })

    const stale = resolveBinary(spec, { toolsDir, artifact, explicit: join(workspace, 'not-there') })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.reason).toContain('不存在或不可执行')
  })

  it('prefers the managed copy over a system one, and demands the pinned version', async () => {
    const artifact = artifactById('faketool')
    const fixture = await buildTarGzFixture({ base: workspace, root: 'FIXTURE_ROOT', binary: 'faketool', version: '9.9' })
    pointAt(fixture, '/unused.tar.gz')
    const { toolsDir } = fixtureSetup()
    const managed = join(toolsDir, 'faketool', '9.9', 'bin')
    mkdirSync(managed, { recursive: true })
    writeFileSync(join(managed, 'faketool'), '#!/bin/sh\necho "faketool 9.9"\n')
    chmodSync(join(managed, 'faketool'), 0o755)

    const spec = { binary: 'faketool', versionArgs: [], versionMarker: '9.9', envVar: 'AVANTF_FAKE_TOOL' }
    const resolved = resolveBinary(spec, { toolsDir, artifact })
    expect(resolved).toMatchObject({ ok: true, source: 'managed' })

    // A managed binary reporting a different version is NOT accepted: the version is load bearing.
    writeFileSync(join(managed, 'faketool'), '#!/bin/sh\necho "faketool 9.8"\n')
    chmodSync(join(managed, 'faketool'), 0o755)
    const wrong = resolveBinary(spec, { toolsDir, artifact })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.reason).toContain('没有符合要求的版本')
  })
})

describe('registry', () => {
  it('registers pandoc on import and refuses a duplicate id', () => {
    registerPandocArtifact()
    expect(artifacts().map(artifact => artifact.id)).toContain('pandoc')
    expect(() => { registerPandocArtifact() }).not.toThrow()
    expect(() => { registerArtifact(artifactById('faketool')) }).toThrow(/重复注册/)
  })

  it('reports an unregistered artifact by name', () => {
    expect(() => artifactById('nope')).toThrow(ProvisionError)
    try {
      artifactById('nope')
    } catch (error) {
      expect((error as Error).message).toContain('faketool')
    }
  })

  it('has no pack for a platform the artifact does not publish', async () => {
    const { packFor } = await import('../src/index.js')
    const artifact = artifactById('pandoc')
    expect(() => packFor(artifact, { os: 'sunos', arch: 'sparc' })).toThrow(/没有 sunos-sparc 的发布包/)
  })
})

describe('offline and auto_install=false', () => {
  it('fails with the reason instead of fetching', async () => {
    const artifact = artifactById('faketool')
    const fixture = await buildTarGzFixture({ base: workspace, root: 'FIXTURE_ROOT', binary: 'faketool', version: '9.9' })
    pointAt(fixture, '/never-requested.tar.gz')
    const { toolsDir, config } = fixtureSetup()
    const before = server.requested.length

    const offline = await ensure('faketool', { toolsDir, config, logger: silentLogger, force: true, offline: true })
    expect(offline.ok).toBe(false)
    expect(offline.error).toContain('offline')

    // The config is what this case is about, so the env kill switch (set to '1' for this file) must
    // not be what answers it.
    const previous = process.env['AVANTF_MEM_AUTO_DOWNLOAD']
    delete process.env['AVANTF_MEM_AUTO_DOWNLOAD']
    try {
      const disabled = await ensure('faketool', {
        toolsDir,
        config: { ...config, auto_install: false },
        logger: silentLogger,
        force: true,
      })
      expect(disabled.ok).toBe(false)
      expect(disabled.error).toContain('auto_install=false')
      expect(server.requested.length).toBe(before)
    } finally {
      process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = previous ?? '1'
    }
  })
})
