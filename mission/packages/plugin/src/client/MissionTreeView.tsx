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
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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

/** Statuses that mean "this mission is over" — a tree whose root reached one is deletable. */
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
 * The shared row state, passed down as one object so adding a field cannot go stale in half
 * the tree. The delete action is deliberately NOT here: it belongs to the tree.
 */
interface RowActions {
  /** The node whose dialog is open, if any; the row uses it to mark itself as the source. */
  readonly openId: string | undefined
  readonly onOpenDetail: (nodeId: string) => void
}

/**
 * The nodes one node depends on, read from the PARENT's `children` and not by matching
 * `parentId`: a reused prerequisite keeps the parent it was born under, so filtering by
 * `parentId` renders it as a leaf — a node that looks like it is waiting for nothing.
 */
function childrenOf(nodes: readonly MissionNodeView[], parent: MissionNodeView): readonly MissionNodeView[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return parent.children
    .map((id) => byId.get(id))
    .filter((node): node is MissionNodeView => node !== undefined)
}

/** The empty ancestor path, shared so a root row does not allocate one. */
const NO_ANCESTORS: ReadonlySet<string> = new Set<string>()

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
 */
export function nodeIdLinkLabel(
  workerSessionId: string | null | undefined,
  workerLive: boolean | undefined,
): string {
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
 * `open` may throw or answer with a rejected promise (the session really was cleaned up): both become
 * the `open` failure. The panel must never blank — or lose its place — because a link went stale,
 * which is the one failure a link invited by us can cause.
 */
export async function workerSessionOpen(input: {
  readonly nodeId: string
  readonly parentSessionId: string
  /** The handle already on the record, when there is one. */
  readonly workerSessionId?: string | null
  readonly open?: (target: WorkerSessionTarget) => unknown
  readonly resolveSession?: (nodeId: string) => Promise<ExecutorSessionLookup>
  readonly onLookupStart?: () => void
}): Promise<WorkerSessionOpenOutcome> {
  const fail = (reason: WorkerSessionFailureReason, detail?: string): WorkerSessionOpenOutcome =>
    ({ opened: false, reason, message: workerFailureText(reason, detail) })
  const textOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

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
 */
export function NodeIdEntry({
  nodeId, workerSessionId, workerLive, sessionId, open, onFailure, resolveSession, className,
}: {
  /** The MISSION's id — what is rendered; the session is only the destination. */
  nodeId: string
  workerSessionId: string | null | undefined
  workerLive?: boolean
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
  const hasHandle = typeof workerSessionId === 'string' && workerSessionId !== ''
  const label = nodeIdLinkLabel(workerSessionId, workerLive)
  const where = hasHandle
    ? `执行这个任务的会话 ${workerSessionId}（${workerLive === true ? '进行中' : '已结束'}）`
    : '执行这个任务的会话（记录里没有句柄，点击时按时间窗与首条提示词查找）'
  // No `uiWorkspace`: the id is STILL the entry, and the click explains why it cannot go anywhere.
  const blocked = open === undefined ? '；当前宿主没有 uiWorkspace 服务，无法跳转' : ''
  const click = createWorkerSessionClick({
    nodeId,
    parentSessionId: sessionId,
    workerSessionId,
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
      className={`${className} avwf-node-id avwf-worker-link${hasHandle ? '' : ' avwf-worker-lookup'}`}
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

function NodeRow({ node, nodes, depth, viaParentId, ancestors = NO_ANCESTORS, actions }: {
  node: MissionNodeView
  nodes: readonly MissionNodeView[]
  depth: number
  /** The parent that listed this node; absent for a tree's root. */
  viaParentId?: string
  /**
   * The ids on the path from the root down to this row. `children` is an arbitrary id list in a
   * persisted document, and the core's own dedup only excludes ancestors while BUILDING a tree —
   * a document corrupted from outside (or a wire payload from a wildly skewed host) could point a
   * node back at one of its ancestors, and the recursion would run until the browser's stack died,
   * taking the whole panel with it. Dropping an already-visited child is the cheap guard.
   */
  ancestors?: ReadonlySet<string>
  actions: RowActions
}): ReactNode {
  const { openId, onOpenDetail } = actions
  // A child already on this path is a cycle, not a dependency: it stops here instead of descending.
  const children = childrenOf(nodes, node).filter((child) => !ancestors.has(child.id))
  // Listed here as a prerequisite: marked so a repeated row does not read as a duplicate.
  const reused = viaParentId !== undefined && node.parentId !== viaParentId
  // The default follows the node: open while its mission is in play, folded once it finished.
  // A click is stored as an OVERRIDE rather than as the state itself, so the default keeps
  // tracking the node afterwards and "I opened this one" survives it finishing.
  const [override, setOverride] = useState<boolean | undefined>(undefined)
  const settled = TERMINAL.includes(node.status)
  const expanded = override ?? !settled
  const expandable = children.length > 0
  const indent = { paddingLeft: `${String(depth * 14 + 6)}px` }
  const detailOpen = openId === node.id
  // Why this mission is queued (skipped by an admission gate), or `undefined` when it is not. Being
  // skipped is normal queuing, so this renders as a marker, never as a warning.
  const waiting = waitingLabel(node.waitingFor)

  return (
    <div className="avwf-node">
      <div className="avwf-row" style={indent}>
        <button
          type="button"
          className={expandable ? 'avwf-twisty' : 'avwf-twisty avwf-twisty-empty'}
          onClick={() => { setOverride(!expanded) }}
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
        {node.corrections.length > 0
          ? (
            <span
              className="avwf-meta avwf-corrected"
              title={`已纠偏 ${String(node.corrections.length)} 次：\n${node.corrections.join('\n')}`}
            >
              已纠偏 {node.corrections.length} 次
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
        {node.resultRef !== null ? <span className="avwf-meta" title={node.resultRef}>结果已落盘</span> : null}
        <span className="avwf-meta avwf-detail-hint">详情</span>
      </div>
      {node.context.length > 0 ? (
        <div className="avwf-context" style={{ paddingLeft: `${String(depth * 14 + 30)}px` }}>
          {node.context.join(' · ')}
        </div>
      ) : null}
      {expanded && expandable
        ? children.map((child) => (
          <NodeRow
            key={child.id}
            node={child}
            nodes={nodes}
            depth={depth + 1}
            viaParentId={node.id}
            ancestors={new Set([...ancestors, node.id])}
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
function Tree({ tree, actions, busy, onDeleteTree, sessionId, openWorkerSession, resolveWorkerSession }: {
  tree: MissionTreeViewData
  actions: RowActions
  busy: string | undefined
  onDeleteTree: (rootId: string) => void
  /** The owner session, and the optional opener — the tree header's root id opens the ROOT's
   *  executor session through the same entry the dialog uses. */
  sessionId: string
  openWorkerSession?: (target: WorkerSessionTarget) => void
  resolveWorkerSession?: (nodeId: string) => Promise<ExecutorSessionLookup>
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
    <section className={settled ? 'avwf-tree avwf-tree-settled' : 'avwf-tree'}>
      <header className="avwf-tree-header">
        {/* The tree's ROOT ID is the node id a reader sees here; it is the entry to the session that
            ran the root mission, exactly as the dialog's heading id is (see `NodeIdEntry`). */}
        <NodeIdEntry
          nodeId={tree.rootId}
          workerSessionId={root?.workerSessionId}
          workerLive={root?.workerLive}
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
      {root === undefined
        ? <div className="avwf-empty">根节点缺失</div>
        : <NodeRow node={root} nodes={tree.nodes} depth={0} actions={actions} />}
    </section>
  )
}

/** Render the session's mission trees. */
export function MissionTreeView({
  useSnapshot, onDeleteTree, loadDetail, loadResult, sessionId, openWorkerSession, resolveWorkerSession,
}: MissionViewProps): ReactNode {
  INSTALL_STYLES()
  const state = useSnapshot()
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [dialog, setDialog] = useState<DialogState | undefined>(undefined)

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

  const openDetail = (nodeId: string): void => { setOpenId(nodeId) }
  const actions: RowActions = { openId, onOpenDetail: openDetail }

  const renderTree = (tree: MissionTreeViewData, slot?: { style: CSSProperties; index: number }): ReactNode => (
    <div
      key={tree.rootId}
      className={slot === undefined ? undefined : 'avwf-slot'}
      data-index={slot?.index}
      ref={slot === undefined ? undefined : virtualizer.measureElement}
      style={slot?.style}
    >
      <Tree
        tree={tree}
        actions={actions}
        busy={busy}
        onDeleteTree={remove}
        sessionId={sessionId}
        {...openWorkerSession === undefined ? {} : { openWorkerSession }}
        {...resolveWorkerSession === undefined ? {} : { resolveWorkerSession }}
      />
    </div>
  )

  return (
    <div className="avwf-root">
      {state.error !== undefined ? <div className="avwf-error">{state.error}</div> : null}
      {/* Version skew is a NOTE, not a failure: the snapshot still renders below it. */}
      {state.data?.skew !== undefined ? <div className="avwf-warn">{state.data.skew}</div> : null}
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
