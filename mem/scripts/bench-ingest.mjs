/**
 * Knowledge-ingest benchmark — the evidence behind `docs/PERFORMANCE_REVIEW.md` §3.3 / §4.10.
 *
 * This is the one benchmark that uses the REAL embedder (`Xenova/bge-base-zh-v1.5`), because
 * the dominant ingest cost is the per-chunk ONNX encode: the store is serial, so throughput is
 * `1 / encode_time` per chunk, and no stub can tell you that number. It measures:
 *
 *   - model load time (first call),
 *   - ingest wall time and derived ms/chunk at one or more corpus sizes,
 *   - the isolated cost of one chunk (a short text) — the fixed per-call floor,
 *   - `kb_query` latency on the resulting corpus,
 *   - `kb_manage reindex` dry_run / full / repeated (the review found the zero-stale full
 *     reindex still pays a whole vstore rebuild),
 *   - startup on a store that already has chunk vectors (hnswlib migration past 2000 chunks).
 *
 * Requires the ONNX model in the cache (`semantic.cache_dir`, default `~/.avantf/models`). If it
 * is missing, the script says so and exits instead of silently measuring a degraded path.
 *
 * Usage:
 *   node scripts/bench-ingest.mjs [--chunks 300,4500] [--json out.json]
 *                                 [--data-home DIR] [--keep]
 *
 * `--chunks` are TARGET chunk counts; the script generates text by repeating paragraphs until
 * `chars >= chunks * (chunk_size - chunk_overlap)` and reports the chunks actually produced.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { buildRuntime } = await import(join(repo, 'packages/core/lib/index.js'))
const { openKnowledgeDb } = await import(join(repo, 'packages/core/lib/db/knowledge.js'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)

const CHUNK_TARGETS = String(arg('chunks', '300,4500')).split(',').map(Number)
const dataHomeArg = arg('data-home', null)
const KEEP = has('keep')
const jsonOut = arg('json', null)
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  return round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))], 3)
}
const timeIt = async (fn, iterations) => {
  const out = []
  for (let i = 0; i < iterations; i++) {
    const s = performance.now()
    await fn(i)
    out.push(performance.now() - s)
  }
  return { p50: pct(out, 50), max: pct(out, 100) }
}

const PARA = (i) =>
  `第${i}段：性能优化记录。服务 svc-payment-${i % 37} 针对 cache-layer-${i % 11} 的缓存失效策略做了调整，`
  + `验证了模型推理时延与检索召回率之间的关系，并记录了基线数据与回归结果。`
  + `本条记录用于压测知识库的分块、实体抽取、语义编码与索引重建路径。`

/** Text long enough to produce roughly `target` chunks at the configured chunk stride. */
function textFor(target, strideChars) {
  const paras = []
  let chars = 0
  for (let i = 0; chars < target * strideChars; i++) {
    const p = PARA(i)
    paras.push(p)
    chars += p.length + 1
  }
  return paras.join('\n')
}

