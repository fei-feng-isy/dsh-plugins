/**
 * Rerank A/B on the REAL library + the frozen eval set — `rerank.backend: none` vs `bge_reranker`.
 *
 * MEASUREMENT ONLY. This script never writes to the live library:
 *   - the live `~/.avantf/memory/memory.db` is opened READ-ONLY and copied with `VACUUM INTO`
 *     into a temp dir (one copy per arm, so each arm's reinforcement writes stay isolated);
 *   - every runtime points its `dataHome` at that temp dir, so the live `~/.avantf/configs/*.yaml`
 *     is never read or written.
 *
 * THE TWO ARMS, and a third reading that turned out to be necessary:
 *   - `none`  — the shipped default; `hybridSearch` fuses and slices without a rerank pass.
 *   - `bge_reranker` (AS SHIPPED) — the registered cross-encoder, driven exactly as production
 *     drives it. REQUIRED READING OF THE RESULT: on this runtime the adapter's `rerank()` THROWS
 *     (`text.replace is not a function`), catches its own error and returns the candidate ids in
 *     their incoming order — i.e. the arm is a PASS-THROUGH. See `docs/RERANK_AB_REAL.md` §1; the
 *     script asserts it (`production_is_identity`) instead of assuming it.
 *   - `cross-encoder applied correctly` — the SAME weights, scored the way `bge-reranker-base`
 *     requires: `tokenizer(query, { text_pair: doc })` + the raw logit from `model.logits`
 *     (num_labels = 1, so the pipeline's softmax is a constant 1.0). This is a HYPOTHETICAL FIX
 *     (it would live in `packages/**`, which this task must not touch), reported so the substantive
 *     question — "would a cross-encoder push #103/#117 out of the top 3?" — has a measured answer.
 *
 * WHAT IS COMPARED (one candidate set per query):
 *   `hybridSearch` reranks the OVER-FETCHED pool (limit × over_fetch_factor), THEN slices to
 *   `limit`; both runtime arms share that pool because only `rerank.backend` differs. The script
 *   re-derives the pool (limit × factor by fused order) and asserts `pool[:k] == none_ids`.
 *
 * QUERY SETS:
 *   - REAL  14 = 6 self-referential + 3 non-self controls + 5 two-character entity lookups.
 *   - FROZEN 41 = `packages/core/test/fixtures/eval_zh_relations.jsonl` (same driver as
 *     `scripts/bench-floors.mjs`: one temp runtime per case, real embedder, real `remember`).
 *
 * Usage:
 *   node mem/scripts/bench-rerank-ab.mjs [--db ~/.avantf/memory/memory.db]
 *                                        [--json mem/docs/rerank-ab.json] [--label 2026-10-04]
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, loadavg, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = (p) => join(repo, 'packages', p)
const { buildRuntime } = await import(lib('core/lib/index.js'))
const { loadEvalCases } = await import(lib('core/lib/eval/loader.js'))
const { LocalBgeBackend } = await import(lib('retrieval-core/lib/adapters/local_bge.js'))
const { LocalReranker } = await import(lib('retrieval-core/lib/adapters/local_reranker.js'))
const { applyModelEnv, estimateTokens, resolveWindow, declaredWindowOf, truncateToTokens, setRetrievalLogger, retrievalHealthSummary } = await import(lib('retrieval-core/lib/index.js'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const EMB_MODEL = arg('model', 'Xenova/bge-base-zh-v1.5')
const EMB_DIM = Number(arg('dim', 768))
const RERANK_MODEL = arg('rerank-model', 'Xenova/bge-reranker-base')
const DB = resolve(arg('db', join(homedir(), '.avantf/memory/memory.db')))
const LIMIT = Number(arg('limit', 5))
const OVER_FETCH_FACTOR = 5
const jsonOut = arg('json', null)
const LABEL = arg('label', new Date().toISOString().slice(0, 10))
const cacheDir = process.env.AVANTF_MEM_MODEL_CACHE ?? join(homedir(), '.avantf/env/models')
const mirror = process.env.AVANTF_MEM_MODEL_MIRROR ?? process.env.HF_ENDPOINT ?? 'https://hf-mirror.com'
const FIXTURE = join(repo, 'packages/core/test/fixtures/eval_zh_relations.jsonl')

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const round4 = (v) => Math.round(v * 1e4) / 1e4
const pct = (arr, p) => {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

// ─── the REAL query set ───────────────────────────────────────────────────────
// Self-referential gold is per-question: the five NAME phrasings ask for #4; `我是做什么的` asks
// for what the user DOES (#5). Both are pinned `user_profile` rows; the script refuses a gold id
// that is not active, so a re-numbered live DB fails loudly instead of scoring nothing.
const REAL_QUERIES = [
  { id: 'real-self-who', q: '我是谁？', kind: 'self', gold: [4], note: 'name fact (9 chars, pinned)' },
  { id: 'real-self-name', q: '我叫什么', kind: 'self', gold: [4], note: 'name fact' },
  { id: 'real-self-myname', q: '我的名字', kind: 'self', gold: [4], note: 'name fact' },
  { id: 'real-self-do', q: '我是做什么的', kind: 'self', gold: [5], note: 'work/company fact (24 chars, pinned)' },
  { id: 'real-self-what', q: '我叫啥', kind: 'self', gold: [4], note: 'out-of-table variant' },
  { id: 'real-self-benren', q: '本人是谁', kind: 'self', gold: [4], note: 'out-of-table variant' },
  { id: 'real-nonself-install', q: '插件的安装方法', kind: 'nonself', gold: null, note: 'control, no gold forced' },
  { id: 'real-nonself-deploy', q: '生产环境的部署流程', kind: 'nonself', gold: null, note: 'control' },
  { id: 'real-nonself-lag', q: '数据库主从延迟', kind: 'nonself', gold: null, note: 'control' },
  { id: 'real-2char-plugin', q: '插件', kind: 'entity2', entity: '插件' },
  { id: 'real-2char-task', q: '任务', kind: 'entity2', entity: '任务' },
  { id: 'real-2char-version', q: '版本', kind: 'entity2', entity: '版本' },
  { id: 'real-2char-host', q: '宿主', kind: 'entity2', entity: '宿主' },
  { id: 'real-2char-session', q: '会话', kind: 'entity2', entity: '会话' },
]

// ─── cross-encoder access ─────────────────────────────────────────────────────
// The correct call shape for `bge-reranker-base` under transformers.js 4.3.0:
//   tokenizer(queries, { text_pair: docs, padding, truncation }) -> model(inputs) -> logits
// The production `LocalReranker` instead does `pipeline('text-classification')([[q,d],...])`,
// which (a) throws on the nested pair shape — the tokenizer's `_call` has no pair branch for it —
// and would (b) score a num_labels=1 model through `softmax`, i.e. a constant 1.0. So this script
// carries BOTH readings: `production` (the adapter's own output) and `correct` (raw logits).
const CE_BATCH = 32
const MIN_DOC_TOKENS = 16 // mirrors `adapters/local_reranker.ts` MIN_DOC_TOKENS
const PAIR_SPECIAL_TOKENS = 3 // mirrors `adapters/local_reranker.ts` PAIR_SPECIAL_TOKENS
const LATENCY_REPS = Number(arg('latency-reps', 3))

async function makeScorer() {
  // The bare specifier only resolves from INSIDE a package that depends on it (pnpm's strict
  // layout), so resolve it the way the adapter's own package would and import that URL.
  const get = createRequire(join(repo, 'packages/retrieval-core/lib/index.js'))
  const mod = await import(pathToFileURL(get.resolve('@huggingface/transformers')).href)
  applyModelEnv(mod, { mirror, cacheDir, autoDownload: true })
  const pipe = await mod.pipeline('text-classification', RERANK_MODEL)
  const window = resolveWindow(0, declaredWindowOf(pipe))
  const score = async (query, docs) => {
    const out = []
    for (let i = 0; i < docs.length; i += CE_BATCH) {
      const batch = docs.slice(i, i + CE_BATCH)
      const bounded = batch.map((doc) => {
        const budget = Math.max(MIN_DOC_TOKENS, window - estimateTokens(query) - PAIR_SPECIAL_TOKENS)
        return truncateToTokens(doc, budget).text
      })
      const inputs = pipe.tokenizer(batch.map(() => query), { text_pair: bounded, padding: true, truncation: true })
      const res = await pipe.model(inputs)
      const list = typeof res.logits.tolist === 'function' ? res.logits.tolist() : [[]]
      for (let j = 0; j < batch.length; j += 1) out.push(Array.isArray(list[j]) ? (list[j][0] ?? 0) : (list[j] ?? 0))
    }
    return out
  }
  return { score, window }
}

// ─── snapshot / runtime plumbing ─────────────────────────────────────────────
function snapshot(src, dst) {
  const { DatabaseSync } = require('node:sqlite')
  rmSync(dst, { force: true })
  const db = new DatabaseSync(src, { readOnly: true })
  try {
    db.exec(`VACUUM INTO '${dst.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
}

function homeConfig(backend, dir) {
  mkdirSync(join(dir, 'configs'), { recursive: true })
  writeFileSync(
    join(dir, 'configs/common.yaml'),
    `semantic:\n  local_model: ${EMB_MODEL}\n  dim: ${EMB_DIM}\n  auto_download: false\n`
    + `rerank:\n  backend: ${backend}\n`,
  )
}

function makeRuntime(dbPath, backend, semantic, tag) {
  const dir = mkdtempSync(join(tmpdir(), `avantf-rerank-${tag}-`))
  homeConfig(backend, dir)
  const rt = buildRuntime({ dataHome: dir, memoryDbPath: dbPath, semantic, logger: quiet })
  return { rt, dir }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Wait until the runtime's configured reranker reports itself available. */
