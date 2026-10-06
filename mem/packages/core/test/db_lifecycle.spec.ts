import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_SCHEMA, openMemoryDb, openMemoryStore } from '../src/db/conn.js'
import { vectorCachePath } from '../src/db/vectors.js'
import { KNOWLEDGE_SCHEMA, openKnowledgeDb, openKnowledgeStore } from '../src/db/knowledge.js'
import { migrate, readUserVersion, validateMigrations, SchemaDowngradeError, type Migration } from '../src/db/migrations.js'
import { openSqlite } from '../src/db/sqlite.js'
import { FACT_COLUMNS_NO_BLOB } from '../src/db/dao/facts.js'
import type { Db } from '../src/db/port.js'
import { describeMigrationOutcome } from '../src/db/store.js'
import { memoryDbPath, knowledgeDbPath } from '../src/config/paths.js'
import { buildRuntime } from '../src/runtime.js'

/**
 * The store lifecycle — initialization and UPGRADE.
 *
 * The engine used to re-apply an idempotent DDL blob on every open and call that "no
 * migrations needed". That stopped being true when a change had to repair data in place, so
 * these tests pin the four states that matter: a fresh file, a re-open, a database from
 * before versioning, and a step that fails halfway.
 */
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avf-db-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const tableExists = (db: Db, name: string): boolean =>
  (db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.n ?? 0) > 0

const indexExists = (db: Db, name: string): boolean =>
  (db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)?.n ?? 0) > 0

