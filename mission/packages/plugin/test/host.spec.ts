/**
 * Host behaviour through the tool surface: ownership, the finish gate, the
 * worker tool face, spill rendering and turn conclusion.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RefusalCode } from '@avantf/mission-core'
import { agent, callTool, executorFor, mount, noteAndSplit } from './mount.js'
import type { TreeDocument } from '../src/domain.js'
import { clientContribution, ROW_CORRECTIONS_MAX, SNAPSHOT_WIRE_VERSION } from '../src/wire.js'
import { WORKER_TOOL_DENY } from '../src/faces.js'

/** A mission unit: the child session the engine reserved for one node. */
function worker(mounted: Awaited<ReturnType<typeof mount>>): ReturnType<typeof agent> {
  const claimId = String(mounted.dispatched.at(-1)?.childId ?? '')
  return agent(claimId)
}

async function createTree(mounted: Awaited<ReturnType<typeof mount>>, title = 'T'): Promise<string> {
  const created = await callTool(mounted, 'create_mission', { title, description: 'd', analysis: ['because'] }, mounted.owner)
  return String(created.data?.root_id ?? '')
}

describe('create_mission authority', () => {
  it('refuses a mission unit rooting its own tree', async () => {
    const mounted = await mount()
    const subagent = agent('child-1', { origin: 'subagent', delegationDepth: 1 })
    const result = await callTool(
      mounted,
      'create_mission',
      { title: 'sneaky', description: 'd', analysis: [] },
      subagent,
    )
    expect(result.ok).toBe(false)
    expect(result.data?.['code']).toBe('no-authority')
  })

  it('refuses a nested session that only records a delegation depth', async () => {
    const mounted = await mount()
    const nested = agent('child-2', { delegationDepth: 2 })
    expect((await callTool(mounted, 'create_mission', { title: 'x', description: 'd', analysis: [] }, nested)).ok).toBe(false)
  })

  it('admits a top-level session', async () => {
    const mounted = await mount()
    expect(await createTree(mounted)).not.toBe('')
  })
})

