/**
 * The "任务" view: one session's mission trees, driven by the `useSnapshot` hook so the
 * component knows nothing about the transport; one mission's detail is read on demand and
 * shown in a modal panel (left: section nav, right: the section, scrolled), the same shape
 * as the shell's 设置 dialog. There is no toolbar (the engine pushes changes), deletion is a
 * TREE-level gesture in the tree header (removing a node from a live tree leaves one that
 * cannot converge), and a row's CHILDREN are open by default while its mission is in play and
 * folded once it has finished — that folding is the tree, not the detail.
 * @module @avantf/dsh-mission/client/MissionTreeView
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  ExecutorSessionLookup,
  MissionNodeDetail,
  MissionNodeView,
  MissionTreeViewData,
  MissionViewProps,
  WorkerSessionTarget,
} from './contract.js'
import { INSTALL_STYLES } from './styles.js'
import { rememberOverride, viewStateFor, type MissionViewState } from './viewState.js'
import { timingBadge, timingDetail } from '../timeFormat.js'

/** Statuses that mean "this mission is over" — a tree whose root reached one is deletable. */
const TERMINAL: readonly string[] = ['done', 'failed']

/** How long an armed delete button waits before it disarms itself. */
const CONFIRM_MS = 4000

/**
 * VISIBLE ROWS worth windowing; below it the list renders plainly.
 *
 * The unit changed when the window moved inside a tree. It used to count TREES (25), which only
 * helped a session with a long history: one active tree is fully expanded while it runs
 * (`expanded = override ?? !settled`), so the engine's own 200-node budget could hang as one
 * card of ~2000–2800 DOM elements. Keeping the old magnitude means "about 25 trees' worth of
 * rows": at a typical 4–5 visible rows per tree that is ~100–125, rounded to 120. This is an
 * observed ORDER OF MAGNITUDE, not an exact boundary — nothing is wrong on either side of it, it
 * only decides whether the window's bookkeeping (a canvas, per-row measurement) is worth it.
 */
export const VIRTUALIZE_FROM = 120

export const VIRTUAL_OVERSCAN = 5

/**
 * One visible row's estimated height, in pixels. The estimate only has to be CLOSE: every mounted
 * row is measured (`measureElement`) and the window is recomputed from the measured sizes, so a
 * wrong guess costs one extra frame at the edge, never a wrong row.
 */
export const VIRTUAL_ESTIMATED_ROW_PX = 24

/** A tree header, including the {@link VIRTUAL_TREE_GAP_PX} air above its card. */
const VIRTUAL_ESTIMATED_HEADER_PX = 48

/**
 * The air between two trees' cards, carried by the header item's slot (the virtualizer subtracts
 * no gap of its own — see the windowed branch of {@link MissionTreeView}). Rows inside one tree
 * get no gap: they are one table, not a stack of cards.
 */
const VIRTUAL_TREE_GAP_PX = 8

/**
 * Viewport assumed for the first paint: without it the first frame renders nothing and then
 * measures as nothing — the flash of an empty panel.
 */
export const VIRTUAL_INITIAL_VIEWPORT_PX = 600

/**
 * The browser half's own copy of the status vocabulary: it cannot import the engine (`contract.ts`
 * explains why), so the wording is kept IDENTICAL to the engine's `statusLabel` by hand. It had
 * drifted — the same status read 「可执行」 here and 「待执行」 in `list_missions` — which is how a user
 * ends up comparing two names for one state. `client-view.spec.tsx` pins the wording.
 */
const STATUS_LABEL: Record<string, string> = {
  blocked: '等待子任务',
  ready: '待执行',
  running: '执行中',
  interrupted: '已中断',
  done: '已完成',
  failed: '已失败',
}

/**
 * Why a queued mission is not running yet, in the owner's words. Being skipped by an admission gate
 * is NORMAL — the mission is queued, not refused — so the row says what it is waiting FOR, and the
 * tooltip carries the numbers the host sent (`needed`/`available`), which are cores for `capacity`
 * and bytes for a memory-floor deferral. `null` for a node nothing is holding back.
 */
function waitingLabel(
  waiting: NonNullable<MissionNodeView['waitingFor']> | null | undefined,
): { text: string; title: string } | undefined {
  if (waiting === null || waiting === undefined) return undefined
  if (waiting.reason === 'unit') {
    return {
      text: '排队中',
      title: waiting.unit === undefined
        ? '同一范围正有别的任务在跑，等它结束'
        : `范围「${waiting.unit}」正有别的任务在跑，等它结束`,
    }
  }
  if (waiting.reason === 'slot') {
    return { text: '排队中', title: '同时执行的任务数已达上限，等一个空位' }
  }
  if (waiting.reason === 'aging') {
    return { text: '排队中', title: '有任务等得太久、已预留整机：正在跑的排空后先派它，本任务随后' }
  }
  if (waiting.resource === 'memory') {
    const numbers = waiting.needed === undefined || waiting.available === undefined
      ? '剩余可用内存无法确认（本平台没有这个信号）'
      : `可用约 ${String(Math.round(waiting.available / (1024 * 1024)))} MB，低于下限 ${String(Math.round(waiting.needed / (1024 * 1024)))} MB`
    return { text: '等内存', title: `${numbers}；低于下限时先不派新任务，不是拒绝` }
  }
  const numbers = waiting.needed === undefined || waiting.available === undefined
    ? ''
    : `（需要 ${String(waiting.needed)} 核，当前空余 ${String(waiting.available)} 核）`
  return { text: '等容量', title: `整机容量不够，等正在跑的任务结束${numbers}` }
}

/**
 * The one dialog's data, as this view tracks it (not part of the contract): which node it is
 * for, and how far that read has got. One at a time, because the dialog is modal — the
 * per-node cache the inline panel kept existed only to survive rows scrolling past.
 */
interface DialogState {
  readonly nodeId: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly detail?: MissionNodeDetail
  readonly error?: string
}

/**
 * The shared row state, passed down as one object so adding a field cannot go stale in half the
 * tree. The delete action is deliberately NOT here: it belongs to the tree.
 *
 * Expand/collapse is NOT here either, in the sense that a row no longer owns its own expanded
 * state: `onToggle` writes the module-level override (see `viewState.ts`) and re-reads the flat,
 * windowed list of visible rows — the row that gained or lost children is decided up there, once.
 * The override has to be module-level anyway because the host remounts this whole view whenever
 * the tab's running marker flips, and a reader's click must survive that.
 */
interface RowActions {
  /** The node whose dialog is open, if any; the row uses it to mark itself as the source. */
  readonly openId: string | undefined
  readonly onOpenDetail: (nodeId: string) => void
  /**
   * Flip one row: remember the override and rebuild the visible-row list. The row renders the
   * glyph it is handed and never decides for itself whether its children are on screen.
   */
  readonly onToggle: (nodeId: string, expanded: boolean) => void
}

/**
 * The nodes one node depends on, read from the PARENT's `children` and not by matching
 * `parentId`: a reused prerequisite keeps the parent it was born under, so filtering by
 * `parentId` renders it as a leaf — a node that looks like it is waiting for nothing.
 *
 * `byId` is built ONCE per tree where the visible rows are computed ({@link buildVisibleItems}),
 * not per row: rebuilding the whole tree's map inside every row is O(N²) map insertions per frame,
 * and the panel re-reads on every engine change. Lookups are O(1).
 */
function childrenOf(byId: ReadonlyMap<string, MissionNodeView>, parent: MissionNodeView): readonly MissionNodeView[] {
  return parent.children
    .map((id) => byId.get(id))
    .filter((node): node is MissionNodeView => node !== undefined)
}

/** The empty ancestor path, shared so a root row does not allocate one. */
const NO_ANCESTORS: ReadonlySet<string> = new Set<string>()

/**
 * One visible line of the panel: a tree's header, or ONE node row.
 *
 * The tree used to render its rows by recursing, which meant a tree was the smallest unit the
 * window could mount. The recursion now happens once, up front, into this flat list (see
 * {@link buildVisibleItems}), so the window works in ROWS and a single 200-node tree is as cheap
 * as 200 one-node trees.
 */
interface TreeHeaderItem {
  readonly kind: 'tree'
  /** Stable identity for React and for the virtualizer's item cache. */
  readonly key: string
  readonly tree: MissionTreeViewData
  /** The tree's root reached a terminal status: its card is dashed and its delete button is live. */
  readonly settled: boolean
  /** A wire document whose `rootId` names no node: rendered as the empty-root message. */
  readonly rootMissing: boolean
}

