/**
 * The "工作" view's rendering: what a reader actually sees in a row, and what an
 * expanded row shows.
 *
 * Rendered to static markup rather than into a DOM on purpose — the parts worth
 * pinning here are the panel's own branches (loading / error / spilled result) and
 * the fact that a row starts collapsed, none of which need a click simulation, and
 * all of which a wrong branch would silently get wrong in the browser.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NodeDetailPanel, WorkTreeView } from '../src/client/WorkTreeView.js'
import type { WorkNodeDetail, WorkNodeView, WorkSnapshot, WorkSnapshotState } from '../src/client/contract.js'

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
function snapshot(statuses: { root?: string; child?: string; grandchild?: string } = {}): WorkSnapshot {
  const node = (
    id: string, parentId: string | null, title: string, depth: number, status: string, attempts: number,
    children: readonly string[] = [],
  ): WorkNodeView => ({
    id, parentId, children, title, context: [], status, attempts, depth,
    createdAt: depth, hasResult: status === 'done', resultRef: null,
  })
  return {
    trees: [{
      rootId: 'r1',
      closedAt: null,
      nodes: [
        node('r1', null, 'Ship it', 1, statuses.root ?? 'running', 1, ['c1']),
        node('c1', 'r1', 'the part', 2, statuses.child ?? 'running', 2, ['g1']),
        node('g1', 'c1', 'the sub-part', 3, statuses.grandchild ?? 'running', 1),
      ],
    }],
  }
}

/** A detail payload as the host returns it. */
function detail(overrides: Partial<WorkNodeDetail['node']> = {}, children: WorkNodeDetail['children'] = []): WorkNodeDetail {
  return {
    node: {
      id: 'r1', rootId: 'r1', title: 'Ship it', description: '把迁移发出去', context: ['prod 已冻结', '回滚脚本在这'],
      status: 'running', attempts: 1, depth: 1, result: null, resultPointer: null,
      ...overrides,
    },
    children,
  }
}

/** Render the panel with its state, the way the view holds it. */
function panel(state: Parameters<typeof NodeDetailPanel>[0]['state']): string {
  return renderToStaticMarkup(<NodeDetailPanel nodeId="r1" depth={0} state={state} />)
}

describe('NodeDetailPanel', () => {
  it('shows the title, the content and the context', () => {
    const html = panel({ status: 'ready', detail: detail() })
    expect(html).toContain('Ship it')
    expect(html).toContain('把迁移发出去')
    expect(html).toContain('prod 已冻结')
    expect(html).toContain('工作内容')
  })

  it('quotes what each child submitted', () => {
    const html = panel({
      status: 'ready',
      detail: detail({}, [
        { id: 'c1', title: 'the part', status: 'done', result: 'child conclusion', resultPointer: null },
      ]),
    })
    expect(html).toContain('the part')
    expect(html).toContain('child conclusion')
    expect(html).toContain('已完成')
  })

  it('says so when nothing was submitted', () => {
    expect(panel({ status: 'ready', detail: detail() })).toContain('（未提交结果）')
    expect(panel({ status: 'ready', detail: detail() })).toContain('（无子工作）')
  })

  it('keeps the inline head of a spilled result and points at the rest', () => {
    const html = panel({
      status: 'ready',
      detail: detail({ result: 'the first 2000 chars', resultPointer: 'spill://abc' }),
    })
    expect(html).toContain('the first 2000 chars')
    expect(html).toContain('spill://abc')
  })

  it('renders the loading and failure states instead of an empty panel', () => {
    expect(panel({ status: 'loading' })).toContain('读取工作详情')
    expect(panel({ status: 'error', error: 'node nope does not exist' })).toContain('node nope does not exist')
    expect(panel(undefined)).toContain('读取工作详情')
  })
})

/** A session that has been busy: `count` finished trees, each with one node. */
function history(count: number): WorkSnapshot {
  return {
    trees: Array.from({ length: count }, (_, index) => ({
      rootId: `t${String(index)}`,
      closedAt: 1,
      nodes: [{
        id: `t${String(index)}`, parentId: null, children: [], title: `work ${String(index)}`,
        context: [], status: 'done', attempts: 1, depth: 1, createdAt: index, hasResult: true, resultRef: null,
      }],
    })),
  }
}

