/**
 * The 「任务」 tab's running marker — the one fact this plugin must know while its OWN tab is not on
 * screen.
 *
 * WHY THIS IS NOT A VIEW EFFECT. The panel's refresh loop (stream / timer / keepalive) lives in
 * `MissionTreeView`'s effect, and `conversation.view` renders exactly ONE occupant at a time: leaving
 * the 任务 tab stops every read. A marker fed from the view would only be right while the reader is
 * already looking at the thing it exists to announce. So the read below is owned by the plugin BODY:
 * it polls the same `snapshot` the panel reads, for the session the host is showing, and the tab's
 * `label` thunk reads its verdict.
 *
 * FAILURE SAFETY. The marker's only value is that it can be trusted, so every uncertain state says
 * "not running": the Remote namespace not mounted, no current session, a read that threw, and the
 * time before the FIRST read settles. A false 「执行中」 is worse than no marker at all.
 *
 * ONE MORE DUTY. A verdict the host never re-projects is not on screen: the label is resolved into
 * the host's snapshot store only when the `conversation.view` registry changes. So a FLIP is
 * announced (see {@link MissionStatusDeps.onRunningChange}) and the caller re-arms its seat; reading
 * the same verdict again announces nothing. A flip can still be MISSED (a failed read, a client half
 * not yet mounted, two flips inside one poll window), so while the verdict stays `running` the signal
 * also re-arms at most once per {@link TAB_STATUS_REARM_MS} ({@link MissionStatusDeps.onRearm}) —
 * bounded on purpose, so the poll never becomes a registration storm.
 *
 * @module @avantf/dsh-mission/client/status
 */
import {
  STREAM_KEEPALIVE_MS,
  fetchSnapshot,
  startPolling,
  type IntervalTimer,
  type MissionRemote,
} from './api.js'
import type { MissionSnapshot, MissionTreeViewData } from './contract.js'

/**
 * The glyph in front of the marker. A plain geometric shape (U+25CF) on purpose: this machine's font
 * set has no emoji face (`fc-list` finds 0 of 56), so `🟢` would paint a tofu box. Named so the whole
 * feature can be re-glyphed in one place.
 */
export const RUNNING_MARKER = '●'

/**
 * The tab's polling cadence: the same 30 s the panel's stream keepalive uses — a backstop, not a busy
 * poll. The label is only re-read when the host projects it, so reading more often buys nothing.
 */
export const TAB_STATUS_POLL_MS = STREAM_KEEPALIVE_MS

/**
 * The BOUNDED self-heal window: while the verdict is `running`, the seat is re-registered at most once
 * per this many milliseconds, so a projection the host never picked up is corrected within ~2 minutes
 * without turning the poll into a registration pump. Deliberately an integer multiple of
 * {@link TAB_STATUS_POLL_MS}: the heal rides the existing poll ticks (one timer, no extra interval, so
 * a host with timers sees the same single poll it always did) and fires on every
 * `TAB_STATUS_REARM_MS / TAB_STATUS_POLL_MS`-th running tick.
 */
export const TAB_STATUS_REARM_MS = TAB_STATUS_POLL_MS * 4

/** Compose the tab label: the base text exactly as before, plus one space and the marker while running. */
export function missionTabLabel(base: string, running: boolean): string {
  return running ? `${base} ${RUNNING_MARKER}` : base
}

/**
 * The verdict one snapshot read yields. Pure, and deliberately pessimistic: only a settled,
 * error-free snapshot with at least one `running` node may raise the marker.
 */
export function snapshotHasRunning(state: {
  readonly data?: MissionSnapshot
  readonly loading?: boolean
  readonly error?: string
}): boolean {
  if (state.error !== undefined) return false
  if (state.loading === true) return false
  const trees = state.data?.trees
  // `Array.isArray` both guards a malformed payload and narrows to `any[]`; the cast restores the
  // declared shape so the walk below stays typed.
  if (!Array.isArray(trees)) return false
  return (trees as readonly MissionTreeViewData[]).some((tree) => tree.nodes.some((node) => node.status === 'running'))
}

/**
 * The main-view session id out of the client's session list, read structurally: the host owns that
 * shape and this half must not take a host client-types dependency. Absent / blank / malformed
 * answers `undefined`, which the signal treats as "no marker".
 */
export function mainSessionId(list: unknown): string | undefined {
  const byId = (list as { byId?: unknown } | null | undefined)?.byId
  if (byId === null || typeof byId !== 'object') return undefined
  for (const row of Object.values(byId as Record<string, unknown>)) {
    if (row === null || typeof row !== 'object') continue
    const record = row as { id?: unknown; retainedBy?: { mainView?: unknown } }
    const mainView = record.retainedBy?.mainView
    if (typeof mainView === 'number' && mainView > 0 && typeof record.id === 'string') return record.id
  }
  return undefined
}

