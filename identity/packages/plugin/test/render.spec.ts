/**
 * The three-file renderer: order, blank-line joining, the empty case, the byte budget, and the
 * literal-`{{...}}` contract.
 *
 * `IdentityDocuments` is what the prompt section returns, so every one of these behaviours is a
 * statement about the system prompt itself. Nothing here may throw: the render runs inside assembly.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdentityDocuments } from '../src/documents.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-identity-render-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const documents = (maxBytes = 0): IdentityDocuments => new IdentityDocuments(dir, { maxBytes: () => maxBytes })

describe('IdentityDocuments', () => {
  it('joins the three bodies in IDENTITY → SOUL → RULES order', () => {
    writeFileSync(join(dir, 'IDENTITY.md'), 'identity\n')
    writeFileSync(join(dir, 'SOUL.md'), 'soul\n')
    writeFileSync(join(dir, 'RULES.md'), 'rules\n')
    // The RULES part carries the one heading the render adds; this fixture's body is Latin, so the
    // heading is its English spelling.
    expect(documents().render()).toBe('identity\n\nsoul\n\n**Rules**\n\nrules')
  })

  it('labels ONLY the rules part, and the label speaks the body\'s language', () => {
    // The two halves of the decision, in one place: IDENTITY and SOUL get no heading (their difference
    // is emphasis, not kind, and a heading would freeze a taxonomy the user may not share), and the
    // Chinese rules body gets `**规则**` — the word the settings page uses for the same file.
    writeFileSync(join(dir, 'IDENTITY.md'), '你是「小助手」。\n')
    writeFileSync(join(dir, 'SOUL.md'), '语气温和。\n')
    writeFileSync(join(dir, 'RULES.md'), '禁止编造。\n')
    expect(documents().render()).toBe('你是「小助手」。\n\n语气温和。\n\n**规则**\n\n禁止编造。')
  })

  it('adds no heading when the rules part is empty — the heading never dangles', () => {
    writeFileSync(join(dir, 'SOUL.md'), 'only the soul\n')
    writeFileSync(join(dir, 'RULES.md'), '   \n')
    expect(documents().render()).toBe('only the soul')
  })

  it('keeps the heading when the render is truncated (the heading is inside the budget)', () => {
    // The byte budget applies to the WHOLE rendered text, heading included: a heading that got cut away
    // by the budget would be worse than no heading, because the reader would see an unexplained list of
    // constraints with nothing saying what it is.
    writeFileSync(join(dir, 'RULES.md'), '禁'.repeat(400))
    const rendered = documents(60).render()
    expect(rendered.startsWith('**规则**\n\n')).toBe(true)
    expect(rendered).toContain('truncated at 60 bytes')
  })

  it('renders an empty string when every file is absent', () => {
    expect(documents().render()).toBe('')
    expect(documents().bytes()).toBe(0)
  })

  it('renders an empty string when every file is blank', () => {
    for (const name of ['IDENTITY', 'SOUL', 'RULES']) writeFileSync(join(dir, `${name}.md`), '\n \n')
    expect(documents().render()).toBe('')
  })

  it('keeps {{...}} verbatim (the file IS the prompt text)', () => {
    writeFileSync(join(dir, 'IDENTITY.md'), 'you are {{unknown_variable}}\n')
    expect(documents().render()).toBe('you are {{unknown_variable}}')
  })

  it('truncates over maxBytes and appends a visible notice', () => {
    const body = 'x'.repeat(400)
    writeFileSync(join(dir, 'IDENTITY.md'), body)
    const rendered = documents(100).render()
    expect(rendered.startsWith('x'.repeat(100))).toBe(true)
    expect(rendered).toContain('truncated at 100 bytes')
    expect(rendered).toContain(dir)
  })

  it('treats maxBytes = 0 as "no budget"', () => {
    const body = 'y'.repeat(500)
    writeFileSync(join(dir, 'IDENTITY.md'), body)
    expect(documents(0).render()).toBe(body)
  })

  it('reports per-file presence and bytes', () => {
    writeFileSync(join(dir, 'IDENTITY.md'), 'abcd')
    const status = documents().status()
    expect(status.map((entry) => [entry.name, entry.present, entry.bytes])).toEqual([
      ['IDENTITY', true, 4],
      ['SOUL', false, 0],
      ['RULES', false, 0],
    ])
  })

  it('sees a write immediately (the cache is invalidated, not stale)', () => {
    writeFileSync(join(dir, 'SOUL.md'), 'before\n')
    const reader = documents()
    expect(reader.render()).toBe('before')
    reader.write('SOUL', 'after\n')
    expect(reader.render()).toBe('after')
  })

  it('sees a write made outside the reader (mtime/size cache)', () => {
    const reader = documents()
    expect(reader.render()).toBe('')
    writeFileSync(join(dir, 'RULES.md'), 'external edit with a different size\n')
    expect(reader.render()).toBe('**Rules**\n\nexternal edit with a different size')
  })

  it('renders an empty string when the directory does not exist at all (environment failure degrades)', () => {
    const missing = new IdentityDocuments(join(dir, 'no-such-directory'), { maxBytes: () => 0 })
    expect(missing.render()).toBe('')
    expect(() => missing.render()).not.toThrow()
    expect(missing.status().every((entry) => !entry.present)).toBe(true)
  })

  it('an unknown file name is refused rather than turned into a path', () => {
    expect(() => documents().write('../../etc/passwd' as never, 'x')).toThrow()
  })
})
