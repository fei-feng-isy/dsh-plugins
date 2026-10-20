/**
 * Full-fidelity REBUILD of a memory library from an export document — the ONE owner of
 * `avantf-mem restore <file>`.
 *
 * RESTORE IS NOT IMPORT. `import` / `merge` (see `facts_io.ts`) are CONTENT-IDENTITY UNIONS: new
 * rows get new ids, only ACTIVE facts travel, and every value the document carries beyond
 * category/ttl/sources/validity is counted as dropped. Restore is the opposite promise — "put this
 * library back exactly as it was" — which is only answerable if the target is EMPTY:
 *
 *   - `facts` is written DIRECTLY, one transaction, keeping `fact_id`, status, timestamps,
 *     `trust_score`, `settle_clock`, counters, pin state, TTL, validity, the supersedes pointer and
 *     the mirror bookkeeping. A non-empty target is REFUSED (never merged into), because "restore"
 *     that silently unions two histories is a different, unreviewable operation.
 *   - Rows are inserted in `source_id` ASCENDING order, so the row a `supersedes` pointer names
 *     already exists when the pointer is written. v1 documents carry the same pointer as
 *     `supersedes_source_id`, so both versions resolve identically.
 *   - `fact_sources` is restored IN FULL (a fact may carry several rows); the identity `import`
 *     is forced to collapse into one `ref` string is not a limitation restore inherits.
 *   - FTS is NOT written by hand. `facts_fts` is an external-content FTS5 table with AFTER INSERT /
 *     DELETE / UPDATE triggers (`db/schema.ts`), so inserting into `facts` indexes the row. That is
 *     the whole reason this path can bypass `MemoryStore.add` without losing lexical recall.
 *   - The DERIVED state is re-derived, not restored. `entities_version = 0` marks every row for the
 *     entity sweep, which rebuilds `fact_entities`, `triples` and the HRR bundle in bounded passes
 *     after the commit; `conflict_checked = 1` keeps a restored corpus from queueing a whole-library
 *     conflict re-scan (the log is not exported — see below).
 *   - VECTORS ARE NOT RESTORED (`semantic_vector`, `embedding_model` stay NULL, `hrr_vector` stays
 *     NULL until the sweep writes it). They are machine-local encodings of a specific model revision;
 *     copying them between hosts would create a vector space the live index cannot serve. The report
 *     says so and points at `avantf-mem vectors --fix` / a host restart.
 *
 * WHAT IS DELIBERATELY NOT RESTORED: `contradiction_log`, the retrieval-stat meta table, `tags`
 * (not exported), and `archived_clock`. The last one is a TRUST-CLOCK value ("active days at archive
 * time"); the document only carries `archived_at` (a wall-clock timestamp), and converting one into
 * the other would invent data. Leaving it NULL sends restored archived rows down
 * `purgeArchived`'s CALENDAR branch, which reads the restored `archived_at` — the honest
 * approximation, and the reason a restore does not restart every purge countdown at zero.
 *
 * V1 DOCUMENTS ARE READ. v2 only ADDED optional facts columns, so a v1 row simply lacks them; each
 * absence is counted per field in `metadata_missing` and resolved with the documented fallback. The
 * one fallback with a real decision behind it: `settle_clock` becomes the CURRENT active-day clock.
 * Zero would make every restored fact decay by the host's whole clock in one settlement; the current
 * clock is the "no decay has happened yet" baseline, which is what a fresh restore means.
 *
 * @module store/facts_restore
 */
import type { FactsExportDocument } from '../facts_io.js'
import type { Db } from '../db/conn.js'
import { readClock } from '../lifecycle/presence.js'
import { formatUtcTs } from '../lifecycle/trust.js'
import { ENTITY_SWEEP_BATCH, type EntitySweepReport } from './entity_sweep.js'

/** The one operator hint about the data restore cannot carry. */
export const RESTORE_VECTOR_HINT =
  '向量不随导出/恢复传输（它们只对产生它们的模型版本有效）：运行 `avantf-mem vectors --fix` 重算，'
  + '或重启 dsh 宿主让它按当前嵌入空间自动重算'

