/**
 * The ONE contract-key → runtime table.
 *
 * The gate that matters is the first one: EVERY key the contract advertises must dispatch. The MCP
 * server used to keep its own switch, fell behind `TOOL_SPECS` when the knowledge tool was split
 * into four, and shipped `kb_add`/`kb_list`/`kb_remove`/`kb_reindex` as tools that were listed,
 * callable, and answered `unknown tool key` on every single call. `TOOL_SPECS.length` assertions
 * cannot catch that — the list was correct, the dispatcher was not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_SPECS } from '@avantf/mem-contract'
import { buildRuntime, dispatchToolKey, supportsToolKey, type AvantfRuntime } from '../src/index.js'

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avf-dispatch-'))
  rt = buildRuntime({ dataHome: dir })
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('dispatch table', () => {
  it('answers every key the contract advertises', () => {
    const missing = TOOL_SPECS.map((s) => s.key).filter((key) => !supportsToolKey(key))
    expect(missing).toEqual([])
  })

  it('also answers `kb`, the internal face the UI and CLI drive', () => {
    // Not in TOOL_SPECS on purpose (`sync` must not be model-facing), but the Remote gateway and the
    // CLI address it by the same key, so it belongs to the table.
    expect(supportsToolKey('kb')).toBe(true)
  })

  it('throws on an unknown key instead of returning an empty success', async () => {
    await expect(dispatchToolKey(rt, 'nope', {})).rejects.toThrow('unknown tool key nope')
  })

  it('routes the four knowledge tools end to end', async () => {
    const added = await dispatchToolKey(rt, 'kb_add', { domain: 'notes', source: 'default', text: '# 派发\n\n正文一段。' })
    const docId = (added as { doc_id?: number }).doc_id
    expect(docId).toBeGreaterThan(0)

    const one = await dispatchToolKey(rt, 'kb_list', { doc_id: docId }) as { doc_id: number; file: string }
    expect(one.doc_id).toBe(docId)
    expect(one.file).toContain('.md')

    const page = await dispatchToolKey(rt, 'kb_list', {}) as { doc_id: number }[]
    expect(page.map((d) => d.doc_id)).toContain(docId)

    const plan = await dispatchToolKey(rt, 'kb_reindex', { dry_run: true }) as Record<string, unknown>
    expect(plan).toBeDefined()

    const removed = await dispatchToolKey(rt, 'kb_remove', { doc_id: docId }) as Record<string, unknown>
    expect(removed).toBeDefined()
    expect(await dispatchToolKey(rt, 'kb_list', { doc_id: docId })).toHaveProperty('error')
  })

  it('refuses a kb_add with no content, without touching the store', async () => {
    const res = await dispatchToolKey(rt, 'kb_add', { domain: 'notes', source: 'default' })
    expect(res).toEqual({ error: 'kb_add 需要 text、source_uri 或 paths 三者之一。' })
  })
})
