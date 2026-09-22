/**
 * Regression cover for the model-cache provider's placement, path safety, content verification and
 * concurrency contracts, plus the two-process completion-marker invariant.
 *
 * @module test/model-hardening
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs, exists } from '../src/fs.js'
import { createProvisioner } from '../src/provisioner.js'
import { modelCacheProvider } from '../src/providers/model.js'
import type { Manifest, ProvisionFs, ProvisionItem, ProvisionLogger } from '../src/types.js'
import { removeHome } from './helpers/tmp.js'

const silent: ProvisionLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const REPO = 'BAAI/bge-small-zh-v1.5'
const SHA = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const CONFIG = '{"model_type":"bert"}'
const TOKEN = '{"version":"1.0"}'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A permissive endpoint: any repo, a configurable sha and per-path content, optional latency. */
function fakeHub(options: { readonly sha?: string; readonly content?: Readonly<Record<string, string>>; readonly delayMs?: number } = {}): typeof fetch {
  const content = options.content ?? { 'config.json': CONFIG, 'tokenizer.json': TOKEN }
  const sha = options.sha ?? SHA
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (/\/api\/models\/.+\/revision\//.test(url)) return new Response(JSON.stringify({ sha }), { status: 200 })
    if (/\/api\/models\/[^/]+\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ siblings: Object.keys(content).map(rfilename => ({ rfilename })) }), { status: 200 })
    }
    const resolve = /\/resolve\/[^/]+\/(.+)$/.exec(url)
    if (resolve !== null) {
      const body = content[resolve[1] ?? '']
      if (body === undefined) return new Response('missing', { status: 404 })
      if (options.delayMs !== undefined && options.delayMs > 0) await new Promise(resolveDelay => setTimeout(resolveDelay, options.delayMs))
      return new Response(body, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

function item(overrides: Partial<ProvisionItem> = {}): ProvisionItem {
  return { id: 'mem:model', kind: 'model-cache', spec: { repo: REPO }, target: { root: 'models' }, schemaVersion: 1, ...overrides }
}

/** The stable code of the error `run` throws, or `'no-throw'`. */
function codeOf(run: () => void): string {
  try {
    run()
    return 'no-throw'
  } catch (error) {
    return (error as { readonly code?: string }).code ?? 'error'
  }
}

describe('model-cache：已落位条目按目标 blob 修复', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-model-fix-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(fetchImpl: typeof fetch, injected: ProvisionFs = fs): ReturnType<typeof createProvisioner> {
    const created = createProvisioner({ home, logger: silent, fs: injected, fetch: fetchImpl })
    created.register(modelCacheProvider())
    return created
  }

  function declare(created: ReturnType<typeof createProvisioner>, declared: ProvisionItem): void {
    created.declare({ plugin: 'mem', items: [declared] } as Manifest)
  }

  const hubRoot = (): string => join(home, 'models', `models--${REPO.replaceAll('/', '--')}`)
  const hubSnapshot = (): string => join(hubRoot(), 'snapshots', SHA)
  const flatData = (): string => join(home, 'models', 'BAAI', 'bge-small-zh-v1.5')

  it('hub：内容不同的崩溃残留被换成指向目标 blob 的链接', async () => {
    const created = provisioner(fakeHub())
    declare(created, item({ spec: { repo: REPO, revision: SHA } }))
    const entry = join(hubSnapshot(), 'config.json')
    await mkdir(hubSnapshot(), { recursive: true })
    await writeFile(entry, '{"v":1-STALE"}')

    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'installed', version: SHA })
    expect((await lstat(entry)).isSymbolicLink()).toBe(true)
    expect(await readFile(entry, 'utf8')).toBe(CONFIG)
  })

  it('hub：内容相同的实体文件也换成链接，不再各存一份', async () => {
    const created = provisioner(fakeHub({ content: { 'config.json': CONFIG } }))
    declare(created, item({ spec: { repo: REPO, revision: SHA, files: ['config.json'] } }))
    const entry = join(hubSnapshot(), 'config.json')
    await mkdir(hubSnapshot(), { recursive: true })
    await writeFile(entry, CONFIG)

    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'installed' })
    expect((await lstat(entry)).isSymbolicLink()).toBe(true)
    expect(await readFile(entry, 'utf8')).toBe(CONFIG)
  })

  it('hub：悬空链接、指向错误 blob 的链接、同名目录都被修复', async () => {
    for (const shape of ['dangling', 'wrong-blob', 'directory'] as const) {
      await removeHome(home)
      await mkdir(home, { recursive: true })
      const created = provisioner(fakeHub({ content: { 'config.json': CONFIG, 'tokenizer.json': TOKEN } }))
      declare(created, item({ spec: { repo: REPO, revision: SHA } }))
      const entry = join(hubSnapshot(), 'config.json')
      await mkdir(hubSnapshot(), { recursive: true })
      if (shape === 'dangling') {
        await symlink(join('..', '..', 'blobs', sha256('absent')), entry)
      } else if (shape === 'wrong-blob') {
        await mkdir(join(hubRoot(), 'blobs'), { recursive: true })
        await writeFile(join(hubRoot(), 'blobs', sha256(TOKEN)), TOKEN)
        await symlink(join('..', '..', 'blobs', sha256(TOKEN)), entry)
      } else {
        await mkdir(entry, { recursive: true })
      }

      expect((await created.ensure()).entries[0]).toMatchObject({ action: 'installed' })
      expect((await lstat(entry)).isSymbolicLink()).toBe(true)
      expect(await readFile(entry, 'utf8')).toBe(CONFIG)
    }
  })

  it('flat：内容不同的残留、同内容实体文件与目录都被换成链接', async () => {
    for (const shape of ['different', 'same', 'directory'] as const) {
      await removeHome(home)
      await mkdir(home, { recursive: true })
      const created = provisioner(fakeHub({ content: { 'config.json': CONFIG } }))
      declare(created, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json'] } }))
      const entry = join(flatData(), 'config.json')
      await mkdir(flatData(), { recursive: true })
      if (shape === 'directory') await mkdir(entry, { recursive: true })
      else await writeFile(entry, shape === 'same' ? CONFIG : '{"local":"user-owned"}')

      expect((await created.ensure()).entries[0]).toMatchObject({ action: 'installed' })
      expect((await lstat(entry)).isSymbolicLink()).toBe(true)
      expect(await readFile(entry, 'utf8')).toBe(CONFIG)
    }
  })

  it('flat：被改指到错误 blob 的链接在下次 ensure 被修回', async () => {
    const created = provisioner(fakeHub())
    declare(created, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json', 'tokenizer.json'] } }))
    await created.ensure()
    const entry = join(flatData(), 'config.json')
    await rm(entry)
    await symlink(join('..', '..', '.envinit', `models--${REPO.replaceAll('/', '--')}`, 'blobs', sha256(TOKEN)), entry)
    expect(await readFile(entry, 'utf8')).toBe(TOKEN)

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    expect(await readFile(entry, 'utf8')).toBe(CONFIG)
  })

  it('flat：已经指向目标 blob 的链接被保留（第二次 ensure 是 present）', async () => {
    const created = provisioner(fakeHub())
    declare(created, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json'] } }))
    await created.ensure()
    const entry = join(flatData(), 'config.json')
    const before = (await lstat(entry)).mtimeMs
    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'present' })
    expect((await lstat(entry)).mtimeMs).toBe(before)
    expect(await readFile(entry, 'utf8')).toBe(CONFIG)
  })

  it('flat：实体文件回退（无符号链接）也写链接不可用时的正确内容', async () => {
    const noSymlinks: ProvisionFs = {
      ...fs,
      symlink: async () => {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      },
    }
    const created = provisioner(fakeHub(), noSymlinks)
    declare(created, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json'] } }))
    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'installed' })
    const entry = join(flatData(), 'config.json')
    expect((await lstat(entry)).isSymbolicLink()).toBe(false)
    expect(await readFile(entry, 'utf8')).toBe(CONFIG)
    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'present' })
  })

  it('受管模型数据只增不减：换 revision 后旧 snapshot 与 blob 仍在，prune() 不回收', async () => {
    const first = provisioner(fakeHub({ sha: SHA, content: { 'config.json': 'V1' } }))
    declare(first, item({ spec: { repo: REPO, files: ['config.json'] } }))
    await first.ensure()

    const moved = provisioner(fakeHub({ sha: SHA_B, content: { 'config.json': 'V2' } }))
    declare(moved, item({ spec: { repo: REPO, files: ['config.json'], revision: 'v2' } }))
    await moved.ensure()

    expect((await readdir(join(hubRoot(), 'snapshots'))).sort()).toEqual([SHA, SHA_B].sort())
    expect((await readdir(join(hubRoot(), 'blobs'))).length).toBe(2)

    const pruned = await moved.experimental().prune()
    expect(pruned.moved).toEqual([])
    expect((await readdir(join(hubRoot(), 'snapshots'))).length).toBe(2)
  })
})

