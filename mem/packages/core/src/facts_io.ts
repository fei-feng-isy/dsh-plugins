/**
 * Facts export / import — the machine-independent JSON form of the memory facts table, and the ONE
 * content-identity import loop behind `avantf-mem import` and `avantf-mem merge`.
 *
 * WHY THIS LIVES IN @avantf/mem, NOT IN THE CLI. The `/mem` slash command runs inside the plugin,
 * and a plugin may not import another tree's CLI (a different package, and `pnpm guard` forbids it).
 * Both surfaces therefore have to reach the same implementation through the engine. The loop also
 * must not be written twice: merge and import share one per-fact add path, so `assert_count`,
 * provenance and the failure-collection rules cannot drift between them.
 *
 * IDENTITY IS CONTENT, NEVER `source_id`. `memory.db` is a file users sync between machines (the git
 * workflow checkpoints WAL and versions `memory.db`). Two clones diverge as soon as both hosts write:
 * the same `fact_id` then names unrelated facts — measured on a real pair (2026-10-20), 162 ids were
 * shared and 78 held DIFFERENT facts. Any id-based restore would silently overwrite one machine's
 * memories with the other's. This module identifies a fact by `normalizeWrite(content).trim()`, which
 * is exactly what `MemoryStore.add` persists and what `FactsDao.findByContent` compares
 * (`WHERE content = ?`); it does not define a second normalization. Under IMPORT `source_id` is
 * carried for the report and for debugging only; under RESTORE it is the id to KEEP
 * (see `store/facts_restore.ts`), which is why it travels in the document either way.
 *
 * READ-ONLY READS. The export source, the merge source and the import TARGET are all opened through a
 * separate `readOnly` connection. Export never writes; merge never migrates, checkpoints or touches the
 * other host's file; the import comparison includes ARCHIVED rows because `findByContent` does not
 * filter status and a store add would REVIVE an archived row (which would be a resurrection, not an
 * import). The only writer is the store's own `rt.remember({ action: 'add', … })` path, so vectors,
 * entities, triples, FTS rows and provenance are generated exactly as for a normal add; nothing here
 * inserts SQL rows.
 *
 * TWO CONSUMERS, TWO SEMANTICS. `import`/`merge` remain a CONTENT-IDENTITY UNION and consume only
 * a subset: category, ttl_days, embedded source ref, valid_from → event_date and valid_to →
 * valid_until. They do NOT restore created_at/updated_at/trust_score/assert_count/helpful_count/
 * pinned, archived status or the supersedes chain — `metadata_dropped` counts each value they
 * knowingly drop instead of pretending. `restore` is the REBUILD (see `store/facts_restore.ts`):
 * only into an EMPTY facts table, keeping fact_id, status, timestamps, trust, pin, counters, every
 * provenance row and the supersedes chain, then re-deriving entities. The union path never revives
 * an archived row; restore is the only path that brings archived rows back. The vector, entity,
 * contradiction and retrieval-stat tables are still not exported at all (recomputable or
 * machine-local), which is why a restore ends with "recompute the vectors" rather than a copy.
 *
 * FORMAT VERSION 2, AND V1 IS STILL READ. The document is lossless over every facts column a
 * snapshot needs, so v2 adds the columns v1 was missing — `settle_clock`, `bonus_count`, `bonus_window_at`,
 * `retrieval_count`, `last_retrieved_at`, `mirror_source`, `mirror_target` and the derived-state
 * stamps `entities_version`/`conflict_checked`. They are OPTIONAL and null-defaulted, so a v1
 * document parses into the same type with those keys ABSENT, which is exactly "unknown" — and
 * restore counts every such absence per field instead of inventing a value. `parseFactsExport`
 * accepts 1 and 2 and refuses anything else (a newer version must be refused, never guessed at).
 *
 * ENCODING IS A CONTAINER, NOT A FORMAT CHANGE. Compression changes only the bytes written to
 * disk, never the document; `version` tracks the FIELD SET (1 → 2 added the columns above).
 * `serializeFactsExport` is minified by default
 * (pretty is debug-only), and `encodeFactsExport` compresses that same JSON with node:zlib (gzip,
 * or brotli — the smallest). Compression is what pays: measured on a real 233-fact library
 * (2026-10-20) pretty 340.7 KiB → minified 300.0 KiB → gzip 92.3 KiB → brotli 70.6 KiB. Field
 * slimming was rejected: after compression it saves ~2% and would change the format.
 *
 * DETECTION IS BY CONTENT, NEVER BY FILE NAME. gzip has a magic header (`1f 8b`), brotli has none,
 * and old exports are plain pretty JSON. So `decodeFactsExport` sniffs: gzip magic → gunzip; else
 * try UTF-8 JSON (this is also the backward-compatible path for every pre-compression file); only
 * if JSON parsing fails try brotli; if all fail, refuse with the three accepted forms. A document
 * that parses as JSON but has the wrong format/version is refused IMMEDIATELY — a format error must
 * never be masked by the brotli fallback.
 *
 * @module @avantf/mem/facts_io
 */
