/**
 * The change delta of a cold wake — and the point at which the engine stops continuing the session
 * and starts a fresh executor instead.
 *
 * The unit tests prove the arithmetic (core `continuation.spec.ts`) and the tree's side (who stamps a
 * baseline, who spends a handle). This file proves the WIRING through the real plugin:
 *
 * - the host stamps the baseline at the moment it hands a session its prompt, so a later wake can
 *   subtract it;
 * - a wake renders what changed since that session last read the mission;
 * - drift that is MATERIAL (an unread correction, a judgement written by ANOTHER session) declines
 *   the continuation and lets the ordinary fresh path take over — which reads every correction and
 *   every note, so nothing is lost but the session's own history;
 * - a record with no baseline (written before the field existed) still continues, with an honest
 *   caveat instead of a fabricated "nothing changed";
 * - a PARKED parent, whose children being terminal is the trigger of its wake and not drift, is
 *   still woken rather than replaced. That is the regression this feature is most likely to break:
 *   counting the engine's own trigger as "the mission changed" would make every parked wake spawn a
 *   fresh executor, silently deleting the previous generation's feature.
 */
import { describe, expect, it } from 'vitest'
import { isMaterialChange } from '@avantf/mission-core'
import { callTool, executorFor, mount } from './mount.js'
import { WORKER, parkedRoot, sealedTree, settle } from './fixtures.js'

describe('the baseline a prompt leaves behind', () => {
  it('stamps what the session was shown, so the next generation can subtract it', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'T', description: 'd', analysis: [] },
      mounted.owner,
    )
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()
    await settle()

    const node = mounted.nodeFor(root)
    expect(node?.dispatchBaseline).not.toBeNull()
    expect(node?.dispatchBaseline?.attempts).toBe(1)
    expect(node?.dispatchBaseline?.notes).toBe(0)
    expect(node?.dispatchBaseline?.corrections).toBe(0)
    expect(node?.dispatchBaseline?.terminalChildren).toBe(0)

    // The durable record carries it too, which is the only reason a RESTART can subtract anything.
    expect(mounted.stored(root)?.nodes[root]?.dispatchBaseline?.attempts).toBe(1)
  })

  it('makes a restart tell the resumed session there is nothing new, not that it cannot tell', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'T', description: 'd', analysis: [] },
      mounted.owner,
    )
    const root = String(created.data?.root_id ?? '')
    await mounted.flush()
    await settle()
    const document = mounted.stored(root)
    if (document === undefined) throw new Error('the first generation persisted nothing')

    // A faithful restart: the document the host itself wrote is what the next process opens.
    const restarted = await mount({ seedDocuments: [document] })
    await restarted.flush()

    // Continued in the same session, with NO delta and NO caveat: the baseline the host stamped is
    // exactly what this session's prompt showed, so it is owed nothing.
    expect(restarted.sent).toHaveLength(1)
    expect(restarted.dispatched).toHaveLength(0)
    const text = restarted.sent[0]?.text ?? ''
    expect(text).toContain('这是本任务第 2 次执行')
    expect(text).not.toContain('自你上次执行后')
    expect(text).not.toContain('无法确定')
  })
})

describe('what a wake tells the session it is resuming', () => {
  it('reports the notes the interrupted round had already recorded', async () => {
    const fixture = await sealedTree(WORKER)
    await fixture.stamp()
    await fixture.note('缺一个前置事实：先拿到调用点清单')
    const mounted = await mount({ seedDocuments: [fixture.document()] })

    await mounted.flush()

    // Nothing material moved: the note belongs to this very dispatch, so the session is continued.
    expect(mounted.sent).toHaveLength(1)
    expect(mounted.sent[0]?.targetId).toBe(WORKER)
    expect(mounted.dispatched).toHaveLength(0)

    const text = mounted.sent[0]?.text ?? ''
    expect(text).toContain('这是本任务第 2 次执行')
    expect(text).toContain('自你上次执行后：')
    expect(text).toContain('新增执行笔记 1 条：缺一个前置事实：先拿到调用点清单')
  })

  it('answers an unknown baseline with an honest caveat, and continues anyway', async () => {
    const fixture = await sealedTree(WORKER)
    await fixture.correct('没人读过这条')
    // Never stamped: a record written before baselines existed.
    const mounted = await mount({ seedDocuments: [fixture.legacyDocument()] })
    const root = fixture.rootId

    await mounted.flush()

    // The conservative choice is to CONTINUE and say so — not to throw a session away over a
    // one-time migration gap, and not to pretend the mission is unchanged.
    expect(mounted.sent).toHaveLength(1)
    expect(mounted.sent[0]?.targetId).toBe(WORKER)
    expect(mounted.dispatched).toHaveLength(0)
    const text = mounted.sent[0]?.text ?? ''
    expect(text).toContain('自你上次执行后的变化无法确定')
    expect(text).toContain('以当前视图为准')
    expect(text).not.toContain('新增执行笔记')
    // The correction it carries is still put in front of that session.
    expect(text).toContain('没人读过这条')
    expect(mounted.nodeFor(root)?.claimedBy).toBe(WORKER)
  })
})

