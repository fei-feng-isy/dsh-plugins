/**
 * Full-fidelity restore — the counterpart of the content-identity import loop.
 *
 * What this file pins, and why each property is load-bearing:
 *
 *   1. a v2 snapshot round-trips FIELD BY FIELD (ids, archived status, timestamps, trust, pin,
 *      counters, TTL, validity, supersedes chain, every provenance row). This is the whole promise
 *      of "restore", and a silently dropped column is exactly the failure the feature exists to fix
 *      (a real 233-fact library lost its 69 archived rows to export→import on 2026-10-20);
 *   2. FTS rows equal fact rows WITHOUT any hand-written FTS insert — the AFTER INSERT trigger is
 *      what lets the rebuild bypass `MemoryStore.add` and still be searchable;
 *   3. a v1 document (the shape every file already on disk has) restores, counts every column it
 *      could not carry in `metadata_missing`, and uses the CURRENT active-day clock as its
 *      `settle_clock` baseline instead of 0;
 *   4. a non-empty target is REFUSED with zero writes, and so is a second restore;
 *   5. a malformed document writes nothing — validation happens before the transaction, and a bad
 *      row inside it rolls the whole transaction back;
 *   6. `--dry-run` is a plan: it reports active/archived counts and the target's current fact count
 *      and writes nothing, even when the real run would be refused.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { FACTS_EXPORT_VERSION, exportFacts, parseFactsExport, type FactsExportDocument } from '../src/facts_io.js'
import { ENTITY_EXTRACTOR_VERSION } from '../src/entities/extract.js'

const homes: string[] = []
const runtimes: AvantfRuntime[] = []

/** One data home + one running runtime; everything is torn down in `afterEach`. */
function makeRuntime(label: string): AvantfRuntime {
  const home = mkdtempSync(join(tmpdir(), 'avantf-restore-' + label + '-'))
  homes.push(home)
  // No `memoryDbPath` override: `exportFacts` reads `config.memory.db.path`, which is the DEFAULT
  // `<home>/memory/memory.db` — overriding the store's file would leave export looking at a path
  // this runtime never created.
  const rt = buildRuntime({ dataHome: home })
  runtimes.push(rt)
  return rt
}

afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.shutdown()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function countOf(rt: AvantfRuntime, sql: string): number {
  return Number((rt.db.prepare(sql).get() as { n: number }).n)
}

function rowOf(rt: AvantfRuntime, factId: number): Record<string, unknown> {
  const row = rt.db.prepare('SELECT * FROM facts WHERE fact_id = ?').get(factId) as Record<string, unknown> | undefined
  expect(row, 'fact ' + String(factId)).toBeTruthy()
  return row as Record<string, unknown>
}

function sourcesOf(rt: AvantfRuntime, factId: number): { kind: string; ref: string }[] {
  return rt.db.prepare('SELECT kind, ref FROM fact_sources WHERE fact_id = ? ORDER BY kind ASC, ref ASC')
    .all(factId) as { kind: string; ref: string }[]
}

function sortedSources(list: readonly { kind: string; ref: string }[]): { kind: string; ref: string }[] {
  return [...list]
    .map((source) => ({ kind: source.kind, ref: source.ref }))
    .sort((a, b) => (a.kind === b.kind ? (a.ref < b.ref ? -1 : 1) : (a.kind < b.kind ? -1 : 1)))
}

const BASE_DOC = {
  format: 'avantf-mem-facts',
  exported_at: '2026-10-20T08:00:00.000Z',
  source: { data_home: '/tmp/home', db: '/tmp/home/memory.db', counts: { active: 0, archived: 0 } },
}

function docOf(facts: unknown[], version = 2): FactsExportDocument {
  return parseFactsExport(JSON.stringify({ ...BASE_DOC, version, facts }))
}

/** The v1 field set, i.e. a fact entry as the historical exporter wrote it. */
function v1Fact(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_id: 1,
    content: '一条事实',
    category: 'general',
    status: 'active',
    created_at: '2026-09-01 01:00:00',
    updated_at: '2026-09-02 02:00:00',
    ttl_days: 0,
    pinned: false,
    pinned_at: null,
    trust_score: 0.5,
    assert_count: 1,
    helpful_count: 0,
    last_reinforced_at: null,
    sources: [],
    valid_from: null,
    valid_to: null,
    supersedes_source_id: null,
    archive: null,
    ...over,
  }
}