/** One row, with everything the row renders already resolved — a leaf, not a subtree. */
interface NodeRowItem {
  readonly kind: 'row'
  readonly key: string
  readonly treeId: string
  readonly node: MissionNodeView
  readonly depth: number
  /** The parent that LISTED this row; `undefined` for a tree's root (see `reused`). */
  readonly viaParentId: string | undefined
  /** Whether the cycle guard left it any children — i.e. whether its twisty is live. */
  readonly expandable: boolean
  /** `override ?? !settled`, resolved when the list is built; the click writes the override. */
  readonly expanded: boolean
}

type VisibleItem = TreeHeaderItem | NodeRowItem

/** One tree as the flat list sees it: its header item plus its visible rows, in render order. */
interface TreeGroup {
  readonly header: TreeHeaderItem
  readonly rows: readonly NodeRowItem[]
  /** The header's index in the flat list (a card's top in the windowed canvas). */
  readonly first: number
  /** The last visible row's index in the flat list (a card's bottom). */
  readonly last: number
}

/**
 * Flatten every tree into the rows a reader can actually see, in render order.
 *
 * This is the recursion `NodeRow` used to do, moved out of rendering: `expanded = override ??
 * !settled` is resolved per node, children come from {@link childrenOf} (which follows `children`,
 * NOT `parentId`, so a reused prerequisite draws under every parent that lists it), and a child
 * already on the path is a CYCLE and is dropped — the guard that used to bound the render
 * recursion, now bounding this walk.
 *
 * Pure and exported because this suite renders to static markup with no DOM to scroll or click in:
 * "which rows are visible" is a fact about the data, and this is where it is decided.
 */
export function buildVisibleItems(
  trees: readonly MissionTreeViewData[],
  overrides: ReadonlyMap<string, boolean>,
): { readonly items: readonly VisibleItem[]; readonly groups: readonly TreeGroup[] } {
  const items: VisibleItem[] = []
  const groups: TreeGroup[] = []
  for (const tree of trees) {
    const first = items.length
    const root = tree.nodes.find((node) => node.id === tree.rootId)
    const header: TreeHeaderItem = {
      kind: 'tree',
      key: `tree:${tree.rootId}`,
      tree,
      settled: root !== undefined && TERMINAL.includes(root.status),
      rootMissing: root === undefined,
    }
    items.push(header)
    const rows: NodeRowItem[] = []
    if (root !== undefined) {
      const byId = new Map(tree.nodes.map((node) => [node.id, node]))
      // A sibling's index is part of the key so two rows for the SAME reused node are still two
      // distinct React children (a node may be listed by more than one parent).
      const walk = (
        node: MissionNodeView,
        depth: number,
        viaParentId: string | undefined,
        parentKey: string,
        ancestors: ReadonlySet<string>,
      ): void => {
        const children = childrenOf(byId, node).filter((child) => !ancestors.has(child.id))
        // The default follows the node: open while its mission is in play, folded once it
        // finished. A click is stored as an OVERRIDE rather than as the state itself, so the
        // default keeps tracking the node afterwards and "I opened this one" survives it finishing.
        const expanded = overrides.get(node.id) ?? !TERMINAL.includes(node.status)
        const row: NodeRowItem = {
          kind: 'row',
          key: `${parentKey}>${node.id}`,
          treeId: tree.rootId,
          node,
          depth,
          viaParentId,
          expandable: children.length > 0,
          expanded,
        }
        items.push(row)
        rows.push(row)
        if (!expanded) return
        const next = new Set([...ancestors, node.id])
        children.forEach((child, index) => {
          walk(child, depth + 1, node.id, `${row.key}:${String(index)}`, next)
        })
      }
      walk(root, 0, undefined, header.key, NO_ANCESTORS)
    }
    groups.push({ header, rows, first, last: items.length - 1 })
  }
  return { items, groups }
}

/** How one on-demand full-result read is going, or `undefined` before it has been asked for. */
export interface FullResultState {
  readonly status: 'loading' | 'ready' | 'error'
  readonly text?: string
  readonly error?: string
}

/**
 * The result pane for ONE read state, rendered as a pure function so every rule that matters —
 * expanded replaces the head, a failed read keeps the locator, no reader means no button — is
 * testable without a DOM to click in.
 */
export function ResultPane({ text, pointer, full, canLoad, onToggle }: {
  text: string | null
  pointer: string | null
  full: FullResultState | undefined
  /** Whether a full read is even possible (a `result` face on the host). */
  canLoad: boolean
  onToggle: () => void
}): ReactNode {
  const hasText = text !== null && text !== ''
  if (!hasText && pointer === null) {
    return <div className="avwf-detail-text avwf-detail-none">（未提交结果）</div>
  }
  const expanded = full?.status === 'ready'
  return (
    <>
      {/* Expanded REPLACES the head instead of stacking under it: the head is the first slice of the
          very text below, and printing both would read as two results. */}
      {hasText && !expanded ? <div className="avwf-detail-text">{text}</div> : null}
      {expanded ? <div className="avwf-detail-text avwf-detail-full">{full.text}</div> : null}
      {pointer === null
        ? null
        : (
          <>
            {expanded
              ? null
              : <div className="avwf-detail-text avwf-detail-none">结果过长，节点上只留了开头；完整内容不在节点里。</div>}
            {/* The locator stays on screen even after a read: it is the address a reader with access
                to that substrate needs, and the TEXT is only this host's answer. */}
            <div className="avwf-detail-text avwf-detail-pointer" title={pointer}>{pointer}</div>
            {canLoad
              ? (
                <button type="button" className="avwf-link" disabled={full?.status === 'loading'} onClick={onToggle}>
                  {full?.status === 'loading' ? '读取中…' : expanded ? '收起完整结果' : '查看完整结果'}
                </button>
              )
              : null}
          </>
        )}
      {full?.status === 'error'
        ? <div className="avwf-detail-text avwf-detail-failed">读取完整结果失败：{full.error}</div>
        : null}
    </>
  )
}

/**
 * A result cell: the submitted text plus, when it was spilled, a way to read the whole thing.
 *
 * The locator is what the MODEL follows — `mission_result` hands it over together with retrieval
 * guidance — and a human reading the panel cannot: a browser refuses to navigate to a filesystem
 * path, and DSH's own open-a-file route belongs to deliverables this mission never registered. So the
 * pane asks the HOST for the text instead (the one party that can read its own spill artifact) and
 * shows it in place. When the host cannot resolve the locator it says why, and the locator stays on
 * screen — it is still the address a reader with access to that substrate needs.
 */
function Result({ nodeId, text, pointer, loadResult }: {
  nodeId: string
  text: string | null
  pointer: string | null
  loadResult?: (nodeId: string) => Promise<string>
}): ReactNode {
  const [full, setFull] = useState<FullResultState | undefined>(undefined)
  // One toggle for two jobs: a collapsed pane reads, an expanded one collapses. The read REPLACES
  // whatever came before, so a failed attempt is retried by the same click.
  const onToggle = (): void => {
    if (full?.status === 'ready') {
      setFull(undefined)
      return
    }
    if (loadResult === undefined) return
    setFull({ status: 'loading' })
    void loadResult(nodeId)
      .then((value) => { setFull({ status: 'ready', text: value }) })
      .catch((cause: unknown) => {
        setFull({ status: 'error', error: cause instanceof Error ? cause.message : String(cause) })
      })
  }
  return (
    <ResultPane text={text} pointer={pointer} full={full} canLoad={loadResult !== undefined} onToggle={onToggle} />
  )
}

/** One section of the detail dialog: its nav cell and the pane the cell shows. */
export interface DetailTab {
  readonly id: string
  readonly label: string
  /** How many entries the section holds; rendered after the label when present. */
  readonly count?: number
  readonly body: ReactNode
}

/**
 * A one-line gloss above a section. The section names alone are not enough: 内容 and 上下文 sit
 * next to each other and answer different questions ("what must this achieve" vs "why does it
 * exist"), and a reader who has to guess which is which reads the wrong one as the goal.
 */
function SectionHint({ children }: { children: ReactNode }): ReactNode {
  return <div className="avwf-dialog-hint">{children}</div>
}

/**
 * A list section's entries, one BOX each — not a `<ul>`.
 *
 * These entries are multi-line prose: a bullet in front of four lines only indents the first, and a
 * glyph separator is doing no mission when the text itself is longer than the bullet's column. The box
 * is the separator, and it is the same box a child's result wears, so 上下文 / 拆解信息 / 纠偏 / 子任务
 * read as one list style rather than four.
 */
