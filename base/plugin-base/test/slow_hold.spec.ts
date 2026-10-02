/**
 * P15 reachability proof: under base's OWN wiring, a live holder that outlives the lock contract must
 * actually produce the `onSlowHold` warning BEFORE the waiter times out.
 *
 * The three production call sites (`provisioner.ts` publish/quarantine, `providers/model.ts`
 * placement, `state.ts` status) used `staleMs` 60 s/30 s against `timeoutMs` 15 s/5 s. Because the
 * warning needs the lock file's mtime to cross `staleMs`, a waiter present from the start of the hold
 * always exhausted its budget first — the R2 warning was unreachable under this package's own
 * constants (`docs/review/2026-10-03-performance-review.md` §1.4 / P15).
 *
 * This spec does not trust the constants. It first OBSERVES what the real call sites pass to
 * `lock.acquire` (by injecting a recording lock through the public seams), then REPLAYS each observed
 * option pair against the real `defaultLock` with a live holder and a controlled mtime. The replay
 * uses an injected clock that reaches the deadline on the first poll, so it proves the ordering
 * "warning first, timeout second" without any real sleep.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs } from '../src/fs.js'
import { lockPath, statusLockPath } from '../src/layout.js'
import { defaultLock, type SlowHoldInfo } from '../src/lock.js'
import { createProvisioner } from '../src/provisioner.js'
import { modelCacheProvider } from '../src/providers/model.js'
import { npmPackageProvider } from '../src/providers/npm.js'
import type { Disposable, Manifest, ProvisionItem, ProvisionLock, ProvisionLogger } from '../src/types.js'
import { integrityOf, packageTarball, registryFor } from './helpers/registry.js'
import { removeHome } from './helpers/tmp.js'

const silent: ProvisionLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const fs = defaultFs()

/** One `acquire` exactly as a base call site made it. */
interface Observed {
  readonly path: string
  readonly timeoutMs: number
  readonly staleMs: number
}

/** A lock that records what the caller passes, then delegates to a real one so the flow completes. */
function recordingLock(seen: Observed[]): ProvisionLock {
  const real = defaultLock()
  return {
    acquire: (path, options): Promise<Disposable> => {
      seen.push({ path, ...options })
      return real.acquire(path, options)
    },
  }
}

function item(overrides: Partial<ProvisionItem> = {}): ProvisionItem {
  return {
    id: 'mem:demo',
    kind: 'npm-package',
    spec: { name: 'demo-pkg', range: '^1.0.0' },
    target: { root: 'runtime' },
    schemaVersion: 1,
    ...overrides,
  }
}

/** A hub endpoint good enough for `model-cache`: revision resolution plus `resolve/<sha>/<file>`. */
const MODEL_SHA = 'b'.repeat(40)
function modelHub(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    if (url.includes('/revision/')) return new Response(JSON.stringify({ sha: MODEL_SHA }), { status: 200 })
    if (/\/resolve\/[^/]+\/.+$/.test(url)) return new Response('bytes', { status: 200 })
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
}

/**
 * Replay one observed option pair through the REAL lock. The lock file is a LIVE holder
 * (`process.pid`) whose mtime already crossed `staleMs`; the injected clock jumps one whole budget
 * per call, so the deadline is reached on the first poll. The warning is emitted before the deadline
 * check in that same iteration, which is exactly the ordering the P15 fix restores.
 */
