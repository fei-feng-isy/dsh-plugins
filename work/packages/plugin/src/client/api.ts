/** The client half's data path, kept away from React so the transport edge stays testable.
 * @module @avantf/dsh-work/client/api
 */
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
  /** The engine's change stream, called with the transport's cancellation signal.
   *  Optional: an older host may not expose it, so the caller keeps its timer fallback. */
  watch?: (args: { sessionId: string }, signal: AbortSignal) => AsyncIterable<unknown>
}

type RemoteEnvelope = { ok?: boolean; value?: unknown; error?: unknown }

/** A timer as the client platform publishes it (`interval` returns its disposer). */
export interface IntervalTimer {
  interval: (callback: () => void, delay: number) => () => void
}

/** Peel the transport envelope (`{ ok, value }` / `{ ok, error }`, or a bare value) so a
 *  wiring mistake surfaces as a message rather than an empty view. */
export function unwrap(response: unknown): { value?: unknown; error?: string } {
  if (response === null || typeof response !== 'object') return { value: response }
  const envelope = response as RemoteEnvelope
  if (envelope.ok === false) {
    return { error: typeof envelope.error === 'string' ? envelope.error : JSON.stringify(envelope.error) }
  }
  if (envelope.ok === true) return { value: envelope.value }
  return { value: response }
}

export function asSnapshot(value: unknown): WorkSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const trees = (value as { trees?: unknown }).trees
  if (!Array.isArray(trees)) return undefined
  return { trees: trees as WorkSnapshot['trees'] }
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
  const snapshot = asSnapshot(value)
  if (snapshot === undefined) {
    throw new Error(`工作树 Remote 返回了无法识别的数据：${JSON.stringify(value)}`)
  }
  return snapshot
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
  if (value === null || typeof value !== 'object') return { error: '工作详情返回了无法识别的数据' }
  const payload = value as { node?: unknown; children?: unknown; error?: unknown }
  return {
    ...payload.node === undefined || payload.node === null
      ? {}
      : { node: payload.node as WorkNodeDetail['node'] },
    children: Array.isArray(payload.children) ? (payload.children as WorkNodeDetail['children']) : [],
    ...typeof payload.error === 'string' ? { error: payload.error } : {},
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
