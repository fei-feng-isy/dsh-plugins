/**
 * The client half's data path: envelope peeling, the reason a refusal carries, and
 * the poll timer.
 *
 * No DOM and no renderer here on purpose — that edge is where a wiring mistake
 * costs the most and is hardest to see in a browser.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  POLL_INTERVAL_MS,
  REFRESH_COALESCE_MS,
  STREAM_REOPEN_MS,
  coalesce,
  deleteWork,
  errorText,
  fetchDetail,
  fetchFullResult,
  fetchSnapshot,
  startPolling,
  watchChanges,
  type WorkRemote,
} from '../src/client/api.js'

/** A Remote stub that records its calls and answers with the given envelope. */
function remoteReturning(answer: unknown, calls: { method: string; args: unknown }[] = []): WorkRemote {
  return {
    snapshot: (args) => {
      calls.push({ method: 'snapshot', args })
      return Promise.resolve(answer)
    },
    detail: (args) => {
      calls.push({ method: 'detail', args })
      return Promise.resolve(answer)
    },
    delete: (args) => {
      calls.push({ method: 'delete', args })
      return Promise.resolve(answer)
    },
    result: (args) => {
      calls.push({ method: 'result', args })
      return Promise.resolve(answer)
    },
  }
}

describe('fetchSnapshot', () => {
  it('peels the success envelope and passes the session through', async () => {
    const calls: { method: string; args: unknown }[] = []
    const remote = remoteReturning({ ok: true, value: { trees: [{ rootId: 'r1', nodes: [], closedAt: null }] } }, calls)

    const snapshot = await fetchSnapshot(remote, 'session-1')
    expect(snapshot.trees[0]?.rootId).toBe('r1')
    expect(calls).toEqual([{ method: 'snapshot', args: { sessionId: 'session-1' } }])
  })

  it('reports a carrier failure instead of rendering an empty view', async () => {
    const remote = remoteReturning({ ok: false, error: 'remote namespace missing' })
    await expect(fetchSnapshot(remote, 'session-1')).rejects.toThrow('remote namespace missing')
  })

  it('rejects a payload it cannot recognise', async () => {
    const remote = remoteReturning({ ok: true, value: { nope: true } })
    await expect(fetchSnapshot(remote, 'session-1')).rejects.toThrow('无法识别的数据')
  })
})

describe('the payload boundary', () => {
  /** One row exactly as an OLDER host sends it: no `corrections` (the field this client added). */
  const staleRow = {
    id: 'n1', parentId: null, children: [], depth: 1, title: 'Ship it', context: [],
    status: 'running', attempts: 1, createdAt: 1, hasResult: false, resultRef: null,
  }

  it('turns a row from an older host into ONE readable message, not a render-body TypeError', async () => {
    // The failure this replaces: `node.corrections.length` throws inside the render body, and the
    // shell's slot error boundary renders an empty `<div>` — no text, no retry for the session.
    // Validating here is the difference between "restart dsh web" and a blank panel.
    const remote = remoteReturning({ ok: true, value: { trees: [{ rootId: 'r1', nodes: [staleRow], closedAt: null }] } })
    await expect(fetchSnapshot(remote, 'session-1')).rejects.toThrow('重启 dsh web')
    // And it says WHICH field moved, so the reader is not guessing.
    await expect(fetchSnapshot(remote, 'session-1')).rejects.toThrow('corrections')
  })

  it('does not reject a payload that merely carries MORE than this client knows', async () => {
    // An older CLIENT against a newer host is the same skew from the other side, and zod's object
    // drops unknown keys rather than refusing the payload: a host that adds a field must not break
    // the panel that has not learned it yet.
    const remote = remoteReturning({
      ok: true,
      value: {
        trees: [{
          rootId: 'r1',
          closedAt: null,
          nodes: [{ ...staleRow, corrections: [], somethingNew: true }],
        }],
      },
    })
    await expect(fetchSnapshot(remote, 'session-1')).resolves.toMatchObject({ trees: [{ rootId: 'r1' }] })
  })

  it('checks the detail payload the same way', async () => {
    // Same window, second door: `detailTabs` dereferences several node fields directly.
    const remote = remoteReturning({
      ok: true,
      value: { node: { id: 'n2', rootId: 'r1', title: 't', description: 'd', context: [] }, children: [] },
    })
    await expect(fetchDetail(remote, 'session-1', 'n2')).rejects.toThrow('无法识别的数据')
  })
})

describe('deleteWork', () => {
  it('sends the TREE root id and returns what went away', async () => {
    // The unit of deletion is the whole tree, so the argument is its root — never a
    // node inside it.
    const calls: { method: string; args: unknown }[] = []
    const remote = remoteReturning({ ok: true, value: { deleted: ['r1', 'n1', 'n2'] } }, calls)

    expect(await deleteWork(remote, 'session-1', 'r1')).toEqual(['r1', 'n1', 'n2'])
    expect(calls).toEqual([{ method: 'delete', args: { sessionId: 'session-1', rootId: 'r1' } }])
  })

  it('turns a refusal into a readable reason', async () => {
    // A refusal is an answer, not a transport failure: the row shows it verbatim.
    const remote = remoteReturning({
      ok: true,
      value: { deleted: [], error: 'tree r1 is running; only a finished tree can be deleted' },
    })
    await expect(deleteWork(remote, 'session-1', 'r1')).rejects.toThrow('only a finished tree')
  })
})

