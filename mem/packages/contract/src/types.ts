/** Shared domain types for avantf-mem. Single source of truth in @avantf/mem-contract. */

export const CATEGORY_VALUES = [
  'user_pref',
  'user_env',
  'project',
  'tool',
  'general',
] as const

export type FactCategory = (typeof CATEGORY_VALUES)[number] | string

/**
 * The fact statuses a caller may filter by, as the ONE list every surface reads: the tool schema's
 * `z.enum`, the derived MCP inputSchema and DSH parameter spec, and the CLI's `--status` flag (which
 * used to hand-copy the pair, so a new status reached every consumer except the CLI).
 */
export const FACT_STATUSES = ['active', 'archived'] as const

export type FactStatus = (typeof FACT_STATUSES)[number]

export interface FactSummary {
  fact_id: number
  content: string
  category: string
  status: FactStatus
  /**
   * Trust as of now: the decayed value for an ACTIVE fact, the stored value for a
   * non-active one. It never influences ranking (TRUST_MODEL.md D9).
   */
  trust_score: number
  /** Permanent memory: never decays, never auto-archives, never purged (D6). */
  pinned: boolean
  /** Remaining ACTIVE days before `forgot`; null when pinned / non-active / trust disabled. */
  remaining_days: number | null
  helpful_count: number
  mirror_source: string | null
  created_at: string
  archived_at: string | null
  archive_reason: string | null
}

export interface FactTriple {
  subj: string
  pred: string
  obj: string
  confidence: number
}

/**
 * The retention diagnostics on a fact view: the trust value, the active days left before the
 * trust clock forgets it, and the reinforcement counter.
 *
 * They belong to the OPERATOR surfaces (the settings page, the CLI, `trust_diagnose`) and are
 * stripped from model-facing tool results — see {@link withoutRetentionDiagnostics}. The model
 * can neither observe these clocks nor act on them, and prompt/result text about them only
 * invites "refresh a fact by rewriting it", which defeats the policy it was told about.
 */
export const RETENTION_DIAGNOSTIC_FIELDS = ['trust_score', 'remaining_days', 'helpful_count'] as const

/**
 * Drop the retention diagnostics from a fact payload (a `FactSummary`/`FactDetail`, or the
 * `{ facts: [...] }` page `mem_admin list` returns). Non-object values pass through, so a
 * caller can apply it without knowing the exact shape.
 */
export function withoutRetentionDiagnostics<T>(value: T): T {
  const project = <R>(row: R): R => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
    for (const field of RETENTION_DIAGNOSTIC_FIELDS) delete out[field]
    return out as R
  }
  if (Array.isArray(value)) return value.map(project) as unknown as T
  if (value !== null && typeof value === 'object' && Array.isArray((value as { facts?: unknown }).facts)) {
    const page = value as unknown as { facts: unknown[] }
    return { ...(value as unknown as Record<string, unknown>), facts: page.facts.map(project) } as unknown as T
  }
  return project(value)
}

export interface FactDetail extends FactSummary {
  retrieval_count: number
  mirror_target: string | null
  supersedes_id: number | null
  entities: string[]
  triples: FactTriple[]
  /** Active-day clock value at the last settle. */
  settle_clock: number
  pinned_at: string | null
  last_reinforced_at: string | null
  /**
   * When this row was last CHANGED (edit/pin/unpin/reinforce/archive/restore). Retrieval and the
   * daily settle do not write it, so it is not `last_retrieved_at`; `null` on a legacy row.
   */
  updated_at: string | null
  /** Effective reinforcement events in the current 24h window (recall + feedback). */
  bonus_count: number
  bonus_window_at: string | null
}

/** A single hit from hybrid retrieval over the merged candidate pool. */
export interface RecallHit {
  kind: 'fact' | 'doc_chunk'
  ref_id: number
  text: string
  score: number
  /**
   * Knowledge-base taxonomy (`domain → source`) of a `doc_chunk`, taken from the
   * `documents` row by the store that owns it. Both are null for memory facts.
   *
   * Carried as fields rather than re-parsed out of `source_ref`: either name may
   * itself contain `:` (`domain:source:docId:idx`), so any split of `source_ref`
   * is a guess. Filters must use these, and so must the UI.
   */
  domain: string | null
  source: string | null
  source_ref: string
  entities: string[]
  /**
   * When this hit was first recorded: a fact's revision chain keeps the ORIGINAL row's
   * `created_at` across a supersede (`mem_remember update`), so this is when the memory was
   * first asserted, not when its current text was written (see `updated_at`). A doc_chunk
   * carries its owning document's `created_at`.
   */
  created_at: string
  /**
   * When this row was last CHANGED — an edit, pin/unpin, reinforcement, archive or restore.
   * Retrieval and the daily settle deliberately do not write it, so it never means "last
   * retrieved"; a copy can carry `null` on a legacy row. A doc_chunk carries its owning
   * document's `updated_at` (re-ingest bumps it).
   */
  updated_at: string | null
  /**
   * Set when an output budget shortened `text` (see `retriever.max_output_tokens` and the
   * `max_tokens` call parameter). An entry can be truncated to EMPTY: the hit still carries
   * `source_ref`, so the caller knows it exists and can fetch it explicitly.
   */
  truncated?: boolean
}