describe('WorkTreeView', () => {
  /** Render the view against a stub snapshot hook. */
  function view(statuses: { root?: string; child?: string; grandchild?: string } = {}): string {
    const state: WorkSnapshotState = {
      data: snapshot(statuses),
      loading: false,
      error: undefined,
      refresh: () => Promise.resolve(),
    }
    return renderToStaticMarkup(
      <WorkTreeView
        useSnapshot={() => state}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
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

  it('renders an empty panel — and no message — when the session has no trees', () => {
    // The old copy ("本会话还没有工作树。让 agent 用 create_work 建一个…") was removed on purpose: an owner
    // who has created no trees gets the tab strip and an empty panel, nothing else. That decision is
    // invisible in the markup unless it is pinned, so pin BOTH halves — the panel is still rendered
    // (not a crash, not a missing view), and nothing is printed in it (not "loading", not an error,
    // not an explanation). Reintroducing a message, or losing the panel, fails here.
    const state: WorkSnapshotState = {
      data: history(0),
      loading: false,
      error: undefined,
      refresh: () => Promise.resolve(),
    }
    const html = renderToStaticMarkup(
      <WorkTreeView
        useSnapshot={() => state}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
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
    expect(html).not.toContain('还没有工作')
  })

  it('keeps a work that is still in play open, sub-sub-works included', () => {
    // Only the root used to be open, which hid a split sub-work's own children — the
    // very thing this view exists to show while the tree is running.
    const html = view()
    expect(html).toContain('the sub-part')
    expect(html.match(/avwf-twisty[^"]*"[^>]*>▾/g) ?? []).toHaveLength(2)
  })

  it('folds a finished work away, while its own parent stays open', () => {
    // The child is done, so its sub-work is folded up; the root is still running, so
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

  it('reads no detail until a row is clicked', () => {
    // The detail read is on demand: a falsely expanded panel would fire one request
    // per row on every snapshot, which is exactly what `detail` exists to avoid.
    const html = view()
    expect(html).toContain('详情')
    expect(html).not.toContain('工作内容')
    expect(html).not.toContain('读取工作详情')
    expect(html).not.toContain('avwf-detail"')
  })

  it('windows a long list: only a slice of the history is rendered', () => {
    // The point of the virtualizer: scrolling can go through every work, but the DOM
    // (and so React's tree) only holds the ones near the viewport.
    const state: WorkSnapshotState = {
      data: history(200),
      loading: false,
      error: undefined,
      refresh: () => Promise.resolve(),
    }
    const html = renderToStaticMarkup(
      <WorkTreeView
        useSnapshot={() => state}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
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
    const state: WorkSnapshotState = {
      data: history(5),
      loading: false,
      error: undefined,
      refresh: () => Promise.resolve(),
    }
    const html = renderToStaticMarkup(
      <WorkTreeView
        useSnapshot={() => state}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
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
      '.avwf-detail-hint', '.avwf-detail-label', '.avwf-detail-foot', '.avwf-empty',
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
    const data: WorkSnapshot = {
      trees: [{
        rootId: 'r1',
        closedAt: null,
        nodes: [
          { id: 'r1', parentId: null, children: ['a', 'b'], title: 'root work', context: [], status: 'blocked', attempts: 1, depth: 1, createdAt: 1, hasResult: false, resultRef: null },
          { id: 'a', parentId: 'r1', children: ['s'], title: 'branch A', context: [], status: 'blocked', attempts: 1, depth: 2, createdAt: 2, hasResult: false, resultRef: null },
          { id: 'b', parentId: 'r1', children: ['s'], title: 'branch B', context: [], status: 'blocked', attempts: 1, depth: 2, createdAt: 3, hasResult: false, resultRef: null },
          { id: 's', parentId: 'a', children: [], title: 'shared premise', context: [], status: 'done', attempts: 1, depth: 3, createdAt: 4, hasResult: true, resultRef: null },
        ],
      }],
    }
    const html = renderToStaticMarkup(
      <WorkTreeView
        useSnapshot={() => ({ data, loading: false, error: undefined, refresh: () => Promise.resolve() })}
        onDeleteTree={() => Promise.resolve()}
        loadDetail={() => Promise.reject(new Error('not clicked'))}
      />,
    )
    // Drawn under BOTH parents (A is its birth parent, B reused it). Four occurrences = two
    // rows × two per row (the tooltip and the visible text).
    expect(html.match(/shared premise/g) ?? []).toHaveLength(4)
    // ...and only the reused copy carries the marker, so a repeated row does not read as a
    // duplicate of the same work.
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
    expect(button).toContain('工作树还在跑')
  })

  it('enables it once the tree has finished', () => {
    const html = view({ root: 'done', child: 'done', grandchild: 'done' })
    const button = html.slice(html.indexOf('avwf-delete'))
    expect(button).not.toContain('disabled')
    expect(button).toContain('>删除<')
  })
})