describe('restore (v2 round trip)', () => {
  it('brings back every field, the ids, the archived rows and all provenance — and FTS follows', async () => {
    const source = makeRuntime('v2-src')
    const plain = await source.remember({ action: 'add', content: '平台组负责统一网关', category: 'project', ttl_days: 30 })
    const replaced = await source.remember({ action: 'add', content: '旧版：项目使用 MySQL' })
    const revision = await source.remember({ action: 'update', fact_id: replaced.fact_id, content: '新版：项目使用 PostgreSQL' })
    const pinned = await source.remember({ action: 'add', content: '陈静加入平台组' })
    source.admin({ action: 'pin', fact_id: pinned.fact_id })
    const archived = await source.remember({ action: 'add', content: '已经遗忘的低信任事实' })
    source.admin({ action: 'archive', fact_id: archived.fact_id, reason: 'forgot' })

    // The values an add/pin/archive CANNOT produce but the document still carries: v2's whole point.
    source.db.prepare(
      `UPDATE facts SET trust_score = ?, settle_clock = ?, assert_count = ?, helpful_count = ?,
          bonus_count = ?, bonus_window_at = ?, retrieval_count = ?, last_retrieved_at = ?,
          valid_from = ?, valid_to = ?, mirror_source = ?, mirror_target = ?,
          pinned_at = ?, last_reinforced_at = ?
        WHERE fact_id = ?`,
    ).run(
      0.83, 5, 4, 2, 2, '2026-10-20 00:00:00', 7, '2026-10-19 23:00:00',
      '2026-09-01', '2026-12-31', 'laptop', 'desktop', '2026-10-01 00:00:00', '2026-10-02 00:00:00',
      plain.fact_id,
    )
    // A fact may carry SEVERAL sources; import collapses them into one ref string, restore must not.
    source.db.prepare('INSERT INTO fact_sources (fact_id, kind, ref) VALUES (?, ?, ?)').run(plain.fact_id, 'tool', 'avantf-mem')
    source.db.prepare('INSERT INTO fact_sources (fact_id, kind, ref) VALUES (?, ?, ?)').run(plain.fact_id, 'session', 's-42')

    const doc = exportFacts(source)
    expect(doc.version).toBe(FACTS_EXPORT_VERSION)
    expect(doc.version).toBe(2)
    expect(doc.facts).toHaveLength(5)
    for (const fact of doc.facts) {
      // The v2-only keys are PRESENT on every row (null where unknown), never absent.
      expect(Object.hasOwn(fact, 'settle_clock')).toBe(true)
      expect(Object.hasOwn(fact, 'retrieval_count')).toBe(true)
      expect(Object.hasOwn(fact, 'mirror_source')).toBe(true)
    }

    const target = makeRuntime('v2-dst')
    const report = await target.memory.restoreFacts(doc)

    expect(report).toMatchObject({
      version: 2,
      restored: 5,
      active: 3,
      archived: 2,
      fts_rows: 5,
    })
    expect(report.dry_run).toBeUndefined()
    expect(report.would_restore).toBeUndefined()
    // Nothing was missing: this document stated every field.
    expect(Object.values(report.metadata_missing).every((count) => count === 0)).toBe(true)
    expect(report.vectors).toMatchObject({ restored: 0 })
    expect(report.vectors.hint).toContain('vectors --fix')
    // The derived state ran: every ACTIVE row was re-extracted, none deferred.
    expect(report.entities).toEqual({ rebuilt: 3, deferred: 0, skipped: false })

    for (const fact of doc.facts) {
      const row = rowOf(target, fact.source_id)
      expect(row.fact_id).toBe(fact.source_id)
      expect(row.content).toBe(fact.content)
      expect(row.category).toBe(fact.category)
      expect(row.status).toBe(fact.status)
      expect(row.created_at).toBe(fact.created_at)
      expect(row.updated_at).toBe(fact.updated_at)
      expect(row.ttl_days).toBe(fact.ttl_days)
      expect(Boolean(row.pinned)).toBe(fact.pinned)
      expect(row.pinned_at ?? null).toBe(fact.pinned_at ?? null)
      expect(Number(row.trust_score)).toBeCloseTo(fact.trust_score, 9)
      expect(row.settle_clock).toBe(fact.settle_clock)
      expect(row.assert_count).toBe(fact.assert_count)
      expect(row.helpful_count).toBe(fact.helpful_count)
      expect(row.last_reinforced_at ?? null).toBe(fact.last_reinforced_at ?? null)
      expect(row.valid_from ?? null).toBe(fact.valid_from ?? null)
      expect(row.valid_to ?? null).toBe(fact.valid_to ?? null)
      expect(row.supersedes_id ?? null).toBe(fact.supersedes_source_id ?? null)
      expect(row.bonus_count).toBe(fact.bonus_count)
      expect(row.bonus_window_at ?? null).toBe(fact.bonus_window_at ?? null)
      expect(row.retrieval_count).toBe(fact.retrieval_count)
      expect(row.last_retrieved_at ?? null).toBe(fact.last_retrieved_at ?? null)
      expect(row.mirror_source ?? null).toBe(fact.mirror_source ?? null)
      expect(row.mirror_target ?? null).toBe(fact.mirror_target ?? null)
      expect(row.archived_at ?? null).toBe(fact.archive?.at ?? null)
      expect(row.archive_reason ?? null).toBe(fact.archive?.reason ?? null)
      // Vectors are NOT part of the snapshot; the entity sweep writes the HRR bundle, never this one.
      expect(row.semantic_vector).toBeNull()
      // No corpus-wide conflict re-scan after a rebuild.
      expect(row.conflict_checked).toBe(1)
      expect(sortedSources(sourcesOf(target, fact.source_id))).toEqual(sortedSources(fact.sources))
      if (fact.status === 'active') expect(row.entities_version).toBe(ENTITY_EXTRACTOR_VERSION)
      else expect(row.entities_version).toBe(0)
    }

    // The supersedes chain is self-consistent: the revision names the archived row it replaced.
    expect(rowOf(target, revision.fact_id).supersedes_id).toBe(replaced.fact_id)

    // FTS: without a hand-written insert, the trigger indexed exactly the restored rows.
    expect(countOf(target, 'SELECT COUNT(*) AS n FROM facts_fts')).toBe(5)
    expect(countOf(target, 'SELECT COUNT(*) AS n FROM facts')).toBe(5)

    // Derived state is non-empty and points at the restored text.
    expect(countOf(target, 'SELECT COUNT(*) AS n FROM entities')).toBeGreaterThan(0)
    const names = (target.db.prepare(
      'SELECT e.name FROM fact_entities fe JOIN entities e ON e.entity_id = fe.entity_id WHERE fe.fact_id = ?',
    ).all(plain.fact_id) as { name: string }[]).map((row) => row.name)
    expect(names).toContain('网关')
    // The multi-source fact really has two rows, and the pinned row is still pinned.
    expect(sourcesOf(target, plain.fact_id)).toHaveLength(2)
    expect(Boolean(rowOf(target, pinned.fact_id).pinned)).toBe(true)
    expect(Boolean(rowOf(target, pinned.fact_id).pinned)).toBe(true)
  }, 60_000)
});

