import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecallResult } from '@avantf/mem-contract'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { extractEntities } from '../src/entities/extract.js'
import { ANCHOR_MIN, ANCHOR_RATE, anchorCeiling, anchoredOverlap, ENTITY_UNION_CAP, selectAnchors } from '../src/store/entity_leg.js'

/**
 * The entity leg's metric (`store/entity_leg.ts`).
 *
 * WHY THIS FILE EXISTS. The metric is a user-visible calibration surface (`retriever.min_jaccard`,
 * DESIGN §20.19), and the defect it fixes is DISTRIBUTION-SENSITIVE: the old Jaccard ratio only
 * fails on a corpus whose facts carry wide entity bags (the live store's median is 31). A fixture of
 * "1 answer + 1 distractor" would be GREEN under both the old and the new metric — the AGENTS.md
 * "分布敏感" rule. So the integration case below reproduces the real shape (one very wide fact
 * carrying the query's rare entity, surrounded by other wide notes) and asserts the properties that
 * changed, with a counterfactual proving the old metric really did reject it.
 */

describe('entity_leg: anchors', () => {
  it('scales the ceiling with the corpus and forgives small corpora', () => {
    // `max(ANCHOR_MIN, ceil(0.2N))`: on a 3-fact eval case the relative term is 1, so the floor is
    // what keeps every name (appearing 1–3 times) an anchor.
    expect(anchorCeiling(3)).toBe(ANCHOR_MIN)
    expect(anchorCeiling(10)).toBe(ANCHOR_MIN)
    expect(anchorCeiling(50)).toBe(10)
    expect(anchorCeiling(81)).toBe(Math.ceil(ANCHOR_RATE * 81))
  })

  it('keeps present-but-rare names and drops absent or corpus-wide ones', () => {
    const df = new Map([['rare', 2], ['generic', 12]])
    const names = ['rare', 'generic', 'absent']
    // N=44 ⇒ ceiling 9: `generic` (12) is corpus-wide, `absent` has df 0 and can never be shared.
    expect(selectAnchors(names, df, 44)).toEqual(['rare'])
    // N=100 ⇒ ceiling 20: the same map now keeps `generic` too.
    expect(selectAnchors(names, df, 100)).toEqual(['rare', 'generic'])
  })
})

describe('entity_leg: anchoredOverlap', () => {
  it('is exactly the Jaccard ratio while the fact is not wider than the cap', () => {
    // |A| = 2, W = 3 (two anchors + one absent query entity), |F| = 3, shared = 2:
    // Jaccard = 2 / (3 + 3 - 2) = 0.5, and the cap does not bind (F \ A = 1).
    expect(anchoredOverlap(['a', 'b'], 3, new Set(['a', 'b', 'x']))).toBeCloseTo(0.5, 12)
    // |F| = W + cap ⇒ still uncapped.
    expect(anchoredOverlap(['a', 'b'], 3, new Set(['a', 'b', 'x', 'y', 'z']))).toBeCloseTo(2 / 6, 12)
  })

  it('saturates the fact width past the cap so a wide bag cannot divide the score to nothing', () => {
    const wide = new Set(['a', ...Array.from({ length: 40 }, (_, i) => `x${String(i)}`)])
    // W=1, |F\A| = 40 ⇒ min(40, cap=3) = 3 ⇒ 1 / (1 + 3) = 0.25, not 1/41.
    expect(anchoredOverlap(['a'], 1, wide)).toBeCloseTo(1 / (1 + ENTITY_UNION_CAP), 12)
    expect(1 / wide.size).toBeLessThan(0.2) // the OLD Jaccard for this pair is structurally below the floor
  })

  it('orders a narrow fact above a wide one that shares the same entity', () => {
    const narrow = new Set(['a', 'b'])
    const wide = new Set(['a', ...Array.from({ length: 40 }, (_, i) => `x${String(i)}`)])
    expect(anchoredOverlap(['a'], 1, narrow)).toBeGreaterThan(anchoredOverlap(['a'], 1, wide))
  })

  it('is 0 for an empty anchor set and for no shared entity', () => {
    expect(anchoredOverlap([], 3, new Set(['a']))).toBe(0)
    expect(anchoredOverlap(['a'], 3, new Set(['b', 'c']))).toBe(0)
  })
})

