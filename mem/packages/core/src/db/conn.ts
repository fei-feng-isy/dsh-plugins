/**
 * The memory store's database: its schema (as ordered migrations) and the open entry point.
 *
 * The lifecycle itself (pragmas, version check, step execution, clean failure) lives in
 * `store.ts` / `migrations.ts`; this module only declares what the memory schema IS — the
 * same split the knowledge store uses, so neither can drift into its own private open path.
 */
import { DDL, FTS_TRIGGERS, ONE_OPEN_CONTRADICTION_ROW_SQL, factsFtsTableDdl } from './schema.js'
import { addColumnIfMissing } from './migrations.js'
import { openStoreDb, type OpenedStore, type StoreSchema } from './store.js'
import { resolveFtsTokenizer, type FtsTokenizer } from './tokenizer.js'

export type { Db, DbStatement, DbRunResult } from './port.js'
export type { FtsTokenizer }

/**
 * Ordered schema steps. Step 1 is the base schema and MUST stay idempotent: a database
 * created before this mechanism existed reports `user_version = 0` while already holding it.
 */
export const MEMORY_SCHEMA: StoreSchema = {
  describe: 'memory (facts / entities / triples / contradictions / stats)',
  migrations: [
    {
      version: 1,
      name: 'base-schema',
      up: (db, ctx: { tokenizer: FtsTokenizer }) => {
        for (const ddl of DDL) db.exec(ddl)
        // DESIGN §16: the tokenizer is chosen BEFORE the DDL — `CREATE VIRTUAL TABLE …
        // tokenize='trigram'` throws on a build without it, so probing afterwards made the
        // graceful-degradation warning unreachable.
        db.exec(factsFtsTableDdl(ctx.tokenizer))
        for (const trigger of FTS_TRIGGERS) db.exec(trigger)
      },
    },
    {
      version: 2,
      name: 'one-open-contradiction-row-per-pair',
      up: (db) => {
        // Dedupe first, then enforce: the DELETE is what makes the index buildable on a
        // database written by the older build.
        for (const sql of ONE_OPEN_CONTRADICTION_ROW_SQL) db.exec(sql)
      },
    },
    {
      version: 3,
      name: 'conflict-verdict-provenance',
      up: (db) => {
        addColumnIfMissing(db, 'contradiction_log', 'resolved_by', 'TEXT')
        // Backfill, rather than a column default: every pair closed before this column existed
        // WAS an automatic retirement (explicit adjudication did not exist yet), and marking
        // only the closed rows keeps "who closed it" NULL for pairs that are still open.
        db.exec("UPDATE contradiction_log SET resolved_by = 'auto' WHERE resolved = 1")
      },
    },
    {
      version: 4,
      name: 'listing-order-and-conflict-lookup-indexes',
      up: (db) => {
        // ① `list` ordered every ACTIVE row through a temp b-tree because no index carried
        // `created_at` (measured 124 ms at 33k facts against 2.1 ms with it).
        db.exec('CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(status, created_at DESC)')
        // ② a DEAD index: the idle predicate wraps its column in `COALESCE` + `julianday`, so no
        // query could use it, while every `touchUsage` (each recall) paid to maintain it.
        db.exec('DROP INDEX IF EXISTS idx_facts_idle')
        // ③ the two conflict-lookup shapes — and the FK cascade checks — cannot use the partial
        // UNIQUE index (see the DDL comment). Plain indexes per side make them a MULTI-INDEX OR
        // instead of a full scan of the log.
        db.exec('CREATE INDEX IF NOT EXISTS idx_contradict_fact_a ON contradiction_log(fact_a)')
        db.exec('CREATE INDEX IF NOT EXISTS idx_contradict_fact_b ON contradiction_log(fact_b)')
      },
    },
    {
      version: 5,
      name: 'tick-scan-indexes',
      up: (db) => {
        // The lifecycle tick's ③④ and the two reinforcement diagnostics each read the whole
        // ACTIVE set to find a small subset. Paired with the sargable rewrites in `FactsDao`
        // (the idle one is an expression index, so the predicate must compare that exact
        // expression — see the DDL comment).
        db.exec('CREATE INDEX IF NOT EXISTS idx_facts_forget ON facts(status, pinned, trust_score)')
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_facts_idle_cutoff ON facts(status, pinned, julianday(COALESCE(last_retrieved_at, created_at)))',
        )
        db.exec('CREATE INDEX IF NOT EXISTS idx_facts_bonus_window ON facts(bonus_window_at)')
      },
    },
    {
      version: 6,
      name: 'fact-derived-state-provenance',
      up: (db) => {
        // Which extraction rules produced a fact's entity/triple rows, and whether the embedding
        // leg of its conflict check has run. Also in the base DDL, so a fresh database gets them
        // from step 1 and this is a no-op there.
        //
        // `entities_version` is NOT NULL DEFAULT 0: the ALTER gives every EXISTING row 0 ("older
        // than any rule set") so the first sweep adopts the corpus exactly once, and it gives
        // every FUTURE row 0 even when the INSERT does not name the column — which is what a
        // pre-v6 process sharing the database during a rolling upgrade does. A nullable column
        // would make those rows invisible to `entities_version < ?` forever (NULL compares NULL).
        addColumnIfMissing(db, 'facts', 'entities_version', 'INTEGER NOT NULL DEFAULT 0')
        addColumnIfMissing(db, 'facts', 'conflict_checked', 'INTEGER NOT NULL DEFAULT 0')
        // Repair for a database that already ran an earlier revision of THIS step, which added
        // `entities_version` as a plain nullable INTEGER: the rows it left NULL are exactly the
        // ones the predicate cannot see, and the ALTER above is skipped for them.
        db.exec('UPDATE facts SET entities_version = 0 WHERE entities_version IS NULL')
        // NO backfill for `conflict_checked`, deliberately — and this is the one place the
        // obvious choice is the wrong one.
        //
        // The tempting argument is "a row with a vector was written by a build whose write path
        // ran the check, so mark it checked and skip re-checking the corpus once". It does not
        // hold, because the marker claims something stronger than "a check ran": it claims the
        // check ran against THIS row's vector, and the embedding leg is scored from the LIVE
        // INDEX, not from the column. The database cannot answer "can the index serve this blob" —
        // it can be a vector from another space, or one the index dropped while it was rebuilt —
        // and the migration cannot either, since the current vector space is derived from the
        // config and the loaded model, neither of which exists at open time.
        //
        // So the cost of guessing wrong is a permanent exemption for a row that was never
        // checked, which is exactly the silent loss this queue was introduced to end. The cost of
        // not guessing is one bounded catch-up pass over the rows that HAVE a vector (the drain is
        // budgeted, and `pendingConflictRows` requires `semantic_vector IS NOT NULL`, so rows
        // awaiting the embedder behave as they already did). Pay that.
        db.exec('CREATE INDEX IF NOT EXISTS idx_facts_entities_version ON facts(entities_version, fact_id)')
        // Partial (see the DDL comment): it covers the pending set, not the corpus.
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_facts_conflict_pending ON facts(status, fact_id) WHERE conflict_checked = 0',
        )
      },
    },
    {
      version: 7,
      name: 'conflict-pending-index-partial',
      up: (db) => {
        // An INTERMEDIATE revision of step 6 (never committed, but applied by any database that ran
        // that build — including this repo's own dev/scratch stores) created this name over
        // `(status, conflict_checked, semantic_vector)`: a 2 KB BLOB per row in the key for a query
        // that selects `content` and therefore can never get a covering plan either. Step 6's
        // `CREATE INDEX IF NOT EXISTS` cannot repair it, because IF NOT EXISTS matches the NAME and
        // the name is already there; and re-running step 6 is not on the table anyway, since such a
        // database sits at `user_version = 6`. Hence a step of its own, which is what a redefined
        // index costs in a versioned schema (step 5's `DROP INDEX IF EXISTS idx_facts_idle` is the
        // same move).
        //
        // Idempotent by construction: a fresh or v5 database already has the partial form from the
        // DDL / step 6, so this drops it and creates the identical thing.
        db.exec('DROP INDEX IF EXISTS idx_facts_conflict_pending')
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_facts_conflict_pending ON facts(status, fact_id) WHERE conflict_checked = 0',
        )
      },
    },
    {
      version: 8,
      name: 'facts-fts-rebuild',
      up: (db) => {
        // `facts_ai` / `facts_ad` / `facts_au` keep the FTS index in step with the table, so a
        // database that has always run this schema needs nothing from this step. One that predates
        // those triggers — the pre-versioning era, or a store whose triggers were lost — holds rows
        // in `facts` with an EMPTY `facts_fts`, which silently costs it the whole FTS leg: hybrid
        // search keeps working from the entity/semantic legs, so nothing reports the loss.
        //
        // FTS5's `'rebuild'` re-derives the index from the external content table
        // (`content='facts'`), which is exactly the repair, and it is idempotent: on a fresh or
        // already-indexed database it changes nothing and just walks the corpus once. That walk is
        // the one-time cost of not being able to answer "was this ever indexed" from the schema.
        db.exec("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')")
      },
    },
    {
      version: 9,
      name: 'contradiction-resolved-indexes',
      up: (db) => {
        // Both in the base DDL too, so a fresh database gets them from step 1 and this is a no-op
        // there (the same arrangement as step 6's provenance columns).
        //
        // `list(resolved=1) ORDER BY score DESC` sorted the whole log through a temp b-tree, and
        // `suppressedPairs`' `resolved = 0 OR resolved_by = 'verdict'` fell back to a full scan
        // because an OR is only index-served when EVERY branch is. The detector calls
        // `suppressedPairs` once per pass, so the cost tracked the log's size — which only shrinks
        // when a purge cascades.
        db.exec('CREATE INDEX IF NOT EXISTS idx_contradict_resolved_score ON contradiction_log(resolved, score DESC)')
        db.exec(
          "CREATE INDEX IF NOT EXISTS idx_contradict_verdict ON contradiction_log(fact_a, fact_b) WHERE resolved_by = 'verdict'",
        )
      },
    },
    {
      version: 10,
      name: 'fact-validity-sources-and-assert-count',
      up: (db) => {
        // Batch 1 lands in ONE step on purpose: `valid_from` / `valid_to` (P-07/P-13),
        // `assert_count` (P-10) and the `fact_sources` table (P-08) are one schema generation, and
        // splitting them would make every store pay two ALTER rounds for one release.
        //
        // All three columns are in the base DDL too, so a fresh database gets them from step 1 and
        // this step is a no-op there (the same arrangement as step 6's provenance columns).
        //
        // `valid_from` / `valid_to` are NULLABLE with NO default: NULL means "unknown", and the
        // retrieval legs must not grow a time predicate from this migration (P-07 is display/audit
        // only). `assert_count` is NOT NULL-by-default 1 — "asserted once" is the honest value for
        // every row that predates the counter, and `ALTER TABLE … DEFAULT 1` backfills exactly that
        // for existing rows while an INSERT that does not name the column still gets 1 (P-10).
        addColumnIfMissing(db, 'facts', 'valid_from', 'TIMESTAMP')
        addColumnIfMissing(db, 'facts', 'valid_to', 'TIMESTAMP')
        addColumnIfMissing(db, 'facts', 'assert_count', 'INTEGER DEFAULT 1')
        db.exec('UPDATE facts SET assert_count = 1 WHERE assert_count IS NULL')
        // The provenance of a fact: one row per (fact, kind, ref). `kind` is a closed set so a
        // future reader can trust the vocabulary; the composite PRIMARY KEY also makes a repeated
        // write idempotent without a separate dedupe query.
        db.exec(`CREATE TABLE IF NOT EXISTS fact_sources (
            fact_id INTEGER NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
            kind    TEXT NOT NULL CHECK (kind IN ('session', 'kb_doc', 'tool', 'manual')),
            ref     TEXT NOT NULL,
            PRIMARY KEY (fact_id, kind, ref)
          )`)
        // Reverse lookup: "which facts came from this source" (`admin list source=`), and the
        // coverage EXISTS predicate. `fact_id` leads the composite PK, so the forward direction is
        // already served.
        db.exec('CREATE INDEX IF NOT EXISTS idx_fact_sources_ref ON fact_sources(ref)')
      },
    },
  ],
}

/** Open (or create) the memory DB, bringing its schema up to the current version. */
export function openMemoryDb(path: string): OpenedStore['db'] {
  return openMemoryStore(path).db
}

/** Open and report which migrations ran (tests, and any explicit upgrade path). */
export function openMemoryStore(path: string): OpenedStore {
  return openStoreDb({ path, schema: MEMORY_SCHEMA, tokenizer: resolveFtsTokenizer() })
}
