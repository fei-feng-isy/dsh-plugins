/**
 * Automatic worker retention (U5): the count-based policy that keeps the newest N SETTLED worker
 * sessions per owner and releases the rest.
 *
 * This spec drives the two real triggers — the mount pass and the sweep pass — plus the read-only
 * listing. The pure ordering/boundary logic is covered in `worker-sessions.spec.ts`; here the point
 * is that the wired-up plugin runs it at the right moments, per owner, without ever touching a live
 * worker, and that `/clean archive all` keeps its manual full-clean semantics.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type Mounted } from './mount.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A deterministic worker id in the claim shape, from an index. */
const workerId = (index: number): string => `mission-${index.toString(16).padStart(8, '0')}`

/** The owner session `owner` for the mount harness; a second one is added where a case needs it. */
const OWNER = 'owner'
const OTHER = 'owner-b'

/** A session root with one project directory holding the given session ids, 2 KB each. */
function sessionRoot(ids: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'avwf-retain-'))
  roots.push(root)
  const project = join(root, '--tmp-project--')
  mkdirSync(project, { recursive: true })
  for (const id of ids) {
    const dir = join(project, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), 'x'.repeat(2048))
  }
  return root
}

const projectDir = (root: string, id: string): string => join(root, '--tmp-project--', id)

/** One stored session entry for the listing, as `sessionQuery.listSessions()` reports it. */
function listed(
  id: string,
  ownerId: string,
  index: number,
  live = false,
): { header: Record<string, unknown>; live: boolean } {
  return {
    header: {
      id,
      origin: 'subagent',
      delegationDepth: 1,
      parentSession: ownerId,
      createdAt: 1000 + index,
    },
    live,
  }
}

/** One worker record ready for `mounted.listedSessions.push`. */
function pushWorker(mounted: Mounted, id: string, ownerId: string, index: number, live = false): void {
  mounted.listedSessions.push(listed(id, ownerId, index, live))
}

describe('automatic retention at mount', () => {
  it('keeps the newest 10 per owner and releases each owner\'s own overflow', async () => {
    const mine = Array.from({ length: 13 }, (_, index) => workerId(index))
    const theirs = Array.from({ length: 12 }, (_, index) => workerId(100 + index))
    const root = sessionRoot([...mine, ...theirs])
    const mounted = await mount({
      workspaceRegistry: true,
      sessions: [OTHER],
      seedTrees: [OWNER, OTHER],
      pluginConfig: { sessionsRoot: root, keepWorkers: 10 },
      seedListedSessions: [
        ...mine.map((id, index) => listed(id, OWNER, index)),
        ...theirs.map((id, index) => listed(id, OTHER, index)),
      ],
    })

    // `owner` had 13 settled → 3 released; `owner-b` had 12 → 2 released. Each owner's own oldest go.
    // The mount pass is chained on `ready` (fire-and-forget, so `apply` never waits on storage) and
    // DEBOUNCED, so the wait has to outlast the coalescing window, not just the next tick.
    await vi.waitFor(() => {
      expect(mounted.registryCalls).toEqual([
        `archive:${mine[2]}`, `unarchive:${mine[2]}`,
        `archive:${mine[1]}`, `unarchive:${mine[1]}`,
        `archive:${mine[0]}`, `unarchive:${mine[0]}`,
        `archive:${theirs[1]}`, `unarchive:${theirs[1]}`,
        `archive:${theirs[0]}`, `unarchive:${theirs[0]}`,
      ])
    }, { timeout: 5_000 })
    for (const id of mine.slice(0, 3)) expect(existsSync(projectDir(root, id)), id).toBe(false)
    for (const id of mine.slice(3)) expect(existsSync(projectDir(root, id)), id).toBe(true)
    for (const id of theirs.slice(0, 2)) expect(existsSync(projectDir(root, id)), id).toBe(false)
    for (const id of theirs.slice(2)) expect(existsSync(projectDir(root, id)), id).toBe(true)
  })

  it('never touches a live worker, and does not let it occupy a retention slot', async () => {
    const mine = Array.from({ length: 13 }, (_, index) => workerId(index))
    const live = Array.from({ length: 4 }, (_, index) => workerId(100 + index))
    const root = sessionRoot([...mine, ...live])
    const mounted = await mount({
      workspaceRegistry: true,
      seedTrees: [OWNER],
      pluginConfig: { sessionsRoot: root, keepWorkers: 10 },
      seedListedSessions: [
        ...mine.map((id, index) => listed(id, OWNER, index)),
        // Live workers with the NEWEST timestamps: if they were counted they would push everyone out.
        ...live.map((id, index) => listed(id, OWNER, 500 + index, true)),
      ],
    })

    // Exactly the 3 oldest SETTLED workers go; the 4 running ones are untouched and unarchived.
    await vi.waitFor(() => {
      expect(mounted.registryCalls).toEqual([
        `archive:${mine[2]}`, `unarchive:${mine[2]}`,
        `archive:${mine[1]}`, `unarchive:${mine[1]}`,
        `archive:${mine[0]}`, `unarchive:${mine[0]}`,
      ])
    }, { timeout: 5_000 })
    for (const id of mine.slice(3)) expect(existsSync(projectDir(root, id)), id).toBe(true)
    for (const id of live) expect(existsSync(projectDir(root, id)), id).toBe(true)
  })

  it('releases nothing at all when keepWorkers is 0', async () => {
    const mine = Array.from({ length: 13 }, (_, index) => workerId(index))
    const root = sessionRoot(mine)
    const mounted = await mount({
      workspaceRegistry: true,
      seedTrees: [OWNER],
      pluginConfig: { sessionsRoot: root, keepWorkers: 0 },
      seedListedSessions: mine.map((id, index) => listed(id, OWNER, index)),
    })

    expect(mounted.registryCalls).toEqual([])
    for (const id of mine) expect(existsSync(projectDir(root, id)), id).toBe(true)
  })
})

