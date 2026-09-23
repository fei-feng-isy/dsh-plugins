import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs, exists } from '../src/fs.js'
import { defaultLock } from '../src/lock.js'
import { createProvisioner } from '../src/provisioner.js'
import { npmPackageProvider } from '../src/providers/npm.js'
import { mergeRows, persistStatus, readDeclared, readStatus } from '../src/state.js'
import type { StatusRow } from '../src/state.js'
import type { Manifest, ProvisionFs, ProvisionItem, ProvisionLogger } from '../src/types.js'
import { createHash } from 'node:crypto'
import { tarGz } from './helpers/tar.js'
import { removeHome } from './helpers/tmp.js'

const silent: ProvisionLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

function packageTarball(version: string): Uint8Array {
  return tarGz([
    { name: 'package/package.json', data: JSON.stringify({ name: 'demo-pkg', version, type: 'module', main: 'index.js' }) },
    { name: 'package/index.js', data: 'export const ok = true\n' },
  ])
}

function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

function hubFor(name: string, version: string, tarball: Uint8Array, integrity: string): typeof fetch {
  const packument = { versions: { [version]: { dist: { tarball: `https://registry.test/${name}/-/${name}-${version}.tgz`, integrity } } } }
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.endsWith('.tgz')) return new Response(tarball, { status: 200 })
    return new Response(JSON.stringify(packument), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

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

describe('合并状态行（key × version）', () => {
  const versioned = (updatedAt: number): StatusRow => ({
    key: 'npm-package+demo-pkg',
    version: '1.0.0',
    items: ['mem:demo'],
    plugins: ['mem'],
    updated_at: updatedAt,
  })

  it('版本行比"无版本行"新 ⇒ 无版本行被折掉，来源标注并入版本行（不留 pending 幽灵）', () => {
    const pending: StatusRow = { key: versioned(1).key, version: '', items: ['job:compat'], plugins: ['job'], updated_at: 1 }
    const merged = mergeRows([pending], [versioned(2)])
    expect(merged.map(row => row.version)).toEqual(['1.0.0'])
    // 折 ≠ 丢：另一个插件在"未决"期间的声明必须留在版本行上。
    expect(merged[0]?.items).toEqual(['job:compat', 'mem:demo'])
    expect(merged[0]?.plugins).toEqual(['job', 'mem'])
  })

  it('"无版本行"更新 ⇒ 保留（它才是当前事实：正在装 / 已跳过）', () => {
    const merged = mergeRows([versioned(1)], [{ ...versioned(3), version: '', items: ['mem:demo'], plugins: ['mem'] }])
    expect(merged.map(row => [row.version, row.updated_at]).sort()).toEqual([['', 3], ['1.0.0', 1]])
  })
})
describe('状态面：status.json / declared.json / .layout.json', () => {
  let home: string
  const fs = defaultFs()
  const tarball = packageTarball('1.0.0')
  const integrity = integrityOf(tarball)

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-state-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(plugin: string): ReturnType<typeof createProvisioner> {
    const created = createProvisioner({ home, logger: silent, fs, fetch: hubFor('demo-pkg', '1.0.0', tarball, integrity) })
    created.register(npmPackageProvider())
    created.declare({ plugin, items: [item({ id: `${plugin}:demo` })] } as Manifest)
    return created
  }

  it('ensure 写出 key × version 的记录，并落 .layout.json', async () => {
    const created = provisioner('mem')
    await created.ensure()

    const layout = JSON.parse(await readFile(join(home, '.envinit', '.layout.json'), 'utf8')) as { layout: string; schemaVersion: number }
    expect(layout).toMatchObject({ layout: 'v1', schemaVersion: 1 })

    const status = await readStatus(fs, home)
    expect(status.kind).toBe('ok')
    if (status.kind !== 'ok') return
    expect(status.rows).toHaveLength(1)
    expect(status.rows[0]).toMatchObject({
      key: 'npm-package+demo-pkg',
      version: '1.0.0',
      items: ['mem:demo'],
      plugins: ['mem'],
      source: 'installed',
    })
  })

  it('两个插件写同一个 key × version 时合并 items/plugins', async () => {
    await provisioner('mem').ensure()
    await provisioner('job').ensure()

    const status = await readStatus(fs, home)
    expect(status.kind).toBe('ok')
    if (status.kind !== 'ok') return
    expect(status.rows).toHaveLength(1)
    expect(status.rows[0]?.items).toEqual(['job:demo', 'mem:demo'])
    expect(status.rows[0]?.plugins).toEqual(['job', 'mem'])
  })

  it('declare 追加声明者登记（key → [{plugin, pid, at}]）', async () => {
    const mem = provisioner('mem')
    const job = provisioner('job')
    // `declare()` writes the registry fire-and-forget; `plan()` is the public way to await it.
    await Promise.all([mem.plan({ only: ['nothing-declared'] }), job.plan({ only: ['nothing-declared'] })])
    const declared = await readDeclared(fs, home)
    const entries = declared['npm-package+demo-pkg'] ?? []
    expect(entries.map(entry => entry.plugin).sort()).toEqual(['job', 'mem'])
    expect(entries.every(entry => entry.pid === process.pid)).toBe(true)
  })

  it('layout 名不一致 ⇒ 只读：所有 item skipped(layout/mismatch)，不写 status.json', async () => {
    await mkdir(join(home, '.envinit'), { recursive: true })
    await writeFile(join(home, '.envinit', '.layout.json'), JSON.stringify({ schemaVersion: 1, layout: 'other', writtenBy: 'x' }))
    const created = provisioner('mem')
    const report = await created.ensure()
    expect(report.ok).toBe(true)
    expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'layout/mismatch' })
    expect(await exists(fs, join(home, '.envinit', 'status.json'))).toBe(false)
  })

  it('layout schemaVersion 更高 ⇒ 只读 skipped(layout/too-new)', async () => {
    await mkdir(join(home, '.envinit'), { recursive: true })
    await writeFile(join(home, '.envinit', '.layout.json'), JSON.stringify({ schemaVersion: 99, layout: 'v1', writtenBy: 'future' }))
    const created = provisioner('mem')
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'layout/too-new' })
    // "只读不写" has to cover the DECLARATION registry too, not just status.json. It did not: the
    // append was kicked off during the synchronous collecting pass, so it landed on disk before the
    // layout verdict existed — and `declared.json` carries no version field of its own, so a home
    // from a future layout had no other protection.
    expect(await exists(fs, join(home, '.envinit', 'declared.json'))).toBe(false)
  })

  it('读不了 .layout.json ⇒ 只读，但报的是 layout/unreadable 而不是 "更新的布局写的"', async () => {
    // An unreadable file shares the read-only CONSEQUENCE and not the meaning: reporting
    // `layout/too-new` told every item's reader "a newer version wrote this, leave it alone" about a
    // home nobody managed to read. A directory where the file belongs is the cheapest real EISDIR.
    await mkdir(join(home, '.envinit', '.layout.json'), { recursive: true })
    const created = provisioner('mem')
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'skipped', code: 'layout/unreadable' })
    expect(await exists(fs, join(home, '.envinit', 'declared.json'))).toBe(false)
  })

  it('status.json 的 schemaVersion 更高 ⇒ 状态面降级为空，不迁移也不覆盖（轴 D）', async () => {
    const path = join(home, '.envinit', 'status.json')
    await mkdir(join(home, '.envinit'), { recursive: true })
    const future = `${JSON.stringify({ schemaVersion: 99, rows: [] }, null, 2)}\n`
    await writeFile(path, future)

    expect((await readStatus(fs, home)).kind).toBe('too-new')
    const result = await persistStatus(
      fs,
      defaultLock(),
      home,
      [{ key: 'k', version: '1', items: ['x'], plugins: ['mem'], updated_at: 1 }],
      silent,
    )
    expect(result).toBe('too-new')
    // The newer file is left exactly as it was.
    expect(await readFile(path, 'utf8')).toBe(future)
  })

  it('状态面写不进去 ⇒ 报 read-only，不抛', async () => {
    const failing: ProvisionFs = {
      ...fs,
      atomicWrite: async () => {
        throw Object.assign(new Error('EACCES: read-only file system'), { code: 'EACCES' })
      },
    }
    const result = await persistStatus(
      failing,
      defaultLock(),
      home,
      [{ key: 'k', version: '1', items: ['x'], plugins: ['mem'], updated_at: 1 }],
      silent,
    )
    expect(result).toBe('read-only')
  })
})
