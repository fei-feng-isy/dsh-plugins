/**
 * The analysis an executor records, end to end through the tool surface.
 *
 * A dispatched worker is a session that is then gone, and the engine dispatches a FRESH
 * worker for the aggregate pass. That worker reads the mission's prompt and nothing else, so
 * the judgement behind the mission has to live on the mission. It is written by `note_mission`
 * DURING the attempt, and `decompose_mission` refuses to split until the dispatch doing the
 * splitting has written its own — these cases pin the whole chain: the tool face, the
 * required argument, the durable record, the gate, and the aggregate prompt.
 */
import { describe, expect, it } from 'vitest'
import { agent, callTool, callToolChecked, executorFor, mount, noteAndSplit, promptFor } from './mount.js'
import { OWNER_TOOL_DENY, WORKER_TOOL_DENY, visibleTo } from '../src/faces.js'

const NOTE = '缺前置事实：先拿到调用点清单，再判断改动范围'

/** A dispatched worker, shaped as the plugin itself creates one. */
function worker(id: string): ReturnType<typeof agent> {
  return agent(id, { origin: 'subagent', delegationDepth: 1 })
}

/** A root mission plus the worker its dispatch produced. */
async function rootWithWorker(
  mounted: Awaited<ReturnType<typeof mount>>,
): Promise<{ root: string; worker: ReturnType<typeof agent> }> {
  const created = await callTool(
    mounted,
    'create_mission',
    { title: 'T', description: 'd', analysis: ['because'] },
    mounted.owner,
  )
  const root = String(created.data?.root_id ?? '')
  await mounted.flush()
  return { root, worker: worker(String(mounted.dispatched.at(-1)?.childId ?? '')) }
}

/** The worker dispatched for one node, found by the id its prompt carries. */
function workerFor(mounted: Awaited<ReturnType<typeof mount>>, nodeId: string): ReturnType<typeof agent> {
  // The node's CURRENT executor: after a wake that is the same session the node was parked
  // on, which no longer appears as the newest entry in `dispatched`.
  return executorFor(mounted, nodeId)
}

describe('note_mission', () => {
  it('requires the analysis argument at the harness boundary', async () => {
    const mounted = await mount()
    const { root, worker: holder } = await rootWithWorker(mounted)
    await expect(
      callToolChecked(mounted, 'note_mission', { node_id: root }, holder),
    ).rejects.toThrow(/invalid arguments.*analysis/u)
    // The refusal happened before the tool body ran: nothing was recorded.
    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.node?.analysisNotes).toEqual([])
  })

  it('is declared with node_id and analysis both required', async () => {
    const mounted = await mount()
    const tool = mounted.registered.find((entry) => entry.name === 'note_mission')
    expect(tool?.parameters).toMatchObject({
      required: ['node_id', 'analysis'],
      properties: { node_id: { type: 'string' }, analysis: { type: 'string' } },
    })
  })

  it('records the analysis on the mission the caller holds, stamped with the dispatch', async () => {
    const mounted = await mount()
    const { root, worker: holder } = await rootWithWorker(mounted)
    const recorded = await callTool(mounted, 'note_mission', { node_id: root, analysis: NOTE }, holder)
    expect(recorded.ok).toBe(true)
    expect(recorded.data?.['analysis_attempt']).toBe(1)

    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.node?.analysisNotes).toEqual([NOTE])
    expect(detail.node?.analysisAttempt).toBe(1)
  })

  it('refuses a caller that does not hold the mission', async () => {
    const mounted = await mount()
    const { root } = await rootWithWorker(mounted)
    const stranger = await callTool(mounted, 'note_mission', { node_id: root, analysis: NOTE }, worker('mission-outside'))
    expect(stranger.data?.['code']).toBe('not-owner')
    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.node?.analysisNotes).toEqual([])
  })

  it('refuses an analysis with no content', async () => {
    const mounted = await mount()
    const { root, worker: holder } = await rootWithWorker(mounted)
    // The tool boundary rejects an empty string before the tree is asked; the tree's own
    // `no-analysis` refusal covers the blank-text case.
    await expect(
      callTool(mounted, 'note_mission', { node_id: root, analysis: '' }, holder),
    ).rejects.toThrow('must be a non-empty string')
    const blank = await callTool(mounted, 'note_mission', { node_id: root, analysis: '   ' }, holder)
    expect(blank.ok).toBe(false)
    expect(blank.data?.['code']).toBe('no-analysis')
    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.node?.analysisNotes).toEqual([])
  })
})

