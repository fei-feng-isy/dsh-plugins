import { describe, it, expect } from 'vitest'
import {
  analyzeCorpus,
  deriveCases,
  fragmentsOf,
  lengthProfileOf,
  REAL_LENGTH_PROFILE,
  synthesizeCorpus,
  timeWordsIn,
} from '../src/eval/derive.js'
import { runDerivedSuiteStub, stubRank } from '../src/eval/derived_runner.js'

/**
 * P-02's derivation engine and its two guards.
 *
 * The three collision-sensitivity requirements the plan names are each pinned here:
 *  ① a corpus with the REAL store's length distribution (`synthesizeCorpus` + `analyzeCorpus`);
 *  ② planted, unrelated, LONG facts that literally contain the key fragment (the bridge);
 *  ③ the counterfactual arm — removing the carrier puts the gold back at rank 1 — plus the rule
 *     that the query never contains a fragment unique to the gold.
 */

const CORPUS = [
  '陈静负责发布窗口，陈静每周核对灰度名单。',
  '张伟负责发布窗口，张伟每周核对发布清单。',
  '李娜负责监控告警，李娜每月复核阈值。',
  '王强负责监控告警，王强每月复核报表。',
  '平台组的发布窗口由值班同学签字确认。',
  '监控告警的阈值每月复核一次并留存记录。',
]

/** Document frequency of every fragment over a fact list (independent of the engine's internals). */
function dfOf(facts: readonly string[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const fact of facts) for (const fragment of fragmentsOf(fact)) df.set(fragment, (df.get(fragment) ?? 0) + 1)
  return df
}

describe('P-02 derive — length distribution (requirement ①)', () => {
  it('synthesizes a corpus whose shape is the real store’s, and reports it honestly', () => {
    const facts = synthesizeCorpus(60)
    const analysis = analyzeCorpus(facts)
    expect(analysis.n).toBe(60)
    // The measured ACTIVE-store shape: 9/243/313/409/882.
    expect(analysis.length_profile.min).toBeLessThanOrEqual(60)
    expect(analysis.length_profile.max).toBeGreaterThanOrEqual(700)
    expect(analysis.length_profile.median).toBeGreaterThanOrEqual(REAL_LENGTH_PROFILE.p25)
    expect(analysis.length_profile.median).toBeLessThanOrEqual(REAL_LENGTH_PROFILE.p75)
    expect(analysis.in_band_rate, 'most facts sit in the real p25..p75 band').toBeGreaterThan(0.3)
    // Nearest-rank percentile (not the average of the middle pair), matching the profile's use as a
    // character-length bucket.
    expect(lengthProfileOf([1, 2, 3, 4, 5]).median).toBe(3)
    expect(lengthProfileOf([1, 2, 3, 4]).median).toBe(2)
    expect(lengthProfileOf([]).median).toBe(0)
  })
})

describe('P-02 derive — determinism', () => {
  it('is byte-identical for the same facts and seed, and the seed only moves the bridge', () => {
    const a = deriveCases(CORPUS, { seed: 7 })
    const b = deriveCases(CORPUS, { seed: 7 })
    const c = deriveCases(CORPUS, { seed: 8 })
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
    expect(c.length).toBe(a.length)
    // The golds and their shared fragments are data-driven, not seed-driven…
    expect(c.map((x) => x.queries[0].gold_index)).toEqual(a.map((x) => x.queries[0].gold_index))
    expect(c.map((x) => x.queries[0].fragments.slice(1))).toEqual(a.map((x) => x.queries[0].fragments.slice(1)))
    // …while the bridge (the planted fragment) is fresh per seed.
    expect(c.map((x) => x.queries[0].fragments[0])).not.toEqual(a.map((x) => x.queries[0].fragments[0]))
  })
})

describe('P-02 derive — no unique literal in the query', () => {
  it('builds every query from shared fragments plus a bridge the gold does not contain', () => {
    const cases = deriveCases(CORPUS, { seed: 7 })
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      const q = c.queries[0]
      const gold = c.setup_facts[q.gold_index!]
      expect(gold.includes(q.query), `${q.query} must not be a literal of the gold`).toBe(false)
      const bridge = q.fragments[0]
      expect(gold.includes(bridge), 'the bridge is not in the gold by construction').toBe(false)
      const df = dfOf(c.setup_facts)
      for (const fragment of q.fragments.slice(1)) {
        expect(df.get(fragment) ?? 0, `shared fragment ${fragment}`).toBeGreaterThanOrEqual(2)
      }
    }
  })
})

describe('P-02 derive — planted fragment carrier (requirement ②)', () => {
  it('plants an unrelated, long fact that literally contains the key fragments', () => {
    const carrierLength = REAL_LENGTH_PROFILE.p75
    const cases = deriveCases(CORPUS, { seed: 7, carrierLength })
    for (const c of cases) {
      const q = c.queries[0]
      const carrier = c.setup_facts[q.carrier_index!]
      expect(carrier.includes(q.fragments[0]), 'the carrier holds the bridge literal').toBe(true)
      for (const fragment of q.fragments.slice(1)) expect(carrier.includes(fragment)).toBe(true)
      // Requirement ① for the PLANTED fact as well: it must be a long note, not a stub.
      expect([...carrier].length).toBeGreaterThanOrEqual(carrierLength)
      expect(carrier).not.toBe(c.setup_facts[q.gold_index!])
      // The collision rate is measured against the non-gold facts and is strictly positive here.
      expect(q.collision_rate).toBeGreaterThan(0)
    }
  })
})

describe('P-02 derive — counterfactual arm + guards (requirement ③)', () => {
  it('the carrier outranks the gold, and removing it puts the gold back at rank 1', () => {
    const cases = deriveCases(CORPUS, { seed: 7 })
    const suite = runDerivedSuiteStub(cases)
    expect(suite.all_collision_self_checks_pass).toBe(true)
    for (const outcome of suite.cases) {
      expect(outcome.collision_self_check?.base_carrier_before_gold).toBe(true)
      expect(outcome.collision_self_check?.counterfactual_gold_top1).toBe(true)
    }
  })

  it('never emits a query with a time expression, and the negative control is empty', () => {
    const timeCorpus = [
      '上周的发布窗口已经确认。',
      '上周的监控告警已经调整。',
      '发布窗口由值班同学签字。',
      '监控告警阈值每月复核。',
    ]
    expect(timeWordsIn('上周做了什么')).toContain('上周')
    const cases = deriveCases(timeCorpus, { seed: 3 })
    expect(cases.length).toBeGreaterThan(0)
    const suite = runDerivedSuiteStub(cases)
    expect(suite.any_time_word_query, 'the no-time-word guard drops temporally confounded queries').toBe(false)
    for (const outcome of suite.cases) {
      for (const q of outcome.queries) expect(timeWordsIn(q.query)).toEqual([])
    }
    expect(suite.all_irrelevant_empty, 'a query sharing nothing retrieves nothing').toBe(true)
    // The guard actually fired on this corpus rather than the candidate never existing.
    expect(cases[cases.length - 1].guards.no_time_word_dropped).toBeGreaterThan(0)
  })

  it('the stub retriever is deterministic and ranks by literal overlap', () => {
    const facts = ['甲组负责发布名单。', '乙组负责监控告警。', '无关记录：发布 窗口 已冻结。']
    expect(stubRank('发布 窗口', facts, 3)).toEqual(stubRank('发布 窗口', facts, 3))
    const { ranked } = stubRank('发布 窗口', facts, 3)
    expect(ranked[0]).toBe(2) // the only fact holding BOTH fragments
    expect(ranked).toContain(0)
  })
})