function ItemList({ entries, tone }: { entries: readonly string[]; tone?: 'emphasis' }): ReactNode {
  return (
    <>
      {entries.map((entry) => (
        <div
          key={entry}
          className={tone === 'emphasis' ? 'avwf-detail-item avwf-detail-corrections' : 'avwf-detail-item'}
        >
          {entry}
        </div>
      ))}
    </>
  )
}

/**
 * The detail's sections, derived from ONE detail read.
 *
 * Exported and pure so the mapping is testable without a DOM: the spec renders to static
 * markup and cannot click a nav cell, so "what does the 纠偏 section hold" has to be
 * askable of a function rather than of a rendered, clicked dialog.
 *
 * A section with nothing to show is ABSENT rather than empty: a 「纠偏」 tab reading
 * 「（无）」 on a mission that was never steered is a section that exists only to say it does
 * not. 内容 / 结果 always exist — every mission has a body to achieve, and "no result yet" is
 * itself a fact about one.
 *
 * 标题 is NOT a section: it heads the dialog (see `MissionDetailDialog`), because it answers
 * "which mission am I looking at" — a question asked before any section is chosen, and one a
 * reader must be able to answer while reading every one of them. What used to share that tab
 * (id / dispatch count / depth) rides the same header as its meta line.
 *
 * Order is the order a reader asks the questions: what it must achieve (内容) → why it exists
 * (上下文) → how the executor reasoned about splitting it (拆解信息) → how the direction
 * changed (纠偏) → what came out (结果) → what the parts reported (子任务).
 */
export function detailTabs(
  detail: MissionNodeDetail,
  options: { readonly loadResult?: (nodeId: string) => Promise<string> } = {},
): readonly DetailTab[] {
  const node = detail.node
  const tabs: DetailTab[] = [
    {
      id: 'content',
      label: '内容',
      body: (
        <>
          <SectionHint>这个任务要达成什么 —— 这里是验收的对象。</SectionHint>
          <div className="avwf-detail-text">{node.description === '' ? '（无）' : node.description}</div>
        </>
      ),
    },
  ]
  if (node.context.length > 0) {
    tabs.push({
      id: 'context',
      label: '上下文',
      count: node.context.length,
      body: (
        <>
          <SectionHint>为什么需要这个任务：拆解它的人写下的前提与理由（根任务是 owner 的初始判断）。前提不是验收标准。</SectionHint>
          <ItemList entries={node.context} />
        </>
      ),
    })
  }
  if (node.analysisNotes.length > 0) {
    tabs.push({
      id: 'analysis',
      label: '拆解信息',
      count: node.analysisNotes.length,
      // The channel that survives the session: the round that judges a mission is a FRESH session,
      // and this is the only place its predecessor's reasoning reached it. Without it here, the
      // reasoning is visible to the engine and to nobody who reads the mission afterwards.
      body: (
        <>
          <SectionHint>执行者在拆解前写下的分析：缺什么前提、排除了哪条路、子任务完成后要判断什么。</SectionHint>
          <ItemList entries={node.analysisNotes} />
          {node.analysisAttempt > 0
            ? <div className="avwf-dialog-hint">最近一条写于第 {node.analysisAttempt} 次派发。</div>
            : null}
        </>
      ),
    })
  }
  if (node.corrections.length > 0) {
    tabs.push({
      id: 'corrections',
      label: '纠偏',
      count: node.corrections.length,
      // Said here, not only in the row's marker: the title is the goal as CREATED, so reading
      // a result against it without this line IS the mismatch this section exists to remove.
      body: (
        <>
          <SectionHint>按先后顺序；目标以「标题」为准，这里是此后每一次改动的方向。</SectionHint>
          <ItemList entries={node.corrections} tone="emphasis" />
        </>
      ),
    })
  }
  tabs.push({
    id: 'result',
    label: '结果',
    body: <Result nodeId={node.id} text={node.result} pointer={node.resultPointer} loadResult={options.loadResult} />,
  })
  if (detail.children.length > 0) {
    tabs.push({
      id: 'children',
      label: '子任务',
      count: detail.children.length,
      body: (
        <>
          {detail.children.map((child) => (
            <div className="avwf-detail-item avwf-detail-child" key={child.id}>
              <div className="avwf-detail-child-head">
                <span className={`avwf-dot avwf-${child.status}`} title={child.status} />
                <span className="avwf-detail-child-title" title={child.id}>{child.title}</span>
                <span className="avwf-meta">{STATUS_LABEL[child.status] ?? child.status}</span>
              </div>
              <Result nodeId={child.id} text={child.result} pointer={child.resultPointer} loadResult={options.loadResult} />
            </div>
          ))}
        </>
      ),
    })
  }
  return tabs
}

/**
 * Take everything that is NOT on the path from `overlay` up to `<body>` out of the tab order, and
 * return the undo.
 *
 * `inert` is the platform's own "not tabbable, not clickable, hidden from assistive tech" flag, and
 * the shell's overlays use it for the same reason. Only elements that were not ALREADY inert are
 * touched, so an overlay opened over another one restores exactly what it changed. The walk goes all
 * the way up, not just to the panel's own root: the composer and the sidebars are behind the mask
 * too, and a dialog that lets Tab reach them is modal only in appearance.
 */
export function inertBackground(overlay: HTMLElement): () => void {
  const changed: HTMLElement[] = []
  let node: HTMLElement = overlay
  for (;;) {
    const parent = node.parentElement
    if (parent === null) break
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert) continue
      sibling.inert = true
      changed.push(sibling)
    }
    if (parent === document.body) break
    node = parent
  }
  return () => {
    for (const element of changed) element.inert = false
  }
}

/**
 * The address of one worker session, exactly as the host's `uiWorkspace.openSession` takes it: the
 * durable parent/child address of a *continuable* subagent — what the main UI sends when a child is
 * picked from the "N 个子智能" dropdown. The PARENT is the owner session this panel belongs to.
 *
 * Exported, with `workerSessionOpen`/`createWorkerSessionClick`/`NodeIdEntry`, because this suite
 * has no DOM: a spec cannot press a rendered button, so it asks these functions (the very ones the
 * entry is wired to) what a click sends. That keeps "点击发出的 target 形状" pinned without adding a
 * browser environment.
 */
export function workerSessionTarget(parentSessionId: string, workerSessionId: string): WorkerSessionTarget {
  return { parentSessionId, childSessionId: workerSessionId, mode: 'continuable' }
}

/**
 * What a node-id entry says, in BOTH cases — W18: the id is an entry whether or not the record
 * already names an executor. The wording names the DESTINATION (the session that executed this
 * mission) and its state, because the thing rendered is the MISSION's id and a reader must not
 * mistake the click for "open the task".
 *
 * Without a handle the label stays honest rather than promising a session that may not exist: the
 * click TRIES, and a miss is explained by {@link workerFailureText} instead of being a dead link.
 * That is also why the two forms are not the same sentence — a reader can tell whether a lookup is
 * about to happen.
 *
 * A RELEASED handle is its own form, and the reason the state is a parameter rather than something
 * inferred from `workerLive`: 已结束 still names an openable session (the whole point of keeping the
 * display handle), while a released one names nothing. Labelling the second as the first would
 * promise a jump that must not happen.
 */
export function nodeIdLinkLabel(
  workerSessionId: string | null | undefined,
  workerLive: boolean | undefined,
  workerReleased?: boolean,
): string {
  if (workerReleased === true) return '执行者会话已被回收，点击看说明'
  const hasHandle = typeof workerSessionId === 'string' && workerSessionId !== ''
  if (!hasHandle) return '尝试打开执行这个任务的会话（记录里没有句柄，点击时查找）'
  return `打开执行这个任务的会话（${workerLive === true ? '进行中' : '已结束'}）`
}

/** Why one click could not open a session. Four kinds, four sentences (see {@link workerFailureText}). */
export type WorkerSessionFailureReason = 'never-dispatched' | 'not-found' | 'unsupported' | 'open'

/**
 * The sentence a failed click leaves behind, per reason. Exported and pure so each of the four is
 * pinned by a test (this suite has no DOM) and so no caller has to invent wording:
 *
 * - 「从未派发过」 is a FACT about the record, not a failure to find something;
 * - 「找不到」 is the case the spec names: a node that WAS dispatched, whose session is gone;
 * - 「无法打开」 is the host's own limitation — no `uiWorkspace` to navigate with, no session service
 *   to look one up in, or an older host whose Remote face predates the lookup — and the detail says
 *   which one, since the three have different remedies;
 * - 「打开失败」 is the one case where a session WAS named and navigation refused it.
 */
