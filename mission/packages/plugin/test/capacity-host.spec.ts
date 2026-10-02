/**
 * The host side of capacity: where the machine reading comes from, that the probe is a real Node
 * implementation with a conservative memory signal, and that `weight`/`waitingFor` reach the panel
 * and `mission_result`.
 */
import { describe, expect, it, vi } from 'vitest'
import { totalmem } from 'node:os'
import { CAPACITY_CEILING } from '@avantf/mission-core'
import { createHostResourceProbe } from '../src/host.js'
import { callTool, agent, executorFor, mount, promptFor, noteAndSplit, type Mounted } from './mount.js'

describe('host capacity derivation', () => {
  it('uses an explicit configuration as given, with no reserved core and no derivation', async () => {
    const mounted = await mount({ pluginConfig: { capacity: 6 } })
    expect(mounted.host.capacityReading()).toEqual({
      capacity: 6,
      source: 'config',
      parallelism: 6,
      reserved: 0,
    })
  })

  it('derives from the machine when nothing is configured, clamped to the ceiling', async () => {
    const mounted = await mount()
    const reading = mounted.host.capacityReading()
    // Node's unified API is always answerable, so the chain lands on `availableParallelism` here;
    // the capacity is bounded on both ends.
    expect(reading.source).toBe('availableParallelism')
    expect(reading.parallelism).toBeGreaterThanOrEqual(1)
    expect(reading.capacity).toBeGreaterThanOrEqual(1)
    expect(reading.capacity).toBeLessThanOrEqual(CAPACITY_CEILING)
    expect(reading.reserved).toBe(1)
  })

  it('clamps an absurd configuration instead of materialising thousands of claims', async () => {
    const mounted = await mount({ pluginConfig: { capacity: 4096 } })
    expect(mounted.host.capacityReading().capacity).toBe(CAPACITY_CEILING)
  })
})

describe('the host resource probe', () => {
  it('answers parallelism and treats memory as a lower bound, never the unconstrained sentinel', () => {
    const probe = createHostResourceProbe()
    expect(probe.parallelism()).toBeGreaterThanOrEqual(1)
    const budget = probe.memoryBudget?.()
    expect(typeof budget).toBe('number')
    // A number, finite, and no larger than the machine: the `1.8e19` sentinel from
    // `process.constrainedMemory()` must never surface as a budget.
    expect(Number.isFinite(budget as number)).toBe(true)
    expect(budget as number).toBeGreaterThanOrEqual(0)
    expect(budget as number).toBeLessThanOrEqual(totalmem())
  })

  it('reports pressure as null: the v2 platform adapters are deliberately not implemented', () => {
    expect(createHostResourceProbe().pressure()).toBeNull()
  })
})

describe('weight and waitingFor reach the panel and the tools', () => {
  it('carries the declared weight into the snapshot rows and the detail read', async () => {
    const mounted = await mount({ pluginConfig: { capacity: 8 } })
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'heavy', description: 'd', analysis: ['because'], weight: 3 },
      mounted.owner,
    )
    const rootId = String(created.data?.['root_id'] ?? '')
    const rows = mounted.host.treesForSession(mounted.owner.id)
    const row = rows[0]?.nodes.find((node) => node.id === rootId)
    expect(row?.weight).toBe(3)
    expect(row?.waitingFor).toBeNull()
    const detail = mounted.host.detailOf(mounted.owner.id, rootId)
    expect(detail.node?.weight).toBe(3)
    expect(detail.node?.waitingFor).toBeNull()
  })

  it('projects capacity queuing onto the row instead of showing a ready mission as runnable', async () => {
    const mounted = await mount({ pluginConfig: { capacity: 1 } })
    await callTool(mounted, 'create_mission', { title: 'first', description: 'd', analysis: [] }, mounted.owner)
    const second = await callTool(
      mounted,
      'create_mission',
      { title: 'second', description: 'd', analysis: [] },
      mounted.owner,
    )
    const queuedId = String(second.data?.['root_id'] ?? '')
    const rows = mounted.host.treesForSession(mounted.owner.id).flatMap((tree) => tree.nodes)
    const queued = rows.find((node) => node.id === queuedId)
    expect(queued?.waitingFor).toEqual({ reason: 'capacity', resource: 'cpu', needed: 1, available: 0 })
    // The other mission holds the whole capacity and is NOT waiting.
    const running = rows.find((node) => node.id !== queuedId)
    expect(running?.waitingFor).toBeNull()
  })

  it('carries the weight and a null waitingFor into the mission_result payload', async () => {
    const mounted = await mount({ pluginConfig: { capacity: 8 } })
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'readable', description: 'd', analysis: [], weight: 2 },
      mounted.owner,
    )
    const rootId = String(created.data?.['root_id'] ?? '')
    const claim = String(mounted.dispatched.at(-1)?.childId ?? '')
    const worker = agent(claim)
    await callTool(mounted, 'submit_mission', { node_id: rootId, result: 'done' }, worker)
    const read = await callTool(mounted, 'mission_result', { node_id: rootId }, mounted.owner)
    expect(read.ok).toBe(true)
    expect(read.data?.['weight']).toBe(2)
    expect(read.data?.['waiting_for']).toBeNull()
  })
})

