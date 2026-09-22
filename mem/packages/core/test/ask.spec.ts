import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import type { RecallResult } from '@avantf/mem-contract'

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-ask-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

async function seed(): Promise<[number, number]> {
  const a = await rt.remember({ action: 'add', content: '张伟管理李娜' })
  const b = await rt.remember({ action: 'add', content: '李娜管理王强' })
  return [a.fact_id, b.fact_id]
}

/**
 * `recall.ask` may answer with a caller error instead of hits; every test here expects hits, so
 * the union is narrowed once (and a silent `{error}` can no longer masquerade as an empty result).
 */
function hitsOf(result: RecallResult | { error: string }): RecallResult['hits'] {
  if ('error' in result) throw new Error(`ask reported an error instead of hits: ${result.error}`)
  return result.hits
}

describe('ask (direction-aware triple matching)', () => {
  it('李娜管理谁 → the fact where 李娜 manages X (not who manages 李娜)', async () => {
    const [fa, fb] = await seed()
    const hit = hitsOf(await rt.recall({ action: 'ask', query: '李娜管理谁' }))
    expect(hit.length).toBeGreaterThan(0)
    // must be the fact authored 李娜管理王强 (fb), NOT 张伟管理李娜 (fa)
    expect(hit[0].ref_id).toBe(fb)
    expect(hit[0].ref_id).not.toBe(fa)
  })

  it('谁管理李娜 → the fact where X manages 李娜', async () => {
    const [fa] = await seed()
    const hit = hitsOf(await rt.recall({ action: 'ask', query: '谁管理李娜' }))
    expect(hit.length).toBeGreaterThan(0)
    expect(hit[0].ref_id).toBe(fa)
  })

  it('reverse direction a/k/a/ differs from plain search', async () => {
    const [, fb] = await seed()
    const forward = hitsOf(await rt.recall({ action: 'ask', query: '李娜管理谁' }))
    const backward = hitsOf(await rt.recall({ action: 'ask', query: '谁管理李娜' }))
    const fwdTop = forward[0]!.ref_id
    const bwdTop = backward[0]!.ref_id
    expect(fwdTop).toBe(fb)
    expect(bwdTop).not.toBe(fb)
  })
})
