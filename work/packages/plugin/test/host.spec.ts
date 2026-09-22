/**
 * Host behaviour through the tool surface: ownership, the finish gate, the
 * worker tool face, spill rendering and turn conclusion.
 */
import { describe, expect, it } from 'vitest'
import { agent, callTool, executorFor, mount, noteAndSplit } from './mount.js'
import { clientContribution } from '../src/wire.js'
import { WORKER_TOOL_DENY } from '../src/faces.js'

/** A work unit: the child session the engine reserved for one node. */
function worker(mounted: Awaited<ReturnType<typeof mount>>): ReturnType<typeof agent> {
  const claimId = String(mounted.dispatched.at(-1)?.childId ?? '')
  return agent(claimId)
}

async function createTree(mounted: Awaited<ReturnType<typeof mount>>, title = 'T'): Promise<string> {
  const created = await callTool(mounted, 'create_work', { title, description: 'd', analysis: ['because'] }, mounted.owner)
  return String(created.data?.root_id ?? '')
}

describe('create_work authority', () => {
  it('refuses a work unit rooting its own tree', async () => {
    const mounted = await mount()
    const subagent = agent('child-1', { origin: 'subagent', delegationDepth: 1 })
    const result = await callTool(
      mounted,
      'create_work',
      { title: 'sneaky', description: 'd', analysis: [] },
      subagent,
    )
    expect(result.ok).toBe(false)
    expect(result.data?.['code']).toBe('no-authority')
  })

  it('refuses a nested session that only records a delegation depth', async () => {
    const mounted = await mount()
    const nested = agent('child-2', { delegationDepth: 2 })
    expect((await callTool(mounted, 'create_work', { title: 'x', description: 'd', analysis: [] }, nested)).ok).toBe(false)
  })

  it('admits a top-level session', async () => {
    const mounted = await mount()
    expect(await createTree(mounted)).not.toBe('')
  })
})

describe('worker tool face', () => {
  it('denies exactly the tools this deployment offers', async () => {
    // A name no tool provides makes `tools.restrict()` throw, which would fail
    // every dispatch and burn the whole tree's attempts. So the request carries the
    // deployment's names PLUS this plugin's own (the owner face, always registered).
    const mounted = await mount({ tools: ['send_message', 'subagent'] })
    await createTree(mounted)
    expect(mounted.dispatched[0]?.toolFilter?.deny).toEqual([
      'send_message',
      'subagent',
      'create_work',
      'adjust_work',
      'work_result',
      'list_works',
      'finish_work',
      'cancel_work',
    ])
  })

  it('still denies the owner face in a deployment with no harness delegation tools', async () => {
    // The face does not depend on what the harness offers: the owner's six tools are
    // this plugin's own registrations, so they are exactly what is left to deny.
    const mounted = await mount({ tools: [] })
    await createTree(mounted)
    expect(mounted.dispatched[0]?.toolFilter?.deny).toEqual([
      'create_work',
      'adjust_work',
      'work_result',
      'list_works',
      'finish_work',
      'cancel_work',
    ])
  })

  it('drops a name the runtime refuses to restrict, instead of failing the dispatch', async () => {
    // A tool registered at the agent plane is visible to the parent but NOT
    // inherited by the child, so `tools.restrict()` refuses the whole filter. The
    // tree must still run: that one tool stays visible, the rest stay denied.
    const mounted = await mount({
      tools: ['send_message', 'subagent', 'subagent_fork'],
      unrestrictable: ['subagent'],
    })
    const rootId = await createTree(mounted)
    const second = mounted.dispatched.at(-1)
    expect(second?.toolFilter?.deny).toEqual([
      'send_message',
      'subagent_fork',
      'create_work',
      'adjust_work',
      'work_result',
      'list_works',
      'finish_work',
      'cancel_work',
    ])
    // The node is running on the retried dispatch, not left to burn its attempts.
    const shown = await callTool(mounted, 'list_works', {}, mounted.owner)
    expect(shown.summary).toContain(`[${rootId}]`)
    expect(shown.summary).toContain('执行中')
  })

  it('drops the filter entirely when the runtime refuses every name', async () => {
    // Every name of the face is unrestrictable here, so the retry keeps an empty list and
    // the child is started without a filter at all (an empty filter would be a bug).
    const mounted = await mount({
      tools: ['send_message'],
      unrestrictable: [...WORKER_TOOL_DENY],
    })
    await createTree(mounted)
    expect(mounted.dispatched.at(-1)?.toolFilter).toBeUndefined()
  })

  it('does not retry a failure the tool filter cannot explain', async () => {
    const mounted = await mount()
    // A start that fails for another reason must reclaim the node, not spin.
    mounted.ctx.subagents.startContinuable = () => Promise.reject(new Error('provider unavailable'))
    const rootId = await createTree(mounted)
    const shown = await callTool(mounted, 'list_works', {}, mounted.owner)
    expect(shown.summary).toContain(`[${rootId}]`)
    expect(shown.summary).toContain('已中断')
  })

  it('dispatches the worker with the node prompt and the owner as parent', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const dispatched = mounted.dispatched[0]
    expect(dispatched?.provider).toBe('spawn')
    expect(dispatched?.parentId).toBe('owner')
    expect(dispatched?.childId).toMatch(/^work-/u)
    expect(dispatched?.prompt).toContain(rootId)
  })
})

