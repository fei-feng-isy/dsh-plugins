/**
 * `@avantf/dsh-mission` — the browser half: one `conversation.view` tab ("任务") rendering
 * this session's mission trees. Inject `remote`, never `remote.avantfMission` (a namespace only
 * exists after its own contribution mounts, and boot's `assertEntriesActive` throws on an
 * entry waiting for a missing service); the hand-written contribution is mounted here.
 * @module @avantf/dsh-mission/client
 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { clientContribution } from '../wire.js'
import { MissionTreeView } from './MissionTreeView.js'
import {
  POLL_INTERVAL_MS,
  REFRESH_COALESCE_MS,
  STREAM_KEEPALIVE_MS,
  STREAM_REOPEN_MS,
  cleanFinishedWork,
  coalesce,
  deleteWork,
  fetchDetail,
  fetchExecutorSession,
  fetchFullResult,
  fetchSnapshot,
  sessionRevision,
  startPolling,
  watchChanges,
  type IntervalTimer,
  type MissionRemote,
} from './api.js'
import type { MissionSnapshot, MissionSnapshotState, WorkerSessionTarget } from './contract.js'
import { isRunning, queuedCount, type SeatSessionView } from './seat.js'
/** Cordis plugin name; matches the host half. */
export const name = 'avantf-mission'

/** Required client services; the Remote namespace itself is intentionally absent (see above). */
export const inject = ['remote', 'slots', 'locale']

const NS = 'avantf-mission'

/** Prefix on every browser-console line, matching the host half's log. */
const LOG_PREFIX = '[avantf-mission]'

/** Tab label, both locales; the deployment here is Chinese-only. */
const zh = { 'view.missions': '任务' }
const en = { 'view.missions': 'Works' }

/**
 * The slice of the client Context this half uses, declared structurally: an installed dsh
 * ships no `ui-slots` package (the browser shell seeds it into the module table), so the
 * seat's real types are not resolvable from what the running host shares.
 */
interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): void
  logger: { error(message: string): void }
  locale: {
    register(namespace: string, dictionaries: Record<'zh' | 'en', Record<string, string>>): () => void
    bind(namespace: string): (key: string) => string
  }
  remote: { $mount(contribution: unknown): Promise<() => Promise<void>> }
  get(name: string): unknown
  slots: {
    inject(name: string, register: () => void): void
    register(
      options: { name: string; id: string; order: number; locale: string; label: () => string },
      component: (props: { sessionId: SessionId }) => ReactNode,
    ): void
  }
}

/**
 * Structural for the same reason as {@link ClientContext}; only the session's own "something
 * happened" values matter. The seat's CHAT hook is deliberately not declared any more: the mission
 * tree is not a function of how many messages the conversation holds, and subscribing to it made
 * every chat activity re-read and re-render the whole tree (see `sessionRevision`).
 */
interface SeatProps {
  readonly sessionId: SessionId
  readonly useSession: <T>(select: (session: SeatSessionView) => T) => T
}

/**
 * The host's OPTIONAL workspace-navigation service, read structurally for the same reason as
 * {@link ClientContext} — and deliberately NOT in `inject`.
 *
 * Injecting `uiWorkspace` would make a host without it refuse to load this half at all; the panel is
 * perfectly usable without the jump (the engine pushes its changes, it does not need navigation), so
 * the service is fetched with `ctx.get` and merely removes a link when absent. Only the one method
 * this half uses is declared, and the target is the STRUCTURAL {@link WorkerSessionTarget} rather
 * than the host's `SessionTarget`: the browser bundle must not depend on a host client-types package.
 */
interface UiWorkspaceLike {
  openSession(target: WorkerSessionTarget): void
}

/**
 * What the snapshot hook needs from the plugin body, as an object because most fields are
 * getters: the Remote namespace mounts asynchronously, so resolving it at the first render
 * would freeze the hook on "not available yet".
 */
