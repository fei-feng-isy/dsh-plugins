/**
 * The pre-step gate: what reaches the model, and what an engine wake does.
 *
 * These are the contracts the mount smoke could not see: it stubbed `next()` as
 * an empty enter decision, so a hook that dropped every runtime-context snapshot
 * (and every wake with it) looked correct.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  agent,
  callTool,
  executorFor,
  loopNext,
  message,
  mount,
  noteAndSplit,
  SNAPSHOT_SOURCE,
} from './mount.js'
import { parkedRoot, settle, WORKER } from './fixtures.js'

const wake = (): ReturnType<typeof message> =>
  message('w', { kind: 'plugin:avantf-mission' }, 'Work tree n1 reached done.')

const notice = (childId: string): ReturnType<typeof message> =>
  message('n', { kind: 'subagent-settled', form: 'notice', summary: 'mission finished', senderSessionId: childId })

const snapshot = (): ReturnType<typeof message> => message('s', SNAPSHOT_SOURCE, 'Work tree: 1 finished.')

/** Own a tree, so the hook actually engages (it only gates a session it acts for). */
async function withTree(mounted: Awaited<ReturnType<typeof mount>>): Promise<string> {
  const created = await callTool(
    mounted,
    'create_mission',
    { title: 'T', description: 'd', analysis: [] },
    mounted.owner,
  )
  return String(created.data?.root_id ?? '')
}

describe('runtime context', () => {
  it('keeps the snapshot on a plain user turn', async () => {
    // The bug this pins: rebuilding the decision from the payload `messages`
    // drops the snapshot, and with it the guidance of every plugin.
    const mounted = await mount()
    await withTree(mounted)
    const user = message('u1', { kind: 'user' }, 'do the thing')
    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [user],
      next: loopNext([user], snapshot()),
    })
    expect(decision.kind).toBe('enter')
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['u1', 's'])
  })

  it('leaves an agent with no trees completely alone', async () => {
    const mounted = await mount()
    const stranger = agent('someone-else')
    const user = message('u1', { kind: 'user' })
    const decision = await mounted.preStep({
      agent: stranger,
      messages: [user],
      next: loopNext([user], snapshot()),
    })
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['u1', 's'])
  })
})

describe('engine wake', () => {
  it('runs a turn when there is mission, dropping the wake itself', async () => {
    const mounted = await mount()
    const rootId = await withTree(mounted)
    // A failed root is mission for the owner: it must be reported, then retired.
    await callTool(mounted, 'cancel_mission', { root_id: rootId }, mounted.owner)

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [wake()],
      next: loopNext([wake()], snapshot()),
    })
    // The guidance snapshot is what the model acts on (§6.5); the wake is signal.
    expect(decision.kind).toBe('enter')
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['s'])
  })

  it('keeps the wake as the carrier when no snapshot accompanies it', async () => {
    // An empty batch spends no model call, so a wake with nothing else in the
    // batch must survive to open the turn.
    const mounted = await mount()
    const rootId = await withTree(mounted)
    await callTool(mounted, 'cancel_mission', { root_id: rootId }, mounted.owner)

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [wake()],
      next: loopNext([wake()]),
    })
    expect(decision.kind).toBe('enter')
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['w'])
  })

  it('keeps a wake-only batch queued behind mission, not in front of it', async () => {
    // A claim takes one next-turn item, so a message the user queued behind this
    // wake is still pending. Ending the turn here would strand it: the loop stops
    // the driver on a step that does not open and never re-reads the inbox.
    const mounted = await mount()
    const rootId = await withTree(mounted)
    await callTool(mounted, 'cancel_mission', { root_id: rootId }, mounted.owner)
    const user = message('u1', { kind: 'user' }, '还在吗？')
    mounted.owner.inbox.append('next-turn', user)

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [wake()],
      next: loopNext([wake()]),
    })

    expect(decision.kind).toBe('enter')
    // The wake still carries the tree state; the queued message rides with it, and
    // leaves the inbox so the step cannot deliver it twice.
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['w', 'u1'])
    expect(mounted.owner.inbox.nextTurn).toEqual([])
  })

  it('drops the wake with nothing to act on, spending no model call', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'T', description: 'd', analysis: [] },
      mounted.owner,
    )
    const rootId = String(created.data?.root_id ?? '')

    // Retire the tree: cancel, read the outcome, close it — the wake now points
    // at nothing, and a turn would be spent on an empty state.
    await callTool(mounted, 'cancel_mission', { root_id: rootId }, mounted.owner)
    await callTool(mounted, 'mission_result', { node_id: rootId }, mounted.owner)
    expect((await callTool(mounted, 'finish_mission', { root_id: rootId }, mounted.owner)).ok).toBe(true)

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [wake()],
      next: loopNext([wake()]),
    })
    // Emptied, not refused: an empty first batch opens no step either way, and a
    // refusal would end a turn that still had queued input behind it.
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toEqual([])
  })

  it('never lets a wake drag a user message out of the batch', async () => {
    const mounted = await mount()
    await withTree(mounted)
    const user = message('u1', { kind: 'user' }, 'and another thing')
    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [user, wake()],
      next: loopNext([user, wake()], snapshot()),
    })
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['u1', 's'])
  })
})