import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants, gunzipSync, gzipSync } from 'node:zlib'
import type { RememberRequest } from '@avantf/mem-contract'
import type { AvantfRuntime } from './runtime.js'
import { normalizeWrite } from './store/common.js'

/** The document's discriminator. A file without it is not an export of this tool. */
export const FACTS_EXPORT_FORMAT = 'avantf-mem-facts'
/**
 * The version THIS build writes: 2 (v1 + the facts columns v1 did not carry).
 *
 * Versions are additive by design: v2 adds OPTIONAL fields, so a v1 document is still the same
 * shape minus the new keys. A version outside {@link FACTS_EXPORT_VERSIONS} must be refused, never
 * guessed at.
 */
export const FACTS_EXPORT_VERSION = 2
/** A version this build can READ. v1 documents are what users already have on disk. */
export const FACTS_EXPORT_VERSIONS = [1, 2] as const
/** The version literal, so a parsed document can say which field set it came from. */
export type FactsExportVersion = (typeof FACTS_EXPORT_VERSIONS)[number]
/** `--status` values accepted by `export` (the whole DB, or one status). */
export const EXPORT_STATUSES = ['active', 'archived', 'all'] as const
export type ExportStatus = (typeof EXPORT_STATUSES)[number]

/** One `fact_sources` row, copied verbatim. */
export interface ExportedFactSource {
  kind: string
  ref: string
}

/**
 * One fact, as it stands in the source database.
 *
 * Every field is part of the documented format even when v1 import ignores it — the point of the
 * document is that a later restore does not have to invent what was never written down.
 */
export interface ExportedFact {
  /** Source-local row id. For reports/debugging ONLY; content is the identity. */
  source_id: number
  content: string
  category: string
  status: string
  created_at: string | null
  updated_at: string | null
  ttl_days: number
  pinned: boolean
  pinned_at: string | null
  trust_score: number
  assert_count: number
  helpful_count: number
  last_reinforced_at: string | null
  sources: ExportedFactSource[]
  valid_from: string | null
  valid_to: string | null
  supersedes_source_id: number | null
  /** `null` for an active row; the archive bookkeeping for an archived one. */
  archive: { at: string | null; reason: string | null } | null
  // ─── v2 additions, all OPTIONAL and null-defaulted ────────────────────────
  // Absent (a v1 document) means "unknown", not "zero": restore reports the absence per field in
  // `metadata_missing` and substitutes the documented fallback (see store/facts_restore.ts).
  /** Active-day clock at the last trust settle — the decay baseline. v1 had no such column. */
  settle_clock?: number | null
  /** Reinforcement events inside the current 24h window. */
  bonus_count?: number | null
  /** Calendar start of that window. */
  bonus_window_at?: string | null
  /** How many times this fact was RETURNED by a retrieval leg (local usage stat, still stored). */
  retrieval_count?: number | null
  last_retrieved_at?: string | null
  /** Mirror bookkeeping (a fact copied between libraries); informational, restored verbatim. */
  mirror_source?: string | null
  mirror_target?: string | null
  /**
   * The DERIVED-STATE stamps. Exported for completeness/diagnostics, but restore deliberately does
   * not trust them: it stamps `entities_version = 0` (so the entity sweep rebuilds) and
   * `conflict_checked = 1` (no corpus-wide conflict re-scan after a rebuild).
   */
  entities_version?: number | null
  conflict_checked?: number | null
}

/** The single JSON document `export` writes (and `import`/`restore` read). */
export interface FactsExportDocument {
  format: typeof FACTS_EXPORT_FORMAT
  /** The version the document was WRITTEN as (1 or 2); this build writes 2. */
  version: FactsExportVersion
  exported_at: string
  source: {
    data_home: string
    db: string
    /** The SOURCE database's whole-DB status counts, independent of `--status`. */
    counts: { active: number; archived: number }
  }
  facts: ExportedFact[]
}

