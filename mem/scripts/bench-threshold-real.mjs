/**
 * Semantic-floor A/B on the REAL library — `retriever.min_semantic_similarity` 0.50 vs 0.55.
 *
 * MEASUREMENT ONLY, same snapshot discipline as `bench-rerank-ab.mjs`: the live
 * `~/.avantf/memory/memory.db` is opened READ-ONLY, copied with `VACUUM INTO` into a temp dir, and
 * every runtime runs against that copy (the live configs are never read or written).
 *
 * WHAT IS MEASURED, and how a "cut" is established:
 *   1. the observable answer: for each query, `recall.search` at limit 5 under floors 0.50 and 0.55
 *      (explicit `floors: 'strict'`, so the auto-relax pass cannot refill the 0.55 answer and hide
 *      the loss), plus the SAME two thresholds under the DEFAULT profile so the mask is visible;
 *   2. the mechanism: the semantic leg's RAW score is the persisted, L2-normalized cosine
 *      (`facts.semantic_vector`, written by the shipped `bge-base-zh-v1.5`). The script decodes the
 *      stored vectors, recomputes the cosine for every active fact, and lists the ones in the
 *      0.50 ≤ cos < 0.55 band within the leg's own candidate window (`max(50, k)`) — i.e. the exact
 *      set the higher floor removes, including candidates that never reached the top 5;
 *   3. the frozen-set counterpart: the 41-query `eval_zh_relations.jsonl` re-run at both thresholds
 *      with the REAL embedder and all legs live (one temp runtime per case), so the
 *      P@k / R@k / must_include / must_exclude movement can be read off the same口径 as the
 *      frozen numbers.
 *
 * PRIVACY: every table prints `fact_id` and metadata only. The one place text appears is a
 * 24-CHARACTER PREFIX of a fact the 0.55 floor removed (`--head`), which the operator asked for
 * explicitly to judge whether the cut entry was a real answer. Pass `--no-head` to suppress it.
 *
 * Usage:
 *   node mem/scripts/bench-threshold-real.mjs [--db ~/.avantf/memory/memory.db] [--limit 5]
 *                                             [--lo 0.5] [--hi 0.55] [--no-head]
 *                                             [--json mem/docs/threshold-real.json]
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = (p) => join(repo, 'packages', p)
const { buildRuntime } = await import(lib('core/lib/index.js'))
const { loadEvalCases } = await import(lib('core/lib/eval/loader.js'))
const { evaluateCases } = await import(lib('core/lib/eval/runner.js'))
const { LocalBgeBackend } = await import(lib('retrieval-core/lib/adapters/local_bge.js'))
const { selfQueryRewrite } = await import(lib('core/lib/store/self_query.js'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

const EMB_MODEL = arg('model', 'Xenova/bge-base-zh-v1.5')
const EMB_DIM = Number(arg('dim', 768))
const DB = resolve(arg('db', join(homedir(), '.avantf/memory/memory.db')))
const LIMIT = Number(arg('limit', 5))
const LO = Number(arg('lo', 0.5))
const HI = Number(arg('hi', 0.55))
const SHOW_HEAD = !hasFlag('no-head')
const HEAD_LEN = 24
const jsonOut = arg('json', null)
const LABEL = arg('label', new Date().toISOString().slice(0, 10))
const cacheDir = process.env.AVANTF_MEM_MODEL_CACHE ?? join(homedir(), '.avantf/env/models')
const FIXTURE = join(repo, 'packages/core/test/fixtures/eval_zh_relations.jsonl')
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const round4 = (v) => Math.round(v * 1e4) / 1e4

// The 20-query real set: the 14 from the rerank A/B plus 6 ordinary phrasings chosen from what the
// corpus is actually about. `gold` is only declared where it is defensible (self-reference targets
// a pinned `user_profile` row; a 2-char lookup targets the facts whose ENTITY SET holds the term).
const QUERIES = [
  { id: 'real-self-who', q: '我是谁？', kind: 'self', gold: [4] },
  { id: 'real-self-name', q: '我叫什么', kind: 'self', gold: [4] },
  { id: 'real-self-myname', q: '我的名字', kind: 'self', gold: [4] },
  { id: 'real-self-do', q: '我是做什么的', kind: 'self', gold: [5] },
  { id: 'real-self-what', q: '我叫啥', kind: 'self', gold: [4] },
  { id: 'real-self-benren', q: '本人是谁', kind: 'self', gold: [4] },
  { id: 'real-nonself-install', q: '插件的安装方法', kind: 'nonself', gold: null },
  { id: 'real-nonself-deploy', q: '生产环境的部署流程', kind: 'nonself', gold: null },
  { id: 'real-nonself-lag', q: '数据库主从延迟', kind: 'nonself', gold: null },
  { id: 'real-2char-plugin', q: '插件', kind: 'entity2', entity: '插件' },
  { id: 'real-2char-task', q: '任务', kind: 'entity2', entity: '任务' },
  { id: 'real-2char-version', q: '版本', kind: 'entity2', entity: '版本' },
  { id: 'real-2char-host', q: '宿主', kind: 'entity2', entity: '宿主' },
  { id: 'real-2char-session', q: '会话', kind: 'entity2', entity: '会话' },
  { id: 'extra-install-how', q: '插件怎么安装', kind: 'extra', gold: null },
  { id: 'extra-db-where', q: '记忆库在哪', kind: 'extra', gold: null },
  { id: 'extra-weights', q: '检索权重是多少', kind: 'extra', gold: null },
  { id: 'extra-model-swap', q: '模型怎么换', kind: 'extra', gold: null },
  { id: 'extra-datahome', q: '数据根在哪', kind: 'extra', gold: null },
  { id: 'extra-schedule', q: '任务怎么调度', kind: 'extra', gold: null },
]

function snapshot(src, dst) {
  rmSync(dst, { force: true })
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(src, { readOnly: true })
  try {
    db.exec(`VACUUM INTO '${dst.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
}

/** Decode the persisted, L2-normalized vectors and the metadata the report prints. */
function loadFacts(dbPath) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const rows = db
      .prepare('select fact_id id, content, length(content) len, category, pinned, embedding_model, semantic_vector v from facts where archived_at is null')
      .all()
    return rows.map((r) => ({
      id: r.id,
      len: r.len,
      category: r.category,
      pinned: r.pinned === 1,
      head: SHOW_HEAD ? String(r.content).slice(0, HEAD_LEN) : null,
      model: r.embedding_model,
      vec: r.v === null ? null : new Float32Array(r.v.buffer, r.v.byteOffset, r.v.byteLength / 4),
    }))
  } finally {
    db.close()
  }
}

