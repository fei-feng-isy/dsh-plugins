import { describe, it, expect } from 'vitest'
import { RELEVANCE_HINT, hintText, messageText } from '../src/hints.js'

/**
 * The conditional hint (DESIGN §12).
 *
 * The verdict is a boolean now — `kb_query` retrieves from BOTH stores, so "which one matched"
 * changes nothing downstream. The interesting properties are that a hit renders ONE line naming
 * that cross-store tool, and that "nothing found" renders as EMPTY (which the prompt registry
 * drops, so it costs no tokens).
 */
describe('hintText', () => {
  it('renders the one line on a hit, and nothing on a miss', () => {
    expect(hintText(true)).toBe(RELEVANCE_HINT)
    expect(hintText(false)).toBe('')
  })

  it('names the cross-store tool and is authored by the plugin', () => {
    // The tool name is what makes the line actionable; the author prefix is what keeps it from
    // reading as something the USER said, since the harness injects this as a user-role snapshot.
    expect(RELEVANCE_HINT).toContain('kb_query')
    expect(RELEVANCE_HINT).toContain('[avantf-mem]')
    // `mem_recall` is the memory-only ACTION tool (chain / probe / reason / contradict). The line
    // must not send the model to a second, overlapping retrieval — that is how the same facts came
    // back twice.
    expect(RELEVANCE_HINT).not.toContain('mem_recall')
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