export function workerFailureText(reason: WorkerSessionFailureReason, detail?: string): string {
  const suffix = detail === undefined || detail === '' ? '' : `（${detail}）`
  switch (reason) {
    case 'never-dispatched':
      return '这个任务从未派发过执行者会话：没有可打开的执行者。'
    case 'not-found':
      return `找不到这个任务的执行者会话${suffix}：它可能已被清理，或日志已不在本机。`
    case 'unsupported':
      return detail === undefined || detail === ''
        ? '无法打开执行者会话：这个宿主不支持这次查找。'
        : `无法打开执行者会话：${detail}`
    case 'open':
      return `找到执行者会话，但打开失败${suffix}。`
  }
}

/** What a busy button shows instead of the id — a separate export because there is no DOM here to
 *  re-render, so the affordance itself is what a test can pin. */
export function workerSessionBusyText(busy: boolean, nodeId: string): string {
  return busy ? '查找中…' : nodeId
}

/** What one click did, as data: a test pins the address that was opened, and the panel renders this
 *  failure instead of the click having "done nothing". */
export type WorkerSessionOpenOutcome =
  | { readonly opened: true; readonly workerSessionId: string }
  | { readonly opened: false; readonly reason: WorkerSessionFailureReason; readonly message: string }

/**
 * The panel's one click handler, W18: the node id is ALWAYS an entry, and the session is resolved
 * lazily when the record does not already name one.
 *
 * Order: ① a handle on the record opens immediately (zero I/O); ② otherwise `resolveSession` asks the
 * host, and ONLY a `resolved` answer is opened; ③ a miss becomes a sentence about WHY — never a throw,
 * never a blank panel. `onLookupStart` fires before the first await, which is what lets the button
 * say 查找中… instead of looking like it ignored the click.
 *
 * ⓪ comes BEFORE all of them when the host marked the handle as RELEASED: that session was deleted
 * off disk, so there is nothing to open and nothing to look up. It is deliberately not "try the
 * handle and report the refusal": the refusal arrives asynchronously and late, from the chat view's
 * history load, as a skeleton host error rather than the plugin's own sentence — which is the defect
 * this branch exists to remove. Zero I/O either way, and the SAME sentence a lookup miss produces.
 *
 * `open` may throw or answer with a rejected promise (the session really was cleaned up): both become
 * the `open` failure. The panel must never blank — or lose its place — because a link went stale,
 * which is the one failure a link invited by us can cause.
 */
export async function workerSessionOpen(input: {
  readonly nodeId: string
  readonly parentSessionId: string
  /** The handle already on the record, when there is one. */
  readonly workerSessionId?: string | null
  /** Whether the host marked that handle's session as released off disk (see the client contract). */
  readonly workerSessionReleased?: boolean
  readonly open?: (target: WorkerSessionTarget) => unknown
  readonly resolveSession?: (nodeId: string) => Promise<ExecutorSessionLookup>
  readonly onLookupStart?: () => void
}): Promise<WorkerSessionOpenOutcome> {
  const fail = (reason: WorkerSessionFailureReason, detail?: string): WorkerSessionOpenOutcome =>
    ({ opened: false, reason, message: workerFailureText(reason, detail) })
  const textOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

  // ⓪ The host's mark: this handle names a session the cleanup pipeline deleted, so NOTHING is opened
  // and nothing is looked up. Checked first so the released state cannot be mistaken for a refusable
  // handle or validated away by a missing `open` — the reader gets the explanation either way.
  if (input.workerSessionReleased === true) {
    return fail('not-found', '执行者会话已被保留策略回收')
  }

  // A host that cannot navigate cannot open ANY session, whatever the lookup says — so this is
  // checked first and reported as its own reason.
  if (input.open === undefined) return fail('unsupported', '当前宿主没有 uiWorkspace 服务')
  const existing = input.workerSessionId
  let workerSessionId = typeof existing === 'string' && existing !== '' ? existing : undefined

  if (workerSessionId === undefined) {
    const resolve = input.resolveSession
    if (resolve === undefined) return fail('unsupported', '这个宿主还不支持查找执行者会话')
    input.onLookupStart?.()
    let lookup: ExecutorSessionLookup
    try {
      lookup = await resolve(input.nodeId)
    } catch (cause) {
      // The lookup REQUEST failed: transport, or a host too old to have the method.
      return fail('unsupported', textOf(cause))
    }
    if (lookup.status !== 'resolved' || typeof lookup.sessionId !== 'string' || lookup.sessionId === '') {
      const reason: WorkerSessionFailureReason = lookup.status === 'resolved' ? 'not-found' : lookup.status
      return fail(reason, lookup.error)
    }
    workerSessionId = lookup.sessionId
  }

  try {
    await Promise.resolve(input.open(workerSessionTarget(input.parentSessionId, workerSessionId)))
    return { opened: true, workerSessionId }
  } catch (cause) {
    return fail('open', textOf(cause))
  }
}

/**
 * The click handler the entry is wired to, as a function of the entry's own state setters.
 *
 * Split out for the same reason `workerSessionTarget` is: this suite has no DOM, so "what a click
 * does" has to be askable of a function rather than of a rendered, clicked button. It is also where
 * the 查找中… bookkeeping lives — `onLookupStart` fires only when a lookup is really needed, so a
 * click that already has a handle does not flash a wait state it never had.
 */
export function createWorkerSessionClick(input: {
  readonly nodeId: string
  readonly parentSessionId: string
  readonly workerSessionId?: string | null
  /** The host's release mark for that handle; a released one explains itself instead of opening. */
  readonly workerSessionReleased?: boolean
  readonly open?: (target: WorkerSessionTarget) => unknown
  readonly resolveSession?: (nodeId: string) => Promise<ExecutorSessionLookup>
  /** Whether a click is already in flight; a second one is ignored rather than queued. */
  readonly busy: boolean
  readonly setBusy: (busy: boolean) => void
  readonly setFailed: (failed: boolean) => void
  readonly onFailure: (message: string) => void
}): () => Promise<void> {
  return async () => {
    if (input.busy) return
    input.setFailed(false)
    const outcome = await workerSessionOpen({
      nodeId: input.nodeId,
      parentSessionId: input.parentSessionId,
      workerSessionId: input.workerSessionId,
      ...input.workerSessionReleased === undefined ? {} : { workerSessionReleased: input.workerSessionReleased },
      ...input.open === undefined ? {} : { open: input.open },
      ...input.resolveSession === undefined ? {} : { resolveSession: input.resolveSession },
      onLookupStart: () => { input.setBusy(true) },
    }).finally(() => { input.setBusy(false) })
    if (outcome.opened) return
    input.setFailed(true)
    input.onFailure(outcome.message)
  }
}

/**
 * One node id as an ENTRY. W18: the id is clickable on EVERY node — an existing handle opens its
 * session directly, and a historical record without one is looked up at CLICK time (the lookup reads
 * session logs, so it must never happen while rendering). Both places that show a node id (the tree
 * header's root id and the detail dialog's heading) render this, so the same thing never becomes two
 * links — W8 put a second, separate link on the worker session id, and that link is what this
 * replaces.
 *
 * Two degradation paths, both deliberate:
 * ① the host cannot complete the jump — no `uiWorkspace` service, no session service, or an older
 *    host whose Remote face predates the lookup → the click SAYS which
 *    ({@link workerFailureText}); the id stays an entry rather than a dead-looking one, so the
 *    explanation is one click away instead of a tooltip a reader has to go looking for;
 * ② `open` throws or rejects (the session really was cleaned up) → `onFailure` turns it into the
 *    caller's message; the panel never blanks and never loses its place.
 *
 * ③ the host marked the handle as RELEASED: the id is STILL an entry, and the click explains it —
 *    `workerSessionOpen` answers without opening or looking anything up.
 */