describe('store schema lifecycle', () => {
  it('a fresh memory database walks every migration and records them', () => {
    const { db, migration } = openMemoryStore(join(dir, 'fresh.db'))
    try {
      expect(migration.from).toBe(0)
      expect(migration.to).toBe(MEMORY_SCHEMA.migrations.length)
      expect(migration.applied).toEqual(MEMORY_SCHEMA.migrations.map((m) => m.version))
      expect(readUserVersion(db)).toBe(MEMORY_SCHEMA.migrations.length)
      expect(db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all())
        .toEqual(MEMORY_SCHEMA.migrations.map((m) => ({ version: m.version, name: m.name })))
      expect(tableExists(db, 'facts')).toBe(true)
      expect(tableExists(db, 'facts_fts')).toBe(true)
      expect(indexExists(db, 'idx_contradict_open_pair')).toBe(true)
      // The listing/conflict-lookup indexes come from the base DDL for a fresh store.
      expect(indexExists(db, 'idx_facts_created')).toBe(true)
      expect(indexExists(db, 'idx_facts_forget')).toBe(true)
      expect(indexExists(db, 'idx_facts_idle_cutoff')).toBe(true)
      expect(indexExists(db, 'idx_facts_bonus_window')).toBe(true)
      expect(indexExists(db, 'idx_contradict_fact_a')).toBe(true)
      expect(indexExists(db, 'idx_contradict_fact_b')).toBe(true)
      // …and the dead one is not created at all (its predicate could never use it).
      expect(indexExists(db, 'idx_facts_idle')).toBe(false)
      // The derived-state columns and their sweep indexes (step 6) come from the base DDL here.
      expect(indexExists(db, 'idx_facts_entities_version')).toBe(true)
      expect(indexExists(db, 'idx_facts_conflict_pending')).toBe(true)
      // NOT NULL DEFAULT 0 on BOTH, which is the point of the columns' shape and not a detail: the
      // sweep predicate is `entities_version < ?`, so a NULL is invisible forever, and a row
      // written by a process that does not name the column (an older build sharing the file during
      // a rolling upgrade) must still land on a version the sweep adopts.
      expect(
        db.prepare("SELECT name, \"notnull\", dflt_value FROM pragma_table_info('facts') WHERE name IN ('entities_version', 'conflict_checked') ORDER BY name").all(),
      ).toEqual([
        { name: 'conflict_checked', notnull: 1, dflt_value: '0' },
        { name: 'entities_version', notnull: 1, dflt_value: '0' },
      ])
    } finally {
      db.close()
    }
  })

  it('names vector snapshots per SPACE, without collisions, and never for :memory:', () => {
    // Sanitizing the space was LOSSY: `a/b` and `a_b` mapped onto one file name — the very
    // collision the space-in-the-name exists to prevent (a model swap must not load another
    // space's graph). Escaping keeps them distinct.
    expect(vectorCachePath('/db/x', 'a/b/512')).not.toBe(vectorCachePath('/db/x', 'a_b/512'))
    expect(vectorCachePath('/db/x', 'model/512')).toContain('model')
    // A non-file database has nowhere to put a snapshot; it used to write `:memory:.….hnsw` into
    // the process working directory.
    expect(vectorCachePath(':memory:', 'model/512')).toBeNull()
  })

  it('a re-open re-applies nothing', () => {
    const path = join(dir, 'reopen.db')
    openMemoryStore(path).db.close()
    const second = openMemoryStore(path)
    try {
      expect(second.migration).toMatchObject({ from: MEMORY_SCHEMA.migrations.length, to: MEMORY_SCHEMA.migrations.length, applied: [] })
    } finally {
      second.db.close()
    }
  })

  it('a pre-versioning database is adopted instead of rebuilt', () => {
    // A database written before `user_version` existed: schema present, version 0, and the
    // duplicate open rows that v2 has to repair before it can add the unique index.
    const path = join(dir, 'legacy.db')
    const first = openMemoryStore(path)
    first.db.exec('DROP INDEX IF EXISTS idx_contradict_open_pair')
    first.db.exec("INSERT INTO facts (content, settle_clock) VALUES ('a', 0), ('b', 0)")
    const ids = first.db.prepare('SELECT fact_id FROM facts ORDER BY fact_id').all() as { fact_id: number }[]
    for (let i = 0; i < 3; i++) {
      first.db.prepare('INSERT INTO contradiction_log (fact_a, fact_b, score) VALUES (?, ?, 0.9)').run(ids[0]!.fact_id, ids[1]!.fact_id)
    }
    first.db.pragma('user_version = 0')
    first.db.close()

    const upgraded = openMemoryStore(path)
    try {
      // v1 is the base schema, so on this database it is a no-op that only stamps the version;
      // every later step still has to run (their mission is what adoption is FOR).
      expect(upgraded.migration.applied).toEqual(MEMORY_SCHEMA.migrations.map((m) => m.version))
      expect(readUserVersion(upgraded.db)).toBe(MEMORY_SCHEMA.migrations.length)
      expect(upgraded.db.prepare('SELECT COUNT(*) AS n FROM contradiction_log WHERE resolved = 0').get()).toEqual({ n: 1 })
      expect(indexExists(upgraded.db, 'idx_contradict_open_pair')).toBe(true)
      // The data itself survives: adoption must not recreate the store.
      expect(upgraded.db.prepare('SELECT COUNT(*) AS n FROM facts').get()).toEqual({ n: 2 })
    } finally {
      upgraded.db.close()
    }
  })

  it('a pre-versioning database whose facts predates the derived-state columns is adopted, not failed by step 1', () => {
    // The REAL pre-versioning shape: a database written before step 6 existed holds `facts`
    // WITHOUT `entities_version` / `conflict_checked`, at version 0. Step 1 (the base DDL) must
    // stay runnable against it — both sweep indexes once lived in the base DDL and blew up on
    // such a store before step 6 could add the columns. Step 6 owns both indexes; step 1 must
    // not name their columns.
    const path = join(dir, 'pre-v6.db')
    const first = openMemoryStore(path)
    first.db.exec('DROP INDEX IF EXISTS idx_facts_entities_version')
    first.db.exec('DROP INDEX IF EXISTS idx_facts_conflict_pending')
    first.db.exec('ALTER TABLE facts DROP COLUMN entities_version')
    first.db.exec('ALTER TABLE facts DROP COLUMN conflict_checked')
    first.db.prepare("INSERT INTO facts (content, settle_clock) VALUES ('旧行', 0)").run()
    first.db.pragma('user_version = 0')
    first.db.close()

    const upgraded = openMemoryStore(path)
    try {
      expect(upgraded.migration.applied).toEqual(MEMORY_SCHEMA.migrations.map((m) => m.version))
      expect(readUserVersion(upgraded.db)).toBe(MEMORY_SCHEMA.migrations.length)
      // The row survives, and the step-6 columns land with their documented defaults so the
      // first derived-state sweep adopts it.
      expect(
        upgraded.db.prepare('SELECT content, entities_version, conflict_checked FROM facts').all(),
      ).toEqual([{ content: '旧行', entities_version: 0, conflict_checked: 0 }])
      expect(indexExists(upgraded.db, 'idx_facts_entities_version')).toBe(true)
      expect(indexExists(upgraded.db, 'idx_facts_conflict_pending')).toBe(true)
    } finally {
      upgraded.db.close()
    }
  })

  it('the knowledge store runs the same lifecycle', () => {
    const path = join(dir, 'knowledge.db')
    const first = openKnowledgeStore(path)
    try {
      expect(first.migration.applied).toEqual(KNOWLEDGE_SCHEMA.migrations.map((m) => m.version))
      expect(tableExists(first.db, 'doc_chunks_fts')).toBe(true)
    } finally {
      first.db.close()
    }
    const second = openKnowledgeStore(path)
    try {
      expect(second.migration.applied).toEqual([])
    } finally {
      second.db.close()
    }
  })

  it('a database from before verdicts existed reads its closed pairs as automatic retirements', () => {
    // v3 adds `resolved_by`. Rows written before it can only have been closed automatically
    // (an explicit adjudication did not exist yet), and that distinction decides whether a
    // later sweep may re-open the pair, so the migration default is load-bearing.
    const path = join(dir, 'pre-verdict.db')
    // `openMemoryDb` returns the PORT itself (the store wrapper is `openMemoryStore`), so the
    // migration fixture talks to `Db` methods directly.
    const first = openMemoryDb(path)
    first.exec('DROP TABLE contradiction_log')
    first.exec(`CREATE TABLE contradiction_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_a INTEGER, fact_b INTEGER, score REAL,
      detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved INTEGER DEFAULT 0, loser_fact_id INTEGER, resolution TEXT, resolved_at TIMESTAMP)`)
    first.exec("INSERT INTO contradiction_log (fact_a, fact_b, score, resolved, resolution, loser_fact_id) VALUES (1, 2, 0.9, 1, 'true_positive', 1)")
    first.exec("INSERT INTO contradiction_log (fact_a, fact_b, score, resolved) VALUES (3, 4, 0.5, 0)")
    first.pragma('user_version = 2')
    first.close()

    const upgraded = openMemoryStore(path)
    try {
      // From v2: the verdict column AND everything after it (indexes from steps 4 and 5, the
      // derived-state columns from step 6).
      expect(upgraded.migration.applied).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
      expect(readUserVersion(upgraded.db)).toBe(MEMORY_SCHEMA.migrations.length)
      // Closed → automatic; still open → not suppressed by a verdict either.
      expect(upgraded.db.prepare('SELECT resolved_by FROM contradiction_log ORDER BY id').all())
        .toEqual([{ resolved_by: 'auto' }, { resolved_by: null }])
    } finally {
      upgraded.db.close()
    }
  })

  it('upgrades a v3 database to the listing/conflict indexes and drops the dead one', () => {
    const path = join(dir, 'v3.db')
    const first = openMemoryStore(path)
    // Simulate a database written before step 4: the new indexes absent, the dead one present.
    first.db.exec('DROP INDEX IF EXISTS idx_facts_created; DROP INDEX IF EXISTS idx_contradict_fact_a; DROP INDEX IF EXISTS idx_contradict_fact_b')
    first.db.exec('DROP INDEX IF EXISTS idx_facts_forget; DROP INDEX IF EXISTS idx_facts_idle_cutoff; DROP INDEX IF EXISTS idx_facts_bonus_window')
    first.db.exec('CREATE INDEX IF NOT EXISTS idx_facts_idle ON facts(status, pinned, last_retrieved_at)')
    first.db.pragma('user_version = 3')
    first.db.close()

    const upgraded = openMemoryStore(path)
    try {
      expect(upgraded.migration.applied).toEqual([4, 5, 6, 7, 8, 9, 10])
      expect(readUserVersion(upgraded.db)).toBe(MEMORY_SCHEMA.migrations.length)
      expect(indexExists(upgraded.db, 'idx_facts_created')).toBe(true)
      expect(indexExists(upgraded.db, 'idx_contradict_fact_a')).toBe(true)
      expect(indexExists(upgraded.db, 'idx_contradict_fact_b')).toBe(true)
      // step 5's tick-scan indexes came along
      expect(indexExists(upgraded.db, 'idx_facts_forget')).toBe(true)
      expect(indexExists(upgraded.db, 'idx_facts_idle_cutoff')).toBe(true)
      expect(indexExists(upgraded.db, 'idx_facts_bonus_window')).toBe(true)
      expect(indexExists(upgraded.db, 'idx_facts_idle')).toBe(false)
      // step 6: the derived-state columns and their two sweep indexes
      expect(indexExists(upgraded.db, 'idx_facts_entities_version')).toBe(true)
      expect(indexExists(upgraded.db, 'idx_facts_conflict_pending')).toBe(true)
    } finally {
      upgraded.db.close()
    }
  })

  it('a v5 database gains the derived-state columns, and NO row is claimed as already checked', () => {
    // The migration must decide two things per row, and both used to be wrong or unasserted:
    //   - `entities_version`: every existing row was extracted by the rules in force before
    //     versioning existed, so it is stale exactly ONCE (0) and the first sweep adopts it.
    //   - `conflict_checked`: the tempting shortcut is "it has a vector, so a build whose write
    //     path ran the check must have produced it". That claim is about the LIVE INDEX, not the
    //     column, and the migration cannot see the index — so guessing `1` makes any row the index
    //     cannot serve (another space, another process, a corrupt blob) exempt forever. The rows
    //     are left at 0 and the budgeted drain adopts them.
    // Two mutations this test is the guard for, because each passed everything before it: making
    // the ALTER a plain nullable INTEGER (row 1 comes back NULL), and re-adding the
    // `UPDATE … SET conflict_checked = 1 WHERE semantic_vector IS NOT NULL` shortcut.
    const path = join(dir, 'v5.db')
    const first = openMemoryStore(path)
    first.db.exec('DROP INDEX IF EXISTS idx_facts_entities_version')
    first.db.exec('DROP INDEX IF EXISTS idx_facts_conflict_pending')
    first.db.exec('ALTER TABLE facts DROP COLUMN entities_version')
    first.db.exec('ALTER TABLE facts DROP COLUMN conflict_checked')
    // One row with a (decodable) vector and one without: the shortcut would have split them.
    first.db.prepare("INSERT INTO facts (content, settle_clock, semantic_vector) VALUES ('有向量', 0, x'0000803f')").run()
    first.db.prepare("INSERT INTO facts (content, settle_clock) VALUES ('没有向量', 0)").run()
    first.db.pragma('user_version = 5')
    first.db.close()

    const upgraded = openMemoryStore(path)
    try {
      expect(upgraded.migration.applied).toEqual([6, 7, 8, 9, 10])
      expect(readUserVersion(upgraded.db)).toBe(MEMORY_SCHEMA.migrations.length)
      expect(
        upgraded.db.prepare('SELECT content, entities_version, conflict_checked FROM facts ORDER BY fact_id').all(),
      ).toEqual([
        { content: '有向量', entities_version: 0, conflict_checked: 0 },
        { content: '没有向量', entities_version: 0, conflict_checked: 0 },
      ])
      // …and the queue predicate still FINDS the vector-bearing row, so "left at 0" is a claim the
      // drain can act on rather than a row that quietly never comes back.
      expect(
        upgraded.db.prepare('SELECT content FROM facts WHERE status = ? AND conflict_checked = 0 AND semantic_vector IS NOT NULL').all('active'),
      ).toEqual([{ content: '有向量' }])
    } finally {
      upgraded.db.close()
    }
  })

  it('replaces the intermediate BLOB conflict index a v6 database may carry (step 7)', () => {
    // `CREATE INDEX IF NOT EXISTS` matches by NAME, so a database that ran the INTERMEDIATE revision
    // of step 6 — which put `semantic_vector` (2 KB per row) into the key for a query that selects
    // `content` and therefore never gets a covering plan — keeps that index forever: step 6 does not
    // re-run at `user_version = 6`. Step 7 is what repairs it, and this is its guard: without step 7
    // the SQL below still names `semantic_vector` and `applied` is empty.
    const path = join(dir, 'v6-blob-index.db')
    const first = openMemoryStore(path)
    first.db.exec('DROP INDEX IF EXISTS idx_facts_conflict_pending')
    first.db.exec('CREATE INDEX idx_facts_conflict_pending ON facts(status, conflict_checked, semantic_vector)')
    first.db.pragma('user_version = 6')
    first.db.close()

    const upgraded = openMemoryStore(path)
    try {
      expect(upgraded.migration.applied).toEqual([7, 8, 9, 10])
      const index = upgraded.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_facts_conflict_pending'")
        .get() as { sql: string } | undefined
      expect(index?.sql).toContain('WHERE conflict_checked = 0')
      expect(index?.sql).not.toContain('semantic_vector')
      // The drain predicate is served by the replacement (the same shape the DDL creates for a fresh
      // database), which is the property the BLOB column was pretending to provide.
      expect(index?.sql).toContain('ON facts(status, fact_id)')
    } finally {
      upgraded.db.close()
    }
    // Idempotent on a second open: v7 is the current version, so nothing runs again.
    const reopened = openMemoryStore(path)
    try {
      expect(reopened.migration.applied).toEqual([])
    } finally {
      reopened.db.close()
    }
  })

  it('repairs an EMPTY FTS index (step 8): rows written before the triggers become searchable again', () => {
    // `facts_ai/ad/au` keep `facts_fts` in step with the table, so this only matters for a database
    // that predates them (or whose triggers were lost). The loss is SILENT — the hybrid search keeps
    // answering from the entity and semantic legs — so the repair has to be unconditional, and
    // FTS5's `'rebuild'` is the only way to re-derive an external-content index from the table.
    const path = join(dir, 'no-fts-index.db')
    const first = openMemoryStore(path)
    // `facts_fts` is an external-content table (`content='facts'`), so a plain `COUNT(*)` reads the
    // CONTENT table and would report 1 either way; what proves the index is the index-only query.
    const searchable = (store: { db: Db }): number =>
      (store.db.prepare('SELECT COUNT(*) AS n FROM facts_fts WHERE facts_fts MATCH ?').get('统一网关') as { n: number }).n
    first.db.exec('DROP TRIGGER IF EXISTS facts_ai')
    first.db.prepare("INSERT INTO facts (content, settle_clock) VALUES ('平台组负责统一网关', 0)").run()
    expect(searchable(first)).toBe(0) // the gap: a fact row the FTS leg cannot see
    first.db.pragma('user_version = 7')
    first.db.close()

    const upgraded = openMemoryStore(path)
    try {
      expect(upgraded.migration.applied).toEqual([8, 9, 10])
      expect(searchable(upgraded)).toBe(1)
    } finally {
      upgraded.db.close()
    }
  })

  it('refuses to open a database written by a NEWER build (migrations are one-way)', () => {
    // A downgraded plugin meets a schema from the future. Applying "no pending steps" and carrying on
    // is the one answer that can corrupt data, so the open must fail — loudly, with the two versions
    // and what to do about it. It must also fail BEFORE touching the file: a refused open may not
    // create the audit table or bump anything.
    const path = join(dir, 'from-the-future.db')
    const newest = MEMORY_SCHEMA.migrations.length
    const first = openMemoryStore(path)
    first.db.pragma(`user_version = ${String(newest + 2)}`)
    const auditOf = (): { n: number; max: number } =>
      first.db.prepare('SELECT COUNT(*) AS n, MAX(version) AS max FROM schema_migrations').get() as { n: number; max: number }
    const before = auditOf()

    expect(() => openMemoryStore(path)).toThrow(SchemaDowngradeError)
    expect(() => openMemoryStore(path)).toThrow(new RegExp(`version ${String(newest + 2)} but this build knows only ${String(newest)}`))
    // Untouched: the version is still the future one, and the refused open neither appended an audit
    // row nor rewrote the ones the first open stamped.
    expect(readUserVersion(first.db)).toBe(newest + 2)
    expect(auditOf()).toEqual(before)
    first.db.close()
  })

  it('a pre-versioning knowledge database gains the derived-state columns, keeping its rows', () => {
    // Same adoption path as the memory store, but this step is an ALTER rather than a rebuild:
    // the columns say what the chunk derivations were built from, so existing rows must end up
    // NULL (unknown ⇒ stale exactly once) instead of being guessed at.
    const path = join(dir, 'legacy-knowledge.db')
    const first = openKnowledgeDb(path)
    first.exec("INSERT INTO documents (domain, source, title) VALUES ('tech', 'a.md', 'a')")
    first.exec("INSERT INTO doc_chunks (doc_id, idx, text, source_ref) VALUES (1, 0, '平台组负责网关', 'tech:a.md:1:0')")
    // Simulate the v1 shape: drop the columns v2 introduces, then rewind the version.
    first.exec('DROP TABLE doc_chunks')
    first.exec(`CREATE TABLE doc_chunks (
      chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
      idx INTEGER NOT NULL, text TEXT NOT NULL, headings_path TEXT DEFAULT '',
      source_ref TEXT NOT NULL, char_start INTEGER DEFAULT 0, char_end INTEGER DEFAULT 0,
      semantic_vector BLOB)`)
    first.exec("INSERT INTO doc_chunks (doc_id, idx, text, source_ref) VALUES (1, 0, '平台组负责网关', 'tech:a.md:1:0')")
    first.pragma('user_version = 1')
    first.close()

    const upgraded = openKnowledgeStore(path)
    try {
      expect(upgraded.migration.applied).toEqual([2])
      expect(readUserVersion(upgraded.db)).toBe(2)
      const row = upgraded.db
        .prepare('SELECT text, content_hash, embedding_model, entities_version FROM doc_chunks')
        .get() as { text: string; content_hash: string | null; embedding_model: string | null; entities_version: number | null }
      expect(row.text).toBe('平台组负责网关')
      expect(row.content_hash).toBeNull()
      expect(row.embedding_model).toBeNull()
      expect(row.entities_version).toBeNull()
    } finally {
      upgraded.db.close()
    }
    // A second open must not try the ALTER again (SQLite would refuse the duplicate column).
    const reopened = openKnowledgeStore(path)
    try {
      expect(reopened.migration.applied).toEqual([])
    } finally {
      reopened.db.close()
    }
  })

  it('a failing step rolls back its own mission and its version bump', () => {
    const db = openSqlite(':memory:')
    const failing: Migration[] = [
      { version: 1, name: 'ok', up: (d) => d.exec('CREATE TABLE t (x)') },
      {
        version: 2,
        name: 'boom',
        up: (d) => {
          d.exec('CREATE TABLE u (x)')
          throw new Error('boom')
        },
      },
    ]
    try {
      expect(() => migrate(db, failing, { tokenizer: 'unicode61' })).toThrow('boom')
      // The whole step is atomic: no table, no audit row, no version claiming it happened.
      expect(tableExists(db, 'u')).toBe(false)
      expect(tableExists(db, 't')).toBe(true)
      expect(readUserVersion(db)).toBe(1)
      expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }])
    } finally {
      db.close()
    }
  })

  it('rejects a migration list with gaps or duplicates', () => {
    const step = (version: number): Migration => ({ version, name: `v${String(version)}`, up: () => {} })
    expect(() => validateMigrations([step(1), step(3)])).toThrow(/1\.\.N/)
    expect(() => validateMigrations([step(1), step(1)])).toThrow(/1\.\.N/)
    expect(() => validateMigrations([step(2)])).toThrow(/1\.\.N/)
    expect(() => validateMigrations([step(1), step(2)])).not.toThrow()
  })

  it('reports the version of a database that has never been opened by this engine', () => {
    const db = openSqlite(':memory:')
    try {
      expect(readUserVersion(db)).toBe(0)
    } finally {
      db.close()
    }
  })
})

