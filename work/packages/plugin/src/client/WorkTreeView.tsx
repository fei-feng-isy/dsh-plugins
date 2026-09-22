/**
 * The "工作" view: one session's work trees, driven by the `useSnapshot` hook so the
 * component knows nothing about the transport; one work's detail is read on demand.
 * There is no toolbar (the engine pushes changes), deletion is a TREE-level gesture in the
 * tree header (removing a node from a live tree leaves one that cannot converge), and a row
 * is open by default while its work is in play and folded once it has finished.
 * @module @avantf/dsh-work/client/WorkTreeView
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { WorkNodeDetail, WorkNodeView, WorkTreeViewData, WorkViewProps } from './contract.js'
import { INSTALL_STYLES } from './styles.js'

/** Statuses that mean "this work is over" — a tree whose root reached one is deletable. */
const TERMINAL: readonly string[] = ['done', 'failed']

/** How long an armed delete button waits before it disarms itself. */
const CONFIRM_MS = 4000

/** Trees worth windowing; below it the list renders plainly. */
const VIRTUALIZE_FROM = 25

const VIRTUAL_OVERSCAN = 5

const VIRTUAL_ESTIMATED_TREE_PX = 120

/**
 * Viewport assumed for the first paint: without it the first frame renders nothing and then
 * measures as nothing — the flash of an empty panel.
 */
const VIRTUAL_INITIAL_VIEWPORT_PX = 600

const STATUS_LABEL: Record<string, string> = {
  blocked: '等待子工作完成',
  ready: '可执行',
  running: '执行中',
  interrupted: '已中断',
  done: '已完成',
  failed: '已失败',
}

/** One expanded row's detail, as this view tracks it (not part of the contract). */
interface DetailState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly detail?: WorkNodeDetail
  readonly error?: string
}

/**
 * The shared row state, passed down as one object so adding a field cannot go stale in half
 * the tree. The delete action is deliberately NOT here: it belongs to the tree.
 */
interface RowActions {
  readonly open: readonly string[]
  readonly details: Record<string, DetailState>
  readonly onToggleDetail: (nodeId: string) => void
}

/**
 * The nodes one node depends on, read from the PARENT's `children` and not by matching
 * `parentId`: a reused prerequisite keeps the parent it was born under, so filtering by
 * `parentId` renders it as a leaf — a node that looks like it is waiting for nothing.
 */
function childrenOf(nodes: readonly WorkNodeView[], parent: WorkNodeView): readonly WorkNodeView[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return parent.children
    .map((id) => byId.get(id))
    .filter((node): node is WorkNodeView => node !== undefined)
}

/**
 * A result cell: the submitted text plus the pointer when it was spilled; the host keeps the
 * first 2 KB inline.
 */
function Result({ text, pointer }: { text: string | null; pointer: string | null }): ReactNode {
  const hasText = text !== null && text !== ''
  if (!hasText && pointer === null) {
    return <div className="avwf-detail-text avwf-detail-none">（未提交结果）</div>
  }
  return (
    <>
      {hasText ? <div className="avwf-detail-text">{text}</div> : null}
      {pointer === null
        ? null
        : (
          <div className="avwf-detail-text avwf-detail-pointer" title={pointer}>
            结果过长已截断，完整内容：{pointer}
          </div>
        )}
    </>
  )
}

