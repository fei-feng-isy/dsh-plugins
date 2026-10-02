/**
 * `/archive` and `/clean`: which sessions they may touch, and the guardrails that keep a
 * wrong sessions root from deleting somebody else's data.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveWorkers,
  bytes,
  cleanWorkers,
  foreignWorkerIds,
  ghostArchiveIds,
  isOurWorker,
  orphanProjectionCacheIds,
  purgeOrphanProjectionCache,
  reconcileArchivedGhosts,
  removeWorker,
  sessionDirFor,
  workerSessions,
  type StoredSession,
  type WorkerSessionDeps,
} from '../src/workerSessions.js'

const OWNER = 'session-owner'
const WORKER = 'mission-1234abcd'

/** One stored session, as the query engine would report it. */
function stored(id: string, overrides: Partial<StoredSession['header']> = {}, live = false): StoredSession {
  return { header: { id, origin: 'subagent', delegationDepth: 1, parentSession: OWNER, ...overrides }, live }
}

/** Deps over a temp session root; `archived` records what archiving was asked for. */
function deps(root: string, list: readonly StoredSession[]): WorkerSessionDeps & { archived: string[] } {
  const archived: string[] = []
  return {
    archived,
    list: () => Promise.resolve(list),
    archive: (id: string) => {
      archived.push(id)
      return Promise.resolve()
    },
    isLive: () => false,
    sessionsRoot: root,
    // A cache root that does not exist unless a case creates one: the default must be a no-op, and
    // a spec must never point this at a real `<dsh home>`.
    projectionCacheRoot: join(root, 'projcache'),
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A session root with one project directory holding the given session ids. */
function sessionRoot(ids: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'avwf-sessions-'))
  roots.push(root)
  const project = join(root, '--tmp-project--')
  mkdirSync(project, { recursive: true })
  for (const id of ids) {
    const dir = join(project, id)
    mkdirSync(dir, { recursive: true })
    // 2 KB of log, so the freed-byte accounting has something to report.
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'x'.repeat(2048))
  }
  return root
}

/**
 * A projection-cache root holding one recorded checkpoint per given id (plus any extra file names),
 * as the host's `session_projcache/sessions/` directory does. A fresh temp root, tracked for cleanup.
 */
function projectionCacheRoot(ids: readonly string[], extraFiles: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'avwf-projcache-'))
  roots.push(root)
  for (const id of ids) writeFileSync(join(root, `${id}.json`), '{"version":7}')
  for (const name of extraFiles) writeFileSync(join(root, name), '{}')
  return root
}

describe('which sessions are ours', () => {
  it('accepts exactly this session\'s direct claim-id children', () => {
    expect(isOurWorker(stored(WORKER), OWNER)).toBe(true)
    // Somebody else's child.
    expect(isOurWorker(stored(WORKER, { parentSession: 'session-other' }), OWNER)).toBe(false)
    // The harness's own delegation (uuid id) or a top-level session.
    expect(isOurWorker(stored('f4f3163b-1111-2222-3333-444455556666'), OWNER)).toBe(false)
    expect(isOurWorker(stored(WORKER, { origin: undefined }), OWNER)).toBe(false)
    // A grandchild belongs to its own parent, not to this session.
    expect(isOurWorker(stored(WORKER, { delegationDepth: 2 }), OWNER)).toBe(false)
  })

  it('reports each worker with the directory and bytes it owns', async () => {
    const root = sessionRoot([WORKER])
    const workers = await workerSessions(deps(root, [stored(WORKER), stored('mission-deadbeef')]), OWNER)
    // Both are ours (a claim id shape is enough); only one has a directory here.
    expect(workers.map((worker) => worker.id)).toEqual([WORKER, 'mission-deadbeef'])
    expect(workers[0]?.bytes).toBe(2048)
    expect(workers[0]?.dir).toBe(sessionDirFor(root, WORKER))
    expect(workers[1]?.dir).toBeUndefined()
    expect(workers[1]?.bytes).toBe(0)
  })

  it('finds nothing when the root is wrong, instead of finding something else', async () => {
    const root = sessionRoot([WORKER])
    const wrong = mkdtempSync(join(tmpdir(), 'avwf-wrong-'))
    roots.push(wrong)
    const workers = await workerSessions(deps(wrong, [stored(WORKER)]), OWNER)
    // Listed (it is ours in the store) but with no directory to delete.
    expect(workers[0]?.dir).toBeUndefined()
    expect(workers[0]?.bytes).toBe(0)
    expect(removeWorker(workers[0]!)).toBe(0)
    expect(sessionDirFor(root, WORKER)).toBeDefined()
  })
})

