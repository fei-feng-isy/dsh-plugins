/**
 * Finding the session that executed ONE historical mission, lazily.
 *
 * W17 made a node id clickable only when the record already carried `executorSessionId`. Nodes
 * dispatched before that field existed have none, so their id was plain text and the session that
 * ran them was unreachable from the panel. The fix cannot be "backfill at mount": resolving a
 * historical executor means LISTING sessions and READING session logs, and doing that while the
 * panel mounts would put the cost of every unlinkable node on every page load.
 *
 * So this module is the click-time half: it is called only from the Remote method that a click
 * invokes, and it answers with a reason rather than an exception, because a miss is an ordinary
 * outcome (the session may have been cleaned up) that the panel has to be able to explain.
 *
 * It is deliberately separated from `host.ts`: the host owns the tree and the write-back, this owns
 * "which stored session is the one that ran node X", and a test can pin the filtering rules and the
 * read budget with no tree and no engine.
 * @module @avantf/dsh-mission/executorSession
 */

/** One stored session, as `sessionQuery.listSessions()` reports it (the fields the filter reads). */
export interface ListedSession {
  readonly header: {
    readonly id: string
    readonly createdAt?: number
    readonly parentSession?: string
  }
}

/**
 * The two `SessionEventResultFilter` members this resolver sends, transcribed from the REAL contract
 * (`@deepseek-ai/dsh-session-query`): a filter array is ANDed, and every clause is an OBJECT
 * discriminated by `kind`. It is NOT a tuple array — W20 shipped `[['time', from, to], ['text', …]]`,
 * which the real `materializeSessionEventResultFilters` rejects with `unknown filter kind (missing)`
 * before it reads anything. The local union stays structural (this module imports no optional
 * service), but it must mirror that shape, and only the two members actually used are declared.
 */
type SessionEventFilter =
  | { readonly kind: 'time'; readonly from?: number; readonly to?: number }
  | { readonly kind: 'text'; readonly text: string }

/** The slice of `sessionQuery` this resolver uses. Structural, like every optional service here. */
export interface SessionQueryLike {
  listSessions(): Promise<readonly ListedSession[]>
  /** Events of one session, AND-filtered by the real `SessionEventResultFilter` object union. */
  filterEvents(
    sessionId: string,
    filters: readonly SessionEventFilter[],
  ): Promise<readonly { readonly text: string }[]>
}

interface ResolveExecutorSessionOptions {
  readonly node: {
    readonly createdAt?: number
    readonly activityAt?: number
    readonly updatedAt?: number
    /**
     * How many times this node has been dispatched. `0` is the DURABLE proof that no session ever
     * ran it (and what the panel's "从未派发" sentence is about); `undefined` means the record cannot
     * say, and the lookup proceeds rather than asserting something it does not know.
     */
    readonly attempts?: number
  }
  /** The owner session every worker hangs under — the panel's own session. */
  readonly ownerSessionId: string
  /** The optional `sessionQuery` service; omitted means the host cannot look anything up. */
  readonly query: SessionQueryLike | undefined
  /** Wall clock, injected so a test fixes the window. */
  readonly now: number
  /**
   * Where a failed per-candidate log read goes. The failure must not VANISH: a filter whose SHAPE
   * the service rejects fails on every candidate and, from the outside, looks exactly like "the
   * session is gone" — which is how W20's total outage stayed green. At most one message per
   * lookup; absent means no sink (tests that do not care).
   */
  readonly warn?: (message: string) => void
}

/** Why no session could be named. The panel turns each into its own sentence. */
type ExecutorSessionResolution =
  | { readonly status: 'resolved'; readonly sessionId: string; readonly candidatesRead: number }
  | { readonly status: 'never-dispatched' }
  | { readonly status: 'not-found' }
  | { readonly status: 'unsupported'; readonly error: string }

/**
 * Worst-case number of session LOGS one click may read.
 *
 * The three candidate filters (parent, id shape, time window) are metadata and free; this bounds the
 * part that opens stored logs. A miss over more than this many candidates inside one node's own time
 * window is not a lookup problem — the owner simply ran many sessions while this node was alive —
 * and the bound is what keeps a click from turning into a scan of the whole corpus.
 */
export const RESOLVE_READ_BUDGET = 8

/**
 * Slack around a node's own time window, in ms. Both ends exist for the same reason: the node
 * record and the session header are written by different code, so clocks a second or two apart
 * would otherwise hide the very session being looked for.
 *
 * Both margins are small BECAUSE of what they bound. The START is the node's creation, and the
 * session that ran it is created at (or within seconds of) the dispatch that stamped the record.
 * The END is the node's last movement, and the last attempt was dispatched BEFORE it — a wide
 * trailing margin would only re-admit the owner's later, unrelated work, which is exactly what the
 * time clause exists to keep out of the read budget.
 */
