/**
 * Regression tests for previously fixed defects.
 *
 * One test per fixed defect, so a re-introduction fails loudly: the npm selection filter,
 * `verify`'s loadability, package-name confinement, peer ranges, the archive install/verify
 * agreement, per-revision model probes, record-driven plans, shutdown and capability honesty,
 * the wildcard/prerelease and partial-comparator rules, and the mirrors / onMissing /
 * provider-scan findings of this round.
 *
 * @module test/fixes
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CAPABILITIES, createProvisioner, normalizeOnMissing } from '../src/provisioner.js'
import { assertRange, satisfiesRange } from '../src/semver.js'
import { defaultFs, exists } from '../src/fs.js'
import { lintManifest } from '../src/lint.js'
import { aliasLegacyManifest, readInstallManifest } from '../src/manifest.js'
import { DEFAULT_MAX_BYTES, METADATA_MAX_BYTES, platformKey } from '../src/net.js'
import { binaryArchiveProvider } from '../src/providers/archive.js'
import { modelCacheProvider } from '../src/providers/model.js'
import { npmPackageProvider, packageDirOf } from '../src/providers/npm.js'
import type { InstallContext, Manifest, ProgressEvent, Provider, ProvisionItem, ProvisionLogger } from '../src/types.js'
import { integrityOf, packageTarball, registryFor } from './helpers/registry.js'
import { tarGz } from './helpers/tar.js'
import { removeHome } from './helpers/tmp.js'

const KEY = platformKey()

function logger(): { readonly lines: string[]; readonly log: ProvisionLogger } {
  const lines: string[] = []
  return {
    lines,
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => lines.push(message),
      error: () => undefined,
    },
  }
}

function npmItem(overrides: Partial<ProvisionItem> = {}): ProvisionItem {
  return {
    id: 'mem:demo',
    kind: 'npm-package',
    spec: { name: 'demo-pkg', range: '^1.0.0' },
    target: { root: 'runtime' },
    schemaVersion: 1,
    ...overrides,
  }
}

function manifestOf(items: readonly ProvisionItem[]): Manifest {
  return { plugin: 'mem', items }
}

/** A packument with several versions, each with its own `engines`/`os`/`deprecated` markers. */
function multiVersionRegistry(
  versions: readonly { readonly version: string; readonly engines?: { readonly node?: string }; readonly os?: readonly string[]; readonly deprecated?: string }[],
  tarball: Uint8Array,
  integrity: string,
): typeof fetch {
  const entries: Record<string, unknown> = {}
  for (const row of versions) {
    entries[row.version] = {
      dist: { tarball: `https://registry.test/demo-pkg/-/demo-pkg-${row.version}.tgz`, integrity },
      ...(row.engines === undefined ? {} : { engines: row.engines }),
      ...(row.os === undefined ? {} : { os: row.os }),
      ...(row.deprecated === undefined ? {} : { deprecated: row.deprecated }),
    }
  }
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.endsWith('.tgz')) return new Response(tarball, { status: 200 })
    return new Response(JSON.stringify({ versions: entries }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('修复回归：npm provider 选版', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(fetchImpl: typeof fetch, log: ProvisionLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }) {
    const created = createProvisioner({ home, logger: log, fs, fetch: fetchImpl })
    created.register(npmPackageProvider())
    return created
  }

  it('engines.node 不满足的最新版被跳过，而不是整体报"无满足版本"', async () => {
    const tarball = packageTarball()
    const integrity = integrityOf(tarball)
    const created = provisioner(
      multiVersionRegistry(
        [
          { version: '1.4.0', engines: { node: '>=99.0.0' } },
          { version: '1.3.0', engines: { node: '>=18.0.0' } },
        ],
        tarball,
        integrity,
      ),
    )
    created.declare(manifestOf([npmItem()]))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed', version: '1.3.0' })
  })

  it('os 不匹配的版本被跳过', async () => {
    const tarball = packageTarball()
    const integrity = integrityOf(tarball)
    const created = provisioner(
      multiVersionRegistry(
        [
          { version: '1.3.0', os: ['plan9'] },
          { version: '1.2.0' },
        ],
        tarball,
        integrity,
      ),
    )
    created.declare(manifestOf([npmItem()]))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed', version: '1.2.0' })
  })

  it('deprecated 版本默认跳过；区间点名时才用', async () => {
    const tarball = packageTarball()
    const integrity = integrityOf(tarball)
    const versions = [
      { version: '1.4.0', deprecated: 'CVE-2099-0001' },
      { version: '1.3.0' },
    ]
    const skipped = provisioner(multiVersionRegistry(versions, tarball, integrity))
    skipped.declare(manifestOf([npmItem()]))
    expect((await skipped.ensure()).entries[0]).toMatchObject({ action: 'installed', version: '1.3.0' })

    const pinned = provisioner(multiVersionRegistry(versions, tarball, integrity))
    pinned.declare(manifestOf([npmItem({ spec: { name: 'demo-pkg', range: '1.4.0' } })]))
    expect((await pinned.ensure()).entries[0]).toMatchObject({ action: 'installed', version: '1.4.0' })
  })
})

