/**
 * Session continuation: a decomposed node's convergence pass runs in the session that
 * decomposed it.
 *
 * The unit tests prove the tree's side (the address is recorded, excluded from the dispatch
 * pool, adopted, undone). This file proves the WIRING through the real host and the real
 * pre-step gate:
 *
 * - the engine reports parked-ready nodes to the owner, batched, as a signal with no content;
 * - the owner's own step is what performs the wake, because the owner is the authorizing
 *   parent the continuation protocol requires (`authorizeLineage`);
 * - a wake that cannot be delivered — the parked session was cleaned, or the owner is not
 *   live — degrades to a fresh session without charging any budget and without stalling the
 *   tree.
 *
 * The stubs are the harness's; the code under test is the plugin's real pre-step listener,
 * reached through the real event chain.
 */
import { describe, expect, it } from 'vitest'
import { executorFor, mount, promptFor } from './mount.js'
import { parkedRoot } from './fixtures.js'

describe('the parked session is woken, not replaced', () => {
  it('reports the parked batch to the owner as a signal, not an instruction', async () => {
    const mounted = await mount()
    const { root } = await parkedRoot(mounted)

    // The engine's pass found the parked-ready node and told the owner — one message, and it
    // asks for no tool call (the wake happens inside the owner's turn; see the pre-step).
    const signals = mounted.owner.received.filter((message) =>
      message.content.some((part) => part.text.includes('子任务都已终态')),
    )
    expect(signals).toHaveLength(1)
    const text = signals[0]?.content.map((part) => part.text).join('') ?? ''
    expect(text).toContain(root)
    expect(text).not.toContain('工具')
    // The wake carries THIS plugin's producer-owned source kind: DSH V4 refuses the retired
    // `plugin` wrapper at the session writer, so this is the durable contract, not a formality.
    expect(signals[0]?.source).toEqual({ kind: 'plugin:avantf-mission' })
  })

  it('adopts the parked session on the owner step and delivers the aggregate prompt', async () => {
    const mounted = await mount()
    const { root, rootWorker } = await parkedRoot(mounted)
    expect(mounted.parkedWorkerOf(root)).toBe(rootWorker.id)

    await mounted.wake()

    // The node is still the SAME session — that is the whole feature — and it was reached
    // through `sendMessage` with the owner as the authorizing sender.
    expect(executorFor(mounted, root).id).toBe(rootWorker.id)
    expect(mounted.parkedWorkerOf(root)).toBeNull()
    const wake = mounted.sent.at(-1)
    expect(wake?.targetId).toBe(rootWorker.id)
    expect(wake?.from).toBe(mounted.owner.id)
    // The prompt is the ordinary dispatch prompt: children results plus the aggregate tail.
    expect(promptFor(mounted, root)).toContain('子任务都已终态')
    expect(promptFor(mounted, root)).toContain('child conclusion')
    // And no new worker was started for the root: the split dispatched the CHILD, so the
    // count that matters is dispatches whose prompt names the root as its own node.
    const rootDispatches = mounted.dispatched.filter((entry) => entry.prompt.includes(`id: ${root}\n`))
    expect(rootDispatches).toHaveLength(1)
  })

  it('lets no sweep reclaim the binding the wake is delivering into', async () => {
    // The regression this exists for (real run, 2026-09-22): the last child's own `subagent/end`
    // triggers a sweep in the SAME moment as the owner's wake. The parked session is IDLE — that is
    // what parking means — so the sweep read the just-adopted binding as "executor vanished",
    // reclaimed it (charging `failures`) and re-dispatched the node, while the cold resume still
    // landed: two executors for one node, one whole extra LLM round, and a `not-owner` refusal.
    const mounted = await mount({ deferSend: true })
    const { root, rootWorker } = await parkedRoot(mounted)

    // The owner's step adopts the parked session and starts delivering; the delivery is held open,
    // which is exactly the window the sweep used to win.
    const waking = mounted.wake()
    for (let tick = 0; tick < 20 && mounted.host.nodeFor(root)?.claimedBy !== rootWorker.id; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(mounted.host.nodeFor(root)?.claimedBy).toBe(rootWorker.id)

    // The sweep runs inside that window and must leave the binding alone.
    await mounted.host.sweep()
    expect(mounted.host.nodeFor(root)?.claimedBy).toBe(rootWorker.id)
    expect(mounted.host.nodeFor(root)?.status).toBe('running')
    expect(mounted.host.nodeFor(root)?.failures).toBe(0)
    expect(mounted.host.nodeFor(root)?.parkedWorker).toBeNull()

    mounted.releaseSends()
    await waking

    // One session, one adoption: the guard charges nothing and starts nobody.
    expect(executorFor(mounted, root).id).toBe(rootWorker.id)
    expect(mounted.host.nodeFor(root)?.attempts).toBe(2)
    const rootDispatches = mounted.dispatched.filter((entry) => entry.prompt.includes(`id: ${root}\n`))
    expect(rootDispatches).toHaveLength(1)
  })

  it('reverts a failed wake to a ready node that still owns its address, charging no budget', async () => {
    // M5's undo contract, on the path the host now makes a compare-and-swap: `reclaim(..., 'wake-failed')`
    // is expected to still find the holder it just adopted. Here nothing raced, so it reverts exactly
    // that binding and charges nothing; the refusal half (a holder that moved under the await) is the
    // CAS the tree owns and is pinned in the core's `tree.spec.ts`.
    const mounted = await mount({ failSend: true })
    const { root } = await parkedRoot(mounted)

    await mounted.wake()

    // The parked session was gone, so the wake failed and the undo ran.
    const node = mounted.host.nodeFor(root)
    expect(node?.status).toBe('running')
    expect(node?.failures).toBe(0)
    expect(node?.spawnFailures).toBe(0)
    // The fallback reserved a fresh claim and delivered to it.
    expect(mounted.host.nodeFor(root)?.claimedBy).not.toBeNull()
    expect(mounted.host.nodeFor(root)?.parkedWorker).toBeNull()
  })

  it('refuses the stale wake-failed undo once another pass has re-bound the node', async () => {
    // M5: the adoption awaits a delivery. A sweep can reclaim the parked binding in that window (the
    // session is idle, so it reads as vanished), and the engine can then re-dispatch the node to a
    // fresh claim — a LIVE worker. The `reclaim(..., 'wake-failed')` that undoes a failed parked wake
    // used to run without an `expectedHolder`, so it would bind-check nothing, drag the node back to
    // `ready` and unbind that live worker (whose `submit_mission` then answers `not-owner`), and the
    // next pass would start a SECOND executor for the same node. The expectation closes it.
    //
    // What is observable here is the state INVARIANT the expectation buys: the node may end this window
    // reverted (`ready`, no holder) or still bound, but never `ready` while a holder is stamped — that
    // is the corruption the missing compare-and-swap produced.
    const mounted = await mount({ deferSend: true })
    const { root, rootWorker } = await parkedRoot(mounted)

    // The owner's step adopts the parked session and starts delivering; the delivery is held open.
    const waking = mounted.wake()
    for (let tick = 0; tick < 20 && mounted.host.nodeFor(root)?.claimedBy !== rootWorker.id; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(mounted.host.nodeFor(root)?.claimedBy).toBe(rootWorker.id)

    // The delivery is then allowed to fail, and the undo runs against whatever binding it finds.
    mounted.releaseSends()
    await waking.catch(() => undefined)

    const node = mounted.host.nodeFor(root)
    if (node?.status === 'ready') expect(node.claimedBy).toBeNull()
    expect(node?.failures).toBe(0)
    expect(node?.spawnFailures).toBe(0)
  })

  it('degrades to a fresh session when the parked one cannot be resumed', async () => {
    const mounted = await mount({ failSend: true })
    const { root, rootWorker } = await parkedRoot(mounted)

    await mounted.wake()

    // The wake failed, so the node is executed by a NEW session, and the failure charged no
    // budget: a cleaned-up session is neither the mission's failure nor an infrastructure one.
    const executor = executorFor(mounted, root)
    expect(executor.id).not.toBe('')
    expect(executor.id).not.toBe(rootWorker.id)
    expect(mounted.parkedWorkerOf(root)).toBeNull()
    expect(mounted.host.nodeFor(root)?.failures).toBe(0)
    expect(mounted.host.nodeFor(root)?.spawnFailures).toBe(0)
    // The fresh session got the ordinary dispatch prompt, so the tree still advances.
    expect(promptFor(mounted, root)).toContain('子任务都已终态')
    // And the fallback is the ORDINARY path: a wake failure must not scar the node. If it were
    // charged as `spawn-failed` the node would be `interrupted` (not running) and carry a
    // cooldown, which is precisely the state that delays the fallback it exists to enable.
    expect(mounted.host.nodeFor(root)?.spawnFailures).toBe(0)
    expect(mounted.host.nodeFor(root)?.claimedBy).not.toBeNull()
    expect(mounted.host.nodeFor(root)?.status).toBe('running')
  })

  it('keeps another session\'s parked mission out of this owner\'s signal', async () => {
    // §8.1: a tree is visible only to the session that rooted it. One report carries every
    // parked node in the process, so it must be split per owner — otherwise one owner's message
    // describes another session's mission AND marks its node "told", leaving that node silently
    // unreported forever.
    const mounted = await mount()
    const mine = await parkedRoot(mounted)
    const other = mounted.makeOwner('session-other')
    const theirs = await parkedRoot(mounted, other)

    const batch = [
      ...mounted.host.parkedReadyNodesOf(mine.root),
      ...mounted.host.parkedReadyNodesOf(theirs.root),
    ]
    expect(batch.map((node) => node.id).sort()).toEqual([mine.root, theirs.root].sort())

    // Reproduce the one call the engine makes with that batch (the setup's own passes already
    // reported these nodes, so the marker is cleared first).
    mounted.host.forgetParkedSignals()
    mounted.owner.received.length = 0
    other.received.length = 0
    mounted.host.notifyParkedReady(batch)

    const toldMine = mounted.owner.received
      .map((message) => message.content.map((part) => part.text).join(''))
      .join('\n')
    const toldTheirs = other.received
      .map((message) => message.content.map((part) => part.text).join(''))
      .join('\n')
    // Each owner hears about its own node, and only about its own.
    expect(toldMine).toContain(mine.root)
    expect(toldMine).not.toContain(theirs.root)
    expect(toldMine).not.toContain('theirs')
    expect(toldTheirs).toContain(theirs.root)
    expect(toldTheirs).not.toContain(mine.root)
    // Neither message may speak for a count that includes the other session's mission.
    expect(toldMine).not.toContain('2 个任务')
    expect(toldTheirs).not.toContain('2 个任务')
  })

  it('wakes only the trees the stepping session owns', async () => {
    const mounted = await mount()
    const mine = await parkedRoot(mounted)
    const other = mounted.makeOwner('session-other')
    const theirs = await parkedRoot(mounted, other)

    // The stepping session is the harness's owner, so its step wakes its own parked node and
    // leaves the other session's exactly where it is (that session's own step will take it).
    await mounted.wake()
    expect(mounted.parkedWorkerOf(mine.root)).toBeNull()
    expect(executorFor(mounted, mine.root).id).toBe(mine.rootWorker.id)
    expect(mounted.parkedWorkerOf(theirs.root)).toBe(theirs.rootWorker.id)
    expect(mounted.sent.some((entry) => entry.targetId === theirs.rootWorker.id)).toBe(false)
  })

  it('leaves the address alone when the owner is not live', async () => {
    const mounted = await mount()
    const { root, rootWorker } = await parkedRoot(mounted)

    // The owner is the authorizing parent; without it there is nobody to wake the child, and
    // the wake must not consume the address (the owner may come back).
    mounted.dropOwner()
    await mounted.wake()

    expect(mounted.parkedWorkerOf(root)).toBe(rootWorker.id)
    expect(mounted.sent).toHaveLength(0)
  })

  it('treats a parked node as actionable, so the wake cannot be dropped', async () => {
    // `nextDispatchable` excludes parked nodes, so if the gate did not count this state as
    // actionable, an owner woken with nothing else in its batch would have its whole step
    // emptied — and the parked session would never be reached by anyone.
    const mounted = await mount()
    const { root, rootWorker } = await parkedRoot(mounted)

    // The harness's stub carries only the fields the host reads; the call is typed against
    // the real Agent shape.
    expect(mounted.host.admitStep(mounted.owner as never).admit).toBe(true)
    await mounted.wake()
    // The parked node is gone from that state: it is running under the session that was
    // woken, which is what makes the next step stop being admitted for its sake.
    expect(executorFor(mounted, root).id).toBe(rootWorker.id)
    expect(mounted.parkedWorkerOf(root)).toBeNull()
    expect(mounted.host.nodeFor(root)?.status).toBe('running')
  })

  it('reports each park once, even though every pass sees it', async () => {
    const mounted = await mount()
    const first = await parkedRoot(mounted)
    const second = await parkedRoot(mounted)

    // Several passes ran (each tool call pumps), plus the explicit flush. Without the marker
    // the owner's inbox would hold one wake per pass.
    await mounted.flush()
    await mounted.flush()
    const signals = mounted.owner.received.filter((message) =>
      message.content.some((part) => part.text.includes('子任务都已终态')),
    )
    // Two nodes parked in two separate passes, so two reports; NOT one per pass.
    expect(signals.length).toBeLessThanOrEqual(2)
    const texts = signals.map((message) => message.content.map((part) => part.text).join(''))
    expect(texts.some((text) => text.includes(first.root))).toBe(true)
    expect(texts.some((text) => text.includes(second.root))).toBe(true)

    // The owner step wakes each in its OWN session.
    await mounted.wake()
    expect(mounted.parkedWorkerOf(first.root)).toBeNull()
    expect(mounted.parkedWorkerOf(second.root)).toBeNull()
    expect(executorFor(mounted, first.root).id).toBe(first.rootWorker.id)
    expect(executorFor(mounted, second.root).id).toBe(second.rootWorker.id)
  })
})