/**
 * Every metadata field the report accounts for.
 *
 * The list is the DOCUMENT's, not the table's: it includes the v2 additions (so a v1 file shows
 * exactly which columns it could not carry) and the derived-state stamps (which restore re-derives
 * rather than trust). A field counts as missing when the document does not carry the key at all —
 * `null` is a value the document states ("unknown"), not an absence.
 */
export const RESTORE_METADATA_FIELDS = [
  'category',
  'created_at',
  'updated_at',
  'trust_score',
  'pinned',
  'pinned_at',
  'assert_count',
  'helpful_count',
  'last_reinforced_at',
  'ttl_days',
  'valid_from',
  'valid_to',
  'supersedes_source_id',
  'archive',
  'sources',
  'settle_clock',
  'bonus_count',
  'bonus_window_at',
  'retrieval_count',
  'last_retrieved_at',
  'mirror_source',
  'mirror_target',
  'entities_version',
  'conflict_checked',
] as const
export type RestoreMetadataField = (typeof RESTORE_METADATA_FIELDS)[number]
/** Per-field count of facts whose document did not carry that field. */
export type RestoreMetadataMissing = Record<RestoreMetadataField, number>

export interface RestoreOptions {
  /** Plan only: no write, no entity rebuild; the report carries `would_restore` + `target_facts`. */
  dryRun?: boolean
}

/**
 * The store's half of the contract, narrow on purpose: the ONE write connection, plus the bounded
 * entity sweep this flow reuses after the commit. Nothing here knows about `MemoryStore`.
 */
export interface RestoreTarget {
  db: Db
  reindexEntities(budget?: number): Promise<EntitySweepReport>
}

/** How many facts a document would restore, split by status. */
export interface RestoreCounts {
  total: number
  active: number
  archived: number
}

/** The single JSON object the CLI prints (it adds `file` / `codec`, which are argv facts). */
export interface RestoreReport {
  /** The DOCUMENT's version, echoed as-is (1 or 2). */
  version: number
  /** Present on `--dry-run` only. */
  dry_run?: true
  /** Present on `--dry-run` only: what a real run would write. */
  would_restore?: RestoreCounts
  /**
   * Present on `--dry-run` only: the target's CURRENT fact count. Non-zero means the real run would
   * be refused (restore only rebuilds into an empty table).
   */
  target_facts?: number
  /** Facts actually written (0 on a dry run). */
  restored: number
  active: number
  archived: number
  metadata_missing: RestoreMetadataMissing
  /** FTS5 rows after the commit — the trigger's work, asserted equal to `restored` by the tests. */
  fts_rows: number
  entities: EntitySweepReport
  vectors: { restored: 0; hint: string }
}

/** One normalized row, ready to insert. Built BEFORE the transaction so a bad document writes nothing. */
interface RestoreRow {
  factId: number
  content: string
  category: string
  status: 'active' | 'archived'
  archivedAt: string | null
  archiveReason: string | null
  createdAt: string
  updatedAt: string
  trustScore: number
  /** `null` for a v1 document: resolved to the target's CURRENT clock inside the transaction. */
  settleClock: number | null
  assertCount: number
  helpfulCount: number
  pinned: boolean
  pinnedAt: string | null
  lastReinforcedAt: string | null
  bonusCount: number
  bonusWindowAt: string | null
  retrievalCount: number
  lastRetrievedAt: string | null
  ttlDays: number
  validFrom: string | null
  validTo: string | null
  supersedesId: number | null
  mirrorSource: string | null
  mirrorTarget: string | null
  sources: { kind: string; ref: string }[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text === '' ? null : text
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const coerced = Number(value)
  return Number.isFinite(coerced) ? coerced : null
}

function integerOrNull(value: unknown): number | null {
  const number = numberOrNull(value)
  return number === null ? null : Math.trunc(number)
}

function boolOf(value: unknown): boolean {
  return value === 1 || value === true || value === '1'
}

function emptyMetadataMissing(): RestoreMetadataMissing {
  return Object.fromEntries(RESTORE_METADATA_FIELDS.map((field) => [field, 0])) as RestoreMetadataMissing
}

/**
 * One document fact → one insert row, or a refusal naming the row.
 *
 * Fatal on purpose. `import` collects a malformed row into `failed` and keeps going because it is a
 * union (a partial import is still a useful library); a rebuild that skipped a row would silently
 * produce a DIFFERENT history — so every unrepresentable row aborts the whole restore, and the
 * pre-commit validation means it aborts without writing anything.
 */
function rowOf(raw: unknown, metadataMissing: RestoreMetadataMissing, nowSql: string): RestoreRow {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('快照里的事实条目不是对象')
  }
  const row = raw as Record<string, unknown>
  const factId = integerOrNull(row['source_id'])
  if (factId === null || factId < 1) {
    throw new Error('快照里的事实条目缺少有效的 source_id（restore 靠它保留 fact_id）')
  }
  const status = row['status']
  if (status !== 'active' && status !== 'archived') {
    throw new Error(`事实 source_id=${String(factId)} 的 status 无效：${JSON.stringify(status)}（只支持 active / archived）`)
  }
  const rawContent = row['content']
  if (typeof rawContent !== 'string' || rawContent.trim() === '') {
    throw new Error(`事实 source_id=${String(factId)} 缺少内容`)
  }

