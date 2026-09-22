/**
 * Output budgeting for retrieved context (DESIGN §20).
 *
 * A retrieval result is not free: `limit` bounds how many hits, never how much TEXT, so a broad
 * query could put tens of thousands of characters into a model's context while a narrow one put
 * in a paragraph. Scores cluster in a narrow band, so spending the whole budget on the top hit is
 * a bad bet as well — every candidate gets a share first, and only leftover budget deepens the
 * best ones (the reference design's breadth-then-depth, with a single tier).
 *
 * Two properties are deliberate:
 *
 *  - the budget degrades TEXT, never the entry: a hit that fits no budget keeps its identity
 *    (`source_ref`), so a caller can still fetch it explicitly instead of not knowing it existed;
 *  - truncation is VISIBLE (`truncated: true` on the hit), unlike the silent truncation this
 *    codebase had at the embedding boundary.
 */
import { estimateTokens, truncateToTokens } from './text_budget.js'

/** What the budget needs from a candidate: ranked text. */
export interface BudgetInput {
  text: string
  score: number
}

export interface BudgetOptions {
  /** Total tokens to spend; `0` (or negative) means "no budget" and returns the input untouched. */
  maxTokens: number
  /** Ceiling for one entry; defaults to twice the average share. */
  perEntryCap?: number
  /** Token estimator override (tests, or a real tokenizer). */
  estimate?: (text: string) => number
}

export interface Budgeted<T> {
  kept: T[]
  used_tokens: number
  /** Entries whose text was shortened (including those left with no text at all). */
  truncated: number
}

/**
 * Fit `items` into `maxTokens`, preserving their (ranked) order.
 *
 * Pass 1 gives every entry `min(perEntryCap, remaining)`. Pass 2 spends what is left growing the
 * entries that were cut, best first. An entry that receives no budget keeps an empty `text` and
 * `truncated: true` — dropping it would hide its existence, which is worse than showing a
 * reference to it.
 */
export function fitToTokenBudget<T extends BudgetInput>(items: readonly T[], opts: BudgetOptions): Budgeted<T & { truncated?: boolean }> {
  const estimate = opts.estimate ?? estimateTokens
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) {
    return { kept: items.map((item) => ({ ...item })), used_tokens: items.reduce((n, i) => n + estimate(i.text), 0), truncated: 0 }
  }
  const maxTokens = Math.floor(opts.maxTokens)
  if (items.length === 0) return { kept: [], used_tokens: 0, truncated: 0 }

  const cap = Math.max(1, Math.floor(opts.perEntryCap ?? (maxTokens / items.length) * 2))
  const kept: (T & { truncated?: boolean })[] = []
  let used = 0
  let truncated = 0
  // Costs of what each entry currently holds, so pass 2 can grow them without re-measuring.
  const held: number[] = []

  for (const item of items) {
    const full = estimate(item.text)
    const share = Math.min(cap, maxTokens - used)
    if (full <= share) {
      kept.push({ ...item })
      used += full
      held.push(full)
      continue
    }
    if (share <= 0) {
      kept.push({ ...item, text: '', truncated: true })
      held.push(0)
      truncated += 1
      continue
    }
    const cut = truncateToTokens(item.text, share, { estimate })
    const cost = estimate(cut.text)
    kept.push({ ...item, text: cut.text, truncated: true })
    used += cost
    held.push(cost)
    truncated += 1
  }

  // Pass 2: leftover budget deepens the best entries that were cut, in order.
  let leftover = maxTokens - used
  for (let i = 0; i < kept.length && leftover > 0; i++) {
    const entry = kept[i]!
    if (entry.truncated !== true) continue
    const full = estimate(items[i]!.text)
    const room = full - held[i]!
    // Two different reasons to skip, and only one of them is worth stopping for: THIS entry may
    // be essentially complete (later entries can still grow), or there may be too little budget
    // left to be worth a re-cut for anyone.
    if (room < 4) continue
    if (leftover < 4) break
    const cut = truncateToTokens(items[i]!.text, held[i]! + Math.min(leftover, room), { estimate })
    const cost = estimate(cut.text)
    entry.text = cut.text
    entry.truncated = cost < full
    used += cost - held[i]!
    held[i] = cost
    leftover = maxTokens - used
  }

  // Entries that pass 2 restored completely are no longer truncated.
  const stillTruncated = kept.filter((entry) => entry.truncated === true).length
  return { kept, used_tokens: used, truncated: stillTruncated }
}