export function NodeIdEntry({
  nodeId, workerSessionId, workerLive, workerReleased, sessionId, open, onFailure, resolveSession, className,
}: {
  /** The MISSION's id — what is rendered; the session is only the destination. */
  nodeId: string
  workerSessionId: string | null | undefined
  workerLive?: boolean
  /** Whether the host marked that handle's session as released off disk. */
  workerReleased?: boolean
  /** The owner session the worker hangs under — the parent half of the address. */
  sessionId: string
  open?: (target: WorkerSessionTarget) => void
  onFailure: (message: string) => void
  /** The click-time lookup; absent on a host whose Remote face predates it (see `MissionViewProps`). */
  resolveSession?: (nodeId: string) => Promise<ExecutorSessionLookup>
  /** The caller's own monospace slot class, applied to both the link and the plain-text form. */
  className: string
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const released = workerReleased === true
  const hasHandle = typeof workerSessionId === 'string' && workerSessionId !== ''
  const label = nodeIdLinkLabel(workerSessionId, workerLive, released)
  const where = released
    ? '执行这个任务的会话已被保留策略回收，点击只会给出说明'
    : hasHandle
      ? `执行这个任务的会话 ${workerSessionId}（${workerLive === true ? '进行中' : '已结束'}）`
      : '执行这个任务的会话（记录里没有句柄，点击时按时间窗与首条提示词查找）'
  // No `uiWorkspace`: the id is STILL the entry, and the click explains why it cannot go anywhere.
  // A released handle is explained by its own state, so the missing service is not what a reader needs
  // to hear first.
  const blocked = open === undefined && !released ? '；当前宿主没有 uiWorkspace 服务，无法跳转' : ''
  const click = createWorkerSessionClick({
    nodeId,
    parentSessionId: sessionId,
    workerSessionId,
    ...workerReleased === undefined ? {} : { workerSessionReleased: workerReleased },
    ...open === undefined ? {} : { open },
    ...resolveSession === undefined ? {} : { resolveSession },
    busy,
    setBusy,
    setFailed,
    onFailure,
  })
  return (
    <button
      type="button"
      className={`${className} avwf-node-id avwf-worker-link${hasHandle ? '' : ' avwf-worker-lookup'}${released ? ' avwf-worker-released' : ''}`}
      title={`${label}\n${where}；不是任务详情${blocked}`}
      aria-label={label}
      disabled={busy}
      onClick={() => { void click() }}
    >
      {failed && !busy ? <span className="avwf-worker-retry" title="上次没找到；再点一次重试">↻ </span> : null}
      {busy
        ? <span className="avwf-worker-busy">{workerSessionBusyText(true, nodeId)}</span>
        : workerSessionBusyText(false, nodeId)}
    </button>
  )
}

/**
 * The inline message a failed open leaves behind. Split out as a pure component, like `ResultPane`,
 * so its markup is testable without a DOM to click in; the dialog owns the state that shows it.
 */
export function WorkerSessionHint({ message }: { message: string }): ReactNode {
  return <span className="avwf-worker-error" role="alert">{message}</span>
}

/**
 * One mission's detail as a MODAL panel: a section rail on the left, the chosen section in a
 * scrollable column on the right — the shell's 设置 dialog, sized for reading (1040×880, capped
 * by the viewport) rather than the settings' 800×800.
 *
 * The heading is the mission's own TITLE, not a 「标题」 section: "which mission is this" is asked
 * before a section is chosen and must stay answerable while reading every one of them.
 *
 * Why a dialog instead of an expanding row: the detail exists to be READ and it runs long —
 * a description, every correction, every child's conclusion. Inline, it pushed the tree down
 * by however much the text happened to be, so comparing two missions meant scrolling one of
 * them out of sight. A fixed panel with its own scroll keeps the tree where it was.
 */
export function MissionDetailDialog({ nodeId, state, onClose, loadResult, sessionId, openWorkerSession, resolveWorkerSession }: {
  nodeId: string
  /** `undefined` until this node's first read lands; a loading state once it has been asked for. */
  state: DialogState | undefined
  onClose: () => void
  /** Read a spilled result back in full. Absent in a host that has no `result` face, and then the
   *  pane shows the locator without offering a read it cannot perform. */
  loadResult?: (nodeId: string) => Promise<string>
  /** The owner session the shown mission's worker hangs under — the parent half of the address. */
  sessionId: string
  /** Open the executor's session; absent on a host with no `uiWorkspace` service, and then the id
   *  is rendered as plain text instead of a dead link (see `MissionViewProps.openWorkerSession`). */
  openWorkerSession?: (target: WorkerSessionTarget) => void
  /** The click-time lookup for a record with no handle (see `MissionViewProps.resolveWorkerSession`). */
  resolveWorkerSession?: (nodeId: string) => Promise<ExecutorSessionLookup>
}): ReactNode {
  // Escape closes, as in every other dialog in the shell. The listener lives exactly as long
  // as the dialog is mounted, so it cannot outlive the thing it closes.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Entering the dialog takes the keyboard: the close button is focused, and everything that is not
  // on the path from the overlay up to <body> goes `inert` — which is what `aria-modal` CLAIMS and
  // without which Tab walks out of the dialog and into the tree behind it. Leaving restores both, so
  // a keyboard user comes back to the row they opened. The shell's own overlays do exactly these two
  // moves; this is that pattern for an overlay that is rendered in place rather than portalled.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  const overlay = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const element = overlay.current
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const release = element === null ? () => undefined : inertBackground(element)
    closeButton.current?.focus()
    return () => {
      release()
      if (previousFocus?.isConnected === true) previousFocus.focus()
    }
  }, [])

  const [selected, setSelected] = useState<string | undefined>(undefined)
  // The one thing the dialog itself cannot render away: a host that refused to open a worker's
  // session. Kept here, so it resets when the dialog moves to another mission (`key={openId}`).
  const [workerFailure, setWorkerFailure] = useState<string | undefined>(undefined)
  const ready = state?.status === 'ready' ? state.detail : undefined
  const tabs = ready === undefined ? [] : detailTabs(ready, { loadResult })
  // A section can vanish under the selected id (a re-read that drops a now-empty list), so the
  // projection falls back to the first tab rather than showing a pane nobody selected.
  const active = tabs.find((tab) => tab.id === selected) ?? tabs[0]
  // The dialog is labelled by its heading, so a screen reader announces WHICH mission is open rather
  // than the generic 「任务详情」.
  const titleId = useId()

  return (
    <div ref={overlay} className="avwf-dialog-overlay" role="presentation">
      {/* The mask is a sibling UNDER the panel, so a click on the panel never reaches it. */}
      <div className="avwf-dialog-mask" aria-hidden="true" onClick={onClose} />
      <div className="avwf-dialog-panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className="avwf-dialog-nav">
          <div className="avwf-dialog-nav-title">任务详情</div>
          <div className="avwf-dialog-nav-list">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={tab.id === active?.id
                  ? 'avwf-dialog-nav-cell avwf-dialog-nav-cell-active'
                  : 'avwf-dialog-nav-cell'}
                aria-current={tab.id === active?.id ? 'true' : undefined}
                onClick={() => { setSelected(tab.id) }}
              >
                <span className="avwf-dialog-nav-label">{tab.label}</span>
                {tab.count === undefined ? null : <span className="avwf-dialog-nav-count">{tab.count}</span>}
              </button>
            ))}
          </div>
        </nav>
        <div className="avwf-dialog-content">
          <div className="avwf-dialog-header">
            {/* The mission's own title heads the dialog — "which mission is this" is asked before any
                section is chosen, and has to stay answerable while reading every one of them. The
                id / dispatch count / depth it used to share a 「标题」 section with ride below it. */}
            <div className="avwf-dialog-head-text">
              <h2 id={titleId} className="avwf-dialog-head-title" title={ready?.node.title}>
                {ready?.node.title ?? '任务详情'}
              </h2>
              <div className="avwf-dialog-head-meta">
                {/* The MISSION's id, made an entry: when this node has an executor session (running or
                    already finished) it is clickable and opens that session — "which mission" and
                    "who ran it" answered from one element, so the id never becomes two links. */}
                <NodeIdEntry
                  nodeId={ready?.node.id ?? nodeId}
                  workerSessionId={ready?.node.workerSessionId}
                  workerLive={ready?.node.workerLive}
                  workerReleased={ready?.node.workerReleased}
                  sessionId={sessionId}
                  onFailure={setWorkerFailure}
                  className="avwf-dialog-head-id"
                  {...openWorkerSession === undefined ? {} : { open: openWorkerSession }}
                  {...resolveWorkerSession === undefined ? {} : { resolveSession: resolveWorkerSession }}
                />
                {workerFailure === undefined ? null : <WorkerSessionHint message={workerFailure} />}
                {ready === undefined
                  ? null
                  : (
                    <>
                      <span className={`avwf-badge avwf-${ready.node.status}`}>
                        {STATUS_LABEL[ready.node.status] ?? ready.node.status}
                      </span>
                      <span>第 {ready.node.attempts} 次派发 · 深度 {ready.node.depth}</span>
                      {/* The FULL timing line lives here, not on the row: three instants separated by
                          「｜」 need the width of a dialog, and 「—」 is the honest reading of an instant
                          an older record never recorded. */}
                      <span className="avwf-dialog-head-time">{timingDetail(ready.node)}</span>
                    </>
                  )}
              </div>
            </div>
            <button ref={closeButton} type="button" className="avwf-dialog-close" aria-label="关闭" onClick={onClose}>✕</button>
          </div>
          <div className="avwf-dialog-body">
            {state === undefined || state.status === 'loading'
              ? <div className="avwf-detail-text avwf-detail-none">读取任务详情…</div>
              : state.status === 'error'
                ? <div className="avwf-detail-text avwf-detail-failed">读取任务详情失败：{state.error}</div>
                : active === undefined
                  ? <div className="avwf-detail-text avwf-detail-none">没有详情可显示</div>
                  : active.body}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Whether two rows are the same PICTURE, field by field. A snapshot refresh hands every row a NEW
 * object (the payload is parsed afresh), so React's identity memo would never hold; this compares what
 * the row actually renders instead. Everything the row reads is listed here, and the two arrays are
 * compared by content because the parser allocates new ones each frame.
 */
