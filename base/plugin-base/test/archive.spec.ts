import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs, exists } from '../src/fs.js'
import { platformKey } from '../src/net.js'
import { createProvisioner } from '../src/provisioner.js'
import { binaryArchiveProvider } from '../src/providers/archive.js'
import type { Manifest, ProvisionItem, ProvisionLogger } from '../src/types.js'
import { tarGz } from './helpers/tar.js'
import { buildZip } from './helpers/zip.js'
import { removeHome } from './helpers/tmp.js'

const silent: ProvisionLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const key = platformKey()

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function archiveTarball(script: string): Uint8Array {
  return tarGz([
    { name: 'demo-1.0.0/bin/demo', data: script },
    { name: 'demo-1.0.0/README', data: 'demo\n' },
  ])
}

function archiveFetcher(bytes: Uint8Array): typeof fetch {
  return (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch
}

function item(overrides: Partial<ProvisionItem> = {}): ProvisionItem {
  return {
    id: 'mem:demo',
    kind: 'binary-archive',
    spec: { id: 'demo', version: '1.0.0', packs: {} },
    target: { root: 'tools' },
    schemaVersion: 1,
    ...overrides,
  }
}

function specWith(pack: { url: string; sha256: string; archive?: 'tar.gz' | 'zip'; binary?: string }): unknown {
  return { id: 'demo', version: '1.0.0', packs: { [key]: pack } }
}

describe('binary-archive provider', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-archive-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(fetchImpl: typeof fetch): ReturnType<typeof createProvisioner> {
    const created = createProvisioner({ home, logger: silent, fs, fetch: fetchImpl })
    created.register(binaryArchiveProvider())
    return created
  }

  it('plan() 由 provider 的纯 plan 回答"装什么、从哪装"，不必等联网', async () => {
    const bytes = archiveTarball('#!/bin/sh\necho demo 1.0.0\n')
    const created = provisioner(archiveFetcher(bytes))
    created.declare({ plugin: 'mem', items: [item({ spec: specWith({ url: 'https://archive.test/demo.tgz', sha256: sha256Of(bytes) }) })] } as Manifest)

    const planned = await created.plan()
    // The spec pins the version and the platform decides the pack: both are pure facts.
    expect(planned.entries[0]).toMatchObject({ action: 'install', version: '1.0.0', urls: ['https://archive.test/demo.tgz'] })
  })

  it('tar.gz：下载 → sha256 → 解包到 bin/ → --version 探测通过', async () => {
    const bytes = archiveTarball('#!/bin/sh\necho demo 1.0.0\n')
    const created = provisioner(archiveFetcher(bytes))
    created.declare({ plugin: 'mem', items: [item({ spec: specWith({ url: 'https://archive.test/demo.tgz', sha256: sha256Of(bytes) }) })] } as Manifest)

    const report = await created.ensure()
    expect(report.ok).toBe(true)
    expect(report.entries[0]).toMatchObject({ action: 'installed', version: '1.0.0', key: 'binary-archive+demo' })

    const binary = join(home, 'tools', 'demo', '1.0.0', 'bin', 'demo')
    expect(await exists(fs, binary)).toBe(true)
    expect(await readFile(binary, 'utf8')).toContain('demo 1.0.0')

    const state = created.resolve('mem:demo')
    expect(state.state).toBe('ready')
    if (state.state === 'ready') {
      expect(state.handle.source).toBe('installed')
      expect(state.handle.dir).toBe(join(home, 'tools', 'demo', '1.0.0', 'bin'))
      expect(state.handle.env['PATH']?.startsWith(join(home, 'tools', 'demo', '1.0.0', 'bin'))).toBe(true)
    }

    const again = await created.ensure()
    expect(again.entries[0]?.action).toBe('present')
  })

  it('zip：store 与 deflate 打出的包同样能装', async () => {
    const bytes = buildZip([
      { name: 'demo-1.0.0/bin/demo', data: '#!/bin/sh\necho demo 1.0.0\n', deflate: true },
      { name: 'demo-1.0.0/README', data: 'demo\n' },
    ])
    const created = provisioner(archiveFetcher(bytes))
    created.declare({
      plugin: 'mem',
      items: [item({ spec: specWith({ url: 'https://archive.test/demo.zip', sha256: sha256Of(bytes), archive: 'zip' }) })],
    } as Manifest)
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    expect(await exists(fs, join(home, 'tools', 'demo', '1.0.0', 'bin', 'demo'))).toBe(true)
  })

  it('sha256 不符 ⇒ 失败且不落盘', async () => {
    const bytes = archiveTarball('#!/bin/sh\necho demo 1.0.0\n')
    const created = provisioner(archiveFetcher(bytes))
    created.declare({
      plugin: 'mem',
      items: [item({ spec: specWith({ url: 'https://archive.test/demo.tgz', sha256: 'deadbeef' }) })],
    } as Manifest)
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'archive/integrity-mismatch' })
    expect(await exists(fs, join(home, 'tools', 'demo'))).toBe(false)
  })

  it('没有当前平台的 pack ⇒ archive/no-platform-pack', async () => {
    const bytes = archiveTarball('#!/bin/sh\necho demo 1.0.0\n')
    const created = provisioner(archiveFetcher(bytes))
    created.declare({
      plugin: 'mem',
      items: [item({ spec: { id: 'demo', version: '1.0.0', packs: { 'plan9-vax': { url: 'x', sha256: 'y' } } } })],
    } as Manifest)
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'archive/no-platform-pack' })
  })

  it('显式路径优先，且不落盘', async () => {
    const explicit = join(home, 'external', 'demo')
    await fs.mkdir(join(home, 'external'))
    await writeFile(explicit, '#!/bin/sh\necho demo 1.0.0\n')
    await chmod(explicit, 0o755)
    const created = provisioner(archiveFetcher(new Uint8Array()))
    created.declare({ plugin: 'mem', items: [item({ spec: { id: 'demo', version: '1.0.0', entry: explicit, packs: {} } })] } as Manifest)
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'present', source: 'explicit' })
    expect(await exists(fs, join(home, 'tools', 'demo'))).toBe(false)
  })

  it('--version 探针失败 ⇒ verify/failed 且隔离', async () => {
    const bytes = archiveTarball('#!/bin/sh\nexit 3\n')
    const created = provisioner(archiveFetcher(bytes))
    created.declare({
      plugin: 'mem',
      items: [item({ spec: specWith({ url: 'https://archive.test/demo.tgz', sha256: sha256Of(bytes) }) })],
    } as Manifest)
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })
    expect(await exists(fs, join(home, 'tools', 'demo', '1.0.0'))).toBe(false)
    expect(await fs.readdir(join(home, '.envinit', '.quarantine'))).toHaveLength(1)
  })
})
