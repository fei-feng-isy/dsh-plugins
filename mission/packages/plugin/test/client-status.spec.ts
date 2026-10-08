/**
 * The 「任务」 tab's running marker: the glyph rules, the verdict rule, and the BODY-LEVEL signal the
 * label thunk reads.
 *
 * These are pure/unit tests on purpose. What they CAN pin is the decision logic and the lifecycle
 * (idle reads verbatim `任务`, a running node adds exactly the named glyph, every failure mode shows
 * nothing, and a disposed signal stops writing). What they CANNOT pin is that a browser paints `●`
 * or that the host re-projects the tab label when the verdict flips — that is a browser fact, called
 * out in the task report rather than dressed up as a test.
 */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.js'
import { STREAM_KEEPALIVE_MS, type MissionRemote } from '../src/client/api.js'
import type { MissionNodeView, MissionSnapshot } from '../src/client/contract.js'
import {
  RUNNING_MARKER,
  TAB_STATUS_POLL_MS,
  TAB_STATUS_REARM_MS,
  createMissionStatusSignal,
  mainSessionId,
  missionTabLabel,
  selectedSessionId,
  snapshotHasRunning,
  subscribeSessionSwitch,
  type MissionStatusDeps,
} from '../src/client/status.js'

/** One node in the wire shape; only `status` matters to the verdict. */
function node(status: string, id = 'r1'): MissionNodeView {
  return {
    id, parentId: null, children: [], depth: 1, title: 'Ship it',
    context: [], corrections: [], status, attempts: 1, createdAt: 1,
    hasResult: false, resultRef: null, workerSessionId: null,
    dispatchedAt: null, endedAt: null,
  }
}

/** One tree holding the given node statuses. */
function snapshot(...statuses: readonly string[]): MissionSnapshot {
  return {
    trees: [{
      rootId: 'r1',
      closedAt: null,
      nodes: statuses.map((status, index) => node(status, `n${String(index)}`)),
    }],
  }
}

/**
 * A Remote whose ONE honest method is `snapshot`. The other members exist because the real
 * {@link MissionRemote} declares them (a fake that omits them would let a shape change hide), and
 * they throw so a suite that starts calling them is told rather than silently served `undefined`.
 */
function remoteWith(snapshot: MissionRemote['snapshot']): MissionRemote {
  const unused = (): never => { throw new Error('this suite only reads the snapshot') }
  return { snapshot, detail: unused, delete: unused }
}

/** A platform timer that records its interval and its disposer instead of scheduling anything. */
function fakeTimer(): {
  service: { interval: (callback: () => void, delay: number) => () => void }
  intervals: { callback: () => void; delay: number }[]
  disposed: () => number
} {
  const intervals: { callback: () => void; delay: number }[] = []
  let disposals = 0
  return {
    service: {
      interval: (callback, delay) => {
        intervals.push({ callback, delay })
        return () => { disposals += 1 }
      },
    },
    intervals,
    disposed: () => disposals,
  }
}

describe('the running marker glyph', () => {
  it('prints the idle label VERBATIM — no marker, no trailing space', () => {
    expect(missionTabLabel('任务', false)).toBe('任务')
    expect(missionTabLabel('任务', false)).not.toContain(RUNNING_MARKER)
    expect(missionTabLabel('任务', false)).not.toMatch(/\s$/u)
  })

  it('appends exactly one space and the one named glyph while running', () => {
    expect(missionTabLabel('任务', true)).toBe(`任务 ${RUNNING_MARKER}`)
    // The glyph is the plain geometric shape (U+25CF), not an emoji: this machine has no emoji font.
    expect(RUNNING_MARKER).toBe('●')
    expect(RUNNING_MARKER.codePointAt(0)).toBe(0x25cf)
  })
})

describe('deciding whether anything is running', () => {
  it('is true when any node in any tree is running', () => {
    expect(snapshotHasRunning({ data: snapshot('done', 'running') })).toBe(true)
    expect(snapshotHasRunning({
      data: {
        trees: [
          { rootId: 'a', closedAt: null, nodes: [node('done', 'a')] },
          { rootId: 'b', closedAt: null, nodes: [node('running', 'b')] },
        ],
      },
    })).toBe(true)
  })

  it('is false for a settled or queued tree', () => {
    expect(snapshotHasRunning({ data: snapshot('done', 'ready', 'blocked', 'failed', 'interrupted') })).toBe(false)
    expect(snapshotHasRunning({ data: { trees: [] } })).toBe(false)
  })

  it('is false for every uncertain state, so a false 执行中 is impossible', () => {
    // No read has settled yet.
    expect(snapshotHasRunning({})).toBe(false)
    expect(snapshotHasRunning({ loading: true })).toBe(false)
    // A read that failed proves nothing about the tree.
    expect(snapshotHasRunning({ data: snapshot('running'), error: '读取任务树失败：boom' })).toBe(false)
    // A still-loading read must not raise the marker even if a stale snapshot is in hand.
    expect(snapshotHasRunning({ data: snapshot('running'), loading: true })).toBe(false)
    // A malformed payload (older/newer host) is not a running tree either.
    expect(snapshotHasRunning({ data: {} as MissionSnapshot })).toBe(false)
  })
})

