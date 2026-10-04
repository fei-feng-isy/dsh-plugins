import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { openMemoryDb } from '../src/db/conn.js'
import { MemoryStore } from '../src/store/memory.js'
import { LocalNumpyVectorStore, type SemanticBackend } from '@avantf/mem-retrieval'
import { defaultConfig, type VectorsFixReport } from '@avantf/mem-contract'
import { float32ToBytes } from '../src/db/vectors.js'
import { runMaintenance } from '../src/lifecycle/maintenance.js'
import { ENTITY_EXTRACTOR_VERSION } from '../src/entities/extract.js'
import { readClock } from '../src/lifecycle/presence.js'
import { encodeHrrEntityVector, hrrFromBytes, hrrToBytes, phaseSimilarity } from '../src/hrr/index.js'

/** A persisted-vector blob with the configured 768 dim (unit basis vector). */
function fakeVector(axis: number): Buffer {
  const v = new Float32Array(768)
  v[axis] = 1
  return float32ToBytes(v)
}

/**
 * A backend that is NEVER available, injected instead of assumed.
 *
 * "The test env has no model" is true on a clean machine and false on one whose cache
 * (`~/.avantf/models`) is populated — and there `vectors_fix`'s warmup SUCCEEDS, so a test
 * asserting "nothing was re-encoded" flips to "one row was re-encoded". Under the full suite's
 * load the warmup tends to fail on its own, which hides it: green for a reason that is not the
 * property under test. Injecting says which world the assertion is about.
 */
class NeverWarm implements SemanticBackend {
  readonly name = 'never_warm'
  readonly dim = 768
  isAvailable(): boolean { return false }
  async encode(): Promise<Float32Array> { throw new Error('no model') }
  async encodeBatch(): Promise<Float32Array[]> { throw new Error('no model') }
}

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-mem-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

describe('memory store', () => {
  it('adds and retrieves a fact via FTS', async () => {
    const add = await rt.remember({ action: 'add', content: '张伟管理李娜' })
    expect(add.is_new).toBe(true)
    const hit = await rt.recall({ action: 'search', query: '理李娜' })
    expect(hit.hits.length).toBeGreaterThan(0)
    expect(hit.hits[0].text).toContain('张伟')
    expect(hit.hits[0].source_ref).toBe(`memory:fact:${add.fact_id}`)
  })

  it('is idempotent on duplicate content', async () => {
    const first = await rt.remember({ action: 'add', content: '项目使用 PostgreSQL' })
    const second = await rt.remember({ action: 'add', content: '项目使用 PostgreSQL' })
    expect(first.is_new).toBe(true)
    expect(second.is_new).toBe(false)
    expect(second.revived).toBe(false)
  })

  it('revives an archived fact on re-add', async () => {
    const a = await rt.remember({ action: 'add', content: '老王喜欢简洁回答' })
    await rt.admin({ action: 'archive', fact_id: a.fact_id })
    const re = await rt.remember({ action: 'add', content: '老王喜欢简洁回答' })
    expect(re.revived).toBe(true)
  })

  it('lists active facts and archives removes them', async () => {
    const a = await rt.remember({ action: 'add', content: '陈静加入平台组' })
    const before = rt.admin({ action: 'list', status: 'active' })
    expect(before.facts.length).toBe(1)
    await rt.admin({ action: 'archive', fact_id: a.fact_id })
    const after = rt.admin({ action: 'list', status: 'active' })
    expect(after.facts.length).toBe(0)
  })

  it('updates a fact via supersedes chain', async () => {
    const a = await rt.remember({ action: 'add', content: '项目使用 MySQL' })
    const upd = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '项目使用 PostgreSQL' })
    expect(upd.fact_id).not.toBe(a.fact_id)
    const detail = rt.memory.get(upd.fact_id)
    expect(detail?.supersedes_id).toBe(a.fact_id)
  })

  it('a revision inherits created_at and gets a fresh updated_at; the replaced row is archived', async () => {
    // The memory's FIRST assertion time is the thing a model needs for "what happened around
    // then", so it has to survive a rewrite — while `updated_at` still says the row changed.
    const a = await rt.remember({ action: 'add', content: '项目使用 MySQL' })
    // A decisive past value: if the revision wrongly took the column DEFAULT, `created_at`
    // would be "now" instead of this.
    rt.db.prepare("UPDATE facts SET created_at = '2020-01-01 00:00:00', updated_at = '2020-01-01 00:00:00' WHERE fact_id = ?").run(a.fact_id)
    const upd = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '项目使用 PostgreSQL' })
    const row = (id: number): { created_at: string; updated_at: string; status: string; archive_reason: string | null; last_retrieved_at: string | null } =>
      rt.db.prepare('SELECT created_at, updated_at, status, archive_reason, last_retrieved_at FROM facts WHERE fact_id = ?').get(id) as never

    const oldRow = row(a.fact_id)
    const newRow = row(upd.fact_id)
    expect(newRow.created_at).toBe('2020-01-01 00:00:00') // inherited, not "now"
    expect(newRow.created_at).toBe(oldRow.created_at)
    expect(newRow.updated_at).not.toBe(oldRow.updated_at)
    expect(newRow.updated_at > oldRow.updated_at).toBe(true)
    // The loser is retired, not merely unlinked.
    expect(oldRow.status).toBe('archived')
    expect(oldRow.archive_reason).toBe('replaced')
    // `last_retrieved_at` is re-stamped on the insert, so the inherited OLD created_at cannot
    // make the fresh revision look idle to the next tick (see lifecycle.spec.ts regression).
    expect(newRow.last_retrieved_at).not.toBeNull()
  })

  it('a recall hit carries both timestamps, and retrieval does not move updated_at', async () => {
    const a = await rt.remember({ action: 'add', content: '命中行要带两个时间' })
    const hit = (await rt.recall({ action: 'search', query: '命中行要带两个时间' })).hits.find((h) => h.ref_id === a.fact_id)!
    expect(hit.created_at).toMatch(/^\d{4}-\d{2}-\d{2} /)
    expect(hit.updated_at).not.toBeNull()

    // A recall is a USE (`last_retrieved_at` moves), not a CHANGE. Backdate updated_at to a
    // value a same-second write could not produce, then confirm the search left it alone.
    rt.db.prepare("UPDATE facts SET updated_at = '2020-01-01 00:00:00' WHERE fact_id = ?").run(a.fact_id)
    const after = (await rt.recall({ action: 'search', query: '命中行要带两个时间' })).hits.find((h) => h.ref_id === a.fact_id)!
    expect(after.updated_at).toBe('2020-01-01 00:00:00')
    expect(after.created_at).toBe(hit.created_at)
  })
})

