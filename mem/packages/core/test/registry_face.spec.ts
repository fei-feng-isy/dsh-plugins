/**
 * The pluggability promise (DESIGN §5 "可选注册新适配器"), pinned ACROSS packages on the public face.
 *
 * Three facts have to hold together for that promise to be real from OUTSIDE this repo, and each one
 * is a separate failure mode:
 *
 *   1. the engine's public index (`../src/index.js`, the file the plugin re-exports and the one that
 *      becomes `lib/index.d.ts`) actually carries the three registrations;
 *   2. registering through that face mutates the SAME registry `@avantf/mem-retrieval` resolves
 *      through — two module copies would make a successful registration silently invisible;
 *   3. the business flow (`buildRuntime`) resolves through config, so a registered name is adopted
 *      with no code change.
 *
 * Uses the real packages rather than an in-test copy of the registry: `@avantf/mem-retrieval` is the
 * same workspace package the engine face re-exports from, so (2) is about module identity, not shape.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema } from '@avantf/mem-contract'
import { LocalNumpyVectorStore, resolveReranker, resolveSemantic, resolveVStore } from '@avantf/mem-retrieval'
import {
  buildRuntime,
  registerReranker,
  registerSemanticBackend,
  registerVectorStore,
  type AvantfRuntime,
  type Reranker,
  type SemanticBackend,
  type VectorStore,
} from '../src/index.js'

const DIM = 512

let dir: string | undefined
let rt: AvantfRuntime | undefined

afterEach(() => {
  rt?.shutdown()
  rt = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A throwaway data home whose `configs/common.yaml` selects whatever the test registered. */
function homeWith(commonYaml: string): string {
  dir = mkdtempSync(join(tmpdir(), 'avf-face-'))
  mkdirSync(join(dir, 'configs'), { recursive: true })
  writeFileSync(join(dir, 'configs', 'common.yaml'), commonYaml)
  return dir
}

function fakeSemantic(name: string, warm: string[]): SemanticBackend {
  return {
    name,
    dim: DIM,
    isAvailable: () => true,
    encode: async () => new Float32Array(DIM),
    encodeBatch: async () => [],
    warmUp: async () => { warm.push(name) },
  }
}

/**
 * A named vector store that delegates to the REAL `LocalNumpyVectorStore`: the name is the only thing
 * under test (did the registry's backend get adopted?), so the behaviour stays the real one.
 */
function namedVectorStore(name: string): VectorStore {
  const inner = new LocalNumpyVectorStore(DIM)
  return {
    name,
    dim: DIM,
    add: (id, vec) => inner.add(id, vec),
    topk: (vec, k) => inner.topk(vec, k),
    fetch: (ids) => inner.fetch(ids),
    remove: (id) => inner.remove(id),
    count: () => inner.count(),
    rebuild: (rows) => inner.rebuild(rows),
  }
}

describe('the registration surface on the engine public face', () => {
  it('re-exports all three registrations', () => {
    expect(typeof registerSemanticBackend).toBe('function')
    expect(typeof registerReranker).toBe('function')
    expect(typeof registerVectorStore).toBe('function')
  })

  it('feeds the same registry @avantf/mem-retrieval resolves through', () => {
    // Registering through the ENGINE face and resolving through the RETRIEVAL package is the
    // identity check: a second copy of the registry (a duplicated module) would still let the
    // register call succeed and then resolve to the built-in default, silently.
    registerSemanticBackend('face_identity_sem', () => fakeSemantic('face_identity_sem', []))
    const reranker: Reranker = {
      name: 'face_identity_rerank',
      isAvailable: () => true,
      rerank: async (_query, candidates) => candidates.map((c) => c.id),
    }
    registerReranker('face_identity_rerank', () => reranker)
    registerVectorStore('face_identity_vstore', () => namedVectorStore('face_identity_vstore'))

    expect(resolveSemantic(ConfigSchema.parse({ semantic: { backend: 'face_identity_sem' } })).name).toBe('face_identity_sem')
    expect(resolveReranker(ConfigSchema.parse({ rerank: { backend: 'face_identity_rerank' } })).name).toBe('face_identity_rerank')
    expect(resolveVStore(ConfigSchema.parse({ vectorStore: { backend: 'face_identity_vstore' } })).name).toBe('face_identity_vstore')
  })

  it('lets buildRuntime adopt a semantic backend registered through the face', async () => {
    const warm: string[] = []
    registerSemanticBackend('face_pin_sem', () => fakeSemantic('face_pin_sem', warm))
    rt = buildRuntime({ dataHome: homeWith('semantic:\n  backend: face_pin_sem\n  auto_download: false\n') })
    // The store warmed THIS instance (not the built-in local_bge) and reports it available.
    expect(await rt.memory.warmupSemantic()).toBe(true)
    expect(warm).toEqual(['face_pin_sem'])
  })

  it('lets buildRuntime adopt a reranker and a vector store registered through the face', async () => {
    const reranked: string[] = []
    const reranker: Reranker = {
      name: 'face_pin_rerank',
      isAvailable: () => true,
      rerank: async (query, candidates) => { reranked.push(query); return candidates.map((c) => c.id) },
    }
    registerReranker('face_pin_rerank', () => reranker)
    registerVectorStore('face_pin_vstore', () => namedVectorStore('face_pin_vstore'))
    rt = buildRuntime({
      dataHome: homeWith('rerank:\n  backend: face_pin_rerank\nvectorStore:\n  backend: face_pin_vstore\n'),
    })
    // The vector-store leg is observable without a query: the diagnostic names the backend serving reads.
    expect(rt.memory.vectorsDiagnose().store).toBe('face_pin_vstore')
    // The rerank leg only runs when a query produced candidates, so drive one: a CJK trigram query
    // against a fact that contains it makes the FTS leg produce a hit deterministically.
    await rt.memory.add('跨包注册面 pin：李娜负责统一网关。', 'pin')
    await rt.memory.search({ query: '统一网关' })
    // `reranked` non-empty IS "the registered reranker ran". Its content is pinned too, but not its
    // length: the store may run a strict pass and then the documented auto-relax pass.
    expect(reranked.length).toBeGreaterThan(0)
    expect(reranked.every((query) => query === '统一网关')).toBe(true)
  })
})
