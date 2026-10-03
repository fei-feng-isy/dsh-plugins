import {
  describeError,
  type Config,
  type ContradictionRecord,
  type DetectedContradiction,
  type FactDetail,
  type FactPage,
  type FactSummary,
  type FloorProfile,
  type RecallHit,
  type RecallResult,
  type RememberResult,
  type TrustDiagnostic,
  type VectorsDiagnostic,
  type VectorsFixReport,
} from '@avantf/mem-contract'
import type { Reranker, SemanticBackend, VectorStore } from '@avantf/mem-retrieval'
import {
  resetRetrievalHealth,
  restoreRetrievalHealth,
  retrievalHealth,
  retrievalLogger,
} from '@avantf/mem-retrieval'
import {
  hybridSearch,
  RetrievalInputError,
  rerankState as rerankerState,
  type HybridContext,
  type HybridDeps,
  type HybridLeg,
} from './hybrid.js'
import { evictVectors as evictVectorsOf, normalizeWrite, normalizeWrites, reportForeignVectors, vectorSpaceOf } from './common.js'
import type { Db } from '../db/conn.js'
import { bytesToFloat32, float32ToBytes, reloadVectorIndex, vectorCachePath } from '../db/vectors.js'
import { buildFtsQuery, detectFtsTokenizer, reportFtsTokenizerDrift, resolveFtsTokenizer, type FtsTokenizer } from '../db/tokenizer.js'
import { probeTerms, type LexicalProbe } from './lexical.js'
import { applyScoreFloor, applyTermFloor, type FloorLeg } from './floors.js'
import {
  ENTITY_EXTRACTOR_VERSION,
  entitiesFromTokens,
  extractEntities,
  parseQueryPattern,
  tagText,
  triplesFromTokens,
  type ExtractedTriple,
  type TriplePattern,
} from '../entities/extract.js'
import { encodeHrrEntityVector, hrrFromBytes, hrrToBytes, phaseSimilarity } from '../hrr/index.js'
import { EntitiesDao } from '../db/dao/entities.js'
import { StatsDao } from '../db/dao/stats.js'
import { FactsDao } from '../db/dao/facts.js'
import { TriplesDao } from '../db/dao/triples.js'
import { ContradictDetector, type Sig } from '../lifecycle/contradiction.js'
import { runMaintenance, type MaintenanceResult } from '../lifecycle/maintenance.js'
import { advancePresence, initClock, readClock } from '../lifecycle/presence.js'
import { runTrustTick, type TickResult } from '../lifecycle/tick.js'
import {
  EPSILON,
  applyFeedbackDelta,
  clamp01,
  displayTrust,
  effectiveTrust,
  formatUtcTs,
  grantRecallBonus,
  isPinned,
  remainingDays,
  type TrustRow,
} from '../lifecycle/trust.js'

/**
 * Result shapes live in `@avantf/mem-contract` (single source for tool/UI payloads); these
 * aliases keep the long-standing `@avantf/mem` export names working for consumers.
 */
export type { DetectedContradiction, RememberResult as AddResult } from '@avantf/mem-contract'

/** `trust_diagnose` reports how many facts are within this many ACTIVE days of forgetting. */
const FORGETTING_SOON_DAYS = 7

/**
 * Facts one `contradict_check` may drain from the durable pending queue.
 *
 * Bounded because the queue is unbounded by nature (it grows while the embedder is down): one call
 * must not walk the whole backlog. 2000 matches the tick's own per-pass budget, and the drain is
 * resumable — the queue is in the database, so an operator can call it again.
 */
const PENDING_CONFLICT_BATCH = 2000

/**
 * "No check was attempted" — the write paths that alter nothing (a duplicate `add`, a re-save of
 * identical content onto the same fact). Nothing is stamped, and the row keeps whatever marker it
 * already had.
 */
const NO_CHECK: { conflicts: DetectedContradiction[]; complete: boolean } = { conflicts: [], complete: false }

/**
 * Facts one derived-state sweep pass may rebuild (`reindexEntities`'s default budget).
 *
 * Bounds MEMORY, not only mission: the pass selects `content` for every row it takes, so an
 * "unbounded" pass (the CLI used to ask for `Number.MAX_SAFE_INTEGER`) builds an array of every
 * stale fact's text before rebuilding the first one. Callers that want the corpus drained loop
 * until `deferred === 0` instead.
 */
export const ENTITY_SWEEP_BATCH = 2000

/** What one derived-state sweep pass did (see `MemoryStore.reindexEntities`). */
export interface EntitySweepReport {
  /**
   * Facts this pass RE-EXTRACTED, i.e. its batch size when it filled it. Counts rows VISITED and
   * re-stamped, not rows whose extraction output differs — the stamp is what makes the corpus
   * current, so a row re-extracted to the same names still counts (and is not rebuilt again).
   */
  rebuilt: number
  /** Facts still written by older rules after this pass. */
  deferred: number
  /** Another pass was already running, so this one did nothing (`deferred` is still current). */
  skipped: boolean
}

/** What one bounded conflict-drain pass did (see `MemoryStore.drainConflicts`). */
export interface ConflictDrainReport {
  /** Pairs newly logged by this pass. */
  logged: Sig[]
  /**
   * Rows the pass COMPLETED — the embedding leg held their vector in the live index, so the stamp
   * moved. Deliberately not the batch size: a row whose vector the index cannot serve stays queued
   * (see `CheckResult`), which is why this can be 0 while `pending` is not.
   */
  checked: number
  /** Rows still queued after this pass (including any it could not complete). */
  pending: number
}

/**
 * Counts-only view of one conflict pass, for the `maintenance` payload: the pairs themselves are
 * the `contradict_check` payload, and a settings-page click has no use for a list of them.
 */
export interface ConflictSweepCounts {
  /** Rows the pass completed (the embedding leg held their vector). */
  checked: number
  /** Pairs it logged. */
  logged: number
  /** Rows still queued afterwards. */
  pending: number
}

/**
 * `avantf_stats` key holding the retrieval-health snapshot.
 *
 * The counters are process-wide, but the MEMORY store owns the side table, so it is the single
 * writer: a second store writing the same key would race the first. Persisting matters because
 * the reference design loses its counters on restart, which makes a long-standing degradation
 * look like a fresh healthy process.
 */
const RETRIEVAL_HEALTH_KEY = 'retrieval_health'

/**
 * Outcome of adjudicating a conflict (see `MemoryStore.resolveContradiction`). `reason` is
 * present only on a refusal, so a caller can tell "the pair is closed" from "your request
 * named a fact that is not in the pair".
 */
export interface ContradictionResolution {
  resolved: boolean
  contradiction_id: number
  /** The fact that was archived as the loser, when the verdict named one. */
  archived_loser: number | null
  /**
   * Why the verdict was refused. `already_resolved` means the pair carries a verdict already — see
   * {@link MemoryStore.resolveContradiction} for why a second one is refused rather than applied.
   */
  reason?: 'not_found' | 'already_resolved' | 'loser_not_in_pair' | 'loser_requires_true_positive'
}

export interface SearchInput {
  query: string
  category?: string
  limit?: number
  /** Also fuse the HRR entity-probe path (used by `recall.probe`). */
  includeHrr?: boolean
  /**
   * Record retrieval stats for the returned facts (default true). Cross-store
   * `kb_query` sets this false and marks only the hits it actually returns, so
   * router-side filtering cannot refresh the dormancy clock of unseen facts.
   */
  track?: boolean
  /**
   * Pre-encoded query vector, when the caller already has one. `runtime.query` encodes a
   * cross-store query ONCE and hands the same vector to both stores (they share the same
   * backend and model), instead of each leg paying for its own encode. The store does not
   * verify it, so it must come from the same backend.
   */
  queryVector?: Float32Array
  /** Per-call output token budget; `0` = unlimited, omitted = `retriever.max_output_tokens`. */
  maxTokens?: number
  /**
   * Relevance-floor profile for this query. Omitted = the default policy: the configured (strict)
   * floors, and if they empty the result while having dropped candidates, ONE relaxed pass
   * (`store/floors.ts`'s `LOOSE_FLOORS`) before answering. `'strict'` asserts the configured floors
   * with no fallback — what the UI's 严格 mode asks for, so the panel can show the honest strict
   * outcome and the drop count. `'loose'` applies the relaxed floors outright.
   */
  floors?: FloorProfile
  /**
   * Which legs a `'loose'` pass may lower (see `store/floors.ts`). Internal: an omitted value lets
   * the default policy derive it from the strict pass's own drop report, while the cross-store
   * router pins the MERGED strict pass's dropping legs on its second call — only the merged result
   * knows which legs were the problem for the user's one question.
   */
  relaxLegs?: readonly FloorLeg[]
  /**
   * Emit a `kind: 'memory'` health event for this search (default true). The cross-store router
   * sets it false: it fuses this leg with the knowledge leg and records ONE `kind: 'cross'`
   * event, so `queries` counts user questions instead of legs (DESIGN §20.5). Distinct from
   * `track`, which is about the dormancy clock — a caller may want one without the other.
   */
  recordStats?: boolean
}

/**
 * Result envelope for pure graph operations (ask/chain/reason/related).
 *
 * `degraded: false` with all-zero weights is the honest report: these paths are SQL
 * over triples/entities and never had a fusion leg, so nothing about them can be
 * degraded — and `degraded: true` would wrongly suggest a quality loss. A caller that
 * needs "was the semantic leg live?" must read `weights.semantic > 0` (as `crossQuery`
 * does), not `degraded`.
 */
/** The memory FTS table; its tokenizer is read from the database at open (see `ftsTokenizer`). */
const MEMORY_FTS_TABLE = 'facts_fts'

const GRAPH_RESULT: Pick<RecallResult, 'degraded' | 'weights'> = {
  degraded: false,
  weights: { semantic: 0, fts: 0, jaccard: 0 },
}

