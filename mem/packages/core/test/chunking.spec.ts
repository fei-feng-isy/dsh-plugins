import { describe, it, expect } from 'vitest'
import { chunkText } from '../src/store/knowledge.js'

describe('chunkText (paragraph + heading aware)', () => {
  it('keeps a short document as one chunk with faithful offsets', () => {
    const text = '# 标题\n\n平台组负责统一网关。'
    const chunks = chunkText(text, 800, 80)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingsPath).toBe('标题')
    expect(text.slice(chunks[0].start, chunks[0].end)).toBe(chunks[0].text)
  })

  it('tracks the markdown heading stack per block', () => {
    const text = '# A\n\nfirst paragraph\n\n## B\n\nsecond paragraph\n\n# C\n\nthird paragraph'
    const chunks = chunkText(text, 800, 0)
    expect(chunks).toHaveLength(1) // all blocks pack into one chunk under 800 chars
    expect(chunks[0].headingsPath).toBe('A') // headings of the first block
    // With a small chunk size the groups split and each carries its own heading path.
    const small = chunkText(text, 30, 0)
    const paths = small.map((c) => c.headingsPath)
    expect(paths).toContain('A')
    expect(paths).toContain('A > B')
    expect(paths).toContain('C')
  })

  it('splits oversized content and keeps char offsets faithful for EVERY chunk', () => {
    const para = (s: string, n: number): string => s.repeat(n)
    const text = `# H\n\n${para('甲', 300)}\n\n${para('乙', 300)}\n\n${para('丙', 300)}`
    const chunks = chunkText(text, 200, 40)
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0)
      expect(text.slice(c.start, c.end)).toBe(c.text) // offsets always match the source
    }
    // coverage: the concatenation of chunk ranges covers the paragraphs
    const last = chunks[chunks.length - 1]
    expect(last.end).toBeGreaterThanOrEqual(text.length - 1)
  })

  it('applies overlap between consecutive chunks', () => {
    const text = `${'A'.repeat(150)}\n\n${'B'.repeat(150)}\n\n${'C'.repeat(150)}`
    const noOverlap = chunkText(text, 160, 0)
    const withOverlap = chunkText(text, 160, 40)
    expect(withOverlap.length).toBe(noOverlap.length)
    // At least one chunk starts before its block boundary (carries previous context).
    const carries = withOverlap.some((c, i) => i > 0 && c.text.includes('A') && c.text.includes('B'))
      || withOverlap.some((c, i) => i > 0 && c.text.includes('B') && c.text.includes('C'))
    expect(carries).toBe(true)
  })

  it('does not apply the overlap twice on hard-split chunks', () => {
    const text = 'A'.repeat(500)
    const overlap = 20
    const chunks = chunkText(text, 100, overlap)
    expect(chunks.length).toBeGreaterThan(3)
    for (let i = 1; i < chunks.length; i++) {
      // Consecutive hard-split chunks share exactly `overlap` characters (the step
      // is chunkSize - overlap); the tail loop used to subtract the overlap again,
      // doubling it to 2× the configured value.
      expect(chunks[i - 1].end - chunks[i].start).toBe(overlap)
      expect(text.slice(chunks[i].start, chunks[i].end)).toBe(chunks[i].text)
    }
  })

  it('returns [] for blank input and rejects nonsensical sizes', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
    expect(() => chunkText('abc', 0, 0)).toThrow()
  })

  it('clamps overlap to half the chunk size', () => {
    const text = `${'X'.repeat(500)}\n\n${'Y'.repeat(500)}`
    const chunks = chunkText(text, 100, 9999) // overlap clamped to 50
    for (const c of chunks) expect(text.slice(c.start, c.end)).toBe(c.text)
    expect(chunks.length).toBeGreaterThan(5)
  })
})
