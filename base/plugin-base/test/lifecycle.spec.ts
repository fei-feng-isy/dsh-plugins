/**
 * The startup critical path has one shared budget. Items that do not settle inside it
 * keep running in the background, answer `pending` in the meantime, and flip to `ready` through an
 * `availability` event — degraded is a state, not a terminal one.
 *
 * @module test/lifecycle
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exists, defaultFs } from '../src/fs.js'
import { createProvisioner } from '../src/provisioner.js'
import { readStatus } from '../src/state.js'
import { npmPackageProvider } from '../src/providers/npm.js'
import type { Manifest, ProvisionEvent, ProvisionItem, ProvisionLogger, ResourceState } from '../src/types.js'
import { integrityOf, packageTarball, registryFor } from './helpers/registry.js'
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

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('test: timed out waiting for the background item')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('启动关键路径预算 + 晚到可用', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-lifecycle-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  /** A fetch that only answers once the test releases it. */
  function gatedRegistry(): { readonly fetch: typeof fetch; readonly release: () => void } {
    const tarball = packageTarball()
    const integrity = integrityOf(tarball)
    const packument = JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://registry.test/demo-pkg/-/demo-pkg-1.0.0.tgz', integrity } } } })
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      await gate
      return String(input).endsWith('.tgz')
        ? new Response(tarball, { status: 200 })
        : new Response(packument, { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetch: impl, release: () => release() }
  }

  function provisioner(options: { readonly fetch: typeof fetch; readonly deadlineMs: number; readonly items?: readonly ProvisionItem[]; readonly events?: ProvisionEvent[] }) {
    const created = createProvisioner({ home, logger: silent, fs: defaultFs(), fetch: options.fetch, policy: { deadlineMs: options.deadlineMs } })
    created.register(npmPackageProvider())
    const manifest: Manifest = { plugin: 'mem', items: options.items === undefined ? [item()] : [...options.items] }
    created.declare(manifest)
    if (options.events !== undefined) created.experimental().on('availability', event => options.events?.push(event))
    return created
  }

  it('预算内完成：照常进 report，resolve() 是 ready', async () => {
    const tarball = packageTarball()
    const registry = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith('.tgz')
        ? new Response(tarball, { status: 200 })
        : new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://registry.test/x.tgz', integrity: integrityOf(tarball) } } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch
    const created = provisioner({ fetch: registry, deadlineMs: 5_000 })
    const report = await created.ensure()

    expect(report.entries.map(entry => entry.action)).toEqual(['installed'])
    expect(created.resolve('mem:demo').state).toBe('ready')
  })

  it('超预算：ensure 立刻返回，item 是 pending；完成后转 ready 并发 availability', async () => {
    const gate = gatedRegistry()
    const events: ProvisionEvent[] = []
    const created = provisioner({ fetch: gate.fetch, deadlineMs: 5, events })

    const started = Date.now()
    const report = await created.ensure()
    expect(Date.now() - started).toBeLessThan(1_000)
    // An unfinished item is not in the returned report; `resolve()` is where pending shows up.
    expect(report.entries).toEqual([])
    expect(report.ok).toBe(true)
    const pending = created.resolve('mem:demo')
    expect(pending.state).toBe('pending')
    expect(pending).toMatchObject({ state: 'pending' })
    expect(typeof (pending as { since?: number }).since).toBe('number')
    expect(created.status().map(row => row.state.state)).toEqual(['pending'])

    gate.release()
    await waitFor(() => created.resolve('mem:demo').state === 'ready')
    const ready = created.resolve('mem:demo') as Extract<ResourceState, { state: 'ready' }>
    expect(ready.handle.source).toBe('installed')
    expect(await exists(defaultFs(), join(home, 'runtime', 'demo-pkg', '1.0.0', 'install.json'))).toBe(true)
    // The union narrows on `type`: only availability events carry a state.
    expect(events.map(event => (event.type === 'availability' ? event.state.state : event.type))).toEqual(['pending', 'ready'])
  })

  it('预算被前一项耗尽时，后面的项也转后台（一个预算，不是每项一个）', async () => {
    const gate = gatedRegistry()
    const created = provisioner({
      fetch: gate.fetch,
      deadlineMs: 5,
      items: [item({ id: 'mem:first' }), item({ id: 'mem:second', spec: { name: 'demo-pkg', range: '^1.0.0' } })],
    })
    const report = await created.ensure()
    expect(report.entries).toEqual([])
    expect(created.resolve('mem:first').state).toBe('pending')
    expect(created.resolve('mem:second').state).toBe('pending')

    gate.release()
    await waitFor(() => created.resolve('mem:first').state === 'ready' && created.resolve('mem:second').state === 'ready')
  })

  it('后台项只下载一次：再跑一次 ensure 会加入同一个进行中的 promise', async () => {
    const gate = gatedRegistry()
    const created = provisioner({ fetch: gate.fetch, deadlineMs: 5 })
    await created.ensure()
    expect(created.resolve('mem:demo').state).toBe('pending')

    // A second ensure while the first download is in flight joins it instead of starting another.
    const second = await created.ensure()
    expect(second.entries).toEqual([])
    gate.release()
    await waitFor(() => created.resolve('mem:demo').state === 'ready')
  })

  it('on() 只投递订阅的那种事件，Disposable 立刻停止投递', async () => {
    const tarball = packageTarball()
    const registry = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith('.tgz')
        ? new Response(tarball, { status: 200 })
        : new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://registry.test/x.tgz', integrity: integrityOf(tarball) } } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch
    const created = provisioner({ fetch: registry, deadlineMs: 5_000 })
    const availability: ProvisionEvent[] = []
    const reports: ProvisionEvent[] = []
    const subscription = created.experimental().on('availability', event => availability.push(event))
    created.experimental().on('report', event => reports.push(event))

    await created.ensure()
    expect(availability.length).toBeGreaterThan(0)
    expect(availability.every(event => event.type === 'availability')).toBe(true)
    expect(reports.map(event => event.type)).toEqual(['report'])

    subscription.dispose()
    const before = availability.length
    await created.ensure()
    expect(availability.length).toBe(before)
  })

  it('ensure({only, deadlineMs}) 让"挂载前必须就绪"的那几项阻塞，其余仍走后台', async () => {
    const packages = new Map(
      ['front-pkg', 'back-pkg'].map(name => {
        const tarball = packageTarball({ name })
        return [name, { tarball, integrity: integrityOf(tarball) }]
      }),
    )
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    // The front item answers at once; the back item is held until the test releases it.
    const splitFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      const name = url.includes('back-pkg') ? 'back-pkg' : 'front-pkg'
      const pkg = packages.get(name)
      if (pkg === undefined) return new Response('unknown', { status: 404 })
      if (url.endsWith('.tgz')) return new Response(pkg.tarball, { status: 200 })
      if (name === 'back-pkg') await gate
      return new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: `https://registry.test/${name}/-/${name}-1.0.0.tgz`, integrity: pkg.integrity } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    // Instance-wide budget is 0: nothing blocks unless the call asks for it.
    const created = provisioner({
      fetch: splitFetch,
      deadlineMs: 0,
      items: [
        item({ id: 'mem:front', spec: { name: 'front-pkg', range: '^1.0.0' } }),
        item({ id: 'mem:back', spec: { name: 'back-pkg', range: '^1.0.0' } }),
      ],
    })

    // The pre-mount phase: wait for the one item the plugin's own check needs.
    const front = await created.ensure({ only: ['mem:front'], deadlineMs: 5_000 })
    expect(front.entries.map(entry => [entry.id, entry.action])).toEqual([['mem:front', 'installed']])
    expect(created.resolve('mem:front').state).toBe('ready')
    // The other item was never even started by that call.
    expect(created.resolve('mem:back')).toEqual({ state: 'missing' })

    // And the ordinary call keeps the instance budget: dispatch, do not wait.
    const rest = await created.ensure()
    expect(rest.entries).toEqual([])
    expect(created.resolve('mem:back').state).toBe('pending')
    release()
    await waitFor(() => created.resolve('mem:back').state === 'ready')
  })

  it("startup: 'background' ⇒ 这一项不进等待集：门禁包同步、模型异步", async () => {
    const packages = new Map(
      ['gate-pkg', 'model-pkg'].map(name => {
        const tarball = packageTarball({ name })
        return [name, { tarball, integrity: integrityOf(tarball) }]
      }),
    )
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    // The gate package answers at once; the model download is held (and is 100x bigger in reality).
    const splitFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      const name = url.includes('model-pkg') ? 'model-pkg' : 'gate-pkg'
      const pkg = packages.get(name)
      if (pkg === undefined) return new Response('unknown', { status: 404 })
      if (url.endsWith('.tgz')) return new Response(pkg.tarball, { status: 200 })
      if (name === 'model-pkg') await gate
      return new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: `https://registry.test/${name}/-/${name}-1.0.0.tgz`, integrity: pkg.integrity } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const created = provisioner({
      fetch: splitFetch,
      deadlineMs: 30_000, // generous: only the *declared* async item may still be skipped
      items: [
        item({ id: 'mem:gate', spec: { name: 'gate-pkg', range: '^1.0.0' } }),
        item({ id: 'mem:model', spec: { name: 'model-pkg', range: '^1.0.0' }, startup: 'background' }),
      ],
    })

    const started = Date.now()
    const report = await created.ensure()
    // The blocking item is awaited and reported; the background one is dispatched, not waited for.
    expect(report.entries.map(entry => [entry.id, entry.action])).toEqual([['mem:gate', 'installed']])
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(created.resolve('mem:model').state).toBe('pending')

    release()
    await waitFor(() => created.resolve('mem:model').state === 'ready')
  })

  it('background 项被 blocking 项 need 时自动升为 blocking（否则"等它"是假的）', async () => {
    const tarball = packageTarball()
    const registry = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith('.tgz')
        ? new Response(tarball, { status: 200 })
        : new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://registry.test/x.tgz', integrity: integrityOf(tarball) } } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch
    const created = provisioner({
      fetch: registry,
      deadlineMs: 5_000,
      items: [
        item({ id: 'mem:base', startup: 'background' }),
        item({ id: 'mem:derived', needs: ['mem:base'] }),
      ],
    })

    const report = await created.ensure()
    // Both are decided (and reported in dependency order) because `derived` cannot wait on
    // something nobody is waiting for.
    expect(report.entries.map(entry => entry.id)).toEqual(['mem:base', 'mem:derived'])
  })

  it('onSettled：异步项完成时回调，带完整执行结果，可在其之后做后续操作', async () => {
    const packages = new Map(
      ['gate-pkg', 'model-pkg'].map(name => {
        const bytes = packageTarball({ name })
        return [name, { tarball: bytes, integrity: integrityOf(bytes) }]
      }),
    )
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const splitFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      const name = url.includes('model-pkg') ? 'model-pkg' : 'gate-pkg'
      const pkg = packages.get(name)
      if (pkg === undefined) return new Response('unknown', { status: 404 })
      if (url.endsWith('.tgz')) return new Response(pkg.tarball, { status: 200 })
      if (name === 'model-pkg') await gate
      return new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: `https://registry.test/${name}/-/${name}-1.0.0.tgz`, integrity: pkg.integrity } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const settled: string[] = []
    const followUp: string[] = []
    const created = provisioner({
      fetch: splitFetch,
      deadlineMs: 30_000,
      items: [
        item({ id: 'mem:gate', spec: { name: 'gate-pkg', range: '^1.0.0' } }),
        item({ id: 'mem:model', spec: { name: 'model-pkg', range: '^1.0.0' }, startup: 'background' }),
      ],
    })

    const report = await created.ensure({
      onSettled: entry => {
        settled.push(`${entry.id}:${entry.action}:${String(entry.version ?? '')}`)
        // 后继操作就放在这里 —— 回调拿到的是与报告同一行的执行结果。
        if (entry.id === 'mem:model' && entry.action === 'installed') followUp.push('semantic-search-on')
      },
    })
    // 同步项在返回前就回调了；异步项还没有（它甚至不在报告里）。
    expect(settled).toEqual(['mem:gate:installed:1.0.0'])
    expect(report.entries.map(entry => entry.id)).toEqual(['mem:gate'])
    expect(followUp).toEqual([])

    release()
    await waitFor(() => created.resolve('mem:model').state === 'ready')
    await waitFor(() => followUp.length === 1)
    expect(settled).toEqual(['mem:gate:installed:1.0.0', 'mem:model:installed:1.0.0'])
    expect(followUp).toEqual(['semantic-search-on'])
  })

  it('后台项就绪后不留"没有版本"的 pending 残留行（key × version）', async () => {
    const gate = gatedRegistry()
    const created = provisioner({ fetch: gate.fetch, deadlineMs: 30_000, items: [item({ id: 'mem:model', startup: 'background' })] })

    const report = await created.ensure()
    expect(report.entries).toEqual([]) // 不占预算、不进报告
    expect(created.status().map(row => [row.version, row.state.state])).toEqual([['', 'pending']])

    gate.release()
    await waitFor(() => created.resolve('mem:model').state === 'ready')
    // The pre-version `pending` row is the same item's older face: keeping it would leave a phantom
    // row in `status.json` forever, which `doctor`/`status()` would report as "still installing".
    expect(created.status().map(row => [row.version, row.state.state])).toEqual([['1.0.0', 'ready']])

    // A second item sharing the resource (same kind+name ⇒ same key) reads the versioned row too —
    // even while its own attempt is still in flight.
    // Both items start together and *both* miss their probe (nothing is on disk yet), so each goes
    // to its own download: the first is held at the tarball, the second at its packument. When the
    // first settles, the second is still in flight — anything it can answer must come from the
    // shared, now-versioned row.
    let packuments = 0
    let tarballs = 0
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const secondGate = new Promise<void>(resolve => {
      releaseSecond = resolve
    })
    const tarball = packageTarball()
    const sharedFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (!url.endsWith('.tgz')) {
        packuments += 1
        if (packuments > 1) await secondGate
        return new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://registry.test/demo-pkg/-/demo-pkg-1.0.0.tgz', integrity: integrityOf(tarball) } } } }), { status: 200 })
      }
      tarballs += 1
      if (tarballs === 1) await firstGate
      return new Response(tarball, { status: 200 })
    }) as unknown as typeof fetch

    // Its own home: the resource must be genuinely absent, or both probes would hit the copy the
    // earlier part of this test already installed.
    const sharedHome = await mkdtemp(join(tmpdir(), 'envinit-lifecycle-shared-'))
    const shared = createProvisioner({ home: sharedHome, logger: silent, fs: defaultFs(), fetch: sharedFetch, policy: { deadlineMs: 1_000 } })
    shared.register(npmPackageProvider())
    shared.declare({ plugin: 'mem', items: [item({ id: 'mem:model', startup: 'background' }), item({ id: 'mem:model-alias', startup: 'background' })] } as Manifest)
    expect((await shared.ensure()).entries).toEqual([])
    expect(shared.status().map(row => [row.version, row.state.state])).toEqual([['', 'pending']]) // 两项共一行
    releaseFirst()
    await waitFor(() => shared.resolve('mem:model').state === 'ready')
    await waitFor(() => packuments > 1) // 第二项已经卡在自己的 packument 上
    // 第一项已经把资源装好了：别名项此刻只可能通过"并入版本行"读到 ready。
    expect(shared.resolve('mem:model-alias').state).toBe('ready')
    expect(shared.status().map(row => [row.version, row.state.state])).toEqual([['1.0.0', 'ready']])
    releaseSecond()
    await waitFor(() => shared.status().every(row => row.state.state === 'ready'))
    await removeHome(sharedHome)
  })

  it('后台项的"无版本"行落盘后也会被折掉（整文件合并，不只是内存）', async () => {
    const packages = new Map(
      ['gate-pkg', 'model-pkg'].map(name => {
        const bytes = packageTarball({ name })
        return [name, { tarball: bytes, integrity: integrityOf(bytes) }]
      }),
    )
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const splitFetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      const name = url.includes('model-pkg') ? 'model-pkg' : 'gate-pkg'
      const pkg = packages.get(name)
      if (pkg === undefined) return new Response('unknown', { status: 404 })
      if (url.endsWith('.tgz')) return new Response(pkg.tarball, { status: 200 })
      if (name === 'model-pkg') await gate
      return new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: `https://registry.test/${name}/-/${name}-1.0.0.tgz`, integrity: pkg.integrity } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const created = provisioner({
      fetch: splitFetch,
      deadlineMs: 30_000,
      items: [
        item({ id: 'mem:gate', spec: { name: 'gate-pkg', range: '^1.0.0' } }),
        item({ id: 'mem:model', spec: { name: 'model-pkg', range: '^1.0.0' }, startup: 'background' }),
      ],
    })

    // The blocking item settling persists the batch — which is how the background item's
    // version-less `pending` row (same resource key × "") reaches `status.json` at all.
    await created.ensure()
    const during = await readStatus(defaultFs(), home)
    expect(during.kind).toBe('ok')
    if (during.kind !== 'ok') throw new Error('unreachable')
    expect(during.rows.map(row => [row.key, row.version])).toContainEqual([`npm-package+model-pkg`, ''])

    release()
    await waitFor(() => created.resolve('mem:model').state === 'ready')
    // The background persist runs after the item settles; poll for it, then assert no phantom row
    // survives the whole-file merge (a merge cannot delete, so it has to fold).
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const now = await readStatus(defaultFs(), home)
      if (now.kind === 'ok' && now.rows.every(row => row.version !== '')) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const after = await readStatus(defaultFs(), home)
    expect(after.kind).toBe('ok')
    if (after.kind !== 'ok') throw new Error('unreachable')
    expect(after.rows.map(row => [row.key, row.version]).sort()).toEqual([
      ['npm-package+gate-pkg', '1.0.0'],
      ['npm-package+model-pkg', '1.0.0'],
    ])
  })

  it('onSettled 回调抛错不影响预装（只记一条 WARNING）', async () => {
    const tarball = packageTarball()
    const created = provisioner({ fetch: registryFor('demo-pkg', '1.0.0', tarball, integrityOf(tarball)), deadlineMs: 5_000 })
    let called = 0
    const report = await created.ensure({
      onSettled: () => {
        called += 1
        throw new Error('callback is broken')
      },
    })
    expect(report.entries.map(entry => entry.action)).toEqual(['installed'])
    expect(called).toBe(1)
    expect(created.resolve('mem:demo').state).toBe('ready')
  })

  it('deadlineMs=0 ⇒ 一律先挂载、后预装，仍能最终就绪', async () => {
    const tarball = packageTarball()
    const registry = (async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith('.tgz')
        ? new Response(tarball, { status: 200 })
        : new Response(JSON.stringify({ versions: { '1.0.0': { dist: { tarball: 'https://registry.test/x.tgz', integrity: integrityOf(tarball) } } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch
    const created = provisioner({ fetch: registry, deadlineMs: 0 })
    const report = await created.ensure()
    expect(report.entries).toEqual([])
    await waitFor(() => created.resolve('mem:demo').state === 'ready')
  })
})