describe('automatic retention on the sweep', () => {
  it('releases the overflow when new workers appear after mount, riding the existing cadence', async () => {
    const older = [workerId(0), workerId(1)]
    const newer = [workerId(2), workerId(3)]
    const root = sessionRoot([...older, ...newer])
    const mounted = await mount({
      workspaceRegistry: true,
      seedTrees: [OWNER],
      pluginConfig: { sessionsRoot: root, keepWorkers: 2 },
      // Exactly the budget at mount: the mount pass is a no-op, so the sweep is what does the work.
      seedListedSessions: older.map((id, index) => listed(id, OWNER, index)),
    })
    // The mount pass is chained on `ready`, fire-and-forget and debounced: wait until it has read
    // the listing before adding the newer records, or the race itself would decide what gets released.
    await vi.waitFor(() => expect(mounted.sessionListCalls()).toBeGreaterThan(0), { timeout: 5_000 })
    expect(mounted.registryCalls).toEqual([])

    pushWorker(mounted, newer[0]!, OWNER, 100)
    pushWorker(mounted, newer[1]!, OWNER, 101)
    // The gate the automatic pass rides is a SETTLEMENT, not the tick: a sweep with nothing new must
    // do no listing at all, so this models the real edge (`onSubagentEnd` is what raises the counter).
    mounted.host.onSubagentEnd(newer[0]!)
    await mounted.host.sweep()

    await vi.waitFor(() => {
      expect(mounted.registryCalls).toEqual([
        `archive:${older[1]}`, `unarchive:${older[1]}`,
        `archive:${older[0]}`, `unarchive:${older[0]}`,
      ])
    }, { timeout: 5_000 })
    for (const id of older) expect(existsSync(projectDir(root, id)), id).toBe(false)
    for (const id of newer) expect(existsSync(projectDir(root, id)), id).toBe(true)
  })
})

