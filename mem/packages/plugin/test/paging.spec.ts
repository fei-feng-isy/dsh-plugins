/**
 * Page merging: the guard against offset-pagination drift.
 *
 * Both list endpoints page by `OFFSET` over a `CURRENT_TIMESTAMP`-ordered column (second
 * precision), so a row written between two page requests shifts the window and repeats a row. What
 * that costs without de-duplication is concrete: React logs a duplicate `key`, renders the row
 * twice, and — because the next offset was derived from the (now inflated) loaded count — one real
 * row can never be reached by scrolling. These cases pin the merge, and the "identity when nothing
 * is new" case pins the other half: a repeated page must not re-render the list.
 */
import { describe, it, expect } from 'vitest'
import { mergeDocs, mergePage } from '../src/client/paging.js'

const facts = (...ids: number[]) => ids.map(fact_id => ({ fact_id, content: `#${String(fact_id)}` }))
const docs = (...ids: number[]) => ids.map(doc_id => ({ doc_id, title: `doc-${String(doc_id)}` }))

describe('mergePage (记忆 pagination)', () => {
  it('appends a page in order', () => {
    expect(mergePage(facts(1, 2), facts(3, 4)).map(row => row.fact_id)).toEqual([1, 2, 3, 4])
  })

  it('drops the row a shifted window repeated, instead of duplicating its key', () => {
    // Page 1 = [3,2,1]; a fact is written; page 2 re-serves 1 and continues with 0.
    const merged = mergePage(facts(3, 2, 1), facts(1, 0))
    expect(merged.map(row => row.fact_id)).toEqual([3, 2, 1, 0])
    expect(new Set(merged.map(row => row.fact_id)).size).toBe(merged.length)
  })

  it('returns the SAME array when a page brings nothing new (no pointless re-render)', () => {
    const previous = facts(1, 2)
    expect(mergePage(previous, facts(2, 1))).toBe(previous)
  })

  it('keeps the newer copy of a row the host re-sent', () => {
    // The duplicate is dropped, so a row edited between pages keeps the copy already on screen —
    // which is the one the user has been looking at.
    const previous = [{ fact_id: 1, content: '旧' }]
    expect(mergePage(previous, [{ fact_id: 1, content: '新' }])).toBe(previous)
  })
})

describe('mergeDocs (知识 pagination)', () => {
  it('appends a page in order', () => {
    expect(mergeDocs(docs(5, 4), docs(3)).map(row => row.doc_id)).toEqual([5, 4, 3])
  })

  it('drops a repeated document instead of duplicating its key', () => {
    const merged = mergeDocs(docs(3, 2, 1), docs(1, 0))
    expect(merged.map(row => row.doc_id)).toEqual([3, 2, 1, 0])
  })

  it('returns the SAME array when nothing is new', () => {
    const previous = docs(1)
    expect(mergeDocs(previous, docs(1))).toBe(previous)
  })
})
