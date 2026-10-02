/**
 * Projection-cache residue: the last on-disk trace a released worker leaves behind.
 *
 * A worker is a real session, so the host keeps a durable projection checkpoint for it — one file
 * per session under `<dsh home>/storages/session_projcache/sessions/<id>.json`. The host's
 * `dsh-session-projection-cache` writes that record on `session/created` and, on `session/disposed`,
 * flushes it (`flushSoft('detach')`) and **deliberately keeps the file** so a reopened session
 * starts warm. There is NO public eviction API: the domain's `delete(`/`clear(` are operations on
 * its internal in-memory Map, not a durable removal path. So when this plugin releases a worker's
 * session directory (the harness has no delete there either), one trace survives — and the parent
 * session reads the stale row back as a subagent, which is the "invisible worker" a person still
 * sees in the list after `/clean` reported the record gone.
 *
 * Every rule here is a guardrail, mirroring `workerSessions.ts`:
 *   - only a file named exactly `mission-<8 hex>.json` is ever considered (no other plugin's or
 *     session's record can be reached by a caller bug);
 *   - the caller proves absence (session corpus AND sessions root both silent) before calling;
 *   - the host's `session_projcache.json` INDEX is never touched — it belongs to the storage domain,
 *     and a concurrent write from here could race the host's own writer;
 *   - every action is best-effort: a missing directory, a missing file or an fs failure is a no-op
 *     or a warning, never an error that could fail a mount or a command.
 * @module @avantf/dsh-mission/projectionCache
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** The only names this module ever removes: an exact worker claim id plus the record suffix. */
const RESIDUE_FILE = /^(mission-[0-9a-f]{8})\.json$/

/** Where one session's projection-cache record lives under the cache root. */
export function projectionCachePath(root: string, id: string): string {
  return join(root, `${id}.json`)
}

/**
 * The worker ids with a residue file under `root`, in directory order.
 *
 * A missing or unreadable directory yields `[]`: "nothing to clean" is the safe answer, never an
 * error — this runs inside mount and inside commands, neither of which may fail because a cache
 * directory is absent.
 */
export function listProjectionCacheIds(root: string): readonly string[] {
  let names: readonly string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const ids: string[] = []
  for (const name of names) {
    const id = RESIDUE_FILE.exec(name)?.[1]
    if (id !== undefined) ids.push(id)
  }
  return ids
}

/** What one best-effort removal did: `removed` / nothing there (`absent`) / fs refused (`failed`). */
export type ProjectionCacheRemoval = 'removed' | 'absent' | 'failed'

/**
 * Remove one worker's residue file, best-effort.
 *
 * Only a `mission-<8 hex>` id is accepted, so a caller bug cannot turn this into a delete of an
 * arbitrary path. A missing file is `absent`, not an error (a cleaned session may never have
 * checkpointed, and a previous pass may already have removed it). A real fs failure is `failed`,
 * which the caller reports as a warning — cleanup is never allowed to fail a command.
 */
export function removeProjectionCache(root: string, id: string): ProjectionCacheRemoval {
  if (RESIDUE_FILE.exec(`${id}.json`) === null) return 'absent'
  const file = projectionCachePath(root, id)
  if (!existsSync(file)) return 'absent'
  try {
    rmSync(file, { force: true })
    return 'removed'
  } catch {
    return 'failed'
  }
}
