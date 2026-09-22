/**
 * The upgrade-parity guard: **a database created by an OLDER build must reach exactly the schema a
 * brand-new database has**, after the numbered migration steps run.
 *
 * This is the guard for a silent failure mode that no other test can see. The base DDL
 * (`DDL` / `KNOWLEDGE_DDL`, migration step 1) is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
 * EXISTS`: on a database that already holds the schema, re-running it is a NO-OP, and step 1 is
 * already marked as applied there, so a column, table or index added to the base DDL without a
 * numbered migration is applied to nothing — new installs get it, existing ones never do, and it
 * surfaces much later as "no such column". Adding an object in BOTH places is the discipline; this
 * test is what enforces it.
 *
 * Why the fixture instead of `migrate(schema.migrations.slice(0, k))`: slicing the LIVE list cannot
 * catch the mutation. Step 1 runs from the same (mutated) `DDL` in both the "old" and the "fresh"
 * fixture, so both end up with the new object and the comparison is green. The "old" database has
 * to be built from a schema the current code does not produce anymore — that is
 * `fixtures/schema_baseline.ts`, which is deliberately frozen and never regenerated to make this
 * file pass. It is the base DDL with every later step's work removed, so each numbered step really
 * runs here (the memory fixture also carries the dead `idx_facts_idle` so step 4's DROP is
 * exercised).
 *
 * Fresh references themselves are covered by `db_lifecycle.spec.ts` (a fresh store runs every step
 * and records them, a re-open applies nothing, a pre-versioning store is adopted); this file adds
 * only the "old version → upgraded schema is item-by-item equal to fresh" cell.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_SCHEMA, openMemoryStore } from '../src/db/conn.js'
import { KNOWLEDGE_SCHEMA, chunksFtsTableDdl, openKnowledgeStore } from '../src/db/knowledge.js'
import { factsFtsTableDdl } from '../src/db/schema.js'
import { migrate, readUserVersion, type Migration } from '../src/db/migrations.js'
import { openSqlite } from '../src/db/sqlite.js'
import { resolveFtsTokenizer } from '../src/db/tokenizer.js'
import type { Db } from '../src/db/port.js'
import type { OpenedStore, StoreSchema } from '../src/db/store.js'
import { KNOWLEDGE_BASELINE_V1, MEMORY_BASELINE_V1, type BaselineSchemaObject } from './fixtures/schema_baseline.js'

const CTX = { tokenizer: resolveFtsTokenizer() }

/**
 * Drop `--` line comments, respecting single-quoted literals, then collapse whitespace. Comments
 * are not part of the schema's meaning, and the frozen fixture is stored without them.
 */
function stripLineComments(sql: string): string {
  let out = ''
  let inQuote = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!
    if (c === "'") {
      inQuote = !inQuote
      out += c
      continue
    }
    if (!inQuote && c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      out += ' '
      continue
    }
    out += c
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Split a `CREATE TABLE` body on top-level commas (parentheses and single quotes respected). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inQuote = false
  let current = ''
  for (const c of body) {
    if (c === "'") inQuote = !inQuote
    if (!inQuote) {
      if (c === '(') depth++
      else if (c === ')') depth--
      else if (c === ',' && depth === 0) {
        parts.push(current)
        current = ''
        continue
      }
    }
    current += c
  }
  if (current.trim() !== '') parts.push(current)
  return parts
}

/**
 * Canonical form of one `sqlite_master.sql`, for equality only.
 *
 * A table's column/constraint definitions are SORTED: `ALTER TABLE … ADD COLUMN` (what every
 * migration uses) always appends, so an upgraded table holds the new column at the end while a
 * fresh one holds it wherever the developer wrote it. Column ORDER is not part of the parity
 * invariant (the scalar projection spec already treats `facts` column order as non-contract), but
 * every definition and every constraint still has to match exactly.
 */
function canonicalSql(sql: string): string {
  const stripped = stripLineComments(sql)
  const open = stripped.indexOf('(')
  if (!stripped.startsWith('CREATE TABLE') || open < 0 || !stripped.endsWith(')')) return stripped
  const body = stripped.slice(open + 1, -1)
  const parts = splitTopLevel(body).map((part) => part.trim()).filter((part) => part !== '')
  return `${stripped.slice(0, open + 1)}${parts.sort().join(', ')})`
}