function goldByEntity(dbPath, entity) {
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

function cosine(a, b) {
  if (a === null || b === null || a.length !== b.length) return null
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i]
  return s
}

if (!existsSync(DB)) {
  console.error(`bench-threshold-real: no database at ${DB}`)
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'avantf-threshold-'))
const snap = join(work, 'memory.db')
snapshot(DB, snap)
const facts = loadFacts(snap)
console.log(`bench-threshold-real  db=${DB}  active=${facts.length}  thresholds=${LO}/${HI}  limit=${LIMIT}  head=${SHOW_HEAD ? HEAD_LEN : 'off'}`)

for (const q of QUERIES) {
  if (q.kind === 'entity2') q.gold = goldByEntity(snap, q.entity)
  if (q.gold) {
    for (const id of q.gold) {
      if (!facts.some((f) => f.id === id)) {
        console.error(`bench-threshold-real: gold id ${id} for ${q.id} is not active — fix the query set.`)
        process.exit(1)
      }
    }
  }
}

const emb = new LocalBgeBackend(EMB_MODEL, EMB_DIM, { cacheDir, autoDownload: false })
await emb.warmUp()
if (!emb.isAvailable()) {
  console.error(`bench-threshold-real: embedder ${EMB_MODEL} unavailable in ${cacheDir} — nothing measured.`)
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'avantf-threshold-home-'))
mkdirSync(join(home, 'configs'), { recursive: true })
writeFileSync(join(home, 'configs/common.yaml'), `semantic:\n  local_model: ${EMB_MODEL}\n  dim: ${EMB_DIM}\n  auto_download: false\nrerank:\n  backend: none\n`)
const rt = buildRuntime({ dataHome: home, memoryDbPath: snap, semantic: emb, logger: quiet })
const retriever = rt.config.common.retriever