describe('dispatch and reclamation', () => {
  it('does not reclaim a worker whose child is still starting', async () => {
    // A continuable child materializes asynchronously: the node is BOUND before the
    // child exists as an agent. A sweep landing inside that window used to read the
    // binding as "the worker vanished", re-dispatch the node, and leave the first
    // worker with every submit refused — two LLM runs for one attempt, and one more
    // bite out of the attempts budget. The real run that exposed this produced 13
    // workers for 5 nodes.
    const mounted = await mount({ deferStart: true })
    await createTree(mounted, 'Ship it')
    const claim = String(mounted.dispatched.at(-1)?.childId ?? '')
    expect(claim).not.toBe('')

    // Bound, not registered: still this engine's live worker, not a vanished one.
    expect(mounted.host.workerLive(claim)).toBe(true)
    await mounted.host.sweep()

    const node = (await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees[0]?.nodes[0]
    expect(node?.status).toBe('running')
    expect(node?.attempts).toBe(1)
    expect(mounted.dispatched).toHaveLength(1)

    mounted.releaseStarts()
  })

  it('still reclaims a binding whose start finished without a live worker', async () => {
    // The guard must not turn "the child never showed up" into a permanently bound
    // node: once the start has resolved (or failed) without a live agent, the binding
    // is gone and the node goes back to the pool.
    const mounted = await mount()
    await createTree(mounted, 'Ship it')
    await mounted.host.sweep()
    expect(mounted.dispatched.length).toBeGreaterThanOrEqual(2)
  })

  it('leaves no claim behind when a dispatch is refused at the ceiling', async () => {
    // The stub never registers the started child as a live agent, so every sweep reclaims the binding
    // as vanished and charges `failures`. The pass after the ceiling reserves a claim and then has its
    // dispatch refused (`failExhausted`) — the one refusal a real run reaches. That reservation was
    // never bound to a node, so it must be handed back: a ghost in `startingClaims` keeps answering
    // "live", and one leaks per refusal.
    const mounted = await mount()
    const rootId = await createTree(mounted, 'Ship it')

    let guard = 0
    let before: { issued: number; starting: number } | undefined
    while (mounted.nodeFor(rootId)?.status !== 'failed' && guard < 12) {
      guard += 1
      before = mounted.host.claimCounts()
      await mounted.host.sweep()
    }
    expect(mounted.nodeFor(rootId)?.status).toBe('failed')
    if (before === undefined) throw new Error('the tree never dispatched')

    // `before` is the snapshot taken immediately before the refusing sweep; that sweep must add nothing.
    expect(mounted.host.claimCounts()).toEqual(before)
  })
})

describe('the two terminal tools', () => {
  it('runs the aggregate pass to a done root and concludes each worker turn', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)

    const rootWorker = worker(mounted)
    const concluded: string[] = []
    const split = await noteAndSplit(mounted, rootId, [{ title: 'sub', description: 'd', context: ['why'] }], rootWorker, { concludeTurn: () => concluded.push('decompose') })
    expect(split.ok).toBe(true)
    // The children were created and the engine already dispatched one.
    const childId = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
    expect(childId).not.toBe('')

    const childWorker = worker(mounted)
    expect(childWorker.id).not.toBe(rootWorker.id)
    await callTool(
      mounted,
      'submit_work',
      { node_id: childId, result: 'child conclusion' },
      childWorker,
      { concludeTurn: () => concluded.push('submit') },
    )
    expect(concluded).toEqual(['decompose', 'submit'])

    // The children are all terminal, so the root's convergence pass is due — the owner's
    // step is what wakes the parked session for it.
    await mounted.wake()

    // The root is an aggregate now. The engine WAKES the session that decomposed it rather
    // than starting a fresh one, so the convergence pass runs in the session that already
    // knows why the split happened — that continuity is the point of the feature.
    const aggregate = executorFor(mounted, rootId)
    expect(aggregate.id).toBe(rootWorker.id)
    const done = await callTool(
      mounted,
      'submit_work',
      { node_id: rootId, result: 'the answer' },
      aggregate,
    )
    expect(done.ok).toBe(true)
    expect(done.summary).toContain('已完成')
    const shown = await callTool(mounted, 'list_works', {}, mounted.owner)
    expect(shown.summary).toContain(`[${rootId}]`)
    expect(shown.summary).toContain('已完成')
  })

  it('refuses a stranger cancel without touching that tree executors', async () => {
    // The refusal is not enough: interrupting a live worker is observable and irreversible
    // (the node then waits for a sweep and burns an attempt), so a call that will be refused
    // must not have reached the point of no return first.
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const rootId = String(created.data?.root_id ?? '')
    await mounted.flush()
    mounted.makeLive(String(mounted.dispatched[0]?.childId ?? ''))

    const refused = await callTool(mounted, 'cancel_work', { root_id: rootId }, agent('session-other'))
    expect(refused.ok).toBe(false)
    expect(refused.data?.['code']).toBe('not-owner')
    expect(mounted.interrupts).toEqual([])
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees).toHaveLength(1)
  })

  it('refuses a worker that does not hold the node', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const stranger = agent('work-not-mine')
    const result = await callTool(mounted, 'submit_work', { node_id: rootId, result: 'x' }, stranger)
    expect(result.ok).toBe(false)
    expect(result.data?.['code']).toBe('not-owner')
  })
})

