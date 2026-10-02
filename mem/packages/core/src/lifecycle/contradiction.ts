import { MAX_REPORTED_CONFLICTS, type ContradictionRecord } from '@avantf/mem-contract'
import type { Db } from '../db/conn.js'
import { ContradictionsDao, type ConflictPair, type StoredConflict } from '../db/dao/contradictions.js'
import { EntitiesDao } from '../db/dao/entities.js'
import { FactsDao } from '../db/dao/facts.js'
import { TriplesDao } from '../db/dao/triples.js'

// The two structural lookups live in the triples DAO, which owns the table. Re-exported here
// alongside the contradiction machinery that runs them.
export { polarityLookupSql, sameSubjPredLookupSql } from '../db/dao/triples.js'

const POLARITY_CONFLICT_SCORE = 0.95
const OBJECT_CONFLICT_SCORE = 0.5
const DEFAULT_CONTRADICT_THRESHOLD = 0.6

/** Re-exported for `@avantf/mem` consumers; the value lives in the contract (the tool description states it). */
export { MAX_REPORTED_CONFLICTS }

const EMBED_MIN_ENTITIES = 2
const EMBED_OVERLAP_MIN = 0.5
const EMBED_SIM_MIN = 0.75
const EMBED_SIM_DUP_MAX = 0.97

/**
 * Embedding-fallback contradiction score: `entity_overlap * semantic_sim`, only
 * when all hold: min entity count, entity overlap floor, and cos sim in
 * [sim_min, sim_dup_max]. `sim > sim_dup_max` is a near-duplicate → 0.
 * Returns [0,1]; 0 means "not a contradiction candidate".
 */
export function detectContradictionEmbedding(
  entitiesA: Iterable<string>,
  entitiesB: Iterable<string>,
  vecA: Float32Array,
  vecB: Float32Array,
  opts?: { minEntities?: number; overlapMin?: number; simMin?: number; simDupMax?: number },
): number {
  const a = new Set(entitiesA)
  const b = new Set(entitiesB)
  const minEntities = opts?.minEntities ?? EMBED_MIN_ENTITIES
  const overlapMin = opts?.overlapMin ?? EMBED_OVERLAP_MIN
  const simMin = opts?.simMin ?? EMBED_SIM_MIN
  const simDupMax = opts?.simDupMax ?? EMBED_SIM_DUP_MAX

  if (Math.min(a.size, b.size) < minEntities) return 0
  const union = new Set([...a, ...b])
  if (union.size === 0) return 0
  const overlap = [...a].filter((e) => b.has(e)).length / union.size
  if (overlap < overlapMin) return 0

  const sim = cosine(vecA, vecB)
  if (sim < simMin || sim > simDupMax) return 0
  return Math.min(1, Math.max(0, overlap * sim))
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return Math.max(-1, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))))
}

const NEGATION_PREFIXES = ['不', '没', '没有', '未', '别', '无需'].sort((a, b) => b.length - a.length)

/** Give the opposite-polarity spellings of a predicate. */
function oppositePolarityPredicates(pred: string): string[] {
  const p = pred.trim()
  if (!p) return []
  for (const neg of NEGATION_PREFIXES) {
    if (p.startsWith(neg) && p.length > neg.length) return [p.slice(neg.length)]
  }
  return NEGATION_PREFIXES.map((neg) => neg + p)
}

interface ContradictionSig {
  fact_a: number
  fact_b: number
  score: number
}

/**
 * What one detection pass could and could not do.
 *
 * `logged` alone is not enough to decide whether a fact's check is FINISHED: it says "no pair was
 * recorded", which is also the answer for a fact whose embedding leg never ran because its vector
 * was not in the live index (another space, another process's write, dropped while the index was
 * rebuilt). Stamping `conflict_checked` on that answer is a permanent, silent exemption — the very
 * failure the durable queue exists to prevent. So the pass reports the two separately.
 */