describe('修复回归：npm provider 准入', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  it('入口文件缺失 ⇒ verify/failed + 隔离（不再静默 ready）', async () => {
    // `exports` points at a file the tarball does not contain: a real publishing mistake.
    const tarball = packageTarball({ packageJson: { exports: { '.': { default: './dist/missing.js' } } } })
    const captured = logger()
    const created = createProvisioner({ home, logger: captured.log, fs, fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)) })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })
    expect(captured.lines.join(' ')).toContain('quarantined')
    const quarantined = await readdir(join(home, '.envinit', '.quarantine'))
    expect(quarantined.length).toBe(1)
  })

  it('非法包名 ⇒ declare 立即拒绝（lint 也在构建期拦），且不落盘', async () => {
    const created = createProvisioner({
      home,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      fs,
      fetch: registryFor('demo-pkg', '1.0.0', packageTarball(), 'sha512-AAAA'),
    })
    created.register(npmPackageProvider())
    // A package name becomes a path segment, so it is checked where the item first meets a provider.
    expect(() => created.declare(manifestOf([npmItem({ spec: { name: '../../evil', range: '^1.0.0' } })]))).toThrow(/包名/)
    expect(await exists(fs, join(home, 'runtime'))).toBe(false)

    // And the offline lint reports it before any build ships.
    const findings = lintManifest({
      plugin: 'mem',
      items: [npmItem({ spec: { name: '../../evil', range: '^1.0.0' } })],
    } as Manifest)
    expect(findings.findings.map(finding => finding.rule)).toContain('lint/spec-shape')
  })

  it('peer 版本不满足区间 ⇒ peer/unsatisfied（不再照报成功）', async () => {
    const peerDir = join(home, 'peers', 'solo')
    await mkdir(peerDir, { recursive: true })
    await writeFile(join(peerDir, 'package.json'), JSON.stringify({ name: 'solo', version: '1.0.0' }))

    const tarball = packageTarball({ packageJson: { peerDependencies: { solo: '^2.0.0' } } })
    const created = createProvisioner({ home, logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }, fs, fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)) })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem({ spec: { name: 'demo-pkg', range: '^1.0.0', peers: [{ name: 'solo', dir: peerDir }] } })]))

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'peer/unsatisfied' })
  })

  it('peer 版本满足区间 ⇒ 链进版本目录', async () => {
    const peerDir = join(home, 'peers', 'solo')
    await mkdir(peerDir, { recursive: true })
    await writeFile(join(peerDir, 'package.json'), JSON.stringify({ name: 'solo', version: '2.1.0' }))

    const tarball = packageTarball({ packageJson: { peerDependencies: { solo: '^2.0.0' } } })
    const created = createProvisioner({ home, logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }, fs, fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)) })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem({ spec: { name: 'demo-pkg', range: '^1.0.0', peers: [{ name: 'solo', dir: peerDir }] } })]))

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    expect(await exists(fs, join(home, 'runtime', 'demo-pkg', '1.0.0', 'node_modules', 'solo', 'package.json'))).toBe(true)
  })
})

describe('修复回归：archive 的入口一致性', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  it('pack 级 binary 不再造成 install/verify 分歧与隔离循环', async () => {
    const tarball = tarGz([
      { name: 'demo-1.0.0/bin/demo-1.0.0', data: '#!/bin/sh\necho demo 1.0.0\n' },
    ])
    const sha256 = createHash('sha256').update(tarball).digest('hex')
    const created = createProvisioner({
      home,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      fs,
      fetch: (async () => new Response(tarball, { status: 200 })) as unknown as typeof fetch,
    })
    created.register(binaryArchiveProvider())
    created.declare(
      manifestOf([
        {
          id: 'mem:demo',
          kind: 'binary-archive',
          // The pack names the binary; the spec does not. install and verify must still agree.
          spec: { id: 'demo', version: '1.0.0', packs: { [KEY]: { url: 'https://x/demo.tgz', sha256, binary: 'demo-1.0.0' } } },
          target: { root: 'tools' },
          schemaVersion: 1,
        },
      ]),
    )

    const first = await created.ensure()
    expect(first.entries[0]).toMatchObject({ action: 'installed' })
    const second = await created.ensure()
    expect(second.entries[0]).toMatchObject({ action: 'present' })
    expect(await exists(fs, join(home, '.envinit', '.quarantine'))).toBe(false)
  })
})

describe('修复回归：model-cache 的逐 revision 语义', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  it('未下载的 revision 不会被报成 ready（不再回退到别的 snapshot）', async () => {
    // `main` is cached; `v2` never was. The probe for `v2` must miss.
    const snapshot = join(home, 'models', 'models--BAAI--bge-small-zh-v1.5', 'snapshots', 'a'.repeat(40))
    await mkdir(snapshot, { recursive: true })
    await writeFile(join(snapshot, 'config.json'), '{}')
    const refs = join(home, 'models', 'models--BAAI--bge-small-zh-v1.5', 'refs')
    await mkdir(refs, { recursive: true })
    await writeFile(join(refs, 'main'), 'a'.repeat(40))

    const created = createProvisioner({
      home,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      fs,
      fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
    })
    created.register(modelCacheProvider())
    created.declare(
      manifestOf([
        {
          id: 'mem:model',
          kind: 'model-cache',
          spec: { repo: 'BAAI/bge-small-zh-v1.5', revision: 'v2' },
          target: { root: 'models' },
          schemaVersion: 1,
        },
      ]),
    )

    const planned = await created.plan()
    expect(planned.entries[0]?.action).not.toBe('present')
    const report = await created.ensure()
    expect(report.entries[0]?.action).toBe('failed') // the endpoint is a 404 in this test
  })
})

describe('修复回归：plan 由解析记录驱动', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  it('副本被删但记录还在 ⇒ plan 报 install 与记录里的版本（不猜版本）', async () => {
    const tarball = packageTarball()
    const created = createProvisioner({
      home,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      fs,
      fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)),
    })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))
    await created.ensure()

    await rm(join(home, 'runtime', 'demo-pkg', '1.0.0'), { recursive: true, force: true })
    const planned = await created.plan()
    expect(planned.entries[0]).toMatchObject({ action: 'install', version: '1.0.0' })
  })
})

describe('修复回归：关停与能力位', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  it('dispose() 中止在飞请求，并把该项记为失败（不留在 pending）', async () => {
    // A request that never answers on its own. It honours an *already aborted* signal too: `dispose()`
    // can land before this request is even issued, and a listener added after the fact would never fire.
    const hanging: typeof fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted === true) {
          reject(new Error('aborted'))
          return
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch

    const created = createProvisioner({ home, logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }, fs, fetch: hanging, policy: { deadlineMs: 5 } })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))
    await created.ensure()
    expect(created.resolve('mem:demo').state).toBe('pending')

    created.dispose()
    // Poll instead of sleeping a fixed 20 ms: under parallel load the abort needs a moment to travel
    // through the hanging request, and a fixed sleep is what made this test flaky.
    const deadline = Date.now() + 2_000
    while (created.resolve('mem:demo').state !== 'failed' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(created.resolve('mem:demo').state).toBe('failed')
  })

  it('CAPABILITIES 不再宣称未实现的 prune，调用它会有警告', async () => {
    expect(CAPABILITIES).not.toContain('prune')
    const captured = logger()
    const created = createProvisioner({ home, logger: captured.log, fs })
    await created.experimental().prune()
    expect(captured.lines.join(' ')).toContain('尚未实现')
  })

  it('onMissing 的逐轴缺省不变（非法值按该轴缺省）', () => {
    expect(normalizeOnMissing({ atStartup: 'refuse' })).toEqual({ atStartup: 'refuse', atUse: 'error' })
    expect(normalizeOnMissing({ atUse: 'degrade' })).toEqual({ atStartup: 'degrade', atUse: 'degrade' })
    // Omitting the object and passing `{}` are the SAME request: each axis takes its documented
    // default. They used to disagree on `atUse` (`degrade` vs `error`), so "declare no preference"
    // and "declare an empty preference" quietly meant two different things.
    expect(normalizeOnMissing(undefined)).toEqual({ atStartup: 'degrade', atUse: 'error' })
    expect(normalizeOnMissing(undefined)).toEqual(normalizeOnMissing({}))
  })
})