/**
 * The relevance floors in force for ONE retrieval (`0` = that leg is not gated).
 *
 * These are values on the legs' OWN raw scales, applied before `fuse()`. They are reported because
 * an empty result has two very different readings — "the floors removed every candidate" and "no
 * leg had a candidate at all" — and only the effective values plus
 * {@link RetrievalFloorDrops} tell them apart.
 */
export interface RetrievalFloors {
  /** Cosine floor for the semantic leg (`retriever.min_semantic_similarity`). */
  semantic: number
  /** Distinct-query-term floor for the FTS leg (`retriever.min_fts_terms`; 1 when degraded). */
  fts: number
  /** Entity-overlap ratio floor (`retriever.min_jaccard`). */
  jaccard: number
}

/**
 * How many candidates each leg dropped because they fell below their floor.
 *
 * A leg absent from a query (semantic down, no query entities) reports 0 here — the counter is
 * "dropped by a floor", not "was not consulted". `hrr` shares the Jaccard floor and is only
 * separately named so a probe whose candidate set the floor narrowed is still attributable.
 */
export interface RetrievalFloorDrops {
  semantic: number
  fts: number
  jaccard: number
  hrr: number
}

export interface RecallResult {
  hits: RecallHit[]
  degraded: boolean
  weights: { semantic: number; fts: number; jaccard: number }
  /**
   * The effective relevance floors for this query, when it ran through the hybrid orchestration.
   * Absent on graph-only answers (`probe`/`chain`/`reason`/`related`), which never scored a leg.
   */
  floors?: RetrievalFloors
  /** Per-leg candidates removed by those floors (see {@link RetrievalFloorDrops}). */
  dropped_by_floor?: RetrievalFloorDrops
}

/**
 * Weights reported when the semantic leg is unavailable (FTS+entity rebalance).
 * Single source for both stores and the cross-retrieval router — previously the
 * same literal lived in three files and could silently desync.
 */
export const DEGRADED_WEIGHTS: RecallResult['weights'] = { semantic: 0, fts: 0.65, jaccard: 0.35 }

export interface ContradictionRecord {
  contradiction_id: number
  fact_a: number
  fact_b: number
  score: number
  detected_at: string
  content_a: string
  content_b: string
  category_a: string | null
  category_b: string | null
  resolved: number
}

/**
 * One contradiction found while WRITING a fact, reported from that fact's point of view.
 *
 * Declared here (not in `core`) because it is a tool-result payload: the settings page and
 * the model both consume it, and AGENTS.md makes this package the single source for tool
 * and UI payload shapes. `fact_a`/`fact_b` are normalized in the log; the write path maps
 * them to the OTHER side of the pair.
 */
export interface DetectedContradiction {
  /**
   * Row id of the conflict pair — the handle `mem_admin contradict_resolve` takes. Reported here
   * because the write path already holds it: without it, a writer that just created a conflict
   * has to go back through `mem_recall contradict` to find the id it was already told about.
   */
  contradiction_id: number
  other_fact_id: number
  score: number
}

/** Result of `mem_remember` `add`/`update` — the shape the tool returns and the UI reads. */
export interface RememberResult {
  fact_id: number
  is_new: boolean
  revived: boolean
  entities: string[]
  /**
   * Contradictions detected against the existing corpus while writing this fact (DESIGN §11).
   * Present only when at least one was found, so the writer learns immediately instead of
   * discovering it from a later sweep.
   */
  contradictions?: DetectedContradiction[]
}

// ─── admin / kb result payloads ─────────────────────────────────────────────
//
// These live here for the SAME reason `FactSummary`/`ContradictionRecord` do: they are tool and
// UI payloads, and AGENTS.md makes this package their single source. They used to be anonymous
// inline return types on the store (or named inside `core`), which left the settings page with no
// way to name them — so it hand-wrote mirrors (`StatsRow`, `RetrievalHealthRow`, `DocRow`, …) and
// a field added on the server silently rendered as `undefined` on the page. Naming them here
// removes the mirrors; the stores now return these types, so the two cannot drift.

