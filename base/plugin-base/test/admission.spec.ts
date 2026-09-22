/**
 * The `[must]` rows of the acceptance matrix that are about the core's own
 * guarantees: publish-once under concurrency, fault injection at the landing step, and admission /
 * self-healing of an already-populated home.
 *
 * @module test/admission
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs, exists } from '../src/fs.js'
import { quarantineRoot, tempRoot } from '../src/layout.js'
import { defaultLock } from '../src/lock.js'
import { createProvisioner } from '../src/provisioner.js'
import { npmPackageProvider } from '../src/providers/npm.js'
import type { Manifest, Provider, ProvisionFs, ProvisionItem, ProvisionLogger } from '../src/types.js'
import { integrityOf, noNetwork, packageTarball, registryFor } from './helpers/registry.js'
import { removeHome } from './helpers/tmp.js'

const silent: ProvisionLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

function item(overrides: Partial<ProvisionItem> = {}): ProvisionItem {
  return {
    id: 'mem:demo',
    kind: 'npm-package',
    spec: { name: 'demo-pkg', range: '^1.0.0' },
    target: { root: 'runtime' },
    schemaVersion: 1,
    ...overrides,
  }
}

function manifestOf(items: readonly ProvisionItem[] = [item()]): Manifest {
  return { plugin: 'mem', items }
}

/** The version directory the core publishes into for the default item/spec above. */
function versionDir(home: string): string {
  return join(home, 'runtime', 'demo-pkg', '1.0.0')
}

async function writeVersionDir(home: string, manifest: unknown | undefined): Promise<string> {
  const dir = versionDir(home)
  const entry = join(dir, 'node_modules', 'demo-pkg')
  await mkdir(entry, { recursive: true })
  await writeFile(join(entry, 'package.json'), JSON.stringify({ name: 'demo-pkg', version: '1.0.0', type: 'module', main: 'index.js' }))
  await writeFile(join(entry, 'index.js'), 'export const ok = true\n')
  if (manifest !== undefined) await writeFile(join(dir, 'install.json'), JSON.stringify(manifest))
  return dir
}

const validManifest = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  name: 'demo-pkg',
  version: '1.0.0',
  dir: '1.0.0',
  installed_at: new Date(0).toISOString(),
  source: 'installed',
  layout: 'v1',
  ...extra,
})