describe('the /clean listing shows where the number stops', () => {
  it('reports finished and running separately, and removes nothing', async () => {
    const settled = Array.from({ length: 12 }, (_, index) => workerId(index))
    const live = [workerId(100), workerId(101)]
    const root = sessionRoot([...settled, ...live])
    // No seeded tree: the task library has no owner sessions, so the mount-time pass is a no-op and
    // cannot race the listing this case is about.
    const mounted = await mount({
      workspaceRegistry: true,
      pluginConfig: { sessionsRoot: root, keepWorkers: 10 },
    })
    for (const [index, id] of settled.entries()) pushWorker(mounted, id, OWNER, index)
    for (const [index, id] of live.entries()) pushWorker(mounted, id, OWNER, 500 + index, true)

    const result = await mounted.runCommand('clean', '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已完成 worker：12 个（保留最新 10 → 可自动清理 2 个）')
    expect(result.text).toContain('正在执行：2 个（不计入保留名额、不会被清理）')
    // Read-only: the mount pass had an empty listing, and the listing itself releases nothing.
    expect(mounted.registryCalls).toEqual([])
    for (const id of settled) expect(existsSync(projectDir(root, id)), id).toBe(true)

    // The manual full clean still releases EVERY settled worker, retention notwithstanding.
    const all = await mounted.runCommand('clean', 'archive all')
    expect(all.kind).toBe('success')
    expect(all.text).toContain('已归档并清理 12 个')
    for (const id of settled) expect(existsSync(projectDir(root, id)), id).toBe(false)
    for (const id of live) expect(existsSync(projectDir(root, id)), id).toBe(true)
  })

  it('says the policy is off when keepWorkers is 0', async () => {
    const settled = [workerId(0), workerId(1)]
    const root = sessionRoot(settled)
    const mounted = await mount({
      workspaceRegistry: true,
      pluginConfig: { sessionsRoot: root, keepWorkers: 0 },
    })
    for (const [index, id] of settled.entries()) pushWorker(mounted, id, OWNER, index)

    const listing = await mounted.runCommand('clean', 'archive')
    expect(listing.text).toContain('保留策略已关闭（keepWorkers=0）')
    expect(listing.text).toContain('正在执行：0 个')
  })
})

describe('the retention pass stays off the hot path', () => {
  it('lists sessions ONCE per pass, however many owners there are', async () => {
    const mine = Array.from({ length: 12 }, (_, index) => workerId(index))
    const theirs = Array.from({ length: 12 }, (_, index) => workerId(100 + index))
    const root = sessionRoot([...mine, ...theirs])
    const mounted = await mount({
      workspaceRegistry: true,
      sessions: [OTHER],
      seedTrees: [OWNER, OTHER],
      pluginConfig: { sessionsRoot: root, keepWorkers: 10 },
      seedListedSessions: [
        ...mine.map((id, index) => listed(id, OWNER, index)),
        ...theirs.map((id, index) => listed(id, OTHER, index)),
      ],
    })
    // Wait for the mount pass to actually run (debounced), then check it read the corpus ONCE — the
    // old shape called `listSessions` once per owner on every sweep.
    await vi.waitFor(() => expect(mounted.registryCalls.length).toBeGreaterThan(0), { timeout: 5_000 })
    expect(mounted.sessionListCalls()).toBe(1)
  })

  it('does no listing at all on a sweep where no worker settled', async () => {
    const root = sessionRoot([workerId(0)])
    const mounted = await mount({
      workspaceRegistry: true,
      seedTrees: [OWNER],
      pluginConfig: { sessionsRoot: root, keepWorkers: 10 },
      seedListedSessions: [listed(workerId(0), OWNER, 0)],
    })
    await vi.waitFor(() => expect(mounted.sessionListCalls()).toBe(1), { timeout: 5_000 })

    // The 60 s tick fires with nothing new: the settlement counter has not moved, so the pass must
    // not touch the session corpus. (The mount counter is what guards against a restart's leftovers.)
    await mounted.host.sweep()
    await mounted.host.sweep()
    expect(mounted.sessionListCalls()).toBe(1)
    expect(mounted.registryCalls).toEqual([])
  })
})
