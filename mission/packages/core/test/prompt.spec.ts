/**
 * Worker prompt construction.
 *
 * These are the load-bearing wording rules: the mission chain must stay bounded, the
 * aggregate tail must carry the children's conclusions, and — most importantly —
 * the execution prompt must never mention sub-mission progress, because that is what
 * invites a worker to wait instead of finishing.
 */
import { describe, expect, it } from 'vitest'
import { buildProgressLine, buildWorkerPrompt, CAPACITY, isTroubled, isTroubledNode, waitedLabel, type ContinuationDelta, type DispatchView, type NodeRecord } from '../src/index.js'

function node(overrides: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id: 'n0001',
    rootId: 'n0001',
    parentId: null,
    title: 'Root mission',
    description: 'Do the whole thing',
    unit: null,
    weight: 1,
    roundMs: null,
    context: [],
    corrections: [],
    correctionsDeliveredUpTo: 0,
    analysisNotes: [],
    analysisAttempt: 0,
    analysisAuthor: null,
    status: 'ready',
    createdAt: 1,
    depth: 1,
    claimedBy: null,
    claimedAt: 0,
    attempts: 1,
    failures: 0,
    spawnFailures: 0,
    parkedWorker: null,
    lastWorkerId: null,
    executorSessionId: null,
    dispatchBaseline: null,
    progressAt: 0,
    activityAt: 0,
    stalls: 0,
    hungCount: 0,
    stalledNotifiedAt: null,
    result: null,
    hasResult: false,
    resultReadAt: null,
    resultRef: null,
    resultHint: null,
    children: [],
    updatedAt: 1,
    ...overrides,
  }
}

function view(overrides: Partial<DispatchView> = {}): DispatchView {
  return { node: node(), chain: [], children: [], ...overrides }
}