const strictAt = async (query, threshold, limit = LIMIT) => {
  retriever.min_semantic_similarity = threshold
  const r = await rt.recall({ action: 'search', query, limit, max_tokens: 0, floors: 'strict' })
  return r
}
const defaultAt = async (query, threshold) => {
  retriever.min_semantic_similarity = threshold
  return rt.recall({ action: 'search', query, limit: LIMIT, max_tokens: 0 })
}

/** One query's full reading at both thresholds. */
async function readOne(entry) {
  const sLo5 = await strictAt(entry.q, LO, LIMIT)
  const sHi5 = await strictAt(entry.q, HI, LIMIT)
  const sLo25 = await strictAt(entry.q, LO, LIMIT * 5)
  const sHi25 = await strictAt(entry.q, HI, LIMIT * 5)
  const dLo = await defaultAt(entry.q, LO)
  const dHi = await defaultAt(entry.q, HI)

  /**
   * The semantic leg's EFFECTIVE raw score, mirroring `hybridSearch`'s self-reference augmentation
   * (方案 A): the original query and its canonical rewrite each run their own semantic leg, and the
   * per-candidate raw scores are unioned with `max`. Scoring only the original would UNDER-report
   * which candidates the 0.55 floor removes for exactly the self-referential family (measured: on
   * `我是做什么的` / `我是谁？` the dropped #117/#103/#133 come from the rewrite's leg).
   */
  const variants = [entry.q]
  const rewrite = selfQueryRewrite(entry.q)
  if (rewrite !== undefined && rewrite !== entry.q) variants.push(rewrite)
  const qvs = []
  for (const v of variants) qvs.push(await emb.encode(v))
  const effectiveCos = (vec) => {
    let best = -Infinity
    for (const q of qvs) {
      const c = cosine(q, vec)
      if (c !== null && c > best) best = c
    }
    return best === -Infinity ? null : best
  }
  const scored = facts
    .map((f) => ({ ...f, cos: effectiveCos(f.vec) }))
    .filter((f) => f.cos !== null)
    .sort((a, b) => b.cos - a.cos)
  const window = Math.max(50, LIMIT) // the semantic leg's own candidate window (`max(50, k)`, per variant)
  const legTop = scored.slice(0, window)
  // The mechanism: everything the 0.55 floor removes that 0.50 kept, inside the leg's window.
  const cutByFloor = legTop
    .map((f, rank) => ({ ...f, semRank: rank + 1 }))
    .filter((f) => f.cos >= LO - 1e-12 && f.cos < HI - 1e-12)
  const fusedLo = new Map(sLo25.hits.map((h, i) => [h.ref_id, { fused: h.score, rank: i + 1 }]))
  const fusedHi = new Map(sHi25.hits.map((h, i) => [h.ref_id, { fused: h.score, rank: i + 1 }]))

  const ids = (r) => r.hits.map((h) => h.ref_id)
  const observableCut = ids(sLo5).filter((id) => !ids(sHi5).includes(id))

  return {
    id: entry.id,
    query: entry.q,
    kind: entry.kind,
    gold: entry.gold ?? null,
    semantic_variants: variants,
    strict_lo: { ids: ids(sLo5), scores: sLo5.hits.map((h) => round4(h.score)), drops: sLo5.dropped_by_floor, relaxed: sLo5.relaxed === true },
    strict_hi: { ids: ids(sHi5), scores: sHi5.hits.map((h) => round4(h.score)), drops: sHi5.dropped_by_floor, relaxed: sHi5.relaxed === true },
    default_lo: { ids: ids(dLo), relaxed: dLo.relaxed === true, drops: dLo.dropped_by_floor },
    default_hi: { ids: ids(dHi), relaxed: dHi.relaxed === true, drops: dHi.dropped_by_floor },
    observable_cut: observableCut,
    floor_drop_count_lo: sLo5.dropped_by_floor?.semantic ?? null,
    floor_drop_count_hi: sHi5.dropped_by_floor?.semantic ?? null,
    semantic_window: window,
    cut_by_floor: cutByFloor.map((f) => ({
      id: f.id,
      len: f.len,
      category: f.category,
      pinned: f.pinned,
      cos: round4(f.cos),
      sem_rank: f.semRank,
      head: f.head,
      fused_lo: fusedLo.has(f.id) ? round4(fusedLo.get(f.id).fused) : null,
      rank_lo: fusedLo.has(f.id) ? fusedLo.get(f.id).rank : null,
      fused_hi: fusedHi.has(f.id) ? round4(fusedHi.get(f.id).fused) : null,
      rank_hi: fusedHi.has(f.id) ? fusedHi.get(f.id).rank : null,
      in_strict_lo_topk: ids(sLo5).includes(f.id),
    })),
  }
}