interface SnapshotDeps {
  readonly sessionId: string
  /** Read the namespace fresh on every use — it appears after the mount settles. */
  readonly getRemote: () => MissionRemote | undefined
  /** Resolves once the contribution is mounted, so no read races the namespace. */
  readonly mounted: Promise<void>
  /** Timer fallback, used only when the host exposes no change stream. */
  readonly schedule: (refresh: () => void) => () => void
  /** Slow unconditional re-read while the change stream is up, so a silently dead stream cannot leave
   *  the panel stale forever (see `STREAM_KEEPALIVE_MS`). */
  readonly keepalive: (refresh: () => void) => () => void
  readonly revision: string
  readonly log: (level: 'log' | 'error', message: string) => void
  /** Record the host's reported `wire` revision (see `wire.ts`), so a later click can refuse to call
   *  a method that host never registered. Must be stable across renders — it is a `refresh` dep. */
  readonly noteWire: (wire: number | undefined) => void
}

/** Which mechanism is currently keeping the view fresh. */
type RefreshLink = 'pending' | 'stream' | 'timer'

/**
 * Build the snapshot hook the view consumes. Refresh is ENGINE-DRIVEN: `watch` yields one
 * frame per change and each frame re-reads the tree; nothing is guessed from the session
 * log. Two backstops remain — the cheap session-side revision, and a slow timer used ONLY
 * when the host exposes no `watch`, a choice that is logged because getting it wrong looks
 * like "the refresh feature was never built".
 */
