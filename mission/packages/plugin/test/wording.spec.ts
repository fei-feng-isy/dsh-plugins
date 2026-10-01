/**
 * The vocabulary the model reads: missions, never the shape they grow into.
 *
 * A mission is the unit the model acts on. The tree is what appears while the engine
 * decomposes it, and naming that shape spends prompt budget on something the model can do
 * nothing with — worse, it invites reading a mission as a container of nodes rather than as
 * the thing being done. So this guard walks every model-facing surface: the declarations
 * (name + parameters), the summaries and refusals a call returns, the static guidance
 * section, and what `/mission` echoes back.
 *
 * `ToolDefinition.parameters` is checked as one string: the model receives that JSON
 * Schema verbatim, so a stray word in one nested description leaks exactly like a
 * top-level one.
 */
import { describe, expect, it } from 'vitest'
import { agent, callTool, mount } from './mount.js'

/** Tree vocabulary, in every form the copy has carried (量词 included). */
const TREE_WORDS = ['任务树', '子树', '整棵树', '棵树', '节点', '树'] as const

/** Fail loudly on the exact word, not just on "some text differed". */
function expectNoTreeWording(text: string, where: string): void {
  for (const word of TREE_WORDS) {
    expect(text, `${where} must not say 「${word}」`).not.toContain(word)
  }
}

describe('the model-facing wording', () => {
  it('declares every tool without naming the shape', async () => {
    const mounted = await mount()
    // Non-vacuity: the loop below proves nothing if the registry came back empty.
    expect(mounted.registered).toHaveLength(9)
    for (const tool of mounted.registered) {
      expectNoTreeWording(tool.description ?? '', `${tool.name} description`)
      expectNoTreeWording(JSON.stringify(tool.parameters ?? {}), `${tool.name} parameter descriptions`)
    }
  })

  it('describes only its own tools, never another plugin\'s', async () => {
    // The whole surface is this plugin's own: every tool description and parameter text must be
    // readable by a deployment that mounts nothing else. A name from another family here is a
    // statement about a composition this plugin cannot see (and one the fold-it-in rename exists
    // to stop people guessing at).
    const FOREIGN = [
      'subagent', 'workflow', 'ralph', 'todo_write', 'create_goal', 'get_goal', 'update_goal',
      'ask_user_question', 'job_list', 'job_output', 'job_kill', 'bash', 'web_search', 'web_fetch',
    ]
    const mounted = await mount()
    expect(mounted.registered).toHaveLength(9)
    for (const tool of mounted.registered) {
      const text = `${tool.description ?? ''} ${JSON.stringify(tool.parameters ?? {})}`
      for (const name of FOREIGN) {
        expect(text, `${tool.name} must not name ${name}`).not.toContain(name)
      }
    }
  })

  it('returns summaries and refusals in the same vocabulary', async () => {
    const mounted = await mount()
    const worker = agent('mission-0f0f0f0f')
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'T', description: 'd', analysis: ['because'] },
      mounted.owner,
    )
    const rootId = String(created.data?.['root_id'] ?? '')
    expect(rootId).not.toBe('')

    // Both outcomes of every tool: the refusals explain a wrong call, the summaries
    // confirm a right one, and both land in the model's context.
    const calls: { name: string; args: Record<string, unknown>; caller: ReturnType<typeof agent> }[] = [
      { name: 'create_mission', args: { title: 'T2', description: 'd', analysis: [] }, caller: mounted.owner },
      { name: 'list_missions', args: {}, caller: mounted.owner },
      { name: 'mission_result', args: { node_id: rootId }, caller: mounted.owner },
      { name: 'adjust_mission', args: { root_id: rootId, adjustment: '换成按新口径统计' }, caller: mounted.owner },
      { name: 'finish_mission', args: { root_id: rootId }, caller: mounted.owner },
      { name: 'cancel_mission', args: { root_id: rootId }, caller: mounted.owner },
      { name: 'mission_result', args: { node_id: 'no-such-mission' }, caller: mounted.owner },
      { name: 'adjust_mission', args: { root_id: 'no-such-mission', adjustment: 'x' }, caller: mounted.owner },
      { name: 'finish_mission', args: { root_id: 'no-such-mission' }, caller: mounted.owner },
      { name: 'cancel_mission', args: { root_id: 'no-such-mission' }, caller: mounted.owner },
      {
        name: 'decompose_mission',
        args: { node_id: rootId, children: [{ title: 'c', description: 'd', context: ['why'] }] },
        caller: worker,
      },
      { name: 'submit_mission', args: { node_id: rootId, result: 'r' }, caller: worker },
      { name: 'list_missions', args: {}, caller: agent('a-stranger') },
    ]
    for (const call of calls) {
      const result = await callTool(mounted, call.name, call.args, call.caller)
      expect(result.summary, `${call.name} returned nothing to check`).not.toBe('')
      expectNoTreeWording(result.summary, `${call.name} summary`)
    }
  })

  it('answers /mission and the guidance section in the same vocabulary', async () => {
    const mounted = await mount()
    for (const command of mounted.commands) {
      expectNoTreeWording(command.description, `/${command.name} description`)
    }
    const empty = await mounted.runCommand('mission', '')
    expectNoTreeWording(empty.text ?? '', '/mission (empty)')
    const created = await mounted.runCommand('mission', 'T\n描述')
    expectNoTreeWording(created.text ?? '', '/mission (create)')
    const listed = await mounted.runCommand('mission', '')
    expectNoTreeWording(listed.text ?? '', '/mission (list)')

    const guidance = mounted.sections.find((entry) => entry.name === 'avantf:mission-tree-guide')
    expect(guidance, 'the guidance section is not registered').toBeDefined()
    expectNoTreeWording(guidance?.text({ agent: mounted.owner }) ?? '', 'the guidance section')
  })
})