describe('worker lifecycle', () => {
  it('reclaims a node as soon as its worker settles', async () => {
    const mounted = await mount()
    await createTree(mounted)
    const claim = String(mounted.dispatched[0]?.childId ?? '')
    expect(mounted.dispatched).toHaveLength(1)

    // Our subagent stub never registers a claim as a live agent, so the settling
    // worker is gone: the event must reclaim the node and the engine re-dispatch
    // it — without waiting for the periodic sweep.
    mounted.ctx.emit('subagent/end', {
      runId: claim,
      provider: 'spawn',
      id: claim,
      local: true,
      stopReason: 'completed',
    } as never)
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(mounted.dispatched).toHaveLength(2)
    // The reclaimed worker consumed one execution-failure slot, and the prompt says so.
    // It must NOT report a dispatch COUNT as "the earlier one did not finish": `attempts`
    // also rises on rounds that succeed (an aggregate/convergence pass is a dispatch).
    expect(mounted.dispatched[1]?.prompt).toContain('没有交出结果')
    expect(mounted.dispatched[1]?.prompt).not.toContain('前几次没有完成')
  })

  it('ignores another agent settling', async () => {
    const mounted = await mount()
    await createTree(mounted)
    mounted.ctx.emit('subagent/end', {
      runId: 'someone-else',
      provider: 'spawn',
      id: 'someone-else',
      local: true,
      stopReason: 'completed',
    } as never)
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(mounted.dispatched).toHaveLength(1)
  })
})

