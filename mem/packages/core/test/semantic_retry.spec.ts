import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSemanticBackend, type SemanticBackend } from '@avantf/mem-core'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'

/**
 * A controllable semantic backend standing in for the ONNX embedder:
 * `warmUp()` is the download/load, `ensureWarm()` the throttled retry. The tests
 * assert *when* the stores ask for either — that wiring is the fix for a failed
 * bootstrap leaving a long-lived host degraded forever.
 */
class FakeSemantic implements SemanticBackend {
  readonly name = 'fake_retry'
  readonly dim = 512
  available = false
  warmUps = 0
  nudges = 0
  /** Simulate a mirror that comes back up: the next warmup succeeds. */
  succeedsOnWarm = false

  isAvailable(): boolean {
    return this.available
  }

  ensureWarm(): void {
    this.nudges += 1
  }

  async warmUp(): Promise<void> {
    this.warmUps += 1
    if (this.succeedsOnWarm) this.available = true
  }

  async encode(): Promise<Float32Array> {
    if (!this.available) throw new Error('fake_retry: not available')
    const vec = new Float32Array(this.dim)
    vec[0] = 1
    return vec
  }

  async encodeBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(() => this.encode()))
  }
}

let dir: string
let rt: AvantfRuntime
let fake: FakeSemantic

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-semantic-retry-'))
  mkdirSync(join(dir, 'configs'), { recursive: true })  // the config files live in one directory now
  // Select the fake through the documented registry + config layer rather than
  // reaching into the stores, so the whole buildRuntime path is exercised.
  writeFileSync(join(dir, 'configs', 'common.yaml'), 'semantic:\n  backend: fake_retry\n')
  fake = new FakeSemantic()
  registerSemanticBackend('fake_retry', () => fake)
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('semantic bootstrap retry wiring', () => {
  it('nudges the backend when a search has to run degraded', async () => {
    await rt.remember({ action: 'add', content: '张伟管理李娜' })
    const before = fake.nudges
    await rt.recall({ action: 'search', query: '李娜' })
    expect(fake.nudges).toBeGreaterThan(before)
  })

  it('does not nudge once the model is available', async () => {
    fake.available = true
    await rt.remember({ action: 'add', content: '张伟管理李娜' })
    const before = fake.nudges
    await rt.recall({ action: 'search', query: '李娜' })
    expect(fake.nudges).toBe(before)
  })

  it('vectors_fix waits for the model and repairs the same call', async () => {
    // Written while the model was down: the incident's "facts without vectors".
    await rt.remember({ action: 'add', content: '项目使用 PostgreSQL' })
    expect(fake.warmUps).toBe(0)

    fake.succeedsOnWarm = true
    const res = (await rt.admin({ action: 'vectors_fix' })) as { fixed: number; semantic_available: boolean }
    expect(fake.warmUps).toBe(1)
    expect(res.semantic_available).toBe(true)
    expect(res.fixed).toBe(1)
  })

  it('vectors_fix --dry-run never reaches for the model', async () => {
    await rt.remember({ action: 'add', content: '项目使用 PostgreSQL' })
    const res = (await rt.admin({ action: 'vectors_fix', dry_run: true })) as { semantic_available: boolean }
    expect(fake.warmUps).toBe(0)
    expect(res.semantic_available).toBe(false)
  })
})
