import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { buildFtsQuery } from '../src/db/tokenizer.js'
import { extractEntities } from '../src/entities/extract.js'
import { encodeHrrEntityVector, hrrToBytes } from '../src/hrr/index.js'
import { ENTITY_UNION_CAP } from '../src/store/entity_leg.js'
import type { RecallRequest } from '@avantf/mem-contract'
import { resetRetrievalHealth, retrievalHealth, retrievalHealthSummary } from '@avantf/mem-retrieval'

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-rec-'))
  mkdirSync(join(dir, 'configs'), { recursive: true })  // the config files live in one directory now
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * The graph queries return a fixed envelope. Pinned because `degraded: false` there is
 * a deliberate claim ("this path had no fusion leg to degrade"), not an oversight — a
 * consumer asking "was the semantic leg live?" must read `weights.semantic > 0`.
 */
describe('graph query envelope (ask/chain/reason/related)', () => {
  it('reports no fusion leg and no degradation', async () => {
    await rt.remember({ action: 'add', content: '张伟管理李娜' })
    // Typed by ACTION, so the per-action overload applies (a plain `RecallRequest[]` would match
    // only the general fallback and hand back `unknown`, which is how the assertions below used to
    // be unchecked). `as const` had also made the members readonly, matching no overload at all.
    const requests: Extract<RecallRequest, { action: 'chain' | 'reason' }>[] = [
      { action: 'chain', subj: '张伟' },
      { action: 'reason', entities: ['张伟'] },
    ]
    for (const req of requests) {
      const res = await rt.recall(req)
      expect(res.degraded).toBe(false)
      expect(res.weights).toEqual({ semantic: 0, fts: 0, jaccard: 0 })
    }
  })
})

describe('recall.related', () => {
  it('returns entities co-occurring with the probe entity, NOT facts', async () => {
    await rt.remember({ action: 'add', content: '张伟管理李娜' })
    await rt.remember({ action: 'add', content: '张伟负责支付网关' })
    // No cast: the dispatch overload types this as `{entity, count}[]`. The shape is the point —
    // the tool description used to promise "facts related to an entity", which this payload can
    // never satisfy (there is no `ref_id`/`content` to cite or read further).
    const res = await rt.recall({ action: 'related', entity: '张伟' })
    const names = res.map((r) => r.entity)
    expect(names).toContain('李娜')
    expect(names).toContain('网关')
    for (const row of res) {
      expect(Object.keys(row).sort()).toEqual(['count', 'entity'])
      expect(row.count).toBeGreaterThan(0)
    }
  })
})

describe('recall.reason', () => {
  it('returns facts whose entity set contains ALL given entities', async () => {
    await rt.remember({ action: 'add', content: '项目使用 PostgreSQL' })
    await rt.remember({ action: 'add', content: '项目使用 MySQL' })
    const hit = (await rt.recall({ action: 'reason', entities: ['项目', 'PostgreSQL'] })) as { hits: { text: string }[] }
    expect(hit.hits.length).toBeGreaterThan(0)
    expect(hit.hits[0].text).toContain('PostgreSQL')
  })
})

describe('recall.chain (two-hop)', () => {
  it(' traverses subj -pred-> mid -pred2-> obj', async () => {
    await rt.remember({ action: 'add', content: '张伟管理李娜' })
    await rt.remember({ action: 'add', content: '李娜管理王强' })
    const hit = (await rt.recall({ action: 'chain', subj: '张伟', pred: '管理', second_pred: '管理' })) as { hits: { text: string }[] }
    expect(hit.hits.length).toBeGreaterThan(0)
    expect(hit.hits.some((h) => h.text.includes('王强'))).toBe(true)
  })
})

