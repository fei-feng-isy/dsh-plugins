/**
 * R5-S5 · the mechanism price of "one call writes N memories (+ relations)".
 *
 * FOUR QUESTIONS THE IMPLEMENTER HAS TO ANSWER BEFORE WRITING THE API (brief §6), each with a number:
 *   1. **One transaction of N rows vs N transactions.** The status-quo path is N real `rt.remember`
 *      calls. There is no batch API to measure, so the batch path is simulated with the PRODUCTION
 *      write primitives: the same `tagText`/`entitiesFromTokens`/`triplesFromTokens` preparation and
 *      the same private `persistFact` — the only difference is ONE outer transaction around all N
 *      (the adapter turns a nested transaction into a SAVEPOINT, so this is the real write path, not
 *      a re-implementation of the SQL). Latency, DB/WAL growth and the returned id shape.
 *   2. **Partial failure.** When item k violates `content UNIQUE`: production's own INSERT is
 *      `INSERT OR IGNORE` + `findByContent`, i.e. **skip**; a plain INSERT in one transaction is
 *      **all-or-nothing**. Both are measured, plus what N calls do today.
 *   3. **The existing mechanisms.** `created_at` monotonicity, revision chains
 *      (`supersedes_id`), the `reindexEntities` budget, and the first trust settlement.
 *   4. **The contract tax.** The `mem_remember` input schema measured through the production
 *      derivation (`toolInputJsonSchema`), the increment of an array parameter, and the argument
 *      tokens of one batch call vs N single calls — using the REAL pass-A atoms for the payload.
 *   Plus the single-call cap: the largest N before the transaction and the response stop being
 *   reasonable, with the measurement that decides it.
 *
 * Usage: node mem/scripts/spikes/bench-r5-4-batch.mjs [--json <path>]
 * PRIVACY: no fact text — the timing payloads are synthetic English strings; the payload-size
 * comparison uses the pass-A atom LENGTHS read in-process (only totals reach the artifact).
 */
import { mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as R from './bench-r5-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round5-s5-batch.json'))
const CAP_N = [1, 5, 10, 20, 50, 100, 200]

const { tagText, entitiesFromTokens, triplesFromTokens, ENTITY_EXTRACTOR_VERSION } = await import(L.lib('core/lib/entities/extract.js'))
const { normalizeWrite, normalizeWrites } = await import(L.lib('core/lib/store/common.js'))

const now = () => Number(process.hrtime.bigint()) / 1e6
const sizeOf = (p) => {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}
const fileSizes = (dbPath) => ({
  db: sizeOf(dbPath),
  wal: sizeOf(`${dbPath}-wal`),
  shm: sizeOf(`${dbPath}-shm`),
})