  // Absence accounting: only a MISSING key means "the document does not say". `null` is a stated
  // value ("unknown"), so it is not counted.
  for (const field of RESTORE_METADATA_FIELDS) {
    if (field === 'archive') {
      // An active row has no archive bookkeeping by definition; counting it would be noise.
      if (status === 'archived' && row['archive'] === undefined) metadataMissing.archive += 1
      continue
    }
    if (row[field] === undefined) metadataMissing[field] += 1
  }

  const category = typeof row['category'] === 'string' && row['category'].trim() !== ''
    ? row['category']
    : 'general'
  const archive = row['archive'] !== null && row['archive'] !== undefined && typeof row['archive'] === 'object'
    ? row['archive'] as Record<string, unknown>
    : undefined
  const sources: { kind: string; ref: string }[] = []
  if (row['sources'] !== undefined) {
    if (!Array.isArray(row['sources'])) {
      throw new Error(`事实 source_id=${String(factId)} 的 sources 不是数组`)
    }
    for (const entry of row['sources'] as readonly unknown[]) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`事实 source_id=${String(factId)} 的 sources 里有非对象条目`)
      }
      const source = entry as Record<string, unknown>
      const kind = typeof source['kind'] === 'string' ? source['kind'] : ''
      const ref = typeof source['ref'] === 'string' ? source['ref'] : ''
      if (kind === '' || ref === '') {
        throw new Error(`事实 source_id=${String(factId)} 的来源缺少 kind/ref`)
      }
      sources.push({ kind, ref })
    }
  }

  return {
    factId,
    content: rawContent,
    category,
    status,
    archivedAt: status === 'archived' ? (textOrNull(archive?.['at']) ?? nowSql) : null,
    archiveReason: status === 'archived' ? textOrNull(archive?.['reason']) : null,
    createdAt: textOrNull(row['created_at']) ?? nowSql,
    updatedAt: textOrNull(row['updated_at']) ?? nowSql,
    trustScore: numberOrNull(row['trust_score']) ?? 0.5,
    settleClock: numberOrNull(row['settle_clock']),
    assertCount: Math.max(1, integerOrNull(row['assert_count']) ?? 1),
    helpfulCount: Math.max(0, integerOrNull(row['helpful_count']) ?? 0),
    pinned: boolOf(row['pinned']),
    pinnedAt: textOrNull(row['pinned_at']),
    lastReinforcedAt: textOrNull(row['last_reinforced_at']),
    bonusCount: Math.max(0, integerOrNull(row['bonus_count']) ?? 0),
    bonusWindowAt: textOrNull(row['bonus_window_at']),
    retrievalCount: Math.max(0, integerOrNull(row['retrieval_count']) ?? 0),
    lastRetrievedAt: textOrNull(row['last_retrieved_at']),
    ttlDays: Math.max(0, integerOrNull(row['ttl_days']) ?? 0),
    validFrom: textOrNull(row['valid_from']),
    validTo: textOrNull(row['valid_to']),
    supersedesId: integerOrNull(row['supersedes_source_id']),
    mirrorSource: textOrNull(row['mirror_source']),
    mirrorTarget: textOrNull(row['mirror_target']),
    sources,
  }
}

