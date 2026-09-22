/**
 * The static routing-policy section: what the model is told about WHEN to create a
 * work tree, and — just as load-bearing — what it is not told.
 */
import { describe, expect, it } from 'vitest'
import { agent, mount } from './mount.js'

/** The registered section, by name. */
function section(mounted: Awaited<ReturnType<typeof mount>>) {
  const found = mounted.sections.find((entry) => entry.name === 'avantf:work-tree-guide')
  if (found === undefined) throw new Error('the guidance section is not registered')
  return found
}

describe('the work-tree guidance section', () => {
  it('registers one section, placed with the tool guidance', async () => {
    const mounted = await mount()
    expect(mounted.sections).toHaveLength(1)
    expect(section(mounted).name).toBe('avantf:work-tree-guide')
    // Tool guidance, not persona: `TOOL_JOBS` is where the harness documents its own
    // work tools, and this is the same kind of text for this plugin's family.
    expect(section(mounted).order).toBe(1600)
  })

  it('says what a work is for, in terms of works rather than trees', async () => {
    const mounted = await mount()
    const text = section(mounted).text({ agent: mounted.owner })
    expect(text).toContain('create_work')
    // The list is examples of what a work may look like, not the test for using one: an
    // independent work counts, and so does one that gets decomposed step by step.
    expect(text).toMatch(/独立的、需要调研的/)
    expect(text).toMatch(/逐步分解的/)
    expect(text).toMatch(/都算/)
    expect(text).toMatch(/需要拆的就交给执行者拆出前置工作，由引擎逐级派下去/)
    // The decomposer is the EXECUTOR; the engine only dispatches. "The engine decomposes" was the
    // contradiction this wording was rewritten to remove, so it is pinned as a negative.
    expect(text).not.toMatch(/引擎[^。]*拆/u)
    // No "do it here instead" clause: creating a work for independent work is legitimate.
    expect(text).not.toContain('不要建树')
  })

  it('admits an independent work: the test is deliverability, not difficulty', async () => {
    // Worth pinning because "it is not complicated" is the most common reason to keep a job in the
    // conversation, and it is the wrong test. A job that can be handed over WITH its acceptance
    // criteria belongs in a work however well understood it is: a work that needs no decomposition
    // is one executor doing it once, which is not a heavier shape than doing it here.
    const mounted = await mount()
    const text = section(mounted).text({ agent: mounted.owner })
    expect(text).toMatch(/不是"它复不复杂"/)
    expect(text).toMatch(/同样适合交给它/)
    expect(text).toMatch(/不需要拆的工作同样适合交给它/)
    // The old reading — "already thought through, therefore not a work" — is closed off by name.
    expect(text).toMatch(/不在这个名单里/)
  })

  it('does not fence off what a work may contain', async () => {
    // An earlier revision listed "irreversible outward actions" as something a work must not
    // contain. That is a narrowing this section has no business making: the owner decides what a
    // work is FOR, and reading its outcome back is what the read tool is for. What is fenced off is
    // the KIND OF HANDOFF (blind, one-shot, unreachable), never the subject matter.
    const mounted = await mount()
    const text = section(mounted).text({ agent: mounted.owner })
    expect(text).not.toMatch(/不可逆|发布、推送、删除/u)
  })

  it('says a correction reaches the executor, and what it costs when there is nothing to void', async () => {
    // The corollary of the paragraph above: for a work that was never decomposed, `adjust_work`
    // has nothing to void, so it is a straight message to the executor.
    const mounted = await mount()
    const text = section(mounted).text({ agent: mounted.owner })
    expect(text).toMatch(/消息会直接投递给正在执行它的执行者/)
    expect(text).toMatch(/没有未完成的子工作时，它就是一条投递给执行者的消息/)
  })

  it('describes only itself: no other plugin tool is named, and the limit is stated as its own', async () => {
    // The submission face is a deployment's choice, so anything the section says about OTHER tools
    // is a statement about a composition it cannot see. The boundary still has to be legible, so it
    // is drawn with a property of THIS plugin's executors (one-shot, blind, unreachable) rather
    // than by pointing at tools that may not be mounted at all.
    const mounted = await mount()
    const text = section(mounted).text({ agent: mounted.owner })
    expect(text).toMatch(/跨会话持久化/)
    expect(text).toMatch(/看不到本对话/)
    expect(text).toMatch(/不能追问/)
    expect(text).toMatch(/脚本化扇出/)
    // Every backticked token is one of ours, or an argument a caller must supply. Pinned as an
    // exact set: adding a name means deciding, here, that it belongs in this plugin's own words.
    const named = [...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1].split('(')[0])
    expect(new Set(named)).toEqual(new Set(['create_work', 'adjust_work']))
  })

  it('leaves the mechanics to the tool: no argument names in the static section', async () => {
    // How to fill `title` / `description` / `analysis` belongs to `create_work`'s own parameter
    // descriptions, which the model reads in the same request. Repeating them here spends per-turn
    // budget on text that is already present, and a section that starts listing mechanics stops
    // reading as the routing policy it exists to be.
    const mounted = await mount()
    const text = section(mounted).text({ agent: mounted.owner })
    for (const argument of ['title', 'description', 'analysis']) {
      expect(text, `the static section must not document the ${argument} argument`)
        .not.toContain(`\`${argument}\``)
    }
  })

  it('draws the boundary with its own executors, not with another tool family', async () => {
    // "Hand this off, or keep it here" is the decision an owner actually faces. What decides it is
    // that these executors are one-shot, unreachable, and blind to the conversation — so that is
    // what the section says, and the tool family that overlaps with it is not named.
    const mounted = await mount()
    const text = section(mounted).text({ agent: mounted.owner })
    expect(text).toMatch(/执行者是一次性的/)
    expect(text).toMatch(/看不到本对话/)
    expect(text).toMatch(/不能追问/)
    expect(text).toMatch(/脚本化扇出/)
    expect(text).not.toMatch(/subagent|workflow|ralph|todo_write|job_/u)
  })

  it('names the correction path, which is how a running work is steered', async () => {
    const mounted = await mount()
    const text = section(mounted).text({ agent: mounted.owner })
    expect(text).toContain('adjust_work')
    expect(text).toMatch(/只对根工作有效/)
    // The consequence is stated as the engine's, not as a second verb for the owner.
    expect(text).not.toContain('cancel_subworks')
    expect(text).toMatch(/调整后，它名下还没完成的子工作会被作废/)
  })

  it('says who waits, so the owner neither polls nor duplicates the work', async () => {
    const mounted = await mount()
    const text = section(mounted).text({ agent: mounted.owner })
    expect(text).toMatch(/引擎自己派活，并在根工作收敛时唤醒你/)
    expect(text).toMatch(/不要轮询/)
    expect(text).toMatch(/不要自己去做已经交出去的那些工作/)
  })

  it('stays silent for a session that may not root a tree', async () => {
    // A worker holds no `create_work` (the tool face removes it), so teaching it how to
    // create one would be teaching a tool it does not have.
    const mounted = await mount()
    const worker = agent('work-1', { origin: 'subagent', delegationDepth: 1 })
    expect(section(mounted).text({ agent: worker })).toBe('')
    expect(section(mounted).text({})).toBe('')
  })

  it('carries nothing the model cannot act on', async () => {
    // The rule for this text: no engine internals, no ids, no storage, no transport,
    // no worker-only vocabulary, and no tree — the owner acts on works, and the shape
    // they grow into is the engine's business. Each of these would be prompt budget
    // spent on something the owner can do nothing with.
    const mounted = await mount()
    const text = section(mounted).text({ agent: mounted.owner })
    // English internals (the identifiers an implementation leaks) plus their Chinese
    // counterparts, so the guard survives the copy being Chinese.
    for (const forbidden of [
      'ready', 'blocked', 'attempt', 'stall', 'reclaim', 'sweep', 'claimed',
      'storageDomain', 'Remote', 'snapshot', 'watch', 'decompose', 'submit_work',
      'work_result', 'finish_work', 'depth',
      '派发次数', '尝试次数', '回收', '轮询扫描', '卡死', '节点', '状态机',
      '工作树', '子树', '棵树', '树',
    ]) {
      expect(text.toLowerCase(), `guidance must not mention ${forbidden}`).not.toContain(forbidden.toLowerCase())
    }
  })
})
