/**
 * Axis B — runtime version negotiation: a loaded framework that does not
 * satisfy the plugin's declared range must skip that plugin's items and let the host mount degraded.
 *
 * @module test/version
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VERSION } from '../src/bootstrap.js'
import { defaultFs, exists } from '../src/fs.js'
import { createProvisioner } from '../src/provisioner.js'
import { npmPackageProvider } from '../src/providers/npm.js'
import type { Manifest, ProvisionItem, ProvisionLogger } from '../src/types.js'
import { integrityOf, packageTarball, registryFor } from './helpers/registry.js'
import { removeHome } from './helpers/tmp.js'

/** A range the loaded framework can never satisfy, whatever version it is. */
const NEXT_MAJOR_RANGE = `^${String(Number.parseInt(VERSION.split('.')[0] ?? '0', 10) + 1)}.0.0`

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

describe('版本轴 B：框架版本 × 插件声明的区间', () => {
  let home: string
  const tarball = packageTarball()
  const registry = registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball))

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-version-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(options: {
    readonly envinitRange?: string
    readonly item?: ProvisionItem
    readonly extraItems?: readonly ProvisionItem[]
    readonly fetch?: typeof fetch
    readonly warn?: string[]
  } = {}) {
    const logger: ProvisionLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: message => options.warn?.push(message),
      error: () => undefined,
    }
    const created = createProvisioner({
      home,
      logger,
      fs: defaultFs(),
      fetch: options.fetch ?? registry,
      ...(options.envinitRange === undefined ? {} : { envinitRange: options.envinitRange }),
    })
    created.register(npmPackageProvider())
    const manifest: Manifest = { plugin: 'mem', items: [options.item ?? item(), ...(options.extraItems ?? [])] }
    created.declare(manifest)
    return created
  }

  it('区间不满足 ⇒ 全部 skipped(unsupported-envinit)，且联网前就停手', async () => {
    let calls = 0
    const counting = (async () => {
      calls += 1
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const warnings: string[] = []
    const created = provisioner({ envinitRange: NEXT_MAJOR_RANGE, fetch: counting, warn: warnings })

    const report = await created.ensure()
    expect(report.entries.map(entry => [entry.action, entry.code])).toEqual([['skipped', 'unsupported-envinit']])
    expect(report.ok).toBe(true)
    expect(calls).toBe(0)
    expect(created.resolve('mem:demo')).toMatchObject({ state: 'skipped', code: 'unsupported-envinit' })
    expect(created.status().map(row => row.state)).toMatchObject([{ state: 'skipped', code: 'unsupported-envinit' }])

    const plan = await created.plan()
    expect(plan.entries.map(entry => entry.action)).toEqual(['skip'])
    expect(warnings.join(' ')).toContain('unsupported-envinit')
    expect(await exists(defaultFs(), join(home, 'runtime'))).toBe(false)
  })

  it('区间不满足时 repair() 也走同一条兜底路径', async () => {
    const created = provisioner({ envinitRange: '^9.0.0' })
    const report = await created.repair('mem:demo')
    expect(report.entries.map(entry => entry.code)).toEqual(['unsupported-envinit'])
  })

  it('区间满足（含预发期 ^0.1.0）⇒ 正常安装', async () => {
    const created = provisioner({ envinitRange: `^${VERSION}` })
    const report = await created.ensure()
    expect(report.entries.map(entry => entry.action)).toEqual(['installed'])
    expect(await exists(defaultFs(), join(home, 'runtime', 'demo-pkg', '1.0.0', 'install.json'))).toBe(true)
  })

  it('区间不在子集内 ⇒ 同样兜底，不拒载、不抛', async () => {
    const warnings: string[] = []
    const created = provisioner({ envinitRange: '1.2.x', warn: warnings })
    const report = await created.ensure()
    expect(report.entries.map(entry => entry.code)).toEqual(['unsupported-envinit'])
    expect(warnings.join(' ')).toContain('unsupported-envinit')
  })

  it('按实例隔离：不满足的实例跳过，同 home 的另一个实例照常安装', async () => {
    const unsupported = provisioner({ envinitRange: '^9.0.0', item: item({ id: 'mem:demo' }) })
    const supported = provisioner({ envinitRange: `^${VERSION}`, item: item({ id: 'job:demo' }) })

    const [skipped, installed] = await Promise.all([unsupported.ensure(), supported.ensure()])
    expect(skipped.entries.map(entry => entry.code)).toEqual(['unsupported-envinit'])
    expect(installed.entries.map(entry => entry.action)).toEqual(['installed'])
    expect(await exists(defaultFs(), join(home, 'runtime', 'demo-pkg', '1.0.0', 'install.json'))).toBe(true)
  })

  it('item 描述符比本副本新 ⇒ 跳过该项，依赖它的 item 随之 failed(missing-need)（轴 A）', async () => {
    const created = provisioner({
      item: item({ id: 'mem:future', schemaVersion: 99 }),
      extraItems: [item({ id: 'mem:dependent', needs: ['mem:future'] })],
    })
    const report = await created.ensure()
    expect(report.entries.map(entry => [entry.id, entry.action, entry.code])).toEqual([
      ['mem:future', 'skipped', 'unsupported-item-schema'],
      ['mem:dependent', 'failed', 'missing-need'],
    ])
    expect(report.ok).toBe(false)
    // `resolve()` answers per `key × version` row (both items share `npm-package+demo-pkg`), so the
    // per-item outcome is the report's job — that is exactly why the report carries `id`.
    expect(created.status().map(row => row.items)).toEqual([['mem:dependent', 'mem:future']])
  })

  it('未声明区间 ⇒ 不做检查（由包管理器负责兼容性）', async () => {
    const created = provisioner()
    const report = await created.ensure()
    expect(report.entries.map(entry => entry.action)).toEqual(['installed'])
  })
})
