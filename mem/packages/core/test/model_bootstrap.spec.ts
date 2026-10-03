import { describe, it, expect } from 'vitest'
import { hasArtifact, registerArtifact, whenEventLoopIdle } from '@avantf/mem-provision'
import { provisionToolchainAsync, awaitStartupGate, warmModels } from '../src/modelBootstrap.js'
import type { AvantfRuntime } from '../src/runtime.js'

/** Block the main thread for `ms` — a stand-in for the host's CPU-bound boot. */
function blockFor(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* spin */ }
}

/** The slice of the runtime `warmModels` touches, with a logger that records lines. */
function fakeRuntime(lines: string[]): AvantfRuntime {
  return {
    config: {
      common: {
        semantic: { local_model: 'test-model', backend: 'local_bge', mirror: 'https://x', cache_dir: '/tmp', auto_download: false },
      },
    },
    logger: {
      info: (message: string) => { lines.push(message) },
      warn: (message: string) => { lines.push(message) },
      error: (message: string) => { lines.push(message) },
    },
    memory: { warmupSemantic: async () => true },
  } as unknown as AvantfRuntime
}

/**
 * The tokenizer warm-up parses nodejieba's dictionary SYNCHRONOUSLY (~1.2 s on the main thread), so
 * on the host path it must not run while the harness is still booting: measured, the harness
 * printed its listen URL 0.09 s after our "tokenizer ready" line, i.e. our parse was the last
 * thing gating startup. `whenEventLoopIdle` (now in `@avantf/mem-provision`, where the startup
 * sweep lives) is the gate; these tests pin both it and the wiring.
 */
describe('whenEventLoopIdle', () => {
  it('returns after one quiet window when the loop is idle', async () => {
    const waited = await whenEventLoopIdle(20, 1000)
    expect(waited).toBeGreaterThanOrEqual(15)
    // The invariant is "did not wait out maxWait"; the exact value is load-dependent (a late
    // window is retried, and under CI load a 20 ms timer can be late by tens of ms).
    expect(waited).toBeLessThan(1000)
  })

  it('keeps waiting while the loop is blocked, then returns once it is quiet', async () => {
    // Queued to fire INSIDE the probe's first window: its spin makes that window's timer late,
    // which is the signal that the loop is not idle yet.
    setTimeout(() => { blockFor(150) }, 5)
    const waited = await whenEventLoopIdle(20, 3000)
    expect(waited).toBeGreaterThanOrEqual(100)
  })

  it('returns at once when maxWait cannot fit another quiet window', async () => {
    // quiet (1000) > maxWait (50): the loop takes the early-return branch, so this pins the CAP
    // semantics rather than "the loop was never idle".
    const started = Date.now()
    const waited = await whenEventLoopIdle(1000, 50)
    expect(Date.now() - started).toBeLessThan(300)
    expect(waited).toBeLessThan(300)
  })
})

