/**
 * The ONLY module that imports the concrete SQLite binding (`better-sqlite3`).
 *
 * Everything else talks to the {@link Db} port, so replacing the binding (the npm package,
 * `node:sqlite`, a bundled build with a different FTS5) is an edit here — not a sweep
 * through the stores. The SQL itself stays SQLite's: see `port.ts`.
 */
import Database from 'better-sqlite3'
import type { Db, DbRunResult, DbStatement, DbTransaction } from './port.js'

type RawStatement = Database.Statement<unknown[], unknown>

class SqliteStatement<Row> implements DbStatement<Row> {
  constructor(private readonly stmt: RawStatement) {}

  all(...params: unknown[]): Row[] {
    return this.stmt.all(...params) as Row[]
  }

  get(...params: unknown[]): Row | undefined {
    return this.stmt.get(...params) as Row | undefined
  }

  run(...params: unknown[]): DbRunResult {
    const result = this.stmt.run(...params)
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid }
  }
}

/** Upper bound on the prepared-statement cache (see `SqliteDb.prepare`). */
const MAX_CACHED_STATEMENTS = 2000

class SqliteDb implements Db {
  /**
   * Prepared-statement cache, keyed by SQL text.
   *
   * better-sqlite3 has NO statement cache of its own: every `prepare()` builds a `Statement` and
   * runs `sqlite3_prepare_v3` (measured 6–8 µs against 0.4 µs for a reused statement). The DAOs
   * prepare at every call — one search is ~20 statements, one write 15–22 — so the compile cost
   * was a real, per-call tax (~65–95 µs per write, plus the same again per search).
   *
   * One cache here covers every DAO without touching them, and the key space is bounded by the
   * SQL TEXT the code contains (~40 `.prepare(` sites, plus the handful of distinct `IN (...)`
   * widths `batches()` produces). Statements are reusable and re-entrant for `all`/`get`/`run`
   * (this port exposes no cursor API), and invalidated wholesale on `close()`.
   */
  private readonly statements = new Map<string, SqliteStatement<unknown>>()

  constructor(private readonly db: Database.Database) {}

  prepare<Row = unknown>(sql: string): DbStatement<Row> {
    let cached = this.statements.get(sql)
    if (cached === undefined) {
      // The key space is NOT just the ~40 literal statements: `batches()` emits a different
      // `IN (?, …)` text per arity, and the arity follows the DATA (measured: 20 adds opened 17
      // keys, 15 of them one statement at different widths). A resident process would therefore
      // grow this map indefinitely, so it gets the same treatment as every other cache here.
      if (this.statements.size >= MAX_CACHED_STATEMENTS) this.statements.clear()
      cached = new SqliteStatement<unknown>(this.db.prepare(sql) as RawStatement)
      this.statements.set(sql, cached)
    }
    return cached as SqliteStatement<Row>
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  transaction<T>(fn: () => T): DbTransaction<T> {
    return this.db.transaction(fn) as unknown as DbTransaction<T>
  }

  pragma(source: string): unknown {
    return this.db.pragma(source)
  }

  close(): void {
    // The statements belong to this handle; the cache must not outlive it.
    this.statements.clear()
    this.db.close()
  }
}

/** Open (or create) a SQLite database behind the port. `':memory:'` is a valid path. */
export function openSqlite(path: string): Db {
  return new SqliteDb(new Database(path))
}
