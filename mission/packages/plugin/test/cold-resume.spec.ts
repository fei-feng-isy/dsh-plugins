/**
 * Cold wake: a restart demoted a `running` node to `interrupted`, and the next dispatch tries to
 * CONTINUE the session that was working on it before it starts a fresh executor.
 *
 * The unit tests prove the tree's side (`reconcileOnOpen` parks the address, `adoptContinuation`
 * spends it, `wake-failed` charges nothing). This file proves the WIRING through the real plugin:
 *
 * - the engine offers a demoted node to the host's continuation hook BEFORE reserving a claim, so a
 *   successful cold resume starts nobody (`startContinuable` is never called);
 * - a delivery the runtime refuses degrades to the ordinary fresh path in the same pass, charging
 *   no budget and not triggering the spawn cooldown;
 * - the wake message tells the resumed session which execution this is and carries ONLY the
 *   corrections that session has not already been given — a fresh executor sees all of them;
 * - a record written before the continuation fields existed still loads, with the conservative
 *   reading (`lastWorkerId` recovered from the binding, `correctionsDeliveredUpTo = 0`);
 * - the idle session is guarded while the delivery is in flight, so no sweep reclaims the binding
 *   and no second executor is started on top of the cold resume.
 *
 * A "restart" is modelled faithfully but cheaply: a document produced by the real tree code is
 * seeded into the store before the plugin opens it (`mount({ seedDocuments })`), which is exactly
 * what `open()` reconciles after a real process restart. Those documents carry no dispatch baseline
 * — the fixture's throwaway tree never built a prompt — so these cases exercise the UNKNOWN-baseline
 * path, whose caveat is asserted in `continuation-delta.spec.ts`.
 */
import { describe, expect, it } from 'vitest'
import { mount } from './mount.js'
import { WORKER, asLegacy, persistedTree } from './fixtures.js'

describe('a restart continues the interrupted session', () => {
  it('delivers to the recorded worker first, and starts nobody when that lands', async () => {
    const document = await persistedTree({ workerId: WORKER })
    const mounted = await mount({ seedDocuments: [asLegacy(document)] })
    const root = document.tree.rootId

    // The restart demoted the binding, but the address survived it.
    expect(mounted.nodeFor(root)?.status).toBe('interrupted')
    expect(mounted.nodeFor(root)?.claimedBy).toBeNull()
    expect(mounted.nodeFor(root)?.lastWorkerId).toBe(WORKER)

    await mounted.flush()

    // One delivery, to that exact session, sent by the owner (the authorizing direct parent).
    expect(mounted.sent).toHaveLength(1)
    expect(mounted.sent[0]?.targetId).toBe(WORKER)
    expect(mounted.sent[0]?.from).toBe(mounted.owner.id)
    // No fresh executor: the whole point of the continuation.
    expect(mounted.dispatched).toHaveLength(0)

    const node = mounted.nodeFor(root)
    expect(node?.status).toBe('running')
    expect(node?.claimedBy).toBe(WORKER)
    expect(node?.attempts).toBe(2)
    expect(node?.lastWorkerId).toBeNull()

    // The notice that answers "a restart looks like starting over".
    const text = mounted.sent[0]?.text ?? ''
    expect(text).toContain('这是本任务第 2 次执行')
    expect(text).toContain('上一次执行被中断')
    expect(text).toContain('工作区')
    expect(text).toContain('本任务')
  })

  it('falls back to a fresh executor when the delivery is refused, charging no budget', async () => {
    const document = await persistedTree({
      workerId: WORKER,
      corrections: ['最早那条（已送达）', '第二条（未送达）'],
      deliveredUpTo: 1,
    })
    // `failSend` is the runtime refusing the resume (the session was cleaned, or is not resumable).
    const mounted = await mount({ seedDocuments: [document], failSend: true })
    const root = document.tree.rootId
    const before = mounted.nodeFor(root)
    expect(before?.failures).toBe(0)
    expect(before?.spawnFailures).toBe(0)

    await mounted.flush()

    const after = mounted.nodeFor(root)
    // `wake-failed` is neither a mission failure nor an infrastructure one.
    expect(after?.failures).toBe(before?.failures)
    expect(after?.spawnFailures).toBe(before?.spawnFailures)
    // `attempts` is the generation marker and never rolls back: the adoption and the fresh dispatch
    // both count.
    expect(after?.attempts).toBe((before?.attempts ?? 0) + 2)

    // The ordinary path took over, in the same pass: exactly one fresh worker.
    expect(mounted.dispatched).toHaveLength(1)
    const prompt = mounted.dispatched[0]?.prompt ?? ''
    // A brand-new executor has read NOTHING: both corrections are in its prompt, delivered or not.
    expect(prompt).toContain('最早那条（已送达）')
    expect(prompt).toContain('第二条（未送达）')
    expect(after?.claimedBy).toBe(mounted.dispatched[0]?.childId)
  })
})

