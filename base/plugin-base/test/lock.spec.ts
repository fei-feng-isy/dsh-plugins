import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultLock, pidIsAlive } from '../src/lock.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('发布锁', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'envinit-lock-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('第二个持有者在超时后报 lock/timeout', async () => {
    const path = join(root, '.lock')
    const lock = defaultLock()
    const first = await lock.acquire(path, { timeoutMs: 1_000, staleMs: 60_000 })
    await expect(lock.acquire(path, { timeoutMs: 120, staleMs: 60_000 })).rejects.toMatchObject({ code: 'lock/timeout' })
    first.dispose()
    await sleep(60)
    const again = await lock.acquire(path, { timeoutMs: 1_000, staleMs: 60_000 })
    again.dispose()
  })

  it('回收"pid 已消失且已过期"的锁', async () => {
    const path = join(root, '.lock')
    const deadPid = 2 ** 30
    expect(pidIsAlive(deadPid)).toBe(false)
    await writeFile(path, JSON.stringify({ pid: deadPid, startedAt: 0 }), 'utf8')
    const lock = defaultLock({ clock: () => 10_000 })
    const handle = await lock.acquire(path, { timeoutMs: 500, staleMs: 1_000 })
    handle.dispose()
  })

  it('非竞争导致的建锁失败保留真因（unknown-error），不伪装成 lock/timeout', async () => {
    // A path Node cannot even open: the failure is "cannot create the lock here", not contention.
    await expect(defaultLock().acquire('\0not-a-path', { timeoutMs: 200, staleMs: 60_000 })).rejects.toMatchObject({
      code: 'unknown-error',
    })
  })

  it('锁路径存在但不是锁文件 ⇒ 等待到预算就报超时，不无限等', async () => {
    const lock = defaultLock({ pollMs: 5 })
    // `open(…, 'wx')` on an existing directory is EEXIST, but `readFile` of it is EISDIR: the path
    // is occupied by something that will never become a lock. The budget must still be honoured.
    await mkdir(join(root, 'occupied'), { recursive: true })
    const started = Date.now()
    await expect(lock.acquire(join(root, 'occupied'), { timeoutMs: 150, staleMs: 60_000 })).rejects.toMatchObject({
      code: 'lock/timeout',
    })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('pid 仍存活时不回收，即使已超过 stale', async () => {
    const path = join(root, '.lock')
    await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: 0 }), 'utf8')
    // A clock that keeps advancing, so the waiter's own timeout can be reached.
    const lock = defaultLock({ clock: () => Date.now() + 10_000_000 })
    await expect(lock.acquire(path, { timeoutMs: 100, staleMs: 1_000 })).rejects.toMatchObject({ code: 'lock/timeout' })
  })
})