describe('admin.vectors_*', () => {
  it('scopes the HRR probe leg to the entity-sharing candidates', async () => {
    // The probe leg used to decode one 8 KB HRR blob per ACTIVE fact and run 1024 `cos` calls on
    // each — measured 1.37 s at 33k facts, on every probe. It now scores the facts that share an
    // entity with the probe (the same information its bundle encodes), so the corpus size stops
    // mattering; a query whose entities match nothing falls back to a BOUNDED sample.
    const a = await rt.remember({ action: 'add', content: '支付网关依赖风控引擎' })
    const b = await rt.remember({ action: 'add', content: '风控引擎依赖规则库' })
    await rt.remember({ action: 'add', content: '日志收集走 ELK 栈' })

    const related = await rt.recall({ action: 'probe', entity: '风控引擎', limit: 10 })
    const refs = (related as { hits: { ref_id: number }[] }).hits.map((h) => h.ref_id)
    expect(refs).toContain(a.fact_id)
    expect(refs).toContain(b.fact_id)

    // A probe whose entity exists nowhere must still answer (bounded fallback), not throw.
    const none = await rt.recall({ action: 'probe', entity: '完全不存在的实体', limit: 10 })
    expect(Array.isArray((none as { hits: unknown[] }).hits)).toBe(true)

    // The fallback is BOUNDED and ordered by recency — the earlier version had a bare `LIMIT`
    // with no `ORDER BY`, so it scored an arbitrary slice (the review measured "the first ids by
    // fact_id", which left 32.8k of 33k facts unreachable at scale).
    // Push every existing row far into the past first, so the five below are unambiguously the
    // most recent (the earlier cases in this file were created "now").
    rt.db.prepare("UPDATE facts SET created_at = '2020-01-01 00:00:00'").run()
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      const f = await rt.remember({ action: 'add', content: `HRR 回退顺序事实 ${i}` })
      ids.push(f.fact_id)
      rt.db.prepare('UPDATE facts SET created_at = ? WHERE fact_id = ?').run(`2026-01-0${i + 1} 00:00:00`, f.fact_id)
    }
    const factsDao = (rt.memory as unknown as {
      facts: { activeHrrRows: (c?: string, l?: number) => { fact_id: number }[] }
    }).facts
    expect(factsDao.activeHrrRows(undefined, 2).map((r) => r.fact_id)).toEqual([ids[4], ids[3]])
  })

  it('caps the FTS and entity legs of a search', async () => {
    // A leg that returns the whole matching corpus makes `fuse` normalize and sort it, which is
    // what the cap removes (the FTS *scoring* is FTS5's own cost and is not what this pin covers).
    for (let i = 0; i < 40; i++) await rt.remember({ action: 'add', content: `缓存失效策略的调整 条目 ${i}` })
    const factsDao = (rt.memory as unknown as { facts: { ftsSearch: (q: string, c?: string, l?: number) => unknown[] } }).facts
    // Built through the real tokenizer: the trigram index only matches >= 3 characters, so a
    // hand-written 2-char token would match nothing at all (see the eval gap test).
    const ftsQuery = buildFtsQuery('缓存失效策略的调整') as string
    expect(factsDao.ftsSearch(ftsQuery, undefined, 5).length).toBeLessThanOrEqual(5)
    expect(factsDao.ftsSearch(ftsQuery).length).toBeGreaterThan(5)

    const entitiesDao = (rt.memory as unknown as {
      entities: { candidateFactsForAnyEntity: (n: string[], c: string | undefined, l: number, w: number, cap: number) => number[] }
    }).entities
    // Use the names the tagger ACTUALLY extracts from this corpus. The first version of this test
    // passed `'缓存失效策略'` — a string that is not an entity of any fact — so the method returned
    // `[]` and `length <= 7` could not fail whatever the SQL did.
    const names = (await extractEntities('缓存失效策略的调整')).map((e) => e.name)
    expect(names.length, 'the corpus must yield entities for this to test anything').toBeGreaterThan(0)
    expect(entitiesDao.candidateFactsForAnyEntity(names, undefined, 1000, names.length, ENTITY_UNION_CAP).length).toBeGreaterThan(5)
    expect(entitiesDao.candidateFactsForAnyEntity(names, undefined, 3, names.length, ENTITY_UNION_CAP)).toHaveLength(3)
  })

  it('keeps the highest-Jaccard candidates when the corpus EXCEEDS the leg cap', async () => {
    // The eval suite cannot guard the cap: its corpora are <= 3 facts while `legCap` is >= 200, so
    // the cap never binds there (verified: the old 29 queries give byte-identical metrics under the
    // capping code). This test builds a corpus that DOES bind it, because ordering by the shared
    // count used to drop exactly the document this asserts on.
    const insFact = rt.db.prepare(
      'INSERT INTO facts (content, category, settle_clock, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    const insEntity = rt.db.prepare('INSERT OR IGNORE INTO entities (name, entity_type, extraction_method) VALUES (?,?,?)')
    const getEntity = rt.db.prepare('SELECT entity_id FROM entities WHERE name = ?')
    const insLink = rt.db.prepare('INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?,?)')
    const eid = (name: string): number => {
      insEntity.run(name, 'n', 'x')
      return (getEntity.get(name) as { entity_id: number }).entity_id
    }
    const t = '2026-01-01 00:00:00'
    const seed = rt.db.transaction(() => {
      // `best` shares ONE query anchor and has no other entity at all ⇒ 1/(2 + 0) = 0.5, the
      // maximum here. The fillers share TWO anchors but carry noise, which the saturating union caps
      // at 3 ⇒ 2/(2 + 3) = 0.4 < 0.5. A shared-count-only ordering would rank all 259 fillers above
      // `best` and a cap of 200 would drop it (measured: the ratio ordering keeps it).
      const best = Number(insFact.run('alpha 核心记录', 'b', 0, 'active', t, t).lastInsertRowid)
      insLink.run(best, eid('alpha'))
      for (let i = 0; i < 259; i++) {
        const fid = Number(insFact.run(`alpha beta 填充事实 ${i}`, 'b', 0, 'active', t, t).lastInsertRowid)
        insLink.run(fid, eid('alpha'))
        insLink.run(fid, eid('beta'))
        for (let n = 1; n <= 3 + (i % 9); n++) insLink.run(fid, eid(`noise-${n}`))
      }
      return best
    })
    const best = seed()

    const entitiesDao = (rt.memory as unknown as {
      entities: { candidateFactsForAnyEntity: (n: string[], c: string | undefined, l: number, w: number, cap: number) => number[] }
    }).entities
    const all = entitiesDao.candidateFactsForAnyEntity(['alpha', 'beta'], undefined, 10_000, 2, ENTITY_UNION_CAP)
    expect(all.length).toBe(260) // every fact shares an entity — the cap is what bounds the leg

    const capped = entitiesDao.candidateFactsForAnyEntity(['alpha', 'beta'], undefined, 200, 2, ENTITY_UNION_CAP)
    expect(capped).toHaveLength(200)
    expect(capped[0]).toBe(best) // ordered by the ratio, so the best candidate survives the cap
    expect(capped).toContain(best)
  })

  it('defaults a cross query limit at the RUNTIME, not only in the tool schema', async () => {
    // `QueryRequest.limit` has a zod default, so the tool boundary always fills it — but
    // `runtime.query` is also called by embedders and benchmarks, and `req.limit * 3` with an
    // omitted limit produced `NaN`: the semantic leg then returned nothing (`slice(0, NaN)`) and a
    // leg cap turned it into a SQLITE_MISMATCH. The runtime now defaults it itself.
    await rt.remember({ action: 'add', content: '支付网关依赖风控引擎' })
    const res = await rt.query({ query: '支付网关' } as unknown as Parameters<typeof rt.query>[0])
    expect(Array.isArray((res as { hits: unknown[] }).hits)).toBe(true)
    expect((res as { hits: unknown[] }).hits.length).toBeGreaterThan(0)
  })

  it('diagnoses missing vectors; fix is a no-op when semantic unavailable', async () => {
    await rt.remember({ action: 'add', content: '陈静加入平台组' })
    const diag = rt.admin({ action: 'vectors_diagnose' }) as { total: number; missing: number }
    expect(diag.total).toBeGreaterThan(0)
    expect(diag.missing).toBeGreaterThan(0)
    const fix = await rt.admin({ action: 'vectors_fix' })
    expect(fix.semantic_available).toBe(false) // no model in test env → degrade
    expect(fix.stores.memory?.encoded).toBe(0)
  })
})

