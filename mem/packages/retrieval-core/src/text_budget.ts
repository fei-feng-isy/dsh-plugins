/**
 * Token budgets for every MODEL-FACING text path (embedder input, reranker pair, retrieval
 * output). See DESIGN §20.
 *
 * Why this exists: the shipped ONNX models have a hard input window (`bge-small-zh-v1.5` and
 * `bge-reranker-base`: 512 tokens) and transformers.js truncates SILENTLY past it —
 * `feature-extraction` and `text-classification` both tokenize with `truncation: true` and
 * default `max_length` to the tokenizer's `model_max_length`. A Chinese chunk of 800
 * characters is roughly 800 tokens, so a large tail of every chunk never reached the encoder
 * and never appeared in its vector — with no exception and no log line.
 *
 * The budget itself belongs to whichever model is loaded, so this module only provides the
 * MECHANISM (estimate → truncate → resolve the effective window); adapters apply it and
 * decide what to log. Estimation is intentionally dependency-free: a real tokenizer would
 * mean loading the model to decide whether the model can read the text.
 */
import { DEFAULT_MODEL_WINDOW_TOKENS } from '@avantf/mem-contract'

/**
 * Ranges a char-level CJK tokenizer emits one token per: CJK ideographs (+ Ext A, compat),
 * kana, hangul, and the CJK/fullwidth PUNCTUATION blocks (。、《》 and ，！？；： — U+3000-303F
 * and U+FF00-FFEF). Everything else is estimated at 4 characters per token, which is the
 * usual sub-word ratio for Latin text and digits.
 *
 * The punctuation blocks are in here because leaving them out UNDER-estimated Chinese text at a
 * quarter of their real cost — the opposite of this module's stated bias — while {@link BREAK}
 * below already treated the very same characters as first-class boundaries.
 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/

/** Sentence/clause terminators used to avoid cutting mid-sentence when a boundary is near. */
const BREAK = new Set(['\n', '。', '！', '？', '；', '，', '.', '!', '?', ';', ',', '、'])

/**
 * Some tokenizers declare `model_max_length` as a sentinel (1e30 in the RoBERTa family)
 * rather than a real limit; treat anything above this as "not declared".
 */
const SENTINEL_WINDOW = 100_000

/** Window assumed when neither the config nor the loaded model declares one. */
export const DEFAULT_MODEL_WINDOW = DEFAULT_MODEL_WINDOW_TOKENS

/** Roughly how many tokens CJK text yields per character (used by the chunk-size derivation). */
export const CJK_TOKENS_PER_CHAR = 1

/**
 * Estimate the token count of `text`.
 *
 * Deliberately an OVER-estimate for mixed text: under-estimating is what silently drops
 * content past the window, while over-estimating only truncates slightly earlier.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1
    else if (ch.trim() !== '') other += 1
  }
  return cjk + Math.ceil(other / 4)
}

export interface TruncatedText {
  /** The bounded text (equals the input when it already fit). */
  text: string
  truncated: boolean
  /** Estimated tokens dropped, for the log line. */
  omittedTokens: number
}

/**
 * Bound `text` to `maxTokens`, preferring a sentence/clause boundary near the cut and
 * appending `marker` so the truncation is VISIBLE rather than silent.
 *
 * The marker's own cost is reserved out of the budget, and the result is verified against
 * `maxTokens` before returning (the estimator rounds up per character class, so a naive
 * character walk can land one token over).
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  opts: { marker?: string; estimate?: (text: string) => number } = {},
): TruncatedText {
  const estimate = opts.estimate ?? estimateTokens
  const marker = opts.marker ?? '…'
  const limit = Math.max(0, Math.floor(maxTokens))
  const full = estimate(text)
  if (full <= limit) return { text, truncated: false, omittedTokens: 0 }
  // Nothing meaningful fits: a lone character (or the marker alone) is not worth returning as
  // text, and returning it would break the "never exceeds the budget" guarantee callers rely on.
  if (limit < 2) return { text: '', truncated: true, omittedTokens: full }

  const chars = Array.from(text)
  const markerCost = estimate(marker)
  // One extra token of slack absorbs the estimator's per-class rounding.
  const budget = Math.max(1, limit - markerCost - 1)

  let used = 0
  let cut = 0
  for (const ch of chars) {
    const cost = CJK.test(ch) ? 1 : ch.trim() === '' ? 0 : 0.25
    if (used + cost > budget) break
    used += cost
    cut += 1
  }
  // Prefer the last sentence/clause break in the final quarter, when there is one.
  const floor = Math.floor(cut * 0.75)
  for (let i = cut - 1; i >= floor; i--) {
    if (BREAK.has(chars[i])) {
      cut = i + 1
      break
    }
  }
  let head = chars.slice(0, cut).join('')
  // The estimator rounds per character class, so trim until head + marker provably fits.
  while (head.length > 0 && estimate(head + marker) > limit) head = Array.from(head).slice(0, -1).join('')
  if (head.length === 0) return { text: '', truncated: true, omittedTokens: full }

  const out = head + marker
  return { text: out, truncated: true, omittedTokens: Math.max(0, full - estimate(head)) }
}

/**
 * Resolve the effective input window for a loaded model.
 *
 * @param configured - `0` (or negative) means "auto: use the model's declared window".
 *                     A positive value is an operator cap and is CLAMPED to the declared
 *                     window when the model declares one, so `max_input_tokens` can never
 *                     push text past what the model can actually read.
 * @param declared - `model_max_length` reported by the loaded tokenizer, if any.
 * @param fallback - used when neither is available.
 */
export function resolveWindow(
  configured: number,
  declared: number | undefined,
  fallback: number = DEFAULT_MODEL_WINDOW,
): number {
  const known = typeof declared === 'number' && Number.isFinite(declared) && declared > 0 && declared <= SENTINEL_WINDOW
    ? Math.floor(declared)
    : undefined
  if (Number.isFinite(configured) && configured > 0) {
    return known === undefined ? Math.floor(configured) : Math.min(Math.floor(configured), known)
  }
  return known ?? fallback
}

/**
 * Read the declared window off a transformers.js pipeline. The pipeline is typed as a bare
 * function in the adapters, so this probes defensively and treats a sentinel as absent.
 */
export function declaredWindowOf(pipe: unknown): number | undefined {
  const tokenizer = (pipe as { tokenizer?: { model_max_length?: unknown } } | null | undefined)?.tokenizer
  const value = tokenizer?.model_max_length
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > SENTINEL_WINDOW) return undefined
  return Math.floor(value)
}

/**
 * Characters of a chunk that fit the window for `window` tokens, minus the per-chunk
 * overhead (`specialTokens` for CLS/SEP). Used to derive `knowledge.chunk_size` so the
 * default chunking is justified by the shipped model's window instead of by feel.
 */
export function windowChars(window: number, specialTokens = 2): number {
  return Math.max(1, Math.floor((window - specialTokens) / CJK_TOKENS_PER_CHAR))
}
