/**
 * Vector-store scale benchmark — the evidence behind `vectorStore.auto_thresholds.hnswlib`.
 *
 * The threshold (2000 by default) decides when `auto` migrates from the brute-force
 * `local_numpy` store to the `hnswlib` ANN index. It was chosen without a measurement, and the
 * two sides are not obviously comparable: hnswlib is APPROXIMATE (it can miss neighbours), so
 * the crossover is not only about latency — it is about how much recall the speed costs.
 *
 * This script measures, per corpus size:
 *   - build time for both stores,
 *   - query latency (p50 / p95) for both,
 *   - recall@k of hnswlib against the brute-force ground truth,
 * and prints where the trade stops being worth it. It is a script, not a test: the numbers
 * depend on the machine, and the output records the environment alongside them.
 *
 * Usage:  node scripts/bench-vstore.mjs [--sizes 1000,2000,4000] [--dim 512] [--queries 30] [--json out.json]
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = (name) => join(repo, 'packages/retrieval-core/lib', name)
const { LocalNumpyVectorStore } = await import(lib('adapters/local_numpy.js'))
const { HnswlibVectorStore } = await import(lib('adapters/hnswlib.js'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const SIZES = String(arg('sizes', '1000,2000,4000,8000')).split(',').map(Number)
const DIM = Number(arg('dim', 512))
const QUERIES = Number(arg('queries', 30))
const K = Number(arg('k', 50)) // the retrieval paths ask for >= 50 candidates
const jsonOut = arg('json', null)

/** Deterministic pseudo-random unit vectors (mulberry32): reproducible without a dependency. */
function rng(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function unitVector(next) {
  const v = new Float32Array(DIM)
  let norm = 0
  for (let i = 0; i < DIM; i++) {
    v[i] = next() * 2 - 1
    norm += v[i] * v[i]
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < DIM; i++) v[i] /= norm
  return v
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function measure(store, queries) {
  const latencies = []
  const results = []
  for (const q of queries) {
    const t0 = process.hrtime.bigint()
    const hits = store.topk(q, K)
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6)
    results.push(hits.map((h) => h.id))
  }
  const sorted = [...latencies].sort((a, b) => a - b)
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), results }
}

function recallAtK(truth, actual) {
  let hit = 0
  let total = 0
  for (let i = 0; i < truth.length; i++) {
    const gold = new Set(truth[i])
    for (const id of actual[i]) if (gold.has(id)) hit += 1
    total += gold.size
  }
  return total === 0 ? 1 : hit / total
}

const rows = []
for (const n of SIZES) {
  const next = rng(0x5eed)
  const vectors = Array.from({ length: n }, (_, i) => ({ id: i + 1, vec: unitVector(next) }))
  const queries = Array.from({ length: QUERIES }, () => unitVector(next))

  const numpy = new LocalNumpyVectorStore(DIM)
  let t0 = process.hrtime.bigint()
  numpy.rebuild(vectors)
  const numpyBuildMs = Number(process.hrtime.bigint() - t0) / 1e6
  const numpyRun = measure(numpy, queries)

  const hnsw = new HnswlibVectorStore(DIM)
  t0 = process.hrtime.bigint()
  hnsw.rebuild(vectors)
  const hnswBuildMs = Number(process.hrtime.bigint() - t0) / 1e6
  const native = hnsw.name === 'hnswlib'
  const hnswRun = measure(hnsw, queries)
  const hnswStatsBefore = hnsw.stats()

  // Eviction cost is measured AFTER recall/serve, because it mutates the store. This is the
  // number that used to be a full rebuild — one `update`/`archive` per evicted id — and is now a
  // tombstone. `rebuilds` must not move for the single-id case: that is the mechanism, and it is
  // what makes the measurement a regression test rather than a machine-dependent duration.
  const evictOne = () => {
    t0 = process.hrtime.bigint()
    hnsw.removeMany([1])
    return Number(process.hrtime.bigint() - t0) / 1e6
  }
  const evictOneMs = native ? evictOne() : null
  const rebuildsAfterOne = hnsw.stats().rebuilds
  const batch = Array.from({ length: Math.min(1000, n) }, (_, i) => i + 2)
  t0 = process.hrtime.bigint()
  if (native) hnsw.removeMany(batch)
  const evictBatchMs = native ? Number(process.hrtime.bigint() - t0) / 1e6 : null
  const hnswStatsAfter = hnsw.stats()

  const row = {
    n,
    dim: DIM,
    queries: QUERIES,
    numpy: { build_ms: round(numpyBuildMs), p50_ms: round(numpyRun.p50, 3), p95_ms: round(numpyRun.p95, 3) },
    hnsw: { available: native, build_ms: round(hnswBuildMs), p50_ms: round(hnswRun.p50, 3), p95_ms: round(hnswRun.p95, 3) },
    recall_at_k: native ? round(recallAtK(numpyRun.results, hnswRun.results), 4) : null,
    speedup_p50: native && hnswRun.p50 > 0 ? round(numpyRun.p50 / hnswRun.p50, 2) : null,
    evict: native
      ? {
          one_id_ms: round(evictOneMs, 3),
          batch_ms: round(evictBatchMs, 3),
          batch_size: batch.length,
          rebuilds_after_one: rebuildsAfterOne - hnswStatsBefore.rebuilds,
          tombstones: hnswStatsAfter.tombstones,
          compacted: hnswStatsAfter.rebuilds > rebuildsAfterOne,
        }
      : null,
  }
  rows.push(row)
  console.log(
    `n=${String(n).padStart(6)}  numpy p50=${String(row.numpy.p50_ms).padStart(7)}ms  `
    + `hnsw p50=${String(row.hnsw.p50_ms).padStart(7)}ms  speedup=${String(row.speedup_p50 ?? 'n/a').padStart(5)}x  `
    + `recall@${String(K)}=${row.recall_at_k === null ? 'n/a (native binding unavailable)' : String(row.recall_at_k)}  `
    + `build numpy=${String(row.numpy.build_ms).padStart(7)}ms hnsw=${String(row.hnsw.build_ms).padStart(7)}ms  `
    + `evict 1 id=${row.evict === null ? 'n/a' : `${row.evict.one_id_ms}ms`}  `
    + `${row.evict?.batch_size ?? 0} ids=${row.evict === null ? 'n/a' : `${row.evict.batch_ms}ms`}  `
    + `rebuilds=${row.evict === null ? 'n/a' : row.evict.rebuilds_after_one}`,
  )
}

function round(v, digits = 2) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

const report = {
  measured_at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: (await import('node:os')).cpus()[0]?.model ?? 'unknown',
  k: K,
  rows,
  note: [
    'Both stores are measured in-process on the same vectors; latency is a single-threaded top-k.',
    'recall@k compares hnswlib against the brute-force result — the price of the speedup.',
    'Vectors are UNIFORM RANDOM, which is the worst case for ANN: real embeddings cluster, so',
    'production recall is higher than these numbers. Judge the threshold on the trend, not the level.',
    'hnswlib search uses vectorStore.hnswlib_ef_search (256) widened to 8*k by the adapter.',
    'evict.one_id_ms is a TOMBSTONE: rebuilds_after_one must stay 0 (a rebuild per eviction was',
    'the defect — 1.3 s for one id at 8000 vectors). Compaction runs only past ~20% tombstones,',
    'which is why the 1000-id arm may report compacted=true and pay a rebuild there.',
  ],
}

console.log('\n' + JSON.stringify(report.note, null, 2))
if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
