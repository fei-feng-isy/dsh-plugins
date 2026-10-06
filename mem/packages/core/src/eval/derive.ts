/**
 * Deterministic query-derivation engine for the P-02 regression net.
 *
 * The shipped 41-query fixture is frozen to the last bit, so it cannot grow to cover a new
 * pathology without re-freezing seven numbers. This engine derives NEW queries from a corpus
 * instead, with no model and no clock: the same facts + seed always produce byte-identical cases.
 *
 * What it derives, per gold fact:
 *  - one query assembled from the gold's SHARED literal fragments plus a bridge fragment the gold
 *    does NOT contain (so the query is never answered by simply echoing the gold's own text);
 *  - one planted, unrelated, LONG carrier fact that literally contains the bridge (requirement ②);
 *  - the collision rate of the query against the non-gold facts;
 *  - the counterfactual arm (requirement ③): removing the carrier must put the gold back at rank 1.
 *
 * The two guards:
 *  - `no_time_word`: an emitted query may not contain a time expression (a temporal query belongs to
 *    a different leg, and would confound "did the ranking change?" with "did the clock move").
 *    Offending candidates are DROPPED and counted, not silently kept.
 *  - `irrelevant`: a negative-control query that shares no fragment with any fact; a retriever that
 *    answers it is returning something for nothing.
 *
 * Requirement ① (a corpus with the real store's length distribution) is served by
 * {@link synthesizeCorpus}, whose output mirrors the measured profile in
 * `docs/bench/BASELINE_REPORT.md` §0.1 (9 / 243 / 313 / 409 / 882 characters); {@link analyzeCorpus}
 * reports how close a corpus actually is so the caller can assert it rather than trust it.
 */

export interface LengthProfile {
  min: number
  p25: number
  median: number
  p75: number
  max: number
}

/**
 * The measured ACTIVE-corpus shape on 2026-10-06 (`docs/bench/BASELINE_REPORT.md` §0.1:
 * 86 active, min/p25/median/p75/max = 9/243/313/409/882 characters). Frozen here so a fixture can
 * be checked against the real store's shape instead of against a guess.
 */
export const REAL_LENGTH_PROFILE: LengthProfile = { min: 9, p25: 243, median: 313, p75: 409, max: 882 }

export interface CorpusAnalysis {
  n: number
  length_profile: LengthProfile
  /** Fraction of facts whose length falls inside the real p25..p75 band. */
  in_band_rate: number
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export function lengthProfileOf(lengths: readonly number[]): LengthProfile {
  if (lengths.length === 0) return { min: 0, p25: 0, median: 0, p75: 0, max: 0 }
  const sorted = [...lengths].sort((a, b) => a - b)
  return {
    min: sorted[0],
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    max: sorted[sorted.length - 1],
  }
}

export function analyzeCorpus(facts: readonly string[]): CorpusAnalysis {
  const lengths = facts.map((f) => [...f].length)
  const profile = lengthProfileOf(lengths)
  const inBand = lengths.filter((n) => n >= REAL_LENGTH_PROFILE.p25 && n <= REAL_LENGTH_PROFILE.p75).length
  return { n: facts.length, length_profile: profile, in_band_rate: facts.length === 0 ? 0 : inBand / facts.length }
}

/** mulberry32 — small, fast, and fully determined by its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The literal unit of collision: latin/digit words of length ≥ 2, and CJK bigrams.
 *
 * Bigrams are the CJK unit on purpose — it is what a trigram FTS index cannot fully guard, and it
 * is exactly the granularity of the 2026-10-04 self-referential ranking incident (`用户是`, a
 * fragment an unrelated note happened to contain).
 */
export function fragmentsOf(text: string): string[] {
  const out = new Set<string>()
  for (const word of text.match(/[A-Za-z0-9_.-]{2,}/g) ?? []) out.add(word.toLowerCase())
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    const chars = [...run]
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1])
  }
  return [...out]
}

/** Time expressions that disqualify a derived query (see the module comment). */
const TIME_WORDS = [
  '今天', '昨天', '前天', '明天', '后天', '本周', '上周', '下周', '这个月', '上个月', '下个月',
  '今年', '去年', '明年', '最近', '刚才', '早上', '上午', '下午', '晚上',
] as const

export function timeWordsIn(text: string): string[] {
  return TIME_WORDS.filter((word) => text.includes(word))
}