/** One context type's share of the retrieval counters (see `RetrievalHealthSummary.by_kind`). */
export interface KindHealth {
  queries: number
  zero_results: number
  results: number
}

/** The raw retrieval-health counters the engine keeps in memory and persists (DESIGN §20). */
export interface RetrievalHealth {
  queries: number
  zero_results: number
  results: number
  latency_ms_total: number
  latency_ms_max: number
  /** Queries where the semantic leg was live / degraded (FTS+entity only). */
  semantic_live: number
  semantic_degraded: number
  rerank_used: number
  rerank_fallback: number
  /** Model-facing text that had to be bounded by a budget (see `retrieval-core/text_budget`). */
  embedding_truncated: number
  rerank_truncated: number
  output_truncated: number
  /**
   * Retrieval legs that returned exactly their cap, i.e. whose tail was dropped (`retriever.leg_cap`).
   * A leg that finished under the cap cannot have been cut, so `size === cap` is the observable
   * signal — and the only one, since fusion scaling keeps a trimmed tail from moving the survivors.
   */
  legs_capped: number
  /**
   * Candidates dropped because they fell below a leg's relevance floor (summed per leg, see
   * {@link RetrievalFloorDrops}). Zero-result queries are the reason this counter exists: with it,
   * "the floors cut everything" is distinguishable from "nothing matched" after the fact.
   */
  candidates_dropped_by_floor: number
  updated_at: string | null
  by_kind: Record<string, KindHealth>
}

/** Derived, rounded rates — what the diagnostics surfaces actually print. */
export interface RetrievalHealthSummary {
  queries: number
  zero_result_rate: number
  avg_results_per_query: number
  avg_latency_ms: number
  max_latency_ms: number
  semantic_live_rate: number
  rerank_used: number
  rerank_fallback: number
  embedding_truncated: number
  rerank_truncated: number
  output_truncated: number
  /** Retrieval legs that returned exactly their cap (see `RetrievalHealth`). */
  legs_capped: number
  /** Candidates removed by a leg's relevance floor (see `RetrievalHealth`). */
  candidates_dropped_by_floor: number
  updated_at: string | null
  by_kind: Record<string, KindHealth>
}

/** `mem_admin stats`: store counts plus the retrieval-health counters. */
export interface StatsSummary {
  active: number
  archived: number
  retrieval: RetrievalHealthSummary
}

/** One page of facts (`mem_admin list`). */
export interface FactPage {
  facts: FactSummary[]
  count: number
  total: number
  /** `true` when more rows exist beyond this page (`offset + count < total`). */
  truncated: boolean
}

/** `mem_admin trust_diagnose` — the retention report (operator-facing, never model-facing). */
export interface TrustDiagnostic {
  enabled: boolean
  clock: number
  active: number
  pinned: number
  /** ACTIVE, unpinned facts whose decayed trust reaches zero within the report's horizon. */
  forgetting_soon: number
  reinforced_today: number
  bonus_granted_today: number
  idle_candidates: number
  archived_by_reason: Record<string, number>
  oldest_settle_clock: number | null
  /**
   * ACTIVE facts whose embedding-leg conflict check has not run — they have no vector yet, so the
   * leg could not run when they were written (the embedder was unavailable). Durable: the queue is
   * a column, not an in-process Set, so it survives a restart and `contradict_check` drains it in
   * bounded batches.
   */
  conflict_pending: number
  /** ACTIVE facts still carrying entity/triple rows from an older extraction rules version. */
  entities_stale: number
}

/** `mem_admin vectors_diagnose` (see DESIGN §20 for what `space_stale` separates from `stale`). */
export interface VectorsDiagnostic {
  total: number
  with_semantic: number
  missing: number
  /** Persisted vectors whose dim no longer matches `semantic.dim`. */
  stale: number
  /** Usable vectors written in a DIFFERENT vector space (model swap, or pre-space-id rows). */
  space_stale: number
  indexed: number
  unindexed: number
  models: Record<string, number>
  /** Which backend is actually serving reads (`auto:local_numpy` → `auto:hnswlib`). */
  store: string
}

/**
 * `mem_admin vectors_fix`: what a repair did, or — with `dry_run` — what it WOULD do.
 *
 * `semantic_available` is "the model is loaded RIGHT NOW" (a dry run must not load it), so the
 * preview also carries `would_warm`: together they separate "unknown until you run it" from
 * "the warmup was attempted and failed".
 */
