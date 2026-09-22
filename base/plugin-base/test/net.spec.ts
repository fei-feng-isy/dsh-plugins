/**
 * Regression cover for the download byte cap: a declared `content-length` that disagrees with the
 * body is an integrity failure, not a silent short read.
 *
 * @module test/net
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_BYTES, readCapped } from '../src/net.js'

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

  it('声明长度超过上限 ⇒ 在读之前就 fetch/failed', async () => {
    const response = new Response('x', { status: 200, headers: { 'content-length': String(DEFAULT_MAX_BYTES + 1) } })
    await expect(readCapped(response, DEFAULT_MAX_BYTES)).rejects.toMatchObject({ code: 'fetch/failed' })
  })

  it('声明长度小于上限但实读超过上限 ⇒ fetch/failed', async () => {
    const response = new Response('0123456789', { status: 200, headers: { 'content-length': '3' } })
    await expect(readCapped(response, 4)).rejects.toMatchObject({ code: 'fetch/failed' })
  })

  it('无 body 时也核对声明长度', async () => {
    const response = new Response(null, { status: 200, headers: { 'content-length': '5' } })
    await expect(readCapped(response)).rejects.toMatchObject({ code: 'fetch/failed' })
  })
})