describe('execution prompt', () => {
  it('carries the node id so the worker can submit', () => {
    const prompt = buildWorkerPrompt(view({ node: node({ id: 'abc12345' }) }))
    expect(prompt).toContain('abc12345')
  })

  it('states both permitted endings', () => {
    const prompt = buildWorkerPrompt(view())
    expect(prompt).toContain('submit_mission')
    expect(prompt).toContain('decompose_mission')
    // Regression guard: the prompt must name the tools the runtime actually registers.
    // It once said `decompose` / `submit_result`, neither of which exists — a worker
    // recovered from its tool list, but naming a missing tool is a wasted turn.
    expect(prompt).not.toMatch(/(?<![_a-z])(decompose|submit_result)(?![_a-z])/)
    expect(prompt).toContain('不要等')
  })

  it('warns an executor at the depth ceiling, and only there', () => {
    // The engine refuses a decomposition at depth `maxDepth`, and before this line the refusal was the
    // only place that fact existed: the executor spent `note_mission` + `decompose_mission` on a call that
    // could not succeed, and a node that never recovered was reclaimed as `stalled` — a structural
    // ceiling recorded as an executor that hung.
    const below = buildWorkerPrompt(view({ node: node({ depth: CAPACITY.maxDepth - 1 }) }))
    expect(below).not.toContain('深度上限')

    const atCeiling = buildWorkerPrompt(view({ node: node({ depth: CAPACITY.maxDepth }) }))
    expect(atCeiling).toContain(`深度上限（第 ${String(CAPACITY.maxDepth)} 层）`)
    expect(atCeiling).toContain('submit_mission')
    // It must NOT tell the executor to decompose at a depth where the engine will refuse it.
    expect(atCeiling).toContain('不要再 note_mission + decompose_mission')
  })

  it('warns the aggregate pass at the ceiling too: its tail also suggests decomposing', () => {
    const child = node({ id: 'n0002', parentId: 'n0001', title: 'Child', status: 'done', depth: CAPACITY.maxDepth })
    const atCeiling = buildWorkerPrompt(view({ node: node({ depth: CAPACITY.maxDepth }), children: [child] }))
    expect(atCeiling).toContain('子任务都已终态')
    expect(atCeiling).toContain('深度上限')
  })

  it('asks the analysis to record what was RULED OUT, not just what is missing', () => {
    // Progressive convergence is exclusion as much as addition: a later executor — or the
    // same session woken again after its children land — needs to know which route was
    // already tried and why it was dropped, or the next round can re-walk a rejected path.
    // Both `note_mission` sites carry the requirement: the decompose tail and the aggregate tail.
    const execute = buildWorkerPrompt(view({ node: node({ status: 'running' }) }))
    expect(execute).toContain('排除了哪条路以及为什么')
    const aggregate = buildWorkerPrompt(view({ node: node({ status: 'ready', children: ['c'] }) }))
    expect(aggregate).toContain('排除了哪条路以及为什么')
  })

  it('never mentions sub-mission progress', () => {
    // A progress line is the single most reliable way to make a worker wait.
    const prompt = buildWorkerPrompt(view({ node: node({ id: 'mid' }) }))
    expect(prompt).not.toMatch(/\d+\s*\/\s*\d+/u)
    expect(prompt).not.toContain('sub-mission')
    expect(prompt).not.toContain('子任务结果')
  })

  it('keeps the mission chain to one line per ancestor', () => {
    const chain = [
      node({ id: 'r', title: 'Root', description: 'ROOT DESCRIPTION', context: ['root reason'] }),
      node({ id: 'm', title: 'Middle', description: 'MIDDLE DESCRIPTION', context: ['middle reason'], depth: 2 }),
    ]
    const prompt = buildWorkerPrompt(view({ node: node({ id: 'leaf', depth: 3, parentId: 'm' }), chain }))
    // Titles and one context line travel; the ancestors' full descriptions do not.
    expect(prompt).toContain('Root')
    expect(prompt).toContain('Middle')
    expect(prompt).toContain('root reason')
    expect(prompt).not.toContain('ROOT DESCRIPTION')
    expect(prompt).not.toContain('MIDDLE DESCRIPTION')
  })

  it('tells the executor how much failure budget is left, and only after a failure', () => {
    // Dispatches that SUCCEED also raise `attempts` (an aggregate/convergence round is one),
    // so a high count must not be reported as "the earlier ones did not finish".
    const converging = buildWorkerPrompt(view({ node: node({ attempts: 6, failures: 0 }) }))
    expect(converging).not.toContain('没有交出结果')
    expect(converging).not.toContain('执行预算')

    const once = buildWorkerPrompt(view({ node: node({ attempts: 2, failures: 1 }) }))
    expect(once).toContain('之前有 1 次执行没有交出结果')
    expect(once).toContain(`再失败 ${String(CAPACITY.maxAttempts - 1)} 次`)

    // The last dispatch before the ceiling must say so plainly: there is no next try.
    const last = buildWorkerPrompt(
      view({ node: node({ attempts: 5, failures: CAPACITY.maxAttempts - 1 }) }),
    )
    expect(last).toContain(`再失败 1 次`)
    const exhausted = buildWorkerPrompt(
      view({ node: node({ attempts: 5, failures: CAPACITY.maxAttempts }) }),
    )
    expect(exhausted).toContain('执行预算已用尽')
  })

  it('renders the recorded analysis inside 本任务, and says nothing about it when empty', () => {
    const bare = buildWorkerPrompt(view({ node: node({ attempts: 2 }) }))
    expect(bare).not.toContain('执行本任务时写下的分析')

    const noted = node({
      attempts: 2,
      analysisNotes: ['缺前置事实：先拿到调用点清单', '拿到后再判断改动范围'],
    })
    const prompt = buildWorkerPrompt(view({ node: noted }))
    expect(prompt).toContain('执行本任务时写下的分析（由上一次执行本任务的执行者记录）：')
    expect(prompt).toContain('缺前置事实：先拿到调用点清单')
    expect(prompt).toContain('拿到后再判断改动范围')
    // Inside 「本任务」: after the node's own block, before any aggregate section.
    expect(prompt.indexOf('本任务：')).toBeLessThan(prompt.indexOf('执行本任务时写下的分析'))
  })
})

