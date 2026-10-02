/**
 * The "任务" view's rendering: what a reader sees in a row, and what the detail DIALOG shows
 * in each of its sections.
 *
 * Rendered to static markup rather than into a DOM on purpose — the parts worth pinning are
 * the dialog's own branches (loading / error / spilled result) and the section set, none of
 * which need a click simulation, and all of which a wrong branch would silently get wrong in
 * the browser.
 *
 * The section model is therefore asked of `detailTabs` (pure) as well as of the rendered
 * dialog: static markup cannot press a nav cell, and "what does 纠偏 hold" is a fact about
 * the data, not about a click.
 */
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MissionDetailDialog,
  MissionTreeView,
  ResultPane,
  WorkerSessionHint,
  WorkerSessionLink,
  detailTabs,
  workerSessionClick,
  workerSessionTarget,
} from '../src/client/MissionTreeView.js'
import { apply } from '../src/client/index.js'
import type {
  MissionNodeDetail,
  MissionNodeView,
  MissionSnapshot,
  MissionSnapshotState,
  WorkerSessionTarget,
} from '../src/client/contract.js'
import { statusLabel } from '@avantf/mission-core'

// The view injects its stylesheet on render, which is the one browser API in its path.
// The tags are kept so the stylesheet itself can be asserted.
const styleTags: { id: string; textContent: string }[] = []
beforeAll(() => {
  ;(globalThis as { document?: unknown }).document = {
    getElementById: (id: string) => styleTags.find((tag) => tag.id === id) ?? null,
    createElement: () => ({ id: '', setAttribute: (): void => undefined, textContent: '' }),
    head: { appendChild: (tag: { id: string; textContent: string }) => { styleTags.push(tag) } },
  }
})

/**
 * A tree three levels deep — a live root, a live child, a live grandchild — with the
 * statuses overridable so the expansion rules can be checked in both directions.
 */
function snapshot(
  statuses: { root?: string; child?: string; grandchild?: string } = {},
  corrections: { root?: readonly string[]; child?: readonly string[] } = {},
): MissionSnapshot {
  const node = (
    id: string, parentId: string | null, title: string, depth: number, status: string, attempts: number,
    children: readonly string[] = [], ownCorrections: readonly string[] = [],
  ): MissionNodeView => ({
    id, parentId, children, title, context: [], corrections: ownCorrections, status, attempts, depth,
    createdAt: depth, hasResult: status === 'done', resultRef: null, workerSessionId: null,
  })
  return {
    trees: [{
      rootId: 'r1',
      closedAt: null,
      nodes: [
        node('r1', null, 'Ship it', 1, statuses.root ?? 'running', 1, ['c1'], corrections.root ?? []),
        node('c1', 'r1', 'the part', 2, statuses.child ?? 'running', 2, ['g1'], corrections.child ?? []),
        node('g1', 'c1', 'the sub-part', 3, statuses.grandchild ?? 'running', 1),
      ],
    }],
  }
}

/** A detail payload as the host returns it. */
function detail(overrides: Partial<MissionNodeDetail['node']> = {}, children: MissionNodeDetail['children'] = []): MissionNodeDetail {
  return {
    node: {
      id: 'r1', rootId: 'r1', title: 'Ship it', description: '把迁移发出去', context: ['prod 已冻结', '回滚脚本在这'],
      analysisNotes: [], analysisAttempt: 0, corrections: [], status: 'running', attempts: 1, depth: 1,
      result: null, resultPointer: null, workerSessionId: null,
      ...overrides,
    },
    children,
  }
}

/** Render the detail dialog with its state, the way the view holds it. */
function dialog(
  state: Parameters<typeof MissionDetailDialog>[0]['state'],
  options: { readonly sessionId?: string; readonly openWorkerSession?: (target: WorkerSessionTarget) => void } = {},
): string {
  return renderToStaticMarkup(
    <MissionDetailDialog
      nodeId="r1"
      state={state}
      onClose={() => undefined}
      sessionId={options.sessionId ?? 'owner-1'}
      {...options.openWorkerSession === undefined ? {} : { openWorkerSession: options.openWorkerSession }}
    />,
  )
}

/** Render the result pane in one read state — the pure half of the click-to-read feature. */
function pane(props: Parameters<typeof ResultPane>[0]): string {
  return renderToStaticMarkup(<ResultPane {...props} />)
}

/** Render one section's pane by id — the section model is what static markup can pin. */
function section(source: MissionNodeDetail, id: string, loadResult?: (nodeId: string) => Promise<string>): string {
  const tab = detailTabs(source, { loadResult }).find((entry) => entry.id === id)
  expect(tab, `no ${id} section`).toBeDefined()
  return tab === undefined ? '' : renderToStaticMarkup(<>{tab.body}</>)
}

/** The section labels a detail produces, in render order. */
function sectionLabels(source: MissionNodeDetail): readonly string[] {
  return detailTabs(source).map((tab) => tab.label)
}