/**
 * One rule across every branch of `persistFact`: an explicitly provided category / TTL
 * lands on the surviving row, an omitted one keeps what that row already has, and a
 * brand-new row falls back to the defaults. Both halves were broken — a duplicate hit
 * reset the values (re-adding without a category wiped it) and a revision DROPPED them
 * (update passed `undefined`, so an explicit TTL silently became 0).
 */
describe('category / ttl_days on every write branch', () => {
  const meta = (id: number): { category: string; ttl_days: number } =>
    rt.db.prepare('SELECT category, ttl_days FROM facts WHERE fact_id = ?').get(id) as { category: string; ttl_days: number }

  it('a duplicate add keeps the stored values, and applies explicitly given ones', async () => {
    const a = await rt.remember({ action: 'add', content: '项目使用 PostgreSQL', category: 'project', ttl_days: 30 })
    const omitted = await rt.remember({ action: 'add', content: '项目使用 PostgreSQL' })
    expect(omitted.fact_id).toBe(a.fact_id)
    expect(meta(a.fact_id)).toEqual({ category: 'project', ttl_days: 30 })

    const explicit = await rt.remember({ action: 'add', content: '项目使用 PostgreSQL', category: 'tool', ttl_days: 7 })
    expect(explicit.fact_id).toBe(a.fact_id)
    expect(meta(a.fact_id)).toEqual({ category: 'tool', ttl_days: 7 })
  })

  it('a revision inherits the category and TTL of the fact it replaces', async () => {
    const a = await rt.remember({ action: 'add', content: '这条事实 30 天后失效', category: 'project', ttl_days: 30 })
    const upd = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '这条事实改写后仍 30 天后失效' })
    expect(upd.is_new).toBe(true)
    expect(meta(upd.fact_id)).toEqual({ category: 'project', ttl_days: 30 })
  })

  it('reviving an archived fact keeps its TTL when none is given', async () => {
    const a = await rt.remember({ action: 'add', content: '这条事实 5 天后失效', ttl_days: 5 })
    await rt.admin({ action: 'archive', fact_id: a.fact_id })
    const revived = await rt.remember({ action: 'add', content: '这条事实 5 天后失效' })
    expect(revived.revived).toBe(true)
    expect(meta(a.fact_id)).toEqual({ category: 'general', ttl_days: 5 })
  })

  it('a no-op update applies an explicit category (previously "完成" over a no-op)', async () => {
    const a = await rt.remember({ action: 'add', content: '同内容改分类', category: 'general' })
    const upd = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '同内容改分类', category: 'user_env' })
    expect(upd.fact_id).toBe(a.fact_id)
    expect(meta(a.fact_id).category).toBe('user_env')
  })

  it('a no-op update applies an explicit TTL too', async () => {
    const a = await rt.remember({ action: 'add', content: '同内容改有效期', ttl_days: 30 })
    const upd = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '同内容改有效期', ttl_days: 1 })
    expect(upd.fact_id).toBe(a.fact_id)
    expect(meta(a.fact_id).ttl_days).toBe(1)
  })

  it('a revision applies an explicitly given TTL instead of inheriting it', async () => {
    // `update` inherits the replaced row's TTL when none is given; an explicit one must win
    // (it reaches `persistFact` through the tool schema → runtime → store chain).
    const a = await rt.remember({ action: 'add', content: '会被改写并改有效期', category: 'project', ttl_days: 30 })
    const upd = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '改写后仍要 7 天', ttl_days: 7 })
    expect(upd.is_new).toBe(true)
    expect(meta(upd.fact_id)).toEqual({ category: 'project', ttl_days: 7 })
  })

  it('ttl_days = 0 revokes the expiry instead of inheriting it', async () => {
    // 0 must be treated as a VALUE (`??` only falls through on null/undefined), otherwise a
    // model that set a TTL could only ever replace it with another positive number.
    const a = await rt.remember({ action: 'add', content: '先设 30 天再取消', ttl_days: 30 })
    const upd = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '取消了有效期的事实', ttl_days: 0 })
    expect(upd.is_new).toBe(true)
    expect(meta(upd.fact_id).ttl_days).toBe(0)

    // …and a brand-new fact can be written without an expiry explicitly.
    const b = await rt.remember({ action: 'add', content: '明确不设有效期的事实', ttl_days: 0 })
    expect(meta(b.fact_id).ttl_days).toBe(0)
  })

  it('a merge neither retags nor re-times the fact it lands on — unless told to', async () => {
    const target = await rt.remember({ action: 'add', content: '老王不喜欢小红', category: 'project', ttl_days: 3 })
    const source = await rt.remember({ action: 'add', content: '陈静加入平台组', category: 'user_env', ttl_days: 9 })
    // The caller addressed `source` and said nothing about category/TTL: the surviving row
    // is `target`, and it must keep ITS values (NOT inherit the source's).
    const merged = await rt.remember({ action: 'update', fact_id: source.fact_id, content: '老王不喜欢小红' })
    expect(merged.fact_id).toBe(target.fact_id)
    expect(meta(target.fact_id)).toEqual({ category: 'project', ttl_days: 3 })

    // An explicit category is the caller's intent for the surviving fact, so it lands.
    const other = await rt.remember({ action: 'add', content: '张伟负责支付网关', category: 'general' })
    const explicit = await rt.remember({ action: 'update', fact_id: other.fact_id, content: '老王不喜欢小红', category: 'tool' })
    expect(explicit.fact_id).toBe(target.fact_id)
    expect(meta(target.fact_id).category).toBe('tool')

    // …and so does an explicit TTL, without touching the category it already has.
    const otherTtl = await rt.remember({ action: 'add', content: '李娜负责风控引擎', category: 'general' })
    const explicitTtl = await rt.remember({ action: 'update', fact_id: otherTtl.fact_id, content: '老王不喜欢小红', ttl_days: 5 })
    expect(explicitTtl.fact_id).toBe(target.fact_id)
    expect(meta(target.fact_id)).toEqual({ category: 'tool', ttl_days: 5 })
  })
})

