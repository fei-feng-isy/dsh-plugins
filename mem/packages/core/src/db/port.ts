/**
 * The relational access port — the ONE place the engine is allowed to say "a database".
 *
 * Stores, lifecycle code and DAOs depend on this interface, never on a driver class, so the
 * binding is an adapter (see `sqlite.ts`) rather than something smeared through 50 call
 * sites. This is deliberately NOT a query builder or an ORM: the SQL stays SQL (FTS5,
 * `INDEXED BY`, partial indexes and `julianday` are load-bearing — see DESIGN §19), and the
 * port only fixes the *shape* of the conversation.
 *
 * The surface is five methods on purpose: `prepare / exec / transaction / pragma / close` is
 * the entire driver API this project uses (104 `prepare`, 11 `exec`, 9 `transaction`, 6
 * `pragma`, 4 `close` call sites, and none of the statement extras such as
 * `pluck`/`raw`/`iterate`/`columns`/`function`/`loadExtension`).
 *
 * SYNCHRONOUS by design: `persistFact` runs contradiction detection inside its transaction
 * and the lifecycle tick is one synchronous pass, so an async driver does not fit this port.
 * That is a decision, not an oversight.
 */
export interface DbRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

/**
 * A prepared statement. Rows are asserted by the caller.
 *
 * Params are either positional (`?`, one argument each — `run(a, b)`) or a single object
 * binding the statement's named parameters (`:step`, `@step` and `$step` all match the key
 * `step`, with or without the prefix). Both forms are forwarded to the driver untouched, so a
 * DAO can keep a long predicate readable instead of counting `?` positions — `facts.ts` uses
 * the named form for the settlement clock and the trust diagnostics.
 */
export interface DbStatement<Row = unknown> {
  all(...params: unknown[]): Row[]
  get(...params: unknown[]): Row | undefined
  run(...params: unknown[]): DbRunResult
}

/**
 * A transaction runner: call it to execute inside a transaction, or pick a lock mode.
 *
 * `immediate()` is load-bearing, not a convenience: the presence clock and the lifecycle
 * tick do a cross-process read-modify-write, and only `BEGIN IMMEDIATE` takes the write lock
 * before the first read. A port without it would have silently degraded those paths.
 */
export interface DbTransaction<T> {
  (): T
  immediate(): T
  deferred(): T
  exclusive(): T
}

export interface Db {
  prepare<Row = unknown>(sql: string): DbStatement<Row>
  exec(sql: string): void
  transaction<T>(fn: () => T): DbTransaction<T>
  pragma(source: string): unknown
  close(): void
}