/**
 * The whole document as insert rows, ordered by `source_id` ASC.
 *
 * Duplicate ids are refused here rather than becoming a PRIMARY KEY error mid-transaction: the
 * message can then name the row, and "this document is unusable" is stated before anything is
 * attempted.
 */
function planOf(doc: FactsExportDocument): {
  rows: RestoreRow[]
  metadataMissing: RestoreMetadataMissing
  counts: RestoreCounts
} {
  const metadataMissing = emptyMetadataMissing()
  const nowSql = formatUtcTs(Date.now())
  const rows: RestoreRow[] = []
  const seen = new Set<number>()
  for (const raw of doc.facts as readonly unknown[]) {
    const row = rowOf(raw, metadataMissing, nowSql)
    if (seen.has(row.factId)) {
      throw new Error(`快照里 source_id=${String(row.factId)} 出现了多次：restore 需要每行一个唯一的 fact_id`)
    }
    seen.add(row.factId)
    rows.push(row)
  }
  rows.sort((a, b) => a.factId - b.factId)
  const archived = rows.filter((row) => row.status === 'archived').length
  return {
    rows,
    metadataMissing,
    counts: { total: rows.length, active: rows.length - archived, archived },
  }
}

/** The columns restore writes. `hrr_vector`/`semantic_vector`/`embedding_model` are the NULLs. */
const INSERT_FACT_SQL = `INSERT INTO facts (
  fact_id, content, category, status, archived_at, archive_reason,
  created_at, updated_at, trust_score, settle_clock, assert_count, helpful_count,
  pinned, pinned_at, last_reinforced_at, bonus_count, bonus_window_at,
  retrieval_count, last_retrieved_at, ttl_days, valid_from, valid_to,
  supersedes_id, mirror_source, mirror_target,
  hrr_vector, semantic_vector, embedding_model, entities_version, conflict_checked
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 1)`

function countOf(db: Db, sql: string): number {
  return Number(db.prepare<{ n: number }>(sql).get()?.n ?? 0)
}

/** Why a non-empty target is refused, in the operator's terms (move it, or use the union path). */
function emptyTableRefusal(existing: number): string {
  return `目标记忆库不是空的（facts 表已有 ${String(existing)} 条事实）：restore 只把快照重建到空库，绝不并入现有事实。`
    + '请先把现有库移走或备份（例如把 <数据根>/memory 目录改名），再对一个空数据根执行 restore；'
    + '要把两份库合成一份请用 import / merge（按内容并集，只导 ACTIVE、不保 id）。'
}

/**
 * Rebuild the target library from `doc`.
 *
 * Order of guarantees: the document is validated COMPLETELY first (no writes on a bad file), then one
 * `BEGIN IMMEDIATE` transaction re-checks emptiness and inserts facts + sources (a failure anywhere
 * rolls the whole thing back), and only after that commit does the derived state get rebuilt. The
 * entity sweep is deliberately OUTSIDE the transaction: it is bounded, resumable work, and holding
 * the write lock for a whole-corpus re-extraction is exactly what its batch exists to avoid.
 */