describe('startPolling', () => {
  it('prefers the platform timer service, at the configured interval', () => {
    const refresh = vi.fn()
    const timers: { callback: () => void; delay: number }[] = []
    const dispose = startPolling(refresh, POLL_INTERVAL_MS, {
      interval: (callback, delay) => {
        timers.push({ callback, delay })
        return () => undefined
      },
    }, {})

    expect(timers).toEqual([{ callback: expect.any(Function), delay: POLL_INTERVAL_MS }])
    timers[0]?.callback()
    expect(refresh).toHaveBeenCalledTimes(1)
    // The disposer is the timer's own, so leaving the tab stops the polling.
    expect(typeof dispose).toBe('function')
  })

  it('falls back to the browser timers when no service is mounted', () => {
    // This deployment's browser side mounts no `timer` service at all, so without
    // this rung the panel would simply never refresh — which looks exactly like the
    // feature was never built.
    const refresh = vi.fn()
    const cleared: unknown[] = []
    const handle = { id: 1 }
    const dispose = startPolling(refresh, POLL_INTERVAL_MS, undefined, {
      setInterval: () => handle,
      clearInterval: (value) => { cleared.push(value) },
    })

    dispose()
    expect(cleared).toEqual([handle])
  })

  it('degrades to no polling where neither is available', () => {
    const refresh = vi.fn()
    const dispose = startPolling(refresh, POLL_INTERVAL_MS, undefined, {})
    expect(refresh).not.toHaveBeenCalled()
    expect(dispose()).toBeUndefined()
  })
})

describe('fetchDetail', () => {
  it('reads one node, and passes the node id through', async () => {
    const calls: { method: string; args: unknown }[] = []
    const remote = remoteReturning({
      ok: true,
      value: {
        node: {
          id: 'n2', rootId: 'r1', title: '子工作', description: '做一件事', context: ['因为'],
          corrections: [], analysisNotes: [], analysisAttempt: 0,
          status: 'done', attempts: 1, depth: 1, result: '做完了', resultPointer: null,
        },
        children: [{ id: 'n3', title: '孙工作', status: 'done', result: '也做完了', resultPointer: null }],
      },
    }, calls)

    const detail = await fetchDetail(remote, 'session-1', 'n2')
    expect(detail.node.title).toBe('子工作')
    expect(detail.children).toHaveLength(1)
    expect(calls).toEqual([{ method: 'detail', args: { sessionId: 'session-1', nodeId: 'n2' } }])
  })

  it('turns a refusal (another session\'s tree) into a readable reason', async () => {
    const remote = remoteReturning({ ok: true, value: { children: [], error: 'this tree belongs to another session' } })
    await expect(fetchDetail(remote, 'session-1', 'n2')).rejects.toThrow('another session')
  })

  it('rejects a payload with no node instead of rendering a blank panel', async () => {
    const remote = remoteReturning({ ok: true, value: { children: [] } })
    await expect(fetchDetail(remote, 'session-1', 'n2')).rejects.toThrow('没有可显示的详情')
  })
})

describe('fetchFullResult', () => {
  it('reads the text and passes the node id through', async () => {
    const calls: { method: string; args: unknown }[] = []
    const remote = remoteReturning({ ok: true, value: { text: 'the whole thing' } }, calls)
    await expect(fetchFullResult(remote, 'session-1', 'n2')).resolves.toBe('the whole thing')
    expect(calls).toEqual([{ method: 'result', args: { sessionId: 'session-1', nodeId: 'n2' } }])
  })

  it('turns the host\'s reason into an exception, rather than showing an empty result', async () => {
    // "The locator is not a file this host can read" is an answer, and the pane shows it beside the
    // locator — an empty string here would read as "the result is empty".
    const remote = remoteReturning({ ok: true, value: { text: '', error: '不在本机文件系统上（spill://abc）' } })
    await expect(fetchFullResult(remote, 'session-1', 'n2')).rejects.toThrow('不在本机文件系统上')
  })

  it('says a host without the call does not support it', async () => {
    const { result: _omitted, ...withoutResult } = remoteReturning({ ok: true, value: { text: 'x' } })
    await expect(fetchFullResult(withoutResult, 'session-1', 'n2')).rejects.toThrow('没有 result 调用')
  })

  it('rejects a payload it cannot recognise', async () => {
    const remote = remoteReturning({ ok: true, value: { nope: true } })
    await expect(fetchFullResult(remote, 'session-1', 'n2')).rejects.toThrow('无法识别的数据')
  })

  it('names a 404 as a stale HOST process, not as a missing result', async () => {
    // The two halves update separately: this bundle is re-read on every page load, the host half is
    // loaded once when `dsh web` starts. A rebuilt plugin therefore talks to an older host, whose
    // gateway answers an unknown method with 404 — and "404" reads like "the work or the file is
    // gone", which is the one thing it does not mean. (Reported from a real run.)
    const stale: WorkRemote = {
      ...remoteReturning({ ok: true, value: { text: 'x' } }),
      result: () => Promise.reject(new Error(
        'client api: avantfWork/result failed: transport failure for /api/avantfWork/result: HTTP 404',
      )),
    }
    await expect(fetchFullResult(stale, 'session-1', 'n2')).rejects.toThrow('重启 dsh web')
  })

  it('passes an unrelated transport failure through unchanged', async () => {
    const broken: WorkRemote = {
      ...remoteReturning({ ok: true, value: { text: 'x' } }),
      result: () => Promise.reject(new Error('socket closed while reading')),
    }
    await expect(fetchFullResult(broken, 'session-1', 'n2')).rejects.toThrow('socket closed while reading')
  })
})

