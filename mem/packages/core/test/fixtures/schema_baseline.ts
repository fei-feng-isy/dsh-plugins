/**
 * The OLDEST schema this build promises to be able to upgrade from: a database at
 * `user_version` 1 — the base DDL with every object that a numbered migration introduced
 * removed, so the numbered steps have real mission to do when the guard upgrades it. Captured from
 * `sqlite_master` (comments stripped, creation order).
 *
 * This file is the fixed reference the upgrade-parity guard (`db_upgrade_parity.spec.ts`) builds
 * its "old database" from. It is deliberately NOT derived from the live schema at test time and
 * must NOT be regenerated to make a red guard green: the whole point is that a database created by
 * an OLDER build must reach the CURRENT schema through the numbered steps. A column, table or
 * index added to the base DDL `DDL`/`KNOWLEDGE_DDL` without a matching migration is invisible to a
 * fresh database (step 1 runs there) and invisible to this fixture (step 1 does not re-run on it);
 * the guard compares the two schemas and fails.
 *
 * Regenerate ONLY when deliberately dropping support for upgrading from this baseline, and treat
 * the regeneration as the "oldest supported version" bump it is.
 *
 * The FTS virtual tables (`facts_fts` / `doc_chunks_fts`), their shadow tables and
 * `schema_migrations` are excluded: the virtual tables are created through the live
 * tokenizer-aware helper (a build without `trigram` must still open the store), the shadow tables
 * are implicit, and the audit table is created by `migrate` itself. The guard excludes the same
 * names from its comparison.
 */

/** One `sqlite_master` row: the object's kind, its name, and its CREATE statement. */
export interface BaselineSchemaObject {
  readonly type: 'table' | 'index' | 'trigger'
  readonly name: string
  readonly sql: string
}

/** Step 1 of `MEMORY_SCHEMA` as this fixture froze it: the base DDL minus every later step's mission. */
export const MEMORY_BASELINE_V1: readonly BaselineSchemaObject[] = [
  { type: "table", name: "facts", sql: "CREATE TABLE facts (fact_id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL UNIQUE, category TEXT DEFAULT 'general', tags TEXT DEFAULT '', trust_score REAL DEFAULT 0.5, settle_clock REAL NOT NULL, pinned INTEGER DEFAULT 0, pinned_at TIMESTAMP, bonus_count INTEGER DEFAULT 0, bonus_window_at TIMESTAMP, last_reinforced_at TIMESTAMP, archived_clock REAL, retrieval_count INTEGER DEFAULT 0, helpful_count INTEGER DEFAULT 0, last_retrieved_at TIMESTAMP, hrr_vector BLOB, semantic_vector BLOB, embedding_model TEXT, vector_store TEXT DEFAULT 'local_numpy', status TEXT DEFAULT 'active', supersedes_id INTEGER, archived_at TIMESTAMP, archive_reason TEXT, ttl_days INTEGER DEFAULT 0, mirror_source TEXT, mirror_target TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)" },
  { type: "index", name: "idx_facts_status_category", sql: "CREATE INDEX idx_facts_status_category ON facts(status, category)" },
  { type: "index", name: "idx_facts_supersedes", sql: "CREATE INDEX idx_facts_supersedes ON facts(supersedes_id)" },
  { type: "index", name: "idx_facts_trust", sql: "CREATE INDEX idx_facts_trust ON facts(status, pinned, settle_clock)" },
  { type: "index", name: "idx_facts_ttl", sql: "CREATE INDEX idx_facts_ttl ON facts(status, ttl_days)" },
  { type: "index", name: "idx_facts_purge", sql: "CREATE INDEX idx_facts_purge ON facts(status, pinned, archived_clock)" },
  { type: "table", name: "entities", sql: "CREATE TABLE entities ( entity_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, entity_type TEXT DEFAULT 'unknown', aliases TEXT DEFAULT '', extraction_method TEXT DEFAULT 'regex', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP )" },
  { type: "table", name: "fact_entities", sql: "CREATE TABLE fact_entities ( fact_id INTEGER REFERENCES facts(fact_id) ON DELETE CASCADE, entity_id INTEGER REFERENCES entities(entity_id) ON DELETE CASCADE, PRIMARY KEY (fact_id, entity_id) )" },
  { type: "index", name: "idx_fact_entities_entity", sql: "CREATE INDEX idx_fact_entities_entity ON fact_entities(entity_id)" },
  { type: "table", name: "triples", sql: "CREATE TABLE triples ( triple_id INTEGER PRIMARY KEY AUTOINCREMENT, fact_id INTEGER NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE, subj TEXT NOT NULL, pred TEXT NOT NULL, obj TEXT NOT NULL, confidence REAL DEFAULT 0.5, source TEXT DEFAULT 'heuristic', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE (fact_id, subj, pred, obj) )" },
  { type: "index", name: "idx_triples_subj", sql: "CREATE INDEX idx_triples_subj ON triples(subj, pred)" },
  { type: "index", name: "idx_triples_obj", sql: "CREATE INDEX idx_triples_obj ON triples(obj, pred)" },
  { type: "index", name: "idx_triples_fact", sql: "CREATE INDEX idx_triples_fact ON triples(fact_id)" },
  { type: "table", name: "contradiction_log", sql: "CREATE TABLE contradiction_log (id INTEGER PRIMARY KEY AUTOINCREMENT, fact_a INTEGER REFERENCES facts(fact_id) ON DELETE CASCADE, fact_b INTEGER REFERENCES facts(fact_id) ON DELETE CASCADE, score REAL, detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, resolved INTEGER DEFAULT 0, loser_fact_id INTEGER REFERENCES facts(fact_id) ON DELETE SET NULL, resolution TEXT, resolved_at TIMESTAMP)" },
  { type: "index", name: "idx_contradict_loser", sql: "CREATE INDEX idx_contradict_loser ON contradiction_log(loser_fact_id)" },
  { type: "table", name: "avantf_stats", sql: "CREATE TABLE avantf_stats ( key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP )" },
  { type: "table", name: "eval_results", sql: "CREATE TABLE eval_results ( eval_run_id TEXT, query_id TEXT, expected_ids TEXT, actual_ids TEXT, precision_at_k REAL, recall_at_k REAL, mrr REAL, ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (eval_run_id, query_id) )" },
  { type: "trigger", name: "facts_ai", sql: "CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts(rowid, content) VALUES (new.fact_id, new.content); END" },
  { type: "trigger", name: "facts_ad", sql: "CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.fact_id, old.content); END" },
  { type: "trigger", name: "facts_au", sql: "CREATE TRIGGER facts_au AFTER UPDATE OF content ON facts BEGIN INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.fact_id, old.content); INSERT INTO facts_fts(rowid, content) VALUES (new.fact_id, new.content); END" },
  { type: "index", name: "idx_facts_idle", sql: "CREATE INDEX idx_facts_idle ON facts(status, pinned, last_retrieved_at)" },
]

