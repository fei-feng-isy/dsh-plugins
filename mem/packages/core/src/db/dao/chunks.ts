/**
 * `doc_chunks` + `chunk_entities` + the `doc_chunks_fts` index — the knowledge read model.
 *
 * Every id list here is batched (`batches()`): candidate sets are derived from the CORPUS
 * (entity overlap, semantic top-k), not from the request, so a plain `IN (…)` would trip
 * SQLite's bind-parameter cap on a large store. That failure is silent on the search path
 * (it just drops a leg), which is exactly what batching prevents.
 */
import type { DocumentChunk } from '@avantf/mem-contract'
import type { Db } from '../port.js'
import { batches, inList } from '../chunk.js'
import { contentHash } from '../hash.js'
import { entityBags, entityCandidateTail, entityCandidates, likeSubstringLeg, queryDocFrequency, setEntitiesVersionBatch } from './shared.js'

/** One chunk to persist, in document order (`idx` is the position, not the array index). */
interface ChunkInsert {
  idx: number
  text: string
  headingsPath: string
  sourceRef: string
  charStart: number
  charEnd: number
}

/**
 * A chunk plus the state of everything DERIVED from it (DESIGN §20).
 *
 * `content_hash` says which text the derivations were built from, `embedding_model` which
 * vector space they live in, `entities_version` which extraction rules produced the entity
 * rows. `reindex` decides per row what actually needs redoing from these; without them it has
 * to assume every row is stale and pay for the whole corpus.
 */
export interface ChunkStateRow {
  chunk_id: number
  text: string
  content_hash: string | null
  embedding_model: string | null
  entities_version: number | null
  /** `1` when a non-NULL vector blob is stored (SQLite has no boolean). */
  has_vector: number
}

/** A persisted chunk with the entity names extracted at ingest time. */
interface ChunkEntityRow {
  chunk_id: number
  names: readonly string[]
}

/** A search hit row: chunk body plus the owning document's identity. */
export interface ChunkHitRow {
  chunk_id: number
  text: string
  source_ref: string
  domain: string
  source: string
  created_at: string | null
  updated_at: string | null
}

export class ChunksDao {
  constructor(private readonly db: Db) {}

  idsForDoc(docId: number): number[] {
    return this.db
      .prepare<{ chunk_id: number }>('SELECT chunk_id FROM doc_chunks WHERE doc_id = ?')
      .all(docId)
      .map((r) => r.chunk_id)
  }

  /** Re-ingest replaces the chunk set wholesale (entities/FTS follow via cascade/triggers). */
  deleteForDoc(docId: number): void {
    this.db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(docId)
  }

