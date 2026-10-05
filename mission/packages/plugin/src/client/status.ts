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
 * the same verdict again announces nothing, which is what keeps the re-registration finite.
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

  const stopPolling = startPolling(() => { void read() }, TAB_STATUS_POLL_MS, deps.getTimer())
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
