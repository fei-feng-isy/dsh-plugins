import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs, exists } from '../src/fs.js'
import { createProvisioner } from '../src/provisioner.js'
import { npmPackageProvider } from '../src/providers/npm.js'
import type { Manifest, ProbeResult, Provider, ProvisionItem, ProvisionLogger, ProvisionPolicy } from '../src/types.js'
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

function manifestOf(items: readonly ProvisionItem[]): Manifest {
  return { plugin: 'mem', items }
}

describe('createProvisioner × npm provider', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-home-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(fetchImpl: typeof fetch, policy?: ProvisionPolicy): ReturnType<typeof createProvisioner> {
    const created = createProvisioner({
      home,
      logger: silent,
      fs,
      fetch: fetchImpl,
      ...(policy === undefined ? {} : { policy }),
    })
    created.register(npmPackageProvider())
    return created
  }

  it('安装 → 落盘 → 复用：第二次 ensure 报 present', async () => {
    const tarball = packageTarball()
    const integrity = integrityOf(tarball)
    const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrity))
    created.declare(manifestOf([item()]))

    const report = await created.ensure()
    expect(report.ok).toBe(true)
    expect(report.entries[0]).toMatchObject({
      action: 'installed',
      version: '1.0.0',
      key: 'npm-package+demo-pkg',
      plugin: 'mem',
      id: 'mem:demo',
    })

    const versionDir = join(home, 'runtime', 'demo-pkg', '1.0.0')
    const install = JSON.parse(await readFile(join(versionDir, 'install.json'), 'utf8')) as Record<string, unknown>
    expect(install).toMatchObject({
      name: 'demo-pkg',
      version: '1.0.0',
      integrity,
      entryDir: 'node_modules/demo-pkg',
      source: 'installed',
    })
    const staged = JSON.parse(await readFile(join(versionDir, 'node_modules', 'demo-pkg', 'package.json'), 'utf8')) as { name: string }
    expect(staged.name).toBe('demo-pkg')

    const again = await created.ensure()
    expect(again.entries[0]?.action).toBe('present')
    expect(created.resolve('mem:demo')).toMatchObject({ state: 'ready' })
    expect(created.status()).toHaveLength(1)
    expect(created.status()[0]).toMatchObject({ key: 'npm-package+demo-pkg', version: '1.0.0' })
  })

  it('可加载性失败 ⇒ 隔离该版本目录并报 verify/failed', async () => {
    const tarball = packageTarball({ entry: "throw new Error('boom')\n" })
    const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    created.declare(manifestOf([item()]))

    const report = await created.ensure()
    expect(report.ok).toBe(false)
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })
    expect(await exists(fs, join(home, 'runtime', 'demo-pkg', '1.0.0'))).toBe(false)
    const quarantined = await fs.readdir(join(home, '.envinit', '.quarantine'))
    expect(quarantined).toHaveLength(1)
  })

  it('packument 没有 dist.integrity ⇒ npm/no-integrity（不改盘）', async () => {
    const tarball = packageTarball()
    const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, undefined))
    created.declare(manifestOf([item()]))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'npm/no-integrity' })
    expect(await exists(fs, join(home, 'runtime', 'demo-pkg'))).toBe(false)
  })

  it('integrity 不符 ⇒ npm/integrity-mismatch', async () => {
    const tarball = packageTarball()
    const wrong = integrityOf(new TextEncoder().encode('something else'))
    const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, wrong))
    created.declare(manifestOf([item()]))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'npm/integrity-mismatch' })
  })

  it('声明了 postinstall ⇒ npm/lifecycle-script-unsupported', async () => {
    const tarball = packageTarball({ packageJson: { scripts: { postinstall: 'node build.js' } } })
    const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    created.declare(manifestOf([item()]))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'npm/lifecycle-script-unsupported' })
  })

  it('闸门关闭 ⇒ skipped(policy/download-disabled)，区分于 failed', async () => {
    const tarball = packageTarball()
    const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)), { autoDownload: false })
    created.declare(manifestOf([item()]))
    const report = await created.ensure()
    expect(report.ok).toBe(true)
    expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'policy/download-disabled' })
  })

  it('policy.autoDownload 的按 kind 覆盖是逐 kind 的', async () => {
    const tarball = packageTarball()
    const blocked = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)), { autoDownload: { 'npm-package': false } })
    blocked.declare(manifestOf([item()]))
    expect((await blocked.ensure()).entries[0]).toMatchObject({ action: 'skipped', code: 'policy/download-disabled' })

    // A different kind's override must not touch this one.
    const other = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)), {
      autoDownload: { 'binary-archive': false },
    })
    other.declare(manifestOf([item()]))
    expect((await other.ensure()).entries[0]).toMatchObject({ action: 'installed' })
  })

  it('未知 kind ⇒ failed(unknown-provider) 且不崩', async () => {
    const created = provisioner(registryFor('demo-pkg', '1.0.0', packageTarball(), integrityOf(packageTarball())))
    created.declare(manifestOf([item({ kind: 'mystery' })]))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'unknown-provider' })
  })

  it('requires.providers 声明过的 kind 缺席 ⇒ failed(provider/unavailable)，与拼错 kind 可区分', async () => {
    const created = provisioner(noNetwork())
    created.declare({
      plugin: 'mem',
      items: [item({ kind: 'plugin:acme' }), item({ id: 'mem:typo', kind: 'plugin:typo' })],
      requires: { providers: [{ package: '@acme/dsh-acme', kinds: ['plugin:acme'] }] },
    })
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'provider/unavailable' })
    expect(report.entries[0]?.reason).toContain('@acme/dsh-acme')
    expect(report.entries[1]).toMatchObject({ action: 'failed', code: 'unknown-provider' })
  })

  it('未知能力名进 ignored-field 警告后继续', async () => {
    const warnings: string[] = []
    const created = createProvisioner({
      home,
      logger: { ...silent, warn: message => warnings.push(message) },
      fs,
      fetch: registryFor('demo-pkg', '1.0.0', packageTarball(), integrityOf(packageTarball())),
    })
    created.register(npmPackageProvider())
    created.declare({ plugin: 'mem', items: [item()], requires: { capabilities: ['events', 'time-travel'] } })
    const report = await created.ensure()
    expect(report.entries[0]?.action).toBe('installed')
    expect(warnings.join(' ')).toContain('time-travel')
    expect(warnings.join(' ')).not.toContain('events')
  })

  it('`only` 指向未声明的 id ⇒ skipped(invalid-option)', async () => {
    const tarball = packageTarball()
    const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    created.declare(manifestOf([item()]))
    const report = await created.ensure({ only: ['mem:nope'] })
    expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'invalid-option' })
  })

  it('provider 的纯 plan 只有明确的 install 才算答案（present/skip/unknown 不冒充 install）', async () => {
    const stub = (action: 'present' | 'skip' | 'unknown'): Provider => ({
      id: '@avantf/plan-stub',
      kinds: ['plugin:plan'],
      identify: () => ({ name: 'stub' }),
      probe: async () => ({ found: false }),
      plan: () => ({ action }),
      targetDir: (_item, ref) => `stub/${ref.segment}`,
      install: async () => {
        throw new Error('plan-only: must not install')
      },
      verify: async () => undefined,
    })
    for (const action of ['present', 'skip', 'unknown'] as const) {
      const created = createProvisioner({ home, logger: silent, fs })
      created.register(stub(action))
      created.declare(manifestOf([item({ id: `mem:${action}`, kind: 'plugin:plan', spec: {} })]))
      expect((await created.plan()).entries[0]?.action, action).toBe('unknown')
    }

    // An explicit `install` (with the version the spec pins) is taken as-is, together with its URLs.
    const explicit = createProvisioner({ home, logger: silent, fs })
    explicit.register({ ...stub('present'), plan: () => ({ action: 'install', version: '9.9.9', urls: ['https://x/y.tgz'] }) })
    explicit.declare(manifestOf([item({ id: 'mem:install', kind: 'plugin:plan', spec: {} })]))
    expect((await explicit.plan()).entries[0]).toMatchObject({ action: 'install', version: '9.9.9', urls: ['https://x/y.tgz'] })
  })

  it('plan() 对缺的项报 install，对已就绪的项报 present', async () => {
    const tarball = packageTarball()
    const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)))
    created.declare(manifestOf([item()]))
    const before = await created.plan()
    // No resolution record yet: the plan says "unknown (needs the network)", never a guessed version.
    expect(before.entries[0]?.action).toBe('unknown')
    await created.ensure()
    const after = await created.plan()
    expect(after.entries[0]?.action).toBe('present')
  })

  it('失败的条目在 status.json 里是"未决行"（version 空）并带走失败原因', async () => {
    // 对 76408fb 的审核把 `version: ""` 读成"缺字段"。它是这个资源的**未决面**：版本之所以未知，
    // 正是因为失败发生在学到版本之前；而按那条建议删掉这一行，等于删掉唯一一条失败记录。
    // 这条测试把该行为钉住：行在、version 空、last_error 与报告里的 code 一致。
    const created = provisioner(noNetwork())
    created.declare(manifestOf([item()]))
    const report = await created.ensure()
    expect(report.ok).toBe(false)
    const code = report.entries[0]?.code
    expect(code).toBeDefined()

    const status = JSON.parse(await readFile(join(home, '.envinit', 'status.json'), 'utf8')) as {
      rows: Array<{ key: string; version: string; items: string[]; last_error?: { code: string } }>
    }
    const row = status.rows.find((entry) => entry.items.includes('mem:demo'))
    expect(row?.version).toBe('')
    expect(row?.last_error?.code).toBe(code)
  })

  it('复用已存在版本目录时比对 integrity：不符即隔离并落盘本次校验过的 staging', async () => {
    // 盘上那份的 install.json 说 1.0.0，但 integrity 不是本次下载并校验的值，且入口目录缺失
    // （probe 因此不认它）。旧代码只比 version 就复用，接着 verify 失败、白下载一次；新代码隔离重取。
    const versionDir = join(home, 'runtime', 'demo-pkg', '1.0.0')
    await mkdir(versionDir, { recursive: true })
    await writeFile(
      join(versionDir, 'install.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'demo-pkg',
        version: '1.0.0',
        dir: '1.0.0',
        integrity: 'sha512-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOL==',
        entryDir: 'node_modules/demo-pkg',
        installed_at: new Date(0).toISOString(),
        source: 'installed',
        layout: 'v1',
      }),
    )

    const tarball = packageTarball()
    const integrity = integrityOf(tarball)
    const created = provisioner(registryFor('demo-pkg', '1.0.0', tarball, integrity))
    created.declare(manifestOf([item()]))

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    const install = JSON.parse(await readFile(join(versionDir, 'install.json'), 'utf8')) as { integrity?: string }
    expect(install.integrity).toBe(integrity)
    expect(await exists(fs, join(versionDir, 'node_modules', 'demo-pkg', 'index.js'))).toBe(true)
    // The old directory was renamed aside, never deleted.
    expect(await fs.readdir(join(home, '.envinit', '.quarantine'))).toHaveLength(1)
  })

  it('background 项的 rejection 在真正 handler 挂上之前就已被认领（不产生 unhandledRejection）', async () => {
    // `ensure()` 要到隔着一次 persistStatus I/O 之后才挂真正的 .catch；窗口内 reject 曾是
    // unhandledRejection（严格宿主上是 FATAL）。一个会抛的 getter 让 ensureOne 在 try/catch 之外
    // reject，正好落在那个窗口里。
    const seen: unknown[] = []
    const listener = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      const boom: Provider = {
        id: '@avantf/boom',
        kinds: ['plugin:boom'],
        identify: () => ({ name: 'boom' }),
        targetDir: () => 'boom',
        plan: () => ({ action: 'install' }),
        probe: async (probedItem): Promise<ProbeResult> => {
          if (probedItem.id === 'mem:ok') return { found: false }
          return Object.defineProperty({}, 'found', {
            get() {
              throw new Error('boom')
            },
          }) as unknown as ProbeResult
        },
        install: async () => {
          throw new Error('unused')
        },
        verify: async () => undefined,
      }
      const created = createProvisioner({ home, logger: silent, fs })
      created.register(boom)
      created.declare(
        manifestOf([
          { id: 'mem:ok', kind: 'plugin:boom', spec: {}, target: { root: 'runtime' }, schemaVersion: 1 },
          { id: 'mem:bg', kind: 'plugin:boom', spec: {}, target: { root: 'runtime' }, schemaVersion: 1, startup: 'background' },
        ]),
      )

      // The blocking item settles first, so the background rejection lands inside the persistStatus I/O.
      const report = await created.ensure({ offline: true })
      expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'policy/offline' })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })
})