describe('results', () => {
  it('spills a long result and hands the reader its retrieval hint', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const root = worker(mounted)
    const long = 'x'.repeat(2500)
    const submitted = await callTool(mounted, 'submit_work', { node_id: rootId, result: long }, root)
    expect(submitted.ok).toBe(true)
    expect(mounted.spill.saved).toEqual([long])

    const read = await callTool(mounted, 'work_result', { node_id: rootId }, mounted.owner)
    expect(read.summary).toContain(mounted.spill.locator)
    expect(read.summary).toContain(mounted.spill.hint)
    expect(read.data?.['result_hint']).toBe(mounted.spill.hint)
  })

  it('keeps the whole result on the node when no spill backend is mounted', async () => {
    const mounted = await mount({ spill: false })
    const rootId = await createTree(mounted)
    const root = worker(mounted)
    const long = 'y'.repeat(2500)
    await callTool(mounted, 'submit_work', { node_id: rootId, result: long }, root)
    const read = await callTool(mounted, 'work_result', { node_id: rootId }, mounted.owner)
    expect(read.summary).toContain(long)
  })

  it('refuses a foreign session and gates finish on having read the result', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const root = worker(mounted)
    await callTool(mounted, 'submit_work', { node_id: rootId, result: 'done' }, root)

    const intruder = agent('someone-else')
    expect((await callTool(mounted, 'work_result', { node_id: rootId }, intruder)).ok).toBe(false)
    expect((await callTool(mounted, 'finish_work', { root_id: rootId }, intruder)).ok).toBe(false)

    const unread = await callTool(mounted, 'finish_work', { root_id: rootId }, mounted.owner)
    expect(unread.ok).toBe(false)
    expect(unread.data?.['code']).toBe('unread-result')

    await callTool(mounted, 'work_result', { node_id: rootId }, mounted.owner)
    expect((await callTool(mounted, 'finish_work', { root_id: rootId }, mounted.owner)).ok).toBe(true)
    // Idempotent, and the archived tree is still readable.
    expect((await callTool(mounted, 'finish_work', { root_id: rootId }, mounted.owner)).ok).toBe(true)
    expect((await callTool(mounted, 'work_result', { node_id: rootId }, mounted.owner)).ok).toBe(true)
  })
})

describe('what the owner sees of a work', () => {
  it('reports it as running, never how the engine split it up', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const listed = await callTool(mounted, 'list_works', {}, mounted.owner)
    expect(listed.ok, listed.summary).toBe(true)
    expect(listed.summary).toContain(`[${rootId}]`)
    expect(listed.summary).toContain('执行中')
    // The owner acts on the whole work (`adjust_work` / `cancel_work`) and on nothing
    // inside it, so the inside is not reported — there is no action it would inform.
    for (const word of ['待执行', '等待子工作', '已完成', '已失败', '派发=']) {
      expect(listed.summary, `list_works must not break a work down into 「${word}」`).not.toContain(word)
    }
  })
})

describe('guidance', () => {
  it('says nothing before a tree exists, then carries the state, then retires', async () => {
    const mounted = await mount()
    const text = mounted.contexts[0]?.text
    if (text === undefined) throw new Error('guidance context not registered')
    expect(text({ agent: mounted.owner })).toBe('')
    expect(text({})).toBe('')

    const rootId = await createTree(mounted)
    const live = text({ agent: mounted.owner })
    expect(live).toContain('工作：')
    expect(live).toContain('1 个进行中')
    // Deterministic per state: the same state renders the same string, which is
    // what keeps the snapshot from being re-appended every step.
    expect(text({ agent: mounted.owner })).toBe(live)

    await callTool(mounted, 'cancel_work', { root_id: rootId }, mounted.owner)
    const cancelled = text({ agent: mounted.owner })
    expect(cancelled).toContain('已结束的工作')
    expect(cancelled).toContain('finish_work')

    await callTool(mounted, 'work_result', { node_id: rootId }, mounted.owner)
    await callTool(mounted, 'finish_work', { root_id: rootId }, mounted.owner)
    expect(text({ agent: mounted.owner })).toBe('')
  })
})

