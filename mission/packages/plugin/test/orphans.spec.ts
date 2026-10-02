/**
 * `/clean`'s two scopes, through the real registered commands.
 *
 * The archive scope keeps every guardrail it had (ours only, settled only, a named id looked up
 * inside this session) and now finishes in ONE pass: a settled worker is archived first and removed
 * only once that succeeded, so `/archive` is no longer a prerequisite. The orphans scope is what
 * this rework adds: a listing grouped by the probe's reason, a re-probe before every delete, and the
 * one aggregate start-up report that replaced the per-tree WARN the user saw on every launch.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type Mounted } from './mount.js'

const OWNER = 'owner'
const ARCHIVED = 'mission-aaaa1111'
const UNSETTLED = 'mission-bbbb2222'
const RUNNING = 'mission-cccc3333'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A session root with one project directory holding the given session ids, 2 KB each. */
function sessionRoot(ids: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'avwf-clean-'))
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

/** One stored session, as the query engine would report it. */
function listWorker(mounted: Mounted, id: string, live = false, parent = OWNER): void {
  mounted.listedSessions.push({
    header: { id, origin: 'subagent', delegationDepth: 1, parentSession: parent },
    live,
  })
}

/** The tree's root node, or `undefined` once the tree is gone. */
function treeAlive(mounted: Mounted, rootId: string): boolean {
  return mounted.host.nodeFor(rootId) !== undefined
}

const projectDir = (root: string, id: string): string => join(root, '--tmp-project--', id)

/** A projection-cache root holding one record file per mission id, plus any extra file names. */
function projectionCache(ids: readonly string[], extra: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'avwf-projcache-'))
  roots.push(root)
  for (const id of ids) writeFileSync(join(root, `${id}.json`), '{"version":7}')
  for (const name of extra) writeFileSync(join(root, name), '{}')
  return root
}