async function expectWarns(entry: Observed): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'envinit-slow-hold-'))
  try {
    const path = join(root, '.lock')
    await mkdir(root, { recursive: true })
    const holder = { pid: process.pid, startedAt: Date.now() - entry.staleMs - 60_000 }
    await writeFile(path, JSON.stringify(holder), 'utf8')
    const when = new Date(Date.now() - entry.staleMs - 1_000)
    await utimes(path, when, when)

    const seen: SlowHoldInfo[] = []
    let now = 1_000_000
    // One third of the budget per clock call: the warning is observed with `waitedMs = 2/3 budget`
    // (still inside it) and the deadline is crossed on the very next check — no real sleep involved.
    const step = Math.ceil(entry.timeoutMs / 3)
    const clock = (): number => (now += step)
    await expect(
      defaultLock({ clock, pollMs: 5, onSlowHold: info => seen.push(info) }).acquire(path, {
        timeoutMs: entry.timeoutMs,
        staleMs: entry.staleMs,
      }),
    ).rejects.toMatchObject({ code: 'lock/timeout' })

    expect(seen, `${entry.path} (timeout ${String(entry.timeoutMs)} / stale ${String(entry.staleMs)})`).toHaveLength(1)
    expect(seen[0]).toMatchObject({ path, pid: process.pid, staleMs: entry.staleMs })
    expect(seen[0]?.heldMs).toBeGreaterThanOrEqual(entry.staleMs)
    // The ordering that P15 was about: the warning lands while the waiter still has budget left.
    expect(seen[0]?.waitedMs).toBeLessThan(entry.timeoutMs)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('慢持有告警在 base 自己的接线下可达（P15）', () => {
  const homes: string[] = []

  beforeEach(() => {
    homes.length = 0
  })
  afterEach(async () => {
    for (const home of homes) await removeHome(home)
  })

  async function newHome(prefix: string): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), prefix))
    homes.push(home)
    return home
  }

  it('观察到的每对常数都 staleMs < timeoutMs，且真实锁先告警后超时', async () => {
    const observed: Observed[] = []

    // ① provisioner.ts 的族根发布锁（npm 经 `publish()`），② state.ts 的状态短锁（`persistStatus`）。
    const npmHome = await newHome('envinit-p15-npm-')
    const npm = createProvisioner({
      home: npmHome,
      logger: silent,
      fs,
      fetch: registryFor('demo-pkg', '1.0.0', packageTarball(), integrityOf(packageTarball())),
      lock: recordingLock(observed),
    })
    npm.register(npmPackageProvider())
    npm.declare({ plugin: 'mem', items: [item()] } as Manifest)
    expect((await npm.ensure()).ok).toBe(true)

    // ③ providers/model.ts 的落位锁，经 `ctx.lock`（同一个注入锁）。
    const modelHome = await newHome('envinit-p15-model-')
    const model = createProvisioner({
      home: modelHome,
      logger: silent,
      fs,
      fetch: modelHub(),
      lock: recordingLock(observed),
    })
    model.register(modelCacheProvider())
    model.declare({
      plugin: 'mem',
      items: [item({ id: 'mem:model', kind: 'model-cache', spec: { repo: 'acme/tiny', files: ['config.json'] }, target: { root: 'models' } })],
    } as Manifest)
    expect((await model.ensure()).ok).toBe(true)

    // All three production sites really went through the injected lock.
    expect(observed.some(entry => entry.path === lockPath(npmHome))).toBe(true)
    expect(observed.some(entry => entry.path === lockPath(modelHome))).toBe(true)
    expect(observed.some(entry => entry.path === statusLockPath(npmHome))).toBe(true)

    // The fix itself: every option pair base's own wiring hands to `acquire` can warn before timing out.
    // Reachability argument: a waiter arrives at or after the holder's acquire, so the file's mtime
    // crosses `staleMs` no later than `holderStart + staleMs`. With `staleMs < timeoutMs` that is
    // strictly before the waiter's own deadline `waiterStart + timeoutMs`, so EVERY waiter present
    // during the hold observes the warning first. With `staleMs >= timeoutMs` only a late arrival
    // (after `staleMs - timeoutMs`) does, which is why the equality mattered.
    expect(observed.length).toBeGreaterThan(0)
    for (const entry of observed) expect(entry.staleMs).toBeLessThan(entry.timeoutMs)

    // Replay each distinct pair against the real lock: live holder + mtime past staleMs ⇒ warning,
    // then `lock/timeout` — the warning is no longer behind the timeout.
    const distinct = new Map(observed.map(entry => [`${entry.path}|${String(entry.timeoutMs)}|${String(entry.staleMs)}`, entry]))
    for (const entry of distinct.values()) await expectWarns(entry)
  })
})