/**
 * The two reads that used to be `SELECT *` (the admin page and every recall's trust settlement)
 * dragged ~10 KB of BLOB per row through the driver for columns no caller looked at. The projection
 * is spelled out, so it has to be kept in step with the table — this is the step-keeping.
 */
describe('the scalar column projection', () => {
  it('names every facts column except the two BLOBs and the two deprecated provenance columns', () => {
    const db = openMemoryDb(join(dir, 'columns.db'))
    try {
      const actual = db.prepare<{ name: string }>('PRAGMA table_info(facts)').all().map((row) => row.name)
      const projected = FACT_COLUMNS_NO_BLOB.split(',').map((part) => part.trim()).filter(Boolean)
      // A column added to the table and forgotten here would silently disappear from `mem_admin
      // list` and from the reinforcement read — no type error, no runtime error, just a missing
      // field. Sets, so the order of the projection is not part of the contract.
      //
      // The two DEPRECATED columns are exempt on purpose (P-05a, 零迁移): `mirror_source` was the
      // constant `'user'` at the single INSERT and `mirror_target` had no writer at all, so the
      // model-facing views stopped projecting them. The COLUMNS stay in the schema for a later
      // migration; only this projection stops reading them. Naming them here keeps the exemption
      // explicit — a THIRD column cannot vanish silently.
      const deprecated = new Set(['mirror_source', 'mirror_target'])
      expect(new Set(projected)).toEqual(
        new Set(actual.filter((name) => name !== 'hrr_vector' && name !== 'semantic_vector' && !deprecated.has(name))),
      )
    } finally {
      db.close()
    }
  })
})

