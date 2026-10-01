/**
 * `/mission`: the human entry point.
 *
 * Two modes, and the split is the whole contract: bare `/mission` reports what is
 * running, while text after it roots a tree — the same thing an agent does with
 * `create_mission`, so a person can start a mission without asking the model to do it.
 */
import { describe, expect, it } from 'vitest'
import { callTool, mount, type Mounted } from './mount.js'

/**
 * The root the most recent `/mission <text>` created.
 *
 * Read from the service rather than parsed out of the command's own message: the
 * message is prose the reply is allowed to reword, while the tree is the fact.
 */
async function lastRootId(mounted: Mounted): Promise<string> {
  const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
  return snapshot.trees[0]?.rootId ?? ''
}

describe('the /mission registration', () => {
  it('describes itself in Chinese, because the command palette is Chinese', async () => {
    // This copy is read by the person typing the command, not by the model: the rest
    // of the plugin's model-facing text is English, this is not.
    const mounted = await mount()
    const command = mounted.commands.find((entry) => entry.name === 'mission')
    if (command === undefined) throw new Error('/mission is not registered')
    expect(command.description).toMatch(/[\u4e00-\u9fff]/)
    expect(command.description).not.toMatch(/[A-Za-z]{4,}/)
    expect(command.input?.hint).toBe('[任务描述]')
  })
})

describe('the /archive and /clean registrations', () => {
  it('are registered with Chinese copy and an input hint', async () => {
    // Both are read by the person typing them (like /mission), and neither name collides with
    // a first-party command (`export` / `compact` / `plan` / `goal` / `feedback`).
    const mounted = await mount()
    const names = mounted.commands.map((entry) => entry.name).sort()
    expect(names).toEqual(['archive', 'clean', 'mission'])
    for (const name of ['archive', 'clean']) {
      const command = mounted.commands.find((entry) => entry.name === name)
      // Chinese copy, but these two MUST name `/clean` and the `mission-xxxxxxxx` id shape,
      // so unlike /mission they cannot be Latin-free.
      expect(command?.description, name).toMatch(/[\u4e00-\u9fff]/)
      expect(command?.description, name).toMatch(/mission|会话/)
    }
    // The hint is the grammar in one line: both scopes, both targets, and the id shapes.
    expect(mounted.commands.find((entry) => entry.name === 'clean')?.input?.hint)
      .toBe('[archive [all|mission-xxxxxxxx] | orphans [all|root-xxxxxxxx]]')
  })

  it('reports an empty store instead of failing', async () => {
    // The commands must degrade to "nothing here", never to a thrown error inside a slash handler.
    const mounted = await mount()
    expect((await mounted.runCommand('clean', '')).text).toContain('没有 mission 会话记录')
    expect((await mounted.runCommand('archive', '')).text).toContain('无法归档')
  })
})

describe('/mission with no input', () => {
  it('reports that there is nothing yet', async () => {
    const mounted = await mount()
    const result = await mounted.runCommand('mission', '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('本会话没有任务')
  })

  it('treats whitespace as no input', async () => {
    const mounted = await mount()
    // The registry hands back the separator whitespace, so a bare `/mission ` is the
    // same command as `/mission`.
    expect((await mounted.runCommand('mission', '   ')).text).toContain('本会话没有任务')
  })

  it('lists the trees it owns, with their status rollup', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'Migrate', description: 'd', analysis: [] },
      mounted.owner,
    )
    const rootId = String(created.data?.['root_id'] ?? '')
    const result = await mounted.runCommand('mission', '')
    expect(result.text).toContain(rootId)
    expect(result.text).toContain('Migrate')
  })

  it('accepts an explicit list verb', async () => {
    const mounted = await mount()
    await mounted.runCommand('mission', 'build the thing')
    expect((await mounted.runCommand('mission', 'list')).text).toContain('个任务')
    expect((await mounted.runCommand('mission', 'ls')).text).toContain('个任务')
  })
})

