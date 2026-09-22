/**
 * Recursive decomposition, end to end through the real host service.
 *
 * The unit tests prove the state machine; this proves the CHAIN a live session
 * exercises: root → work unit → the unit splits itself → children dispatch → a
 * child splits again → grandchildren → every level aggregates → the root
 * converges. Each step goes through the registered tool surface and the engine's
 * own dispatch loop, so a break anywhere in the wiring shows up here.
 */
import { describe, expect, it } from 'vitest'
import { callTool, executorFor, mount, noteAndSplit, promptFor, type Mounted } from './mount.js'

/** The caller session of the most recently dispatched worker, now marked live. */
function lastWorker(mounted: Mounted) {
  const claimId = String(mounted.dispatched.at(-1)?.childId ?? '')
  return mounted.makeLive(claimId)
}

/** Split one node from the worker that currently holds it. */
async function split(
  mounted: Mounted,
  worker: ReturnType<typeof lastWorker>,
  nodeId: string,
  titles: readonly string[],
): Promise<readonly string[]> {
  const result = await noteAndSplit(
    mounted,
    nodeId,
    titles.map((title, index) => ({
      title,
      description: `${title} description`,
      context: [`needed because of step ${String(index + 1)}`],
    })),
    worker,
  )
  expect(result.ok, result.summary).toBe(true)
  return (result.data?.['created'] as string[] | undefined) ?? []
}

/** Finish one node from the worker that holds it. */
async function finish(
  mounted: Mounted,
  worker: ReturnType<typeof lastWorker>,
  nodeId: string,
  result: string,
): Promise<void> {
  const submitted = await callTool(mounted, 'submit_work', { node_id: nodeId, result }, worker)
  expect(submitted.ok, submitted.summary).toBe(true)
}

