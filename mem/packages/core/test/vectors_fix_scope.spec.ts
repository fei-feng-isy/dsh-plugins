import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { openKnowledgeDb } from '../src/db/knowledge.js'
import { float32ToBytes } from '../src/db/vectors.js'
import { allowAnyDomain } from './helpers.js'
import type { SemanticBackend } from '@avantf/mem-retrieval'

/**
 * `mem_admin vectors_fix` now covers BOTH stores: the same model swap leaves memory and knowledge
 * in the same state, and the manual repair used to exist for memory only. What this file pins is the
 * per-store report shape, the `store` filter and the dry-run split — the boundaries the shared flow
 * adds on top of each store's own migration spec.
 */
const DIM = 768
const OLD_SPACE = 'local_bge/Xenova/bge-small-zh-v1.5/512'
const MEMORY_FACTS = 4
const KB_DOCS = 5

class AxisSemantic implements SemanticBackend {
  readonly name = 'axis_sem'
  readonly dim = DIM
  isAvailable(): boolean { return true }
  ensureWarm(): void { /* always warm */ }
  async encode(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIM)
    v[text.length % DIM] = 1
    return v
  }
  async encodeBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.encode(t)))
  }
}

let dir: string
let rt: AvantfRuntime

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-vecfix-'))
  allowAnyDomain(dir)
  rt = buildRuntime({ dataHome: dir, semantic: new AxisSemantic() })
  for (let i = 1; i <= MEMORY_FACTS; i++) {
    await rt.remember({ action: 'add', content: `事实${String(i)}：一段长度接近真实语料的记录，用来占位。` })
  }
  for (let i = 1; i <= KB_DOCS; i++) {
    await rt.kb({
      action: 'ingest',
      text: `资料${String(i)}：一份用来占位的知识库文档，长度短于一个分块。`,
      domain: 'tech',
      source: 'fixtures',
      title: `资料${String(i)}`,
    })
  }
  // Age BOTH libraries into the previous embedding space (wrong width + old model id).
  const old = float32ToBytes(new Float32Array(512))
  rt.db.prepare('UPDATE facts SET semantic_vector = ?, embedding_model = ?').run(old, OLD_SPACE)
  const kb = openKnowledgeDb(rt.config.knowledge.db.path)
  try {
    kb.prepare('UPDATE doc_chunks SET semantic_vector = ?, embedding_model = ?').run(old, OLD_SPACE)
  } finally {
    kb.close()
  }
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('mem_admin vectors_fix covers both stores', () => {
  it('dry-run previews both stores and writes nothing', async () => {
    const plan = await rt.admin({ action: 'vectors_fix', dry_run: true })
    expect(plan.dry_run).toBe(true)
    expect(plan.semantic_available).toBe(true)
    expect(plan.stores.memory).toMatchObject({ stale: MEMORY_FACTS, dropped: 0, encoded: 0, failed: 0, semantic_available: true })
    expect(plan.stores.knowledge).toMatchObject({ stale: KB_DOCS, dropped: 0, encoded: 0, failed: 0, semantic_available: true })
    // Nothing was written: both stores still report the old space.
    expect(rt.memory.vectorSpaceHealth().stale).toBe(MEMORY_FACTS)
    expect(rt.knowledge.vectorSpaceHealth().stale).toBe(KB_DOCS)
  })

  it('store: memory repairs only memory and leaves the report single-store', async () => {
    const result = await rt.admin({ action: 'vectors_fix', store: 'memory' })
    expect(result.stores.memory).toMatchObject({ stale: MEMORY_FACTS, dropped: MEMORY_FACTS, encoded: MEMORY_FACTS })
    expect(result.stores.knowledge).toBeUndefined()
    expect(rt.memory.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: 0 })
    // The other library was NOT touched by a memory-scoped call.
    expect(rt.knowledge.vectorSpaceHealth().stale).toBe(KB_DOCS)
  })

  it('store: knowledge repairs only knowledge; a later default call covers both', async () => {
    const only = await rt.admin({ action: 'vectors_fix', store: 'knowledge' })
    expect(only.stores.knowledge).toMatchObject({ stale: KB_DOCS, dropped: 0, encoded: KB_DOCS })
    expect(only.stores.memory).toBeUndefined()
    expect(rt.knowledge.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: 0 })
    expect(rt.memory.vectorSpaceHealth().stale).toBe(MEMORY_FACTS)

    // The default call (no `store`) now covers both, and is idempotent for the store already done.
    const both = await rt.admin({ action: 'vectors_fix' })
    expect(both.stores.memory?.encoded).toBe(MEMORY_FACTS)
    expect(both.stores.knowledge?.encoded).toBe(0)
    expect(rt.memory.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: 0 })
    expect(rt.knowledge.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: 0 })
  })

  it('reports the common per-store subset for both libraries', async () => {
    const result = await rt.admin({ action: 'vectors_fix' })
    const common = ['stale', 'space_stale', 'missing', 'dropped', 'encoded', 'failed', 'semantic_available', 'would_warm']
    for (const kind of ['memory', 'knowledge'] as const) {
      const report = result.stores[kind]
      expect(report).toBeDefined()
      for (const key of common) expect(report).toHaveProperty(key)
    }
    // The live-index fields are memory's own.
    expect(result.stores.memory).toHaveProperty('unindexed')
    expect(result.stores.memory).toHaveProperty('reindexed')
    expect(result.stores.knowledge).not.toHaveProperty('unindexed')
  })
})