  /** Insert the doc's chunks in one statement per chunk; returns the new ids in order. */
  insertMany(docId: number, chunks: readonly ChunkInsert[]): number[] {
    const ins = this.db.prepare(
      'INSERT INTO doc_chunks (doc_id, idx, text, headings_path, source_ref, char_start, char_end, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const ids: number[] = []
    for (const c of chunks) {
      const info = ins.run(docId, c.idx, c.text, c.headingsPath, c.sourceRef, c.charStart, c.charEnd, contentHash(c.text))
      ids.push(Number(info.lastInsertRowid))
    }
    return ids
  }

  /** Chunk bodies by id (entity extraction + vector encoding after ingest). */
  texts(ids: readonly number[]): { chunk_id: number; text: string }[] {
    const out: { chunk_id: number; text: string }[] = []
    for (const batch of batches(ids)) {
      const { placeholders, values } = inList(batch)
      out.push(
        ...this.db
          .prepare<{ chunk_id: number; text: string }>(`SELECT chunk_id, text FROM doc_chunks WHERE chunk_id IN (${placeholders})`)
          .all(...values),
      )
    }
    return out
  }

  /** Chunk rows for the catalog detail view, in document order (`DocumentDetail.chunks`). */
  rowsForDoc(docId: number): DocumentChunk[] {
    return this.db
      .prepare<DocumentChunk>('SELECT chunk_id, idx, text, headings_path, source_ref FROM doc_chunks WHERE doc_id = ? ORDER BY idx')
      .all(docId)
  }

  /** Persist a chunk vector together with the vector space it belongs to. */
  setVector(chunkId: number, bytes: Buffer, embeddingModel: string): void {
    this.db
      .prepare('UPDATE doc_chunks SET semantic_vector = ?, embedding_model = ? WHERE chunk_id = ?')
      .run(bytes, embeddingModel, chunkId)
  }

  /**
   * The doc's chunks WITH their stored vectors — the reuse index for a re-ingest.
   *
   * A re-ingest deletes and re-inserts every chunk (new ids), so without this the only way to keep a
   * vector is to re-encode the same text; `vectorReusable` already knows how to tell "unchanged", but
   * only `reindex` could use it. Read BEFORE the replace, inside its transaction.
   */
  vectorStateForDoc(docId: number): (ChunkStateRow & { vec: Buffer | null })[] {
    return this.db
      .prepare<ChunkStateRow & { vec: Buffer | null }>(
        `SELECT dc.chunk_id AS chunk_id, dc.text AS text, dc.content_hash AS content_hash,
                dc.embedding_model AS embedding_model, dc.entities_version AS entities_version,
                (dc.semantic_vector IS NOT NULL) AS has_vector, dc.semantic_vector AS vec
           FROM doc_chunks dc
          WHERE dc.doc_id = ?`,
      )
      .all(docId)
  }

  /**
   * Write a batch of vectors in ONE transaction.
   *
   * `setVector` is autocommit: each chunk costs a commit (measured 14.2 µs/row against 2.2 µs in a
   * transaction, and on a WAL database every commit appends its dirty pages). Callers encode in
   * batches anyway, so this is the same loop with the boundary moved out — and the transaction
   * NEVER spans an `await` (the caller encodes first, then calls this).
   */
  setVectors(rows: readonly { chunk_id: number; bytes: Buffer; embeddingModel: string }[]): void {
    if (!rows.length) return
    const stmt = this.db.prepare('UPDATE doc_chunks SET semantic_vector = ?, embedding_model = ? WHERE chunk_id = ?')
    this.db.transaction(() => {
      for (const r of rows) stmt.run(r.bytes, r.embeddingModel, r.chunk_id)
    })()
  }

  /** Record which extraction rules produced a chunk's entity rows (see `ENTITY_EXTRACTOR_VERSION`). */
  setEntitiesVersion(ids: readonly number[], version: number): void {
    setEntitiesVersionBatch(this.db, 'doc_chunks', 'chunk_id', ids, version)
  }

  /** Every persisted chunk vector, for rebuilding the in-memory index at open. */
  /**
   * Every persisted chunk vector, with the space it was written in.
   *
   * `embedding_model` is selected too (not just the bytes) so a reload can DETECT a model swap: a
   * dim-valid vector from another space is still ranked, and without this the two spaces would mix
   * in one index silently — the memory side had the check, the knowledge side did not.
   */
  vectorRows(): { id: number; vec: Buffer; embedding_model: string | null }[] {
    return this.db
      .prepare<{ id: number; vec: Buffer; embedding_model: string | null }>(
        'SELECT chunk_id AS id, semantic_vector AS vec, embedding_model AS embedding_model FROM doc_chunks WHERE semantic_vector IS NOT NULL',
      )
      .all()
  }

  /**
   * Vector-space health of the WHOLE chunk corpus, by kind, WITHOUT decoding a single blob.
   *
   * The same two counts the open-time warning reports (`stale` = wrong width, `space_stale` = same
   * width but another recorded space — `embedding_model IS NOT` is null-safe, so a row with no
   * recorded space counts as foreign exactly like the JS comparison in `reloadIndex`) plus `missing`
   * (no vector at all), which is the third reason the semantic leg cannot use a chunk.
   *
   * This is what lets the shared repair flow read "what is stale" cheaply per slice instead of
   * re-scanning and hashing the corpus (`corpusState` reads every text; a batched migration must
   * not).
   */
  vectorSpaceCounts(space: string, expectedBytes: number): { stale: number; space_stale: number; missing: number } {
    const row = this.db
      .prepare<{ stale: number; space_stale: number; missing: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN semantic_vector IS NULL THEN 1 ELSE 0 END), 0) AS missing,
           COALESCE(SUM(CASE WHEN semantic_vector IS NOT NULL AND length(semantic_vector) != :bytes THEN 1 ELSE 0 END), 0) AS stale,
           COALESCE(SUM(CASE WHEN semantic_vector IS NOT NULL AND length(semantic_vector) = :bytes AND embedding_model IS NOT :space THEN 1 ELSE 0 END), 0) AS space_stale
         FROM doc_chunks`,
      )
      .get({ bytes: expectedBytes, space })
    return { stale: Number(row?.stale ?? 0), space_stale: Number(row?.space_stale ?? 0), missing: Number(row?.missing ?? 0) }
  }

  /** Chunks with no persisted vector — the repair flow's `missing` term in `remaining`. */
  countMissingVectors(): number {
    return Number(
      this.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM doc_chunks WHERE semantic_vector IS NULL').get()?.n ?? 0,
    )
  }

  /**
   * Chunks the semantic leg cannot use (no vector / wrong width / another space), bounded and
   * ordered by id — the repair flow's encode source.
   *
   * The content-hash check `vectorReusable` adds is deliberately NOT here: a chunk whose vector is
   * in the current space is usable even if its text was edited behind the store's back, and that
   * (rarer) case belongs to `kb_reindex`, which re-derives every leg. Repairing the SPACE must not
   * pay a jieba/hash pass over the corpus to find rows the space change did not touch.
   */
  staleVectorRows(space: string, expectedBytes: number, limit: number): { chunk_id: number; text: string }[] {
    // SQLite reads a negative LIMIT as "no limit" (`LIMIT -1`) and rejects a non-integer bind with a
    // datatype mismatch, so the explicit-repair `Infinity` has to be translated here rather than
    // reaching the driver.
    const bound = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : -1
    return this.db
      .prepare<{ chunk_id: number; text: string }>(
        `SELECT chunk_id AS chunk_id, text AS text FROM doc_chunks
          WHERE semantic_vector IS NULL OR length(semantic_vector) != :bytes OR embedding_model IS NOT :space
          ORDER BY chunk_id ASC LIMIT :limit`,
      )
      .all({ bytes: expectedBytes, space, limit: bound })
  }

  count(): number {
    return this.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM doc_chunks').get()!.n
  }

  /**
   * Replace the entity rows of the given chunks in one transaction.
   *
   * `replace` is REQUIRED, not defaulted: `true` clears the old rows first (the entity sweep, where
   * the extractor may have changed), `false` is the ingest path, where the chunk ids are freshly
   * inserted and an absent old row set. A default would let one caller silently inherit the other's
   * semantics — an extra `DELETE` per chunk on ingest, or an append-on-top-of-stale sweep.
   */
  replaceEntities(rows: readonly ChunkEntityRow[], replace: boolean): void {
    const del = this.db.prepare('DELETE FROM chunk_entities WHERE chunk_id = ?')
    const ins = this.db.prepare('INSERT OR IGNORE INTO chunk_entities (chunk_id, name) VALUES (?, ?)')
    this.db.transaction(() => {
      for (const r of rows) {
        if (replace) del.run(r.chunk_id)
        for (const name of r.names) ins.run(r.chunk_id, name)
      }
    })()
  }

  /** Batched entity bags: `Map<chunkId, names>` (ids with none are absent). */
  entityBags(ids: readonly number[]): Map<number, string[]> {
    // No seed: knowledge's callers use `?? []`, and only rows that really carry entities appear (see
    // `shared.ts#entityBags`).
    return entityBags(this.db, ids, {
      table: 'chunk_entities',
      keyColumn: 'chunk_id',
      nameColumn: 'name',
      seedEmpty: false,
    })
  }

