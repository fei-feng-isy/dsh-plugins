/**
 * Finding, archiving and removing the session logs of this plugin's own workers.
 *
 * The lifecycle `/clean archive` completes has THREE steps, and the third is what keeps the
 * subagent list honest:
 *   1. **mark archived** — `workspaceRegistry.archiveSession(id)` (the official interface);
 *   2. **release the record** — delete the session directory (there is NO harness delete API);
 *   3. **unarchive** — `workspaceRegistry.unarchiveSession(id)`, best-effort. The marker exists
 *      only to authorize step 2, so leaving it behind after the record is gone is a "ghost id":
 *      durable in the registry, absent on disk, and still listed by every surface that reads the
 *      archive set. A failed unarchive is reported and NEVER rolls back the deletion.
 *
 * `reconcileArchivedGhosts` clears the ghosts older runs left behind, under a deliberately narrow
 * scope: only `mission-*`-shaped ids, only when neither the session corpus nor the sessions root
 * knows them, and only when the corpus could actually be read (absence must be PROVEN, not assumed).
 *
 * There is a FOURTH trace, one layer below the record: the host's projection cache. Releasing a
 * session directory does not evict its `<dsh home>/storages/session_projcache/sessions/<id>.json`
 * checkpoint — the host keeps disposed sessions' records for a warm reopen and exposes no eviction
 * API (see `projectionCache.ts`). The parent session reads those stale rows back as subagents, so a
 * released worker can still show up in the list. This module therefore removes the residue alongside
 * the record: for what `/clean archive` releases, and — the reconcile pass's PRIMARY input, since
 * the archive set can legitimately be empty while residue persists — by enumerating the cache
 * directory itself and asking the same "is the record proven gone?" predicate.
 *
 * Removing has NO harness API, so this module deletes the directory itself — only for a session
 * this plugin dispatched, never a live one, and the directory named exactly the session id under
 * the configured sessions root. Another session's worker is reported, never touched.
 * @module @avantf/dsh-mission/workerSessions
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isWorkerClaimId } from './claims.js'
import { listProjectionCacheIds, removeProjectionCache } from './projectionCache.js'

/**
 * The slice of the workspace registry these commands use, declared structurally: the
 * registry is an optional service here (absent headless), and importing it would make a
 * type the plugin only reads into a deployment requirement.
 */
export interface ArchiveRegistry {
  readonly archivedSessionIds?: readonly string[]
  archiveSession(id: SessionId): Promise<void>
  /**
   * Durable unarchive: idempotent on the host ("an id that is not archived resolves without
   * writing"), which is what makes the reconcile pass safe to run on every mount. Optional here
   * because a host older than the API must still mount; the pass reports itself unsupported then.
   */
  unarchiveSession?(id: SessionId): Promise<void>
}

/** One stored session, as `sessionQuery.listSessions()` reports it. */
export interface StoredSession {
  readonly header: {
    readonly id: string
    readonly createdAt?: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly parentSession?: string
  }
  /** Whether the id currently exists as a live agent. */
  readonly live: boolean
}

/** What the commands need from the host; explicit so tests can pass fakes. */
export interface WorkerSessionDeps {
  /** Stored sessions, live ones included. */
  list(): Promise<readonly StoredSession[]>
  /** Durable archive of one session. Absent in a deployment without a registry. */
  archive?(id: string): Promise<void>
  /**
   * Durable unarchive of one session — step 3 of the cleanup lifecycle. Absent without a registry,
   * or on a host whose registry predates `unarchiveSession`; the pass then reports itself
   * unsupported instead of pretending the marker was lifted.
   */
  unarchive?(id: string): Promise<void>
  isLive(id: string): boolean
  /** Root of the session store (`$DSH_HOME/sessions`, `~/.dsh/sessions` by default). */
  sessionsRoot: string
  /**
   * Root of the host's projection-cache record directory
   * (`<dsh home>/storages/session_projcache/sessions` by default). The host keeps one record per
   * session even after disposal and has no eviction API, so a released record leaves a residue this
   * module removes. Absent/unreadable is not an error — it simply means there is nothing to clean.
   */
  projectionCacheRoot: string
}

