/**
 * The shared leg runner (`store/legs.ts`) — 阶段 4 of `docs/vector-repair-shared-flow.md`.
 *
 * The extraction is PURE STRUCTURE: `MemoryStore.searchLegs` and `KnowledgeStore.searchLegs` used to
 * build their legs with the same wrapper twice (cap measured on the RAW set, `applyTermFloor` /
 * `applyScoreFloor`, and the equal-weight empty leg for a down semantic backend). The only honest way
 * to prove "behavior byte-identical" for that is a DIFFERENTIAL test: the pre-extraction wrappers are
 * reproduced verbatim below as the reference, and the runner is asserted equal to them — key SET, key
 * ORDER, every value, and even Map identity where the old code returned the same map. The integration
 * half (`eval_zh.spec.ts`'s frozen 41-query numbers) is what pins the real corpus behaviour.
 *
 * The third describe block is the §2.5 discipline: a THIRD, artificial store that is neither memory
 * nor knowledge drives the same runner from its own sources, so "a new store supplies a leg list and
 * sources, not a copy of the flow" is asserted rather than claimed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecallHit } from '@avantf/mem-contract'
import type { SemanticBackend } from '@avantf/mem-retrieval'
import { applyScoreFloor, applyTermFloor } from '../src/store/floors.js'
import { makeLegRunner } from '../src/store/legs.js'
import type { HybridLeg, HybridResult } from '../src/store/hybrid.js'
import { selfQueryRewrite } from '../src/store/self_query.js'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { allowAnyDomain } from './helpers.js'

// ─── the reference: the wrappers exactly as they were before the extraction ──────────────────────

/**
 * The memory store's pre-extraction `leg()` helper (verbatim shape). `raw` is the PRE-floor set and
 * is what the cap is measured on.
 */
function refMemoryLeg(scores: Map<number, number>, weight: number, cap: number, raw?: Map<number, number>): HybridLeg {
  return {
    weight,
    scores,
    capped: (raw ?? scores).size === cap,
  }
}

/** The memory store's pre-extraction Jaccard leg (`{ ...leg(...), leg, droppedByFloor }`). */
function refMemoryJaccard(raw: Map<number, number>, weight: number, cap: number, floor: number): HybridLeg {
  const floored = applyScoreFloor(raw, floor)
  return { ...refMemoryLeg(floored.scores, weight, cap, raw), leg: 'jaccard' as const, droppedByFloor: floored.dropped }
}

/** The memory store's pre-extraction FTS leg. */
function refMemoryFts(
  raw: Map<number, number>,
  texts: Map<number, string>,
  query: string,
  weight: number,
  cap: number,
  floor: number,
): HybridLeg {
  const floored = applyTermFloor(raw, texts, query, floor)
  return { ...refMemoryLeg(floored.scores, weight, cap, raw), leg: 'fts' as const, droppedByFloor: floored.dropped }
}

/** The memory store's pre-extraction semantic leg (no `capped` key at all). */
function refMemorySemantic(raw: Map<number, number>, weight: number, floor: number): HybridLeg {
  const floored = applyScoreFloor(raw, floor)
  return { weight, scores: floored.scores, leg: 'semantic' as const, droppedByFloor: floored.dropped }
}

/** The knowledge store's pre-extraction `leg()` helper (one shape for every named leg). */
function refKnowledgeLeg(
  scores: Map<number, number>,
  weight: number,
  name: 'semantic' | 'fts' | 'jaccard',
  dropped: number,
  cap: number,
  raw?: Map<number, number>,
): HybridLeg {
  return {
    weight,
    scores,
    capped: (raw ?? scores).size === cap,
    leg: name,
    droppedByFloor: dropped,
  }
}

/**
 * A byte-level snapshot of a leg. `Map` does not survive `JSON.stringify`, so the scores are
 * flattened to a sorted entry array; `keys` captures which optional properties EXIST and in what
 * insertion order (a leg that ships `capped: undefined` is not the same object as one without it).
 */
function snap(leg: HybridLeg): string {
  return JSON.stringify({
    weight: leg.weight,
    scores: [...leg.scores.entries()].sort((a, b) => a[0] - b[0]),
    capped: leg.capped,
    leg: leg.leg,
    droppedByFloor: leg.droppedByFloor,
    keys: Object.keys(leg),
  })
}

