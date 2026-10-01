/**
 * Entity + SPO triples extraction. Uses nodejieba (optional dependency) for POS;
 * degrades gracefully to a character/regex fallback when unavailable, exactly like
 * the `jieba_available()` guard.
 *
 * Note: nodejieba's `tag()` returns `{ word, tag }` objects, and its POS flag set
 * differs from Python jieba (e.g. proper nouns → `nr`, 名动词 → `vn`).
 */

export interface ExtractedEntity {
  name: string
  type: string
  method: string
}

export interface ExtractedTriple {
  subj: string
  pred: string
  obj: string
  confidence: number
  source: string
}

export type PosToken = { word: string; tag: string }
type JiebaPosseg = { tag(text: string): PosToken[]; load?: () => void }

/**
 * The load, memoized as a PROMISE — not as its result.
 *
 * `mod.load()` parses nodejieba's dictionary synchronously on the main thread (~1 s measured), and
 * the assignment below happens before the first `await`, so concurrent callers hand back the SAME
 * in-flight promise instead of each running their own parse. Memoizing the result instead left a
 * window that the startup deferral (see `modelBootstrap`) deliberately widened: between the boot
 * signal and the warm-up's idle gate, a write would call this, see `undefined`, and parse a second
 * time — measured 2143 ms for two concurrent callers against 1000 ms for one.
 *
 * A FAILED load is cached too (the same one-attempt policy as before): a process whose jieba cannot
 * be imported uses the regex fallback for its lifetime rather than retrying on every write.
 */
let jiebaLoad: Promise<JiebaPosseg | null> | undefined
/** How many times the dictionary was actually parsed in this process (see `jiebaLoadAttempts`). */
let jiebaAttempts = 0

function loadJieba(): Promise<JiebaPosseg | null> {
  jiebaLoad ??= loadJiebaOnce()
  return jiebaLoad
}

/**
 * Attempts made so far — the mechanism, not the wall time.
 *
 * A wall-clock assertion would be machine-dependent, but "how many parses ran" is exact and is
 * what {@link loadJieba}'s promise-level memo exists to keep at one. The case that matters is
 * CONCURRENCY: a result-level memo looks correct to any sequential caller and only shows up when
 * two of them overlap.
 */
export function jiebaLoadAttempts(): number {
  return jiebaAttempts
}

async function loadJiebaOnce(): Promise<JiebaPosseg | null> {
  jiebaAttempts += 1
  try {
    const raw = (await import('nodejieba')) as unknown as {
      tag?: unknown
      load?: unknown
      default?: { tag?: unknown; load?: unknown }
    }
    const mod = (typeof raw.tag === 'function' ? raw : raw.default ?? raw) as JiebaPosseg
    if (typeof mod.load === 'function') mod.load()
    return mod
  } catch {
    return null
  }
}

export async function jiebaAvailable(): Promise<boolean> {
  return (await loadJieba()) !== null
}

/**
 * Version of the extraction RULES below (accepted tags, stop words, triple patterns).
 *
 * Persisted per chunk so a reindex can skip rows whose text is unchanged while still
 * rebuilding the ones produced by an older rule set. Bump this whenever a change here would
 * yield different entities/triples for the same text — it is the only thing that separates
 * "already extracted" from "extracted by the previous version" (DESIGN §20).
 */
export const ENTITY_EXTRACTOR_VERSION = 1

// Noun-ish POS flags usable as entities (nodejieba tag set).
const NOUN_FLAGS = new Set([
  'n', 'nr', 'nrfg', 'ns', 'nt', 'nz', 'nl', 'nw', 'j', 's', 'an', 'b', 'a',
])
// Proper nouns and bare CJK/latin runs are treated as entities too.
const ENTITY_EXTRA = new Set(['x', 'eng', 'nrt', 'zg'])

// Strict verbs (predicates). `vn` (名动词) is weak — only used as fallback.
const STRICT_VERB = new Set(['v', 'vd', 'vg', 'vf', 'vx', 'vi', 'vl', 'vq'])
const WEAK_VERB = new Set(['vn'])
const STOP_PREDS = new Set(['是', '有', '做', '来', '去', '说', '会', '要', '想', '让', '作为', '进行', '可以', '应该', '成为', '属于'])
const NEGATIONS = ['不', '没', '没有', '未', '别', '无需']
const ASPECT_SUFFIXES = ['了', '着', '过']

// Interrogative words: the corresponding slot becomes a wildcard in a query pattern.
const INTERROGATIVES = new Set([
  '谁', '什么', '哪个', '哪些', '哪儿', '哪里', '何', '何时', '何处',
  '多少', '几', '几点', '几时', '怎么', '怎样', '如何', '多久', '什么时候',
])

export interface TriplePattern {
  subj?: string
  pred?: string
  obj?: string
}