/**
 * A tree whose ROOT is blocked on a still-live child while a SIBLING child is already `done` — the
 * state a settlement notice arrives in when only a middle node settled. Root not terminal, nothing
 * parked-ready (the parked root is still `blocked`, not `ready`), nothing troubled.
 */
async function withSettledSibling(
  mounted: Awaited<ReturnType<typeof mount>>,
): Promise<{ root: string; settled: string; running: string }> {
  const created = await callTool(
    mounted,
    'create_mission',
    { title: 'T', description: 'd', analysis: ['because'] },
    mounted.owner,
  )
  const root = String(created.data?.root_id ?? '')
  await mounted.flush()
  await settle()
  const rootWorker = agent(String(mounted.dispatched[0]?.childId ?? ''))
  const split = await noteAndSplit(
    mounted,
    root,
    [
      { title: 'a', description: 'd', context: ['why'] },
      { title: 'b', description: 'd', context: ['why'] },
    ],
    rootWorker,
  )
  const [settled, running] = (split.data?.['created'] as string[] | undefined) ?? []
  if (settled === undefined || running === undefined) throw new Error('the split did not create two children')
  await mounted.flush()
  await callTool(
    mounted,
    'submit_mission',
    { node_id: settled, result: 'child a conclusion' },
    executorFor(mounted, settled),
  )
  await mounted.flush()
  return { root, settled, running }
}

describe('worker settlement notices', () => {
  it('drops the notice of its own worker', async () => {
    const mounted = await mount()
    await withTree(mounted)
    const claim = String(mounted.dispatched[0]?.childId ?? '')
    expect(claim).not.toBe('')

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [notice(claim)],
      next: loopNext([notice(claim)], snapshot()),
    })
    // The notice is gone; the snapshot is what carries state.
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['s'])
  })

  it("keeps another agent's child settling", async () => {
    const mounted = await mount()
    const foreign = notice('some-other-child')
    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [foreign],
      next: loopNext([foreign]),
    })
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['n'])
  })

  it('discards a notice still queued behind the claimed batch', async () => {
    // The claim takes one next-turn item, so a settlement that arrived while this
    // turn ran sits in the queue — in front of anything the user queued after it.
    const mounted = await mount()
    await withTree(mounted)
    const claim = String(mounted.dispatched[0]?.childId ?? '')
    mounted.owner.inbox.append('next-turn', notice(claim))

    await mounted.preStep({
      agent: mounted.owner,
      messages: [wake()],
      next: loopNext([wake()]),
    })

    expect(mounted.owner.inbox.nextTurn).toEqual([])
  })

  it('serves a user message queued behind a notice instead of stranding it', async () => {
    const mounted = await mount()
    const { settled } = await withSettledSibling(mounted)
    const claim = executorFor(mounted, settled).id
    const user = message('u1', { kind: 'user' }, '你能继续吗？')
    mounted.owner.inbox.append('next-turn', user)

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [notice(claim)],
      next: loopNext([notice(claim)]),
    })

    expect(decision.kind).toBe('enter')
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['u1'])
    expect(mounted.owner.inbox.nextTurn).toEqual([])
  })
})