describe('tool-level argument and caller refusals', () => {
  it('answers a callerless call with no-caller, a code the refusal table knows', async () => {
    // An audit found `no-caller` produced by all nine tools but absent from `RefusalCode`: any
    // consumer that exhausts the union would silently drop it. Pin BOTH halves — the value is
    // produced, and it is part of the table.
    const mounted = await mount()
    const callerless = await callTool(
      mounted,
      'create_mission',
      { title: 'T', description: 'd', analysis: [] },
      undefined as never,
    )
    expect(callerless.ok).toBe(false)
    expect(callerless.data?.['code']).toBe('no-caller')
    // A type-level half: this line stops compiling if `no-caller` leaves `RefusalCode`.
    const known: RefusalCode = 'no-caller'
    expect(known).toBe(callerless.data?.['code'])
  })

  it('refuses whitespace-only content, the way note_mission always has', async () => {
    // "Must be a non-empty string" meant `length > 0`, so `"   "` was content: a blank title, a blank
    // result, a blank correction — persisted, then rendered back into later prompts. `note_mission`
    // already refused the same thing with a code (`no-analysis`); the other three writes answer with
    // the same SHAPE (`blank-text`), not with a thrown error.
    const mounted = await mount()
    const rootId = await createTree(mounted)

    const blankTitle = await callTool(
      mounted,
      'create_mission',
      { title: '   ', description: 'd', analysis: [] },
      mounted.owner,
    )
    expect(blankTitle.ok).toBe(false)
    expect(blankTitle.data?.['code']).toBe('blank-text')

    const blankAdjustment = await callTool(
      mounted,
      'adjust_mission',
      { root_id: rootId, adjustment: ' \n ' },
      mounted.owner,
    )
    expect(blankAdjustment.ok).toBe(false)
    expect(blankAdjustment.data?.['code']).toBe('blank-text')

    const blankResult = await callTool(mounted, 'submit_mission', { node_id: rootId, result: '\t' }, worker(mounted))
    expect(blankResult.ok).toBe(false)
    expect(blankResult.data?.['code']).toBe('blank-text')

    // Nothing was written on the way to any of those refusals.
    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: rootId })
    expect(detail.node?.corrections).toEqual([])
    expect(detail.node?.result).toBeNull()
    const missions = await callTool(mounted, 'list_missions', {}, mounted.owner)
    expect(missions.summary.match(/^\[/gmu) ?? []).toHaveLength(1)
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
      'create_mission',
      'adjust_mission',
      'mission_result',
      'list_missions',
      'finish_mission',
      'cancel_mission',
    ])
  })

  it('still denies the owner face in a deployment with no harness delegation tools', async () => {
    // The face does not depend on what the harness offers: the owner's six tools are
    // this plugin's own registrations, so they are exactly what is left to deny.
    const mounted = await mount({ tools: [] })
    await createTree(mounted)
    expect(mounted.dispatched[0]?.toolFilter?.deny).toEqual([
      'create_mission',
      'adjust_mission',
      'mission_result',
      'list_missions',
      'finish_mission',
      'cancel_mission',
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
      'create_mission',
      'adjust_mission',
      'mission_result',
      'list_missions',
      'finish_mission',
      'cancel_mission',
    ])
    // The node is running on the retried dispatch, not left to burn its attempts.
    const shown = await callTool(mounted, 'list_missions', {}, mounted.owner)
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
    const shown = await callTool(mounted, 'list_missions', {}, mounted.owner)
    expect(shown.summary).toContain(`[${rootId}]`)
    expect(shown.summary).toContain('已中断')
  })

  it('dispatches the worker with the node prompt and the owner as parent', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const dispatched = mounted.dispatched[0]
    expect(dispatched?.provider).toBe('spawn')
    expect(dispatched?.parentId).toBe('owner')
    expect(dispatched?.childId).toMatch(/^mission-/u)
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

  it('tells the owner when a node keeps failing to start a worker', async () => {
    // The gap an audit found: a spawn-failed node is never `running`, so the stall sweep — the only
    // heads-up the engine had — could not see it, while `list_missions` still marked the mission
    // 「反复出过问题」. The message has to come from the dispatch failure itself, at the SAME floor
    // (`isTroubledNode`), because otherwise the two channels report different things about one node.
    //
    // Only `Date` is faked: the counters and floors are the engine's own, and each failed start starts
    // a real cooldown, so the clock is advanced between pumps the way an outage would advance it.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const mounted = await mount({ failStart: true })
      // `deliverToOwner` only writes to a LIVE owner; a deferred message is a log line, which is the
      // right production behaviour and a silent no-op in a test. Making it live is the assertion's
      // precondition, not a convenience.
      const ownerAgent = mounted.makeLive('owner')
      const rootId = await createTree(mounted, 'Ship it')

      // Drive the outage until the owner is actually TOLD — that message is the behaviour under test,
      // and the counter crossing its floor is only how it gets there. Each failed start begins a real
      // cooldown, so the clock is advanced between pumps the way an outage would advance it.
      let guard = 0
      while (ownerAgent.received.length === 0 && guard < 10) {
        guard += 1
        vi.setSystemTime(Date.now() + 11 * 60_000)
        await mounted.flush()
      }

      const node = mounted.nodeFor(rootId)
      expect(node?.spawnFailures).toBeGreaterThanOrEqual(4)
      // Charged to the START budget, never to the mission's own failure budget: an outage is not the
      // mission's fault, and the two ceilings are deliberately separate.
      expect(node?.failures).toBe(0)
      const told = ownerAgent.received.map((message) => JSON.stringify(message)).join('\n')
      expect(told).toContain('没能启动执行者')
      expect(told).toContain(rootId)
      expect(told).toContain('5 次')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the two terminal tools', () => {
  it('says a child is not a root, instead of claiming it does not exist', async () => {
    // `finish` looks the ROOT up by id, so a child id fell through to `not-found` — 「任务 X 不存在」
    // about a node that plainly exists. `adjust_mission` had the right shape already; all three owner
    // tools now answer the same way.
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const split = await noteAndSplit(
      mounted,
      rootId,
      [{ title: 'A', description: 'a', context: ['why'] }],
      worker(mounted),
    )
    const child = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
    expect(child).not.toBe('')

    const refused = await callTool(mounted, 'finish_mission', { root_id: child }, mounted.owner)
    expect(refused.ok).toBe(false)
    expect(refused.data?.['code']).toBe('not-root')
    expect(refused.summary).toContain('不是根任务')
  })

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
      'submit_mission',
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
      'submit_mission',
      { node_id: rootId, result: 'the answer' },
      aggregate,
    )
    expect(done.ok).toBe(true)
    expect(done.summary).toContain('已完成')
    const shown = await callTool(mounted, 'list_missions', {}, mounted.owner)
    expect(shown.summary).toContain(`[${rootId}]`)
    expect(shown.summary).toContain('已完成')
  })

  it('refuses a stranger cancel without touching that tree executors', async () => {
    // The refusal is not enough: interrupting a live worker is observable and irreversible
    // (the node then waits for a sweep and burns an attempt), so a call that will be refused
    // must not have reached the point of no return first.
    const mounted = await mount()
    const created = await callTool(mounted, 'create_mission', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
    const rootId = String(created.data?.root_id ?? '')
    await mounted.flush()
    mounted.makeLive(String(mounted.dispatched[0]?.childId ?? ''))

    const refused = await callTool(mounted, 'cancel_mission', { root_id: rootId }, agent('session-other'))
    expect(refused.ok).toBe(false)
    expect(refused.data?.['code']).toBe('not-owner')
    expect(mounted.interrupts).toEqual([])
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees).toHaveLength(1)
  })

  it('refuses a worker that does not hold the node', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const stranger = agent('mission-not-mine')
    const result = await callTool(mounted, 'submit_mission', { node_id: rootId, result: 'x' }, stranger)
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

  it('keeps refreshing progress for a claim issued before a restart, and separates output from noise', async () => {
    // Hot reload: the durable tree still binds this worker (`reconcileOnOpen` keeps a live survivor
    // `running` and resets its clocks), but `issuedClaims` is in-memory and start-up never refills
    // it. Filtering the progress feed on that set dropped every later event, so past `staleMs` a
    // worker that had been working the whole time was interrupted and reclaimed as stalled — one
    // burnt attempt and one `failures` slot. The claim id's own shape is the fallback provenance.
    const mounted = await mount()
    const rootId = await createTree(mounted, 'a long run')
    const claim = String(mounted.dispatched[0]?.childId ?? '')
    expect(claim).not.toBe('')

    // A restart: the in-memory set empties while the persisted binding stays.
    await mounted.host.stop()
    expect(mounted.host.claimCounts().issued).toBe(0)
    expect(mounted.nodeFor(rootId)?.claimedBy).toBe(claim)

    const before = mounted.nodeFor(rootId)?.progressAt ?? 0
    // Through the feed the plugin actually registers, not by calling the host method directly.
    // Transport-layer noise (a retried provider attempt) is heard — it moves the activity clock —
    // but is NOT output, so the stale check's own clock must not move.
    const noiseAt = before + 100
    mounted.ctx.emit('session/event', { id: claim } as never, { time: noiseAt, type: 'assistant/attempt' } as never)
    expect(mounted.nodeFor(rootId)?.progressAt).toBe(before)
    expect(mounted.nodeFor(rootId)?.activityAt).toBe(noiseAt)

    // Real output (the model's committed message) refreshes both clocks.
    mounted.ctx.emit('session/event', { id: claim } as never, { time: noiseAt + 1, type: 'assistant/message' } as never)
    expect(mounted.nodeFor(rootId)?.progressAt).toBe(noiseAt + 1)
    expect(mounted.nodeFor(rootId)?.activityAt).toBe(noiseAt + 1)
  })

  it('⑦ configures the round ceiling with a floor and a warning, exactly like staleMs', async () => {
    // The round cap is the backstop a refreshed timestamp cannot veto, so it is configured at the
    // SAME layer as `staleMs` (plugin config -> host option -> engine option) and floored the same
    // way. Its floor is `max(10 min, staleMs)`: a cap below the output window would fire before
    // `stalled` ever can, so the floor moves with the configured window instead of being a constant
    // that a large `staleMs` would contradict.
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
    try {
      // Below the 10-minute constant, and below the default 30-minute window: raised to the window.
      const below = await mount({ pluginConfig: { roundMs: 1_000 } })
      expect(below.host.roundWindowMs()).toBe(30 * 60_000)
      expect(lines.some((line) => line.includes('roundMs') && line.includes('floor'))).toBe(true)

      // The constant floor once the window is small: raised to 10 minutes, not to `staleMs`.
      const smallWindow = await mount({ pluginConfig: { roundMs: 1_000, staleMs: 60_000 } })
      expect(smallWindow.host.roundWindowMs()).toBe(10 * 60_000)

      // Above the floor nothing is raised and nothing is said; only NEW lines count, since the host
      // may have evaluated the window more than once while opening the earlier mounts.
      const before = lines.length
      const accepted = await mount({ pluginConfig: { roundMs: 20 * 60_000, staleMs: 60_000 } })
      expect(accepted.host.roundWindowMs()).toBe(20 * 60_000)
      expect(lines.slice(before).filter((line) => line.includes('roundMs') && line.includes('floor'))).toHaveLength(0)

      // Unconfigured: one hour, or the output window when the owner widened that past an hour.
      const unset = await mount()
      expect(unset.host.roundWindowMs()).toBe(60 * 60_000)
      const widened = await mount({ pluginConfig: { staleMs: 2 * 60 * 60_000 } })
      expect(widened.host.roundWindowMs()).toBe(2 * 60 * 60_000)
    } finally {
      spy.mockRestore()
    }
  })

  it('warns — rate-limited — when a background sweep fails, instead of swallowing it', async () => {
    // The chain the two fire-and-forget callers start persists progress (a durable write), probes
    // storage for orphans and then reclaims/dispatches. `.catch(() => undefined)` hid a store that
    // keeps refusing writes: a failure a minute, zero evidence. The first failure must speak, and
    // the 60 s interval must not turn one condition into a line a minute.
    const mounted = await mount()
    await createTree(mounted)
    const claim = String(mounted.dispatched[0]?.childId ?? '')
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
    try {
      mounted.host.sweep = () => Promise.reject(new Error('stubbed: the store refuses the write'))
      const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })
      const end = { runId: claim, provider: 'spawn', id: claim, local: true, stopReason: 'completed' } as never
      mounted.ctx.emit('subagent/end', end)
      await settle()
      // Same condition, inside the throttle window: folded, not printed again.
      mounted.ctx.emit('subagent/end', end)
      await settle()
    } finally {
      spy.mockRestore()
    }
    const warnings = lines.filter((line) => line.includes('sweep failed'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('stubbed: the store refuses the write')
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
    const submitted = await callTool(mounted, 'submit_mission', { node_id: rootId, result: long }, root)
    expect(submitted.ok).toBe(true)
    expect(mounted.spill.saved).toEqual([long])

    const read = await callTool(mounted, 'mission_result', { node_id: rootId }, mounted.owner)
    expect(read.summary).toContain(mounted.spill.locator)
    expect(read.summary).toContain(mounted.spill.hint)
    expect(read.data?.['result_hint']).toBe(mounted.spill.hint)
  })

  it('keeps the whole result on the node when no spill backend is mounted', async () => {
    const mounted = await mount({ spill: false })
    const rootId = await createTree(mounted)
    const root = worker(mounted)
    const long = 'y'.repeat(2500)
    await callTool(mounted, 'submit_mission', { node_id: rootId, result: long }, root)
    const read = await callTool(mounted, 'mission_result', { node_id: rootId }, mounted.owner)
    expect(read.summary).toContain(long)
  })

  it('refuses a foreign session and gates finish on having read the result', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const root = worker(mounted)
    await callTool(mounted, 'submit_mission', { node_id: rootId, result: 'done' }, root)

    const intruder = agent('someone-else')
    expect((await callTool(mounted, 'mission_result', { node_id: rootId }, intruder)).ok).toBe(false)
    expect((await callTool(mounted, 'finish_mission', { root_id: rootId }, intruder)).ok).toBe(false)

    const unread = await callTool(mounted, 'finish_mission', { root_id: rootId }, mounted.owner)
    expect(unread.ok).toBe(false)
    expect(unread.data?.['code']).toBe('unread-result')

    await callTool(mounted, 'mission_result', { node_id: rootId }, mounted.owner)
    expect((await callTool(mounted, 'finish_mission', { root_id: rootId }, mounted.owner)).ok).toBe(true)
    // Idempotent, and the archived tree is still readable.
    expect((await callTool(mounted, 'finish_mission', { root_id: rootId }, mounted.owner)).ok).toBe(true)
    expect((await callTool(mounted, 'mission_result', { node_id: rootId }, mounted.owner)).ok).toBe(true)
  })

  it('reads a spilled result back in full, and only for its own session', async () => {
    // The panel cannot follow the locator itself (a browser will not open a filesystem path), so the
    // host reads its own spill artifact. `spillToDisk` models `dsh-spill-local`, the backend whose
    // locator IS a path — read, not assumed.
    const mounted = await mount({ spillToDisk: true })
    const rootId = await createTree(mounted)
    const long = 'z'.repeat(2500)
    await callTool(mounted, 'submit_mission', { node_id: rootId, result: long }, worker(mounted))

    const full = await mounted.host.result({ sessionId: mounted.owner.id, nodeId: rootId })
    expect(full.error).toBeUndefined()
    expect(full.text).toBe(long)
    // The node itself still holds only the head — the read is the full text, not a bigger node.
    expect(mounted.nodeFor(rootId)?.result).toHaveLength(2000)
    // Someone else's session is refused, exactly like `detail`.
    expect((await mounted.host.result({ sessionId: 'elsewhere', nodeId: rootId })).error).toContain('别的会话')
    expect((await mounted.host.result({ sessionId: mounted.owner.id, nodeId: 'nope' })).error).toContain('不存在')
  })

  it('answers with the inline text when nothing was spilled, and says why when the locator is not a path', async () => {
    // The default stub hands out an OPAQUE locator (`spill://…`), which is what the `SpillStore`
    // contract allows. A host that cannot resolve it must say so and leave the locator readable —
    // never silently show nothing, and never guess that a locator is a filename.
    const mounted = await mount({ spill: false })
    const inlineRoot = await createTree(mounted, 'inline')
    await callTool(mounted, 'submit_mission', { node_id: inlineRoot, result: 'short' }, worker(mounted))
    expect(await mounted.host.result({ sessionId: mounted.owner.id, nodeId: inlineRoot }))
      .toEqual({ text: 'short' })

    const spilled = await mount()
    const opaqueRoot = await createTree(spilled, 'opaque')
    await callTool(spilled, 'submit_mission', { node_id: opaqueRoot, result: 'q'.repeat(2500) }, worker(spilled))
    const refused = await spilled.host.result({ sessionId: spilled.owner.id, nodeId: opaqueRoot })
    expect(refused.text).toBe('')
    expect(refused.error).toContain('不在本机文件系统上')
    expect(refused.error).toContain(spilled.spill.locator)
  })
})