/**
 * The `resolved` dimension of `contradiction_log` had no index: `list(resolved=1)` sorted the whole
 * log through a temp b-tree, and `suppressedPairs`' `resolved = 0 OR resolved_by = 'verdict'` fell
 * back to a full scan because an OR is only index-served when EVERY branch is.
 */
describe('the contradiction resolved-indexes (v9)', () => {
  it('a v8 database gains both indexes', () => {
    const path = join(dir, 'v8-contradictions.db')
    const first = openMemoryStore(path)
    first.db.exec('DROP INDEX IF EXISTS idx_contradict_resolved_score')
    first.db.exec('DROP INDEX IF EXISTS idx_contradict_verdict')
    first.db.pragma('user_version = 8')
    first.db.close()

    const upgraded = openMemoryStore(path)
    try {
      expect(upgraded.migration.applied).toEqual([9, 10])
      expect(indexExists(upgraded.db, 'idx_contradict_resolved_score')).toBe(true)
      expect(indexExists(upgraded.db, 'idx_contradict_verdict')).toBe(true)
    } finally {
      upgraded.db.close()
    }
  })

  it('a fresh database gets them from the base DDL, so step 9 is a no-op there', () => {
    const { db } = openMemoryStore(join(dir, 'fresh-contradictions.db'))
    try {
      expect(indexExists(db, 'idx_contradict_resolved_score')).toBe(true)
      expect(indexExists(db, 'idx_contradict_verdict')).toBe(true)
    } finally {
      db.close()
    }
  })

  it('keeps the verdict partial index to exactly the pairs a sweep must not resurrect', () => {
    const db = openMemoryDb(join(dir, 'verdict-index.db'))
    try {
      const sql = db.prepare<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_contradict_verdict'",
      ).get()!.sql
      // Partial on `resolved_by = 'verdict'`: an adjudicated pair stays suppressed forever, while a
      // pair retired because a fact left the corpus can be re-detected after a restore.
      expect(sql).toContain("resolved_by = 'verdict'")
    } finally {
      db.close()
    }
  })
})