describe('修复回归：子集与 lint', () => {
  it('合法预发布版本不再被 x 通配检查误杀', () => {
    expect(() => assertRange('1.0.0-next.1')).not.toThrow()
    expect(() => assertRange('>=1.0.0-experimental')).not.toThrow()
    expect(satisfiesRange('1.0.0-next.2', '>=1.0.0-next.1')).toBe(true)
    // Real wildcards are still rejected.
    expect(() => assertRange('1.2.x')).toThrow()
    expect(() => assertRange('1.x')).toThrow()
  })

  it('lint 拒绝含 `*` 的区间（它匹配一切）', () => {
    const result = lintManifest({
      plugin: 'mem',
      items: [{ id: 'mem:demo', kind: 'npm-package', spec: { name: 'demo-pkg', range: '^1.0.0 || *' }, target: { root: 'runtime' }, schemaVersion: 1 }],
    } as Manifest)
    expect(result.findings.map(finding => finding.rule)).toContain('lint/range-star')
  })

  it('lint 要求所有 item id 前缀化（不再放行历史 id）', () => {
    const result = lintManifest({
      plugin: 'mem',
      items: [
        { id: 'pandoc', kind: 'binary-archive', spec: { id: 'pandoc', version: '3.11', packs: {} }, target: { root: 'tools' }, schemaVersion: 1 },
        { id: 'model', kind: 'model-cache', spec: { repo: 'org/name' }, target: { root: 'models' }, schemaVersion: 1 },
      ],
    } as Manifest)
    expect(result.findings.filter(finding => finding.rule === 'lint/id-prefix')).toHaveLength(2)
  })
})

describe('修复回归：内部件不在公开入口', () => {
  it('版本目录里不再有整仓缓存（model 的 dir 是 snapshot）', async () => {
    // Covered behaviourally in model.spec.ts; this pins the contract the core relies on when it
    // quarantines `Resolved.dir`: that value is always the published unit.
    const provider: Provider = modelCacheProvider()
    expect(provider.kinds).toEqual(['model-cache'])
    const item: ProvisionItem = { id: 'mem:model', kind: 'model-cache', spec: { repo: 'x/y' }, target: { root: 'models' }, schemaVersion: 1 }
    expect(provider.targetDir(item, { name: 'x/y', version: 'main', segment: 'main' })).toBe('models--x--y/main')
  })
})

describe('修复回归：下载体上限', () => {
  it('声明或实际超过上限的响应体被拒绝（fetch/too-large，终局）', async () => {
    const { readCapped } = await import('../src/net.js')
    const declared = new Response(new Uint8Array(4), { status: 200, headers: { 'content-length': '2048' } })
    await expect(readCapped(declared, 1024)).rejects.toMatchObject({ code: 'fetch/too-large' })

    const actual = new Response(new Uint8Array(2048), { status: 200 })
    await expect(readCapped(actual, 1024)).rejects.toMatchObject({ code: 'fetch/too-large' })

    const ok = new Response(new Uint8Array(16), { status: 200, headers: { 'content-length': '16' } })
    await expect(readCapped(ok, 1024)).resolves.toHaveLength(16)
  })
})

describe('修复回归：install.json 的兼容读入', () => {
  it('旧 pandoc manifest 的十六进制 sha256 被映射成 SRI base64，binary 成为 bin/<binary>', () => {
    const hex = 'a'.repeat(64)
    const aliased = aliasLegacyManifest({ id: 'pandoc', version: '3.11', sha256: hex, url: 'https://x/pandoc.tgz', binary: 'pandoc' }, 'binary-archive')
    expect(aliased['integrity']).toBe(`sha256-${Buffer.from(hex, 'hex').toString('base64')}`)
    expect(aliased['entry']).toBe('bin/pandoc')
  })

  it('读入旧形状时 schemaVersion 视为 0，且不缺 integrity 字段', () => {
    const manifest = readInstallManifest(
      {
        id: 'pandoc',
        version: '3.11',
        binary: 'pandoc',
        url: 'https://example.test/pandoc.tgz',
        sha256: 'b'.repeat(64),
        installed_at: '2026-01-01T00:00:00.000Z',
      },
      'binary-archive',
    )
    expect(manifest).toMatchObject({
      name: 'pandoc',
      version: '3.11',
      schemaVersion: 0,
      entry: 'bin/pandoc',
      tarball: 'https://example.test/pandoc.tgz',
    })
    expect(manifest?.integrity).toMatch(/^sha256-/)
  })
})