export async function restoreFactsDocument(
  target: RestoreTarget,
  doc: FactsExportDocument,
  options: RestoreOptions = {},
): Promise<RestoreReport> {
  // Validate EVERY row before touching the database. A refusal here therefore leaves the target
  // byte-identical, which is the strong form of "--dry-run writes nothing" for the real run too.
  const { rows, metadataMissing, counts } = planOf(doc)
  const vectors = { restored: 0 as const, hint: RESTORE_VECTOR_HINT }

  if (options.dryRun === true) {
    return {
      version: doc.version,
      dry_run: true,
      would_restore: counts,
      // The one thing a plan cannot know from the document: whether the real run would be refused.
      target_facts: countOf(target.db, 'SELECT COUNT(*) AS n FROM facts'),
      restored: 0,
      active: 0,
      archived: 0,
      metadata_missing: metadataMissing,
      fts_rows: countOf(target.db, 'SELECT COUNT(*) AS n FROM facts_fts'),
      entities: { rebuilt: 0, deferred: 0, skipped: false },
      vectors,
    }
  }

  let restoredActive = 0
  let restoredArchived = 0
  try {
    // IMMEDIATE, not the default DEFERRED: the emptiness test is a READ, and a deferred transaction
    // takes the write lock only at the first INSERT — another process could write a fact in between,
    // and the restore would then be merging into a library it had just certified as empty.
    target.db.transaction(() => {
      const existing = countOf(target.db, 'SELECT COUNT(*) AS n FROM facts')
      if (existing !== 0) throw new Error(emptyTableRefusal(existing))
      // v1 has no settle_clock: the CURRENT active-day clock is the "no decay yet" baseline (0 would
      // decay every restored fact by the host's entire clock in the next settlement).
      const clock = readClock(target.db)
      const insertFact = target.db.prepare(INSERT_FACT_SQL)
      const insertSource = target.db.prepare('INSERT INTO fact_sources (fact_id, kind, ref) VALUES (?, ?, ?)')
      for (const row of rows) {
        try {
          insertFact.run(
            row.factId, row.content, row.category, row.status, row.archivedAt, row.archiveReason,
            row.createdAt, row.updatedAt, row.trustScore, row.settleClock ?? clock,
            row.assertCount, row.helpfulCount, row.pinned ? 1 : 0, row.pinnedAt, row.lastReinforcedAt,
            row.bonusCount, row.bonusWindowAt, row.retrievalCount, row.lastRetrievedAt, row.ttlDays,
            row.validFrom, row.validTo, row.supersedesId, row.mirrorSource, row.mirrorTarget,
          )
          for (const source of row.sources) {
            insertSource.run(row.factId, source.kind, source.ref)
          }
        } catch (error) {
          throw new Error(
            `写入事实失败（source_id=${String(row.factId)}）：${messageOf(error)}（整个事务已回滚，目标库没有写入任何一行）`,
          )
        }
        if (row.status === 'archived') restoredArchived += 1
        else restoredActive += 1
      }
    }).immediate()
  } catch (error) {
    // A rolled-back attempt must not claim rows in the report.
    restoredActive = 0
    restoredArchived = 0
    throw error
  }

  // Derived state, AFTER the commit and in bounded passes — the same loop the CLI's `maintenance`
  // runs. The sweep only selects ACTIVE facts, so archived rows keep an empty entity graph (they are
  // outside every retrieval leg), which is what `rebuilt` versus `restored` will show.
  let rebuilt = 0
  let deferred = 0
  let skipped = false
  for (;;) {
    const pass = await target.reindexEntities(ENTITY_SWEEP_BATCH)
    rebuilt += pass.rebuilt
    deferred = pass.deferred
    skipped = skipped || pass.skipped
    if (pass.rebuilt === 0 || pass.deferred === 0) break
  }

  // The sweep requeues the conflict check per rebuilt row (its two inputs — entities and triples —
  // just changed, so any verdict about them is stale). After a RESTORE that requeue is pure cost:
  // the contradiction log is NOT part of the snapshot, so there is no stale verdict to invalidate,
  // and re-checking a whole corpus is exactly what `conflict_checked = 1` on the insert avoids.
  // Re-stamp the restored range (`fact_id <=` the plan's max; a concurrent writer's new rows have
  // larger ids and keep their own stamp).
  const maxFactId = rows.length === 0 ? 0 : (rows[rows.length - 1]?.factId ?? 0)
  if (maxFactId > 0) {
    target.db.prepare('UPDATE facts SET conflict_checked = 1 WHERE fact_id <= ?').run(maxFactId)
  }

  return {
    version: doc.version,
    restored: restoredActive + restoredArchived,
    active: restoredActive,
    archived: restoredArchived,
    metadata_missing: metadataMissing,
    fts_rows: countOf(target.db, 'SELECT COUNT(*) AS n FROM facts_fts'),
    entities: { rebuilt, deferred, skipped },
    vectors,
  }
}

