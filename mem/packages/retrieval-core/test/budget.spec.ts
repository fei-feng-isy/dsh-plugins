import { describe, it, expect } from 'vitest'
import { fitToTokenBudget } from '../src/budget.js'
import { estimateTokens } from '../src/text_budget.js'

const hit = (text: string, score: number): { text: string; score: number } => ({ text, score })

describe('fitToTokenBudget', () => {
  it('returns the input untouched when no budget is set', () => {
    const items = [hit('中'.repeat(500), 0.9), hit('中'.repeat(500), 0.5)]
    const out = fitToTokenBudget(items, { maxTokens: 0 })
    expect(out.truncated).toBe(0)
    expect(out.kept.map((k) => k.text)).toEqual(items.map((i) => i.text))
    expect(out.used_tokens).toBe(1000)
  })

  it('gives every entry a share instead of letting the top hit eat the budget', () => {
    // Five hits, 100 tokens: the top hit is huge. It must NOT take all 100.
    const items = [hit('中'.repeat(400), 0.9), hit('文'.repeat(400), 0.8), hit('字'.repeat(400), 0.7)]
    const out = fitToTokenBudget(items, { maxTokens: 90 })
    expect(out.kept).toHaveLength(3)
    expect(out.used_tokens).toBeLessThanOrEqual(90)
    // cap = 90/3*2 = 60, so no single entry may exceed it.
    for (const entry of out.kept) expect(estimateTokens(entry.text)).toBeLessThanOrEqual(60)
    expect(out.truncated).toBe(3)
  })

  it('spends leftover budget deepening the best entries, best first', () => {
    // Three tiny hits + one long one. Pass 1 truncates the long one; pass 2 restores it.
    const items = [hit('短', 0.9), hit('句', 0.8), hit('子', 0.7), hit('长'.repeat(30), 0.6)]
    const out = fitToTokenBudget(items, { maxTokens: 40 })
    expect(out.used_tokens).toBeLessThanOrEqual(40)
    const long = out.kept[3]!
    expect(estimateTokens(long.text)).toBeGreaterThan(4) // it grew past the pass-1 cap
    expect(out.truncated).toBeLessThanOrEqual(1)
  })

  it('keeps an entry that fits no budget as a reference rather than dropping it', () => {
    const items = [hit('中'.repeat(50), 0.9), hit('尾', 0.5)]
    // 50 tokens for the first entry only leaves nothing for the second.
    const out = fitToTokenBudget(items, { maxTokens: 50, perEntryCap: 50 })
    expect(out.kept).toHaveLength(2)
    expect(out.kept[1]!.text).toBe('')
    expect(out.kept[1]!.truncated).toBe(true)
    expect(out.used_tokens).toBeLessThanOrEqual(50)
  })

  it('never exceeds the budget, and marks exactly what it shortened', () => {
    const items = Array.from({ length: 7 }, (_, i) => hit('文'.repeat(100 + i), 1 - i / 10))
    const out = fitToTokenBudget(items, { maxTokens: 210 })
    expect(out.used_tokens).toBeLessThanOrEqual(210)
    expect(out.truncated).toBeGreaterThan(0)
    for (const entry of out.kept) {
      if (entry.truncated !== true) expect(estimateTokens(entry.text)).toBeGreaterThan(0)
    }
    // A short entry that fit keeps its text verbatim.
    const small = fitToTokenBudget([hit('短句', 1)], { maxTokens: 100 })
    expect(small.kept[0]).toEqual({ text: '短句', score: 1 })
    expect(small.truncated).toBe(0)
  })

  it('does not stop deepening the later entries when one entry has no room left', () => {
    // Pass 2 walks the cut entries best-first. The FIRST one here is already within a token of
    // complete, which used to abort the whole loop (`break`) and strand the budget that the
    // LAST entry could have used. "This entry is done" and "there is nothing left to spend" are
    // different conditions.
    const items = [hit('x'.repeat(11), 0.9), hit('y', 0.8), hit('z'.repeat(40), 0.7)]
    const estimate = (t: string): number => t.length
    const out = fitToTokenBudget(items, { maxTokens: 30, perEntryCap: 10, estimate })
    expect(out.used_tokens).toBeLessThanOrEqual(30)
    // Pass 1 alone leaves the third entry at the per-entry cap (10 characters).
    expect(out.kept[2]!.text.length).toBeGreaterThan(12)
  })

  it('accepts an estimator override so a real tokenizer can replace the heuristic', () => {
    const out = fitToTokenBudget([hit('abcdefgh', 1)], { maxTokens: 3, estimate: (t) => t.length })
    expect(out.kept[0]!.truncated).toBe(true)
    expect((out.kept[0]!.text).length).toBeLessThanOrEqual(3)
  })
})