export const WINDOW_BEFORE_MS = 120_000
export const WINDOW_AFTER_MS = 120_000

/** The worker session id shape (`claims.ts`), re-stated here so this module imports no sibling. */
const WORKER_ID = /^mission-[0-9a-f]{8}$/u

/**
 * Where one node's execution can have happened: from its creation through the last moment its
 * record moved, plus the margins.
 *
 * The END is the node's own last movement (`activityAt` / `updatedAt`) and deliberately NOT the
 * current wall clock. A session created long after a node stopped moving cannot have run it — and
 * "now" as the end would let the very sessions the third clause exists to exclude (the owner's
 * LATER work, which really is `mission-*` and really does hang under this owner) back in, spending
 * the read budget on them. `now` is only the fallback for a record with no end at all.
 *
 * A record with no usable timestamps gets the widest window instead of a wrong narrow one: the read
 * budget still bounds the work, and whether the node was ever dispatched is answered separately
 * (`attempts`), never inferred from a missing clock.
 */
function searchWindow(node: ResolveExecutorSessionOptions['node'], now: number): { from: number; to: number } {
  const created = Number.isFinite(node.createdAt) ? (node.createdAt as number) : 0
  const activity = Number.isFinite(node.activityAt) ? (node.activityAt as number) : 0
  const updated = Number.isFinite(node.updatedAt) ? (node.updatedAt as number) : 0
  const ended = Math.max(activity, updated, created)
  const fallback = Number.isFinite(now) ? now : ended
  return {
    from: created > 0 ? created - WINDOW_BEFORE_MS : 0,
    to: (ended > 0 ? ended : fallback) + WINDOW_AFTER_MS,
  }
}

/**
 * The sessions that COULD be one node's executor, newest first.
 *
 * Three clauses, all metadata, all required:
 * ① `parentSession === ownerSessionId` — a worker is a child of the panel's own session, so a
 *    session another owner ran can never be this node's executor even if it looks like one;
 * ② the id is the `mission-xxxxxxxx` claim shape — the plugin's own workers are ids it minted, and
 *    an ordinary subagent of the same owner must not be read (or opened) as an executor;
 * ③ `createdAt` inside the node's window — the session has to have been created while this node
 *    could have been running.
 *
 * A malformed/absent `createdAt` on a record makes it fail clause ③ rather than pass it: the id
 * would otherwise be a guess.
 */
