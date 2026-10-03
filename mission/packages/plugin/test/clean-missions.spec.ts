/**
 * `/clean missions` and the panel's batch entry: deleting the CLOSED task trees one session owns.
 *
 * The boundary this suite exists to pin is the one users confuse: a task TREE (this plugin's record,
 * what `finish_mission` closes) is a different thing from the worker SESSION records `/clean archive`
 * releases. The batch pass acts on the former only, for the caller's OWN session only, and only on
 * trees that were actually retired — a running tree is reported, never deleted.
 */
import { describe, expect, it } from 'vitest'
import { callTool, mount, type Mounted } from './mount.js'

/** Create one root tree as `owner` (default: the mount's primary owner). */
async function createTree(mounted: Mounted, title: string, owner = mounted.owner): Promise<string> {
  const created = await callTool(
    mounted,
    'create_mission',
    { title, description: 'd', analysis: ['because'] },
    owner,
  )
  return String(created.data?.['root_id'] ?? '')
}

/**
 * Close a tree out the way an owner does: `cancel_mission` takes every node terminal, `mission_result`
 * records the read the finish gate requires, and `finish_mission` archives it (`closedAt` set).
 */
async function closeTree(mounted: Mounted, rootId: string, owner = mounted.owner): Promise<void> {
  const cancelled = await callTool(mounted, 'cancel_mission', { root_id: rootId }, owner)
  expect(cancelled.ok, cancelled.summary).toBe(true)
  const read = await callTool(mounted, 'mission_result', { node_id: rootId }, owner)
  expect(read.ok, read.summary).toBe(true)
  const finished = await callTool(mounted, 'finish_mission', { root_id: rootId }, owner)
  expect(finished.ok, finished.summary).toBe(true)
}

/** Whether the tree record still exists (the panel's own liveness question). */
function treeAlive(mounted: Mounted, rootId: string): boolean {
  return mounted.host.nodeFor(rootId) !== undefined
}

describe('/clean missions', () => {
  it('lists the closed trees without deleting anything, and names the next command', async () => {
    const mounted = await mount()
    const closed = await createTree(mounted, 'closed')
    await mounted.flush()
    await closeTree(mounted, closed)

    const listed = await mounted.runCommand('clean', 'missions')
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain('可清理的已完成任务 1 棵')
    expect(listed.text).toContain(closed)
    expect(listed.text).toContain('/clean missions all')
    // Read-only: a listing is a report, never authorization.
    expect(treeAlive(mounted, closed)).toBe(true)
  })

  it('reports "nothing to clean" on an empty store, without failing', async () => {
    const mounted = await mount()
    const result = await mounted.runCommand('clean', 'missions all')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('没有可清理的')
  })

  it('refuses a named target, pointing single-tree removal at the panel', async () => {
    const mounted = await mount()
    const result = await mounted.runCommand('clean', 'missions 1234abcd')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('/clean missions all')
  })
})