describe('the status vocabulary the panel shows', () => {
  it('says exactly what the engine says, status for status', () => {
    // The browser half cannot import the engine, so its map is a hand-kept copy — and it had drifted:
    // one status read 「可执行」 in the panel and 「待执行」 in `list_missions`. Comparing the literal in the
    // source against the engine's own `statusLabel` is what keeps the copy honest.
    const source = readFileSync(new URL('../src/client/MissionTreeView.tsx', import.meta.url), 'utf8')
    const table = /const STATUS_LABEL: Record<string, string> = \{([\s\S]*?)\}/u.exec(source)?.[1]
    expect(table, 'STATUS_LABEL not found in MissionTreeView.tsx').toBeDefined()
    const entries = [...(table ?? '').matchAll(/(\w+):\s*'([^']*)'/gu)].map((match) => [match[1], match[2]] as const)
    expect(entries.length).toBeGreaterThan(0)
    for (const [status, label] of entries) {
      expect(label, `panel label for ${status}`).toBe(statusLabel(status))
    }
    // And the reverse: a status the engine names but the panel does not would render the raw key.
    for (const status of ['blocked', 'ready', 'running', 'interrupted', 'done', 'failed']) {
      expect(entries.map(([key]) => key)).toContain(status)
    }
  })
})

describe('the detail dialog', () => {
  it('renders the shell 设置 shape: a section rail beside a scrolling pane', () => {
    const html = dialog({ nodeId: 'r1', status: 'ready', detail: detail() })
    expect(html).toContain('avwf-dialog-overlay')
    expect(html).toContain('avwf-dialog-mask')
    expect(html).toContain('avwf-dialog-panel')
    expect(html).toContain('avwf-dialog-nav')
    expect(html).toContain('avwf-dialog-content')
    expect(html).toContain('任务详情')
    expect(html).toContain('关闭')
    // And the inline block it replaced is GONE: nothing here pushes the tree down.
    expect(html).not.toContain('avwf-detail"')
  })

  it('heads the dialog with the mission title, and opens on 内容', () => {
    // The last-open section of a DIFFERENT mission must not leak in: the view keys the dialog by
    // node id, and this test is the visible half of that reset.
    const html = dialog({ nodeId: 'r1', status: 'ready', detail: detail() })
    // 标题 is not a section any more — it is the heading, because "which mission is this" is asked
    // before a section is chosen and must stay answered while reading all of them.
    expect(html).not.toContain('>标题<')
    expect(html).toMatch(/<h2[^>]*class="avwf-dialog-head-title"[^>]*>Ship it<\/h2>/)
    // The meta the 标题 section used to carry rides the heading.
    expect(html).toContain('r1')
    expect(html).toContain('第 1 次派发')
    expect(html).toContain('深度 1')
    // Landing section is 内容, so the pane opens on the mission's body rather than an empty pane.
    expect(html).toContain('>内容<')
    expect(html).toContain('把迁移发出去')
    expect(html.match(/avwf-dialog-nav-cell-active/gu) ?? []).toHaveLength(1)
  })

  it('offers 纠偏 only for a mission that was actually steered', () => {
    // A section reading 「（无）」 exists only to say it does not; the row's marker already says
    // "this one was corrected" without opening anything.
    expect(sectionLabels(detail())).not.toContain('纠偏')
    expect(sectionLabels(detail({ corrections: ['改成先做 B'] }))).toContain('纠偏')
  })

  it('offers 拆解信息 whenever an analysis was recorded — split or not', () => {
    // The rule is `analysisNotes.length > 0`, NOT "has children". An executor that wrote an
    // analysis and then solved the mission without splitting it (or whose split was voided) leaves
    // the analysis behind, and that is exactly the record a reader wants to find again.
    expect(sectionLabels(detail())).not.toContain('拆解信息')
    expect(sectionLabels(detail({ analysisNotes: ['缺调用点清单'] }))).toContain('拆解信息')
    // No children anywhere in these fixtures: notes alone are enough to earn the section.
    expect(detail({ analysisNotes: ['缺调用点清单'] }).children).toEqual([])
  })

  it('quotes the decomposition analysis and the dispatch that wrote it', () => {
    // The reasoning a FRESH session reads back: without it in the dialog, the only reader who
    // ever sees it is the engine's next dispatch.
    const html = section(detail({
      analysisNotes: ['缺前置事实：先拿到调用点清单', '排除：直接改 v1 会打断在跑的任务'],
      analysisAttempt: 2,
    }), 'analysis')
    expect(html).toContain('缺前置事实：先拿到调用点清单')
    expect(html).toContain('排除：直接改 v1 会打断在跑的任务')
    expect(html).toContain('第 2 次派发')
  })

  it('keeps a stable section order, and hides the list sections that are empty', () => {
    const full = detail({ corrections: ['改成先做 B'], analysisNotes: ['缺调用点清单'], analysisAttempt: 1 }, [
      { id: 'c1', title: 'the part', status: 'done', result: 'child conclusion', resultPointer: null },
    ])
    expect(sectionLabels(full)).toEqual(['内容', '上下文', '拆解信息', '纠偏', '结果', '子任务'])
    // A leaf mission with no context, no analysis and no steering: body and result — nothing else.
    const bare: MissionNodeDetail = { node: { ...detail().node, context: [] }, children: [] }
    expect(sectionLabels(bare)).toEqual(['内容', '结果'])
  })

  it('quotes each section’s own content', () => {
    const source = detail({ corrections: ['改成先做 B', '口径按子文件数'] }, [
      { id: 'c1', title: 'the part', status: 'done', result: 'child conclusion', resultPointer: null },
    ])
    expect(section(source, 'content')).toContain('把迁移发出去')
    expect(section(source, 'context')).toContain('prod 已冻结')
    expect(section(source, 'corrections')).toContain('改成先做 B')
    expect(section(source, 'corrections')).toContain('口径按子文件数')
    expect(section(source, 'result')).toContain('（未提交结果）')
    expect(section(source, 'children')).toContain('child conclusion')
    expect(section(source, 'children')).toContain('已完成')
  })

  it('says what 内容 and 上下文 each mean, because the names alone do not', () => {
    // Two adjacent sections answering different questions — "what must this achieve" vs "why does
    // it exist". Without the gloss a reader takes the premise for the acceptance criteria.
    const content = section(detail(), 'content')
    expect(content).toContain('要达成什么')
    expect(content).toContain('验收')
    const context = section(detail(), 'context')
    expect(context).toContain('为什么需要这个任务')
    expect(context).toContain('前提不是验收标准')
  })

  it('says the goal is the title, so the corrections are read against it', () => {
    // The line that reconciles the two halves: without it the correction list reads as an
    // addendum to a description the mission no longer follows.
    expect(section(detail({ corrections: ['改成先做 B'] }), 'corrections')).toContain('目标以「标题」为准')
  })

  it('counts the sections that hold a list', () => {
    const tabs = detailTabs(detail({ corrections: ['a', 'b'], analysisNotes: ['n1', 'n2', 'n3'] }, [
      { id: 'c1', title: 'the part', status: 'done', result: 'r', resultPointer: null },
    ]))
    const countOf = (id: string): number | undefined => tabs.find((tab) => tab.id === id)?.count
    expect(countOf('context')).toBe(2)
    expect(countOf('analysis')).toBe(3)
    expect(countOf('corrections')).toBe(2)
    expect(countOf('children')).toBe(1)
    // A section that is not a list carries none, so the nav cell stays a plain label.
    expect(countOf('content')).toBeUndefined()
    expect(countOf('result')).toBeUndefined()
  })

  it('keeps the inline head of a spilled result and points at the rest', () => {
    const html = section(detail({ result: 'the first 2000 chars', resultPointer: 'spill://abc' }), 'result')
    expect(html).toContain('the first 2000 chars')
    expect(html).toContain('spill://abc')
  })

  it('renders each multi-item section as one box per entry, like 子任务', () => {
    // A bullet in front of four lines of prose only indents the first line, and the glyph is doing
    // no mission when the text is wider than its column. The box is the separator — the same box a
    // child's result wears, so the four list sections read as ONE style.
    const source = detail({ corrections: ['改成先做 B'], analysisNotes: ['缺调用点清单'] }, [
      { id: 'c1', title: 'the part', status: 'done', result: 'child conclusion', resultPointer: null },
    ])
    for (const id of ['context', 'analysis', 'corrections', 'children']) {
      const html = section(source, id)
      expect(html, `${id} has no boxed entry`).toContain('avwf-detail-item')
      expect(html, `${id} still renders a bullet list`).not.toContain('<li')
      expect(html, `${id} still renders a bullet list`).not.toContain('<ul')
    }
    // The corrections keep their full-strength tone; the others stay secondary.
    expect(section(source, 'corrections')).toContain('avwf-detail-corrections')
    expect(section(source, 'context')).not.toContain('avwf-detail-corrections')
  })

  it('renders the loading and failure states instead of an empty pane', () => {
    expect(dialog({ nodeId: 'r1', status: 'loading' })).toContain('读取任务详情')
    const failed = dialog({ nodeId: 'r1', status: 'error', error: 'node nope does not exist' })
    expect(failed).toContain('node nope does not exist')
    expect(dialog(undefined)).toContain('读取任务详情')
    // Neither offers sections to click: there is nothing to switch between yet.
    expect(failed).not.toContain('avwf-dialog-nav-cell')
  })
})