/** How v1 import may treat the provenance embedded in the document. */
export interface ImportOptions {
  /** Plan only: no write, and the report gets `would_import`. */
  dryRun?: boolean
  /** Fallback provenance when the document has none (the CLI passes `import:<file>`). */
  sourceRef?: string
  /**
   * Use `sources[0].ref` when present (the default, and the import contract).
   *
   * `merge` turns this OFF: its documented provenance is `merge:<absolute source path>` for every
   * imported row, so a merge must not start attributing rows to whatever the other host recorded.
   */
  preferEmbeddedSources?: boolean
}

/** One row the store refused; the rest of the import continues. */
export interface ImportFailure {
  /** The document's `source_id`, or `null` when the row was too malformed to have one. */
  source_id: number | null
  error: string
}

/** Source id → target id for one fact this invocation actually CREATED. */
export interface ImportNewId {
  source_id: number | null
  new_fact_id: number
}

/**
 * Counts of values v1 could not carry, over the facts this invocation imported (or, for a dry run,
 * planned to import). `1` per fact that actually carried the value; `0` when there was nothing to
 * lose. See the module doc for why these are losses rather than silent successes.
 */
export interface MetadataDropped {
  timestamps: number
  trust: number
  assert_count: number
  helpful_count: number
  pinned: number
  supersedes: number
}

/** The single JSON object `import` prints (`file` is added by the CLI, which knows the argument). */
export interface ImportReport {
  version: number
  total: number
  imported: number
  /** Present on `--dry-run` only; the number of facts that WOULD be written. */
  would_import?: number
  skipped_existing: number
  skipped_archived: number
  failed: ImportFailure[]
  new_ids: ImportNewId[]
  metadata_dropped: MetadataDropped
}

/** The db→db variant's report. Field names kept from the original `merge` output. */
export interface MergeReport {
  source: string
  source_active: number
  added: number
  would_add: number
  skipped_existing: number
  skipped_archived: number
  failed: { source_fact_id: number | null; error: string }[]
  new_ids: { source_fact_id: number | null; new_fact_id: number }[]
}

export interface MergeOptions {
  /** Provenance for rows without an embedded source; default `merge:<absolute source path>`. */
  sourceRef?: string
  /** Plan only: no model warmup, no write, `added` stays 0. */
  dryRun?: boolean
}

/**
 * The slice of `node:sqlite` this module calls.
 *
 * Declared structurally and loaded through createRequire for the same two reasons the engine's
 * adapter does it (see db/sqlite.ts): a static `import 'node:sqlite'` would make the whole package
 * unloadable on a runtime without the builtin, and these signatures do not depend on which
 * `@types/node` a consumer builds with.
 */
interface RawStatement {
  all(...params: unknown[]): unknown[]
}
interface RawDatabase {
  prepare(sql: string): RawStatement
  close(): void
}
type DatabaseCtor = new (path: string, options?: { readOnly?: boolean }) => RawDatabase

/** Open one database strictly for reading. Never used for a write. */
function openReadOnly(path: string): RawDatabase {
  const require_ = createRequire(import.meta.url)
  const module = require_('node:sqlite') as { DatabaseSync?: DatabaseCtor }
  if (typeof module.DatabaseSync !== 'function') {
    throw new Error('node:sqlite 不可用：导出/导入需要运行时自带的 SQLite（Node >= 22.12）')
  }
  return new module.DatabaseSync(path, { readOnly: true })
}

/**
 * The columns the document carries, in output order.
 *
 * The reader selects the INTERSECTION with the source table's real columns: a merge source is
 * another host's file and may predate a later column (P-13's `valid_from`/`valid_to`, P-08's
 * `fact_sources` table), and a read-only source must not fail — or be migrated — just because it is
 * old. Missing fields read as `null`/`0`, which is exactly "unknown".
 */
const FACT_COLUMNS = [
  'fact_id', 'content', 'category', 'status', 'created_at', 'updated_at', 'ttl_days',
  'pinned', 'pinned_at', 'trust_score', 'assert_count', 'helpful_count', 'last_reinforced_at',
  'valid_from', 'valid_to', 'supersedes_id', 'archived_at', 'archive_reason',
  // v2: the columns v1 could not carry. A source older than one of them simply lacks the key,
  // and `numberOrNull`/`textOrNull` read that absence as "unknown".
  'settle_clock', 'bonus_count', 'bonus_window_at', 'retrieval_count', 'last_retrieved_at',
  'mirror_source', 'mirror_target', 'entities_version', 'conflict_checked',
] as const

