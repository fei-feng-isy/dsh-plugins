/**
 * The default control-plane lock at `<home>/.envinit/.lock`.
 * @module lock
 */
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ProvisionError } from './errors.js'
import type { Disposable, ProvisionLock } from './types.js'

interface LockHolder {
  readonly pid: number
  readonly startedAt: number
}

/** What a waiter observed when it refused to reclaim a lock whose holder is still alive. */
export interface SlowHoldInfo {
  readonly path: string
  readonly pid: number
  readonly startedAt: number
  /** How old the lock file's mtime already is — the value that crossed `staleMs`. */
  readonly heldMs: number
  readonly staleMs: number
  /** How long this `acquire()` call has been waiting so far. */
  readonly waitedMs: number
}

/** `true` when the pid exists; `EPERM` counts as alive. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

async function readHolder(path: string): Promise<LockHolder | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const pid = record['pid']
    const startedAt = record['startedAt']
    if (typeof pid !== 'number' || typeof startedAt !== 'number') return undefined
    return { pid, startedAt }
  } catch {
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Last warning time per `(path, holder)` pair. The poll loop re-observes the same stale-but-alive
 * holder every `pollMs`, and a caller may retry `acquire` — both would otherwise emit the same line
 * hundreds of times. The window is one `staleMs` (at least 1 s), i.e. the same period the warning is
 * about; the holder identity makes a genuinely new holder warn again immediately.
 */
const slowHoldWarnedAt = new Map<string, number>()
/** Bound on the rate-limit state; a lock home far past this just re-warns once more. */
const SLOW_HOLD_WARN_STATE_LIMIT = 64

function warnSlowHold(onSlowHold: (info: SlowHoldInfo) => void, info: SlowHoldInfo): void {
  const key = `${info.path}\u0000${String(info.pid)}\u0000${String(info.startedAt)}`
  const now = Date.now()
  const last = slowHoldWarnedAt.get(key)
  if (last !== undefined && now - last < Math.max(1_000, info.staleMs)) return
  if (slowHoldWarnedAt.size >= SLOW_HOLD_WARN_STATE_LIMIT) slowHoldWarnedAt.clear()
  slowHoldWarnedAt.set(key, now)
  onSlowHold(info)
}

export interface DefaultLockOptions {
  /** Clock source; defaults to `Date.now`. */
  readonly clock?: () => number
  /** Poll interval while waiting; defaults to 25 ms. */
  readonly pollMs?: number
  /**
   * Called (rate-limited) when a waiter sees a lock whose mtime crossed `staleMs` while its holder
   * pid is still ALIVE — the one case the lock deliberately refuses to reclaim. A long critical
   * section is legal; this is how "the lock contract is being stretched" becomes visible instead of
   * being silently papered over by stealing the lock.
   */
  readonly onSlowHold?: (info: SlowHoldInfo) => void
}