export class MemoryStore {
  private readonly db: Db
  private readonly config: Config
  private readonly semantic: SemanticBackend
  private readonly vstore: VectorStore
  private readonly reranker: Reranker
  private readonly contradictions: ContradictDetector
  private readonly facts: FactsDao
  private readonly entities: EntitiesDao
  private readonly triples: TriplesDao
  /**
   * The tokenizer `facts_fts` was ACTUALLY built with, read from the database at open.
   *
   * Not `resolveFtsTokenizer()`: `CREATE VIRTUAL TABLE IF NOT EXISTS` never rebuilds an existing
   * table, so a database created under another SQLite build keeps the tokenizer it was born with,
   * and building MATCH expressions for the wrong one is silent zero recall (see `db/tokenizer.ts`).
   */
  private readonly ftsTokenizer: FtsTokenizer
  /** In-flight guard for `reindexEntities` (see there: the periodic callers can overlap). */
  private entitySweepInFlight = false
  /**
   * Where the next conflict drain resumes (see `checkContradictions`). A scheduling cursor, not
   * derived state: nothing is lost when it resets, and the queue itself is in the database.
   */
  private conflictDrainCursor = 0

  constructor(
    db: Db,
    config: Config,
    semantic: SemanticBackend,
    vstore: VectorStore,
    reranker: Reranker,
    /** The store's database path, used ONLY to name the vector index snapshot beside it. */
    dbPath?: string,
  ) {
    this.db = db
    this.config = config
    this.semantic = semantic
    this.vstore = vstore
    this.reranker = reranker
    const detectedFts = detectFtsTokenizer(db, MEMORY_FTS_TABLE)
    this.ftsTokenizer = detectedFts ?? resolveFtsTokenizer()
    // No operator-facing command rebuilds the memory FTS table (a schema migration does), so the
    // drift notice names no remedy rather than inventing one.
    reportFtsTokenizerDrift('memory index', MEMORY_FTS_TABLE, detectedFts, null)
    this.facts = new FactsDao(db)
    this.entities = new EntitiesDao(db)
    this.triples = new TriplesDao(db)
    this.contradictions = new ContradictDetector(
      db,
      config.lifecycle.contradiction_threshold,
      (ids) => this.vstore.fetch(ids),
      (id) => this.entityNames(id),
      (ids) => this.entityBags(ids),
    )
    this.restoreHealth()
    // Repair the clock BEFORE the startup pass reads it. The clock anchors every lifecycle window
    // (settle/TTL/forget/idle/purge), so a lost meta row beside existing facts would measure all of
    // them from 0 and let rows live forever. `initClock` is `max(stored, MAX(settle_clock))` — one
    // index scan — so it runs ONCE here instead of on every presence, where the same scan would ride
    // each heartbeat; a healthy store reads its stored value back unchanged.
    initClock(db)
    // Startup pass FIRST: presence + tick then build the index from the post-tick
    // ACTIVE set, so archived rows never enter it and no extra eviction is needed (R9).
    this.trustTick()
    // Let the index cache itself next to the database (space-qualified): the reload below can
    // then RESTORE the native graph instead of rebuilding it, which is the difference between a
    // ~16 ms and a ~1.3 s startup at 8000 vectors.
    if (dbPath) {
      const cachePrefix = vectorCachePath(dbPath, this.vectorSpace())
      if (cachePrefix !== null) this.vstore.attachPersistence?.(cachePrefix)
    }
    this.reloadIndex()
  }

  /**
   * One automatic trust/lifecycle pass (spec §5): advance the active-day clock
   * (when trust is enabled), run the tick, and evict archived/purged vectors from
   * the live index. Called at startup, from the heartbeat, and by `maintenance()`.
   */
  trustTick(opts?: { budget?: number | null }): TickResult {
    const trust = this.config.trust
    const clock = trust.enabled
      ? advancePresence(this.db, { gapCapDays: trust.presence.gap_cap_days }).clock
      : readClock(this.db)
    const result = runTrustTick(this.db, this.config, { clock, budget: opts?.budget ?? trust.tick_max_facts })
    this.evictVectors([...result.archived_ids, ...result.purged_ids])
    this.retireConflicts([...result.archived_ids, ...result.purged_ids])
    // Keep planner statistics current. Without them the contradiction candidate self-join
    // picked a covering scan of `facts` (measured 130 ms → 0.08 ms once analyzed), and the
    // tick is the one periodic hook we already have (startup + heartbeat). `optimize` is a
    // no-op when the statistics are fresh (0.05 ms), and only analyzes what changed.
    this.db.pragma('optimize')
    return result
  }

  /** Identity of the vector space this store currently writes into (`vectorSpaceId`). */
  private vectorSpace(): string {
    return vectorSpaceOf(this.semantic, this.config.semantic.local_model)
  }

  /**
   * Rebuild the in-memory vstore from persisted `facts.semantic_vector` BLOBs.
   * Without this the semantic path is silently empty after every process restart
   * (the DB is the authoritative vector store; the vstore is a derived read model).
   *
   * Only ACTIVE facts are indexed: archived facts are filtered out of every
   * retrieval path anyway, so loading them would only grow the index forever.
   * `archive()` evicts and `restore()` re-adds, keeping the invariant.
   */
  private reloadIndex(): void {
    const space = this.vectorSpace()
    const persisted = this.facts.activeVectorRows()
    const rows = persisted.map((r) => ({ id: r.fact_id, vec: r.semantic_vector }))
    reloadVectorIndex(this.vstore, rows, 'memory')
    // A dim-valid vector from another space is still RANKED (the reload cannot tell the
    // difference), so a silent model swap would mix two spaces in one index. Say so once per
    // process; acting on it is `vectors_fix`'s job, because re-encoding is a real cost the
    // operator should choose (and see the count of).
    reportForeignVectors(
      'memory',
      space,
      persisted.filter((r) => r.embedding_model !== space).length,
      'mem_admin vectors_fix (dry_run=true previews the count)',
    )
  }

  async add(content: string, category?: string, ttlDays?: number): Promise<RememberResult> {
    // Normalize BEFORE tagging: the row, every derived entity/triple and the `entities` this call
    // RETURNS all descend from this one string, so repairing it here is what lets them agree
    // (`normalizeWrite` = well-formed + NFC; see store/common).
    const normalized = normalizeWrite(content).trim()
    if (!normalized) throw new Error('内容不能为空')

    // ONE tagging pass drives both extractors (they used to tag the same content separately).
    const tokens = await tagText(normalized)
    const entities = normalizeWrites(entitiesFromTokens(tokens, normalized).map((e) => e.name))
    const triples = this.normalizeTriples(triplesFromTokens(tokens))

    // `category`/`ttlDays` stay `undefined` when unset, so a duplicate-content hit keeps the
    // existing row's values instead of resetting them (see `persistFact`).
    const { fact_id, is_new, revived } = this.persistFact(
      normalized,
      category === undefined ? undefined : normalizeWrite(category),
      ttlDays,
      entities,
      triples,
    )
    if (is_new || revived) {
      // Index BEFORE checking: the embedding leg can only see a vector that exists,
      // and the fact being written should participate in its own check.
      await this.maybeIndexSemantic(fact_id, normalized)
    }
    const check = is_new || revived ? this.detectContradictions(fact_id) : NO_CHECK
    // The stamp is about the CHECK, not about the write: it moves only when the detection pass
    // reports it actually had this fact's vector (see `detectContradictions`). A write that could
    // not encode stays pending in the database, which is what survives a restart (the reason
    // `conflict_checked` exists at all).
    if (check.complete) this.facts.markConflictChecked([fact_id])
    // A duplicate `add` (is_new === false && !revived) changes nothing: the row already
    // exists and its conflicts were reported when it was first written, so re-reporting them
    // on every idempotent re-add would be noise (and a repeated detection pass).
    return { fact_id, is_new, revived, entities, ...(check.conflicts.length > 0 ? { contradictions: check.conflicts } : {}) }
  }

  /**
   * Write-path contradiction detection (DESIGN §11): check the fact that was just
   * written against the corpus, then report its FULL open-conflict set.
   *
   * The check's own return value is not enough: `maybeLog` skips pairs that are already
   * open, so what it returns is "what this pass inserted" — while the caller's question is
   * "what does this write conflict with?". Reporting only the new rows made an update that
   * merged into an already-conflicting fact look clean.
   *
   * Best-effort — a detection failure must never fail the write, and the fact stays PENDING for
   * the next `contradict_check`. `complete` is what enforces that second half: it is true only
   * when nothing went wrong AND the pass held this fact's vector, so a caught failure can never
   * be mistaken for a finished check (an earlier version returned `[]` for both and the caller
   * stamped the marker anyway — a permanent, silent exemption).
   */
  private detectContradictions(factId: number): { conflicts: DetectedContradiction[]; complete: boolean } {
    try {
      const checked = this.contradictions.checkOne(factId)
      const conflicts = this.contradictions.openConflictsFor(factId).map((c) => ({
        contradiction_id: c.contradiction_id,
        other_fact_id: c.fact_a === factId ? c.fact_b : c.fact_a,
        score: c.score,
      }))
      return { conflicts, complete: checked.complete.includes(factId) }
    } catch (error) {
      retrievalLogger().warn(`contradiction check failed for fact ${factId}: ${describeError(error)}`)
      return { conflicts: [], complete: false }
    }
  }

  /** Best-effort semantic indexing: encode the fact and add it to the vstore. */
  private async maybeIndexSemantic(factId: number, content: string): Promise<boolean> {
    try {
      if (!this.semantic.isAvailable()) {
        // Observing call site: keep a failed bootstrap retryable so a recovered
        // mirror is picked up without a restart (see warm_gate.ts).
        this.semantic.ensureWarm?.()
        return false
      }
      const vec = await this.semantic.encode(content)
      this.vstore.add(factId, vec)
      // Record the VECTOR SPACE, not just the backend name: a same-width model swap is
      // otherwise indistinguishable from "already encoded" (DESIGN §20).
      this.facts.setSemanticVector(factId, float32ToBytes(vec), this.vectorSpace(), this.vstore.name)
      return true
    } catch (error) {
      // Not silent, and the two failures mean different things. An encode failure leaves the fact
      // unindexed, which `vectors_diagnose` reports as missing and `vectors_fix` repairs. A failure
      // in `setSemanticVector` (SQLITE_BUSY under multi-process contention) is worse: the vector IS
      // in the live index but was not persisted, so this process answers with it and the next one
      // does not — a divergence nothing else would ever mention.
      retrievalLogger().warn(
        `memory index: fact ${String(factId)} was not semantically indexed (${describeError(error)}) — `
        + 'run mem_admin vectors_diagnose to see the shortfall, vectors_fix to re-encode',
      )
      return false
    }
  }