describe('reading a spilled result back', () => {
  const spilled: Parameters<typeof ResultPane>[0] = {
    text: 'the first 2000 chars',
    pointer: '/tmp/dsh-spill/x.txt — read it with the read tool',
    full: undefined,
    canLoad: true,
    onToggle: () => undefined,
  }

  it('offers the read only when the host has a way to perform it', () => {
    // An older host with no `result` face gets no button: offering a read that cannot happen is worse
    // than leaving the locator, which a reader with access to that substrate can still chase.
    expect(pane(spilled)).toContain('查看完整结果')
    expect(pane({ ...spilled, canLoad: false })).not.toContain('查看完整结果')
    // The locator is on screen either way.
    expect(pane({ ...spilled, canLoad: false })).toContain('/tmp/dsh-spill/x.txt')
  })

  it('replaces the head with the full text instead of stacking the two', () => {
    // The head IS the first slice of the full text; printing both would read as two results.
    const html = pane({ ...spilled, full: { status: 'ready', text: 'the whole thing' } })
    expect(html).toContain('the whole thing')
    expect(html).not.toContain('the first 2000 chars')
    expect(html).toContain('收起完整结果')
    // And the locator stays: the text is THIS host's answer, the locator is the address.
    expect(html).toContain('/tmp/dsh-spill/x.txt')
  })

  it('comes back to the head, with the locator, when the read failed', () => {
    const html = pane({ ...spilled, full: { status: 'error', error: '不在本机文件系统上（spill://abc）' } })
    expect(html).toContain('the first 2000 chars')
    expect(html).toContain('不在本机文件系统上')
    expect(html).toContain('/tmp/dsh-spill/x.txt')
    // Retryable: the same click reads again.
    expect(html).toContain('查看完整结果')
  })

  it('says it is reading, and disables the button while it does', () => {
    const html = pane({ ...spilled, full: { status: 'loading' } })
    expect(html).toContain('读取中')
    expect(html).toContain('disabled')
    // The head stays visible while the read is in flight, so the pane never blanks.
    expect(html).toContain('the first 2000 chars')
  })

  it('passes a reader down to the result section, and only there', () => {
    // The reader is what makes the button appear; `detailTabs` is the seam that carries it.
    const source = detail({ result: 'head', resultPointer: 'spill://abc' })
    expect(section(source, 'result', () => Promise.resolve('all of it'))).toContain('查看完整结果')
    expect(section(source, 'result')).not.toContain('查看完整结果')
  })
})

