/** The client half's data path, kept away from React so the transport edge stays testable.
 * @module @avantf/dsh-mission/client/api
 */
import {
  CLEAN_FINISHED_WIRE_VERSION,
  EXECUTOR_LOOKUP_WIRE_VERSION,
  SNAPSHOT_WIRE_VERSION,
  cleanFinishedResultSchema,
  detailResultSchema,
  snapshotResultSchema,
} from '../wire.js'
import type { ExecutorSessionLookup, MissionNodeDetail, MissionSnapshot } from './contract.js'

/** Safety-net re-read interval; slow on purpose, since the session itself is the primary trigger. */
export const POLL_INTERVAL_MS = 5_000

/**
 * Coalescing window: one turn's burst of session revisions becomes a single read.
 */
export const REFRESH_COALESCE_MS = 400

/**
 * How often the panel re-reads even while the engine's change stream is up. The stream is the update
 * channel, but a stream that is silently dead (open, delivering nothing) is not detectable from this
 * side, and the panel must not be able to go stale forever — this bounds the staleness. It is not a
 * "poll": at 30 s it is a backstop, and a healthy stream still gives sub-second freshness.
 */
export const STREAM_KEEPALIVE_MS = 30_000

/**
 * The cheap session-side value that changes when the mission tree may have. It deliberately does NOT
 * include the chat node count: the mission tree is not a function of how many messages the
 * conversation holds, and folding that in made every chat activity re-read and re-render the whole
 * tree (the stream is what carries actual mission changes; `queued`/`running` are the session-side
 * facts that matter).
 */
export function sessionRevision(input: {
  readonly queued: number
  readonly running: boolean
}): string {
  return `${String(input.queued)}:${input.running ? '1' : '0'}`
}

