import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { float32ToBytes } from '../src/db/vectors.js'
import type { AvantfLogger } from '@avantf/mem-contract'
import type { SemanticBackend } from '@avantf/mem-retrieval'

/**
 * Changing the embedding space is a DATA MIGRATION, so the fixture must be the real shape: a store
 * whose ACTIVE corpus is ALREADY persisted in the OLD space, then a process that opens it under the
 * NEW default model. Testing only "facts written after the change" would miss the entire failure —
 * measured on the real library after 512→768, 78 of 80 ACTIVE facts fell out of the semantic leg and
 * retrieval silently degraded to lexical+entity.
 *
 * The fake embedder exists only to make the semantic leg provable END TO END: it maps the query and
 * its one correct fact to the SAME axis and everything else to orthogonal axes, so a semantic hit is
 * cosine 1 and a lexical/entity hit is impossible (an English query over a Chinese corpus shares no
 * FTS term and no entity). It is a contract-shaped stand-in, not a copy of the ONNX adapter.
 */
const ANSWER_AXIS = 7
const DIM = 768
const OLD_SPACE = 'local_bge/Xenova/bge-small-zh-v1.5/512'
const QUERY = 'sailing harbour at dusk'
const ANSWER = '傍晚的潮汐把旧渔船推回了港湾。'

/** One axis per fact; the answer and the query share {@link ANSWER_AXIS}, so only it can match. */
class AxisSemantic implements SemanticBackend {
  readonly name = 'axis_sem'
  readonly dim = DIM
  isAvailable(): boolean { return true }
  ensureWarm(): void { /* always warm */ }
  private axis(text: string): number {
    if (text.includes('潮汐') || text.includes('dusk')) return ANSWER_AXIS
    const marked = /^事实(\d+)/u.exec(text)
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

/** A ~300-character fact that mirrors the real corpus's length distribution. */
function longFact(i: number): string {
  const body = '这条记录描述的是平台在若干次升级之后留下的运行经验，涉及缓存、索引与事件循环的取舍，'
    + '长度刻意接近真实语料的中位数，而不是一句短标签。'
  return `事实${String(i)}：${body}${body}`
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'avantf-vecmig-'))
}

/** Persist every ACTIVE vector in the OLD space (wrong width + old model id) — the upgrade shape. */
function ageAllVectors(rt: AvantfRuntime): void {
  const old = float32ToBytes(new Float32Array(512))
  rt.db.prepare('UPDATE facts SET semantic_vector = ?, embedding_model = ?').run(old, OLD_SPACE)
}

interface Fixture {
  dir: string
  answerText: string
  count: number
  logger: CapturingLogger
}

class CapturingLogger implements AvantfLogger {
  readonly lines: string[] = []
  info(message: string): void { this.lines.push(`INFO ${message}`) }
  warn(message: string): void { this.lines.push(`WARN ${message}`) }
  error(message: string): void { this.lines.push(`ERROR ${message}`) }
}

/** No model at all — the "upgraded on a machine that cannot load it (yet)" shape. */
class NeverWarmSemantic implements SemanticBackend {
  readonly name = 'never_warm'
  readonly dim = DIM
  isAvailable(): boolean { return false }
  async encode(): Promise<Float32Array> { throw new Error('no model') }
  async encodeBatch(): Promise<Float32Array[]> { throw new Error('no model') }
}

const FACT_COUNT = 80

async function seed(): Promise<Fixture> {
  const dir = makeDir()
  const logger = new CapturingLogger()
  const rt = buildRuntime({ dataHome: dir, semantic: new AxisSemantic(), logger })
  try {
    await rt.remember({ action: 'add', content: ANSWER })
    for (let i = 1; i <= FACT_COUNT - 1; i++) {
      // Axis 7 is the answer's; the marker indexes give every other fact its own orthogonal axis.
      await rt.remember({ action: 'add', content: longFact(i === ANSWER_AXIS ? FACT_COUNT + 1 : i) })
    }
    ageAllVectors(rt)
  } finally {
    rt.shutdown()
  }
  return { dir, answerText: ANSWER, count: FACT_COUNT, logger }
}