describe('/mission with input', () => {
  it('creates a root from the text', async () => {
    const mounted = await mount()
    const result = await mounted.runCommand('mission', ' Migrate the API to v2 ')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Migrate the API to v2')

    // It is a real root: dispatched, owned by the caller, visible to the tools.
    const rootId = await lastRootId(mounted)
    expect(rootId).not.toBe('')
    expect(mounted.dispatched).toHaveLength(1)
    expect(mounted.dispatched[0]?.prompt).toContain(rootId)
    expect(mounted.dispatched[0]?.prompt).toContain('Migrate the API to v2')

    const shown = await callTool(mounted, 'list_missions', {}, mounted.owner)
    expect(shown.ok, shown.summary).toBe(true)
    expect(shown.summary).toContain('Migrate the API to v2')
  })

  it('uses the first line as the title, and keeps the whole text as the description', async () => {
    const mounted = await mount()
    await mounted.runCommand('mission', 'Ship the migration\nMove every caller to v2\nThen delete v1')
    const rootId = await lastRootId(mounted)
    const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
    const node = snapshot.trees.flatMap((tree) => tree.nodes).find((entry) => entry.id === rootId)
    expect(node?.title).toBe('Ship the migration')
    // The body is NOT in the summary (rows never render it, and the summary is re-sent
    // on every change); it is read through `detail` when a row is expanded.
    expect(node).not.toHaveProperty('description')
    expect((await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: rootId })).node?.description)
      .toBe('Ship the migration\nMove every caller to v2\nThen delete v1')
    // No owner analysis exists for a slash command, and none is invented.
    expect(node?.context).toEqual([])
  })

  it('elides a title that would not fit one line', async () => {
    const mounted = await mount()
    const long = 'x'.repeat(300)
    await mounted.runCommand('mission', long)
    const rootId = await lastRootId(mounted)
    const snapshot = await mounted.host.snapshot({ sessionId: mounted.owner.id })
    const node = snapshot.trees.flatMap((tree) => tree.nodes).find((entry) => entry.id === rootId)
    const title = node?.title ?? ''
    expect(title.length).toBeLessThanOrEqual(80)
    expect(title.endsWith('…')).toBe(true)
    // The full text still travels as the description.
    expect((await mounted.host.detail({ sessionId: mounted.owner.id, nodeId: rootId })).node?.description)
      .toHaveLength(300)
  })

  it('reports a refusal instead of throwing', async () => {
    const mounted = await mount()
    // A mission unit may not root its own tree; the command path must surface that
    // as an error result rather than an exception the client cannot render.
    const worker = mounted.makeLive('mission-worker')
    const subagent = { ...worker, header: { origin: 'subagent' as const, delegationDepth: 1 }, session: { header: { origin: 'subagent' as const, delegationDepth: 1 } } }
    const result = await mounted.runCommand('mission', 'do my own thing', subagent)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('no-authority')
  })
})

describe('the create_mission tool description', () => {
  it('says when NOT to use it, by describing its own executors rather than other tools', async () => {
    // The overlap with plain delegation is the decision an owner actually faces, so the tool that
    // starts a mission is where the boundary has to be legible — but legible from THIS description
    // alone: naming another plugin's tools would be describing a composition it cannot see.
    const mounted = await mount()
    const tool = mounted.registered.find((entry) => entry.name === 'create_mission') as
      | { description?: string }
      | undefined
    const description = tool?.description ?? ''
    expect(description).toContain('独立的、需要调研的')
    expect(description).toMatch(/一次性执行者/)
    expect(description).toMatch(/看不到本对话/)
    expect(description).toMatch(/不能追问/)
    // Same correction as the guidance section: an independent, already-decided job is a first-class
    // use, so the decision the model reads is deliverability rather than difficulty.
    expect(description).toMatch(/不是"它复不复杂"/)
    expect(description).toMatch(/同样适合交给它/)
    // What a mission may contain is the owner's call: the description bounds the KIND OF HANDOFF,
    // never the subject matter.
    expect(description).not.toMatch(/不可逆|发布、推送、删除/u)
    expect(description).not.toMatch(/subagent|workflow|ralph|todo_write|job_/u)
  })
})