  /** Chunk body + owning-document identity for the fused candidate ids. */
  hits(ids: readonly number[]): ChunkHitRow[] {
    const out: ChunkHitRow[] = []
    for (const batch of batches(ids)) {
      const { placeholders, values } = inList(batch)
      // `domain`/`source` come from the owning `documents` row — the only place that knows
      // them for certain (`source_ref` is a lossy encoding of the same pair). The two
      // timestamps are the DOCUMENT's: a chunk has no clock of its own, and a re-ingest
      // replaces the chunk row while bumping `documents.updated_at`.
      out.push(
        ...this.db
          .prepare<ChunkHitRow>(
            `SELECT dc.chunk_id AS chunk_id, dc.text AS text, dc.source_ref AS source_ref,
                    d.domain AS domain, d.source AS source,
                    d.created_at AS created_at, d.updated_at AS updated_at
             FROM doc_chunks dc JOIN documents d ON d.doc_id = dc.doc_id
             WHERE dc.chunk_id IN (${placeholders})`,
          )
          .all(...values),
      )
    }
    return out
  }

  /** `(chunk_id, domain, source)` for the semantic top-k, to apply the domain/source filter. */
  meta(ids: readonly number[]): { chunk_id: number; domain: string; source: string }[] {
    const out: { chunk_id: number; domain: string; source: string }[] = []
    for (const batch of batches(ids)) {
      const { placeholders, values } = inList(batch)
      out.push(
        ...this.db
          .prepare<{ chunk_id: number; domain: string; source: string }>(
            `SELECT dc.chunk_id AS chunk_id, d.domain AS domain, d.source AS source
             FROM doc_chunks dc JOIN documents d ON d.doc_id = dc.doc_id
             WHERE dc.chunk_id IN (${placeholders})`,
          )
          .all(...values),
      )
    }
    return out
  }