async function waitRerankReady(rt, timeoutMs = 180000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (rt.memory.rerankState().used) return true
    await sleep(250)
  }
  return false
}

function activeGoldByEntity(dbPath, entity) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db
      .prepare(
        'select f.fact_id id from facts f join fact_entities fe on fe.fact_id=f.fact_id '
        + 'join entities e on e.entity_id=fe.entity_id where f.archived_at is null and e.name=? order by f.fact_id',
      )
      .all(entity)
      .map((r) => r.id)
  } finally {
    db.close()
  }
}

function factMeta(dbPath) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db.prepare('select fact_id id, length(content) n, category, pinned, substr(content,1,24) head from facts where archived_at is null').all()
    return new Map(rows.map((r) => [r.id, r]))
  } finally {
    db.close()
  }
}

function dirSize(path) {
  let total = 0
  const walk = (p) => {
    const st = statSync(p)
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name))
    else total += st.size
  }
  if (existsSync(path)) walk(path)
  return total
}

/**
 * `du` semantics: do not follow symlinks and do not descend into them.
 *
 * The family model root stores the framework-installed embedders as symlinks into `.envinit/blob`
 * storage, so a follow-everything walk counts those weights twice. The reranker is written by
 * transformers.js as a PLAIN directory, which is why `dirSize` above is right for it.
 */
