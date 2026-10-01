/**
 * The SQLite adapter — the runtime's OWN `node:sqlite`, and the only database implementation this
 * engine has.
 *
 * WHY THE BUILTIN AND NOT A BINDING: `better-sqlite3` is a NAN addon, so its `.node` file is tied to
 * ONE `NODE_MODULE_VERSION`. A dsh host that runs plugin code inside Electron (DSH Desktop does: the
 * profile host is `DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE=1`, i.e. NODE_MODULE_VERSION 149
 * on Electron 44) cannot load a binding built for plain Node, and the upstream prebuilds stop well
 * short of that ABI — `new Database(path)` throws "Could not locate the bindings file", and the whole
 * memory store used to be unavailable there. The builtin is already inside the runtime that runs the
 * plugin (unflagged from Node 22.13 / 23.4; Electron 44 carries it), FTS5 included, so ONE
 * implementation serves every host instead of two code paths whose behaviour must be proven equal.
 * The parity this file owes the engine is therefore written down as a CONTRACT, not as a comparison:
 *
 *  - statements are cached per SQL text (compiling one costs ~19x a reuse on this driver: measured
 *    6.03 µs vs 0.31 µs per `SELECT` in a 20k-iteration loop) — the DAOs prepare on every call;
 *  - `run/get/all` take positional parameters OR one object of named parameters, with or without the
 *    `:`/`@`/`$` prefix, and a named parameter the statement does not use is IGNORED (see
 *    {@link NodeSqliteStatement}: the DAOs hand one params object to statements that use subsets of
 *    it, and `FactsDao.purgeArchived` is the call site that made this load-bearing);
 *  - BLOBs are returned as `Buffer` (the builtin hands back a plain `Uint8Array`) — the DAOs and
 *    `hrr/encode.ts` read vector blobs through `buf.buffer`/`byteOffset`, and `Buffer.isBuffer`
 *    checks exist in callers, so the adapter normalizes rather than teaching every reader two shapes;
 *  - `pragma()` returns the pragma's rows (`[]` for a write), `transaction()` is `BEGIN
 *    DEFERRED/IMMEDIATE/EXCLUSIVE` with `SAVEPOINT` nesting and rollback-on-throw — the presence
 *    clock and the lifecycle tick depend on `immediate()` taking the write lock up front.
 *
 * The module is loaded through `createRequire`, never a static `import`: `node:sqlite` does not exist
 * before Node 22.5, and a static import would make THIS FILE unloadable there, failing the plugin's
 * loader row instead of degrading. A missing builtin has to be a PROBE failure (the runtime then
 * mounts DEGRADED and every tool answers with the reason), never a module-load failure.
 * @module @avantf/mem/db/sqlite
 */
import { createRequire } from 'node:module'
import type { Db, DbRunResult, DbStatement, DbTransaction } from './port.js'

/**
 * The slice of the `node:sqlite` builtin this port uses, declared structurally.
 *
 * Not imported from `@types/node`: the module lives behind its own release line (its typings appeared
 * part-way through the Node 22 line) and the engine must type-check against whatever `@types/node` a
 * consumer's build resolves. Declaring the four signatures the port actually calls keeps that
 * independent.
 */
interface RawNodeStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  /**
   * Present from Node v22.15 / v23.11 (see {@link sqliteProbe}, which refuses a runtime without it).
   * Optional in the type so this file still compiles against an older `@types/node`.
   */
  setAllowUnknownNamedParameters?(enabled: boolean): void
}

interface NodeSqliteDatabase {
  prepare(sql: string): RawNodeStatement
  exec(sql: string): void
  close(): void
}

/**
 * The builtin's module shape, as far as this adapter is concerned.
 *
 * Exported for {@link probeModule}'s callers — the contract spec hands it a fake.
 */
export interface NodeSqliteModule {
  DatabaseSync: new (path: string) => NodeSqliteDatabase
}