describe('watchChanges', () => {
  /** A Remote whose `watch` yields the given frames, recording its arguments. */
  function watchingRemote(frames: unknown[], seen: { args?: unknown; signal?: AbortSignal } = {}): WorkRemote {
    return {
      ...remoteReturning({ ok: true, value: { trees: [] } }),
      watch: (args, signal) => {
        seen.args = args
        seen.signal = signal
        return (async function* () {
          for (const frame of frames) {
            if (signal.aborted) return
            yield frame
          }
        })()
      },
    }
  }

  it('calls back once per frame and passes the session through', async () => {
    const seen: { args?: unknown; signal?: AbortSignal } = {}
    const onChange = vi.fn()
    await watchChanges(watchingRemote([{ revision: 1 }, { revision: 2 }], seen), 'session-1',
      new AbortController().signal, onChange)

    expect(onChange).toHaveBeenCalledTimes(2)
    expect(seen.args).toEqual({ sessionId: 'session-1' })
  })

  it('stops at the signal, so an unmounted panel cannot keep reading', async () => {
    const controller = new AbortController()
    const onChange = vi.fn(() => { controller.abort() })
    await watchChanges(watchingRemote([{ revision: 1 }, { revision: 2 }]), 'session-1', controller.signal, onChange)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('resolves immediately against a host that exposes no stream', async () => {
    // The fallback contract: no `watch` means "return at once", never "hang", so the
    // caller can decide to keep its timer.
    const bare = remoteReturning({ ok: true, value: { trees: [] } })
    const onChange = vi.fn()
    await expect(watchChanges(bare, 'session-1', new AbortController().signal, onChange)).resolves.toBeUndefined()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps the reopen delay short enough to look live', () => {
    expect(STREAM_REOPEN_MS).toBeLessThanOrEqual(5_000)
  })
})

describe('errorText', () => {
  it('keeps the message of an Error-shaped failure, which JSON.stringify would drop', () => {
    // `RemoteError extends Error`: `message` is NOT an own enumerable property, so the old
    // `JSON.stringify(error)` fallback rendered `{"code":"…"}` and threw away the one sentence the
    // reader needs.
    const remoteError = Object.assign(new Error('工作 r1 正在执行；只有已结束的树才能删除'), { code: 'tree-running' })
    expect(errorText(remoteError)).toBe('工作 r1 正在执行；只有已结束的树才能删除')
    expect(JSON.stringify(remoteError)).not.toContain('正在执行')
    // A plain object with a message is just as good.
    expect(errorText({ message: 'boom', code: 'x' })).toBe('boom')
  })

  it('falls back to the JSON (then to String) when there is no message', () => {
    expect(errorText({ code: 'x', details: [1] })).toBe('{"code":"x","details":[1]}')
    expect(errorText(undefined)).toBe('undefined')
    expect(errorText('plain')).toBe('plain')
  })
})

describe('coalesce', () => {
  it('collapses a burst into one call, and cancels a pending one', () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const coalescer = coalesce(() => { calls += 1 }, REFRESH_COALESCE_MS)
      // The engine pushes a frame per state change: ten frames must not mean ten snapshot reads.
      for (let i = 0; i < 10; i += 1) coalescer.request()
      expect(calls).toBe(0)
      vi.advanceTimersByTime(REFRESH_COALESCE_MS)
      expect(calls).toBe(1)
      // A second burst after the quiet period is a second call, not a third.
      coalescer.request()
      vi.advanceTimersByTime(REFRESH_COALESCE_MS)
      expect(calls).toBe(2)
      // Cancelled before the delay: never fires (this is the unmount disposer).
      coalescer.request()
      coalescer.cancel()
      vi.advanceTimersByTime(REFRESH_COALESCE_MS * 2)
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