describe('the capacity wait reaches the dispatch prompt', () => {
  it('⑦ tells an executor that was queued how long it waited, from the engine\'s own aging clock', async () => {
    // The report this answers: a run that had queued behind a full machine told its owner "I did not
    // wait", because nothing in its prompt said otherwise. The queued node gets the fact on dispatch.
    //
    // The wait is a REAL interval on the engine's aging clock, and the prompt deliberately says nothing
    // when it is 0 — so the clock has to be advanced the way a queue advances it. Without this the
    // deferral and the dispatch land in the same millisecond and the sentence never appears (only
    // `Date` is faked, so the fixture's own timers still work; see `host.spec.ts` for the same idiom).
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const mounted = await mount({ pluginConfig: { capacity: 1 } })
      const first = await callTool(mounted, 'create_mission', { title: 'first', description: 'd', analysis: [] }, mounted.owner)
      const firstId = String(first.data?.['root_id'] ?? '')
      const second = await callTool(mounted, 'create_mission', { title: 'second', description: 'd', analysis: [] }, mounted.owner)
      const secondId = String(second.data?.['root_id'] ?? '')

      // The first holds the whole machine; the second is queued, not dispatched.
      expect(promptFor(mounted, secondId)).toBe('')
      // Half a minute behind a full machine, then the machine frees up.
      vi.setSystemTime(Date.now() + 30_000)
      await callTool(
        mounted,
        'submit_mission',
        { node_id: firstId, result: 'done' },
        mounted.makeLive(String(mounted.dispatched[0]?.childId ?? '')),
      )
      await mounted.flush()

      const prompt = promptFor(mounted, secondId)
      expect(prompt).toContain('本任务在容量队列里等了')
      expect(prompt).toContain('原因：机器容量已被占用')
      // And the FIRST mission, which never waited, must not be told it did.
      expect(promptFor(mounted, firstId)).not.toContain('容量队列')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the parked wake goes through the capacity gate', () => {
  /** One macrotask: the engine starts workers fire-and-forget, so a read needs a turn to settle. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  /**
   * A parked root whose wake is due, with the machine already full.
   *
   * Order matters and is the whole trick: the root is created FIRST, so it runs, decomposes and parks
   * normally (parking releases its slot). Only then is the hog created, and its `weight` equals the
   * capacity, so it is dispatched into the freed slot and holds the whole machine. The parked root's
   * own weight-1 wake would fit an idle machine; it must be refused because this one is not idle.
   */
  async function parkedUnderAHog(): Promise<{
    mounted: Mounted
    hogId: string
    root: string
    rootWorker: ReturnType<typeof executorFor>
  }> {
    const mounted = await mount({ pluginConfig: { capacity: 2 } })
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'parked', description: 'd', analysis: ['because'] },
      mounted.owner,
    )
    const root = String(created.data?.['root_id'] ?? '')
    await mounted.flush()
    await settle()
    const rootWorker = executorFor(mounted, root)
    if (rootWorker.id === '') throw new Error('fixture: the root was never dispatched')
    const split = await noteAndSplit(
      mounted,
      root,
      [{ title: 'sub', description: 'd', context: ['why'] }],
      rootWorker,
    )
    const child = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
    await mounted.flush()
    await callTool(mounted, 'submit_mission', { node_id: child, result: 'child conclusion' }, executorFor(mounted, child))
    await mounted.flush()
    const hog = await callTool(
      mounted,
      'create_mission',
      { title: 'hog', description: 'd', analysis: [], weight: 2 },
      mounted.owner,
    )
    const hogId = String(hog.data?.['root_id'] ?? '')
    await mounted.flush()
    return { mounted, hogId, root, rootWorker }
  }

  it('defers a parked wake while the machine is full, charging nothing and keeping the address', async () => {
    const { mounted, hogId, root, rootWorker } = await parkedUnderAHog()
    // The parked root was parked before the hog arrived, and the hog holds the whole machine.
    expect(mounted.nodeFor(root)?.status).toBe('ready')
    expect(mounted.parkedWorkerOf(root)).toBe(rootWorker.id)
    expect(mounted.nodeFor(hogId)?.status).toBe('running')
    const startedBefore = mounted.dispatched.length

    await mounted.wake()

    // The wake was refused by the gate: no delivery to the parked session, no fresh executor, and the
    // node untouched — the same deferral every other admission path gets.
    expect(mounted.nodeFor(root)?.status).toBe('ready')
    expect(mounted.nodeFor(root)?.claimedBy).toBeNull()
    expect(mounted.parkedWorkerOf(root)).toBe(rootWorker.id)
    expect(mounted.nodeFor(root)?.attempts).toBe(1)
    expect(mounted.nodeFor(root)?.failures).toBe(0)
    expect(mounted.nodeFor(root)?.spawnFailures).toBe(0)
    expect(mounted.dispatched).toHaveLength(startedBefore)
    expect(mounted.sent.some((entry) => entry.targetId === rootWorker.id)).toBe(false)
  })

  it('wakes the same parked session normally once the machine has room', async () => {
    const { mounted, hogId, root, rootWorker } = await parkedUnderAHog()
    // Drain the machine: capacity is free again.
    await callTool(
      mounted,
      'submit_mission',
      { node_id: hogId, result: 'done' },
      executorFor(mounted, hogId),
    )
    await mounted.flush()

    await mounted.wake()

    // The SAME parked session was adopted and delivered to: the gate defers a wake, it never destroys
    // the address or replaces the session.
    expect(mounted.parkedWorkerOf(root)).toBeNull()
    expect(mounted.nodeFor(root)?.status).toBe('running')
    expect(mounted.nodeFor(root)?.claimedBy).toBe(rootWorker.id)
    expect(mounted.nodeFor(root)?.attempts).toBe(2)
    expect(mounted.nodeFor(root)?.failures).toBe(0)
    const wake = mounted.sent.at(-1)
    expect(wake?.targetId).toBe(rootWorker.id)
    expect(promptFor(mounted, root)).toContain('子任务都已终态')
    // No second executor was started for the root.
    expect(mounted.dispatched.filter((entry) => entry.prompt.includes(`id: ${root}\n`))).toHaveLength(1)
    // One macrotask for the delivery to settle before the node is read again elsewhere.
    await settle()
  })
})