function useSnapshotFor(deps: SnapshotDeps): MissionSnapshotState {
  const { sessionId, getRemote, mounted, schedule, keepalive, revision, log, noteWire } = deps
  const [data, setData] = useState<MissionSnapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [link, setLink] = useState<RefreshLink>('pending')
  const firstRender = useRef(true)

  // Reads can overlap — a stream frame lands while the previous read is still in flight — and without
  // this the OLDER response can land last and overwrite the newer snapshot, leaving the panel stale
  // until the next change. Every read takes a ticket; only the newest ticket may write.
  const readSeq = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    // Never race the mount: a read before the namespace exists would report a
    // failure that is really just "not yet".
    await mounted
    const remote = getRemote()
    if (remote === undefined) {
      setError('任务树 Remote 未挂载：本插件自带的 typert contribution 挂载失败（详见控制台）。')
      return
    }
    const seq = ++readSeq.current
    setLoading(true)
    try {
      const next = await fetchSnapshot(remote, sessionId)
      if (seq !== readSeq.current) return
      // Remember WHICH host this is before rendering its trees: a click on a node from this snapshot
      // may need a remote the host is too old to have, and the revision is how that is known.
      noteWire(next.wire)
      setData(next)
      setError(undefined)
    } catch (cause) {
      if (seq !== readSeq.current) return
      setError(`读取任务树失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (seq === readSeq.current) setLoading(false)
    }
  }, [mounted, getRemote, sessionId, noteWire])

  // ONE coalescer for every trigger (session revision, stream frames, stream reopen). It used to be
  // wired to the revision path only, while the change stream called `refresh()` per frame — and the
  // engine pushes a frame per state change, so a burst became one snapshot RPC per frame.
  const coalescer = useMemo(() => coalesce(() => { void refresh() }, REFRESH_COALESCE_MS), [refresh])
  const requestRefresh = coalescer.request
  useEffect(() => coalescer.cancel, [coalescer])

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      void refresh()
      return undefined
    }
    requestRefresh()
  }, [refresh, revision, requestRefresh])

  // The engine's change stream: opened once per mounted panel, reopened if the link changes.
  useEffect(() => {
    const controller = new AbortController()
    let live = true
    let reopen: ReturnType<typeof setTimeout> | undefined
    void (async (): Promise<void> => {
      await mounted
      const remote = getRemote()
      if (!live) return
      if (remote === undefined || typeof remote.watch !== 'function') {
        setLink('timer')
        return
      }
      setLink('stream')
      // A healthy stream delivers its opening frame immediately, so "nothing arrived"
      // is how an unusable stream is told apart from a quiet one.
      let barren = 0
      const run = async (): Promise<void> => {
        let frames = 0
        try {
          await watchChanges(remote, sessionId, controller.signal, () => {
            frames += 1
            requestRefresh()
          })
        } catch (cause) {
          // A broken stream is a transport fact: the session revision and the next reopen
          // cover it, and the snapshot read itself reports any real failure.
          log('error', `change stream ended with an error: ${String(cause)}`)
        }
        if (!live) return
        barren = frames === 0 ? barren + 1 : 0
        if (barren >= 2) {
          log('error', 'change stream delivered nothing twice; falling back to the refresh timer')
          setLink('timer')
          return
        }
        // Ended without an abort, i.e. the connection generation changed: frames may have
        // been missed while it was down, so re-read once, then reopen.
        requestRefresh()
        reopen = setTimeout(() => { void run() }, STREAM_REOPEN_MS)
      }
      void run()
    })()
    return () => {
      live = false
      controller.abort()
      if (reopen !== undefined) clearTimeout(reopen)
    }
  }, [mounted, getRemote, sessionId, requestRefresh])

  // Timer fallback only; its disposer belongs to the effect, so leaving the tab stops it.
  useEffect(() => {
    if (link !== 'timer') return undefined
    return schedule(() => { void refresh() })
  }, [link, schedule, refresh])

  // The keepalive runs in EVERY link state, including a healthy-looking stream: it is the only bound
  // on "the stream is open but has stopped delivering". Cheap by construction (one read per 30 s).
  useEffect(() => keepalive(() => { void refresh() }), [keepalive, refresh])

  return { data, loading, error, refresh }
}

/** Client plugin body: mount this package's Remote face, register the tab. */
export function apply(ctx: ClientContext): void {
  // The browser console: where anyone diagnosing a missing tab looks first.
  const log = (level: 'log' | 'error', message: string): void => {
    console[level](`${LOG_PREFIX} ${message}`)
    try {
      if (level === 'error') ctx.logger.error(`${LOG_PREFIX} ${message}`)
    } catch {
      // A logging failure must not break the mount it is describing.
    }
  }
  log('log', 'client half mounting: conversation.view seat + avantfMission Remote namespace')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'avantf-mission: dictionaries')

  // Mounted asynchronously, so the tab is registered regardless: a failed mount must show
  // an explanatory view, not a missing tab, and must never fail the web boot.
  const state: { remote?: MissionRemote; wire?: number } = {}
  /** Stable across renders on purpose: it is a dependency of the snapshot hook's memoized `refresh`. */
  const noteWire = (wire: number | undefined): void => { state.wire = wire }
  // The view waits on this instead of racing the mount; settled on failure too, so a broken
  // mount surfaces as the view's error rather than as a panel that loads forever.
  const mounted = ((): { promise: Promise<void>; settle: () => void } => {
    let settle = (): void => {}
    const promise = new Promise<void>((resolve) => { settle = resolve })
    return { promise, settle }
  })()
  void ctx.remote
    .$mount(clientContribution as never)
    .then(() => {
      state.remote = ctx.get(`remote.${'avantfMission'}`) as MissionRemote | undefined
      if (state.remote === undefined) {
        log('error', 'contribution mounted but ctx.get("remote.avantfMission") is undefined; the view will report it')
      } else {
        log('log', 'Remote namespace mounted: the 任务 view can read the tree')
      }
      mounted.settle()
    })
    .catch((cause: unknown) => {
      log('error', `mounting the Remote contribution failed: ${String(cause)}`)
      mounted.settle()
    })

  const t = ctx.locale.bind(NS)

  // ── the refresh triggers ─────────────────────────────────────────────────
  // Primary: the engine's change stream; secondary: the session revision; tertiary, only
  // when the host exposes no stream, a timer. The platform `timer` service is a
  // host-composition row and is not mounted here, so the lookup happens at USE time.
  const schedule = (refresh: () => void): (() => void) =>
    startPolling(refresh, POLL_INTERVAL_MS, ctx.get('timer') as Partial<IntervalTimer> | undefined)
  // The unconditional stream keepalive: the same platform-timer lookup, at a much slower cadence.
  const keepalive = (refresh: () => void): (() => void) =>
    startPolling(refresh, STREAM_KEEPALIVE_MS, ctx.get('timer') as Partial<IntervalTimer> | undefined)
  const hasHostTimers = typeof setInterval === 'function' && typeof clearInterval === 'function'
  log(
    'log',
    ctx.get('timer') !== undefined
      ? `auto-refresh: engine change stream, platform timer fallback (${String(POLL_INTERVAL_MS)} ms)`
      : hasHostTimers
        ? `auto-refresh: engine change stream, browser timer fallback (${String(POLL_INTERVAL_MS)} ms)`
        : 'auto-refresh: engine change stream + session events only',
  )

  const getRemote = (): MissionRemote | undefined => state.remote

  /**
   * The optional navigation service, resolved on EVERY render rather than cached at apply time:
   * cordis reports a service as absent until its own fiber is active, and this half deliberately
   * does not declare `uiWorkspace` in `inject` (a host without it must still mount the panel), so a
   * late-mounted service would otherwise be missed forever. Absent at render time ⇒ the view renders
   * the worker id as plain text; the miss costs a link, never the panel.
   */
  const uiWorkspace = (): UiWorkspaceLike | undefined => {
    const service = ctx.get('uiWorkspace') as Partial<UiWorkspaceLike> | undefined
    return service !== undefined && typeof service.openSession === 'function'
      ? service as UiWorkspaceLike
      : undefined
  }

  // The seat's session hooks are the refresh trigger (see `sessionRevision`). The seat's chat hook is
  // deliberately NOT read any more: folding the chat node count into the revision made every message
  // re-read and re-render the whole tree, and the mission tree is not a function of chat length. The
  // stream carries mission changes, and the keepalive bounds staleness if it goes quiet.
  //
  // Every field is read through `seat.ts`, never off the snapshot directly: these are the HOST's
  // structures, and a selector that throws in the render body blanks the whole panel silently
  // (dsh 0.1.6 dropped `queue` — see that file). `seat.spec.ts` pins the rule.
  function useSeatRevision(seat: SeatProps): string {
    const queued = seat.useSession((session) => queuedCount(session))
    const running = seat.useSession((session) => isRunning(session))
    return sessionRevision({ queued, running })
  }

  const View = (props: { sessionId: SessionId }): ReactNode => {
    const seat = props as unknown as SeatProps
    const revision = useSeatRevision(seat)
    // Read per render: the service may appear after this plugin applies (see `uiWorkspace`).
    const workspace = uiWorkspace()

    return h(MissionTreeView, {
      useSnapshot: () => useSnapshotFor({
        sessionId: props.sessionId,
        getRemote,
        mounted: mounted.promise,
        schedule,
        keepalive,
        revision,
        log,
        noteWire,
      }),
      onDeleteTree: async (rootId: string): Promise<void> => {
        const remote = getRemote()
        if (remote === undefined) throw new Error('任务树 Remote 未挂载')
        await deleteWork(remote, props.sessionId, rootId)
      },
      // The batch entry. Gated on the host's reported `wire` INSIDE `cleanFinishedWork`: an older
      // host never registered the method, so sending the call would only earn a gateway 404 that
      // reads like "the missions are gone".
      onCleanFinished: async (): Promise<{ deleted: readonly string[]; skipped: readonly string[] }> => {
        const remote = getRemote()
        if (remote === undefined) throw new Error('任务树 Remote 未挂载')
        return await cleanFinishedWork(remote, props.sessionId, state.wire)
      },
      loadDetail: async (nodeId: string) => {
        const remote = getRemote()
        if (remote === undefined) throw new Error('任务树 Remote 未挂载')
        return await fetchDetail(remote, props.sessionId, nodeId)
      },
      loadResult: async (nodeId: string) => {
        const remote = getRemote()
        if (remote === undefined) throw new Error('任务树 Remote 未挂载')
        return await fetchFullResult(remote, props.sessionId, nodeId)
      },
      // The owner session is the PARENT of every worker session the panel links to.
      sessionId: props.sessionId,
      // W18: the lazy lookup behind a click on a node whose record has no handle yet. It is a
      // Remote call (the host lists sessions and reads a few logs), so it is handed over as a
      // function and NEVER invoked here — the view calls it from the click only. The `wire` the last
      // snapshot reported goes WITH it: a host too old to have registered the method must not be
      // called at all (the gateway's 404 for it reads like a missing mission).
      resolveWorkerSession: async (nodeId: string) => {
        const remote = getRemote()
        if (remote === undefined) throw new Error('任务树 Remote 未挂载')
        return await fetchExecutorSession(remote, props.sessionId, nodeId, state.wire)
      },
      ...workspace === undefined
        ? {}
        : { openWorkerSession: (target: WorkerSessionTarget): void => { workspace.openSession(target) } },
    })
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'missions',
    // After 对话 (0) and 轨迹 (10).
    order: 20,
    locale: NS,
    label: () => t('view.missions'),
  }, View))
  log('log', 'registered the conversation.view seat: id=missions order=20')
}