  async update(fact_id: number, content: string, category?: string, ttlDays?: number): Promise<RememberResult> {
    const row = this.getRow(fact_id)
    if (!row) throw new Error(`找不到 fact_id=${fact_id}`)
    // Same entry as `add`: normalize before tagging, so the replaced row, its derived data and the
    // echoed `entities` all describe the SAME text (see there).
    const normalized = normalizeWrite(content).trim()
    if (!normalized) throw new Error('内容不能为空')
    // Re-extract for the NEW content: an updated fact must stay visible to the
    // entity/jaccard/ask paths and to semantic search, exactly like a fresh add.
    // ONE tagging pass drives both extractors (they used to tag the same content separately).
    const tokens = await tagText(normalized)
    const entities = normalizeWrites(entitiesFromTokens(tokens, normalized).map((e) => e.name))
    const triples = this.normalizeTriples(triplesFromTokens(tokens))
    // Archive old and create a fresh fact linked by supersedes_id.
    // A revision is the same fact rewritten: `persistFact` carries the replaced row's
    // category and TTL over unless the caller gave new ones, so an update no longer
    // silently drops an explicit TTL (or retags the fact a merge lands on).
    const { fact_id: newId, is_new, revived } = this.persistFact(
      normalized,
      category === undefined ? undefined : normalizeWrite(category),
      ttlDays,
      entities,
      triples,
      { supersedesId: fact_id, archiveOldIfActive: true },
    )
    if (is_new || revived) await this.maybeIndexSemantic(newId, normalized)
    // `changed` = this write altered state. The MERGE case (`newId !== fact_id`, the new
    // content was already an existing fact) counts even though `is_new` is false — it
    // archived a revision — while re-saving identical content onto the same fact is a true
    // no-op and must stay as quiet as a duplicate `add`.
    const changed = is_new || revived || newId !== fact_id
    const check = changed ? this.detectContradictions(newId) : NO_CHECK
    // Same rule as `add`: the marker follows the CHECK, not the write (see there).
    if (check.complete) this.facts.markConflictChecked([newId])
    return { fact_id: newId, is_new, revived, entities, ...(check.conflicts.length > 0 ? { contradictions: check.conflicts } : {}) }
  }

  remove(fact_id: number, reason = 'manual'): boolean {
    return this.archive(fact_id, reason)
  }

  archive(fact_id: number, reason = 'manual'): boolean {
    const status = this.facts.statusOf(fact_id)
    if (status === undefined) return false
    if (status === 'archived') return true
    // The one writer of `archive_reason` — the contract's `reason` AND the lifecycle's own literals
    // both land here, so normalizing at this entry covers every caller.
    const changed = this.facts.archive(fact_id, readClock(this.db), normalizeWrite(reason))
    // The live index tracks ACTIVE facts only (see reloadIndex): drop the vector.
    if (changed > 0) {
      this.vstore.remove(fact_id)
      // A conflict with an archived fact is no longer actionable: retire its open rows
      // so `contradict`/the settings page never show a stale pair, and so they cannot
      // accumulate across archive/restore cycles.
      this.contradictions.resolveForFact(fact_id)
    }
    return changed > 0
  }

  /**
   * Bring an archived fact back (spec §2.6): a `forgot` fact is lifted to
   * `recall_floor` (otherwise the very next tick would re-archive it, R4), the
   * idle clock is refreshed (otherwise an `idle`-archived fact dies again, R18),
   * and `settle_clock` moves to now so the downtime is not charged.
   */
  restore(fact_id: number): boolean {
    const row = this.getRow(fact_id)
    if (!row) return false
    const trust = this.config.trust
    const clock = readClock(this.db)
    const stored = Number(row.trust_score)
    const lift = String(row.archive_reason) === 'forgot' || stored <= trust.forget_threshold
    const next = lift ? Math.max(stored, trust.recall_floor) : stored
    if (this.facts.restore(fact_id, next, clock) === 0) return false
    // Re-index the persisted vector (archive evicted it from the live index).
    const vec = bytesToFloat32((row.semantic_vector as Uint8Array | null) ?? null)
    if (vec && vec.length === this.vstore.dim) this.vstore.add(fact_id, vec)
    // Back in the ACTIVE corpus, so run the write-path check again: archiving retired this
    // fact's open conflicts, and without re-checking they would stay invisible even though
    // both sides are active again. Best-effort, like every other write-path detection — and, as
    // there, only a check that actually ran is allowed to move the marker.
    if (this.detectContradictions(fact_id).complete) this.facts.markConflictChecked([fact_id])
    return true
  }

  helpful(fact_id: number): number | null {
    return this.applyFeedback(fact_id, +1)
  }

  unhelpful(fact_id: number): number | null {
    return this.applyFeedback(fact_id, -1)
  }

  /**
   * Explicit feedback (spec §2.4). Pinned/archived rows only move `helpful_count`
   * (R7); otherwise the decay is settled first, then `±feedback_delta`, pin at the
   * permanent threshold (snap to 1.0) or archive immediately at the forget line.
   */
  private applyFeedback(fact_id: number, delta: number): number | null {
    // Cheap existence check first, so a bogus id does not pay for a write lock.
    if (this.getRow(fact_id) === undefined) return null
    const trust = this.config.trust
    // The transaction only writes the DB and REPORTS what must leave the live index:
    // mutating the index inside the transaction would leave it diverged from the DB if
    // the transaction rolled back.
    //
    // IMMEDIATE, with the row and the clock read INSIDE it: this is a cross-process
    // read-modify-write of the per-fact 24h bonus counter, and a DEFERRED transaction takes the
    // write lock only at its first WRITE — after the read. Two processes applying feedback to the
    // same fact would then both compute their outcome from the same stale `bonus_count` and both
    // grant it, i.e. the daily cap gets spent twice. The presence clock and the lifecycle tick
    // already use `immediate` for exactly this reason (see `db/port.ts`).
    const tx = this.db.transaction((): number | null => {
      const row = this.getRow(fact_id)
      if (!row) return null
      const clock = readClock(this.db)
      const outcome = applyFeedbackDelta(asTrustRow(row), clock, delta, Date.now(), trust)
      this.facts.bumpHelpful(fact_id, delta)
      if (outcome.untouched) return null
      if (outcome.pin) {
        this.facts.pinOutcome(fact_id, clock, outcome.bonusCount, outcome.windowAt)
        return null
      }
      if (outcome.forget) {
        this.facts.forgetOutcome(fact_id, outcome.next, clock, outcome.bonusCount, outcome.windowAt)
        this.contradictions.resolveForFact(fact_id)
        return fact_id
      }
      this.facts.reinforceOutcome(fact_id, outcome.next, clock, outcome.bonusCount, outcome.windowAt)
      return null
    })
    const evict = tx.immediate()
    if (evict !== null) this.evictVectors([evict])
    return (this.getRow(fact_id)?.helpful_count ?? 0) as number
  }

  /** Permanent-memory administration (spec §6). */
  pin(fact_id: number): boolean {
    return this.facts.pin(fact_id, readClock(this.db)) > 0
  }

  unpin(fact_id: number): boolean {
    return this.facts.unpin(fact_id, readClock(this.db)) > 0
  }

  /**
   * Trust/forgetting diagnostics (spec §6, R17/R24): the quota is PER FACT, so the
   * report exposes "facts that consumed quota today" and "total effective gains"
   * rather than a meaningless global remaining.
   */
  trustDiagnose(): TrustDiagnostic {
    const trust = this.config.trust
    const clock = readClock(this.db)
    const active = this.facts.countActive()
    const pinned = this.facts.countPinnedActive()
    const forgettingSoon = trust.decay_per_day > 0
      ? this.facts.countForgettingWithin({ step: trust.decay_per_day, clock, withinDays: FORGETTING_SOON_DAYS })
      : 0
    const bonus = this.facts.bonusStatedToday()
    const reinforcedToday = bonus.count
    const grantedToday = bonus.granted
    const idleCandidates = this.facts.countIdleCandidates(trust.idle_calendar_days)
    const reasons = this.facts.archivedByReason()
    const oldest = this.facts.minSettleClock()
    return {
      enabled: trust.enabled,
      clock,
      active,
      pinned,
      forgetting_soon: forgettingSoon,
      reinforced_today: reinforcedToday,
      bonus_granted_today: grantedToday,
      idle_candidates: idleCandidates,
      // Derived state that is BEHIND the code, in the same report as the other diagnostics: a
      // backlog is otherwise invisible until retrieval quality or the sweep is questioned.
      // `conflict_pending` counts facts whose embedding-leg check has not run (they are waiting for
      // an embedder, which is why they have no vector) and `entities_stale` counts facts still
      // carrying entity/triple rows from an older extraction rule set.
      conflict_pending: this.facts.countPendingConflicts(),
      entities_stale: this.facts.countStaleEntities(ENTITY_EXTRACTOR_VERSION),
      archived_by_reason: Object.fromEntries(reasons.map((r) => [r.reason ?? 'unknown', r.n])),
      oldest_settle_clock: oldest,
    }
  }

  get(fact_id: number): FactDetail | null {
    const row = this.getRow(fact_id)
    if (!row) return null
    return this.toDetail(row, this.entityNames(fact_id), this.triplesOf(fact_id), readClock(this.db))
  }

  private triplesOf(fact_id: number): { subj: string; pred: string; obj: string; confidence: number }[] {
    return this.triples.listForFact(fact_id)
  }

  /**
   * One page of facts, newest first.
   * @param category - optional category filter.
   * @param status - `active` (default) or `archived`.
   * @param limit - page size.
   * @param offset - page offset (0-based).
   * @returns the page, the page size (`count`), the matching total, and whether
   * more rows remain after this page.
   */
  list(
    category?: string,
    status = 'active',
    limit = 50,
    offset = 0,
  ): FactPage {
    const rows = this.facts.page(status, category, limit, offset)
    const total = this.facts.countInStatus(status, category)
    const clock = readClock(this.db)
    return {
      facts: rows.map((r) => this.toSummary(r, clock)),
      count: rows.length,
      total,
      truncated: offset + rows.length < total,
    }
  }

  countByStatus(): { active: number; archived: number } {
    return this.facts.countByStatus()
  }

