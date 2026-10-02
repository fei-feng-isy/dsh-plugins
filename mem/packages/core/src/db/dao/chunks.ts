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
import { batches } from '../chunk.js'
import { contentHash } from '../hash.js'

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
      const placeholders = batch.map(() => '?').join(',')
      out.push(
        ...this.db
          .prepare<{ chunk_id: number; text: string }>(`SELECT chunk_id, text FROM doc_chunks WHERE chunk_id IN (${placeholders})`)
          .all(...batch),
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
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      this.db
        .prepare(`UPDATE doc_chunks SET entities_version = ? WHERE chunk_id IN (${placeholders})`)
        .run(version, ...batch)
    }
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

  count(): number {
    return this.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM doc_chunks').get()!.n
  }

  /**
   * Replace the entity rows of the given chunks in one transaction (`replace` clears the
   * old rows first — used by reindex, where the extractor may have changed).
   */
  replaceEntities(rows: readonly ChunkEntityRow[], replace = false): void {
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
    const out = new Map<number, string[]>()
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.db
        .prepare<{ chunk_id: number; name: string }>(`SELECT chunk_id, name FROM chunk_entities WHERE chunk_id IN (${placeholders})`)
        .all(...batch)
      for (const r of rows) {
        const list = out.get(r.chunk_id)
        if (list) list.push(r.name)
        else out.set(r.chunk_id, [r.name])
      }
    }
    return out
  }

  /** Chunk body + owning-document identity for the fused candidate ids. */
  hits(ids: readonly number[]): ChunkHitRow[] {
    const out: ChunkHitRow[] = []
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
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
          .all(...batch),
      )
    }
    return out
  }

  /** `(chunk_id, domain, source)` for the semantic top-k, to apply the domain/source filter. */
  meta(ids: readonly number[]): { chunk_id: number; domain: string; source: string }[] {
    const out: { chunk_id: number; domain: string; source: string }[] = []
    for (const batch of batches(ids)) {
      const placeholders = batch.map(() => '?').join(',')
      out.push(
        ...this.db
          .prepare<{ chunk_id: number; domain: string; source: string }>(
            `SELECT dc.chunk_id AS chunk_id, d.domain AS domain, d.source AS source
             FROM doc_chunks dc JOIN documents d ON d.doc_id = dc.doc_id
             WHERE dc.chunk_id IN (${placeholders})`,
          )
          .all(...batch),
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

  /** Rebuild the FTS index from the content table (write-path maintenance). */
  rebuildFts(): void {
    this.db.exec("INSERT INTO doc_chunks_fts(doc_chunks_fts) VALUES('rebuild')")
  }

  /** Active chunks sharing at least one entity name with the query (jaccard candidate set). */
  /**
   * Entity-overlap candidates, most-shared first and CAPPED (see the memory store's sibling).
   *
   * `limit` is applied per name-batch and the batches are unioned, so the result is bounded by
   * `limit x ceil(names/batch)` — corpus-independent, which is what this query can promise. The
   * caller is expected to enforce the real `cap` on the union AFTER scoring it (it re-computes the
   * true Jaccard in JS): a union of per-batch tops is not a top-N, and a leg that returns more than
   * the cap makes `scores.size === legCap` — the "was this leg trimmed" signal — report the opposite
   * of the truth. (The memory store's sibling does not batch, so its single `LIMIT` is already exact.)
   */
  candidatesByEntityNames(names: readonly string[], domain: string | undefined, source: string | undefined, limit: number): number[] {
    if (limit <= 0) return []
    const out = new Set<number>()
    for (const batch of batches(names)) {
      const placeholders = batch.map(() => '?').join(',')
      const rows = this.db
        .prepare<{ chunk_id: number }>(
          // Ordered by the ACTUAL Jaccard, not by the shared count — see the memory store's
          // sibling for the measured case where those two disagree.
          `SELECT ce.chunk_id AS chunk_id, COUNT(*) AS shared,
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
            GROUP BY ce.chunk_id
            ORDER BY (CAST(shared AS REAL) / (total + ? - shared)) DESC, ce.chunk_id ASC
            LIMIT ?`,
        )
        .all(...batch, domain ?? null, domain ?? null, source ?? null, source ?? null, batch.length, limit)
      for (const r of rows) out.add(r.chunk_id)
    }
    return [...out]
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
}
