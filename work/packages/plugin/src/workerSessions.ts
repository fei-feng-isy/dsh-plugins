/**
 * Finding, archiving and removing the session logs of this plugin's own workers.
 * Archiving is a supported harness operation that frees no disk; removing has NO harness
 * API, so this module deletes the directory itself — only for a session this plugin
 * dispatched, never a live one, `/clean all` limited to archived ids, and the directory
 * named exactly the session id under the configured sessions root.
 * @module @avantf/dsh-work/workerSessions
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isWorkerClaimId } from './claims.js'

/**
 * The slice of the workspace registry these commands use, declared structurally: the
 * registry is an optional service here (absent headless), and importing it would make a
 * type the plugin only reads into a deployment requirement.
 */
export interface ArchiveRegistry {
  readonly archivedSessionIds?: readonly string[]
  archiveSession(id: SessionId): Promise<void>
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
  isLive(id: string): boolean
  /** Root of the session store (`~/.dsh/sessions` by default). */
  sessionsRoot: string
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

export function isOurWorker(record: StoredSession, ownerId: string): boolean {
  const header = record.header
  return header.origin === 'subagent'
    && header.delegationDepth === 1
    && header.parentSession === ownerId
    && isWorkerClaimId(header.id)
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
export function sessionBytes(dir: string | undefined): number {
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
  return all
    .filter((record) => isOurWorker(record, ownerId))
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

export function removeWorker(worker: WorkerSession): number {
  if (worker.dir === undefined) return 0
  const freed = worker.bytes
  rmSync(worker.dir, { recursive: true, force: true })
  return freed
}