function cell(row: Record<string, unknown>, name: string): unknown {
  return row[name]
}

function textOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

/** A nullable numeric column: absent (an older source) and NULL both mean "unknown". */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const coerced = Number(value)
  return Number.isFinite(coerced) ? coerced : null
}

function numberOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const coerced = Number(value)
  return value === null || value === undefined || !Number.isFinite(coerced) ? fallback : coerced
}

function boolOf(value: unknown): boolean {
  return value === 1 || value === true || value === '1'
}

/** The one content identity: `normalizeWrite` (the store's own write normalization) + the same trim. */
function identityOf(content: string): string {
  return normalizeWrite(content).trim()
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/** The facts table's real columns, or a clear error when this is not a facts database at all. */
function factsColumns(db: RawDatabase): Set<string> {
  const rows = db.prepare('PRAGMA table_info(facts)').all() as Record<string, unknown>[]
  const columns = new Set(rows.map((row) => String(cell(row, 'name'))))
  if (columns.size === 0) throw new Error('源库没有 facts 表')
  if (!columns.has('content')) throw new Error('源库的 facts 表缺少 content 列')
  return columns
}

/** Whole-DB status counts (`--status` narrows `facts`, never the source metadata). */
function readCounts(db: RawDatabase, columns: Set<string>): { active: number; archived: number } {
  const counts = { active: 0, archived: 0 }
  if (!columns.has('status')) return counts
  for (const raw of db.prepare('SELECT status, COUNT(*) AS n FROM facts GROUP BY status').all()) {
    const row = raw as Record<string, unknown>
    const status = textOf(cell(row, 'status'))
    if (status === 'active') counts.active = numberOf(cell(row, 'n'), 0)
    if (status === 'archived') counts.archived = numberOf(cell(row, 'n'), 0)
  }
  return counts
}

/** One query for every fact's sources, grouped by id — never one query per fact. */
function readSources(db: RawDatabase): Map<number, ExportedFactSource[]> {
  const out = new Map<number, ExportedFactSource[]>()
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fact_sources'")
    .all().length > 0
  if (!hasTable) return out // a source older than P-08 simply carries no provenance
  for (const raw of db.prepare('SELECT fact_id, kind, ref FROM fact_sources ORDER BY fact_id ASC').all()) {
    const row = raw as Record<string, unknown>
    const factId = numberOf(cell(row, 'fact_id'), -1)
    if (factId < 0) continue
    const list = out.get(factId) ?? []
    list.push({ kind: textOf(cell(row, 'kind')), ref: textOf(cell(row, 'ref')) })
    out.set(factId, list)
  }
  return out
}

/**
 * Read one facts database into the export document. Internal: the public faces are
 * {@link exportFacts} (this runtime's database) and {@link mergeDb} (another host's file).
 */
function readFactsDocument(
  dbPath: string,
  options: { status: ExportStatus; dataHome: string },
): FactsExportDocument {
  const db = openReadOnly(dbPath)
  try {
    const columns = factsColumns(db)
    const projection = FACT_COLUMNS.filter((column) => columns.has(column))
    const where = options.status === 'all' ? '' : ' WHERE status = ?'
    const params = options.status === 'all' ? [] : [options.status]
    const rawRows = db.prepare(
      `SELECT ${projection.join(', ')} FROM facts${where} ORDER BY fact_id ASC`,
    ).all(...params)
    const sources = readSources(db)
    const facts: ExportedFact[] = rawRows.map((raw) => {
      const row = raw as Record<string, unknown>
      const sourceId = numberOf(cell(row, 'fact_id'), 0)
      const status = textOf(cell(row, 'status'))
      const supersedes = cell(row, 'supersedes_id')
      return {
        source_id: sourceId,
        content: textOf(cell(row, 'content')),
        category: textOf(cell(row, 'category')),
        status,
        created_at: textOrNull(cell(row, 'created_at')),
        updated_at: textOrNull(cell(row, 'updated_at')),
        ttl_days: numberOf(cell(row, 'ttl_days'), 0),
        pinned: boolOf(cell(row, 'pinned')),
        pinned_at: textOrNull(cell(row, 'pinned_at')),
        trust_score: numberOf(cell(row, 'trust_score'), 0),
        assert_count: numberOf(cell(row, 'assert_count'), 1),
        helpful_count: numberOf(cell(row, 'helpful_count'), 0),
        last_reinforced_at: textOrNull(cell(row, 'last_reinforced_at')),
        sources: sources.get(sourceId) ?? [],
        valid_from: textOrNull(cell(row, 'valid_from')),
        valid_to: textOrNull(cell(row, 'valid_to')),
        supersedes_source_id: supersedes === null || supersedes === undefined ? null : numberOf(supersedes, 0),
        archive: status === 'archived'
          ? { at: textOrNull(cell(row, 'archived_at')), reason: textOrNull(cell(row, 'archive_reason')) }
          : null,
        // v2. Written for every row, including `null`: "the document says unknown" and "the
        // document predates this field" both read as null, which is the same thing to a restore.
        settle_clock: numberOrNull(cell(row, 'settle_clock')),
        bonus_count: numberOrNull(cell(row, 'bonus_count')),
        bonus_window_at: textOrNull(cell(row, 'bonus_window_at')),
        retrieval_count: numberOrNull(cell(row, 'retrieval_count')),
        last_retrieved_at: textOrNull(cell(row, 'last_retrieved_at')),
        mirror_source: textOrNull(cell(row, 'mirror_source')),
        mirror_target: textOrNull(cell(row, 'mirror_target')),
        entities_version: numberOrNull(cell(row, 'entities_version')),
        conflict_checked: numberOrNull(cell(row, 'conflict_checked')),
      }
    })
    return {
      format: FACTS_EXPORT_FORMAT,
      version: FACTS_EXPORT_VERSION,
      exported_at: new Date().toISOString(),
      source: { data_home: options.dataHome, db: dbPath, counts: readCounts(db, columns) },
      facts,
    }
  } finally {
    db.close()
  }
}

/**
 * Export THIS runtime's memory facts. Read-only: the store's own connection is never asked to write
 * (and this command needs no embedding model — the rows are already there).
 */
export function exportFacts(
  rt: AvantfRuntime,
  options: { status?: ExportStatus } = {},
): FactsExportDocument {
  const status = options.status ?? 'all'
  if (!(EXPORT_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`--status 必须是 ${EXPORT_STATUSES.join(' | ')}（收到 '${String(status)}'）`)
  }
  return readFactsDocument(rt.config.memory.db.path, { status, dataHome: rt.config.home })
}

/**
 * The compression containers `export` can write. `none` is plain minified JSON (the format's
 * canonical text, and what stdout always carries).
 */
export type FactsExportCodec = 'brotli' | 'gzip' | 'none'

/**
 * The one serialization. MINIFIED by default: the document is a machine artifact that gets
 * compressed, and indentation only makes the uncompressed fallback bigger. `pretty` exists for
 * debugging (a human reading a diff), never as the default — and it is the ONLY mode that appends
 * the trailing newline that used to be unconditional.
 */
export function serializeFactsExport(
  doc: FactsExportDocument,
  options: { pretty?: boolean } = {},
): string {
  return options.pretty === true ? JSON.stringify(doc, null, 2) + '\n' : JSON.stringify(doc)
}

/**
 * Serialize + compress in one step. gzip uses level 9; brotli uses quality 11 and tells the encoder
 * the input size, which is the smallest output either library produces for a one-shot export.
 *
 * `codec` defaults to `none` so a caller that says nothing gets the canonical minified JSON.
 */
export function encodeFactsExport(
  doc: FactsExportDocument,
  options: { codec?: FactsExportCodec; pretty?: boolean } = {},
): Buffer {
  const codec = options.codec ?? 'none'
  const plain = Buffer.from(serializeFactsExport(doc, { pretty: options.pretty === true }), 'utf8')
  if (codec === 'none') return plain
  if (codec === 'gzip') return gzipSync(plain, { level: 9 })
  if (codec !== 'brotli') throw new Error('不支持的导出编码：' + String(codec))
  return brotliCompressSync(plain, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: plain.length,
    },
  })
}