function dirSizeNoFollow(path) {
  let total = 0
  const walk = (p) => {
    const st = lstatSync(p)
    if (st.isSymbolicLink()) {
      total += st.size
      return
    }
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(join(p, name))
    else total += st.size
  }
  if (existsSync(path)) walk(path)
  return total
}

// ─── main ────────────────────────────────────────────────────────────────────
if (!existsSync(DB)) {
  console.error(`bench-rerank-ab: no database at ${DB}`)
  process.exit(1)
}
const modelsRoot = cacheDir
const rerankModelDir = join(modelsRoot, RERANK_MODEL)
if (!existsSync(rerankModelDir)) {
  console.error(`bench-rerank-ab: ${RERANK_MODEL} is not in ${modelsRoot} — nothing measured (download it first).`)
  process.exit(1)
}
const rerankBytes = dirSize(rerankModelDir)

const work = mkdtempSync(join(tmpdir(), 'avantf-rerank-ab-'))
console.log(`bench-rerank-ab  db=${DB}  limit=${LIMIT}  work=${work}`)
const embBackend = new LocalBgeBackend(EMB_MODEL, EMB_DIM, { cacheDir, autoDownload: false })
await embBackend.warmUp()
if (!embBackend.isAvailable()) {
  console.error(`bench-rerank-ab: embedder ${EMB_MODEL} unavailable in ${cacheDir} — nothing measured.`)
  process.exit(1)
}

const meta0 = factMeta(DB)
const snapNone = join(work, 'none.db')
const snapRerank = join(work, 'rerank.db')
snapshot(DB, snapNone)
snapshot(DB, snapRerank)

