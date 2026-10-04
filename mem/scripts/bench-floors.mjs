/**
 * Relevance-floor calibration scan — the evidence behind DESIGN §20.19's P@k/R@k table.
 *
 * The semantic floor (`retriever.min_semantic_similarity`, default 0.5) is in COSINE units, so it
 * is calibrated against the shipped embedder and must be re-scanned whenever the model/width
 * changes. This script reproduces the ORIGINAL method: the semantic leg is LEFT LIVE (the real
 * ONNX model through the production loader), while the other two floors are set to 0 to isolate
 * the semantic knob; it then walks the thresholds and reports the same seven columns as the doc
 * table.
 *
 * Two details that make the reading trustworthy:
 *   - `floors: 'strict'` is passed explicitly, so DESIGN §20.20's auto-relax pass never fires.
 *     Without it, an empty strict pass at e.g. 0.55 would be re-run at 0.40 and the row would no
 *     longer describe THAT threshold's effect.
 *   - every case gets a real `remember` + real `recall`; the runtime is memoized per setup_facts
 *     and one warmed backend is shared across cases, so model loading is paid once.
 *
 * Validation: run this at `--model Xenova/bge-small-zh-v1.5 --dim 512 --exclude-tag self_query`
 * and it reproduces the 512/35 table recorded in DESIGN §20.19 to the last decimal — that is what
 * makes the 768/41 table it now carries (表二) credible.
 *
 * Usage:
 *   node scripts/bench-floors.mjs [--model Xenova/bge-base-zh-v1.5] [--dim 768]
 *                                 [--thresholds 0,0.40,0.45,0.50,0.55,0.60]
 *                                 [--exclude-tag self_query] [--json out.json]
 *
 * Requires the model in the cache (`~/.avantf/env/models`); it says so and exits instead of
 * silently measuring a degraded path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = (p) => join(repo, 'packages', p)
const { buildRuntime } = await import(lib('core/lib/index.js'))
const { loadEvalCases } = await import(lib('core/lib/eval/loader.js'))
const { evaluateCases } = await import(lib('core/lib/eval/runner.js'))
const { LocalBgeBackend } = await import(lib('retrieval-core/lib/adapters/local_bge.js'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const MODEL = arg('model', 'Xenova/bge-base-zh-v1.5')
const DIM = Number(arg('dim', 768))
const THRESHOLDS = String(arg('thresholds', '0,0.40,0.45,0.50,0.55,0.60')).split(',').map(Number)
const EXCLUDE_TAG = arg('exclude-tag', null)
const jsonOut = arg('json', null)
const FIXTURE = join(repo, 'packages/core/test/fixtures/eval_zh_relations.jsonl')
const cacheDir = arg('cache-dir', join(homedir(), '.avantf/env/models'))
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const round4 = (v) => Math.round(v * 1e4) / 1e4

const allCases = loadEvalCases(FIXTURE)
const cases = EXCLUDE_TAG === null ? allCases : allCases.filter((c) => !c.tags.includes(EXCLUDE_TAG))
const nQueries = cases.flatMap((c) => c.queries).length

const backend = new LocalBgeBackend(MODEL, DIM, { cacheDir, autoDownload: false })
await backend.warmUp()
if (!backend.isAvailable()) {
  console.error(`bench-floors: model ${MODEL} is not available in ${cacheDir} — nothing measured.`)
  process.exit(1)
}
console.log(`model=${MODEL}  dim=${DIM}  cases=${cases.length}  queries=${nQueries}`)

const runtimes = []
const dirs = []
let cached = null

/** Retrieve at `threshold`, with the other two floors off and the auto-relax pass disabled. */
const retrieveAt = (threshold) => async (query, k, facts) => {
  if (!cached || cached.facts !== facts) {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-floors-'))
    dirs.push(dir)
    // buildRuntime refuses a backend whose width disagrees with `semantic.dim`, so pin the config
    // to the model under test (this is what lets the same script run the 512/35 validation).
    mkdirSync(join(dir, 'configs'), { recursive: true })
    writeFileSync(join(dir, 'configs/common.yaml'), `semantic:\n  local_model: ${MODEL}\n  dim: ${DIM}\n  auto_download: false\n`)
    const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: backend, logger: quiet })
    const ids = []
    for (const f of facts) ids.push((await rt.remember({ action: 'add', content: f })).fact_id)
    cached = { facts, rt, ids }
    runtimes.push(rt)
  }
  const retriever = cached.rt.config.common.retriever
  retriever.min_semantic_similarity = threshold
  retriever.min_fts_terms = 0
  retriever.min_jaccard = 0
  const hit = await cached.rt.recall({ action: 'search', query, floors: 'strict' })
  return hit.hits
    .map((h) => cached.ids.indexOf(h.ref_id))
    .filter((i) => i >= 0)
    .slice(0, k)
}

const rows = []
for (const threshold of THRESHOLDS) {
  const report = await evaluateCases(cases, retrieveAt(threshold))
  const blocked = report.perQuery.filter((q) => !q.must_include_satisfied)
  rows.push({
    threshold,
    precision_at_k: round4(report.summary.mean_precision_at_k),
    recall_at_k: round4(report.summary.mean_recall_at_k),
    mrr: round4(report.summary.mrr),
    must_include: round4(report.summary.must_include_pass_rate),
    must_exclude: round4(report.summary.must_exclude_pass_rate),
    empty: round4(report.summary.empty_rate),
    blocked_must_include: blocked.length,
    blocked_queries: blocked.map((q) => q.query),
    total_hits: report.perQuery.reduce((s, q) => s + q.actual_ids.length, 0),
  })
}

for (const rt of runtimes) rt.shutdown()
for (const d of dirs) rmSync(d, { recursive: true, force: true })

const header = ['threshold', 'P@k', 'R@k', 'MRR', 'must_inc', 'must_exc', 'empty', 'blocked', 'hits']
console.log(header.join('\t'))
for (const r of rows) {
  console.log([r.threshold, r.precision_at_k, r.recall_at_k, r.mrr, r.must_include, r.must_exclude, r.empty, r.blocked_must_include, r.total_hits].join('\t'))
}
if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify({ measured_at: new Date().toISOString(), node: process.version, model: MODEL, dim: DIM, queries: nQueries, excluded_tag: EXCLUDE_TAG, rows }, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