describe('what the owner sees of a mission', () => {
  it('reports it as running, never how the engine split it up', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const listed = await callTool(mounted, 'list_missions', {}, mounted.owner)
    expect(listed.ok, listed.summary).toBe(true)
    expect(listed.summary).toContain(`[${rootId}]`)
    expect(listed.summary).toContain('执行中')
    // The owner acts on the whole mission (`adjust_mission` / `cancel_mission`) and on nothing
    // inside it, so the inside is not reported — there is no action it would inform.
    for (const word of ['待执行', '等待子任务', '已完成', '已失败', '派发=']) {
      expect(listed.summary, `list_missions must not break a mission down into 「${word}」`).not.toContain(word)
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
    expect(live).toContain('任务：')
    expect(live).toContain('1 个进行中')
    // Deterministic per state: the same state renders the same string, which is
    // what keeps the snapshot from being re-appended every step.
    expect(text({ agent: mounted.owner })).toBe(live)

    await callTool(mounted, 'cancel_mission', { root_id: rootId }, mounted.owner)
    const cancelled = text({ agent: mounted.owner })
    expect(cancelled).toContain('已结束的任务')
    expect(cancelled).toContain('finish_mission')

    await callTool(mounted, 'mission_result', { node_id: rootId }, mounted.owner)
    await callTool(mounted, 'finish_mission', { root_id: rootId }, mounted.owner)
    expect(text({ agent: mounted.owner })).toBe('')
  })
})