describe('cancel', () => {
  it('fails every unfinished node and keeps the tree readable', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const cancelled = await callTool(mounted, 'cancel_work', { root_id: rootId }, mounted.owner)
    expect(cancelled.ok).toBe(true)
    const shown = await callTool(mounted, 'list_works', {}, mounted.owner)
    expect(shown.summary).toContain(`[${rootId}]`)
    expect(shown.summary).toContain('已失败')
  })

  it('interrupts the running worker, not just the local start controller', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const claim = String(mounted.dispatched.at(-1)?.childId ?? '')
    expect(claim).not.toBe('')
    const cancelled = await callTool(mounted, 'cancel_work', { root_id: rootId }, mounted.owner)
    expect(cancelled.ok).toBe(true)
    // Regression: `cancelTree` clears every `claimedBy` inside the lock, so the host's
    // `findHolderTree` lookup comes back empty unless the owner is passed explicitly. Without
    // it the live worker is never interrupted and keeps burning model calls whose
    // `submit_work` can only be refused.
    expect(mounted.interrupts).toContain(claim)
  })
})

describe('the browser half\'s wire face', () => {
  it('registers its host contribution with the Typert registry', async () => {
    const mounted = await mount()
    expect(mounted.typertContributions).toHaveLength(1)
    const contribution = mounted.typertContributions[0] as {
      package: string
      face: string
      schemas: { name: string }[]
      invocations: { method: string; mode?: string }[]
    }
    expect(contribution.package).toBe('@avantf/dsh-work')
    expect(contribution.face).toBe('host')
    expect(contribution.invocations.map((entry) => entry.method)).toEqual([
      'snapshot',
      'detail',
      'delete',
      'watch',
    ])
    expect(contribution.schemas.map((entry) => entry.name)).toEqual([
      'snapshotargs',
      'snapshotResult',
      'deleteargs',
      'deleteResult',
      'detailargs',
      'detailResult',
      'watchargs',
      'watchFrame',
    ])
  })

  it('exposes the change stream as a stream invocation, so the engine can push', () => {
    // The refresh is engine-driven: the browser half follows this stream instead of
    // polling, so it must be a `stream` invocation (the harness's own
    // session/control uses the same mode) rather than a unary call.
    const descriptors = (clientContribution as unknown as {
      descriptors: readonly { method: string; mode?: string; cancellation?: { parameter: string } }[]
    }).descriptors
    const watch = descriptors.find((entry) => entry.method === 'watch')
    expect(watch?.mode).toBe('stream')
    // A stream method takes the transport's cancellation signal as a final HOST
    // parameter (never on the wire), which is what lets an unmounted panel stop it.
    expect(watch?.cancellation).toEqual({ parameter: 'signal' })
  })
})

describe('the snapshot the 工作 view reads', () => {
  it('returns this session\'s trees with every node and its status', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await mounted.flush()

    // The Remote method is called directly: the transport is the harness's, and
    // what matters here is the payload the view renders.
    const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
    expect(snapshot.trees).toHaveLength(1)
    const tree = snapshot.trees[0]
    expect(tree?.rootId).toBe(root)
    expect(tree?.closedAt).toBeNull()
    expect(tree?.nodes).toHaveLength(1)
    const node = tree?.nodes[0]
    expect(node?.id).toBe(root)
    expect(node?.title).toBe('Ship it')
    expect(node?.status).toBe('running')
    expect(node?.parentId).toBeNull()
    expect(node?.depth).toBe(1)
    expect(node?.context).toEqual(['because'])
    expect(node?.attempts).toBe(1)
    expect(node?.hasResult).toBe(false)
  })

  it('returns nothing for an unknown or missing session', async () => {
    const mounted = await mount()
    await createTree(mounted, 'Owned')
    expect((await mounted.host.snapshot({ sessionId: 'someone-else' })).trees).toHaveLength(0)
    expect((await mounted.host.snapshot({})).trees).toHaveLength(0)
  })

  it('marks an archived tree so the view can dim it', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Archived')
    await mounted.flush()
    const worker = mounted.makeLive(String(mounted.dispatched.at(-1)?.childId ?? ''))
    await callTool(mounted, 'submit_work', { node_id: root, result: 'done' }, worker)
    await callTool(mounted, 'work_result', { node_id: root }, mounted.owner)
    await callTool(mounted, 'finish_work', { root_id: root }, mounted.owner)

    const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
    expect(snapshot.trees[0]?.closedAt).not.toBeNull()
  })
})