function map(entries: readonly (readonly [number, number])[]): Map<number, number> {
  return new Map(entries.map(([id, score]) => [id, score]))
}

const TEXTS = new Map<number, string>([
  [1, '缓存策略改为写穿，热点键过期时间随机抖动'],
  [2, '缓存命中率的观测面板'],
  [3, '网关由平台组维护'],
])

// ─── 1. differential: the runner IS the two pre-extraction wrappers ──────────────────────────────

describe('腿运行器 = 抽取前的两份实现（逐字节差分）', () => {
  it('measures `capped` on the RAW set, so a floor that empties the leg cannot erase the signal', () => {
    const raw = map([[1, 0.9], [2, 0.5], [3, 0.1]])
    // Floor 0.95 keeps nothing. The old wrapper still reported capped=true because RAW.size === cap.
    const actual = makeLegRunner({ legCap: 3 }).scored('jaccard', raw, 0.15, 0.95)
    const expected = refMemoryJaccard(raw, 0.15, 3, 0.95)
    expect(snap(actual)).toBe(snap(expected))
    expect(Object.keys(actual)).toEqual(Object.keys(expected))
    expect(actual.capped).toBe(true)
    expect(actual.scores.size).toBe(0)
    expect(actual.droppedByFloor).toBe(3)
  })

  it('a leg that finished UNDER the cap is not flagged, and the floor keeps the survivors', () => {
    const raw = map([[1, 0.9], [2, 0.4]])
    const actual = makeLegRunner({ legCap: 5 }).scored('jaccard', raw, 0.15, 0.5)
    const expected = refMemoryJaccard(raw, 0.15, 5, 0.5)
    expect(snap(actual)).toBe(snap(expected))
    expect(actual.capped).toBe(false)
    expect([...actual.scores]).toEqual([[1, 0.9]])
    expect(actual.droppedByFloor).toBe(1)
  })

  it('a floor of 0 hands the RAW map through by IDENTITY (no copy, no narrowing) and reports 0 drops', () => {
    const raw = map([[1, 2], [2, 1]])
    const actual = makeLegRunner({ legCap: 9 }).scored('jaccard', raw, 0.15, 0)
    expect(actual.scores).toBe(raw)
    expect(snap(actual)).toBe(snap(refMemoryJaccard(raw, 0.15, 9, 0)))
    expect(actual.capped).toBe(false)
    expect(actual.droppedByFloor).toBe(0)
  })

  it('the FTS leg applies the per-row TERM floor on the store-read texts (both pre-extraction forms)', () => {
    const raw = map([[1, 2], [2, 1], [3, 1]])
    const actual = makeLegRunner({ legCap: 3 }).term('fts', raw, TEXTS, '缓存策略', 0.3, 2)
    // Memory's form.
    expect(snap(actual)).toBe(snap(refMemoryFts(raw, TEXTS, '缓存策略', 0.3, 3, 2)))
    // Knowledge's form (same numbers, spelled through its single `leg()` helper).
    const floored = applyTermFloor(raw, TEXTS, '缓存策略', 2)
    expect(snap(actual)).toBe(snap(refKnowledgeLeg(floored.scores, 0.3, 'fts', floored.dropped, 3, raw)))
    expect(actual.capped).toBe(true)
    expect([...actual.scores.keys()]).toEqual([1])
    expect(actual.droppedByFloor).toBe(2)
  })

  it('the plain (HRR / time-window) leg carries ONLY weight+scores+capped', () => {
    const raw = map([[1, 1], [2, 1]])
    const actual = makeLegRunner({ legCap: 2 }).plain(raw, 0.15)
    expect(Object.keys(actual)).toEqual(['weight', 'scores', 'capped'])
    expect(snap(actual)).toBe(snap(refMemoryLeg(raw, 0.15, 2)))
    expect(actual.leg).toBeUndefined()
    expect(actual.droppedByFloor).toBeUndefined()
  })

  it('the semantic leg has NO `capped` key (the pool caps it, not legCap) and the down fallback keeps the WEIGHT', () => {
    const raw = map([[1, 0.7], [2, 0.2]])
    const runner = makeLegRunner({ legCap: 2 })
    const on = runner.semantic(raw, 0.55, 0.5)
    expect(snap(on)).toBe(snap(refMemorySemantic(raw, 0.55, 0.5)))
    expect(Object.keys(on)).toEqual(['weight', 'scores', 'leg', 'droppedByFloor'])
    // `size === cap` is TRUE here, and it must still not be reported: the pool sized this leg.
    expect(on.capped).toBeUndefined()
    expect([...on.scores]).toEqual([[1, 0.7]])

    const off = runner.semanticOff(0.55)
    expect(Object.keys(off)).toEqual(['weight', 'scores', 'leg', 'droppedByFloor'])
    expect(off.weight, 'equal weight, not zero: the 3-key weights contract must not move').toBe(0.55)
    expect(off.scores.size).toBe(0)
    expect(off.droppedByFloor).toBe(0)
    expect(off.leg).toBe('semantic')
  })

  it('drives the KNOWLEDGE form too: the async Jaccard leg is the same wrapper after its promise resolves', async () => {
    const raw = map([[1, 0.5], [2, 0.1], [3, 0.9]])
    const runner = makeLegRunner({ legCap: 3 })
    const actual = await Promise.resolve(raw).then((r) => runner.scored('jaccard', r, 0.15, 0.2))
    const floored = applyScoreFloor(raw, 0.2)
    expect(snap(actual)).toBe(snap(refKnowledgeLeg(floored.scores, 0.15, 'jaccard', floored.dropped, 3, raw)))
    expect(actual.capped).toBe(true)
    expect([...actual.scores.keys()]).toEqual([1, 3])
  })

  it('accounts for every raw candidate: survivors + counted floor drops === the raw set (union not narrowed)', () => {
    const runner = makeLegRunner({ legCap: 50 })
    const jaccardRaw = map([[1, 0.9], [2, 0.4], [3, 0.2]])
    const ftsRaw = map([[2, 1], [4, 0.05]])
    const legs: readonly (readonly [Map<number, number>, HybridLeg])[] = [
      [jaccardRaw, runner.scored('jaccard', jaccardRaw, 0.15, 0.5)],
      [ftsRaw, runner.term('fts', ftsRaw, TEXTS, '缓存策略', 0.3, 2)],
    ]
    for (const [raw, leg] of legs) {
      // The floor is the ONLY thing that may remove an entry, and each removal is counted. Nothing
      // else can silently disappear between a store's source map and the leg `fuse` receives.
      expect(leg.scores.size + (leg.droppedByFloor ?? 0), 'survivors + counted drops === raw size').toBe(raw.size)
      for (const id of raw.keys()) {
        expect(leg.scores.has(id) || (leg.droppedByFloor ?? 0) > 0).toBe(true)
      }
    }
    expect(legs[0][1].droppedByFloor, 'the entity floor really dropped something').toBeGreaterThan(0)
    expect(legs[1][1].droppedByFloor, 'the term floor really dropped something').toBeGreaterThan(0)
  })
})