// The adapter under test — the SAME object production builds for `rerank.backend: bge_reranker`.
const tWarm = Date.now()
const directReranker = new LocalReranker(RERANK_MODEL, { mirror, cacheDir, autoDownload: true }, undefined)
await directReranker.warmUp()
const warmMs = Date.now() - tWarm
if (!directReranker.isAvailable()) {
  console.error('bench-rerank-ab: LocalReranker unavailable — nothing measured.')
  process.exit(1)
}
const scorer = await makeScorer()
const modelsRootBytes = dirSizeNoFollow(modelsRoot)

// Capture the adapter's own warnings so "the pass failed and fell back" is observed, not assumed.
const rerankWarnings = []
setRetrievalLogger({ info() {}, warn: (m) => rerankWarnings.push(String(m)), error() {}, debug() {} })

const { rt: rtNone, dir: homeNone } = makeRuntime(snapNone, 'none', embBackend, 'none')
const { rt: rtRerank, dir: homeRerank } = makeRuntime(snapRerank, 'bge_reranker', embBackend, 'rerank')
const ready = await waitRerankReady(rtRerank)
console.log(`reranker available=${String(ready)}  warm=${warmMs}ms  model dir=${(rerankBytes / 1048576).toFixed(1)} MiB  window=${String(scorer.window)}`)

const gold = new Map()
for (const q of REAL_QUERIES) {
  if (q.kind === 'entity2') q.gold = activeGoldByEntity(snapNone, q.entity)
  if (q.gold !== null && q.gold !== undefined) {
    for (const id of q.gold) {
      if (!meta0.has(id)) {
        console.error(`bench-rerank-ab: gold id ${id} for ${q.id} is not active — fix the query set.`)
        process.exit(1)
      }
    }
  }
  gold.set(q.id, q.gold ?? null)
}

const results = { label: LABEL, measured_at: new Date().toISOString(), node: process.version, db: DB, limit: LIMIT, real: [], eval: [], latency_ms: [] }