/** The document an encoded file carries, plus the container it actually turned out to be. */
export interface DecodedFactsExport {
  doc: FactsExportDocument
  codec: FactsExportCodec
}

/**
 * Decode one export file from its BYTES. The file name is deliberately not an input: gzip has a
 * magic header, brotli does not, and a pre-compression export is plain JSON — so the only reliable
 * discriminator is the content itself (a brotli file renamed to `.json` still imports, and a plain
 * JSON file renamed to `.json.br` does too).
 *
 * Order, and why: gzip magic → gunzip (a corrupt gzip is refused as gzip, not silently "JSON");
 * otherwise UTF-8 JSON (the backward-compatible path for every old pretty file); only when JSON
 * parsing fails, brotli (its decoder rejects non-brotli input, so this cannot shadow a JSON
 * document). A document that IS JSON but has the wrong format/version throws its own error right
 * away — {@link parseFactsExport} is the format gate, not a fallback.
 */
export function decodeFactsExport(bytes: Buffer): DecodedFactsExport {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    let text: string
    try {
      text = gunzipSync(bytes).toString('utf8')
    } catch (error) {
      throw new Error('gzip 解压失败（文件头是 gzip，但内容损坏或不完整）：' + messageOf(error))
    }
    return { doc: parseFactsExport(text), codec: 'gzip' }
  }

  const plain = jsonValueOf(bytes.toString('utf8'))
  if (plain.ok) return { doc: documentOf(plain.value), codec: 'none' }

  let brotliError: unknown
  try {
    const decoded = jsonValueOf(brotliDecompressSync(bytes).toString('utf8'))
    if (decoded.ok) return { doc: documentOf(decoded.value), codec: 'brotli' }
    brotliError = decoded.error
  } catch (error) {
    brotliError = error
  }
  throw new Error(
    '无法识别导出文件：既不是有效的 JSON，也不是 gzip / brotli 压缩的导出文档。'
    + '\n接受的三种形式：.json（明文，minified 或旧版 pretty JSON）、.json.gz（gzip）、.json.br（brotli）——按内容识别，不看扩展名。'
    + '\n（明文解析失败：' + messageOf(plain.error) + '；brotli 解压失败：' + messageOf(brotliError) + '）',
  )
}