describe('model-cache：revision、refs 与 repo 的路径安全', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-model-safe-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(fetchImpl: typeof fetch): ReturnType<typeof createProvisioner> {
    const created = createProvisioner({ home, logger: silent, fs, fetch: fetchImpl })
    created.register(modelCacheProvider())
    return created
  }

  const declare = (created: ReturnType<typeof createProvisioner>, declared: ProvisionItem): void => {
    created.declare({ plugin: 'mem', items: [declared] } as Manifest)
  }

  it('端点返回的 sha 不是 40/64 位小写十六进制 ⇒ fetch/failed，不落盘到 home 外', async () => {
    const escapeRoot = join(tmpdir(), `envinit-escape-${String(process.pid)}-${Date.now().toString(36)}`)
    await rm(escapeRoot, { recursive: true, force: true })
    const snapshots = join(home, 'models', `models--${REPO.replaceAll('/', '--')}`, 'snapshots')
    const traversal = relative(snapshots, join(escapeRoot, 'snap'))
    const created = provisioner(fakeHub({ sha: traversal, content: { 'config.json': 'PWNED' } }))
    declare(created, item({ spec: { repo: REPO, revision: 'main' } }))

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'fetch/failed' })
    expect(await exists(fs, join(escapeRoot, 'snap', 'config.json'))).toBe(false)
    await rm(escapeRoot, { recursive: true, force: true })
  })

  it('refs 文件里的值不是 sha ⇒ probe 视为未缓存，不顺着路径读出去', async () => {
    const outside = join(tmpdir(), `envinit-outside-${String(process.pid)}-${Date.now().toString(36)}`)
    await mkdir(join(outside, 'snap'), { recursive: true })
    await writeFile(join(outside, 'snap', 'config.json'), 'OUTSIDE')
    const root = join(home, 'models', `models--${REPO.replaceAll('/', '--')}`)
    await mkdir(join(root, 'refs'), { recursive: true })
    await writeFile(join(root, 'refs', 'main'), relative(join(root, 'snapshots'), join(outside, 'snap')))
    const provider = modelCacheProvider()

    const probe = await provider.probe(item(), { home, logger: silent, policy: {}, fs })
    expect(probe.found).toBe(false)
    await rm(outside, { recursive: true, force: true })
  })

  it('声明期的非法 revision ⇒ invalid-option', () => {
    const created = provisioner(fakeHub())
    const bad = ['', '   ', '.', '..', '../x', 'a/../b', '/abs', '\\abs', 'a\\b', 'a//b', 'a/./b', 'a\u0001b']
    for (const revision of bad) {
      expect(codeOf(() => declare(created, item({ spec: { repo: REPO, revision } }))), JSON.stringify(revision)).toBe('invalid-option')
    }
  })

  it('flat 布局的 repo 含控制字符或侧车段 ⇒ 声明期 invalid-option', () => {
    const created = provisioner(fakeHub())
    for (const repo of ['a\u0001b', '.envinit/x', 'a/../b', 'a//b']) {
      expect(codeOf(() => declare(created, item({ spec: { repo, layout: 'flat' } }))), JSON.stringify(repo)).toBe('invalid-option')
    }
  })

  it('嵌套 ref（release/v1）仍然可用，refs 写在对应的子目录', async () => {
    const created = provisioner(fakeHub({ content: { 'config.json': CONFIG } }))
    declare(created, item({ spec: { repo: REPO, revision: 'release/v1', files: ['config.json'] } }))
    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'installed' })
    const ref = join(home, 'models', `models--${REPO.replaceAll('/', '--')}`, 'refs', 'release', 'v1')
    expect(await readFile(ref, 'utf8')).toBe(SHA)
    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'present' })
  })

  it('空白 spec.endpoint ⇒ invalid-option，且从不触网', async () => {
    let hits = 0
    const created = provisioner((async () => {
      hits += 1
      return new Response('x', { status: 200 })
    }) as unknown as typeof fetch)
    declare(created, item({ spec: { repo: REPO, files: ['config.json'], endpoint: '   ' } }))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'invalid-option' })
    expect(hits).toBe(0)
  })

  it('repo 里的反斜杠按分隔符规整：hub 折叠、flat 分层', async () => {
    const hub = provisioner(fakeHub({ content: { 'config.json': CONFIG } }))
    declare(hub, item({ spec: { repo: 'org\\name', files: ['config.json'] } }))
    expect((await hub.ensure()).entries[0]).toMatchObject({ action: 'installed' })
    expect(await exists(fs, join(home, 'models', 'models--org--name', 'snapshots', SHA, 'config.json'))).toBe(true)

    const flatHome = await mkdtemp(join(tmpdir(), 'envinit-model-safe-'))
    try {
      const flat = createProvisioner({ home: flatHome, logger: silent, fs, fetch: fakeHub({ content: { 'config.json': CONFIG } }) })
      flat.register(modelCacheProvider())
      flat.declare({ plugin: 'mem', items: [item({ spec: { repo: 'org\\name', layout: 'flat', files: ['config.json'] } })] } as Manifest)
      expect((await flat.ensure()).entries[0]).toMatchObject({ action: 'installed' })
      expect(await readFile(join(flatHome, 'models', 'org', 'name', 'config.json'), 'utf8')).toBe(CONFIG)
    } finally {
      await removeHome(flatHome)
    }
  })
})

