/**
 * Write-side normalization at the store entries (`store/common.ts`'s `normalizeWrite`).
 *
 * What is pinned here is the INVARIANT, not the repair helper: whatever a caller sends, what the
 * stores persist, what they hand back and what a model would ultimately see are all well-formed
 * Unicode. The repair itself is unit-tested in the contract package.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toWellFormedDeep, toWellFormedText } from '@avantf/mem-contract'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { allowAnyDomain } from './helpers.js'

const HALF_HIGH = '\uD800'
const HALF_LOW = '\uDC00'
const HALF_EMOJI = '\uD83D'
const EMOJI = '🐟'
const CJK_EXT_B = '𠀀'
const METACHARS = '"quoted" \\ backslash \n newline \t tab'
const REPLACEMENT = '\uFFFD'

/** Every string reachable from `value` must be well-formed (JSON.parse alone accepts lone surrogates). */
function expectWellFormedEverywhere(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    expect(value.isWellFormed(), `${path}: ${JSON.stringify(value)}`).toBe(true)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => expectWellFormedEverywhere(item, `${path}[${i}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      expect(key.isWellFormed(), `${path} key`).toBe(true)
      expectWellFormedEverywhere(item, `${path}.${key}`)
    }
  }
}

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-wellformed-'))
  allowAnyDomain(dir)
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('memory write normalization', () => {
  it('repairs a fact before it is stored, tagged or echoed', async () => {
    const content = `A${HALF_HIGH}B ${HALF_LOW} ${HALF_EMOJI} ${EMOJI} ${CJK_EXT_B} ${METACHARS}`
    const added = await rt.remember({ action: 'add', content, category: `cat${HALF_HIGH}` })
    expect(added.is_new).toBe(true)

    const expected = toWellFormedText(content).trim()
    const stored = rt.memory.get(added.fact_id)
    expect(stored).toBeDefined()
    expect(stored!.content).toBe(expected)
    expect(stored!.content.isWellFormed()).toBe(true)
    expect(stored!.category).toBe(`${'cat'}${REPLACEMENT}`)
    // Complete astral characters survive the repair untouched.
    expect(stored!.content).toContain(EMOJI)
    expect(stored!.content).toContain(CJK_EXT_B)
    // `entities` is derived in JS and returned WITHOUT a database round trip, so it is the value
    // the driver cannot sanitize for us.
    expectWellFormedEverywhere(added)
    expectWellFormedEverywhere(JSON.parse(JSON.stringify(toWellFormedDeep(added))))
  })

  it('applies the same entry to update', async () => {
    const first = await rt.remember({ action: 'add', content: '原始事实' })
    const updated = await rt.remember({ action: 'update', fact_id: first.fact_id, content: `修订${HALF_HIGH}内容` })
    expect(updated.fact_id).not.toBe(first.fact_id)
    const stored = rt.memory.get(updated.fact_id)
    expect(stored!.content).toBe(`修订${REPLACEMENT}内容`)
    expectWellFormedEverywhere(updated)
  })

  it('repairs the archive reason', async () => {
    const added = await rt.remember({ action: 'add', content: '待归档事实' })
    expect(rt.admin({ action: 'archive', fact_id: added.fact_id, reason: `why${HALF_HIGH}` })).toBe(true)
    const stored = rt.memory.get(added.fact_id)
    expect(stored!.archive_reason).toBe(`why${REPLACEMENT}`)
    expectWellFormedEverywhere(stored)
  })

  it('reads and returns legacy bad content without crashing, well-formed either way', async () => {
    const added = await rt.remember({ action: 'add', content: '正常事实' })
    // A row written outside `normalizeWrite` — the shape an older build or a foreign writer could
    // leave behind. NOTE: `node:sqlite` binds a JS lone surrogate as U+FFFD itself, so this
    // particular write already lands repaired (asserted below); the point of the case is that the
    // read path never throws and the model-facing serialization is well-formed regardless of what
    // the driver stored. The read-side repair of a lone surrogate that DOES reach JS is pinned in
    // the contract package (`text.spec.ts`) and at the MCP/plugin boundaries.
    rt.db.prepare('UPDATE facts SET content = ? WHERE fact_id = ?').run(`历史${HALF_HIGH}坏数据${HALF_LOW}`, added.fact_id)

    const detail = rt.admin({ action: 'detail', fact_id: added.fact_id })
    expect(detail).not.toHaveProperty('error')
    expectWellFormedEverywhere(detail)
    expectWellFormedEverywhere(JSON.parse(JSON.stringify(toWellFormedDeep(detail))))
    // Search touches the FTS index of the same row and must not throw either.
    const hit = await rt.recall({ action: 'search', query: '坏数据' })
    expectWellFormedEverywhere(JSON.parse(JSON.stringify(toWellFormedDeep(hit))))
  })
})

describe('knowledge write normalization', () => {
  it('repairs domain/source/title on the identity path and in the returned document', async () => {
    const result = await rt.knowledge.ingestNew(`正文${HALF_HIGH}一段`, 'notes', `s${HALF_HIGH}`, `t${HALF_HIGH}`)
    expect(result.doc_id).toBeGreaterThan(0)
    expectWellFormedEverywhere(toWellFormedDeep(result))

    const docs = rt.knowledge.list('notes')
    const doc = docs.find((d) => d.doc_id === result.doc_id)
    expect(doc).toBeDefined()
    expect(doc!.title).toBe(`t${REPLACEMENT}`)
    expect(doc!.source).toBe(`s${REPLACEMENT}`)
    expectWellFormedEverywhere(docs.map((d) => toWellFormedDeep(d)))
  })

  it('normalizes a derived title too (an untitled paste takes its title from the body)', async () => {
    const result = await rt.knowledge.ingestNew(`# 标题${HALF_HIGH}\n\n正文。`, 'notes')
    const doc = rt.knowledge.list('notes').find((d) => d.doc_id === result.doc_id)
    expect(doc!.title).toBe(`标题${REPLACEMENT}`)
  })
})