describe('drift large enough to stop continuing', () => {
  it('declines on an unread correction and replaces the session exactly once', async () => {
    const fixture = await sealedTree(WORKER)
    // Stamped BEFORE the correction: the session's prompt did not carry it.
    await fixture.stamp()
    await fixture.correct('改成先做 C')
    const mounted = await mount({ seedDocuments: [fixture.document()] })
    const root = fixture.rootId

    await mounted.flush()

    // No delivery to the recorded session at all: this is not a refused wake followed by a fallback
    // (which would count one adoption plus one dispatch); the address is spent before any delivery,
    // so there is exactly one executor for the node and no window for a second one.
    expect(mounted.sent).toHaveLength(0)
    expect(mounted.dispatched).toHaveLength(1)

    const prompt = mounted.dispatched[0]?.prompt ?? ''
    // A fresh executor has read nothing, so it sees EVERY correction...
    expect(prompt).toContain('改成先做 C')
    expect(prompt).toContain('纠偏')
    // ...and no delta: "since you last executed" is a lie for a session that never executed.
    expect(prompt).not.toContain('自你上次执行后')
    expect(prompt).not.toContain('无法确定')

    const node = mounted.nodeFor(root)
    expect(node?.claimedBy).toBe(mounted.dispatched[0]?.childId)
    // The handle is spent, not left for the next pass to re-decide.
    expect(node?.lastWorkerId).toBeNull()
    // Declining is not a failure and starts no cooldown (same contract as `wake-failed`).
    expect(node?.failures).toBe(0)
    expect(node?.spawnFailures).toBe(0)
    expect(node?.status).toBe('running')
  })

  it('continues when the latest judgement is the session’s OWN, even after a re-dispatch', async () => {
    const fixture = await sealedTree(WORKER)
    await fixture.note('上一轮的结论：先换掉那个调用点')
    // A second round on the same node, and its baseline: the note's GENERATION is now behind the
    // dispatch this session's prompt was built under, but its AUTHOR is still this very session.
    await fixture.redispatch(WORKER)
    await fixture.stamp()
    const mounted = await mount({ seedDocuments: [fixture.document()] })

    await mounted.flush()

    // Identity beats the generation: this is the aggregate-parent shape N3 was about, where reading
    // the session's own surviving note as "somebody else wrote here" throws away the executor with
    // the most context on the node. It is continued...
    expect(mounted.sent).toHaveLength(1)
    expect(mounted.sent[0]?.targetId).toBe(WORKER)
    expect(mounted.dispatched).toHaveLength(0)
    // ...and the note still reaches it, in the current mission block.
    expect(mounted.sent[0]?.text ?? '').toContain('上一轮的结论：先换掉那个调用点')
  })

  it('declines when the latest judgement was written by ANOTHER session', async () => {
    const fixture = await sealedTree(WORKER)
    // The baseline belongs to the session that has gone...
    await fixture.stamp()
    // ...and a DIFFERENT executor took the node over and wrote the latest judgement.
    await fixture.redispatch('mission-bbbb2222')
    await fixture.noteAs('mission-bbbb2222', '别人的结论：这条路走不通')
    const mounted = await mount({ seedDocuments: [fixture.document()] })

    await mounted.flush()

    expect(mounted.sent).toHaveLength(0)
    expect(mounted.dispatched).toHaveLength(1)
    // The fresh executor reads the judgement its predecessor recorded.
    expect(mounted.dispatched[0]?.prompt ?? '').toContain('别人的结论：这条路走不通')
  })
})

describe('a parked wake is not drift', () => {
  it('wakes a parent whose children are all terminal instead of replacing it', async () => {
    // The engine's OWN trigger for this wake is "every child reached a terminal state". A judgement
    // that counted that as "the mission changed" would decline here and spawn a fresh executor, and
    // the feature `session-continuation.spec.ts` covers would be dead code in production.
    const mounted = await mount()
    const { root, rootWorker } = await parkedRoot(mounted)
    expect(mounted.host.nodeFor(root)?.status).toBe('ready')
    expect(mounted.parkedWorkerOf(root)).toBe(rootWorker.id)

    // The trigger IS in the delta — this is the strongest possible temptation to call it drift, so
    // the pair of assertions below is what the regression rests on: the wake's own trigger is
    // visible, and the judgement still says "not material".
    const drift = mounted.host.continuationDeltaOf(root)
    expect(drift?.baselineKnown).toBe(true)
    expect(drift?.terminalChildren).toBe(1)
    expect(isMaterialChange(drift!)).toBe(false)

    await mounted.wake()

    expect(executorFor(mounted, root).id).toBe(rootWorker.id)
    expect(mounted.parkedWorkerOf(root)).toBeNull()
    // No second executor for this node: the only dispatch it ever had was the one that decomposed it.
    expect(mounted.dispatched.filter((entry) => entry.prompt.includes(`id: ${root}\n`))).toHaveLength(1)
    // And the round the wake opened is stamped, so a LATER cold wake of this parked session
    // subtracts from here rather than re-reporting its children's results as new.
    expect(mounted.nodeFor(root)?.dispatchBaseline?.attempts).toBe(2)
  })
})
