/**
 * The DAO layer's shared algorithms and contracts (`src/db/dao/shared.ts`).
 *
 * Spec: `docs/vector-repair-shared-flow.md` §4.5 phase 7. Four rules have exactly one
 * implementation and two aggregates:
 *
 *   ① the entity-candidate leg's score/order + the batch/union loop
 *      (`EntitiesDao.candidateFactsForAnyEntity` / `ChunksDao.candidatesByEntityNames`),
 *   ② the batched `UPDATE … SET entities_version = ?` (`FactsDao` / `ChunksDao`),
 *   ③ the short-query LIKE fallback's build/guard/double-bind protocol (both `ftsSubstringSearch`),
 *   ④ the document-frequency query shape (`activeDocFrequency` / `docFrequency`).
 *
 * Deliberately DAO-level: raw store handles, no runtime. That lets the "equivalent data in both
 * schemas ⇒ identical result" contract be asserted directly, and keeps this file independent of the
 * store layer (whose files are being converged in a parallel stage). A recording fake `Db` pins the
 * protocol details — bind order, batch split, dedupe — that no realistic seeded corpus can reach.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemoryStore } from '../src/db/conn.js'
import { openKnowledgeStore } from '../src/db/knowledge.js'
import type { Db } from '../src/db/port.js'
import { batches, inList } from '../src/db/chunk.js'
import { FactsDao } from '../src/db/dao/facts.js'
import { EntitiesDao } from '../src/db/dao/entities.js'
import { ChunksDao } from '../src/db/dao/chunks.js'
import {
  entityBags,
  entityCandidates,
  entityCandidateTail,
  likeSubstringLeg,
  queryDocFrequency,
  setEntitiesVersionBatch,
} from '../src/db/dao/shared.js'

// ─── a recording fake Db ────────────────────────────────────────────────────

interface Call {
  sql: string
  params: unknown[]
}

/** A `Db` whose statements record `(sql, params)` and return canned rows, one row-set per prepare. */
function fakeDb(rowSets: unknown[][] = []): { db: Db; calls: Call[] } {
  const calls: Call[] = []
  let prepared = 0
  const db = {
    prepare(sql: string) {
      const rows = rowSets[prepared] ?? []
      prepared += 1
      const record = (params: unknown[]): void => {
        calls.push({ sql, params })
      }
      return {
        all: (...params: unknown[]) => {
          record(params)
          return rows
        },
        get: (...params: unknown[]) => {
          record(params)
          return rows[0]
        },
        run: (...params: unknown[]) => {
          record(params)
          return { changes: 1, lastInsertRowid: 0 }
        },
      }
    },
    exec: () => undefined,
    transaction: (fn: () => unknown) => Object.assign(() => fn(), { immediate: fn, deferred: fn, exclusive: fn }),
    pragma: () => undefined,
    close: () => undefined,
  } as unknown as Db
  return { db, calls }
}