/** The Remote namespace surface this plugin consumes. */
export interface MissionRemote {
  snapshot: (args: { sessionId: string }) => Promise<unknown>
  detail: (args: { sessionId: string; nodeId: string }) => Promise<unknown>
  delete: (args: { sessionId: string; rootId: string }) => Promise<unknown>
  /** Delete EVERY closed tree this session owns (the panel's "清理已完成"). Optional for the same
   *  reason as `result`: an older host has no such method, and the panel refuses to send the call
   *  rather than reading the gateway's 404 as "the missions are gone". */
  cleanFinished?: (args: { sessionId: string }) => Promise<unknown>
  /** The FULL text behind a spilled result. Optional for the same reason `watch` is: an older host
   *  simply does not have it, and the pane falls back to showing the locator. */
  result?: (args: { sessionId: string; nodeId: string }) => Promise<unknown>
  /** The click-time executor lookup (W18). Optional for the same reason as `result`: an older host
   *  has no such method, and the panel says "the two halves are out of step" instead of guessing. */
  resolveExecutorSession?: (args: { sessionId: string; nodeId: string }) => Promise<unknown>
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
 * The mission tree has three refresh triggers (the session revision, the engine's change stream, and the
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
  if (reason === undefined || reason === null) return '任务树拒绝了这次操作'
  return JSON.stringify(reason)
}

/**
 * The version-skew note for one `snapshot` payload, or `undefined` when the two halves agree.
 *
 * WHY A NOTE AND NOT A THROW. The host half is loaded ONCE when `dsh web` starts; this bundle is
 * re-read on every page load. So a rebuilt client routinely talks to an older host, and the ONE thing
 * the marker must never do is blank the panel: `snapshot` is the entry point every other read hangs
 * off, and an unrecognised revision usually still carries the fields the panel renders. So an absent
 * marker ("host predates it") and an unknown one ("host is newer") both come back as a note beside the
 * tree, never as a failed read.
 *
 * `wire` is read off the RAW payload rather than a validated field: the schema accepts any number, and
 * a payload whose `wire` is missing must not be reported as a shape failure.
 */
export function snapshotSkew(value: unknown): string | undefined {
  const wire = value !== null && typeof value === 'object'
    ? (value as { wire?: unknown }).wire
    : undefined
  if (wire === SNAPSHOT_WIRE_VERSION) return undefined
  if (wire === undefined) {
    return `宿主没有回报 wire 版本（它比本客户端旧）：面板可能缺少新字段，重启 dsh web 让两半对齐。`
      + `（本客户端说 wire=${String(SNAPSHOT_WIRE_VERSION)}）`
  }
  return `宿主回报的 wire 版本是 ${String(wire)}，本客户端只认识 ${String(SNAPSHOT_WIRE_VERSION)}：`
    + '面板继续显示，但两半可能已经错位——重启 dsh web 后再试。'
}

/** Read one session's trees; throws with the reason when the read cannot be trusted. */
export async function fetchSnapshot(remote: MissionRemote, sessionId: string): Promise<MissionSnapshot> {
  const { value, error } = unwrap(await remote.snapshot({ sessionId }))
  if (error !== undefined) throw new Error(error)
  const parseStartedAt = nowMs()
  const parsed = snapshotResultSchema.safeParse(value)
  const parseMs = nowMs() - parseStartedAt
  if (!parsed.success) throw new Error(skewHint('任务树', issueText(parsed.error)))
  // A version skew is a NOTE on a usable snapshot, not a failure: see `snapshotSkew`.
  const skew = snapshotSkew(value)
  // The revision travels with the snapshot so a later click can gate on it (see
  // `fetchExecutorSession`): the host half is loaded once, so this cannot change under a session.
  const wire = parsed.data.wire
  // The step timed as the "merge": what turns the validated payload into the snapshot the view reads.
  // For a full frame that is this assignment; an incremental frame (see the N3 plan) replaces it with
  // a by-id merge, and that merge's own cost lands on the same line.
  const mergeStartedAt = nowMs()
  const snapshot: MissionSnapshot = {
    trees: parsed.data.trees as MissionSnapshot['trees'],
    ...wire === undefined ? {} : { wire },
    ...skew === undefined ? {} : { skew },
  }
  const mergeMs = nowMs() - mergeStartedAt
  logSnapshotFrame({
    bytes: reportedBytes(value),
    parseMs,
    mergeMs,
    trees: snapshot.trees.length,
    nodes: snapshot.trees.reduce((sum, tree) => sum + tree.nodes.length, 0),
  })
  return snapshot
}

/** A monotonic clock when the platform has one, so the timings are not quantised by the wall clock. */
function nowMs(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/**
 * The frame size the HOST reported, when it rode the payload.
 *
 * Read off the RAW value, not `parsed.data`: the wire schema deliberately does not name `bytes` (see
 * `wire.ts`), so `safeParse` strips it. `undefined` against an older host — and that case must stay
 * FREE: measuring the frame here would mean a second `JSON.stringify` of a payload this client just
 * walked, on the very path the instrumentation exists to keep cheap.
 */
function reportedBytes(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const bytes = (value as { bytes?: unknown }).bytes
  return typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : undefined
}

/**
 * One line per frame, on the browser's DEBUG channel — instrumentation, not an error, and
 * `console.debug` stays out of the way unless the console's verbose level is on. This is what turns
 * the N3 question ("每帧 X KB / Y ms") into a number read off a real tree; when step 2 is NOT done,
 * `merge` is the full-replace assignment above and reads as the near-zero it is.
 *
 * SILENT when the host reported no size (an older host): there is then nothing to print that this
 * client did not have to measure, and paying a second `JSON.stringify` per frame to print it would
 * make the instrumentation cost the very thing it exists to measure.
 *
 * Total on purpose: a logger that threw (a sandboxed console) must not be able to fail the read it
 * describes.
 */
function logSnapshotFrame(input: {
  readonly bytes: number | undefined
  readonly parseMs: number
  readonly mergeMs: number
  readonly trees: number
  readonly nodes: number
}): void {
  if (input.bytes === undefined) return
  try {
    if (typeof console === 'undefined' || typeof console.debug !== 'function') return
    console.debug(
      `[avantf-mission] snapshot frame: ${(input.bytes / 1024).toFixed(1)} KB,`
      + ` parse ${input.parseMs.toFixed(2)} ms, merge ${input.mergeMs.toFixed(2)} ms`
      + ` (${String(input.trees)} tree(s) / ${String(input.nodes)} node(s))`,
    )
  } catch {
    // A logging failure must never break the read it describes.
  }
}

/**
 * Delete one whole finished mission tree by root — the unit is the TREE; a refusal travels in
 * the result envelope and becomes an exception here.
 */
export async function deleteWork(remote: MissionRemote, sessionId: string, rootId: string): Promise<readonly string[]> {
  const { value, error } = unwrap(await remote.delete({ sessionId, rootId }))
  if (error !== undefined) throw new Error(error)
  const result = value as { deleted?: unknown; error?: unknown } | null | undefined
  if (result !== null && typeof result === 'object' && result.error !== undefined) {
    throw new Error(textOf(result.error))
  }
  const deleted = result !== null && typeof result === 'object' ? result.deleted : undefined
  return Array.isArray(deleted) ? (deleted as string[]) : []
}

/**
 * Delete EVERY closed tree this session owns — the batch entry behind the panel's "清理已完成".
 *
 * The first half is the version-skew gate, exactly as {@link fetchExecutorSession}'s: against a host
 * whose `wire` predates the method, sending the call can only produce a gateway 404 that reads like
 * "the missions are gone". The call is not sent, and the sentence names the remedy (restart dsh).
 *
 * Returns the two id lists the host reported — the roots removed and the roots kept because they were
 * never retired — so the caller can render "N removed / M skipped" without parsing prose.
 */
export async function cleanFinishedWork(
  remote: MissionRemote,
  sessionId: string,
  hostWire?: number,
): Promise<{ deleted: readonly string[]; skipped: readonly string[] }> {
  if (hostWire === undefined || hostWire < CLEAN_FINISHED_WIRE_VERSION) {
    throw new Error(staleCleanHostText(hostWire))
  }
  const clean = remote.cleanFinished
  if (typeof clean !== 'function') {
    throw new Error(
      '宿主可能没有注册这个接口（旧版本 / 未重启）：Remote 面没有 cleanFinished 调用，'
      + '宿主只在 dsh web 启动时加载一次，重启 dsh web 后再试。',
    )
  }
  let response: unknown
  try {
    response = await clean({ sessionId })
  } catch (cause: unknown) {
    throw new Error(transportHint(cause))
  }
  const { value, error } = unwrap(response)
  if (error !== undefined) throw new Error(error)
  const parsed = cleanFinishedResultSchema.safeParse(value)
  if (!parsed.success) throw new Error(skewHint('已完成任务清理', issueText(parsed.error)))
  return { deleted: parsed.data.deleted, skipped: parsed.data.skipped }
}

export function asDetail(value: unknown): Partial<MissionNodeDetail> & { error?: string } {
  const parsed = detailResultSchema.safeParse(value)
  if (!parsed.success) return { error: skewHint('任务详情', issueText(parsed.error)) }
  return {
    ...parsed.data.node === undefined ? {} : { node: parsed.data.node as MissionNodeDetail['node'] },
    children: (parsed.data.children ?? []) as MissionNodeDetail['children'],
    ...parsed.data.error === undefined ? {} : { error: parsed.data.error },
  }
}

/** Read one mission's full detail on demand — results run to 2 KB each, and the snapshot re-reads on change. */
export async function fetchDetail(remote: MissionRemote, sessionId: string, nodeId: string): Promise<MissionNodeDetail> {
  const { value, error } = unwrap(await remote.detail({ sessionId, nodeId }))
  if (error !== undefined) throw new Error(error)
  const detail = asDetail(value)
  if (detail.error !== undefined) throw new Error(detail.error)
  if (detail.node === undefined) throw new Error(`任务 ${nodeId} 没有可显示的详情`)
  return { node: detail.node, children: detail.children ?? [] }
}

/**
 * Name a transport failure that is really a VERSION SKEW.
 *
 * The two halves of this plugin do not update together: the browser bundle is re-read on every page
 * load, the host half is loaded once when `dsh web` starts. So a rebuilt plugin routinely talks to an
 * older host, and the gateway answers a method that host never published with an HTTP 404 — which
 * reads exactly like "the mission or the file is gone", the two things it does NOT mean. The sentence
 * therefore names the missing REGISTRATION (an older host, or one that was never restarted) rather
 * than only repeating the transport text.
 */
export function transportHint(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause)
  if (!/404|not found/iu.test(text)) return text
  return '宿主可能没有注册这个接口（旧版本 / 未重启）：客户端会随页面刷新，宿主只在 dsh web 启动时加载一次，'
    + `所以 dsh web 很可能还在跑旧的宿主代码。重启 dsh web 后再试。（原始错误：${text}）`
}

/**
 * The sentence for a host older than a click-time remote call. The call is NEVER sent, so this must
 * not read as a transport failure: the host's own revision says the method does not exist, and the
 * remedy (restart dsh) is specific. `undefined` is the host that predates the `wire` marker at all —
 * the same vintage, said differently.
 */
function staleHostLookupText(hostWire: number | undefined): string {
  const state = hostWire === undefined
    ? `宿主没有回报 wire 版本（本客户端需要 ${String(EXECUTOR_LOOKUP_WIRE_VERSION)}）`
    : `宿主仍在运行旧版本（wire ${String(hostWire)} < ${String(EXECUTOR_LOOKUP_WIRE_VERSION)}）`
  return `${state}：它还没有注册 resolveExecutorSession 这条调用，所以这次查找没有发出去。`
    + '重启 dsh 后即可点击历史任务。'
}

/** The same gate as {@link staleHostLookupText}, for the batch clean: the call is never sent. */
function staleCleanHostText(hostWire: number | undefined): string {
  const state = hostWire === undefined
    ? `宿主没有回报 wire 版本（本客户端需要 ${String(CLEAN_FINISHED_WIRE_VERSION)}）`
    : `宿主仍在运行旧版本（wire ${String(hostWire)} < ${String(CLEAN_FINISHED_WIRE_VERSION)}）`
  return `${state}：它还没有注册 cleanFinished 这条调用，所以这次清理没有发出去。`
    + '重启 dsh web 后即可批量清理已完成任务（也可以先用 /clean missions all）。'
}

/**
 * Read the FULL text behind a spilled result. On demand only: the pane offering it is answering a
 * question ("show me all of it"), and the host reads a file to answer — so nothing prefetches it.
 * A host that cannot resolve the locator answers with a reason instead, which the pane shows beside
 * the locator rather than as a failed read.
 */
export async function fetchFullResult(remote: MissionRemote, sessionId: string, nodeId: string): Promise<string> {
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
    // the mission tree.
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
 * Ask the host to find the session that ran one node (W18). CALLED ONLY FROM A CLICK: the server
 * side lists the session corpus and reads a few logs, which is exactly the cost the panel must not
 * pay while rendering.
 *
 * Four failure shapes, kept apart on purpose:
 * - the host reports a `wire` older than the method (an older host, or one never restarted) → the call
 *   is NOT SENT at all, and the sentence names the remedy (restart dsh);
 * - the host has no such method despite a current `wire` → the same version-skew sentence;
 * - the call itself failed (transport) → `transportHint`'s reading of it;
 * - the host ANSWERED "never dispatched" / "not found" / "cannot look up" → returned as an answer,
 *   because those are outcomes a reader must be told about, not failures of the panel.
 *
 * `hostWire` is the revision the host reported on its last `snapshot` (carried on the snapshot the
 * panel renders from). Checked FIRST and before the remote is even touched: against a host that never
 * registered the method, sending the call can only produce a gateway 404 that reads like a deleted
 * mission (see `transportHint`).
 */
export async function fetchExecutorSession(
  remote: MissionRemote,
  sessionId: string,
  nodeId: string,
  hostWire?: number,
): Promise<ExecutorSessionLookup> {
  if (hostWire === undefined || hostWire < EXECUTOR_LOOKUP_WIRE_VERSION) {
    throw new Error(staleHostLookupText(hostWire))
  }
  const resolve = remote.resolveExecutorSession
  if (typeof resolve !== 'function') {
    throw new Error(
      '宿主可能没有注册这个接口（旧版本 / 未重启）：Remote 面没有 resolveExecutorSession 调用，'
      + '宿主只在 dsh web 启动时加载一次，重启 dsh web 后再试。',
    )
  }
  let response: unknown
  try {
    response = await resolve({ sessionId, nodeId })
  } catch (cause: unknown) {
    throw new Error(transportHint(cause))
  }
  const { value, error } = unwrap(response)
  if (error !== undefined) throw new Error(error)
  const payload = value as { sessionId?: unknown; status?: unknown; error?: unknown } | null | undefined
  if (payload === null || typeof payload !== 'object') throw new Error('查找执行者会话返回了无法识别的数据')
  const status = payload.status
  if (status !== 'resolved' && status !== 'never-dispatched' && status !== 'not-found' && status !== 'unsupported') {
    throw new Error('查找执行者会话返回了无法识别的数据')
  }
  return {
    status,
    ...typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {},
    ...typeof payload.error === 'string' ? { error: payload.error } : {},
  }
}

/**
 * Follow the engine's change stream, calling `onChange` per frame; the frame carries a
 * revision and nothing else. The CALLER decides what a normal end means.
 */export async function watchChanges(
  remote: MissionRemote,
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