describe('cancel', () => {
  it('fails every unfinished node and keeps the tree readable', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const cancelled = await callTool(mounted, 'cancel_mission', { root_id: rootId }, mounted.owner)
    expect(cancelled.ok).toBe(true)
    const shown = await callTool(mounted, 'list_missions', {}, mounted.owner)
    expect(shown.summary).toContain(`[${rootId}]`)
    expect(shown.summary).toContain('已失败')
  })

  it('interrupts the running worker, not just the local start controller', async () => {
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const claim = String(mounted.dispatched.at(-1)?.childId ?? '')
    expect(claim).not.toBe('')
    const cancelled = await callTool(mounted, 'cancel_mission', { root_id: rootId }, mounted.owner)
    expect(cancelled.ok).toBe(true)
    // Regression: `cancelTree` clears every `claimedBy` inside the lock, so the host's
    // `findHolderTree` lookup comes back empty unless the owner is passed explicitly. Without
    // it the live worker is never interrupted and keeps burning model calls whose
    // `submit_mission` can only be refused.
    expect(mounted.interrupts).toContain(claim)
  })

  it('says a child is not a root, instead of claiming it does not exist', async () => {
    // `treeOf` is keyed by ROOT id, so a child id used to come back as 「任务 X 不存在」 — and this
    // tool's whole job is to act on the id it was handed, so a misleading refusal is expensive.
    const mounted = await mount()
    const rootId = await createTree(mounted)
    const split = await noteAndSplit(
      mounted,
      rootId,
      [{ title: 'A', description: 'a', context: ['why'] }],
      worker(mounted),
    )
    const child = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
    expect(child).not.toBe('')

    const refused = await callTool(mounted, 'cancel_mission', { root_id: child }, mounted.owner)
    expect(refused.ok).toBe(false)
    expect(refused.data?.['code']).toBe('not-root')
    expect(refused.summary).toContain('不是根任务')
    // And nothing was interrupted on the way to that refusal.
    expect(mounted.interrupts).toEqual([])
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
    expect(contribution.package).toBe('@avantf/dsh-mission')
    expect(contribution.face).toBe('host')
    expect(contribution.invocations.map((entry) => entry.method)).toEqual([
      'snapshot',
      'detail',
      'result',
      'delete',
      'cleanFinished',
      'resolveExecutorSession',
      'watch',
    ])
    expect(contribution.schemas.map((entry) => entry.name)).toEqual([
      'snapshotargs',
      'snapshotResult',
      'deleteargs',
      'deleteResult',
      'cleanFinishedargs',
      'cleanFinishedResult',
      'detailargs',
      'detailResult',
      'resultargs',
      'resultText',
      'resolveExecutorSessionargs',
      'executorSessionResult',
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

describe('the snapshot the 任务 view reads', () => {
  it('returns this session\'s trees with every node and its status', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await mounted.flush()

    // The Remote method is called directly: the transport is the harness's, and
    // what matters here is the payload the view renders.
    const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
    expect(snapshot.trees).toHaveLength(1)
    // The panel's version marker travels on this ONE payload (see `wire.ts`): an older client drops
    // the extra key, a newer client reads it to say "the two halves are out of step".
    expect(snapshot.wire).toBe(SNAPSHOT_WIRE_VERSION)
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
    // The row projection carries the premise COUNT, not the premises: the texts live in the detail
    // dialog, and every node in a tree would otherwise re-send them on every frame. `context: []` is
    // the legacy shape an older client still requires.
    expect(node?.context).toEqual([])
    expect(node?.contextCount).toBe(1)
    expect(node?.attempts).toBe(1)
    expect(node?.hasResult).toBe(false)
  })

  it('caps the corrections a row carries but reports the full count', async () => {
    // The row marks a steered mission from `correctionCount`; only the newest few texts ride along, so
    // a root the owner corrected many times cannot make every frame carry all of them.
    const mounted = await mount()
    const root = await createTree(mounted, 'Steered')
    await mounted.flush()
    for (let index = 0; index < ROW_CORRECTIONS_MAX + 3; index++) {
      await callTool(mounted, 'adjust_mission', { root_id: root, adjustment: `correction ${String(index)}` }, mounted.owner)
    }
    const node = (await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees[0]?.nodes[0]
    expect(node?.correctionCount).toBe(ROW_CORRECTIONS_MAX + 3)
    expect(node?.corrections).toHaveLength(ROW_CORRECTIONS_MAX)
    // The newest survive the cap; the detail dialog is where all of them are read.
    expect(node?.corrections.at(-1)).toBe(`correction ${String(ROW_CORRECTIONS_MAX + 2)}`)
    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.node?.corrections).toHaveLength(ROW_CORRECTIONS_MAX + 3)
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
    await callTool(mounted, 'submit_mission', { node_id: root, result: 'done' }, worker)
    await callTool(mounted, 'mission_result', { node_id: root }, mounted.owner)
    await callTool(mounted, 'finish_mission', { root_id: root }, mounted.owner)

    const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
    expect(snapshot.trees[0]?.closedAt).not.toBeNull()
  })
})

describe('the worker session the panel can open', () => {
  it('names the executor while a node is bound, and marks it live', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await mounted.flush()
    const claim = String(mounted.dispatched[0]?.childId ?? '')
    expect(claim).not.toBe('')

    const node = (await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees[0]?.nodes[0]
    expect(node?.workerSessionId).toBe(claim)
    // The field names the EXECUTOR — never the mission id dressed up as one.
    expect(node?.workerSessionId).not.toBe(node?.id)
    // ② running ⇒ live, so the panel's entry says 进行中.
    expect(node?.workerLive).toBe(true)

    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.node?.workerSessionId).toBe(claim)
    expect(detail.node?.workerLive).toBe(true)
  })

  it('KEEPS the executor handle after the node finishes, and reports it as not live', async () => {
    // ① The bug this whole change exists for: `claimedBy` is cleared on submit, so a finished mission
    // used to have no address at all. The display handle survives it, and `workerLive` says the
    // session has stopped — which is exactly what lets the panel open a finished mission's session.
    const mounted = await mount()
    const root = await createTree(mounted, 'Finished')
    await mounted.flush()
    const claim = String(mounted.dispatched[0]?.childId ?? '')
    const worker = mounted.makeLive(claim)

    await callTool(mounted, 'submit_mission', { node_id: root, result: 'done' }, worker)
    expect(mounted.nodeFor(root)?.claimedBy ?? null).toBeNull()

    const node = (await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees[0]?.nodes[0]
    expect(node?.status).toBe('done')
    expect(node?.workerSessionId).toBe(claim)
    expect(node?.workerLive).toBe(false)
    expect(mounted.nodeFor(root)?.executorSessionId).toBe(claim)

    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.node?.workerSessionId).toBe(claim)
    expect(detail.node?.workerLive).toBe(false)
  })

  it('keeps the handle on a cancelled node, and never the node id or an empty string', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Cancelled')
    await mounted.flush()
    // The binding was real before the cancel — otherwise "kept afterwards" would prove nothing.
    const claim = String(mounted.dispatched[0]?.childId ?? '')
    expect(mounted.nodeFor(root)?.claimedBy).toBe(claim)

    await callTool(mounted, 'cancel_mission', { root_id: root }, mounted.owner)
    expect(mounted.nodeFor(root)?.claimedBy ?? null).toBeNull()

    const node = (await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees[0]?.nodes[0]
    expect(node?.status).toBe('failed')
    expect(node?.workerSessionId).toBe(claim)
    expect(node?.workerSessionId).not.toBe(root)
    expect(node?.workerSessionId).not.toBe('')
    expect(node?.workerLive).toBe(false)

    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.node?.workerSessionId).toBe(claim)
  })

  it('has no handle at all for a node that was never dispatched', async () => {
    // ④ A mission the capacity gate is holding back: it has never run, so there is nothing to open
    // and the panel renders the id as plain text.
    const mounted = await mount({ pluginConfig: { capacity: 1 } })
    await callTool(mounted, 'create_mission', { title: 'first', description: 'd', analysis: [] }, mounted.owner)
    const second = await callTool(mounted, 'create_mission', { title: 'queued', description: 'd', analysis: [] }, mounted.owner)
    const queuedId = String(second.data?.['root_id'] ?? '')
    const row = mounted.host.treesForSession(mounted.owner.id).flatMap((tree) => tree.nodes)
      .find((node) => node.id === queuedId)
    expect(row?.waitingFor).not.toBeNull()
    expect(row?.workerSessionId).toBeNull()
    expect(row?.workerLive).toBe(false)
    expect(mounted.nodeFor(queuedId)?.executorSessionId).toBeNull()
  })
})

/**
 * W18: `resolveExecutorSession` — the click-time lookup for a node whose record has no display
 * handle (everything dispatched before that field existed). These cases pin what it answers, what it
 * WRITES BACK, and — the invariant the whole feature rests on — that it reads session logs only when
 * a click asks it to.
 */
describe('resolving a historical executor on click', () => {
  /** A tree record as a build BEFORE `executorSessionId` existed wrote it: finished, no handle. */
  function historicalDocument(rootId: string, ownerSessionId: string, at = 1_000): TreeDocument {
    const document: TreeDocument = {
      tree: { rootId, ownerSessionId, createdAt: at, closedAt: null, reportedAt: null },
      nodes: {
        [rootId]: {
          id: rootId, rootId, parentId: null, title: 'Historical', description: 'd',
          unit: null, weight: 1, roundMs: null, executorSessionId: null,
          context: [], corrections: [], correctionsDeliveredUpTo: 0, analysisNotes: [], analysisAttempt: 0,
          analysisAuthor: null,
          status: 'done', createdAt: at, depth: 1, claimedBy: null, claimedAt: at, attempts: 1,
          dispatchedAt: at, endedAt: at + 500,
          failures: 0, spawnFailures: 0, parkedWorker: null, lastWorkerId: null, dispatchBaseline: null,
          progressAt: at, activityAt: at + 500, stalls: 0, hungCount: 0, stalledNotifiedAt: null,
          result: 'done', hasResult: true, resultReadAt: null, resultRef: null, resultHint: null,
          children: [], updatedAt: at + 500,
        },
      },
    }
    // ABSENT, not merely null: `seedDocuments` bypasses the domain schema on purpose, so this is the
    // one place a record an earlier build wrote can be modelled exactly (the schema's
    // `nullable().default(null)` is what `domain.spec.ts` pins). The two dispatch clocks belong to
    // that same vintage: an earlier build wrote neither.
    delete (document.nodes[rootId] as unknown as Record<string, unknown>)['executorSessionId']
    delete (document.nodes[rootId] as unknown as Record<string, unknown>)['dispatchedAt']
    delete (document.nodes[rootId] as unknown as Record<string, unknown>)['endedAt']
    return document
  }

  /** List one stored session as the query engine would, and give it a log that ran `nodeId`. */
  function storeWorker(
    mounted: Awaited<ReturnType<typeof mount>>,
    id: string,
    options: { parent?: string; createdAt?: number; nodeId?: string; text?: string } = {},
  ): void {
    const createdAt = options.createdAt ?? 1_200
    mounted.listedSessions.push({
      header: { id, origin: 'subagent', delegationDepth: 1, parentSession: options.parent ?? mounted.owner.id, createdAt },
      live: false,
    })
    const body = options.text ?? (options.nodeId === undefined ? '本任务：\nid: 00000000\n' : `本任务：\nid: ${options.nodeId}\n标题: x`)
    mounted.workerSessions.set(id, [{ time: createdAt + 10, text: body }])
  }

  it('answers from a record that already has a handle without reading a single session', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Live')
    await mounted.flush()
    const claim = String(mounted.dispatched[0]?.childId ?? '')

    const resolved = await mounted.host.resolveExecutorSession({ sessionId: mounted.owner.id, nodeId: root })
    expect(resolved).toEqual({ sessionId: claim, status: 'resolved' })
    // Zero I/O: neither the corpus listing nor any event scan was touched.
    expect(mounted.sessionListCalls()).toBe(0)
    expect(mounted.sessionLogReads).toEqual([])
  })

  it('finds a historical executor from the stored logs and WRITES the handle back', async () => {
    const mounted = await mount({ seedDocuments: [historicalDocument('aaaa1111', 'owner')] })
    storeWorker(mounted, 'mission-1234abcd', { nodeId: 'aaaa1111' })

    const resolved = await mounted.host.resolveExecutorSession({ sessionId: 'owner', nodeId: 'aaaa1111' })
    expect(resolved).toEqual({ sessionId: 'mission-1234abcd', status: 'resolved' })
    // Persisted, not just in memory: the panel would otherwise pay for the lookup on every open.
    expect(mounted.nodeFor('aaaa1111')?.executorSessionId).toBe('mission-1234abcd')
    expect(mounted.stored('aaaa1111')?.nodes['aaaa1111']?.executorSessionId).toBe('mission-1234abcd')

    // The second click answers from the record: no listing, no log read.
    const again = await mounted.host.resolveExecutorSession({ sessionId: 'owner', nodeId: 'aaaa1111' })
    expect(again).toEqual({ sessionId: 'mission-1234abcd', status: 'resolved' })
    expect(mounted.sessionListCalls()).toBe(1)
    expect(mounted.sessionLogReads).toEqual(['mission-1234abcd'])
    // The filter shape the fake received was the real `{kind:'time'|'text'}` union (W20): a tuple
    // would be recorded here and fail this case instead of answering `not-found` quietly.
    expect(mounted.sessionFilterViolations).toEqual([])
  })

  it('reads ONLY the candidates that pass the parent / id-shape / time filters', async () => {
    const mounted = await mount({ seedDocuments: [historicalDocument('bbbb2222', 'owner', 1_000)] })
    storeWorker(mounted, 'mission-aaaaaaaa', { parent: 'someone-else', createdAt: 1_100, nodeId: 'bbbb2222' })
    storeWorker(mounted, 'subagent-not-ours', { createdAt: 1_100, nodeId: 'bbbb2222' })
    storeWorker(mounted, 'mission-bbbbbbbb', { createdAt: 9_999_999, nodeId: 'bbbb2222' })
    storeWorker(mounted, 'mission-cccccccc', { createdAt: 1_100, nodeId: 'bbbb2222' })

    const resolved = await mounted.host.resolveExecutorSession({ sessionId: 'owner', nodeId: 'bbbb2222' })
    expect(resolved).toMatchObject({ status: 'resolved', sessionId: 'mission-cccccccc' })
    expect(mounted.sessionLogReads).toEqual(['mission-cccccccc'])
    expect(mounted.sessionFilterViolations).toEqual([])
  })

  it('separates "找不到" from "never dispatched"', async () => {
    // ① Dispatched once (attempts 1) but its session is gone: the panel must say it looked and failed.
    const historical = await mount({ seedDocuments: [historicalDocument('cccc3333', 'owner')] })
    expect(await historical.host.resolveExecutorSession({ sessionId: 'owner', nodeId: 'cccc3333' }))
      .toEqual({ status: 'not-found' })

    // ② Never dispatched at all (a queued node): nothing was ever run, so nothing is looked up.
    const queued = await mount({ pluginConfig: { capacity: 1 } })
    const first = await callTool(queued, 'create_mission', { title: 'first', description: 'd', analysis: [] }, queued.owner)
    expect(first.ok).toBe(true)
    const second = await callTool(queued, 'create_mission', { title: 'queued', description: 'd', analysis: [] }, queued.owner)
    const queuedId = String(second.data?.['root_id'] ?? '')
    expect(await queued.host.resolveExecutorSession({ sessionId: queued.owner.id, nodeId: queuedId }))
      .toEqual({ status: 'never-dispatched' })
    expect(queued.sessionListCalls()).toBe(0)
  })

  it('says the host cannot look a session up when sessionQuery is absent, and never throws', async () => {
    const mounted = await mount({ noSessionQuery: true, seedDocuments: [historicalDocument('dddd4444', 'owner')] })
    const resolved = await mounted.host.resolveExecutorSession({ sessionId: 'owner', nodeId: 'dddd4444' })
    expect(resolved.status).toBe('unsupported')
    expect(resolved.error ?? '').toContain('无法查找')
    // The panel is untouched by the absence: the tree still renders.
    expect(mounted.host.treesForSession('owner')).toHaveLength(1)
  })

  it('is loading ZERO cost: mount, snapshot, detail, list_missions and mission_result read no session', async () => {
    // W18's central invariant. The lookup is only ever invited by a click, so every path a page load
    // or a model call takes must touch no session log — and no corpus listing either (the listing is
    // the cheaper half, and it is still I/O the panel must not pay per render).
    const mounted = await mount({ seedDocuments: [historicalDocument('ffff6666', 'owner')] })
    storeWorker(mounted, 'mission-feedfeed', { nodeId: 'ffff6666' })

    expect(await mounted.host.snapshot({ sessionId: 'owner' })).toBeDefined()
    expect(await mounted.host.detail({ sessionId: 'owner', nodeId: 'ffff6666' })).toBeDefined()
    await callTool(mounted, 'list_missions', {}, mounted.owner)
    await callTool(mounted, 'mission_result', { node_id: 'ffff6666' }, mounted.owner)

    expect(mounted.sessionListCalls()).toBe(0)
    expect(mounted.sessionLogReads).toEqual([])
    // Non-vacuity: the fixtures WOULD have been found, so the count above is not zero by accident.
    expect(await mounted.host.resolveExecutorSession({ sessionId: 'owner', nodeId: 'ffff6666' }))
      .toMatchObject({ status: 'resolved', sessionId: 'mission-feedfeed' })
    expect(mounted.sessionLogReads).toEqual(['mission-feedfeed'])
    expect(mounted.sessionFilterViolations).toEqual([])
  })

  it('refuses another session\'s node without reading anything', async () => {
    const mounted = await mount({ seedDocuments: [historicalDocument('eeee5555', 'owner')] })
    const resolved = await mounted.host.resolveExecutorSession({ sessionId: 'somebody-else', nodeId: 'eeee5555' })
    expect(resolved.status).toBe('not-found')
    expect(mounted.sessionListCalls()).toBe(0)
    expect(mounted.nodeFor('eeee5555')?.executorSessionId).toBeNull()
  })
})

describe('a reused prerequisite stays visible as a dependency', () => {  it('lists it among the depending node children, and in the snapshot', async () => {
    // The bug this pins: a node that reuses a prerequisite was born under ANOTHER parent, so
    // rendering or reading by `parentId` showed an aggregate as a leaf — waiting on nothing.
    const mounted = await mount()
    const created = await callTool(mounted, 'create_mission', { title: 'T', description: 'd', analysis: [] }, mounted.owner)
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
  it('returns the mission\'s own content plus what its children reported', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    const rootWorker = worker(mounted)
    const split = await noteAndSplit(mounted, root, [{ title: 'sub', description: 'do the part', context: ['why'] }], rootWorker)
    const childId = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
    await callTool(
      mounted,
      'submit_mission',
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
      await callTool(mounted, 'cancel_mission', { root_id: root }, mounted.owner)
    })
    // One frame for opening (the current revision) and at least one for the change.
    expect(during.length).toBeGreaterThanOrEqual(2)
    expect(during.at(-1)).toBeGreaterThan(during[0] ?? -1)
  })

  it('frames a change that produced no session event at all', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await callTool(mounted, 'cancel_mission', { root_id: root }, mounted.owner)

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
      await callTool(mounted, 'cancel_mission', { root_id: root }, mounted.owner)
    })
    // Only the opening frame: a panel must never be woken by another session's tree.
    expect(seen).toHaveLength(1)
  })
})