describe('the capacity-queue notice', () => {
  // The report this answers: a run that had queued 123 seconds behind a full machine told its owner
  // "I did not wait", because the prompt it was handed contained no such fact. The number comes from
  // the engine's own aging clock, through `WorkerPromptOptions.capacityWaitedMs`.
  it('states the wait when the engine actually deferred this dispatch', () => {
    const prompt = buildWorkerPrompt(view(), { capacityWaitedMs: 123_000 })
    expect(prompt).toContain('本任务在容量队列里等了约 2 分钟（原因：机器容量已被占用）')
    // Stated before the mission block: it is a fact about why this dispatch is starting now.
    expect(prompt.indexOf('容量队列')).toBeLessThan(prompt.indexOf('本任务：'))
  })

  it('renders sub-minute waits in seconds, rounded and approximate', () => {
    expect(buildWorkerPrompt(view(), { capacityWaitedMs: 12_400 })).toContain('等了约 12 秒')
    // A few milliseconds is still "it queued": never "0 秒", which would read as "no wait".
    expect(buildWorkerPrompt(view(), { capacityWaitedMs: 5 })).toContain('等了约 1 秒')
    expect(waitedLabel(0)).toBe('约 1 秒')
    expect(waitedLabel(59_999)).toBe('约 60 秒')
    expect(waitedLabel(60_000)).toBe('约 1 分钟')
  })

  it('says NOTHING about a queue when the node was never deferred', () => {
    expect(buildWorkerPrompt(view())).not.toContain('容量队列')
    expect(buildWorkerPrompt(view(), { capacityWaitedMs: 0 })).not.toContain('容量队列')
  })
})

describe('the hand-off notice for a later execution', () => {
  // The complaint this answers: after a restart the mission looked like it was starting over — a
  // brand-new executor re-derived the plan and re-ran work the previous attempt may already have
  // left on disk. The notice is the one place that fact can be stated, and it has to differ between
  // "a fresh executor" and "the very session that was interrupted", because only the latter still
  // holds its own history.
  it('says nothing on a FIRST execution', () => {
    const prompt = buildWorkerPrompt(view({ node: node({ attempts: 1 }) }))
    expect(prompt).not.toContain('这是本任务第')
    expect(prompt).not.toContain('工作区')
  })

  it('tells a fresh executor which execution this is, and that the worktree may be dirty', () => {
    const prompt = buildWorkerPrompt(view({ node: node({ attempts: 2 }) }))
    expect(prompt).toContain('这是本任务第 2 次执行')
    expect(prompt).toContain('工作区里可能留着上一次执行的改动')
    expect(prompt).toContain('`git status`')
    // A fresh executor was not interrupted; only a resume may say so.
    expect(prompt).not.toContain('上一次执行被中断')
  })

  it('tells a RESUMED executor that it is continuing the interrupted session', () => {
    const prompt = buildWorkerPrompt(view({ node: node({ attempts: 2 }) }), { resumed: true })
    expect(prompt).toContain('这是本任务第 2 次执行')
    expect(prompt).toContain('上一次执行被中断')
    expect(prompt).toContain('接着那个会话继续')
  })
})