/** One query: the two runtime arms, the adapter pass, and the correctly-wired cross-encoder. */
async function measure(rtN, rtR, entry, opts = {}) {
  setRetrievalLogger({ info() {}, warn: (m) => rerankWarnings.push(String(m)), error() {}, debug() {} })
  const k = entry.k ?? LIMIT
  const poolK = k * OVER_FETCH_FACTOR
  const none = await rtN.recall({ action: 'search', query: entry.q, limit: k })
  const rerank = opts.rerankRuntime === false ? null : await rtR.recall({ action: 'search', query: entry.q, limit: k })
  /**
   * The EXACT pool the k-run reranked (limit × over_fetch_factor, then the same pass-selection rule).
   *
   * Derived by asking for `poolK` hits with `over_fetch_factor: 1`, so the run's over-fetch is
   * `poolK × 1 = k × 5` — the same number, the same `legCap` (`max(200, overFetch × 4)`) and the
   * same `vstore.topk(max(50, overFetch))` as the production run. Raising `limit` instead would
   * raise the over-fetch too and could flip the auto-relax decision, which is how a differently
   * relaxed pass sneaks a different candidate set into the comparison.
   */
  const factor = rtN.config.common.retriever.over_fetch_factor
  let poolRes
  try {
    rtN.config.common.retriever.over_fetch_factor = 1
    poolRes = await rtN.recall({ action: 'search', query: entry.q, limit: poolK, max_tokens: 0 })
  } finally {
    rtN.config.common.retriever.over_fetch_factor = factor
  }
  const pool = poolRes.hits.map((h) => ({ id: h.ref_id, text: h.text, fused: h.score }))

  const noneIds = none.hits.map((h) => h.ref_id)
  const rerankIds = rerank === null ? null : rerank.hits.map((h) => h.ref_id)

  // Arm R1 — the adapter as shipped, timed (repeated: a shared host makes a single sample noisy).
  const prodTimes = []
  let prodOrder = []
  for (let i = 0; i < LATENCY_REPS; i += 1) {
    const t1 = process.hrtime.bigint()
    prodOrder = await directReranker.rerank(entry.q, pool.map((p) => ({ id: p.id, text: p.text })))
    prodTimes.push(Number(process.hrtime.bigint() - t1) / 1e6)
  }

  // Arm R2 — the same weights, wired correctly (raw logits), timed.
  const ceTimes = []
  let logits = []
  for (let i = 0; i < LATENCY_REPS; i += 1) {
    const t2 = process.hrtime.bigint()
    logits = await scorer.score(entry.q, pool.map((p) => p.text))
    ceTimes.push(Number(process.hrtime.bigint() - t2) / 1e6)
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const prodMs = Math.min(...prodTimes)
  const prodMed = med(prodTimes)
  const ceMs = Math.min(...ceTimes)
  const ceMed = med(ceTimes)
  const logitById = new Map(pool.map((p, i) => [p.id, logits[i]]))
  const ceOrder = [...pool].sort((a, b) => (logitById.get(b.id) ?? -Infinity) - (logitById.get(a.id) ?? -Infinity)).map((p) => p.id)

  const prodIsIdentity = JSON.stringify(prodOrder) === JSON.stringify(pool.map((p) => p.id))
  const g = gold.has(entry.id) ? gold.get(entry.id) : (entry.gold ?? null)
  const rel = (ids) => (g === null ? null : ids.slice(0, 3).filter((id) => g.includes(id)).length)
  const ok = (ids) => (g === null ? null : g.includes(ids[0]))

  results.latency_ms.push({ id: entry.id, set: entry.set, pool: pool.length, prod_min: round4(prodMs), prod_med: round4(prodMed), ce_min: round4(ceMs), ce_med: round4(ceMed), reps: LATENCY_REPS })

  return {
    id: entry.id,
    set: entry.set,
    query: entry.q,
    kind: entry.kind ?? entry.set,
    note: entry.note ?? null,
    k,
    pool_size: pool.length,
    relaxed_none: none.relaxed === true,
    relaxed_rerank: rerank === null ? null : rerank.relaxed === true,
    gold: g,
    none_ids: noneIds,
    none_scores: none.hits.map((h) => round4(h.score)),
    // Arm R1 (bge_reranker AS SHIPPED): fused scores, product-supported.
    rerank_ids: rerankIds,
    rerank_scores: rerank === null ? null : rerank.hits.map((h) => round4(h.score)),
    // Arm R2 (correctly wired cross-encoder): the raw logits and the order they imply.
    ce_order: ceOrder,
    ce_scores: pool.map((p) => ({ id: p.id, fused: round4(p.fused), logit: round4(logitById.get(p.id) ?? 0), len: meta0.get(p.id)?.n ?? null, category: meta0.get(p.id)?.category ?? null, pinned: meta0.get(p.id)?.pinned === 1, head: meta0.get(p.id)?.head ?? null })),
    fused_order: pool.map((p) => p.id),
    production_order: prodOrder,
    production_is_identity: prodIsIdentity,
    prod_ms_min: round4(prodMs),
    prod_ms_median: round4(prodMed),
    ce_ms_min: round4(ceMs),
    ce_ms_median: round4(ceMed),
    latency_reps: LATENCY_REPS,
    pool_topk_matches_none: JSON.stringify(pool.slice(0, k).map((p) => p.id)) === JSON.stringify(noneIds),
    top1_ok_none: ok(noneIds),
    top1_ok_rerank: ok(rerankIds ?? ceOrder),
    top1_ok_ce: ok(ceOrder),
    top3_relevant_none: rel(noneIds),
    top3_relevant_rerank: rel(rerankIds ?? ceOrder),
    top3_relevant_ce: rel(ceOrder),
  }
}

// ─── REAL set ────────────────────────────────────────────────────────────────
const loadAtStart = loadavg()
const realRows = []
for (const q of REAL_QUERIES) realRows.push(await measure(rtNone, rtRerank, { ...q, set: 'real' }))
results.real = realRows

// ─── FROZEN eval set ─────────────────────────────────────────────────────────
// One `none` runtime per case (no reranker model per case); the R1 arm is the adapter pass over the
// same pool and the R2 arm its correctly-wired logits. The agreement of R1 with the runtime on the
// REAL set is what licenses the substitution (recorded in `assert`).
const cases = loadEvalCases(FIXTURE)
const evalRows = []
const evalDirs = []
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'avantf-rerank-eval-'))
  evalDirs.push(dir)
  homeConfig('none', dir)
  const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: embBackend, logger: quiet })
  const ids = []
  for (const fact of c.setup_facts) ids.push((await rt.remember({ action: 'add', content: fact })).fact_id)
  for (const q of c.queries) {
    const entry = { id: `${c.id}::${q.query}`, q: q.query, set: 'eval', kind: c.tags.join('+') || 'eval', k: q.k, gold: q.expected_ids.map((i) => ids[i]) }
    const row = await measure(rt, rt, entry, { rerankRuntime: false })
    row.rerank_ids = row.production_order
    row.rerank_scores = row.production_order.map((id) => row.ce_scores.find((s) => s.id === id)?.fused ?? 0)
    row.relaxed_rerank = row.relaxed_none
    row.top1_ok_rerank = entry.gold === null ? null : entry.gold.includes(row.rerank_ids[0])
    row.top3_relevant_rerank = entry.gold === null ? null : row.rerank_ids.slice(0, 3).filter((id) => entry.gold.includes(id)).length
    row.must_include_ok_none = (q.must_include ?? []).map((i) => ids[i]).every((id) => row.none_ids.slice(0, q.k).includes(id))
    row.must_include_ok_ce = (q.must_include ?? []).map((i) => ids[i]).every((id) => row.ce_order.slice(0, q.k).includes(id))
    row.must_exclude_ok_none = !(q.must_exclude ?? []).map((i) => ids[i]).some((id) => row.none_ids.slice(0, q.k).includes(id))
    row.must_exclude_ok_ce = !(q.must_exclude ?? []).map((i) => ids[i]).some((id) => row.ce_order.slice(0, q.k).includes(id))
    evalRows.push(row)
  }
  rt.shutdown()
}
results.eval = evalRows
const loadAtEnd = loadavg()

