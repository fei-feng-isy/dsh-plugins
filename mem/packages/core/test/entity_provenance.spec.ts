import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import type { SemanticBackend } from '@avantf/mem-retrieval'

/**
 * P-05b — the extractor already computes `{name, type, method}`; the write path used to keep only
 * `name`. These assertions pin that the two provenance columns now carry REAL values for entities
 * the store creates, WITHOUT any of the things that would have made that a data migration:
 * `ENTITY_EXTRACTOR_VERSION` is not bumped, no triples are re-run, no HRR vector is overwritten,
 * no contradiction check is requeued.
 *
 * The store is opened with an UNAVAILABLE semantic backend: the property under test is purely
 * synchronous (SQLite rows), so a real model must not be warmed and a populated model cache on the
 * machine must not change the result.
 */
class NeverWarm implements SemanticBackend {
  readonly name = 'entity_provenance_never_warm'
  readonly dim = 768
  isAvailable(): boolean { return false }
  async encode(): Promise<Float32Array> { throw new Error('no model') }
  async encodeBatch(): Promise<Float32Array[]> { throw new Error('no model') }
}

interface EntityRow {
  name: string
  entity_type: string | null
  extraction_method: string | null
}

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-entity-prov-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: new NeverWarm() })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

function rows(): EntityRow[] {
  return rt.db
    .prepare<EntityRow>('SELECT name, entity_type, extraction_method FROM entities ORDER BY entity_id')
    .all()
}

describe('P-05b entity provenance', () => {
  it('writes real entity_type / extraction_method for a freshly created vocabulary', async () => {
    // CJK + latin so the regex fallback (this suite has no nodejieba) produces TWO distinct types.
    await rt.remember({ action: 'add', content: '张伟管理 PostgreSQL 14' })
    const all = rows()
    expect(all.length, 'the fact must have produced at least one entity').toBeGreaterThan(0)

    for (const row of all) {
      expect(['jieba', 'regex']).toContain(row.extraction_method)
      expect(row.entity_type, `${row.name} must not keep the column default`).toBeTruthy()
      expect(row.entity_type).not.toBe('unknown')
    }
    const methods = new Set(all.map((r) => r.extraction_method))
    const types = new Set(all.map((r) => r.entity_type))
    // "no longer only one value": the type column carries something the default did not. Both
    // extractors qualify — jieba yields POS flags (`nr`/`n`/`eng`), the regex fallback yields `n`
    // for CJK and `eng` for latin — so this asserts the property without pinning which extractor
    // this machine has.
    expect(types.size, `entity_type values: ${[...types].join(',')}`).toBeGreaterThanOrEqual(2)
    // One tagging pass drives one extractor, so every row of a single write shares its method.
    expect([...methods].length).toBe(1)
  })

  it('keeps FIRST-WRITE-WINS: a later fact sharing a name does not rewrite its provenance row', async () => {
    await rt.remember({ action: 'add', content: '张伟管理 PostgreSQL 14' })
    const before = rows().find((r) => r.name === '张伟')
    expect(before).toBeDefined()

    // The second write links the SAME name again through the normal path. `INSERT OR IGNORE` on the
    // unique name must leave the first row's type/method alone — that is the "accept a mixed
    // old/new store" trade-off of not bumping the extractor version.
    await rt.remember({ action: 'add', content: '张伟负责发布窗口' })

    const after = rows().find((r) => r.name === '张伟')
    expect(after).toEqual(before)
  })

  it('adds nothing to the migration surface: the schema version does not move', async () => {
    // A bump of `ENTITY_EXTRACTOR_VERSION` would re-run triples + overwrite HRR + requeue the
    // contradiction detector for the whole store. P-05b is only a write-path assignment, so the
    // stored version of a fact written now is still the shipped constant.
    const { fact_id } = await rt.remember({ action: 'add', content: '陈静负责发布窗口' })
    const row = rt.db.prepare<{ entities_version: number }>('SELECT entities_version FROM facts WHERE fact_id = ?').get(fact_id)
    const { ENTITY_EXTRACTOR_VERSION } = await import('../src/entities/extract.js')
    expect(Number(row?.entities_version)).toBe(ENTITY_EXTRACTOR_VERSION)
  })
})
