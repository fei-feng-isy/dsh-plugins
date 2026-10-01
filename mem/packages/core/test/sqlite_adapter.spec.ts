/**
 * The contract of the ONE SQLite adapter (`src/db/sqlite.ts`), plus the capability probe that decides
 * whether a runtime can carry the stores at all.
 *
 * There is no second driver to compare against any more: the engine runs on the runtime's own
 * `node:sqlite` everywhere, so what used to be an equivalence test between two drivers is now a
 * written-down CONTRACT the adapter owes everything above the port. Each clause is a behaviour some
 * caller depends on, not a driver quirk:
 *
 *  - positional AND bare-key named binding (the long predicates in `facts.ts`);
 *  - a named parameter the statement does not use being IGNORED (`FactsDao.purgeArchived` passes one
 *    params object to statements that use subsets of it);
 *  - BLOBs as `Buffer`, subarray writes included (`hrr/encode.ts`, `db/vectors.ts`);
 *  - `pragma()` reads and writes, transactions with `immediate()`, and SAVEPOINT nesting (the presence
 *    clock and the lifecycle tick);
 *  - a statement cache keyed by SQL text (measured on this driver: 6.03 µs to compile vs 0.31 µs to
 *    reuse, ~19x).
 *
 * The capability half is exercised with FAKE modules, because the refusals are the code nobody sees
 * until a user's host hits them — and "no usable SQLite" must be a probe reason (the runtime then
 * mounts DEGRADED and says why), never a module-load failure or a DDL error much later.
 */
import { describe, it, expect } from 'vitest'
import { describeSqlite, openSqlite, probeModule, sqliteProbe, type NodeSqliteModule } from '../src/db/sqlite.js'
import { buildFtsQuery, resolveFtsTokenizer } from '../src/db/tokenizer.js'
import type { Db } from '../src/db/port.js'

/** One in-memory database with a four-column table, closed by the caller's `finally`. */
function withDb<T>(fn: (db: Db) => T): T {
  const db = openSqlite(':memory:')
  try {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, n INTEGER, bytes BLOB)')
    return fn(db)
  } finally {
    db.close()
  }
}

