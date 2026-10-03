/**
 * P14: a body that outgrows the in-memory budget streams into a caller's sink instead of being
 * assembled twice in the heap. Everything here drives `readCappedOrSpill` with a handful of bytes and
 * a tiny threshold, so the boundary, the byte-for-byte result and every failure path are covered
 * without any real multi-MB IO.
 *
 * @module test/spill
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_BYTES, SPILL_THRESHOLD_BYTES, readCappedOrSpill } from '../src/net.js'
import type { BodySpill } from '../src/net.js'

const bytes = (values: readonly number[]): Uint8Array => Uint8Array.from(values)
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** A body delivered as the given chunks, optionally announcing `declared` bytes. */
function chunked(chunks: readonly Uint8Array[], declared?: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, declared === undefined ? {} : { headers: { 'content-length': String(declared) } })
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** What a sink returns: the reassembled bytes plus the length `finish` was told. */
interface Spilled {
  readonly total: number
  readonly bytes: Uint8Array
}

/** A recording sink; `maxWrite` is the largest single chunk it was ever handed. */
class Recorder implements BodySpill<Spilled> {
  readonly writes: Uint8Array[] = []
  finishes = 0
  aborts = 0
  maxWrite = 0
  async write(chunk: Uint8Array): Promise<void> {
    this.writes.push(chunk)
    this.maxWrite = Math.max(this.maxWrite, chunk.byteLength)
  }
  async finish(total: number): Promise<Spilled> {
    this.finishes += 1
    return { total, bytes: join(this.writes) }
  }
  async abort(): Promise<void> {
    this.aborts += 1
  }
}

