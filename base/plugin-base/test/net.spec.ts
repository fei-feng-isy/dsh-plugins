/**
 * Regression cover for the download byte cap. Two shapes that used to share one code are now distinct,
 * because a caller has to branch on them: crossing the hard cap is TERMINAL (`fetch/too-large`), while a
 * declared `content-length` that disagrees with the body is a truncated DOWNLOAD (`fetch/failed`) and
 * retries the next mirror.
 *
 * @module test/net
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_BYTES, downloadBytes, readCapped } from '../src/net.js'
import type { ProviderContext } from '../src/types.js'

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('readCapped：声明长度与实际上限', () => {
  it('声明长度与实读一致 ⇒ 通过', async () => {
    const body = 'hello'
    const response = new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
    await expect(readCapped(response)).resolves.toEqual(bytesOf(body))
  })

  it('没有 content-length ⇒ 只受硬上限约束', async () => {
    await expect(readCapped(new Response('hello', { status: 200 }))).resolves.toEqual(bytesOf('hello'))
  })

  it('声明的长度大于实读 ⇒ fetch/failed（短读）', async () => {
    const response = new Response('{"trunc":1}', { status: 200, headers: { 'content-length': String(1024 * 1024) } })
    await expect(readCapped(response)).rejects.toMatchObject({ code: 'fetch/failed' })
  })

  it('声明的长度小于实读 ⇒ fetch/failed（超读）', async () => {
    const response = new Response('0123456789', { status: 200, headers: { 'content-length': '3' } })
    await expect(readCapped(response)).rejects.toMatchObject({ code: 'fetch/failed' })
  })

  it('声明长度超过上限 ⇒ 在读之前就 fetch/too-large（终局）', async () => {
    const response = new Response('x', { status: 200, headers: { 'content-length': String(DEFAULT_MAX_BYTES + 1) } })
    await expect(readCapped(response, DEFAULT_MAX_BYTES)).rejects.toMatchObject({ code: 'fetch/too-large' })
  })

  it('声明长度小于上限但实读超过上限 ⇒ fetch/too-large（终局）', async () => {
    const response = new Response('0123456789', { status: 200, headers: { 'content-length': '3' } })
    await expect(readCapped(response, 4)).rejects.toMatchObject({ code: 'fetch/too-large' })
  })

  it('无 body 时也核对声明长度', async () => {
    const response = new Response(null, { status: 200, headers: { 'content-length': '5' } })
    await expect(readCapped(response)).rejects.toMatchObject({ code: 'fetch/failed' })
  })
})

describe('downloadBytes：下载期的进度可见（DSH Desktop 上曾空转 8 分钟无一行日志）', () => {
  /** 一个记录型 logger + 一个把 `failing` 里的 URL 回 503、其余回 'ok' 的 fetch。 */
  function ctxFor(failing: readonly string[], lines: string[]): ProviderContext {
    return {
      home: '/tmp/unused',
      logger: {
        debug: () => undefined,
        info: (message: string) => lines.push(`info ${message}`),
        warn: (message: string) => lines.push(`warn ${message}`),
        error: (message: string) => lines.push(`error ${message}`),
      },
      policy: {},
      fs: undefined as never,
      fetch: async (input: RequestInfo | URL) => {
        const url = String(input)
        if (failing.includes(url)) return new Response('', { status: 503 })
        return new Response('ok', { status: 200, headers: { 'content-length': '2' } })
      },
    } as unknown as ProviderContext
  }

  it('每次尝试一行；被跳过的候选源带原因；成功也留痕', async () => {
    const lines: string[] = []
    const first = 'https://mirror-a.test/demo.tgz'
    const second = 'https://mirror-b.test/demo.tgz'
    const { url, bytes } = await downloadBytes(ctxFor([first], lines), [first, second], 'binary-archive+demo')
    expect(url).toBe(second)
    expect(new TextDecoder().decode(bytes)).toBe('ok')
    expect(lines).toEqual([
      `info binary-archive+demo：尝试候选源 1/2 ${first}`,
      `warn binary-archive+demo：${first} 返回 HTTP 503，改用下一个候选源`,
      `info binary-archive+demo：尝试候选源 2/2 ${second}`,
      `info binary-archive+demo：下载完成 2 字节（${second}）`,
    ])
  })

  it('全部候选源失败时，每次尝试都有日志，且最后一个不再承诺"改用下一个"', async () => {
    const lines: string[] = []
    const urls = ['https://mirror-a.test/demo.tgz', 'https://mirror-b.test/demo.tgz']
    await expect(downloadBytes(ctxFor(urls, lines), urls, 'binary-archive+demo'))
      .rejects.toMatchObject({ code: 'fetch/failed' })
    expect(lines.filter((line) => line.startsWith('info '))).toHaveLength(2)
    expect(lines.at(-1)).toContain('没有更多候选源')
    expect(lines.at(-1)).not.toContain('改用下一个候选源')
  })

  it('超过硬上限是终局：立即 fetch/too-large，不再试下一个候选源', async () => {
    const lines: string[] = []
    const tried: string[] = []
    const first = 'https://mirror-a.test/demo.tgz'
    const second = 'https://mirror-b.test/demo.tgz'
    const ctx = {
      home: '/tmp/unused',
      logger: { debug: () => undefined, info: () => undefined, warn: (m: string) => lines.push(m), error: () => undefined },
      policy: {},
      fs: undefined as never,
      fetch: async (input: Parameters<typeof fetch>[0]) => {
        tried.push(String(input))
        // The declared length alone crosses the cap; readCapped throws before reading a body.
        return new Response('x', { status: 200, headers: { 'content-length': String(DEFAULT_MAX_BYTES + 1) } })
      },
    } as unknown as ProviderContext
    await expect(downloadBytes(ctx, [first, second], 'binary-archive+demo')).rejects.toMatchObject({ code: 'fetch/too-large' })
    expect(tried).toEqual([first])
  })
})
