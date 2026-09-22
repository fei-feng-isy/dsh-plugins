import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import {
  gradeWriteCases,
  type WriteCase,
  type WriteObservation,
  type WriteReport,
} from '../src/eval/write_metrics.js'

/**
 * Write-side evaluation (DESIGN §20.4): the half of the lifecycle the retrieval suite never
 * graded. Deterministic end to end — markers in the fact text, counts from the DB, no model
 * and no judge.
 *
 * Every case asserts BOTH metrics, and the report is compared across SEVERAL SCENARIO ORDERS: the
 * cases share one store, so a claim that is only true because "this case happened to run first"
 * is a claim about the order, not about the write path. That is not hypothetical — an earlier
 * version counted archived rows over the whole store, and the first case's standalone `0` held
 * only because it ran first. Every observation is therefore scoped to the facts the case names,
 * and the suite now proves it by permuting.
 */
let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-write-eval-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * The live/archived identity view of the store, plus the structural counters a case may pin.
 *
 * The token is the fact's `category`: the store never interprets it, so grading is independent
 * of the entity/triple extractor (an in-text token would sit inside the parsed statement and
 * can suppress the very signal a case is about).
 *
 * `open_conflicts` is counted over the facts in `tokens`, NOT over the store: cases share it, and
 * a store-wide count would make a case's result depend on which cases ran before it.
 */