  /** Run one incremental contradiction-detection pass; returns newly logged pairs. */
  /**
   * Drain the DURABLE pending queue, bounded by `budget`.
   *
   * These are facts whose embedding-leg check could not run when they were written (no vector —
   * the embedder was unavailable). The queue is `facts.conflict_checked`, not an in-process Set, so
   * it survives a restart and cannot grow without bound as a memory structure.
   *
   * The stamp follows the CHECK, not the selection: a row is marked checked only when the pass
   * actually held its vector (see `CheckResult`). The queue predicate asks the DATABASE for
   * `semantic_vector IS NOT NULL`, which is a different question from "the live index can serve
   * it" — a vector written by another process, or dropped while this one rebuilt its index, is in
   * the column and not in the index. Stamping those was a permanent exemption dressed up as a
   * completed check; leaving them queued keeps `conflict_pending` honest, and `vectors_fix` (which
   * resets the marker when it re-encodes) is what clears them.
   *
   * What the drain guarantees instead of "every selected row is stamped" is that it always MOVES:
   * rows are taken above `conflictDrainCursor`, so an un-completable row cannot hold up the ones
   * behind it. A restart resets the cursor, which costs one extra pass over the head and is why
   * this is a scheduling cursor rather than derived state.
   *
   * A throw keeps the batch queued too — `checkMany` never returns, so nothing is stamped.
   */
  drainConflicts(budget = PENDING_CONFLICT_BATCH): ConflictDrainReport {
    let rows = this.facts.pendingConflictRows(budget, this.conflictDrainCursor)
    if (rows.length === 0 && this.conflictDrainCursor > 0) {
      // The tail is consumed: start over from the head. Anything still queued is a row this
      // process could not complete last time; retrying it is the point of the wrap, and the
      // selection order means it cannot starve the rows added since.
      this.conflictDrainCursor = 0
      rows = this.facts.pendingConflictRows(budget, 0)
    }
    // Nothing SELECTED is not the same as nothing PENDING, and this line conflated the two: the queue
    // predicate requires `semantic_vector IS NOT NULL`, so with no embedder (the default shape on a
    // machine without a model) the selection is always empty — while `trust`, which counts the rows
    // with no vector ON PURPOSE ("hiding them would report an empty queue while nothing had been
    // checked"), reports the real backlog. `maintenance` printed "queue empty" beside it.
    if (rows.length === 0) return { logged: [], checked: 0, pending: this.facts.countPendingConflicts() }
    this.conflictDrainCursor = rows[rows.length - 1]!.fact_id
    const checked = this.contradictions.checkMany(rows.map((r) => r.fact_id))
    if (checked.complete.length > 0) this.facts.markConflictChecked(checked.complete)
    return {
      logged: checked.logged,
      checked: checked.complete.length,
      pending: this.facts.countPendingConflicts(),
    }
  }

  /** {@link drainConflicts}, reduced to the pairs it logged (the `contradict_check` payload). */
  checkContradictions(budget = PENDING_CONFLICT_BATCH): Sig[] {
    return this.drainConflicts(budget).logged
  }

  /**
   * One bounded conflict pass for {@link maintenance}, reduced to COUNTS.
   *
   * `maintenance` is the surfaces' "clean up now" entry (the settings page and the MCP tool call
   * it), and the conflict queue is the other half of the derived state the entity sweep handles: a
   * database upgraded from v5 has every vector-bearing row queued at once, and without this the
   * only way to drain it was the explicit `contradict_check` action. Bounded like the entity sweep
   * (one batch), so a settings-page click stays a click; the CLI is the surface that loops.
   */
  private sweepConflicts(): ConflictSweepCounts {
    const pass = this.drainConflicts()
    return { checked: pass.checked, logged: pass.logged.length, pending: pass.pending }
  }

  /** Async bootstrap the semantic backend (download/config model) without blocking. */
  async warmupSemantic(): Promise<boolean> {
    await (this.semantic.warmUp?.() ?? Promise.resolve())
    return this.semantic.isAvailable()
  }

  /** List contradiction candidates (`resolved` 0 = open, 1 = closed with a recorded verdict). */
  listContradictions(opts?: { resolved?: number; category?: string; threshold?: number; limit?: number }): ContradictionRecord[] {
    return this.contradictions.list(opts?.resolved ?? 0, opts?.category, opts?.threshold, opts?.limit ?? 10)
  }

  /**
   * Adjudicate one logged conflict — the outlet the detector never had.
   *
   * Detection was complete but one-way: a pair was recorded and `resolveForFact` retired it when
   * a fact left the ACTIVE corpus, yet nothing could say "this pair is decided" while both
   * revisions stayed put. The DAO even had `resolve()` with no caller, so the open list could
   * only grow. Two verdicts are meaningful:
   *
   *  - `false_positive`: both statements are true, the pair is closed and both facts stay;
   *  - `true_positive` + `loser_fact_id`: the loser was wrong, so it is ARCHIVED — which is also
   *    what retires every other open conflict naming it, and why the loser must be one of the
   *    two facts in this pair.
   *
   * The verdict is recorded on this row either way: `archive()` short-circuits for a fact that
   * is already archived, and the row would otherwise stay open on a technicality.
   */
  resolveContradiction(
    id: number,
    resolution: 'true_positive' | 'false_positive',
    loserFactId?: number,
  ): ContradictionResolution {
    const row = this.contradictions.get(id)
    if (!row) return { resolved: false, contradiction_id: id, archived_loser: null, reason: 'not_found' }
    // A pair that already carries a verdict is REFUSED, not overwritten. Overwriting used to replace
    // `resolution` / `loser_fact_id` / `resolved_at` in place with no history, which is bad enough on
    // its own — but the decisive problem is that a verdict has a side effect that a second one cannot
    // undo: adjudicating `true_positive` with loser A archives A, and re-adjudicating with loser B
    // archives B while A stays archived. The row would then name one loser while two facts are gone,
    // and nothing in the store could say so. Correcting a misclick is a capability to design
    // deliberately (it has to un-archive), not something a repeat call should do silently.
    if (Number(row.resolved) === 1) {
      return { resolved: false, contradiction_id: id, archived_loser: null, reason: 'already_resolved' }
    }
    if (loserFactId !== undefined) {
      if (resolution !== 'true_positive') {
        return { resolved: false, contradiction_id: id, archived_loser: null, reason: 'loser_requires_true_positive' }
      }
      if (loserFactId !== row.fact_a && loserFactId !== row.fact_b) {
        return { resolved: false, contradiction_id: id, archived_loser: null, reason: 'loser_not_in_pair' }
      }
      this.archive(loserFactId, 'contradiction')
      this.contradictions.resolve(id, resolution, loserFactId)
      return { resolved: true, contradiction_id: id, archived_loser: loserFactId }
    }
    this.contradictions.resolve(id, resolution)
    return { resolved: true, contradiction_id: id, archived_loser: null }
  }

  /**
   * Semantic-index health for the ACTIVE corpus (the only thing the index serves):
   *  - `missing`     active facts with no persisted vector at all;
   *  - `stale`       active facts whose persisted vector has the wrong dim
   *                  (semantic.dim changed) — needs a re-encode;
   *  - `indexed`     vectors currently in the live index;
   *  - `unindexed`   active facts with a usable persisted vector that the live
   *                  index does not hold (restart/index loss);
   *  - `store`       the backend actually serving reads (`auto` migrates at a threshold).
   *  - `space_stale` vectors written in a DIFFERENT vector space (another model, or a store
   *                  upgraded past the space id) — usable bytes, incomparable scores.
   * `total`/`with_semantic` still describe the whole table (including archived).
   */
  vectorsDiagnose(): VectorsDiagnostic {
    const c = this.classifyVectors()
    return {
      total: c.total,
      with_semantic: c.with_semantic,
      missing: c.missing,
      stale: c.staleIds.length,
      space_stale: c.spaceStaleIds.length,
      indexed: this.vstore.count(),
      unindexed: c.unindexed.length,
      models: c.models,
      // `vectorStore.backend: 'auto'` moves to ANN behind the caller's back; without this the
      // upgrade (and its recall/latency trade-off) is invisible from every surface.
      store: this.vstore.name,
    }
  }

  /**
   * ONE read+decode pass over the persisted vectors, shared by diagnose and fix
   * (the two methods used to re-scan and re-decode the same blobs 4-5× per call).
   */
  private classifyVectors(): {
    total: number
    with_semantic: number
    missing: number
    models: Record<string, number>
    staleIds: number[]
    /** Vectors whose recorded space is not the current one (see {@link spaceStaleIds} docs below). */
    spaceStaleIds: number[]
    /** Usable persisted vectors absent from the live index (decoded, ready to add). */
    unindexed: { id: number; vec: Float32Array }[]
  } {
    const counts = this.facts.vectorCounts()
    const models = this.facts.embeddingModels()
    const rows = this.facts.activeVectorRows()
    const space = this.vectorSpace()

    const staleIds: number[] = []
    // Rows whose bytes are usable but whose SPACE is not provably the current one: a different
    // model of the same width ranks in a different vector space, so keeping such a vector in the
    // live index compares two spaces. A row written before the space id existed carries the old
    // backend-only string, which also lands here — that is the intended one-time adoption, and
    // it is REPORTED rather than acted on, because re-encoding a whole table is an operator's
    // decision, not a startup side effect (the startup reload stays dim-only on purpose: acting
    // on it there would silently empty the semantic leg of every upgraded store).
    const spaceStaleIds: number[] = []
    const usable: { id: number; vec: Float32Array }[] = []
    for (const r of rows) {
      const vec = bytesToFloat32(r.semantic_vector)
      if (!vec || vec.length !== this.vstore.dim) {
        staleIds.push(r.fact_id)
        continue
      }
      if (r.embedding_model !== space) spaceStaleIds.push(r.fact_id)
      usable.push({ id: r.fact_id, vec })
    }
    const present = usable.length ? this.vstore.fetch(usable.map((u) => u.id)) : new Map<number, Float32Array>()
    return {
      total: counts.total,
      with_semantic: counts.withSemantic,
      missing: counts.missing,
      models: Object.fromEntries(models.map((m) => [m.model, m.n])),
      staleIds,
      spaceStaleIds,
      unindexed: usable.filter((u) => !present.has(u.id)),
    }
  }

