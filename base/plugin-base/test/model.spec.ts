import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs, exists } from '../src/fs.js'
import { createProvisioner } from '../src/provisioner.js'
import { modelCacheProvider } from '../src/providers/model.js'
import type { Manifest, ProvisionFs, ProvisionItem, ProvisionLogger } from '../src/types.js'
import { removeHome } from './helpers/tmp.js'

const silent: ProvisionLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const REPO = 'BAAI/bge-small-zh-v1.5'
const SHA = 'a'.repeat(40)
const FLAT_DATA = join('BAAI', 'bge-small-zh-v1.5')
const FLAT_SIDECAR = join('.envinit', 'models--BAAI--bge-small-zh-v1.5')

const FILES: Record<string, string> = {
  'config.json': '{"model_type":"bert"}',
  'tokenizer.json': '{"version":"1.0"}',
  'tokenizer_config.json': '{}',
  // Model repos routinely keep weights in subdirectories; the snapshot link must resolve from depth.
  'onnx/model.onnx': 'WEIGHTS',
}

/** A fake hub endpoint: revision resolution, sibling listing and file resolve. */
function fakeHub(seen: string[] = [], delayMs = 0): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    seen.push(url)
    // A delay widens the window two concurrent installers can overlap in.
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    const revision = /\/api\/models\/.+\/revision\/(.+)$/.exec(url)
    if (revision !== null) return new Response(JSON.stringify({ sha: SHA }), { status: 200 })
    if (url.endsWith(`/api/models/${REPO}`)) {
      return new Response(JSON.stringify({ siblings: Object.keys(FILES).map(rfilename => ({ rfilename })) }), { status: 200 })
    }
    const resolve = /\/resolve\/[^/]+\/(.+)$/.exec(url)
    if (resolve !== null) {
      const content = FILES[resolve[1] ?? '']
      if (content === undefined) return new Response('missing', { status: 404 })
      return new Response(content, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

function item(overrides: Partial<ProvisionItem> = {}): ProvisionItem {
  return {
    id: 'mem:model',
    kind: 'model-cache',
    spec: { repo: REPO },
    target: { root: 'models' },
    schemaVersion: 1,
    ...overrides,
  }
}

describe('model-cache provider（受管例外）', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-model-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(fetchImpl: typeof fetch): ReturnType<typeof createProvisioner> {
    const created = createProvisioner({ home, logger: silent, fs, fetch: fetchImpl })
    created.register(modelCacheProvider())
    return created
  }

  it('解析 revision → 写入 hub 形状缓存 → 复用 present', async () => {
    const created = provisioner(fakeHub())
    created.declare({ plugin: 'mem', items: [item()] } as Manifest)

    const report = await created.ensure()
    expect(report.ok).toBe(true)
    expect(report.entries[0]).toMatchObject({ action: 'installed', version: SHA, key: `model-cache+${REPO}` })

    const root = join(home, 'models', 'models--BAAI--bge-small-zh-v1.5')
    const snapshot = join(root, 'snapshots', SHA)
    expect(await exists(fs, join(snapshot, 'config.json'))).toBe(true)
    expect(await readFile(join(snapshot, 'config.json'), 'utf8')).toBe(FILES['config.json'])
    // Nested files link through the same blob; the link must resolve, not dangle.
    expect(await readFile(join(snapshot, 'onnx', 'model.onnx'), 'utf8')).toBe(FILES['onnx/model.onnx'])
    expect(await readFile(join(root, 'refs', 'main'), 'utf8')).toBe(SHA)
    // This kind deliberately has no install.json.
    expect(await exists(fs, join(snapshot, 'install.json'))).toBe(false)
    expect(await exists(fs, join(root, 'install.json'))).toBe(false)

    const again = await created.ensure()
    expect(again.entries[0]?.action).toBe('present')
    expect(created.resolve('mem:model')).toMatchObject({ state: 'ready' })
  })

  it('缺少必需文件 ⇒ verify/failed，且只隔离这个 snapshot', async () => {
    const created = provisioner(fakeHub())
    created.declare({ plugin: 'mem', items: [item({ spec: { repo: REPO, requiredFiles: ['missing.json'] } })] } as Manifest)
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })
    // `Resolved.dir` is the version directory (the snapshot), never the whole per-repo cache: a
    // sibling revision must survive another revision's failed verify.
    const root = join(home, 'models', 'models--BAAI--bge-small-zh-v1.5')
    expect(await exists(fs, join(root, 'snapshots', SHA))).toBe(false)
    expect(await exists(fs, root)).toBe(true)
  })

  it('快照被删但记录还在 ⇒ plan 按记录给出 sha（记录版本不是 semver 也要能用）', async () => {
    const created = provisioner(fakeHub())
    created.declare({ plugin: 'mem', items: [item()] } as Manifest)
    await created.ensure()

    // The snapshot is gone, so only the resolution record can answer — and its version is a sha,
    // while the item's identity range is the *revision* (`main`).
    await rm(join(home, 'models', `models--${REPO.replaceAll('/', '--')}`, 'snapshots', SHA), { recursive: true, force: true })
    const planned = (await created.plan()).entries[0]
    expect(planned).toMatchObject({ action: 'install', version: SHA })
  })

  it('sha 固定时，崩溃残留的半快照（没有 refs/<sha> 完成标记）不会被当成 present', async () => {
    const created = provisioner(fakeHub())
    created.declare({ plugin: 'mem', items: [item({ spec: { repo: REPO, revision: SHA } })] } as Manifest)
    const root = join(home, 'models', `models--${REPO.replaceAll('/', '--')}`)
    const snapshot = join(root, 'snapshots', SHA)
    // A download that crashed after the first file: the directory and config.json exist, refs does not.
    await mkdir(snapshot, { recursive: true })
    await writeFile(join(snapshot, 'config.json'), FILES['config.json'] ?? '{}')

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed', version: SHA })
    expect(await readFile(join(root, 'refs', SHA), 'utf8')).toBe(SHA)
    const again = await created.ensure()
    expect(again.entries[0]?.action).toBe('present')
  })

  it('sha 固定时，refs 内容与钉死值不符 ⇒ 不算缓存，重装后自愈', async () => {
    const created = provisioner(fakeHub())
    created.declare({ plugin: 'mem', items: [item({ spec: { repo: REPO, revision: SHA } })] } as Manifest)
    const root = join(home, 'models', `models--${REPO.replaceAll('/', '--')}`)
    const snapshot = join(root, 'snapshots', SHA)
    await mkdir(snapshot, { recursive: true })
    await writeFile(join(snapshot, 'config.json'), FILES['config.json'] ?? '{}')
    // A foreign cache: the marker exists but names another revision, so the pin cannot trust it.
    await mkdir(join(root, 'refs'), { recursive: true })
    await writeFile(join(root, 'refs', SHA), 'b'.repeat(40))

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed', version: SHA })
    expect(await readFile(join(root, 'refs', SHA), 'utf8')).toBe(SHA)
    const again = await created.ensure()
    expect(again.entries[0]?.action).toBe('present')
  })

  it('文件列表来自 API siblings（spec.files 可覆盖）', async () => {
    const created = provisioner(fakeHub())
    created.declare({ plugin: 'mem', items: [item({ spec: { repo: REPO, files: ['config.json'] } })] } as Manifest)
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    const snapshot = join(home, 'models', 'models--BAAI--bge-small-zh-v1.5', 'snapshots', SHA)
    expect(await exists(fs, join(snapshot, 'config.json'))).toBe(true)
    expect(await exists(fs, join(snapshot, 'tokenizer.json'))).toBe(false)
  })
})

