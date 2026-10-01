/**
 * Memory-store scale benchmark — the evidence behind `docs/PERFORMANCE_REVIEW.md` §3.1 / §3.2.
 *
 * The review's scale claims (retrieval legs grow linearly with the corpus, `remember update`
 * is O(N) once `auto` has migrated to hnswlib, startup rebuilds the ANN index every process)
 * all come from this script. Keep it runnable so those claims can be re-checked instead of
 * believed: every number it prints is reproducible from a synthetic corpus on one machine.
 *
 * Two modes, because they answer different questions:
 *   - `db`  — stub semantic backend that reports UNAVAILABLE, and rows WITHOUT vectors. This
 *             isolates the SQL/FTS/entity/HRR legs from the vector index, so "how much is the
 *             database" and "how much is the ANN" are not mixed.
 *   - `vec` — the same corpus WITH vectors and the stub AVAILABLE, so `vectorStore.backend:
 *             auto` migrates to hnswlib past the threshold. Sizes here are deliberately small
 *             by default: hnswlib build is ~0.4–1.3 ms/vector, so 16k already costs ~15 s.
 *
 * What it measures per size: candidate fan-out per leg (the mechanism), retrieval latencies,
 * write latencies, the lifecycle tick / maintenance, and process RSS + DB size.
 *
 * Usage:
 *   node scripts/bench-memory.mjs [--mode db|vec|both] [--sizes 2000,10000]
 *                                 [--iterations 20] [--dim 512]
 *                                 [--data-home DIR] [--keep] [--json out.json]
 *
 * `--data-home` reuses an existing seeded store (skips seeding) — useful when iterating on the
 * measurement half. Without it a fresh temp home is created and removed at the end unless
 * `--keep` is passed.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { buildRuntime } = await import(join(repo, 'packages/core/lib/index.js'))
// Benchmarks reach into the engine's internals on purpose, so they import the modules directly
// rather than through the package's public surface (which is deliberately narrow).
const { vectorSpaceId } = await import(join(repo, 'packages/core/lib/db/vectors.js'))
const { readClock } = await import(join(repo, 'packages/core/lib/lifecycle/presence.js'))
const { extractEntities } = await import(join(repo, 'packages/core/lib/entities/extract.js'))
const { encodeHrrEntityVector, hrrToBytes } = await import(join(repo, 'packages/core/lib/hrr/encode.js'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)

const MODE = String(arg('mode', 'both'))
const SIZES = String(arg('sizes', '2000,10000')).split(',').map(Number)
const ITER = Number(arg('iterations', 20))
const DIM = Number(arg('dim', 512))
const dataHomeArg = arg('data-home', null)
const KEEP = has('keep')
const jsonOut = arg('json', null)
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

const pct = (arr, p) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))], 3)
}
const stat = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), max: pct(arr, 100) })
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d
const log = (o) => console.log(JSON.stringify(o))

/**
 * Deterministic stub embedder: hashes the text into a unit vector. It is NOT a model — it only
 * has to be cheap, stable, and to produce dim-valid vectors so the vector store does real mission.
 * Availability is what the two modes switch, so the SQL-only path can be measured in isolation.
 */
function makeStub(available, dim) {
  const enc = (text) => {
    const v = new Float32Array(dim)
    let h = 2166136261
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    let s = h >>> 0
    for (let i = 0; i < dim; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0
      v[i] = (s / 4294967296) * 2 - 1
    }
    let n = 0
    for (let i = 0; i < dim; i++) n += v[i] * v[i]
    n = Math.sqrt(n) || 1
    for (let i = 0; i < dim; i++) v[i] /= n
    return v
  }
  return {
    name: 'bench-stub',
    dim,
    _enc: enc,
    isAvailable: () => available,
    async encode(t) { return enc(t) },
    async encodeBatch(ts) { return ts.map(enc) },
  }
}

// ── synthetic corpus ─────────────────────────────────────────────────────────
// A shared CJK phrase in every fact (so a "common word" query matches the whole corpus), plus
// latin identifiers (so entity extraction has something to find on both sides), plus a per-fact
// number to keep `content` UNIQUE.
const VERBS = ['调整', '验证', '否决', '复核', '记录']
const svc = (i) => `svc-payment-${i % 200}`
const cache = (i) => `cache-layer-${i % 50}`
const contentOf = (i) => `性能优化记录：${svc(i)} 针对 ${cache(i)} 的${VERBS[i % VERBS.length]}（条目 ${i}）`
const QUERIES = {
  common: '性能优化记录',
  selective: `${svc(7)} 的优化`,
  miss: 'zzz-nonexistent-token-xyz',
}