/** Reopen the aged store under the current model — this is the "user upgraded" moment. */
function reopen(fx: Fixture, logger?: AvantfLogger): AvantfRuntime {
  return buildRuntime({
    dataHome: fx.dir,
    semantic: new AxisSemantic(),
    ...(logger === undefined ? {} : { logger }),
  })
}

function activeContents(rt: AvantfRuntime): { fact_id: number; content: string }[] {
  return rt.db
    .prepare<{ fact_id: number; content: string }>('SELECT fact_id, content FROM facts WHERE status = \'active\' ORDER BY fact_id')
    .all()
}

async function topRef(rt: AvantfRuntime, query: string): Promise<number | null> {
  const result = await rt.recall({ action: 'search', query, floors: 'strict' })
  return result.hits[0]?.ref_id ?? null
}

describe('vector-space migration (changing the embedding space is a data migration)', () => {
  it('detects the old space loudly, heals it in bounded background batches, and restores the semantic leg', async () => {
    const fx = await seed()
    // The open under the new model is where the warning must fire.
    const logger = new CapturingLogger()
    const rt = reopen(fx, logger)
    try {
      // ① detection — including the startup WARNING (count + reason + manual entry)
      const health = rt.memory.vectorSpaceHealth()
      expect(health).toEqual({ stale: FACT_COUNT, space_stale: 0 })
      expect(rt.memory.vectorsDiagnose().stale).toBe(FACT_COUNT)
      expect(rt.memory.vectorsDiagnose().indexed).toBe(0)
      const warning = logger.lines.find((l) => l.startsWith('WARN') && l.includes('OLDER embedding space'))
      expect(warning).toBeDefined()
      expect(warning).toContain(String(FACT_COUNT))
      expect(warning).toContain('vectors --fix')

      // The status surface (`mem_admin stats`) exposes the same counts, so the degradation is not
      // only a one-shot startup line.
      const stats = rt.admin({ action: 'stats' })
      expect(stats.vectors).toEqual({ stale: FACT_COUNT, space_stale: 0 })

      // ② the failure itself: a query ONLY the semantic leg can answer has no answer at all
      expect(await topRef(rt, QUERY)).toBeNull()

      // ③ bounded: one slice drops + re-encodes at most `batchSize` rows
      const slice = await rt.memory.migrateVectorsBatch(3)
      expect(slice.migrated).toBe(3)
      expect(slice.dropped).toBe(3)
      expect(slice.remaining).toBe(FACT_COUNT - 3)
      expect(rt.memory.vectorsDiagnose().indexed).toBe(3)

      // ③ non-blocking: a query resolves while the drive is in flight, and the loop yields to the
      // event loop between batches (a timer scheduled before the drive fires during it).
      let timerFired = false
      const timer = setTimeout(() => { timerFired = true }, 0)
      const drive = rt.memory.migrateVectors({ batchSize: 2 })
      const during = await rt.recall({ action: 'search', query: QUERY })
      expect(Array.isArray(during.hits)).toBe(true)
      const outcome = await drive
      clearTimeout(timer)
      expect(timerFired).toBe(true)

      // ④ the whole corpus ends up current, and the semantic leg now answers
      expect(outcome.enabled).toBe(true)
      expect(outcome.remaining).toBe(0)
      expect(rt.memory.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: 0 })
      expect(rt.memory.vectorsDiagnose().stale).toBe(0)
      expect(rt.memory.vectorsDiagnose().indexed).toBe(FACT_COUNT)
      expect(await topRef(rt, QUERY)).toBe(1) // the seeded answer is fact_id 1

      // ⑤ no data loss: same active rows, same text
      const contents = activeContents(rt)
      expect(contents.length).toBe(FACT_COUNT)
      expect(contents[0]?.content).toBe(ANSWER)

      // ⑥ idempotent: a second drive is a no-op
      const again = await rt.memory.migrateVectors()
      expect(again.migrated).toBe(0)
      expect(again.dropped).toBe(0)
      expect(again.remaining).toBe(0)
      expect(rt.memory.vectorsDiagnose().indexed).toBe(FACT_COUNT)
      expect(await topRef(rt, QUERY)).toBe(1)
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
      expect(rt.memory.vectorSpaceHealth().stale).toBe(FACT_COUNT)
      // The automatic repair is off: the semantic leg stays blind (this is the assertion that goes
      // red if the switch is ignored, i.e. the mutation check for requirement ②).
      const outcome = await rt.memory.migrateVectors()
      expect(outcome.enabled).toBe(false)
      expect(outcome.migrated).toBe(0)
      expect(outcome.remaining).toBe(FACT_COUNT)
      expect(rt.memory.vectorsDiagnose().indexed).toBe(0)
      expect(await topRef(rt, QUERY)).toBeNull()
      // The manual entry still works with the switch off.
      const fixed = await rt.memory.vectorsFix()
      expect(fixed.fixed).toBe(FACT_COUNT)
      expect(await topRef(rt, QUERY)).toBe(1)
    } finally {
      rt.shutdown()
      rmSync(fx.dir, { recursive: true, force: true })
    }
  })

  it('also detects a same-width MODEL swap (space_stale) and heals it', async () => {
    const fx = await seed()
    const rt = reopen(fx)
    try {
      // Same width, another model: this one is invisible to a dim check and used to be ranked.
      const bytes = float32ToBytes(new Float32Array(DIM))
      rt.db.prepare('UPDATE facts SET semantic_vector = ?, embedding_model = ?').run(bytes, 'other_backend/other-model/768')
      const health = rt.memory.vectorSpaceHealth()
      expect(health).toEqual({ stale: 0, space_stale: FACT_COUNT })
      const outcome = await rt.memory.migrateVectors({ batchSize: 8 })
      expect(outcome.remaining).toBe(0)
      expect(rt.memory.vectorSpaceHealth()).toEqual({ stale: 0, space_stale: 0 })
      expect(await topRef(rt, QUERY)).toBe(1)
    } finally {
      rt.shutdown()
      rmSync(fx.dir, { recursive: true, force: true })
    }
  })

  it('resumes after a restart — the remaining state lives in the database, not in the process', async () => {
    const fx = await seed()
    let rt = reopen(fx)
    const slice = await rt.memory.migrateVectorsBatch(5)
    expect(slice.migrated).toBe(5)
    expect(slice.remaining).toBe(FACT_COUNT - 5)
    rt.shutdown() // "the process dies mid-migration"

    rt = reopen(fx)
    try {
      // The 5 already re-encoded rows are in the new space; the rest are still old-space.
      expect(rt.memory.vectorSpaceHealth()).toEqual({ stale: FACT_COUNT - 5, space_stale: 0 })
      const outcome = await rt.memory.migrateVectors({ batchSize: 8 })
      expect(outcome.remaining).toBe(0)
      expect(rt.memory.vectorsDiagnose().indexed).toBe(FACT_COUNT)
      expect(await topRef(rt, QUERY)).toBe(1)
    } finally {
      rt.shutdown()
      rmSync(fx.dir, { recursive: true, force: true })
    }
  })

  it('does not throw when the embedder is unavailable — it leaves the work for a later pass', async () => {
    const fx = await seed()
    const rt = buildRuntime({ dataHome: fx.dir, semantic: new NeverWarmSemantic() })
    try {
      const outcome = await rt.memory.migrateVectors({ batchSize: 4 })
      expect(outcome.enabled).toBe(true)
      expect(outcome.semantic_available).toBe(false)
      expect(outcome.migrated).toBe(0)
      expect(outcome.remaining).toBe(FACT_COUNT) // nothing lost, nothing half-done
      expect(rt.memory.vectorSpaceHealth().stale).toBe(FACT_COUNT)
      expect(rt.memory.vectorsDiagnose().indexed).toBe(0)
    } finally {
      rt.shutdown()
      rmSync(fx.dir, { recursive: true, force: true })
    }
  })
})