/** One of this plugin's workers, with what the commands need to report. */
export interface WorkerSession {
  readonly id: string
  readonly createdAt: number
  readonly live: boolean
  /** Whether its log directory was found; a session can be listed without one. */
  readonly bytes: number
  readonly dir: string | undefined
}

/**
 * A mission worker at all, whichever session owns it: `origin: subagent`, delegation depth 1, and a
 * claim-id shape. The harness's own delegations use uuids, so they never match. Ownership is the
 * separate half (`isOurWorker`), because a listing must be able to say "another session's worker"
 * out loud without that statement being an authorization.
 */
export function isMissionWorker(record: StoredSession): boolean {
  const header = record.header
  return header.origin === 'subagent'
    && header.delegationDepth === 1
    && isWorkerClaimId(header.id)
}

export function isOurWorker(record: StoredSession, ownerId: string): boolean {
  return isMissionWorker(record) && record.header.parentSession === ownerId
}

/** The directory a session id owns, scanned by name so no path encoding is replicated. */
export function sessionDirFor(root: string, id: string): string | undefined {
  if (!existsSync(root)) return undefined
  for (const project of readdirSync(root)) {
    const candidate = join(root, project, id)
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  }
  return undefined
}

/** Bytes one directory occupies, or 0 when it is gone. */
function sessionBytes(dir: string | undefined): number {
  if (dir === undefined || !existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    try {
      total += statSync(join(entry.parentPath, entry.name)).size
    } catch {
      // A file that vanished mid-walk contributes nothing.
    }
  }
  return total
}

/** This session's own workers, newest last. */
export async function workerSessions(deps: WorkerSessionDeps, ownerId: string): Promise<readonly WorkerSession[]> {
  const all = await deps.list()
  return toWorkers(deps, all.filter((record) => isOurWorker(record, ownerId)))
}

/** Mission workers of OTHER sessions, as ids: shown so a skip is legible, never an authorization. */
export async function foreignWorkerIds(deps: WorkerSessionDeps, ownerId: string): Promise<readonly string[]> {
  const all = await deps.list()
  return all
    .filter((record) => isMissionWorker(record) && !isOurWorker(record, ownerId))
    .map((record) => record.header.id)
}

