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
        try {
          const handle = await open(path, 'wx')
          await handle.writeFile(JSON.stringify(mine), 'utf8')
          await handle.close()
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
          // Only EEXIST is contention; any other error is rethrown.
          if ((error as { code?: string }).code !== 'EEXIST') {
            throw new ProvisionError('unknown-error', `无法创建锁 ${path}：${error instanceof Error ? error.message : String(error)}`)
          }
        }

        const holder = await readHolder(path)
        if (holder === undefined) {
          // A missing or unreadable holder still honours the timeout budget.
          if (clock() >= deadline) {
            throw new ProvisionError(
              'lock/timeout',
              `等待发布锁超时（${String(timeoutMs)} ms）：${path} 存在但不是可读的锁文件`,
            )
          }
          const stillThere = await stat(path).then(() => true, () => false)
          if (stillThere) await sleep(pollMs)
          continue
        }
        if (!pidIsAlive(holder.pid) && clock() - holder.startedAt > staleMs) {
          await unlink(path).catch(() => undefined)
          continue
        }
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