function sameNode(a: MissionNodeView, b: MissionNodeView): boolean {
  return a === b || (
    a.id === b.id
    && a.parentId === b.parentId
    && a.depth === b.depth
    && a.title === b.title
    && a.status === b.status
    && a.attempts === b.attempts
    && a.dispatchedAt === b.dispatchedAt
    && a.endedAt === b.endedAt
    && a.hasResult === b.hasResult
    && a.resultRef === b.resultRef
    && a.workerSessionId === b.workerSessionId
    && a.workerLive === b.workerLive
    && a.workerReleased === b.workerReleased
    && a.weight === b.weight
    && (a.contextCount ?? a.context.length) === (b.contextCount ?? b.context.length)
    && (a.correctionCount ?? a.corrections.length) === (b.correctionCount ?? b.corrections.length)
    && a.corrections.length === b.corrections.length
    && a.corrections.every((text, index) => text === b.corrections[index])
    && a.children.length === b.children.length
    && a.children.every((id, index) => id === b.children[index])
    && sameWaiting(a.waitingFor, b.waitingFor)
  )
}

/** Two waiting-for markers render identically, or not. Small and flat by construction. */
function sameWaiting(a: MissionNodeView['waitingFor'], b: MissionNodeView['waitingFor']): boolean {
  if (a === b) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  return a.reason === b.reason && a.resource === b.resource && a.needed === b.needed
    && a.available === b.available && a.unit === b.unit
}

/**
 * One row of a tree. `memo` because a frame re-reads the whole snapshot: without it every row
 * re-renders on every engine change even when its own picture is unchanged.
 *
 * A LEAF, deliberately: it renders its own line and nothing below it. Its children are separate
 * items of the flat list ({@link buildVisibleItems}) that decides which are visible, so the row
 * never recurses — that is what lets the window cut a long tree anywhere, not just between trees.
 * `depth`, `viaParentId`, `expandable` and `expanded` arrive resolved; `onToggle` writes the
 * module-level override and rebuilds the list.
 */
const NodeRow = memo(function NodeRow({ node, depth, viaParentId, expandable, expanded, actions }: {
  node: MissionNodeView
  depth: number
  /** The parent that listed this row; absent for a tree's root. */
  viaParentId?: string
  /** Whether the cycle guard left it any children — i.e. whether its twisty is live. */
  expandable: boolean
  /** `override ?? !settled`, resolved by {@link buildVisibleItems}. */
  expanded: boolean
  actions: RowActions
}): ReactNode {
  const { openId, onOpenDetail, onToggle } = actions
  // Listed here as a prerequisite: marked so a repeated row does not read as a duplicate.
  const reused = viaParentId !== undefined && node.parentId !== viaParentId
  const indent = { paddingLeft: `${String(depth * 14 + 6)}px` }
  const detailOpen = openId === node.id
  // Why this mission is queued (skipped by an admission gate), or `undefined` when it is not. Being
  // skipped is normal queuing, so this renders as a marker, never as a warning.
  const waiting = waitingLabel(node.waitingFor)
  // The row carries COUNTS, not the texts (see `wire.ts`): a current host sends the counts, an older
  // one still sends the arrays, and the longer of the two is the truth in either case.
  const contextCount = Math.max(node.contextCount ?? 0, node.context.length)
  const corrections = node.corrections
  const correctionCount = Math.max(node.correctionCount ?? 0, corrections.length)
  // The compact timing marker (or `undefined` when the row already says it all). `timingBadge` reads
  // the numeric instants, tolerating an older host whose payload omits them.
  const rowTiming = timingBadge(node)

  return (
    // `data-node-id` is the DOM-level answer to "which rows are mounted", which is exactly what the
    // windowing is about — a test (or a profiler) counts rows without reading React's tree.
    <div className="avwf-node" data-node-id={node.id}>
      <div className="avwf-row" style={indent}>
        <button
          type="button"
          className={expandable ? 'avwf-twisty' : 'avwf-twisty avwf-twisty-empty'}
          onClick={() => { onToggle(node.id, !expanded) }}
          aria-expanded={expandable ? expanded : undefined}
          tabIndex={expandable ? 0 : -1}
          title={expandable ? '展开/收起子任务' : undefined}
        >
          {expandable ? (expanded ? '▾' : '▸') : '·'}
        </button>
        {/* The label opens the detail dialog: what this mission was asked to do, what it
            reported, and (when there were any) every correction it was given. */}
        <button
          type="button"
          className={detailOpen ? 'avwf-title avwf-title-open' : 'avwf-title'}
          onClick={() => { onOpenDetail(node.id) }}
          aria-haspopup="dialog"
          aria-expanded={detailOpen}
          title={`${node.title}\n点击查看任务详情`}
        >
          <span className={`avwf-dot avwf-${node.status}`} title={node.status} />
          <span className="avwf-title-text">{node.title}</span>
        </button>
        {reused ? <span className="avwf-meta avwf-reused" title="这个节点是复用的前提，出生在别的任务下">复用</span> : null}
        {/* A collapsed row has to say the mission was steered — its title is the goal as created, and
            without this a corrected mission reads as a title that does not match its own result. The
            texts ride in the tooltip; the detail dialog's 「纠偏」 section lists them in full. */}
        {correctionCount > 0
          ? (
            <span
              className="avwf-meta avwf-corrected"
              title={`已纠偏 ${String(correctionCount)} 次：\n${corrections.join('\n')}`
                + (correctionCount > corrections.length
                  ? `\n（这里只列最新 ${String(corrections.length)} 条，全部在详情里）`
                  : '')}
            >
              已纠偏 {correctionCount} 次
            </span>
          )
          : null}
        <span className={`avwf-badge avwf-${node.status}`}>{STATUS_LABEL[node.status] ?? node.status}</span>
        {waiting === undefined
          ? null
          : <span className="avwf-meta avwf-waiting" title={waiting.title}>{waiting.text}</span>}
        {node.weight !== undefined && node.weight > 1
          ? <span className="avwf-meta" title={`这个任务按 ${String(node.weight)} 核参与整机容量分配`}>约占 {node.weight} 核</span>
          : null}
        {node.attempts > 1 ? <span className="avwf-meta">第 {node.attempts} 次</span> : null}
        {/* Compact timing: a finished mission shows how long it took, a running one when it started.
            The full 受理/派发/结束 line is in the detail dialog — a row is a line, and the whole point
            of the compact form is not to break it. */}
        {rowTiming === undefined ? null : <span className="avwf-meta avwf-timing" title="在详情里看完整时间">{rowTiming}</span>}
        {node.resultRef !== null ? <span className="avwf-meta" title={node.resultRef}>结果已落盘</span> : null}
        <span className="avwf-meta avwf-detail-hint">详情</span>
      </div>
      {contextCount > 0 ? (
        <div className="avwf-context" style={{ paddingLeft: `${String(depth * 14 + 30)}px` }}>
          背景 {contextCount} 条（详情里可见）
        </div>
      ) : null}
    </div>
  )
}, (prev, next) =>
  // The same field-level "is this the same PICTURE" comparison as before, on the leaf's own props:
  // `expanded`/`expandable` replaced `ancestors`, because the cycle guard moved into the flat-list
  // walk (two different paths can leave a node with different visible children).
  prev.depth === next.depth
  && prev.viaParentId === next.viaParentId
  && prev.expandable === next.expandable
  && prev.expanded === next.expanded
  && prev.actions === next.actions
  && sameNode(prev.node, next.node))

/**
 * One tree's HEADER: its root entry, its status summary and the whole-tree delete button. The
 * delete button is here and not on the rows because the unit of deletion is the TREE; a live
 * tree's button says so instead of hiding.
 *
 * It used to render the rows too, and the card around them was its `<section>`. The rows are now
 * items of the flat, windowed list, so this renders the header alone; the card is drawn by
 * {@link MissionTreeView} — the same markup in the plain path, an absolutely positioned box in the
 * windowed one — because a card cannot be split across two virtual items.
 */