describe('the drift a cold wake reports', () => {
  // The resumed session is the one participant whose picture of the mission can be stale without it
  // being able to notice. The section sits between the hand-off notice and the mission block,
  // because that is the order it has to be read in: "you are continuing" → "here is what moved" →
  // "here is the mission".
  function drift(overrides: Partial<ContinuationDelta> = {}): ContinuationDelta {
    return {
      baselineKnown: true,
      corrections: [],
      notes: [],
      terminalChildren: 0,
      titleOrContentChanged: false,
      analysisFromAnotherDispatch: false,
      ...overrides,
    }
  }

  it('lists every channel that moved, between the notice and the mission block', () => {
    const delta = drift({
      corrections: ['换成先做 C'],
      notes: ['缺一个前置事实：先拿到调用点清单'],
      terminalChildren: 2,
      titleOrContentChanged: true,
    })
    const prompt = buildWorkerPrompt(view({ node: node({ attempts: 2 }) }), {
      resumed: true,
      corrections: delta.corrections,
      delta,
    })
    expect(prompt).toContain('自你上次执行后：')
    expect(prompt).toContain('新增纠偏 1 条')
    expect(prompt).toContain('新增执行笔记 1 条：缺一个前置事实：先拿到调用点清单')
    expect(prompt).toContain('2 个子任务达到终态')
    expect(prompt).toContain('本任务的标题或内容被改过')

    const noticeAt = prompt.indexOf('这是本任务第 2 次执行')
    const driftAt = prompt.indexOf('自你上次执行后：')
    const missionAt = prompt.indexOf('本任务：')
    expect(noticeAt).toBeGreaterThanOrEqual(0)
    expect(noticeAt).toBeLessThan(driftAt)
    expect(driftAt).toBeLessThan(missionAt)
  })

  it('says nothing when a known baseline shows no drift', () => {
    // The hand-off notice already says "you are continuing"; a block saying "nothing changed" on
    // every quiet wake would be pure noise.
    const prompt = buildWorkerPrompt(view({ node: node({ attempts: 2 }) }), {
      resumed: true,
      corrections: [],
      delta: drift(),
    })
    expect(prompt).not.toContain('自你上次执行后')
    expect(prompt).toContain('上一次执行被中断')
  })

  it('answers an UNKNOWN baseline with an honest caveat, never with silence', () => {
    // A record written before baselines existed cannot say what changed; "we cannot tell" must not be
    // dressed as "nothing changed", and the correction it carries must still reach the session.
    const delta = drift({ baselineKnown: false, corrections: ['没人读过这条'] })
    const prompt = buildWorkerPrompt(view({ node: node({ attempts: 2, corrections: ['没人读过这条'] }) }), {
      resumed: true,
      corrections: delta.corrections,
      delta,
    })
    expect(prompt).toContain('自你上次执行后的变化无法确定')
    expect(prompt).toContain('以当前视图为准')
    expect(prompt).toContain('没人读过这条')
    // It must not invent counts it does not have.
    expect(prompt).not.toContain('新增执行笔记')
    expect(prompt).not.toContain('达到终态')
  })

  it('is absent from a fresh spawn, which never executed this mission', () => {
    // The fresh path passes no delta at all — and must not grow one by accident, because "since you
    // last executed" is a lie for a session that has never executed anything.
    const prompt = buildWorkerPrompt(view({ node: node({ attempts: 3 }) }))
    expect(prompt).not.toContain('自你上次执行后')
    expect(prompt).not.toContain('无法确定')
    // The corrections it needs are all there regardless of the watermark.
    expect(prompt).toContain('这是本任务第 3 次执行')
  })
})

describe('which corrections one dispatch renders', () => {
  const corrected = () => node({
    attempts: 2,
    corrections: ['最早那条（已送达）', '后来那条（未送达）'],
    correctionsDeliveredUpTo: 1,
  })

  it('gives a fresh executor EVERY correction, watermark or not', () => {
    // A new session has read none of them; suppressing a delivered one here would hide a direction
    // the owner gave from the only executor that could act on it.
    const prompt = buildWorkerPrompt(view({ node: corrected() }))
    expect(prompt).toContain('最早那条（已送达）')
    expect(prompt).toContain('后来那条（未送达）')
  })

  it('gives a resumed session only what it has NOT read', () => {
    // `correctionsDeliveredUpTo` is the watermark; a wake renders the tail. The delivered one must
    // not be argued a second time to the session that already acted on it.
    const prompt = buildWorkerPrompt(view({ node: corrected() }), {
      resumed: true,
      corrections: corrected().corrections.slice(corrected().correctionsDeliveredUpTo),
    })
    expect(prompt).toContain('后来那条（未送达）')
    expect(prompt).not.toContain('最早那条（已送达）')
    expect(prompt).toContain('纠偏')
  })

  it('omits the correction block entirely when nothing is pending', () => {
    const prompt = buildWorkerPrompt(view({ node: corrected() }), { resumed: true, corrections: [] })
    // The tail mentions 纠偏消息 in general; what must be gone is the node's own block.
    expect(prompt).not.toContain('纠偏:')
    expect(prompt).not.toContain('后来那条（未送达）')
  })
})