/** Upper bound on the prepared-statement cache — see {@link NodeSqliteDb.prepare} for its key space. */
const MAX_CACHED_STATEMENTS = 2000

/** One line of an error, for a probe's report: the callers log it, they never rethrow the object. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const first = text.split('\n')[0] ?? text
  return first.length > 300 ? `${first.slice(0, 297)}…` : first
}

/**
 * Load the builtin synchronously, or explain why this runtime cannot.
 *
 * `createRequire` (not `import`) because the port is synchronous by design: the stores open inside a
 * synchronous `buildRuntime`. The specifier is passed to the resolved `require` rather than written
 * as a `require(...)` literal, so a bundler leaves it as a runtime call instead of trying to resolve
 * (or inline) a builtin that may not exist on the target.
 */
function loadNodeSqlite(): { module?: NodeSqliteModule; reason?: string } {
  try {
    const require_ = createRequire(import.meta.url)
    const loaded = (require_ as (specifier: string) => unknown)('node:sqlite')
    if (loaded === null || typeof loaded !== 'object' || typeof (loaded as NodeSqliteModule).DatabaseSync !== 'function') {
      return { reason: 'the runtime exposes no node:sqlite DatabaseSync' }
    }
    return { module: loaded as NodeSqliteModule }
  } catch (error) {
    return {
      reason: `node:sqlite is unavailable (${messageOf(error)}) — it needs Node >= 22.5, and `
        + 'is unflagged from Node 22.13 / 23.4',
    }
  }
}

/**
 * Whether this runtime can actually SERVE the stores through `node:sqlite`, or why it cannot.
 *
 * Constructing a throwaway `:memory:` handle is only the first half. A runtime can expose the module
 * and still be unusable for this engine in two ways that would otherwise surface much later, as a DDL
 * error or as a broken lifecycle tick in production:
 *
 *  - **no FTS5** — both schemas create `fts5` virtual tables the moment a store is opened, so a build
 *    without the module cannot hold a store at all;
 *  - **no `setAllowUnknownNamedParameters`** (Node v22.15 / v23.11) — `node:sqlite` throws on a named
 *    parameter the statement does not use, while the DAOs deliberately pass one params object to
 *    statements that use subsets of it. Without the switch, `FactsDao.purgeArchived` takes the whole
 *    lifecycle tick down.
 *
 * The probe reports the FIRST of these that applies as one line; `undefined` means "this runtime can
 * serve a store". It is NOT a dry run of the caller's database: a file that is corrupt, locked or
 * written by a newer schema must still fail loudly in {@link openSqlite} (and mount DEGRADED with its
 * own reason) rather than being reported as a driver problem.
 */
export function sqliteProbe(): string | undefined {
  const loaded = loadNodeSqlite()
  if (loaded.module === undefined) return loaded.reason
  return probeModule(loaded.module)
}

/**
 * The capability half of {@link sqliteProbe}: what a loaded `node:sqlite` module must be able to do.
 *
 * Exported — and taking the module as an argument — so the contract spec can hand it a FAKE and
 * assert each refusal by name. That is not a driver seam: it is the only way to exercise "this
 * runtime's builtin cannot serve a store" on a machine whose builtin can, and the failure path is
 * exactly the one nobody sees until it happens on a user's host.
 */
export function probeModule(module: NodeSqliteModule): string | undefined {
  let probe: NodeSqliteDatabase | undefined
  try {
    probe = new module.DatabaseSync(':memory:')
    probe.exec('CREATE VIRTUAL TABLE probe_fts USING fts5(body)')
    const statement = probe.prepare('SELECT :value AS value')
    if (typeof statement.setAllowUnknownNamedParameters !== 'function') {
      return 'node:sqlite has no setAllowUnknownNamedParameters (needs Node >= 22.15 / >= 23.11)'
    }
    statement.setAllowUnknownNamedParameters(true)
    statement.get({ value: 1, unused: 2 })
    return undefined
  } catch (error) {
    return `node:sqlite cannot serve a store (${messageOf(error)})`
  } finally {
    probe?.close()
  }
}