describe('修复回归：发布临界区与原子性', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  it('发布只 rename：目标从不被 rm，且 rename 时锁已持有、manifest 已在 staging 里', async () => {
    const tarball = packageTarball()
    const renames: { readonly from: string; readonly to: string; readonly locked: boolean; readonly manifestStaged: boolean }[] = []
    const removed: string[] = []
    const inner = defaultFs()
    const targetRoot = join(home, 'runtime')
    const wrapped = {
      ...inner,
      async rename(from: string, to: string) {
        if (to.startsWith(targetRoot)) {
          renames.push({
            from,
            to,
            locked: await exists(inner, join(home, '.envinit', '.lock')),
            manifestStaged: await exists(inner, join(from, 'install.json')),
          })
        }
        await inner.rename(from, to)
      },
      async rm(path: string, options?: { recursive?: boolean }) {
        removed.push(path)
        await inner.rm(path, options)
      },
    }
    const created = createProvisioner({
      home,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      fs: wrapped,
      fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)),
    })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))
    await created.ensure()

    expect(renames).toHaveLength(1)
    expect(renames[0]?.locked).toBe(true)
    // The manifest is written into staging, so the rename publishes directory and manifest together.
    expect(renames[0]?.manifestStaged).toBe(true)
    // Nothing may have been removed from under the resource root ("只增不改").
    expect(removed.filter(path => path.startsWith(targetRoot))).toEqual([])
  })

  it('provider 的 Disposable 真的卸载注册', async () => {
    const created = createProvisioner({ home, logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }, fs })
    const registration = created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))
    registration.dispose()
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'unknown-provider' })
  })

  it('缺 integrity 的旧副本被复用，但在日志里被标为 unverifiable', async () => {
    const versionDir = join(home, 'runtime', 'demo-pkg', '1.0.0')
    await mkdir(join(versionDir, 'node_modules', 'demo-pkg'), { recursive: true })
    await writeFile(
      join(versionDir, 'install.json'),
      JSON.stringify({ schemaVersion: 0, name: 'demo-pkg', version: '1.0.0', dir: '1.0.0', entryDir: 'node_modules/demo-pkg', installed_at: '2026-01-01T00:00:00.000Z', source: 'installed', layout: 'v1' }),
    )
    await writeFile(join(versionDir, 'node_modules', 'demo-pkg', 'package.json'), JSON.stringify({ name: 'demo-pkg', version: '1.0.0' }))

    const captured = logger()
    const created = createProvisioner({ home, logger: captured.log, fs, fetch: registryFor('demo-pkg', '1.0.0', packageTarball(), 'sha512-AAAA') })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'present' })
    expect(captured.lines.join(' ')).toContain('unverifiable')
  })

  it('没有满足区间的版本 ⇒ npm/no-satisfying-version', async () => {
    const tarball = packageTarball()
    const created = createProvisioner({
      home,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      fs,
      fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)),
    })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem({ spec: { name: 'demo-pkg', range: '^9.0.0' } })]))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'npm/no-satisfying-version' })
  })

  it('offline ⇒ 策略性跳过（policy/offline，而不是 failed）', async () => {
    const tarball = packageTarball()
    const created = createProvisioner({
      home,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      fs,
      fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)),
    })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))
    const report = await created.ensure({ offline: true })
    expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'policy/offline' })
  })

  it('预编译原生模块被 verify 拒绝（*.node）', async () => {
    const tarball = packageTarball({ extra: [{ name: 'package/build/addon.node', data: 'binary' }] })
    const created = createProvisioner({
      home,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      fs,
      fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)),
    })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })
    expect(report.entries[0]?.reason).toMatch(/原生模块/)
  })
})

/**
 * Second review round: the fixes above were themselves reviewed, and these are the defects found in
 * them. One test per finding, so a regression fails loudly.
 */
describe('第二轮修复回归', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix2-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(fetchImpl: typeof fetch, log?: ProvisionLogger) {
    const created = createProvisioner({ home, logger: log ?? { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }, fs, fetch: fetchImpl })
    created.register(npmPackageProvider())
    return created
  }

  it('F1 plan() 的记录按 item 区间过滤：区间不接受记录版本 ⇒ unknown，接受 ⇒ install', async () => {
    const tarball = packageTarball()
    const registry = registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball))
    const first = provisioner(registry)
    first.declare(manifestOf([npmItem()]))
    await first.ensure()

    // The copy is gone, so only the record can answer — and it must fit *this* item's range.
    await rm(join(home, 'runtime', 'demo-pkg', '1.0.0'), { recursive: true, force: true })
    const inside = provisioner(registry)
    inside.declare(manifestOf([npmItem()]))
    expect((await inside.plan()).entries[0]).toMatchObject({ action: 'install', version: '1.0.0' })

    const outside = provisioner(registry)
    outside.declare(manifestOf([npmItem({ spec: { name: 'demo-pkg', range: '^2.0.0' } })]))
    const planned = (await outside.plan()).entries[0]
    expect(planned?.action).toBe('unknown')
    expect(planned?.version).toBeUndefined()
  })

  it('F3 历史大写包名可用（路径安全 ≠ npm 的小写策略），越界名仍被拒', async () => {
    const tarball = packageTarball({ name: 'JSONStream' })
    const created = provisioner(registryFor('JSONStream', '1.0.0', tarball, integrityOf(tarball)))
    expect(() =>
      created.declare(manifestOf([npmItem({ spec: { name: 'JSONStream', range: '^1.0.0' } })])),
    ).not.toThrow()
    const report = await created.ensure()
    expect(report.entries[0]?.action).toBe('installed')
    expect(await exists(fs, join(home, 'runtime', 'JSONStream', '1.0.0', 'install.json'))).toBe(true)

    expect(() => created.declare(manifestOf([npmItem({ id: 'mem:bad', spec: { name: '../../evil', range: '^1.0.0' } })]))).toThrow(/包名/)
    expect(() => created.declare(manifestOf([npmItem({ id: 'mem:bad2', spec: { name: 'a/../b', range: '^1.0.0' } })]))).toThrow(/包名/)
  })

  it('F4 main:"" / main:"." 按 npm 语义落到 index.js；畸形的 exports 仍然不可导入', async () => {
    for (const packageJson of [{ main: '' }, { main: '.' }, { main: './' }]) {
      await removeHome(home)
      await mkdir(home, { recursive: true })
      const tarball = packageTarball({ packageJson })
      const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
      created.declare(manifestOf([npmItem()]))
      const report = await created.ensure()
      expect(report.entries[0]?.action, JSON.stringify(packageJson)).toBe('installed')
      expect(await exists(fs, join(home, '.envinit', '.quarantine'))).toBe(false)
    }

    // An empty `exports` target is a real packaging error: Node refuses to import it, so do we.
    await removeHome(home)
    await mkdir(home, { recursive: true })
    const broken = packageTarball({ packageJson: { exports: { '.': '' } } })
    const created = provisioner(registryFor('demo-pkg', '1.0.0', broken, integrityOf(broken)))
    created.declare(manifestOf([npmItem()]))
    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })
  })

  it('F11 unverifiable 每个版本目录只告警一次', async () => {
    const tarball = packageTarball()
    const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    created.declare(manifestOf([npmItem()]))
    await created.ensure()
    // Drop the recorded integrity: the copy stays usable, but not verifiable.
    const manifestPath = join(home, 'runtime', 'demo-pkg', '1.0.0', 'install.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    delete manifest['integrity']
    await writeFile(manifestPath, JSON.stringify(manifest))

    const lines: string[] = []
    const talkative = createProvisioner({ home, logger: { ...logger().log, warn: m => lines.push(m) }, fs, fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)) })
    talkative.register(npmPackageProvider())
    talkative.declare(manifestOf([npmItem()]))
    await talkative.plan()
    await talkative.plan()
    expect(lines.filter(line => line.includes('unverifiable'))).toHaveLength(1)
  })

  it('F10 没有 content-length 的超限响应被流式拒绝，够小的原样读出', async () => {
    const { readCapped } = await import('../src/net.js')
    const streamed = (size: number): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(size))
            controller.enqueue(new Uint8Array(size))
            controller.close()
          },
        }),
      )
    await expect(readCapped(streamed(64), 16)).rejects.toMatchObject({ code: 'fetch/too-large' })
    expect((await readCapped(streamed(4), 16)).byteLength).toBe(8)
    await expect(readCapped(new Response(new Uint8Array(64), { headers: { 'content-length': '64' } }), 16)).rejects.toMatchObject({ code: 'fetch/too-large' })
  })

  it('F6 归档落盘的 integrity 是 SRI base64，且能被 verifyIntegrity 校验', async () => {
    const tarball = tarGz([{ name: 'demo-1.0.0/bin/demo', data: '#!/bin/sh\necho demo 1.0.0\n' }])
    const hex = createHash('sha256').update(tarball).digest('hex')
    const created = createProvisioner({
      home,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      fs,
      fetch: (async () => new Response(tarball, { status: 200 })) as unknown as typeof fetch,
    })
    created.register(binaryArchiveProvider())
    created.declare(
      manifestOf([
        { id: 'mem:demo', kind: 'binary-archive', spec: { id: 'demo', version: '1.0.0', packs: { [KEY]: { url: 'https://x/demo.tgz', sha256: hex } } }, target: { root: 'tools' }, schemaVersion: 1 },
      ]),
    )
    const report = await created.ensure()
    expect(report.entries[0]?.action).toBe('installed')

    const manifest = JSON.parse(await readFile(join(home, 'tools', 'demo', '1.0.0', 'install.json'), 'utf8')) as { integrity: string }
    expect(manifest.integrity).toBe(`sha256-${Buffer.from(hex, 'hex').toString('base64')}`)
    const { verifyIntegrity } = await import('../src/integrity.js')
    expect(() => verifyIntegrity(tarball, manifest.integrity)).not.toThrow()
  })
})

