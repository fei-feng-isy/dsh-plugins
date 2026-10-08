import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { openKnowledgeDb } from '../src/db/knowledge.js'
import { float32ToBytes } from '../src/db/vectors.js'
import { jiebaAvailable } from '../src/entities/extract.js'
import { allowAnyDomain } from './helpers.js'
import type { AvantfLogger } from '@avantf/mem-contract'
import type { SemanticBackend } from '@avantf/mem-retrieval'

/**
 * The KNOWLEDGE half of "changing the embedding space is a data migration".
 *
 * The memory store has had this test since the first migration; the knowledge store had only the
 * loud warning and a manual `kb_reindex`, so a model swap left every `doc_chunks.semantic_vector`
 * in the old space and the semantic leg blind to it. The fixture is the real shape: a corpus whose
 * persisted vectors are ALREADY in the old space (512-dim, old model id — 2048-byte BLOBs), then a
 * process that opens the same library under the new 768-dim model.
 *
 * The fake embedder makes the semantic leg provable END TO END: it maps the query and its one
 * correct chunk to the SAME axis and everything else to orthogonal axes, so a semantic hit is
 * cosine 1 and a lexical/entity hit is impossible (an English query over a Chinese corpus shares no
 * FTS term and no entity).
 */
const ANSWER_AXIS = 7
const DIM = 768
const OLD_SPACE = 'local_bge/Xenova/bge-small-zh-v1.5/512'
const QUERY = 'sailing harbour at dusk'
const ANSWER = '潮汐把旧渔船推回港湾，值班员把它记进了当天的航海日志。'
const DOC_COUNT = 12

/** One axis per document; the answer and the query share {@link ANSWER_AXIS}. */
class AxisSemantic implements SemanticBackend {
  readonly name = 'axis_sem'
  readonly dim = DIM
  isAvailable(): boolean { return true }
  ensureWarm(): void { /* always warm */ }
  private axis(text: string): number {
    if (text.includes('潮汐') || text.includes('dusk')) return ANSWER_AXIS
    const marked = /^资料(\d+)/u.exec(text)
    if (marked) {
      const n = Number(marked[1])
      return n === ANSWER_AXIS ? ANSWER_AXIS + 1 : n
    }
    return ANSWER_AXIS + 2
  }
  async encode(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIM)
    v[this.axis(text) % DIM] = 1
    return v
  }
  async encodeBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.encode(t)))
  }
}

/** A ~300-character chunk that mirrors the real corpus's length distribution. */
function docText(i: number): string {
  const body = '这段资料记录的是平台在若干次升级之后留下的运行经验，涉及缓存、索引与事件循环的取舍，'
    + '长度刻意接近真实语料的中位数，而不是一句短标签。'
  return `资料${String(i)}：${body}${body}`
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'avantf-kbvecmig-'))
}

class CapturingLogger implements AvantfLogger {
  readonly lines: string[] = []
  info(message: string): void { this.lines.push(`INFO ${message}`) }
  warn(message: string): void { this.lines.push(`WARN ${message}`) }
  error(message: string): void { this.lines.push(`ERROR ${message}`) }
}

interface Fixture {
  dir: string
  /** Chunks in the seeded corpus (one per document — each document is shorter than `chunk_size`). */
  chunks: number
  /** The chunk whose text carries the answer. */
  answerChunk: number
}

beforeAll(async () => { await jiebaAvailable() })

/** Ingest the corpus under the CURRENT space, then age every chunk vector into the OLD one. */
async function seed(): Promise<Fixture> {
  const dir = makeDir()
  allowAnyDomain(dir)
  const rt = buildRuntime({ dataHome: dir, semantic: new AxisSemantic() })
  let chunks = 0
  let answerChunk = 0
  let kbDbPath = ''
  try {
    for (let i = 1; i <= DOC_COUNT; i++) {
      const text = i === ANSWER_AXIS ? ANSWER : docText(i === ANSWER_AXIS ? DOC_COUNT + 1 : i)
      await rt.kb({ action: 'ingest', text, domain: 'tech', source: 'fixtures', title: `资料${String(i)}` })
    }
    kbDbPath = rt.config.knowledge.db.path
    chunks = rt.knowledge.count().chunks
  } finally {
    rt.shutdown()
  }
  // Age through a separate connection (the store is closed): wrong width AND an old model id —
  // the exact shape a 512→768 upgrade leaves behind.
  const kb = openKnowledgeDb(kbDbPath)
  try {
    kb.prepare('UPDATE doc_chunks SET semantic_vector = ?, embedding_model = ?')
      .run(float32ToBytes(new Float32Array(512)), OLD_SPACE)
    const answer = kb
      .prepare<{ chunk_id: number }>('SELECT chunk_id FROM doc_chunks WHERE text LIKE ?')
      .get('%潮汐%')
    answerChunk = answer?.chunk_id ?? 0
  } finally {
    kb.close()
  }
  return { dir, chunks, answerChunk }
}

function reopen(fx: Fixture, logger?: AvantfLogger): AvantfRuntime {
  return buildRuntime({
    dataHome: fx.dir,
    semantic: new AxisSemantic(),
    ...(logger === undefined ? {} : { logger }),
  })
}

/** The head chunk of a knowledge search — the semantic leg is the only one that can answer QUERY. */
async function topChunk(rt: AvantfRuntime, query: string): Promise<number | null> {
  const hits = await rt.knowledge.search(query, { floors: 'strict' })
  return hits[0]?.ref_id ?? null
}