/**
 * The session the reader is LOOKING AT, out of the client's `uiSession` service (`@deepseek-ai/
 * dsh-client-ui-session`).
 *
 * WHY THIS IS THE PRIMARY ANSWER. The host's tab strip is ONE global list: `viewTabs()` walks
 * `slots.entries("conversation.view")` with no session filter, so this plugin's single `label` thunk
 * answers for every conversation at once. The marker must therefore speak for the CURRENTLY SELECTED
 * session — and the host's own projection says which one that is
 * (`dsh-client-ui-session/lib/client.js`, `publishMain()`): `this.current.value.key` first, and only
 * when that is absent does it scan the catalog for a main-view-retained row. {@link mainSessionId}
 * copies only that fallback, so on a host with several open conversations it answers "the first one"
 * while the reader may be in another — the cross-session leak this reader exists to remove.
 *
 * Read structurally (this half takes no host client-types dependency) and from whichever shape the
 * service publishes: the live host exposes `current.value.key` together with a `current.getSnapshot()`
 * snapshot accessor. Both are tried, first hit wins. Absent / blank / malformed / throwing answers
 * `undefined`, which the caller turns into the catalog fallback — never an exception.
 */
export function selectedSessionId(uiSession: unknown): string | undefined {
  try {
    if (uiSession === null || uiSession === undefined) return undefined
    const current = (uiSession as { current?: unknown }).current
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    const source = current as { getSnapshot?: unknown; value?: unknown }
    const candidates: unknown[] = []
    if (typeof source.getSnapshot === 'function') {
      // A snapshot accessor that throws is a malformed service, not a dead end: the `value` form below
      // is still tried before giving up.
      try { candidates.push((source.getSnapshot as () => unknown)()) } catch { /* try `value` */ }
    }
    candidates.push(source.value)
    for (const binding of candidates) {
      const key = binding !== null && typeof binding === 'object'
        ? (binding as { key?: unknown }).key
        : undefined
      if (typeof key === 'string' && key !== '') return key
    }
    return undefined
  } catch {
    // A hostile/differently-shaped service is a fact, not a failure: the caller falls back.
    return undefined
  }
}

/**
 * Subscribe to the selected-session changes of the `uiSession` service, so a session SWITCH re-arms
 * the seat immediately instead of waiting for the next verdict flip.
 *
 * WHY A SWITCH NEEDS IT. The host re-projects the tab label only when the `conversation.view`
 * registry changes, the locale changes or the config changes — switching sessions is none of those
 * (`docs/TAB_STATUS_INDICATOR_FIX.md` §1). Without this, the label for the newly selected session would
 * stay at the old session's value until the 30 s poll happens to flip something.
 *
 * Only the `current` store's own `subscribe` is used; a host that publishes no store returns
 * `undefined` and the caller keeps its poll. Neither subscribing nor the returned disposer throws,
 * and the wrapped listener cannot throw into the host's notify loop. The callback only READS the
 * verdict (through `rearmSeat`), so the re-registration it triggers cannot feed back into the store.
 */
export function subscribeSessionSwitch(uiSession: unknown, listener: () => void): (() => void) | undefined {
  try {
    if (uiSession === null || uiSession === undefined) return undefined
    const current = (uiSession as { current?: unknown }).current
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    const subscribe = (current as { subscribe?: unknown }).subscribe
    if (typeof subscribe !== 'function') return undefined
    const dispose = (subscribe as (listener: () => void) => unknown).call(current, () => {
      try {
        listener()
      } catch {
        // The host's `notifySubscribers` would log this; the marker must never break the switch itself.
      }
    })
    return typeof dispose === 'function' ? (dispose as () => void) : (): void => undefined
  } catch {
    return undefined
  }
}

/** The body-level verdict the tab's label thunk reads. */
export interface MissionStatusSignal {
  /** True only while the last settled read saw a running node. */
  isRunning(): boolean
  /** Read once now (the initial read is issued at creation). */
  refresh(): Promise<void>
  /** Stop polling and freeze the verdict; idempotent, and late reads stop writing. */
  dispose(): void
}

/** Everything the signal needs, as callbacks because the Remote namespace mounts asynchronously. */
export interface MissionStatusDeps {
  readonly getRemote: () => MissionRemote | undefined
  /** Resolves once the Remote contribution is mounted, so no read races the namespace. */
  readonly mounted: Promise<void>
  /** The session the host is showing, or `undefined` when there is none yet. */
  readonly getSessionId: () => string | undefined
  /** The platform timer, looked up at use time (a host with none falls back to browser timers). */
  readonly getTimer: () => Partial<IntervalTimer> | undefined
  readonly log: (level: 'log' | 'error', message: string) => void
  /**
   * Called when the verdict FLIPS — never for a repeated read of the same value.
   *
   * WHY THE CONSUMER NEEDS IT. The host resolves this tab's label into a snapshot store when the
   * `conversation.view` registry changes, and only then (`docs/TAB_STATUS_INDICATOR_FIX.md` §1): a
   * verdict that flips without touching the registry never reaches the screen. The caller re-arms its
   * seat registration here; the flip-only contract is what keeps that from becoming a poll (and from
   * looping back into this signal, which `read` never does).
   *
   * A `true → false` flip counts, including the pessimistic one a failed read produces: the marker
   * must disappear from the tab too, so "the read broke" is not an excuse to leave it up.
   */
  readonly onRunningChange?: (running: boolean) => void
  /**
   * Called for the BOUNDED self-heal, i.e. at most once per {@link TAB_STATUS_REARM_MS} while the
   * verdict stays `running`; never while idle and never per poll tick.
   *
   * WHY IT IS NEEDED IN ADDITION TO THE FLIP. A flip can be missed (a read failed, the client half
   * was not mounted yet, two flips compressed into one poll window), and then the label the host
   * projected is simply wrong with nobody to correct it — the "the dot vanished for a while and came
   * back on its own" the user saw. Re-registering the seat once per heal window makes the host
   * re-project the CURRENT verdict, so a missed flip self-corrects within ~2 minutes.
   */
  readonly onRearm?: () => void
}