describe('修复回归：框架审查发现（本轮）', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function stubProvider(name: string, onInstall?: (ctx: InstallContext) => void): Provider {
    return {
      id: `@avantf/stub-${name}`,
      kinds: [`plugin:${name}`],
      identify: () => ({ name: 'demo' }),
      probe: async () => ({ found: false }),
      plan: () => ({ action: 'install' }),
      targetDir: (_item, ref) => join('demo', ref.segment),
      install: async (_item, ctx) => {
        onInstall?.(ctx)
        return ctx.publish(await ctx.stage(), { name: 'demo', version: '1.0.0' })
      },
      verify: async () => undefined,
    }
  }

  it('入口用无扩展名的 main（`./index`）也能安装（Node 的 CJS 解析）', async () => {
    const tarball = packageTarball({ packageJson: { main: './index' } })
    const created = createProvisioner({
      home,
      logger: logger().log,
      fs,
      fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)),
    })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))

    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'installed', version: '1.0.0' })
    expect(created.resolve('mem:demo').state).toBe('ready')
  })

  it('repair() 作为首次调用也会先做 layout 准入（只读 home 不落盘）', async () => {
    await mkdir(join(home, '.envinit'), { recursive: true })
    await writeFile(join(home, '.envinit', '.layout.json'), JSON.stringify({ schemaVersion: 99, layout: 'v9', writtenBy: 'test' }))
    const created = createProvisioner({ home, logger: logger().log, fs })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))

    const report = await created.repair('mem:demo')

    expect(report.entries[0]?.code).toBe('layout/too-new')
    expect(created.resolve('mem:demo')).toMatchObject({ state: 'skipped', code: 'layout/too-new' })
  })

  it('repair() 现在会登记声明并落盘 status.json', async () => {
    const created = createProvisioner({ home, logger: logger().log, fs })
    created.register(stubProvider('repair'))
    created.declare({
      plugin: 'mem',
      items: [{ id: 'mem:repair', kind: 'plugin:repair', spec: {}, target: { root: 'runtime' }, schemaVersion: 1 }],
    })

    const report = await created.repair('mem:repair')

    expect(report.entries[0]?.action).toBe('installed')
    const declared = JSON.parse(await readFile(join(home, '.envinit', 'declared.json'), 'utf8')) as Record<string, unknown>
    expect(declared['plugin:repair+demo']).toBeDefined()
    const status = JSON.parse(await readFile(join(home, '.envinit', 'status.json'), 'utf8')) as { rows: readonly unknown[] }
    expect(status.rows.length).toBeGreaterThan(0)
  })

  it('EnsureOptions.onProgress 上接到 InstallContext.onProgress', async () => {
    const events: ProgressEvent[] = []
    const created = createProvisioner({ home, logger: logger().log, fs })
    created.register(
      stubProvider('progress', ctx => {
        ctx.onProgress?.({ key: 'plugin:progress+demo', phase: 'download', loaded: 1, total: 2 })
      }),
    )
    created.declare({
      plugin: 'mem',
      items: [{ id: 'mem:progress', kind: 'plugin:progress', spec: {}, target: { root: 'runtime' }, schemaVersion: 1 }],
    })

    await created.ensure({ onProgress: event => events.push(event) })

    expect(events).toEqual([{ key: 'plugin:progress+demo', phase: 'download', loaded: 1, total: 2 }])
  })

  it('未实现的设置项会告警，而不是静默忽略', async () => {
    const captured = logger()
    const created = createProvisioner({ home, logger: captured.log, fs, policy: { quotaBytes: 1 } })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem({ policy: { concurrency: 2 } })]))
    await created.ensure({ offline: true })

    const text = captured.lines.join(' ')
    expect(text).toContain('policy.quotaBytes')
    expect(text).toContain('mem:demo.policy.concurrency')
  })

  it('lint 拦截未实现的 item policy 键', () => {
    const result = lintManifest(manifestOf([npmItem({ policy: { concurrency: 2 } })]))
    expect(result.ok).toBe(false)
    expect(result.findings.map(finding => finding.rule)).toContain('lint/policy-unimplemented')
  })

  it('运行期 declare 拒绝 needs 成环', () => {
    const created = createProvisioner({ home, logger: logger().log, fs })
    expect(() =>
      created.declare(
        manifestOf([
          npmItem({ id: 'mem:a', needs: ['mem:b'] }),
          npmItem({ id: 'mem:b', needs: ['mem:a'] }),
        ]),
      ),
    ).toThrow(/成环/)
  })
})