/**
 * Resolve the container for a file export: an explicit flag wins, then the extension (`.br` /
 * `.gz`), then plain minified JSON. Shared by the CLI and `/mem` so the two surfaces cannot
 * disagree about what `--out backup.json.gz` means.
 */
export function codecForExportPath(path: string, explicit?: FactsExportCodec): FactsExportCodec {
  if (explicit !== undefined) return explicit
  const lower = path.toLowerCase()
  if (lower.endsWith('.br')) return 'brotli'
  if (lower.endsWith('.gz')) return 'gzip'
  return 'none'
}

/** `JSON.parse` split out so {@link decodeFactsExport} can tell a syntax failure from a format one. */
function jsonValueOf(text: string): { ok: true; value: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Parse and validate an export document TEXT (the stdin entry point). Top-level format errors are
 * FATAL (the caller must write nothing); a malformed individual fact is NOT — {@link importFacts}
 * collects it in `failed` and keeps going. Restore is STRICTER by construction: it validates every
 * row before opening its transaction, because skipping a row would produce a different history.
 */
export function parseFactsExport(text: string): FactsExportDocument {
  const parsed = jsonValueOf(text)
  if (!parsed.ok) throw new Error('导入文件不是有效的 JSON: ' + messageOf(parsed.error))
  return documentOf(parsed.value)
}

/** The ONE top-level shape check, shared by the text entry point and the byte decoder. */
function documentOf(value: unknown): FactsExportDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('导入文件不是 JSON 对象')
  }
  const doc = value as Record<string, unknown>
  if (doc['format'] !== FACTS_EXPORT_FORMAT) {
    throw new Error(`导入文件的 format 不是 ${FACTS_EXPORT_FORMAT}（读到 ${JSON.stringify(doc['format'])}）`)
  }
  // Accepting v1 is not leniency: v2 only ADDED optional fields, so a v1 document is the same
  // shape minus them. Anything else is refused — a newer version must never be guessed at.
  if (!(FACTS_EXPORT_VERSIONS as readonly unknown[]).includes(doc['version'])) {
    throw new Error(
      `不支持的导出格式版本：${String(doc['version'])}（支持 ${FACTS_EXPORT_VERSIONS.join(' / ')}）`,
    )
  }
  if (!Array.isArray(doc['facts'])) throw new Error('导入文件的 facts 不是数组')
  return value as FactsExportDocument
}

/** The target's contents, ARCHIVED INCLUDED — see the module doc for why that is load-bearing. */
function readTargetContents(dbPath: string): Set<string> {
  const db = openReadOnly(dbPath)
  try {
    factsColumns(db)
    return new Set(
      db.prepare('SELECT content FROM facts').all()
        .map((raw) => identityOf(textOf(cell(raw as Record<string, unknown>, 'content')))),
    )
  } finally {
    db.close()
  }
}

function emptyMetadataDropped(): MetadataDropped {
  return { timestamps: 0, trust: 0, assert_count: 0, helpful_count: 0, pinned: 0, supersedes: 0 }
}