describe('archiving', () => {
  it('archives the settled ones and skips the live and the already-archived', async () => {
    const root = sessionRoot([WORKER, 'mission-11112222', 'mission-33334444'])
    const list = [
      stored(WORKER),
      stored('mission-11112222', {}, true),
      stored('mission-33334444'),
    ]
    const fake = deps(root, list)
    const result = await archiveWorkers(fake, OWNER, (id) => id === 'mission-33334444')
    expect(result.supported).toBe(true)
    expect(result.archived).toEqual([WORKER])
    expect(fake.archived).toEqual([WORKER])
    expect([...result.skipped].sort()).toEqual(['mission-11112222', 'mission-33334444'])
  })

  it('reports "unsupported" rather than pretending, without a registry', async () => {
    const result = await archiveWorkers({ list: () => Promise.resolve([]), isLive: () => false, sessionsRoot: '/nope', projectionCacheRoot: '/nope' }, OWNER, () => false)
    expect(result.supported).toBe(false)
  })
})

describe('cleaning in one pass', () => {
  it('archives a settled worker first, then removes it', async () => {
    const root = sessionRoot([WORKER])
    /** The directory as it looked INSIDE the archive call — the only place the ordering is visible. */
    const seenAtArchive: (string | undefined)[] = []
    const fake: WorkerSessionDeps = {
      list: () => Promise.resolve([stored(WORKER)]),
      archive: (id) => {
        seenAtArchive.push(sessionDirFor(root, id))
        return Promise.resolve()
      },
      isLive: () => false,
      sessionsRoot: root,
      projectionCacheRoot: join(root, 'projcache'),
    }

    const result = await cleanWorkers(fake, OWNER, () => false)
    // Archived while the log was still on disk, and removed only after that call returned.
    expect(seenAtArchive).toHaveLength(1)
    expect(seenAtArchive[0]).toBeDefined()
    expect(result.supported).toBe(true)
    expect(result.cleaned).toEqual([{ id: WORKER, freed: 2048, archivedNow: true }])
    expect(sessionDirFor(root, WORKER)).toBeUndefined()
  })

  it('keeps the record when archiving fails, instead of releasing it anyway', async () => {
    const root = sessionRoot([WORKER])
    const failing: WorkerSessionDeps = {
      ...deps(root, [stored(WORKER)]),
      archive: () => Promise.reject(new Error('registry is read-only')),
    }
    const result = await cleanWorkers(failing, OWNER, () => false)
    expect(result.cleaned).toEqual([])
    expect(result.refused).toEqual([{ id: WORKER, reason: 'registry is read-only' }])
    expect(sessionDirFor(root, WORKER)).toBeDefined()
  })

  it('leaves a live worker and another session\'s worker alone, and reports both', async () => {
    const foreign = 'mission-9999aaaa'
    const root = sessionRoot([WORKER, 'mission-11112222', foreign])
    const fake = deps(root, [
      stored(WORKER),
      stored('mission-11112222', {}, true),
      stored(foreign, { parentSession: 'session-other' }),
    ])

    const result = await cleanWorkers(fake, OWNER, () => false)
    expect(result.cleaned.map((entry) => entry.id)).toEqual([WORKER])
    expect(result.running).toEqual(['mission-11112222'])
    expect(result.foreign).toEqual([foreign])
    // Neither skip was archived, and neither log directory was touched.
    expect(fake.archived).toEqual([WORKER])
    expect(sessionDirFor(root, 'mission-11112222')).toBeDefined()
    expect(sessionDirFor(root, foreign)).toBeDefined()
  })

  it('reuses an existing archive marker rather than archiving again', async () => {
    const root = sessionRoot([WORKER])
    const fake = deps(root, [stored(WORKER)])
    const result = await cleanWorkers(fake, OWNER, (id) => id === WORKER)
    expect(result.cleaned).toEqual([{ id: WORKER, freed: 2048, archivedNow: false }])
    expect(fake.archived).toEqual([])
    expect(sessionDirFor(root, WORKER)).toBeUndefined()
  })

  it('narrows to one named id and leaves the other settled workers in place', async () => {
    const root = sessionRoot([WORKER, 'mission-11112222'])
    const fake = deps(root, [stored(WORKER), stored('mission-11112222')])
    const result = await cleanWorkers(fake, OWNER, () => false, { only: WORKER })
    expect(result.cleaned.map((entry) => entry.id)).toEqual([WORKER])
    expect(fake.archived).toEqual([WORKER])
    // A named pass still archives first — it does not skip the gate the old code let it skip.
    expect(result.cleaned[0]?.archivedNow).toBe(true)
    expect(sessionDirFor(root, 'mission-11112222')).toBeDefined()
  })

  it('removes nothing at all without a registry, whatever the listing says', async () => {
    const root = sessionRoot([WORKER])
    const noRegistry: WorkerSessionDeps = {
      list: () => Promise.resolve([stored(WORKER), stored('mission-9999aaaa', { parentSession: 'other' })]),
      isLive: () => false,
      sessionsRoot: root,
      projectionCacheRoot: join(root, 'projcache'),
    }
    const result = await cleanWorkers(noRegistry, OWNER, () => false)
    expect(result.supported).toBe(false)
    expect(result.cleaned).toEqual([])
    expect(result.foreign).toEqual(['mission-9999aaaa'])
    expect(sessionDirFor(root, WORKER)).toBeDefined()
  })

  it('lists another session\'s workers for reporting only', async () => {
    const foreign = 'mission-9999aaaa'
    const ids = await foreignWorkerIds(
      deps('/nope', [stored(WORKER), stored(foreign, { parentSession: 'session-other' }), stored('plain')]),
      OWNER,
    )
    // Ours is not foreign, and a session whose id is not a claim shape is not a worker at all.
    expect(ids).toEqual([foreign])
  })
})