  /**
   * Corpus rows for the rebuild legs, optionally scoped to one domain, together with the state
   * of their derivations. This is the `reindex` source: the caller compares `content_hash` /
   * `embedding_model` / `entities_version` against what it is about to produce and only pays
   * for the rows that are actually out of date (DESIGN §20).
   */
  corpusState(domain?: string): ChunkStateRow[] {
    return this.db
      .prepare<ChunkStateRow>(
        `SELECT dc.chunk_id AS chunk_id, dc.text AS text, dc.content_hash AS content_hash,
                dc.embedding_model AS embedding_model, dc.entities_version AS entities_version,
                (dc.semantic_vector IS NOT NULL) AS has_vector
         FROM doc_chunks dc
         JOIN documents d ON d.doc_id = dc.doc_id
         WHERE (? IS NULL OR d.domain = ?)`,
      )
      .all(domain ?? null, domain ?? null)
  }

  /**
   * Chunk rows whose `chunk_entities` were produced by OLDER extraction rules — the entity sweep's
   * selection, bounded and ordered by id.
   *
   * `COALESCE(entities_version, 0) < :version`, not `entities_version != :version`: the column is
   * NULLABLE on purpose (a row written before the derived-state columns existed must look stale
   * exactly once and be adopted by the first rebuild — see `ChunkStateRow`), and a bare `<` would
   * evaluate to NULL for those rows and let them hide from the sweep forever.
   *
   * The predicate is index-served in id order (`doc_chunks` is keyed by `chunk_id`), so the LIMIT
   * bounds what is READ, not only what is rebuilt — the same property `FactsDao.staleEntityRows`
   * documents for the memory side.
   */
  chunkEntityRows(version: number, limit: number, domain?: string): { chunk_id: number; text: string }[] {
    return this.db
      .prepare<{ chunk_id: number; text: string }>(
        `SELECT dc.chunk_id AS chunk_id, dc.text AS text
           FROM doc_chunks dc
           JOIN documents d ON d.doc_id = dc.doc_id
          WHERE COALESCE(dc.entities_version, 0) < :version AND (:domain IS NULL OR d.domain = :domain)
          ORDER BY dc.chunk_id ASC LIMIT :limit`,
      )
      .all({ version, limit, domain: domain ?? null })
  }

  /** How many chunks still carry entity rows from older rules — the sweep's `deferred` source. */
  countStaleEntityChunks(version: number, domain?: string): number {
    return Number(
      this.db
        .prepare<{ n: number }>(
          `SELECT COUNT(*) AS n
             FROM doc_chunks dc
             JOIN documents d ON d.doc_id = dc.doc_id
            WHERE COALESCE(dc.entities_version, 0) < :version AND (:domain IS NULL OR d.domain = :domain)`,
        )
        .get({ version, domain: domain ?? null })?.n ?? 0,
    )
  }

  /** Rebuild the FTS index from the content table (write-path maintenance). */
  rebuildFts(): void {
    this.db.exec("INSERT INTO doc_chunks_fts(doc_chunks_fts) VALUES('rebuild')")
  }