/** What a Phase-2 restore WOULD have carried but v1 does not. */
function metadataDroppedOf(row: Record<string, unknown>): MetadataDropped {
  return {
    timestamps: hasText(cell(row, 'created_at')) || hasText(cell(row, 'updated_at')) ? 1 : 0,
    trust: typeof cell(row, 'trust_score') === 'number' ? 1 : 0,
    assert_count: numberOf(cell(row, 'assert_count'), 1) > 1 ? 1 : 0,
    helpful_count: numberOf(cell(row, 'helpful_count'), 0) > 0 ? 1 : 0,
    pinned: boolOf(cell(row, 'pinned')) ? 1 : 0,
    supersedes: cell(row, 'supersedes_source_id') === null || cell(row, 'supersedes_source_id') === undefined ? 0 : 1,
  }
}

function accumulateMetadataDropped(total: MetadataDropped, one: MetadataDropped): void {
  total.timestamps += one.timestamps
  total.trust += one.trust
  total.assert_count += one.assert_count
  total.helpful_count += one.helpful_count
  total.pinned += one.pinned
  total.supersedes += one.supersedes
}

function sourceIdOf(row: Record<string, unknown>): number | null {
  const value = cell(row, 'source_id')
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function optionalString(row: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = cell(row, key)
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label} 不是字符串`)
  return value === '' ? undefined : value
}

function optionalTtlDays(row: Record<string, unknown>): number | undefined {
  const value = cell(row, 'ttl_days')
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('ttl_days 无效（需要非负整数）')
  }
  return value
}

function optionalDate(row: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = cell(row, key)
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 无效（需要非空字符串）`)
  return value
}