function candidatesFor(
  listed: readonly ListedSession[],
  ownerSessionId: string,
  window: { from: number; to: number },
): readonly { id: string; createdAt: number }[] {
  const candidates: { id: string; createdAt: number }[] = []
  for (const record of listed) {
    const header = record.header
    if (header === null || typeof header !== 'object') continue
    const id = typeof header.id === 'string' ? header.id : ''
    if (!WORKER_ID.test(id)) continue
    if (header.parentSession !== ownerSessionId) continue
    const createdAt = header.createdAt
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue
    if (createdAt < window.from || createdAt > window.to) continue
    candidates.push({ id, createdAt })
  }
  // Newest first, so the read budget is spent on the most recent attempts — the same "only the last
  // one counts" rule the persisted handle follows.
  return candidates.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * What one candidate's log read answered. Three shapes rather than a boolean because "the log says
 * this is not the session" and "the log could not be read at all" are different facts, and reading
 * the second as the first is exactly how W20's total outage passed as "not found".
 */
type SessionProbe =
  | { readonly kind: 'hit' }
  | { readonly kind: 'miss' }
  | { readonly kind: 'unreadable'; readonly error: string }

/**
 * Does this session's log say it ran `nodeId`?
 *
 * The worker prompt's `本任务` block always opens with `id: <nodeId>` (`core/src/prompt.ts`'s
 * `currentNodeBlock`), and it reaches the session as its first user message, so the question is
 * asked of the session's own semantic text. The filter is the harness's (it knows how to extract
 * text from each event type, and it can scan without materializing a whole log in this plugin); the
 * regex after it is this module's own `id: <nodeId>` check, so a text filter that merely came CLOSE
 * cannot make the answer wrong.
 *
 * The clauses are the REAL object union (`{kind:'time',from,to}` / `{kind:'text',text}`); see
 * {@link SessionEventFilter}.
 */
async function sessionRanNode(
  query: SessionQueryLike,
  sessionId: string,
  nodeId: string,
  window: { from: number; to: number },
  warn: (message: string) => void,
): Promise<SessionProbe> {
  const pattern = new RegExp(`(?:^|\\n)id: ${nodeId}(?:\\n|$)`, 'u')
  // A service that cannot filter events at all fails EVERY candidate the same way. Reported through
  // the same one-line sink as a rejected filter, and returned as `unreadable` so the caller's total
  // outage is distinguishable from "no session matched".
  if (typeof query.filterEvents !== 'function') {
    const error = '会话查询服务不支持按事件过滤（filterEvents）'
    warn(`executor session lookup: filtering ${sessionId} failed — ${error}; trying the rest`)
    return { kind: 'unreadable', error }
  }
  try {
    const hits = await query.filterEvents(sessionId, [
      { kind: 'time', from: window.from, to: window.to },
      { kind: 'text', text: `id: ${nodeId}` },
    ])
    return hits.some((hit) => pattern.test(hit.text)) ? { kind: 'hit' } : { kind: 'miss' }
  } catch (cause) {
    // One unreadable log (a session-store migration refusing an old file, a race with a cleanup)
    // must not fail the whole lookup — the other candidates are still worth asking. It must not
    // vanish either: a rejected filter SHAPE fails on every candidate and reads as "not found", so
    // the first failure is reported once per lookup (the caller bounds it), session id included —
    // and the caller turns an ALL-failed lookup into `unsupported` rather than `not-found`.
    const error = oneLine(cause)
    warn(`executor session lookup: filtering ${sessionId} failed — ${error}; trying the rest`)
    return { kind: 'unreadable', error }
  }
}

/** A one-line, length-capped reason for a failed log read: a host error must not become a paragraph. */
function oneLine(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const text = raw.replace(/\s+/gu, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

/**
 * Resolve one node's executor session from stored sessions, or say why not.
 *
 * Order of the answer: a node whose `attempts` is 0 is `never-dispatched` (nothing ever ran it, so
 * there is nothing to look for — and the panel must be able to say that instead of "it may have
 * been cleaned up"); a host without `sessionQuery` is `unsupported` (a real deployment can be
 * headless, and the panel must say so instead of crashing); otherwise the filtered candidates are
 * read newest-first until one matches or the budget is spent.
 *
 * A spent budget with no match splits in two, and the split is the point: if at least ONE candidate
 * was read successfully, the honest reading is `not-found` ("it was dispatched once, and the session
 * is gone now"); if EVERY candidate we read failed, nothing was actually searched and the answer is
 * `unsupported` carrying the first reason — a broken filter shape or a dead backend must never be
 * dressed up as "the session was cleaned up" (W20).
 */
export async function resolveExecutorSession(
  nodeId: string,
  options: ResolveExecutorSessionOptions,
): Promise<ExecutorSessionResolution> {
  if (nodeId === '') return { status: 'not-found' }
  if (options.node.attempts === 0) return { status: 'never-dispatched' }
  const window = searchWindow(options.node, options.now)
  const query = options.query
  if (query === undefined || typeof query.listSessions !== 'function') {
    return { status: 'unsupported', error: '宿主没有挂载会话查询服务（sessionQuery），无法查找执行者会话' }
  }

  let listed: readonly ListedSession[]
  try {
    listed = await query.listSessions()
  } catch (cause) {
    return {
      status: 'unsupported',
      error: `读取会话列表失败：${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }

  const candidates = candidatesFor(listed, options.ownerSessionId, window)
  // At most ONE warn per lookup: a shape error fails on every candidate, and one line per candidate
  // would turn a single defect into a wall of noise (the read budget bounds it, but still).
  let warned = false
  const warnOnce = (message: string): void => {
    if (warned) return
    warned = true
    options.warn?.(message)
  }
  let read = 0
  let unreadable = 0
  let firstFailure: string | undefined
  for (const candidate of candidates) {
    if (read >= RESOLVE_READ_BUDGET) break
    read += 1
    const probe = await sessionRanNode(query, candidate.id, nodeId, window, warnOnce)
    if (probe.kind === 'hit') {
      return { status: 'resolved', sessionId: candidate.id, candidatesRead: read }
    }
    if (probe.kind === 'unreadable') {
      unreadable += 1
      firstFailure ??= probe.error
    }
  }
  // "None of the logs could be read" is not "no log matched": the first failure is carried so the
  // panel can say what actually went wrong instead of guessing at a cleanup.
  if (read > 0 && unreadable === read && firstFailure !== undefined) {
    return {
      status: 'unsupported',
      error: `无法读取任何候选会话的日志（${String(unreadable)} 条都失败）：${firstFailure}`,
    }
  }
  return { status: 'not-found' }
}