// ─── assertions / aggregates ─────────────────────────────────────────────────
const realG = realRows.filter((r) => r.gold !== null)
const poolOk = [...realRows, ...evalRows].filter((r) => r.pool_topk_matches_none)
results.assert = {
  rerank_runtime_used: ready,
  production_adapter_identity_everywhere: [...realRows, ...evalRows].every((r) => r.production_is_identity),
  real_runtime_equals_adapter_pass: realG.every((r) => JSON.stringify(r.rerank_ids.slice(0, r.k)) === JSON.stringify(r.production_order.slice(0, r.k))),
  pool_topk_matches_none: `${poolOk.length}/${realRows.length + evalRows.length}`,
  rerank_warnings: rerankWarnings.slice(0, 3),
  rerank_warning_count: rerankWarnings.length,
  rerank_model_dir: rerankModelDir,
  rerank_model_bytes: rerankBytes,
  models_root_bytes: modelsRootBytes,
  rerank_warm_ms: warmMs,
  // The health counters the product exposes: `rerank_used` counts the pass while the adapter was
  // returning the incoming order (see `production_adapter_identity_everywhere`).
  rerank_health: (() => {
    const h = retrievalHealthSummary()
    return { queries: h.queries, rerank_used: h.rerank_used, rerank_fallback: h.rerank_fallback, rerank_truncated: h.rerank_truncated }
  })(),
}