/**
 * The "jump to the executor" link. This suite has no DOM, so the click is exercised on the seam the
 * button is wired to (`WorkerSessionLink`'s root element, whose `onClick` is what the panel renders)
 * rather than by dispatching a browser event — the same reason `ResultPane` is a pure function here.
 */
describe('opening the session that ran a mission', () => {
  const WORKER = 'mission-aaaa1111'

  /** The seat's session hook, structurally: `seat.ts` reads every field defensively. */
  const stubSession = <T,>(select: (session: { queue?: readonly unknown[]; running?: boolean }) => T): T =>
    select({ queue: [], running: false })
  const stubChat = <T,>(select: (chat: { order?: readonly string[] }) => T): T => select({ order: [] })

  /**
   * A structural client Context: only what `apply` touches, with `get` answering per call so a test
   * can make the optional service appear between two renders. `view` reaches the props the seat
   * would pass the registered component by CALLING it — safe because `View` itself is hook-free
   * (its state lives in `MissionTreeView`), which is what keeps this suite DOM-less.
   */
  function fakeClientContext(workspace: () => unknown): {
    ctx: Parameters<typeof apply>[0]
    view: (props: Record<string, unknown>) => { props: Record<string, unknown> }
  } {
    type Registered = (props: Record<string, unknown>) => { props: Record<string, unknown> }
    let component: Registered | undefined
    const ctx = {
      effect: (callback: () => (() => void) | void): void => { callback() },
      logger: { error: (): void => undefined },
      locale: {
        register: (): (() => void) => () => undefined,
        bind: (): ((key: string) => string) => (key: string) => key,
      },
      remote: { $mount: (): Promise<() => Promise<void>> => Promise.resolve(() => Promise.resolve()) },
      get: (name: string): unknown => {
        if (name === 'uiWorkspace') return workspace()
        // A namespace, so the mount's `.then` does not report a broken contribution.
        if (name === 'remote.avantfMission') return {}
        return undefined
      },
      slots: {
        inject: (_name: string, register: () => void): void => { register() },
        register: (_options: unknown, registered: unknown): void => { component = registered as Registered },
      },
    }
    return {
      ctx: ctx as unknown as Parameters<typeof apply>[0],
      view: (props) => {
        if (component === undefined) throw new Error('apply did not register the conversation.view seat')
        return component(props)
      },
    }
  }

  it('sends the exact continuable-child address when the link is clicked', () => {
    const sent: WorkerSessionTarget[] = []
    const element = WorkerSessionLink({
      workerSessionId: WORKER,
      sessionId: 'owner-1',
      open: (target) => { sent.push(target) },
      onFailure: () => undefined,
    }) as unknown as { props: { onClick: () => void } }

    element.props.onClick()
    // The REAL object, field for field: parent = the panel's own session, child = the worker, and
    // `continuable` so the host opens the durable subagent address rather than a bare id.
    expect(sent).toEqual([{ parentSessionId: 'owner-1', childSessionId: WORKER, mode: 'continuable' }])
    // ...and that object is the builder's own output, not two shapes kept in step by hand.
    expect(workerSessionTarget('owner-1', WORKER))
      .toEqual({ parentSessionId: 'owner-1', childSessionId: WORKER, mode: 'continuable' })
  })

  it('renders a real clickable element for a bound mission', () => {
    const html = dialog(
      { nodeId: 'r1', status: 'ready', detail: detail({ workerSessionId: WORKER }) },
      { sessionId: 'owner-1', openWorkerSession: () => undefined },
    )
    expect(html).toContain('avwf-worker-link')
    expect(html).toContain(`<button type="button"`)
    expect(html).toContain(WORKER)
    // Labelled for assistive tech, and it says what the click does.
    expect(html).toContain('aria-label="打开执行这个任务的会话')
  })

  it('renders NO clickable element for an unbound mission, and says nothing about one', () => {
    // `workerSessionId: null` is the engine's "no executor bound": there is nothing to open, so the
    // header shows neither a link nor a placeholder.
    const html = dialog({ nodeId: 'r1', status: 'ready', detail: detail({ workerSessionId: null }) }, {
      openWorkerSession: () => undefined,
    })
    expect(html).not.toContain('avwf-worker-link')
    expect(html).not.toContain('avwf-worker-id')
    // The panel itself is intact — this is a missing link, not a broken dialog.
    expect(html).toContain('Ship it')
    expect(html).toContain('>内容<')
  })

  it('renders the id as plain text when the host has no uiWorkspace, with no dead link', () => {
    // `openWorkerSession` is absent exactly when `ctx.get('uiWorkspace')` found no service. The id is
    // still the useful half of the feature, so it stays on screen — as text, never as a button.
    const html = dialog({ nodeId: 'r1', status: 'ready', detail: detail({ workerSessionId: WORKER }) })
    expect(html).toContain('avwf-worker-id')
    expect(html).toContain(WORKER)
    expect(html).not.toContain('avwf-worker-link')
    expect(html).toContain('当前宿主没有 uiWorkspace 服务')
    // And nothing else changed: the dialog is fully rendered.
    expect(html).toContain('Ship it')
    expect(html).toContain('第 1 次派发')
  })

  it('turns a refused or failed open into an inline message, never a throw', async () => {
    const failures: string[] = []
    const base = { parentSessionId: 'owner-1', workerSessionId: WORKER, onFailure: (message: string) => { failures.push(message) } }

    // A host may refuse a cleaned-up session by THROWING...
    const threw = workerSessionClick({ ...base, open: () => { throw new Error('会话已被清理') } })
    expect(() => { threw() }).not.toThrow()
    expect(failures).toEqual(['会话已被清理'])

    // ...or by answering with a rejected promise.
    const rejected = workerSessionClick({ ...base, open: () => Promise.reject(new Error('会话不存在')) })
    rejected()
    await Promise.resolve()
    expect(failures).toEqual(['会话已被清理', '会话不存在'])

    // The message the dialog renders in place is a line of text with `role="alert"`, not a blank pane.
    const html = renderToStaticMarkup(<WorkerSessionHint message="会话已被清理" />)
    expect(html).toContain('打开执行者会话失败')
    expect(html).toContain('会话已被清理')
    expect(html).toContain('role="alert"')
  })

  it('asks the host for uiWorkspace on EVERY render, and never injects it', () => {
    // The client half's own wiring. `uiWorkspace` is fetched with `ctx.get` (never `inject`: a host
    // without it must still mount this half), and the view only receives an opener when the service is
    // really there. The lookup is per render because cordis reports a service as absent until its own
    // fiber is active — caching "no service" at apply time would lose a late-mounted one forever.
    const sent: WorkerSessionTarget[] = []
    const workspace = { openSession: (target: WorkerSessionTarget): void => { sent.push(target) } }
    let available: unknown
    const { ctx, view } = fakeClientContext(() => available)

    apply(ctx)
    // 1) No service: the seat's view gets NO opener, so the id can only render as plain text.
    const absent = view({ sessionId: 'owner-1', useChat: stubChat, useSession: stubSession })
    expect(absent.props['openWorkerSession']).toBeUndefined()
    expect(absent.props['sessionId']).toBe('owner-1')

    // 2) The service appears afterwards: the NEXT render sees it, and the opener it hands over still
    //    forwards the target unchanged.
    available = workspace
    const present = view({ sessionId: 'owner-2', useChat: stubChat, useSession: stubSession })
    expect(present.props['sessionId']).toBe('owner-2')
    const open = present.props['openWorkerSession'] as ((target: WorkerSessionTarget) => void) | undefined
    expect(typeof open).toBe('function')
    open?.({ parentSessionId: 'owner-2', childSessionId: WORKER, mode: 'continuable' })
    expect(sent).toEqual([{ parentSessionId: 'owner-2', childSessionId: WORKER, mode: 'continuable' }])
  })
})