describe('核心落盘与准入（[must] 行）', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-admission-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(fs: ProvisionFs, fetchImpl: typeof fetch, options: { readonly lock?: ReturnType<typeof defaultLock> } = {}) {
    const created = createProvisioner({
      home,
      logger: silent,
      fs,
      fetch: fetchImpl,
      ...(options.lock === undefined ? {} : { lock: options.lock }),
    })
    created.register(npmPackageProvider())
    created.declare(manifestOf())
    return created
  }

  it('两个互不相识的实例共享一个 home：只发布一次，两边都成功', async () => {
    const tarball = packageTarball()
    const integrity = integrityOf(tarball)
    const target = versionDir(home)

    const countingFs = (counts: { renamed: number }): ProvisionFs => {
      const inner = defaultFs()
      return {
        ...inner,
        async rename(from, to) {
          if (to === target) counts.renamed += 1
          await inner.rename(from, to)
        },
      }
    }

    const a = { renamed: 0 }
    const b = { renamed: 0 }
    const instanceA = provisioner(countingFs(a), registryFor('demo-pkg', '1.0.0', tarball, integrity), { lock: defaultLock() })
    const instanceB = provisioner(countingFs(b), registryFor('demo-pkg', '1.0.0', tarball, integrity), { lock: defaultLock() })

    const [reportA, reportB] = await Promise.all([instanceA.ensure(), instanceB.ensure()])
    const actions = [...reportA.entries, ...reportB.entries].map(entry => entry.action)
    // Whichever publisher lost the race reuses the winner's directory: `installed` or `present`.
    expect(actions.every(action => action === 'installed' || action === 'present')).toBe(true)
    expect(actions).toContain('installed')
    // Two independent publishers downloaded twice (allowed), but only one rename landed.
    expect(a.renamed + b.renamed).toBe(1)
    expect(await exists(defaultFs(), join(target, 'install.json'))).toBe(true)

    // A third, fresh instance reuses the published copy without touching the network.
    const reader = provisioner(defaultFs(), noNetwork(), { lock: defaultLock() })
    const third = await reader.ensure()
    expect(third.entries.map(entry => [entry.action, entry.source])).toEqual([['present', 'managed']])
  })

  it('磁盘满（ENOSPC）⇒ failed，且不留可用目录', async () => {
    const tarball = packageTarball()
    const inner = defaultFs()
    const staging = tempRoot(home)
    const full: ProvisionFs = {
      ...inner,
      async writeFile(path, data) {
        if (path.startsWith(staging)) {
          throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
        }
        await inner.writeFile(path, data)
      },
    }
    const created = provisioner(full, registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    const report = await created.ensure()

    expect(report.ok).toBe(false)
    expect(report.entries[0]).toMatchObject({ action: 'failed' })
    expect(report.entries[0]?.reason).toMatch(/ENOSPC/)
    expect(created.resolve('mem:demo')).toMatchObject({ state: 'failed' })
    expect(await exists(inner, versionDir(home))).toBe(false)
  })

  it('rename 落盘失败 ⇒ failed，staging 清理干净', async () => {
    const tarball = packageTarball()
    const inner = defaultFs()
    const failing: ProvisionFs = {
      ...inner,
      async rename(from, to) {
        if (to === versionDir(home)) throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' })
        await inner.rename(from, to)
      },
    }
    const created = provisioner(failing, registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'failed' })
    expect(report.entries[0]?.reason).toMatch(/EACCES/)
    expect(await exists(inner, versionDir(home))).toBe(false)
    const leftovers = (await readdir(tempRoot(home)).catch(() => [] as string[])).filter(entry => entry.includes('mem'))
    expect(leftovers).toEqual([])
  })

  it('install.json 缺失或不可解析 ⇒ 不信任旧目录：隔离后重取', async () => {
    const tarball = packageTarball()
    for (const legacy of [undefined, '{ not json']) {
      await removeHome(home)
      await mkdir(home, { recursive: true })
      const old = await writeVersionDir(home, legacy)
      const created = provisioner(defaultFs(), registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
      const report = await created.ensure()

      expect(report.entries[0]?.action, `manifest=${String(legacy)}`).toBe('installed')
      // The untrusted directory was renamed aside, never deleted.
      const quarantined = await readdir(quarantineRoot(home))
      expect(quarantined.length, `manifest=${String(legacy)}`).toBe(1)
      expect(await exists(defaultFs(), old)).toBe(true)
      const manifest = JSON.parse(await readFile(join(old, 'install.json'), 'utf8')) as { name: string }
      expect(manifest.name).toBe('demo-pkg')
    }
  })

  it('目标目录描述的版本与本次不一致 ⇒ 隔离后重取', async () => {
    await writeVersionDir(home, validManifest({ version: '0.0.1', dir: '0.0.1' }))
    const tarball = packageTarball()
    const created = provisioner(defaultFs(), registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    const report = await created.ensure()

    expect(report.entries[0]?.action).toBe('installed')
    expect((await readdir(quarantineRoot(home))).length).toBe(1)
    const manifest = JSON.parse(await readFile(join(versionDir(home), 'install.json'), 'utf8')) as { version: string }
    expect(manifest.version).toBe('1.0.0')
  })

  it('staging 与目标跨文件系统（EXDEV）⇒ failed(publish/cross-device)', async () => {
    const tarball = packageTarball()
    const inner = defaultFs()
    const crossing: ProvisionFs = {
      ...inner,
      async rename(from, to) {
        if (to === versionDir(home)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
        await inner.rename(from, to)
      },
    }
    const created = provisioner(crossing, registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'publish/cross-device' })
    expect(await exists(inner, versionDir(home))).toBe(false)
  })

  it('缺 integrity 的 manifest ⇒ 复用且不隔离、不下载（unverifiable 可用）', async () => {
    await writeVersionDir(home, validManifest())
    const created = provisioner(defaultFs(), noNetwork())
    const report = await created.ensure()

    expect(report.entries.map(entry => [entry.action, entry.source])).toEqual([['present', 'managed']])
    expect(await readdir(quarantineRoot(home)).catch(() => [] as string[])).toEqual([])
  })

  it('旧形状的 install.json 按别名表读入（id → name）', async () => {
    await writeVersionDir(home, { id: 'demo-pkg', version: '1.0.0', sha256: 'abc', url: 'https://example.test/x.tgz' })
    const created = provisioner(defaultFs(), noNetwork())
    const report = await created.ensure()

    expect(report.entries.map(entry => entry.action)).toEqual(['present'])
    expect(await readdir(quarantineRoot(home)).catch(() => [] as string[])).toEqual([])
  })

  it('peer 不可满足 ⇒ failed(peer/unsatisfied)，不落盘', async () => {
    const tarball = packageTarball({ packageJson: { peerDependencies: { 'missing-peer': '^1.0.0' } } })
    const created = provisioner(defaultFs(), registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'peer/unsatisfied' })
    expect(await exists(defaultFs(), versionDir(home))).toBe(false)
  })

  it('Windows 无软链权限时 peer 退化为真实副本', async () => {
    const tarball = packageTarball({ packageJson: { peerDependencies: { 'demo-peer': '^1.0.0' } } })
    const inner = defaultFs()
    const peerDir = join(home, 'runtime', 'demo-peer', '1.0.0', 'node_modules', 'demo-peer')
    await mkdir(peerDir, { recursive: true })
    await writeFile(join(peerDir, 'package.json'), JSON.stringify({ name: 'demo-peer', version: '1.0.0' }))

    const noSymlink: ProvisionFs = {
      ...inner,
      async symlink() {
        throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' })
      },
    }
    const created = createProvisioner({ home, logger: silent, fs: noSymlink, fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)) })
    created.register(npmPackageProvider())
    created.declare(
      manifestOf([
        item({ spec: { name: 'demo-pkg', range: '^1.0.0', peers: [{ name: 'demo-peer', dir: peerDir }] } }),
      ]),
    )
    const report = await created.ensure()

    expect(report.entries[0]?.action).toBe('installed')
    const copied = join(versionDir(home), 'node_modules', 'demo-peer', 'package.json')
    expect(await exists(inner, copied)).toBe(true)
    expect(JSON.parse(await readFile(copied, 'utf8'))).toMatchObject({ name: 'demo-peer' })
  })

  it('原生模块 ⇒ verify/failed 并指向 prebuilt 路线，目录被隔离', async () => {
    const tarball = packageTarball({ extra: [{ name: 'package/binding.gyp', data: '{}\n' }] })
    const created = provisioner(defaultFs(), registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    const report = await created.ensure()

    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })
    expect(report.entries[0]?.reason).toMatch(/prebuilt/)
    expect((await readdir(quarantineRoot(home))).length).toBe(1)
  })

  it('发布锁被长安装持有时，状态短锁仍可写（锁语义）', async () => {
    const held = await defaultLock().acquire(join(home, '.envinit', '.lock'), { timeoutMs: 1_000, staleMs: 60_000 })
    try {
      // The status plane has its own short lock, so a long install never blocks it.
      const { persistStatus, readStatus } = await import('../src/state.js')
      await persistStatus(defaultFs(), defaultLock(), home, [], silent)
      const status = await readStatus(defaultFs(), home)
      expect(status.kind).toBe('ok')
    } finally {
      held.dispose()
    }
  })

  it('Resolved.key 由核心按 kind+name 填：provider 造的值在 verify 里已被覆盖（落盘权威）', async () => {
    const seen: string[] = []
    const stub: Provider = {
      id: '@avantf/stub-provider',
      kinds: ['plugin:stub'],
      identify: () => ({ name: 'demo' }),
      probe: async () => ({ found: false }),
      plan: () => ({ action: 'install' }),
      targetDir: (_item, ref) => join('demo', ref.segment),
      install: async (_item, ctx) => {
        const published = await ctx.publish(await ctx.stage(), { name: 'demo', version: '1.0.0' })
        // A provider may invent a key; the core must overwrite it with the canonical one.
        return { ...published, key: 'provider-invented' }
      },
      verify: async (_item, resolved) => {
        seen.push(resolved.key ?? '(missing)')
      },
    }
    const created = createProvisioner({ home, logger: silent, fs: defaultFs() })
    created.register(stub)
    created.declare(manifestOf([{ id: 'mem:stub', kind: 'plugin:stub', spec: {}, target: { root: 'runtime' }, schemaVersion: 1 }]))
    const report = await created.ensure()

    expect(report.entries[0]?.action).toBe('installed')
    expect(seen).toEqual(['plugin:stub+demo'])
    const state = created.resolve('mem:stub')
    expect(state.state === 'ready' ? state.handle.key : undefined).toBe('plugin:stub+demo')
  })

  it('同进程两个实例的 staging 路径互不相同（pid 不足以区分实例）', async () => {
    const tarball = packageTarball()
    const root = tempRoot(home)
    // Hold both instances at their packument request, so their staging phases really overlap.
    let inFlight = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const barrierFetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith('.tgz')) return new Response(tarball, { status: 200 })
      inFlight += 1
      if (inFlight === 2) release()
      await gate
      return new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://registry.test/x.tgz', integrity: integrityOf(tarball) } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    /** An fs that remembers the first staging directory this instance created. */
    const observing = (): { readonly fs: ProvisionFs; readonly first: () => string } => {
      const inner = defaultFs()
      let first = ''
      return {
        first: () => first,
        fs: {
          ...inner,
          async mkdir(path) {
            if (first === '' && path.startsWith(root)) first = path
            await inner.mkdir(path)
          },
        },
      }
    }

    const make = (): { readonly instance: ReturnType<typeof createProvisioner>; readonly first: () => string } => {
      const seen = observing()
      const instance = createProvisioner({ home, logger: silent, fs: seen.fs, fetch: barrierFetch })
      instance.register(npmPackageProvider())
      instance.declare(manifestOf())
      return { instance, first: seen.first }
    }

    const a = make()
    const b = make()
    const [reportA, reportB] = await Promise.all([a.instance.ensure(), b.instance.ensure()])
    expect(reportA.entries[0]?.action).toBe('installed')
    expect(reportB.entries[0]?.action).toBe('installed')
    // `pid` is the same for both, so the sequence must be process-global: otherwise the two
    // instances share one staging tree and only timing decides whether that corrupts the run.
    expect(a.first()).not.toBe('')
    expect(a.first()).not.toBe(b.first())
  })

  it('读进程与发布交错：目标要么不存在、要么完整，import 不出现 ENOENT（[must] 并发）', async () => {
    const tarball = packageTarball()
    const inner = defaultFs()
    const target = versionDir(home)
    const entry = join(target, 'node_modules', 'demo-pkg', 'index.js')
    const seen: string[] = []
    let reader: ReturnType<typeof createProvisioner> | undefined

    // The writer's fs observes the publish step from the inside: `rename` is where the version
    // directory appears, so that is where an interleaving reader must see "nothing yet".
    const observing: ProvisionFs = {
      ...inner,
      async rename(from, to) {
        if (to !== target) return inner.rename(from, to)
        const beforeManifest = await exists(inner, join(target, 'install.json'))
        const beforeEntry = await exists(inner, entry)
        const planned = (await reader?.plan())?.entries[0]?.action
        seen.push(`before: manifest=${String(beforeManifest)} entry=${String(beforeEntry)} plan=${String(planned)}`)
        await inner.rename(from, to)
        const afterManifest = await exists(inner, join(target, 'install.json'))
        const afterEntry = await exists(inner, entry)
        seen.push(`after: manifest=${String(afterManifest)} entry=${String(afterEntry)}`)
      },
    }

    const writer = createProvisioner({ home, logger: silent, fs: observing, fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)) })
    writer.register(npmPackageProvider())
    writer.declare(manifestOf([item()]))

    // A second instance over the same home stands in for the reading process.
    reader = createProvisioner({ home, logger: silent, fs: inner, fetch: noNetwork() })
    reader.register(npmPackageProvider())
    reader.declare(manifestOf([item()]))

    const report = await writer.ensure()
    expect(report.entries[0]?.action).toBe('installed')
    // Half-published is impossible: the manifest travels inside the tree, so the rename is the
    // single moment the directory becomes visible — and it is already complete then.
    // "plan" may legitimately be `install` (a resolution record) or `unknown` (nothing yet), but
    // never `present`: the copy is not there yet.
    expect(seen[0]).toMatch(/^before: manifest=false entry=false plan=(unknown|install)$/)
    expect(seen[1]).toBe('after: manifest=true entry=true')

    // And the reader can really import it afterwards: no ENOENT, the file is complete.
    const loaded = (await import(pathToFileURL(entry).href)) as { ok?: boolean }
    expect(loaded.ok).toBe(true)
    expect((await reader.plan()).entries[0]?.action).toBe('present')
    expect(reader.resolve('mem:demo')).toMatchObject({ state: 'missing' }) // it never installed anything itself
  })

  it('前置集接入配方：作用域包 + peer + exports 映射，按 handle.dir 解析并 import（第 4 步）', async () => {
    // The shape a plugin's pre-mount dependency really has: a scoped package with an `exports` map
    // and a peer that must be reused from the host tree rather than downloaded again.
    const name = '@avantf/dsh-gatebase'
    const peerDir = join(home, 'host-tree', 'node_modules', 'zod')
    await mkdir(peerDir, { recursive: true })
    await writeFile(join(peerDir, 'package.json'), JSON.stringify({ name: 'zod', version: '3.23.8' }))
    const tarball = packageTarball({
      name,
      packageJson: { exports: { '.': { default: './dist/index.js' } }, peerDependencies: { zod: '^3.0.0' } },
      extra: [{ name: 'package/dist/index.js', data: 'export const gate = true\n' }],
    })

    const created = createProvisioner({ home, logger: silent, fs: defaultFs(), fetch: registryFor(name, '1.0.0', tarball, integrityOf(tarball)) })
    created.register(npmPackageProvider())
    created.declare(
      manifestOf([
        {
          id: 'mem:gate',
          kind: 'npm-package',
          spec: { name, range: '^1.0.0', peers: [{ name: 'zod', dir: peerDir }] },
          target: { root: 'runtime' },
          schemaVersion: 1,
          onMissing: { atStartup: 'degrade' }, // 拿不到 ≠ 拒载
        },
      ]),
    )

    // Block on exactly this item, then take its entry directory.
    const front = await created.ensure({ only: ['mem:gate'], deadlineMs: 5_000 })
    expect(front.entries.map(entry => entry.action)).toEqual(['installed'])
    const state = created.resolve('mem:gate')
    expect(state.state).toBe('ready')
    if (state.state !== 'ready') throw new Error('unreachable')
    // Resolve by package name from the entry directory: that is the whole recipe. Counting path
    // levels by hand is wrong for scoped names (they occupy two segments under `node_modules/`).
    const require = createRequire(join(state.handle.dir, 'package.json'))
    const resolved = require.resolve(name)
    expect(resolved.startsWith(state.handle.dir)).toBe(true)
    const loaded = (await import(pathToFileURL(resolved).href)) as { gate?: boolean }
    expect(loaded.gate).toBe(true)

    // The peer was reused from the host tree (linked, not downloaded a second time).
    const peerResolved = require.resolve('zod/package.json')
    expect(peerResolved.startsWith(peerDir)).toBe(true)
    expect(await exists(defaultFs(), join(peerDir, 'package.json'))).toBe(true)
  })

  it('两个实例互不污染：未在本身例声明的 item 是 missing', async () => {
    const tarball = packageTarball()
    const registry = registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball))
    const mem = provisioner(defaultFs(), registry)
    const other = createProvisioner({ home, logger: silent, fs: defaultFs(), fetch: registry })
    other.register(npmPackageProvider())
    other.declare(manifestOf([item({ id: 'job:other', kind: 'plugin:unknown' })]))

    expect(mem.resolve('job:other')).toEqual({ state: 'missing' })
    expect(mem.status().every(row => !row.items.includes('job:other'))).toBe(true)
    // Flush the fire-and-forget declaration writes before teardown.
    await Promise.all([mem.plan({ only: ['nothing-declared'] }), other.plan({ only: ['nothing-declared'] })])
  })
})