describe('restore (v1 documents)', () => {
  it('restores a REAL-shaped v1 file: archived rows return, settle_clock uses the current clock', async () => {
    const doc = parseFactsExport(
      readFileSync(new URL('./fixtures/facts_v1_export.json', import.meta.url), 'utf8'),
    )
    expect(doc.version).toBe(1)

    const target = makeRuntime('v1')
    // A non-zero active-day clock BEFORE the restore. A v1 row has no settle_clock, so the fallback
    // must be "now" (7): 0 would decay every restored fact by the host's whole clock on the next
    // settlement, which is the retroactive decay this branch exists to avoid.
    target.db.prepare("INSERT OR REPLACE INTO avantf_stats (key, value) VALUES ('trust_clock', '7')").run()

    const report = await target.memory.restoreFacts(doc)
    expect(report).toMatchObject({ version: 1, restored: 4, active: 2, archived: 2, fts_rows: 4 })
    expect(report.entities).toEqual({ rebuilt: 2, deferred: 0, skipped: false })

    // The archived half came back ARCHIVED, with its own timestamp and reason — the exact loss that
    // made this feature necessary (69 archived facts never returned through import).
    const old = rowOf(target, 2)
    expect(old.status).toBe('archived')
    expect(old.archived_at).toBe('2026-08-10 02:00:00')
    expect(old.archive_reason).toBe('superseded')
    expect(Number(old.trust_score)).toBeCloseTo(0.31, 9)
    expect(old.valid_to).toBe('2026-08-10')
    expect(rowOf(target, 4).archive_reason).toBe('forgot')

    // The supersedes chain survived, and the pinned/revision row kept its pin.
    expect(rowOf(target, 3).supersedes_id).toBe(2)
    expect(Boolean(rowOf(target, 3).pinned)).toBe(true)
    expect(rowOf(target, 3).pinned_at).toBe('2026-08-11 00:00:00')

    // Timestamps are the document's, never "now".
    expect(rowOf(target, 1).created_at).toBe('2026-09-01 01:00:00')
    expect(rowOf(target, 1).updated_at).toBe('2026-09-02 02:00:00')
    expect(rowOf(target, 1).assert_count).toBe(3)
    expect(rowOf(target, 1).helpful_count).toBe(1)
    expect(rowOf(target, 1).last_reinforced_at).toBe('2026-09-04 00:00:00')
    expect(rowOf(target, 1).ttl_days).toBe(30)
    expect(rowOf(target, 1).valid_from).toBe('2026-09-01')

    // The one substitution: the CURRENT clock as the no-decay baseline, trust preserved.
    for (const factId of [1, 2, 3, 4]) {
      expect(rowOf(target, factId).settle_clock, 'fact ' + String(factId)).toBe(7)
    }
    expect(Number(rowOf(target, 1).trust_score)).toBeCloseTo(0.82, 9)
    expect(sourcesOf(target, 1)).toEqual([
      { kind: 'manual', ref: 'session:s-1' },
      { kind: 'tool', ref: 'avantf-mem' },
    ])

    // Every column v1 could not carry is counted ONCE PER FACT instead of being invented.
    const missing = report.metadata_missing
    for (const field of [
      'settle_clock', 'bonus_count', 'bonus_window_at', 'retrieval_count',
      'last_retrieved_at', 'mirror_source', 'mirror_target', 'entities_version', 'conflict_checked',
    ] as const) {
      expect(missing[field], field).toBe(4)
    }
    // ...and every column v1 DID carry is not counted (null is a stated value, not an absence).
    for (const field of [
      'category', 'created_at', 'updated_at', 'trust_score', 'pinned', 'pinned_at',
      'assert_count', 'helpful_count', 'last_reinforced_at', 'ttl_days', 'valid_from',
      'valid_to', 'supersedes_source_id', 'archive', 'sources',
    ] as const) {
      expect(missing[field], field).toBe(0)
    }

    // FTS again by trigger, and the derived entity graph exists for the ACTIVE half.
    expect(countOf(target, 'SELECT COUNT(*) AS n FROM facts_fts')).toBe(4)
    expect(countOf(target, 'SELECT COUNT(*) AS n FROM entities')).toBeGreaterThan(0)
    expect(rowOf(target, 1).conflict_checked).toBe(1)
    expect(rowOf(target, 1).entities_version).toBe(ENTITY_EXTRACTOR_VERSION)
    expect(rowOf(target, 2).entities_version).toBe(0)
    expect(rowOf(target, 1).semantic_vector).toBeNull()
  }, 60_000)

  it('counts a field only when the document does not carry the KEY at all', async () => {
    // A row that predates even v1's ttl_days/created_at columns: the fallbacks apply, and the
    // report names exactly those three absences.
    const fact = v1Fact({ content: '缺字段的事实' })
    delete fact['created_at']
    delete fact['updated_at']
    delete fact['ttl_days']
    const target = makeRuntime('v1-partial')
    const report = await target.memory.restoreFacts(docOf([fact], 1))
    expect(report.restored).toBe(1)
    expect(report.metadata_missing.created_at).toBe(1)
    expect(report.metadata_missing.updated_at).toBe(1)
    expect(report.metadata_missing.ttl_days).toBe(1)
    expect(report.metadata_missing.pinned_at).toBe(0)
    expect(report.metadata_missing.valid_to).toBe(0)
    expect(report.metadata_missing.archive).toBe(0)
    const row = rowOf(target, 1)
    expect(String(row.created_at).length).toBeGreaterThan(10)
    expect(row.ttl_days).toBe(0)
  }, 60_000)
});