const agg = (rows, key) => ({
  n: rows.length,
  top1: rows.filter((r) => r[`top1_ok_${key}`] === true).length,
  top3_mean: round4(rows.reduce((s, r) => s + (r[`top3_relevant_${key}`] ?? 0), 0) / (rows.length || 1)),
})
results.summary = {
  real_with_gold: { none: agg(realG, 'none'), bge_reranker_as_shipped: agg(realG, 'rerank'), cross_encoder_correct: agg(realG, 'ce') },
  eval: { none: agg(evalRows, 'none'), bge_reranker_as_shipped: agg(evalRows, 'rerank'), cross_encoder_correct: agg(evalRows, 'ce') },
  latency_prod_ms: { p50: pct(results.latency_ms.map((l) => l.prod_med), 50), p95: pct(results.latency_ms.map((l) => l.prod_med), 95), max: Math.max(...results.latency_ms.map((l) => l.prod_med)) },
  latency_prod_ms_real: { p50: pct(results.latency_ms.filter((l) => l.set === 'real').map((l) => l.prod_med), 50), p95: pct(results.latency_ms.filter((l) => l.set === 'real').map((l) => l.prod_med), 95) },
  latency_prod_ms_eval: { p50: pct(results.latency_ms.filter((l) => l.set === 'eval').map((l) => l.prod_med), 50), p95: pct(results.latency_ms.filter((l) => l.set === 'eval').map((l) => l.prod_med), 95) },
  latency_ce_ms_min: { p50: pct(results.latency_ms.map((l) => l.ce_min), 50), p95: pct(results.latency_ms.map((l) => l.ce_min), 95), max: Math.max(...results.latency_ms.map((l) => l.ce_min)) },
  latency_ce_ms_median: { p50: pct(results.latency_ms.map((l) => l.ce_med), 50), p95: pct(results.latency_ms.map((l) => l.ce_med), 95), max: Math.max(...results.latency_ms.map((l) => l.ce_med)) },
  latency_ce_ms_real_min: { p50: pct(results.latency_ms.filter((l) => l.set === 'real').map((l) => l.ce_min), 50), p95: pct(results.latency_ms.filter((l) => l.set === 'real').map((l) => l.ce_min), 95) },
  latency_ce_ms_real_median: { p50: pct(results.latency_ms.filter((l) => l.set === 'real').map((l) => l.ce_med), 50), p95: pct(results.latency_ms.filter((l) => l.set === 'real').map((l) => l.ce_med), 95) },
  latency_ce_ms_eval_min: { p50: pct(results.latency_ms.filter((l) => l.set === 'eval').map((l) => l.ce_min), 50), p95: pct(results.latency_ms.filter((l) => l.set === 'eval').map((l) => l.ce_min), 95) },
  latency_ce_ms_eval_median: { p50: pct(results.latency_ms.filter((l) => l.set === 'eval').map((l) => l.ce_med), 50), p95: pct(results.latency_ms.filter((l) => l.set === 'eval').map((l) => l.ce_med), 95) },
  loadavg: { start: loadAtStart, end: loadAtEnd, cpus: Number(process.env.AVANTF_CPU_COUNT ?? 0) || undefined },
}
results.eval_quality = {
  must_include_none: evalRows.filter((r) => r.must_include_ok_none).length,
  must_include_ce: evalRows.filter((r) => r.must_include_ok_ce).length,
  must_exclude_none: evalRows.filter((r) => r.must_exclude_ok_none).length,
  must_exclude_ce: evalRows.filter((r) => r.must_exclude_ok_ce).length,
}
results.query_sets = { real: REAL_QUERIES.length, eval: evalRows.length, eval_cases: cases.length }

// ─── console tables ──────────────────────────────────────────────────────────
const line = (r) => [
  r.id.padEnd(30),
  `k=${String(r.k)}`,
  `pool=${String(r.pool_size).padStart(2)}`,
  `none[${r.none_ids.slice(0, r.k).join(',')}]`,
  `R1[${r.rerank_ids.slice(0, r.k).join(',')}]`,
  `R2[${r.ce_order.slice(0, r.k).join(',')}]`,
  r.gold === null ? 'gold=-' : `top1 ${r.top1_ok_none ? 'Y' : 'n'}/${r.top1_ok_rerank ? 'Y' : 'n'}/${r.top1_ok_ce ? 'Y' : 'n'}`,
  r.gold === null ? '' : `top3rel ${String(r.top3_relevant_none)}/${String(r.top3_relevant_rerank)}/${String(r.top3_relevant_ce)}`,
  `prod=${r.prod_ms_median}ms ce=${r.ce_ms_median}ms`,
].join('\t')
console.log('\n== REAL ==  (top1 none/R1/R2, top3rel none/R1/R2)')
for (const r of realRows) console.log(line(r))
console.log('\n== EVAL ==')
for (const r of evalRows) console.log(line(r))
console.log('\n== aggregates ==')
console.log(JSON.stringify(results.summary, null, 2))
console.log(JSON.stringify(results.assert, null, 2))
console.log(JSON.stringify(results.eval_quality, null, 2))

if (jsonOut !== null) {
  mkdirSync(dirname(resolve(jsonOut)), { recursive: true })
  writeFileSync(resolve(jsonOut), JSON.stringify(results, null, 2))
  console.log(`\nwrote ${resolve(jsonOut)}`)
}

rtNone.shutdown()
rtRerank.shutdown()
for (const d of [work, homeNone, homeRerank, ...evalDirs]) rmSync(d, { recursive: true, force: true })