describe('the Db contract', () => {
  it('runs a multi-statement exec and binds positional parameters', () => {
    withDb((db) => {
      db.exec("INSERT INTO t (label, n) VALUES ('seed', 0); INSERT INTO t (label, n) VALUES ('second', 0)")
      const result = db.prepare("INSERT INTO t (label, n) VALUES (?, ?)").run('third', 3)
      expect(result.changes).toBe(1)
      expect(Number(result.lastInsertRowid)).toBe(3)
      expect(db.prepare<{ label: string }>('SELECT label FROM t WHERE id = ?').get(3)).toEqual({ label: 'third' })
      expect(db.prepare('SELECT label FROM t WHERE id = ?').get(99)).toBeUndefined()
      expect(db.prepare<{ label: string }>('SELECT label FROM t ORDER BY id').all().map((row) => row.label))
        .toEqual(['seed', 'second', 'third'])
    })
  })

  it('binds one bare key to a named parameter written with any SQL prefix', () => {
    withDb((db) => {
      // The port's rule, and the ONLY one the engine may rely on: the KEY is bare (`label`), while the
      // SQL may write `:label`, `@label` or `$label`. A PREFIXED JS key is not part of the contract —
      // it is the form that behaves differently between SQLite wrappers.
      db.prepare('INSERT INTO t (label, n) VALUES (:label, :n)').run({ label: 'colon', n: 1 })
      db.prepare('INSERT INTO t (label, n) VALUES (@label, @n)').run({ label: 'at', n: 2 })
      db.prepare('INSERT INTO t (label, n) VALUES ($label, $n)').run({ label: 'dollar', n: 3 })
      expect(db.prepare<{ label: string }>('SELECT label FROM t ORDER BY n').all().map((row) => row.label))
        .toEqual(['colon', 'at', 'dollar'])
    })
  })

  it('ignores a named parameter the statement does not use', () => {
    withDb((db) => {
      // `node:sqlite` throws "Unknown named parameter" unless the adapter turns that check off, and the
      // DAOs deliberately hand one params object to statements that use different subsets of it.
      expect(() => db.prepare('INSERT INTO t (label, n) VALUES (:label, :n)').run({ label: 'x', n: 1, unused: 9 }))
        .not.toThrow()
      expect(db.prepare<{ label: string }>('SELECT label FROM t').get()).toEqual({ label: 'x' })
    })
  })

  it('reads and writes pragmas, and a written pragma takes effect', () => {
    withDb((db) => {
      const asNumber = (raw: unknown): number => {
        const value = Array.isArray(raw) ? (raw[0] as { user_version?: unknown } | undefined)?.user_version : raw
        return Number(value ?? 0)
      }
      expect(asNumber(db.pragma('user_version'))).toBe(0)
      db.pragma('user_version = 7')
      expect(asNumber(db.pragma('user_version'))).toBe(7)
      // The pragma the stores depend on, observable through its effect rather than its return shape.
      db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
      db.exec('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))')
      db.pragma('foreign_keys = ON')
      expect(() => db.prepare('INSERT INTO child (parent_id) VALUES (?)').run(404)).toThrow(/FOREIGN KEY/u)
      db.prepare('INSERT INTO parent (id) VALUES (?)').run(1)
      db.prepare('INSERT INTO child (parent_id) VALUES (?)').run(1)
    })
  })

  it('commits, rolls back on throw, and nests through savepoints', () => {
    withDb((db) => {
      const insert = (n: number): void => { db.prepare('INSERT INTO t (n) VALUES (?)').run(n) }
      const ns = (): number[] => db.prepare<{ n: number }>('SELECT n FROM t ORDER BY n').all().map((row) => row.n)

      db.transaction(() => { insert(1) }).immediate()
      expect(ns()).toEqual([1])

      expect(() => db.transaction(() => { insert(2); throw new Error('outer') })()).toThrow('outer')
      expect(ns()).toEqual([1])

      // The nested transaction is a SAVEPOINT: its rollback must not take the outer work with it.
      db.transaction(() => {
        insert(3)
        try {
          db.transaction(() => { insert(4); throw new Error('inner') })()
        } catch { /* the outer scope decides what to do with the inner failure */ }
      })()
      expect(ns()).toEqual([1, 3])
    })
  })

  it('returns a BLOB as a Buffer, including from a subarray write', () => {
    withDb((db) => {
      const source = Buffer.from([0, 1, 2, 250, 255])
      db.prepare('INSERT INTO t (bytes) VALUES (?)').run(source)
      db.prepare('INSERT INTO t (bytes) VALUES (?)').run(source.subarray(1, 4))
      const rows = db.prepare<{ id: number; bytes: Buffer }>('SELECT id, bytes FROM t ORDER BY id').all()
      expect(rows.map((row) => Buffer.isBuffer(row.bytes))).toEqual([true, true])
      expect([...rows[0]!.bytes]).toEqual([0, 1, 2, 250, 255])
      expect([...rows[1]!.bytes]).toEqual([1, 2, 250])
    })
  })

  it('serves FTS5 with the tokenizer this build resolved', () => {
    withDb((db) => {
      const tokenizer = resolveFtsTokenizer()
      db.exec(`CREATE VIRTUAL TABLE f USING fts5(content, tokenize='${tokenizer}')`)
      // A space-separated CJK phrase: one whole token for unicode61, a run of 3-grams for trigram —
      // the query builder emits the form the tokenizer needs, and either way this must hit.
      db.prepare('INSERT INTO f (content) VALUES (?)').run('内存回收路径 调优')
      const query = buildFtsQuery('内存回收路径', tokenizer)
      expect(query).not.toBeNull()
      const hit = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM f WHERE f MATCH ?').get(query!)
      expect(hit?.n ?? 0).toBeGreaterThan(0)
    })
  })

  it('caches prepared statements per SQL text', () => {
    // The DAOs prepare on every call, and compiling a statement costs ~19x a reuse on this driver —
    // so identity here is the observable half of the cache documented in the adapter.
    withDb((db) => {
      const sql = 'SELECT n FROM t WHERE id = ?'
      expect(db.prepare(sql)).toBe(db.prepare(sql))
    })
  })

  it('closes the handle', () => {
    const db = openSqlite(':memory:')
    db.exec('CREATE TABLE t (id INTEGER)')
    db.close()
    expect(() => db.prepare('SELECT 1').get()).toThrow()
  })
})