const QUERY = '缓存失效策略与检索召回率'
const rows = []
for (const target of CHUNK_TARGETS) {
  const home = dataHomeArg ?? mkdtempSync(join(tmpdir(), 'avantf-bench-ingest-'))
  mkdirSync(home, { recursive: true })
  const reused = existsSync(join(home, 'knowledge', 'knowledge.db')) && dataHomeArg !== null

  let t0 = performance.now()
  const rt = buildRuntime({ dataHome: home, logger: quiet })
  const bootColdMs = round(performance.now() - t0)
  t0 = performance.now()
  const warm = await rt.memory.warmupSemantic()
  const modelLoadMs = round(performance.now() - t0)

  if (!warm) {
    console.error(
      `semantic backend unavailable (${rt.config.common.semantic.backend}, model `
      + `${rt.config.common.semantic.local_model}) — fetch it into `
      + `${rt.config.common.semantic.cache_dir} first, or set AVANTF_MEM_AUTO_DOWNLOAD=1.`,
    )
    rt.shutdown()
    process.exitCode = 2
    break
  }

  const stride = Math.max(1, rt.config.knowledge.chunk_size - rt.config.knowledge.chunk_overlap)
  const text = textFor(target, stride)
  let ingestMs = null
  let chunks = null
  let reindex = null
  if (!reused) {
    t0 = performance.now()
    const result = await rt.kb({ action: 'ingest', text, domain: 'bench', source: 'spec', title: `bench-${target}` })
    ingestMs = round(performance.now() - t0)
    chunks = result?.chunks ?? null
  }

  // Isolated per-call cost: one short text = one chunk, so this is encode + jieba + FTS + insert.
  const single = await timeIt((i) => rt.knowledge.ingest(`短文本探针 ${i} 性能优化记录`, 'bench', 'probe'), 20)

  const query = await timeIt(() => rt.query({ query: QUERY }), 5)
  const searchMemory = await timeIt(() => rt.recall({ action: 'search', query: QUERY, limit: 10 }), 5)
  await timeIt(() => rt.kb({ action: 'list' }), 1)
  await timeIt(() => {
    const list = rt.kb({ action: 'list' })
    const docId = list?.[0]?.doc_id
    if (docId) rt.kb({ action: 'detail', doc_id: docId })
  }, 3)

  if (!reused) {
    const dryStart = performance.now()
    const dry = await rt.kb({ action: 'reindex', domain: 'bench', dry_run: true })
    const dryMs = round(performance.now() - dryStart)
    const fullStart = performance.now()
    const full = await rt.kb({ action: 'reindex', domain: 'bench' })
    const fullMs = round(performance.now() - fullStart)
    const againStart = performance.now()
    const again = await rt.kb({ action: 'reindex', domain: 'bench' })
    const againMs = round(performance.now() - againStart)
    reindex = {
      dry_run: { ms: dryMs, stale: dry?.vectors_stale ?? null, encoded: dry?.vectors_encoded ?? null },
      full_zero_stale: { ms: fullMs, stale: full?.vectors_stale ?? null, encoded: full?.vectors_encoded ?? null },
      full_again: { ms: againMs, stale: again?.vectors_stale ?? null, encoded: again?.vectors_encoded ?? null },
    }
  }

  // Cold vs warm startup: the second boot has to reload every chunk vector into the vstore.
  const kdb = openKnowledgeDb(join(home, 'knowledge', 'knowledge.db'))
  const counts = kdb.prepare(
    `SELECT (SELECT count(*) FROM documents) AS docs,
            (SELECT count(*) FROM doc_chunks) AS chunks,
            (SELECT count(*) FROM doc_chunks WHERE semantic_vector IS NOT NULL) AS vecs`,
  ).get()
  kdb.close()
  const dbBytes = statSync(join(home, 'knowledge', 'knowledge.db')).size
  rt.shutdown()

  t0 = performance.now()
  const rt2 = buildRuntime({ dataHome: home, logger: quiet })
  const bootWarmMs = round(performance.now() - t0)
  const queryWarm = await timeIt(() => rt2.query({ query: QUERY }), 5)
  rt2.shutdown()

  const row = {
    target_chunks: target,
    reused,
    chars: text.length,
    actual_chunks: chunks ?? counts.chunks,
    ms_per_chunk: chunks ? round(ingestMs / chunks, 2) : null,
    ingest_ms: ingestMs,
    single_text_chunk: single,
    model_load_ms: modelLoadMs,
    boot_cold_ms: bootColdMs,
    boot_warm_ms: bootWarmMs,
    query: { ...query, range: query.max - query.p50 },
    query_warm: { ...queryWarm, range: queryWarm.max - queryWarm.p50 },
    search_memory: searchMemory,
    reindex,
    counts,
    db_bytes: dbBytes,
    ...(dataHomeArg !== null || KEEP ? { data_home: home } : {}),
  }
  rows.push(row)
  console.log(
    `target=${String(target).padStart(5)}  chunks=${String(row.actual_chunks).padStart(5)}  `
    + `ingest=${String(row.ingest_ms ?? 'n/a').padStart(9)}ms  per_chunk=${String(row.ms_per_chunk ?? 'n/a').padStart(6)}ms  `
    + `query p50=${String(row.query.p50).padStart(7)}ms  boot_cold=${String(bootColdMs).padStart(7)}ms  `
    + `boot_warm=${String(bootWarmMs).padStart(8)}ms`,
  )

  if (dataHomeArg === null && !KEEP) rmSync(home, { recursive: true, force: true })
}

const report = {
  measured_at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: (await import('node:os')).cpus()[0]?.model ?? 'unknown',
  rows,
  note: [
    'Uses the real ONNX embedder — per-chunk encode dominates, so ms/chunk is the headline number.',
    'Encode cost scales with TOKENS, not with the call: a short query is a few ms, a ~450-char',
    'chunk is tens of ms on the same machine. Never extrapolate a query encode to an ingest.',
    'actual_chunks is authoritative: the target only sizes the generated text, and chunkText',
    'packs on line boundaries, so the two differ (most at small targets).',
    'Very small targets also fold the first-call session warm-up into ms/chunk — read ms/chunk',
    'from a corpus of at least a few hundred chunks, not from a smoke run.',
    'single_text_chunk is one short ingest = the fixed per-call floor (encode of a tiny text).',
    'boot_warm reloads every chunk vector into the vstore and migrates to hnswlib past 2000 chunks.',
    'reindex full_zero_stale re-encodes 0 vectors by design; its cost is the unconditional',
    'rebuildFts + the full vstore reload — that is the finding, not a mistake in the setup.',
  ],
}
console.log('\n' + JSON.stringify(report.note, null, 2))
if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