describe('aggregate prompt', () => {
  const childA = node({
    id: 'a',
    parentId: 'n0001',
    title: 'Find callers',
    status: 'done',
    hasResult: true,
    result: 'twelve callers',
    depth: 2,
  })
  const childB = node({
    id: 'b',
    parentId: 'n0001',
    title: 'Write the shim',
    status: 'done',
    hasResult: true,
    result: 'shim merged',
    resultRef: 'spill:42',
    depth: 2,
  })

  it('carries every child conclusion and asks for the convergence judgement', () => {
    // The status here is the node's DISPATCHED status: the prompt is built after
    // dispatch() marked it `running`, so the branch may not depend on `ready`.
    const prompt = buildWorkerPrompt(
      view({
        node: node({ status: 'running', children: ['a', 'b'], attempts: 2 }),
        children: [childA, childB],
      }),
    )
    expect(prompt).toContain('twelve callers')
    expect(prompt).toContain('shim merged')
    expect(prompt).toContain('spill:42')
    expect(prompt).toContain('子任务都已终态')
    expect(prompt).toContain('submit_mission')
    expect(prompt).toContain('decompose_mission')
    // Regression guard: the prompt must name the tools the runtime actually registers.
    // It once said `decompose` / `submit_result`, neither of which exists — a worker
    // recovered from its tool list, but naming a missing tool is a wasted turn.
    expect(prompt).not.toMatch(/(?<![_a-z])(decompose|submit_result)(?![_a-z])/)
    // The aggregate must not be invited to redo the children's mission.
    expect(prompt).toContain('不要重做子任务')
  })

  it('marks a child that finished without a result', () => {    const silent = node({ id: 'c', parentId: 'n0001', title: 'Silent', status: 'done', hasResult: false, depth: 2 })
    const prompt = buildWorkerPrompt(
      view({ node: node({ status: 'running', children: ['c'], attempts: 2 }), children: [silent] }),
    )
    expect(prompt).toContain('未提交结果')
  })

  it('does not use the aggregate tail while children are still running', () => {
    // No terminal child in the view: this node is blocked and undispatchable, and
    // if a prompt were ever built for it, it must not read as a convergence pass.
    const prompt = buildWorkerPrompt(view({ node: node({ status: 'blocked', children: ['a'] }), children: [] }))
    expect(prompt).not.toContain('子任务都已终态')
  })

  it('renders the recorded analysis inside 本任务 and BEFORE the children results', () => {
    // The analysis is the premise for reading the conclusions, so order is the point:
    // rebuilt from a node the previous dispatch wrote, read by the aggregate pass.
    const prompt = buildWorkerPrompt(
      view({
        node: node({
          status: 'running',
          children: ['a', 'b'],
          attempts: 2,
          analysisNotes: ['上一次为什么拆：缺调用点清单'],
        }),
        children: [childA, childB],
      }),
    )
    expect(prompt).toContain('上一次为什么拆：缺调用点清单')
    expect(prompt.indexOf('本任务：')).toBeLessThan(prompt.indexOf('执行本任务时写下的分析'))
    expect(prompt.indexOf('执行本任务时写下的分析')).toBeLessThan(prompt.indexOf('子任务结果：'))
    expect(prompt.indexOf('执行本任务时写下的分析')).toBeLessThan(prompt.indexOf('twelve callers'))
    // The aggregate tail points the reader at that section by name.
    expect(prompt).toContain('先读「执行本任务时写下的分析」')
  })
})