describe('cleaning', () => {
  it('removes the directory and reports the bytes', async () => {
    const root = sessionRoot([WORKER])
    const [worker] = await workerSessions(deps(root, [stored(WORKER)]), OWNER)
    expect(removeWorker(worker!)).toBe(2048)
    expect(sessionDirFor(root, WORKER)).toBeUndefined()
  })

  it('formats sizes for the reply', () => {
    expect(bytes(512)).toBe('512 B')
    expect(bytes(2048)).toBe('2.0 KB')
    expect(bytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('the unarchive step (step 3)', () => {
  it('lifts the marker only AFTER the record is gone: archive → delete → unarchive', async () => {
    const root = sessionRoot([WORKER])
    const seen: string[] = []
    const fake: WorkerSessionDeps = {
      list: () => Promise.resolve([stored(WORKER)]),
      archive: (id) => {
        seen.push(`archive:${id}`)
        return Promise.resolve()
      },
      unarchive: (id) => {
        // The load-bearing observation: step 2 already destroyed the directory when step 3 runs.
        seen.push(`unarchive:${id}:${sessionDirFor(root, id) === undefined ? 'record-gone' : 'record-present'}`)
        return Promise.resolve()
      },
      isLive: () => false,
      sessionsRoot: root,
      projectionCacheRoot: join(root, 'projcache'),
    }

    const result = await cleanWorkers(fake, OWNER, () => false)
    expect(result.cleaned).toEqual([{ id: WORKER, freed: 2048, archivedNow: true }])
    expect(result.unarchiveFailures).toEqual([])
    expect(seen).toEqual([`archive:${WORKER}`, `unarchive:${WORKER}:record-gone`])
  })

  it('keeps the deletion and reports the failure when the marker cannot be lifted', async () => {
    const root = sessionRoot([WORKER])
    const failing: WorkerSessionDeps = {
      ...deps(root, [stored(WORKER)]),
      unarchive: () => Promise.reject(new Error('registry write refused')),
    }
    const result = await cleanWorkers(failing, OWNER, () => false)
    // The record is released either way; only the marker outlived it, and that is reported.
    expect(result.cleaned).toEqual([{ id: WORKER, freed: 2048, archivedNow: true }])
    expect(result.unarchiveFailures).toEqual([{ id: WORKER, reason: 'registry write refused' }])
    expect(sessionDirFor(root, WORKER)).toBeUndefined()
  })

  it('lifts the marker of an already-archived worker too', async () => {
    const root = sessionRoot([WORKER])
    const lifted: string[] = []
    const fake: WorkerSessionDeps = {
      ...deps(root, [stored(WORKER)]),
      unarchive: (id) => {
        lifted.push(id)
        return Promise.resolve()
      },
    }
    const result = await cleanWorkers(fake, OWNER, (id) => id === WORKER)
    expect(result.cleaned[0]?.archivedNow).toBe(false)
    expect(lifted).toEqual([WORKER])
  })

  it('still cleans when the host has no unarchive API, and reports no failure', async () => {
    const root = sessionRoot([WORKER])
    // `deps()` declares only `archive`, as a host that predates `unarchiveSession` does.
    const result = await cleanWorkers(deps(root, [stored(WORKER)]), OWNER, () => false)
    expect(result.cleaned.map((entry) => entry.id)).toEqual([WORKER])
    expect(result.unarchiveFailures).toEqual([])
    expect(sessionDirFor(root, WORKER)).toBeUndefined()
  })
})

describe('ghost archive reconciliation', () => {
  const GHOST = 'mission-deadbeef'
  const ON_DISK = 'mission-11112222'
  const IN_CORPUS = 'mission-33334444'
  const FOREIGN_SHAPE = 'not-a-mission'

  it('lifts only archived, mission-shaped ids absent from BOTH the corpus and the sessions root', async () => {
    const root = sessionRoot([ON_DISK])
    const released: string[] = []
    const fake: WorkerSessionDeps = {
      list: () => Promise.resolve([stored(IN_CORPUS)]),
      unarchive: (id) => {
        released.push(id)
        return Promise.resolve()
      },
      isLive: () => false,
      sessionsRoot: root,
      projectionCacheRoot: join(root, 'projcache'),
    }

    const result = await reconcileArchivedGhosts(fake, new Set([GHOST, ON_DISK, IN_CORPUS, FOREIGN_SHAPE]), {
      readable: true,
      known: new Set([IN_CORPUS]),
    })
    expect(result.supported).toBe(true)
    expect(result.readable).toBe(true)
    // A record still on disk and a record the corpus still knows both keep their marker: the
    // marker is only meaningless once BOTH sources agree the record is gone.
    expect(result.released).toEqual([GHOST])
    expect(released).toEqual([GHOST])
    expect(result.failed).toEqual([])
  })

  it('reconciles NOTHING when the corpus is unreadable: absence is unproven, not assumed', async () => {
    const released: string[] = []
    const fake: WorkerSessionDeps = {
      ...deps('/nope', []),
      unarchive: (id) => {
        released.push(id)
        return Promise.resolve()
      },
    }
    const result = await reconcileArchivedGhosts(fake, new Set([GHOST]), { readable: false, known: new Set() })
    expect(result.readable).toBe(false)
    expect(result.released).toEqual([])
    expect(released).toEqual([])
  })

  it('reports itself unsupported without an unarchive API and touches nothing', async () => {
    // Only `archive` is declared, as an older host's registry would be.
    const result = await reconcileArchivedGhosts(deps('/nope', []), new Set([GHOST]), {
      readable: true,
      known: new Set(),
    })
    expect(result.supported).toBe(false)
    expect(result.released).toEqual([])
    expect(result.failed).toEqual([])
  })

  it('reports a failed unarchive without throwing, and keeps going', async () => {
    const other = 'mission-feedface'
    const fake: WorkerSessionDeps = {
      ...deps('/nope', []),
      unarchive: (id) => Promise.reject(new Error(`refused ${id}`)),
    }
    const result = await reconcileArchivedGhosts(fake, new Set([GHOST, other]), { readable: true, known: new Set() })
    expect(result.released).toEqual([])
    expect(result.failed).toEqual([
      { id: GHOST, reason: `refused ${GHOST}` },
      { id: other, reason: `refused ${other}` },
    ])
  })

  it('is idempotent: a registry that dropped the id writes nothing on the second pass', async () => {
    const archived = new Set([GHOST])
    const calls: string[] = []
    const fake: WorkerSessionDeps = {
      ...deps('/nope', []),
      unarchive: (id) => {
        calls.push(id)
        archived.delete(id)
        return Promise.resolve()
      },
    }
    const first = await reconcileArchivedGhosts(fake, archived, { readable: true, known: new Set() })
    expect(first.released).toEqual([GHOST])
    // The real registry's getter now answers without it, so the next pass has nothing to consider.
    const second = await reconcileArchivedGhosts(fake, new Set(archived), { readable: true, known: new Set() })
    expect(second.released).toEqual([])
    expect(calls).toEqual([GHOST])
  })

  it('shares one predicate between the listing and the pass', () => {
    const root = sessionRoot([ON_DISK])
    // Same inputs, same answer: what `/clean archive` shows is exactly what the pass would clear.
    expect(ghostArchiveIds(new Set([GHOST, ON_DISK, IN_CORPUS, FOREIGN_SHAPE]), new Set([IN_CORPUS]), root))
      .toEqual([GHOST])
  })
})

describe('projection-cache residue (the "invisible worker" layer)', () => {
  const GONE = 'mission-aaaa1111'
  const PRESENT = 'mission-bbbb2222'

  it('removes the cache file only for a record proven gone', async () => {
    const root = sessionRoot([PRESENT])
    // The cache directory also holds a foreign, non-mission file name and one whose face is unknown.
    const cache = projectionCacheRoot([GONE, PRESENT], ['not-a-mission.json', 'session-cccc3333.json'])
    const fake: WorkerSessionDeps = { ...deps(root, [stored(PRESENT)]), projectionCacheRoot: cache }

    const purge = purgeOrphanProjectionCache(fake, { readable: true, known: new Set([PRESENT]) })
    expect(purge.purged).toEqual([GONE])
    expect(purge.failures).toEqual([])
    expect(existsSync(join(cache, `${GONE}.json`))).toBe(false)
    // Still known to the corpus → in use → untouched.
    expect(existsSync(join(cache, `${PRESENT}.json`))).toBe(true)
    // Non-mission names are never candidates, even though no record answers for them.
    expect(existsSync(join(cache, 'not-a-mission.json'))).toBe(true)
    expect(existsSync(join(cache, 'session-cccc3333.json'))).toBe(true)
  })

  it('keeps a cache file whose record is still on disk even when the corpus does not list it', () => {
    const root = sessionRoot([PRESENT])
    const cache = projectionCacheRoot([PRESENT])
    const fake: WorkerSessionDeps = { ...deps(root, []), projectionCacheRoot: cache }
    const purge = purgeOrphanProjectionCache(fake, { readable: true, known: new Set() })
    expect(purge.purged).toEqual([])
    expect(existsSync(join(cache, `${PRESENT}.json`))).toBe(true)
  })

  it('touches nothing when the corpus is unreadable, and shrugs at a missing directory', () => {
    const root = sessionRoot([])
    const cache = projectionCacheRoot([GONE])
    const unreadable: WorkerSessionDeps = { ...deps(root, []), projectionCacheRoot: cache }
    expect(purgeOrphanProjectionCache(unreadable, { readable: false, known: new Set() }).purged).toEqual([])
    expect(existsSync(join(cache, `${GONE}.json`))).toBe(true)

    const missing: WorkerSessionDeps = { ...deps(root, []), projectionCacheRoot: join(root, 'absent') }
    expect(() => purgeOrphanProjectionCache(missing, { readable: true, known: new Set() })).not.toThrow()
    expect(purgeOrphanProjectionCache(missing, { readable: true, known: new Set() }).purged).toEqual([])
  })

  it('uses the cache directory itself as the reconcile input when the archive set is empty', async () => {
    const root = sessionRoot([])
    const cache = projectionCacheRoot([GONE])
    const fake: WorkerSessionDeps = { ...deps(root, []), projectionCacheRoot: cache }
    // U2 makes `/clean` unarchive after releasing, so the archive set can be empty while residue
    // persists — the old "archived ids" input would clear nothing at all.
    const result = await reconcileArchivedGhosts(fake, new Set(), { readable: true, known: new Set() })
    expect(result.released).toEqual([])
    expect(result.purged).toEqual([GONE])
  })

  it('is idempotent: the second pass finds nothing and reports no failure', async () => {
    const root = sessionRoot([])
    const cache = projectionCacheRoot([GONE])
    const fake: WorkerSessionDeps = { ...deps(root, []), projectionCacheRoot: cache }
    const corpus = { readable: true, known: new Set<string>() }
    const first = await reconcileArchivedGhosts(fake, new Set(), corpus)
    expect(first.purged).toEqual([GONE])
    const second = await reconcileArchivedGhosts(fake, new Set(), corpus)
    expect(second.purged).toEqual([])
    expect(second.purgeFailures).toEqual([])
  })

  it('lists the same candidates it would purge', () => {
    const root = sessionRoot([PRESENT])
    const cache = projectionCacheRoot([GONE, PRESENT, 'other.json'])
    const fake: WorkerSessionDeps = { ...deps(root, []), projectionCacheRoot: cache }
    expect(orphanProjectionCacheIds(fake, { readable: true, known: new Set([PRESENT]) })).toEqual([GONE])
  })
})

describe('the projection cache is cleared with the record it belongs to', () => {
  it('removes the just-released worker\'s cache file in the same `/clean archive` pass', async () => {
    const root = sessionRoot([WORKER])
    const cache = projectionCacheRoot([WORKER])
    const fake: WorkerSessionDeps = { ...deps(root, [stored(WORKER)]), projectionCacheRoot: cache }
    const result = await cleanWorkers(fake, OWNER, () => false)
    expect(result.cleaned.map((entry) => entry.id)).toEqual([WORKER])
    expect(result.purged).toEqual([WORKER])
    expect(sessionDirFor(root, WORKER)).toBeUndefined()
    expect(existsSync(join(cache, `${WORKER}.json`))).toBe(false)
  })

  it('reports nothing purged when the session never checkpointed', async () => {
    const root = sessionRoot([WORKER])
    const cache = projectionCacheRoot([])
    const fake: WorkerSessionDeps = { ...deps(root, [stored(WORKER)]), projectionCacheRoot: cache }
    const result = await cleanWorkers(fake, OWNER, () => false)
    expect(result.purged).toEqual([])
    expect(result.purgeFailures).toEqual([])
  })
})