/** Stored records projected into the shape the commands report, with the bytes each one owns. */
function toWorkers(deps: WorkerSessionDeps, records: readonly StoredSession[]): WorkerSession[] {
  return records
    .map((record) => {
      const dir = sessionDirFor(deps.sessionsRoot, record.header.id)
      return {
        id: record.header.id,
        createdAt: record.header.createdAt ?? 0,
        live: record.live || deps.isLive(record.header.id),
        bytes: sessionBytes(dir),
        dir,
      }
    })
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** One owner session's retention picture, computed from its own workers (never from the store). */
export interface WorkerRetention {
  /** Settled workers (`!live`), newest first; ties broken by id so the order is deterministic. */
  readonly settled: readonly WorkerSession[]
  /** Live workers: excluded from the count entirely, and never a release candidate. */
  readonly live: readonly WorkerSession[]
  /** The newest `keep` settled workers the policy holds (all of them when the policy is off). */
  readonly retained: readonly WorkerSession[]
  /** Settled workers OLDER than the retained ones: what automatic retention would release. */
  readonly releasable: readonly WorkerSession[]
  /** `false` when `keep <= 0`: automatic retention is OFF, so nothing is releasable. */
  readonly enabled: boolean
}

/**
 * Split one owner's workers into what the retention policy KEEPS and what it would release.
 *
 * The count is over SETTLED (`!live`) workers only. A live worker does not occupy a retention slot
 * and is never a candidate, so "keep the newest N" means "keep the newest N FINISHED workers",
 * however many are still running: 13 finished + 4 running with N=10 releases 3, and 3 finished +
 * 8 running with N=10 releases nothing.
 *
 * Ordering is by `header.createdAt` descending — newest first — with the id as a deterministic
 * tie-break, so a listing and a pass can never disagree about which worker sits on the boundary.
 * `keep <= 0` disables the policy: everything is kept and nothing is releasable (the disabled
 * spelling is "keep all", NOT "keep none").
 */
export function workerRetention(workers: readonly WorkerSession[], keep: number): WorkerRetention {
  const settled = workers
    .filter((worker) => !worker.live)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const live = workers.filter((worker) => worker.live)
  const enabled = keep > 0
  return {
    settled,
    live,
    retained: enabled ? settled.slice(0, keep) : settled,
    releasable: enabled ? settled.slice(keep) : [],
    enabled,
  }
}

export function bytes(n: number): string {
  if (n < 1024) return `${String(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Archive every settled, not-yet-archived worker of this session. */
export async function archiveWorkers(
  deps: WorkerSessionDeps,
  ownerId: string,
  archived: (id: string) => boolean,
): Promise<{ readonly archived: readonly string[]; readonly skipped: readonly string[]; readonly supported: boolean }> {
  if (deps.archive === undefined) return { archived: [], skipped: [], supported: false }
  const done: string[] = []
  const skipped: string[] = []
  for (const worker of await workerSessions(deps, ownerId)) {
    if (worker.live || archived(worker.id)) {
      skipped.push(worker.id)
      continue
    }
    await deps.archive(worker.id)
    done.push(worker.id)
  }
  return { archived: done, skipped, supported: true }
}

/** One worker a cleanup pass archived (when needed) and then removed. */
export interface CleanedWorker {
  readonly id: string
  readonly freed: number
  /** `true` when THIS run wrote the archive marker; `false` when it was already archived. */
  readonly archivedNow: boolean
}

/** One settled worker whose archive FAILED: deliberately left in place, with the reason. */
export interface RefusedWorker {
  readonly id: string
  readonly reason: string
}

/** What one `/clean archive` pass did, and the three buckets of what it left alone. */
export interface WorkerCleanup {
  readonly cleaned: readonly CleanedWorker[]
  readonly refused: readonly RefusedWorker[]
  /**
   * Records that WERE removed, but whose archive marker could not be lifted (step 3 failed).
   * The deletion stands — the files are gone, so keeping the marker only adds a ghost — and the
   * failure is reported instead of rolled back.
   */
  readonly unarchiveFailures: readonly RefusedWorker[]
  /**
   * Projection-cache residue files removed for the records this pass released. The host keeps a
   * disposed session's checkpoint with no eviction API, so this is the layer that would otherwise
   * keep the worker listed forever.
   */
  readonly purged: readonly string[]
  /** Residue files that could not be removed: reported, never fatal, never a rollback. */
  readonly purgeFailures: readonly RefusedWorker[]
  /** Ours, still running: never touched. */
  readonly running: readonly string[]
  /** Mission workers of other sessions: never touched. */
  readonly foreign: readonly string[]
  /** `false` when no registry is mounted: nothing can be archived, so nothing is removed. */
  readonly supported: boolean
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Archive-then-remove in ONE pass, for this session's settled workers, finishing with the
 * best-effort unarchive that keeps the registry free of ghost ids.
 *
 * Scope is exactly `isOurWorker(record, ownerId) && !live`: a live worker is never touched (no
 * interrupt, no archive) and another session's worker is never touched. A settled worker that is not
 * yet archived is archived FIRST, and removed only once that succeeded — a failed archive leaves the
 * record in place and is reported, because "removed without an archive marker" is the one outcome the
 * guardrails exist to prevent. After a successful removal the marker is lifted; if THAT fails the
 * deletion still stands (the files are gone) and the failure is reported in `unarchiveFailures`.
 * `only` narrows the pass to one named id, still looked up inside this session's own workers. Without
 * a registry the pass is `supported: false` and removes nothing.
 *
 * `retain` is the AUTOMATIC retention half: it narrows the candidates to the settled workers OLDER
 * than the newest `retain` (see {@link workerRetention}) and reuses this same archive → delete →
 * unarchive → purge pipeline. Live workers are excluded from the count, so they never occupy a
 * retention slot and are never released. `retain <= 0` means "policy off", which keeps everything.
 * A named `only` pass is an explicit manual action and ignores `retain`.
 */
export async function cleanWorkers(
  deps: WorkerSessionDeps,
  ownerId: string,
  archived: (id: string) => boolean,
  options: { readonly only?: string; readonly retain?: number } = {},
): Promise<WorkerCleanup> {
  const all = await deps.list()
  const foreign = all
    .filter((record) => isMissionWorker(record) && !isOurWorker(record, ownerId))
    .map((record) => record.header.id)
  const mine = all.filter((record) =>
    isOurWorker(record, ownerId) && (options.only === undefined || record.header.id === options.only))
  const workers = toWorkers(deps, mine)
  const running = workers.filter((worker) => worker.live).map((worker) => worker.id)
  // Automatic retention: release only what falls outside the newest `retain` settled workers. The
  // named form is manual and explicit, so it is never narrowed.
  const candidates = options.only === undefined && options.retain !== undefined
    ? workerRetention(workers, options.retain).releasable
    : workers

  if (deps.archive === undefined) {
    return {
      cleaned: [],
      refused: [],
      unarchiveFailures: [],
      purged: [],
      purgeFailures: [],
      running,
      foreign,
      supported: false,
    }
  }

  const cleaned: CleanedWorker[] = []
  const refused: RefusedWorker[] = []
  const unarchiveFailures: RefusedWorker[] = []
  const purged: string[] = []
  const purgeFailures: RefusedWorker[] = []
  for (const worker of candidates) {
    if (worker.live) continue
    const already = archived(worker.id)
    if (!already) {
      try {
        await deps.archive(worker.id)
      } catch (error) {
        refused.push({ id: worker.id, reason: reasonOf(error) })
        continue
      }
    }
    cleaned.push({ id: worker.id, freed: removeWorker(worker), archivedNow: !already })
    // The record is gone; its projection-cache residue must go too, or the parent session keeps
    // reading the stale row back (the "invisible worker"). Best-effort: a missing file is normal,
    // and an fs failure is reported rather than allowed to fail the cleanup.
    const removal = removeProjectionCache(deps.projectionCacheRoot, worker.id)
    if (removal === 'removed') purged.push(worker.id)
    else if (removal === 'failed') purgeFailures.push({ id: worker.id, reason: 'projection cache file could not be removed' })
    // Step 3, AFTER the record is gone: the marker authorized the release and has no other job.
    // Best-effort on purpose — the deletion must not be undone because the marker outlived it.
    if (deps.unarchive !== undefined) {
      try {
        await deps.unarchive(worker.id)
      } catch (error) {
        unarchiveFailures.push({ id: worker.id, reason: reasonOf(error) })
      }
    }
  }
  return { cleaned, refused, unarchiveFailures, purged, purgeFailures, running, foreign, supported: true }
}

export function removeWorker(worker: WorkerSession): number {
  if (worker.dir === undefined) return 0
  const freed = worker.bytes
  rmSync(worker.dir, { recursive: true, force: true })
  return freed
}

/**
 * The live-preferred session corpus, as `sessionQuery.listSessions()` answers it.
 *
 * `readable: false` is the load-bearing half: with no session query at all, "no record" cannot be
 * told apart from "cannot ask", and this module treats an unproven absence as presence.
 */
export interface SessionCorpus {
  readonly readable: boolean
  readonly known: ReadonlySet<string>
}

/** What one ghost-reconciliation pass did, for the log line and the command's reply. */
export interface GhostReconcile {
  /** Archive markers lifted this pass. */
  readonly released: readonly string[]
  /** Markers whose `unarchiveSession` call failed: reported, never fatal. */
  readonly failed: readonly RefusedWorker[]
  /** Projection-cache residue files removed this pass (records proven gone). */
  readonly purged: readonly string[]
  /** Residue files that could not be removed: reported, never fatal. */
  readonly purgeFailures: readonly RefusedWorker[]
  /** `false` when there is no unarchive API to call: nothing was attempted. */
  readonly supported: boolean
  /** `false` when the corpus could not be read: absence is unproven, so nothing was attempted. */
  readonly readable: boolean
}

/** What one projection-cache purge pass did: what it removed, and what it could not. */
export interface ProjectionCachePurge {
  readonly purged: readonly string[]
  readonly failures: readonly RefusedWorker[]
}

/**
 * Archived ids that are GHOSTS: mission-shaped, gone from the live-preferred corpus AND gone from
 * the sessions root under every project directory.
 *
 * Written as one predicate used by both the listing and the reconcile pass, so what `/clean archive`
 * shows and what it clears can never disagree. The narrowness is the whole safety argument: a
 * non-mission id belongs to another subsystem or another session's archive set, and an id either
 * source still knows is a record whose archive marker is still meaningful.
 */
export function ghostArchiveIds(
  archived: ReadonlySet<string>,
  known: ReadonlySet<string>,
  sessionsRoot: string,
): readonly string[] {
  return [...archived].filter((id) =>
    isWorkerClaimId(id)
    && !known.has(id)
    && sessionDirFor(sessionsRoot, id) === undefined)
}

/**
 * Projection-cache residue whose record is PROVEN gone: `mission-*`-shaped files under the cache
 * root whose id is absent from BOTH the live-preferred corpus and the sessions root.
 *
 * The SAME absence predicate as `ghostArchiveIds`, for a different layer: that function reasons
 * about archive markers, this one about the host's cached rows. Read-only: it answers what a purge
 * would remove without removing anything.
 *
 * An unreadable corpus means absence is unproven, so the answer is `[]`. A record either source
 * still knows is a session in use; its cache is never a candidate.
 */
export function orphanProjectionCacheIds(
  deps: WorkerSessionDeps,
  corpus: SessionCorpus,
): readonly string[] {
  if (!corpus.readable) return []
  return listProjectionCacheIds(deps.projectionCacheRoot).filter((id) =>
    !corpus.known.has(id) && sessionDirFor(deps.sessionsRoot, id) === undefined)
}

/**
 * Remove the projection-cache residue of every record PROVEN gone.
 *
 * Registry-independent by design: proving a record gone needs the corpus and the sessions root, not
 * an archive marker — and the archive set can legitimately be empty while residue persists, which
 * is exactly why this enumerates the cache directory instead of taking archived ids as input. Every
 * removal is best-effort; a failure is returned, never thrown.
 */
export function purgeOrphanProjectionCache(
  deps: WorkerSessionDeps,
  corpus: SessionCorpus,
): ProjectionCachePurge {
  const purged: string[] = []
  const failures: RefusedWorker[] = []
  for (const id of orphanProjectionCacheIds(deps, corpus)) {
    const removal = removeProjectionCache(deps.projectionCacheRoot, id)
    if (removal === 'removed') purged.push(id)
    else if (removal === 'failed') failures.push({ id, reason: 'projection cache file could not be removed' })
  }
  return { purged, failures }
}

/**
 * Lift the archive markers older cleanups left behind, and clear the projection-cache residue of
 * records that no longer exist, so the subagent list stops showing workers that are gone.
 *
 * Deliberately conservative, in three ways: only `mission-*`-shaped ids, only ids absent from BOTH
 * the live-preferred corpus and the sessions root, and only when the corpus was readable at all (an
 * unreadable corpus means absence is unproven). The residue purge runs FIRST and is
 * registry-independent — the archive set no longer has to be non-empty for the pass to do its work.
 * Each unarchive is best-effort — a failure is returned, never thrown — and the host's own unarchive
 * is idempotent, so re-running this pass is safe.
 */
export async function reconcileArchivedGhosts(
  deps: WorkerSessionDeps,
  archived: ReadonlySet<string>,
  corpus: SessionCorpus,
): Promise<GhostReconcile> {
  const purge = purgeOrphanProjectionCache(deps, corpus)
  const unarchive = deps.unarchive
  if (unarchive === undefined || !corpus.readable) {
    return {
      released: [],
      failed: [],
      purged: purge.purged,
      purgeFailures: purge.failures,
      supported: unarchive !== undefined,
      readable: corpus.readable,
    }
  }
  const released: string[] = []
  const failed: RefusedWorker[] = []
  for (const id of ghostArchiveIds(archived, corpus.known, deps.sessionsRoot)) {
    try {
      await unarchive(id)
      released.push(id)
    } catch (error) {
      failed.push({ id, reason: reasonOf(error) })
    }
  }
  return {
    released,
    failed,
    purged: purge.purged,
    purgeFailures: purge.failures,
    supported: true,
    readable: true,
  }
}
