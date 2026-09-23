/** The client half's data path, kept away from React so the transport edge stays testable.
 * @module @avantf/dsh-work/client/api
 */
import { detailResultSchema, snapshotResultSchema } from '../wire.js'
import type { WorkNodeDetail, WorkSnapshot } from './contract.js'

/** Safety-net re-read interval; slow on purpose, since the session itself is the primary trigger. */
export const POLL_INTERVAL_MS = 5_000

/** Coalescing window: one turn's burst of session revisions becomes a single read. */
export const REFRESH_COALESCE_MS = 400

/**
 * The cheap session-side value that changes when the work tree may have (node count, inbox,
 * turn boundary); a string because React compares selector results by identity.
 */
export function sessionRevision(input: {
  readonly chatNodes: number
  readonly queued: number
  readonly running: boolean
}): string {
  return `${String(input.chatNodes)}:${String(input.queued)}:${input.running ? '1' : '0'}`
}

/** The Remote namespace surface this plugin consumes. */
export interface WorkRemote {
  snapshot: (args: { sessionId: string }) => Promise<unknown>
  detail: (args: { sessionId: string; nodeId: string }) => Promise<unknown>
  delete: (args: { sessionId: string; rootId: string }) => Promise<unknown>
  /** The FULL text behind a spilled result. Optional for the same reason `watch` is: an older host
   *  simply does not have it, and the pane falls back to showing the locator. */
  result?: (args: { sessionId: string; nodeId: string }) => Promise<unknown>
  /** The engine's change stream, called with the transport's cancellation signal.
   *  Optional: an older host may not expose it, so the caller keeps its timer fallback. */
  watch?: (args: { sessionId: string }, signal: AbortSignal) => AsyncIterable<unknown>
}

type RemoteEnvelope = { ok?: boolean; value?: unknown; error?: unknown }

/** A timer as the client platform publishes it (`interval` returns its disposer). */
export interface IntervalTimer {
  interval: (callback: () => void, delay: number) => () => void
}

