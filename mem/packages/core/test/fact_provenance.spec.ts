/**
 * Batch 1, the write/read faces: P-07 validity + supersede audit, P-08 provenance, P-13 event time,
 * P-10 assertion counter — plus the P-07 invariants (with planted violations, so the check is
 * proven non-vacuous).
 *
 * One file because the four features share one schema generation and are exercised through the same
 * runtime; splitting them would rebuild the same store four times and hide the interactions that
 * matter (a source-filtered recall must not be mistaken for a floor problem; a revive must not move
 * the assertion counter; a superseded row must gain its end time).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { RETIRED_WITHOUT_VALID_TO_SQL, VALID_TO_BEFORE_VALID_FROM_SQL, validityInvariantViolations } from '../src/db/invariants.js'
import type { FactDetail } from '@avantf/mem-contract'
import type { SemanticBackend } from '@avantf/mem-retrieval'

/** No model, no download: these specs are about columns and predicates, not about embeddings. */
class NeverWarm implements SemanticBackend {
  readonly name = 'provenance_never_warm'
  readonly dim = 768
  isAvailable(): boolean { return false }
  async encode(): Promise<Float32Array> { throw new Error('no model') }
  async encodeBatch(): Promise<Float32Array[]> { throw new Error('no model') }
}

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-prov-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: new NeverWarm() })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

const add = (content: string, extra: Record<string, unknown> = {}) =>
  rt.remember({ action: 'add', content, ...extra })

/** `admin.detail` for a fact this test just wrote; throws instead of returning a nullable union. */
function detailOf(factId: number): FactDetail {
  const detail = rt.admin({ action: 'detail', fact_id: factId })
  if (detail === null || 'error' in detail) throw new Error(`fact_id=${String(factId)} not found`)
  return detail
}

// ─── P-13: event time / known end ──────────────────────────────────────────────

describe('P-13 event time and known end', () => {
  it('writes valid_from / valid_to and KEEPS the row active', async () => {
    const written = await add('发布窗口由陈静负责，代号 provenance-token-alpha', {
      event_date: '2026-01-02',
      valid_until: '2026-12-31',
    })
    expect(written.is_new).toBe(true)

    const detail = detailOf(written.fact_id)
    expect(detail.valid_from).toBe('2026-01-02')
    expect(detail.valid_to).toBe('2026-12-31')
    // The whole point of `valid_until` (P-07's reachability fix): a known end does NOT archive.
    expect(detail.status).toBe('active')
    expect(rt.admin({ action: 'list', limit: 10 }).facts.map((f) => f.fact_id)).toContain(written.fact_id)

    // …and it is therefore recallable, with the envelope carrying the validity only because the
    // values are non-null.
    const hits = await rt.recall({ action: 'search', query: 'provenance-token-alpha', limit: 5 })
    const hit = hits.hits.find((h) => h.ref_id === written.fact_id)
    expect(hit?.valid_from).toBe('2026-01-02')
    expect(hit?.valid_to).toBe('2026-12-31')
  })

  it('omits BOTH validity keys from the envelope when unknown (byte-identical default path)', async () => {
    const written = await add('没有任何事件时间的普通事实 provenance-token-plain')
    const hits = await rt.recall({ action: 'search', query: 'provenance-token-plain', limit: 5 })
    const hit = hits.hits.find((h) => h.ref_id === written.fact_id)
    expect(hit).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(hit, 'valid_from')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(hit, 'valid_to')).toBe(false)
  })

  it('refuses an unparseable date instead of storing it', async () => {
    await expect(add('坏日期的事实', { event_date: '2026-13-45' })).rejects.toThrow(/event_date/)
    await expect(add('坏终点的事实', { valid_until: '不是日期' })).rejects.toThrow(/valid_until/)
  })

  it('reports valid_from coverage in admin stats from the first write', async () => {
    await add('有事件时间 provenance-token-cov', { event_date: '2026-03-01' })
    await add('没有事件时间 provenance-token-nocov')
    const stats = rt.admin({ action: 'stats' })
    expect(stats.validity.active).toBe(2)
    expect(stats.validity.facts_with_valid_from).toBe(1)
    expect(stats.validity.coverage).toBeCloseTo(0.5, 10)
  })
})

