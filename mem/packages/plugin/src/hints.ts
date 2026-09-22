import type { RelevanceHit } from '@avantf/mem'

/**
 * The plugin's CONDITIONAL hints: one line per store, contributed only when that store already
 * holds something relevant to what the user just sent (DESIGN §12).
 *
 * These are deliberately NOT part of the always-on usage sections. A usage section says WHEN a
 * store is worth consulting and therefore has to be paid for on every step of every session; this
 * says "there is something here, right now", which is only true sometimes. The two layers compose:
 * the section is the fallback for the paraphrase the lexical probe misses, and the hint is the
 * concrete nudge for the case it catches.
 *
 * ONE LINE PER STORE, never a merged sentence. The two stores answer different questions and
 * either can be the relevant one, so `RelevanceHit` is a closed four-valued answer and each store
 * gets its own contribution — a caller can then see, and later tune or drop, one without the other.
 *
 * WHY EACH LINE NAMES THE PLUGIN. This text is injected as runtime context, and the harness
 * materialises that as a USER-role snapshot in the conversation (`dsh-agent-loop`'s
 * `runtimeContext.project`). Without an author, a line like "记忆里有相关内容" reads as something
 * the user said. The `[avantf-mem 插件]` prefix is what keeps the provenance honest.
 */

export const MEMORY_HINT = '[avantf-mem 插件] 记忆里有与本次提问相关的事实；需要时用 `mem_recall` 检索。'

export const KNOWLEDGE_HINT = '[avantf-mem 插件] 知识库里有与本次提问相关的内容；需要时用 `kb_query` 检索。'

/**
 * Map one answer to the two contributions, as text.
 *
 * An empty string is the "contribute nothing" value: `renderPrompt`/`renderContextSections` drop
 * empty text, so `none` (and the missing half of `memory`/`knowledge`) costs no tokens at all.
 */
export function hintLines(hit: RelevanceHit): { memory: string; knowledge: string } {
  return {
    memory: hit === 'memory' || hit === 'both' ? MEMORY_HINT : '',
    knowledge: hit === 'knowledge' || hit === 'both' ? KNOWLEDGE_HINT : '',
  }
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
