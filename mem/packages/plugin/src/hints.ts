import type { RelevanceHit } from '@avantf/mem'

/**
 * The plugin's CONDITIONAL hint: ONE line, contributed only when either store already holds
 * something relevant to the message the user just sent (DESIGN §12).
 *
 * These are deliberately NOT part of the always-on usage sections. A usage section says WHEN a
 * store is worth consulting and therefore has to be paid for on every step of every session; this
 * says "there is something here, right now", which is only true sometimes. The two layers compose:
 * the section is the fallback for the paraphrase the lexical probe misses, and the hint is the
 * concrete nudge for the case it catches.
 *
 * ONE LINE FOR BOTH STORES, and it names ONE tool. `kb_query` is a cross-store retrieval (document
 * chunks AND memory facts), so a single line covers whichever store matched. Per-store lines used
 * to name two tools, which invited two overlapping calls — the memory facts came back twice, once
 * from `mem_recall` and again inside `kb_query`'s fused result — and made every memory↔knowledge
 * transition a fresh snapshot append. `mem_recall` remains the tool for the memory-only actions
 * (chain / probe / reason / contradict); the always-on memory usage section is where that is said.
 *
 * WHY THE LINE NAMES THE PLUGIN. This text is injected as runtime context, and the harness
 * materialises that as a USER-role snapshot in the conversation (`dsh-agent-loop`'s
 * `runtimeContext.project`). Without an author, a line like "记忆里有相关内容" reads as something
 * the user said. The `[avantf-mem]` prefix is what keeps the provenance honest.
 */

export const RELEVANCE_HINT =
  '[avantf-mem] 记忆或知识库里有与上条用户消息相关的内容；需要时用 `kb_query` 检索。'

/**
 * Map one answer to the contribution, as text.
 *
 * An empty string is the "contribute nothing" value: `renderContextSections` drops empty text, so
 * "nothing found" costs no tokens at all.
 */
export function hintText(hit: RelevanceHit): string {
  return hit ? RELEVANCE_HINT : ''
}

/**
 * The plain text of an inbox message, or `''` when it carries none.
 *
 * `dsh-agent-loop`'s own extractor returns `undefined` unless the message is exactly ONE text
 * block; a steered or multi-part message would then silently produce no hint. Concatenating the
 * text blocks keeps the probe working for those, and non-text blocks (images) are simply skipped —
 * the probe is lexical, so it has nothing to say about them anyway.
 */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: string; text?: unknown }
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .filter(Boolean)
    .join('\n')
}
