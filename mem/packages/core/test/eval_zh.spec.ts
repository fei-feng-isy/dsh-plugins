import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { buildFtsQuery } from '../src/db/tokenizer.js'
import { loadEvalCases } from '../src/eval/loader.js'
import { evaluateCases } from '../src/eval/runner.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures', 'eval_zh_relations.jsonl')

const cases = loadEvalCases(FIXTURE)

describe('zh relations eval (degraded FTS+entity path)', () => {
  it('runs the full 35-query set and reports metrics', async () => {
    // ONE runtime per case (memoized by the case's setup_facts identity): the
    // previous per-query runtime churn spawned 29 engine + model-bootstrap cycles.
    let cached: { facts: string[]; rt: AvantfRuntime; dir: string; ids: number[] } | null = null
    const dirs: string[] = []
    const runtimes: AvantfRuntime[] = []

    const retrieve = async (query: string, k: number, facts: string[]) => {
      if (!cached || cached.facts !== facts) {
        const dir = mkdtempSync(join(tmpdir(), 'avantf-eval-'))
        dirs.push(dir)
        const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
        runtimes.push(rt)
        const ids: number[] = []
        for (const f of facts) {
          const res = await rt.remember({ action: 'add', content: f })
          ids.push(res.fact_id)
        }
        cached = { facts, rt, dir, ids }
      }
      const hit = await cached.rt.recall({ action: 'search', query })
      const ids = (hit as { hits: { ref_id: number }[] }).hits.map((h) => h.ref_id)
      // map fact_id → index into the case's setup_facts
      return ids
        .map((id) => cached!.ids.indexOf(id))
        .filter((i) => i >= 0)
        .slice(0, k)
    }

    const report = await evaluateCases(cases, retrieve)
    for (const rt of runtimes) rt.shutdown()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })

    // eslint-disable-next-line no-console
    console.log('eval summary:', JSON.stringify(report.summary))
    // FROZEN baseline (TRUST_MODEL.md §9 基线守卫, M0): the degraded FTS+entity numbers,
    // asserted to the last bit. trust must never enter ranking, so any drift here means the
    // retrieval path was touched — not just trust.
    //
    // 29 → 35 queries: the performance review (§4.4) found this set had ZERO queries of two CJK
    // characters while `buildFtsQuery` returns null for them (a trigram index cannot match a
    // 2-char token), i.e. the shape was invisible to the very gate meant to protect the FTS leg.
    // The six added queries are that shape (names 李娜/张伟/王强, terms 网关/数据库, shared 风控);
    // they pass through the ENTITY leg today, which is what these numbers record.
    //
    // RE-FROZEN for the cap-invariant fusion (`retrieval-core/src/fusion.ts`): paths are now scaled
    // by their own MAXIMUM instead of min-max over their returned set, so that a capped leg cannot
    // rescale the survivors. Two movements, both understood:
    //   - `mrr` 0.9429 → 0.9714: one more query finds its answer at rank 1 (33/35 → 34/35);
    //   - `must_exclude_pass_rate` 0.7429 → 0.6571: min-max mapped the WEAKEST entry of a path to
    //     0, and `fuse` then dropped entries whose total was 0 — a de-facto per-path threshold. With
    //     scaling there is no such threshold, so on a 3-fact corpus with k=2 the second slot fills
    //     with an entity-sharing neighbour (asked "李娜管理谁", it now also returns "张伟管理李娜").
    //     Every one of the 12 violations is that shape: the answer is still FIRST, the tail slot is
    //     a related fact. This codebase has no absolute score thresholds by design, so the numbers
    //     are recorded as they are rather than fitted by inventing one.
    //
    // RE-VERIFIED, unchanged, when the relevance floors landed (`retriever.min_*`, DESIGN §20.19):
    // this spec runs the DEGRADED path (vitest pins the model cache to a temp dir and disables
    // download), so the floors in force are `{semantic: 0.5, fts: 1, jaccard: 0.2}` — the semantic
    // one is inert (leg down), the FTS one relaxed to 1 (every row that matched at all hits at
    // least one query term), and the Jaccard floor cut nothing on this 3-fact-per-case corpus.
    // Measured across all 35 queries: `dropped_by_floor` totals `{semantic: 0, fts: 0, jaccard: 0,
    // hrr: 0}`, so all seven numbers below are bit-identical before and after. The floor's own
    // calibration is the semantic-LIVE scan in the CHANGELOG (0.40/0.45/0.50 tie; 0.55+ starts
    // blocking must-include answers), and `test/floors.spec.ts` pins the boundary behaviour on both
    // stores — NOT this degraded set.
    //
    // RE-VERIFIED AGAIN, still unchanged, for the §20.20 rules (auto-relax on an empty strict pass,
    // and the FTS reachability clamp `min(configured, termCount)`). Both are no-ops HERE:
    //   - the reachability clamp only bites when the semantic LEG IS UP and `min_fts_terms` > 1; this
    //     spec runs degraded, where the configured FTS bar is already relaxed to 1, so the reported
    //     `floors.fts` stays 1 and no row's verdict moves;
    //   - these calls omit `floors`, i.e. they get the default policy, whose retry fires only when the
    //     strict pass returned NOTHING while having dropped something — and the measured drop totals
    //     above are all zero, so no query here ever takes the second pass.
    // The rules themselves are pinned by `test/floors.spec.ts` (both stores) and by the semantic-LIVE
    // measurements recorded in DESIGN §20.20.
    expect(report.summary).toEqual({
      n_queries: 35,
      mean_precision_at_k: 0.5666666666666667,
      mean_recall_at_k: 0.9571428571428572,
      mrr: 0.9714285714285714,
      empty_rate: 0.02857142857142857,
      must_include_pass_rate: 0.9428571428571428,
      must_exclude_pass_rate: 0.6571428571428571,
    })
  })

  it('PINNED GAP: a 2-char term the tagger calls a VERB reaches no leg at all', async () => {
    // Review §4.4, and the reason the set above was extended. `buildFtsQuery` drops any CJK token
    // shorter than 3 characters (a trigram index has nothing to match), so a 2-char query has no
    // FTS leg; what is left is the entity leg, which only sees tags worth keeping.
    //
    // MEASURED, and it corrects an earlier reading of this gap: the terms that go missing are not
    // "unknown to the tagger" — `缓存` is tagged `v` (a verb), and so are 维护/负责/加入/离开/审核/
    // 发布/值班. `风控` is `x`, which IS accepted (`ENTITY_EXTRA`), which is why the eval's 风控
    // query missions. So the gap is precisely "a term the tagger classifies as a verb", and the
    // obvious extraction-layer fix — accept bare multi-char CJK runs — would admit EVERY verb and
    // pollute the entity leg (and the Jaccard denominators it feeds). The honest fixes are at the
    // lexical layer instead: a `LIKE '%…%'` fallback (no index can serve a 2-char trigram query, so
    // it is an O(corpus) scan per query) or a bigram index maintained on write. Both are
    // recall-semantics decisions of their own; this test pins the gap so it stays visible and so
    // that touching the retrieval legs has to move this line deliberately.
    expect(buildFtsQuery('缓存')).toBeNull()
    expect(buildFtsQuery('李娜')).toBeNull()

    const dir = mkdtempSync(join(tmpdir(), 'avantf-eval-gap-'))
    const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      await rt.remember({ action: 'add', content: '缓存策略改为写穿' })
      await rt.remember({ action: 'add', content: '李娜负责支付网关' })
      const missed = await rt.recall({ action: 'search', query: '缓存' })
      expect((missed as { hits: unknown[] }).hits, 'the 2-char untagged term is invisible').toHaveLength(0)
      const found = await rt.recall({ action: 'search', query: '李娜' })
      expect((found as { hits: unknown[] }).hits.length, 'the 2-char NAME is served by the entity leg').toBeGreaterThan(0)
    } finally {
      rt.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }

    // …and the eval set now covers the shape that used to be absent from it.
    const twoCharQueries = cases
      .flatMap((c) => c.queries)
      .filter((q) => ((q.query.match(/[\u4e00-\u9fff]/g) ?? []).length <= 2))
    expect(twoCharQueries.length).toBeGreaterThanOrEqual(5)
  })

  it('R16: ranking is identical with every fact at trust 0 and at trust 1', async () => {
    // The second half of the frozen M0 guard: trust must not enter fusion/rerank at
    // all, so forcing the whole store to either extreme cannot reorder a single query.
    let cached: { facts: string[]; rt: AvantfRuntime } | null = null
    const dirs: string[] = []
    const runtimes: AvantfRuntime[] = []
    const sequences: Record<'mid' | 'zero' | 'one', string[]> = { mid: [], zero: [], one: [] }

    for (const c of cases) {
      if (!cached || cached.facts !== c.setup_facts) {
        const dir = mkdtempSync(join(tmpdir(), 'avantf-eval-trust-'))
        dirs.push(dir)
        const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
        runtimes.push(rt)
        for (const f of c.setup_facts) await rt.remember({ action: 'add', content: f })
        cached = { facts: c.setup_facts, rt }
      }
      for (const q of c.queries) {
        for (const mode of ['mid', 'zero', 'one'] as const) {
          // Recall itself reinforces trust, so force the extreme before EVERY query.
          if (mode !== 'mid') {
            cached.rt.db.prepare('UPDATE facts SET trust_score = ?, pinned = 0, settle_clock = 0').run(mode === 'zero' ? 0 : 1)
          }
          const hit = await cached.rt.recall({ action: 'search', query: q.query })
          sequences[mode].push((hit as { hits: { ref_id: number }[] }).hits.map((h) => h.ref_id).slice(0, q.k).join(','))
        }
      }
    }
    for (const rt of runtimes) rt.shutdown()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })

    expect(sequences.zero).toEqual(sequences.mid)
    expect(sequences.one).toEqual(sequences.mid)
  })
})