export interface VectorsFixReport {
  missing: number
  stale: number
  space_stale: number
  unindexed: number
  reindexed: number
  dropped: number
  fixed: number
  semantic_available: boolean
  would_warm: boolean
  dry_run: boolean
}

/** `kb_manage ingest`: what one document produced. */
export interface IngestResult {
  doc_id: number
  chunks: number
  /**
   * How many chunks did NOT get a semantic vector. Absent when every chunk did, so a healthy ingest
   * stays as quiet as it was.
   *
   * `chunks` counts what was CHUNKED, not what became semantically searchable: an encode failure (no
   * model, bad input) or a write failure (`SQLITE_BUSY` under multi-process contention) skips that
   * chunk while the text/entity/FTS indexes stay complete. Reporting the shortfall here is what stops
   * "入库成功 N 段" from implying "N 段都能被语义检索到" — before this, the only way to find out was to
   * run `kb_reindex` and compare `vectors_stale` against `vectors_encoded`. A missing embedding model
   * reports every chunk, which is the honest reading of "indexed, but not semantically".
   */
  vectors_failed?: number
  /**
   * How the source bytes became text: `utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be` or `gb18030`
   * (absent for pasted text, for a document pulled back from its managed file, and for a PDF —
   * whose text comes from an extracted layer rather than from a byte encoding). Reported because
   * decoding a legacy-encoded file is a GUESS the caller should be able to see.
   */
  encoding?: string
  /**
   * Which converter turned the source into Markdown — `docx`, `xlsx`, `html` or `csv` (absent for
   * text, PDF, and a body re-read from its managed file). The body is derived rather than read in
   * that case, so the caller is told what derived it.
   */
  converter?: string
  /** What that conversion could not carry over (dropped media, a truncated sheet, ragged rows). */
  warnings?: string[]
  /** The managed file this ingest wrote (`knowledge.docs.dir/<domain>/<source>/<title>.md`). */
  file?: string
  /** Why the managed file could not be written; the document itself is still searchable. */
  file_error?: string
}

/**
 * One existing document an ingest would land on — the machine-readable half of a collision.
 *
 * `path` is the managed `.md` copy (`knowledge.docs.dir/<domain>/<source>/<title>.md`), which is
 * what the caller edits to change that document; `doc_id`/`title` are what it takes to name the
 * collision. Reported by BOTH the add-only refusal (as text, for the agent) and the replace
 * confirmation (as a list, for the UI's dialog and the CLI).
 */
export interface KbIngestConflict {
  doc_id: number
  title: string
  path: string
}

/**
 * What `kb_manage` answers when a write would REPLACE an existing document and the caller did not
 * confirm it. `conflict: true` is the flag the UI's 入库 form and the CLI dispatch on; nothing was
 * written when this comes back, so "取消" is a no-op rather than a rollback.
 *
 * `would_overwrite`/`would_add` are the summary the confirmation dialog shows ("将覆盖 N 篇 /
 * 新增 M 篇") — computed at plan time, when the targets are known, rather than re-derived by the
 * caller from `conflicts`.
 */
export interface KbConflictReport {
  conflict: true
  /** Chinese, actionable: names the colliding documents and says nothing was written. */
  error: string
  conflicts: KbIngestConflict[]
  would_overwrite: number
  would_add: number
}

/**
 * `kb_manage import`: what landed, what failed (with the reason), and what was skipped.
 *
 * `skipped` is the DIRECTORY walk's rejections (files whose name is not an ingestable format) — a
 * silent list before this, which made "3 of 200 files imported" indistinguishable from "3 files".
 * Only the first `SKIPPED_REPORTED` (a `core` constant) paths are listed; `skipped_total` is the real count.
 */
export interface ImportResult {
  imported: IngestResult[]
  failed: { path: string; error: string }[]
  skipped: string[]
  skipped_total: number
}

/**
 * One document's managed file, as the file system sees it right now.
 *
 * `stale` means the file's body no longer matches what the KB indexed (someone edited it and
 * the change has not been ingested); `missing` means there is no file for this document (never
 * written, deleted by hand, or replaced by another document's file).
 */
export interface KbDocFile {
  doc_id: number
  title: string
  path: string
  stale: boolean
  missing: boolean
}

