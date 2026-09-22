import { describe, it, expect } from 'vitest'
import { describeError } from '../src/log.js'

describe('describeError', () => {
  it('returns a plain error message unchanged', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
  })

  it('surfaces the cause chain that `fetch failed` hides', () => {
    const cause = Object.assign(
      new Error('Connect Timeout Error (attempted address: hf-mirror.com:443, timeout: 10000ms)'),
      { code: 'UND_ERR_CONNECT_TIMEOUT' },
    )
    const text = describeError(new TypeError('fetch failed', { cause }))
    // The chain + code are the subject here; the Chinese gloss is pinned separately below.
    expect(text.endsWith('fetch failed <- Connect Timeout Error (attempted address: hf-mirror.com:443, timeout: 10000ms) [UND_ERR_CONNECT_TIMEOUT]')).toBe(true)
    expect(text.startsWith('连接超时（UND_ERR_CONNECT_TIMEOUT）—— ')).toBe(true)
  })

  it('walks nested causes and reports the innermost code', () => {
    const root = Object.assign(new Error('getaddrinfo ENOTFOUND huggingface.co'), { code: 'ENOTFOUND' })
    const middle = new Error('socket hang up', { cause: root })
    const text = describeError(new Error('fetch failed', { cause: middle }))
    expect(text.endsWith('fetch failed <- socket hang up <- getaddrinfo ENOTFOUND huggingface.co [ENOTFOUND]')).toBe(true)
    expect(text.startsWith('域名解析失败（ENOTFOUND）—— ')).toBe(true)
  })

  it('accepts non-Error throwables', () => {
    expect(describeError('just a string')).toBe('just a string')
    expect(describeError(new Error('outer', { cause: 'inner text' }))).toBe('outer <- inner text')
  })

  it('reports a code that sits on the outer error with no cause at all', () => {
    const text = describeError(Object.assign(new Error('nope'), { code: 'EACCES' }))
    expect(text.endsWith('nope [EACCES]')).toBe(true)
    expect(text.startsWith('权限不足（EACCES）—— ')).toBe(true)
  })

  it('terminates on a self-referential cause chain', () => {
    const loop = new Error('loop')
    ;(loop as { cause?: unknown }).cause = loop
    expect(describeError(loop)).toBe('loop')
  })
})

describe('describeError: Chinese gloss for errno codes', () => {
  it('prefixes what the code means, keeping the technical text for diagnosis', () => {
    const error = Object.assign(new Error("EACCES: permission denied, open '/x'"), { code: 'EACCES' })
    const text = describeError(error)
    expect(text).toContain('权限不足（EACCES）')
    expect(text).toContain('permission denied') // the original wording is still there
    expect(text).toContain('[EACCES]')
  })

  it('leaves an unknown code and a plain error alone', () => {
    expect(describeError(Object.assign(new Error('boom'), { code: 'EWEIRD' }))).toBe('boom [EWEIRD]')
    expect(describeError(new Error('plain'))).toBe('plain')
  })
})
