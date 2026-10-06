/**
 * Memory DB schema.
 *
 * `DDL` is the BASE schema (migration 1) and stays idempotent: databases created before the
 * versioning mechanism existed report `user_version = 0` while already holding these tables,
 * so adopting them must be a no-op plus a version stamp (see `migrations.ts`). Later schema
 * changes belong in a numbered migration — `ONE_OPEN_CONTRADICTION_ROW_SQL` below is v2.
 */

export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS facts (
    fact_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    content           TEXT NOT NULL UNIQUE,
    category          TEXT DEFAULT 'general',
    tags              TEXT DEFAULT '',
    trust_score       REAL DEFAULT 0.5,   -- settlement value, see settle_clock
    settle_clock      REAL NOT NULL,       -- active-day clock at the last settle; NO DEFAULT (R1/S1)
    pinned            INTEGER DEFAULT 0,   -- permanent memory (never decays / auto-archives / purges)
    pinned_at         TIMESTAMP,
    bonus_count       INTEGER DEFAULT 0,   -- effective reinforcement events in the current window
    bonus_window_at   TIMESTAMP,           -- calendar start of that 24h window (add writes it, R25)
    last_reinforced_at TIMESTAMP,
    archived_clock    REAL,                -- active-day clock at archive time (purge window, R19)
    retrieval_count   INTEGER DEFAULT 0,
    helpful_count     INTEGER DEFAULT 0,
    last_retrieved_at TIMESTAMP,
    hrr_vector        BLOB,
    semantic_vector   BLOB,
    embedding_model   TEXT,
    vector_store      TEXT DEFAULT 'local_numpy',
    status            TEXT DEFAULT 'active',
    -- PLAIN column, deliberately NOT a self-reference to facts(fact_id): that FK was
    -- ON DELETE NO ACTION, so once a revision chain crossed purge_after_archived_days the
    -- archived half could not be deleted — the FK failed, rolled back the whole tick
    -- transaction, and (because the tick runs from the store's constructor) stopped the process
    -- from starting. purgeArchived now clears this column before deleting, and toDetail renders
    -- NULL as "no predecessor". Databases created before this change still carry the FK (SQLite
    -- cannot drop one without a table rebuild); they rely on the same unlink step.
    supersedes_id     INTEGER,
    -- Derived-state provenance, the memory-side counterpart of doc_chunks.entities_version:
    -- which extraction rules produced this row's fact_entities/triples, and whether the
    -- EMBEDDING leg of the conflict check has run against this row's CURRENT vector. Without the
    -- first, changing the rules could never reach facts already written; without the second,
    -- "awaiting the embedder" lived only in an in-process Set and was lost on every restart.
    --
    -- NOT NULL DEFAULT 0, unlike the knowledge side's nullable column: the sweep's predicate is
    -- "entities_version < ?", and NULL < ? is NULL in SQLite, so ONE row written by a pre-v6
    -- process during a rolling upgrade would be invisible to every future sweep while
    -- countStaleEntities reported it as clean. The default also means an older build's INSERT
    -- (which does not name this column) is adopted by the first sweep rather than exempted.
    entities_version  INTEGER NOT NULL DEFAULT 0,
    conflict_checked  INTEGER NOT NULL DEFAULT 0,
    archived_at       TIMESTAMP,
    archive_reason    TEXT,
    ttl_days          INTEGER DEFAULT 0,
    -- P-07/P-13: when the fact became true and when it stopped being true. NULL = unknown, and no
    -- retrieval leg reads either column (the envelope only carries them, and only when non-null).
    -- valid_to is written by mem_remember valid_until WITHOUT archiving the row, which is what
    -- makes "still active, known to end at T" representable at all; the two archival paths
    -- (supersede, contradiction verdict) also stamp it for audit.
    valid_from        TIMESTAMP,
    valid_to          TIMESTAMP,
    -- P-10: how many times this exact content has been asserted. DEFAULT 1 because every row that
    -- predates the counter was asserted once; a verbatim duplicate add moves it (+1) while
    -- reviving an archived row does not (that is a resurrection, not a new assertion). Never scored.
    assert_count      INTEGER DEFAULT 1,
    mirror_source     TEXT,
    mirror_target     TEXT,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_facts_status_category ON facts(status, category)`,
  // Serves `purgeArchived`'s unlink lookup, and on pre-existing databases it keeps the legacy
  // NO ACTION check an index seek. Do NOT drop it on those: without it every deleted parent row
  // scans `facts` to look for children (measured 119x slower on purge).
  `CREATE INDEX IF NOT EXISTS idx_facts_supersedes ON facts(supersedes_id)`,
  `CREATE INDEX IF NOT EXISTS idx_facts_trust ON facts(status, pinned, settle_clock)`,
  // `mem_admin list` orders by `created_at DESC` with a status filter; without this the planner
  // sorted every ACTIVE row (a temp b-tree) — measured 124 ms at 33k facts against 2.1 ms with it.
  `CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(status, created_at DESC)`,
  // NO `idx_facts_idle`: the idle predicate wraps `last_retrieved_at` in `COALESCE` + `julianday`
  // (see `FactsDao.archiveIdle`), so a plain column index could never serve it. What CAN serve it
  // is an expression index on exactly the expression the predicate compares — see below.
  `CREATE INDEX IF NOT EXISTS idx_facts_ttl ON facts(status, ttl_days)`,
  `CREATE INDEX IF NOT EXISTS idx_facts_purge ON facts(status, pinned, archived_clock)`,
  // ③ forgetting by settled trust. Without this the tick read every ACTIVE unpinned row to find
  // the few below the threshold (measured 18.6–27.4 ms at 180k, with zero matches).
  `CREATE INDEX IF NOT EXISTS idx_facts_forget ON facts(status, pinned, trust_score)`,
  // ④ the idle sweep, as an EXPRESSION index: the predicate compares
  // `julianday(COALESCE(last_retrieved_at, created_at))` against a cutoff, so the index must carry
  // that same expression to be usable. The predicate is written in the matching order
  // (`<expr> < julianday('now', …)`) so this is a range seek, not a per-row function call.
  `CREATE INDEX IF NOT EXISTS idx_facts_idle_cutoff ON facts(status, pinned, julianday(COALESCE(last_retrieved_at, created_at)))`,
  // The two "how much reinforcement quota is live" diagnostics share one window predicate
  // (`bonus_window_at > datetime('now', '-1 day')`); windowed rows are a small minority.
  `CREATE INDEX IF NOT EXISTS idx_facts_bonus_window ON facts(bonus_window_at)`,
  // P-08: where a fact came from — one row per (fact, kind, ref). `kind` is a closed vocabulary
  // (`session` / `kb_doc` / `tool` / `manual`); the composite PRIMARY KEY makes a repeated write
  // idempotent and serves the forward direction (a fact's sources), while the separate `ref` index
  // serves the reverse one (`admin list source=`).
  `CREATE TABLE IF NOT EXISTS fact_sources (
    fact_id INTEGER NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
    kind    TEXT NOT NULL CHECK (kind IN ('session', 'kb_doc', 'tool', 'manual')),
    ref     TEXT NOT NULL,
    PRIMARY KEY (fact_id, kind, ref)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fact_sources_ref ON fact_sources(ref)`,
  // The derived-state sweep and drain indexes (`idx_facts_entities_version`,
  // `idx_facts_conflict_pending`) are deliberately NOT part of the base DDL: step 1 must stay
  // runnable against a pre-versioning database whose `facts` lacks these columns, and migration
  // step 6 creates both AFTER adding them. A fresh database runs every step from version 0, so
  // it still ends up with both indexes.
  `CREATE TABLE IF NOT EXISTS entities (
    entity_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL UNIQUE,
    entity_type       TEXT DEFAULT 'unknown',
    aliases           TEXT DEFAULT '',
    extraction_method TEXT DEFAULT 'regex',
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS fact_entities (
    fact_id   INTEGER REFERENCES facts(fact_id) ON DELETE CASCADE,
    entity_id INTEGER REFERENCES entities(entity_id) ON DELETE CASCADE,
    PRIMARY KEY (fact_id, entity_id)
  )`,
  // Lookups BY ENTITY (`jaccardPath`, `related`, and the write-path contradiction
  // candidates) join on `entity_id`, which the (fact_id, entity_id) primary key cannot
  // serve — without this, each of them scans the whole link table.
  `CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities(entity_id)`,
  `CREATE TABLE IF NOT EXISTS triples (
    triple_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id    INTEGER NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
    subj       TEXT NOT NULL,
    pred       TEXT NOT NULL,
    obj        TEXT NOT NULL,
    confidence REAL DEFAULT 0.5,
    source     TEXT DEFAULT 'heuristic',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (fact_id, subj, pred, obj)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_triples_subj ON triples(subj, pred)`,
  `CREATE INDEX IF NOT EXISTS idx_triples_obj ON triples(obj, pred)`,
  `CREATE INDEX IF NOT EXISTS idx_triples_fact ON triples(fact_id)`,
  `CREATE TABLE IF NOT EXISTS contradiction_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_a        INTEGER REFERENCES facts(fact_id) ON DELETE CASCADE,
    fact_b        INTEGER REFERENCES facts(fact_id) ON DELETE CASCADE,
    score         REAL,
    detected_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved      INTEGER DEFAULT 0,
    loser_fact_id INTEGER REFERENCES facts(fact_id) ON DELETE SET NULL,
    resolution    TEXT,
    resolved_at   TIMESTAMP,
    -- WHO closed the pair: 'auto' when a fact simply left the active corpus (re-loggable if it
    -- comes back), 'verdict' for an explicit adjudication (a sweep must not re-open it).
    resolved_by   TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contradict_loser ON contradiction_log(loser_fact_id)`,
  // NON-partial, one per side. `idx_contradict_open_pair` is UNIQUE and partial (it enforces one
  // OPEN row per pair), which means the planner cannot use it for the two shapes that matter:
  //   - `(fact_a = ? OR fact_b = ?) AND (resolved = 0 OR resolved_by = 'verdict')` — the
  //     `OR resolved_by` disjunct does not imply `resolved = 0`;
  //   - the FK CASCADE checks for `fact_a`/`fact_b`, which also cannot use a partial index.
  // Two plain indexes give both shapes a MULTI-INDEX OR: measured `openConflictsFor` 5.05 → 0.04 ms
  // and `resolveForFact` 9.4 → 0.14 ms at 100k open pairs (scripts/bench-indexes.mjs).
  `CREATE INDEX IF NOT EXISTS idx_contradict_fact_a ON contradiction_log(fact_a)`,
  `CREATE INDEX IF NOT EXISTS idx_contradict_fact_b ON contradiction_log(fact_b)`,
  // The `resolved` dimension had no index at all, and both of its readers are unbounded:
  // `list(resolved=1)` sorted the whole log through a temp b-tree, and `suppressedPairs`'
  // `resolved = 0 OR resolved_by = 'verdict'` could not use the partial UNIQUE index for the OR.
  // The log only shrinks when a purge cascades, so between two purges it grows without limit.
  `CREATE INDEX IF NOT EXISTS idx_contradict_resolved_score ON contradiction_log(resolved, score DESC)`,
  // Partial, and exactly the OR's second branch, so `suppressedPairs` becomes a MULTI-INDEX OR
  // (this index ∪ `idx_contradict_open_pair`) instead of a full scan of the log.
  `CREATE INDEX IF NOT EXISTS idx_contradict_verdict ON contradiction_log(fact_a, fact_b) WHERE resolved_by = 'verdict'`,
  `CREATE TABLE IF NOT EXISTS avantf_stats (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS eval_results (
    eval_run_id    TEXT,
    query_id       TEXT,
    expected_ids   TEXT,
    actual_ids     TEXT,
    precision_at_k REAL,
    recall_at_k    REAL,
    mrr            REAL,
    ran_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (eval_run_id, query_id)
  )`,
]

/**
 * v2 — at most one OPEN row per contradiction pair.
 *
 * The in-process `suppressedPairs` dedupe cannot see another process, and the dsh host, the CLI
 * and the MCP server all open this same database. Resolved rows are exempt, so a pair may
 * legitimately be re-opened after it was retired (archive → restore → re-detect). The DELETE
 * runs first because a database written by an older build may already hold duplicates for an
 * open pair, and `CREATE UNIQUE INDEX` would then refuse to build at all.
 */
export const ONE_OPEN_CONTRADICTION_ROW_SQL: string[] = [
  `DELETE FROM contradiction_log
     WHERE resolved = 0
       AND id NOT IN (SELECT MIN(id) FROM contradiction_log WHERE resolved = 0 GROUP BY fact_a, fact_b)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contradict_open_pair ON contradiction_log(fact_a, fact_b) WHERE resolved = 0`,
]

/**
 * The external-content FTS5 table. Created separately from {@link DDL} because the
 * tokenizer is chosen at open time by the runtime self-check (`resolveFtsTokenizer`)
 * — a build without `trigram` must not make the store unopenable (DESIGN §16).
 */
export function factsFtsTableDdl(tokenizer: string): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    content,
    content='facts',
    content_rowid='fact_id',
    tokenize='${tokenizer}'
  )`
}

export const FTS_TRIGGERS: string[] = [`CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, content) VALUES (new.fact_id, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, content)
      VALUES ('delete', old.fact_id, old.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE OF content ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, content)
      VALUES ('delete', old.fact_id, old.content);
    INSERT INTO facts_fts(rowid, content) VALUES (new.fact_id, new.content);
  END`,
]