describe('entity_leg: the memory store reaches a wide fact that shares the query’s rare entity', () => {
  const LONG =
    '生产环境的部署流程已经冻结：发布窗口定在每周三凌晨，回滚脚本必须先在预发环境演练通过，演练记录由值班同学签字确认后才允许合并。'
    + '监控面板聚合节点存活、队列积压与连接池占用三项指标，任一指标连续五分钟越过阈值就触发告警，告警会同时推送到值班群与工单系统。'
    + '数据库主从延迟的排查手册要求先看复制线程状态，再核对慢查询日志，最后比对两侧的表行数与校验和，确认无差异后才能恢复写入。'
    + '归档任务每天凌晨启动，把超过保留期的会话记录搬到冷存储，冷存储的读取路径单独限流，防止批量回放把在线查询拖慢。'
    + '容量评审每月一次，按最近四周的峰值水位留出两成余量，新增依赖必须在上线前补齐演练与回滚预案，否则不予放行。'

  it('keeps the wide answer reachable while a corpus-wide word yields no anchor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-entity-leg-'))
    const rt: AvantfRuntime = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      const shortId = (await rt.remember({ action: 'add', content: '冯飞负责支付网关' })).fact_id
      const wideId = (await rt.remember({ action: 'add', content: `${LONG}冯飞也参与了这个项目` })).fact_id
      for (let i = 0; i < 30; i += 1) await rt.remember({ action: 'add', content: `${LONG}（归档批次 ${String(i)}）` })
      for (let i = 0; i < 12; i += 1) await rt.remember({ action: 'add', content: `用户负责${String(i)}号模块` })

      // ── fixture self-check (the "分布敏感" rule): the wide fact really is wide, and the old
      //    Jaccard ratio for the very pair this test cares about was structurally below the floor.
      const wideBag = (await extractEntities(`${LONG}冯飞也参与了这个项目`)).length
      expect(wideBag, 'the wide fact carries a live-store-sized entity bag').toBeGreaterThan(15)
      expect(1 / wideBag, 'the OLD metric could not reach the 0.2 floor on this pair').toBeLessThan(0.2)
      expect((await extractEntities('冯飞负责支付网关')).length).toBeLessThan(5)

      const corpus = (rt.db.prepare("SELECT COUNT(*) AS c FROM facts WHERE status='active'").get() as { c: number }).c
      const docFrequency = (name: string): number =>
        (rt.db
          .prepare(
            `SELECT COUNT(*) AS c FROM fact_entities fe
               JOIN facts f ON f.fact_id = fe.fact_id
               JOIN entities e ON e.entity_id = fe.entity_id
              WHERE f.status = 'active' AND e.name = ?`,
          )
          .get(name) as { c: number }).c
      const df = new Map([['冯飞', docFrequency('冯飞')], ['用户', docFrequency('用户')]])
      // The whole point of the anchor filter: `用户` is corpus-wide (12 of 44 ⇒ above the ceiling)
      // and is NOT evidence; `冯飞` is rare and IS.
      expect(df.get('冯飞')).toBe(2)
      expect(df.get('用户')!).toBeGreaterThan(anchorCeiling(corpus))
      expect(selectAnchors(['冯飞'], df, corpus)).toEqual(['冯飞'])
      expect(selectAnchors(['用户'], df, corpus)).toEqual([])

      // Isolate the entity leg: the other three legs carry no weight.
      Object.assign(rt.config.common.retriever, {
        weight_semantic: 0,
        weight_fts: 0,
        weight_jaccard: 1,
        min_semantic_similarity: 0,
        min_fts_terms: 0,
        min_jaccard: 0.2,
      })

      const hit = await rt.memory.search({ query: '冯飞', limit: 5, floors: 'strict' }) as RecallResult
      // Both facts share the anchor; the narrow one still outranks the wide one (the ordering the old
      // Jaccard ratio provided), and — the fix — the wide one is NOT dropped by the floor.
      expect(hit.hits[0]?.ref_id, 'the narrow fact outranks the wide one').toBe(shortId)
      expect(hit.hits.map((h) => h.ref_id), 'the wide fact is reachable through the entity leg').toContain(wideId)
      expect(hit.dropped_by_floor?.jaccard, 'nothing was dropped below the floor').toBe(0)
    } finally {
      rt.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