function embeddedSourceRef(row: Record<string, unknown>): string | undefined {
  const sources = cell(row, 'sources')
  if (!Array.isArray(sources) || sources.length === 0) return undefined
  const first = sources[0]
  if (first === null || typeof first !== 'object') return undefined
  const ref = cell(first as Record<string, unknown>, 'ref')
  if (typeof ref !== 'string') return undefined
  const trimmed = ref.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The one `add` request v1 import builds. It is built during PLANNING (not inside the write loop),
 * so `--dry-run` reports a malformed metadata row as `failed` instead of claiming it would import.
 */
function addRequestFor(
  identity: string,
  row: Record<string, unknown>,
  fallbackSourceRef: string | undefined,
  preferEmbeddedSources: boolean,
): Extract<RememberRequest, { action: 'add' }> {
  const embedded = preferEmbeddedSources ? embeddedSourceRef(row) : undefined
  const sourceRef = embedded ?? fallbackSourceRef
  const category = optionalString(row, 'category', 'category')
  const ttlDays = optionalTtlDays(row)
  const eventDate = optionalDate(row, 'valid_from', 'valid_from')
  const validUntil = optionalDate(row, 'valid_to', 'valid_to')
  return {
    action: 'add',
    // The normalized identity is what the store would persist anyway; handing it in makes the string
    // compared against the target and the string written literally the same value.
    content: identity,
    ...(category === undefined ? {} : { category }),
    ...(ttlDays === undefined ? {} : { ttl_days: ttlDays }),
    ...(sourceRef === undefined ? {} : { source_ref: sourceRef }),
    ...(eventDate === undefined ? {} : { event_date: eventDate }),
    ...(validUntil === undefined ? {} : { valid_until: validUntil }),
  }
}

interface PendingImport {
  identity: string
  sourceId: number | null
  row: Record<string, unknown>
  request: Extract<RememberRequest, { action: 'add' }>
}

/**
 * Import one export document into `rt`'s memory store.
 *
 * Order of decisions per fact: archived → skipped_archived (v1 never revives); content already in
 * the target (or planned by an earlier row of this same document) → skipped_existing; otherwise the
 * store's add path runs. A row the store refuses is collected in `failed` and the loop continues.
 */
export async function importFacts(
  rt: AvantfRuntime,
  doc: FactsExportDocument,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun === true
  const trimmedRef = options.sourceRef?.trim()
  const fallbackSourceRef = trimmedRef === undefined || trimmedRef === '' ? undefined : trimmedRef
  const preferEmbeddedSources = options.preferEmbeddedSources !== false
  const targetContents = readTargetContents(rt.config.memory.db.path)
  const seen = new Set<string>()
  const pending: PendingImport[] = []
  const failed: ImportFailure[] = []
  let skippedExisting = 0
  let skippedArchived = 0

  // The document is only guaranteed at the TOP level (parseFactsExport); a hand-edited fact entry
  // must become one `failed` row, not a crash, so the loop starts from `unknown`.
  const rows: readonly unknown[] = doc.facts
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      failed.push({ source_id: null, error: '事实条目不是对象' })
      continue
    }
    const row = raw as Record<string, unknown>
    const sourceId = sourceIdOf(row)
    // Only explicit active rows are imported. Anything else is v1's "archived" bucket: v1 has no way
    // to restore an archived state, so a non-active row must never be silently turned active.
    if (row['status'] !== 'active') {
      skippedArchived += 1
      continue
    }
    if (typeof row['content'] !== 'string') {
      failed.push({ source_id: sourceId, error: 'content 缺失或不是字符串' })
      continue
    }
    const identity = identityOf(row['content'])
    if (identity === '') {
      failed.push({ source_id: sourceId, error: '内容为空' })
      continue
    }
    if (targetContents.has(identity) || seen.has(identity)) {
      skippedExisting += 1
      continue
    }
    let request: Extract<RememberRequest, { action: 'add' }>
    try {
      request = addRequestFor(identity, row, fallbackSourceRef, preferEmbeddedSources)
    } catch (error) {
      failed.push({ source_id: sourceId, error: messageOf(error) })
      continue
    }
    seen.add(identity)
    pending.push({ identity, sourceId, row, request })
  }

  const metadataDropped = emptyMetadataDropped()
  if (dryRun) {
    for (const item of pending) accumulateMetadataDropped(metadataDropped, metadataDroppedOf(item.row))
    return {
      version: doc.version,
      total: doc.facts.length,
      imported: 0,
      would_import: pending.length,
      skipped_existing: skippedExisting,
      skipped_archived: skippedArchived,
      failed,
      new_ids: [],
      metadata_dropped: metadataDropped,
    }
  }

  let imported = 0
  const newIds: ImportNewId[] = []
  for (const item of pending) {
    try {
      const result = (await rt.remember(item.request)) as { fact_id: number; is_new: boolean }
      if (result.is_new) {
        imported += 1
        newIds.push({ source_id: item.sourceId, new_fact_id: result.fact_id })
        accumulateMetadataDropped(metadataDropped, metadataDroppedOf(item.row))
      } else {
        // Only reachable when another writer landed this content between the prefilter and this
        // write. The row already existed (and add may have bumped its assert_count), so it is not a
        // new id and the metadata loss does not apply.
        skippedExisting += 1
      }
    } catch (error) {
      failed.push({ source_id: item.sourceId, error: messageOf(error) })
    }
  }

  return {
    version: doc.version,
    total: doc.facts.length,
    imported,
    skipped_existing: skippedExisting,
    skipped_archived: skippedArchived,
    failed,
    new_ids: newIds,
    metadata_dropped: metadataDropped,
  }
}

/**
 * `merge` — the db→document→import form of the same union.
 *
 * The source is another host's file: opened read-only, never migrated, never written. The document is
 * built in memory and handed to {@link importFacts}, so merge and `import` share one per-fact add
 * path (and one failure-collection rule). Its provenance stays `merge:<absolute source path>` even
 * when the source rows carry their own sources — that is the documented merge contract and the
 * reason {@link ImportOptions.preferEmbeddedSources} can be turned off.
 */
export async function mergeDb(
  rt: AvantfRuntime,
  dbPath: string,
  options: MergeOptions = {},
): Promise<MergeReport> {
  const source = resolve(dbPath)
  let isFile = false
  try {
    isFile = statSync(source).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) throw new Error('源库不存在或不是文件: ' + source)

  const sourceRef = options.sourceRef ?? ('merge:' + source)
  if (sourceRef.trim() === '') throw new Error('--source-ref 不能为空')

  const doc = readFactsDocument(source, { status: 'all', dataHome: rt.config.home })
  const report = await importFacts(rt, doc, {
    dryRun: options.dryRun === true,
    sourceRef,
    preferEmbeddedSources: false,
  })
  return {
    source,
    source_active: doc.source.counts.active,
    added: report.imported,
    would_add: report.would_import ?? 0,
    skipped_existing: report.skipped_existing,
    skipped_archived: report.skipped_archived,
    failed: report.failed.map((failure) => ({ source_fact_id: failure.source_id, error: failure.error })),
    new_ids: report.new_ids.map((entry) => ({ source_fact_id: entry.source_id, new_fact_id: entry.new_fact_id })),
  }
}