// ─── 2. a THIRD store: sources only, no copy of the flow ─────────────────────────────────────────

describe('第三个（人造）库只给腿清单与候选来源', () => {
  it('drives the same runner without touching either real store', () => {
    // A store that is neither memory nor knowledge: its own corpus, its own sources, a different leg
    // count/order. If the flow had to be copied per store, this is the test that would need a copy.
    const runner = makeLegRunner({ legCap: 4 })
    const docs = new Map<number, string>([[7, '灰度发布先放百分之一流量'], [8, '值班手册第 3 节']])
    const third = {
      semanticOff: runner.semanticOff(0.5),
      fts: runner.term('fts', map([[7, 2], [8, 1]]), docs, '灰度发布', 0.3, 2),
      jaccard: runner.scored('jaccard', map([[7, 0.5]]), 0.2, 0.4),
      plain: runner.plain(map([[9, 1]]), 0.2),
    }
    expect([third.semanticOff.leg, third.fts.leg, third.jaccard.leg, third.plain.leg])
      .toEqual(['semantic', 'fts', 'jaccard', undefined])
    expect(third.semanticOff.weight).toBe(0.5)
    expect(third.fts.capped).toBe(false)
    expect(third.jaccard.scores.size).toBe(1)
    expect(third.plain.capped).toBe(false)
    // Every leg is a well-formed `HybridLeg` the orchestrator can fuse, with no store-specific field.
    for (const leg of Object.values(third)) {
      expect(leg.scores).toBeInstanceOf(Map)
      expect(typeof leg.weight).toBe('number')
      expect(Object.keys(leg).every((k) => ['weight', 'scores', 'capped', 'leg', 'droppedByFloor'].includes(k))).toBe(true)
    }
  })
})