/**
 * Startup auto-upgrade has to be VISIBLE: the version lives in `PRAGMA user_version`, so without a
 * log line an operator cannot tell "the store was upgraded on this boot" from "it was already
 * current" — and the first is the one that matters after deploying a build with a new migration.
 *
 * The other half is equal and opposite: a store that is already current must not add a per-boot
 * line, or the signal drowns.
 */
/**
 * Batch 1's schema generation (P-07 / P-08 / P-10 / P-13): the columns, the provenance table and
 * its reverse-lookup index. The every-starting-version parity guard lives in
 * `db_upgrade_parity.spec.ts` (it iterates the migration list, so step 10 is covered there); this
 * pins the two places the objects must appear — the base DDL (fresh file) and step 10 (old file).
 */
describe('the v10 validity/sources/assert-count schema', () => {
  const V10_COLUMNS = ['valid_from', 'valid_to', 'assert_count']
  const factsColumns = (db: Db): string[] =>
    db.prepare<{ name: string }>('PRAGMA table_info(facts)').all().map((c) => c.name)

  it('a fresh database gets them from the base DDL, so step 10 is a no-op there', () => {
    const { db, migration } = openMemoryStore(join(dir, 'fresh-v10.db'))
    try {
      expect(factsColumns(db)).toEqual(expect.arrayContaining(V10_COLUMNS))
      expect(tableExists(db, 'fact_sources')).toBe(true)
      expect(indexExists(db, 'idx_fact_sources_ref')).toBe(true)
      expect(migration.applied).toContain(10)
    } finally {
      db.close()
    }
  })

  it('a v9 database gains ALL of them from step 10 alone', () => {
    const path = join(dir, 'v9-v10.db')
    const seeded = openMemoryStore(path)
    // Downgrade the fresh file to the v9 shape: the columns/table/index step 10 introduces are the
    // only things a v9 database lacks (every earlier step is already at its final form).
    seeded.db.exec('DROP TABLE IF EXISTS fact_sources')
    seeded.db.exec('DROP INDEX IF EXISTS idx_fact_sources_ref')
    for (const column of V10_COLUMNS) seeded.db.exec(`ALTER TABLE facts DROP COLUMN ${column}`)
    seeded.db.pragma('user_version = 9')
    seeded.db.close()

    const upgraded = openMemoryStore(path)
    try {
      expect(upgraded.migration.applied).toEqual([10])
      expect(factsColumns(upgraded.db)).toEqual(expect.arrayContaining(V10_COLUMNS))
      expect(tableExists(upgraded.db, 'fact_sources')).toBe(true)
      expect(indexExists(upgraded.db, 'idx_fact_sources_ref')).toBe(true)
      // `assert_count` is DEFAULT 1 for every row that predates it ("asserted once").
      expect(
        upgraded.db.prepare<{ dflt: string | null }>("SELECT dflt_value AS dflt FROM pragma_table_info('facts') WHERE name = 'assert_count'").get()?.dflt,
      ).toBe('1')
    } finally {
      upgraded.db.close()
    }
  })
})

