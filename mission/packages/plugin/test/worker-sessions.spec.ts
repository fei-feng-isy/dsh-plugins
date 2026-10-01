/**
 * `/archive` and `/clean`: which sessions they may touch, and the guardrails that keep a
 * wrong sessions root from deleting somebody else's data.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveWorkers,
  bytes,
  isOurWorker,
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
    const result = await archiveWorkers({ list: () => Promise.resolve([]), isLive: () => false, sessionsRoot: '/nope' }, OWNER, () => false)
    expect(result.supported).toBe(false)
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