describe('which corrections a wake carries', () => {
  it('carries only what the resumed session has not read, and never repeats a delivered one', async () => {
    const document = await persistedTree({
      workerId: WORKER,
      corrections: ['最早那条（已送达）', '第二条（未送达）'],
      deliveredUpTo: 1,
    })
    const mounted = await mount({ seedDocuments: [document] })
    const root = document.tree.rootId

    await mounted.flush()

    const text = mounted.sent[0]?.text ?? ''
    expect(text).toContain('第二条（未送达）')
    expect(text).toContain('纠偏')
    // The correction this very session was already given is not argued to it a second time.
    expect(text).not.toContain('最早那条（已送达）')

    // The mark is durable, and it now covers what this wake carried, so a LATER wake of the same
    // node cannot repeat it either.
    expect(mounted.nodeFor(root)?.correctionsDeliveredUpTo).toBe(2)
    expect(mounted.stored(root)?.nodes[root]?.correctionsDeliveredUpTo).toBe(2)
  })
})

describe('a record written before the continuation fields existed', () => {
  it('recovers the handle from the binding and reads a missing watermark as "nothing delivered"', async () => {
    const document = await persistedTree({
      workerId: WORKER,
      corrections: ['没人读过这条'],
      // Deliberately non-zero in the fixture: the legacy strip must make it read as 0 again.
      deliveredUpTo: 1,
    })
    const mounted = await mount({ seedDocuments: [asLegacy(document)] })
    const root = document.tree.rootId

    expect(mounted.nodeFor(root)?.lastWorkerId).toBe(WORKER)
    expect(mounted.nodeFor(root)?.correctionsDeliveredUpTo).toBe(0)

    await mounted.flush()
    // The conservative default carries the correction rather than silently skipping it.
    expect(mounted.sent[0]?.text ?? '').toContain('没人读过这条')
  })

  it('reads a never-dispatched legacy node as "no handle", and still spawns a fresh executor', async () => {
    const document = await persistedTree({
      workerId: WORKER,
      dispatched: false,
      corrections: ['全新任务的一条纠偏'],
    })
    const mounted = await mount({ seedDocuments: [asLegacy(document)] })
    const root = document.tree.rootId

    expect(mounted.nodeFor(root)?.lastWorkerId).toBeNull()
    expect(mounted.nodeFor(root)?.correctionsDeliveredUpTo).toBe(0)

    await mounted.flush()
    expect(mounted.dispatched).toHaveLength(1)
    expect(mounted.dispatched[0]?.prompt ?? '').toContain('全新任务的一条纠偏')
  })
})

describe('a cold resume must not run twice', () => {
  it('lets no sweep reclaim the binding the delivery is going into, and starts no second executor', async () => {
    // A resumed session is idle until the cold resume materializes it, so the liveness check alone
    // reads the freshly adopted binding as vanished. The sweep fired by anything at all in that
    // window used to reclaim it and re-dispatch — while the cold resume still landed.
    const document = await persistedTree({ workerId: WORKER })
    const mounted = await mount({ seedDocuments: [document], deferSend: true })
    const root = document.tree.rootId

    // Start the pass and hold its delivery open: the adoption has landed, the agent has not.
    const pumping = mounted.host.pump()
    for (let tick = 0; tick < 20 && mounted.nodeFor(root)?.claimedBy !== WORKER; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(mounted.nodeFor(root)?.claimedBy).toBe(WORKER)

    // The sweep runs inside that window and must leave the binding alone.
    await mounted.host.sweep()
    expect(mounted.nodeFor(root)?.claimedBy).toBe(WORKER)
    expect(mounted.nodeFor(root)?.status).toBe('running')
    expect(mounted.nodeFor(root)?.failures).toBe(0)
    expect(mounted.dispatched).toHaveLength(0)

    mounted.releaseSends()
    await pumping

    // One session, one adoption: the guard charges nothing and starts nobody.
    expect(mounted.dispatched).toHaveLength(0)
    expect(mounted.sent).toHaveLength(1)
    expect(mounted.nodeFor(root)?.attempts).toBe(2)
    expect(mounted.nodeFor(root)?.failures).toBe(0)
  })
})
