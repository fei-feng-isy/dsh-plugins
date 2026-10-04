import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LocalBgeBackend,
  modelFilesPresent,
  modelRecordPath,
  readModelRevision,
  representationKey,
  representationKeyOf,
  UNDECLARED_REPRESENTATION,
  type SemanticBackend,
  type SemanticRepresentation,
} from '../src/index.js'
import { setRetrievalLogger } from '../src/log.js'
import type { AvantfLogger } from '@avantf/mem-contract'

/**
 * The representation fingerprint is the DETECTION half of "any change to how text becomes a vector
 * is a data migration". These are the unit-level guards: the key changes when (and only when) a
 * representation knob changes, and the model-revision read DEGRADES instead of throwing when the
 * family sidecar is absent, unreadable or malformed.
 */

const BASE: SemanticRepresentation = { pooling: 'mean', normalize: true, maxInputTokens: 0 }

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'avantf-rep-'))
}

/** Write the family provider's sidecar exactly where `providers/model.ts` puts it. */
function writeSidecar(cacheDir: string, model: string, body: unknown): void {
  const path = modelRecordPath(cacheDir, model)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
}

function collectingLogger(): { logger: AvantfLogger; lines: string[] } {
  const lines: string[] = []
  return { lines, logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) } }
}

afterEach(() => {
  setRetrievalLogger()
})

describe('representationKey', () => {
  it('is stable and normalized for the same representation', () => {
    expect(representationKey(BASE)).toBe('p=mean;n=1;w=0')
    // Normalization: pooling case/whitespace and a fractional window cannot produce a second key
    // for the same meaning (a spurious change here would re-encode a whole corpus for nothing).
    expect(representationKey({ pooling: ' MEAN ', normalize: true, maxInputTokens: 0 })).toBe('p=mean;n=1;w=0')
    expect(representationKey({ pooling: 'mean', normalize: true, maxInputTokens: 12.7 })).toBe('p=mean;n=1;w=12')
    expect(representationKey({ pooling: 'mean', normalize: false, maxInputTokens: -5 })).toBe('p=mean;n=0;w=0')
  })

  it('moves for EACH representation knob — pooling, normalize, window, revision', () => {
    const base = representationKey(BASE)
    expect(representationKey({ ...BASE, pooling: 'cls' })).not.toBe(base)
    expect(representationKey({ ...BASE, normalize: false })).not.toBe(base)
    expect(representationKey({ ...BASE, maxInputTokens: 512 })).not.toBe(base)
    expect(representationKey({ ...BASE, revision: '71e50dc531959f9e04ebf190ea25b00261a0a186' })).not.toBe(base)
  })

  it('omits an absent/blank revision rather than encoding a placeholder', () => {
    expect(representationKey(BASE)).toBe(representationKey({ ...BASE, revision: '' }))
    expect(representationKey(BASE)).toBe(representationKey({ ...BASE, revision: '   ' }))
  })

  it('names a backend that declares nothing as undeclared (honest, not a claimed representation)', () => {
    const undeclared: SemanticBackend = {
      name: 'custom',
      dim: 3,
      isAvailable: () => true,
      encode: async () => new Float32Array(3),
      encodeBatch: async (t) => t.map(() => new Float32Array(3)),
    }
    expect(representationKeyOf(undeclared)).toBe(UNDECLARED_REPRESENTATION)
    const declared: SemanticBackend = { ...undeclared, representation: () => BASE }
    expect(representationKeyOf(declared)).toBe('p=mean;n=1;w=0')
  })
})