describe('the capability probe', () => {
  /**
   * A `node:sqlite` module that behaves, so each fake below differs from it in exactly one way.
   * `probeModule` takes the module as an argument for precisely this: the refusals cannot be reached
   * on a machine whose builtin missions.
   */
  function fakeModule(options: { throwOnConstruct?: string; throwOnExec?: string; tolerate?: boolean } = {}): NodeSqliteModule {
    class FakeDatabase {
      constructor() {
        if (options.throwOnConstruct !== undefined) throw new Error(options.throwOnConstruct)
      }
      exec(sql: string): void {
        if (options.throwOnExec !== undefined && sql.includes('fts5')) throw new Error(options.throwOnExec)
      }
      prepare(): unknown {
        const statement: Record<string, unknown> = {
          all: () => [],
          get: () => ({ value: 1 }),
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
        }
        if (options.tolerate !== false) statement['setAllowUnknownNamedParameters'] = (): void => undefined
        return statement
      }
      close(): void {}
    }
    return { DatabaseSync: FakeDatabase } as unknown as NodeSqliteModule
  }

  it('accepts a module that opens, carries FTS5 and tolerates unused named parameters', () => {
    expect(probeModule(fakeModule())).toBeUndefined()
  })

  it('refuses a module whose handle cannot even be opened', () => {
    expect(probeModule(fakeModule({ throwOnConstruct: 'cannot open database' })))
      .toMatch(/cannot serve a store \(cannot open database\)/u)
  })

  it('refuses a build without FTS5 — the schemas create fts5 tables at open', () => {
    expect(probeModule(fakeModule({ throwOnExec: 'no such module: fts5' })))
      .toMatch(/cannot serve a store \(no such module: fts5\)/u)
  })

  it('refuses a runtime without setAllowUnknownNamedParameters, naming the Node versions', () => {
    // The gap this closes: `node:sqlite` is unflagged from Node 22.13 / 23.4, but the method only
    // arrived in 22.15 / 23.11 — a host in between would otherwise mount fine and then lose the
    // whole lifecycle tick to "Unknown named parameter".
    expect(probeModule(fakeModule({ tolerate: false })))
      .toMatch(/setAllowUnknownNamedParameters \(needs Node >= 22\.15 \/ >= 23\.11\)/u)
  })

  it('reports this runtime as usable', () => {
    expect(sqliteProbe()).toBeUndefined()
  })

  it('makes a refused runtime fail the OPEN, so the caller degrades with the reason', () => {
    // The verdict is checked before any file is touched: a runtime that cannot serve a store must fail
    // the open (and mount DEGRADED with this text), not fail half-way through a schema migration or a
    // lifecycle tick. The injected verdict is the test seam that makes this reachable here.
    const refused = 'node:sqlite has no setAllowUnknownNamedParameters (needs Node >= 22.15 / >= 23.11)'
    expect(() => openSqlite(':memory:', () => refused)).toThrow(/setAllowUnknownNamedParameters/u)
  })
})

describe('the startup description', () => {
  it('names the builtin and the SQLite version a real handle reports', () => {
    const db = openSqlite(':memory:')
    try {
      const row = db.prepare<{ v: unknown }>('SELECT sqlite_version() AS v').get()
      expect(describeSqlite()).toBe(`node:sqlite ${String(row?.v)}`)
    } finally {
      db.close()
    }
  })
})
