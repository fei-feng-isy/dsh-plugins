/**
 * Arguments that arrive as TEXT.
 *
 * Observed live: the tool-call transport handed an array parameter over as the STRING of its
 * JSON text, and the host's argument validator rejected the whole call before it ran
 * (`invalid arguments: "analysis" must be an array`) — three `create_mission` attempts in a row
 * died that way, and the same hazard sits on `decompose_mission.children`. These cases pin the
 * tolerance: the array, its JSON text, and one-item-per-line text must all reach the engine
 * with the same arguments, and a string that is none of those must refuse with a readable
 * reason.
 *
 * The declarations accept both shapes (`oneOf`), and every call here goes through the real
 * parameter schema (`callToolChecked`), so this exercises the declared contract and not only
 * the accessors behind it.
 */
import { describe, expect, it } from 'vitest'
import { agent, callTool, callToolChecked, mount } from './mount.js'

/** The root node's stored context — where a root's `analysis` lands. */
async function rootContext(
  mounted: Awaited<ReturnType<typeof mount>>,
  root: string,
): Promise<readonly string[]> {
  const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
  const tree = snapshot.trees.find((candidate) => candidate.rootId === root)
  return tree?.nodes.find((node) => node.id === root)?.context ?? []
}

/** Create a root and hand its dispatched worker back, as the engine would. */
async function rootAndWorker(
  mounted: Awaited<ReturnType<typeof mount>>,
): Promise<{ root: string; worker: ReturnType<typeof agent> }> {
  const created = await callToolChecked(
    mounted,
    'create_mission',
    { title: 'T', description: 'd', analysis: [] },
    mounted.owner,
  )
  const root = String(created.data?.root_id ?? '')
  await mounted.flush()
  return {
    root,
    worker: agent(String(mounted.dispatched.at(-1)?.childId ?? ''), { origin: 'subagent', delegationDepth: 1 }),
  }
}

/** Create a root, note this dispatch's analysis, and hand the worker back. */
async function notedWorker(
  mounted: Awaited<ReturnType<typeof mount>>,
): Promise<{ root: string; worker: ReturnType<typeof agent> }> {
  const { root, worker } = await rootAndWorker(mounted)
  const noted = await callTool(mounted, 'note_mission', { node_id: root, analysis: '这次为什么拆：缺一个前置事实' }, worker)
  expect(noted.ok).toBe(true)
  return { root, worker }
}

/** The context a child mission was created with. */
async function childContext(
  mounted: Awaited<ReturnType<typeof mount>>,
  title: string,
): Promise<readonly string[]> {
  const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
  return snapshot.trees[0]?.nodes.find((node) => node.title === title)?.context ?? []
}

describe('create_mission.analysis accepts the array, its JSON text, and one line per item', () => {
  const cases: { label: string; analysis: unknown }[] = [
    { label: 'an array', analysis: ['a', 'b'] },
    { label: 'the JSON text of that array', analysis: '["a","b"]' },
    { label: 'one item per line', analysis: '- a\n- b\n\n' },
  ]

  for (const entry of cases) {
    it(`reaches the engine identically when given ${entry.label}`, async () => {
      const mounted = await mount()
      const created = await callToolChecked(
        mounted,
        'create_mission',
        { title: 'T', description: 'd', analysis: entry.analysis },
        mounted.owner,
      )
      expect(created.ok).toBe(true)
      expect(await rootContext(mounted, String(created.data?.root_id ?? ''))).toEqual(['a', 'b'])
    })
  }

  it('refuses a shape the declaration cannot admit, at the harness boundary', async () => {
    const mounted = await mount()
    // A number satisfies neither branch of the `oneOf`, so the call never reaches the tool
    // body. (A plain non-JSON STRING is deliberately admitted — it is the one-item-per-line
    // form; see `argument-readers.spec.ts` for what the reader then does with it.)
    await expect(
      callToolChecked(mounted, 'create_mission', { title: 'T', description: 'd', analysis: 42 }, mounted.owner),
    ).rejects.toThrow(/invalid arguments.*analysis/u)
  })

  it('declares both shapes, so the harness admits the text form', async () => {
    const mounted = await mount()
    const tool = mounted.registered.find((entry) => entry.name === 'create_mission')
    expect(tool?.parameters).toMatchObject({
      properties: {
        analysis: { oneOf: [{ type: 'array' }, { type: 'string' }] },
      },
    })
  })
})

describe('decompose_mission.children accepts the array and its JSON text', () => {
  it('takes the children as the JSON text of their array', async () => {
    const mounted = await mount()
    const { root, worker } = await notedWorker(mounted)
    const children = JSON.stringify([{ title: 'A', description: 'a', context: ['why a'] }])
    // The shape the transport delivered live: the array serialized into a string.
    const split = await callToolChecked(mounted, 'decompose_mission', { node_id: root, children }, worker)
    expect(split.ok).toBe(true)
    expect(await childContext(mounted, 'A')).toEqual(['why a'])
  })

  it('takes a nested context as one item per line, inside a children array', async () => {
    const mounted = await mount()
    const { root, worker } = await notedWorker(mounted)
    const split = await callToolChecked(
      mounted,
      'decompose_mission',
      {
        node_id: root,
        children: [{ title: 'B', description: 'b', context: '- why b\n- and this too\n' }],
      },
      worker,
    )
    expect(split.ok).toBe(true)
    expect(await childContext(mounted, 'B')).toEqual(['why b', 'and this too'])
  })

  it('takes a nested context as the JSON text of its array, inside JSON-text children', async () => {
    const mounted = await mount()
    const { root, worker } = await notedWorker(mounted)
    const children = JSON.stringify([{ title: 'C', description: 'c', context: '["why c"]' }])
    const split = await callToolChecked(mounted, 'decompose_mission', { node_id: root, children }, worker)
    expect(split.ok).toBe(true)
    expect(await childContext(mounted, 'C')).toEqual(['why c'])
  })

  it('produces the SAME split from the array and from its JSON text', async () => {
    const body = [{ title: 'Same', description: 'same', context: ['why'] }]
    const writings: unknown[] = [body, JSON.stringify(body)]
    for (const children of writings) {
      const mounted = await mount()
      const { root, worker } = await notedWorker(mounted)
      const split = await callToolChecked(mounted, 'decompose_mission', { node_id: root, children }, worker)
      expect(split.ok, `children=${JSON.stringify(children)}`).toBe(true)
      expect(await childContext(mounted, 'Same')).toEqual(['why'])
    }
  })

  it('refuses a shape the declaration cannot admit, at the harness boundary', async () => {
    const mounted = await mount()
    const { root, worker } = await notedWorker(mounted)
    // Neither branch of `oneOf` admits an object, so the call is refused before the body.
    await expect(
      callToolChecked(mounted, 'decompose_mission', { node_id: root, children: { title: 'x' } }, worker),
    ).rejects.toThrow(/invalid arguments.*children/u)
  })

  it('declares both shapes on children', async () => {
    const mounted = await mount()
    const tool = mounted.registered.find((entry) => entry.name === 'decompose_mission')
    expect(tool?.parameters).toMatchObject({
      properties: {
        children: { oneOf: [{ type: 'array' }, { type: 'string' }] },
      },
    })
  })
})
