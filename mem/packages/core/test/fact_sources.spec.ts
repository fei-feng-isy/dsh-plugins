/**
 * The `fact_sources` kind vocabulary has ONE spelling.
 *
 * `FACT_SOURCE_KINDS` used to be a non-test orphan: the real answers came from a hand-written regex in
 * `classifySourceRef`, from two SQL `CHECK (kind IN (…))` constraints, and from the contract's
 * `FactSourceView['kind']` — four lists that agreed by luck. These cases pin the JS derivation to the
 * array, and the array to the SQL constraint, so adding a kind is one edit plus one failing test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import {
  FACT_SOURCE_FALLBACK_KIND,
  FACT_SOURCE_KINDS,
  classifySourceRef,
} from '../src/db/dao/fact_sources.js'
import type { SemanticBackend } from '@avantf/mem-retrieval'

/** No model, no download: this spec is about a closed vocabulary, not about embeddings. */
class NeverWarm implements SemanticBackend {
  readonly name = 'fact_sources_never_warm'
  readonly dim = 768
  isAvailable(): boolean { return false }
  async encode(): Promise<Float32Array> { throw new Error('no model') }
  async encodeBatch(): Promise<Float32Array[]> { throw new Error('no model') }
}

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-src-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: new NeverWarm() })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('classifySourceRef derives the kind from the ONE vocabulary', () => {
  it('round-trips every kind in FACT_SOURCE_KINDS', () => {
    for (const kind of FACT_SOURCE_KINDS) {
      // The spec of the table: `kind:x` is BY DEFINITION that kind. (The old hand-written regex listed
      // only three of the four prefixes, so this case is exactly what it could not say.)
      expect(classifySourceRef(`${kind}:x`).kind).toBe(kind)
    }
    // …and the array IS the set of kinds the classifier can ever return.
    const returned = new Set(FACT_SOURCE_KINDS.map((kind) => classifySourceRef(`${kind}:x`).kind))
    expect([...returned].sort()).toEqual([...FACT_SOURCE_KINDS].sort())
  })

  it('keeps the reference whole, colons included (no shape guessing)', () => {
    expect(classifySourceRef('kb_doc:design:arch:标题')).toEqual({ kind: 'kb_doc', ref: 'design:arch:标题' })
    expect(classifySourceRef('tool:importer')).toEqual({ kind: 'tool', ref: 'importer' })
    // The FIRST colon is the separator: the rest belongs to the reference.
    expect(classifySourceRef('session:a:b:c')).toEqual({ kind: 'session', ref: 'a:b:c' })
  })

  it('falls back to `manual` with the reference VERBATIM', () => {
    expect(classifySourceRef('随手记的出处')).toEqual({ kind: 'manual', ref: '随手记的出处' })
    expect(classifySourceRef('domain:source:title')).toEqual({ kind: 'manual', ref: 'domain:source:title' })
    // Unknown prefix, and a KNOWN prefix with an empty reference: both stay verbatim.
    expect(classifySourceRef('note:hello')).toEqual({ kind: 'manual', ref: 'note:hello' })
    expect(classifySourceRef('session:')).toEqual({ kind: 'manual', ref: 'session:' })
    expect(classifySourceRef(':x')).toEqual({ kind: 'manual', ref: ':x' })
    // The fallback kind's own name is NOT a prefix: the documented `kind:` prefixes are the others
    // (`contract/src/tools.ts`'s SOURCE_REF_DESCRIPTION), so `manual:x` keeps `manual:x`.
    expect(classifySourceRef('manual:x')).toEqual({ kind: 'manual', ref: 'manual:x' })
  })

  it('handles a newline inside the reference (the old regex was dot-all on purpose)', () => {
    expect(classifySourceRef('session:a\nb')).toEqual({ kind: 'session', ref: 'a\nb' })
  })
})

describe('the SQL vocabulary is the same list', () => {
  it('admits every FACT_SOURCE_KINDS and refuses an unknown kind', async () => {
    const fact = await rt.remember({ action: 'add', content: 'SQL 词表钉住 fact_sources kind' })
    const insert = rt.db.prepare('INSERT INTO fact_sources (fact_id, kind, ref) VALUES (?, ?, ?)')
    for (const kind of FACT_SOURCE_KINDS) insert.run(fact.fact_id, kind, `ref-${kind}`)
    const stored = rt.db
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM fact_sources WHERE fact_id = ?')
      .get(fact.fact_id)
    expect(Number(stored?.n ?? 0)).toBe(FACT_SOURCE_KINDS.length)
    // `CHECK (kind IN (…))` in `db/schema.ts` / `db/conn.ts`: a kind this file does not know cannot
    // be persisted, so a JS-only addition fails HERE instead of at read time. (Plain `INSERT`, not
    // `OR IGNORE`: the latter silently skips a CHECK violation too.)
    expect(() => insert.run(fact.fact_id, 'not-a-kind', 'x')).toThrow()
  })

  it('records the classifier output as the single source of a real write', async () => {
    const fact = await rt.remember({
      action: 'add',
      content: '来源分类写入 round-trip',
      source_ref: 'tool:importer',
    })
    const detail = rt.admin({ action: 'detail', fact_id: fact.fact_id })
    if (detail === null || 'error' in detail) throw new Error('the fact just written must be readable')
    expect(detail.sources).toEqual([{ kind: 'tool', ref: 'importer' }])
  })
})