/**
 * Own the "is any mission running" read for the plugin's lifetime.
 *
 * `refresh` is exposed so a caller that already knows the tree changed can ask immediately; the poll
 * is the backstop that keeps the verdict right with no view mounted. Nothing here may reject: a
 * failed read is reported as "not running" and logged, never as an unhandled rejection.
 */
export function createMissionStatusSignal(deps: MissionStatusDeps): MissionStatusSignal {
  let running = false
  let disposed = false
  /** Running poll ticks since the last self-heal; reset whenever the verdict is not running. */
  let ticksWhileRunning = 0
  const REARM_EVERY_TICKS = Math.max(1, Math.round(TAB_STATUS_REARM_MS / TAB_STATUS_POLL_MS))

  /**
   * The ONE writer of the verdict. It exists so every path — a settled read, a failed read, an
   * unmounted Remote — reports the same way and a flip is announced exactly once.
   *
   * It can never throw: `read` is invoked fire-and-forget, and an escaping error would surface as an
   * unhandled rejection in the host (the family's "environment faults degrade, never kill the host"
   * rule). A failing listener is logged; the verdict itself is already recorded.
   */
  const setRunning = (next: boolean): void => {
    if (next === running) return
    running = next
    if (deps.onRunningChange === undefined) return
    try {
      deps.onRunningChange(next)
    } catch (cause) {
      try {
        deps.log(
          'error',
          `tab running indicator: reacting to the flipped marker failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      } catch {
        // Logging must not escape either.
      }
    }
  }

  const read = async (): Promise<void> => {
    if (disposed) return
    try {
      await deps.mounted
      if (disposed) return
      const remote = deps.getRemote()
      const sessionId = deps.getSessionId()
      if (remote === undefined || sessionId === undefined) {
        setRunning(false)
        return
      }
      const snapshot = await fetchSnapshot(remote, sessionId)
      if (disposed) return
      setRunning(snapshotHasRunning({ data: snapshot }))
    } catch (cause) {
      if (disposed) return
      setRunning(false)
      try {
        deps.log(
          'error',
          `tab running indicator: reading the mission tree failed (no marker shown): ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      } catch {
        // Logging must never turn "the read failed" into an unhandled rejection.
      }
    }
  }

  /**
   * The BOUNDED self-heal: re-announce the current verdict so the host re-projects it. At most once
   * per {@link TAB_STATUS_REARM_MS} because it is driven by {@link tick} on entire heal windows, and
   * never while disposed or idle. A failing listener is logged, never propagated (this runs from a
   * timer callback, where an escaping error would be an unhandled one).
   */
  const rearm = (): void => {
    if (disposed || deps.onRearm === undefined) return
    try {
      deps.onRearm()
    } catch (cause) {
      try {
        deps.log(
          'error',
          `tab running indicator: the bounded self-heal re-registration failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      } catch {
        // Logging must not escape either.
      }
    }
  }

  /**
   * One poll tick: re-read, then — only if the read left the verdict `running` — count the tick
   * towards the heal window. The count resets on every non-running tick (including the idle and
   * failed reads), so the heal can never fire on a tick that landed in idle, and an idle session
   * never re-registers. Counting TICKS rather than reading a clock keeps the heal on the poll's own
   * single interval: no second timer, and the cadence is whatever `TAB_STATUS_POLL_MS` means on this
   * host.
   */
  const tick = async (): Promise<void> => {
    await read()
    if (disposed || !running) {
      ticksWhileRunning = 0
      return
    }
    ticksWhileRunning += 1
    if (ticksWhileRunning < REARM_EVERY_TICKS) return
    ticksWhileRunning = 0
    rearm()
  }

  const stopPolling = startPolling(() => { void tick() }, TAB_STATUS_POLL_MS, deps.getTimer())
  void read()

  return {
    isRunning: (): boolean => running,
    refresh: read,
    dispose: (): void => {
      if (disposed) return
      disposed = true
      stopPolling()
    },
  }
}
