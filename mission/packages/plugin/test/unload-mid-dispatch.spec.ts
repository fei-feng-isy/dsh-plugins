/**
 * Unloading the plugin while a dispatch is in flight.
 *
 * A worker start is bound (`running`) before it resolves. When the fiber unloads inside that window
 * the host aborts the start's controller, and the start rejects. That rejection used to be classified
 * as a FAILED START: the node was reclaimed as `spawn-failed`, which spends the start-failure budget,
 * begins a cooldown and — at the floor — tells the owner the mission "keeps failing to start". The
 * classification is what this file pins: the abort reason names the unload, so the reclaim is the
 * expected `unloading` one and NOTHING is charged.
 *
 * The first case is the behaviour under change; the last one is a deliberate STATEMENT of the old
 * classification (a direct `spawn-failed` reclaim really does charge the budget), so the difference
 * the change makes stays visible in the suite instead of being asserted only by prose.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MissionTree, type TreeState, type TreeStore } from '@avantf/mission-core'
import { callTool, mount } from './mount.js'
import { settle } from './fixtures.js'

/** Rejections Node could not attribute to a handler, collected for the whole file. */
const unhandled: unknown[] = []
const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }

beforeAll(() => { process.on('unhandledRejection', onUnhandled) })
afterAll(() => { process.off('unhandledRejection', onUnhandled) })

/** The in-memory store a throwaway tree writes through, so the last case needs no mount. */
function memoryStore(): TreeStore {
  let latest: TreeState | undefined
  return {
    loadAll: () => Promise.resolve(latest === undefined ? [] : [latest]),
    put: (state) => {
      latest = state
      return Promise.resolve()
    },
    remove: () => {
      latest = undefined
      return Promise.resolve()
    },
  }
}

describe('unloading mid-dispatch', () => {
  it('does not charge a start failure, returns the node to the pool, and says nothing is wrong', async () => {
    const mounted = await mount({ deferStart: true })
    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
    try {
      const created = await callTool(
        mounted,
        'create_mission',
        { title: '卸载中的派发', description: 'd', analysis: ['because'] },
        mounted.owner,
      )
      const rootId = String(created.data?.root_id ?? '')
      const claim = String(mounted.dispatched.at(-1)?.childId ?? '')
      expect(rootId).not.toBe('')
      expect(claim).not.toBe('')
      // The start is bound but not resolved: exactly the window an unload lands in.
      expect(mounted.nodeFor(rootId)?.status).toBe('running')

      await mounted.host.stop()
      // Two turns: one for the aborted start to reject, one for its reclaim to settle.
      await settle()
      await settle()

      const node = mounted.nodeFor(rootId)
      // ① The start-failure budget is untouched: a worker the unload cancelled was never a failure.
      expect(node?.spawnFailures).toBe(0)
      expect(node?.failures).toBe(0)
      // ② Back in the pool, unclaimed and immediately dispatchable.
      expect(node?.status).toBe('ready')
      expect(node?.claimedBy).toBeNull()

      // ③ No misleading WARN: the line is INFO and names the unload.
      const falseFailures = lines.filter((line) =>
        line.includes('WARN') && line.includes('dispatch of') && line.includes('failed'))
      expect(falseFailures).toEqual([])
      expect(lines.some((line) => line.includes('INFO') && line.includes('unloading'))).toBe(true)

      // ④ Nothing was left unhandled.
      expect(unhandled).toEqual([])

      // ② continued: a later pump really does dispatch it again, so "ready" is not just a status.
      await mounted.flush()
      expect(mounted.dispatched).toHaveLength(2)
      expect(mounted.dispatched.at(-1)?.childId).not.toBe(claim)
      expect(mounted.dispatched.at(-1)?.prompt).toContain(rootId)
      mounted.releaseStarts()
      await settle()
    } finally {
      spy.mockRestore()
    }
  })

  it('states the old classification: a spawn-failed reclaim does charge the start budget', async () => {
    // Not a behaviour this plugin should produce on unload — the point is that the old classification
    // was real and expensive, so `unloading` is a classification change and not a no-op rename.
    const tree = new MissionTree(memoryStore(), {
      isAgentLive: () => true,
      probeOwner: () => Promise.resolve({ kind: 'exists' }),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'root0001',
    })
    const created = await tree.createRoot({
      ownerSessionId: 'owner',
      title: 'T',
      description: 'd',
      analysis: [],
    })
    if (!created.ok) throw new Error('root creation failed')
    const id = created.value.id
    await tree.dispatch(id, 'mission-1')
    const reclaimed = await tree.reclaim(id, 'spawn-failed')
    expect(reclaimed.ok).toBe(true)
    expect(tree.node(id)?.spawnFailures).toBe(1)
    // And the cooldown it starts is what held the node out of the next pump.
    expect(tree.nextDispatchable()).toBeUndefined()
  })
})