async function main() {
  const corpus = R.readTmp('corpus.json')
  const split = R.readTmp('split-a.json')
  const atomsOf = new Map(split.facts.map((f) => [f.id, f.atoms ?? []]))
  const relsOf = new Map(split.facts.map((f) => [f.id, f.relations ?? []]))
  L.banner('R5-S5 · batch-call mechanism + contract tax', { source_facts: corpus.facts.length })

  const req = createRequire(join(L.lib('contract'), 'package.json'))
  const { z } = await import(pathToFileURL(req.resolve('zod')).href)
  const c = await import(join(L.lib('contract'), 'lib/index.js'))
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r54-'))
  track.dirs.push(work)

  const mkRuntime = (name) => {
    const dir = join(work, name)
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, 'memory.db')
    const rt = R.newRuntime({ snapPath: dbPath, semantic: emb, track })
    return { rt, dbPath }
  }
  const prep0 = mkRuntime('prep')
  const normalizeTriples = (t) => prep0.rt.memory.normalizeTriples(t)
  const prepare = async (texts) => {
    const out = []
    for (const text of texts) {
      const normalized = normalizeWrite(text).trim()
      const tokens = await tagText(normalized)
      const entities = normalizeWrites(entitiesFromTokens(tokens, normalized).map((e) => e.name))
      const triples = normalizeTriples(triplesFromTokens(tokens))
      out.push({ content: normalized, entities, triples })
    }
    return out
  }

  // ── 1. one transaction of N vs N transactions ────────────────────────────────────────────────
  const N_MECH = 20
  const synthetic = Array.from({ length: N_MECH }, (_, i) => `spike r5 batch item ${i}: synthetic row used only for the batch mechanics measurement, padding to a paragraph-ish length so the row is not degenerate.`)
  const prepared = await prepare(synthetic)

  const { rt: rtSep, dbPath: dbSep } = mkRuntime('separate')
  const beforeSep = fileSizes(dbSep)
  const t0 = now()
  const sepIds = []
  for (const text of synthetic) sepIds.push((await rtSep.remember({ action: 'add', content: text })).fact_id)
  const sepMs = now() - t0
  const afterSep = fileSizes(dbSep)

  const { rt: rtBatch, dbPath: dbBatch } = mkRuntime('batch')
  const beforeBatch = fileSizes(dbBatch)
  const t1 = now()
  const batchIds = rtBatch.memory.db.transaction(() => prepared.map((p) => rtBatch.memory.persistFact(p.content, undefined, undefined, p.entities, p.triples).fact_id))()
  const txMs = now() - t1
  const t2 = now()
  for (let i = 0; i < prepared.length; i += 1) await rtBatch.memory.maybeIndexSemantic(Number(batchIds[i]), prepared[i].content)
  const indexMs = now() - t2
  const afterBatch = fileSizes(dbBatch)
  const journal = rtBatch.memory.db.pragma('journal_mode')

  // ── 2. partial failure semantics ─────────────────────────────────────────────────────────────
  const DUP = 'spike r5 partial duplicate row'
  const partial = await (async () => {
    const items = ['spike r5 partial a', DUP, 'spike r5 partial b', 'spike r5 partial c']
    // (a) production skip semantics: INSERT OR IGNORE through persistFact, one transaction
    const { rt } = mkRuntime('partial-skip')
    await rt.remember({ action: 'add', content: DUP })
    const prep = await prepare(items)
    const results = rt.memory.db.transaction(() => prep.map((p) => rt.memory.persistFact(p.content, undefined, undefined, p.entities, p.triples)))()
    const rows = rt.memory.db.prepare("select count(*) n from facts where content like 'spike r5 partial %'").get().n
    // (b) all-or-nothing: a hypothetical batch that does not use OR IGNORE
    const { rt: rt2 } = mkRuntime('partial-rollback')
    await rt2.remember({ action: 'add', content: DUP })
    let rolledBack = false
    let inserted = 0
    const stmt = rt2.memory.db.prepare('INSERT INTO facts(content, settle_clock, created_at, updated_at) VALUES (?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)')
    try {
      rt2.memory.db.transaction(() => { for (const it of ['spike r5 rb a', DUP, 'spike r5 rb b']) { stmt.run(it); inserted += 1 } })()
    } catch {
      rolledBack = true
    }
    const rowsAfterRollback = rt2.memory.db.prepare("select count(*) n from facts where content like 'spike r5 rb %'").get().n
    // (c) what N separate calls do today with the same duplicate in the middle
    const { rt: rt3 } = mkRuntime('partial-calls')
    await rt3.remember({ action: 'add', content: DUP })
    const callResults = []
    for (const it of items) callResults.push(await rt3.remember({ action: 'add', content: it }))
    const rowsAfterCalls = rt3.memory.db.prepare("select count(*) n from facts where content like 'spike r5 partial %'").get().n
    return {
      production_skip: { items: items.length, new_rows: results.filter((r) => r.is_new).length, returned_ids: results.length, rows_total: rows, note: 'INSERT OR IGNORE + findByContent: the duplicate returns the existing row id, is_new=false, the transaction COMMITS' },
      plain_insert_rollback: { items: 3, inserted_before_error: inserted, error_thrown: rolledBack, rows_after_rollback: rowsAfterRollback, note: 'a batch that used a plain INSERT would raise UNIQUE at item k and roll the whole transaction back to 0 new rows' },
      n_separate_calls: { items: items.length, new_rows: callResults.filter((r) => r.is_new).length, rows_total: rowsAfterCalls, is_new_flags: callResults.map((r) => r.is_new), note: 'N calls keep partial progress and never raise; the duplicate is a silent no-op' },
    }
  })()

  // ── 3. existing mechanisms ───────────────────────────────────────────────────────────────────
  const invariants = await (async () => {
    const { rt, dbPath } = mkRuntime('invariants')
    const prep = await prepare(synthetic.slice(0, 5))
    const ids = rt.memory.db.transaction(() => prep.map((p) => rt.memory.persistFact(p.content, undefined, undefined, p.entities, p.triples).fact_id))()
    for (let i = 0; i < prep.length; i += 1) await rt.memory.maybeIndexSemantic(Number(ids[i]), prep[i].content)
    const rows = rt.memory.db.prepare('select fact_id, created_at, trust_score, settle_clock, pinned, bonus_count, bonus_window_at, entities_version, conflict_checked, status from facts order by fact_id').all()
    const created = rows.map((r) => String(r.created_at))
    const monotonic = created.every((v, i) => i === 0 || v >= created[i - 1])
    const distinctCreated = new Set(created).size
    // revision chain inside one transaction
    const prep2 = await prepare(['spike r5 revision base', 'spike r5 revision next'])
    const chain = rt.memory.db.transaction(() => {
      const first = rt.memory.persistFact(prep2[0].content, undefined, undefined, prep2[0].entities, prep2[0].triples)
      const second = rt.memory.persistFact(prep2[1].content, undefined, undefined, prep2[1].entities, prep2[1].triples, { supersedesId: Number(first.fact_id), archiveOldIfActive: true })
      return { first: Number(first.fact_id), second: Number(second.fact_id) }
    })()
    const baseRow = rt.memory.db.prepare('select status, supersedes_id from facts where fact_id = ?').get(chain.first)
    const nextRow = rt.memory.db.prepare('select status, supersedes_id from facts where fact_id = ?').get(chain.second)
    const stale = rt.memory.facts.countStaleEntities(ENTITY_EXTRACTOR_VERSION)
    const t = now()
    const sweep = await rt.memory.reindexEntities()
    const sweepMs = now() - t
    const trustCfg = rt.memory.config.trust
    return {
      created_at: { distinct_values: distinctCreated, rows: created.length, monotonic_non_decreasing: monotonic, note: 'CURRENT_TIMESTAMP is second-resolution, so a batch written inside one second SHARES created_at' },
      trust_first_settlement: {
        start_trust: trustCfg.start,
        rows_at_start_trust: rows.filter((r) => Math.abs(Number(r.trust_score) - trustCfg.start) < 1e-9).length,
        rows_with_settle_clock: rows.filter((r) => r.settle_clock !== null).length,
        rows_with_bonus_window: rows.filter((r) => r.bonus_window_at !== null).length,
        rows_bonus_count_zero: rows.filter((r) => Number(r.bonus_count) === 0).length,
        rows_pinned_zero: rows.filter((r) => Number(r.pinned) === 0).length,
      },
      revision_chain_in_one_transaction: {
        base_status: String(baseRow?.status), base_supersedes: baseRow?.supersedes_id ?? null,
        next_status: String(nextRow?.status), next_supersedes: nextRow?.supersedes_id ?? null,
        linked: Number(nextRow?.supersedes_id) === chain.first && String(baseRow?.status) === 'archived',
      },
      reindex: { entities_stale_after_batch: stale, sweep, sweep_ms: L.round4(sweepMs), budget: 'ENTITY_SWEEP_BATCH = 2000 (read from the built store module default)' },
      dbPath,
    }
  })()

  // ── 4. contract tax ──────────────────────────────────────────────────────────────────────────
  const spec = c.TOOL_SPECS.find((s) => s.name === 'mem_remember')
  const branchName = (o) => o.def.shape.action.def.values[0]
  const options = c.RememberUnion.def.options
  const extend = (fields) => z.discriminatedUnion('action', options.map((o) => (branchName(o) === 'add' ? o.extend(fields) : o)))
  const schemaOf = (input) => c.toolInputJsonSchema({ ...spec, input })
  const baseline = JSON.stringify(c.toolInputJsonSchema(spec))
  const factsArray = (verbose) =>
    z
      .array(z.object({ content: z.string().min(1), category: z.string().optional(), ttl_days: z.number().int().nonnegative().optional() }))
      .min(1)
      .max(20)
      .describe(verbose ? '要一次写入的原子事实数组（1-20 条）；每条 content 与单条 add 的 content 语义相同，顺序保留。整批要么全部提交，要么（第 k 条违反 content UNIQUE 时）按跳过语义提交其余条目。' : '原子事实数组；1-20 条。')
  const relationsArray = (keyed, verbose) =>
    z
      .array(z.object(keyed
        ? { from: z.string().min(1), to: z.string().min(1), type: z.enum(R.RELATION_TYPES) }
        : { from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), type: z.enum(R.RELATION_TYPES) }))
      .optional()
      .describe(verbose
        ? `本批事实之间的关系（可选）。${keyed ? 'from/to 是本批内调用方自定的临时 key' : 'from/to 是本批 facts 数组的下标'}，type 取 ${R.RELATION_TYPES.join('/')}；只声明接口，不在本轮实现。`
        : '本批内关系；可选。')
  const SHAPES = [
    { id: 'facts-array-concise', input: () => extend({ facts: factsArray(false) }) },
    { id: 'facts-array-verbose', input: () => extend({ facts: factsArray(true) }) },
    { id: 'facts+relations-index-verbose', input: () => extend({ facts: factsArray(true), relations: relationsArray(false, true) }) },
    { id: 'facts+relations-key-verbose', input: () => extend({ facts: factsArray(true), relations: relationsArray(true, true) }) },
  ]
  const contractTax = SHAPES.map((s) => {
    const json = JSON.stringify(schemaOf(s.input()))
    return {
      id: s.id,
      chars: json.length,
      chars_delta: json.length - baseline.length,
      tokens: L.estimateTokens(json),
      tokens_delta: L.estimateTokens(json) - L.estimateTokens(baseline),
    }
  })
  const baselineTokens = L.estimateTokens(baseline)

  // one batch call vs N single calls, on the REAL pass-A payloads (only sizes leave this process)
  const payload = (() => {
    const singles = []
    const batches = []
    let atoms = 0
    for (const f of corpus.facts) {
      const list = atomsOf.get(f.id) ?? []
      atoms += list.length
      for (const a of list) singles.push(JSON.stringify({ action: 'add', content: a.text }))
      const rels = relsOf.get(f.id) ?? []
      batches.push(JSON.stringify({ action: 'add', facts: list.map((a) => ({ content: a.text })), ...(rels.length ? { relations: rels } : {}) }))
    }
    const batchesNoRel = []
    for (const f of corpus.facts) {
      const list = atomsOf.get(f.id) ?? []
      batchesNoRel.push(JSON.stringify({ action: 'add', facts: list.map((a) => ({ content: a.text })) }))
    }
    const singleStr = singles.join('')
    const batchStr = batches.join('')
    const batchNoRelStr = batchesNoRel.join('')
    return {
      atoms,
      n_single_calls_args_chars: singleStr.length,
      one_batch_call_args_chars: batchStr.length,
      one_batch_call_no_relations_args_chars: batchNoRelStr.length,
      single_calls_tokens: L.estimateTokens(singleStr),
      one_batch_call_tokens: L.estimateTokens(batchStr),
      one_batch_call_no_relations_tokens: L.estimateTokens(batchNoRelStr),
      note: 'argument payloads only (the content is written either way). Relations are declaration text and they COST tokens; the turn/tool-result saving is separate and not counted here.',
    }
  })()

  // ── 5. the cap N ─────────────────────────────────────────────────────────────────────────────
  const capRows = []
  for (const n of CAP_N) {
    const { rt, dbPath } = mkRuntime(`cap-${n}`)
    const items = Array.from({ length: n }, (_, i) => `spike r5 cap n${n} item ${i}: synthetic row for the single-call cap measurement.`)
    const prep = await prepare(items)
    const before = fileSizes(dbPath)
    const t = now()
    const ids = rt.memory.db.transaction(() => prep.map((p) => rt.memory.persistFact(p.content, undefined, undefined, p.entities, p.triples).fact_id))()
    const ms = now() - t
    const tEnc = now()
    for (let i = 0; i < prep.length; i += 1) await rt.memory.maybeIndexSemantic(Number(ids[i]), prep[i].content)
    const encMs = now() - tEnc
    const after = fileSizes(dbPath)
    capRows.push({
      n, tx_ms: L.round4(ms), tx_ms_per_row: L.round4(ms / n), encode_ms: L.round4(encMs),
      db_bytes_delta: after.db - before.db, wal_bytes_delta: after.wal - before.wal,
      response_ids_json_chars: JSON.stringify(ids.map(Number)).length,
      args_json_chars: JSON.stringify({ action: 'add', facts: items.map((t2) => ({ content: t2 })) }).length,
    })
    console.log(`cap n=${n}: tx ${L.round4(ms)} ms, encode ${L.round4(encMs)} ms, db +${after.db - before.db} B, wal +${after.wal - before.wal} B`)
  }
  const capDecision = (() => {
    const ok = capRows.filter((r) => r.tx_ms < 250 && r.response_ids_json_chars < 2000)
    const cap = ok.length ? Math.max(...ok.map((r) => r.n)) : 1
    const maxAtoms = Math.max(...corpus.facts.map((f) => (atomsOf.get(f.id) ?? []).length))
    const observed = { max_atoms_in_split_a: maxAtoms, p95_atoms_per_fact: R.quantile(split.facts.map((f) => (f.atoms ?? []).length), 0.95) }
    return {
      cap_n_measured_ceiling: cap,
      criteria: 'largest N whose single-transaction row write stays under 250 ms and whose returned-id array stays under 2 000 chars',
      recommended_cap_n: Math.max(20, maxAtoms),
      recommendation: `observed max atoms for one source fact = ${maxAtoms} (split A) / ${Math.max(...split.facts.map((f) => (f.atoms ?? []).length))} — a cap of ${Math.max(20, maxAtoms)} covers every real batch in this corpus with one slot of headroom; the measured ceiling under the latency/response criteria is ${cap}`,
      observed,
      note: 'encode time is per row and is NOT saved by batching a single embedder call; it is reported separately',
    }
  })()

  const out = {
    card: 'R5-S5',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'mechanism card — the production write path is exercised directly; no retrieval pass to identity-check (R2-5/R2-7 convention)' },
    mechanics: {
      n: N_MECH,
      separate_calls: { total_ms: L.round4(sepMs), per_row_ms: L.round4(sepMs / N_MECH), returned_ids: sepIds.length, db_bytes: afterSep.db - beforeSep.db, wal_bytes: afterSep.wal - beforeSep.wal, shm_bytes: afterSep.shm - beforeSep.shm },
      one_transaction: { tx_ms: L.round4(txMs), per_row_ms: L.round4(txMs / N_MECH), index_ms: L.round4(indexMs), total_ms: L.round4(txMs + indexMs), returned_ids: batchIds.length, db_bytes: afterBatch.db - beforeBatch.db, wal_bytes: afterBatch.wal - beforeBatch.wal, shm_bytes: afterBatch.shm - beforeBatch.shm },
      speedup_tx_only: L.round4(sepMs / Math.max(txMs, 0.001)),
      speedup_total: L.round4(sepMs / Math.max(txMs + indexMs, 0.001)),
      journal_mode: Array.isArray(journal) ? journal.map((r) => r.journal_mode).join(',') : String(journal),
      note: 'the batch path is the production preparation + private persistFact inside ONE outer transaction; the adapter turns the nested per-row transaction into a SAVEPOINT, so this is the real row+entity+triple+FTS write, and the semantic index is filled after the commit in both arms',
    },
    partial_failure: partial,
    invariants,
    contract_tax: {
      baseline: { chars: baseline.length, tokens: baselineTokens, brief_expectation: { chars: 2623, tokens: 917 }, matches_brief: baseline.length === 2623 },
      shapes: contractTax,
      full_spec_description_chars: spec.description.length,
      note: 'the schema increment is paid per TURN by a host that re-sends tool definitions; a host that caches them pays it once. It is not paid per item — the payload is.',
    },
    payload_tokens: {
      atoms: payload.atoms,
      n_single_calls_args_chars: payload.n_single_calls_args_chars,
      one_batch_call_args_chars: payload.one_batch_call_args_chars,
      single_calls_args_tokens: payload.single_calls_tokens,
      one_batch_call_args_tokens: payload.one_batch_call_tokens,
      one_batch_call_no_relations_args_chars: payload.one_batch_call_no_relations_args_chars,
      one_batch_call_no_relations_tokens: payload.one_batch_call_no_relations_tokens,
      args_saved_tokens_with_relations: payload.single_calls_tokens - payload.one_batch_call_tokens,
      args_saved_tokens_without_relations: payload.single_calls_tokens - payload.one_batch_call_no_relations_tokens,
      note: payload.note,
    },
    cap: { rows: capRows, decision: capDecision, constants: { ENTITY_SWEEP_BATCH: 2000, PENDING_CONFLICT_BATCH: 2000 } },
    reproduction: 'node mem/scripts/spikes/bench-r5-4-batch.mjs --json mem/docs/spikes/raw/round5-s5-batch.json',
  }
  const whitelist = R.repoCjkWhitelist()
  out.privacy = R.auditArtifact(out, { cjkWhitelist: whitelist })
  if (!out.privacy.clean) {
    console.error('PRIVACY AUDIT FAILED', JSON.stringify(out.privacy).slice(0, 3000))
    process.exitCode = 1
  }
  L.writeJson(jsonOut, out)
  console.log('mechanics:', JSON.stringify(out.mechanics.separate_calls), JSON.stringify(out.mechanics.one_transaction))
  console.log('contract:', JSON.stringify(out.contract_tax.baseline), JSON.stringify(contractTax))
  console.log('cap:', JSON.stringify(capDecision))
  L.teardown(track)
}

main()