describe('/clean missions all', () => {
  it('deletes this session\'s closed trees, keeps the un-retired one and says why (①)', async () => {
    const mounted = await mount()
    const closed = await createTree(mounted, 'closed one')
    await mounted.flush()
    const open = await createTree(mounted, 'still running')
    await mounted.flush()
    await closeTree(mounted, closed)

    const result = await mounted.runCommand('clean', 'missions all')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已清理 1 棵已完成任务')
    expect(result.text).toContain('跳过 1 棵仍在进行')
    expect(result.text).toContain(closed)
    expect(treeAlive(mounted, closed)).toBe(false)
    // The invariant: a tree the owner never retired is not a candidate, and the reply names it.
    expect(treeAlive(mounted, open)).toBe(true)
    expect(result.text).toContain(open)
    expect(mounted.stored(closed)).toBeUndefined()
  })

  it('never touches another session\'s closed tree (②)', async () => {
    const mounted = await mount({ sessions: ['session-other'] })
    const other = mounted.makeOwner('session-other')
    const foreign = await createTree(mounted, 'theirs', other)
    await mounted.flush()
    await closeTree(mounted, foreign, other)
    const mine = await createTree(mounted, 'mine')
    await mounted.flush()
    await closeTree(mounted, mine)

    const result = await mounted.runCommand('clean', 'missions all')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('已清理 1 棵已完成任务')
    expect(result.text).toContain(mine)
    expect(result.text).not.toContain(foreign)
    // Ownership is the line: the other session's closed tree is untouched, not even counted as skipped.
    expect(treeAlive(mounted, foreign)).toBe(true)
    expect(treeAlive(mounted, mine)).toBe(false)
  })

  it('says there is nothing to clean when only un-retired trees exist (③)', async () => {
    const mounted = await mount()
    const open = await createTree(mounted, 'running')
    await mounted.flush()

    const result = await mounted.runCommand('clean', 'missions all')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('没有可清理的')
    expect(result.text).toContain('跳过 1 棵仍在进行')
    expect(treeAlive(mounted, open)).toBe(true)
  })

  it('cleans a tree immediately after finish_mission closed it (⑤, end to end)', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'finish then clean')
    await mounted.flush()
    await closeTree(mounted, root)
    // finish_mission archived it and KEPT the record: closing and deleting are different gestures.
    expect(mounted.stored(root)?.tree.closedAt).not.toBeNull()

    const result = await mounted.runCommand('clean', 'missions all')
    expect(result.text).toContain('已清理 1 棵')
    expect(treeAlive(mounted, root)).toBe(false)
    expect(mounted.stored(root)).toBeUndefined()
  })

  it('leaves the archive and orphans scopes alone (不破坏现有语义)', async () => {
    // A closed tree and the worker records are separate layers: `/clean missions all` deletes the
    // tree record, and proves it by leaving the (empty here) worker-session machinery untouched.
    const mounted = await mount({ workspaceRegistry: true })
    const root = await createTree(mounted, 'closed')
    await mounted.flush()
    await closeTree(mounted, root)

    const result = await mounted.runCommand('clean', 'missions all')
    expect(result.text).not.toContain('已归档并清理')
    expect(result.text).not.toContain('孤儿')
    // The archive scope still answers for itself, and there is nothing for it to release.
    expect((await mounted.runCommand('clean', 'archive all')).text).toContain('没有可清理的 mission 会话')
  })
})

describe('the cleanFinished remote (④)', () => {
  it('returns the roots removed and the roots kept, by id', async () => {
    const mounted = await mount()
    const closedA = await createTree(mounted, 'a')
    await mounted.flush()
    const closedB = await createTree(mounted, 'b')
    await mounted.flush()
    const open = await createTree(mounted, 'open')
    await mounted.flush()
    await closeTree(mounted, closedA)
    await closeTree(mounted, closedB)

    const result = await mounted.host.cleanFinished({ sessionId: mounted.owner.id })
    expect([...result.deleted].sort()).toEqual([closedA, closedB].sort())
    expect(result.skipped).toEqual([open])

    // Idempotent: a second pass has nothing to delete and keeps reporting the open tree.
    const again = await mounted.host.cleanFinished({ sessionId: mounted.owner.id })
    expect(again.deleted).toEqual([])
    expect(again.skipped).toEqual([open])
    expect(treeAlive(mounted, open)).toBe(true)
  })

  it('does not even look at another session\'s trees', async () => {
    const mounted = await mount({ sessions: ['session-other'] })
    const other = mounted.makeOwner('session-other')
    const foreign = await createTree(mounted, 'theirs', other)
    await mounted.flush()
    await closeTree(mounted, foreign, other)

    const result = await mounted.host.cleanFinished({ sessionId: mounted.owner.id })
    expect(result.deleted).toEqual([])
    // Not another session's business: it is not "skipped", it is out of scope.
    expect(result.skipped).toEqual([])
    expect(treeAlive(mounted, foreign)).toBe(true)
  })

  it('answers an empty result for a missing session id instead of throwing', async () => {
    const mounted = await mount()
    await createTree(mounted, 'mine')
    await mounted.flush()
    expect(await mounted.host.cleanFinished({})).toEqual({ deleted: [], skipped: [] })
    expect(await mounted.host.cleanFinished({ sessionId: '' })).toEqual({ deleted: [], skipped: [] })
  })
})

/**
 * The misleading feedback this suite exists to stop repeating: `/clean archive` answers for the
 * SESSION-record layer, so an operator with only closed TASK TREES used to read "没有可清理的
 * mission 会话" as "the command is broken". The pointer names the scope that actually has something,
 * with the real count, and is absent when it would be a lie.
 */