/**
 * POS-tag `text` ONCE, or `null` when nodejieba is unavailable (callers fall back to regex).
 *
 * Exists so one write can drive BOTH extractors from a single `jieba.tag()` call: `add`/`update`
 * used to tag the same content twice (once for entities, once for triples), which is pure repeated
 * mission — measured ~1.1 ms per 1000 characters per pass.
 */
export async function tagText(text: string): Promise<PosToken[] | null> {
  const jieba = await loadJieba()
  return jieba ? jieba.tag(text) : null
}

/**
 * Entities from ALREADY-TAGGED tokens (`null` = tagger unavailable → regex fallback on `text`).
 *
 * The token array is passed in rather than re-derived, so a caller that needs entities AND triples
 * pays for one tagging pass (see `tagText`).
 */
export function entitiesFromTokens(tokens: PosToken[] | null, text: string): ExtractedEntity[] {
  if (tokens === null) return regexEntities(text)
  const seen = new Set<string>()
  const out: ExtractedEntity[] = []
  for (const { word, tag } of tokens) {
    const w = word.trim()
    if (!w || w.length < 2) continue
    if (!NOUN_FLAGS.has(tag) && !ENTITY_EXTRA.has(tag)) continue
    if (seen.has(w)) continue
    seen.add(w)
    out.push({ name: w, type: tag, method: 'jieba' })
  }
  return out
}

/** Extract entity names using nodejieba POS when available, else a regex fallback. */
export async function extractEntities(text: string): Promise<ExtractedEntity[]> {
  return entitiesFromTokens(await tagText(text), text)
}

function regexEntities(text: string): ExtractedEntity[] {
  const seen = new Set<string>()
  const out: ExtractedEntity[] = []
  const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  const latin = text.match(/[A-Za-z0-9_.-]{2,}/g) ?? []
  for (const m of cjk) {
    if (!seen.has(m)) {
      seen.add(m)
      out.push({ name: m, type: 'n', method: 'regex' })
    }
  }
  for (const m of latin) {
    if (!seen.has(m)) {
      seen.add(m)
      out.push({ name: m, type: 'eng', method: 'regex' })
    }
  }
  return out
}

/**
 * SPO triples from ALREADY-TAGGED tokens (`null` = tagger unavailable → no triples, as before).
 *
 * `pos` is exported alongside `entitiesFromTokens` so the write path can tag once and drive both.
 */
export function triplesFromTokens(rawTokens: PosToken[] | null): ExtractedTriple[] {
  if (rawTokens === null) return []
  const tokens = rawTokens.filter((t) => t.word.trim()).map((t) => ({ word: t.word.trim(), tag: t.tag }))
  if (tokens.length < 2) return []

  // Prefer strict verbs; if they yield no triple, fall back to `vn` (名动词) / preposition.
  const strictIdx = predIndices(tokens, (tag) => STRICT_VERB.has(tag))
  const weakIdx = predIndices(tokens, (tag) => WEAK_VERB.has(tag) || tag === 'p')

  const out: ExtractedTriple[] = []
  const seen = new Set<string>()
  const tryCandidates = (candidates: number[]) => {
    for (const i of candidates) {
      const { word, tag } = tokens[i]
      let pred = word.trim()
      if (i > 0 && NEGATIONS.includes(tokens[i - 1].word)) pred = tokens[i - 1].word + pred
      pred = stripAspect(pred)
      if (!pred || STOP_PREDS.has(pred) || pred.length < 2) continue

      const subj = mergeLeft(tokens, i - 1)
      const obj = mergeRight(tokens, i + 1)
      if (!subj || !obj || subj === obj || subj.length < 2 || obj.length < 2) continue
      if (seen.has(`${subj}|${pred}|${obj}`)) continue
      seen.add(`${subj}|${pred}|${obj}`)
      out.push({ subj, pred, obj, confidence: 0.5, source: 'heuristic' })
      if (out.length >= 8) return
    }
  }
  tryCandidates(strictIdx)
  if (out.length === 0) tryCandidates(weakIdx)
  return out
}

/** Extract a few SPO triples via a simplified SVO heuristic. Returns [] when jieba unavailable. */
export async function extractTriples(text: string): Promise<ExtractedTriple[]> {
  return triplesFromTokens(await tagText(text))
}

function predIndices(tokens: PosToken[], predicate: (tag: string) => boolean): number[] {
  const idx: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (predicate(tokens[i].tag)) {
      const prev = tokens[i - 1]?.tag
      if (prev === 'vn') continue // seriatim verb: keep the first
      idx.push(i)
    }
  }
  return idx
}

function stripAspect(pred: string): string {
  for (const s of ASPECT_SUFFIXES) {
    if (pred.length > s.length && pred.endsWith(s)) return pred.slice(0, -s.length)
  }
  return pred
}