function observe(store: AvantfRuntime, tokens: readonly string[], chainRoot?: number): WriteObservation {
  const rows = store.db
    .prepare('SELECT fact_id, category, status, archive_reason FROM facts')
    .all() as { fact_id: number; category: string; status: string; archive_reason: string | null }[]
  const live = new Map<string, number>()
  const archived = new Set<string>()
  for (const row of rows) {
    const token = String(row.category ?? '')
    if (row.status === 'active') live.set(token, (live.get(token) ?? 0) + 1)
    else archived.add(token)
  }
  const placeholders = tokens.map(() => '?').join(',')
  const open = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM contradiction_log c
         JOIN facts fa ON fa.fact_id = c.fact_a
         JOIN facts fb ON fb.fact_id = c.fact_b
        WHERE c.resolved = 0 AND (fa.category IN (${placeholders}) OR fb.category IN (${placeholders}))`,
    )
    .get(...tokens, ...tokens) as { n: number }
  return {
    live,
    archived,
    archive_reasons: rows.map((r) => ({ token: String(r.category ?? ''), reason: r.archive_reason ?? '' })),
    open_conflicts: open.n,
    revision_chain: chainRoot === undefined ? undefined : revisionChain(store, chainRoot),
  }
}

/** How many revisions the supersede chain holds, counted forward from its first revision. */
function revisionChain(store: AvantfRuntime, rootFactId: number): number {
  const row = store.db
    .prepare(
      `WITH RECURSIVE chain(id) AS (
         SELECT fact_id FROM facts WHERE fact_id = ?
         UNION ALL
         SELECT f.fact_id FROM facts f JOIN chain c ON f.supersedes_id = c.id
       )
       SELECT COUNT(*) AS n FROM chain`,
    )
    .get(rootFactId) as { n: number }
  return row.n
}

/**
 * The open pair naming exactly these two facts.
 *
 * Scoped on purpose: a scenario must act on ITS OWN pair. Taking the first row of the store-wide
 * list selected whatever pair happened to be oldest, which made the verdict land on another
 * scenario's facts as soon as the running order changed.
 */
function ownPair(store: AvantfRuntime, a: number, b: number): { contradiction_id: number } {
  const listed = store.memory.listContradictions({ limit: 100 }) as { contradiction_id: number; fact_a: number; fact_b: number }[]
  const pair = listed.find((c) => (c.fact_a === a && c.fact_b === b) || (c.fact_a === b && c.fact_b === a))
  if (pair === undefined) throw new Error(`no open conflict naming ${a} and ${b}`)
  return pair
}

const CASES: WriteCase[] = [
  {
    id: 'exact-duplicate-is-not-a-second-fact',
    live: ['F1'],
    // The structural claims: the duplicate did NOT create a second revision, and F1 itself was
    // never archived. The count stands alone (no `archived_reason`), i.e. "any reason", and it is
    // read over the facts THIS case names — so it stays true regardless of what ran before.
    expect_action: { revision_chain: 1, archived_reason_count: 0 },
  },
  {
    id: 'update-supersedes-one-revision',
    live: ['F3'],
    retired: ['F2'],
    expect_action: { revision_chain: 2 },
  },
  {
    id: 'contradiction-is-logged-and-adjudicated',
    live: ['F4'],
    retired: ['F5'],
    expect_action: { archived_reason: 'contradiction', archived_reason_count: 1, open_conflicts: 0 },
  },
  {
    id: 'false-positive-closes-the-pair-and-keeps-both',
    live: ['F6', 'F7'],
    expect_action: { open_conflicts: 0 },
  },
  {
    id: 'archive-restore-round-trip-re-detects',
    live: ['F8', 'F9'],
    expect_action: { open_conflicts: 1 },
  },
]

/**
 * One scenario: creates its OWN facts and returns the observation.
 *
 * Self-contained by construction — its own identity tokens (unique across scenarios) and its own
 * subject matter. The alternative, one shared narrative where a later step reuses an earlier
 * step's row, cannot be permuted at all: the "later" step would fail on its own.
 */
interface Scenario {
  caseId: string
  run: (store: AvantfRuntime) => Promise<WriteObservation>
}

const SCENARIOS: Scenario[] = [
  {
    caseId: 'exact-duplicate-is-not-a-second-fact',
    run: async (store) => {
      // The same statement three times: one fact, not three, and not a second revision.
      await store.remember({ action: 'add', content: '网关由平台组维护', category: 'F1' })
      await store.remember({ action: 'add', content: '网关由平台组维护', category: 'F1' })
      const duplicate = await store.remember({ action: 'add', content: '网关由平台组维护', category: 'F1' })
      return observe(store, ['F1'], duplicate.fact_id)
    },
  },
  {
    caseId: 'update-supersedes-one-revision',
    run: async (store) => {
      const original = await store.remember({ action: 'add', content: '配载单由调度组生成', category: 'F2' })
      await store.remember({ action: 'update', fact_id: original.fact_id, content: '配载单由计划组生成', category: 'F3' })
      return observe(store, ['F2', 'F3'], original.fact_id)
    },
  },
  {
    caseId: 'contradiction-is-logged-and-adjudicated',
    run: async (store) => {
      // Two statements that cannot both be true: the conflict is logged on write, and the verdict
      // archives the wrong one.
      const keep = await store.remember({ action: 'add', content: '老王喜欢小红', category: 'F4' })
      const wrong = await store.remember({ action: 'add', content: '老王不喜欢小红', category: 'F5' })
      store.admin({
        action: 'contradict_resolve',
        contradiction_id: ownPair(store, keep.fact_id, wrong.fact_id).contradiction_id,
        resolution: 'true_positive',
        loser_fact_id: wrong.fact_id,
      })
      return observe(store, ['F4', 'F5'])
    },
  },
  {
    caseId: 'false-positive-closes-the-pair-and-keeps-both',
    run: async (store) => {
      const a = await store.remember({ action: 'add', content: '陈静喜欢跑步', category: 'F6' })
      const b = await store.remember({ action: 'add', content: '陈静不喜欢跑步', category: 'F7' })
      store.admin({
        action: 'contradict_resolve',
        contradiction_id: ownPair(store, a.fact_id, b.fact_id).contradiction_id,
        resolution: 'false_positive',
      })
      return observe(store, ['F6', 'F7'])
    },
  },
  {
    caseId: 'archive-restore-round-trip-re-detects',
    run: async (store) => {
      // Archive retires the pair; restore puts both statements back in the corpus, where a later
      // write (or `contradict_check`) picks the conflict up again.
      // Wording matters here: the structural signal needs a triple on BOTH sides, and the
      // segmenter is name-sensitive ('赵敏喜欢跑步' yields none while '赵敏不喜欢跑步' does), so
      // these use the subject/verb/object shapes already proven by the detector tests.
      const a = await store.remember({ action: 'add', content: '老王喜欢跑步', category: 'F8' })
      const other = await store.remember({ action: 'add', content: '老王不喜欢跑步', category: 'F9' })
      expect(ownPair(store, a.fact_id, other.fact_id)).toBeDefined()
      store.admin({ action: 'archive', fact_id: other.fact_id, reason: 'test' })
      expect(store.memory.listContradictions({ limit: 100 })).toHaveLength(0) // retired with the fact
      store.admin({ action: 'restore', fact_id: other.fact_id })
      store.memory.checkContradictions()
      return observe(store, ['F8', 'F9'])
    },
  },
]

/** Run the scenarios in the given order against ONE store, returning one observation per case. */
async function runScenarios(order: readonly number[], store: AvantfRuntime): Promise<Map<string, WriteObservation>> {
  const observations = new Map<string, WriteObservation>()
  for (const index of order) {
    const scenario = SCENARIOS[index]!
    observations.set(scenario.caseId, await scenario.run(store))
  }
  return observations
}

async function runOrder(order: readonly number[], store: AvantfRuntime): Promise<WriteReport> {
  return gradeWriteCases(CASES, await runScenarios(order, store))
}

/** A fresh store per order, so one order cannot inherit the previous one's state. */
async function inFreshStore<T>(body: (store: AvantfRuntime) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'avantf-write-eval-order-'))
  const store = buildRuntime({ dataHome: home, memoryDbPath: join(home, 'memory.db') })
  try {
    return await body(store)
  } finally {
    store.shutdown()
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * The orders to run. Rotations put every case FIRST exactly once (and last once), which is the
 * cheapest way to surface "this claim depended on what ran before" — that is the shape of the
 * real defect this suite hit.
 *
 * Not all 120 permutations: each order costs a full pass through the write path (extraction
 * included), and rotations already separate every case from each of its neighbours. Add an
 * explicit order here if a specific interaction is being investigated.
 */
const ORDERS: number[][] = [
  [0, 1, 2, 3, 4], // natural
  [4, 3, 2, 1, 0], // reversed
  [1, 2, 3, 4, 0],
  [2, 3, 4, 0, 1],
  [3, 4, 0, 1, 2],
  [4, 0, 1, 2, 3],
]

describe('write-side evaluation (deterministic, both metrics)', () => {
  it('produces the SAME report in every scenario order, and every case passes both metrics', async () => {
    const baseline = await runOrder(ORDERS[0]!, rt)
    for (const caseResult of baseline.cases) {
      expect(caseResult, `${caseResult.id}: action_success=${caseResult.detail}`).toMatchObject({
        action_success: true,
        information_integrity: true,
      })
    }
    expect(baseline.action_success_rate).toBe(1)
    expect(baseline.information_integrity_rate).toBe(1)

    for (const order of ORDERS.slice(1)) {
      const report = await inFreshStore(async (store) => runOrder(order, store))
      // The whole report, not just the booleans: a `detail` that differs between orders means the
      // numbers behind it moved, even when both runs still pass.
      expect(report, `order ${order.join(',')}`).toEqual(baseline)
    }
  })

  it('the two metrics are independent: a lost fact fails integrity while the action stands', async () => {
    // Fabricated observation for the supersede case: the update DID happen (chain = 2) but the
    // fact it replaced carried a marker that is gone from the live corpus AND from the archive.
    // A single blended score would report "50% fine"; the split says which half broke.
    const observations = await runScenarios([...CASES.keys()], rt)
    const key = 'update-supersedes-one-revision'
    observations.set(key, { ...observations.get(key)!, archived: new Set() })
    const report = gradeWriteCases(CASES, observations)
    const c = report.cases.find((x) => x.id === key)!
    expect(c.action_success).toBe(true)
    expect(c.information_integrity).toBe(false)
    expect(c.detail).toContain('retired-but-lost')
  })

  it('the standalone archive count is enforced, not skipped for want of a reason', () => {
    // `archived_reason_count` without `archived_reason` means "any reason". It used to be read
    // only INSIDE the `archived_reason` branch, so this exact shape asserted nothing at all.
    const base: WriteObservation = {
      live: new Map([['F1', 1]]),
      archived: new Set(['F2']),
      archive_reasons: [{ token: 'F1', reason: '' }, { token: 'F2', reason: 'replaced' }],
      open_conflicts: 0,
    }
    const anyCount = (count: number): WriteReport =>
      gradeWriteCases(
        [{ id: 'c', live: ['F1'], retired: ['F2'], expect_action: { archived_reason_count: count } }],
        new Map([['c', base]]),
      )
    // Exactly one of the case's own rows carries a reason (F2), so "any" is 1.
    expect(anyCount(1).cases[0]!.action_success).toBe(true)
    expect(anyCount(0).cases[0]!.detail).toContain('archived_reason(any)=1 expected 0')

    const named = (reason: string): WriteReport =>
      gradeWriteCases(
        [{ id: 'c', live: ['F1'], retired: ['F2'], expect_action: { archived_reason: reason, archived_reason_count: 1 } }],
        new Map([['c', base]]),
      )
    expect(named('replaced').cases[0]!.action_success).toBe(true)
    // The named form stays strict: a different reason is not the one that was archived.
    expect(named('contradiction').cases[0]!.action_success).toBe(false)
  })

  it('a standalone archive count ignores facts the case does not name', () => {
    // The count is scoped to `live` + `retired`, which is what makes it order-independent: the
    // scenarios share one store, so anything else that happened to be archived would otherwise
    // leak into this case's verdict.
    const unrelatedArchived: WriteObservation = {
      live: new Map([['F1', 1]]),
      archived: new Set(['F9']),
      archive_reasons: [{ token: 'F9', reason: 'contradiction' }],
      open_conflicts: 0,
    }
    const oneCase: WriteCase = { id: 'c', live: ['F1'], expect_action: { archived_reason_count: 0 } }
    // F9 was archived for a reason, but the case does not name it → ignored.
    expect(gradeWriteCases([oneCase], new Map([['c', unrelatedArchived]])).cases[0]!.action_success).toBe(true)

    // Now archive the case's OWN fact: the same claim must fail.
    const ownArchived: WriteObservation = {
      ...unrelatedArchived,
      archive_reasons: [...unrelatedArchived.archive_reasons, { token: 'F1', reason: 'replaced' }],
    }
    expect(gradeWriteCases([oneCase], new Map([['c', ownArchived]])).cases[0]!.action_success).toBe(false)
  })

  it('a scenario that never ran is a failure, not a silent skip', () => {
    const report = gradeWriteCases(CASES, new Map())
    expect(report.cases).toHaveLength(CASES.length)
    expect(report.action_success_rate).toBe(0)
    expect(report.cases[0]!.detail).toContain('no observation')
  })
})

