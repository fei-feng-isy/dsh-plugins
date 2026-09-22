import { describe, expect, it } from 'vitest'
import { createPluginLogger } from '../src/kit/logger.js'
import { endpointId, fieldSymbol, resultSymbol, strictCodec } from '../src/kit/typert.js'
import { z } from 'zod'

describe('createPluginLogger', () => {
  it('writes one prefixed stderr line per call and mirrors into the host', () => {
    const lines: string[] = []
    const mirrored: string[] = []
    const log = createPluginLogger({
      prefix: '[avantf-x]',
      host: {
        info: (message) => { mirrored.push(`info:${message}`) },
        warn: (message) => { mirrored.push(`warn:${message}`) },
      },
      sink: (line) => { lines.push(line) },
    })
    log.info('a')
    log.warn('b')
    log.error('c')
    expect(lines).toEqual(['[avantf-x] INFO a', '[avantf-x] WARN b', '[avantf-x] ERROR c'])
    expect(mirrored).toEqual(['info:[avantf-x] a', 'warn:[avantf-x] b'])
  })

  it('never lets a throwing host logger escape', () => {
    const log = createPluginLogger({
      prefix: '[avantf-x]',
      host: { error: () => { throw new Error('host logger exploded') } },
      sink: () => {},
    })
    expect(() => { log.error('still fine') }).not.toThrow()
  })
})

describe('typert wire conventions', () => {
  it('names endpoints and fields with the generator convention', () => {
    expect(endpointId('@avantf/dsh-x', 'ns', 'watch')).toBe('@avantf/dsh-x#ns/watch')
    expect(fieldSymbol('@avantf/dsh-x', 'ns', 'watch', 'args')).toBe('@avantf/dsh-x#ns/watch:args')
    expect(resultSymbol('@avantf/dsh-x', 'ns', 'watch')).toBe('@avantf/dsh-x#ns/watch:result')
  })

  it('builds a strict codec that satisfies BOTH the 0.1.5 and 0.1.6 validators', () => {
    const schema = z.object({ a: z.string() })
    const codec = strictCodec(schema, '@avantf/dsh-x#ns/m:args')
    // 0.1.5 read `codec.schema.parse`; 0.1.6 reads `codec.create()`.
    expect(codec.mode).toBe('strict')
    expect(codec.schema).toBe(schema)
    expect(codec.create()).toBe(schema)
    expect(codec.typeSymbol).toBe('@avantf/dsh-x#ns/m:args')
  })
})