  /** Active chunks sharing at least one entity name with the query (jaccard candidate set). */
  /**
   * Entity-overlap candidates, highest-score first and CAPPED (see the memory store's sibling;
   * the score/order tail itself lives in `./shared.js#entityCandidateTail`).
   *
   * `limit` is applied per name-batch and the batches are unioned, so the result is bounded by
   * `limit x ceil(names/batch)` — corpus-independent, which is what this query can promise. The
   * caller is expected to enforce the real `cap` on the union AFTER scoring it (it re-computes the
   * true Jaccard in JS): a union of per-batch tops is not a top-N, and a leg that returns more than
   * the cap makes `scores.size === legCap` — the "was this leg trimmed" signal — report the opposite
   * of the truth. (The memory store's sibling does not batch, so its single `LIMIT` is already exact.)
   */
  candidatesByEntityNames(names: readonly string[], domain: string | undefined, source: string | undefined, limit: number, queryWidth: number, widthCap: number): number[] {
    // The score/order tail, bind order and per-batch union come from `./shared.js` — the memory
    // store's `candidateFactsForAnyEntity` runs the same contract on its own table.
    return entityCandidates(this.db, {
      names,
      filterParams: [domain ?? null, domain ?? null, source ?? null, source ?? null],
      limit,
      queryWidth,
      widthCap,
      batchNames: true,
      sql: (placeholders) => `SELECT ce.chunk_id AS id, COUNT(*) AS shared,
                  (SELECT COUNT(*) FROM chunk_entities x WHERE x.chunk_id = ce.chunk_id) AS total
             FROM chunk_entities ce
             JOIN doc_chunks dc ON dc.chunk_id = ce.chunk_id
             JOIN documents d ON d.doc_id = dc.doc_id
            -- No d.status predicate: documents.status has no writer (a removal is a physical DELETE
            -- that cascades to the chunks), so it reads 'active' for every row and the comparison
            -- only invited the reading that inactive documents are filtered out here. What keeps a
            -- removed document's chunks out of a result is the JOIN itself.
            WHERE ce.name IN (${placeholders})
              AND (? IS NULL OR d.domain = ?) AND (? IS NULL OR d.source = ?)
            ${entityCandidateTail('ce.chunk_id')}`,
    })
  }

  /**
   * How many chunks carry each name — the knowledge side of the entity leg's document frequency.
   *
   * Mirrors `EntitiesDao.activeDocFrequency`: only the caller's query names are looked up. There is
   * no status column to filter on (see `candidatesByEntityNames`), so "document frequency" is over
   * all chunks, which is the population the leg ranks.
   */
  docFrequency(names: readonly string[]): Map<string, number> {
    return queryDocFrequency(this.db, names, { from: ' FROM chunk_entities', nameExpr: 'name' })
  }

  /** FTS leg (`bm25` rank; negated by the caller so higher = better). */
  ftsSearch(ftsQuery: string, domain?: string, source?: string, limit?: number): { id: number; rank: number }[] {
    return this.db
      .prepare<{ id: number; rank: number }>(
        `SELECT c.rowid AS id, bm25(doc_chunks_fts) AS rank FROM doc_chunks_fts c
         JOIN doc_chunks dc ON dc.chunk_id = c.rowid
         JOIN documents d ON d.doc_id = dc.doc_id
         WHERE doc_chunks_fts MATCH ?
           AND (? IS NULL OR d.domain = ?) AND (? IS NULL OR d.source = ?)
         ORDER BY rank ASC
         LIMIT ?`,
      )
      .all(ftsQuery, domain ?? null, domain ?? null, source ?? null, source ?? null, limit ?? -1)
  }

  /**
   * The knowledge store's SHORT-QUERY fallback leg — the sibling of `FactsDao.ftsSubstringSearch`
   * (see it for the score/tie/verify notes; the predicate itself is shared through
   * `db/tokenizer.ts#likeSubstring`). It reads `doc_chunks` directly rather than the external-content
   * FTS table: no index can serve a two-character pattern anyway, and the `documents` join is where
   * the domain/source filter lives.
   */
  ftsSubstringSearch(terms: readonly string[], domain?: string, source?: string, limit?: number): { id: number; rank: number }[] {
    return likeSubstringLeg(
      this.db,
      'dc.text',
      terms,
      ({ any, count }) => `SELECT dc.chunk_id AS id, ${count} AS rank
           FROM doc_chunks dc
           JOIN documents d ON d.doc_id = dc.doc_id
          WHERE (? IS NULL OR d.domain = ?) AND (? IS NULL OR d.source = ?) AND (${any})
          ORDER BY rank DESC, dc.chunk_id ASC
          LIMIT ?`,
      [domain ?? null, domain ?? null, source ?? null, source ?? null],
      limit,
    )
  }
}
