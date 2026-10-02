/**
 * The knowledge store's database: its schema (as ordered migrations) and the open entry point.
 *
 * Same lifecycle as the memory store — `openStoreDb` applies the shared PRAGMAs, the version
 * check and the steps; this module only declares what the knowledge schema IS.
 */
import { addColumnIfMissing } from './migrations.js'
import { openStoreDb, type OpenedStore, type StoreSchema } from './store.js'
import { resolveFtsTokenizer, type FtsTokenizer } from './tokenizer.js'

/** Knowledge DB schema: documents under `domain → source`, split into chunks. */
export const KNOWLEDGE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS documents (
    doc_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    domain      TEXT NOT NULL,
    source      TEXT NOT NULL,
    title       TEXT NOT NULL,
    source_uri  TEXT,
    meta        TEXT DEFAULT '',
    status      TEXT DEFAULT 'active',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (domain, source, title)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_documents_domain_source ON documents(domain, source)`,
  `CREATE TABLE IF NOT EXISTS doc_chunks (
    chunk_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id      INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    text        TEXT NOT NULL,
    headings_path TEXT DEFAULT '',
    source_ref  TEXT NOT NULL,
    char_start  INTEGER DEFAULT 0,
    char_end    INTEGER DEFAULT 0,
    semantic_vector BLOB,
    content_hash    TEXT,
    embedding_model TEXT,
    entities_version INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc ON doc_chunks(doc_id)`,
  `CREATE TABLE IF NOT EXISTS chunk_entities (
    chunk_id INTEGER NOT NULL REFERENCES doc_chunks(chunk_id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    PRIMARY KEY (chunk_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chunk_entities_name ON chunk_entities(name)`,
]

/**
 * The external-content FTS5 table, created separately so the tokenizer can be
 * chosen at open time (same DESIGN §16 mitigation as the memory store).
 */
export function chunksFtsTableDdl(tokenizer: string): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
    text,
    content='doc_chunks',
    content_rowid='chunk_id',
    tokenize='${tokenizer}'
  )`
}

const KNOWLEDGE_FTS_TRIGGERS: string[] = [
  `CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON doc_chunks BEGIN
    INSERT INTO doc_chunks_fts(rowid, text) VALUES (new.chunk_id, new.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON doc_chunks BEGIN
    INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, text)
      VALUES('delete', old.chunk_id, old.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON doc_chunks BEGIN
    INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, text)
      VALUES('delete', old.chunk_id, old.text);
    INSERT INTO doc_chunks_fts(rowid, text) VALUES (new.chunk_id, new.text);
  END`,
]

/**
 * Ordered schema steps. Step 1 is the base schema and MUST stay idempotent: a database
 * created before this mechanism existed reports `user_version = 0` while already holding it.
 */
export const KNOWLEDGE_SCHEMA: StoreSchema = {
  describe: 'knowledge (documents / doc_chunks / chunk_entities)',
  migrations: [
    {
      version: 1,
      name: 'base-schema',
      up: (db, ctx: { tokenizer: FtsTokenizer }) => {
        for (const ddl of KNOWLEDGE_DDL) db.exec(ddl)
        // Same ordering rule as the memory store: choose the tokenizer before the DDL.
        db.exec(chunksFtsTableDdl(ctx.tokenizer))
        for (const tri of KNOWLEDGE_FTS_TRIGGERS) db.exec(tri)
      },
    },
    {
      version: 2,
      name: 'chunk-derived-state-provenance',
      up: (db) => {
        // Which text the derived rows were built from, and by what. Without these a reindex
        // cannot tell "already done" from "stale", so it re-encodes and re-extracts the whole
        // corpus every time, and a model change mixes two vector spaces in one column.
        // Also present in the base DDL, so a fresh database gets them from step 1.
        addColumnIfMissing(db, 'doc_chunks', 'content_hash', 'TEXT')
        addColumnIfMissing(db, 'doc_chunks', 'embedding_model', 'TEXT')
        addColumnIfMissing(db, 'doc_chunks', 'entities_version', 'INTEGER')
      },
    },
  ],
}

/** Open (or create) the knowledge DB, bringing its schema up to the current version. */
export function openKnowledgeDb(path: string): OpenedStore['db'] {
  return openKnowledgeStore(path).db
}

/** Open and report which migrations ran (tests, and any explicit upgrade path). */
export function openKnowledgeStore(path: string): OpenedStore {
  return openStoreDb({ path, schema: KNOWLEDGE_SCHEMA, tokenizer: resolveFtsTokenizer() })
}
