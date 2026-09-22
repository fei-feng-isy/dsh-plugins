/**
 * Read-path write-amplification benchmark — the evidence behind `docs/PERFORMANCE_REVIEW.md` §4.9.
 *
 * A `mem_recall search` is the only read action that WRITES: `track: true` (the default) runs
 * `reinforce`, which touches the usage counters and the trust settlement of every returned fact
 * in its own transaction. The review measured that at 13 statements and ~8.6 KB of WAL per
 * search. This script keeps both halves measurable:
 *
 *   - latency with and without `track` (same queries, same store),
 *   - WAL bytes produced by N searches with each setting, after a `wal_checkpoint(TRUNCATE)`,
 *   - how many distinct facts were actually touched, versus how many row-updates were issued.
 *
 * The distinction matters because cross-store `kb_query` already passes `track: false`, while a
 * direct `mem_recall search` pays it on every call.
 *
 * Usage:
 *   node scripts/bench-reinforce.mjs [--facts 5000] [--iterations 100] [--json out.json]
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { buildRuntime } = await import(join(repo, 'packages/core/lib/index.js'))
const { readClock } = await import(join(repo, 'packages/core/lib/lifecycle/presence.js'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const FACTS = Number(arg('facts', 5000))
const ITER = Number(arg('iterations', 100))
const jsonOut = arg('json', null)
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  return round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))], 3)
}

const home = mkdtempSync(join(tmpdir(), 'avantf-bench-reinforce-'))
const stub = {
  name: 'bench-stub',
  dim: 512,
  isAvailable: () => false,
  async encode() { return new Float32Array(512) },
  async encodeBatch(texts) { return texts.map(() => new Float32Array(512)) },
}
const rt = buildRuntime({ dataHome: home, semantic: stub, logger: quiet })
const db = rt.db
const clock = readClock(db)
db.transaction(() => {
  const ins = db.prepare(
    'INSERT INTO facts (content, category, settle_clock, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  )
  for (let i = 0; i < FACTS; i++) {
    ins.run(`性能优化记录：条目 ${i} 缓存失效策略的调整`, 'bench', clock, 'active', '2025-06-01 00:00:00', '2025-06-01 00:00:00')
  }
})()

const walBytes = () => {
  try {
    return statSync(join(home, 'memory', 'memory.db-wal')).size
  } catch {
    return 0
  }
}
const queryOf = (i) => `缓存失效策略 条目 ${i % 40}`

/** Same store, same queries — only `track` differs. Each arm starts from a truncated WAL. */
async function arm(track) {
  db.pragma('wal_checkpoint(TRUNCATE)')
  const before = walBytes()
  const latencies = []
  for (let i = 0; i < ITER; i++) {
    const s = performance.now()
    await rt.memory.search({ query: queryOf(i), limit: 10, track })
    latencies.push(performance.now() - s)
  }
  return {
    track,
    p50_ms: pct(latencies, 50),
    p95_ms: pct(latencies, 95),
    total_ms: round(latencies.reduce((a, b) => a + b, 0)),
    wal_bytes: walBytes() - before,
    wal_bytes_per_search: Math.round((walBytes() - before) / ITER),
  }
}

const withTrack = await arm(true)
const withoutTrack = await arm(false)

const touched = db.prepare('SELECT count(*) AS touched, sum(retrieval_count) AS sum_rc FROM facts WHERE retrieval_count > 0').get()
const report = {
  measured_at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: (await import('node:os')).cpus()[0]?.model ?? 'unknown',
  facts: FACTS,
  iterations: ITER,
  limit: 10,
  track_true: withTrack,
  track_false: withoutTrack,
  distinct_facts_touched: touched.touched,
  total_retrieval_count: touched.sum_rc,
  note: [
    'Both arms run the same queries against the same store; only `track` changes.',
    'WAL is truncated before each arm, so wal_bytes is that arm\'s own write volume.',
    'A search returns the same ~10 facts each time, yet every tracked search rewrites their',
    'usage counters — distinct_facts_touched stays flat while total_retrieval_count grows by',
    'roughly iterations x limit. That ratio is the amplification.',
    'Read p50 as the per-call effect; `total_ms` is NOT a controlled comparison between arms,',
    'because the tracked arm grows a WAL that the untracked arm never writes (and the second',
    'arm therefore starts from a checkpointed, warmer file). Use wal_bytes_per_search for cost.',
    'Cross-store `kb_query` does not pay this (it passes track: false for the memory leg).',
  ],
}
console.log(`track=true   p50=${withTrack.p50_ms}ms  total=${withTrack.total_ms}ms  wal=${withTrack.wal_bytes}B (${withTrack.wal_bytes_per_search}B/search)`)
console.log(`track=false  p50=${withoutTrack.p50_ms}ms  total=${withoutTrack.total_ms}ms  wal=${withoutTrack.wal_bytes}B`)
console.log(`distinct facts touched=${touched.touched}  total retrieval_count=${touched.sum_rc}`)
console.log('\n' + JSON.stringify(report.note, null, 2))
if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
rt.shutdown()
rmSync(home, { recursive: true, force: true })