describe('a reused prerequisite stays visible as a dependency', () => {
  it('lists it among the depending node children, and in the snapshot', async () => {
    // The bug this pins: a node that reuses a prerequisite was born under ANOTHER parent, so
    // rendering or reading by `parentId` showed an aggregate as a leaf — waiting on nothing.
    const mounted = await mount()
    const created = await callTool(mounted, 'create_work', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()
    const rootWorker = agent(String(mounted.dispatched.at(-1)?.childId ?? ''))
    const split = await noteAndSplit(mounted, root, [
          { title: 'A', description: 'a', context: ['why'] },
          { title: 'B', description: 'b', context: ['why'] },
        ], rootWorker)
    const [a, b] = (split.data?.['created'] as string[] | undefined) ?? []
    await mounted.flush()

    // The worker for a node is the dispatch whose prompt carries that node's id — reading
    // `dispatched.at(-1)` picks up whichever sibling happened to be dispatched last.
    const workerFor = (nodeId: string): ReturnType<typeof agent> =>
      agent(String(mounted.dispatched.filter((entry) => entry.prompt.includes(nodeId)).at(-1)?.childId ?? ''))
    await noteAndSplit(mounted, String(a), [{ title: 'shared', description: 's', context: ['why'] }], workerFor(String(a)))
    await mounted.flush()
    const bWorker = workerFor(String(b))
    const reused = await noteAndSplit(mounted, String(b), [{ title: 'shared', description: 's', context: ['why'] }], bWorker)
    expect((reused.data?.['reused'] as string[] | undefined)?.length).toBe(1)
    const shared = String((reused.data?.['reused'] as string[] | undefined)?.[0] ?? '')

    // B depends on it, and B's detail says so — even though the node was born under A.
    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: String(b) })
    expect(detail.children.map((child) => child.id)).toEqual([shared])
    expect(detail.children[0]?.title).toBe('shared')

    // The snapshot carries the same edge, so the client can render it too.
    const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
    const view = snapshot.trees[0]?.nodes.find((node) => node.id === String(b))
    expect(view?.children).toEqual([shared])
    expect(snapshot.trees[0]?.nodes.find((node) => node.id === shared)?.parentId).toBe(String(a))
  })
})

describe('the detail an expanded row shows', () => {
  it('returns the work\'s own content plus what its children reported', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    const rootWorker = worker(mounted)
    const split = await noteAndSplit(mounted, root, [{ title: 'sub', description: 'do the part', context: ['why'] }], rootWorker)
    const childId = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
    await callTool(
      mounted,
      'submit_work',
      { node_id: childId, result: 'child conclusion' },
      worker(mounted),
    )

    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.error).toBeUndefined()
    expect(detail.node?.title).toBe('Ship it')
    expect(detail.node?.description).toBe('d')
    expect(detail.node?.context).toEqual(['because'])
    expect(detail.node?.depth).toBe(1)
    // The child's own body is what the parent's panel quotes, so the reader sees the
    // conclusion without expanding each child in turn.
    expect(detail.children).toHaveLength(1)
    expect(detail.children[0]?.title).toBe('sub')
    expect(detail.children[0]?.status).toBe('done')
    expect(detail.children[0]?.result).toBe('child conclusion')
  })

  it('refuses a node of another session, and an unknown node', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')

    expect((await mounted.host.detail({ sessionId: 'someone-else', nodeId: root })).error)
      .toContain('属于别的会话')
    expect((await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: 'nope' })).error)
      .toContain('不存在')
  })
})

