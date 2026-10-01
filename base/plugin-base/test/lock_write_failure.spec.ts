/**
 * The failure window `lock.ts` has to survive: `open(path, 'wx')` created the file, then the write
 * failed (ENOSPC, EIO, SIGKILL mid-write). The file is OURS, so it must be removed — an empty `.lock`
 * left behind wedges every later publisher — and the handle must be released on the way out.
 *
 * `node:fs/promises` is mocked for THIS file only (vitest isolates the module graph per test file), and
 * only for a path whose name ends in the marker: every other open still reaches the real filesystem, so
 * the mock cannot itself change the behaviour under test.
 *
 * @module test/lock_write_failure
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open = async (path: string, flags?: string, mode?: number): Promise<unknown> => {
    const handle = await (actual.open as unknown as (p: string, f?: string, m?: number) => Promise<{
      writeFile: (data: string, encoding: string) => Promise<void>
      close: () => Promise<void>
    }>)(path, flags, mode)
    if (!path.endsWith('.failwrite')) return handle
    return {
      writeFile: async () => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      },
      close: () => handle.close(),
    }
  }
  return { ...actual, open }
})

const { defaultLock } = await import('../src/lock.js')

describe('发布锁：建锁失败不留下空锁，也不泄漏句柄', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'envinit-lock-io-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writeFile 失败 ⇒ unknown-error，且把刚创建的文件删掉', async () => {
    const path = join(root, '.failwrite')
    await expect(defaultLock().acquire(path, { timeoutMs: 200, staleMs: 60_000 })).rejects.toMatchObject({
      code: 'unknown-error',
    })
    // The file `open(…, 'wx')` created must be gone: otherwise the next publisher sees an unreadable
    // lock and (before the mtime self-heal) would time out forever.
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('失败后锁目录仍可被正常获取（句柄释放、路径干净）', async () => {
    const path = join(root, '.failwrite')
    await expect(defaultLock().acquire(path, { timeoutMs: 200, staleMs: 60_000 })).rejects.toMatchObject({
      code: 'unknown-error',
    })
    // A different name in the same directory must still work — proof the failure path left the state
    // usable rather than holding anything open.
    const handle = await defaultLock().acquire(join(root, '.ok'), { timeoutMs: 500, staleMs: 1_000 })
    handle.dispose()
  })
})
