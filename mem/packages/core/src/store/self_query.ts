/**
 * Query-side SELF-REFERENCE rewriting (方案 A, `mem/docs/SELF_QUERY_RELEVANCE.md` §4-A).
 *
 * THE PROBLEM. The corpus writes the user in the THIRD person ("用户的名字是…"), the user asks in
 * the FIRST ("我是谁？" / "我的名字"). On the measured model that costs 0.15–0.24 of cosine and,
 * worse, the two sides share NO lexical term — so the FTS and entity legs contribute exactly
 * nothing and the semantic leg has to carry the whole decision. Rewriting the query onto the
 * canonical third-person form the corpus is written in is the one measured change that lifts this
 * family of questions over the strict bar (0.685 / 0.677 / 0.626 vs 0.476 / 0.459 / 0.420).
 *
 * WHAT THIS MODULE IS, AND IS NOT. A pure string table: cues (substrings) → ONE canonical rewrite.
 * No model, no tokenizer, no await, no I/O — that is what lets the SAME table serve the synchronous
 * conditional hint (`runtime.relevance`, 方案 A②) and the async retrieval path (`store/hybrid.ts`).
 *
 * WHY THE TABLE IS CLOSED AND WHY ONLY ONE REWRITE. The first match wins and produces exactly one
 * canonical string. Chinese self-reference has unbounded variants ("我叫啥" / "本人是" / "我是干啥的"),
 * so no closed table can recognize all of them; keeping the OUTPUT set closed (one canonical form per
 * intent) bounds the cost and keeps the fused numbers comparable across queries. Recognizing more
 * variants is a job for the (future) slot/structured work, not for an ever-growing cue list.
 *
 * WHY A WRONG MATCH IS AFFORDABLE. The rewrite is applied as AUGMENTATION, never replacement
 * (`store/hybrid.ts`): the original query still runs and its candidates are still kept, so a false
 * positive can only ADD recall — it can never change what the user actually asked. That is also why
 * the cues can be a little generous: the measured cost of over-matching is "one more leg run", where
 * the cost of under-matching is the failure this whole file exists to remove.
 *
 * @module store/self_query
 */

/** One intent: any of `cues` present ⇒ this intent, rewritten to `rewrite`. */
export interface SelfQueryRule {
  /**
   * Substring cues, matched case-sensitively against the raw query. Deliberately plain strings
   * (no regex) — the table stays readable and cheap to extend, and matching cannot backtrack.
   */
  readonly cues: readonly string[]
  /** The ONE canonical third-person form this intent rewrites to. */
  readonly rewrite: string
}

/**
 * The intent table. ORDER IS LOAD-BEARING: the first rule with a matching cue wins, so a more
 * specific intent must precede a broader one that would also match (e.g. the occupation forms sit
 * before the bare identity cue). All cues are first-person ("我") or the formal self-reference
 * "本人"; nothing here can match a question about somebody else.
 */
export const SELF_QUERY_RULES: readonly SelfQueryRule[] = [
  {
    // "我是做什么的" / "我是干啥的" — the corpus writes this as "用户是做什么的".
    cues: ['我是做什么的', '我是干什么的', '我是干啥的', '我是做哪行的', '我的职业', '我的工作'],
    rewrite: '用户是做什么的',
  },
  {
    // The name intent, and the one the two H KNOWN GAPs ("我叫啥" / "本人是谁") fall into.
    // These are QUESTION forms on purpose — a bare "我叫" would also match "我叫他别忘了…", and the
    // hint path (`relevance`) runs on every user message, where a false positive is pure noise.
    cues: ['我的名字', '我叫什么', '我叫啥', '我的姓名', '我叫什么名字'],
    rewrite: '用户的名字',
  },
  {
    // "本人是谁" is the formal self-reference; it shares no cue with the name forms above.
    cues: ['我是谁', '本人是谁', '我是什么人', '本人是什么人'],
    rewrite: '用户是谁',
  },
  {
    cues: ['我在哪', '我在哪里', '我住在哪', '我的位置', '我的所在地'],
    rewrite: '用户在哪里',
  },
  {
    cues: ['我的偏好', '我喜欢什么', '我的喜好', '我的习惯'],
    rewrite: '用户的偏好',
  },
]

/**
 * The ONE canonical rewrite for `text`, or `undefined` when the input is not self-referential.
 *
 * `undefined` (not `text`) is the "nothing to add" answer on purpose: the retrieval path keys
 * "run a second leg set" off it, and returning the input unchanged would make every query pay for
 * an augmentation that cannot add anything.
 */
export function selfQueryRewrite(text: string): string | undefined {
  const query = text.trim()
  if (query === '') return undefined
  for (const rule of SELF_QUERY_RULES) {
    for (const cue of rule.cues) {
      if (query.includes(cue)) return rule.rewrite
    }
  }
  return undefined
}
