/**
 * The pluggability promise (DESIGN §5 "可选注册新适配器"), pinned ACROSS packages on the public face.
 *
 * Three facts have to hold together for that promise to be real from OUTSIDE this repo, and each one
 * is a separate failure mode:
 *
 *   1. the engine's public index (`../src/index.js`, the file the plugin re-exports and the one that
 *      becomes `lib/index.d.ts`) actually carries the registrations;
 *   2. registering through that face mutates the SAME registry `@avantf/mem-retrieval` resolves
 *      through — two module copies would make a successful registration silently invisible;
 *   3. the business flow (`buildRuntime`) resolves through config, so a registered name is adopted
 *      with no code change.
 *
 * Uses the real packages rather than an in-test copy of the registry: `@avantf/mem-retrieval` is the
 * same workspace package the engine face re-exports from, so (2) is about module identity, not shape.
 *
 * THE THIRD SURFACE IS GONE. DESIGN §5 used to promise THREE registries; the rerank one was removed in
 * 0.5.0 (docs/review/RETRIEVAL_RERANK_NECESSITY.md, 方案 B — the seam went with the adapter). The
 * negative assertions at the bottom of this file are the regression guard: they must go RED if
 * `registerReranker` / `resolveReranker` / the `Reranker` interface is re-introduced anywhere on the
 * engine or retrieval face.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema } from '@avantf/mem-contract'
import * as retrievalFace from '@avantf/mem-retrieval'
import { LocalNumpyVectorStore, resolveSemantic, resolveVStore } from '@avantf/mem-retrieval'
import * as engineFace from '../src/index.js'
import {
  buildRuntime,
  registerSemanticBackend,
  registerVectorStore,
  type AvantfRuntime,
  type SemanticBackend,
  type VectorStore,
} from '../src/index.js'

const DIM = 768

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
  it('re-exports both registrations', () => {
    expect(typeof registerSemanticBackend).toBe('function')
    expect(typeof registerVectorStore).toBe('function')
  })

  it('feeds the same registry @avantf/mem-retrieval resolves through', () => {
    // Registering through the ENGINE face and resolving through the RETRIEVAL package is the
    // identity check: a second copy of the registry (a duplicated module) would still let the
    // register call succeed and then resolve to the built-in default, silently.
    registerSemanticBackend('face_identity_sem', () => fakeSemantic('face_identity_sem', []))
    registerVectorStore('face_identity_vstore', () => namedVectorStore('face_identity_vstore'))

    expect(resolveSemantic(ConfigSchema.parse({ semantic: { backend: 'face_identity_sem' } })).name).toBe('face_identity_sem')
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

  it('lets buildRuntime adopt a vector store registered through the face', async () => {
    registerVectorStore('face_pin_vstore', () => namedVectorStore('face_pin_vstore'))
    rt = buildRuntime({
      dataHome: homeWith('vectorStore:\n  backend: face_pin_vstore\n'),
    })
    // The vector-store leg is observable without a query: the diagnostic names the backend serving reads.
    expect(rt.memory.vectorsDiagnose().store).toBe('face_pin_vstore')
  })
})

describe('the rerank surface is gone (0.5.0, 方案 B)', () => {
  // These are the deliberate NEGATIVE pins for the removal. Each one is written so that re-adding the
  // symbol (the mutation) turns it red — that is the whole point of testing an absence.
  it('no longer re-exports registerReranker / resolveReranker from the engine face', () => {
    expect('registerReranker' in engineFace).toBe(false)
    expect('resolveReranker' in engineFace).toBe(false)
  })

  it('no longer resolves a reranker from the retrieval package', () => {
    expect('registerReranker' in retrievalFace).toBe(false)
    expect('resolveReranker' in retrievalFace).toBe(false)
    expect('LocalReranker' in retrievalFace).toBe(false)
    expect('NoneReranker' in retrievalFace).toBe(false)
    expect('rerankHits' in retrievalFace).toBe(false)
  })
})

// The TYPE-level half of the same pin, checked by `pnpm typecheck` rather than at runtime. If the
// `Reranker` interface is re-exported on the engine face again, the directive below becomes unused and
// TypeScript errors — i.e. the mutation turns this red even though `import type` has no runtime form.
// @ts-expect-error `Reranker` was removed from the published face in 0.5.0.
import type { Reranker as _RemovedReranker } from '../src/index.js'