const names = (n: number, prefix = 'n'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`)

describe('entityCandidates (shared score/order + batching)', () => {
  it('single-statement mode issues ONE statement for a name list past the batch size', () => {
    // The memory sibling does not batch: its names are request-bounded, so one `LIMIT` is the exact
    // top-N. This pins that the shared runner does not silently start batching it.
    const { db, calls } = fakeDb()
    const list = names(600)
    const out = entityCandidates(db, {
      names: list,
      filterParams: ['F1', null, 'F3', null],
      limit: 9,
      queryWidth: 2,
      widthCap: 3,
      batchNames: false,
      sql: (p) => `sql(${String(p.length)})`,
    })
    expect(out).toEqual([])
    expect(calls).toHaveLength(1)
    // Bind order: <names…>, <filters…>, queryWidth, widthCap, limit. `inList` pads 600 to its exact
    // width (no rung above 512), so the tail is the last 7 params.
    const call = calls[0] as Call
    expect(call.params).toHaveLength(600 + 7)
    expect(call.params.slice(0, 3)).toEqual(['n0', 'n1', 'n2'])
    expect(call.params[599]).toBe('n599')
    expect(call.params.slice(-7)).toEqual(['F1', null, 'F3', null, 2, 3, 9])
  })

  it('batch mode splits at 500, unions and dedupes keeping first-seen order', () => {
    // The knowledge sibling batches and unions: a union of per-batch tops is not a top-N, so the
    // duplicates across batches must collapse without reordering (the caller re-scores the union).
    const { db, calls } = fakeDb([
      [{ id: 1 }, { id: 2 }],
      [{ id: 2 }, { id: 3 }],
      [{ id: 4 }],
    ])
    const out = entityCandidates(db, {
      names: names(1200),
      filterParams: [null, null, null, null],
      limit: 5,
      queryWidth: 7,
      widthCap: 3,
      batchNames: true,
      sql: (p) => `sql(${String(p.length)})`,
    })
    expect(out).toEqual([1, 2, 3, 4])
    expect(calls).toHaveLength(3)
    // 500 → rung 512, 500 → 512, 200 → 256; each carries the 4 filters + the 3 score params.
    expect(calls.map((c) => c.params.length)).toEqual([512 + 7, 512 + 7, 256 + 7])
    for (const call of calls) expect(call.params.slice(-3)).toEqual([7, 3, 5])
    // The pad repeats the batch's last element (inert in `IN (…)`, keeps the cache key stable).
    expect((calls[0] as Call).params[500]).toBe('n499')
  })

  it('returns empty without querying for an empty name list or a non-positive limit', () => {
    for (const q of [
      { names: [] as readonly string[], limit: 5 },
      { names: names(3), limit: 0 },
      { names: names(3), limit: -1 },
    ]) {
      const { db, calls } = fakeDb()
      expect(
        entityCandidates(db, {
          names: q.names,
          filterParams: [],
          limit: q.limit,
          queryWidth: 1,
          widthCap: 3,
          batchNames: true,
          sql: () => 'sql',
        }),
      ).toEqual([])
      expect(calls).toHaveLength(0)
    }
  })

  it('the shared tail carries the one score formula for a given id column', () => {
    // Both callers splice this; the id column is the only variable. Pinned because the ORDER BY is
    // what makes the `LIMIT` keep the best rows (see `store/entity_leg.ts`).
    expect(entityCandidateTail('fa.fact_id')).toBe(
      'GROUP BY fa.fact_id\n'
      + '  ORDER BY (CAST(shared AS REAL) / (? + MIN(total - shared, ?))) DESC, total ASC, fa.fact_id ASC\n'
      + '  LIMIT ?',
    )
    expect(entityCandidateTail('ce.chunk_id')).toContain('MIN(total - shared, ?)')
    expect(entityCandidateTail('ce.chunk_id')).toContain('ce.chunk_id ASC')
  })
})

describe('setEntitiesVersionBatch (shared batched UPDATE)', () => {
  it('issues one batched UPDATE per batch and sums `changes`', () => {
    const { db, calls } = fakeDb()
    const changes = setEntitiesVersionBatch(db, 'facts', 'fact_id', names(600).map((_, i) => i + 1), 7)
    expect(changes).toBe(2) // 600 ids → two batches, the fake reports 1 change each
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.sql).toMatch(/^UPDATE facts SET entities_version = \? WHERE fact_id IN \(\?/)
      expect(call.params[0]).toBe(7)
    }
    expect((calls[0] as Call).params).toHaveLength(1 + 512)
    expect((calls[1] as Call).params).toHaveLength(1 + 128) // 88 ids → rung 128
  })

  it('is a no-op for an empty id list', () => {
    const { db, calls } = fakeDb()
    expect(setEntitiesVersionBatch(db, 'doc_chunks', 'chunk_id', [], 3)).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

describe('queryDocFrequency (shared query shape)', () => {
  it('builds one grouped COUNT and coerces the counts to numbers', () => {
    const { db, calls } = fakeDb([[{ name: 'alpha', df: '4' }, { name: 'beta', df: 3 }]])
    const df = queryDocFrequency(db, ['alpha', 'beta', 'missing'], {
      from: '\n  FROM entities e',
      nameExpr: 'e.name',
      where: "e.kind = 'x'",
    })
    expect(df).toEqual(new Map([['alpha', 4], ['beta', 3]]))
    expect(calls).toHaveLength(1)
    const sql = (calls[0] as Call).sql
    expect(sql).toContain('SELECT e.name AS name, COUNT(*) AS df')
    expect(sql).toContain('WHERE e.name IN (')
    expect(sql).toContain("AND e.kind = 'x'")
    expect(sql).toContain('GROUP BY e.name')
  })

  it('omits the extra predicate and skips the query for no names', () => {
    const { db, calls } = fakeDb([[]])
    expect(queryDocFrequency(db, ['a'], { from: ' FROM chunk_entities', nameExpr: 'name' })).toEqual(new Map())
    expect((calls[0] as Call).sql).not.toContain(' AND ')
    const empty = fakeDb()
    expect(queryDocFrequency(empty.db, [], { from: ' FROM chunk_entities', nameExpr: 'name' })).toEqual(new Map())
    expect(empty.calls).toHaveLength(0)
  })
})

describe('likeSubstringLeg (shared short-query fallback protocol)', () => {
  it('binds the pattern list twice, around the caller filters, with -1 as the default limit', () => {
    const { db, calls } = fakeDb([[{ id: 1, rank: 1 }]])
    const out = likeSubstringLeg(
      db,
      'fa.content',
      ['ab', 'cd'],
      ({ any, count }) => `SELECT ${count} AS rank FROM facts WHERE (? IS NULL OR cat = ?) AND (${any}) LIMIT ?`,
      [null, 'cat1'],
    )
    expect(out).toEqual([{ id: 1, rank: 1 }])
    const call = calls[0] as Call
    // count's two placeholders, then the two filter values, then any's two, then the limit.
    expect(call.params).toEqual(['%ab%', '%cd%', null, 'cat1', '%ab%', '%cd%', -1])
    expect(call.sql).toContain('(? IS NULL OR cat = ?)')
  })

  it('escapes LIKE metacharacters and returns [] without querying for no terms', () => {
    const { db, calls } = fakeDb([[{ id: 1, rank: 1 }]])
    likeSubstringLeg(db, 'fa.content', ['50%_x'], ({ any, count }) => `SELECT ${count} ${any} LIMIT ?`)
    expect((calls[0] as Call).params).toEqual(['%50\\%\\_x%', '%50\\%\\_x%', -1])
    const empty = fakeDb()
    expect(likeSubstringLeg(empty.db, 'fa.content', [], () => 'never')).toEqual([])
    expect(empty.calls).toHaveLength(0)
  })
})

// ─── the two real DAOs on equivalent data ───────────────────────────────────

/**
 * The same (shared, total) profile in each schema, ordered so the ratio order differs from the
 * shared-count order: 1/(2+0), 2/(2+0), 2/(2+1), 2/(2+3) = 0.5, 1.0, 0.667, 0.4. A
 * shared-count-only ordering would be 2↔3 swapped.
 */
const PROFILES: readonly (readonly string[])[] = [
  ['alpha'],
  ['alpha', 'beta'],
  ['alpha', 'beta', 'noise1'],
  ['alpha', 'beta', 'noise1', 'noise2', 'noise3', 'noise4'],
]

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avf-dao-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Seeded {
  memDb: Db
  kbDb: Db
  facts: FactsDao
  entities: EntitiesDao
  chunks: ChunksDao
  close: () => void
}

function seed(): Seeded {
  const mem = openMemoryStore(join(dir, 'memory.db'))
  const kb = openKnowledgeStore(join(dir, 'knowledge.db'))
  const facts = new FactsDao(mem.db)
  const entities = new EntitiesDao(mem.db)
  const chunks = new ChunksDao(kb.db)

  const insFact = mem.db.prepare(
    'INSERT INTO facts (content, category, settle_clock, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  )
  const insEntity = mem.db.prepare('INSERT OR IGNORE INTO entities (name, entity_type, extraction_method) VALUES (?,?,?)')
  const entityId = mem.db.prepare<{ entity_id: number }>('SELECT entity_id FROM entities WHERE name = ?')
  const link = mem.db.prepare('INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?,?)')

  const insDoc = kb.db.prepare("INSERT INTO documents (domain, source, title) VALUES ('d', 's', 't')")
  const docId = Number(insDoc.run().lastInsertRowid)
  const insChunk = kb.db.prepare(
    'INSERT INTO doc_chunks (doc_id, idx, text, headings_path, source_ref, char_start, char_end) VALUES (?,?,?,?,?,?,?)',
  )
  const insChunkEntity = kb.db.prepare('INSERT OR IGNORE INTO chunk_entities (chunk_id, name) VALUES (?,?)')

  PROFILES.forEach((profile, i) => {
    // The body is the entity list itself, so the same corpus exercises the LIKE fallback: row 1
    // carries only `alpha`, the rest carry both query terms.
    const text = profile.join(' ')
    const id = Number(insFact.run(text, 'general', 0, 'active', 't', 't').lastInsertRowid)
    for (const name of profile) {
      insEntity.run(name, 'n', 'x')
      link.run(id, (entityId.get(name) as { entity_id: number }).entity_id)
    }
    const cid = Number(insChunk.run(docId, i, text, '', 'd:s', 0, 1).lastInsertRowid)
    for (const name of profile) insChunkEntity.run(cid, name)
  })

  return {
    memDb: mem.db,
    kbDb: kb.db,
    facts,
    entities,
    chunks,
    close: () => {
      mem.db.close()
      kb.db.close()
    },
  }
}

describe('both aggregates share the entity-candidate contract', () => {
  it('returns the SAME ratio order on equivalent seeded data (not the shared-count order)', () => {
    const s = seed()
    try {
      const mem = s.entities.candidateFactsForAnyEntity(['alpha', 'beta'], undefined, 100, 2, 3)
      const kb = s.chunks.candidatesByEntityNames(['alpha', 'beta'], undefined, undefined, 100, 2, 3)
      expect(mem).toEqual([2, 3, 1, 4])
      expect(kb).toEqual([2, 3, 1, 4])
    } finally {
      s.close()
    }
  })

  it('the cap drops from the same end in both aggregates', () => {
    const s = seed()
    try {
      expect(s.entities.candidateFactsForAnyEntity(['alpha', 'beta'], undefined, 2, 2, 3)).toEqual([2, 3])
      expect(s.chunks.candidatesByEntityNames(['alpha', 'beta'], undefined, undefined, 2, 2, 3)).toEqual([2, 3])
    } finally {
      s.close()
    }
  })
})

describe('both aggregates share document frequency', () => {
  it('agree on the per-name carrier count and omit absent names', () => {
    const s = seed()
    try {
      const names = ['alpha', 'beta', 'noise1', 'absent']
      const mem = s.entities.activeDocFrequency(names)
      const kb = s.chunks.docFrequency(names)
      expect(mem).toEqual(new Map([['alpha', 4], ['beta', 3], ['noise1', 2]]))
      expect([...kb.entries()].sort()).toEqual([...mem.entries()].sort())
    } finally {
      s.close()
    }
  })
})

describe('both aggregates share the entities_version UPDATE', () => {
  it('stamps exactly the named rows (memory reports changes, knowledge returns void)', () => {
    const s = seed()
    try {
      expect(s.facts.setEntitiesVersion([1, 3], 9)).toBe(2)
      expect(
        s.memDb.prepare<{ fact_id: number; entities_version: number }>(
          'SELECT fact_id, entities_version FROM facts ORDER BY fact_id',
        ).all(),
      ).toEqual([
        { fact_id: 1, entities_version: 9 },
        { fact_id: 2, entities_version: 0 },
        { fact_id: 3, entities_version: 9 },
        { fact_id: 4, entities_version: 0 },
      ])

      s.chunks.setEntitiesVersion([2, 4], 9)
      expect(
        s.kbDb.prepare<{ chunk_id: number; entities_version: number }>(
          'SELECT chunk_id, entities_version FROM doc_chunks ORDER BY chunk_id',
        ).all(),
      ).toEqual([
        { chunk_id: 1, entities_version: null },
        { chunk_id: 2, entities_version: 9 },
        { chunk_id: 3, entities_version: null },
        { chunk_id: 4, entities_version: 9 },
      ])
      // The batched UPDATE still crosses the batch boundary correctly on a large id list.
      expect(s.facts.setEntitiesVersion([1, 2, 3, 4], 11)).toBe(4)
    } finally {
      s.close()
    }
  })
})

describe('both aggregates share the LIKE fallback', () => {
  it('rank by contained-term count, ties on ascending id', () => {
    const s = seed()
    try {
      expect(s.facts.ftsSubstringSearch(['alpha', 'beta'])).toEqual([
        { id: 2, rank: 2 }, { id: 3, rank: 2 }, { id: 4, rank: 2 }, { id: 1, rank: 1 },
      ])
      expect(s.chunks.ftsSubstringSearch(['alpha', 'beta'])).toEqual([
        { id: 2, rank: 2 }, { id: 3, rank: 2 }, { id: 4, rank: 2 }, { id: 1, rank: 1 },
      ])
    } finally {
      s.close()
    }
  })
})

// ─── entityBags: the shared batched read (§4.6.3), against the pre-extraction bodies ────────────

/** `EntitiesDao.bagsForFacts` BEFORE the extraction (verbatim body). */
function refBagsForFacts(db: Db, ids: readonly number[]): Map<number, string[]> {
  const out = new Map<number, string[]>()
  if (!ids.length) return out
  for (const id of ids) out.set(id, [])
  for (const batch of batches(ids)) {
    const { placeholders, values } = inList(batch)
    const rows = db
      .prepare<{ fact_id: number; name: string }>(
        `SELECT fe.fact_id AS fact_id, e.name AS name FROM fact_entities fe
         JOIN entities e ON e.entity_id = fe.entity_id
         WHERE fe.fact_id IN (${placeholders})`,
      )
      .all(...values)
    for (const row of rows) out.get(row.fact_id)?.push(row.name)
  }
  return out
}

/** `ChunksDao.entityBags` BEFORE the extraction (verbatim body). */
function refChunkEntityBags(db: Db, ids: readonly number[]): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const batch of batches(ids)) {
    const { placeholders, values } = inList(batch)
    const rows = db
      .prepare<{ chunk_id: number; name: string }>(`SELECT chunk_id, name FROM chunk_entities WHERE chunk_id IN (${placeholders})`)
      .all(...values)
    for (const r of rows) {
      const list = out.get(r.chunk_id)
      if (list) list.push(r.name)
      else out.set(r.chunk_id, [r.name])
    }
  }
  return out
}

/** `Map` does not survive `JSON.stringify`: flatten to an ordered entry array. */
const snapBags = (bags: Map<number, string[]>): string => JSON.stringify([...bags.entries()])

const MEM_QUERY = {
  table: 'fact_entities fe',
  keyColumn: 'fe.fact_id',
  nameColumn: 'e.name',
  joinEntities: 'JOIN entities e ON e.entity_id = fe.entity_id',
  seedEmpty: true,
} as const

const KB_QUERY = {
  table: 'chunk_entities',
  keyColumn: 'chunk_id',
  nameColumn: 'name',
  seedEmpty: false,
} as const

describe('entityBags (shared batched entity-name read)', () => {
  it('memory: seeds EVERY requested id to [] in request order, then appends names — same as before', () => {
    const s = seed()
    try {
      const ids = [4, 99, 2, 1]
      const actual = entityBags(s.memDb, ids, MEM_QUERY)
      expect(snapBags(actual)).toBe(snapBags(refBagsForFacts(s.memDb, ids)))
      expect(snapBags(s.entities.bagsForFacts(ids))).toBe(snapBags(actual))
      // Default semantics, asserted directly: every id is present, absent rows are `[]`.
      expect([...actual.keys()]).toEqual([4, 99, 2, 1])
      expect(actual.get(99)).toEqual([])
      expect(actual.get(4)).toEqual(PROFILES[3])
      expect(s.entities.bagsForFacts([]).size).toBe(0)
    } finally {
      s.close()
    }
  })

  it('knowledge: only rows that carry entities appear (no seed) — same as before', () => {
    const s = seed()
    try {
      const ids = [4, 99, 2, 1]
      const actual = entityBags(s.kbDb, ids, KB_QUERY)
      expect(snapBags(actual)).toBe(snapBags(refChunkEntityBags(s.kbDb, ids)))
      expect(snapBags(s.chunks.entityBags(ids))).toBe(snapBags(actual))
      // Default semantics, asserted directly: the absent id is NOT seeded.
      expect(actual.has(99)).toBe(false)
      expect(actual.get(2)).toEqual(PROFILES[1])
      expect(s.chunks.entityBags([]).size).toBe(0)
    } finally {
      s.close()
    }
  })

  it('splits at the batch size for both SQL shapes, keeping the prefix stable', () => {
    const ids = names(600).map((_, i) => i + 1)
    const mem = fakeDb([[{ id: ids[0] as number, name: 'a' }], [{ id: ids[500] as number, name: 'b' }]])
    const memBags = entityBags(mem.db, ids, MEM_QUERY)
    expect(mem.calls).toHaveLength(2)
    expect(mem.calls[0]?.params).toHaveLength(512)
    expect(mem.calls[1]?.params).toHaveLength(128) // 88 ids → rung 128
    expect(mem.calls[0]?.sql).toContain('FROM fact_entities fe JOIN entities e ON e.entity_id = fe.entity_id')
    expect(mem.calls[0]?.sql).toContain('SELECT fe.fact_id AS id, e.name AS name')
    // The seed made every requested id a key before any name was appended.
    expect(memBags.size).toBe(600)
    expect(memBags.get(1)).toEqual(['a'])
    expect(memBags.get(501)).toEqual(['b'])
    expect(memBags.get(600)).toEqual([])

    const kb = fakeDb()
    expect(entityBags(kb.db, ids, KB_QUERY).size).toBe(0)
    expect(kb.calls).toHaveLength(2)
    expect(kb.calls[0]?.sql).toContain('FROM chunk_entities')
    expect(kb.calls[0]?.sql).toContain('SELECT chunk_id AS id, name AS name')
  })
})
