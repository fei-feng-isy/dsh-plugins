import { describe, it, expect } from 'vitest'
import { ConfigSchema } from '@avantf/mem-contract'
import {
  resolveSemantic,
  resolveVStore,
  registerVectorStore,
  registerSemanticBackend,
} from '../src/registry.js'
import { LocalNumpyVectorStore } from '../src/adapters/local_numpy.js'
import { HnswlibVectorStore } from '../src/adapters/hnswlib.js'
import { AutoVectorStore } from '../src/adapters/auto_vstore.js'
import { LocalBgeBackend } from '../src/adapters/local_bge.js'
import type { SemanticBackend, VectorStore } from '../src/interfaces.js'

describe('model bootstrap config', () => {
  it('defaults to a domestic mirror with auto-download on', () => {
    const cfg = ConfigSchema.parse({})
    expect(cfg.semantic.mirror).toBe('https://hf-mirror.com')
    expect(cfg.semantic.auto_download).toBe(true)
    // Empty = "the family root's models" (the loader resolves it); the pre-framework path is gone.
    expect(cfg.semantic.cache_dir).toBe('')
  })

  it('lets the mirror be overridden by config', () => {
    const cfg = ConfigSchema.parse({ semantic: { mirror: 'https://my.example.com' } })
    expect(cfg.semantic.mirror).toBe('https://my.example.com')
  })

  it('BGE backend degrades gracefully when transformers.js is not installed', async () => {
    const b = new LocalBgeBackend('BAAI/bge-base-zh-v1.5', 768)
    expect(b.isAvailable()).toBe(false)
    await b.warmUp() // must resolve (not throw) and stay unavailable
    expect(b.isAvailable()).toBe(false)
  })
})

describe('pluggable backends', () => {
  it('rejects an unknown semantic backend (registry, not a silent fallback)', () => {
    const cfg = ConfigSchema.parse({ semantic: { backend: 'does_not_exist' } })
    expect(() => resolveSemantic(cfg)).toThrow(/未知的语义后端/)
  })

  it('resolves local_bge to an unavailable semantic backend (degrades until M3)', () => {
    const cfg = ConfigSchema.parse({})
    const sem = resolveSemantic(cfg)
    expect(sem.name).toBe('local_bge')
    expect(sem.isAvailable()).toBe(false)
  })

  it('auto resolves to the upgrading AutoVectorStore', () => {
    const cfg = ConfigSchema.parse({ vectorStore: { backend: 'auto' } })
    const vs = resolveVStore(cfg)
    expect(vs).toBeInstanceOf(AutoVectorStore)
    expect(vs.dim).toBe(768)
    expect(vs.name).toBe('auto:local_numpy')
  })

  it('resolves every known vector-store name to a usable store', () => {
    const expected: Record<string, new (d: number) => VectorStore> = {
      local_numpy: LocalNumpyVectorStore,
      hnswlib: HnswlibVectorStore,
      auto: AutoVectorStore as unknown as new (d: number) => VectorStore,
    }
    for (const backend of ['local_numpy', 'hnswlib', 'faiss', 'pgvector', 'qdrant', 'auto']) {
      const cfg = ConfigSchema.parse({ vectorStore: { backend } })
      const vs = resolveVStore(cfg)
      expect(vs).toBeInstanceOf(expected[backend] ?? LocalNumpyVectorStore)
    }
  })

  it('lets a third-party backend be registered and resolved without touching the business flow', () => {
    const cfg = ConfigSchema.parse({ vectorStore: { backend: 'custom' } })
    class CustomStore implements VectorStore {
      readonly name = 'custom'
      readonly dim = 768
      add() {}
      topk() { return [] }
      fetch() { return new Map() }
      remove() {}
      count() { return 0 }
      rebuild() {}
    }
    registerVectorStore('custom', () => new CustomStore())
    const vs = resolveVStore(cfg)
    expect(vs.name).toBe('custom')
  })

  it('lets a semantic backend be registered and resolved', () => {
    const cfg = ConfigSchema.parse({ semantic: { backend: 'fake' } })
    const fake: SemanticBackend = {
      name: 'fake',
      dim: 768,
      isAvailable: () => true,
      encode: async () => new Float32Array(768),
      encodeBatch: async () => [],
    }
    registerSemanticBackend('fake', () => fake)
    expect(resolveSemantic(cfg).isAvailable()).toBe(true)
  })

  it('rejects an unknown name in every registry — never a silent fallback', () => {
    // Both surfaces share one contract, and the message is the operator's only clue for a config
    // typo, so it is pinned verbatim: a name nobody registered is an error, not a quiet built-in.
    expect(() => resolveSemantic(ConfigSchema.parse({ semantic: { backend: 'nope' } }))).toThrow('未知的语义后端：nope')
    expect(() => resolveVStore(ConfigSchema.parse({ vectorStore: { backend: 'nope' } }))).toThrow('未知的向量库后端：nope')
  })

  it('keeps the unregistered defaults exactly as before', () => {
    // Adding a registration (and the re-exports) must not move the built-in resolution: with
    // nothing registered, each surface still lands on the same adapter it always did.
    const cfg = ConfigSchema.parse({})
    expect(resolveSemantic(cfg).name).toBe('local_bge')
    expect(resolveVStore(cfg).name).toBe('auto:local_numpy')
  })

  it('threads the warm deferral through to the backend factory', () => {
    // The DSH plugin resolves with `{ deferWarm: true }` because the family framework is still
    // installing the model into the managed root: a constructor warm here would race that install
    // and fetch a second copy (M1). The registry must not swallow the flag.
    const cfg = ConfigSchema.parse({ semantic: { backend: 'capture' } })
    const seen: unknown[] = []
    registerSemanticBackend('capture', (_cfg, opts) => {
      seen.push(opts)
      return {
        name: 'capture',
        dim: 768,
        isAvailable: () => true,
        encode: async () => new Float32Array(768),
        encodeBatch: async () => [],
      }
    })
    resolveSemantic(cfg, { deferWarm: true })
    resolveSemantic(cfg)
    expect(seen).toEqual([{ deferWarm: true }, undefined])
  })
})