/** Unrelated filler used to pad a planted carrier to a realistic length. */
const FILLER_SENTENCES = [
  '生产环境的部署流程已经冻结，发布窗口定在每周三凌晨，回滚脚本必须先在预发环境演练通过。',
  '监控面板聚合节点存活、队列积压与连接池占用三项指标，任一指标越阈值就触发告警。',
  '数据库主从延迟的排查手册要求先看复制线程状态，再核对慢查询日志，最后比对两侧的行数。',
  '缓存策略统一改为写穿，热点键的过期时间在写入时随机抖动，避免同一时刻大面积失效。',
  '归档任务每天凌晨启动，把超过保留期的会话记录搬到冷存储，冷存储的读取路径单独限流。',
  '容量评审每月一次，按最近四周的峰值水位留出两成余量，新增依赖必须补齐演练与回滚预案。',
] as const

export type GuardKind = 'none' | 'no_time_word' | 'irrelevant'

export interface DerivedQuery {
  query: string
  k: number
  /** Index of the gold fact in `setup_facts`, or null for a negative-control query. */
  gold_index: number | null
  must_include: number[]
  must_exclude: number[]
  guard: GuardKind
  /** The literal fragments the query is built from. */
  fragments: string[]
  /** Fraction of the NON-gold facts that literally share at least one query fragment. */
  collision_rate: number
  /** Index of the planted fragment carrier in `setup_facts`, when this query has one. */
  carrier_index: number | null
}

export interface CollisionSelfCheck {
  query_index: number
  carrier_index: number
  gold_index: number
  /** The fixture is only meaningful if the carrier actually outranks the gold in the base arm. */
  base_carrier_before_gold: boolean
  /** …and if removing it puts the gold first (the counterfactual arm). */
  counterfactual_gold_top1: boolean
}

export interface DerivedCase {
  id: string
  setup_facts: string[]
  queries: DerivedQuery[]
  analysis: CorpusAnalysis
  collision: CollisionSelfCheck | null
  guards: {
    /** Candidates dropped because they contained a time expression (cumulative across the suite). */
    no_time_word_dropped: number
    /** Negative-control queries emitted. */
    irrelevant_queries: number
  }
}

export interface DeriveOptions {
  seed?: number
  /** Maximum number of gold facts to derive a case from. */
  maxGolds?: number
  /** Shared fragments folded into one query. */
  fragmentsPerQuery?: number
  /** Target character length of a planted carrier (default: the real store's p75). */
  carrierLength?: number
}

/** A deterministic nonce that is guaranteed absent from `facts`. */
function freshNonce(seed: number, salt: number, facts: readonly string[]): string {
  const random = rng(seed + salt * 7919)
  for (let attempt = 0; attempt < 64; attempt++) {
    const nonce = `zq${Math.floor(random() * 0xfffffff).toString(36)}`
    if (!facts.some((f) => f.toLowerCase().includes(nonce))) return nonce
  }
  return `zq${String(seed)}${String(salt)}x`
}

function padTo(prefix: string, target: number, salt: number): string {
  let text = prefix
  let i = 0
  while ([...text].length < target) {
    text += FILLER_SENTENCES[(i + salt) % FILLER_SENTENCES.length]
    i++
  }
  return text
}

/** Document frequency of every fragment across the corpus. */
function fragmentDf(facts: readonly string[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const fact of facts) {
    for (const fragment of fragmentsOf(fact)) df.set(fragment, (df.get(fragment) ?? 0) + 1)
  }
  return df
}

function collisionRate(queryFragments: readonly string[], facts: readonly string[], goldIndex: number): number {
  const others = facts.length - 1
  if (others <= 0) return 0
  let colliding = 0
  for (let i = 0; i < facts.length; i++) {
    if (i === goldIndex) continue
    const own = new Set(fragmentsOf(facts[i]))
    if (queryFragments.some((f) => own.has(f))) colliding++
  }
  return colliding / others
}

/**
 * Derive one case per shared-fragment gold fact (deterministic order, capped by `maxGolds`).
 *
 * The bridge fragment is a NONCE because the engine may not call a model: a real paraphrase's bridge
 * (`我是谁？` → `用户是谁`, introducing `用户是`) cannot be produced without one. The nonce plays the
 * same mechanical role — a literal the gold does not contain and an unrelated fact does — and the
 * point of the fixture is the collision arithmetic, which is identical.
 */