// ─── 3. the real stores: non-self-referential query, per-leg evidence, 3-key weights ─────────────

const DIM = 768

/** Deterministic embedder: the recorded cosine against the pinned query axis, no model download. */
function cosineStub(cosines: Readonly<Record<string, number>>): SemanticBackend {
  const encode = async (text: string): Promise<Float32Array> => {
    const v = new Float32Array(DIM)
    const c = cosines[text]
    if (c === undefined) return v
    v[0] = c
    v[1] = Math.sqrt(Math.max(0, 1 - c * c))
    return v
  }
  return {
    name: 'legs-cosine-stub',
    dim: DIM,
    encode,
    encodeBatch: async (texts: string[]) => Promise.all(texts.map((t) => encode(t))),
    isAvailable: () => true,
  }
}

const QUERY = '缓存失效策略'
const FACTS = [
  '缓存失效策略：热点键的过期时间在写入时随机抖动，避免同一时刻大面积失效。',
  '缓存淘汰采用近似 LRU，命中率面板按小时聚合。',
  '网关由平台组维护，变更必须走评审流程。',
]

describe('实库端到端：非自指查询逐字节可复现，命中都来自腿的并集', () => {
  let dir: string
  let rt: AvantfRuntime

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'avantf-legs-'))
    allowAnyDomain(dir)
    rt = buildRuntime({
      dataHome: dir,
      memoryDbPath: join(dir, 'memory.db'),
      semantic: cosineStub({
        [QUERY]: 1,
        [FACTS[0]]: 0.72,
        [FACTS[1]]: 0.55,
        [FACTS[2]]: 0.2,
      }),
    })
    for (const content of FACTS) await rt.remember({ action: 'add', content })
  })

  afterEach(() => {
    rt.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('memory: the same query answers the same ids+scores twice, with the 3-key weights contract', async () => {
    // Non-vacuous: the self-reference rewriter must NOT fire for this query, so the byte-identical
    // property below is about the plain path and not the augmentation.
    expect(selfQueryRewrite(QUERY), 'the guard query is really non-self-referential').toBeUndefined()

    const first = await rt.memory.search({ query: QUERY, limit: 5, includeScores: true })
    const second = await rt.memory.search({ query: QUERY, limit: 5, includeScores: true })
    expect(first.hits.length, 'the guard corpus must answer, or this asserts nothing').toBeGreaterThan(0)
    expect(second.hits.map((h) => [h.ref_id, h.score, h.text])).toEqual(
      first.hits.map((h) => [h.ref_id, h.score, h.text]),
    )
    expect(Object.keys(first.weights).sort(), 'the three-key contract').toEqual(['fts', 'jaccard', 'semantic'])
    // Every returned hit is carried by at least one leg: the fused set is built from the union of the
    // legs, never a narrowed subset of it.
    for (const hit of first.hits) {
      expect(
        Object.values(hit.scores ?? {}).some((entry) => entry !== null),
        `命中 ${String(hit.ref_id)} 至少由一条腿提供证据`,
      ).toBe(true)
    }
  })

  it('knowledge: the same envelope contract and per-leg evidence', async () => {
    await rt.knowledge.ingest(FACTS[0], 'tech', 'cache.md', '缓存失效策略')
    await rt.knowledge.ingest(FACTS[2], 'tech', 'gw.md', '网关')

    let captured: HybridResult<RecallHit> | undefined
    const hits = await rt.knowledge.search(QUERY, {
      limit: 5,
      includeScores: true,
      onResult: (result) => { captured = result },
    })
    expect(captured, 'the orchestrator result must reach the caller').toBeDefined()
    expect(Object.keys(captured?.weights ?? {}).sort(), 'the three-key contract').toEqual(['fts', 'jaccard', 'semantic'])
    expect(Object.keys(captured?.dropped_by_floor ?? {}).sort()).toEqual(['fts', 'hrr', 'jaccard', 'semantic'])
    expect(hits.length, 'the guard corpus must answer').toBeGreaterThan(0)
    for (const hit of hits) {
      expect(Object.values(hit.scores ?? {}).some((entry) => entry !== null)).toBe(true)
    }
  })
})