export interface CheckResult {
  /** Pairs this pass inserted (`maybeLog` skips the ones already open). */
  logged: Sig[]
  /**
   * Facts whose EMBEDDING leg is COMPLETE — a vector was available for them, so nothing about
   * their check depends on a later run. The store stamps exactly these; anything absent stays
   * queued and `conflict_pending` keeps reporting it.
   */
  complete: number[]
}


/**
 * Contradiction detector: the structural signals (always, no vectors) then the embedding
 * fallback when vectors are available. Pairs are normalized (min,max) and deduped.
 *
 * STATELESS about what is pending. It used to hold a Set of changed fact ids and retry them, which
 * meant "awaiting the embedder" was lost on every restart, could grow without bound, and needed a
 * bound plus a dropped-count to stay honest. `facts.conflict_checked` now records it durably, so
 * this class only ever answers "what do these facts conflict with" (`checkOne` / `checkMany`) and
 * the STORE owns the queue (see `MemoryStore.checkContradictions`).
 */
export class ContradictDetector {
  private readonly triples: TriplesDao
  private readonly repo: ContradictionsDao
  private readonly entities: EntitiesDao
  private readonly facts: FactsDao

  constructor(
    private readonly db: Db,
    private readonly threshold = DEFAULT_CONTRADICT_THRESHOLD,
    private readonly fetchVectors: (ids: number[]) => Map<number, Float32Array> = () => new Map(),
    private readonly fetchEntities: (id: number) => string[] = () => [],
    /** Optional batched entity fetch — one query for the whole candidate set instead of N+1. */
    private readonly fetchEntitiesBatch?: (ids: number[]) => Map<number, string[]>,
  ) {
    this.triples = new TriplesDao(db)
    this.repo = new ContradictionsDao(db)
    this.entities = new EntitiesDao(db)
    this.facts = new FactsDao(db)
  }

  /**
   * Check ONE fact against the corpus — the WRITE-path entry.
   *
   * A fact is checked as it is written, so the open-contradiction list is truthful
   * without anyone remembering to run a sweep (the UI used to read an always-empty
   * log as "no contradictions").
   *
   * It leaves the pending set itself (see {@link detect}): the id stays queued only while
   * the embedding leg could not run — i.e. no vector in the live index — so a later
   * {@link checkMany} can retry exactly those. Re-checking a fact that was already scored
   * with its vector would repeat an identical pass, and doing that for every write is what
   * made the queue grow without bound.
   */
  checkOne(factId: number): CheckResult {
    const changedIds = this.filterActive([factId])
    if (changedIds.length === 0) return { logged: [], complete: [] }
    // ONE fact can only be part of its OWN pairs, so the suppression set is read by fact instead
    // of by whole log: measured 60.8 ms → 0.06 ms per write at 100k open pairs (see
    // `ContradictionsDao.suppressedPairsFor`).
    return this.detect(changedIds, (ids) => this.repo.suppressedPairsFor(ids[0]!))
  }

  /**
   * A fact left the active corpus: retire the open conflicts that name it (see
   * {@link ContradictionsDao.resolveForFact}). Returns how many rows were closed.
   */
  resolveForFact(factId: number): number {
    return this.repo.resolveForFact(factId)
  }

  /**
   * The lifecycle tick's bulk form: close the open conflicts of every id in one pass.
   *
   * The per-id loop cost O(archived × log) — measured 6.3 s for 999 ids at 99k open pairs, inside
   * the tick's single IMMEDIATE transaction, i.e. holding the write lock for that whole time.
   */
  resolveForFacts(factIds: readonly number[]): number {
    return this.repo.resolveForFacts(factIds)
  }

  /** Every OPEN conflict naming `factId` — what a writer is told about (see the repo). */
  openConflictsFor(factId: number): ConflictPair[] {
    return this.repo.openConflictsFor(factId)
  }

  /** One stored conflict by id (adjudication needs the pair and its state). */
  get(id: number): StoredConflict | undefined {
    return this.repo.getById(id)
  }