  /**
   * Repair the semantic read model:
   *  (a) reload persisted, dim-valid vectors missing from the live index
   *      (restart / index loss — needs no model),
   *  (b) drop persisted vectors whose dim no longer matches `semantic.dim` so a
   *      re-encode can replace them (never `add()` a stale vector — the store
   *      throws on dim mismatch),
   *  (c) encode active facts that have no vector yet (needs the semantic backend),
   *  (d) re-encode vectors written in ANOTHER vector space (a model swap, or the one-time
   *      adoption of a store predating the space id). Deliberately here and not at open: this is
   *      the only path that re-encodes the whole table, so it is an explicit, counted action.
   * `dry_run` previews every count without writing — and without loading the model, which is why
   * the preview also reports `would_warm` (see the contract's `VectorsFixReport`).
   */
  async vectorsFix(dryRun = false): Promise<VectorsFixReport> {
    const c = this.classifyVectors()
    const loadedNow = this.semantic.isAvailable()
    let semAvailable = loadedNow
    // An explicit repair is the one call site worth *waiting* for the model: a
    // bare availability read would make `vectors_fix` a silent no-op right after
    // a failed bootstrap — the incident that motivated the retry gate.
    if (!semAvailable && !dryRun) semAvailable = await this.warmupSemantic()
    // Reported for BOTH modes, and computed before the warmup: a dry run cannot know whether a
    // warmup would succeed (it must not download), so "the model is not loaded" is not the same
    // answer as "the repair cannot run" — see the contract's `VectorsFixReport`.
    const wouldWarm = !loadedNow
    if (dryRun) {
      return {
        missing: c.missing,
        stale: c.staleIds.length,
        space_stale: c.spaceStaleIds.length,
        unindexed: c.unindexed.length,
        reindexed: 0,
        dropped: 0,
        fixed: 0,
        semantic_available: semAvailable,
        would_warm: wouldWarm,
        dry_run: true,
      }
    }

    let reindexed = 0
    for (const u of c.unindexed) {
      this.vstore.add(u.id, u.vec)
      reindexed++
    }

    // Unusable bytes (dim mismatch) and foreign-space vectors both have to go before a re-encode
    // can pick them up, and for the same reason: `add()` would keep ranking them otherwise.
    let dropped = 0
    if (semAvailable) {
      const toDrop = [...c.staleIds, ...c.spaceStaleIds]
      if (toDrop.length) {
        dropped = this.facts.clearVectors(toDrop)
        this.evictVectors(c.spaceStaleIds)
      }
    }

    let fixed = 0
    if (semAvailable) {
      const missingRows = this.facts.missingVectorRows()
      for (const m of missingRows) {
        // Every path here lands the vector through `setSemanticVector`, which re-queues the fact
        // for the conflict check (`conflict_checked = 0`) — the same rule as `clearVectors`
        // above: a fact whose vector the leg could not see when it ran has not been checked.
        if (!await this.maybeIndexSemantic(m.fact_id, m.content)) continue
        fixed++
      }
    }
    return {
      missing: c.missing,
      stale: c.staleIds.length,
      space_stale: c.spaceStaleIds.length,
      unindexed: c.unindexed.length,
      reindexed,
      dropped,
      fixed,
      semantic_available: semAvailable,
      would_warm: wouldWarm,
      dry_run: false,
    }
  }

  /**
   * One lifecycle pass, owned by the store so the DB writes and the live-index
   * invariant (ACTIVE vectors only) are maintained in ONE place — the runtime no
   * longer has to patch the index behind the store's back.
   *
   * It also runs ONE bounded derived-state sweep pass, which is why it is async: `entities` is
   * what the sweep rebuilt and what it still owes (`deferred`). One pass, not a loop — this is
   * reachable from a settings-page button and an MCP call, so it must not block on a whole stale
   * corpus; operators who want it drained loop on `reindexEntities` until `deferred === 0` (the
   * CLI does). It deliberately does not sit behind `heartbeat_minutes`, which can be 0.
   */
  async maintenance(): Promise<MaintenanceResult & { entities: EntitySweepReport; conflicts: ConflictSweepCounts }> {
    const result = runMaintenance(this.db, this.config, { budget: 0 })
    this.evictVectors([...result.archived_ids, ...result.purged_ids])
    this.retireConflicts([...result.archived_ids, ...result.purged_ids])
    // `admin maintenance` is the explicit "clean up now" command, so it is also where the vector
    // index reclaims tombstones that never reached the automatic compaction threshold (they can
    // otherwise accumulate across sessions — see `HnswlibVectorStore.graphElements`).
    this.vstore.compact?.()
    this.db.pragma('optimize')
    this.flushHealth()
    // Both halves of the derived state: the entity sweep (one batch) and the conflict queue (one
    // bounded drain). Each returns what it did and what is left, so a caller that wants the whole
    // corpus current can loop — the CLI does.
    return { ...result, entities: await this.reindexEntities(), conflicts: this.sweepConflicts() }
  }

  /**
   * Re-extract the entity/triple rows of facts written by OLDER extraction rules (bounded).
   *
   * The memory-side counterpart of `KnowledgeStore.reindex`'s entity leg, and the reason
   * `facts.entities_version` exists: without it a change to the extraction rules could only reach
   * facts written afterwards, so the corpus would carry two vintages indefinitely and retrieval
   * quality would depend on when a fact happened to be written. The version covers the RULES, not
   * which tagger happened to produce the tokens — the tagger is an optional dependency loaded
   * asynchronously, and a process that fails to load it falls back to regex; folding that into the
   * version would make a capability failure schedule a corpus-wide rebuild with the WORSE extractor.
   *
   * One transaction per fact: the entity rows, the triple rows, the HRR bundle (which is derived
   * FROM the entity names) and the version stamp all move together or not at all. The semantic
   * vector is untouched — it encodes the CONTENT, which is unchanged — but `conflict_checked` is
   * RESET, because both legs of the conflict check read exactly what this rebuilt (see
   * `requeueConflictCheck`).
   *
   * Awaited by `maintenance` (one batch), so the caller knows the batch is done when it returns;
   * `deferred` is what the next pass still has to do. Callers that want the whole corpus drained
   * loop until `deferred === 0` — `budget` bounds MEMORY as well as mission, since the pass reads
   * every selected row's `content` before rebuilding the first one.
   *
   * The in-flight guard is here rather than at the callers because the callers CAN overlap: the
   * plugin's heartbeat and `maintenance` are both periodic, and `staleEntityRows` is ORDERED, so
   * two concurrent passes would select the same rows and re-tag them twice. Overlap is not
   * corruption (each fact is stamped in its own transaction) — it is duplicated mission in a
   * single-threaded process. A pass that finds one running reports `skipped` and does nothing.
   *
   * `budget` is clamped at 0: SQLite reads a negative LIMIT as "no limit" (`LIMIT -1`), so a
   * caller asking for "-1 rows" would silently get the whole corpus — the opposite of bounded.
   */
  async reindexEntities(budget = ENTITY_SWEEP_BATCH): Promise<EntitySweepReport> {
    if (this.entitySweepInFlight) {
      return { rebuilt: 0, deferred: this.facts.countStaleEntities(ENTITY_EXTRACTOR_VERSION), skipped: true }
    }
    this.entitySweepInFlight = true
    try {
      const rows = this.facts.staleEntityRows(ENTITY_EXTRACTOR_VERSION, Math.max(0, Math.floor(budget)))
      for (const row of rows) {
        // Tag ONCE for both extractors (the write path does the same — see `tagText`).
        const tokens = await tagText(row.content)
        const entities = normalizeWrites(entitiesFromTokens(tokens, row.content).map((e) => e.name))
        const triples = this.normalizeTriples(triplesFromTokens(tokens))
        const hrr = hrrToBytes(encodeHrrEntityVector(entities))
        this.db.transaction(() => {
          this.entities.unlinkFact(row.fact_id)
          this.linkEntities(row.fact_id, entities)
          this.triples.deleteForFact(row.fact_id)
          this.insertTriples(row.fact_id, triples)
          this.facts.setHrrVector(row.fact_id, hrr)
          this.facts.setEntitiesVersion([row.fact_id], ENTITY_EXTRACTOR_VERSION)
          // The triples/entities just changed under the conflict legs, so any verdict they
          // produced is about a fact that no longer exists.
          this.facts.requeueConflictCheck([row.fact_id])
        })()
      }
      return { rebuilt: rows.length, deferred: this.facts.countStaleEntities(ENTITY_EXTRACTOR_VERSION), skipped: false }
    } finally {
      this.entitySweepInFlight = false
    }
  }

  /**
   * A fact left the ACTIVE corpus: retire the open conflicts that name it, so
   * `contradict` never reports a pair whose revision is archived and repeated
   * archive/restore cycles cannot stack duplicates (see
   * `ContradictionsDao.resolveForFact`).
   */
  private retireConflicts(factIds: number[]): void {
    // Batched (two indexed statements per 500 ids), not one statement per id: the tick can archive
    // thousands of rows in a single IMMEDIATE transaction, and the per-id loop was O(archived×log)
    // — measured 6.3 s for 999 ids at 99k open pairs, all of it holding the write lock.
    this.contradictions.resolveForFacts(factIds)
  }

  /** Drop vectors of archived/purged facts from the live index (batched). */
  private evictVectors(factIds: number[]): void {
    evictVectorsOf(this.vstore, factIds)
  }

  /**
   * Entities that co-occur with `entity` across ACTIVE facts, ranked by occurrence
   * count. Archived (incl. superseded) facts are excluded — their entities are not
   * part of the live graph.
   */
  related(entity: string, limit = 10, category?: string): { entity: string; count: number }[] {
    const ids = this.entities.activeFactsForEntity(entity, category)
    // One batched entity load for the whole co-occurrence set (was N+1 queries).
    const bags = this.entityBags(ids)
    const counts = new Map<string, number>()
    for (const f of ids.map((fact_id) => ({ fact_id }))) {
      for (const other of bags.get(f.fact_id) ?? []) {
        if (other === entity) continue
        counts.set(other, (counts.get(other) ?? 0) + 1)
      }
    }
    return [...counts.entries()].map(([name, count]) => ({ entity: name, count })).sort((a, b) => b.count - a.count).slice(0, limit)
  }