describe('progress line', () => {
  it('anchors every clause so a stale copy is not a false statement', () => {
    const line = buildProgressLine({
      roots: [node({ status: 'done', hasResult: true })],
      ongoing: 2,
      troubled: true,
    })
    // Counts describe a moment, not "now"; no clock values anywhere.
    expect(line).toContain('2 个进行中')
    expect(line).toContain('反复出过问题')
    expect(line).not.toMatch(/\d{2}:\d{2}/u)
    expect(line).toContain('mission_result')
  })

  it('stops at "running or troubled": a per-state breakdown is not the owner\'s to act on', () => {
    const line = buildProgressLine({ roots: [node({ status: 'running' })], ongoing: 1, troubled: false })
    expect(line).toContain('1 个进行中')
    expect(line).not.toContain('反复出过问题')
    for (const word of ['待执行', '等待子任务', '已完成', '已失败']) {
      expect(line, `the progress line must not break the mission down into 「${word}」`).not.toContain(word)
    }
  })

  it('says so when there is no mission', () => {
    const line = buildProgressLine({ roots: [], ongoing: 0, troubled: false })
    expect(line).toContain('暂无任务')
  })

  it('separates "nothing running" from "nothing at all"', () => {
    const line = buildProgressLine({ roots: [node({ status: 'done', hasResult: true })], ongoing: 0, troubled: false })
    expect(line).toContain('暂无进行中的')
    expect(line).toContain('已结束的任务')
  })
})

describe('trouble detection', () => {
  it('stays quiet below the engine\'s own floors', () => {
    // A single stall or failure is a hiccup the engine recovers from by itself; `reportStall` would
    // not wake the owner for it either, and the two channels have to speak one vocabulary.
    expect(isTroubled([node({ status: 'running', stalls: 1 })])).toBe(false)
    expect(isTroubled([node({ status: 'ready', failures: 1 })])).toBe(false)
    expect(isTroubled([node({ status: 'ready', spawnFailures: 1 })])).toBe(false)
  })

  it('marks a mission that reached the floors, on any of the three counters', () => {
    expect(isTroubled([node({ status: 'running', stalls: CAPACITY.maxStallsBeforeReport })])).toBe(true)
    expect(isTroubled([node({ status: 'ready', failures: CAPACITY.maxAttempts - 1 })])).toBe(true)
    // Its own budget: nothing could be STARTED, however healthy the other two counters look.
    expect(isTroubled([node({ status: 'ready', spawnFailures: CAPACITY.maxAttempts - 1 })])).toBe(true)
  })

  it('keeps the mark after the mission recovers — it is history, not a live reading', () => {
    // The path this guard exists for: reclaimed, re-dispatched, now running fine. The counters never
    // reset, so the mission carries the mark for the rest of its life — which is exactly why the
    // MODEL-FACING wording is "反复出过问题" (it HAS BEEN in trouble), never "卡住了" (it IS stuck).
    expect(isTroubled([node({ status: 'running', stalls: CAPACITY.maxStallsBeforeReport })])).toBe(true)
  })

  it('does not call a finished mission troubled, however rough its history', () => {
    // The engine already recovered; a node that failed and later succeeded converged.
    expect(isTroubled([node({ status: 'done', failures: 4, stalls: 3 })])).toBe(false)
  })

  it('leaves a mission that is simply progressing alone', () => {
    expect(isTroubled([node({ status: 'running' })])).toBe(false)
  })

  it('exposes ONE predicate, so the flag and the heads-ups cannot disagree', () => {
    // The bug this pins: the flag counted `spawnFailures` while the stall gate did not, so a mission that
    // could not get a worker started read as 「反复出过问题」 in `list_missions` and the owner was never
    // told. `isTroubledNode` is that one predicate; `isTroubled` is it plus the terminal filter.
    for (const overrides of [
      { stalls: CAPACITY.maxStallsBeforeReport },
      { failures: CAPACITY.maxAttempts - 1 },
      { spawnFailures: CAPACITY.maxAttempts - 1 },
    ]) {
      expect(isTroubledNode(node({ ...overrides, status: 'running' })), JSON.stringify(overrides)).toBe(true)
      expect(isTroubled([node({ ...overrides, status: 'running' })])).toBe(true)
    }
    // Below the floors both say no; on a terminal node only the flag does (the predicate is about a
    // node's history, the filter is what makes it the owner's business).
    expect(isTroubledNode(node({ failures: 1 }))).toBe(false)
    expect(isTroubled([node({ failures: 1 })])).toBe(false)
    expect(isTroubledNode(node({ status: 'done', failures: 4 }))).toBe(true)
    expect(isTroubled([node({ status: 'done', failures: 4 })])).toBe(false)
  })
})