function TreeHeader({ item, busy, onDeleteTree, sessionId, openWorkerSession, resolveWorkerSession }: {
  item: TreeHeaderItem
  busy: string | undefined
  onDeleteTree: (rootId: string) => void
  /** The owner session, and the optional opener — the tree header's root id opens the ROOT's
   *  executor session through the same entry the dialog uses. */
  sessionId: string
  openWorkerSession?: (target: WorkerSessionTarget) => void
  resolveWorkerSession?: (nodeId: string) => Promise<ExecutorSessionLookup>
}): ReactNode {
  const { tree, settled, rootMissing } = item
  const root = tree.nodes.find((node) => node.id === tree.rootId)
  const counts = tree.nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.status] = (acc[node.status] ?? 0) + 1
    return acc
  }, {})
  const summary = Object.entries(counts)
    .map(([status, count]) => `${String(count)} ${STATUS_LABEL[status] ?? status}`)
    .join(' · ')
  const [confirming, setConfirming] = useState(false)
  // A refused `openSession` on THIS tree's root id, shown beside the id it came from. Per tree, so a
  // stale session on one tree does not print an error on all of them.
  const [workerFailure, setWorkerFailure] = useState<string | undefined>(undefined)

  // An armed button must not stay armed, or a later click deletes a whole tree unconfirmed.
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => { setConfirming(false) }, CONFIRM_MS)
    return () => { clearTimeout(timer) }
  }, [confirming])

  return (
    <>
      <header className="avwf-tree-header">
        {/* The tree's ROOT ID is the node id a reader sees here; it is the entry to the session that
            ran the root mission, exactly as the dialog's heading id is (see `NodeIdEntry`). */}
        <NodeIdEntry
          nodeId={tree.rootId}
          workerSessionId={root?.workerSessionId}
          workerLive={root?.workerLive}
          workerReleased={root?.workerReleased}
          sessionId={sessionId}
          onFailure={setWorkerFailure}
          className="avwf-root-id"
          {...openWorkerSession === undefined ? {} : { open: openWorkerSession }}
          {...resolveWorkerSession === undefined ? {} : { resolveSession: resolveWorkerSession }}
        />
        {workerFailure === undefined ? null : <WorkerSessionHint message={workerFailure} />}
        <span className="avwf-tree-summary">{summary}</span>
        {tree.closedAt === null ? null : <span className="avwf-meta">已归档</span>}
        <span className="avwf-spacer" />
        <button
          type="button"
          className={confirming ? 'avwf-delete avwf-delete-armed' : 'avwf-delete'}
          disabled={!settled || busy === tree.rootId}
          title={settled
            ? '删除整棵树：全部节点与结果一并删除，不可恢复'
            : '任务树还在跑：先结束它（cancel_mission），或等它收敛后再删除'}
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
      {rootMissing ? <div className="avwf-empty">根节点缺失</div> : null}
    </>
  )
}

/**
 * The batch entry above the list: "清理已完成", armed on the first click and carried out on the
 * second, the same two-gesture rule the per-tree delete uses. Disabled — with the reason in its
 * tooltip — when the session has no closed tree yet. Rendered only when the host advertises the call
 * and the session owns at least one tree, so the empty panel stays empty.
 */
function CleanFinishedBar({ finished, busy, onClean }: {
  finished: number
  busy: boolean
  onClean: () => void
}): ReactNode {
  const [confirming, setConfirming] = useState(false)

  // An armed button must not stay armed, or a later click runs the batch unconfirmed.
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => { setConfirming(false) }, CONFIRM_MS)
    return () => { clearTimeout(timer) }
  }, [confirming])

  const disabled = finished === 0 || busy
  return (
    <div className="avwf-toolbar">
      <button
        type="button"
        className={confirming ? 'avwf-clean avwf-clean-armed' : 'avwf-clean'}
        disabled={disabled}
        title={finished === 0
          ? '本会话没有已完成（finish_mission 收尾）的任务树'
          : `删除本会话全部 ${String(finished)} 棵已完成任务树：节点与结果一并删除，不可恢复`}
        onClick={() => {
          if (!confirming) {
            setConfirming(true)
            return
          }
          setConfirming(false)
          onClean()
        }}
      >
        {busy ? '清理中…' : confirming ? `确认清理 ${String(finished)} 棵` : `清理已完成${finished === 0 ? '' : `（${String(finished)}）`}`}
      </button>
    </div>
  )
}