function seed(rt, n, withVectors, spaceId) {
  const db = rt.db
  const clock = readClock(db)
  const insFact = db.prepare(
    `INSERT INTO facts (content, category, settle_clock, status, hrr_vector, semantic_vector, embedding_model, vector_store, created_at, updated_at, retrieval_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const insEntity = db.prepare('INSERT OR IGNORE INTO entities (name, entity_type, extraction_method) VALUES (?,?,?)')
  const getEntity = db.prepare('SELECT entity_id FROM entities WHERE name = ?')
  const insLink = db.prepare('INSERT OR IGNORE INTO fact_entities (fact_id, entity_id) VALUES (?,?)')
  const insTriple = db.prepare('INSERT OR IGNORE INTO triples (fact_id, subj, pred, obj) VALUES (?,?,?,?)')
  const ids = new Map()
  const eid = (name) => {
    let v = ids.get(name)
    if (v === undefined) {
      insEntity.run(name, 'n', 'bench')
      v = getEntity.get(name).entity_id
      ids.set(name, v)
    }
    return v
  }
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const content = contentOf(i)
      const names = [svc(i), cache(i), VERBS[i % VERBS.length]]
      const created = new Date(Date.now() - (i % 90) * 86400000).toISOString().replace('T', ' ').slice(0, 19)
      const vec = withVectors ? Buffer.from(rt.benchEncode(content).buffer.slice(0)) : null
      const r = insFact.run(content, 'bench', clock, 'active', hrrToBytes(encodeHrrEntityVector(names)), vec, withVectors ? spaceId : null, 'local_numpy', created, created, i % 7)
      const fid = Number(r.lastInsertRowid)
      for (const name of names) insLink.run(fid, eid(name))
      insTriple.run(fid, svc(i), VERBS[i % VERBS.length], cache(i))
    }
  })
  tx.immediate()
}

async function runMode(mode) {
  const withVectors = mode === 'vec'
  const rows = []
  for (const n of SIZES) {
    const home = dataHomeArg ?? mkdtempSync(join(tmpdir(), `avantf-bench-${mode}-`))
    mkdirSync(home, { recursive: true })
    const reused = existsSync(join(home, 'memory', 'memory.db')) && dataHomeArg !== null
    const stub = makeStub(withVectors, DIM)
    const spaceId = vectorSpaceId(stub.name, 'bench', DIM)

    let seedMs = 0
    if (!reused) {
      const rt0 = buildRuntime({ dataHome: home, semantic: stub, logger: quiet })
      rt0.benchEncode = stub._enc
      const t0 = performance.now()
      seed(rt0, n, withVectors, spaceId)
      seedMs = round(performance.now() - t0)
      rt0.shutdown()
    }

    const t0 = performance.now()
    const rt = buildRuntime({ dataHome: home, semantic: stub, logger: quiet })
    const startupMs = round(performance.now() - t0)

    // Candidate fan-out: the same SQL shapes the legs use, counted directly. This is the
    // mechanism behind the latency numbers — a leg with no LIMIT returns the whole corpus.
    const db = rt.db
    const ftsCount = (q) => {
      const parts = q.trim().split(/[\s,，。;；]+/).filter(Boolean)
        .flatMap((tok) => (tok.length >= 3 ? [`"${tok}"`] : []))
      if (!parts.length) return null
      try {
        return db.prepare("SELECT count(*) AS c FROM facts_fts f JOIN facts fa ON fa.fact_id=f.rowid WHERE facts_fts MATCH ? AND fa.status='active'").get(parts.join(' OR ')).c
      } catch { return -1 }
    }
    const jacCount = async (q) => {
      const names = (await extractEntities(q)).map((e) => e.name)
      if (!names.length) return 0
      const ph = names.map(() => '?').join(',')
      return db.prepare(`SELECT count(DISTINCT fa.fact_id) AS c FROM facts fa JOIN fact_entities fe ON fe.fact_id=fa.fact_id JOIN entities e ON e.entity_id=fe.entity_id WHERE e.name IN (${ph}) AND fa.status='active'`).all(...names)[0].c
    }
    const fanout = {}
    for (const [key, q] of Object.entries(QUERIES)) fanout[key] = { fts: ftsCount(q), jaccard: await jacCount(q) }
    fanout.hrr_rows = db.prepare("SELECT count(*) AS c FROM facts WHERE status='active' AND hrr_vector IS NOT NULL").get().c
    // The numbers above are the CORPUS-side fan-out of the predicates (what the legs had to
    // process before step 6). The store caps each non-semantic leg at 4x its fusion pool, so the
    // row that actually reaches `fuse` is `min(fanout, leg_cap)` — the cap bounds the JS side
    // (normalize + sort + row loads), while FTS5's own bm25 scoring over the match set remains.
    const factor = rt.config.common.retriever.over_fetch_factor || 5
    fanout.leg_cap = Math.max(200, 10 * factor * 4)

    const timeIt = async (fn, iterations) => {
      const out = []
      for (let i = 0; i < iterations; i++) {
        const s = performance.now()
        await fn(i)
        out.push(performance.now() - s)
      }
      return out
    }
    const search = (q) => rt.recall({ action: 'search', query: q, limit: 10 })
    await search(QUERIES.selective) // warm the statements

    const row = {
      mode,
      n,
      reused,
      seed_ms: seedMs,
      startup_ms: startupMs,
      fanout,
      search_selective: stat(await timeIt(() => search(QUERIES.selective), ITER)),
      search_common: stat(await timeIt(() => search(QUERIES.common), ITER)),
      search_miss: stat(await timeIt(() => search(QUERIES.miss), Math.max(3, Math.floor(ITER / 4)))),
      probe_hrr: stat(await timeIt(() => rt.recall({ action: 'probe', entity: svc(7), limit: 10 }), Math.max(3, Math.floor(ITER / 4)))),
      cross_query: stat(await timeIt(() => rt.query({ query: QUERIES.selective }), Math.max(3, Math.floor(ITER / 4)))),
      admin_list: stat(await timeIt(() => rt.admin({ action: 'list', limit: 50 }), Math.max(3, Math.floor(ITER / 4)))),
      contradict_check_ms: round(await timeSince(() => rt.admin({ action: 'contradict_check' }))),
      trust_diagnose_ms: round(await timeSince(() => rt.admin({ action: 'trust_diagnose' }))),
      vectors_diagnose: await (async () => {
        const s = performance.now()
        const d = rt.admin({ action: 'vectors_diagnose' })
        return { ms: round(performance.now() - s), total: d?.total ?? null, space_stale: d?.space_stale ?? null }
      })(),
    }
    await timeIt(async () => { rt.admin({ action: 'stats' }) }, 1)

    // write path (real store method: jieba extraction + HRR + contradiction detection)
    let wid = n + 100000
    row.remember_add = stat(await timeIt(
      () => rt.remember({ action: 'add', content: `性能优化记录：${svc(7)} 针对 ${cache(3)} 的复核（写入 ${wid++}）` }),
      Math.max(3, Math.floor(ITER / 4)),
    ))
    let uid = 1
    row.remember_update = stat(await timeIt(
      (i) => rt.remember({ action: 'update', fact_id: 1 + ((i + uid) % n), content: `${contentOf(1 + ((i + uid) % n))}（改写 ${i}-${uid++}）` }),
      Math.max(2, Math.floor(ITER / 8)),
    ))

    // lifecycle: force a full settle backlog, then measure one budgeted tick and one maintenance
    db.prepare('UPDATE facts SET settle_clock = settle_clock - 5 WHERE status = ?').run('active')
    row.trust_tick = await (async () => {
      const s = performance.now()
      const r = rt.memory.trustTick()
      return { ms: round(performance.now() - s), settled: r?.settled ?? null, skipped: r?.skipped ?? null, deferred: r?.archived_deferred ?? null }
    })()
    db.prepare('UPDATE facts SET settle_clock = settle_clock - 5 WHERE status = ?').run('active')
    row.maintenance_ms = round(await timeSince(() => rt.memory.maintenance()))

    const mem = process.memoryUsage()
    row.rss_mb = round(mem.rss / 1048576, 1)
    row.heap_mb = round(mem.heapUsed / 1048576, 1)
    row.db_bytes = statSync(join(home, 'memory', 'memory.db')).size
    row.db_files_bytes = readdirSync(join(home, 'memory')).reduce((a, f) => a + statSync(join(home, 'memory', f)).size, 0)

    rt.shutdown()
    if (dataHomeArg === null && !KEEP) rmSync(home, { recursive: true, force: true })
    else row.data_home = home

    rows.push(row)
    console.log(
      `mode=${mode.padEnd(3)} n=${String(n).padStart(6)}  `
      + `search p50=${String(row.search_selective.p50).padStart(8)}ms  common=${String(row.search_common.p50).padStart(8)}ms  `
      + `probe=${String(row.probe_hrr.p50).padStart(9)}ms  add=${String(row.remember_add.p50).padStart(8)}ms  `
      + `update=${String(row.remember_update.p50).padStart(9)}ms  startup=${String(row.startup_ms).padStart(9)}ms  rss=${row.rss_mb}MB`,
    )
  }
  return rows
}

async function timeSince(fn) {
  const s = performance.now()
  await fn()
  return performance.now() - s
}

const modes = MODE === 'both' ? ['db', 'vec'] : [MODE]
const all = []
for (const mode of modes) all.push(...(await runMode(mode)))

const report = {
  measured_at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: (await import('node:os')).cpus()[0]?.model ?? 'unknown',
  dim: DIM,
  iterations: ITER,
  rows: all,
  note: [
    'Semantic backend is a deterministic hash stub, not a model: these numbers isolate the store,',
    'not the embedder. Ingest-side encode cost is measured by scripts/bench-ingest.mjs instead.',
    'mode=db seeds rows WITHOUT vectors and reports the stub unavailable -> SQL/FTS/entity/HRR only.',
    'mode=vec seeds vectors and reports the stub available -> auto migrates to hnswlib past 2000.',
    'fanout is the CORPUS-side row count each predicate matches; `leg_cap` is what the store lets',
    'through to fusion (4x the pool). FTS scoring over the match set is FTS5-internal and is NOT',
    'bounded by that cap — only the rows that cross into JS are.',
    'Rows carry an 8 KB hrr_vector, like production, so page/row-width effects are included.',
  ],
}
console.log('\n' + JSON.stringify(report.note, null, 2))
if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