describe('deleting a mission tree from the 任务 view', () => {
  it('refuses a tree that is still running, and points at cancel_mission', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await mounted.flush()

    // `createTree` dispatches, so the tree is live: the panel's button is disabled for
    // it, and the host refuses anyway rather than trusting the caller.
    const refused = await mounted.host.delete({ sessionId: mounted.owner.id, rootId: root })
    expect(refused.deleted).toEqual([])
    expect(refused.error).toContain('只有已结束的任务能删除')
    expect(refused.error).toContain('cancel_mission')
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees).toHaveLength(1)
  })

  it('deletes the whole tree, every node of it', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    const split = await noteAndSplit(mounted, root, [{ title: 'sub', description: 'd', context: [] }], worker(mounted))
    const childId = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
    await callTool(mounted, 'cancel_mission', { root_id: root }, mounted.owner)

    // The unit is the tree: naming the root removes the children with it.
    const deleted = await mounted.host.delete({ sessionId: mounted.owner.id, rootId: root })
    expect(deleted.error).toBeUndefined()
    expect([...deleted.deleted].sort()).toEqual([root, childId].sort())
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees).toHaveLength(0)
  })

  it('deletes an archived tree, so finishing and deleting stay different gestures', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await callTool(mounted, 'cancel_mission', { root_id: root }, mounted.owner)
    await callTool(mounted, 'mission_result', { node_id: root }, mounted.owner)
    await callTool(mounted, 'finish_mission', { root_id: root }, mounted.owner)
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees[0]?.closedAt).not.toBeNull()

    const deleted = await mounted.host.delete({ sessionId: mounted.owner.id, rootId: root })
    expect(deleted.error).toBeUndefined()
    expect((await mounted.host.snapshot({ sessionId: mounted.owner.id })).trees).toHaveLength(0)
  })

  it('refuses a session that does not own the tree', async () => {
    const mounted = await mount()
    const root = await createTree(mounted, 'Ship it')
    await callTool(mounted, 'cancel_mission', { root_id: root }, mounted.owner)

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