describe('knowledge vector-space migration (the store used to be left behind)', () => {
  it('detects the old space loudly, heals it in bounded background batches, and restores the semantic leg', async () => {
    const fx = await seed()
    expect(fx.chunks).toBe(DOC_COUNT)
    expect(fx.answerChunk).toBeGreaterThan(0)

    const logger = new CapturingLogger()
    const rt = reopen(fx, logger)
    try {
      // ① detection — including the startup WARNING (count + reason + manual entry)
      expect(rt.knowledge.vectorSpaceHealth()).toEqual({ stale: DOC_COUNT, space_stale: 0 })
      const warning = logger.lines.find((l) => l.startsWith('WARN') && l.includes('OLDER embedding space'))
      expect(warning).toBeDefined()
      expect(warning).toContain('knowledge')
      expect(warning).toContain(String(DOC_COUNT))
      expect(warning).toContain('vectors --fix')

      // ② the failure: a query ONLY the semantic leg can answer has no answer at all (wrong-width
      // vectors were skipped by the reload, so the live index is empty for this corpus)
      expect(await topChunk(rt, QUERY)).toBeNull()

      // ③ bounded: one slice re-encodes at most `batchSize` chunks (knowledge overwrites in place,
      // so there is nothing to drop first)
      const slice = await rt.knowledge.migrateVectorsBatch(3)
      expect(slice.migrated).toBe(3)
      expect(slice.dropped).toBe(0)
      expect(slice.remaining).toBe(DOC_COUNT - 3)
      expect(slice.semantic_available).toBe(true)

      // ④ the whole corpus ends up current, and the semantic leg now answers
      const outcome = await rt.knowledge.migrateVectors({ batchSize: 4 })
      expect(outcome.enabled).toBe(true)
      expect(outcome.migrated).toBe(DOC_COUNT - 3)
      expect(outcome.remaining).toBe(0)
      expect(rt.knowledge.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: 0 })
      expect(await topChunk(rt, QUERY)).toBe(fx.answerChunk)

      // ⑤ idempotent: a second drive is a no-op
      const again = await rt.knowledge.migrateVectors()
      expect(again.migrated).toBe(0)
      expect(again.remaining).toBe(0)
      expect(await topChunk(rt, QUERY)).toBe(fx.answerChunk)
    } finally {
      rt.shutdown()
      rmSync(fx.dir, { recursive: true, force: true })
    }
  })

  it('also detects a same-width MODEL swap (space_stale) and heals it', async () => {
    const fx = await seed()
    // Same width, another model: invisible to a dim check, and the reload still ranks the bytes.
    const kb = openKnowledgeDb(join(fx.dir, 'knowledge', 'knowledge.db'))
    try {
      kb.prepare('UPDATE doc_chunks SET semantic_vector = ?, embedding_model = ?')
        .run(float32ToBytes(new Float32Array(DIM)), 'other_backend/other-model/768')
    } finally {
      kb.close()
    }
    const rt = reopen(fx)
    try {
      expect(rt.knowledge.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: DOC_COUNT })
      const outcome = await rt.knowledge.migrateVectors({ batchSize: 4 })
      expect(outcome.remaining).toBe(0)
      expect(rt.knowledge.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: 0 })
      expect(await topChunk(rt, QUERY)).toBe(fx.answerChunk)
    } finally {
      rt.shutdown()
      rmSync(fx.dir, { recursive: true, force: true })
    }
  })

  it('honours semantic.auto_migrate: false — the warning stays, nothing is re-encoded (mutation guard)', async () => {
    const fx = await seed()
    mkdirSync(join(fx.dir, 'configs'), { recursive: true })
    writeFileSync(join(fx.dir, 'configs', 'common.yaml'), 'semantic:\n  auto_migrate: false\n')
    const rt = reopen(fx)
    try {
      expect(rt.config.common.semantic.auto_migrate).toBe(false)
      // Detection is still on — the operator must SEE the problem.
      expect(rt.knowledge.vectorSpaceHealth().stale).toBe(DOC_COUNT)
      // The automatic repair is off: the semantic leg stays blind (this is the assertion that goes
      // red if the switch is ignored, i.e. the mutation check for requirement ③).
      const outcome = await rt.knowledge.migrateVectors()
      expect(outcome.enabled).toBe(false)
      expect(outcome.migrated).toBe(0)
      expect(outcome.remaining).toBe(DOC_COUNT)
      expect(await topChunk(rt, QUERY)).toBeNull()
      // The manual entry still works with the switch off.
      const fixed = await rt.knowledge.vectorsFix()
      expect(fixed.encoded).toBe(DOC_COUNT)
      expect(await topChunk(rt, QUERY)).toBe(fx.answerChunk)
    } finally {
      rt.shutdown()
      rmSync(fx.dir, { recursive: true, force: true })
    }
  })

  it('resumes after a restart — the remaining state lives in the database, not in the process', async () => {
    const fx = await seed()
    let rt = reopen(fx)
    const slice = await rt.knowledge.migrateVectorsBatch(5)
    expect(slice.migrated).toBe(5)
    expect(slice.remaining).toBe(DOC_COUNT - 5)
    rt.shutdown() // "the process dies mid-migration"

    rt = reopen(fx)
    try {
      // The 5 already re-encoded chunks are in the new space; the rest are still old-space.
      expect(rt.knowledge.vectorSpaceHealth()).toEqual({ stale: DOC_COUNT - 5, space_stale: 0 })
      const outcome = await rt.knowledge.migrateVectors({ batchSize: 4 })
      expect(outcome.remaining).toBe(0)
      expect(await topChunk(rt, QUERY)).toBe(fx.answerChunk)
    } finally {
      rt.shutdown()
      rmSync(fx.dir, { recursive: true, force: true })
    }
  })
})