  /** Two-hop traversal: subj -pred-> mid, mid -second_pred-> obj. Returns the second-hop facts. */
  async chain(subj: string, pred?: string, secondPred?: string, limit = 10): Promise<RecallResult> {
    const midNames = this.triples.objectsForSubject(subj, pred)
    if (midNames.length === 0) return { hits: [], ...GRAPH_RESULT }

    const ids = this.triples.activeFactsBySubject(midNames, secondPred).slice(0, limit)
    this.reinforce(ids)
    return { hits: this.factHits(ids, () => 1), ...GRAPH_RESULT }
  }

  /** Facts whose entity set contains ALL given entities (AND-join). */
  async reason(entities: string[], limit = 10): Promise<RecallResult> {
    if (entities.length === 0) return { hits: [], ...GRAPH_RESULT }
    const ids = this.entities.activeFactsForAllEntities(entities).slice(0, limit)
    this.reinforce(ids)
    return { hits: this.factHits(ids, () => 1), ...GRAPH_RESULT }
  }

  /** Hybrid search over the memory corpus (semantic + FTS + entity Jaccard [+ HRR probe] via fusion). */
  async search(input: SearchInput): Promise<RecallResult> {
    const result = await hybridSearch<RecallHit>(this.hybridDeps(input), {
      query: input.query,
      limit: input.limit,
      maxTokens: input.maxTokens,
      queryVector: input.queryVector,
      recordStats: input.recordStats,
      floors: input.floors,
      ...(input.relaxLegs === undefined ? {} : { relaxLegs: input.relaxLegs }),
    })
    return {
      hits: result.hits,
      degraded: result.degraded,
      weights: result.weights,
      floors: result.floors,
      dropped_by_floor: result.dropped_by_floor,
      ...(result.relaxed === true ? { relaxed: true } : {}),
    }
  }

  /**
   * This store's half of the shared orchestration (`store/hybrid.ts`): the legs, the text load, the
   * fact→hit mapping, and what to do with the hits the caller actually receives.
   */
  private hybridDeps(input: SearchInput): HybridDeps<RecallHit> {
    return {
      kind: 'memory',
      config: this.config,
      semantic: this.semantic,
      reranker: this.reranker,
      legs: (ctx) => this.searchLegs(input, ctx),
      texts: (ids) => this.loadTexts(ids),
      hits: (ranked, texts) => {
        const scoreById = new Map(ranked.map((h) => [h.id, h.score]))
        return this.factHits(ranked.map((h) => h.id), (id) => scoreById.get(id) ?? 0, texts)
      },
      // AFTER the output budget, on the hits the caller really gets: reinforcing the pre-budget list
      // used to refresh the dormancy clock (and grant the trust bonus) for facts the budget had
      // already dropped. The cross-store path had already learned this (R5/R21, see `runtime.query`);
      // a single-store `recall.search` had not.
      onReturn: (kept) => {
        if (input.track !== false) this.reinforce(kept.map((h) => h.ref_id))
      },
    }
  }

  /**
   * The memory legs: semantic, FTS, entity Jaccard, and — for `recall.probe` — the HRR probe.
   *
   * Every non-semantic leg is CAPPED. Fusion only ever keeps `overFetch` entries, so a leg returning
   * the whole matching corpus (measured: the FTS leg returned all 33000 facts for a common phrase,
   * the entity leg 6600) made `fuse` normalize and sort the corpus per query. 4× the pool is
   * deliberate headroom: each leg must be able to fill the pool on its own.
   *
   * The cap is score-transparent for a leg that hands its entries over in ITS OWN SCORE ORDER —
   * `fuse` scales by each leg's maximum, an entry no cap can remove, so a trimmed tail cannot
   * rescale the survivors. That covers the Jaccard and FTS legs. It does NOT cover the HRR leg, whose
   * candidates arrive in the JACCARD leg's order (or by recency in its fallback), so its cap can
   * remove its own highest scorer and `v / max` really does move. Accepted — the cap bounds per-query
   * mission and the pool is reranked afterwards — but do not read these scores as comparable across
   * different cap/over-fetch settings; see `docs/PROVENANCE_REVIEW.md` N5 for the missing differential.
   */
  private async searchLegs(
    input: SearchInput,
    ctx: HybridContext,
  ): Promise<readonly (HybridLeg | Promise<HybridLeg>)[]> {
    // Entities and the entity-sharing candidate set are computed ONCE and shared: the Jaccard and
    // HRR legs are two views of the same information (an HRR bundle IS a bundle of entity atoms),
    // and before this the probe extracted the same query twice and read the corpus twice.
    const qEntities = Array.from(new Set((await extractEntities(ctx.query)).map((e) => e.name)))
    const candidates = qEntities.length > 0
      ? this.entities.candidateFactsForAnyEntity(qEntities, input.category, ctx.legCap)
      : []
    /**
     * Wrap one leg's raw scores. `capped` must be measured on the RAW set (before the relevance
     * floor): the floor removes the tail anyway, and deriving the flag from the floored size would
     * erase the "this leg was cut at legCap" signal exactly when it bound.
     */
    const leg = (scores: Map<number, number>, weight: number, raw?: Map<number, number>): HybridLeg => ({
      weight,
      scores,
      // `size === cap` is the only observable "this leg was cut" signal: a leg that finished under
      // the cap cannot have been trimmed.
      capped: (raw ?? scores).size === ctx.legCap,
    })
    // FTS floor: per ROW distinct-query-term coverage, on the terms `lexical.ts` defines. The texts
    // are loaded once for the capped candidate set (one batched query) — a row whose text is gone
    // scores 0 terms and is dropped, which the live filter would have done anyway.
    const ftsRaw = this.ftsPath(ctx.query, input.category, ctx.legCap)
    const ftsFloored = applyTermFloor(ftsRaw, this.loadTexts([...ftsRaw.keys()]), ctx.query, ctx.floors.fts)
    // Jaccard floor: applied to the shared candidate set, then the survivors are what the HRR probe
    // scores — an HRR bundle IS a bundle of entity atoms, so a candidate the entity floor rejected
    // has no business in the probe either.
    const jaccardRaw = this.jaccardPath(qEntities, candidates)
    const jaccardFloored = applyScoreFloor(jaccardRaw, ctx.floors.jaccard)
    const jaccardLeg = { ...leg(jaccardFloored.scores, ctx.weights.jaccard, jaccardRaw), leg: 'jaccard' as const, droppedByFloor: jaccardFloored.dropped }
    const legs: (HybridLeg | Promise<HybridLeg>)[] = [
      // The async legs (model encode) are independent — the orchestrator awaits them concurrently.
      ctx.semAvail
        ? this.semanticPath(ctx.query, input.category, ctx.overFetch, ctx.queryVector, ctx.onQueryVector)
            .then((raw) => {
              const floored = applyScoreFloor(raw, ctx.floors.semantic)
              return { weight: ctx.weights.semantic, scores: floored.scores, leg: 'semantic' as const, droppedByFloor: floored.dropped } satisfies HybridLeg
            })
        : { weight: ctx.weights.semantic, scores: new Map<number, number>(), leg: 'semantic', droppedByFloor: 0 },
      Promise.resolve(jaccardLeg),
      { ...leg(ftsFloored.scores, ctx.weights.fts, ftsRaw), leg: 'fts', droppedByFloor: ftsFloored.dropped },
    ]
    if (input.includeHrr) {
      // The HRR probe is an entity-level leg; it shares the jaccard weight so the reported 3-key
      // weights contract stays stable. Its candidates are the Jaccard survivors; when the raw set
      // was non-empty but the floor emptied it, the recency fallback must NOT fire (that would
      // re-admit exactly the candidates the floor removed).
      legs.push(Promise.resolve(leg(
        this.hrrPath(
          ctx.query,
          qEntities,
          [...jaccardFloored.scores.keys()],
          input.category,
          ctx.legCap,
          candidates.length === 0,
        ),
        ctx.weights.jaccard,
      )))
    }
    return legs
  }

  /**
   * Whether the configured reranker is actually in use — the two flags a retrieval event
   * carries. Exposed so the cross-store router can report ONE event for a merged query with the
   * same honesty as a single-store search (both stores share this adapter, and the derivation lives
   * in `store/hybrid.ts` rather than being re-spelled per store).
   */
  rerankState(): { used: boolean; fallback: boolean } {
    return rerankerState(this.reranker)
  }

  /**
   * The one fact→RecallHit mapper (kind/source_ref/entities shape lives here ONLY;
   * chain/reason/ask/search all used to carry byte-identical copies, three of them
   * with an N+1 entity load each). Facts have no knowledge-base taxonomy, so
   * `domain`/`source` are null — that is what keeps a `domain`-filtered cross query
   * from ever matching a memory hit.
   */
  private factHits(ids: number[], scoreOf: (id: number) => number, texts?: Map<number, string>): RecallResult['hits'] {
    const textMap = texts ?? this.loadTexts(ids)
    const bags = this.entityBags(ids)
    const times = this.facts.timesByIds(ids)
    return ids.map((id) => ({
      kind: 'fact' as const,
      ref_id: id,
      text: textMap.get(id) ?? '',
      score: scoreOf(id),
      domain: null,
      source: null,
      source_ref: `memory:fact:${id}`,
      entities: bags.get(id) ?? [],
      created_at: times.get(id)?.created_at ?? '',
      updated_at: times.get(id)?.updated_at ?? null,
    }))
  }