/**
 * This process's verdict on the builtin, decided on first use and then fixed.
 *
 * Memoized because it is a property of the RUNTIME, not of a database: re-probing at every store open
 * would spend an in-memory database per open (memory, knowledge, and the tokenizer self-check) to
 * re-learn something that cannot change. The first open pays for it; every later open reuses the
 * answer — including a refusal, which keeps failing with the same reason.
 */
let serveVerdict: string | undefined
let served = false

function serveReason(): string | undefined {
  if (!served) {
    served = true
    serveVerdict = sqliteProbe()
  }
  return serveVerdict
}

/**
 * A one-line, NEVER-THROWING description for the startup log.
 *
 * The runtime logs this before it opens the stores, so it must not be the thing that turns "this
 * runtime cannot serve the builtin" into a crash before the caller's own error handling runs. The
 * version is part of the line on purpose: the store files stay per-host (a Desktop HOME and a WSL
 * HOME are different machines' worth of data), so the SQLite version is the one fact that tells an
 * operator WHICH build is answering — and the fact to quote when a query behaves differently across
 * two hosts. A refused runtime is reported as such, so this line and the later DEGRADED mount agree.
 */
export function describeSqlite(): string {
  const refused = serveReason()
  if (refused !== undefined) return `unavailable: ${refused}`
  const loaded = loadNodeSqlite()
  if (loaded.module === undefined) return `unavailable: ${loaded.reason}`
  try {
    const db = new loaded.module.DatabaseSync(':memory:')
    try {
      const row = db.prepare('SELECT sqlite_version() AS version').get() as { version?: unknown } | undefined
      return `node:sqlite ${String(row?.version ?? 'unknown')}`
    } finally {
      db.close()
    }
  } catch (error) {
    return `unavailable: ${messageOf(error)}`
  }
}

/**
 * One row as the port promises it: a BLOB is a `Buffer`.
 *
 * The copy is a VIEW over the same bytes (`Buffer.from(arrayBuffer, offset, length)`), so it costs no
 * data movement; the row object is only rebuilt when it actually carries a `Uint8Array`.
 */
function normalizeRow<Row>(row: unknown): Row {
  if (row === null || typeof row !== 'object') return row as Row
  const source = row as Record<string, unknown>
  let mapped: Record<string, unknown> | undefined
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
      mapped ??= { ...source }
      mapped[key] = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    }
  }
  return (mapped ?? source) as Row
}

class NodeSqliteStatement<Row> implements DbStatement<Row> {
  constructor(private readonly stmt: RawNodeStatement) {
    // The port's rule: a named parameter the statement does not use is IGNORED. `node:sqlite` throws
    // "Unknown named parameter" by default, and the DAOs legitimately hand ONE params object to
    // statements that use different subsets of it (`FactsDao.purgeArchived` passes `purgeModifier` to
    // a statement without that placeholder). The tolerance belongs HERE, once, rather than in every
    // DAO, which is also why {@link sqliteProbe} refuses a runtime where it is missing.
    this.stmt.setAllowUnknownNamedParameters?.(true)
  }

  all(...params: unknown[]): Row[] {
    return (this.stmt.all(...params) as unknown[]).map((row) => normalizeRow<Row>(row))
  }

  get(...params: unknown[]): Row | undefined {
    const row = this.stmt.get(...params)
    return row === undefined ? undefined : normalizeRow<Row>(row)
  }

  run(...params: unknown[]): DbRunResult {
    const result = this.stmt.run(...params)
    // `changes` is `number` on the port; the driver can hand back a BigInt (and values past 2^53 are
    // not a case this engine has: every write is one row).
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }
  }
}