const rows = []
for (const entry of QUERIES) rows.push(await readOne(entry))

// ─── frozen-set counterpart (41 queries, real embedder, all legs live) ────────
const cases = loadEvalCases(FIXTURE)
const evalDirs = []
const evalByThreshold = {}
// Memoized per (threshold, setup_facts): one runtime per case per threshold, like `bench-floors.mjs`.
const evalRuntimes = new Map()
for (const threshold of [LO, HI]) {
  const retrieve = async (query, k, setupFacts) => {
    const key = `${threshold}\u0000${setupFacts.join('\u0001')}`
    let cached = evalRuntimes.get(key)
    if (cached === undefined) {
      const dir = mkdtempSync(join(tmpdir(), 'avantf-threshold-eval-'))
      evalDirs.push(dir)
      mkdirSync(join(dir, 'configs'), { recursive: true })
      writeFileSync(join(dir, 'configs/common.yaml'), `semantic:\n  local_model: ${EMB_MODEL}\n  dim: ${EMB_DIM}\n  auto_download: false\nrerank:\n  backend: none\n`)
      const ert = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: emb, logger: quiet })
      ert.config.common.retriever.min_semantic_similarity = threshold
      const ids = []
      for (const f of setupFacts) ids.push((await ert.remember({ action: 'add', content: f })).fact_id)
      cached = { ert, ids }
      evalRuntimes.set(key, cached)
    }
    const r = await cached.ert.recall({ action: 'search', query, limit: k, max_tokens: 0, floors: 'strict' })
    return r.hits.map((h) => cached.ids.indexOf(h.ref_id)).filter((i) => i >= 0).slice(0, k)
  }
  const report = await evaluateCases(cases, retrieve)
  evalByThreshold[String(threshold)] = {
    precision_at_k: round4(report.summary.mean_precision_at_k),
    recall_at_k: round4(report.summary.mean_recall_at_k),
    mrr: round4(report.summary.mrr),
    must_include: round4(report.summary.must_include_pass_rate),
    must_exclude: round4(report.summary.must_exclude_pass_rate),
    empty_rate: round4(report.summary.empty_rate),
    blocked: report.perQuery.filter((q) => !q.must_include_satisfied).map((q) => q.query),
  }
}
for (const { ert } of evalRuntimes.values()) ert.shutdown()