describe('the cross-scope pointer for a wrong-object cleanup', () => {
  const WORKER = 'mission-aaaa1111'

  /** Register one settled worker record as `sessionQuery.listSessions()` reports it. */
  function listWorker(mounted: Mounted): void {
    mounted.listedSessions.push({
      header: { id: WORKER, origin: 'subagent', delegationDepth: 1, parentSession: mounted.owner.id },
      live: false,
    })
  }

  it('points /clean archive all at the closed trees, with the right count (①)', async () => {
    const mounted = await mount({ workspaceRegistry: true })
    const first = await createTree(mounted, 'closed one')
    await mounted.flush()
    const second = await createTree(mounted, 'closed two')
    await mounted.flush()
    await closeTree(mounted, first)
    await closeTree(mounted, second)

    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('没有可清理的 mission 会话')
    expect(result.text).toContain('另有 2 棵已关闭的任务树可清理：/clean missions all')
    // The pointer names the command; it does not run it, and it does not touch the trees.
    expect(treeAlive(mounted, first)).toBe(true)
    expect(treeAlive(mounted, second)).toBe(true)
  })

  it('adds no pointer at all when the session has no closed tree (②)', async () => {
    const mounted = await mount({ workspaceRegistry: true })
    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('没有可清理的 mission 会话')
    expect(result.text).not.toContain('另有')
  })

  it('counts only this session\'s closed trees', async () => {
    const mounted = await mount({ sessions: ['session-other'], workspaceRegistry: true })
    const other = mounted.makeOwner('session-other')
    const foreign = await createTree(mounted, 'theirs', other)
    await mounted.flush()
    await closeTree(mounted, foreign, other)

    const result = await mounted.runCommand('clean', 'archive all')
    expect(result.text).not.toContain('/clean missions all')
    expect(treeAlive(mounted, foreign)).toBe(true)
  })

  it('applies to the named form, which is where a bare tree root id lands (④)', async () => {
    const mounted = await mount({ workspaceRegistry: true })
    const root = await createTree(mounted, 'closed')
    await mounted.flush()
    await closeTree(mounted, root)

    // A tree root id is bare hex, so it can only ever be a wrong-object attempt at this scope.
    const result = await mounted.runCommand('clean', `archive ${root}`)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('不是本会话的 mission 会话')
    expect(result.text).toContain('另有 1 棵已关闭的任务树可清理：/clean missions all')
  })

  it('appends the same pointer to the bare /clean archive listing and to /archive', async () => {
    const mounted = await mount({ workspaceRegistry: true })
    const root = await createTree(mounted, 'closed')
    await mounted.flush()
    await closeTree(mounted, root)

    const listed = await mounted.runCommand('clean', 'archive')
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain('本会话没有 mission 会话记录。')
    expect(listed.text).toContain('另有 1 棵已关闭的任务树可清理：/clean missions all')

    const archived = await mounted.runCommand('archive', '')
    expect(archived.kind).toBe('success')
    expect(archived.text).toContain('没有需要归档的 mission 会话')
    expect(archived.text).toContain('另有 1 棵已关闭的任务树可清理：/clean missions all')
  })

  it('lists both scopes and names each command when both have content (③)', async () => {
    const mounted = await mount({ workspaceRegistry: true })
    listWorker(mounted)
    const root = await createTree(mounted, 'closed')
    await mounted.flush()
    await closeTree(mounted, root)

    const result = await mounted.runCommand('clean', '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('archive 作用域')
    expect(result.text).toContain(WORKER)
    expect(result.text).toContain('本会话任务树（missions 作用域）')
    expect(result.text).toContain('/clean archive all')
    expect(result.text).toContain('/clean missions all')
    // Neither scope is empty, so no "what you were looking for is empty" notice is owed.
    expect(result.text).not.toContain('本会话没有可清理的 worker 会话记录（archive 作用域）')
  })

  it('points the archive-empty overview at the closed trees', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'closed')
    await mounted.flush()
    await closeTree(mounted, root)

    const result = await mounted.runCommand('clean', '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('本会话没有可清理的 worker 会话记录（archive 作用域）')
    expect(result.text).toContain('1 棵已关闭的任务树用 /clean missions all')
  })
})