// ─── P-07: supersede audit + invariants ────────────────────────────────────────

describe('P-07 validity and the supersede audit', () => {
  it('stamps valid_to on the replaced row and derives superseded_by in reverse', async () => {
    const first = await add('第一版说明 provenance-token-rev')
    const second = await rt.remember({
      action: 'update',
      fact_id: first.fact_id,
      content: '第二版说明 provenance-token-rev（已改写）',
    })

    const old = detailOf(first.fact_id)
    const next = detailOf(second.fact_id)
    expect(old.status).toBe('archived')
    expect(old.archive_reason).toBe('replaced')
    expect(old.valid_to).not.toBeNull()
    expect(old.superseded_by).toBe(second.fact_id)
    expect(next.supersedes_id).toBe(first.fact_id)
    expect(next.valid_to).toBeNull()
  })

  it('stamps valid_to on the loser of a true_positive contradiction verdict', async () => {
    const a = await add('服务端口是 8080 provenance-token-verdict-a')
    const b = await add('服务端口是 9090 provenance-token-verdict-b')
    // A logged pair (the detector's own shape); the verdict is what this test drives.
    rt.db
      .prepare('INSERT INTO contradiction_log (fact_a, fact_b, score, resolved) VALUES (?, ?, 0.9, 0)')
      .run(a.fact_id, b.fact_id)
    const id = Number(
      (rt.db.prepare('SELECT MAX(id) AS id FROM contradiction_log').get() as { id: number }).id,
    )
    const outcome = rt.admin({ action: 'contradict_resolve', contradiction_id: id, resolution: 'true_positive', loser_fact_id: b.fact_id })
    expect('error' in outcome).toBe(false)
    const loser = detailOf(b.fact_id)
    expect(loser.status).toBe('archived')
    expect(loser.archive_reason).toBe('contradiction')
    expect(loser.valid_to).not.toBeNull()
  })

  it('holds on a clean store, and the planted violation makes the check FAIL', () => {
    // Clean: nothing archived by a semantic path yet.
    expect(validityInvariantViolations(rt.db)).toEqual({ retired_without_valid_to: 0, valid_to_before_valid_from: 0 })

    // Plant violation ①: a row retired by `replaced` with no end time. If the SQL were vacuous
    // (always 0) this assertion — and the negative one above — would be indistinguishable.
    rt.db
      .prepare("INSERT INTO facts (content, category, settle_clock, status, archive_reason, created_at, updated_at) VALUES ('planted retired without end', 'general', 0, 'archived', 'replaced', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
      .run()
    expect(Number(rt.db.prepare<{ n: number }>(RETIRED_WITHOUT_VALID_TO_SQL).get()!.n)).toBe(1)

    // Plant violation ②: a known end before the known start.
    rt.db
      .prepare("INSERT INTO facts (content, category, settle_clock, status, valid_from, valid_to, created_at, updated_at) VALUES ('planted reversed window', 'general', 0, 'active', '2026-05-01', '2026-01-01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
      .run()
    expect(Number(rt.db.prepare<{ n: number }>(VALID_TO_BEFORE_VALID_FROM_SQL).get()!.n)).toBe(1)
  })
})

// ─── P-08: provenance ──────────────────────────────────────────────────────────

describe('P-08 provenance and reverse lookup', () => {
  it('records source_ref with a kind derived from its prefix, and never invents one', async () => {
    const session = await add('来自会话的事实 provenance-token-src-session', { source_ref: 'session:conv-42' })
    const kb = await add('来自知识库的事实 provenance-token-src-kb', { source_ref: 'kb_doc:design:arch:标题' })
    const manual = await add('手工来源的事实 provenance-token-src-manual', { source_ref: '随手记的出处' })
    const none = await add('没有来源的事实 provenance-token-src-none')

    const sourcesOf = (id: number) => detailOf(id).sources
    expect(sourcesOf(session.fact_id)).toEqual([{ kind: 'session', ref: 'conv-42' }])
    expect(sourcesOf(kb.fact_id)).toEqual([{ kind: 'kb_doc', ref: 'design:arch:标题' }])
    expect(sourcesOf(manual.fact_id)).toEqual([{ kind: 'manual', ref: '随手记的出处' }])
    expect(sourcesOf(none.fact_id)).toEqual([])
  })

  it('filters recall by source= inside the legs, and an empty source result is NOT a floor retry', async () => {
    const alpha = await add('主库缓存方案 alpha 记录 provenance-token-srcfilter', { source_ref: 'session:alpha' })
    const beta = await add('主库缓存方案 beta 记录 provenance-token-srcfilter', { source_ref: 'session:beta' })

    const onlyAlpha = await rt.recall({ action: 'search', query: 'provenance-token-srcfilter', limit: 10, source: 'alpha' })
    expect(onlyAlpha.hits.map((h) => h.ref_id)).toEqual([alpha.fact_id])

    // The source filter is applied by the legs, so an empty result stays empty and is not reported
    // as "the floors were relaxed behind the caller's back" (that retry would re-run the same
    // filter and burn a second pass for nothing).
    const none = await rt.recall({ action: 'search', query: 'provenance-token-srcfilter', limit: 10, source: 'does-not-exist' })
    expect(none.hits).toEqual([])
    expect(none.relaxed).toBeUndefined()

    // EXISTS, not JOIN: a fact with TWO sources must be returned exactly once.
    rt.db.prepare('INSERT OR IGNORE INTO fact_sources (fact_id, kind, ref) VALUES (?, ?, ?)').run(alpha.fact_id, 'manual', 'alpha')
    const stillOnce = await rt.recall({ action: 'search', query: 'provenance-token-srcfilter', limit: 10, source: 'alpha' })
    expect(stillOnce.hits.map((h) => h.ref_id)).toEqual([alpha.fact_id])
    expect(beta.fact_id).not.toBe(alpha.fact_id)
  })

  it('enumerates a source\'s facts through admin list, and reports coverage in stats', async () => {
    const one = await add('来源枚举一 provenance-token-list-1', { source_ref: 'kb_doc:notes:doc-a' })
    const two = await add('来源枚举二 provenance-token-list-2', { source_ref: 'kb_doc:notes:doc-a' })
    await add('别的来源 provenance-token-list-3', { source_ref: 'kb_doc:notes:doc-b' })
    await add('没有来源 provenance-token-list-4')

    const page = rt.admin({ action: 'list', source: 'notes:doc-a', limit: 50 })
    expect(page.facts.map((f) => f.fact_id).sort((x, y) => x - y)).toEqual([one.fact_id, two.fact_id].sort((x, y) => x - y))
    expect(page.total).toBe(2)
    expect(page.truncated).toBe(false)

    const stats = rt.admin({ action: 'stats' })
    expect(stats.sources.active).toBe(4)
    expect(stats.sources.facts_with_source).toBe(3)
    expect(stats.sources.coverage).toBeCloseTo(0.75, 10)
  })

  it('carries a revision\'s sources forward when the update names none', async () => {
    const first = await add('源要继承 provenance-token-inherit', { source_ref: 'tool:importer' })
    const second = await rt.remember({
      action: 'update',
      fact_id: first.fact_id,
      content: '源要继承（改写过） provenance-token-inherit',
    })
    expect(detailOf(second.fact_id).sources).toEqual([{ kind: 'tool', ref: 'importer' }])
  })
})

// ─── P-10: assertion counter ───────────────────────────────────────────────────

describe('P-10 assertion counter', () => {
  it('is 1 on a new row and moves only on a PURE duplicate add', async () => {
    const first = await add('被反复断言的事实 provenance-token-count')
    expect(first.assert_count).toBe(1)

    const again = await add('被反复断言的事实 provenance-token-count')
    expect(again.fact_id).toBe(first.fact_id)
    expect(again.is_new).toBe(false)
    expect(again.revived).toBe(false)
    expect(again.assert_count).toBe(2)

    const third = await add('被反复断言的事实 provenance-token-count')
    expect(third.assert_count).toBe(3)

    expect(detailOf(first.fact_id).assert_count).toBe(3)
  })

  it('does NOT count a revive: resurrection is not a new assertion', async () => {
    const first = await add('归档后再写回的事实 provenance-token-revive')
    await add('归档后再写回的事实 provenance-token-revive')
    expect((await add('归档后再写回的事实 provenance-token-revive')).assert_count).toBe(3)

    expect(rt.admin({ action: 'archive', fact_id: first.fact_id })).toBe(true)
    const revived = await add('归档后再写回的事实 provenance-token-revive')
    expect(revived.revived).toBe(true)
    expect(revived.assert_count).toBe(3)
  })
})

// ─── P-01: per-leg evidence ────────────────────────────────────────────────────

describe('P-01 per-leg evidence envelope', () => {
  it('is ABSENT by default and present only when asked, with raw + normalized + final', async () => {
    await add('主库统一走 PostgreSQL 的说明 provenance-token-evidence')

    const plain = await rt.recall({ action: 'search', query: 'provenance-token-evidence', limit: 5 })
    expect(plain.hits.length).toBeGreaterThan(0)
    for (const hit of plain.hits) {
      expect(Object.prototype.hasOwnProperty.call(hit, 'scores')).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(hit, 'final')).toBe(false)
    }

    const withScores = await rt.recall({ action: 'search', query: 'provenance-token-evidence', limit: 5, include_scores: true })
    expect(withScores.hits.length).toBe(plain.hits.length)
    // The ranking itself is IDENTICAL: evidence is purely additive.
    expect(withScores.hits.map((h) => h.ref_id)).toEqual(plain.hits.map((h) => h.ref_id))
    for (let i = 0; i < withScores.hits.length; i += 1) {
      const hit = withScores.hits[i]!
      expect(hit.final).toBeCloseTo(plain.hits[i]!.score, 12)
      const scores = hit.scores
      expect(scores).toBeDefined()
      // Every leg that was fused is keyed, including the ones that did not recall this hit (null).
      expect(Object.keys(scores!).sort()).toEqual(['fts', 'jaccard', 'semantic'])
      const fts = scores!.fts
      expect(fts).not.toBeNull()
      expect(fts!.normalized).toBeGreaterThan(0)
      expect(fts!.normalized).toBeLessThanOrEqual(1)
      expect(Number.isFinite(fts!.raw)).toBe(true)
    }
  })

  it('reaches the cross-store kb_query too (the knowledge store is the other fuse caller)', async () => {
    const ingested = await rt.kb({
      action: 'ingest',
      domain: 'notes',
      source: 'arch',
      title: '融合证据说明',
      text: '融合证据说明：检索结果可以携带每条腿的原始分与归一值 provenance-token-kbscore。',
    })
    expect((ingested as { error?: string }).error).toBeUndefined()

    const plain = await rt.query({ query: 'provenance-token-kbscore', limit: 5, max_tokens: 0 })
    expect(plain.hits.length).toBeGreaterThan(0)
    for (const hit of plain.hits) expect(Object.prototype.hasOwnProperty.call(hit, 'scores')).toBe(false)

    const scored = await rt.query({ query: 'provenance-token-kbscore', limit: 5, max_tokens: 0, include_scores: true })
    expect(scored.hits.map((h) => h.ref_id)).toEqual(plain.hits.map((h) => h.ref_id))
    const doc = scored.hits.find((h) => h.kind === 'doc_chunk')
    expect(doc).toBeDefined()
    expect(doc!.scores).toBeDefined()
    expect(doc!.final).toBeTypeOf('number')
  })
})
