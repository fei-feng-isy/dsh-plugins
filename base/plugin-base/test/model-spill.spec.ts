/**
 * P14 at the provider level: the model-cache download path switches to streaming above an injectable
 * threshold, lands byte-identical content under the content-addressed blob name, leaves no temp behind,
 * and keeps the small-file path on `atomicWrite`. The payloads are a few hundred bytes and the
 * thresholds are tiny, so nothing here does real multi-MB IO.
 *
 * @module test/model-spill
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs, exists } from '../src/fs.js'
import { createProvisioner } from '../src/provisioner.js'
import { MAX_MODEL_BYTES, modelCacheProvider } from '../src/providers/model.js'
import type { Manifest, ProvisionFs, ProvisionItem, ProvisionLogger } from '../src/types.js'
import { removeHome } from './helpers/tmp.js'

const silent: ProvisionLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const REPO = 'BAAI/bge-small-zh-v1.5'
const SHA = 'a'.repeat(40)
const FILE = 'weights.bin'
const CONFIG = '{"model_type":"bert"}'
const CACHE_ROOT = join('models', 'models--BAAI--bge-small-zh-v1.5')
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** 256 distinct bytes; small, but comfortably above the tiny thresholds the tests inject. */
const CONTENT = Uint8Array.from({ length: 256 }, (_unused, i) => (i * 13 + 5) % 256)
const DIGEST = sha256(CONTENT)

/** A fake hub that serves `content` as a `chunk`-sized stream for the weights file. */
function hub(content: Uint8Array, options: { readonly chunk?: number; readonly declared?: number } = {}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (/\/api\/models\/.+\/revision\//.test(url)) return new Response(JSON.stringify({ sha: SHA }), { status: 200 })
    if (url.endsWith(`/api/models/${REPO}`)) {
      return new Response(JSON.stringify({ siblings: [{ rfilename: 'config.json' }, { rfilename: FILE }] }), { status: 200 })
    }
    const resolve = /\/resolve\/[^/]+\/(.+)$/.exec(url)
    if (resolve === null) return new Response('not found', { status: 404 })
    if (resolve[1] === 'config.json') return new Response(CONFIG, { status: 200 })
    const size = options.chunk ?? content.byteLength
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < content.byteLength; offset += size) chunks.push(content.subarray(offset, offset + size))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    if (options.declared === undefined) return new Response(stream, { status: 200 })
    return new Response(stream, { status: 200, headers: { 'content-length': String(options.declared) } })
  }) as unknown as typeof fetch
}

function item(): ProvisionItem {
  return { id: 'mem:model', kind: 'model-cache', spec: { repo: REPO }, target: { root: 'models' }, schemaVersion: 1 }
}

/** A seam wrapper that records which mutation primitive landed which path. */
function recording(inner: ProvisionFs): {
  readonly fs: ProvisionFs
  readonly atomicWrites: string[]
  readonly renames: Array<readonly [string, string]>
  readonly copies: string[]
} {
  const atomicWrites: string[] = []
  const renames: Array<readonly [string, string]> = []
  const copies: string[] = []
  const fs: ProvisionFs = {
    ...inner,
    atomicWrite: async (path, data) => {
      atomicWrites.push(path)
      await inner.atomicWrite(path, data)
    },
    rename: async (from, to) => {
      renames.push([from, to])
      await inner.rename(from, to)
    },
    copyFile: async (from, to) => {
      copies.push(to)
      await inner.copyFile(from, to)
    },
  }
  return { fs, atomicWrites, renames, copies }
}

