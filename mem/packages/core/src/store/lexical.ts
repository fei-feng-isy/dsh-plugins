/**
 * The sync relevance probe behind the plugin's conditional hints (DESIGN §12).
 *
 * WHY THIS IS LEXICAL, AND WHY IT MUST BE SYNC. The hint has to be in place *before* the step's
 * prompt is assembled — `dsh-agent-loop`'s `preStep` calls `systemPrompt.assemble()` immediately
 * after the message is admitted, and the section/context provider that renders the hint is
 * SYNCHRONOUS (it cannot await). Of the retrieval legs, only the FTS one is synchronous: the
 * semantic leg needs an `encode()`, and a warm encode is ~10–20 ms, which loses the race and lands
 * the hint one step late — i.e. after the model already decided whether to call a tool. So the
 * gate is a lexical one, and paraphrase-style questions score 0 here. That is the accepted trade:
 * it stays SILENT when unsure, and the always-on usage sections remain the fallback that tells the
 * model to query anyway.
 *
 * THE BAR, AND HOW IT WAS MEASURED. Terms are latin/digit words of >= 5 chars plus every CJK
 * 3-gram (the FTS tables are trigram-tokenised, so a 2-char CJK term cannot be expressed and a
 * whitespace split leaves a whole Chinese sentence as ONE token — a single OR'd trigram query for
 * such a sentence matches incidentally and its bm25 rank is *not* discriminative: measured
 * -3.14 for an unrelated question vs -2.12 for a genuine one-word `cgroup` query). Counting how
 * many DISTINCT terms each store actually holds separates cleanly instead. Measured on the live
 * stores, 10 probes: the three genuinely-covered questions scored 6, 6 and 2 (`cgroup v2 的内存保护…`,
 * its question form, `MGLRU 是怎么回收页面的`), the seven uncovered ones scored 0 or 1 — including
 * an English question that matched common words — it scored 3 matched terms with a 4-char floor
 * (`unit`, `test`, `this`, `for`) and only 1 once the floor was 5 (`write`), so the floor alone
 * would not have saved it; BOTH the floor and the two-term bar are load-bearing. Hence
 * `matched >= 2`, with the margin between 2 and 1 rather than a tuned threshold inside a
 * continuum. A single-word query (`cgroup`) scores 1 and stays silent on purpose: one term is not
 * evidence.
 */

/** How many of an input's terms a store holds. `terms === 0` means the input had nothing to test. */
export interface LexicalProbe {
  terms: number
  matched: number
}

/**
 * Which stores hold something relevant — the ONE answer the plugin's hint layer consumes.
 *
 * A boolean on purpose: `kb_query` retrieves from BOTH stores, so the hint only has to decide
 * "worth mentioning or not". Which store matched is nobody's business downstream — and asking for
 * it cost a distinction the probe would have to keep alive in two places.
 */
export type RelevanceHit = boolean

/** Latin/digit words shorter than this are too common to be evidence (measured: `unit`, `test`). */
const MIN_LATIN = 5

/** Bound on the distinct terms tested, so the probe is a bounded number of `LIMIT 1` FTS queries. */
const MAX_TERMS = 24

const LATIN_RE = /[A-Za-z0-9_.]{2,}/g
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g

/**
 * The distinct terms of `text` that the FTS tables can express.
 *
 * Exported for the store probes and for the tests that pin the measured behaviour above; the
 * caller runs one `LIMIT 1` MATCH per term and counts the hits.
 */
export function relevanceTerms(text: string, cap = MAX_TERMS): string[] {
  const terms = new Set<string>()
  for (const word of text.match(LATIN_RE) ?? []) {
    if (word.length >= MIN_LATIN) terms.add(word.toLowerCase())
  }
  for (const run of text.match(CJK_RUN_RE) ?? []) {
    // 3-grams, because the trigram tokenizer cannot match a shorter CJK term at all.
    for (let i = 0; i + 3 <= run.length; i++) terms.add(run.slice(i, i + 3))
  }
  return [...terms].slice(0, cap)
}

/**
 * The gate itself: is this store worth telling the model about?
 *
 * Two distinct terms is the measured bar (see the module comment). Deliberately not "at least one"
 * — a single hit is what a common word produces — and deliberately not a score threshold, because
 * bm25 sums over OR'd terms and therefore rewards a long question for merely containing many
 * 3-grams.
 */
export function looksRelevant(probe: LexicalProbe): boolean {
  return probe.matched >= 2
}


/**
 * Count how many of `text`'s terms ONE store holds.
 *
 * The loop both stores used to carry verbatim. `holds` is handed the raw TERM, not a built MATCH
 * expression: turning a term into a query depends on the tokenizer the store's FTS table was actually
 * built with (see `db/tokenizer.ts`), which is the store's business, not this module's. Each store
 * asks its own table with `LIMIT 1` — the question is whether a term exists at all, not where it ranks. `stopAt` lets a caller that only asks "≥ 2?" stop early (`relevance()` does, and the prompt
 * path is synchronous); the default keeps an exact count for the calibration recorded above.
 */
export function probeTerms(
  text: string,
  holds: (term: string) => boolean,
  stopAt = Number.POSITIVE_INFINITY,
): LexicalProbe {
  const terms = relevanceTerms(text)
  let matched = 0
  for (const term of terms) {
    if (holds(term)) matched += 1
    if (matched >= stopAt) break
  }
  return { terms: terms.length, matched }
}