  /**
   * Record a RECALL and reinforce the facts (spec §2.3): usage stats always move,
   * the trust bonus is quota-limited (per fact, calendar 24h), zero-gain recalls
   * cost nothing, and a recall can never push a fact to permanent (D11).
   *
   * Public so `runtime.query` can reinforce ONLY the merged hits it actually
   * returns, after the router's kind/domain/source filtering (R5/R21).
   */
  reinforce(ids: number[]): void {
    if (!ids.length) return
    const trust = this.config.trust
    if (!trust.enabled) {
      this.touchUsage(ids)
      return
    }
    const nowMs = Date.now()
    // IMMEDIATE, with the rows read INSIDE it: a recall is a cross-process read-modify-write of the
    // per-fact 24h bonus counter, and a DEFERRED transaction takes the write lock only at its first
    // WRITE. Two processes recalling the same fact would both settle from the same stale
    // `bonus_count`/`settle_clock` and both grant the bonus — a cap spent twice, and the later writer
    // overwriting the earlier one's settled trust. Same reason `presence` and the tick use it.
    const tx = this.db.transaction(() => {
      const clock = readClock(this.db)
      const rows = this.facts.rowsByIds(ids)
      this.facts.touchUsage(ids)
      for (const row of rows) {
        if (String(row.status) !== 'active' || isPinned(asTrustRow(row))) continue
        const outcome = grantRecallBonus(asTrustRow(row), clock, nowMs, trust)
        const factId = Number(row.fact_id)
        if (outcome.granted) this.facts.reinforce(factId, outcome.next, clock, outcome.bonusCount, outcome.windowAt)
        else if (Math.abs(outcome.settled - Number(row.trust_score)) > EPSILON) this.facts.settleTrust(factId, outcome.settled, clock)
      }
    })
    tx.immediate()
  }

  /**
   * Load the persisted retrieval-health counters, and write the current ones back.
   *
   * A snapshot written by an older build (or a corrupt row) must not break startup, so a parse
   * failure leaves the live counters alone — `restoreRetrievalHealth` validates the shape.
   */
  private restoreHealth(): void {
    const raw = new StatsDao(this.db).read(RETRIEVAL_HEALTH_KEY)
    if (raw === null) return
    try {
      restoreRetrievalHealth(JSON.parse(raw))
    } catch {
      resetRetrievalHealth()
    }
  }

  /**
   * Flush the counters so a restart does not reset the picture (see `RETRIEVAL_HEALTH_KEY`).
   *
   * Called by `maintenance()` and by the runtime on shutdown — NOT from a `close()`, because the
   * runtime owns the database handle.
   */
  flushHealth(): void {
    new StatsDao(this.db).write(RETRIEVAL_HEALTH_KEY, JSON.stringify(retrievalHealth()))
  }

  /** Retrieval bookkeeping: `retrieval_count` + the "last used" clock (spec §2.5). */
  private touchUsage(ids: number[]): void {
    try {
      this.facts.touchUsage(ids)
    } catch {
      // stats are best-effort; never fail a search for them
    }
  }

  /**
   * Semantic leg. `queryVector` short-circuits the encode when the caller already
   * encoded this exact query (the cross-store router does, for both stores at once);
   * `onVector` publishes the vector this leg actually used, so the relaxed retry pass can reuse it
   * instead of re-encoding (performance review §7.7 / P8).
   */
  private async semanticPath(query: string, category: string | undefined, k: number, queryVector?: Float32Array, onVector?: (vec: Float32Array) => void): Promise<Map<number, number>> {
    const vec = queryVector ?? await this.semantic.encode(query)
    // A caller-supplied vector is trusted to come from this backend (see `SearchInput`), but the
    // dimension is cheap to check and a mismatch would otherwise score as garbage. It is an INPUT
    // error, not a leg failure: the orchestrator isolates a dead leg so the query still answers, but
    // a wrong width means the caller encoded with a different backend, and quietly answering from
    // the other legs would hide that for the rest of the session.
    if (vec.length !== this.vstore.dim) {
      throw new RetrievalInputError(`queryVector 维度不符：${vec.length} != ${this.vstore.dim}`)
    }
    onVector?.(vec)
    const topk = this.vstore.topk(vec, Math.max(50, k))
    if (!topk.length) return new Map()
    // The vstore has no notion of status/category — filter candidates through the DB
    // so archived/purged facts and other categories never leak into the semantic leg.
    const allowed = new Set(this.facts.activeIdsIn(topk.map((t) => t.id), category))
    const out = new Map<number, number>()
    for (const t of topk) if (allowed.has(t.id)) out.set(t.id, t.score)
    return out
  }

  /**
   * HRR entity-probe path: phase similarity between the query's entity bundle and
   * each active fact's persisted HRR vector. Recalls facts whose entities relate to
   * the probe even when surface text shares no FTS trigrams.
   */
  private hrrPath(
    query: string,
    entityNames: string[],
    candidates: number[],
    category: string | undefined,
    cap: number,
    /**
     * Whether the recency fallback may run. The caller passes `false` when the Jaccard floor
     * emptied a NON-empty candidate set: the probe's candidates are that leg's survivors, and
     * falling back to "the cap most recent facts" would re-admit exactly what the floor removed.
     * An empty RAW set still falls back — that is the pre-existing path for a query whose entities
     * no fact shares (and for a query with no entities at all).
     */
    allowRecencyFallback = candidates.length === 0,
  ): Map<number, number> {
    if (entityNames.length === 0 && !query.trim()) return new Map()
    if (candidates.length === 0 && !allowRecencyFallback) return new Map()
    const probe = encodeHrrEntityVector(entityNames.length ? entityNames : [query.trim()])
    // Only the entity-sharing candidates are scored (the bundle's atoms ARE the entity names).
    // NOTE the fallback condition is "no candidate set at all", NOT "the query has no entities":
    // it also fires when entities were extracted but no fact shares one. In that case the leg
    // scores the `cap` MOST RECENT facts (see `activeHrrRows`) — bounded on purpose, and reported
    // once, because the alternative is decoding one 8 KB blob per active fact (1.37 s at 33k).
    const truncatedFallback = allowRecencyFallback
    const rows = truncatedFallback
      ? this.facts.activeHrrRows(category, cap)
      : this.facts.hrrRowsForFacts(candidates, category)
    if (truncatedFallback && rows.length === cap && !this.hrrFallbackWarned) {
      this.hrrFallbackWarned = true
      retrievalLogger().warn(
        `memory probe: no fact shares an entity with this probe — the HRR leg scored only the ${cap} `
        + `most recent facts (bounded by design; see DESIGN §7 and docs/PERFORMANCE_REVIEW.md §4.5)`,
      )
    }
    const out = new Map<number, number>()
    for (const r of rows) {
      const vec = hrrFromBytes(r.hrr_vector)
      if (!vec || vec.length !== probe.length) continue
      out.set(r.fact_id, phaseSimilarity(probe, vec))
    }
    return out
  }

  /**
   * Direction-aware question answering over SPO triples.
   * Parse the query into a TriplePattern, match triples by the filled slots
   * (unfilled = wildcard), and rank the owning facts. Direction is preserved by
   * the triple's (subj, pred, obj) roles.
   */
  async ask(query: string, limit = 10): Promise<RecallResult> {
    const pattern = await parseQueryPattern(query)
    const matched = await this.askByPattern(pattern, limit)
    if (matched.hits.length > 0) return matched
    // layered fallback: no directional triple match → hybrid search on the original query
    return this.search({ query, limit })
  }

  /** Direction-aware answer over SPO triples from an explicit pattern. */
  async askByPattern(pattern: TriplePattern, limit = 10): Promise<RecallResult> {
    if (!pattern.subj && !pattern.obj && !pattern.pred) {
      return { hits: [], ...GRAPH_RESULT }
    }
    // The role weights are the store's ranking policy; the DAO only knows how to express the
    // three slots as SQL (exact and relaxed).
    const exactWeight = (pattern.subj ? 0.25 : 0) + (pattern.pred ? 0.5 : 0) + (pattern.obj ? 0.25 : 0)
    const exactRows = this.triples.activeFactsMatchingExact(pattern)

    const score = new Map<number, number>()
    for (const fact_id of exactRows) score.set(fact_id, Math.max(score.get(fact_id) ?? 0, exactWeight))

    // Middle layer: relax exact `=` to substring (`LIKE %term%`) — recovers recall
    // from triple string mismatches while keeping the subj/pred/obj ROLE (direction).
    if (score.size < limit) {
      const relaxed = 0.7 * exactWeight // relaxed weight
      for (const fact_id of this.triples.activeFactsMatchingLike(pattern)) {
        score.set(fact_id, Math.max(score.get(fact_id) ?? 0, relaxed))
      }
    }

    const sorted = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    const ids = sorted.map(([id]) => id)
    this.reinforce(ids)
    return { hits: this.factHits(ids, (id) => score.get(id) ?? 0), ...GRAPH_RESULT }
  }

  /** One-shot flag for the probe fallback warning (see `hrrPath`). */
  private hrrFallbackWarned = false

  /**
   * Sync relevance probe for the plugin's conditional hint (DESIGN §12): how many of `text`'s
   * terms this store already holds. `store/lexical.ts` carries why it is lexical rather than
   * semantic, why it must be synchronous, and how the bar itself was measured.
   */
  lexicalProbe(text: string, stopAt = Number.POSITIVE_INFINITY): LexicalProbe {
    return probeTerms(text, (term) => {
      // One `LIMIT 1` per term, built for THIS table's tokenizer.
      const fts = buildFtsQuery(term, this.ftsTokenizer)
      return fts !== null && this.facts.ftsSearch(fts, undefined, 1).length > 0
    }, stopAt)
  }

  private ftsPath(query: string, category: string | undefined, cap: number): Map<number, number> {
    const ftsQuery = buildFtsQuery(query, this.ftsTokenizer)
    if (!ftsQuery) return new Map()
    // ORDER BY bm25 + LIMIT: FTS5 still scores every match internally, but only the best `cap`
    // rows cross into JS — which is what the old code paid for (33k rows through min-max + sort).
    const rows = this.facts.ftsSearch(ftsQuery, category, cap)
    // FTS5 bm25() is negative (more negative = better match); negate so higher = better.
    return new Map(rows.map((r) => [r.id, -r.rank]))
  }

  /**
   * Jaccard leg over the precomputed candidate set (see `search`): the candidates are the facts
   * sharing at least one query entity, pre-ranked by how many they share and already capped.
   */
  private jaccardPath(entityNames: string[], candidates: number[]): Map<number, number> {
    const qEntities = new Set(entityNames)
    if (qEntities.size === 0 || candidates.length === 0) return new Map()
    const bags = this.entityBags(candidates)

    const out = new Map<number, number>()
    for (const id of candidates) {
      const factEntities = new Set(bags.get(id) ?? [])
      const union = new Set([...qEntities, ...factEntities])
      if (union.size === 0) continue
      const overlap = [...qEntities].filter((e) => factEntities.has(e)).length
      const jaccard = overlap / union.size
      if (jaccard > 0) out.set(id, jaccard)
    }
    return out
  }