/** Step 1 of `KNOWLEDGE_SCHEMA` as this fixture froze it. */
export const KNOWLEDGE_BASELINE_V1: readonly BaselineSchemaObject[] = [
  { type: "table", name: "documents", sql: "CREATE TABLE documents ( doc_id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, source_uri TEXT, meta TEXT DEFAULT '', status TEXT DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE (domain, source, title) )" },
  { type: "index", name: "idx_documents_domain_source", sql: "CREATE INDEX idx_documents_domain_source ON documents(domain, source)" },
  { type: "table", name: "doc_chunks", sql: "CREATE TABLE doc_chunks (chunk_id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE, idx INTEGER NOT NULL, text TEXT NOT NULL, headings_path TEXT DEFAULT '', source_ref TEXT NOT NULL, char_start INTEGER DEFAULT 0, char_end INTEGER DEFAULT 0, semantic_vector BLOB)" },
  { type: "index", name: "idx_doc_chunks_doc", sql: "CREATE INDEX idx_doc_chunks_doc ON doc_chunks(doc_id)" },
  { type: "table", name: "chunk_entities", sql: "CREATE TABLE chunk_entities ( chunk_id INTEGER NOT NULL REFERENCES doc_chunks(chunk_id) ON DELETE CASCADE, name TEXT NOT NULL, PRIMARY KEY (chunk_id, name) )" },
  { type: "index", name: "idx_chunk_entities_name", sql: "CREATE INDEX idx_chunk_entities_name ON chunk_entities(name)" },
  { type: "trigger", name: "chunks_ai", sql: "CREATE TRIGGER chunks_ai AFTER INSERT ON doc_chunks BEGIN INSERT INTO doc_chunks_fts(rowid, text) VALUES (new.chunk_id, new.text); END" },
  { type: "trigger", name: "chunks_ad", sql: "CREATE TRIGGER chunks_ad AFTER DELETE ON doc_chunks BEGIN INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, text) VALUES('delete', old.chunk_id, old.text); END" },
  { type: "trigger", name: "chunks_au", sql: "CREATE TRIGGER chunks_au AFTER UPDATE OF text ON doc_chunks BEGIN INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, text) VALUES('delete', old.chunk_id, old.text); INSERT INTO doc_chunks_fts(rowid, text) VALUES (new.chunk_id, new.text); END" },
]
