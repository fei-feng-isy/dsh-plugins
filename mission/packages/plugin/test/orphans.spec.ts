/**
 * `/clean`'s two scopes, through the real registered commands.
 *
 * The archive scope keeps every guardrail it had (ours only, settled only, `all` archived only, a
 * named id looked up inside this session). The orphans scope is what this rework adds: a listing
 * grouped by the probe's reason, a re-probe before every delete, and the one aggregate start-up
 * report that replaced the per-tree WARN the user saw on every launch.
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

  it('removes only archived, non-live records with all', async () => {
    const root = sessionRoot([ARCHIVED, UNSETTLED, RUNNING])
    const mounted = await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root } })
    mounted.archivedSessions.add(ARCHIVED)
    listWorker(mounted, ARCHIVED)
    listWorker(mounted, UNSETTLED)
    listWorker(mounted, RUNNING, true)

    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.kind).toBe('success')
    expect(result.text).toContain(ARCHIVED)
    expect(result.text).not.toContain(UNSETTLED)
    expect(result.text).not.toContain(RUNNING)
    expect(existsSync(projectDir(root, ARCHIVED))).toBe(false)
    expect(existsSync(projectDir(root, UNSETTLED))).toBe(true)
    expect(existsSync(projectDir(root, RUNNING))).toBe(true)
  })

  it('never reaches another session\'s records through a named id', async () => {
    const foreign = 'mission-9999aaaa'
    const root = sessionRoot([foreign])
    const mounted = await mount({ workspaceRegistry: true, pluginConfig: { sessionsRoot: root } })
    listWorker(mounted, foreign, false, 'session-other')

    const result = await mounted.runCommand('clean', `archive ${foreign}`)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('不是本会话')
    expect(existsSync(projectDir(root, foreign))).toBe(true)
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