describe('/clean with no argument', () => {
  it('lists both scopes and removes nothing', async () => {
    const root = sessionRoot([ARCHIVED])
    const mounted = await mount({
      workspaceRegistry: true,
      pluginConfig: { sessionsRoot: root },
      seedTrees: ['opaque'],
      unobservableSessions: ['opaque'],
    })
    mounted.archivedSessions.add(ARCHIVED)
    listWorker(mounted, ARCHIVED)

    const result = await mounted.runCommand('clean', '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('archive 作用域')
    expect(result.text).toContain(ARCHIVED)
    expect(result.text).toContain('孤儿任务树')
    expect(result.text).toContain('不可观测')
    // Read-only: neither the log directory nor the orphan tree was touched.
    expect(existsSync(projectDir(root, ARCHIVED))).toBe(true)
    expect(treeAlive(mounted, mounted.seededRoots[0]!)).toBe(true)
  })

  it('omits the orphans section when there is no orphan', async () => {
    const root = sessionRoot([])
    const mounted = await mount({ pluginConfig: { sessionsRoot: root }, seedTrees: ['owner'] })
    listWorker(mounted, ARCHIVED)

    const result = await mounted.runCommand('clean', '')
    expect(result.text).toContain('archive 作用域')
    expect(result.text).not.toContain('孤儿任务树')
  })
})

describe('/clean archive', () => {
  it('lists the scope without deleting anything', async () => {
    const root = sessionRoot([ARCHIVED])
    const mounted = await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root } })
    mounted.archivedSessions.add(ARCHIVED)
    listWorker(mounted, ARCHIVED)

    const result = await mounted.runCommand('clean', 'archive')
    expect(result.kind).toBe('success')
    expect(result.text).toContain(ARCHIVED)
    expect(existsSync(projectDir(root, ARCHIVED))).toBe(true)
  })

  it('archives a settled worker, removes it, and lifts the marker in the same pass — no /archive first', async () => {
    const root = sessionRoot([UNSETTLED])
    const mounted = await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root } })
    listWorker(mounted, UNSETTLED)

    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已归档并清理 1 个')
    expect(result.text).toContain('本次归档')
    expect(result.text).toContain(UNSETTLED)
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(false)
    // Step 3: the marker that authorized the release is gone too. Left behind it would be a ghost
    // id — durable in the registry, absent on disk, and still listed among the subagents.
    expect(mounted.archivedSessions.has(UNSETTLED)).toBe(false)
    expect(mounted.registryCalls).toEqual([`archive:${UNSETTLED}`, `unarchive:${UNSETTLED}`])
  })

  it('keeps the already-archived path, and never touches a live or another session\'s worker', async () => {
    const foreign = 'mission-8888bbbb'
    const root = sessionRoot([ARCHIVED, UNSETTLED, RUNNING, foreign])
    const mounted = await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root } })
    mounted.archivedSessions.add(ARCHIVED)
    listWorker(mounted, ARCHIVED)
    listWorker(mounted, UNSETTLED)
    listWorker(mounted, RUNNING, true)
    listWorker(mounted, foreign, false, 'session-other')

    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已归档并清理 2 个')
    expect(result.text).toContain('原本已归档')
    expect(result.text).toContain('本次归档')
    expect(result.text).toContain('因仍在运行跳过 1 个')
    expect(result.text).toContain('不属于本会话跳过 1 个')
    // Ours and settled: released, and their markers lifted (the pre-existing one included).
    expect(existsSync(projectDir(root, ARCHIVED))).toBe(false)
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(false)
    expect(mounted.archivedSessions.has(ARCHIVED)).toBe(false)
    expect(mounted.archivedSessions.has(UNSETTLED)).toBe(false)
    expect(mounted.registryCalls).toEqual([
      `unarchive:${ARCHIVED}`, `archive:${UNSETTLED}`, `unarchive:${UNSETTLED}`,
    ])
    // Live: kept, and NOT archived. Another session's: kept, NOT archived, and its marker — had it
    // one — would be corpus-protected rather than reconciled.
    expect(existsSync(projectDir(root, RUNNING))).toBe(true)
    expect(existsSync(projectDir(root, foreign))).toBe(true)
    expect(mounted.archivedSessions.has(RUNNING)).toBe(false)
    expect(mounted.archivedSessions.has(foreign)).toBe(false)
  })

  it('refuses to touch a live worker, even when it is named explicitly', async () => {
    const root = sessionRoot([RUNNING])
    const mounted = await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root } })
    listWorker(mounted, RUNNING, true)

    const all = await mounted.runCommand('clean', 'archive all')
    expect(all.kind).toBe('success')
    expect(all.text).toContain('因仍在运行跳过 1 个')

    const named = await mounted.runCommand('clean', `archive ${RUNNING}`)
    expect(named.kind).toBe('error')
    expect(named.text).toContain('还在运行')
    expect(mounted.archivedSessions.has(RUNNING)).toBe(false)
    expect(existsSync(projectDir(root, RUNNING))).toBe(true)
  })

  it('archives a named settled worker before deleting it, and lifts its marker', async () => {
    const root = sessionRoot([UNSETTLED])
    const mounted = await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root } })
    listWorker(mounted, UNSETTLED)

    const result = await mounted.runCommand('clean', `archive ${UNSETTLED}`)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('本次归档')
    expect(mounted.archivedSessions.has(UNSETTLED)).toBe(false)
    expect(mounted.registryCalls).toEqual([`archive:${UNSETTLED}`, `unarchive:${UNSETTLED}`])
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(false)
  })

  it('never reaches another session\'s records through a named id', async () => {
    const foreign = 'mission-9999aaaa'
    const root = sessionRoot([foreign])
    const mounted = await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root } })
    listWorker(mounted, foreign, false, 'session-other')

    const result = await mounted.runCommand('clean', `archive ${foreign}`)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('不是本会话')
    expect(mounted.archivedSessions.has(foreign)).toBe(false)
    expect(existsSync(projectDir(root, foreign))).toBe(true)
  })
})