describe('the settlement-notice batch that must not reach the model', () => {
  /**
   * A notice-only batch, the tree holding nothing only the owner can act on. In a live profile the
   * host's `dsh-time-context` listener appends its note AFTER this decision, so returning an empty
   * batch bought a model call: the decision has to be `reject`, which that listener honors.
   */
  it('refuses the turn when only a middle node settled', async () => {
    const mounted = await mount()
    const { settled } = await withSettledSibling(mounted)
    const claim = executorFor(mounted, settled).id
    expect(claim).not.toBe('')
    expect(mounted.host.admitStep(mounted.owner as never).admit).toBe(false)

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [notice(claim)],
      next: loopNext([notice(claim)]),
    })

    expect(decision.kind).toBe('reject')
    expect(decision.messages).toBeUndefined()
  })

  it('admits the same notice-only batch once the ROOT is terminal', async () => {
    // The root's own end is exactly what the owner must act on: read `mission_result`, then finish.
    const mounted = await mount()
    const rootId = await withTree(mounted)
    await callTool(mounted, 'cancel_mission', { root_id: rootId }, mounted.owner)
    const claim = String(mounted.dispatched[0]?.childId ?? '')

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [notice(claim)],
      next: loopNext([notice(claim)]),
    })

    expect(decision.kind).toBe('enter')
  })

  it('admits a notice-only batch while a parked executor needs the owner to wake it', async () => {
    // The third owner-only state: `nextDispatchable` excludes a parked node, so the owner's step is
    // the only place its session can be adopted and woken (pre-step ⓪).
    const mounted = await mount()
    const { root } = await parkedRoot(mounted)
    expect(mounted.host.admitStep(mounted.owner as never).admit).toBe(true)
    const claim = String(mounted.executorOf.get(root)?.sessionId ?? '')

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [notice(claim)],
      next: loopNext([notice(claim)]),
    })

    expect(decision.kind).toBe('enter')
  })

  it('admits a notice-only batch while the tree is troubled', async () => {
    // Trouble is the owner's call (`adjust_mission` / `cancel_mission`), so tightening the predicate
    // must not start refusing it. Only `Date` is faked: the counters and floors are the engine's.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const mounted = await mount({ failStart: true })
      mounted.makeLive('owner')
      const created = await callTool(
        mounted,
        'create_mission',
        { title: 'T', description: 'd', analysis: [] },
        mounted.owner,
      )
      const rootId = String(created.data?.root_id ?? '')
      let guard = 0
      while ((mounted.nodeFor(rootId)?.spawnFailures ?? 0) < 4 && guard < 10) {
        guard += 1
        vi.setSystemTime(Date.now() + 11 * 60_000)
        await mounted.flush()
      }
      expect(mounted.nodeFor(rootId)?.spawnFailures).toBeGreaterThanOrEqual(4)
      expect(mounted.host.admitStep(mounted.owner as never).admit).toBe(true)

      const decision = await mounted.preStep({
        agent: mounted.owner,
        messages: [notice(WORKER)],
        next: loopNext([notice(WORKER)]),
      })

      expect(decision.kind).toBe('enter')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never refuses a batch that also carries a user message', async () => {
    const mounted = await mount()
    const { settled } = await withSettledSibling(mounted)
    const claim = executorFor(mounted, settled).id
    const user = message('u1', { kind: 'user' }, 'and another thing')

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [notice(claim), user],
      next: loopNext([notice(claim), user]),
    })

    expect(decision.kind).toBe('enter')
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['u1'])
  })

  it('never refuses a foreign subagent notice (UUID sender)', async () => {
    // An ordinary subagent's session id is `spec.childId ?? randomUUID()`, which cannot match mission's    // `^mission-[0-9a-f]{8}$` claim shape — so it is not "ours" and must arrive verbatim.
    const mounted = await mount()
    await withSettledSibling(mounted)
    const foreign = notice('3f2b0c1e-5d4a-4b3c-9e8f-1a2b3c4d5e6f')

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [foreign],
      next: loopNext([foreign]),
    })

    expect(decision.kind).toBe('enter')
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['n'])
  })

  it('never refuses a notice claimed at a LATER step of a running turn', async () => {
    // A notice can arrive as steering while the model still has its own tool result to read. The tool
    // result is a SESSION event, not a claimed message, so this batch looks notice-only — but
    // refusing it would end the turn before the model reads that result. Emptying it is correct: the
    // emptied batch still runs the step, and the notice itself never reaches the model.
    const mounted = await mount()
    const { settled } = await withSettledSibling(mounted)
    const claim = executorFor(mounted, settled).id

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [notice(claim)],
      next: loopNext([notice(claim)]),
      step: 2,
    })

    expect(decision.kind).toBe('enter')
    expect(decision.messages).toEqual([])
  })
})

describe('the empty batch of a continuing turn', () => {
  it('enters with nothing at a LATER step rather than refusing the step', async () => {
    // The loop proposes an empty batch at every step boundary after the first — a tool result lands
    // in the session, not in a claimed inbox message. Refusing it ends the turn, so the model never
    // reads its own tool result: the "calling a tool ends the conversation" failure.
    const mounted = await mount()
    await withTree(mounted)
    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [],
      next: loopNext([]),
      step: 2,
    })
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toEqual([])
  })

  it('enters with nothing at the turn\'s first step too (no claimed batch)', async () => {
    // Nothing was CLAIMED, so this is not a notice-only turn: the refusal is reserved for a batch
    // that actually carried our own settlement notices. An empty first batch opens no step either
    // way, and `reject` would skip the loop's inbox re-read.
    const mounted = await mount()
    await withTree(mounted)
    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [],
      next: loopNext([]),
    })
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toEqual([])
  })

  it('does not end a turn while a queued message is still waiting', async () => {
    const mounted = await mount()
    await withTree(mounted)
    const user = message('u1', { kind: 'user' }, '继续')
    mounted.owner.inbox.append('next-turn', user)

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [],
      next: loopNext([]),
    })

    expect(decision.messages?.map((entry) => entry.id)).toEqual(['u1'])
    expect(mounted.owner.inbox.nextTurn).toEqual([])
  })

  it('leaves an unrelated session alone', async () => {
    const mounted = await mount()
    const stranger = agent('someone-else')
    const decision = await mounted.preStep({
      agent: stranger,
      messages: [],
      next: loopNext([]),
    })
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toEqual([])
  })
})