describe('修复回归：镜像策略', () => {
  let home: string
  const fs = defaultFs()
  const OFFICIAL = 'https://registry.test/demo-pkg/-/demo-pkg-1.0.0.tgz'
  const MIRROR = `https://npm-mirror.test/${OFFICIAL}`

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function npmItemWithRegistry(overrides: Partial<ProvisionItem> = {}): ProvisionItem {
    return npmItem({ spec: { name: 'demo-pkg', range: '^1.0.0', registry: 'https://registry.test' }, ...overrides })
  }

  /** The official registry answers the packument but refuses the tarball; `hits` records every URL. */
  function deadTarballRegistry(tarball: Uint8Array, integrity: string, hits: string[]): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      hits.push(url)
      if (url === 'https://registry.test/demo-pkg') {
        return new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: OFFICIAL, integrity } } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === OFFICIAL) return new Response('gone', { status: 503 })
      if (url === MIRROR) return new Response(tarball, { status: 200 })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
  }

  it('item policy 的 npm 镜像被真正转发：官方 tarball 失败后按"官方优先"走镜像', async () => {
    const tarball = packageTarball()
    const hits: string[] = []
    const created = createProvisioner({ home, logger: logger().log, fs, fetch: deadTarballRegistry(tarball, integrityOf(tarball), hits) })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItemWithRegistry({ policy: { mirrors: { archive: [], npm: ['https://npm-mirror.test/{url}'] } } })]))
    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'installed', version: '1.0.0' })
    expect(hits[0]).toBe('https://registry.test/demo-pkg')
    expect(hits.indexOf(OFFICIAL)).toBeLessThan(hits.indexOf(MIRROR))
  })

  it('item policy.mirrors 覆盖全局 mirrors.npm（逐字段），全局镜像不再被访问', async () => {
    const tarball = packageTarball()
    const hits: string[] = []
    const created = createProvisioner({
      home,
      logger: logger().log,
      fs,
      policy: { mirrors: { archive: [], npm: ['https://stale-mirror.test/{url}'] } },
      fetch: deadTarballRegistry(tarball, integrityOf(tarball), hits),
    })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItemWithRegistry({ policy: { mirrors: { archive: [], npm: ['https://npm-mirror.test/{url}'] } } })]))
    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    expect(hits.join(' ')).not.toContain('stale-mirror.test')
  })

  it('item 只覆盖 mirrors.npm 时，全局 mirrors.archive 仍然继承（逐字段合并）', async () => {
    const seen: unknown[] = []
    const spy: Provider = {
      id: '@avantf/mirror-spy',
      kinds: ['plugin:mirror-spy'],
      identify: () => ({ name: 'demo' }),
      probe: async (_item, ctx) => {
        seen.push(ctx.policy.mirrors)
        return { found: true, version: '1.0.0', dir: home, source: 'managed' }
      },
      plan: () => ({ action: 'present' }),
      targetDir: (_item, ref) => join('demo', ref.segment),
      install: async () => {
        throw new Error('unused')
      },
      verify: async () => undefined,
    }
    const created = createProvisioner({
      home,
      logger: logger().log,
      fs,
      policy: { mirrors: { archive: ['https://global-archive/{url}'], npm: ['https://global-npm/{url}'] } },
    })
    created.register(spy)
    // A manifest is data: it may name only one axis, and the other must keep the global value.
    created.declare(manifestOf([
      { id: 'mem:spy', kind: 'plugin:mirror-spy', spec: {}, target: { root: 'runtime' }, schemaVersion: 1, policy: { mirrors: { npm: ['https://item-npm/{url}'] } } as never },
    ]))

    await created.ensure()

    expect(seen[0]).toEqual({ archive: ['https://global-archive/{url}'], npm: ['https://item-npm/{url}'] })
  })

  it('全局 mirrors.npm 未被子项覆盖时照常生效', async () => {
    const tarball = packageTarball()
    const hits: string[] = []
    const created = createProvisioner({
      home,
      logger: logger().log,
      fs,
      policy: { mirrors: { archive: [], npm: ['https://npm-mirror.test/{url}'] } },
      fetch: deadTarballRegistry(tarball, integrityOf(tarball), hits),
    })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItemWithRegistry()]))
    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    expect(hits).toContain(MIRROR)
  })

  it('镜像的包体 integrity 不符 ⇒ 直接失败，不换下一个候选源', async () => {
    const tarball = packageTarball()
    const tampered = packageTarball({ entry: 'export const ok = "tampered"\n' })
    const secondMirror = `https://npm-mirror2.test/${OFFICIAL}`
    const hits: string[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      hits.push(url)
      if (url === 'https://registry.test/demo-pkg') {
        return new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: OFFICIAL, integrity: integrityOf(tarball) } } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === OFFICIAL) return new Response('gone', { status: 503 })
      if (url === MIRROR) return new Response(tampered, { status: 200 })
      if (url === secondMirror) return new Response(tarball, { status: 200 })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const created = createProvisioner({ home, logger: logger().log, fs, fetch: fetchImpl })
    created.register(npmPackageProvider())
    created.declare(
      manifestOf([
        npmItemWithRegistry({ policy: { mirrors: { archive: [], npm: ['https://npm-mirror.test/{url}', 'https://npm-mirror2.test/{url}'] } } }),
      ]),
    )
    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'npm/integrity-mismatch' })
    // A tampered body is a supply-chain signal, not a transport failure: the next mirror is not tried.
    expect(hits).not.toContain(secondMirror)
  })
})