describe('the /clean archive unarchive step', () => {
  it('keeps the deletion and reports a failed unarchive instead of throwing', async () => {
    const root = sessionRoot([UNSETTLED])
    const mounted = await mount({
      workspaceRegistry: true,
      unarchiveThrows: true,
      pluginConfig: { sessionsRoot: root },
    })
    listWorker(mounted, UNSETTLED)

    const result = await mounted.runCommand('clean', 'archive all')
    // The command still succeeds: the record is gone, and undoing that is not an option.
    expect(result.kind).toBe('success')
    expect(result.text).toContain('取消归档失败 1 个')
    expect(result.text).toContain(UNSETTLED)
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(false)
    // The marker is still there — reported, and left for a later mount to reconcile.
    expect(mounted.archivedSessions.has(UNSETTLED)).toBe(true)
  })

  it('reports a failed unarchive on the named form too, without undoing the deletion', async () => {
    const root = sessionRoot([UNSETTLED])
    const mounted = await mount({
      workspaceRegistry: true,
      unarchiveThrows: true,
      pluginConfig: { sessionsRoot: root },
    })
    listWorker(mounted, UNSETTLED)

    const result = await mounted.runCommand('clean', `archive ${UNSETTLED}`)
    // Same discipline as `all`: the one id named is released, and step 3's failure is reported
    // rather than swallowed or rolled back.
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已归档并清理')
    expect(result.text).toContain('取消归档失败')
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(false)
    expect(mounted.archivedSessions.has(UNSETTLED)).toBe(true)
    expect(mounted.registryCalls).toEqual([`archive:${UNSETTLED}`, `unarchive:${UNSETTLED}`])
  })
})

describe('/clean archive ghost reconciliation', () => {
  const GHOST = 'mission-deadbeef'
  const STILL_LISTED = 'mission-aaaaaaaa'

  it('lifts a historical ghost and reports it, while leaving a still-listed record alone', async () => {
    const root = sessionRoot([])
    const mounted = await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root } })
    // A marker an earlier cleanup left behind, plus a foreign worker whose record is still known.
    mounted.archivedSessions.add(GHOST)
    mounted.archivedSessions.add(STILL_LISTED)
    listWorker(mounted, STILL_LISTED, false, 'session-other')

    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('对账清理了 1 个幽灵 id')
    expect(result.text).toContain(GHOST)
    expect(mounted.archivedSessions.has(GHOST)).toBe(false)
    // The corpus still knows this one, so its archive marker still means something.
    expect(mounted.archivedSessions.has(STILL_LISTED)).toBe(true)
    expect(mounted.registryCalls).toEqual([`unarchive:${GHOST}`])
  })

  it('shows ghosts apart from "已完成未归档" in the read-only listing', async () => {
    const root = sessionRoot([UNSETTLED])
    const mounted = await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root } })
    mounted.archivedSessions.add(GHOST)
    listWorker(mounted, UNSETTLED)

    const result = await mounted.runCommand('clean', 'archive')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已完成未归档，清理时先归档')
    expect(result.text).toContain('已归档但记录已不在（幽灵）1 个')
    expect(result.text).toContain(GHOST)
    // Still read-only: a listing neither lifts a marker nor deletes a record.
    expect(mounted.archivedSessions.has(GHOST)).toBe(true)
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(true)
  })

  it('reconciles nothing when sessionQuery is absent, because absence is unproven', async () => {
    const mounted = await mount({ workspaceRegistry: true, noSessionQuery: true, archivedSessions: [GHOST] })
    expect(mounted.archivedSessions.has(GHOST)).toBe(true)
    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.kind).toBe('success')
    expect(result.text).not.toContain('对账清理了')
    expect(mounted.archivedSessions.has(GHOST)).toBe(true)
  })
})