/**
 * The leg cap, measured rather than argued (review §2/§3.4).
 *
 * Every non-semantic leg is capped for cost (`retriever.leg_cap`, derived by default), and capping
 * a leg is a change to what can reach the fused result. What makes it SAFE is that fusion scales
 * each leg by its own MAXIMUM — an entry no cap can remove — so trimming a leg's tail cannot move
 * the survivors. This test is the differential that claim rests on: same corpus, same query, cap
 * effectively off vs the shipped cap, and the top-k must be identical *including the scores*.
 *
 * The third run is the control: with a cap of 2 the same query must visibly change, which is what
 * makes the first comparison evidence instead of a tautology.
 */
describe('leg cap differential', () => {
  /** A corpus big enough that the derived cap (>= 200) binds for a common term. */
  const CORPUS = 300

  async function seeded(home: string, legCap: number): Promise<AvantfRuntime> {
    mkdirSync(join(home, 'configs'), { recursive: true })
    writeFileSync(join(home, 'configs', 'common.yaml'), `retriever:\n  leg_cap: ${String(legCap)}\n`)
    const rt2 = buildRuntime({ dataHome: home, memoryDbPath: join(home, 'memory.db') })
    // One shared term (so the FTS leg returns the whole corpus for it) plus distinctive ones.
    for (let i = 0; i < CORPUS; i++) await rt2.remember({ action: 'add', content: `网关变更记录 ${String(i)}` })
    await rt2.remember({ action: 'add', content: '风控引擎依赖规则库' })
    return rt2
  }

  const topHits = async (r: AvantfRuntime): Promise<{ id: number; score: number }[]> => {
    const res = await r.recall({ action: 'search', query: '网关变更' })
    return res.hits.slice(0, 5).map((h) => ({ id: h.ref_id, score: h.score }))
  }

  it('the shipped cap does not change the head; a tiny one visibly does', async () => {
    resetRetrievalHealth()
    const homes = [mkdtempSync(join(tmpdir(), 'avantf-cap-off-')), mkdtempSync(join(tmpdir(), 'avantf-cap-on-')), mkdtempSync(join(tmpdir(), 'avantf-cap-tiny-'))]
    const [off, on, tiny] = await Promise.all([
      seeded(homes[0]!, 1_000_000), // effectively no cap
      seeded(homes[1]!, 0), // the shipped derivation
      seeded(homes[2]!, 2), // deliberately too small
    ])
    try {
      const unlimited = await topHits(off)
      expect(unlimited.length).toBeGreaterThan(0)
      // No leg was cut in this run, which is what makes the counter below meaningful.
      expect(retrievalHealthSummary().legs_capped).toBe(0)

      const capped = await topHits(on)
      // The shipped cap DID bind — the counter is the only way to know that, since the result is
      // about to be identical — and the head is unchanged anyway. Identical ids AND scores: a
      // trimmed tail cannot rescale a survivor, because the maximum each leg scales by is an entry
      // the cap never removes.
      expect(retrievalHealthSummary().legs_capped).toBeGreaterThan(0)
      expect(capped).toEqual(unlimited)

      // Control: a cap of 2 changes the result, so the equality above is not vacuous.
      const squeezed = await topHits(tiny)
      expect(squeezed).not.toEqual(unlimited)
    } finally {
      for (const r of [off, on, tiny]) r.shutdown()
      for (const h of homes) rmSync(h, { recursive: true, force: true })
    }
  })

  /**
   * The HRR probe is the ONE leg whose cap is not ordered by that leg's own score (its candidate
   * set comes from `candidateFactsForAnyEntity`, ordered by the entity-leg score; the fallback takes the
   * `cap` most RECENT facts). So it is the leg that makes the "a trimmed tail cannot rescale a
   * survivor" claim conditional, which is exactly how DESIGN §20.17 and `fusion.ts` now scope it —
   * and this test is the store-level half of that boundary (`fusion.spec.ts` pins the arithmetic).
   */
  async function hrrSeeded(home: string, legCap: number): Promise<{ rt: AvantfRuntime; best: number }> {
    mkdirSync(join(home, 'configs'), { recursive: true })
    writeFileSync(join(home, 'configs', 'common.yaml'), `retriever:\n  leg_cap: ${String(legCap)}\n`)
    const r = buildRuntime({ dataHome: home, memoryDbPath: join(home, 'memory.db') })
    await r.remember({ action: 'add', content: '李娜负责统一网关' }) // 李娜 + 网关
    await r.remember({ action: 'add', content: '李娜负责风控' }) // 李娜 + 风控
    // More entities ⇒ LOWER exact Jaccard with the one-entity probe, so this row is ordered LAST
    // and a small cap drops it first.
    const best = await r.remember({ action: 'add', content: '李娜负责支付、风控、网关与监控' })
    // …and give that row the probe's OWN bundle, i.e. phase similarity 1.0: the leg's maximum.
    r.db
      .prepare('UPDATE facts SET hrr_vector = ? WHERE fact_id = ?')
      .run(hrrToBytes(encodeHrrEntityVector(['李娜'])), best.fact_id)
    return { rt: r, best: best.fact_id }
  }

  const probeIds = async (r: AvantfRuntime): Promise<number[]> =>
    (await r.recall({ action: 'probe', entity: '李娜', limit: 10 })).hits.map((h) => h.ref_id)

  it('the HRR leg is NOT cap-invariant: a Jaccard-ordered cap drops its best scorer', async () => {
    resetRetrievalHealth()
    const homeWide = mkdtempSync(join(tmpdir(), 'avantf-hrr-wide-'))
    const homeTiny = mkdtempSync(join(tmpdir(), 'avantf-hrr-tiny-'))
    const wide = await hrrSeeded(homeWide, 0) // derived cap (>= 200): nothing is cut
    const tiny = await hrrSeeded(homeTiny, 2) // keeps the two highest-Jaccard rows only
    try {
      const uncapped = await probeIds(wide.rt)
      expect(uncapped).toContain(wide.best) // its 1.0 similarity is in the pool…
      expect(retrievalHealthSummary().legs_capped).toBe(0) // …and no leg was cut

      const capped = await probeIds(tiny.rt)
      // The cap removed the highest scorer, so the leg it belongs to is not cap-invariant. If the
      // HRR leg ever gets a score-ordered cap, this expectation must FLIP — that is the point.
      expect(capped).not.toContain(tiny.best)
      // The HRR leg (and the entity leg feeding it) hit their cap, and the counter is visible on
      // BOTH health surfaces — the summary and the full snapshot the health page reads.
      expect(retrievalHealthSummary().legs_capped).toBeGreaterThan(0)
      expect(retrievalHealth().legs_capped).toBe(retrievalHealthSummary().legs_capped)
    } finally {
      for (const r of [wide.rt, tiny.rt]) r.shutdown()
      for (const h of [homeWide, homeTiny]) rmSync(h, { recursive: true, force: true })
    }
  })
})
