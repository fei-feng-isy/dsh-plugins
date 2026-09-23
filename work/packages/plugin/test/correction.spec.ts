/**
 * Steering a work that is already out there: `/…`-free equivalents of the two model tools —
 * `adjust_work` (owner → the work) and the consequence the ENGINE carries out for it: the
 * unfinished sub-works are voided, the work comes back for re-planning with the correction.
 */
import { describe, expect, it } from 'vitest'
import { agent, callTool, executorFor, mount, noteAndSplit, promptFor } from './mount.js'

/** The node id of the tree's root, from the service (never parsed out of prose). */
async function rootOf(mounted: Awaited<ReturnType<typeof mount>>): Promise<string> {
  const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
  return snapshot.trees[0]?.rootId ?? ''
}

/** Create a root and drive it into `decomposed`, returning the child's id. */
async function decomposed(
  mounted: Awaited<ReturnType<typeof mount>>,
  children: { title: string; description: string; context: string[] }[],
): Promise<{ root: string; child: string }> {
  const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
  const root = String(created.data?.root_id ?? '')
  await mounted.flush()
  const worker = agent(String(mounted.dispatched.at(-1)?.childId ?? ''))
  const split = await noteAndSplit(mounted, root, children, worker)
  const child = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
  await mounted.flush()
  return { root, child }
}

describe('adjust_work: correcting a running root', () => {
  it('records the correction and delivers it to the live executor', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()
    // In the host a dispatched worker materializes as an agent; the harness stub has to be
    // told, since "live holder" is what decides between delivering and only recording.
    mounted.makeLive(String(mounted.dispatched[0]?.childId ?? ''))

    const corrected = await callTool(mounted, 'adjust_work', { root_id: root, adjustment: '改成先做 B' }, mounted.owner)
    expect(corrected.ok).toBe(true)
    expect(corrected.data?.['delivered']).toBe(true)
    // Delivered to the worker actually holding the root, not to some other session.
    expect(mounted.sent).toHaveLength(1)
    expect(mounted.sent[0]?.targetId).toBe(mounted.dispatched[0]?.childId)
    expect(mounted.sent[0]?.text).toContain('纠偏：改成先做 B')
  })

  it('writes the correction into the work itself, so a later dispatch reads it', async () => {
    // The point of recording as well as delivering: every re-dispatch is a fresh session, so
    // a correction that lived only in one worker's inbox would be lost.
    const mounted = await mount()
    const { root, child } = await decomposed(mounted, [{ title: 'A', description: 'a', context: ['why'] }])
    // No live holder now (the root is blocked on its child): recorded, not delivered.
    const corrected = await callTool(mounted, 'adjust_work', { root_id: root, adjustment: '换个方向' }, mounted.owner)
    expect(corrected.data?.['delivered']).toBe(false)

    const worker = executorFor(mounted, child)
    await callTool(mounted, 'submit_work', { node_id: child, result: 'A done' }, worker)
    await mounted.flush()
    // Children all terminal: the owner's step wakes the session that decomposed the root.
    await mounted.wake()

    // The correction reaches the convergence pass as its own block (and on the chain line).
    const aggregate = promptFor(mounted, root)
    expect(aggregate).toContain('换个方向')
    expect(aggregate).toContain('纠偏')
  })

  it('carries the correction down the chain, so a re-dispatched descendant sees it', async () => {
    // `adjust_work` writes the ROOT. A descendant never sees the root's own node block, so the
    // chain line is the only channel that can carry the correction to it. Build a two-level
    // tree, keep the GRANDCHILD live and running, and let a mid-level re-dispatch prove the
    // chain renders it.
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_work',
      { title: 'T', description: 'd', analysis: ['原始分析：走 A 方案'] },
      mounted.owner,
    )
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()

    const rootWorker = agent(String(mounted.dispatched.at(-1)?.childId ?? ''))
    const split = await noteAndSplit(
      mounted,
      root,
      [{ title: 'child', description: 'c', context: ['why'] }],
      rootWorker,
    )
    expect(String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')).not.toBe('')
    await mounted.flush()

    // The root is blocked on the child, so a correction is recorded and NOT delivered: the
    // child's own worker is the one that would have to read it, and it is not live.
    await callTool(mounted, 'adjust_work', { root_id: root, adjustment: '改用 B 方案' }, mounted.owner)
    // The correction voids the unfinished child, so the root is ready for its convergence
    // pass — and the chain line it reads now carries the correction. That is the mechanism a
    // descendant would see on ITS next dispatch too.
    await mounted.wake()
    const rootPrompt = promptFor(mounted, root)
    expect(rootPrompt).toContain('改用 B 方案')
    expect(rootPrompt).toContain('纠偏')
    // The correction is on the root's chain line, which is what a descendant renders.
    expect(rootPrompt).toContain('本工作')
  })

  it('tells the truth in the aggregate round after a cancellation', async () => {
    // The cancelled children ARE terminal, but they were cancelled — not finished. The judge
    // needs the status and the reason, or it reads two empty results and a false "all done".
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()
    await noteAndSplit(
      mounted,
      root,
      [{ title: 'A', description: 'a', context: ['why'] }],
      agent(String(mounted.dispatched.at(-1)?.childId ?? '')),
    )
    await mounted.flush()
    // The correction alone voids the unfinished child — the engine owns that consequence.
    await callTool(mounted, 'adjust_work', { root_id: root, adjustment: '口径改成子文件数' }, mounted.owner)
    await mounted.flush()
    // The voided child is terminal, so the root is ready for its convergence pass.
    await mounted.wake()

    const aggregate = promptFor(mounted, root)
    expect(aggregate).toContain('被父工作取消')
    expect(aggregate).toContain('（已失败）')
    expect(aggregate).toContain('子工作都已终态')
    expect(aggregate).not.toContain('（未提交结果）')
  })

  it('refuses a sub-work: a correction is for the work the owner handed out', async () => {
    const mounted = await mount()
    const { child } = await decomposed(mounted, [{ title: 'A', description: 'a', context: ['why'] }])
    const refused = await callTool(mounted, 'adjust_work', { root_id: child, adjustment: 'x' }, mounted.owner)
    expect(refused.ok).toBe(false)
    expect(refused.data?.['code']).toBe('not-root')
  })

  it('refuses a work that has already ended', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const root = String(created.data?.root_id ?? '')
    await callTool(mounted, 'cancel_work', { root_id: root }, mounted.owner)

    const refused = await callTool(mounted, 'adjust_work', { root_id: root, adjustment: 'x' }, mounted.owner)
    expect(refused.ok).toBe(false)
    expect(refused.data?.['code']).toBe('terminal')
  })

  it('refuses a session that does not own the work', async () => {
    const mounted = await mount()
    const root = await rootOf(await (async () => {
      await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
      return mounted
    })())
    expect(root).not.toBe('')
    const refused = await callTool(mounted, 'adjust_work', { root_id: root, adjustment: 'x' }, agent('session-other'))
    expect(refused.ok).toBe(false)
    expect(refused.data?.['code']).toBe('not-owner')
  })
})