describe('readModelRevision (the family sidecar, best effort)', () => {
  it('reads the sha the base records beside a flat-layout model', () => {
    const dir = makeDir()
    try {
      writeSidecar(dir, 'Xenova/bge-base-zh-v1.5', {
        schemaVersion: 1,
        repo: 'Xenova/bge-base-zh-v1.5',
        revision: 'main',
        sha: '71e50dc531959f9e04ebf190ea25b00261a0a186',
        files: ['onnx/model.onnx'],
      })
      const read = readModelRevision(dir, 'Xenova/bge-base-zh-v1.5')
      expect(read.revision).toBe('71e50dc531959f9e04ebf190ea25b00261a0a186')
      expect(read.path).toContain('models--Xenova--bge-base-zh-v1.5/record.json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades — no throw — when the sidecar is missing, malformed, or records nothing', () => {
    const dir = makeDir()
    try {
      const missing = readModelRevision(dir, 'Xenova/bge-base-zh-v1.5')
      expect(missing.revision).toBeUndefined()
      expect(missing.detail).toContain('no sidecar')

      writeSidecar(dir, 'Xenova/bge-base-zh-v1.5', '{ not json')
      expect(readModelRevision(dir, 'Xenova/bge-base-zh-v1.5').revision).toBeUndefined()

      writeSidecar(dir, 'Xenova/bge-base-zh-v1.5', { repo: 'Xenova/bge-base-zh-v1.5' })
      const empty = readModelRevision(dir, 'Xenova/bge-base-zh-v1.5')
      expect(empty.revision).toBeUndefined()
      expect(empty.detail).toContain('records no revision')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('LocalBgeBackend.representation', () => {
  const noPipe = async (): Promise<never> => { throw new Error('model not needed for the fingerprint') }

  it('declares the knobs it actually applies, with the revision when the sidecar has one', () => {
    const dir = makeDir()
    const previous = process.env['AVANTF_MEM_MODEL_CACHE']
    try {
      writeSidecar(dir, 'Xenova/bge-small-zh-v1.5', { revision: 'main', sha: 'abc123' })
      process.env['AVANTF_MEM_MODEL_CACHE'] = dir
      const backend = new LocalBgeBackend('Xenova/bge-small-zh-v1.5', 512, {
        autoDownload: false,
        deferWarm: true,
        maxInputTokens: 256,
        pooling: 'cls',
        normalize: false,
      }, noPipe)
      expect(backend.representation()).toEqual({
        pooling: 'cls',
        normalize: false,
        maxInputTokens: 256,
        revision: 'abc123',
      })
      expect(representationKeyOf(backend)).toBe('p=cls;n=0;w=256;r=abc123')
    } finally {
      if (previous === undefined) delete process.env['AVANTF_MEM_MODEL_CACHE']
      else process.env['AVANTF_MEM_MODEL_CACHE'] = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to a revision-less fingerprint with ONE warning when weights are present but the sidecar is not', () => {
    const dir = makeDir()
    const previous = process.env['AVANTF_MEM_MODEL_CACHE']
    const { logger, lines } = collectingLogger()
    try {
      process.env['AVANTF_MEM_MODEL_CACHE'] = dir
      // The weights ARE on disk (the flat layout) but nobody recorded their revision.
      mkdirSync(join(dir, 'Xenova', 'bge-small-zh-v1.5'), { recursive: true })
      writeFileSync(join(dir, 'Xenova', 'bge-small-zh-v1.5', 'config.json'), '{}')
      expect(modelFilesPresent(dir, 'Xenova/bge-small-zh-v1.5')).toBe(true)
      setRetrievalLogger(logger)
      const backend = new LocalBgeBackend('Xenova/bge-small-zh-v1.5', 512, { autoDownload: false, deferWarm: true }, noPipe)
      expect(backend.representation()).toEqual({ pooling: 'mean', normalize: true, maxInputTokens: 0 })
      expect(representationKeyOf(backend)).toBe('p=mean;n=1;w=0')
      const warnings = lines.filter((l) => l.includes('no model revision'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('cannot be detected as a representation change')
      // Cached: a second read must not warn again, and must not change the fingerprint mid-process.
      backend.representation()
      expect(lines.filter((l) => l.includes('no model revision'))).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env['AVANTF_MEM_MODEL_CACHE']
      else process.env['AVANTF_MEM_MODEL_CACHE'] = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stays quiet when the model is not installed yet (fresh install in flight, nothing to fingerprint)', () => {
    const dir = makeDir()
    const previous = process.env['AVANTF_MEM_MODEL_CACHE']
    const { logger, lines } = collectingLogger()
    try {
      process.env['AVANTF_MEM_MODEL_CACHE'] = dir // empty: no weights, no sidecar
      setRetrievalLogger(logger)
      const backend = new LocalBgeBackend('Xenova/bge-small-zh-v1.5', 512, { autoDownload: false, deferWarm: true }, noPipe)
      expect(representationKeyOf(backend)).toBe('p=mean;n=1;w=0')
      expect(lines.filter((l) => l.includes('no model revision'))).toHaveLength(0)
    } finally {
      if (previous === undefined) delete process.env['AVANTF_MEM_MODEL_CACHE']
      else process.env['AVANTF_MEM_MODEL_CACHE'] = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