/**
 * The human half of a failure. `Error#message` is NOT an own enumerable property, so a plain
 * `JSON.stringify(error)` drops exactly the sentence a reader needs and leaves `{"code":…}` — the
 * `RemoteError` this boundary carries is an `Error` subclass with `code`/`details` as the own ones.
 * So: the message first, the JSON only when there is no message to show.
 */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error === null || typeof error !== 'object') return String(error)
  const message = (error as { message?: unknown }).message
  if (typeof message === 'string' && message !== '') return message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Collapse a burst of triggers into ONE call after `delayMs` of quiet.
 *
 * The work tree has three refresh triggers (the session revision, the engine's change stream, and the
 * stream's reopen) and the engine pushes a frame per state change, so without this a burst of changes
 * costs one snapshot RPC per frame. `cancel` releases a pending call — the disposer of the effect that
 * owns the coalescer, so leaving the tab cannot fire a read into an unmounted panel.
 */
export function coalesce(run: () => void, delayMs: number): { request: () => void; cancel: () => void } {
  let pending: ReturnType<typeof setTimeout> | undefined
  return {
    request: (): void => {
      if (pending !== undefined) return
      pending = setTimeout(() => {
        pending = undefined
        run()
      }, delayMs)
    },
    cancel: (): void => {
      if (pending === undefined) return
      clearTimeout(pending)
      pending = undefined
    },
  }
}

/** Peel the transport envelope (`{ ok, value }` / `{ ok, error }`, or a bare value) so a
 *  wiring mistake surfaces as a message rather than an empty view. */
export function unwrap(response: unknown): { value?: unknown; error?: string } {
  if (response === null || typeof response !== 'object') return { value: response }
  const envelope = response as RemoteEnvelope
  if (envelope.ok === false) return { error: errorText(envelope.error) }
  if (envelope.ok === true) return { value: envelope.value }
  return { value: response }
}

/**
 * Why a payload could not be read, with the likely reason attached.
 *
 * The two halves of this plugin do not update together: the browser bundle is re-read on every page
 * load, the host half only when `dsh web` starts. So a rebuilt client routinely talks to an older
 * host, and the ONE failure this must never produce is silence — an unread node field read in a
 * render body is a `TypeError`, and the shell's slot error boundary turns that into an empty `<div>`
 * with no text and no retry for the rest of the session. Measured once already (the seat fields), and
 * again latent behind every new required field.
 */
function skewHint(what: string, issues: readonly string[]): string {
  const detail = issues.slice(0, 3).join('; ')
  return `${what}返回了无法识别的数据（${detail}）—— 宿主与客户端可能不是同一版本：`
    + '客户端随页面刷新，宿主只在 dsh web 启动时加载一次，重启 dsh web 后再试。'
}

/** zod's own words for the first few problems: enough to see WHICH field moved. */
function issueText(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '(根)'}: ${issue.message}`)
}

function textOf(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason === undefined || reason === null) return '工作树拒绝了这次操作'
  return JSON.stringify(reason)
}

/** Read one session's trees; throws with the reason when the read cannot be trusted. */
export async function fetchSnapshot(remote: WorkRemote, sessionId: string): Promise<WorkSnapshot> {
  const { value, error } = unwrap(await remote.snapshot({ sessionId }))
  if (error !== undefined) throw new Error(error)
  const parsed = snapshotResultSchema.safeParse(value)
  if (!parsed.success) throw new Error(skewHint('工作树', issueText(parsed.error)))
  return { trees: parsed.data.trees as WorkSnapshot['trees'] }
}

/**
 * Delete one whole finished work tree by root — the unit is the TREE; a refusal travels in
 * the result envelope and becomes an exception here.
 */
export async function deleteWork(remote: WorkRemote, sessionId: string, rootId: string): Promise<readonly string[]> {
  const { value, error } = unwrap(await remote.delete({ sessionId, rootId }))
  if (error !== undefined) throw new Error(error)
  const result = value as { deleted?: unknown; error?: unknown } | null | undefined
  if (result !== null && typeof result === 'object' && result.error !== undefined) {
    throw new Error(textOf(result.error))
  }
  const deleted = result !== null && typeof result === 'object' ? result.deleted : undefined
  return Array.isArray(deleted) ? (deleted as string[]) : []
}

export function asDetail(value: unknown): Partial<WorkNodeDetail> & { error?: string } {
  const parsed = detailResultSchema.safeParse(value)
  if (!parsed.success) return { error: skewHint('工作详情', issueText(parsed.error)) }
  return {
    ...parsed.data.node === undefined ? {} : { node: parsed.data.node as WorkNodeDetail['node'] },
    children: (parsed.data.children ?? []) as WorkNodeDetail['children'],
    ...parsed.data.error === undefined ? {} : { error: parsed.data.error },
  }
}

/** Read one work's full detail on demand — results run to 2 KB each, and the snapshot re-reads on change. */
export async function fetchDetail(remote: WorkRemote, sessionId: string, nodeId: string): Promise<WorkNodeDetail> {
  const { value, error } = unwrap(await remote.detail({ sessionId, nodeId }))
  if (error !== undefined) throw new Error(error)
  const detail = asDetail(value)
  if (detail.error !== undefined) throw new Error(detail.error)
  if (detail.node === undefined) throw new Error(`工作 ${nodeId} 没有可显示的详情`)
  return { node: detail.node, children: detail.children ?? [] }
}

/**
 * Name a transport failure that is really a VERSION SKEW.
 *
 * The two halves of this plugin do not update together: the browser bundle is re-read on every page
 * load, the host half is loaded once when `dsh web` starts. So a rebuilt plugin routinely talks to an
 * older host, and the gateway answers a method that host never published with an HTTP 404 — which
 * reads exactly like "the work or the file is gone", the two things it does NOT mean.
 */
export function transportHint(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause)
  if (!/404|not found/iu.test(text)) return text
  return '宿主进程里没有这条调用：客户端会随页面刷新，宿主只在启动时加载一次，所以 dsh web 很可能还在跑'
    + `旧的宿主代码。重启 dsh web 后再试。（原始错误：${text}）`
}

/**
 * Read the FULL text behind a spilled result. On demand only: the pane offering it is answering a
 * question ("show me all of it"), and the host reads a file to answer — so nothing prefetches it.
 * A host that cannot resolve the locator answers with a reason instead, which the pane shows beside
 * the locator rather than as a failed read.
 */
export async function fetchFullResult(remote: WorkRemote, sessionId: string, nodeId: string): Promise<string> {
  const getResult = remote.result
  if (typeof getResult !== 'function') {
    throw new Error('这个宿主不支持读回完整结果（Remote 面没有 result 调用）')
  }
  let response: unknown
  try {
    response = await getResult({ sessionId, nodeId })
  } catch (cause: unknown) {
    // A rejected call is the transport's, and the commonest reason for it here is a host that does not
    // know the method yet — say so instead of "transport failure", which sends the reader looking at
    // the work tree.
    throw new Error(transportHint(cause))
  }
  const { value, error } = unwrap(response)
  if (error !== undefined) throw new Error(error)
  const payload = value as { text?: unknown; error?: unknown } | null | undefined
  if (payload !== null && typeof payload === 'object' && typeof payload.error === 'string') {
    throw new Error(payload.error)
  }
  const text = payload !== null && typeof payload === 'object' ? payload.text : undefined
  if (typeof text !== 'string') throw new Error('完整结果返回了无法识别的数据')
  return text
}

/**
 * Follow the engine's change stream, calling `onChange` per frame; the frame carries a
 * revision and nothing else. The CALLER decides what a normal end means.
 */
export async function watchChanges(
  remote: WorkRemote,
  sessionId: string,
  signal: AbortSignal,
  onChange: () => void,
): Promise<void> {
  const watch = remote.watch
  if (typeof watch !== 'function') return
  for await (const _frame of watch.call(remote, { sessionId }, signal)) {
    if (signal.aborted) return
    onChange()
  }
}

export const STREAM_REOPEN_MS = 1_000

/**
 * Start re-reading on a timer — a poll, not a subscription, because the tree lives in a
 * host-side KV domain with no event feed. Two rungs because the platform `timer` service is
 * NOT reliably mounted: the service is preferred, the browser's own timers are the fallback.
 */
export function startPolling(
  refresh: () => void,
  intervalMs: number,
  service: Partial<IntervalTimer> | undefined,
  host: HostTimers = globalThis as unknown as HostTimers,
): () => void {
  if (typeof service?.interval === 'function') return service.interval(refresh, intervalMs)
  const setIntervalFn = host.setInterval
  const clearIntervalFn = host.clearInterval
  if (typeof setIntervalFn === 'function' && typeof clearIntervalFn === 'function') {
    const handle = setIntervalFn(refresh, intervalMs)
    return () => { clearIntervalFn(handle) }
  }
  return () => undefined
}

export interface HostTimers {
  setInterval?: (callback: () => void, delay: number) => unknown
  clearInterval?: (handle: unknown) => void
}