/**
 * `kb_manage sync`: the managed files vs what the KB indexed.
 *
 * `stale` is the plan and `reingested` what happened (equal unless `dry_run`); `orphans` are
 * managed files with no document behind them — left by a hand-deleted row, and safe to delete.
 */
export interface KbSyncReport {
  checked: number
  stale: KbDocFile[]
  missing: KbDocFile[]
  orphans: string[]
  /**
   * Files that sit exactly where a document's path says its own copy belongs, yet do not claim that
   * document — a whole-file overwrite that destroyed the frontmatter.
   *
   * These ARE recovered automatically, but only behind guards: no `doc_id` at all, a non-empty
   * body, a stamp that holds still (see `ADOPT_SETTLE_MS`) and a path exactly one document maps
   * to. A candidate that fails any of them stays here, unclaimed, and `sync {adopt: true}` is the
   * explicit per-document way to take it back immediately.
   */
  unclaimed: KbUnclaimedFile[]
  reingested: number
  /** How many documents this call adopted (`sync {adopt: true}`); 0 otherwise. */
  adopted: number
  dry_run: boolean
}

/** One adoptable file: its path names this document, but the file does not claim it. */
export interface KbUnclaimedFile {
  doc_id: number
  title: string
  path: string
}

/**
 * `kb_manage reindex`: what it did, and what it deliberately did NOT redo (DESIGN §20).
 *
 * `vectors_stale` is the plan and `vectors_encoded` what happened; they differ when the embedder
 * is unavailable, which is the case a caller needs to see instead of "nothing to do".
 */
export interface ReindexReport {
  chunks: number
  entities_rebuilt: number
  vectors_stale: number
  vectors_encoded: number
  semantic_available: boolean
  dry_run: boolean
}

/** `kb_manage list`: the stored document columns (everything but `meta`/`status`). */
export interface DocumentSummary {
  doc_id: number
  domain: string
  source: string
  title: string
  source_uri: string | null
  created_at: string
  updated_at: string
}

/** The full stored document row (`kb detail` minus its chunks). */
export interface DocumentRecord extends DocumentSummary {
  meta: string
  status: string
}

/** One stored chunk as `kb detail` returns it. */
export interface DocumentChunk {
  chunk_id: number
  idx: number
  text: string
  headings_path: string
  source_ref: string
}

/** `kb_manage detail`: the document row plus its chunks, in document order. */
export interface DocumentDetail extends DocumentRecord {
  chunks: DocumentChunk[]
}

/** What one `kb_manage` source string turned out to be. */
export type SourceKind = 'url' | 'file' | 'directory' | 'text' | 'missing'

/**
 * The answer the UI needs to label the input and pick the right `kb_manage` action.
 *
 * It lives in the CONTRACT rather than next to the engine that computes it, because the browser half
 * cannot import the engine (it must not pull node into the client bundle) and used to hand-mirror this
 * shape — the same "mirror drifts, then a render body dereferences a field the host stopped sending"
 * failure that has already cost this family once.
 */
export interface SourceClassification {
  readonly kind: SourceKind
  /** Resolved, boundary-checked absolute paths (when `kind` is `file`/`directory`). */
  readonly paths: readonly string[]
  /** Inputs that look like paths but do not resolve, or resolve outside the allowed roots. */
  readonly missing: readonly string[]
  /** Why the missing ones are missing (the boundary's own message; they differ per input). */
  readonly reasons: readonly string[]
  /** How many files a directory holds that ingestion would actually take. */
  readonly files: number
}

/** One row of a directory listing (the 选择 picker's `browseDir`). */
export interface BrowseEntry {
  readonly name: string
  readonly path: string
  /** `dir` navigates; `ingestable` can be picked; `other` exists but ingestion would refuse it. */
  readonly kind: 'dir' | 'ingestable' | 'other'
}

/**
 * One directory as the browser picker sees it.
 *
 * Pinned to the engine's `browseDirectory` return BY the host Remote declaration, which annotates its
 * payload with this interface: the two cannot drift without a type error. That check is the reason this
 * shape is spelled here rather than mirrored in the browser half.
 */
export interface BrowseListing {
  readonly path: string
  /** The parent directory, or `null` when this is an allowed root (or the filesystem root). */
  readonly parent: string | null
  /** The configured roots — what the picker may walk when `unrestricted` is false. */
  readonly roots: readonly string[]
  /**
   * `knowledge.ingest.allow_outside_workspace`: the whole filesystem is fair game, so `roots` is
   * informational only and the UI must say "不限制" rather than show a boundary it does not honour.
   */
  readonly unrestricted: boolean
  readonly entries: readonly BrowseEntry[]
}