describe('model-cache provider（flat 布局）', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-model-flat-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(options: {
    readonly fetch: typeof fetch
    readonly fs?: ProvisionFs
    readonly mirrors?: readonly string[]
  }): ReturnType<typeof createProvisioner> {
    const created = createProvisioner({
      home,
      logger: silent,
      fs: options.fs ?? fs,
      fetch: options.fetch,
      ...(options.mirrors === undefined ? {} : { policy: { mirrors: { archive: [], model: options.mirrors } } }),
    })
    created.register(modelCacheProvider())
    return created
  }

  function flatItem(overrides: Partial<ProvisionItem> = {}): ProvisionItem {
    return item({ spec: { repo: REPO, layout: 'flat' }, ...overrides })
  }

  function declareItem(created: ReturnType<typeof createProvisioner>, declared: ProvisionItem): void {
    created.declare({ plugin: 'mem', items: [declared] } as Manifest)
  }

  const dataDir = (): string => join(home, 'models', FLAT_DATA)
  const sidecarDir = (): string => join(home, 'models', FLAT_SIDECAR)

  it('落盘形如 <root>/<repo>/<file>，版本记录在侧车而不是运行时读的目录', async () => {
    const seen: string[] = []
    const created = provisioner({ fetch: fakeHub(seen) })
    declareItem(created, flatItem())

    const report = await created.ensure()
    expect(report.ok).toBe(true)
    expect(report.entries[0]).toMatchObject({ action: 'installed', version: SHA, key: `model-cache+${REPO}` })

    expect(await readFile(join(dataDir(), 'config.json'), 'utf8')).toBe(FILES['config.json'])
    // 子目录文件也要落到位，并指向内容寻址的 blob。
    expect(await readFile(join(dataDir(), 'onnx', 'model.onnx'), 'utf8')).toBe(FILES['onnx/model.onnx'])
    expect((await lstat(join(dataDir(), 'config.json'))).isSymbolicLink()).toBe(true)
    // 不是 hub 布局：没有 models--…/snapshots/… 树。
    expect(await exists(fs, join(home, 'models', 'models--BAAI--bge-small-zh-v1.5'))).toBe(false)
    // revision/版本记录不进运行时读的目录。
    expect(await exists(fs, join(dataDir(), 'refs'))).toBe(false)
    expect(await exists(fs, join(dataDir(), 'record.json'))).toBe(false)
    const record: unknown = JSON.parse(await readFile(join(sidecarDir(), 'record.json'), 'utf8'))
    expect(record).toMatchObject({ repo: REPO, revision: 'main', sha: SHA, files: Object.keys(FILES) })

    const before = seen.length
    const again = await created.ensure()
    expect(again.entries[0]).toMatchObject({ action: 'present', version: SHA, source: 'managed' })
    expect(seen.length).toBe(before)
    const state = created.resolve('mem:model')
    expect(state.state).toBe('ready')
    if (state.state === 'ready') expect(state.handle.dir).toBe(dataDir())
  })

  it('probe 完全离线：落位后 plan/ensure 不再触网', async () => {
    const created = provisioner({ fetch: fakeHub() })
    declareItem(created, flatItem())
    await created.ensure()

    const forbidden = (() => {
      throw new Error('network disabled')
    }) as unknown as typeof fetch
    const offline = provisioner({ fetch: forbidden })
    declareItem(offline, flatItem())
    const planned = await offline.plan()
    expect(planned.entries[0]).toMatchObject({ action: 'present', version: SHA })
    const report = await offline.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'present', version: SHA })
  })

  it('verify 至少要求 config.json，spec.requiredFiles 在其上追加', async () => {
    const created = provisioner({ fetch: fakeHub() })
    // 文件列表里没有 config.json：装了也不算可用。
    declareItem(created, flatItem({ spec: { repo: REPO, layout: 'flat', files: ['tokenizer.json'] } }))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })
    // 失败的那份被移走隔离，不留半可用的数据目录。
    expect(await exists(fs, dataDir())).toBe(false)
    expect(await exists(fs, join(home, 'models'))).toBe(true)

    const extra = provisioner({ fetch: fakeHub() })
    declareItem(extra, flatItem({ spec: { repo: REPO, layout: 'flat', files: ['config.json', 'tokenizer.json'], requiredFiles: ['missing.json'] } }))
    const second = await extra.ensure()
    expect(second.entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })
  })

  it('幂等：第二次 ensure 一个字节都不重下', async () => {
    const seen: string[] = []
    const created = provisioner({ fetch: fakeHub(seen) })
    declareItem(created, flatItem())
    await created.ensure()
    const afterFirst = seen.length
    expect(afterFirst).toBeGreaterThan(0)

    await created.ensure()
    expect(seen.length).toBe(afterFirst)
  })

  it('并发安装同一项：两边都能落地、blob 不被复制覆盖、随后 present', async () => {
    const a = provisioner({ fetch: fakeHub([], 10) })
    const b = provisioner({ fetch: fakeHub([], 10) })
    declareItem(a, flatItem())
    declareItem(b, flatItem())

    const [first, second] = await Promise.all([a.ensure(), b.ensure()])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.entries[0]?.action).toBe('installed')
    expect(second.entries[0]?.action).toBe('installed')

    expect(await readFile(join(dataDir(), 'config.json'), 'utf8')).toBe(FILES['config.json'])
    expect(await readFile(join(dataDir(), 'onnx', 'model.onnx'), 'utf8')).toBe(FILES['onnx/model.onnx'])
    const blobs = await readdir(join(sidecarDir(), 'blobs'))
    expect(blobs.length).toBe(Object.keys(FILES).length)
    for (const blob of blobs) {
      const info = await fs.stat(join(sidecarDir(), 'blobs', blob))
      expect(info?.size).toBeGreaterThan(0)
    }

    const third = provisioner({ fetch: fakeHub() })
    declareItem(third, flatItem())
    expect((await third.ensure()).entries[0]?.action).toBe('present')
  })

  it('跨设备 / 无符号链接：退化为原子写入的实体文件，内容仍正确且可探测', async () => {
    const noSymlinks: ProvisionFs = {
      ...defaultFs(),
      symlink: async () => {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      },
    }
    const created = provisioner({ fetch: fakeHub(), fs: noSymlinks })
    declareItem(created, flatItem())
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed' })

    expect((await lstat(join(dataDir(), 'config.json'))).isSymbolicLink()).toBe(false)
    expect(await readFile(join(dataDir(), 'config.json'), 'utf8')).toBe(FILES['config.json'])
    expect(await readFile(join(dataDir(), 'onnx', 'model.onnx'), 'utf8')).toBe(FILES['onnx/model.onnx'])
    expect((await created.ensure()).entries[0]?.action).toBe('present')
  })

  it('远端文件列表为空 ⇒ fetch/failed', async () => {
    const empty = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (/\/api\/models\/.+\/revision\//.test(url)) return new Response(JSON.stringify({ sha: SHA }), { status: 200 })
      if (url.endsWith(`/api/models/${REPO}`)) return new Response(JSON.stringify({ siblings: [] }), { status: 200 })
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const created = provisioner({ fetch: empty })
    declareItem(created, flatItem())
    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'failed', code: 'fetch/failed' })
  })

  it('spec.files 显式为空 ⇒ invalid-option，不去猜远端列表', async () => {
    const seen: string[] = []
    const created = provisioner({ fetch: fakeHub(seen) })
    declareItem(created, flatItem({ spec: { repo: REPO, layout: 'flat', files: [] } }))
    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'failed', code: 'invalid-option' })
    expect(seen).toEqual([])
  })

  it('policy.mirrors.model 提供 endpoint，spec.endpoint 覆盖它', async () => {
    const mirrored: string[] = []
    const created = provisioner({ fetch: fakeHub(mirrored), mirrors: ['https://mirror.test'] })
    declareItem(created, flatItem({ spec: { repo: REPO, layout: 'flat', files: ['config.json'] } }))
    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'installed' })
    expect(mirrored.length).toBeGreaterThan(0)
    expect(mirrored.every(url => url.startsWith('https://mirror.test/'))).toBe(true)
    expect(mirrored.some(url => url.includes('/revision/main'))).toBe(true)
    expect(mirrored.some(url => url.includes('/resolve/'))).toBe(true)

    const explicitHome = await mkdtemp(join(tmpdir(), 'envinit-model-flat-'))
    try {
      const explicit: string[] = []
      const direct = createProvisioner({
        home: explicitHome,
        logger: silent,
        fs,
        fetch: fakeHub(explicit),
        policy: { mirrors: { archive: [], model: ['https://mirror.test'] } },
      })
      direct.register(modelCacheProvider())
      direct.declare({
        plugin: 'mem',
        items: [item({ spec: { repo: REPO, layout: 'flat', files: ['config.json'], endpoint: 'https://explicit.test' } })],
      } as Manifest)
      expect((await direct.ensure()).entries[0]).toMatchObject({ action: 'installed' })
      expect(explicit.every(url => url.startsWith('https://explicit.test/'))).toBe(true)
    } finally {
      await removeHome(explicitHome)
    }
  })

  it('probe 与 install 判据一致：revision 不符就不算缓存', async () => {
    const created = provisioner({ fetch: fakeHub() })
    declareItem(created, flatItem())
    expect((await created.ensure()).entries[0]?.action).toBe('installed')
    expect((await created.ensure()).entries[0]?.action).toBe('present')

    const moved = provisioner({ fetch: fakeHub() })
    declareItem(moved, flatItem({ spec: { repo: REPO, layout: 'flat', revision: 'v2' } }))
    expect((await moved.ensure()).entries[0]?.action).toBe('installed')
    expect(JSON.parse(await readFile(join(sidecarDir(), 'record.json'), 'utf8'))).toMatchObject({ revision: 'v2' })

    const back = provisioner({ fetch: fakeHub() })
    declareItem(back, flatItem())
    expect((await back.ensure()).entries[0]?.action).toBe('installed')
  })

  it('非法的 spec.layout ⇒ invalid-option（声明期就拒）', () => {
    const created = provisioner({ fetch: fakeHub() })
    expect(() => {
      declareItem(created, flatItem({ spec: { repo: REPO, layout: 'tree' } }))
    }).toThrow(/spec\.layout/)
  })
})