/** The default {@link ProvisionLock}. */
export function defaultLock(options: DefaultLockOptions = {}): ProvisionLock {
  const clock = options.clock ?? Date.now
  const pollMs = options.pollMs ?? 25
  const onSlowHold = options.onSlowHold
  return {
    async acquire(path, { timeoutMs, staleMs }): Promise<Disposable> {
      // Ensure the control-plane directory exists.
      await mkdir(dirname(path), { recursive: true })
      const started = clock()
      const deadline = started + timeoutMs
      for (;;) {
        const mine: LockHolder = { pid: process.pid, startedAt: clock() }
        let handle: Awaited<ReturnType<typeof open>> | undefined
        try {
          handle = await open(path, 'wx')
          await handle.writeFile(JSON.stringify(mine), 'utf8')
          return {
            dispose: () => {
              // Remove the lock only while it is still ours.
              void (async () => {
                const holder = await readHolder(path)
                if (holder?.pid === mine.pid && holder.startedAt === mine.startedAt) {
                  await unlink(path).catch(() => undefined)
                }
              })()
            },
          }
        } catch (error) {
          // The file we just created is OURS even though the write failed. Leaving a zero-byte
          // `.lock` behind is exactly the wedge this function has to recover from, so remove it
          // before rethrowing. Close first: Windows refuses to unlink an open handle.
          if (handle !== undefined) {
            await handle.close().catch(() => undefined)
            handle = undefined
            await unlink(path).catch(() => undefined)
          }
          // Only EEXIST is contention; any other error is rethrown.
          if ((error as { code?: string }).code !== 'EEXIST') {
            throw new ProvisionError('unknown-error', `无法创建锁 ${path}：${error instanceof Error ? error.message : String(error)}`)
          }
        } finally {
          // The success path returns from inside the `try`, so the handle is released here — a
          // `writeFile`/`close` failure must never leak it.
          if (handle !== undefined) await handle.close().catch(() => undefined)
        }

        const holder = await readHolder(path)
        // The lock file's own mtime, read from the filesystem. It is compared against the WALL clock
        // rather than the injectable one: `clock` drives the timeout budget and the recorded
        // `startedAt`, but an injected clock that is deliberately far from wall time would make a
        // fresh lock look arbitrarily old.
        const info = await stat(path).then(value => value, () => undefined)
        const fileStale = info !== undefined && Date.now() - info.mtimeMs > staleMs
        const heldMs = info === undefined ? 0 : Math.round(Date.now() - info.mtimeMs)
        const waitedMs = Math.round(clock() - started)
        if (holder === undefined) {
          // No readable holder. mtime is the only trustworthy signal that this is a corrupt /
          // half-written lock rather than a live writer caught mid-write, so a stale file is
          // reclaimed and a fresh one still honours the timeout budget.
          if (fileStale && await unlink(path).then(() => true, () => false)) continue
          if (clock() >= deadline) {
            throw new ProvisionError(
              'lock/timeout',
              `等待发布锁超时（预算 ${String(timeoutMs)} ms，已等待 ${String(waitedMs)} ms）：${path} 存在但不是可读的锁文件` +
                (info === undefined ? '' : `；锁文件 mtime 年龄 ${String(heldMs)} ms（staleMs ${String(staleMs)} ms）`),
            )
          }
          if (info !== undefined) await sleep(pollMs)
          continue
        }
        // A readable holder. The pid is AUTHORITATIVE: a lock is reclaimed only when its holder is
        // provably GONE. mtime alone must never reclaim a live holder — a critical section is allowed
        // to outlive `staleMs` (a GiB-scale copy fallback on Windows takes minutes), and stealing the
        // lock from a live writer is worse than making the waiter fail visibly: two writers entering
        // the same snapshot directory is a correctness break, a timeout is a report. `recordedStale`
        // stays the secondary signal for a dead pid, keeping recovery working under an injected clock
        // or where mtime is not meaningful.
        const alive = pidIsAlive(holder.pid)
        const recordedStale = !alive && clock() - holder.startedAt > staleMs
        if (!alive && (recordedStale || fileStale) && await unlink(path).then(() => true, () => false)) continue
        if (alive && fileStale && onSlowHold !== undefined) {
          warnSlowHold(onSlowHold, {
            path,
            pid: holder.pid,
            startedAt: holder.startedAt,
            heldMs,
            staleMs,
            waitedMs,
          })
        }
        if (clock() >= deadline) {
          const state = alive ? '仍存活（活体持有者，不回收）' : '已消失（尚未满足可回收条件）'
          throw new ProvisionError(
            'lock/timeout',
            `等待发布锁超时（预算 ${String(timeoutMs)} ms，已等待 ${String(waitedMs)} ms）：${path} 由 pid ${String(holder.pid)} ` +
              `持有（startedAt ${String(holder.startedAt)}），该进程${state}；锁文件 mtime 年龄 ${String(heldMs)} ms（staleMs ${String(staleMs)} ms）`,
          )
        }
        await sleep(pollMs)
      }
    },
  }
}