describe('model-cache：大文件流式落盘（P14）', () => {
  let home: string
  const fs = defaultFs()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-model-spill-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  function provisioner(
    fetchImpl: typeof fetch,
    options: { readonly maxBytes?: number; readonly spillAtBytes?: number },
    injected: ProvisionFs = fs,
  ): ReturnType<typeof createProvisioner> {
    const created = createProvisioner({ home, logger: silent, fs: injected, fetch: fetchImpl })
    created.register(modelCacheProvider(options))
    created.declare({ plugin: 'mem', items: [item()] } as Manifest)
    return created
  }

  it('默认上限是 2 GiB：留出安全余量，且远大于现实模型', () => {
    expect(MAX_MODEL_BYTES).toBe(2 * 1024 * 1024 * 1024)
    expect(MAX_MODEL_BYTES).toBeLessThan(4 * 1024 * 1024 * 1024)
  })

  it('超阈值：流式落成内容寻址 blob，sha256 与整读路径一致，且不留临时文件', async () => {
    const report = await provisioner(hub(CONTENT, { chunk: 16 }), { spillAtBytes: 64, maxBytes: 1 << 20 }).ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed' })

    const blobs = join(home, CACHE_ROOT, 'blobs')
    expect(await exists(fs, join(blobs, DIGEST))).toBe(true)
    // The blob NAME is sha256(content): the streamed bytes are byte-identical to the whole-body path,
    // which is the only thing that could have produced this digest.
    expect(sha256(await readFile(join(blobs, DIGEST)))).toBe(DIGEST)
    expect(sha256(await readFile(join(home, CACHE_ROOT, 'snapshots', SHA, FILE)))).toBe(DIGEST)
    expect((await readdir(blobs)).filter(name => name.startsWith('.atomic-'))).toEqual([])
  })

  it('小文件仍走 atomicWrite 原路径（机制断言）', async () => {
    const recorder = recording(fs)
    const report = await provisioner(hub(CONTENT, { chunk: 16 }), { spillAtBytes: 1 << 20, maxBytes: 1 << 20 }, recorder.fs).ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    const blob = join(home, CACHE_ROOT, 'blobs', DIGEST)
    expect(recorder.atomicWrites).toContain(blob)
    expect(recorder.renames.map(([, to]) => to)).not.toContain(blob)
  })

  it('超阈值走流式：blob 不经 atomicWrite，而是临时文件 rename 落位（机制断言）', async () => {
    const recorder = recording(fs)
    const report = await provisioner(hub(CONTENT, { chunk: 16 }), { spillAtBytes: 64, maxBytes: 1 << 20 }, recorder.fs).ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed' })
    const blob = join(home, CACHE_ROOT, 'blobs', DIGEST)
    expect(recorder.atomicWrites).not.toContain(blob)
    const landed = recorder.renames.find(([, to]) => to === blob)
    expect(landed).toBeDefined()
    expect(landed?.[0]).toContain('.atomic-spill-')
  })

  it('无符号链接的复制回退走 copyFile+rename，不再整读 blob 再 atomicWrite（机制断言）', async () => {
    const recorder = recording({
      ...fs,
      symlink: async () => {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      },
    })
    const report = await provisioner(hub(CONTENT, { chunk: 16 }), { spillAtBytes: 64, maxBytes: 1 << 20 }, recorder.fs).ensure()
    expect(report.entries[0]).toMatchObject({ action: 'installed' })

    const destination = join(home, CACHE_ROOT, 'snapshots', SHA, FILE)
    expect(recorder.copies.length).toBeGreaterThan(0)
    expect(recorder.atomicWrites).not.toContain(destination)
    expect(recorder.renames.map(([, to]) => to)).toContain(destination)
    expect(sha256(await readFile(destination))).toBe(DIGEST)
  })

  it('恰好等于上限通过；超过上限是终局 fetch/too-large，文案带上限', async () => {
    const exact = await provisioner(hub(CONTENT, { chunk: 16, declared: CONTENT.byteLength }), {
      spillAtBytes: 64,
      maxBytes: CONTENT.byteLength,
    }).ensure()
    expect(exact.entries[0]).toMatchObject({ action: 'installed' })

    const overHome = await mkdtemp(join(tmpdir(), 'envinit-model-spill-over-'))
    try {
      const over = createProvisioner({ home: overHome, logger: silent, fs, fetch: hub(CONTENT, { chunk: 16, declared: CONTENT.byteLength }) })
      over.register(modelCacheProvider({ spillAtBytes: 64, maxBytes: CONTENT.byteLength - 1 }))
      over.declare({ plugin: 'mem', items: [item()] } as Manifest)
      const report = await over.ensure()
      expect(report.entries[0]).toMatchObject({ action: 'failed', code: 'fetch/too-large' })
      expect(report.entries[0]?.reason).toContain(`超过上限 ${String(CONTENT.byteLength - 1)}`)
    } finally {
      await removeHome(overHome)
    }
  })
})