/** Render the session's mission trees. */
export function MissionTreeView({
  useSnapshot, onDeleteTree, onCleanFinished, loadDetail, loadResult, sessionId, openWorkerSession, resolveWorkerSession,
}: MissionViewProps): ReactNode {
  INSTALL_STYLES()
  const state = useSnapshot()
  // The remount-resistant slice of this view's UI state (see `viewState.ts`): the host mints a new
  // entry — and React a new component instance — every time the tab's running marker flips.
  const ui: MissionViewState = useMemo(() => viewStateFor(sessionId), [sessionId])
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [cleaning, setCleaning] = useState(false)
  const [cleanNote, setCleanNote] = useState<string | undefined>(undefined)
  const [cleanFailed, setCleanFailed] = useState(false)
  const [openId, setOpenIdState] = useState<string | undefined>(() => ui.openId)
  const [dialog, setDialog] = useState<DialogState | undefined>(undefined)
  // Bumped by a twisty click. The expand/collapse overrides live in `ui.overrides` (a module-level
  // Map, so it survives the remount the running marker forces) and a Map mutation is invisible to
  // React; this counter is the re-read trigger for the memo that builds the visible rows.
  const [expandVersion, setExpandVersion] = useState(0)

  /** The open dialog is part of the remount-resistant state: reopening it re-reads its detail. */
  const setOpenId = useCallback((nodeId: string | undefined): void => {
    ui.openId = nodeId
    setOpenIdState(nodeId)
  }, [ui])

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

  /** Delete every closed tree, then re-read; the host's two counts become one line. */
  const cleanFinished = (): void => {
    if (onCleanFinished === undefined) return
    setCleaning(true)
    setCleanNote(undefined)
    setCleanFailed(false)
    void onCleanFinished()
      .then((result) => {
        setCleanNote(result.deleted.length === 0
          ? `没有已完成的任务树可清理（跳过 ${String(result.skipped.length)} 棵未收尾）。`
          : `已清理 ${String(result.deleted.length)} 棵已完成任务（跳过 ${String(result.skipped.length)} 棵仍在进行）。`)
        return state.refresh()
      })
      .catch((cause: unknown) => {
        setCleanFailed(true)
        setCleanNote(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => { setCleaning(false) })
  }

  // The writes below are keyed to `nodeId` on purpose: a read that was in flight when the
  // dialog moved to another mission must not land as THAT mission's detail.
  const read = (nodeId: string): void => {
    // A RE-read of the SAME mission keeps what is on screen. The effect below re-reads the open
    // dialog on every snapshot (so a result that lands while it is open appears without a
    // re-click), and blanking it back to 「读取任务详情…」 each time made a live tree flicker —
    // worst while an executor is running.
    setDialog((prev) => (prev?.nodeId === nodeId && prev.status === 'ready'
      ? prev
      : { nodeId, status: 'loading' }))
    void loader.current(nodeId)
      .then((detail) => {
        setDialog((prev) => (prev?.nodeId === nodeId ? { nodeId, status: 'ready', detail } : prev))
      })
      .catch((cause: unknown) => {
        setDialog((prev) => (prev?.nodeId === nodeId
          ? { nodeId, status: 'error', error: cause instanceof Error ? cause.message : String(cause) }
          : prev))
      })
  }

  // The open dialog follows the tree: the same change that re-reads the snapshot re-reads it,
  // so a result that lands while it is open shows up without a re-click.
  useEffect(() => {
    if (openId !== undefined) read(openId)
    // Keyed to the snapshot and the open id, not to `read`'s identity (see `loader`).
  }, [state.data, openId])

  const trees = state.data?.trees ?? []
  // The flat list of what a reader can actually see: one item per tree header plus one per VISIBLE
  // row. Rebuilt when the tree data changes or when a click writes an override (`expandVersion`); a
  // Map mutation alone would not invalidate this memo, which is why the click also bumps a counter.
  const overrides = ui.overrides
  const { items, groups } = useMemo(
    () => buildVisibleItems(trees, overrides),
    [trees, overrides, expandVersion],
  )
  // Windowing is worth its bookkeeping once the ROW list is long; under it the plain column is the
  // list. Headers count as lines too — a header is mounted work like any other.
  const windowed = items.length > VIRTUALIZE_FROM
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const virtualizer = useVirtualizer({
    count: windowed ? items.length : 0,
    enabled: windowed,
    estimateSize: (index) => (items[index]?.kind === 'tree' ? VIRTUAL_ESTIMATED_HEADER_PX : VIRTUAL_ESTIMATED_ROW_PX),
    getItemKey: (index) => items[index]?.key ?? index,
    getScrollElement: () => scrollRef.current,
    initialRect: { width: 0, height: VIRTUAL_INITIAL_VIEWPORT_PX },
    // The offset the reader left behind is the FIRST frame's offset, from the module-level view
    // state — not something a later effect applies after an empty frame. In the browser the
    // element's own `scrollTop` takes over as soon as it is measured; this only seeds the window.
    initialOffset: ui.scrollTop,
    overscan: VIRTUAL_OVERSCAN,
  })

  // Stable identities matter for the row memo: a fresh `actions` object (or callback) on every render
  // would invalidate every `NodeRow` even when nothing it renders changed.
  const openDetail = useCallback((nodeId: string): void => { setOpenId(nodeId) }, [setOpenId])
  const toggleRow = useCallback((nodeId: string, expanded: boolean): void => {
    rememberOverride(ui, nodeId, expanded)
    setExpandVersion((version) => version + 1)
  }, [ui])
  const actions: RowActions = useMemo(
    () => ({ openId, onOpenDetail: openDetail, onToggle: toggleRow }),
    [openId, openDetail, toggleRow],
  )
  // Only CLOSED trees (finish_mission) are batch-clean candidates; an un-retired tree is skipped and
  // reported by the host. Counting here is for the button's label and its enabled/disabled state.
  const finishedCount = trees.filter((tree) => tree.closedAt !== null).length

  // Put the list back where the reader left it, once, as soon as there is a list to scroll: a
  // remount starts with an EMPTY container (the snapshot is re-read), so restoring earlier would
  // simply clamp to 0. The flag keeps a later snapshot from yanking the view back to the old offset.
  const scrollRestored = useRef(false)
  useEffect(() => {
    if (scrollRestored.current || state.data === undefined) return
    scrollRestored.current = true
    const element = scrollRef.current
    if (element !== null && ui.scrollTop > 0) element.scrollTop = ui.scrollTop
  }, [state.data, ui])

  /** One tree as the PLAIN column draws it: a card in flow, its header and every visible row. */
  const plainTree = (group: TreeGroup): ReactNode => (
    <section
      key={group.header.key}
      className={group.header.settled ? 'avwf-tree avwf-tree-settled' : 'avwf-tree'}
    >
      <TreeHeader
        item={group.header}
        busy={busy}
        onDeleteTree={remove}
        sessionId={sessionId}
        {...openWorkerSession === undefined ? {} : { openWorkerSession }}
        {...resolveWorkerSession === undefined ? {} : { resolveWorkerSession }}
      />
      {group.rows.map((row) => (
        <NodeRow
          key={row.key}
          node={row.node}
          depth={row.depth}
          viaParentId={row.viaParentId}
          expandable={row.expandable}
          expanded={row.expanded}
          actions={actions}
        />
      ))}
    </section>
  )

  // The windowed path: the same items, each one a slot positioned by the virtualizer. `totalSize`
  // and the items are computed first because both of them populate `measurementsCache`, which the
  // cards below read for each tree's own top and bottom.
  const virtualItems = windowed ? virtualizer.getVirtualItems() : []
  const totalSize = windowed ? virtualizer.getTotalSize() : 0
  const measurements = virtualizer.measurementsCache
  const firstWindow = virtualItems[0]?.index ?? 0
  const lastWindow = virtualItems[virtualItems.length - 1]?.index ?? -1
  // A card cannot be split between two virtual items, so it is a box of its own, one per tree that
  // has a line in the window, spanning the tree's FULL estimated height (which is what keeps the
  // border around rows that are not mounted). The header item carries the gap above the card
  // ({@link VIRTUAL_TREE_GAP_PX}), so the box starts that far below the tree's first item.
  const cards = windowed
    ? groups.map((group) => {
      if (group.last < firstWindow || group.first > lastWindow) return null
      const top = (measurements[group.first]?.start ?? 0) + VIRTUAL_TREE_GAP_PX
      const bottom = measurements[group.last]?.end ?? top
      return (
        <div
          key={`card:${group.header.tree.rootId}`}
          className={group.header.settled ? 'avwf-tree avwf-tree-settled' : 'avwf-tree'}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: `${String(Math.max(0, bottom - top))}px`,
            // The card's own padding must sit INSIDE the height, or every card would overlap the
            // next one by its padding.
            boxSizing: 'border-box',
            transform: `translateY(${String(top)}px)`,
          }}
        />
      )
    })
    : null

  return (
    <div className="avwf-root">
      {state.error !== undefined ? <div className="avwf-error">{state.error}</div> : null}
      {/* Version skew is a NOTE, not a failure: the snapshot still renders below it. */}
      {state.data?.skew !== undefined ? <div className="avwf-warn">{state.data.skew}</div> : null}
      {failure !== undefined ? <div className="avwf-error">删除失败：{failure}</div> : null}
      {/* The batch entry sits ABOVE the scrolling list, and only when there is a list to act on:
          a session with no tree keeps the empty panel empty. */}
      {onCleanFinished === undefined || trees.length === 0
        ? null
        : <CleanFinishedBar finished={finishedCount} busy={cleaning} onClean={cleanFinished} />}
      {cleanNote === undefined
        ? null
        : <div className={cleanFailed ? 'avwf-error' : 'avwf-meta'}>{cleanNote}</div>}
      {state.loading && state.data === undefined ? <div className="avwf-empty">读取中…</div> : null}
      {/* No empty-state message: a session with no trees shows an empty panel. */}
      {/* The scroll container owns the viewport the window is computed from, so it is
          the element the virtualizer measures — the messages above stay put. Its offset is mirrored
          into the module-level view state so the remount the running marker forces lands where the
          reader left off. */}
      <div
        className="avwf-scroll"
        ref={scrollRef}
        onScroll={(event) => { ui.scrollTop = event.currentTarget.scrollTop }}
      >
        {windowed
          ? (
            <div className="avwf-canvas" style={{ height: `${String(totalSize)}px` }}>
              {cards}
              {virtualItems.map((entry) => {
                const item = items[entry.index]
                if (item === undefined) return null
                // The header's slot carries the air above its card; a row's does not (rows are one
                // table, and `.avwf-slot`'s own bottom padding was the gap between TREES).
                const gap = item.kind === 'tree' ? VIRTUAL_TREE_GAP_PX : 0
                return (
                  <div
                    key={item.key}
                    className="avwf-slot"
                    data-index={entry.index}
                    ref={virtualizer.measureElement}
                    style={{
                      transform: `translateY(${String(entry.start)}px)`,
                      paddingTop: `${String(gap)}px`,
                      paddingBottom: 0,
                    }}
                  >
                    {item.kind === 'tree'
                      ? (
                        <TreeHeader
                          item={item}
                          busy={busy}
                          onDeleteTree={remove}
                          sessionId={sessionId}
                          {...openWorkerSession === undefined ? {} : { openWorkerSession }}
                          {...resolveWorkerSession === undefined ? {} : { resolveWorkerSession }}
                        />
                      )
                      : (
                        <NodeRow
                          node={item.node}
                          depth={item.depth}
                          viaParentId={item.viaParentId}
                          expandable={item.expandable}
                          expanded={item.expanded}
                          actions={actions}
                        />
                      )}
                  </div>
                )
              })}
            </div>
          )
          : groups.map((group) => plainTree(group))}
      </div>
      {/* Rendered HERE, at the view root, and not inside a row: rows live in the virtualizer and
          unmount when scrolled past, which would close the dialog under the reader's pointer. The
          `key` resets the section selection when it moves to another mission. */}
      {openId === undefined
        ? null
        : (
          <MissionDetailDialog
            key={openId}
            nodeId={openId}
            state={dialog?.nodeId === openId ? dialog : undefined}
            onClose={() => { setOpenId(undefined) }}
            loadResult={loadResult}
            sessionId={sessionId}
            {...openWorkerSession === undefined ? {} : { openWorkerSession }}
            {...resolveWorkerSession === undefined ? {} : { resolveWorkerSession }}
          />
        )}
    </div>
  )
}