  // ─── persistence ───────────────────────────────────────────────────────

  /**
   * Insert (or resolve to) a fact row.
   *
   * `category` / `ttlDays` are `undefined` when the CALLER specified nothing — the
   * distinction is load-bearing. A duplicate-content hit must not clobber the existing
   * row's values with the insert defaults: re-adding a fact without a category used to
   * reset it to `general`, and reviving an archived one silently cleared an explicit TTL.
   * The rule for all three branches is therefore: an explicitly provided value lands, an
   * omitted one keeps what the row already has, and a brand-new row falls back to the
   * defaults (`general` / `0`).
   */
  private persistFact(
    content: string,
    category: string | undefined,
    ttlDays: number | undefined,
    entities: string[],
    triples: ExtractedTriple[],
    opts?: { supersedesId?: number; archiveOldIfActive?: boolean },
  ): { fact_id: number; is_new: boolean; revived: boolean } {
    const hrr = hrrToBytes(encodeHrrEntityVector(entities))
    const trust = this.config.trust
    const clock = readClock(this.db)
    const nowIso = formatUtcTs(Date.now())
    // The row a revision replaces, if any. Loaded regardless of `inherit_trust_on_update`
    // so `category`/`ttl_days` always inherit: that flag decides the TRUST/pin policy
    // (§2.6), not whether the revision is the same logical fact.
    const replaced = opts?.supersedesId === undefined ? undefined : this.getRow(opts.supersedesId)
    const superseded = trust.inherit_trust_on_update ? replaced : undefined
    const startTrust = superseded === undefined ? trust.start : effectiveTrust(asTrustRow(superseded), clock, trust)
    const startPinned = superseded !== undefined && isPinned(asTrustRow(superseded)) ? 1 : 0
    // A revision is the same fact rewritten, so its category and time bound carry over
    // unless the caller replaced them. Resolving it HERE (rather than at the call sites)
    // is what keeps an implicit `update` from retagging the unrelated fact a merge lands
    // on: the surviving row keeps its own values in that branch (see below).
    const newCategory = category ?? (replaced === undefined ? 'general' : String(replaced.category ?? 'general'))
    const newTtl = ttlDays ?? (replaced === undefined ? 0 : Number(replaced.ttl_days ?? 0))
    // A revision is the SAME memory rewritten, so it inherits the archived row's `created_at`
    // (when the memory was first asserted) and gets a fresh `updated_at` from the insert. A
    // first add has no predecessor and uses now. `created_at` also feeds the TTL predicate
    // ("valid for N days after first recording") and the idle fallback's `COALESCE`, which is
    // why `insertRevision` re-stamps `last_retrieved_at` — see TRUST_MODEL.md.
    const createdAt = replaced === undefined || replaced.created_at === null
      ? nowIso
      : String(replaced.created_at)
    const tx = this.db.transaction(() => {
      // R1/S1: `settle_clock` is NOT NULL with no default — every insert writes it.
      const cur = this.facts.insertRevision({
        content,
        category: newCategory,
        ttlDays: newTtl,
        supersedesId: opts?.supersedesId ?? null,
        hrr,
        trust: clamp01(startTrust),
        clock,
        pinned: startPinned,
        pinnedAt: startPinned === 1 ? nowIso : null,
        windowAt: nowIso, // R25: the quota window starts at creation, so no NULL branch exists
        createdAt,
      })
      let fact_id: number
      let is_new: boolean
      if (cur.changes === 0) {
        const row = this.facts.findByContent(content) as Record<string, unknown>
        fact_id = Number(row.fact_id)
        is_new = false
        // The values that survive: an omitted argument keeps what the row already has.
        const rowCategory = String(row.category ?? 'general')
        const rowTtl = Number(row.ttl_days ?? 0)
        const keepCategory = category ?? rowCategory
        const keepTtl = ttlDays ?? rowTtl
        // Revive if archived: settle the frozen value, lift to `recall_floor`, refresh
        // the idle clock (R18) and clear the archive bookkeeping (R19).
        const settled = effectiveTrust(asTrustRow(row), clock, trust)
        const revived = this.facts.revive(fact_id, keepCategory, keepTtl, Math.max(settled, trust.recall_floor), clock) > 0
        // Not revived = the row was already ACTIVE, i.e. a pure duplicate. An explicitly
        // provided category/TTL still has to land, or the caller sees "更新完成" for an
        // edit that changed nothing.
        if (!revived && (keepCategory !== rowCategory || keepTtl !== rowTtl)) {
          this.facts.applyValues(fact_id, keepCategory, keepTtl)
        }
        // link entities/triples for both new & revived
        this.linkEntities(fact_id, entities)
        this.insertTriples(fact_id, triples)
        const supersededId = this.applySupersede(fact_id, opts)
        return { fact_id, is_new, revived, supersededId }
      }
      fact_id = Number(cur.lastInsertRowid)
      is_new = true
      this.linkEntities(fact_id, entities)
      this.insertTriples(fact_id, triples)
      const supersededId = this.applySupersede(fact_id, opts)
      return { fact_id, is_new, revived: false, supersededId }
    })
    const { supersededId, ...result } = tx()
    // After the commit (see `applySupersede`), never inside the transaction.
    if (supersededId !== null) this.evictVectors([supersededId])
    return result
  }

  /**
   * Link the revision chain and archive the superseded fact — on both the fresh-insert
   * and duplicate-content branches.
   *
   * @returns the superseded fact id whose vector must leave the live index, or null.
   *   The caller evicts it AFTER the surrounding transaction commits: evicting inside
   *   would desync the index from the DB on a rollback.
   */
  private applySupersede(fact_id: number, opts?: { supersedesId?: number; archiveOldIfActive?: boolean }): number | null {
    if (!opts?.supersedesId || opts.supersedesId === fact_id) return null
    this.facts.linkSupersede(fact_id, opts.supersedesId)
    if (opts.archiveOldIfActive) {
      // The superseded revision is the loser of any conflict it was named in — retire
      // those rows, or `update` would stack a permanent duplicate per edit.
      if (this.facts.archiveSuperseded(opts.supersedesId, readClock(this.db)) > 0) this.contradictions.resolveForFact(opts.supersedesId)
    }
    // The superseded revision leaves the live graph (and the active-only vector index).
    this.triples.deleteForFact(opts.supersedesId)
    return opts.supersedesId
  }

  private linkEntities(fact_id: number, entities: string[]): void {
    this.entities.linkFact(fact_id, entities)
  }

  /**
   * Normalize the SPO slots of extracted triples through the same write entry as fact content.
   *
   * The triples are DERIVED (from an already-normalized content string, in `add`/`update`), but a
   * tokenizer is free to hand back a half code unit, and a future truncation rule could split a
   * surrogate pair — so the derived rows cross the same entry instead of trusting the producer.
   */
  private normalizeTriples(triples: ExtractedTriple[]): ExtractedTriple[] {
    return triples.map((t) => ({
      ...t,
      subj: normalizeWrite(t.subj),
      pred: normalizeWrite(t.pred),
      obj: normalizeWrite(t.obj),
    }))
  }

  private insertTriples(fact_id: number, triples: ExtractedTriple[]): void {
    this.triples.insertMany(fact_id, triples)
  }

  // ─── row helpers ───────────────────────────────────────────────────────

  private getRow(fact_id: number): Record<string, unknown> | undefined {
    return this.facts.getById(fact_id)
  }

  private entityNames(fact_id: number): string[] {
    return this.entities.namesForFact(fact_id)
  }

  private entityBags(ids: number[]): Map<number, string[]> {
    return this.entities.bagsForFacts(ids)
  }

  private loadTexts(ids: number[]): Map<number, string> {
    return this.facts.textsByIds(ids)
  }

  /**
   * Summary projection. `trust_score` follows the R11 display rule: the EFFECTIVE
   * (decayed) value for active facts and the STORED one for non-active rows;
   * `remaining_days` is null for pinned / non-active rows (spec §6) so it can never
   * go negative.
   */
  private toSummary(r: Record<string, unknown>, clock: number): FactSummary {
    const row = asTrustRow(r)
    return {
      fact_id: Number(r.fact_id),
      content: String(r.content),
      category: String(r.category),
      status: (r.status as FactSummary['status']) ?? 'active',
      trust_score: displayTrust(row, clock, this.config.trust),
      pinned: isPinned(row),
      remaining_days: remainingDays(row, clock, this.config.trust),
      helpful_count: Number(r.helpful_count),
      mirror_source: r.mirror_source ? String(r.mirror_source) : null,
      created_at: String(r.created_at),
      archived_at: r.archived_at ? String(r.archived_at) : null,
      archive_reason: r.archive_reason ? String(r.archive_reason) : null,
    }
  }

  private toDetail(r: Record<string, unknown>, entities: string[], triples: FactDetail['triples'], clock: number): FactDetail {
    return {
      ...this.toSummary(r, clock),
      retrieval_count: Number(r.retrieval_count),
      mirror_target: r.mirror_target ? String(r.mirror_target) : null,
      supersedes_id: r.supersedes_id ? Number(r.supersedes_id) : null,
      entities,
      triples,
      settle_clock: Number(r.settle_clock),
      pinned_at: r.pinned_at ? String(r.pinned_at) : null,
      last_reinforced_at: r.last_reinforced_at ? String(r.last_reinforced_at) : null,
      updated_at: r.updated_at ? String(r.updated_at) : null,
      bonus_count: Number(r.bonus_count ?? 0),
      bonus_window_at: r.bonus_window_at ? String(r.bonus_window_at) : null,
    }
  }
}

/** Decode a `SELECT *` facts row into the pure trust-math view. */
function asTrustRow(r: Record<string, unknown>): TrustRow {
  return {
    trust_score: Number(r.trust_score ?? 0),
    settle_clock: Number(r.settle_clock ?? 0),
    pinned: Number(r.pinned ?? 0),
    bonus_count: r.bonus_count === null || r.bonus_count === undefined ? 0 : Number(r.bonus_count),
    bonus_window_at: r.bonus_window_at === null || r.bonus_window_at === undefined ? null : String(r.bonus_window_at),
    status: String(r.status ?? 'active'),
  }
}