/** A session that has been busy: `count` finished trees, each with one node. */
function history(count: number): MissionSnapshot {
  return {
    trees: Array.from({ length: count }, (_, index) => ({
      rootId: `t${String(index)}`,
      closedAt: 1,
      nodes: [{
        id: `t${String(index)}`, parentId: null, children: [], title: `mission ${String(index)}`,
        context: [], corrections: [], status: 'done', attempts: 1, depth: 1, createdAt: index, hasResult: true, resultRef: null, workerSessionId: null,
      }],
    })),
  }
}

describe('MissionTreeView', () => {
  /** Render the view against a stub snapshot hook. */
  function view(
    statuses: { root?: string; child?: string; grandchild?: string } = {},
    corrections: { root?: readonly string[]; child?: readonly string[] } = {},
  ): string {
    const state: MissionSnapshotState = {
      data: snapshot(statuses, corrections),
      loading: false,
      error: undefined,
      refresh: () => Promise.resolve(),
    }
    return renderToStaticMarkup(
      <MissionTreeView
        useSnapshot={() => state}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
        loadResult={() => Promise.reject(new Error('not clicked'))}
        sessionId="owner-1"
      />,
    )
  }

  it('renders every node with its title and status', () => {
    const html = view()
    expect(html).toContain('Ship it')
    expect(html).toContain('the part')
    expect(html).toContain('执行中')
    expect(html).toContain('第 2 次')
  })

  it('marks a corrected mission in the row, so a settled goal is not read as the whole story', () => {
    // The row renders `title` — the goal as CREATED. A correction changes what the result answers,
    // so without a marker a corrected mission reads as a title that contradicts its own result. The
    // texts are carried in the tooltip rather than the row body: the marker has to be cheap, and
    // the full list is the detail panel's job.
    const html = view({}, { root: ['改成先做 B', '口径按子文件数'] })
    expect(html).toContain('已纠偏 2 次')
    expect(html).toContain('改成先做 B')
    expect(html).toContain('口径按子文件数')
    // Only the corrected node is marked: the child carries none. Counted by the marker element,
    // because the text itself appears twice on a marked row (the tag and its tooltip).
    expect(html.match(/class="avwf-meta avwf-corrected"/gu)?.length).toBe(1)
  })

  it('renders an empty panel — and no message — when the session has no trees', () => {
    // The old copy ("本会话还没有任务树。让 agent 用 create_mission 建一个…") was removed on purpose: an owner
    // who has created no trees gets the tab strip and an empty panel, nothing else. That decision is
    // invisible in the markup unless it is pinned, so pin BOTH halves — the panel is still rendered
    // (not a crash, not a missing view), and nothing is printed in it (not "loading", not an error,
    // not an explanation). Reintroducing a message, or losing the panel, fails here.
    const state: MissionSnapshotState = {
      data: history(0),
      loading: false,
      error: undefined,
      refresh: () => Promise.resolve(),
    }
    const html = renderToStaticMarkup(
      <MissionTreeView
        useSnapshot={() => state}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
        loadResult={() => Promise.reject(new Error('not clicked'))}
        sessionId="owner-1"
      />,
    )
    expect(html).toContain('avwf-root')
    expect(html).toContain('avwf-scroll')
    // The generic half: with every tag stripped, nothing readable is left. Token checks alone would
    // pass a NEW message in a NEW class (that is the whole point of a generic assertion here), so this
    // is what actually pins "the empty state says nothing".
    expect(html.replace(/<[^>]*>/gu, '').replace(/<!--.*?-->/gu, '').trim()).toBe('')
    // And the specific half, so a regression names itself instead of just failing the line above.
    expect(html).not.toContain('avwf-empty')
    expect(html).not.toContain('avwf-error')
    expect(html).not.toContain('读取中')
    expect(html).not.toContain('根节点缺失')
    expect(html).not.toContain('还没有任务')
  })

  it('keeps a mission that is still in play open, sub-sub-missions included', () => {
    // Only the root used to be open, which hid a split sub-mission's own children — the
    // very thing this view exists to show while the tree is running.
    const html = view()
    expect(html).toContain('the sub-part')
    expect(html.match(/avwf-twisty[^"]*"[^>]*>▾/g) ?? []).toHaveLength(2)
  })

  it('folds a finished mission away, while its own parent stays open', () => {
    // The child is done, so its sub-mission is folded up; the root is still running, so
    // it keeps showing the child. A settled branch stops burying the live one.
    const html = view({ child: 'done', grandchild: 'done' })
    expect(html).toContain('the part')
    expect(html).not.toContain('the sub-part')
    expect(html.match(/avwf-twisty[^"]*"[^>]*>▾/g) ?? []).toHaveLength(1)
  })

  it('folds a whole finished tree to its root row', () => {
    const html = view({ root: 'done', child: 'done', grandchild: 'done' })
    expect(html).toContain('Ship it')
    expect(html).not.toContain('the part')
    expect(html).not.toContain('the sub-part')
  })

  it('stops at a cycle in a corrupted document instead of recursing forever', () => {
    // `children` is an arbitrary id list in a persisted/wire document. The core never BUILDS a cycle,
    // but a document corrupted from outside could point a node back at an ancestor; descending
    // blindly would recurse until the browser's stack died, taking the whole panel with it. The guard
    // renders each node once and refuses to descend into a child already on the path.
    const row = (id: string, parentId: string | null, children: readonly string[]): MissionNodeView => ({
      id, parentId, children, depth: 1, title: id, context: [], corrections: [],
      status: 'running', attempts: 1, createdAt: 0, hasResult: false, resultRef: null, workerSessionId: null,
    })
    const state: MissionSnapshotState = {
      data: { trees: [{ rootId: 'r1', closedAt: null, nodes: [row('r1', null, ['c1']), row('c1', 'r1', ['r1'])] }] },
      loading: false,
      error: undefined,
      refresh: () => Promise.resolve(),
    }
    const html = renderToStaticMarkup(
      <MissionTreeView
        useSnapshot={() => state}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
        loadResult={() => Promise.reject(new Error('not clicked'))}
        sessionId="owner-1"
      />,
    )
    // Both rows render, and the back-edge does not add a second copy of the root.
    expect(html.match(/class="avwf-title"/gu) ?? []).toHaveLength(2)
  })

  it('reads no detail until a row is clicked', () => {
    // The detail read is on demand: a dialog opened for every row would fire one request per
    // row on every snapshot, which is exactly what the `detail` RPC exists to avoid.
    const html = view()
    expect(html).toContain('详情')
    expect(html).not.toContain('读取任务详情')
    expect(html).not.toContain('avwf-dialog')
    expect(html).not.toContain('avwf-detail"')
  })

  it('windows a long list: only a slice of the history is rendered', () => {
    // The point of the virtualizer: scrolling can go through every mission, but the DOM
    // (and so React's tree) only holds the ones near the viewport.
    const state: MissionSnapshotState = {
      data: history(200),
      loading: false,
      error: undefined,
      refresh: () => Promise.resolve(),
    }
    const html = renderToStaticMarkup(
      <MissionTreeView
        useSnapshot={() => state}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
        loadResult={() => Promise.reject(new Error('not clicked'))}
        sessionId="owner-1"
      />,
    )
    const rendered = html.match(/avwf-tree-header/g) ?? []
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(200)
    // The window is placed on a canvas sized for the whole history, so the scrollbar
    // still covers every tree.
    expect(html).toContain('avwf-canvas')
    expect(html).toMatch(/height:\s*\d+px/)
  })

  it('renders a short list plainly, with no windowing in the way', () => {
    // Under the threshold the list is a plain flex column: the path every other test
    // here exercises, and the one small sessions actually take.
    const state: MissionSnapshotState = {
      data: history(5),
      loading: false,
      error: undefined,
      refresh: () => Promise.resolve(),
    }
    const html = renderToStaticMarkup(
      <MissionTreeView
        useSnapshot={() => state}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
        loadResult={() => Promise.reject(new Error('not clicked'))}
        sessionId="owner-1"
      />,
    )
    expect(html.match(/avwf-tree-header/g) ?? []).toHaveLength(5)
    expect(html).not.toContain('avwf-canvas')
    expect(html).not.toContain('avwf-slot')
  })

  it('aligns the panel with the conversation column, like the 记忆 tab', () => {
    // Full-bleed rows were the complaint: the fix is the rule `@avantf/mem-dsh` uses on the
    // same shared property, so both tabs share the transcript's axis and width.
    view()
    const css = styleTags.map((tag) => tag.textContent).join('\n')
    expect(css).toContain('max-width: var(--dsh-chat-content-width)')
    expect(css).toContain('margin: 0 auto')
    // The boxes ARE the items, so the root must not add a horizontal inset of its own.
    expect(css).toMatch(/\.avwf-root \{[^}]*padding: 8px 0 16px;/)
  })

  it('draws the detail dialog to the shell 设置 panel’s rules', () => {
    view()
    const css = styleTags.map((tag) => tag.textContent).join('\n')
    // Same mask tokens as the shell's own Modal / settings overlay, so the two read as one surface
    // rather than two kinds of dialog.
    expect(css).toMatch(/\.avwf-dialog-mask \{[^}]*background: var\(--dsw-alias-bg-mask-1\)/)
    expect(css).toMatch(/\.avwf-dialog-mask \{[^}]*backdrop-filter: var\(--dsw-mask-blur\)/)
    // Layer-2 fill + prominent elevation: the elevation tokens a dialog wears, not a card's.
    expect(css).toMatch(/\.avwf-dialog-panel \{[^}]*background: var\(--dsw-alias-bg-layer-2\)/)
    expect(css).toMatch(/\.avwf-dialog-panel \{[^}]*box-shadow: var\(--dsw-elevation-prominent\)/)
    // Wider than the settings panel on purpose: the reading matter here is prose plus long lists,
    // and 800px left the content column cramped once the rail took its share. Still capped by the
    // viewport, so the card never grows past the window it is centered in.
    expect(css).toMatch(/\.avwf-dialog-panel \{[^}]*width: 1040px/)
    expect(css).toMatch(/\.avwf-dialog-panel \{[^}]*height: min\(880px, calc\(100vh - 2 \* max\(24px, var\(--dsh-frame-top-clearance, 24px\)\)\)\)/)
    // The BODY is the only scrolling region — that is what keeps the tree from moving.
    expect(css).toMatch(/\.avwf-dialog-body \{[^}]*overflow-y: auto/)
    // One step up from the row text: this is the surface meant for reading, and 14px read as fine
    // print at this width. The rail's cells scale with it so the two columns stay in proportion.
    expect(css).toMatch(/\.avwf-dialog-body \{[^}]*font-size: 15px/)
    expect(css).toMatch(/\.avwf-dialog-nav-cell \{[^}]*font-size: 15px/)
    // The heading is the mission's title, one step above the body and allowed to WRAP: a title is the
    // one string a reader must not have to hover to read.
    expect(css).toMatch(/\.avwf-dialog-head-title \{[^}]*font-size: 17px/)
    expect(css).toMatch(/\.avwf-dialog-head-title \{[^}]*overflow-wrap: anywhere/)
  })

  it('fills and tints each item from the design tokens the 记忆 tab uses', () => {
    // Same two tokens as @avantf/mem-dsh's item: bg-layer-1 for the fill, label-primary for
    // the text. Hardcoded colours here would read as a foreign widget in either theme.
    view()
    const css = styleTags.map((tag) => tag.textContent).join('\n')
    const item = /\.avwf-tree \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(item).toContain('background: var(--dsw-alias-bg-layer-1)')
    expect(item).toContain('color: var(--dsw-alias-label-primary)')
  })

  it('never dims text with opacity, which stacks and kills contrast', () => {
    // The bug this guards: one dimmed ancestor (.avwf-tree-settled) times one dimmed child
    // (.avwf-meta) landed near 2.5:1 in both themes. Every text colour now comes from a label
    // token, whose measured contrast on the item fill is ≥ 5.8:1 in both themes.
    view()
    const css = styleTags.map((tag) => tag.textContent).join('\n')
    for (const selector of [
      '.avwf-tree-settled', '.avwf-root-id', '.avwf-tree-summary', '.avwf-meta', '.avwf-context',
      '.avwf-detail-hint', '.avwf-detail-none', '.avwf-dialog-nav-title', '.avwf-dialog-nav-count',
      '.avwf-dialog-head-id', '.avwf-empty',
    ]) {
      const rule = new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
      expect(rule, `${selector} must set a colour, not an opacity`).not.toContain('opacity')
    }
    // The visible text of a row and of the panel's messages is a label token.
    expect(css).toMatch(/\.avwf-meta \{[^}]*color: var\(--dsw-alias-label-secondary\)/)
    // Status is a hue for shapes and tints, never a text colour: the badge carries the status
    // as a background tint and its text stays a label token.
    expect(css).toMatch(/\.avwf-badge \{[^}]*color: var\(--dsw-alias-label-primary\)/)
    expect(css).toMatch(/\.avwf-dot \{[^}]*background: var\(--avwf-status/)
    expect(css).toMatch(/\.avwf-tree \{[^}]*color: var\(--dsw-alias-label-primary\)/)
  })

  it('draws a reused prerequisite under the node that depends on it, marked as reused', () => {
    // `parentId` is where a node was BORN; the dependency edge is `children`. Rendering by
    // `parentId` showed a reused prerequisite only under its birth parent, so the node that
    // depends on it looked like a leaf that was waiting for nothing.
    const data: MissionSnapshot = {
      trees: [{
        rootId: 'r1',
        closedAt: null,
        nodes: [
          { id: 'r1', parentId: null, children: ['a', 'b'], title: 'root mission', context: [], corrections: [], status: 'blocked', attempts: 1, depth: 1, createdAt: 1, hasResult: false, resultRef: null, workerSessionId: null },
          { id: 'a', parentId: 'r1', children: ['s'], title: 'branch A', context: [], corrections: [], status: 'blocked', attempts: 1, depth: 2, createdAt: 2, hasResult: false, resultRef: null, workerSessionId: null },
          { id: 'b', parentId: 'r1', children: ['s'], title: 'branch B', context: [], corrections: [], status: 'blocked', attempts: 1, depth: 2, createdAt: 3, hasResult: false, resultRef: null, workerSessionId: null },
          { id: 's', parentId: 'a', children: [], title: 'shared premise', context: [], corrections: [], status: 'done', attempts: 1, depth: 3, createdAt: 4, hasResult: true, resultRef: null, workerSessionId: null },
        ],
      }],
    }
    const html = renderToStaticMarkup(
      <MissionTreeView
        useSnapshot={() => ({ data, loading: false, error: undefined, refresh: () => Promise.resolve() })}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
        loadResult={() => Promise.reject(new Error('not clicked'))}
        sessionId="owner-1"
      />,
    )
    // Drawn under BOTH parents (A is its birth parent, B reused it). Four occurrences = two
    // rows × two per row (the tooltip and the visible text).
    expect(html.match(/shared premise/g) ?? []).toHaveLength(4)
    // ...and only the reused copy carries the marker, so a repeated row does not read as a
    // duplicate of the same mission.
    expect(html.match(/avwf-reused/gu) ?? []).toHaveLength(1)
    expect(html).toContain('复用')
  })

  it('offers one short delete button per tree, in the tree header', () => {
    // The unit of deletion is the tree, so no row carries a button — not even the
    // finished child, which a node-level gesture would have made deletable.
    const html = view()
    expect(html.match(/avwf-delete/g) ?? []).toHaveLength(1)
    const [header, ...rows] = html.split('avwf-row')
    expect(header).toContain('删除')
    for (const row of rows) expect(row).not.toContain('avwf-delete')
  })

  it('disables the tree button while the tree is live, and explains why', () => {
    // A live tree belongs to the engine: the button is visibly there but refuses,
    // rather than appearing once the tree finishes with no hint of the rule.
    const html = view()
    const button = html.slice(html.indexOf('avwf-delete'))
    expect(button).toContain('disabled')
    expect(button).toContain('任务树还在跑')
  })

  it('enables it once the tree has finished', () => {
    const html = view({ root: 'done', child: 'done', grandchild: 'done' })
    const button = html.slice(html.indexOf('avwf-delete'))
    expect(button).not.toContain('disabled')
    expect(button).toContain('>删除<')
  })
})
