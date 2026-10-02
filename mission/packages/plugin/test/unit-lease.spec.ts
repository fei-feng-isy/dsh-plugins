/**
 * Unit leases through the tool surface: how a scope is DECLARED and inherited, and that the engine
 * honours it end to end.
 *
 * The tree-level rule ("the lease is the unit of the `running` nodes") is proven in the core's
 * `unit-lease.spec.ts`; these cases prove the model-facing half — the parameters, the inheritance
 * default, and that a real mount serializes two roots that declared the same scope.
 */
import { describe, expect, it } from 'vitest'
import { callTool, callToolChecked, executorFor, mount, type StubAgent } from './mount.js'

/** The child ids of a node, keyed by title (the only label the test wrote). */
async function childIds(
  mounted: Awaited<ReturnType<typeof mount>>,
  nodeId: string,
): Promise<Map<string, string>> {
  const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId })
  return new Map(detail.children.map((child) => [child.title, child.id]))
}

describe('declaring a scope', () => {
  it('carries `unit` from create_mission onto the root, and reads a blank one as none', async () => {
    const mounted = await mount()
    const created = await callToolChecked(
      mounted,
      'create_mission',
      { title: 'T', description: 'd', analysis: [], unit: 'mission/packages/plugin/src/host.ts' },
      mounted.owner,
    )
    expect(created.ok).toBe(true)
    const rootId = String(created.data?.['root_id'] ?? '')
    expect(mounted.nodeFor(rootId)?.unit).toBe('mission/packages/plugin/src/host.ts')

    // Blank is the explicit opt-out, not a scope named " ".
    const blank = await callToolChecked(
      mounted,
      'create_mission',
      { title: 'T2', description: 'd', analysis: [], unit: '   ' },
      mounted.owner,
    )
    expect(mounted.nodeFor(String(blank.data?.['root_id'] ?? ''))?.unit).toBeNull()
  })

  it('declares `unit` as an optional parameter, and admits it at the harness boundary', async () => {
    const mounted = await mount()
    const create = mounted.registered.find((entry) => entry.name === 'create_mission')
    expect(create?.parameters).toMatchObject({
      properties: { unit: { type: 'string' } },
    })
    expect((create?.parameters?.['required'] as string[] | undefined) ?? []).not.toContain('unit')

    const children = (mounted.registered.find((entry) => entry.name === 'decompose_mission')
      ?.parameters?.['properties'] as Record<string, { oneOf?: unknown[] }> | undefined)?.['children']
    const array = (children?.oneOf?.[0] as { items?: { properties?: Record<string, unknown> } } | undefined)
    expect(array?.items?.properties?.['unit']).toMatchObject({ type: 'string' })
  })

  it('inherits the parent scope by default, takes an explicit one, and lets a child opt out', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'T', description: 'd', analysis: ['why'], unit: 'pkg/host.ts' },
      mounted.owner,
    )
    const rootId = String(created.data?.['root_id'] ?? '')
    const worker: StubAgent = executorFor(mounted, rootId)
    const noted = await callTool(
      mounted,
      'note_mission',
      { node_id: rootId, analysis: '这次为什么拆：缺一个前置事实' },
      worker,
    )
    expect(noted.ok).toBe(true)
    // Through `callToolChecked`, so the DECLARED child shape (including `unit`, with
    // `additionalProperties: false`) is what admits the call.
    const split = await callToolChecked(
      mounted,
      'decompose_mission',
      {
        node_id: rootId,
        children: [
          { title: 'inherit', description: 'd', context: ['why'] },
          { title: 'own', description: 'd', context: ['why'], unit: 'pkg/other.ts' },
          { title: 'none', description: 'd', context: ['why'], unit: '  ' },
        ],
      },
      worker,
    )
    expect(split.ok).toBe(true)
    const ids = await childIds(mounted, rootId)
    expect(mounted.nodeFor(ids.get('inherit') ?? '')?.unit).toBe('pkg/host.ts')
    expect(mounted.nodeFor(ids.get('own') ?? '')?.unit).toBe('pkg/other.ts')
    expect(mounted.nodeFor(ids.get('none') ?? '')?.unit).toBeNull()
  })
})

describe('one executor per scope, across roots', () => {
  it('⑥ dispatches one of two same-unit roots, and the other once the first is done', async () => {
    const mounted = await mount()
    const second = mounted.makeOwner('owner2')
    const first = await callToolChecked(
      mounted,
      'create_mission',
      { title: 'A', description: 'd', analysis: [], unit: 'mission/packages/plugin/src/host.ts' },
      mounted.owner,
    )
    const secondRoot = await callToolChecked(
      mounted,
      'create_mission',
      { title: 'B', description: 'd', analysis: [], unit: 'mission/packages/plugin/src/host.ts' },
      second,
    )
    // Two trees, two owners, one declared scope: only the first root got an executor.
    expect(mounted.dispatched).toHaveLength(1)
    const firstId = String(first.data?.['root_id'] ?? '')
    const secondId = String(secondRoot.data?.['root_id'] ?? '')
    expect(mounted.nodeFor(secondId)?.status).toBe('ready')

    // The holder submits; the very next pass runs the second root.
    const submitted = await callTool(
      mounted,
      'submit_mission',
      { node_id: firstId, result: 'done' },
      executorFor(mounted, firstId),
    )
    expect(submitted.ok).toBe(true)
    expect(mounted.dispatched).toHaveLength(2)
    expect(mounted.nodeFor(secondId)?.status).toBe('running')
  })
})