/**
 * Every user-visible schema object, as `type|name|canonical sql`, sorted.
 *
 * `sqlite_%` is SQLite's own bookkeeping (`sqlite_sequence`, `sqlite_autoindex_*`); `%_fts_%` is an
 * FTS5 virtual table's shadow tables, created implicitly by the virtual table itself. Both differ
 * only in ways SQLite owns, not in ways this repository declares.
 */
function schemaFingerprint(db: Db): string[] {
  return db
    .prepare<{ type: string; name: string; sql: string | null }>(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL"
        + " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
        + " AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\'"
        + ' ORDER BY type, name',
    )
    .all()
    .map((row) => `${row.type}|${row.name}|${canonicalSql(row.sql ?? '')}`)
}

/** Migration step 1 as the frozen baseline created it (plus the live, tokenizer-aware FTS table). */
function baselineStep1(store: StoreUnderGuard): Migration {
  return {
    version: 1,
    name: 'base-schema',
    up: (db, ctx) => {
      // Tables first (foreign keys are declared inline), then the virtual table, then indexes and
      // triggers — the order step 1 itself uses.
      for (const object of store.baseline) if (object.type === 'table') db.exec(object.sql)
      db.exec(store.ftsTableDdl(ctx.tokenizer))
      for (const object of store.baseline) if (object.type !== 'table') db.exec(object.sql)
    },
  }
}

interface StoreUnderGuard {
  readonly label: string
  readonly schema: StoreSchema
  readonly baseline: readonly BaselineSchemaObject[]
  readonly open: (path: string) => OpenedStore
  readonly ftsTableDdl: (tokenizer: string) => string
}

const STORES: readonly StoreUnderGuard[] = [
  { label: 'memory', schema: MEMORY_SCHEMA, baseline: MEMORY_BASELINE_V1, open: openMemoryStore, ftsTableDdl: factsFtsTableDdl },
  { label: 'knowledge', schema: KNOWLEDGE_SCHEMA, baseline: KNOWLEDGE_BASELINE_V1, open: openKnowledgeStore, ftsTableDdl: chunksFtsTableDdl },
]

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avf-parity-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('old database → current schema parity', () => {
  for (const store of STORES) {
    const versions = store.schema.migrations.length

    it(`${store.label}: every starting version upgrades to exactly the fresh schema`, () => {
      const fresh = store.open(join(dir, `${store.label}-fresh.db`))
      let freshSchema: string[]
      try {
        freshSchema = schemaFingerprint(fresh.db)
      } finally {
        fresh.db.close()
      }

      const frozenStep1 = baselineStep1(store)
      for (let k = 1; k < versions; k++) {
        const path = join(dir, `${store.label}-v${k}.db`)
        const seeded = openSqlite(path)
        try {
          // "An old database at version k": the frozen v1 baseline, then only the numbered steps
          // that existed up to k. `migrate` stamps user_version and writes the audit rows.
          migrate(seeded, [frozenStep1, ...store.schema.migrations.slice(1, k)], CTX)
          expect(readUserVersion(seeded), `seeded v${k}`).toBe(k)
          // The baseline must genuinely be BEHIND the fresh schema, or the comparison below would
          // be vacuously green.
          expect(schemaFingerprint(seeded), `v${k} differs from fresh`).not.toEqual(freshSchema)
        } finally {
          seeded.close()
        }

        const upgraded = store.open(path)
        try {
          expect(upgraded.migration.applied, `v${k} → v${versions} applied`).toEqual(
            store.schema.migrations.slice(k).map((migration) => migration.version),
          )
          expect(schemaFingerprint(upgraded.db), `v${k} → v${versions} schema`).toEqual(freshSchema)
        } finally {
          upgraded.db.close()
        }
      }
    })
  }

  it('the frozen baseline is a real earlier schema, not a copy of the live one', () => {
    // If the fixture were regenerated from the live DDL, the memory guard would lose the objects
    // step 2/4/5/6/9 are supposed to create and the knowledge guard would lose step 2's columns.
    // Pin the two extremes so that stays visible.
    const memoryNames = new Set(MEMORY_BASELINE_V1.map((object) => object.name))
    expect(memoryNames.has('idx_contradict_open_pair')).toBe(false)
    expect(memoryNames.has('idx_facts_entities_version')).toBe(false)
    expect(memoryNames.has('idx_facts_idle')).toBe(true)
    const kbChunks = KNOWLEDGE_BASELINE_V1.find((object) => object.name === 'doc_chunks')
    expect(kbChunks?.sql).not.toContain('content_hash')
  })
})