describe('the final state the owner declares', () => {
  /**
   * Retire a tree the way its owner does: a terminal root, its result read, then
   * `finish_mission`. Every engine path is supposed to fall silent after that — the
   * wake decision included, which is the one the owner actually sees.
   */
  async function retire(mounted: Awaited<ReturnType<typeof mount>>, rootId: string): Promise<void> {
    await callTool(mounted, 'cancel_mission', { root_id: rootId }, mounted.owner)
    await callTool(mounted, 'mission_result', { node_id: rootId }, mounted.owner)
    const closed = await callTool(mounted, 'finish_mission', { root_id: rootId }, mounted.owner)
    expect(closed.ok).toBe(true)
  }

  it('sends nothing for a wake still in flight when the tree was closed', async () => {
    // The wake may already have been queued before `finish_mission` ran; a closed tree
    // is the owner's declaration that the mission is over, and "over" means no message
    // and no model call — not even for an engine signal that is already in hand.
    const mounted = await mount()
    const rootId = await withTree(mounted)
    await retire(mounted, rootId)

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [wake()],
      next: loopNext([wake()]),
    })
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toEqual([])
  })

  it('serves a queued user message even though the tree is closed', async () => {
    // Silence is about the engine's own messages. Input the user typed after the
    // close is not the engine talking, and must still reach the model.
    const mounted = await mount()
    const rootId = await withTree(mounted)
    await retire(mounted, rootId)
    mounted.owner.inbox.append('next-turn', message('u1', { kind: 'user' }, '再看一眼结果'))

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [wake()],
      next: loopNext([wake()]),
    })
    expect(decision.messages?.map((entry) => entry.id)).toEqual(['u1'])
  })
})

describe('the engine keeps at most one message queued', () => {
  const queuedWake = (id: string): ReturnType<typeof message> =>
    message(id, { kind: 'plugin:avantf-mission' }, 'Work tree n1 reached done.')

  const legacyQueuedWake = (id: string): ReturnType<typeof message> =>
    message(id, { kind: 'plugin', plugin: 'avantf-mission' }, 'Work tree n1 reached done.')

  it('still recognizes a wake written under the released plugin wrapper', async () => {
    // A session written before the producer-owned kind kept the wrapper until the migration rewrites
    // it; the gate must drain that pending wake rather than serve it as user text.
    const mounted = await mount()
    await withTree(mounted)
    mounted.owner.inbox.append('next-turn', legacyQueuedWake('w0'))

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [wake()],
      next: loopNext([wake()]),
    })

    expect(decision.messages).toEqual([])
    expect(mounted.owner.inbox.nextTurn).toEqual([])
  })

  it('drops a queued wake once the owner has nothing to act on', async () => {
    // The root is running, so the engine has no state for the owner: a wake left in
    // the queue is the engine's message sitting in someone's inbox, opening a turn
    // that can only be emptied again.
    const mounted = await mount()
    await withTree(mounted)
    mounted.owner.inbox.append('next-turn', queuedWake('w1'))

    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [wake()],
      next: loopNext([wake()]),
    })

    expect(decision.messages).toEqual([])
    expect(mounted.owner.inbox.nextTurn).toEqual([])
  })

  it('keeps exactly one queued wake while the owner still has mission', async () => {
    const mounted = await mount()
    const rootId = await withTree(mounted)
    await callTool(mounted, 'cancel_mission', { root_id: rootId }, mounted.owner)
    mounted.owner.inbox.append('next-turn', queuedWake('w1'))
    mounted.owner.inbox.append('next-turn', queuedWake('w2'))

    await mounted.preStep({
      agent: mounted.owner,
      messages: [wake()],
      next: loopNext([wake()]),
    })

    // One trigger is enough to open the turn that reads the guidance.
    expect(mounted.owner.inbox.nextTurn.map((entry) => entry.id)).toEqual(['w1'])
  })
})