describe('修复回归：onMissing/startup 运行期校验', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function slowProvider(delayMs: number): Provider {
    return {
      id: '@avantf/slow',
      kinds: ['plugin:slow'],
      identify: () => ({ name: 'demo' }),
      probe: async () => ({ found: false }),
      plan: () => ({ action: 'install' }),
      targetDir: (_item, ref) => join('demo', ref.segment),
      install: async (_item, ctx) => {
        await new Promise(resolve => setTimeout(resolve, delayMs))
        return ctx.publish(await ctx.stage(), { name: 'demo', version: '1.0.0' })
      },
      verify: async () => undefined,
    }
  }

  it('非法的 onMissing 取值报 invalid-option 后按该轴缺省继续，绝不 refuse', async () => {
    const captured = logger()
    const tarball = packageTarball()
    const created = createProvisioner({ home, logger: captured.log, fs, fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)) })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem({ onMissing: { atStartup: 'ignore', atUse: 'refuse' } as never })]))
    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    const text = captured.lines.join(' ')
    expect(text).toContain('invalid-option: mem:demo.onMissing.atStartup')
    expect(text).toContain('invalid-option: mem:demo.onMissing.atUse')
  })

  it('合法的 onMissing 不产生 invalid-option 告警', async () => {
    const captured = logger()
    const tarball = packageTarball()
    const created = createProvisioner({ home, logger: captured.log, fs, fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)) })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem({ onMissing: { atStartup: 'refuse', atUse: 'degrade' } })]))
    await created.ensure()

    expect(captured.lines.join(' ')).not.toContain('invalid-option')
  })

  it('非法的 startup 取值报 invalid-option 并按缺省 blocking 处理（ensure 等它落定）', async () => {
    const captured = logger()
    const created = createProvisioner({ home, logger: captured.log, fs })
    created.register(slowProvider(50))
    created.declare(
      manifestOf([{ id: 'mem:slow', kind: 'plugin:slow', spec: {}, target: { root: 'runtime' }, schemaVersion: 1, startup: 'later' as never }]),
    )

    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    expect(captured.lines.join(' ')).toContain('invalid-option: mem:slow.startup')
  })
})

describe('修复回归：provider 扫描与告警的进程外状态（P3）', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  it('PATH 上第一个候选探针失败时继续扫描后续 PATH', async () => {
    const firstDir = join(home, 'path-first')
    const secondDir = join(home, 'path-second')
    await mkdir(firstDir, { recursive: true })
    await mkdir(secondDir, { recursive: true })
    const broken = join(firstDir, 'demo')
    const working = join(secondDir, 'demo')
    await writeFile(broken, '#!/bin/sh\nexit 3\n')
    await writeFile(working, '#!/bin/sh\necho demo 1.0.0\n')
    await chmod(broken, 0o755)
    await chmod(working, 0o755)

    const original = process.env['PATH']
    process.env['PATH'] = `${firstDir}${delimiter}${secondDir}`
    try {
      const captured = logger()
      const created = createProvisioner({ home, logger: captured.log, fs })
      created.register(binaryArchiveProvider())
      created.declare(manifestOf([{ id: 'mem:demo', kind: 'binary-archive', spec: { id: 'demo', version: '1.0.0', packs: {} }, target: { root: 'tools' }, schemaVersion: 1 }]))
      const report = await created.ensure({ offline: true })

      expect(report.entries[0]).toMatchObject({ action: 'present', source: 'system' })
      expect(created.resolve('mem:demo')).toMatchObject({ state: 'ready' })
      const ready = created.resolve('mem:demo')
      if (ready.state === 'ready') expect(ready.handle.dir).toBe(secondDir)
      expect(captured.lines.join(' ')).toContain(broken)
    } finally {
      if (original === undefined) delete process.env['PATH']
      else process.env['PATH'] = original
    }
  })

  it('PATH 上的候选全部探针失败 ⇒ 汇总一条告警并按未安装处理', async () => {
    const firstDir = join(home, 'path-dead-a')
    const secondDir = join(home, 'path-dead-b')
    await mkdir(firstDir, { recursive: true })
    await mkdir(secondDir, { recursive: true })
    const dead = join(firstDir, 'demo')
    const alsoDead = join(secondDir, 'demo')
    await writeFile(dead, '#!/bin/sh\nexit 3\n')
    await writeFile(alsoDead, '#!/bin/sh\nexit 4\n')
    await chmod(dead, 0o755)
    await chmod(alsoDead, 0o755)

    const original = process.env['PATH']
    process.env['PATH'] = `${firstDir}${delimiter}${secondDir}`
    try {
      const captured = logger()
      const created = createProvisioner({ home, logger: captured.log, fs })
      created.register(binaryArchiveProvider())
      created.declare(manifestOf([{ id: 'mem:demo', kind: 'binary-archive', spec: { id: 'demo', version: '1.0.0', packs: {} }, target: { root: 'tools' }, schemaVersion: 1 }]))
      const report = await created.ensure({ offline: true })

      expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'policy/offline' })
      const summary = captured.lines.find(line => line.includes('均未通过'))
      expect(summary).toBeDefined()
      expect(summary).toContain(dead)
      expect(summary).toContain(alsoDead)
    } finally {
      if (original === undefined) delete process.env['PATH']
      else process.env['PATH'] = original
    }
  })

  it('unverifiable 告警按 provider 实例计：新实例会重新告警一次', async () => {
    const versionDir = join(home, 'runtime', 'demo-pkg', '1.0.0')
    await mkdir(join(versionDir, 'node_modules', 'demo-pkg'), { recursive: true })
    await writeFile(
      join(versionDir, 'install.json'),
      JSON.stringify({ schemaVersion: 0, name: 'demo-pkg', version: '1.0.0', dir: '1.0.0', entryDir: 'node_modules/demo-pkg', installed_at: '2026-01-01T00:00:00.000Z', source: 'installed', layout: 'v1' }),
    )
    await writeFile(join(versionDir, 'node_modules', 'demo-pkg', 'package.json'), JSON.stringify({ name: 'demo-pkg', version: '1.0.0' }))

    const first = logger()
    const one = createProvisioner({ home, logger: first.log, fs })
    one.register(npmPackageProvider())
    one.declare(manifestOf([npmItem()]))
    await one.plan()

    const second = logger()
    const two = createProvisioner({ home, logger: second.log, fs })
    two.register(npmPackageProvider())
    two.declare(manifestOf([npmItem()]))
    await two.plan()

    expect(first.lines.filter(line => line.includes('unverifiable'))).toHaveLength(1)
    // The dedup state lives on the provider instance, so a fresh instance warns again (not once per process).
    expect(second.lines.filter(line => line.includes('unverifiable'))).toHaveLength(1)
  })
})

