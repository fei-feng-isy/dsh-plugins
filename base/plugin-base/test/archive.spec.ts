import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises'
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

  it('保留归档里可执行物的真实文件名（Windows 的 `<binary>.exe` 不再退化成 `<binary>`）', async () => {
    // A Windows pack declares the executable by NAME (`pandoc`) while the archive ships `pandoc.exe`,
    // and Windows cannot execute a PE image under a name without the extension. Installing it as
    // `bin/demo` made the mandatory `--version` probe fail and quarantined the fresh download —
    // measured on DSH Desktop, where pandoc then could not convert anything. The manifest's entry is
    // what `probe`/`verify` read back, so it has to carry the real name.
    const bytes = tarGz([{ name: 'demo-1.0.0/bin/demo.exe', data: '#!/bin/sh\necho demo 1.0.0\n' }])
    const created = provisioner(archiveFetcher(bytes))
    created.declare({ plugin: 'mem', items: [item({ spec: specWith({ url: 'https://archive.test/demo.tgz', sha256: sha256Of(bytes) }) })] } as Manifest)

    const report = await created.ensure()
    expect(report.ok).toBe(true)
    expect(await exists(fs, join(home, 'tools', 'demo', '1.0.0', 'bin', 'demo.exe'))).toBe(true)
    expect(await exists(fs, join(home, 'tools', 'demo', '1.0.0', 'bin', 'demo'))).toBe(false)
    const manifest = JSON.parse(await readFile(join(home, 'tools', 'demo', '1.0.0', 'install.json'), 'utf8')) as { entry?: string }
    expect(manifest.entry).toBe('bin/demo.exe')
    expect(created.resolve('mem:demo').state).toBe('ready')
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

  // ── M2：探针必须解析 stdout，而不是把退出码当成"就是钉住的那个版本" ──────────────────────
  it('PATH 上的同名二进制报告别的版本 ⇒ 不算命中（旧代码只看退出码即当作 1.0.0）', async () => {
    const dir = join(home, 'fake-bin')
    await mkdir(dir, { recursive: true })
    const fake = join(dir, 'demo')
    await writeFile(fake, '#!/bin/sh\necho demo 9.9.9\n')
    await chmod(fake, 0o755)
    const original = process.env['PATH']
    process.env['PATH'] = dir
    try {
      const created = provisioner(archiveFetcher(new Uint8Array()))
      created.declare({ plugin: 'mem', items: [item({ spec: { id: 'demo', version: '1.0.0', packs: {} } })] } as Manifest)
      const report = await created.ensure({ offline: true })
      expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'policy/offline' })
      expect(created.resolve('mem:demo').state).toBe('skipped')
    } finally {
      if (original === undefined) delete process.env['PATH']
      else process.env['PATH'] = original
    }
  })

  it('输出合法版本号 ⇒ 命中', async () => {
    const explicit = join(home, 'external', 'demo')
    await mkdir(join(home, 'external'), { recursive: true })
    await writeFile(explicit, '#!/bin/sh\necho demo 1.0.0\n')
    await chmod(explicit, 0o755)
    const created = provisioner(archiveFetcher(new Uint8Array()))
    created.declare({ plugin: 'mem', items: [item({ spec: { id: 'demo', version: '1.0.0', entry: explicit, packs: {} } })] } as Manifest)
    const report = await created.ensure({ offline: true })
    expect(report.entries[0]).toMatchObject({ action: 'present', source: 'explicit', version: '1.0.0' })
  })

  // ── N13：发行版/构建后缀不是版本身份的一部分，纯数字 pin 按"数字核"比对 ──────────────────────
  /** Install a fake binary that prints `line`, and probe it against `expected`. */
  async function probeSays(line: string, expected: string) {
    const explicit = join(home, 'external', 'demo')
    await mkdir(join(home, 'external'), { recursive: true })
    await writeFile(explicit, `#!/bin/sh\necho "${line}"\n`)
    await chmod(explicit, 0o755)
    const created = provisioner(archiveFetcher(new Uint8Array()))
    created.declare({
      plugin: 'mem',
      items: [item({ spec: { id: 'demo', version: expected, entry: explicit, packs: {} } })],
    } as Manifest)
    return created.ensure({ offline: true })
  }

  it('发行版后缀与期望的纯数字版本命中：4.4.2-0ubuntu0.22.04.1 vs 4.4.2（实测形状）', async () => {
    // Measured on `ffmpeg 4.4.2-0ubuntu0.22.04.1` against a pin of `4.4.2`: the old exact-token rule
    // said MISS and re-downloaded a tool that was already the pinned version.
    const report = await probeSays('ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c)', '4.4.2')
    expect(report.entries[0]).toMatchObject({ action: 'present', source: 'explicit', version: '4.4.2' })
  })

  it('构建后缀（+build）与前缀 v 也一样命中', async () => {
    const report = await probeSays('demo v1.2.3+2026-10-02', '1.2.3')
    expect(report.entries[0]).toMatchObject({ action: 'present', version: '1.2.3' })
  })

  it('主次版本确实不同仍判 MISS（数字核整段比对，不是字符串前缀）', async () => {
    // 4.5.0 is not 4.4.2, and 4.4 is not 4.4.2 either — a prefix rule would wrongly accept the latter.
    const minor = await probeSays('demo 4.5.0', '4.4.2')
    expect(minor.entries[0]?.action).not.toBe('present')
    const shorter = await probeSays('demo 4.4', '4.4.2')
    expect(shorter.entries[0]?.action).not.toBe('present')
    const longer = await probeSays('demo 1.0.0.1', '1.0.0')
    expect(longer.entries[0]?.action).not.toBe('present')
  })

  it('期望本身带后缀（不是纯数字）⇒ 退回全等：后缀属于被 pin 的身份', async () => {
    const exact = await probeSays('demo 1.2.3-rc.1', '1.2.3-rc.1')
    expect(exact.entries[0]).toMatchObject({ action: 'present', version: '1.2.3-rc.1' })
    // The SAME numeric core without the pinned prerelease suffix must NOT match.
    const bare = await probeSays('demo 1.2.3', '1.2.3-rc.1')
    expect(bare.entries[0]?.action).not.toBe('present')
    // …and neither may a different prerelease of the same core.
    const other = await probeSays('demo 1.2.3-rc.2', '1.2.3-rc.1')
    expect(other.entries[0]?.action).not.toBe('present')
  })

  it('versionArgs 为空 ⇒ 存在但版本未知（旧代码照抄 spec.version）', async () => {
    const explicit = join(home, 'external', 'demo')
    await mkdir(join(home, 'external'), { recursive: true })
    await writeFile(explicit, '#!/bin/sh\necho demo 1.0.0\n')
    await chmod(explicit, 0o755)
    const created = provisioner(archiveFetcher(new Uint8Array()))
    created.declare({ plugin: 'mem', items: [item({ spec: { id: 'demo', version: '1.0.0', entry: explicit, versionArgs: [], packs: {} } })] } as Manifest)
    const report = await created.ensure({ offline: true })
    expect(report.entries[0]).toMatchObject({ action: 'present', source: 'explicit' })
    expect(report.entries[0]?.version).toBeUndefined()
    const state = created.resolve('mem:demo')
    expect(state.state).toBe('ready')
    if (state.state === 'ready') expect(state.handle.version).toBeUndefined()
  })

  it('install.json 的 entry 跳出版本目录 ⇒ 不采信（旧代码会 join 到 home 之外）', async () => {
    const versionDir = join(home, 'tools', 'demo', '1.0.0')
    await mkdir(versionDir, { recursive: true })
    await writeFile(
      join(versionDir, 'install.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'demo',
        version: '1.0.0',
        dir: '1.0.0',
        entry: '../../../outside/demo',
        installed_at: new Date(0).toISOString(),
        source: 'installed',
        layout: 'v1',
      }),
    )
    await mkdir(join(home, 'outside'), { recursive: true })
    await writeFile(join(home, 'outside', 'demo'), '#!/bin/sh\necho demo 1.0.0\n')
    await chmod(join(home, 'outside', 'demo'), 0o755)
    const original = process.env['PATH']
    process.env['PATH'] = ''
    try {
      const created = provisioner(archiveFetcher(new Uint8Array()))
      created.declare({ plugin: 'mem', items: [item({ spec: { id: 'demo', version: '1.0.0', packs: {} } })] } as Manifest)
      const report = await created.ensure({ offline: true })
      expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'policy/offline' })
      expect(created.resolve('mem:demo').state).toBe('skipped')
    } finally {
      if (original === undefined) delete process.env['PATH']
      else process.env['PATH'] = original
    }
  })
})