describe('the vocabulary the model reads', () => {
  // Every string here is read by a model with no other source of truth: a mission is the unit
  // it acts on, while the tree is only the shape the engine grows while decomposing. Naming
  // the shape describes nothing the model can act on, and it makes a mission read as a
  // container of nodes instead of the thing being done.
  const TREE_WORDS = ['任务树', '子树', '整棵树', '棵树', '节点', '树'] as const

  function expectNoTreeWording(text: string, where: string): void {
    for (const word of TREE_WORDS) {
      expect(text, `${where} must not say 「${word}」`).not.toContain(word)
    }
  }

  function ancestor(): NodeRecord {
    return node({ id: 'n0000', title: 'Root mission', context: ['because'], corrections: ['换成按新口径统计'] })
  }

  it('builds both tails without naming the shape', () => {
    // The chain carries a correction, which is how a descendant learns about an
    // adjustment written on the root — the case most likely to grow a tree word.
    expectNoTreeWording(
      buildWorkerPrompt(view({ node: node({ id: 'n0009', depth: 2 }), chain: [ancestor()] })),
      'execution prompt',
    )
    expectNoTreeWording(
      buildWorkerPrompt(
        view({
          node: node({ id: 'n0001', status: 'running', children: ['n0002'] }),
          chain: [ancestor()],
          children: [node({ id: 'n0002', title: 'Child', status: 'done', hasResult: true, result: '结论' })],
        }),
      ),
      'aggregate prompt',
    )
  })

  it('calls the ancestor path a chain of missions', () => {
    const prompt = buildWorkerPrompt(view({ node: node({ id: 'n0009', depth: 2 }), chain: [ancestor()] }))
    expect(prompt).toContain('任务链（根任务 → 本任务）')
  })

  it('keeps the hand-off notice out of the tree vocabulary too', () => {
    // The notice is NEW model-facing text, so it owes the same discipline as the rest: it may say
    // 工作区 (the checkout), never 树 (the engine's shape).
    expectNoTreeWording(
      buildWorkerPrompt(
        view({ node: node({ id: 'n0009', depth: 2, attempts: 3, corrections: ['换口径'] }) }),
        { resumed: true, corrections: ['换口径'] },
      ),
      'resumed prompt',
    )
  })

  it('keeps the drift section out of the tree vocabulary too', () => {
    // The drift is the other NEW model-facing text, and it is the one most tempted to describe the
    // engine's shape: it is literally about "things happening elsewhere". It says 子任务, never 树.
    expectNoTreeWording(
      buildWorkerPrompt(
        view({ node: node({ id: 'n0009', depth: 2, attempts: 3, corrections: ['换口径'] }) }),
        {
          resumed: true,
          corrections: ['换口径'],
          delta: {
            baselineKnown: true,
            corrections: ['换口径'],
            notes: ['缺前置事实'],
            terminalChildren: 2,
            titleOrContentChanged: true,
            analysisFromAnotherDispatch: false,
          },
        },
      ),
      'resumed prompt with drift',
    )
  })

  it('builds the progress line without naming the shape', () => {
    expectNoTreeWording(
      buildProgressLine({
        roots: [node({ status: 'running' })],
        ongoing: 1,
        troubled: true,
      }),
      'progress line',
    )
  })
})
