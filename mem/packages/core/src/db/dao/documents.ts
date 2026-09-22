/**
 * `documents` — the knowledge corpus identity table (`domain → source → title`).
 *
 * Identity is the `(domain, source, title)` unique key, so `upsert` is `INSERT OR IGNORE`
 * followed by a lookup: a re-ingest of the same document must land on the SAME `doc_id`
 * (chunks are replaced under it), never create a second row.
 */
import type { Db } from '../port.js'
import type { DocumentRecord, DocumentSummary } from '@avantf/mem-contract'

/**
 * The stored document rows. The PAYLOAD shapes live in the contract (`kb list`/`kb detail` return
 * them verbatim, and the settings page imports them), so these are aliases rather than a second
 * declaration — a column added here without the contract would be a type error, not a silent
 * extra field on the wire.
 */
export type DocumentRow = DocumentSummary
export type DocumentDetailRow = DocumentRecord

export class DocumentsDao {
  constructor(private readonly db: Db) {}

  /** Idempotent upsert by the unique key; returns the existing or newly created id. */
  upsert(domain: string, source: string, title: string, sourceUri?: string): number {
    this.db
      .prepare('INSERT OR IGNORE INTO documents (domain, source, title, source_uri) VALUES (?, ?, ?, ?)')
      .run(domain, source, title, sourceUri ?? null)
    const row = this.db
      .prepare<{ doc_id: number }>('SELECT doc_id FROM documents WHERE domain = ? AND source = ? AND title = ?')
      .get(domain, source, title)
    if (!row) throw new Error(`文档 upsert 之后找不到自己的行：${domain}/${source}/${title}`)
    return row.doc_id
  }

  /**
   * One row by the unique identity `(domain, source, title)`, or `null` when no such document
   * exists. Walks the `UNIQUE(domain, source, title)` index — the add-only guard's existence test.
   */
  find(domain: string, source: string, title: string): DocumentRow | null {
    return this.db
      .prepare<DocumentRow>(
        'SELECT doc_id, domain, source, title, source_uri, created_at, updated_at FROM documents'
        + ' WHERE domain = ? AND source = ? AND title = ?',
      )
      .get(domain, source, title) ?? null
  }

  /**
   * Bump `updated_at` and record the URI that was actually read. `COALESCE` keeps the
   * previous URI when this ingest did not come from one (plain text has none).
   */
  touch(docId: number, sourceUri?: string): void {
    this.db
      .prepare('UPDATE documents SET updated_at = CURRENT_TIMESTAMP, source_uri = COALESCE(?, source_uri) WHERE doc_id = ?')
      .run(sourceUri ?? null, docId)
  }

  /**
   * Catalog page: newest first, optionally scoped to one domain and/or source.
   *
   * `limit`/`offset` page it for the UI (which renders one page at a time); omitting `limit` keeps
   * the historical "everything" behavior the CLI and MCP surfaces expect.
   */
  list(domain?: string, source?: string, limit?: number, offset?: number): DocumentRow[] {
    const select = 'SELECT doc_id, domain, source, title, source_uri, created_at, updated_at FROM documents'
      + ' WHERE (? IS NULL OR domain = ?) AND (? IS NULL OR source = ?) ORDER BY updated_at DESC'
    const args = [domain ?? null, domain ?? null, source ?? null, source ?? null] as const
    if (limit === undefined) return this.db.prepare<DocumentRow>(select).all(...args)
    return this.db.prepare<DocumentRow>(`${select} LIMIT ? OFFSET ?`).all(...args, limit, offset ?? 0)
  }

  get(docId: number): DocumentDetailRow | null {
    return this.db.prepare<DocumentDetailRow>('SELECT * FROM documents WHERE doc_id = ?').get(docId) ?? null
  }

  /**
   * The distinct domains the library already holds, sorted. This is the "already in the library"
   * half of the domain allowlist: a name in use must stay usable (and selectable) even when the
   * configured allowlist would not have accepted it as a NEW domain.
   */
  domains(): string[] {
    return this.db
      .prepare<{ domain: string }>('SELECT DISTINCT domain FROM documents ORDER BY domain')
      .all()
      .map((row) => row.domain)
  }

  /** `true` when a document was actually deleted (cascades chunks/entities/FTS). */
  remove(docId: number): boolean {
    return this.db.prepare('DELETE FROM documents WHERE doc_id = ?').run(docId).changes > 0
  }

  count(): number {
    return this.db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM documents').get()!.n
  }
}
