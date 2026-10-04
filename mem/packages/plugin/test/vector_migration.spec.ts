import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime, type SemanticBackend } from '@avantf/mem'
import type { AvantfLogger } from '@avantf/mem-contract'
import { createVectorMigration } from '../src/vectorMigration.js'

/**
 * The plugin's driver, on the SHAPE that produced the incident: a store whose ACTIVE vectors are
 * already persisted in the OLD space (512-dim, old model id), reopened under the new 768-dim model.
 * The core spec proves the store's migration; this one proves the driver the plugin actually mounts —
 * that it logs start/progress/end, re-encodes in bounded batches, and does nothing after `stop()`.
 *
 * The embedder is a contract-shaped stand-in (always warm, dim 768); nothing here needs the ONNX
 * adapter, and the plugin's default vitest config must stay free of downloads.
 */
const OLD_SPACE = 'local_bge/Xenova/bge-small-zh-v1.5/512'
const DIM = 768

class WarmSemantic implements SemanticBackend {
  readonly name = 'warm_fake'
  readonly dim = DIM
  isAvailable(): boolean { return true }
  ensureWarm(): void { /* always warm */ }
  async encode(): Promise<Float32Array> { return new Float32Array(DIM) }
  async encodeBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(DIM))
  }
}

class CapturingLogger implements AvantfLogger {
  readonly lines: string[] = []
  info(message: string): void { this.lines.push(`INFO ${message}`) }
  warn(message: string): void { this.lines.push(`WARN ${message}`) }
  error(message: string): void { this.lines.push(`ERROR ${message}`) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the migration')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

let dir: string
let rt: AvantfRuntime

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-vecmig-plugin-'))
  const first = buildRuntime({ dataHome: dir, semantic: new WarmSemantic() })
  try {
    for (const text of ['第一条旧空间事实，长度接近真实语料。', '第二条旧空间事实，也被留在旧嵌入空间里。', '第三条旧空间事实，用来验证驱动器的分批行为。']) {
      await first.remember({ action: 'add', content: text })
    }
    // Age the whole corpus into the previous embedding space (wrong width + old model id).
    first.db.prepare('UPDATE facts SET semantic_vector = ?, embedding_model = ?').run(Buffer.alloc(512 * 4), OLD_SPACE)
  } finally {
    first.shutdown()
  }
  rt = buildRuntime({ dataHome: dir, semantic: new WarmSemantic() })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('plugin vector-migration driver', () => {
  it('re-encodes the aged corpus in the background and logs start, progress and end', async () => {
    expect(rt.memory.vectorSpaceHealth().stale).toBe(3)
    const logger = new CapturingLogger()
    const migration = createVectorMigration({ rt, logger, isActive: () => true, batchSize: 2 })
    migration.start()
    await waitFor(() => rt.memory.vectorSpaceHealth().stale === 0)
    expect(rt.memory.vectorsDiagnose().indexed).toBe(3)
    expect(logger.lines.some((l) => l.includes('belong to an older embedding space'))).toBe(true)
    expect(logger.lines.some((l) => l.includes('re-encoded 2/3'))).toBe(true)
    expect(logger.lines.some((l) => l.includes('complete'))).toBe(true)
  })

  it('does nothing after stop()', async () => {
    const migration = createVectorMigration({ rt, logger: new CapturingLogger(), isActive: () => true })
    migration.stop()
    migration.start()
    // Give a would-be loop a chance to run; nothing may change.
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(rt.memory.vectorSpaceHealth().stale).toBe(3)
    expect(rt.memory.vectorsDiagnose().indexed).toBe(0)
  })
})