/** One work's full detail: its own content first, then what its children reported. */
export function NodeDetailPanel({
  nodeId,
  depth,
  state,
}: {
  nodeId: string
  depth: number
  state: DetailState | undefined
}): ReactNode {
  const indent = { marginLeft: `${String(depth * 14 + 6)}px` }
  if (state === undefined || state.status === 'loading') {
    return <div className="avwf-detail" style={indent}>读取工作详情…</div>
  }
  if (state.status === 'error') {
    return <div className="avwf-detail avwf-detail-failed" style={indent}>读取工作详情失败：{state.error}</div>
  }
  const detail = state.detail
  if (detail === undefined) return <div className="avwf-detail" style={indent}>没有详情可显示</div>
  const node = detail.node
  return (
    <div className="avwf-detail" style={indent}>
      <div className="avwf-detail-head">
        <span className="avwf-detail-id" title={node.id}>{node.id}</span>
        <span className={`avwf-badge avwf-${node.status}`}>{STATUS_LABEL[node.status] ?? node.status}</span>
        <span className="avwf-meta">第 {node.attempts} 次派发 · 深度 {node.depth}</span>
      </div>
      <div className="avwf-detail-label">工作标题</div>
      <div className="avwf-detail-text avwf-detail-title">{node.title}</div>
      <div className="avwf-detail-label">工作内容</div>
      <div className="avwf-detail-text">{node.description === '' ? '（无）' : node.description}</div>
      {node.context.length > 0 ? (
        <>
          <div className="avwf-detail-label">上下文</div>
          <ul className="avwf-detail-context">
            {node.context.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
        </>
      ) : null}
      <div className="avwf-detail-label">本工作提交的结果</div>
      <Result text={node.result} pointer={node.resultPointer} />
      <div className="avwf-detail-label">子工作提交的结果{detail.children.length === 0 ? '（无子工作）' : ''}</div>
      {detail.children.map((child) => (
        <div className="avwf-detail-child" key={child.id}>
          <div className="avwf-detail-child-head">
            <span className={`avwf-dot avwf-${child.status}`} title={child.status} />
            <span className="avwf-detail-child-title" title={child.id}>{child.title}</span>
            <span className="avwf-meta">{STATUS_LABEL[child.status] ?? child.status}</span>
          </div>
          <Result text={child.result} pointer={child.resultPointer} />
        </div>
      ))}
      <div className="avwf-detail-foot">节点 {nodeId} · 树 {node.rootId}</div>
    </div>
  )
}

function NodeRow({ node, nodes, depth, viaParentId, actions }: {
  node: WorkNodeView
  nodes: readonly WorkNodeView[]
  depth: number
  /** The parent that listed this node; absent for a tree's root. */
  viaParentId?: string
  actions: RowActions
}): ReactNode {
  const { open, details, onToggleDetail } = actions
  const children = childrenOf(nodes, node)
  // Listed here as a prerequisite: marked so a repeated row does not read as a duplicate.
  const reused = viaParentId !== undefined && node.parentId !== viaParentId
  // The default follows the node: open while its work is in play, folded once it finished.
  // A click is stored as an OVERRIDE rather than as the state itself, so the default keeps
  // tracking the node afterwards and "I opened this one" survives it finishing.
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  const settled = TERMINAL.includes(node.status)
  const expanded = override ?? !settled
  const expandable = children.length > 0
  const indent = { paddingLeft: `${String(depth * 14 + 6)}px` }
  const detailOpen = open.includes(node.id)

  return (
    <div className="avwf-node">
      <div className="avwf-row" style={indent}>
        <button
          type="button"
          className={expandable ? 'avwf-twisty' : 'avwf-twisty avwf-twisty-empty'}
          onClick={() => { setOverride(!expanded) }}
          aria-expanded={expandable ? expanded : undefined}
          tabIndex={expandable ? 0 : -1}
          title={expandable ? '展开/收起子工作' : undefined}
        >
          {expandable ? (expanded ? '▾' : '▸') : '·'}
        </button>
        {/* The label is the detail toggle: clicking a work opens what it was asked to
            do and what it (and its children) reported. */}
        <button
          type="button"
          className={detailOpen ? 'avwf-title avwf-title-open' : 'avwf-title'}
          onClick={() => { onToggleDetail(node.id) }}
          aria-expanded={detailOpen}
          title={`${node.title}\n点击${detailOpen ? '收起' : '展开'}工作详情`}
        >
          <span className={`avwf-dot avwf-${node.status}`} title={node.status} />
          <span className="avwf-title-text">{node.title}</span>
        </button>
        {reused ? <span className="avwf-meta avwf-reused" title="这个节点是复用的前提，出生在别的工作下">复用</span> : null}
        <span className={`avwf-badge avwf-${node.status}`}>{STATUS_LABEL[node.status] ?? node.status}</span>
        {node.attempts > 1 ? <span className="avwf-meta">第 {node.attempts} 次</span> : null}
        {node.resultRef !== null ? <span className="avwf-meta" title={node.resultRef}>结果已落盘</span> : null}
        <span className="avwf-meta avwf-detail-hint">{detailOpen ? '收起' : '详情'}</span>
      </div>
      {node.context.length > 0 ? (
        <div className="avwf-context" style={{ paddingLeft: `${String(depth * 14 + 30)}px` }}>
          {node.context.join(' · ')}
        </div>
      ) : null}
      {detailOpen ? <NodeDetailPanel nodeId={node.id} depth={depth} state={details[node.id]} /> : null}
      {expanded && expandable
        ? children.map((child) => (
          <NodeRow
            key={child.id}
            node={child}
            nodes={nodes}
            depth={depth + 1}
            viaParentId={node.id}
            actions={actions}
          />
        ))
        : null}
    </div>
  )
}

/**
 * One whole tree, with its own action. The delete button is here and not on the rows
 * because the unit of deletion is the TREE; a live tree's button says so instead of hiding.
 */
function Tree({ tree, actions, busy, onDeleteTree }: {
  tree: WorkTreeViewData
  actions: RowActions
  busy: string | undefined
  onDeleteTree: (rootId: string) => void
}): ReactNode {
  const root = tree.nodes.find((node) => node.id === tree.rootId)
  const settled = root !== undefined && TERMINAL.includes(root.status)
  const counts = tree.nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.status] = (acc[node.status] ?? 0) + 1
    return acc
  }, {})
  const summary = Object.entries(counts)
    .map(([status, count]) => `${String(count)} ${STATUS_LABEL[status] ?? status}`)
    .join(' · ')
  const [confirming, setConfirming] = useState(false)

  // An armed button must not stay armed, or a later click deletes a whole tree unconfirmed.
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => { setConfirming(false) }, CONFIRM_MS)
    return () => { clearTimeout(timer) }
  }, [confirming])

  return (
    <section className={settled ? 'avwf-tree avwf-tree-settled' : 'avwf-tree'}>
      <header className="avwf-tree-header">
        <span className="avwf-root-id">{tree.rootId}</span>
        <span className="avwf-tree-summary">{summary}</span>
        {tree.closedAt === null ? null : <span className="avwf-meta">已归档</span>}
        <span className="avwf-spacer" />
        <button
          type="button"
          className={confirming ? 'avwf-delete avwf-delete-armed' : 'avwf-delete'}
          disabled={!settled || busy === tree.rootId}
          title={settled
            ? '删除整棵树：全部节点与结果一并删除，不可恢复'
            : '工作树还在跑：先结束它（cancel_work），或等它收敛后再删除'}
          onClick={() => {
            if (!confirming) {
              setConfirming(true)
              return
            }
            setConfirming(false)
            onDeleteTree(tree.rootId)
          }}
        >
          {busy === tree.rootId ? '删除中…' : confirming ? '确认删除' : '删除'}
        </button>
      </header>
      {root === undefined
        ? <div className="avwf-empty">根节点缺失</div>
        : <NodeRow node={root} nodes={tree.nodes} depth={0} actions={actions} />}
    </section>
  )
}