describe('update keeps the fact fully indexed', () => {
  it('re-extracts entities/triples and stays visible to entity paths', async () => {
    const a = await rt.remember({ action: 'add', content: '项目使用 MySQL' })
    const upd = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '张伟负责支付网关' })
    const detail = rt.memory.get(upd.fact_id)
    expect(detail?.entities.length).toBeGreaterThan(0) // was [] before the fix
    // The updated fact is findable through the entity-join reason path.
    const reason = (await rt.recall({ action: 'reason', entities: detail!.entities.slice(0, 1) })) as { hits: { ref_id: number }[] }
    expect(reason.hits.some((h) => h.ref_id === upd.fact_id)).toBe(true)
    // The old fact is archived and no longer returned by search.
    const search = (await rt.recall({ action: 'search', query: '项目使用 MySQL' })) as { hits: { ref_id: number }[] }
    expect(search.hits.some((h) => h.ref_id === a.fact_id)).toBe(false)
  })

  it('updating to duplicate content still links the supersedes chain', async () => {
    const a = await rt.remember({ action: 'add', content: '甲事实内容' })
    const b = await rt.remember({ action: 'add', content: '乙事实内容' })
    const upd = await rt.remember({ action: 'update', fact_id: a.fact_id, content: '乙事实内容' })
    expect(upd.fact_id).toBe(b.fact_id) // duplicate content → existing row
    const detail = rt.memory.get(b.fact_id)
    expect(detail?.supersedes_id).toBe(a.fact_id)
    const old = rt.memory.get(a.fact_id)
    expect(old?.status).toBe('archived')
  })
})

/**
 * Derived state follows the RULES, not the write (DESIGN §20.16).
 *
 * `facts.entities_version` exists so an extraction change can reach facts that were written
 * before it — otherwise the corpus carries two vintages forever and retrieval quality depends on
 * when a fact happened to be written. The rebuild must REPLACE the rows: `linkFact` is additive
 * (`INSERT OR IGNORE`), so an append-only rebuild would leave the old names in place and the
 * version stamp would then claim they are current.
 */
describe('entity re-extraction (derived state)', () => {
  it('replaces the entity rows of older facts, and moves the HRR bundle with them', async () => {
    const f = await rt.remember({ action: 'add', content: '平台组负责统一网关' })
    // Plant a link a correct rebuild must DROP, a bundle it must REPLACE, and a stale stamp. The
    // planted bundle has to differ from what the text yields — otherwise "the bundle moved" is
    // unobservable (see the note below).
    rt.db.prepare("INSERT OR IGNORE INTO entities (name) VALUES ('__stale_marker__')").run()
    rt.db.prepare(
      "INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) SELECT ?, entity_id FROM entities WHERE name = '__stale_marker__'",
    ).run(f.fact_id)
    const wrongBundle = hrrToBytes(encodeHrrEntityVector(['__stale_marker__']))
    rt.db.prepare('UPDATE facts SET entities_version = 0, hrr_vector = ? WHERE fact_id = ?').run(wrongBundle, f.fact_id)
    // Same trap for the TRIPLES: `deleteForFact` + `insertTriples` must replace, for the same
    // reason, and a planted row is the only way to observe it here (the test env has no tagger, so
    // the extractor legitimately returns no triples for this text).
    rt.db.prepare("INSERT OR IGNORE INTO triples (fact_id, subj, pred, obj) VALUES (?, '__stale__', '负责', '__stale__')").run(f.fact_id)

    const report = await rt.memory.reindexEntities(10)
    expect(report).toEqual({ rebuilt: 1, deferred: 0, skipped: false })

    const names = rt.memory.get(f.fact_id)!.entities
    expect(names).toContain('网关') // re-extracted from the text
    expect(names).not.toContain('__stale_marker__') // REPLACED, not appended
    const triples = rt.db.prepare('SELECT subj, pred, obj FROM triples WHERE fact_id = ?').all(f.fact_id) as { subj: string }[]
    expect(triples.map((t) => t.subj)).not.toContain('__stale__')

    const after = rt.db.prepare('SELECT hrr_vector, entities_version, conflict_checked FROM facts WHERE fact_id = ?').get(f.fact_id) as
      { hrr_vector: Uint8Array; entities_version: number; conflict_checked: number }
    expect(after.entities_version).toBe(ENTITY_EXTRACTOR_VERSION)
    // The rebuild changed BOTH inputs of the conflict check (the entity rows the embedding leg
    // candidates from, and the triples the structural leg reads), so the previous verdict — the
    // one the marker stood for — was about a fact that no longer exists. It goes back in the queue.
    expect(after.conflict_checked).toBe(0)
    // The bundle is derived from the entity names, so a rebuild that left it alone would keep
    // scoring names the fact no longer has. Similarity (not byte equality): `bundle` sums complex
    // exponentials, so a different name ORDER moves the last bits — that is not the property here.
    const stored = hrrFromBytes(after.hrr_vector)!
    expect(phaseSimilarity(stored, encodeHrrEntityVector(names))).toBeGreaterThan(0.99)
    expect(phaseSimilarity(stored, encodeHrrEntityVector(['__stale_marker__']))).toBeLessThan(0.9)

    // Idempotent: a second pass has nothing to do.
    expect(await rt.memory.reindexEntities(10)).toEqual({ rebuilt: 0, deferred: 0, skipped: false })
  })

  it('leaves facts written by the CURRENT rules alone', async () => {
    const f = await rt.remember({ action: 'add', content: '陈静加入了平台组' })
    const before = rt.db.prepare('SELECT hrr_vector FROM facts WHERE fact_id = ?').get(f.fact_id) as { hrr_vector: Uint8Array }
    expect(await rt.memory.reindexEntities(10)).toEqual({ rebuilt: 0, deferred: 0, skipped: false })
    const after = rt.db.prepare('SELECT hrr_vector FROM facts WHERE fact_id = ?').get(f.fact_id) as { hrr_vector: Uint8Array }
    expect(Buffer.from(after.hrr_vector).equals(Buffer.from(before.hrr_vector))).toBe(true)
  })

  it('a budgeted pass reports what it DEFERRED and the next one finishes the corpus', async () => {
    // `deferred` is the sweep's progress report, and nothing asserted it: hard-coding `deferred: 0`
    // passed every test while making "still stale" invisible. The budget is also what bounds
    // memory (the pass selects every chosen row's text), so a partial pass must leave the rest.
    for (const text of ['张伟管理李娜', '平台组负责网关', '陈静加入平台组']) {
      const f = await rt.remember({ action: 'add', content: text })
      rt.db.prepare('UPDATE facts SET entities_version = 0 WHERE fact_id = ?').run(f.fact_id)
    }

    const first = await rt.memory.reindexEntities(2)
    expect(first).toEqual({ rebuilt: 2, deferred: 1, skipped: false })
    const second = await rt.memory.reindexEntities(2)
    expect(second).toEqual({ rebuilt: 1, deferred: 0, skipped: false })
  })
})