// ─── aggregates ──────────────────────────────────────────────────────────────
const withGold = rows.filter((r) => r.gold !== null)
const cutAll = rows.flatMap((r) => r.cut_by_floor.map((c) => ({ ...c, query: r.query, kind: r.kind, gold: r.gold })))
const cutGold = cutAll.filter((c) => c.gold !== null && c.gold.includes(c.id))
const observableAll = rows.flatMap((r) => r.observable_cut.map((id) => ({ query: r.query, id, gold: r.gold, kind: r.kind })))
const observableGold = observableAll.filter((c) => c.gold !== null && c.gold.includes(c.id))
const top1 = (r, key) => r[key].ids[0] ?? null
const summary = {
  queries: rows.length,
  strict_nonempty_lo: rows.filter((r) => r.strict_lo.ids.length > 0).length,
  strict_nonempty_hi: rows.filter((r) => r.strict_hi.ids.length > 0).length,
  default_nonempty_lo: rows.filter((r) => r.default_lo.ids.length > 0).length,
  default_nonempty_hi: rows.filter((r) => r.default_hi.ids.length > 0).length,
  strict_top1_changed: rows.filter((r) => top1(r, 'strict_lo') !== top1(r, 'strict_hi')).length,
  default_top1_changed: rows.filter((r) => top1(r, 'default_lo') !== top1(r, 'default_hi')).length,
  with_gold: withGold.length,
  gold_queries_top1_ok_lo: withGold.filter((r) => r.strict_lo.ids[0] !== undefined && r.gold.includes(r.strict_lo.ids[0])).length,
  gold_queries_top1_ok_hi: withGold.filter((r) => r.strict_hi.ids[0] !== undefined && r.gold.includes(r.strict_hi.ids[0])).length,
  with_gold_nonempty_lo: withGold.filter((r) => r.strict_lo.ids.length > 0).length,
  with_gold_nonempty_hi: withGold.filter((r) => r.strict_hi.ids.length > 0).length,
  cut_entries_total: cutAll.length,
  cut_entries_gold: cutGold.length,
  cut_entries_gold_detail: cutGold.map((c) => ({ query: c.query, id: c.id, cos: c.cos, sem_rank: c.sem_rank, in_strict_lo_topk: c.in_strict_lo_topk })),
  observable_cut_total: observableAll.length,
  observable_cut_gold: observableGold.length,
  observable_cut_gold_detail: observableGold,
}
const results = { label: LABEL, measured_at: new Date().toISOString(), node: process.version, db: DB, thresholds: [LO, HI], limit: LIMIT, head_chars: SHOW_HEAD ? HEAD_LEN : 0, active_facts: facts.length, summary, rows, eval_frozen: evalByThreshold }

// ─── console tables ──────────────────────────────────────────────────────────
console.log('\n== per-query (strict, no auto-relax) ==')
for (const r of rows) {
  console.log([
    r.id.padEnd(22),
    `lo[${r.strict_lo.ids.join(',') || '-'}]`,
    `hi[${r.strict_hi.ids.join(',') || '-'}]`,
    `cut=${r.observable_cut.join(',') || '-'}`,
    `semDrops ${String(r.floor_drop_count_lo)}->${String(r.floor_drop_count_hi)}`,
    `default ${r.default_lo.ids.length}->${r.default_hi.ids.length}${r.default_hi.relaxed ? '(relaxed)' : ''}`,
  ].join('\t'))
}

console.log(`\n== facts removed by the ${HI} floor (0.50 <= cos < 0.55, semantic window top-${rows[0]?.semantic_window ?? 50}) ==`)
console.log(['fact_id', 'len', 'category', 'pinned', 'cos', 'sem#', 'fused@lo', 'rank@lo', 'fused@hi', 'inTop5@lo', 'head'].join('\t'))
for (const r of rows) {
  for (const c of r.cut_by_floor) {
    console.log([c.id, c.len, c.category, c.pinned ? 'Y' : '-', c.cos, c.sem_rank, c.fused_lo ?? '-', c.rank_lo ?? '-', c.fused_hi ?? '-', c.in_strict_lo_topk ? 'Y' : '-', c.head ?? ''].join('\t'))
  }
}

console.log('\n== frozen 41 @ both thresholds (strict, real embedder) ==')
console.log(JSON.stringify(evalByThreshold, null, 2))
console.log('\n== summary ==')
console.log(JSON.stringify(summary, null, 2))

if (jsonOut !== null) {
  mkdirSync(dirname(resolve(jsonOut)), { recursive: true })
  writeFileSync(resolve(jsonOut), JSON.stringify(results, null, 2))
  console.log(`\nwrote ${resolve(jsonOut)}`)
}

rt.shutdown()
for (const d of [work, home, ...evalDirs]) rmSync(d, { recursive: true, force: true })
