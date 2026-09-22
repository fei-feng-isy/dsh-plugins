import { describe, it, expect } from 'vitest'
import { KNOWLEDGE_HINT, MEMORY_HINT, hintLines, messageText } from '../src/hints.js'

/**
 * The conditional hints (DESIGN §12).
 *
 * `RelevanceHit` is a closed set, so the mapping is checked exhaustively rather than by example —
 * the interesting property is which of the two contributions renders, and that "nothing found"
 * renders as EMPTY (which the prompt registry drops, so it costs no tokens).
 */
describe('hintLines', () => {
  it('maps all four answers, one contribution per store', () => {
    expect(hintLines('none')).toEqual({ memory: '', knowledge: '' })
    expect(hintLines('memory')).toEqual({ memory: MEMORY_HINT, knowledge: '' })
    expect(hintLines('knowledge')).toEqual({ memory: '', knowledge: KNOWLEDGE_HINT })
    expect(hintLines('both')).toEqual({ memory: MEMORY_HINT, knowledge: KNOWLEDGE_HINT })
  })

  it('names the store\'s own tool and is authored by the plugin', () => {
    // The tool name is what makes the line actionable; the author prefix is what keeps it from
    // reading as something the USER said, since the harness injects this as a user-role snapshot.
    expect(MEMORY_HINT).toContain('mem_recall')
    expect(KNOWLEDGE_HINT).toContain('kb_query')
    for (const line of [MEMORY_HINT, KNOWLEDGE_HINT]) expect(line).toContain('[avantf-mem 插件]')
  })

  it('does not cross the two stores: the memory line never names kb_query and vice versa', () => {
    expect(MEMORY_HINT).not.toContain('kb_query')
    expect(KNOWLEDGE_HINT).not.toContain('mem_recall')
  })
})

describe('messageText', () => {
  it('reads a single text block', () => {
    expect(messageText({ content: [{ type: 'text', text: '你好' }] })).toBe('你好')
  })

  it('joins multiple text blocks instead of giving up (dsh returns undefined for those)', () => {
    expect(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  })

  it('returns empty for anything without text', () => {
    expect(messageText(undefined)).toBe('')
    expect(messageText(null)).toBe('')
    expect(messageText({})).toBe('')
    expect(messageText({ content: 'not-an-array' })).toBe('')
    expect(messageText({ content: [{ type: 'image', url: 'x' }] })).toBe('')
  })
})