describe('model-cache：verify 证明内容而不是只查存在', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-model-verify-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(fetchImpl: typeof fetch): ReturnType<typeof createProvisioner> {
    const created = createProvisioner({ home, logger: silent, fs, fetch: fetchImpl })
    created.register(modelCacheProvider())
    return created
  }

  const declare = (created: ReturnType<typeof createProvisioner>, declared: ProvisionItem): void => {
    created.declare({ plugin: 'mem', items: [declared] } as Manifest)
  }

  const hubRoot = (): string => join(home, 'models', `models--${REPO.replaceAll('/', '--')}`)
  const hubSnapshot = (): string => join(hubRoot(), 'snapshots', SHA)
  const dataDir = (): string => join(home, 'models', 'BAAI', 'bge-small-zh-v1.5')
  const sidecar = (): string => join(home, 'models', '.envinit', `models--${REPO.replaceAll('/', '--')}`)

  async function verifyHub(): Promise<string> {
    const provider = modelCacheProvider()
    const resolved = { key: 'k', name: REPO, version: SHA, dir: hubSnapshot(), entryDir: hubSnapshot(), source: 'installed' as const }
    try {
      await provider.verify(item({ spec: { repo: REPO } }), resolved, { home, logger: silent, policy: {}, fs })
      return ''
    } catch (error) {
      return (error as { readonly code?: string }).code ?? 'error'
    }
  }

  it('hub：空文件、截断、目录、错内容、被截断的 blob 都过不了 verify', async () => {
    const created = provisioner(fakeHub({ content: { 'config.json': CONFIG } }))
    declare(created, item({ spec: { repo: REPO, files: ['config.json'] } }))
    await created.ensure()
    const entry = join(hubSnapshot(), 'config.json')

    expect(await verifyHub()).toBe('')

    // A healthy link whose blob was truncated must fail too.
    const [blob] = await readdir(join(hubRoot(), 'blobs'))
    await writeFile(join(hubRoot(), 'blobs', blob ?? 'missing'), 'x')
    expect(await verifyHub()).toBe('verify/failed')

    await rm(entry, { force: true })
    await writeFile(entry, '')
    expect(await verifyHub()).toBe('verify/failed')

    await rm(entry, { force: true })
    await writeFile(entry, '{"model_type":"be')
    expect(await verifyHub()).toBe('verify/failed')

    await rm(entry, { recursive: true, force: true })
    await mkdir(entry)
    expect(await verifyHub()).toBe('verify/failed')

    await rm(entry, { recursive: true, force: true })
    await writeFile(entry, 'GARBAGE')
    expect(await verifyHub()).toBe('verify/failed')
  })

  it('hub：probe 仍然廉价，只拒空文件、目录与悬空链接', async () => {
    const created = provisioner(fakeHub({ content: { 'config.json': CONFIG } }))
    declare(created, item({ spec: { repo: REPO, files: ['config.json'] } }))
    await created.ensure()
    const provider = modelCacheProvider()
    const ctx = { home, logger: silent, policy: {}, fs }
    const entry = join(hubSnapshot(), 'config.json')

    // Truncated but non-empty stays a cheap hit; verify proves it instead.
    await writeFile(entry, '{"model_type":"be')
    expect(await provider.probe(item({ spec: { repo: REPO, files: ['config.json'] } }), ctx)).toMatchObject({ found: true })

    await rm(entry, { force: true })
    await writeFile(entry, '')
    expect((await provider.probe(item({ spec: { repo: REPO, files: ['config.json'] } }), ctx)).found).toBe(false)

    await rm(entry, { recursive: true, force: true })
    await mkdir(entry)
    expect((await provider.probe(item({ spec: { repo: REPO, files: ['config.json'] } }), ctx)).found).toBe(false)

    await rm(entry, { recursive: true, force: true })
    await symlink(join('..', '..', 'blobs', sha256('gone')), entry)
    expect((await provider.probe(item({ spec: { repo: REPO, files: ['config.json'] } }), ctx)).found).toBe(false)
  })

  it('flat：记录里的 digest 让空文件、截断、目录、错内容都过不了 verify', async () => {
    const created = provisioner(fakeHub({ content: { 'config.json': CONFIG } }))
    declare(created, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json'] } }))
    await created.ensure()
    const provider = modelCacheProvider()
    const resolved = { key: 'k', name: REPO, version: SHA, dir: dataDir(), entryDir: dataDir(), source: 'installed' as const }
    const ctx = { home, logger: silent, policy: {}, fs }
    const spec = { repo: REPO, layout: 'flat' as const, files: ['config.json'] }
    const entry = join(dataDir(), 'config.json')

    await rm(entry, { force: true })
    await writeFile(entry, '')
    await expect(provider.verify(item({ spec }), resolved, ctx)).rejects.toMatchObject({ code: 'verify/failed' })

    await rm(entry, { force: true })
    await writeFile(entry, '{"model_type":"be')
    await expect(provider.verify(item({ spec }), resolved, ctx)).rejects.toMatchObject({ code: 'verify/failed' })

    await rm(entry, { recursive: true, force: true })
    await mkdir(entry)
    await expect(provider.verify(item({ spec }), resolved, ctx)).rejects.toMatchObject({ code: 'verify/failed' })

    await rm(entry, { recursive: true, force: true })
    await writeFile(entry, 'GARBAGE')
    await expect(provider.verify(item({ spec }), resolved, ctx)).rejects.toMatchObject({ code: 'verify/failed' })
  })

  it('flat：只有名字的旧记录不被丢弃（旧树仍可用）', async () => {
    const created = provisioner(fakeHub({ content: { 'config.json': CONFIG } }))
    declare(created, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json'] } }))
    await created.ensure()
    // Downgrade the record to the names-only shape and make the entry a real file.
    await writeFile(join(sidecar(), 'record.json'), `${JSON.stringify({ schemaVersion: 1, repo: REPO, revision: 'main', sha: SHA, files: ['config.json'] })}\n`)
    const entry = join(dataDir(), 'config.json')
    await rm(entry, { force: true })
    await writeFile(entry, CONFIG)
    const provider = modelCacheProvider()
    const ctx = { home, logger: silent, policy: {}, fs }
    const spec = { repo: REPO, layout: 'flat' as const, files: ['config.json'] }

    expect((await provider.probe(item({ spec }), ctx)).found).toBe(true)
    await expect(
      provider.verify(item({ spec }), { key: 'k', name: REPO, version: SHA, dir: dataDir(), entryDir: dataDir(), source: 'installed' as const }, ctx),
    ).resolves.toBeUndefined()
  })

  it('flat：probe 用记录里的 digest 发现被改指的链接', async () => {
    const created = provisioner(fakeHub())
    declare(created, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json', 'tokenizer.json'] } }))
    await created.ensure()
    const provider = modelCacheProvider()
    const ctx = { home, logger: silent, policy: {}, fs }
    const spec = { repo: REPO, layout: 'flat' as const, files: ['config.json', 'tokenizer.json'] }
    const entry = join(dataDir(), 'config.json')
    await rm(entry)
    await symlink(join('..', '..', '.envinit', `models--${REPO.replaceAll('/', '--')}`, 'blobs', sha256(TOKEN)), entry)

    expect((await provider.probe(item({ spec }), ctx)).found).toBe(false)
  })
})

describe('model-cache：requiredFiles 与镜像失败语义', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-model-req-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(options: { readonly fetch: typeof fetch; readonly modelMirrors?: readonly string[] }): ReturnType<typeof createProvisioner> {
    const created = createProvisioner({
      home,
      logger: silent,
      fs,
      fetch: options.fetch,
      ...(options.modelMirrors === undefined ? {} : { policy: { mirrors: { archive: [], model: options.modelMirrors } } }),
    })
    created.register(modelCacheProvider())
    return created
  }

  const declare = (created: ReturnType<typeof createProvisioner>, declared: ProvisionItem): void => {
    created.declare({ plugin: 'mem', items: [declared] } as Manifest)
  }

  it('hub 与 flat 一样总是要求 config.json：requiredFiles: [] 不会把默认项删掉', async () => {
    const created = provisioner({ fetch: fakeHub({ content: { 'tokenizer.json': TOKEN } }) })
    declare(created, item({ spec: { repo: REPO, requiredFiles: [] } }))
    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })
  })

  it('requiredFiles 在默认 config.json 之上追加', async () => {
    const created = provisioner({ fetch: fakeHub({ content: { 'config.json': CONFIG } }) })
    declare(created, item({ spec: { repo: REPO, files: ['config.json'], requiredFiles: ['missing.json'] } }))
    expect((await created.ensure()).entries[0]).toMatchObject({ action: 'failed', code: 'verify/failed' })

    const extraHome = await mkdtemp(join(tmpdir(), 'envinit-model-req-'))
    try {
      const ok = createProvisioner({ home: extraHome, logger: silent, fs, fetch: fakeHub({ content: { 'config.json': CONFIG, 'tokenizer.json': TOKEN } }) })
      ok.register(modelCacheProvider())
      ok.declare({ plugin: 'mem', items: [item({ spec: { repo: REPO, files: ['config.json', 'tokenizer.json'], requiredFiles: ['tokenizer.json'] } })] } as Manifest)
      expect((await ok.ensure()).entries[0]).toMatchObject({ action: 'installed' })
    } finally {
      await removeHome(extraHome)
    }
  })

  it('长度/完整性失败是终局：不再落到下一个镜像', async () => {
    const live: string[] = []
    const impl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.startsWith('https://huge.test/')) {
        if (/\/resolve\//.test(url)) return new Response('x', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024 * 1024) } })
        if (/\/api\/models\/.+\/revision\//.test(url)) return new Response(JSON.stringify({ sha: SHA }), { status: 200 })
        return new Response(JSON.stringify({ siblings: [{ rfilename: 'config.json' }] }), { status: 200 })
      }
      live.push(url)
      if (/\/api\/models\/.+\/revision\//.test(url)) return new Response(JSON.stringify({ sha: SHA }), { status: 200 })
      if (/\/api\/models\/[^/]+\/[^/]+$/.test(url)) return new Response(JSON.stringify({ siblings: [{ rfilename: 'config.json' }] }), { status: 200 })
      return new Response(CONFIG, { status: 200 })
    }) as unknown as typeof fetch
    const created = provisioner({ fetch: impl, modelMirrors: ['https://huge.test', 'https://live.test'] })
    declare(created, item({ spec: { repo: REPO, files: ['config.json'] } }))

    const report = await created.ensure()
    expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'fetch/failed' })
    expect(live.some(url => url.includes('/resolve/'))).toBe(false)

    const short = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (/\/api\/models\/.+\/revision\//.test(url)) return new Response(JSON.stringify({ sha: SHA }), { status: 200 })
      if (/\/resolve\//.test(url)) return new Response('{"trunc":1}', { status: 200, headers: { 'content-length': String(1024 * 1024) } })
      return new Response(JSON.stringify({ siblings: [{ rfilename: 'config.json' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const created2 = provisioner({ fetch: short })
    declare(created2, item({ spec: { repo: REPO, files: ['config.json'] } }))
    expect((await created2.ensure()).entries[0]).toMatchObject({ action: 'failed', code: 'fetch/failed' })
    expect(await exists(fs, join(home, 'models', `models--${REPO.replaceAll('/', '--')}`, 'snapshots', SHA, 'config.json'))).toBe(false)
  })
})

describe('model-cache：并发安装同一份记录与数据', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-model-conc-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  const make = (fetchImpl: typeof fetch): ReturnType<typeof createProvisioner> => {
    const created = createProvisioner({ home, logger: silent, fs: defaultFs(), fetch: fetchImpl })
    created.register(modelCacheProvider())
    return created
  }
  const declare = (created: ReturnType<typeof createProvisioner>, declared: ProvisionItem): void => {
    created.declare({ plugin: 'mem', items: [declared] } as Manifest)
  }
  const slow = (impl: typeof fetch, ms: number): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      await new Promise(resolve => setTimeout(resolve, ms))
      return impl(input, init)
    }) as unknown as typeof fetch

  it('同进程两个不同 revision 的 flat 安装：record 与数据一致', async () => {
    const a = make(slow(fakeHub({ sha: SHA, content: { 'config.json': 'REV-A-BYTES' } }), 20))
    const b = make(slow(fakeHub({ sha: SHA_B, content: { 'config.json': 'REV-B-BYTES' } }), 20))
    declare(a, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json'], revision: 'revA' } }))
    declare(b, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json'], revision: 'revB' } }))
    const [ra, rb] = await Promise.all([a.ensure(), b.ensure()])
    expect([ra.ok, rb.ok]).toEqual([true, true])

    const content = await readFile(join(home, 'models', 'BAAI', 'bge-small-zh-v1.5', 'config.json'), 'utf8')
    const record = JSON.parse(
      await readFile(join(home, 'models', '.envinit', `models--${REPO.replaceAll('/', '--')}`, 'record.json'), 'utf8'),
    ) as { revision: string; sha: string }
    expect(content).toBe(record.sha === SHA ? 'REV-A-BYTES' : 'REV-B-BYTES')
    expect(record.revision).toBe(record.sha === SHA ? 'revA' : 'revB')
  })

  it('同进程两个不同 sha 的 hub 安装：refs 指向的 snapshot 内容自洽', async () => {
    const a = make(slow(fakeHub({ sha: SHA, content: { 'config.json': 'HUB-A' } }), 20))
    const b = make(slow(fakeHub({ sha: SHA_B, content: { 'config.json': 'HUB-B' } }), 20))
    declare(a, item({ spec: { repo: REPO, files: ['config.json'] } }))
    declare(b, item({ spec: { repo: REPO, files: ['config.json'] } }))
    await Promise.all([a.ensure(), b.ensure()])

    const root = join(home, 'models', `models--${REPO.replaceAll('/', '--')}`)
    const ref = await readFile(join(root, 'refs', 'main'), 'utf8')
    const content = await readFile(join(root, 'snapshots', ref, 'config.json'), 'utf8')
    expect(content).toBe(ref === SHA ? 'HUB-A' : 'HUB-B')
  })

  it('两个进程安装不同 revision：record 与数据最终一致', async () => {
    const child = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'model-child.mjs')
    const spawnChild = (revision: string, sha: string, content: string): Promise<{ readonly code: number | null; readonly stderr: string }> =>
      new Promise(resolve => {
        const proc = spawn(process.execPath, [child, home, 'flat', revision, sha, content, REPO], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        proc.stderr.on('data', chunk => (stderr += String(chunk)))
        proc.on('close', code => resolve({ code, stderr }))
      })

    const [a, b] = await Promise.all([spawnChild('revA', SHA, 'REV-A-BYTES'), spawnChild('revB', SHA_B, 'REV-B-BYTES')])
    expect(a.code, a.stderr).toBe(0)
    expect(b.code, b.stderr).toBe(0)

    const content = await readFile(join(home, 'models', 'BAAI', 'bge-small-zh-v1.5', 'config.json'), 'utf8')
    const record = JSON.parse(
      await readFile(join(home, 'models', '.envinit', `models--${REPO.replaceAll('/', '--')}`, 'record.json'), 'utf8'),
    ) as { revision: string; sha: string }
    expect(content).toBe(record.sha === SHA ? 'REV-A-BYTES' : 'REV-B-BYTES')
    expect(record.revision).toBe(record.sha === SHA ? 'revA' : 'revB')
  }, 60_000)
})
