import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs, exists } from '../src/fs.js'
import { createProvisioner } from '../src/provisioner.js'
import { npmPackageProvider } from '../src/providers/npm.js'
import type { Manifest, Provider, ProvisionItem, ProvisionLogger, ProvisionPolicy } from '../src/types.js'
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
})
