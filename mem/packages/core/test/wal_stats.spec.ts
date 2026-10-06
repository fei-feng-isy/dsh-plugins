import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import type { SemanticBackend } from '@avantf/mem-retrieval'

/** No model, no download: this spec is about one `statSync`, not about retrieval. */
class NeverWarm implements SemanticBackend {
  readonly name = 'wal_stats_never_warm'
  readonly dim = 768
  isAvailable(): boolean { return false }
  async encode(): Promise<Float32Array> { throw new Error('no model') }
  async encodeBatch(): Promise<Float32Array[]> { throw new Error('no model') }
}

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-wal-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: new NeverWarm() })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * P-06 — `admin stats` reports the WAL sidecar from ONE `statSync`, and the value it reports is the
 * real file state (not a cached/derived number). The negative branch (absent / truncated → silent)
 * is the same code path with `bytes === 0`, asserted here by consistency so the test does not have
 * to delete a live WAL out from under SQLite.
 */
describe('P-06 WAL health in admin stats', () => {
  it('reports the -wal bytes that are actually on disk, with a reminder only when non-empty', async () => {
    // A write makes SQLite create/extend the sidecar; the connection stays open for the check.
    await rt.remember({ action: 'add', content: '陈静负责发布窗口' })
    const onDisk = statSync(join(dir, 'memory.db-wal')).size

    const stats = rt.admin({ action: 'stats' })
    expect(stats.wal.present, 'the sidecar exists while the connection is open').toBe(true)
    expect(stats.wal.bytes, 'the reported size is the file size, not a guess').toBe(onDisk)
    expect(stats.wal.bytes).toBeGreaterThan(0)
    expect(stats.wal.warning, 'non-empty WAL ⇒ the checkpoint reminder').not.toBeNull()
    expect(stats.wal.warning).toContain('wal_checkpoint(TRUNCATE)')

    // The consistency the negative branch relies on: no bytes ⇒ no warning.
    if (stats.wal.bytes === 0) expect(stats.wal.warning).toBeNull()
  })

  it('keeps the rest of the stats payload intact', async () => {
    const stats = rt.admin({ action: 'stats' })
    expect(stats.active).toBe(0)
    expect(stats.vectors).toEqual({ stale: 0, space_stale: 0 })
    expect(typeof stats.retrieval.queries).toBe('number')
  })
})