describe('the change stream the panel follows', () => {
  /** Collect the frames a stream yields until it is aborted. */
  async function frames(
    mounted: Awaited<ReturnType<typeof mount>>,
    sessionId: string,
    act: () => Promise<void>,
  ): Promise<number[]> {
    const controller = new AbortController()
    const seen: number[] = []
    const consumer = (async () => {
      for await (const frame of mounted.host.watch({ sessionId }, controller.signal)) seen.push(frame.revision)
    })()
    // Let the generator reach its first yield before anything changes.
    await mounted.flush()
    await act()
    await mounted.flush()
    controller.abort()
    await consumer
    return seen
  }

  it('frames a change the engine made, opening with the current revision', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    const during = await frames(mounted, mounted.owner.id, async () => {
      await callTool(mounted, 'cancel_work', { root_id: root }, mounted.owner)
    })
    // One frame for opening (the current revision) and at least one for the change.
    expect(during.length).toBeGreaterThanOrEqual(2)
    expect(during.at(-1)).toBeGreaterThan(during[0] ?? -1)
  })

  it('frames a change that produced no session event at all', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await callTool(mounted, 'cancel_work', { root_id: root }, mounted.owner)

    // Deleting is a Remote call, not a tool call: nothing lands in the owner's
    // session, so a panel that inferred changes from the log would keep showing a
    // tree that is already gone. This is the class of change the push exists for.
    const during = await frames(mounted, mounted.owner.id, async () => {
      await mounted.host.delete({ sessionId: mounted.owner.id, rootId: root })
    })
    expect(during.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps another session\'s stream quiet', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    const seen = await frames(mounted, 'someone-else', async () => {
      await callTool(mounted, 'cancel_work', { root_id: root }, mounted.owner)
    })
    // Only the opening frame: a panel must never be woken by another session's tree.
    expect(seen).toHaveLength(1)
  })
})

describe('deleting a work tree from the 工作 view', () => {
  it('refuses a tree that is still running, and points at cancel_work', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await mounted.flush()

    // `createTree` dispatches, so the tree is live: the panel's button is disabled for
    // it, and the host refuses anyway rather than trusting the caller.
    const refused = await mounted.host.delete({ sessionId: mounted.owner.id, rootId: root })
    expect(refused.deleted).toEqual([])
    expect(refused.error).toContain('只有已结束的工作能删除')
    expect(refused.error).toContain('cancel_work')
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees).toHaveLength(1)
  })

  it('deletes the whole tree, every node of it', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    const split = await noteAndSplit(mounted, root, [{ title: 'sub', description: 'd', context: [] }], worker(mounted))
    const childId = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
    await callTool(mounted, 'cancel_work', { root_id: root }, mounted.owner)

    // The unit is the tree: naming the root removes the children with it.
    const deleted = await mounted.host.delete({ sessionId: mounted.owner.id, rootId: root })
    expect(deleted.error).toBeUndefined()
    expect([...deleted.deleted].sort()).toEqual([root, childId].sort())
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees).toHaveLength(0)
  })

  it('deletes an archived tree, so finishing and deleting stay different gestures', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await callTool(mounted, 'cancel_work', { root_id: root }, mounted.owner)
    await callTool(mounted, 'work_result', { node_id: root }, mounted.owner)
    await callTool(mounted, 'finish_work', { root_id: root }, mounted.owner)
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees[0]?.closedAt).not.toBeNull()

    const deleted = await mounted.host.delete({ sessionId: mounted.owner.id, rootId: root })
    expect(deleted.error).toBeUndefined()
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees).toHaveLength(0)
  })

  it('refuses a session that does not own the tree', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await callTool(mounted, 'cancel_work', { root_id: root }, mounted.owner)

    const refused = await mounted.host.delete({ sessionId: 'someone-else', rootId: root })
    expect(refused.deleted).toEqual([])
    expect(refused.error).toContain('属于别的会话')
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees).toHaveLength(1)
  })

  it('will not take a node id: the tree is the addressable unit', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    const split = await noteAndSplit(mounted, root, [{ title: 'sub', description: 'd', context: [] }], worker(mounted))
    const childId = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')

    const refused = await mounted.host.delete({ sessionId: mounted.owner.id, rootId: childId })
    expect(refused.deleted).toEqual([])
    expect(refused.error).toContain('不存在')
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees).toHaveLength(1)
  })
})