describe('修复回归：2026-10-01 审核的静默与不设防（D 车道）', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  it('packument 走硬字节上限 ⇒ fetch/too-large（旧代码无上限地 response.json()）', async () => {
    const fetcher = (async () =>
      new Response('{"versions":{}}', { status: 200, headers: { 'content-length': String(DEFAULT_MAX_BYTES + 1) } })) as unknown as typeof fetch
    const created = createProvisioner({ home, logger: logger().log, fs, fetch: fetcher })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'fetch/too-large' })
  })

  it('model 的 revision/siblings 元数据同样有硬上限 ⇒ fetch/too-large（终局，不换源）', async () => {
    const fetcher = (async () =>
      new Response('{"sha":"x"}', { status: 200, headers: { 'content-length': String(DEFAULT_MAX_BYTES + 1) } })) as unknown as typeof fetch
    const created = createProvisioner({ home, logger: logger().log, fs, fetch: fetcher })
    created.register(modelCacheProvider())
    created.declare(
      manifestOf([{ id: 'mem:model', kind: 'model-cache', spec: { repo: 'org/model' }, target: { root: 'models' }, schemaVersion: 1 }]),
    )

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'fetch/too-large' })
  })

  // ── N11：元数据用自己那条约 16 MiB 的上限，不再沿用 256 MiB 的归档上限 ──────────────────────
  it('元数据上限是 METADATA_MAX_BYTES（远小于 DEFAULT_MAX_BYTES），不是归档上限', async () => {
    // The declared length is ~16 MiB: far under the 256 MiB archive cap, so this can only be terminal
    // if the metadata path really uses the smaller cap. (`@types/node`'s full packument measured
    // 11.2 MB, `typescript`'s 15.7 MB — both under it; see `net.ts`.)
    const fetcher = (async () =>
      new Response('{"versions":{}}', {
        status: 200,
        headers: { 'content-length': String(METADATA_MAX_BYTES + 1) },
      })) as unknown as typeof fetch
    const created = createProvisioner({ home, logger: logger().log, fs, fetch: fetcher })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'fetch/too-large' })
  })

  it('元数据超限是终局：不换源重试（镜像排在默认端点之前，一次都不碰）', async () => {
    const hits: string[] = []
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      hits.push(String(input))
      return new Response('{"sha":"x"}', {
        status: 200,
        headers: { 'content-length': String(METADATA_MAX_BYTES + 1) },
      })
    }) as unknown as typeof fetch
    const created = createProvisioner({
      home,
      logger: logger().log,
      fs,
      fetch: fetcher,
      policy: { mirrors: { archive: [], model: ['https://model-mirror.test'] } },
    })
    created.register(modelCacheProvider())
    created.declare(
      manifestOf([{ id: 'mem:model', kind: 'model-cache', spec: { repo: 'org/model' }, target: { root: 'models' }, schemaVersion: 1 }]),
    )

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'fetch/too-large' })
    // The mirror answers first and is oversized; a mirror serves the same oversized document, so the
    // default endpoint must never be tried (that is the whole point of the terminal classification).
    expect(hits).toEqual(['https://model-mirror.test/api/models/org/model/revision/main'])
  })

  it('正常大小的元数据不受新上限影响（照常解析出 sha 并继续）', async () => {
    const sha = 'a'.repeat(40)
    const hits: string[] = []
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      hits.push(url)
      if (url.endsWith(`/revision/main`)) {
        return new Response(JSON.stringify({ sha }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // The siblings call is the next metadata read; a 503 keeps the test at the metadata layer (the
      // point is that the ~100-byte revision response was ACCEPTED, not that the model installs).
      return new Response('nope', { status: 503 })
    }) as unknown as typeof fetch
    const created = createProvisioner({ home, logger: logger().log, fs, fetch: fetcher })
    created.register(modelCacheProvider())
    created.declare(
      manifestOf([{ id: 'mem:model', kind: 'model-cache', spec: { repo: 'org/model' }, target: { root: 'models' }, schemaVersion: 1 }]),
    )

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'fetch/failed' })
    expect(hits[0]).toBe('https://huggingface.co/api/models/org/model/revision/main')
    expect(hits[1]).toBe('https://huggingface.co/api/models/org/model')
  })

  it('peer 只能从宿主启动目录解析到 ⇒ 告警一次（旧代码静默用 CWD）', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'envinit-cwd-'))
    const peerDir = join(cwd, 'node_modules', 'phantom-peer')
    await mkdir(peerDir, { recursive: true })
    await writeFile(join(peerDir, 'package.json'), JSON.stringify({ name: 'phantom-peer', version: '1.0.0' }))
    const tarball = packageTarball({ packageJson: { peerDependencies: { 'phantom-peer': '^1.0.0' } } })
    const original = process.cwd()
    process.chdir(cwd)
    try {
      const captured = logger()
      const created = createProvisioner({
        home,
        logger: captured.log,
        fs,
        fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)),
      })
      created.register(npmPackageProvider())
      created.declare(manifestOf([npmItem()]))

      const report = await created.ensure()
      expect(report.entries[0]).toMatchObject({ action: 'installed' })
      expect(captured.lines.some(line => line.includes('宿主启动目录'))).toBe(true)
    } finally {
      process.chdir(original)
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('packageDirOf：win32 反斜杠下 scoped peer 也能匹配（旧代码 endsWith 永不匹配）', () => {
    expect(packageDirOf('C:\\host\\node_modules\\@scope\\pkg\\dist\\index.js', '@scope/pkg', win32.dirname)).toBe(
      'C:\\host\\node_modules\\@scope\\pkg',
    )
    // 同一个 off-by-one 修好后，入口就在包根时也能命中（旧循环先上跳一步再看）。
    expect(packageDirOf('/host/node_modules/zod/index.js', 'zod')).toBe('/host/node_modules/zod')
    expect(packageDirOf('/host/other/thing.js', 'zod')).toBeUndefined()
  })

  it('install.json 的 entryDir 逃出包目录 ⇒ 不采信（旧代码会 join 到 home 内别处）', async () => {
    const versionDir = join(home, 'runtime', 'demo-pkg', '1.0.0')
    await mkdir(versionDir, { recursive: true })
    await writeFile(
      join(versionDir, 'install.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'demo-pkg',
        version: '1.0.0',
        dir: '1.0.0',
        entryDir: '../../outside',
        installed_at: new Date(0).toISOString(),
        source: 'installed',
        layout: 'v1',
      }),
    )
    await mkdir(join(home, 'runtime', 'outside'), { recursive: true })
    await writeFile(join(home, 'runtime', 'outside', 'package.json'), JSON.stringify({ name: 'demo-pkg', version: '1.0.0' }))

    const created = createProvisioner({ home, logger: logger().log, fs })
    created.register(npmPackageProvider())
    created.declare(manifestOf([npmItem()]))

    const report = await created.ensure({ offline: true })
    expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'policy/offline' })
  })
})