  /** Record a verdict on a conflict WITHOUT touching the facts (see `resolveContradiction`). */
  resolve(id: number, resolution: 'true_positive' | 'false_positive', loserFactId?: number): void {
    this.repo.resolve(id, resolution, loserFactId)
  }

  /** List conflicts for the admin surface (`resolved` 0 = open). */
  list(resolved = 0, category?: string, threshold?: number, limit = 10): ContradictionRecord[] {
    return this.repo.list(resolved, category, threshold, limit)
  }

  /** Drain the pending set: the incremental sweep (`admin contradict_check`). */
  /**
   * Check a LIST of facts — the store's durable drain supplies it (`contradict_check`).
   *
   * Only ACTIVE ids participate (design: 新变更 × 全量 active). A fact that is no longer active
   * can never be checked again — its open rows were retired when it left the corpus — so it is
   * filtered out here. It needs no stamp either: the queue predicate is `status = 'active'`.
   */
  checkMany(factIds: readonly number[]): CheckResult {
    const active = this.filterActive([...factIds])
    if (active.length === 0) return { logged: [], complete: [] }
    return this.detect(active)
  }

  /**
   * Both signal families over the given (already filtered to ACTIVE) facts.
   *
   * `suppressed` decides how the already-logged set is read: a single-fact check only needs that
   * fact's pairs, while the sweep reads the whole log once. Both are correct because `maybeLog` is
   * only ever called with one side being a CHANGED id.
   */
  private detect(changedIds: number[], suppressed: (ids: number[]) => Set<string> = () => this.repo.suppressedPairs()): CheckResult {
    const existing = suppressed(changedIds)
    const logged: Sig[] = []
    this.structuralPass(changedIds, existing, logged)
    // Embedding fallback (needs vectors; skipped when unavailable). What it returns is exactly
    // "whose check is finished": the facts whose vector this pass actually had in hand.
    const complete = this.embeddingPass(changedIds, existing, logged)
    // Pending = the facts whose embedding leg could NOT run (no vector in the live index).
    // Anything the pass could score is done: keeping it queued would re-run an identical pass
    // on every later sweep, and the queue would grow with every write in a long-lived process.
    return { logged, complete }
  }

  /** Structural signals — pure SQL, no vectors needed. */
  private structuralPass(changedIds: number[], existing: Set<string>, logged: Sig[]): void {
    for (const fid of changedIds) {
      const own = this.triples.getByFact(fid)
      for (const t of own) {
        for (const other of this.triples.findPolarityCounterparts(t.subj, t.obj, oppositePolarityPredicates(t.pred), fid)) {
          this.maybeLog(fid, other.fact_id, POLARITY_CONFLICT_SCORE, existing, logged)
        }
        for (const other of this.triples.findSameSubjPredOtherObj(t.subj, t.pred, t.obj, fid)) {
          this.maybeLog(fid, other.fact_id, OBJECT_CONFLICT_SCORE, existing, logged)
        }
      }
    }
  }

  /** ACTIVE subset of `ids` (batched: the pending set grows with the corpus). */
  private filterActive(ids: number[]): number[] {
    return this.facts.activeIds(ids)
  }

