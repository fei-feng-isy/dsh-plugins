/**
 * Store open/upgrade lifecycle shared by the memory and knowledge databases.
 *
 * Both stores need the same four things (open the file, the standard PRAGMA set, the
 * versioned schema, a clean failure), and both used to spell them out separately. A store
 * now only declares its {@link StoreSchema}, and this module runs it.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Db } from './port.js'
import { openSqlite } from './sqlite.js'
import { migrate, type Migration, type MigrationResult } from './migrations.js'
import type { FtsTokenizer } from './tokenizer.js'

/** The PRAGMA set every avantf store opens with (shared by memory + knowledge DBs). */
function applyPragmas(db: Db): void {
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
}

/** One store's schema: only the migration steps and a label for diagnostics. */
export interface StoreSchema {
  readonly describe: string
  readonly migrations: readonly Migration[]
}

export interface OpenedStore {
  readonly db: Db
  /** Which steps ran on THIS open (`from`/`to` make a stale store obvious in a log line). */
  readonly migration: MigrationResult
}

/**
 * One read-only diagnostic for the startup log, built entirely from the open's already-returned
 * result — it must never touch the database, block, or throw.
 *
 * It is defined for both states (`schema up to date (9)` and `schema upgraded 8 → 9 (applied: 9
 * contradiction-resolved-indexes)`), but callers are expected to EMIT only the upgraded form: an
 * up-to-date store is the normal case and does not deserve a line on every boot. The helper exists
 * so that state is still assertable and so both stores phrase it identically.
 */
export function describeMigrationOutcome(schema: StoreSchema, migration: MigrationResult): string {
  if (migration.applied.length === 0) return `schema up to date (${String(migration.to)})`
  const steps = migration.applied
    .map((version) => {
      const step = schema.migrations.find((m) => m.version === version)
      return step === undefined ? String(version) : `${String(version)} ${step.name}`
    })
    .join(', ')
  return `schema upgraded ${String(migration.from)} → ${String(migration.to)} (applied: ${steps})`
}

/** Whether this open actually applied anything (`false` = the store was already current). */
export function wasUpgraded(migration: MigrationResult): boolean {
  return migration.applied.length > 0
}

/**
 * Open (or create) a store database: directory, PRAGMAs, then every migration newer than
 * the file's `user_version`. A failure closes the handle — an open handle keeps the WAL and
 * its locks alive, and a half-open store would be worse than none.
 */
export function openStoreDb(opts: { path: string; schema: StoreSchema; tokenizer: FtsTokenizer }): OpenedStore {
  mkdirSync(dirname(opts.path), { recursive: true })
  const db = openSqlite(opts.path)
  try {
    applyPragmas(db)
    const migration = migrate(db, opts.schema.migrations, { tokenizer: opts.tokenizer })
    return { db, migration }
  } catch (error) {
    db.close()
    throw error
  }
}
