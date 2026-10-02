/**
 * Versioned schema migrations — the "upgrade" half of the store lifecycle.
 *
 * The engine used to apply an idempotent `CREATE TABLE IF NOT EXISTS` blob on every open and
 * call that "no migrations needed, a schema change ships by recreating the file". That
 * stopped being true the first time a change had to fix data in place (the duplicate open
 * contradiction rows that a partial unique index must not choke on), so the schema now has a
 * version and ordered steps.
 *
 * Mechanics, deliberately boring:
 *  - the version lives in SQLite's own `PRAGMA user_version` (no side table needed to order
 *    steps), and every applied step is ALSO recorded in `schema_migrations` for audit;
 *  - each step runs in its own transaction together with its `user_version` bump, so a
 *    failure rolls the step back completely — a database is never "half upgraded";
 *  - step 1 is the base schema and stays idempotent, because databases created before this
 *    mechanism existed report `user_version = 0` while already holding the schema; adopting
 *    them is a no-op that just stamps the version.
 */
import type { Db } from './port.js'
import type { FtsTokenizer } from './tokenizer.js'

/** What a migration may need from its store (the FTS tokenizer is chosen before the DDL). */
interface MigrationContext {
  readonly tokenizer: FtsTokenizer
}

export interface Migration {
  /** 1-based, contiguous, unique — see {@link validateMigrations}. */
  readonly version: number
  readonly name: string
  /** Must be idempotent enough to run against a database from the pre-versioning era. */
  readonly up: (db: Db, ctx: MigrationContext) => void
}

export interface MigrationResult {
  readonly from: number
  readonly to: number
  readonly applied: readonly number[]
}

/**
 * `ALTER TABLE … ADD COLUMN`, skipped when the column is already there.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, and every step must stay runnable against a
 * database from the pre-versioning era (`user_version = 0` with the schema already present),
 * so the check is explicit rather than implied by the version number. New columns should ALSO
 * be added to the base DDL: a fresh database then gets them from step 1 and this becomes a
 * no-op, while an existing one is upgraded here.
 */
export function addColumnIfMissing(db: Db, table: string, column: string, columnDdl: string): void {
  const columns = db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all()
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDdl}`)
}

const AUDIT_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`

/** The schema version stored in the database header (0 = pre-versioning). */
export function readUserVersion(db: Db): number {
  const raw = db.pragma('user_version') as unknown
  if (typeof raw === 'number') return raw
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0] as { user_version?: unknown }
    const value = Number(first?.user_version ?? 0)
    return Number.isFinite(value) ? value : 0
  }
  return 0
}

/**
 * Steps must be 1..N with no gaps: a database at version k then always has a defined path
 * forward, and a mistaken edit (duplicate or skipped number) fails at startup instead of
 * silently leaving a store behind.
 */
export function validateMigrations(migrations: readonly Migration[]): void {
  const versions = migrations.map((m) => m.version).sort((a, b) => a - b)
  versions.forEach((version, index) => {
    if (version !== index + 1) {
      throw new Error(`迁移必须是 1..N、不能有缺口或重复（实际为 ${versions.join(', ')}）`)
    }
  })
}

/**
 * The database was written by a NEWER build than the one opening it.
 *
 * Migrations are one-way (each step's `up` fixes data in place, and there is no `down`), so an
 * older build cannot know what the extra steps did: running it against such a schema is undefined
 * behaviour dressed up as a normal open — it may read columns that moved, or write rows the newer
 * schema constrains differently. Refusing is the only honest answer, and the message has to say
 * what to do, because this is what a plugin downgrade looks like in practice.
 */
export class SchemaDowngradeError extends Error {
  constructor(readonly databaseVersion: number, readonly codeVersion: number) {
    super(
      `database schema is version ${String(databaseVersion)} but this build knows only `
      + `${String(codeVersion)} — it was created by a NEWER version of avantf-mem. `
      + 'Migrations are one-way: upgrade the running version instead of downgrading it, or restore '
      + `a backup of the data home taken before the upgrade.`,
    )
    this.name = 'SchemaDowngradeError'
  }
}

/** Apply every migration newer than the stored version. Returns what ran. */
export function migrate(db: Db, migrations: readonly Migration[], ctx: MigrationContext): MigrationResult {
  validateMigrations(migrations)
  const from = readUserVersion(db)
  // Refuse to open a schema from the future BEFORE touching anything (not even the audit table):
  // a downgrade must leave the file exactly as it found it.
  const newest = migrations.at(-1)?.version ?? 0
  if (from > newest) throw new SchemaDowngradeError(from, newest)
  db.exec(AUDIT_TABLE)
  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version)
  const applied: number[] = []
  for (const migration of pending) {
    // Step + version bump + audit row in ONE transaction: `user_version` lives in the
    // database header and is transactional, so a throw cannot leave a version claiming mission
    // that was rolled back.
    db.transaction(() => {
      migration.up(db, ctx)
      db.prepare('INSERT OR REPLACE INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name)
      db.pragma(`user_version = ${String(migration.version)}`)
    })()
    applied.push(migration.version)
  }
  return { from, to: readUserVersion(db), applied }
}