describe('restore (the empty-table rule)', () => {
  it('refuses a non-empty library with zero writes, and refuses a second restore', async () => {
    const source = makeRuntime('refuse-src')
    await source.remember({ action: 'add', content: '源库事实' })
    const doc = exportFacts(source)

    const target = makeRuntime('refuse-dst')
    await target.remember({ action: 'add', content: '目标库自己的事实' })
    const before = countOf(target, 'SELECT COUNT(*) AS n FROM facts')
    await expect(target.memory.restoreFacts(doc)).rejects.toThrow(/不是空的/)
    expect(countOf(target, 'SELECT COUNT(*) AS n FROM facts')).toBe(before)
    expect(countOf(target, "SELECT COUNT(*) AS n FROM facts WHERE content = '源库事实'")).toBe(0)
    // The refusal is about the TARGET, and it names the way out.
    await expect(target.memory.restoreFacts(doc)).rejects.toThrow(/import \/ merge/)

    // A legitimately empty library accepts the first restore and refuses the second one.
    const empty = makeRuntime('refuse-empty')
    const first = await empty.memory.restoreFacts(doc)
    expect(first.restored).toBe(1)
    await expect(empty.memory.restoreFacts(doc)).rejects.toThrow(/不是空的/)
    expect(countOf(empty, 'SELECT COUNT(*) AS n FROM facts')).toBe(1)
  }, 60_000)

  it('writes nothing on a malformed document, and rolls the transaction back on a bad row', async () => {
    const target = makeRuntime('bad-doc')

    await expect(target.memory.restoreFacts(docOf([v1Fact({ content: '' })]))).rejects.toThrow(/缺少内容/)
    await expect(target.memory.restoreFacts(docOf([v1Fact({ status: 'deleted' })]))).rejects.toThrow(/status 无效/)
    expect(() => docOf([v1Fact()], 3)).toThrow(/不支持的导出格式版本/)
    await expect(
      target.memory.restoreFacts(docOf([v1Fact(), v1Fact({ content: '第二条' })])),
    ).rejects.toThrow(/出现了多次/)

    // A row whose provenance kind is outside the closed vocabulary: the INSERT fails inside the
    // transaction, so the row BEFORE it must not survive either.
    await expect(
      target.memory.restoreFacts(docOf([
        v1Fact({ source_id: 1, content: '好的那一条' }),
        v1Fact({ source_id: 2, content: '坏的那一条', sources: [{ kind: 'nope', ref: 'x' }] }),
      ])),
    ).rejects.toThrow(/写入事实失败/)

    expect(countOf(target, 'SELECT COUNT(*) AS n FROM facts')).toBe(0)
    expect(countOf(target, 'SELECT COUNT(*) AS n FROM facts_fts')).toBe(0)
    expect(countOf(target, 'SELECT COUNT(*) AS n FROM fact_sources')).toBe(0)
  }, 60_000)

  it('--dry-run reports the plan and writes nothing, even on a non-empty target', async () => {
    const source = makeRuntime('dry-src')
    await source.remember({ action: 'add', content: '待恢复甲' })
    const second = await source.remember({ action: 'add', content: '待恢复乙' })
    source.admin({ action: 'archive', fact_id: second.fact_id })
    const doc = exportFacts(source)

    const target = makeRuntime('dry-dst')
    const plan = await target.memory.restoreFacts(doc, { dryRun: true })
    expect(plan).toMatchObject({
      version: 2,
      dry_run: true,
      would_restore: { total: 2, active: 1, archived: 1 },
      target_facts: 0,
      restored: 0,
      active: 0,
      archived: 0,
      fts_rows: 0,
    })
    expect(plan.entities).toEqual({ rebuilt: 0, deferred: 0, skipped: false })
    expect(Object.values(plan.metadata_missing).every((count) => count === 0)).toBe(true)
    expect(countOf(target, 'SELECT COUNT(*) AS n FROM facts')).toBe(0)

    // On a NON-empty target a plan is still a plan: it reports the target's facts instead of
    // throwing, so the operator learns the real run would be refused BEFORE running it.
    await target.remember({ action: 'add', content: '目标库自有事实' })
    const blocked = await target.memory.restoreFacts(doc, { dryRun: true })
    expect(blocked.target_facts).toBe(1)
    expect(blocked.would_restore).toMatchObject({ total: 2 })
    expect(countOf(target, 'SELECT COUNT(*) AS n FROM facts')).toBe(1)
  }, 60_000)
});