describe('the mount-time ghost archive reconciliation', () => {
  const GHOST = 'mission-deadbeef'
  const ON_DISK = 'mission-11112222'
  const OTHER_SHAPE = 'session-abcdef'

  it('lifts only the mission-shaped marker with no record anywhere', async () => {
    const root = sessionRoot([ON_DISK])
    const mounted = await mount({
      workspaceRegistry: true,
      archivedSessions: [GHOST, ON_DISK, OTHER_SHAPE],
      pluginConfig: { sessionsRoot: root },
    })
    expect(mounted.archivedSessions.has(GHOST)).toBe(false)
    // A directory on disk IS a record: its marker still means something.
    expect(mounted.archivedSessions.has(ON_DISK)).toBe(true)
    // Not this plugin's shape: another subsystem's archive entry, never touched.
    expect(mounted.archivedSessions.has(OTHER_SHAPE)).toBe(true)
    expect(mounted.registryCalls).toEqual([`unarchive:${GHOST}`])
  })
})

describe('/clean archive without a workspace registry', () => {
  it('says it cannot archive, therefore cannot clean, and deletes nothing', async () => {
    const root = sessionRoot([UNSETTLED])
    const mounted = await mount({ pluginConfig: { sessionsRoot: root } })
    listWorker(mounted, UNSETTLED)

    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('无法归档')
    expect(result.text).toContain('无法清理')
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(true)
  })

  it('says the same for a named id', async () => {
    const root = sessionRoot([UNSETTLED])
    const mounted = await mount({ pluginConfig: { sessionsRoot: root } })
    listWorker(mounted, UNSETTLED)

    const result = await mounted.runCommand('clean', `archive ${UNSETTLED}`)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('无法归档')
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(true)
  })

  it('still lists the scope read-only, naming the reason it cannot clean', async () => {
    const root = sessionRoot([UNSETTLED])
    const mounted = await mount({ pluginConfig: { sessionsRoot: root } })
    listWorker(mounted, UNSETTLED)

    const result = await mounted.runCommand('clean', 'archive')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('未归档，清理时先归档')
    expect(result.text).toContain('无法归档')
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(true)
  })
})

describe('/clean orphans', () => {
  it('lists both reasons, grouped, without deleting', async () => {
    const mounted = await mount({
      seedTrees: ['opaque', 'flip'],
      unobservableSessions: ['opaque'],
      sessions: ['flip'],
    })
    // The session exists when the plugin opens (so its tree survives start-up), then vanishes: the
    // durable "missing" verdict only the next probe can see.
    mounted.sessions.delete('flip')

    const result = await mounted.runCommand('clean', 'orphans')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('不存在')
    expect(result.text).toContain('不可观测：stubbed: session store cannot read "opaque"')
    expect(result.text).toContain(mounted.seededRoots[0]!)
    expect(result.text).toContain(mounted.seededRoots[1]!)
    expect(treeAlive(mounted, mounted.seededRoots[0]!)).toBe(true)
    expect(treeAlive(mounted, mounted.seededRoots[1]!)).toBe(true)
  })

  it('removes every listed orphan with all and leaves every other tree alone', async () => {
    const mounted = await mount({
      seedTrees: ['opaque', 'flip', 'owner'],
      unobservableSessions: ['opaque'],
      sessions: ['flip'],
    })
    mounted.sessions.delete('flip')

    const result = await mounted.runCommand('clean', 'orphans all')
    expect(result.kind).toBe('success')
    expect(treeAlive(mounted, mounted.seededRoots[0]!)).toBe(false)
    expect(treeAlive(mounted, mounted.seededRoots[1]!)).toBe(false)
    // The live owner's tree is the line this whole scope must never cross.
    expect(treeAlive(mounted, mounted.seededRoots[2]!)).toBe(true)
  })

  it('re-probes before a named delete: a session that came back keeps its tree', async () => {
    const mounted = await mount({ seedTrees: ['flip'], sessions: ['flip'] })
    mounted.sessions.delete('flip')
    const listed = await mounted.runCommand('clean', 'orphans')
    expect(listed.text).toContain('不存在')

    mounted.sessions.add('flip')
    const result = await mounted.runCommand('clean', `orphans ${mounted.seededRoots[0]!}`)
    expect(result.text).toContain('已可观测')
    expect(treeAlive(mounted, mounted.seededRoots[0]!)).toBe(true)
  })

  it('interrupts a live worker before destroying its orphaned tree', async () => {
    const mounted = await mount({ sessions: ['session-orphan'] })
    const other = mounted.makeOwner('session-orphan')
    await mounted.runCommand('mission', 'orphan mission\ncarries a running executor', other)
    const rootId = (await mounted.host.snapshot({ sessionId: 'session-orphan' })).trees[0]?.rootId
    expect(rootId).toBeDefined()
    const child = mounted.dispatched.at(-1)?.childId
    expect(child).toBeDefined()
    // The executor is materialized, the owner is not: an unobservable tree with a running worker.
    mounted.makeLive(child!)
    mounted.dropLive('session-orphan')
    mounted.unobservableSessions.add('session-orphan')

    const result = await mounted.runCommand('clean', 'orphans all')
    expect(result.kind).toBe('success')
    expect(mounted.interrupts).toContain(child)
    expect(treeAlive(mounted, rootId!)).toBe(false)
  })
})

