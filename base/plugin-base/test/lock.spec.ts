import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultLock, pidIsAlive, type SlowHoldInfo } from '../src/lock.js'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Backdate a path's mtime so it reads as a lock nobody has touched for `ageMs`. */
async function age(path: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs)
  await utimes(path, when, when)
}

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

  it('死 pid + mtime 过期 ⇒ 回收（保留的两类回收之一）', async () => {
    const path = join(root, '.lock')
    await writeFile(path, JSON.stringify({ pid: 2 ** 30, startedAt: 0 }), 'utf8')
    await age(path, 60_000)
    const handle = await defaultLock().acquire(path, { timeoutMs: 500, staleMs: 1_000 })
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

  it('mtime 过期但 pid 仍存活 ⇒ 不回收：第二个获取者超时失败，原锁文件仍在（R2）', async () => {
    const path = join(root, '.lock')
    const holder = { pid: process.pid, startedAt: Date.now() - 60_000 }
    await writeFile(path, JSON.stringify(holder), 'utf8')
    // The lock file's mtime is 60 s old — the exact shape the old code used to reclaim a LIVE lock on.
    await age(path, 60_000)
    const lock = defaultLock({ pollMs: 5 })
    await expect(lock.acquire(path, { timeoutMs: 150, staleMs: 1_000 })).rejects.toMatchObject({ code: 'lock/timeout' })
    // Stealing it would let two writers into the same critical section; the file must survive untouched.
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(holder)
  })

  it('活体持有者超时的错误信息带诊断：path / pid / startedAt / mtime 年龄 / 已等待 ms', async () => {
    const path = join(root, '.lock')
    await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: 12_345 }), 'utf8')
    await age(path, 30_000)
    let message = ''
    try {
      await defaultLock({ pollMs: 5 }).acquire(path, { timeoutMs: 120, staleMs: 1_000 })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(path)
    expect(message).toContain(`pid ${String(process.pid)}`)
    expect(message).toContain('startedAt 12345')
    expect(message).toMatch(/mtime 年龄 \d+ ms/)
    expect(message).toMatch(/已等待 \d+ ms/)
    expect(message).toContain('活体持有者，不回收')
  })

  it('看得到"活体持有者拖着不回收"：限频 warn 一次，且不因轮询而重复（R2）', async () => {
    const path = join(root, '.lock')
    await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8')
    await age(path, 30_000)
    const seen: SlowHoldInfo[] = []
    const lock = defaultLock({ pollMs: 5, onSlowHold: info => seen.push(info) })
    await expect(lock.acquire(path, { timeoutMs: 150, staleMs: 1_000 })).rejects.toMatchObject({ code: 'lock/timeout' })
    // ~30 polls in 150 ms; the warn fires once per stale window, not once per poll.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path, pid: process.pid, staleMs: 1_000 })
    expect(seen[0]?.heldMs).toBeGreaterThanOrEqual(30_000)
    expect(seen[0]?.waitedMs).toBeGreaterThanOrEqual(0)

    // A second acquire within the same stale window does not repeat it either (rate limit, not just
    // "once per acquire call").
    await expect(lock.acquire(path, { timeoutMs: 60, staleMs: 1_000 })).rejects.toMatchObject({ code: 'lock/timeout' })
    expect(seen).toHaveLength(1)
  })

  it('mtime 新鲜（未过期）的活体持有者不发慢持有 warn —— 那是正常的短临界区', async () => {
    const path = join(root, '.lock')
    await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8')
    const seen: SlowHoldInfo[] = []
    await expect(
      defaultLock({ pollMs: 5, onSlowHold: info => seen.push(info) }).acquire(path, { timeoutMs: 100, staleMs: 60_000 }),
    ).rejects.toMatchObject({ code: 'lock/timeout' })
    expect(seen).toEqual([])
  })

  it('死亡持有者被回收时不发慢持有 warn（那是回收，不是"不回收"）', async () => {
    const path = join(root, '.lock')
    const deadPid = 2 ** 30
    await writeFile(path, JSON.stringify({ pid: deadPid, startedAt: 0 }), 'utf8')
    const seen: SlowHoldInfo[] = []
    const handle = await defaultLock({ onSlowHold: info => seen.push(info) }).acquire(path, { timeoutMs: 500, staleMs: 1_000 })
    handle.dispose()
    expect(seen).toEqual([])
  })

  it('陈旧的空锁（0 字节，SIGKILL/ENOSPC 的残留）被按 mtime 回收，不再楔死所有人', async () => {
    const path = join(root, '.lock')
    await writeFile(path, '', 'utf8')
    await age(path, 60_000)
    const lock = defaultLock()
    const handle = await lock.acquire(path, { timeoutMs: 500, staleMs: 1_000 })
    handle.dispose()
  })

  it('陈旧的垃圾内容（无法解析为 holder）同样被回收', async () => {
    const path = join(root, '.lock')
    await writeFile(path, '{"pid":', 'utf8')
    await age(path, 60_000)
    const lock = defaultLock()
    const handle = await lock.acquire(path, { timeoutMs: 500, staleMs: 1_000 })
    handle.dispose()
  })

  it('新鲜的空锁仍然超时 —— 不把互斥打破', async () => {
    const path = join(root, '.lock')
    await writeFile(path, '', 'utf8')
    // Fresh mtime, large staleMs: this is indistinguishable from a live writer mid-write, so the
    // budget must still be honoured rather than the file yanked.
    await expect(defaultLock({ pollMs: 5 }).acquire(path, { timeoutMs: 120, staleMs: 60_000 }))
      .rejects.toMatchObject({ code: 'lock/timeout' })
  })
})
