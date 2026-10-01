/**
 * The pre-step gate: what reaches the model, and what an engine wake does.
 *
 * These are the contracts the mount smoke could not see: it stubbed `next()` as
 * an empty enter decision, so a hook that dropped every runtime-context snapshot
 * (and every wake with it) looked correct.
 */
import { describe, expect, it } from 'vitest'
import { callTool, agent, loopNext, message, mount, SNAPSHOT_SOURCE } from './mount.js'

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
    await withTree(mounted)
    const claim = String(mounted.dispatched[0]?.childId ?? '')
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

  it('drops a notice-only batch without ending the turn it interrupted', async () => {
    // A rejection here is what killed every tool-calling turn: the notice arrives
    // while the model still has its own tool result to read.
    const mounted = await mount()
    await withTree(mounted)
    const claim = String(mounted.dispatched[0]?.childId ?? '')
    const decision = await mounted.preStep({
      agent: mounted.owner,
      messages: [notice(claim)],
      next: loopNext([notice(claim)]),
    })
    expect(decision.kind).toBe('enter')
    expect(decision.messages).toEqual([])
  })
})

describe('the empty batch of a continuing turn', () => {
  it('enters with nothing rather than refusing the step', async () => {
    // The loop proposes an empty batch at every step boundary after the first.
    // Refusing it ends the turn, so the model never reads its own tool result —
    // the "calling a tool ends the conversation" failure.
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