/** Render the session's work trees. */
export function WorkTreeView({ useSnapshot, onDeleteTree, loadDetail }: WorkViewProps): ReactNode {
  INSTALL_STYLES()
  const state = useSnapshot()
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState<readonly string[]>([])
  const [details, setDetails] = useState<Record<string, DetailState>>({})

  // The loader is a fresh closure on every render of the seat's view, so the
  // re-read effect below must not depend on it — that would loop forever.
  const loader = useRef(loadDetail)
  loader.current = loadDetail

  /** Delete one tree, then re-read: the tree lives in the host, this is a mirror. */
  const remove = (rootId: string): void => {
    setBusy(rootId)
    setFailure(undefined)
    void onDeleteTree(rootId)
      .then(() => state.refresh())
      .catch((cause: unknown) => {
        setFailure(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => { setBusy(undefined) })
  }

  const read = (nodeId: string): void => {
    setDetails((prev) => ({ ...prev, [nodeId]: { status: 'loading' } }))
    void loader.current(nodeId)
      .then((detail) => { setDetails((prev) => ({ ...prev, [nodeId]: { status: 'ready', detail } })) })
      .catch((cause: unknown) => {
        setDetails((prev) => ({
          ...prev,
          [nodeId]: { status: 'error', error: cause instanceof Error ? cause.message : String(cause) },
        }))
      })
  }

  const toggleDetail = (nodeId: string): void => {
    setOpen((prev) => (prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId]))
  }

  // An open panel follows the tree: the same change that re-reads the snapshot re-reads the
  // panels it left open, so a result that lands while a row is open shows up without a re-click.
  useEffect(() => {
    for (const nodeId of open) read(nodeId)
    // Keyed to the snapshot and the open set, not to `read`'s identity (see `loader`).
  }, [state.data, open])

  const trees = state.data?.trees ?? []
  // Windowing is only worth its bookkeeping once the list is long; under it the plain column is the list.
  const windowed = trees.length > VIRTUALIZE_FROM
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: windowed ? trees.length : 0,
    enabled: windowed,
    estimateSize: () => VIRTUAL_ESTIMATED_TREE_PX,
    getItemKey: (index) => trees[index]?.rootId ?? index,
    getScrollElement: () => scrollRef.current,
    initialRect: { width: 0, height: VIRTUAL_INITIAL_VIEWPORT_PX },
    overscan: VIRTUAL_OVERSCAN,
  })

  const renderTree = (tree: WorkTreeViewData, slot?: { style: CSSProperties; index: number }): ReactNode => (
    <div
      key={tree.rootId}
      className={slot === undefined ? undefined : 'avwf-slot'}
      data-index={slot?.index}
      ref={slot === undefined ? undefined : virtualizer.measureElement}
      style={slot?.style}
    >
      <Tree
        tree={tree}
        actions={{ open, details, onToggleDetail: toggleDetail }}
        busy={busy}
        onDeleteTree={remove}
      />
    </div>
  )

  return (
    <div className="avwf-root">
      {state.error !== undefined ? <div className="avwf-error">{state.error}</div> : null}
      {failure !== undefined ? <div className="avwf-error">删除失败：{failure}</div> : null}
      {state.loading && state.data === undefined ? <div className="avwf-empty">读取中…</div> : null}
      {/* No empty-state message: a session with no trees shows an empty panel. */}
      {/* The scroll container owns the viewport the window is computed from, so it is
          the element the virtualizer measures — the messages above stay put. */}
      <div className="avwf-scroll" ref={scrollRef}>
        {windowed
          ? (
            <div className="avwf-canvas" style={{ height: `${String(virtualizer.getTotalSize())}px` }}>
              {virtualizer.getVirtualItems().map((item) => {
                const tree = trees[item.index]
                if (tree === undefined) return null
                return renderTree(tree, {
                  index: item.index,
                  style: { transform: `translateY(${String(item.start)}px)` },
                })
              })}
            </div>
          )
          : trees.map((tree) => renderTree(tree))}
      </div>
    </div>
  )
}