describe('reading which session the marker speaks for', () => {
  it('takes the session the host retains for the main view', () => {
    expect(mainSessionId({
      byId: {
        'worker-1': { id: 'worker-1', retainedBy: { mainView: 0, sidebar: 1 } },
        'owner-1': { id: 'owner-1', retainedBy: { mainView: 1 } },
      },
    })).toBe('owner-1')
  })

  it('answers undefined for an absent, blank or malformed catalog', () => {
    expect(mainSessionId(undefined)).toBeUndefined()
    expect(mainSessionId({ byId: {} })).toBeUndefined()
    expect(mainSessionId({ byId: { 'owner-1': { retainedBy: { mainView: 0 } } } })).toBeUndefined()
    expect(mainSessionId({ byId: { 'owner-1': { id: 42, retainedBy: { mainView: 1 } } } })).toBeUndefined()
    expect(mainSessionId('nonsense')).toBeUndefined()
  })
})

/**
 * The PRIMARY session answer: the client `uiSession` service's current selection. The host's tab
 * strip is global, so a marker that reads "the first main-view-retained session" leaks into every
 * other conversation (see the module docs in `status.ts`).
 */
describe('reading the CURRENTLY SELECTED session out of uiSession', () => {
  /** The live host's shape: one binding source with BOTH `value` and `getSnapshot()`. */
  function bindingSource(key: string | undefined): unknown {
    const value = { key, hooks: {}, keyedHooks: {}, props: {} }
    return { current: { value, getSnapshot: () => value, subscribe: () => () => undefined } }
  }

  it('prefers the current selection, in either published shape', () => {
    // `current.value.key` — what the host's own `publishMain()` reads.
    expect(selectedSessionId({ current: { value: { key: 'looking-at-this' } } })).toBe('looking-at-this')
    // `current.getSnapshot?.().key` — the snapshot accessor form.
    expect(selectedSessionId({ current: { getSnapshot: () => ({ key: 'snap-2' }) } })).toBe('snap-2')
    // Both present (the live host): any hit answers, and the answer is not blank.
    expect(selectedSessionId(bindingSource('both'))).toBe('both')
  })

  it('answers undefined for absent / blank / malformed / hostile services, and never throws', () => {
    expect(selectedSessionId(undefined)).toBeUndefined()
    expect(selectedSessionId({})).toBeUndefined()
    expect(selectedSessionId({ current: undefined })).toBeUndefined()
    // The absent-session binding the host publishes when nothing is selected.
    expect(selectedSessionId({ current: { value: { key: undefined } } })).toBeUndefined()
    expect(selectedSessionId({ current: { value: { key: 42 } } })).toBeUndefined()
    expect(selectedSessionId('nonsense')).toBeUndefined()
    // A throwing `getSnapshot` still falls through to `value`.
    expect(selectedSessionId({
      current: { value: { key: 'from-value' }, getSnapshot: () => { throw new Error('shape mismatch') } },
    })).toBe('from-value')
    // A whole service that throws on access.
    const hostile = new Proxy({}, { get: () => { throw new Error('shape mismatch') } })
    expect(selectedSessionId(hostile)).toBeUndefined()
  })

  it('subscribes to session switches and releases the subscription, and stays undefined without a store', () => {
    let listener: (() => void) | undefined
    let released = 0
    const store = {
      current: {
        value: { key: 'a' },
        subscribe: (next: () => void): (() => void) => {
          listener = next
          return () => { released += 1 }
        },
      },
    }
    let switches = 0
    const dispose = subscribeSessionSwitch(store, () => { switches += 1 })
    expect(typeof dispose).toBe('function')
    listener?.()
    expect(switches).toBe(1)
    dispose?.()
    expect(released).toBe(1)
    // No store / no `subscribe` ⇒ the caller keeps its poll; nothing is returned and nothing throws.
    expect(subscribeSessionSwitch({ current: { value: { key: 'a' } } }, () => undefined)).toBeUndefined()
    expect(subscribeSessionSwitch(undefined, () => undefined)).toBeUndefined()
    const hostile = new Proxy({}, { get: () => { throw new Error('shape mismatch') } })
    expect(subscribeSessionSwitch(hostile, () => undefined)).toBeUndefined()
    // A THROWING listener must not escape into the host's notify loop.
    let throwing: (() => void) | undefined
    subscribeSessionSwitch({
      current: { subscribe: (next: () => void) => { throwing = next; return () => undefined } },
    }, () => { throw new Error('listener down') })
    expect(() => { throwing?.() }).not.toThrow()
  })
})