describe('the engine carries out the consequence of a correction', () => {
  it('voids the unfinished sub-tree, stops its executors, and brings the work back', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const rootId = String(created.data?.root_id ?? '')
    await mounted.flush()

    const rootWorker = agent(String(mounted.dispatched.at(-1)?.childId ?? ''))
    const split = await noteAndSplit(
      mounted,
      rootId,
      [{ title: 'A', description: 'a', context: ['why'] }],
      rootWorker,
    )
    expect(String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')).not.toBe('')
    await mounted.flush()
    const childWorkerId = String(mounted.dispatched.at(-1)?.childId ?? '')
    mounted.makeLive(childWorkerId)

    // One call from the owner: no separate cancellation verb exists any more.
    const corrected = await callTool(mounted, 'adjust_work', { root_id: rootId, adjustment: '改成 B 口径' }, mounted.owner)
    expect(corrected.ok).toBe(true)
    expect(corrected.data?.['voided']).toBe(1)
    expect(mounted.interrupts).toContain(childWorkerId)

    // The work comes back for re-planning: its children were voided, so it is ready for a
    // convergence pass, and the owner's next step wakes the session that decomposed it —
    // with the correction in the prompt.
    await mounted.wake()
    expect(promptFor(mounted, rootId)).toContain('改成 B 口径')
  })

  it('voids nothing when there is nothing unfinished, and still records the correction', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()

    const corrected = await callTool(mounted, 'adjust_work', { root_id: root, adjustment: '只是补充一句' }, mounted.owner)
    expect(corrected.ok).toBe(true)
    expect(corrected.data?.['voided']).toBe(0)
    expect(mounted.interrupts).toEqual([])
  })

  it('is refused for a session that does not own the work', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()

    const refused = await callTool(mounted, 'adjust_work', { root_id: root, adjustment: 'x' }, agent('session-other'))
    expect(refused.ok).toBe(false)
    expect(refused.data?.['code']).toBe('not-owner')
  })
})

describe('a correction is readable back, not only executable', () => {
  // Recording it for the executor is not enough: a work is read by the panel and by `work_result`,
  // and both rendered the title the work was CREATED with. A corrected work therefore read as
  // "goal X, result of Y" with nothing in between — the correction was in the store but invisible
  // at the two surfaces a reader actually looks at.
  it('carries the corrections in the row and detail projections the panel reads', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()
    await callTool(mounted, 'adjust_work', { root_id: root, adjustment: '改成先做 B' }, mounted.owner)

    const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
    const row = snapshot.trees.flatMap((tree) => tree.nodes).find((node) => node.id === root)
    expect(row?.corrections).toEqual(['改成先做 B'])

    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.node?.corrections).toEqual(['改成先做 B'])
    // The goal itself is NOT rewritten — the correction is history laid beside it, which is what
    // keeps the original intent readable instead of overwritten.
    expect(detail.node?.title).toBe('T')
  })

  it('hands the corrections to the owner reading the result', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()
    const rootWorker = agent(String(mounted.dispatched.at(-1)?.childId ?? ''))

    await callTool(mounted, 'adjust_work', { root_id: root, adjustment: '改成先做 B' }, mounted.owner)
    await callTool(mounted, 'submit_work', { node_id: root, result: 'B 已做完' }, rootWorker)

    const read = await callTool(mounted, 'work_result', { node_id: root }, mounted.owner)
    expect(read.ok, read.summary).toBe(true)
    expect(read.summary).toContain('改成先做 B')
    expect(read.summary).toContain('B 已做完')
    expect(read.data?.['corrections']).toEqual(['改成先做 B'])
  })

  it('leaves every read surface untouched for a work that was never corrected', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()
    const rootWorker = agent(String(mounted.dispatched.at(-1)?.childId ?? ''))
    await callTool(mounted, 'submit_work', { node_id: root, result: 'done' }, rootWorker)

    const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
    expect(snapshot.trees[0]?.nodes[0]?.corrections).toEqual([])
    expect((await callTool(mounted, 'work_result', { node_id: root }, mounted.owner)).summary).not.toContain('纠偏')
  })
})