describe('warmModels tokenizer gating', () => {
  it('waits for an idle turn on the host path', async () => {
    const lines: string[] = []
    setTimeout(() => { blockFor(150) }, 5)
    await warmModels(fakeRuntime(lines), { deferTokenizerUntilIdle: true })
    // The line only exists when the gate actually waited (>= 200 ms), which needs a late window.
    expect(lines.some((line) => line.includes('tokenizer warm waited'))).toBe(true)
    expect(lines.some((line) => line.includes('tokenizer ready') || line.includes('nodejieba unavailable'))).toBe(true)
  })

  it('waits for the host readiness signal before the tokenizer parse', async () => {
    const lines: string[] = []
    let release: () => void = () => {}
    const waitFor = new Promise<void>((resolve) => { release = resolve })
    const done = warmModels(fakeRuntime(lines), { waitFor })
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    // The semantic warm has completed by now (its fake is immediate), so a tokenizer line here
    // would mean the parse ran before the host said it was ready.
    expect(lines.some((line) => line.includes('tokenizer ready') || line.includes('nodejieba unavailable'))).toBe(false)
    release()
    await done
    expect(lines.some((line) => line.includes('tokenizer ready') || line.includes('nodejieba unavailable'))).toBe(true)
  })

  it('warms when the host readiness signal rejects (a failed boot)', async () => {
    const lines: string[] = []
    const failed: Promise<unknown> = Promise.reject(new Error('boot failed'))
    failed.catch(() => undefined) // keep the test process quiet; the code under test adds its own
    await warmModels(fakeRuntime(lines), { waitFor: failed, waitForCapMs: 50 })
    expect(lines.some((line) => line.includes('tokenizer ready') || line.includes('nodejieba unavailable'))).toBe(true)
  })

  it('warms anyway when the host signal never arrives (the cap, not the host, ends the wait)', async () => {
    const lines: string[] = []
    const never = new Promise<never>(() => { /* never settles — a hung loader row */ })
    const started = Date.now()
    await warmModels(fakeRuntime(lines), { waitFor: never, waitForCapMs: 30 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(lines.some((line) => line.includes('tokenizer ready') || line.includes('nodejieba unavailable'))).toBe(true)
  })

  it('does not gate the CLI path, which is already idle', async () => {
    const lines: string[] = []
    setTimeout(() => { blockFor(150) }, 5)
    await warmModels(fakeRuntime(lines))
    expect(lines.some((line) => line.includes('tokenizer warm waited'))).toBe(false)
  })
})

describe('awaitStartupGate', () => {
  it('does not resolve before the host readiness signal does', async () => {
    let release: () => void = () => {}
    const waitFor = new Promise<void>((resolve) => { release = resolve })
    let opened = false
    const gate = awaitStartupGate({ waitFor, waitForCapMs: 5_000 }).then(() => { opened = true })
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    expect(opened).toBe(false)
    release()
    await gate
    expect(opened).toBe(true)
  })

  it('still opens when the readiness signal rejects (a failed boot is a sync point, not a precondition)', async () => {
    const failed: Promise<unknown> = Promise.reject(new Error('boot failed'))
    failed.catch(() => undefined)
    await expect(awaitStartupGate({ waitFor: failed, waitForCapMs: 50 })).resolves.toBe(0)
  })

  it('does not wait for an idle loop unless asked (the CLI path)', async () => {
    setTimeout(() => { blockFor(120) }, 5)
    const started = Date.now()
    // No `deferTokenizerUntilIdle`: the gate is only the host signal, so this returns immediately.
    await awaitStartupGate()
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('waits out an idle turn when asked (the host path the entity sweep shares)', async () => {
    // First window is blocked, so the idle gate must keep trying; the same gate the tokenizer warm
    // uses, now also guarding the mount-time entity sweep (a jieba parse would otherwise re-enter
    // the boot window through that second door).
    setTimeout(() => { blockFor(150) }, 5)
    const waited = await awaitStartupGate({ deferTokenizerUntilIdle: true })
    expect(waited).toBeGreaterThanOrEqual(100)
  })
})

/**
 * The dsh compatibility gate is the FIRST step of the startup sweep: when the host dsh API is proven
 * incompatible, NOTHING is resolved, installed or warmed — preparing an environment for an API we
 * cannot drive is wasted mission. The counting artifact below is the falsifier: if the gate were
 * missing (or after it), its `install` would record a call.
 *
 * The plugin computes the verdict (it owns the base dependency) and passes it as plain data; core
 * only reads `load`. That keeps `@avantf/dsh-compat` out of the inlined core bundle entirely.
 */
describe('provisionToolchainAsync dsh compatibility gate', () => {
  it('never resolves, installs or warms any artifact when the host dsh is incompatible', async () => {
    const lines: string[] = []
    const installs: string[] = []
    const id = 'compat-gate-probe'
    if (!hasArtifact(id)) {
      registerArtifact({
        id,
        title: 'compat gate probe',
        isPresent: async () => false,
        install: async () => { installs.push(id) },
        verify: async () => undefined,
      })
    }
    const result = await provisionToolchainAsync(fakeRuntime(lines), {
      dshCompat: {
        load: false,
        status: 'probe-failed',
        reason: 'ctx.typert.register() refused a probe contribution: TypertSchemaFactory is not a constructor',
      },
    })
    expect(result.skipped).toBe(true)
    expect(result.status).toBe('probe-failed')
    expect(result.reason).toContain('TypertSchemaFactory')
    // Not one artifact ran, and the sweep was never even announced.
    expect(installs).toEqual([])
    expect(lines.some((line) => line.includes('compat:'))).toBe(true)
    expect(lines.some((line) => line.includes('provision[') || line.includes('启动预装已调度'))).toBe(false)
  })

  it('provisions as usual when the verdict says load (a version difference is not a refusal)', async () => {
    // The counterpart to the case above: `version-mismatch` carries `load: true`, and the sweep must
    // NOT be skipped by it. The claim is "only probe-failed skips", and this pins it from the data.
    const lines: string[] = []
    const result = await provisionToolchainAsync(fakeRuntime(lines), {
      dshCompat: { load: true, status: 'version-mismatch', reason: '' },
    })
    expect(result.skipped).toBe(false)
    expect(lines.some((line) => line.includes('compat:') && line.includes('skipped'))).toBe(false)
  })
})