describe('the pre-scope forms are errors', () => {
  it('rejects /clean all and names both scoped replacements', async () => {
    const mounted = await mount()
    const result = await mounted.runCommand('clean', 'all')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('/clean archive all')
    expect(result.text).toContain('/clean orphans all')
  })

  it('rejects /clean <mission-id> and names both scoped replacements', async () => {
    const mounted = await mount()
    const result = await mounted.runCommand('clean', 'mission-1234abcd')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('/clean archive mission-1234abcd')
    expect(result.text).toContain('/clean orphans')
  })
})

describe('the aggregate start-up report', () => {
  const lines: string[] = []

  beforeEach(() => {
    lines.length = 0
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is ONE line for the whole orphan set, and destroys only the missing owners', async () => {
    const mounted = await mount({
      seedTrees: ['opaque-a', 'opaque-b', 'gone', 'owner'],
      unobservableSessions: ['opaque-a', 'opaque-b'],
    })
    const orphanLines = lines.filter((line) => line.includes('orphans:'))
    expect(orphanLines).toHaveLength(1)
    expect(orphanLines[0]).toContain('3 tree(s)')
    expect(orphanLines[0]).toContain('unobservable: 2, missing: 1')
    // The per-tree WARN this replaces is gone — that was the noise, not the condition.
    expect(lines.some((line) => line.includes('cannot resolve session'))).toBe(false)
    // Missing ⇒ reconciled away; unobservable and live ⇒ kept.
    expect(treeAlive(mounted, mounted.seededRoots[2]!)).toBe(false)
    expect(treeAlive(mounted, mounted.seededRoots[0]!)).toBe(true)
    expect(treeAlive(mounted, mounted.seededRoots[1]!)).toBe(true)
    expect(treeAlive(mounted, mounted.seededRoots[3]!)).toBe(true)
  })
})

describe('the /clean orphans audit line', () => {
  const lines: string[] = []

  beforeEach(() => {
    lines.length = 0
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names the SKIPPED trees after `skipped`, not the removed ones', async () => {
    // The comment above the call calls this "the only record of a destructive act that leaves no
    // session log behind", so its content must not lie. It used to print `removed`'s ids after
    // `skipped N:`; here nothing is removed and one target is skipped because its tree is already
    // gone, so the old code printed an empty list after the count.
    const mounted = await mount()
    const absent = 'deadbeef'
    const result = await mounted.runCommand('clean', `orphans ${absent}`)
    expect(result.kind).toBe('error')
    const audit = lines.filter((line) => line.includes('/clean orphans from'))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toContain('removed 0 tree(s)')
    expect(audit[0]).toContain(`skipped 1: ${absent}（任务树已不存在）`)
  })
})