describe('readCappedOrSpill：阈值以下走原路径', () => {
  it('SPILL_THRESHOLD_BYTES 是 64 MiB，且低于归档上限', () => {
    expect(SPILL_THRESHOLD_BYTES).toBe(64 * 1024 * 1024)
    expect(SPILL_THRESHOLD_BYTES).toBeLessThan(DEFAULT_MAX_BYTES)
  })

  it('小文件不创建 sink，结果与原路径逐字节相同', async () => {
    let opened = 0
    const result = await readCappedOrSpill(chunked([bytes([1, 2, 3, 4, 5])], 5), {
      maxBytes: 1024,
      spillAtBytes: 64,
      spill: async () => {
        opened += 1
        return new Recorder()
      },
    })
    expect(result).toBeInstanceOf(Uint8Array)
    expect(sha256(result as Uint8Array)).toBe(sha256(bytes([1, 2, 3, 4, 5])))
    expect(opened).toBe(0)
  })

  it('恰好等于阈值仍走内存；多 1 字节才开 sink', async () => {
    const threshold = 8
    let opened = 0
    const exactly = bytes([1, 2, 3, 4, 5, 6, 7, 8])
    const memory = await readCappedOrSpill(chunked([exactly], 8), {
      maxBytes: 1024,
      spillAtBytes: threshold,
      spill: async () => {
        opened += 1
        return new Recorder()
      },
    })
    expect(memory).toBeInstanceOf(Uint8Array)
    expect(opened).toBe(0)

    const recorder = new Recorder()
    const over = bytes([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const spilled = await readCappedOrSpill(chunked([over], 9), {
      maxBytes: 1024,
      spillAtBytes: threshold,
      spill: async () => recorder,
    })
    expect(spilled).not.toBeInstanceOf(Uint8Array)
    expect(opened).toBe(0)
    expect(recorder.finishes).toBe(1)
    expect((spilled as Spilled).total).toBe(9)
  })
})

describe('readCappedOrSpill：超阈值走流式', () => {
  /** 16 chunks × 8 bytes, each byte distinct, so a reordered or concatenated buffer would show. */
  const chunks = Array.from({ length: 16 }, (_unused, i) =>
    Uint8Array.from({ length: 8 }, (_v, j) => ((i * 8 + j) * 7 + 3) % 256),
  )
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)

  it('结果与内存路径逐字节相同（sha256 比对）', async () => {
    const memory = await readCappedOrSpill(chunked(chunks, total), { maxBytes: 1 << 20 })
    const recorder = new Recorder()
    const spilled = await readCappedOrSpill(chunked(chunks, total), { maxBytes: 1 << 20, spillAtBytes: 16, spill: async () => recorder })

    expect(spilled).not.toBeInstanceOf(Uint8Array)
    const out = spilled as Spilled
    expect(out.total).toBe(total)
    expect(out.bytes).toHaveLength(total)
    expect(sha256(out.bytes)).toBe(sha256(memory as Uint8Array))
  })

  it('机制证据：sink 每次只收到一个源块，从未收到整段拼接', async () => {
    const recorder = new Recorder()
    await readCappedOrSpill(chunked(chunks, total), { maxBytes: 1 << 20, spillAtBytes: 16, spill: async () => recorder })
    // The buffered prefix is replayed first, then the rest arrives chunk by chunk — 16 writes for 16
    // source chunks, the largest of which is a single source chunk.
    expect(recorder.writes).toHaveLength(chunks.length)
    expect(recorder.maxWrite).toBe(8)
    expect(recorder.writes.every((chunk, i) => chunk === chunks[i])).toBe(true)
    expect(recorder.finishes).toBe(1)
    expect(recorder.aborts).toBe(0)
  })

  it('成功时 finish 拿到核对过的总长', async () => {
    const recorder = new Recorder()
    const result = await readCappedOrSpill(chunked([bytes([1, 2, 3, 4]), bytes([5, 6, 7, 8])], 8), {
      maxBytes: 1024,
      spillAtBytes: 4,
      spill: async () => recorder,
    })
    expect((result as Spilled).total).toBe(8)
    expect(sha256((result as Spilled).bytes)).toBe(sha256(bytes([1, 2, 3, 4, 5, 6, 7, 8])))
    expect(recorder.finishes).toBe(1)
    expect(recorder.aborts).toBe(0)
  })
})

describe('readCappedOrSpill：上限与长度核对', () => {
  it('声明长度超过上限：读之前就 fetch/too-large，不下沉', async () => {
    let opened = 0
    await expect(
      readCappedOrSpill(chunked([bytes([1])], 4096), {
        maxBytes: 1024,
        spillAtBytes: 8,
        spill: async () => {
          opened += 1
          return new Recorder()
        },
      }),
    ).rejects.toMatchObject({ code: 'fetch/too-large', message: '响应声明 4096 字节，超过上限 1024' })
    expect(opened).toBe(0)
  })

  it('流式路径中实读超上限：终局，sink 被 abort 且不 finish', async () => {
    const recorder = new Recorder()
    const chunks = [bytes([0, 0, 0, 0]), bytes([0, 0, 0, 0]), bytes([0, 0, 0, 0])]
    await expect(
      readCappedOrSpill(chunked(chunks), { maxBytes: 8, spillAtBytes: 4, spill: async () => recorder }),
    ).rejects.toMatchObject({ code: 'fetch/too-large', message: '响应超过上限 8 字节（已读 12）' })
    expect(recorder.aborts).toBe(1)
    expect(recorder.finishes).toBe(0)
  })

  it('流式路径中声明长度与实读不符：传输失败，sink 被 abort', async () => {
    const recorder = new Recorder()
    const chunks = [bytes([1, 2, 3, 4, 5, 6, 7, 8]), bytes([9, 10, 11, 12, 13, 14, 15, 16])]
    await expect(
      readCappedOrSpill(chunked(chunks, 100), { maxBytes: 1024, spillAtBytes: 4, spill: async () => recorder }),
    ).rejects.toMatchObject({ code: 'fetch/failed', message: '响应声明 100 字节，实际收到 16 字节' })
    expect(recorder.aborts).toBe(1)
    expect(recorder.finishes).toBe(0)
  })

  it('sink 打开失败：错误原样抛出，不再试内存路径', async () => {
    const boom = new Error('spill-open-boom')
    await expect(
      readCappedOrSpill(chunked([bytes([1, 2, 3, 4, 5])], 5), {
        maxBytes: 1024,
        spillAtBytes: 2,
        spill: async () => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)
  })
})
