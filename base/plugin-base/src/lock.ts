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

export interface DefaultLockOptions {
  /** Clock source; defaults to `Date.now`. */
  readonly clock?: () => number
  /** Poll interval while waiting; defaults to 25 ms. */
  readonly pollMs?: number
}

/** The default {@link ProvisionLock}. */
export function defaultLock(options: DefaultLockOptions = {}): ProvisionLock {
  const clock = options.clock ?? Date.now
  const pollMs = options.pollMs ?? 25
  return {
    async acquire(path, { timeoutMs, staleMs }): Promise<Disposable> {
      // Ensure the control-plane directory exists.
      await mkdir(dirname(path), { recursive: true })
      const deadline = clock() + timeoutMs
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
        // freshly written lock look arbitrarily old and reclaim a live one.
        const info = await stat(path).then(value => value, () => undefined)
        const fileStale = info !== undefined && Date.now() - info.mtimeMs > staleMs
        if (holder === undefined) {
          // No readable holder. mtime is the only trustworthy signal that this is a corrupt /
          // half-written lock rather than a live writer caught mid-write, so a stale file is
          // reclaimed and a fresh one still honours the timeout budget.
          if (fileStale && await unlink(path).then(() => true, () => false)) continue
          if (clock() >= deadline) {
            throw new ProvisionError(
              'lock/timeout',
              `等待发布锁超时（${String(timeoutMs)} ms）：${path} 存在但不是可读的锁文件`,
            )
          }
          if (info !== undefined) await sleep(pollMs)
          continue
        }
        // A readable holder. mtime is AUTHORITATIVE here: a pid can be reused by an unrelated live
        // process, and requiring "the pid is dead" then means a dead holder's lock is never
        // reclaimed. The recorded start time stays a secondary signal for a provably dead pid, which
        // keeps recovery working under an injected clock or where mtime is not meaningful.
        const recordedStale = !pidIsAlive(holder.pid) && clock() - holder.startedAt > staleMs
        if ((fileStale || recordedStale) && await unlink(path).then(() => true, () => false)) continue
        if (clock() >= deadline) {
          throw new ProvisionError(
            'lock/timeout',
            `等待发布锁超时（${String(timeoutMs)} ms）：${path} 由 pid ${String(holder.pid)} 持有`,
          )
        }
        await sleep(pollMs)
      }
    },
  }
}