function isArg(tag: string): boolean {
  return NOUN_FLAGS.has(tag) || tag === 'vn' || tag === 'x' || tag === 'eng'
}

function mergeLeft(tokens: PosToken[], end: number): string {
  const parts: string[] = []
  for (let i = end; i >= 0; i--) {
    const { word: w, tag: f } = tokens[i]
    if (isArg(f)) {
      parts.unshift(w)
    } else if (w === '的' && parts.length) {
      parts.unshift(w)
    } else if (['ul', 'u', 'y', 'd', 'a', 'ad', 'c', 'p'].includes(f)) {
      continue
    } else {
      break
    }
  }
  return parts.join('').replace(/^的|的$/g, '').trim()
}

function mergeRight(tokens: PosToken[], start: number): string {
  const parts: string[] = []
  for (let i = start; i < tokens.length; i++) {
    const { word: w, tag: f } = tokens[i]
    if (isArg(f)) {
      parts.push(w)
    } else if (w === '的' && parts.length) {
      parts.push(w)
    } else if (['ul', 'u', 'y', 'd', 'a', 'ad', 'c', 'p'].includes(f)) {
      continue
    } else {
      break
    }
  }
  return parts.join('').replace(/^的|的$/g, '').trim()
}

// ─── query pattern (ask: direction-aware) ──────────────────────────────────

/** Merge an argument from `start` along `dir`, stopping at an interrogative (wildcard slot). */
function mergeArg(tokens: PosToken[], start: number, dir: 1 | -1): string {
  const parts: string[] = []
  let i = start
  while (i >= 0 && i < tokens.length) {
    const { word: w, tag: f } = tokens[i]
    if (INTERROGATIVES.has(w)) break
    if (isArg(f)) {
      parts.push(w)
    } else if (w === '的' && parts.length) {
      parts.push(w)
    } else if (['ul', 'u', 'y', 'd', 'a', 'ad', 'c', 'p'].includes(f)) {
      if (!parts.length) { i += dir; continue }
    } else {
      break
    }
    i += dir
  }
  if (!parts.length) return ''
  if (dir < 0) parts.reverse()
  return parts.join('').replace(/^的|的$/g, '').trim()
}

function cleanArg(arg: string): string | undefined {
  const a = arg.trim().replace(/^的|的$/g, '')
  if (a.length < 2 || INTERROGATIVES.has(a)) return undefined
  return a
}

/**
 * Parse a natural-language question into a direction-aware TriplePattern where
 * interrogative slots are wildcards (`undefined`).
 * `parse_query_pattern`: predicates anchor to the interrogative, and no literal
 * interrogative word fills a slot.
 *
 *   「李娜管理谁」 → { subj: '李娜', pred: '管理' }
 *   「谁管理李娜」 → { pred: '管理', obj: '李娜' }
 */
export async function parseQueryPattern(query: string): Promise<TriplePattern> {
  const jieba = await loadJieba()
  if (!jieba || !query.trim()) return {}
  const tokens = jieba.tag(query.trim()).filter((t) => t.word.trim()).map((t) => ({ word: t.word.trim(), tag: t.tag }))
  if (tokens.length < 2) return {}

  const qPositions = tokens.map((t, i) => (INTERROGATIVES.has(t.word) ? i : -1)).filter((i) => i >= 0)
  const strictIdx = predIndices(tokens, (t) => STRICT_VERB.has(t))
  const weakIdx = strictIdx.length ? [] : predIndices(tokens, (t) => WEAK_VERB.has(t) || t === 'p')
  const candidates = strictIdx.length ? strictIdx : weakIdx

  let best: TriplePattern | undefined
  let bestKey = -Infinity
  let predOnly: TriplePattern | undefined

  for (const i of candidates) {
    const { word, tag } = tokens[i]
    let pred = word.trim()
    if (i > 0 && NEGATIONS.includes(tokens[i - 1].word)) pred = tokens[i - 1].word + pred
    pred = stripAspect(pred)
    if (!pred || STOP_PREDS.has(pred) || pred.length < 2) continue
    const subj = cleanArg(mergeArg(tokens, i - 1, -1))
    const obj = cleanArg(mergeArg(tokens, i + 1, 1))
    const candidate: TriplePattern = { pred, ...(subj ? { subj } : {}), ...(obj ? { obj } : {}) }
    if (!subj && !obj) {
      if (!predOnly) predOnly = { pred }
      continue
    }
    const filled = (subj ? 1 : 0) + (obj ? 1 : 0)
    let key = filled * 1000
    if (qPositions.length) key -= Math.min(...qPositions.map((q) => Math.abs(q - i)))
    if (key > bestKey) {
      best = candidate
      bestKey = key
    }
  }
  return best ?? predOnly ?? {}
}