describe('startup schema diagnostics', () => {
  it('phrases both states, naming every applied step', () => {
    const path = join(dir, 'diagnostics.db')
    const fresh = openMemoryStore(path)
    try {
      expect(describeMigrationOutcome(MEMORY_SCHEMA, fresh.migration)).toBe(
        `schema upgraded 0 → ${String(MEMORY_SCHEMA.migrations.length)} `
        + `(applied: ${MEMORY_SCHEMA.migrations.map((m) => `${String(m.version)} ${m.name}`).join(', ')})`,
      )
    } finally {
      fresh.db.close()
    }
    const reopen = openMemoryStore(path)
    try {
      expect(describeMigrationOutcome(MEMORY_SCHEMA, reopen.migration)).toBe(
        `schema up to date (${String(MEMORY_SCHEMA.migrations.length)})`,
      )
    } finally {
      reopen.db.close()
    }
  })

  it('logs one upgraded line per store at startup, and none when both are already current', () => {
    const home = join(dir, 'diagnostics-home')
    // A memory store at the version before the last step, and a knowledge store at the version
    // before its last step: both are genuinely behind, so both must report.
    const mem = openMemoryStore(memoryDbPath(home))
    mem.db.exec('DROP INDEX IF EXISTS idx_contradict_resolved_score')
    mem.db.exec('DROP INDEX IF EXISTS idx_contradict_verdict')
    mem.db.pragma(`user_version = ${String(MEMORY_SCHEMA.migrations.length - 1)}`)
    mem.db.close()
    const kb = openKnowledgeStore(knowledgeDbPath(home))
    kb.db.pragma(`user_version = ${String(KNOWLEDGE_SCHEMA.migrations.length - 1)}`)
    kb.db.close()

    const memoryLast = MEMORY_SCHEMA.migrations.at(-1)!
    const knowledgeLast = KNOWLEDGE_SCHEMA.migrations.at(-1)!
    const firstBoot: string[] = []
    const first = buildRuntime({ dataHome: home, logger: { info: (m) => firstBoot.push(m), warn: () => {}, error: () => {} } })
    try {
      expect(firstBoot).toContain(
        `memory: schema upgraded ${String(memoryLast.version - 1)} → ${String(memoryLast.version)} `
        + `(applied: ${String(memoryLast.version)} ${memoryLast.name})`,
      )
      expect(firstBoot).toContain(
        `knowledge: schema upgraded ${String(knowledgeLast.version - 1)} → ${String(knowledgeLast.version)} `
        + `(applied: ${String(knowledgeLast.version)} ${knowledgeLast.name})`,
      )
    } finally {
      first.shutdown()
    }

    // Second boot: nothing to apply, so no upgrade line from either store.
    const secondBoot: string[] = []
    const second = buildRuntime({ dataHome: home, logger: { info: (m) => secondBoot.push(m), warn: () => {}, error: () => {} } })
    try {
      expect(secondBoot.filter((line) => line.includes('schema upgraded'))).toEqual([])
    } finally {
      second.shutdown()
    }
  })

  it('a store this build cannot open makes the runtime throw, which is what the plugin degrades', () => {
    // The plugin's `apply` catches exactly this and mounts DEGRADED with `memory unavailable: …`
    // (a throwing `apply` is what used to stop `dsh web` from booting at all; see `mount-smoke`).
    // The point here is that the failure still PROPAGATES out of `buildRuntime` instead of being
    // swallowed by the migration path.
    const home = join(dir, 'unopenable-home')
    const seed = openMemoryStore(memoryDbPath(home))
    seed.db.pragma(`user_version = ${String(MEMORY_SCHEMA.migrations.length + 2)}`)
    seed.db.close()
    expect(() => buildRuntime({ dataHome: home, logger: { info: () => {}, warn: () => {}, error: () => {} } })).toThrow(SchemaDowngradeError)
  })
})
