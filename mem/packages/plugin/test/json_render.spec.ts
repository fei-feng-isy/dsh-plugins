/**
 * The plugin's model-facing output boundary (`src/render.ts`).
 *
 * Harness-free by construction: `render.ts` only type-imports the DSH peer, so this spec runs in
 * the same LOCAL vitest config as the other harness-independent units (see `vitest.config.ts`).
 */
import { describe, it, expect } from 'vitest'
import { DEGRADED_LEG_NOTE } from '@avantf/mem-contract'
import { OUTPUT } from '../src/render.js'

/** Every string reachable from the value must be well-formed (JSON.parse accepts lone surrogates). */
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

describe('model-facing tool output', () => {
  it('renders a payload carrying lone surrogates as strictly-parseable text', () => {
    const payload = {
      ok: true,
      result: { content: '\uD800legacy\uDC00', entities: ['\uD83D', '🐟', '𠀀'], nested: { ['k\uD800']: '"\\\n\t' } },
    }
    expect(JSON.stringify(payload)).toContain('\\ud800') // the defect the boundary closes

    const blocks = OUTPUT.render(undefined, payload)
    expect(blocks).toHaveLength(1)
    const text = blocks[0]!.text
    expect(text).not.toContain('\\ud800')
    expect(text).not.toContain('\\udc00')
    expectWellFormedEverywhere(JSON.parse(text))
  })

  it('keeps complete astral characters, shapes and the pretty format', () => {
    const blocks = OUTPUT.render(undefined, { ok: true, result: { n: 1, b: false, s: '🐟𠀀' } })
    const text = blocks[0]!.text
    expect(text).toContain('\n  ') // `null, 2` pretty printing is part of the contract
    expect(JSON.parse(text)).toEqual({ ok: true, result: { n: 1, b: false, s: '🐟𠀀' } })
  })

  it('surfaces the EXISTING degraded flag as a note, and only when it is true (方案 G)', () => {
    // A recall/query result already carries `degraded`; the note names the consequence. The JSON
    // block stays the FIRST and strictly-parseable block — the note is appended, never interleaved.
    const degraded = OUTPUT.render(undefined, { ok: true, result: { hits: [], degraded: true } })
    expect(degraded).toHaveLength(2)
    expect(JSON.parse(degraded[0]!.text)).toEqual({ ok: true, result: { hits: [], degraded: true } })
    expect(degraded[1]!.text).toBe(DEGRADED_LEG_NOTE)

    // Semantic leg live: no note.
    expect(OUTPUT.render(undefined, { ok: true, result: { hits: [], degraded: false } })).toHaveLength(1)
    // Graph-only answers / non-recall payloads carry no flag at all: no note.
    expect(OUTPUT.render(undefined, { ok: true, result: { entity: 'x', count: 1 } })).toHaveLength(1)
    expect(OUTPUT.render(undefined, { ok: false, error: 'boom' })).toHaveLength(1)
  })
})