export function deriveCases(facts: readonly string[], opts: DeriveOptions = {}): DerivedCase[] {
  const seed = opts.seed ?? 20261006
  const maxGolds = opts.maxGolds ?? 4
  const fragmentsPerQuery = opts.fragmentsPerQuery ?? 2
  const carrierLength = opts.carrierLength ?? REAL_LENGTH_PROFILE.p75
  const analysis = analyzeCorpus(facts)
  const df = fragmentDf(facts)

  const cases: DerivedCase[] = []
  let droppedTimeWords = 0

  // Which facts carry each fragment, so a fragment can be required to be "shared, but only with
  // LATER facts". That is what makes the counterfactual arm (③) unambiguous: after the planted
  // carrier is removed, the gold is the earliest fact still holding every selected fragment, so the
  // deterministic tie-break in the stub retriever lands on it. Without this rule two ordinary facts
  // would tie and "gold returns to rank 1" would be a coin flip, i.e. not a fixture self-check.
  const holders = new Map<string, number[]>()
  for (let i = 0; i < facts.length; i++) {
    for (const fragment of fragmentsOf(facts[i])) {
      const list = holders.get(fragment)
      if (list) list.push(i)
      else holders.set(fragment, [i])
    }
  }

  for (let gold = 0; gold < facts.length && cases.length < maxGolds; gold++) {
    const own = [...new Set(fragmentsOf(facts[gold]))]
    // SHARED fragments only: df ≥ 2 means "not unique to the gold", which is the literal-collision
    // rule ("查询不得包含 gold 的唯一字面"). Fragments in EVERY fact are corpus noise, not evidence.
    const shared = own
      .filter((f) => (df.get(f) ?? 0) >= 2 && (df.get(f) ?? 0) < facts.length)
      .filter((f) => (holders.get(f) ?? []).every((index) => index === gold || index > gold))
      .sort((a, b) => (df.get(a)! - df.get(b)!) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, fragmentsPerQuery)
    if (shared.length === 0) continue

    const bridge = freshNonce(seed, gold, facts)
    const query = [bridge, ...shared].join(' ')
    if (timeWordsIn(query).length > 0) {
      // The no-time-word guard: never emit a temporally confounded query.
      droppedTimeWords++
      continue
    }
    const queryFragments = fragmentsOf(query)

    // The carrier is LONG (requirement ①) and unrelated; it literally contains the bridge and every
    // shared fragment (requirement ②), which is what makes the base arm's arithmetic possible.
    const carrier = padTo(`无关记录：${bridge} ${shared.join('')} `, carrierLength, gold)
    const setup = [...facts, carrier]
    const carrierIndex = setup.length - 1

    const goldQuery: DerivedQuery = {
      query,
      k: 3,
      gold_index: gold,
      must_include: [gold],
      must_exclude: [carrierIndex],
      guard: 'none',
      fragments: queryFragments,
      collision_rate: collisionRate(queryFragments, setup, gold),
      carrier_index: carrierIndex,
    }

    // Negative control: shares no fragment with anything (a nonce with no CJK and no shared word).
    const irrelevant = freshNonce(seed, gold + 1000, setup)
    const irrelevantQuery: DerivedQuery = {
      query: irrelevant,
      k: 3,
      gold_index: null,
      must_include: [],
      must_exclude: setup.map((_, i) => i),
      guard: 'irrelevant',
      fragments: [irrelevant],
      collision_rate: 0,
      carrier_index: null,
    }

    cases.push({
      id: `derived-${String(cases.length + 1).padStart(2, '0')}-${shared.join('')}`,
      setup_facts: setup,
      queries: [goldQuery, irrelevantQuery],
      analysis,
      // Filled by the stub runner; the shape is declared here so the fixture carries its own check.
      collision: {
        query_index: 0,
        carrier_index: carrierIndex,
        gold_index: gold,
        base_carrier_before_gold: false,
        counterfactual_gold_top1: false,
      },
      guards: { no_time_word_dropped: droppedTimeWords, irrelevant_queries: 1 },
    })
  }
  return cases
}

/**
 * A deterministic corpus whose length distribution mirrors the real store's (requirement ①).
 *
 * `n` short-to-long facts are generated by padding a short seed sentence with the same unrelated
 * filler the carriers use; the caller is expected to assert the result with {@link analyzeCorpus}
 * rather than trust the generator.
 */
export function synthesizeCorpus(n: number, seed = 20261006): string[] {
  const random = rng(seed)
  const facts: string[] = []
  for (let i = 0; i < n; i++) {
    const roll = random()
    // Long-tailed: mostly the p25..p75 band with a few short and a few long facts, like the store.
    const target = roll < 0.12
      ? REAL_LENGTH_PROFILE.min + Math.floor(random() * 40)
      : roll > 0.9
        ? REAL_LENGTH_PROFILE.p75 + Math.floor(random() * (REAL_LENGTH_PROFILE.max - REAL_LENGTH_PROFILE.p75))
        : REAL_LENGTH_PROFILE.p25 + Math.floor(random() * (REAL_LENGTH_PROFILE.p75 - REAL_LENGTH_PROFILE.p25))
    const entity = `主题${Math.floor(random() * 40)}`
    const relation = i % 3 === 0 ? '负责' : i % 3 === 1 ? '依赖' : '属于'
    facts.push(padTo(`${entity}${relation}${entity}${String(i)} `, target, i))
  }
  return facts
}
