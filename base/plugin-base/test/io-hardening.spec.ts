/**
 * Regression cover for the data-plane helpers: atomic-write temp cleanup and the copy fallback
 * onto an already-existing destination.
 *
 * @module test/io-hardening
 */
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs, linkOrCopy, sweepAtomicTemps } from '../src/fs.js'
import { createProvisioner } from '../src/provisioner.js'
import { modelCacheProvider } from '../src/providers/model.js'
import type { Manifest, ProvisionFs, ProvisionItem, ProvisionLogger } from '../src/types.js'
import { removeHome } from './helpers/tmp.js'

const silent: ProvisionLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const REPO = 'BAAI/bge-small-zh-v1.5'
const SHA = 'a'.repeat(40)

function item(overrides: Partial<ProvisionItem> = {}): ProvisionItem {
  return { id: 'mem:model', kind: 'model-cache', spec: { repo: REPO }, target: { root: 'models' }, schemaVersion: 1, ...overrides }
}

describe('fs：原子写临时文件清理', () => {
  let dir: string
  const fs = defaultFs()

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'envinit-sweep-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('只清掉 .atomic- 前缀，保留正常文件', async () => {
    await writeFile(join(dir, '.atomic-crashed'), 'x')
    await writeFile(join(dir, 'keep.json'), 'y')
    await sweepAtomicTemps(fs, dir)
    expect(await readdir(dir)).toEqual(['keep.json'])
  })

  it('目录不存在或不可读时静默返回', async () => {
    await expect(sweepAtomicTemps(fs, join(dir, 'missing'))).resolves.toBeUndefined()
  })

  it('atomicWrite 顺手清掉很久以前的临时文件，但保留新写的', async () => {
    const stale = join(dir, '.atomic-stale')
    await writeFile(stale, 'x')
    const old = new Date(Date.now() - 60 * 60 * 1000)
    await utimes(stale, old, old)
    await defaultFs().atomicWrite(join(dir, 'fresh.json'), new TextEncoder().encode('{}'))
    expect(await readdir(dir)).toEqual(['fresh.json'])
  })
})

describe('model-cache：崩溃残留的临时文件在恢复时被清掉', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-model-sweep-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  /** An fs whose atomicWrite dies after dropping a recognizable temp beside the target. */
  function crashingAtomicWrite(): ProvisionFs {
    const inner = defaultFs()
    return {
      ...inner,
      async atomicWrite(path, data) {
        if (!path.endsWith('record.json') && !dirname(path).endsWith('refs')) return inner.atomicWrite(path, data)
        await writeFile(join(dirname(path), '.atomic-crashed'), data)
        throw new Error('simulated crash')
      },
    }
  }

  const declare = (created: ReturnType<typeof createProvisioner>, declared: ProvisionItem): void => {
    created.declare({ plugin: 'mem', items: [declared] } as Manifest)
  }

  const hubFetch = (): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (/\/api\/models\/.+\/revision\//.test(url)) return new Response(JSON.stringify({ sha: SHA }), { status: 200 })
      if (/\/api\/models\/[^/]+\/[^/]+$/.test(url)) return new Response(JSON.stringify({ siblings: [{ rfilename: 'config.json' }] }), { status: 200 })
      return new Response('{"model_type":"bert"}', { status: 200 })
    }) as unknown as typeof fetch

  it('flat：record.json 写失败后重跑，侧车不再剩 .atomic- 文件', async () => {
    const sidecar = join(home, 'models', '.envinit', `models--${REPO.replaceAll('/', '--')}`)
    const crashing = createProvisioner({ home, logger: silent, fs: crashingAtomicWrite(), fetch: hubFetch() })
    crashing.register(modelCacheProvider())
    declare(crashing, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json'] } }))
    expect((await crashing.ensure()).entries[0]).toMatchObject({ action: 'failed' })
    expect((await readdir(sidecar)).some(entry => entry.startsWith('.atomic-'))).toBe(true)

    const recovered = createProvisioner({ home, logger: silent, fs, fetch: hubFetch() })
    recovered.register(modelCacheProvider())
    declare(recovered, item({ spec: { repo: REPO, layout: 'flat', files: ['config.json'] } }))
    expect((await recovered.ensure()).entries[0]).toMatchObject({ action: 'installed' })
    expect((await readdir(sidecar)).some(entry => entry.startsWith('.atomic-'))).toBe(false)
  })

  it('hub：refs 写失败后重跑，refs 目录不再剩 .atomic- 文件', async () => {
    const refs = join(home, 'models', `models--${REPO.replaceAll('/', '--')}`, 'refs')
    const crashing = createProvisioner({ home, logger: silent, fs: crashingAtomicWrite(), fetch: hubFetch() })
    crashing.register(modelCacheProvider())
    declare(crashing, item({ spec: { repo: REPO, files: ['config.json'] } }))
    expect((await crashing.ensure()).entries[0]).toMatchObject({ action: 'failed' })
    expect((await readdir(refs)).some(entry => entry.startsWith('.atomic-'))).toBe(true)

    const recovered = createProvisioner({ home, logger: silent, fs, fetch: hubFetch() })
    recovered.register(modelCacheProvider())
    declare(recovered, item({ spec: { repo: REPO, files: ['config.json'] } }))
    expect((await recovered.ensure()).entries[0]).toMatchObject({ action: 'installed' })
    expect(await readFile(join(refs, 'main'), 'utf8')).toBe(SHA)
    expect((await readdir(refs)).some(entry => entry.startsWith('.atomic-'))).toBe(false)
  })
})

describe('fs：linkOrCopy 的复制回退容忍已存在的目标目录', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'envinit-link-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const noSymlinks = (): ProvisionFs => ({
    ...defaultFs(),
    symlink: async () => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    },
  })

  it('目标目录已存在时复制内容而不是抛 EEXIST', async () => {
    const target = join(dir, 'target')
    const destination = join(dir, 'destination')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'file.txt'), 'PAYLOAD')
    await mkdir(destination, { recursive: true })

    await expect(linkOrCopy(noSymlinks(), target, destination)).resolves.toBe('copied')
    expect(await readFile(join(destination, 'file.txt'), 'utf8')).toBe('PAYLOAD')
  })

  it('目标目录里已有的同名文件被覆盖', async () => {
    const target = join(dir, 'target')
    const destination = join(dir, 'destination')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'file.txt'), 'FRESH')
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'file.txt'), 'STALE')

    await expect(linkOrCopy(noSymlinks(), target, destination)).resolves.toBe('copied')
    expect(await readFile(join(destination, 'file.txt'), 'utf8')).toBe('FRESH')
  })

  it('符号链接可用时仍然优先建链接', async () => {
    const target = join(dir, 'target')
    const destination = join(dir, 'destination')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'file.txt'), 'PAYLOAD')
    await expect(linkOrCopy(defaultFs(), target, destination)).resolves.toBe('linked')
    expect(await readFile(join(destination, 'file.txt'), 'utf8')).toBe('PAYLOAD')
  })
})