describe('semantic index persistence across restarts', () => {
  it('rebuilds the vstore from persisted semantic_vector blobs (restart recovery)', async () => {
    const a = await rt.remember({ action: 'add', content: '张伟管理李娜' })
    // Simulate a persisted embedding (the semantic backend is unavailable in tests,
    // so write the blob directly — the restart path must not need the model).
    rt.db.prepare('UPDATE facts SET semantic_vector = ? WHERE fact_id = ?').run(fakeVector(0), a.fact_id)
    const before = rt.memory.vectorsDiagnose()
    expect(before.with_semantic).toBe(1)
    expect(before.indexed).toBe(0) // this process never added it to the live index

    const rt2 = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      const after = rt2.memory.vectorsDiagnose()
      expect(after.with_semantic).toBe(1)
      expect(after.indexed).toBe(1) // rebuilt from the blob on construction
      // vectors_fix reports nothing left to repair
      const fix = (await rt2.admin({ action: 'vectors_fix' })) as { reindexed: number; unindexed: number }
      expect(fix.unindexed).toBe(0)
      expect(fix.reindexed).toBe(0)
    } finally {
      rt2.shutdown()
    }
  })

  it('repairs a LOST clock at startup, so lifecycle windows cannot silently restart from zero', async () => {
    // The clock anchors every lifecycle window (settle/TTL/forget/idle/purge). If its meta row is
    // lost while facts remain, all of those windows would start at 0 and rows would live forever —
    // the one failure mode `initClock` exists for. It runs at store open, so a restart IS the repair
    // (and it is an index scan, which is why it is not on the presence path).
    const a = await rt.remember({ action: 'add', content: '时钟修复测试事实' })
    rt.db.prepare('UPDATE facts SET settle_clock = ? WHERE fact_id = ?').run(12_345, a.fact_id)
    rt.db.prepare('DELETE FROM avantf_stats WHERE key = ?').run('trust_clock')
    expect(readClock(rt.db)).toBe(0) // the loss

    // A second runtime on the same file IS the restart (`rt` is shut down by `afterEach`, so it has
    // to stay open here — closing it twice is what "connection is not open" meant).
    const restarted = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      expect(readClock(restarted.db)).toBeGreaterThanOrEqual(12_345)
    } finally {
      restarted.shutdown()
    }
  })

  it('vectors_fix reloads persisted vectors that are missing from the live index', async () => {
    const a = await rt.remember({ action: 'add', content: '陈静加入平台组' })
    rt.db.prepare('UPDATE facts SET semantic_vector = ? WHERE fact_id = ?').run(fakeVector(1), a.fact_id)
    const fix = (await rt.admin({ action: 'vectors_fix' })) as { reindexed: number; semantic_available: boolean }
    expect(fix.reindexed).toBe(1)
    expect(rt.memory.vectorsDiagnose().indexed).toBe(1)
  })

  it('vectors_fix never throws on a stale-dim vector (the path reloadIndex points at)', async () => {
    const offline = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: new NeverWarm() })
    try {
      const a = await offline.remember({ action: 'add', content: '维度不匹配的向量' })
      const stale = new Float32Array(3)
      stale[0] = 1
      offline.db.prepare('UPDATE facts SET semantic_vector = ? WHERE fact_id = ?').run(float32ToBytes(stale), a.fact_id)

      const diag = offline.memory.vectorsDiagnose()
      expect(diag.stale).toBe(1)
      expect(diag.missing).toBe(0)
      expect(diag.unindexed).toBe(0) // unusable vectors are "stale", not "unindexed"
      // Which backend is serving is part of the diagnosis: `vectorStore.backend: auto` migrates
      // to ANN (and its recall/latency trade-off) without any other surface showing it. The default
      // backend is `auto`, so before the threshold this reports its brute-force delegate.
      expect(diag.store).toContain('local_numpy')

      // Must resolve, not reject: the store refuses to add a mismatched vector.
      const fix = (await offline.admin({ action: 'vectors_fix' })) as { stale: number; dropped: number; semantic_available: boolean }
      expect(fix.stale).toBe(1)
      expect(fix.dropped).toBe(0) // the repair cannot run without a model → nothing is cleared
      expect(fix.semantic_available).toBe(false)
      expect(offline.memory.vectorsDiagnose().stale).toBe(1)
    } finally {
      offline.shutdown()
    }
  })

  it('reports vectors written in ANOTHER space instead of ranking them as if they matched', async () => {
    // A same-width model swap is invisible to the dim check, so the bytes stay usable and the
    // vectors stay IN the index (comparability cannot be verified from the row alone). What must
    // not happen is silence: the mismatch is reported, and re-encoding is `vectors_fix`'s job
    // (an explicit, counted action) rather than an open-time side effect.
    const offline = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: new NeverWarm() })
    try {
      const a = await offline.remember({ action: 'add', content: '这条事实的向量来自另一个模型' })
      const foreign = 'local_bge/bge-m3/512'
      offline.db
        .prepare('UPDATE facts SET semantic_vector = ?, embedding_model = ? WHERE fact_id = ?')
        .run(fakeVector(9), foreign, a.fact_id)

      const diag = offline.memory.vectorsDiagnose()
      expect(diag.space_stale).toBe(1)
      expect(diag.stale).toBe(0) // the bytes are fine — it is the SPACE that is in doubt
      expect(diag.unindexed).toBe(1) // usable, and absent from the live index (row written post-open)
      expect(diag.models).toEqual({ [foreign]: 1 })

      const plan = (await offline.admin({ action: 'vectors_fix', dry_run: true })) as { space_stale: number; dropped: number }
      expect(plan.space_stale).toBe(1)
      expect(plan.dropped).toBe(0) // a dry run writes nothing

      // Without a model the vector is reported but must NOT be dropped, or the fact would
      // silently lose its (still best-available) vector.
      const fix = (await offline.admin({ action: 'vectors_fix' })) as { space_stale: number; dropped: number }
      expect(fix.space_stale).toBe(1)
      expect(fix.dropped).toBe(0)
      expect(offline.memory.vectorsDiagnose().space_stale).toBe(1)
    } finally {
      offline.shutdown()
    }

    // Opening a store with foreign-space rows warns once and keeps serving them (the alternative
    // — dropping them at open — would empty the semantic leg of every upgraded store).
    const rt2 = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      expect(rt2.memory.vectorsDiagnose().indexed).toBe(1)
    } finally {
      rt2.shutdown()
    }
  })

  it('separates "not loaded right now" from "the repair cannot run" in a preview', async () => {
    // A dry run must not load the model (that would be a download inside a call that promises not
    // to write), so its `semantic_available` can only answer "is it loaded NOW?" — which reads
    // like "the repair is impossible" unless the report also says a real run would try. Hence
    // `would_warm`, reported in BOTH modes and computed before any warmup.
    const offline = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: new NeverWarm() })
    try {
      const a = await offline.remember({ action: 'add', content: '预演与真实执行的模型可用性不同' })
      // Dim-valid bytes from a FOREIGN space: with no model the row would otherwise be "missing a
      // vector" rather than "holding one from another space" — a different diagnosis.
      offline.db
        .prepare('UPDATE facts SET semantic_vector = ?, embedding_model = ? WHERE fact_id = ?')
        .run(fakeVector(3), 'local_bge/bge-m3/512', a.fact_id)

      const plan = (await offline.admin({ action: 'vectors_fix', dry_run: true })) as VectorsFixReport
      expect(plan).toMatchObject({ space_stale: 1, dropped: 0, dry_run: true, semantic_available: false, would_warm: true })

      const real = (await offline.admin({ action: 'vectors_fix' })) as VectorsFixReport
      expect(real).toMatchObject({ dry_run: false, would_warm: true })
      // The warmup was attempted and failed (the backend cannot warm), so nothing is cleared: the
      // row keeps the only vector it has and `space_stale` keeps reporting it.
      expect(real.semantic_available).toBe(false)
      expect(real.dropped).toBe(0)
      expect(offline.memory.vectorsDiagnose().space_stale).toBe(1)
    } finally {
      offline.shutdown()
    }
  })

  it('re-encodes foreign-space vectors once the model is available', async () => {
    // The counterpart of the test above, with a backend that IS available: the repair must
    // actually replace the vector, re-add it to the live index, and record the space it wrote.
    class AlwaysWarm implements SemanticBackend {
      readonly name = 'always_warm'
      readonly dim = 768
      isAvailable(): boolean { return true }
      async encode(): Promise<Float32Array> {
        const vec = new Float32Array(this.dim)
        vec[0] = 1
        return vec
      }
      async encodeBatch(texts: string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map(() => this.encode()))
      }
    }

    const live = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: new AlwaysWarm() })
    try {
      const a = await live.remember({ action: 'add', content: '换模型后这条事实需要重编码' })
      live.db
        .prepare("UPDATE facts SET embedding_model = 'other/model/512' WHERE fact_id = ?")
        .run(a.fact_id)
      expect(live.memory.vectorsDiagnose().space_stale).toBe(1)

      const plan = (await live.admin({ action: 'vectors_fix', dry_run: true })) as VectorsFixReport
      expect(plan).toMatchObject({ space_stale: 1, dropped: 0, dry_run: true, semantic_available: true, would_warm: false })

      const real = (await live.admin({ action: 'vectors_fix' })) as VectorsFixReport
      expect(real).toMatchObject({ space_stale: 1, dropped: 1, fixed: 1, dry_run: false, semantic_available: true })
      const row = live.db.prepare('SELECT embedding_model FROM facts WHERE fact_id = ?').get(a.fact_id) as { embedding_model: string }
      expect(row.embedding_model).toContain('always_warm/')
      // Repaired means BOTH: the column carries the current space, and the live index serves it.
      expect(live.memory.vectorsDiagnose().space_stale).toBe(0)
      expect(live.memory.vectorsDiagnose().indexed).toBe(1)
    } finally {
      live.shutdown()
    }
  })

  it('keeps only ACTIVE vectors in the live index (archive evicts, restore re-adds)', async () => {
    const a = await rt.remember({ action: 'add', content: '这条事实会被归档' })
    rt.db.prepare('UPDATE facts SET semantic_vector = ? WHERE fact_id = ?').run(fakeVector(2), a.fact_id)
    const rt2 = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      expect(rt2.memory.vectorsDiagnose().indexed).toBe(1)
      await rt2.admin({ action: 'archive', fact_id: a.fact_id })
      expect(rt2.memory.vectorsDiagnose().indexed).toBe(0)
      await rt2.admin({ action: 'restore', fact_id: a.fact_id })
      expect(rt2.memory.vectorsDiagnose().indexed).toBe(1)
    } finally {
      rt2.shutdown()
    }
  })

  it('the startup pass archives TTL-expired facts before the index is built (M3/R9)', async () => {
    const a = await rt.remember({ action: 'add', content: '这条事实会被 TTL 归档' })
    rt.db.prepare('UPDATE facts SET semantic_vector = ?, ttl_days = 1, created_at = ? WHERE fact_id = ?')
      .run(fakeVector(3), '2020-01-01 00:00:00', a.fact_id)
    const rt2 = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
    try {
      // Constructor order is presence → tick → reloadIndex, so the expired fact was
      // archived before the index was loaded and never entered it (no eviction needed).
      expect(rt2.memory.vectorsDiagnose().indexed).toBe(0)
      const row = rt2.db.prepare('SELECT status, archive_reason FROM facts WHERE fact_id = ?').get(a.fact_id) as { status: string; archive_reason: string }
      expect(row.status).toBe('archived')
      expect(row.archive_reason).toBe('ttl')
    } finally {
      rt2.shutdown()
    }
  })
})