describe('recursive decomposition', () => {
  it('runs root → split → child split → grandchildren → converge', async () => {
    const mounted = await mount()

    // ── the owner roots a tree ────────────────────────────────────────────
    const created = await callTool(
      mounted,
      'create_work',
      { title: 'Ship the migration', description: 'Move every caller to v2', analysis: ['v1 is deprecated'] },
      mounted.owner,
    )
    expect(created.ok, created.summary).toBe(true)
    const root = String(created.data?.['root_id'] ?? '')
    expect(root).not.toBe('')

    // The fresh root is dispatched as the first work unit.
    expect(mounted.dispatched).toHaveLength(1)
    const first = lastWorker(mounted)
    expect(mounted.dispatched[0]?.prompt).toContain(root)
    // An execution prompt must not carry sub-work progress.
    expect(mounted.dispatched[0]?.prompt).not.toContain('子工作都已终态')

    // ── level 1: the root's worker splits it ──────────────────────────────
    const [childA, childB] = (await split(mounted, first, root, ['Inventory the callers', 'Draft the shim'])) as [
      string,
      string,
    ]
    // Splitting releases the claim and puts the children in the pool.
    expect(childA).toBeTruthy()
    expect(childB).toBeTruthy()

    // ── level 2: the first child's worker splits IT again ─────────────────
    await mounted.flush()
    expect(mounted.dispatched).toHaveLength(3)
    const childAWorker = mounted.dispatched
      .filter((entry) => entry.prompt.includes(childA))
      .map((entry) => mounted.makeLive(entry.childId))
      .at(-1)
    expect(childAWorker).toBeDefined()
    if (childAWorker === undefined) return

    // A child session must not be able to root its own tree.
    const sneaky = await callTool(
      mounted,
      'create_work',
      { title: 'mine', description: 'd', analysis: [] },
      { ...childAWorker, header: { origin: 'subagent', delegationDepth: 2 }, session: { header: { origin: 'subagent', delegationDepth: 2 } } },
    )
    expect(sneaky.ok).toBe(false)
    expect(sneaky.data?.['code']).toBe('no-authority')

    const [grandA1, grandA2] = (await split(mounted, childAWorker, childA, ['Grep for imports', 'List the shims'])) as [
      string,
      string,
    ]
    expect(grandA1).toBeTruthy()
    expect(grandA2).toBeTruthy()

    // The grandchild's prompt carries the whole vertical chain, so it can see
    // why it exists without any sibling knowledge.
    await mounted.flush()
    const grandPrompt = mounted.dispatched.map((entry) => entry.prompt).find((text) => text.includes(grandA1))
    expect(grandPrompt).toBeDefined()
    expect(grandPrompt).toContain('Ship the migration')
    expect(grandPrompt).toContain('Inventory the callers')
    expect(grandPrompt).toContain('Grep for imports')
    expect(grandPrompt).toContain('needed because of step 1')

    // ── level 3: grandchildren finish, childA aggregates ──────────────────
    for (const [index, nodeId] of [grandA1, grandA2].entries()) {
      const entry = mounted.dispatched.filter((candidate) => candidate.prompt.includes(nodeId)).at(-1)
      const worker = mounted.makeLive(String(entry?.childId ?? ''))
      await finish(mounted, worker, nodeId, `grandchild ${String(index + 1)} conclusion`)
    }

    // childA is now an aggregate: the session that decomposed it is woken, and its prompt
    // must carry the grandchildren's conclusions.
    await mounted.flush()
    await mounted.wake()
    const childAPrompt = promptFor(mounted, childA)
    expect(childAPrompt, 'childA must be woken as an aggregate').toContain('子工作都已终态')
    expect(childAPrompt).toContain('grandchild 1 conclusion')
    expect(childAPrompt).toContain('grandchild 2 conclusion')

    const childAWorker2 = mounted.makeLive(executorFor(mounted, childA).id)
    await finish(mounted, childAWorker2, childA, 'callers are inventoried')

    // ── childB finishes, then the root aggregates ────────────────────────
    const childBEntry = mounted.dispatched
      .filter((entry) => entry.prompt.includes(childB) && !entry.prompt.includes('子工作都已终态'))
      .at(-1)
    expect(childBEntry, 'childB must have been dispatched').toBeDefined()
    await finish(mounted, mounted.makeLive(String(childBEntry?.childId ?? '')), childB, 'shim is drafted')

    await mounted.flush()
    await mounted.wake()
    const rootPrompt = promptFor(mounted, root)
    expect(rootPrompt, 'the root must be woken as an aggregate').toContain('子工作都已终态')
    expect(rootPrompt).toContain('callers are inventoried')
    expect(rootPrompt).toContain('shim is drafted')

    // ── the root converges and the owner reads it ────────────────────────
    const rootWorker = mounted.makeLive(executorFor(mounted, root).id)
    await finish(mounted, rootWorker, root, 'migration complete: 12 callers on v2')

    const read = await callTool(mounted, 'work_result', { node_id: root }, mounted.owner)
    expect(read.ok, read.summary).toBe(true)
    expect(read.summary).toContain('migration complete: 12 callers on v2')

    // The finish gate: reading is what unlocks closing the tree.
    const closed = await callTool(mounted, 'finish_work', { root_id: root }, mounted.owner)
    expect(closed.ok, closed.summary).toBe(true)

    // A closed tree stops feeding the owner's guidance.
    const guidance = mounted.contexts.find((contribution) => contribution.name === 'avantf:work-tree')
    expect(guidance?.text({ agent: mounted.owner })).toBe('')
  })

  it('reuses a prerequisite another branch already created', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_work',
      { title: 'Root', description: 'd', analysis: [] },
      mounted.owner,
    )
    const root = String(created.data?.['root_id'] ?? '')
    const first = lastWorker(mounted)
    const [branchA, branchB] = (await split(mounted, first, root, ['Branch A', 'Branch B'])) as [string, string]

    // Branch A discovers a prerequisite.
    await mounted.flush()
    const workerA = mounted.makeLive(
      String(mounted.dispatched.filter((entry) => entry.prompt.includes(branchA)).at(-1)?.childId ?? ''),
    )
    const [shared] = (await split(mounted, workerA, branchA, ['Confirm the v2 interface'])) as [string]

    // Branch B independently discovers the same one.
    const workerB = mounted.makeLive(
      String(mounted.dispatched.filter((entry) => entry.prompt.includes(branchB)).at(-1)?.childId ?? ''),
    )
    // Same title AND same description as branch A's node: that is what "the same gap"
    // means now — a title alone is not evidence (see core `findEquivalent`).
    const second = await noteAndSplit(mounted, branchB, [{
      title: 'confirm the v2 INTERFACE',
      description: 'Confirm the v2 interface description',
      context: ['branch B needs it too'],
    }], workerB)
    expect(second.ok, second.summary).toBe(true)
    expect(second.data?.['created']).toEqual([])
    expect(second.data?.['reused']).toEqual([shared])
  })
})