  /**
   * Active facts that could POSSIBLY conflict with `factId` through the embedding leg.
   *
   * The scorer is `overlap × cosine` with `overlap = |A∩B| / |A∪B|`, gated by
   * `overlap ≥ EMBED_OVERLAP_MIN`, `sim ≤ EMBED_SIM_DUP_MAX` and `|·| ≥ EMBED_MIN_ENTITIES`,
   * and the pair is only logged when the score reaches `threshold`. So a qualifying pair
   * must have
   *
   *     p := max(EMBED_OVERLAP_MIN, threshold / EMBED_SIM_DUP_MAX)   (score ≤ overlap × simDupMax)
   *     |A∩B| ≥ p·|A|      because |A∪B| ≥ |A|
   *     |B|   ≤ |A|/p      because |A∩B| ≤ |A| and |A∩B| ≥ p·|B|
   *
   * Both are NECESSARY conditions, so filtering on them drops no pair that could ever be
   * logged — it only shrinks the set the vector fetch and the pairwise cosine then pay for.
   * On a hub entity (one entity shared by 30k facts, checked fact has two) the shared-entity
   * floor alone removes the whole hub, because 1 shared entity cannot reach `p·|A| = 2`.
   */
  private findEntitySharing(factId: number): number[] {
    const mineCount = this.entities.countForFact(factId)
    if (mineCount < EMBED_MIN_ENTITIES) return [] // the scorer returns 0 below the entity floor
    const p = Math.max(EMBED_OVERLAP_MIN, this.threshold / EMBED_SIM_DUP_MAX)
    const minShared = Math.ceil(p * mineCount)
    const maxEntities = Math.floor(mineCount / p)
    if (minShared > mineCount || maxEntities < EMBED_MIN_ENTITIES) return []
    return this.entities.candidateFacts(factId, minShared, maxEntities)
  }

  /**
   * Score every changed fact against its candidate set.
   *
   * Returns the ids whose OWN vector this pass had in hand — the embedding leg RAN for those, so
   * they are the only ones whose check is complete. Note what this is NOT: `logged.length`. A
   * fact can be fully checked and log nothing (no candidate reached the threshold), and a fact
   * whose vector is missing was never checked at all yet logs nothing either. Only the vector
   * table separates the two, which is why the pass returns it instead of the caller re-deriving
   * it from the database (`semantic_vector IS NOT NULL` is a different question — see `CheckResult`).
   *
   * The entity floor counts as complete: `detectContradictionEmbedding` returns 0 below
   * `EMBED_MIN_ENTITIES` whatever the vectors are, so no later pass could score differently.
   */
  private embeddingPass(changedIds: number[], existing: Set<string>, logged: Sig[]): number[] {
    const candidates = new Map<number, number[]>()
    const universe = new Set<number>(changedIds)
    for (const c of changedIds) {
      const ids = this.findEntitySharing(c)
      candidates.set(c, ids)
      for (const id of ids) universe.add(id)
    }
    const allIds = [...universe]
    if (allIds.length === 0) return []
    // One batched entity load and one vector fetch for the whole candidate universe.
    const entCache: Map<number, Set<string>> = this.fetchEntitiesBatch
      ? new Map([...this.fetchEntitiesBatch(allIds)].map(([id, names]) => [id, new Set(names)]))
      : new Map()
    const entFor = (id: number): Set<string> => {
      let set = entCache.get(id)
      if (!set) {
        set = new Set(this.fetchEntities(id))
        entCache.set(id, set)
      }
      return set
    }
    const vectors = this.fetchVectors(allIds)
    const complete: number[] = []
    for (const c of changedIds) {
      const vecC = vectors.get(c)
      if (!vecC) continue // no vector in the live index ⇒ nothing was scored for this fact
      complete.push(c)
      const entC = entFor(c)
      if (entC.size < EMBED_MIN_ENTITIES) continue // leg ran: below the floor it scores 0
      for (const t of candidates.get(c) ?? []) {
        if (t === c) continue
        const key = c < t ? `${c}|${t}` : `${t}|${c}`
        if (existing.has(key)) continue
        const vecT = vectors.get(t)
        if (!vecT) continue
        const score = detectContradictionEmbedding(entC, entFor(t), vecC, vecT)
        this.maybeLog(c, t, score, existing, logged)
      }
    }
    return complete
  }

  private maybeLog(factA: number, factB: number, score: number, existing: Set<string>, logged: Sig[]): void {
    if (score < this.threshold) return
    const key = factA < factB ? `${factA}|${factB}` : `${factB}|${factA}`
    if (existing.has(key)) return
    this.repo.log(factA, factB, score)
    existing.add(key)
    logged.push({ fact_a: factA, fact_b: factB, score })
  }
}

export type Sig = ContradictionSig