describe('decompose_mission requires the current dispatch to have noted its analysis', () => {
  it('refuses the split when nothing was noted, leaving no side effect', async () => {
    const mounted = await mount()
    const { root, worker: holder } = await rootWithWorker(mounted)
    const refused = await callTool(
      mounted,
      'decompose_mission',
      { node_id: root, children: [{ title: 'sub', description: 'd', context: ['why'] }] },
      holder,
    )
    expect(refused.ok).toBe(false)
    expect(refused.data?.['code']).toBe('analysis-missing')
    expect(refused.summary).toContain('还没写下为什么拆')
    expect(refused.summary).toContain('note_mission')

    // No child, no attempt burned, and the worker still owns the mission.
    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.children).toEqual([])
    expect(detail.node?.status).toBe('running')
    expect(detail.node?.attempts).toBe(1)
  })

  it('admits the split once THIS dispatch noted its analysis', async () => {
    const mounted = await mount()
    const { root, worker: holder } = await rootWithWorker(mounted)
    expect((await callTool(mounted, 'note_mission', { node_id: root, analysis: NOTE }, holder)).ok).toBe(true)
    const split = await callTool(
      mounted,
      'decompose_mission',
      { node_id: root, children: [{ title: 'sub', description: 'd', context: ['why'] }] },
      holder,
    )
    expect(split.ok).toBe(true)
  })

  it('closes again after the mission is dispatched once more', async () => {
    const mounted = await mount()
    const { root, worker: rootWorker } = await rootWithWorker(mounted)
    const split = await noteAndSplit(
      mounted,
      root,
      [{ title: 'sub', description: 'd', context: ['why'] }],
      rootWorker,
      { note: NOTE },
    )
    expect(split.ok).toBe(true)
    const childId = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
    await mounted.flush()
    await callTool(mounted, 'submit_mission', { node_id: childId, result: 'twelve call sites' }, workerFor(mounted, childId))

    // The owner's step wakes the session that decomposed: the aggregate pass runs THERE,
    // and the note that justified the first split is not an argument for the second one
    // (the gate is per-dispatch, and a wake is a new dispatch round).
    await mounted.wake()
    const aggregate = workerFor(mounted, root)
    expect(aggregate.id).toBe(rootWorker.id)
    const refused = await callTool(
      mounted,
      'decompose_mission',
      { node_id: root, children: [{ title: 'follow-up', description: 'd', context: [] }] },
      aggregate,
    )
    expect(refused.ok).toBe(false)
    expect(refused.data?.['code']).toBe('analysis-missing')

    // This round's analysis opens it, and both notes stay on the mission.
    await callTool(mounted, 'note_mission', { node_id: root, analysis: '缺前置结论：第一次结果只是部分结果' }, aggregate)
    const again = await callTool(
      mounted,
      'decompose_mission',
      { node_id: root, children: [{ title: 'follow-up', description: 'd', context: [] }] },
      aggregate,
    )
    expect(again.ok).toBe(true)
    const detail = await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: root })
    expect(detail.node?.analysisNotes).toEqual([NOTE, '缺前置结论：第一次结果只是部分结果'])
    expect(detail.node?.analysisAttempt).toBe(2)
  })
})

describe('the aggregate dispatch prompt', () => {
  it('carries the recorded analysis inside 本任务, before the children results', async () => {
    const mounted = await mount()
    const { root, worker: rootWorker } = await rootWithWorker(mounted)
    const split = await noteAndSplit(
      mounted,
      root,
      [{ title: 'sub', description: 'd', context: ['why'] }],
      rootWorker,
      { note: NOTE },
    )
    const childId = String((split.data?.['created'] as string[] | undefined)?.[0] ?? '')
    await mounted.flush()
    await callTool(mounted, 'submit_mission', { node_id: childId, result: 'twelve call sites' }, workerFor(mounted, childId))

    // The convergence pass arrives as a WAKE on the session that decomposed, so the prompt
    // to inspect is the one that session last received — not a fresh dispatch entry.
    await mounted.wake()
    expect(executorFor(mounted, root).id).toBe(rootWorker.id)
    const prompt = promptFor(mounted, root)
    expect(prompt).toContain('本任务：')
    expect(prompt).toContain('执行本任务时写下的分析（由上一次执行本任务的执行者记录）：')
    expect(prompt).toContain(NOTE)
    expect(prompt).toContain('twelve call sites')
    expect(prompt.indexOf('本任务：')).toBeLessThan(prompt.indexOf('执行本任务时写下的分析'))
    expect(prompt.indexOf('执行本任务时写下的分析')).toBeLessThan(prompt.indexOf('子任务结果：'))
  })
})

describe('the note_mission face', () => {
  it('is hidden from the owner and visible to a worker', () => {
    expect(OWNER_TOOL_DENY).toContain('note_mission')
    expect(WORKER_TOOL_DENY).not.toContain('note_mission')
    const tools = [{ name: 'note_mission' }, { name: 'decompose_mission' }, { name: 'create_mission' }]
    expect(visibleTo(tools, OWNER_TOOL_DENY).map((tool) => tool.name)).toEqual(['create_mission'])
    expect(visibleTo(tools, WORKER_TOOL_DENY).map((tool) => tool.name)).toEqual(['note_mission', 'decompose_mission'])
  })

  it('keeps note_mission out of the owner assembly and leaves a worker list untouched', async () => {
    const mounted = await mount()
    const assembly = {
      sections: [],
      contexts: [],
      tools: [
        { name: 'note_mission', description: '', parameters: {} },
        { name: 'create_mission', description: '', parameters: {} },
      ],
      variables: {},
    }
    const filtered = await mounted.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent: mounted.owner as never },
      () => Promise.resolve(assembly as never),
    )
    expect(filtered.tools.map((tool) => tool.name)).toEqual(['create_mission'])

    const untouched = await mounted.ctx.waterfall(
      'system-prompt/assemble',
      assembly,
      { agent: worker('mission-1') as never },
      () => Promise.resolve(assembly as never),
    )
    expect(untouched.tools.map((tool) => tool.name)).toEqual(['note_mission', 'create_mission'])
  })
})