describe('trust lifecycle in the store (TRUST_MODEL.md §2)', () => {
  const trust = (): typeof rt.config.common.trust => rt.config.common.trust
  const factRow = (id: number): { status: string; trust_score: number; settle_clock: number; pinned: number; bonus_count: number; last_retrieved_at: string | null } =>
    rt.db.prepare('SELECT status, trust_score, settle_clock, pinned, bonus_count, last_retrieved_at FROM facts WHERE fact_id = ?').get(id) as never

  it('R1: a fact written after 100 active days is not decayed away by the next tick', async () => {
    rt.db.prepare("INSERT INTO avantf_stats (key, value) VALUES ('trust_clock', '100') ON CONFLICT(key) DO UPDATE SET value = '100'").run()
    const a = await rt.remember({ action: 'add', content: '第 100 个活跃日写入的事实' })
    expect(factRow(a.fact_id).settle_clock).toBe(100) // explicit at INSERT (R1/S1)
    const res = runMaintenance(rt.db, rt.config.common, { clock: 100, budget: 0 })
    expect(res.archived_ids).not.toContain(a.fact_id)
    expect(factRow(a.fact_id).status).toBe('active')
    expect(factRow(a.fact_id).trust_score).toBeCloseTo(0.5, 6)
  })

  it('R2/R10: recall never lowers trust and a zero-gain recall costs no quota', async () => {
    const high = await rt.remember({ action: 'add', content: '被反馈推高到 ceiling 之上' })
    rt.db.prepare('UPDATE facts SET trust_score = 0.88 WHERE fact_id = ?').run(high.fact_id)
    rt.memory.reinforce([high.fact_id])
    expect(factRow(high.fact_id).trust_score).toBeGreaterThanOrEqual(0.88)

    const floor = await rt.remember({ action: 'add', content: '刚好在地板上的新事实' })
    for (let i = 0; i < 3; i++) rt.memory.reinforce([floor.fact_id])
    expect(factRow(floor.fact_id).trust_score).toBeCloseTo(0.5, 9)
    expect(factRow(floor.fact_id).bonus_count).toBe(0) // R10: nothing gained, nothing consumed
  })

  it('caps the daily gains: a 4th recall the same day adds nothing', async () => {
    const a = await rt.remember({ action: 'add', content: '一天内被反复召回的事实' })
    rt.db.prepare('UPDATE facts SET trust_score = 0.6 WHERE fact_id = ?').run(a.fact_id)
    for (let i = 0; i < 3; i++) rt.memory.reinforce([a.fact_id])
    const afterThree = factRow(a.fact_id)
    expect(afterThree.bonus_count).toBe(3)
    expect(afterThree.trust_score).toBeCloseTo(0.6 + 3 * trust().recall_delta, 6)
    rt.memory.reinforce([a.fact_id])
    expect(factRow(a.fact_id).trust_score).toBeCloseTo(afterThree.trust_score, 9) // capped
    expect(factRow(a.fact_id).bonus_count).toBe(3)
  })

  it('R7/D6: helpful promotes to permanent (snap to 1.0) and feedback cannot change it', async () => {
    const a = await rt.remember({ action: 'add', content: '被反复确认有用的事实' })
    for (let i = 0; i < 8; i++) await rt.remember({ action: 'helpful', fact_id: a.fact_id })
    const detail = rt.memory.get(a.fact_id)!
    expect(detail.pinned).toBe(true)
    expect(detail.trust_score).toBe(1)
    await rt.remember({ action: 'unhelpful', fact_id: a.fact_id })
    expect(factRow(a.fact_id).trust_score).toBe(1) // untouched (R7)
    const res = runMaintenance(rt.db, rt.config.common, { clock: 400, budget: 0 })
    expect(res.archived_ids).not.toContain(a.fact_id)
    expect(res.purged_ids).not.toContain(a.fact_id)
  })

  it('unhelpful repeated drives a fact to the forget line and archives it immediately', async () => {
    const a = await rt.remember({ action: 'add', content: '被判定为没用的事实' })
    for (let i = 0; i < 10; i++) await rt.remember({ action: 'unhelpful', fact_id: a.fact_id })
    const row = factRow(a.fact_id)
    expect(row.status).toBe('archived')
    expect(row.trust_score).toBe(0)
    expect(rt.db.prepare('SELECT archive_reason AS r FROM facts WHERE fact_id = ?').get(a.fact_id)).toEqual({ r: 'forgot' })
    expect(rt.memory.vectorsDiagnose().indexed).toBe(0) // vector evicted with the archive
  })

  it('R4/R18: restoring a forgot or idle fact survives the next tick', async () => {
    // Bring the STORED clock to day 90 (as presence would); maintenance passes read it.
    const setClock = (v: number): void => {
      rt.db.prepare("INSERT INTO avantf_stats (key, value) VALUES ('trust_clock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(v))
    }
    setClock(90)
    const forgot = await rt.remember({ action: 'add', content: '被遗忘后又被恢复的事实' })
    rt.db.prepare('UPDATE facts SET settle_clock = 0 WHERE fact_id = ?').run(forgot.fact_id) // created "90 active days ago"
    runMaintenance(rt.db, rt.config.common)
    expect(factRow(forgot.fact_id).status).toBe('archived')
    expect(rt.memory.restore(forgot.fact_id)).toBe(true)
    const restored = rt.memory.get(forgot.fact_id)!
    expect(restored.status).toBe('active')
    expect(restored.trust_score).toBeCloseTo(trust().recall_floor, 6) // lifted (R4)
    expect(factRow(forgot.fact_id).last_retrieved_at).not.toBeNull() // idle clock refreshed (R18)
    runMaintenance(rt.db, rt.config.common) // same active day → must NOT re-archive (R4)
    expect(factRow(forgot.fact_id).status).toBe('active')

    const idle = await rt.remember({ action: 'add', content: '被 idle 兜底归档后恢复的事实' })
    rt.db.prepare("UPDATE facts SET last_retrieved_at = '2020-01-01 00:00:00' WHERE fact_id = ?").run(idle.fact_id)
    runMaintenance(rt.db, rt.config.common)
    expect(factRow(idle.fact_id).status).toBe('archived')
    expect(rt.memory.restore(idle.fact_id)).toBe(true)
    runMaintenance(rt.db, rt.config.common)
    expect(factRow(idle.fact_id).status).toBe('active') // idle clock refreshed by restore (R18)
  })

  it('restore refuses an ACTIVE fact instead of quietly extending its life', async () => {
    // The gate is not cosmetic: this UPDATE settles trust and refreshes the idle clock, so without
    // `AND status = 'archived'` restoring an active row would lift a fact the next tick was about to
    // forget back to `recall_floor` — and report success while doing it.
    const a = await rt.remember({ action: 'add', content: '本来就活跃的事实' })
    rt.db.prepare('UPDATE facts SET trust_score = 0, last_retrieved_at = NULL WHERE fact_id = ?').run(a.fact_id)

    expect(rt.memory.restore(a.fact_id)).toBe(false)
    const row = factRow(a.fact_id)
    expect(row.status).toBe('active')
    expect(row.trust_score).toBe(0) // not lifted
    expect(row.last_retrieved_at).toBeNull() // idle clock untouched
  })

  it('R5/R21: ask/chain/reason count as recall; related does not; cross-query only final facts', async () => {
    const a = await rt.remember({ action: 'add', content: '张伟管理李娜' })
    const b = await rt.remember({ action: 'add', content: '李娜管理王强' })
    rt.db.prepare('UPDATE facts SET last_retrieved_at = NULL').run()

    await rt.recall({ action: 'ask', query: '李娜管理谁' }) // triple hit → askByPattern path
    expect(factRow(b.fact_id).last_retrieved_at).not.toBeNull()

    rt.db.prepare('UPDATE facts SET last_retrieved_at = NULL').run()
    await rt.recall({ action: 'chain', subj: '张伟', pred: '管理', second_pred: '管理' })
    expect(factRow(b.fact_id).last_retrieved_at).not.toBeNull()

    rt.db.prepare('UPDATE facts SET last_retrieved_at = NULL').run()
    await rt.recall({ action: 'reason', entities: ['张伟'] })
    expect(factRow(a.fact_id).last_retrieved_at).not.toBeNull()

    rt.db.prepare('UPDATE facts SET last_retrieved_at = NULL').run()
    await rt.recall({ action: 'related', entity: '张伟' })
    expect(factRow(a.fact_id).last_retrieved_at).toBeNull() // entity co-occurrence is not a recall

    // Cross-query: only the facts actually returned get usage stats.
    rt.db.prepare('UPDATE facts SET last_retrieved_at = NULL').run()
    const res = await rt.query({ query: '张伟', kind: 'doc_chunk', limit: 5 })
    expect(res.hits).toHaveLength(0)
    expect(factRow(a.fact_id).last_retrieved_at).toBeNull()
  })

  it('trust_diagnose reports clock, permanent count and well-defined quota counters (R17/R24)', async () => {
    const a = await rt.remember({ action: 'add', content: '诊断用事实' })
    // A fresh write OPENS the bonus window with `bonus_count = 0` (see `insertRevision`), so this
    // fact has not consumed any quota yet — both quota numbers must be 0 here. Regression guard:
    // when the merged `bonusStatedToday` dropped `bonus_count > 0`, this read 1 and the assertions
    // after `reinforce` below could not fail.
    expect(rt.memory.trustDiagnose().reinforced_today).toBe(0)
    expect(rt.memory.trustDiagnose().bonus_granted_today).toBe(0)
    rt.db.prepare('UPDATE facts SET trust_score = 0.6 WHERE fact_id = ?').run(a.fact_id)
    rt.memory.reinforce([a.fact_id])
    rt.memory.pin(a.fact_id)
    const diag = rt.memory.trustDiagnose()
    expect(diag.active).toBe(1)
    expect(diag.pinned).toBe(1)
    expect(diag.reinforced_today).toBe(1)
    expect(diag.bonus_granted_today).toBe(1)
    expect(typeof diag.clock).toBe('number')
    expect(diag.oldest_settle_clock).toBe(0)
    expect(rt.memory.unpin(a.fact_id)).toBe(true)
    expect(rt.memory.trustDiagnose().pinned).toBe(0)
  })

  it('trust_diagnose counts near-forgetting and idle facts, not just every active row (R17)', async () => {
    const near = await rt.remember({ action: 'add', content: '诊断用即将遗忘的事实' })
    const far = await rt.remember({ action: 'add', content: '诊断用远离遗忘的事实' })
    const clock = rt.memory.trustDiagnose().clock
    // `near` is settled as of now with a trust under one week of decay, and unused for years;
    // `far` is far above the horizon and freshly created. Both are active and unpinned, so a
    // report that merely counted active rows would answer 2 to both questions.
    rt.db.prepare('UPDATE facts SET trust_score = 0.01, settle_clock = ?, pinned = 0 WHERE fact_id = ?').run(clock, near.fact_id)
    rt.db.prepare('UPDATE facts SET trust_score = 0.9, settle_clock = ?, pinned = 0 WHERE fact_id = ?').run(clock, far.fact_id)
    rt.db.prepare("UPDATE facts SET last_retrieved_at = '2020-01-01 00:00:00' WHERE fact_id = ?").run(near.fact_id)
    const diag = rt.memory.trustDiagnose()
    expect(diag.active).toBe(2)
    expect(diag.forgetting_soon).toBe(1) // only `near` is inside the 7-active-day horizon
    expect(diag.idle_candidates).toBe(1) // only `near` is past idle_calendar_days
  })
})

describe('retrieval stats follow what the caller actually sees', () => {
  it('cross-store query does not bump memory stats for filtered-out hits', async () => {
    const a = await rt.remember({ action: 'add', content: '张伟负责支付网关的维护' })
    const count = (): number => rt.memory.get(a.fact_id)?.retrieval_count ?? -1
    expect(count()).toBe(0)

    // kind=doc_chunk drops every memory hit → the fact was never returned.
    await rt.query({ query: '张伟', kind: 'doc_chunk', limit: 5 })
    expect(count()).toBe(0)
    // a domain filter also drops memory hits
    await rt.query({ query: '张伟', domain: 'nope', limit: 5 })
    expect(count()).toBe(0)
    // ...but a blended query that DOES return the fact records exactly one retrieval
    const blended = await rt.query({ query: '张伟', limit: 5 })
    expect(blended.hits.some((h) => h.kind === 'fact')).toBe(true)
    expect(count()).toBe(1)
  })

  it('a memory search still records its own hits', async () => {
    const a = await rt.remember({ action: 'add', content: '李娜负责风控引擎' })
    await rt.recall({ action: 'search', query: '风控引擎' })
    expect(rt.memory.get(a.fact_id)?.retrieval_count).toBe(1)
  })
})

describe('related() reads the live graph only', () => {
  it('ignores entities that only co-occur in archived (superseded) facts', async () => {
    const a = await rt.remember({ action: 'add', content: '张伟管理李娜' })
    await rt.remember({ action: 'update', fact_id: a.fact_id, content: '王强负责风控引擎' })
    expect(rt.memory.get(a.fact_id)?.status).toBe('archived')
    expect(rt.memory.related('张伟')).toEqual([])
  })

  it('honors the contract category filter', async () => {
    await rt.remember({ action: 'add', content: '张伟管理李娜', category: 'project' })
    await rt.remember({ action: 'add', content: '张伟熟悉陈静', category: 'tool' })
    const all = (await rt.recall({ action: 'related', entity: '张伟' })) as { entity: string }[]
    expect(all.map((r) => r.entity).sort()).toEqual(['李娜', '陈静'].sort())
    const onlyProject = (await rt.recall({ action: 'related', entity: '张伟', category: 'project' })) as { entity: string }[]
    expect(onlyProject.map((r) => r.entity)).toEqual(['李娜'])
  })
})

describe('admin.detail', () => {
  it('returns entities and triples for one fact', async () => {
    const a = await rt.remember({ action: 'add', content: '张伟管理李娜' })
    const detail = rt.admin({ action: 'detail', fact_id: a.fact_id }) as { fact_id: number; entities: string[]; triples: unknown[] }
    expect(detail.fact_id).toBe(a.fact_id)
    expect(Array.isArray(detail.entities)).toBe(true)
    expect(Array.isArray(detail.triples)).toBe(true)
  })
})

/**
 * The write-path check is best-effort and its pending set lives IN PROCESS, so a fact whose
 * embedding leg could not run (no vector yet — the model was down) is only retried from the
 * queue that a restart erases. `vectors_fix` is the one operation that later makes such a
 * fact scorable, so it has to hand them back to the sweep; otherwise the conflict stays
 * undetected until something happens to rewrite the fact.
 */
describe('a vector repair re-queues the facts it just made scorable', () => {
  const DIM = 768
  const CONTENT_A = '老王负责甲事务'
  const CONTENT_B = '老王负责乙事务'
  /** cos(V_A, V_B) = 0.85 — high enough that overlap × sim clears the 0.6 threshold. */
  const V_A = ((): Float32Array => { const v = new Float32Array(DIM); v[0] = 1; return v })()
  const V_B = ((): Float32Array => { const v = new Float32Array(DIM); v[0] = 0.85; v[1] = Math.sqrt(1 - 0.85 ** 2); return v })()

  /**
   * The fixture both tests share: two facts that share their two entities, a STORE on the same
   * database (= a fresh process: no vectors in the live index), and a backend that stays
   * unavailable until `warm()`. The embedding leg is what these tests are about, and it cannot
   * run until a vector exists.
   */
  async function twoFactsAwaitingTheModel() {
    const a = await rt.remember({ action: 'add', content: CONTENT_A })
    const b = await rt.remember({ action: 'add', content: CONTENT_B })
    // Give both facts the SAME two entities: the candidate narrowing needs enough shared
    // entities to clear the overlap floor, and jieba's own output differs between them.
    const ensureEntity = rt.db.prepare('INSERT OR IGNORE INTO entities (name) VALUES (?)')
    const unlink = rt.db.prepare('DELETE FROM fact_entities WHERE fact_id = ?')
    const link = rt.db.prepare('INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?, (SELECT entity_id FROM entities WHERE name = ?))')
    for (const name of ['老王', '甲事务']) ensureEntity.run(name)
    for (const f of [a.fact_id, b.fact_id]) {
      unlink.run(f)
      for (const name of ['老王', '甲事务']) link.run(f, name)
    }

    let available = false
    const encode = async (t: string): Promise<Float32Array> => (t === CONTENT_A ? V_A : V_B)
    const semantic: SemanticBackend = {
      name: 'test_fake',
      dim: DIM,
      isAvailable: () => available,
      encode,
      encodeBatch: (texts: string[]) => Promise.all(texts.map(encode)),
    }
    const db = openMemoryDb(join(dir, 'memory.db'))
    const vstore = new LocalNumpyVectorStore(DIM)
    const store = new MemoryStore(db, defaultConfig, semantic, vstore)
    return { db, store, vstore, a, b, warm: (): void => { available = true } }
  }

  it('vectors_fix re-queues them for the catch-up sweep', async () => {
    const { db, store, a, b, warm } = await twoFactsAwaitingTheModel()
    try {
      // Nothing to find: the sweep has no backlog and no vector to score with (the structural
      // signal for this pair is 0.5, under the 0.6 threshold).
      expect(store.checkContradictions()).toEqual([])

      warm()
      const fix = await store.vectorsFix()
      expect(fix).toMatchObject({ fixed: 2, semantic_available: true })

      const sigs = store.checkContradictions()
      expect(sigs).toHaveLength(1)
      expect([sigs[0]!.fact_a, sigs[0]!.fact_b].sort((x, y) => x - y)).toEqual([a.fact_id, b.fact_id].sort((x, y) => x - y))
      expect(sigs[0]!.score).toBeCloseTo(0.85, 2) // overlap 1.0 × cos 0.85
      // …and the re-check is idempotent, like every other sweep.
      expect(store.checkContradictions()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('a budget below the backlog drains exactly that many rows and leaves the rest queued', async () => {
    // The drain's budget was never exercised below the pending count: every test drained a queue
    // it could empty. That is the one shape where "stamp what you selected" and "stamp what you
    // COMPLETED" differ in size, so it is the shape that tests the contract.
    const { db, store, warm } = await twoFactsAwaitingTheModel()
    try {
      warm()
      await store.vectorsFix()
      expect(store.trustDiagnose().conflict_pending).toBe(2)

      // One row: checking it scores it against the WHOLE corpus, so the pair is found here.
      expect(store.checkContradictions(1)).toHaveLength(1)
      expect(store.trustDiagnose().conflict_pending).toBe(1) // the other row is still owed a check

      // The remainder is drained next time, and re-scoring the same pair logs nothing new.
      expect(store.checkContradictions()).toEqual([])
      expect(store.trustDiagnose().conflict_pending).toBe(0)
    } finally {
      db.close()
    }
  })

  it('a row this process cannot score does not block the rows behind it', async () => {
    // The queue predicate asks the DATABASE for a vector; the embedding leg is scored from the
    // LIVE INDEX. A row where the two disagree (here: another process's write, which landed the
    // column and not this index) must not be stamped — and must not sit at the head of a
    // `fact_id`-ordered queue either, or every row behind it would starve. Both at once is what
    // the resume cursor is for.
    const { db, store, vstore, a, b } = await twoFactsAwaitingTheModel()
    try {
      db.prepare('UPDATE facts SET semantic_vector = ? WHERE fact_id = ?').run(float32ToBytes(V_A), a.fact_id)
      db.prepare('UPDATE facts SET semantic_vector = ? WHERE fact_id = ?').run(float32ToBytes(V_B), b.fact_id)
      // Only the SECOND row's vector reaches this process's index.
      vstore.add(b.fact_id, V_B)
      expect(store.trustDiagnose().conflict_pending).toBe(2)

      // One row per pass: the first pass takes (a) — the head — and completes nothing.
      expect(store.checkContradictions(1)).toEqual([])
      expect(store.trustDiagnose().conflict_pending).toBe(2) // nothing was claimed

      // The next pass still reaches (b), which is the whole point.
      expect(store.checkContradictions(1)).toEqual([])
      expect(store.trustDiagnose().conflict_pending).toBe(1)

      // (a) stays queued — it genuinely has not been checked — and the cursor wraps back to it
      // rather than the queue being considered drained.
      expect(store.checkContradictions(1)).toEqual([])
      expect(store.trustDiagnose().conflict_pending).toBe(1)
    } finally {
      db.close()
    }
  })
})