describe('projection-cache residue (the "invisible worker" layer)', () => {
  const GONE = 'mission-deadbeef'

  it('removes a released worker\'s residue in the same /clean archive all pass, and reports both counts', async () => {
    const root = sessionRoot([UNSETTLED])
    const cache = projectionCache([UNSETTLED])
    const mounted = await mount({
      workspaceRegistry: true,
      pluginConfig: { sessionsRoot: root, projectionCacheRoot: cache },
    })
    listWorker(mounted, UNSETTLED)

    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.kind).toBe('success')
    // The two layers are reported as two numbers: the record released, and the residue cleared.
    expect(result.text).toContain('已归档并清理 1 个')
    expect(result.text).toContain('清理残留投影缓存 1 个')
    expect(result.text).toContain(UNSETTLED)
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(false)
    expect(existsSync(join(cache, `${UNSETTLED}.json`))).toBe(false)
  })

  it('purges residue whose record is gone at mount, while a record on disk and foreign names survive', async () => {
    const root = sessionRoot([UNSETTLED])
    const cache = projectionCache([GONE, UNSETTLED], ['not-a-mission.json', 'session-ffff0000.json'])
    // The mount-time reconcile runs before any listing exists; the proof is the sessions root alone.
    await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root, projectionCacheRoot: cache } })

    expect(existsSync(join(cache, `${GONE}.json`))).toBe(false)
    // A record with a session directory still exists → its cache is in use → untouched.
    expect(existsSync(join(cache, `${UNSETTLED}.json`))).toBe(true)
    // Never a mission-shaped name → never a candidate.
    expect(existsSync(join(cache, 'not-a-mission.json'))).toBe(true)
    expect(existsSync(join(cache, 'session-ffff0000.json'))).toBe(true)
  })

  it('keeps the residue of an id the corpus still lists, during the command pass', async () => {
    const root = sessionRoot([])
    const cache = projectionCache([])
    const mounted = await mount({
      workspaceRegistry: true,
      pluginConfig: { sessionsRoot: root, projectionCacheRoot: cache },
    })
    // Written AFTER mount, so only the command-time reconcile sees it: the corpus still lists the
    // id (a worker in use), so its cache must be left alone even though no directory exists.
    writeFileSync(join(cache, `${RUNNING}.json`), '{"version":7}')
    listWorker(mounted, RUNNING, true)

    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.text).not.toContain('清理残留投影缓存')
    expect(existsSync(join(cache, `${RUNNING}.json`))).toBe(true)
  })

  it('removes nothing at mount when sessionQuery is absent: absence is unproven', async () => {
    const root = sessionRoot([])
    const cache = projectionCache([GONE])
    await mount({
      workspaceRegistry: true,
      noSessionQuery: true,
      pluginConfig: { sessionsRoot: root, projectionCacheRoot: cache },
    })
    expect(existsSync(join(cache, `${GONE}.json`))).toBe(true)
  })

  it('is idempotent: a second pass reports no residue left to clear', async () => {
    const root = sessionRoot([UNSETTLED])
    const cache = projectionCache([UNSETTLED])
    const mounted = await mount({
      workspaceRegistry: true,
      pluginConfig: { sessionsRoot: root, projectionCacheRoot: cache },
    })
    listWorker(mounted, UNSETTLED)

    const first = await mounted.runCommand('clean', 'archive all')
    expect(first.text).toContain('清理残留投影缓存 1 个')
    const second = await mounted.runCommand('clean', 'archive all')
    expect(second.text).not.toContain('清理残留投影缓存')
  })
})