describe('the body-level status signal', () => {
  /**
   * Deps whose single read answers from `remote` (defaulting to a running tree); `calls` records the
   * session asked for, `errors` the reasons logged. `omitRemote` is the "Remote namespace never
   * mounted" case.
   */
  function deps(options: {
    remote?: MissionRemote
    omitRemote?: boolean
    sessionId?: string | undefined
    mounted?: Promise<void>
    timer?: ReturnType<typeof fakeTimer>
    onRearm?: () => void
  } = {}): { deps: MissionStatusDeps; calls: string[]; errors: string[] } {
    const calls: string[] = []
    const errors: string[] = []
    const remote = options.omitRemote === true
      ? undefined
      : options.remote ?? remoteWith(async (args: { sessionId: string }): Promise<unknown> => {
          calls.push(args.sessionId)
          return { ok: true, value: snapshot('running') }
        })
    return {
      calls,
      errors,
      deps: {
        getRemote: () => remote,
        mounted: options.mounted ?? Promise.resolve(),
        getSessionId: () => ('sessionId' in options ? options.sessionId : 'owner-1'),
        getTimer: () => (options.timer ?? fakeTimer()).service,
        log: (_level, message) => { errors.push(message) },
        ...options.onRearm === undefined ? {} : { onRearm: options.onRearm },
      },
    }
  }

  /** Let one poll tick (which awaits a read) run to completion. */
  const flushTick = async (timer: ReturnType<typeof fakeTimer>): Promise<void> => {
    timer.intervals[0]?.callback()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  }

  it('reports running only after a settled read proves it, and polls no faster than 30 s', async () => {
    const timer = fakeTimer()
    const { deps: d, calls } = deps({ timer })
    const signal = createMissionStatusSignal(d)
    // Before the read settles: silence, never a guess.
    expect(signal.isRunning()).toBe(false)
    await signal.refresh()
    expect(signal.isRunning()).toBe(true)
    // The body-level read names the session the host is showing.
    expect(calls).toContain('owner-1')
    // The poll is the slow keepalive cadence, per the spec's "no more often than 30 s".
    expect(TAB_STATUS_POLL_MS).toBe(STREAM_KEEPALIVE_MS)
    expect(TAB_STATUS_POLL_MS).toBeLessThanOrEqual(30_000)
    expect(timer.intervals).toHaveLength(1)
    expect(timer.intervals[0]?.delay).toBe(TAB_STATUS_POLL_MS)
    signal.dispose()
  })

  it('shows no marker while the Remote namespace is not mounted', async () => {
    const { deps: d, calls } = deps({ omitRemote: true, sessionId: undefined })
    const signal = createMissionStatusSignal(d)
    await signal.refresh()
    expect(signal.isRunning()).toBe(false)
    expect(calls).toEqual([])
    signal.dispose()
  })

  it('shows no marker when the read itself fails, and says so once', async () => {
    const timer = fakeTimer()
    const { deps: d, errors } = deps({ remote: remoteWith((): Promise<unknown> => Promise.reject(new Error('transport down'))), timer })
    const signal = createMissionStatusSignal(d)
    await signal.refresh()
    expect(signal.isRunning()).toBe(false)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.at(-1)).toContain('transport down')
    signal.dispose()
  })

  it('shows no marker for a valid but idle tree — the label stays verbatim 任务', async () => {
    const timer = fakeTimer()
    const idle = remoteWith(async (): Promise<unknown> => ({ ok: true, value: snapshot('done', 'ready') }))
    const { deps: d } = deps({ remote: idle, timer })
    const signal = createMissionStatusSignal(d)
    await signal.refresh()
    expect(signal.isRunning()).toBe(false)
    expect(missionTabLabel('任务', signal.isRunning())).toBe('任务')
    signal.dispose()
  })

  it('stops writing after dispose — a late read cannot raise the marker', async () => {
    const timer = fakeTimer()
    let release: (value: unknown) => void = () => undefined
    const pending = new Promise<unknown>((resolve) => { release = resolve })
    const { deps: d } = deps({ remote: remoteWith((): Promise<unknown> => pending), timer })
    const signal = createMissionStatusSignal(d)
    const inFlight = signal.refresh()
    signal.dispose()
    // The disposer ran: the poll is cancelled and the interval was scheduled at the slow cadence.
    expect(timer.disposed()).toBe(1)
    expect(timer.intervals).toHaveLength(1)
    expect(timer.intervals[0]?.delay).toBe(TAB_STATUS_POLL_MS)
    // Now let the read that was already in flight land with "running" in it.
    release({ ok: true, value: snapshot('running') })
    await inFlight
    expect(signal.isRunning()).toBe(false)
    // Idempotent: a second dispose does not double-release the timer.
    signal.dispose()
    expect(timer.disposed()).toBe(1)
  })

  /**
   * The bounded self-heal (H1): a flip can be MISSED, and then the host's projected label stands
   * wrong with nobody to correct it. While — and only while — the verdict stays `running`, the signal
   * asks for one extra re-registration per {@link TAB_STATUS_REARM_MS}, riding the poll's own ticks.
   * The assertions below are all about BOUNDEDNESS: a per-tick (or per-second) rearm must fail them.
   */
  describe('the bounded self-heal while running', () => {
    const TICKS_PER_WINDOW = Math.round(TAB_STATUS_REARM_MS / TAB_STATUS_POLL_MS)

    it('re-arms at most once per heal window while running, never per poll tick', async () => {
      const timer = fakeTimer()
      let rearms = 0
      const { deps: d } = deps({ timer, onRearm: () => { rearms += 1 } })
      const signal = createMissionStatusSignal(d)
      await signal.refresh()
      expect(signal.isRunning()).toBe(true)
      // Entering running is the FLIP's job (`onRunningChange`), not the self-heal's.
      expect(rearms).toBe(0)
      expect(TICKS_PER_WINDOW).toBeGreaterThan(1)

      // The first window: the last tick of it is the first heal, no earlier.
      for (let tick = 1; tick < TICKS_PER_WINDOW; tick += 1) {
        await flushTick(timer)
        expect(rearms).toBe(0)
      }
      await flushTick(timer)
      expect(rearms).toBe(1)

      // Bounded, not per-tick: a second window buys exactly one more, however many ticks it takes.
      for (let tick = 0; tick < TICKS_PER_WINDOW; tick += 1) await flushTick(timer)
      expect(rearms).toBe(2)
      signal.dispose()
    })

    it('never re-arms while the verdict is idle', async () => {
      const timer = fakeTimer()
      let rearms = 0
      const idle = remoteWith(async (): Promise<unknown> => ({ ok: true, value: snapshot('done', 'ready') }))
      const { deps: d } = deps({ remote: idle, timer, onRearm: () => { rearms += 1 } })
      const signal = createMissionStatusSignal(d)
      await signal.refresh()
      expect(signal.isRunning()).toBe(false)
      for (let tick = 0; tick < TICKS_PER_WINDOW * 2; tick += 1) await flushTick(timer)
      expect(rearms).toBe(0)
      signal.dispose()
    })

    it('stops re-arming once disposed — a late tick cannot resurrect the heal', async () => {
      const timer = fakeTimer()
      let rearms = 0
      const { deps: d } = deps({ timer, onRearm: () => { rearms += 1 } })
      const signal = createMissionStatusSignal(d)
      await signal.refresh()
      expect(signal.isRunning()).toBe(true)
      signal.dispose()
      for (let tick = 0; tick < TICKS_PER_WINDOW * 2; tick += 1) await flushTick(timer)
      expect(rearms).toBe(0)
    })

    it('a failing heal listener is logged, never thrown into the timer callback', async () => {
      const timer = fakeTimer()
      const { deps: d, errors } = deps({
        timer,
        onRearm: () => { throw new Error('rearm down') },
      })
      const signal = createMissionStatusSignal(d)
      await signal.refresh()
      for (let tick = 0; tick < TICKS_PER_WINDOW; tick += 1) await flushTick(timer)
      expect(errors.some((message) => message.includes('rearm down'))).toBe(true)
      signal.dispose()
    })
  })
})