class NodeSqliteDb implements Db {
  /**
   * Prepared-statement cache, keyed by SQL text. See the module doc for the measured cost of not
   * caching. The key space is NOT just the ~40 literal statements: `batches()` emits a different
   * `IN (?, …)` text per arity, and the arity follows the DATA (measured: 20 adds opened 17 keys, 15
   * of them one statement at different widths), so a resident process would otherwise grow this map
   * indefinitely — hence the same bound, and the same wholesale clear, as everywhere else here.
   */
  private readonly statements = new Map<string, NodeSqliteStatement<unknown>>()

  /** Nesting depth, so a transaction inside a transaction becomes a SAVEPOINT. */
  private depth = 0

  constructor(private readonly db: NodeSqliteDatabase) {}

  prepare<Row = unknown>(sql: string): DbStatement<Row> {
    let cached = this.statements.get(sql)
    if (cached === undefined) {
      if (this.statements.size >= MAX_CACHED_STATEMENTS) this.statements.clear()
      cached = new NodeSqliteStatement<unknown>(this.db.prepare(sql))
      this.statements.set(sql, cached)
    }
    return cached as NodeSqliteStatement<Row>
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  /**
   * `PRAGMA` through a prepared statement: `node:sqlite` has no `pragma()` of its own, and preparing
   * the statement is what returns the rows a reader (`user_version`, `journal_mode`) asks for — a
   * write pragma simply returns `[]`.
   */
  pragma(source: string): unknown {
    return (this.db.prepare(`PRAGMA ${source}`).all() as unknown[]).map((row) => normalizeRow<Record<string, unknown>>(row))
  }

  transaction<T>(fn: () => T): DbTransaction<T> {
    const runner = (mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') => (): T => this.atomic(fn, mode)
    const tx = runner('DEFERRED') as DbTransaction<T>
    tx.immediate = runner('IMMEDIATE')
    tx.deferred = runner('DEFERRED')
    tx.exclusive = runner('EXCLUSIVE')
    return tx
  }

  close(): void {
    // The statements belong to this handle; the cache must not outlive it.
    this.statements.clear()
    this.db.close()
  }

  private atomic<T>(fn: () => T, mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE'): T {
    if (this.depth > 0) {
      const savepoint = `avantf_nested_${String(this.depth)}`
      this.depth += 1
      this.db.exec(`SAVEPOINT ${savepoint}`)
      try {
        const value = fn()
        this.db.exec(`RELEASE ${savepoint}`)
        return value
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${savepoint}`)
        this.db.exec(`RELEASE ${savepoint}`)
        throw error
      } finally {
        this.depth -= 1
      }
    }
    this.depth = 1
    this.db.exec(`BEGIN ${mode}`)
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      // A rollback that itself fails (a killed transaction) must not replace the caller's error.
      try {
        this.db.exec('ROLLBACK')
      } catch { /* already rolled back by SQLite */ }
      throw error
    } finally {
      this.depth = 0
    }
  }
}

/**
 * Open (or create) a SQLite database behind the port. `':memory:'` is a valid path.
 *
 * The runtime's verdict is checked HERE, not only by the startup log: a runtime whose builtin cannot
 * serve a store (no FTS5, or no tolerance for unused named parameters — see {@link sqliteProbe}) must
 * fail this open, so the caller's own error handling degrades the plugin with that reason instead of
 * the engine discovering it half-way through a schema migration or a lifecycle tick.
 *
 * `verdict` is a TEST seam, and deliberately not a driver seam: there is one implementation and it
 * cannot be replaced at runtime. It exists so the refusal path can be asserted on a machine whose
 * builtin missions — the path nobody sees until a user hits it.
 */
export function openSqlite(path: string, verdict: () => string | undefined = serveReason): Db {
  const refused = verdict()
  if (refused !== undefined) throw new Error(refused)
  const loaded = loadNodeSqlite()
  if (loaded.module === undefined) throw new Error(loaded.reason)
  return new NodeSqliteDb(new loaded.module.DatabaseSync(path))
}