/**
 * The wiring half: `apply` must register a `label` thunk that composes the body-level verdict with
 * the localized base text — and must never call the Remote for a session the host is not showing.
 */
describe('the conversation.view label thunk', () => {
  /** The slice of `apply` that matters here, with every host service answered structurally. */
  function boot(options: {
    snapshot?: MissionRemote['snapshot']
    remote?: MissionRemote
    omitRemote?: boolean
    sessions?: unknown
    timer?: ReturnType<typeof fakeTimer>
    /** The `uiSession` service, or a getter so a suite can make its fiber activate late. */
    uiSession?: unknown
  } = {}): {
    label: () => string | undefined
    projected: () => string | undefined
    calls: string[]
    listenerCalls: () => number
    errors: string[]
    seatDispose: () => void
    unload: () => void
  } {
    const dictionaries: Record<string, { zh: Record<string, string> }> = {}
    const errors: string[] = []
    const disposers: (() => void)[] = []
    /**
     * The registry traffic, as the host would see it: `register#N` / `dispose#N` in order. Two host
     * behaviours are mirrored because the whole fix rests on them — `register` returns a disposer and
     * `inject` runs its callback inside `ctx.effect` (so the returned disposer IS the seat's teardown),
     * and EVERY registry change notifies `subscribe("conversation.view", …)` listeners, which is what
     * makes the host re-resolve the label (`docs/TAB_STATUS_INDICATOR_FIX.md` §1).
     */
    const calls: string[] = []
    const listeners = new Set<() => void>()
    let listenerCalls = 0
    let registered: { label?: () => string } | undefined
    let projected: string | undefined
    let seatDispose: (() => void) | undefined
    let seatSerial = 0
    const notify = (): void => { for (const listener of listeners) listener() }
    const slots = {
      inject: (_name: string, register: () => (() => void) | void): void => {
        const dispose = register()
        if (typeof dispose === 'function') {
          seatDispose = dispose
          disposers.push(dispose)
        }
      },
      register: (registeredOptions: { label?: () => string }): (() => void) => {
        seatSerial += 1
        const serial = seatSerial
        calls.push(`register#${String(serial)}`)
        registered = registeredOptions
        notify()
        let live = true
        return () => {
          if (!live) return
          live = false
          calls.push(`dispose#${String(serial)}`)
          // The entry is GONE from the registry now, exactly as the host's `entries()` would report.
          registered = undefined
          notify()
        }
      },
      subscribe: (_name: string, listener: () => void): (() => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    // The HOST's own wiring, installed at boot: re-resolve the tab label on every registry change.
    // `projected()` is therefore what the tab would show right now, without the test reading it.
    slots.subscribe('conversation.view', () => {
      listenerCalls += 1
      projected = registered?.label?.()
    })
    const timer = options.timer ?? fakeTimer()
    const remote = options.omitRemote === true
      ? undefined
      : options.remote ?? remoteWith(options.snapshot ?? (async (): Promise<unknown> => ({ ok: true, value: snapshot('done') })))
    const ctx = {
      effect: (callback: () => (() => void) | void): void => {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
      logger: { error: (message: string): void => { errors.push(message) } },
      locale: {
        register: (namespace: string, dict: { zh: Record<string, string> }): (() => void) => {
          dictionaries[namespace] = dict
          return () => undefined
        },
        bind: (namespace: string) => (key: string): string => dictionaries[namespace]?.zh[key] ?? key,
      },
      remote: { $mount: (): Promise<() => Promise<void>> => Promise.resolve(() => Promise.resolve()) },
      get: (name: string): unknown => {
        if (name === 'remote.avantfMission') return remote
        if (name === 'timer') return timer.service
        if (name === 'sessions') return options.sessions
        if (name === 'uiSession') {
          return typeof options.uiSession === 'function' ? (options.uiSession as () => unknown)() : options.uiSession
        }
        return undefined
      },
      slots,
    }
    apply(ctx as unknown as Parameters<typeof apply>[0])
    return {
      label: () => registered?.label?.(),
      projected: () => projected,
      calls,
      listenerCalls: () => listenerCalls,
      errors,
      seatDispose: () => { seatDispose?.() },
      unload: () => { for (const dispose of disposers.splice(0)) dispose() },
    }
  }

  /** Let the mount `.then` and the first snapshot read settle. */
  const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

  const MAIN = { list: { getSnapshot: () => ({ byId: { 'owner-1': { id: 'owner-1', retainedBy: { mainView: 1 } } } }) } }

  it('reads 任务 while the tree is idle', async () => {
    const booted = boot({ sessions: MAIN })
    await settle()
    expect(booted.label()).toBe('任务')
    booted.unload()
  })

  it('reads 任务 ● while a mission is running', async () => {
    const booted = boot({
      sessions: MAIN,
      snapshot: async (): Promise<unknown> => ({ ok: true, value: snapshot('running') }),
    })
    await settle()
    expect(booted.label()).toBe(`任务 ${RUNNING_MARKER}`)
    booted.unload()
  })

  it('reads 任务 when no session is selected, and never asks the Remote', async () => {
    let asked = 0
    const booted = boot({
      sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
      snapshot: (): Promise<unknown> => { asked += 1; return Promise.resolve({ ok: true, value: snapshot('running') }) },
    })
    await settle()
    expect(booted.label()).toBe('任务')
    expect(asked).toBe(0)
    booted.unload()
  })

  /**
   * A `uiSession` store in the live host's shape: one `current` binding source with `value`,
   * `getSnapshot()` and `subscribe`, plus a test-side `push` that notifies exactly like the host's
   * `notifySubscribers(this.current.listeners, …)` does on a real session switch.
   */
  function fakeUiSession(initial: string | undefined): {
    service: unknown
    push: (key: string | undefined) => void
    listenerCount: () => number
  } {
    let key = initial
    const listeners = new Set<() => void>()
    return {
      service: {
        current: {
          get value(): { key: string | undefined } { return { key } },
          getSnapshot: (): { key: string | undefined } => ({ key }),
          subscribe: (listener: () => void): (() => void) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
      },
      push: (next: string | undefined): void => {
        key = next
        for (const listener of [...listeners]) listener()
      },
      listenerCount: (): number => listeners.size,
    }
  }

  /** The heuristic this suite's catalog would answer (owner-1) is a RUNNING session on purpose. */
  const runningOwner = async (args: { sessionId: string }): Promise<unknown> =>
    ({ ok: true, value: snapshot(args.sessionId === 'owner-1' ? 'running' : 'done') })

  it('① marks the CURRENTLY SELECTED session, even when another retained session is running too', async () => {
    const store = fakeUiSession('owner-1')
    const booted = boot({ sessions: MAIN, uiSession: store.service, snapshot: runningOwner })
    await settle()
    expect(booted.label()).toBe(`任务 ${RUNNING_MARKER}`)
    booted.unload()
  })

  it('② shows 任务 VERBATIM when the current session is idle although ANOTHER session runs', async () => {
    const store = fakeUiSession('user-b')
    const asked: string[] = []
    const booted = boot({
      // `MAIN` would answer owner-1 (running); only the current selection may win.
      sessions: MAIN,
      uiSession: store.service,
      snapshot: async (args: { sessionId: string }): Promise<unknown> => {
        asked.push(args.sessionId)
        return runningOwner(args)
      },
    })
    await settle()
    expect(booted.label()).toBe('任务')
    expect(booted.label()).not.toContain(RUNNING_MARKER)
    expect(asked).toContain('user-b')
    expect(asked).not.toContain('owner-1')
    booted.unload()
  })

  it('③ re-registers the seat EXACTLY once when the selected session changes', async () => {
    const store = fakeUiSession('user-a')
    const booted = boot({ sessions: MAIN, uiSession: store.service })
    await settle()
    expect(booted.calls).toEqual(['register#1'])
    store.push('user-b')
    expect(booted.calls).toEqual(['register#1', 'dispose#1', 'register#2'])
    // The host's notify loop is not pumped further by one switch.
    expect(booted.calls).toHaveLength(3)
    // Unloading releases the subscription: a later push cannot resurrect the seat.
    booted.unload()
    expect(store.listenerCount()).toBe(0)
    store.push('user-c')
    // Only the unload's own seat teardown follows: the push after it registered nothing.
    expect(booted.calls).toEqual(['register#1', 'dispose#1', 'register#2', 'dispose#2'])
  })

  it('subscribes to a uiSession service whose fiber activates only after apply', async () => {
    const store = fakeUiSession('user-a')
    let service: unknown
    const timer = fakeTimer()
    const booted = boot({ sessions: MAIN, timer, uiSession: () => service })
    await settle()
    // Not there at apply time ⇒ the poll is the only trigger, and no subscription exists yet.
    expect(store.listenerCount()).toBe(0)
    expect(booted.calls).toEqual(['register#1'])
    // The service's fiber activates; the next body-level read attaches the subscription.
    service = store.service
    timer.intervals[0]?.callback()
    await settle()
    expect(store.listenerCount()).toBe(1)
    store.push('user-b')
    expect(booted.calls).toEqual(['register#1', 'dispose#1', 'register#2'])
    // Still exactly one subscription, however many reads retried the attach.
    timer.intervals[0]?.callback()
    await settle()
    expect(store.listenerCount()).toBe(1)
    booted.unload()
    expect(store.listenerCount()).toBe(0)
  })

  it('re-reads for the newly selected session on a switch, so the marker follows it', async () => {
    const store = fakeUiSession('user-a')
    const booted = boot({
      sessions: MAIN,
      uiSession: store.service,
      snapshot: async (args: { sessionId: string }): Promise<unknown> =>
        ({ ok: true, value: snapshot(args.sessionId === 'user-b' ? 'running' : 'done') }),
    })
    await settle()
    expect(booted.label()).toBe('任务')
    store.push('user-b')
    await settle()
    // The fresh read flips the verdict and reaches the host; the display follows the selection.
    expect(booted.label()).toBe(`任务 ${RUNNING_MARKER}`)
    store.push('user-a')
    await settle()
    expect(booted.label()).toBe('任务')
    booted.unload()
  })

  it('⑤ falls back to the catalog heuristic, without throwing, when uiSession is absent or hostile', async () => {
    // Absent: the catalog (owner-1) still answers.
    const absent = boot({ sessions: MAIN, snapshot: runningOwner })
    await settle()
    expect(absent.label()).toBe(`任务 ${RUNNING_MARKER}`)
    absent.unload()

    // A service that throws on every access, and one with no store: no throw, heuristic fallback.
    for (const hostile of [
      new Proxy({}, { get: () => { throw new Error('shape mismatch') } }),
      { current: { value: { key: undefined } } },
      { current: { value: 'nonsense' } },
    ]) {
      const booted = boot({ sessions: MAIN, uiSession: hostile, snapshot: runningOwner })
      await settle()
      expect(booted.label()).toBe(`任务 ${RUNNING_MARKER}`)
      expect(booted.errors).toEqual([])
      booted.unload()
    }
  })

    /**
     * The half the FIRST delivery missed: a verdict the host never re-projects is not on screen. The
     * host re-resolves the tab label only when the `conversation.view` registry changes
     * (`docs/TAB_STATUS_INDICATOR_FIX.md` §1), so a flipped marker must dispose + re-register the seat —
     * and must do it ONLY on a flip, or the poll would turn into a registration storm.
     *
     * The fake `slots` above mirrors the two host mechanisms these tests rest on (a disposer-returning
     * `register` run through `inject`, and a `subscribe` notification on every registry change), so the
     * assertions are about host behaviour, not about "we called register".
     */
    describe('re-projecting the label when the running verdict flips', () => {

    it('flips with exactly one dispose/re-register pair, and the host subscription re-projects the label', async () => {
      let running = false
      const timer = fakeTimer()
      const booted = boot({
        sessions: MAIN,
        timer,
        snapshot: async (): Promise<unknown> => ({ ok: true, value: snapshot(running ? 'running' : 'done') }),
      })
      await settle()
      // ④ idle: the label is the base text VERBATIM, and the registry has been touched once (the mount).
      expect(booted.label()).toBe('任务')
      expect(booted.projected()).toBe('任务')
      expect(booted.calls).toEqual(['register#1'])

      // The mission starts: the next poll settles the flipped verdict.
      running = true
      timer.intervals[0]?.callback()
      await settle()
      expect(booted.label()).toBe(`任务 ${RUNNING_MARKER}`)
      // ① EXACTLY one re-registration — one dispose and one register, in that order.
      expect(booted.calls).toEqual(['register#1', 'dispose#1', 'register#2'])
      // ⑤ the host's `subscribe` listener ran on the registry change, and what it resolved is the NEW
      // label — i.e. the host's `refreshViews()` put 「任务 ●」 into the snapshot store.
      expect(booted.projected()).toBe(`任务 ${RUNNING_MARKER}`)
      booted.unload()
    })

    it('re-reads the same verdict without touching the registry again (no loop)', async () => {
      const timer = fakeTimer()
      const booted = boot({
        sessions: MAIN,
        timer,
        snapshot: async (): Promise<unknown> => ({ ok: true, value: snapshot('running') }),
      })
      await settle()
      // The first settled read already flipped false → true: exactly one pair, once.
      expect(booted.calls).toEqual(['register#1', 'dispose#1', 'register#2'])
      const listenerCalls = booted.listenerCalls()
      const projected = booted.projected()
      for (let tick = 0; tick < 3; tick += 1) {
        timer.intervals[0]?.callback()
        await settle()
      }
      // ② zero extra registry traffic, zero extra listener calls: the poll is not a registration pump.
      expect(booted.calls).toEqual(['register#1', 'dispose#1', 'register#2'])
      expect(booted.listenerCalls()).toBe(listenerCalls)
      expect(booted.projected()).toBe(projected)
      booted.unload()
    })

    it('stops re-registering once the seat is torn down, so a late flip cannot resurrect it', async () => {
      let running = false
      const timer = fakeTimer()
      const booted = boot({
        sessions: MAIN,
        timer,
        snapshot: async (): Promise<unknown> => ({ ok: true, value: snapshot(running ? 'running' : 'done') }),
      })
      await settle()
      expect(booted.calls).toEqual(['register#1'])
      // The disposer the inject callback returned IS the seat's teardown (the host holds it via ctx.effect).
      booted.seatDispose()
      expect(booted.calls).toEqual(['register#1', 'dispose#1'])

      // ③ the verdict flips after the seat is gone: the signal announces it, nobody re-registers.
      running = true
      timer.intervals[0]?.callback()
      await settle()
      expect(booted.calls).toEqual(['register#1', 'dispose#1'])
      booted.unload()
    })

    it('a full unload disposes the seat and the poll together — a late tick changes nothing', async () => {
      let running = false
      const timer = fakeTimer()
      const booted = boot({
        sessions: MAIN,
        timer,
        snapshot: async (): Promise<unknown> => ({ ok: true, value: snapshot(running ? 'running' : 'done') }),
      })
      await settle()
      booted.unload()
      expect(booted.calls).toEqual(['register#1', 'dispose#1'])
      expect(timer.disposed()).toBe(1)
      running = true
      timer.intervals[0]?.callback()
      await settle()
      expect(booted.calls).toEqual(['register#1', 'dispose#1'])
    })

    it('keeps the marker OFF, and the registry untouched, while the read is failing', async () => {
      const timer = fakeTimer()
      const booted = boot({
        sessions: MAIN,
        timer,
        remote: remoteWith((): Promise<unknown> => Promise.reject(new Error('transport down'))),
      })
      await settle()
      // A failed read proves nothing about the tree: no marker, and no flip to announce (it was idle).
      expect(booted.label()).toBe('任务')
      expect(booted.calls).toEqual(['register#1'])
      timer.intervals[0]?.callback()
      await settle()
      expect(booted.calls).toEqual(['register#1'])
      expect(booted.errors.some((message) => message.includes('transport down'))).toBe(true)
      booted.unload()
    })

    it('shows no marker, and touches the registry only at mount, while the Remote namespace is absent', async () => {
      const timer = fakeTimer()
      const booted = boot({ sessions: MAIN, timer, omitRemote: true })
      await settle()
      expect(booted.label()).toBe('任务')
      expect(booted.calls).toEqual(['register#1'])
      // Still nothing to announce on a later tick: an unmounted Remote is "not running", not a flip.
      timer.intervals[0]?.callback()
      await settle()
      expect(booted.calls).toEqual(['register#1'])
      booted.unload()
    })

    it('clears a raised marker with one more pair when a running read starts failing', async () => {
      let failing = false
      const timer = fakeTimer()
      const booted = boot({
        sessions: MAIN,
        timer,
        snapshot: async (): Promise<unknown> => {
          if (failing) throw new Error('transport down')
          return { ok: true, value: snapshot('running') }
        },
      })
      await settle()
      expect(booted.label()).toBe(`任务 ${RUNNING_MARKER}`)
      expect(booted.calls).toEqual(['register#1', 'dispose#1', 'register#2'])

      // The evidence is gone, so the marker must go too — that IS a flip (true → false), and the tab
      // needs one registry change to hear about it. Further failures are NOT further flips.
      failing = true
      timer.intervals[0]?.callback()
      await settle()
      expect(booted.label()).toBe('任务')
      expect(booted.projected()).toBe('任务')
      expect(booted.calls).toEqual(['register#1', 'dispose#1', 'register#2', 'dispose#2', 'register#3'])
      timer.intervals[0]?.callback()
      await settle()
      expect(booted.calls).toEqual(['register#1', 'dispose#1', 'register#2', 'dispose#2', 'register#3'])
      booted.unload()
    })
  })
})
