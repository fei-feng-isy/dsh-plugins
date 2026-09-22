/**
 * Index A/B harness — the evidence behind `docs/PERFORMANCE_REVIEW.md` §5 (and §4.11 / §4.7).
 *
 * Every index recommendation in the review was measured before/after here, and one of them was
 * FALSIFIED by it: adding only a PARTIAL index `(fact_b, fact_a) WHERE resolved = 0` does not
 * help, because the shipped predicates include `OR resolved_by = 'verdict'`, which does not
 * imply `resolved = 0`, so the planner cannot use a partial index. This script keeps that
 * counter-example executable instead of leaving it as a sentence in a document.
 *
 * It measures four things on synthetic data, each before and after the proposed index:
 *   1. `facts.page()` — `ORDER BY created_at DESC LIMIT ? OFFSET ?` with no usable index, the
 *      cost behind a slow `mem_admin list` (a temp b-tree over every active row).
 *   2. `contradiction_log` lookups — the `(fact_a = ? OR fact_b = ?)` shape used by
 *      `resolveForFact` / `openConflictsFor`, and the full-table suppression read issued on
 *      EVERY write.
 *   3. The DELETE plan's foreign-key subprogram — it shows the per-row cascade scans and the
 *      `supersedes_id` NO ACTION check, which is why a non-partial index pays off twice.
 *   4. The falsified partial-index variant, so the negative result stays reproducible.
 *
 * Usage:
 *   node scripts/bench-indexes.mjs [--facts 100000] [--pairs 100000] [--blob 0]
 *                                  [--victim 1213] [--json out.json]
 *
 * `--pairs` must be <= `--facts` (the log has FKs into `facts`). `--blob` writes an N-byte
 * `hrr_vector` per row to reproduce row-width effects — the review's 124 ms `admin list` figure
 * needed 8 KB rows, but 100k such rows is ~800 MB, so use fewer facts with `--blob 8192`.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { openMemoryStore } = await import(join(repo, 'packages/core/lib/db/conn.js'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const FACTS = Number(arg('facts', 100000))
const PAIRS = Math.min(Number(arg('pairs', 100000)), FACTS)
const BLOB = Number(arg('blob', 0))
const VICTIM = Number(arg('victim', 1213))
const jsonOut = arg('json', null)

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b)
  return round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))], 3)
}
const timeN = (fn, n = 7) => {
  const out = []
  for (let i = 0; i < n; i++) {
    const s = performance.now()
    fn(i)
    out.push(performance.now() - s)
  }
  return pct(out, 50)
}
const plan = (db, sql, ...params) =>
  db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map((r) => r.detail).join(' | ')

const home = mkdtempSync(join(tmpdir(), 'avantf-bench-indexes-'))
const { db } = openMemoryStore(join(home, 'memory.db'))

// The shipped DDL now CONTAINS the fixes this script measures, so the baseline has to rebuild the
// pre-fix schema explicitly: without this, "before" would already be the fixed state and every
// ratio below would read 1x. (`idx_facts_idle` also comes back: it existed before step 4, and its
// removal is measured in the `touchUsage` arm.)
db.exec('DROP INDEX IF EXISTS idx_facts_created')
db.exec('DROP INDEX IF EXISTS idx_contradict_fact_a')
db.exec('DROP INDEX IF EXISTS idx_contradict_fact_b')
db.exec('CREATE INDEX IF NOT EXISTS idx_facts_idle ON facts(status, pinned, last_retrieved_at)')

// ── seed ─────────────────────────────────────────────────────────────────────
const blob = BLOB > 0 ? Buffer.alloc(BLOB, 7) : null
const insFact = db.prepare(
  'INSERT INTO facts (content, category, settle_clock, status, hrr_vector, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
)
let t0 = performance.now()
db.transaction(() => {
  for (let i = 0; i < FACTS; i++) {
    const created = new Date(Date.now() - (i % 120) * 86400000).toISOString().replace('T', ' ').slice(0, 19)
    insFact.run(`条目 ${i} 性能优化记录`, 'bench', 0, 'active', blob, created, created)
  }
})()
const seedFactsMs = round(performance.now() - t0)
const seedPairs = () => {
  db.exec('DELETE FROM contradiction_log')
  const ins = db.prepare('INSERT INTO contradiction_log (fact_a, fact_b, score, resolved, resolved_by) VALUES (?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < PAIRS; i++) {
      const verdict = i % 20 === 0 // 5% adjudicated: keeps the `OR resolved_by='verdict'` branch non-empty
      ins.run(i + 1, ((i * 7 + 13) % FACTS) + 1, 0.7 + (i % 100) / 1000, verdict ? 1 : 0, verdict ? 'verdict' : null)
    }
  })()
}
t0 = performance.now()
seedPairs()
const seedPairsMs = round(performance.now() - t0)
console.log(`seeded facts=${FACTS} (blob=${BLOB}B, ${seedFactsMs}ms) pairs=${PAIRS} (${seedPairsMs}ms)\n`)

// ── 1. facts.page(): ORDER BY created_at DESC ────────────────────────────────
const PAGE = 'SELECT * FROM facts WHERE status = ? AND (? IS NULL OR category = ?) ORDER BY created_at DESC LIMIT ? OFFSET ?'
const deepOffset = Math.min(20000, Math.max(0, FACTS - 51))
const pagePart = {
  before: {
    head_p50_ms: timeN(() => db.prepare(PAGE).all('active', null, null, 50, 0)),
    deep_p50_ms: timeN(() => db.prepare(PAGE).all('active', null, null, 50, deepOffset)),
    plan: plan(db, PAGE, 'active', null, null, 50, 0),
  },
}
t0 = performance.now()
db.exec('CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(status, created_at DESC)')
pagePart.index_create_ms = round(performance.now() - t0)
pagePart.after = {
  head_p50_ms: timeN(() => db.prepare(PAGE).all('active', null, null, 50, 0)),
  deep_p50_ms: timeN(() => db.prepare(PAGE).all('active', null, null, 50, deepOffset)),
  plan: plan(db, PAGE, 'active', null, null, 50, 0),
}

// ── 2. contradiction_log lookups ─────────────────────────────────────────────
const SUPPRESS_ALL = "SELECT fact_a, fact_b FROM contradiction_log WHERE resolved = 0 OR resolved_by = 'verdict'"
const SUPPRESS_TARGETED =
  "SELECT fact_a, fact_b FROM contradiction_log WHERE fact_a = ? AND (resolved = 0 OR resolved_by = 'verdict')"
  + " UNION SELECT fact_a, fact_b FROM contradiction_log WHERE fact_b = ? AND (resolved = 0 OR resolved_by = 'verdict')"
const RESOLVE_LOOKUP = 'SELECT count(*) AS n FROM contradiction_log WHERE resolved = 0 AND (fact_a = ? OR fact_b = ?)'
const RESOLVE_UPDATE = 'UPDATE contradiction_log SET resolved = 1 WHERE resolved = 0 AND (fact_a = ? OR fact_b = ?)'
const OPEN_CONFLICTS =
  "SELECT c.id, c.fact_a, c.fact_b, c.score FROM contradiction_log c"
  + " WHERE (c.fact_a = ? OR c.fact_b = ?) AND (c.resolved = 0 OR c.resolved_by = 'verdict')"
  + ' ORDER BY c.score DESC, c.id ASC LIMIT 20'
const restoreOpen = () =>
  db.prepare("UPDATE contradiction_log SET resolved = 0 WHERE resolved = 1 AND resolved_by IS NULL AND (fact_a = ? OR fact_b = ?)").run(VICTIM, VICTIM)
const updateWithRestore = () => {
  db.prepare(RESOLVE_UPDATE).run(VICTIM, VICTIM)
  restoreOpen()
}

const measureLog = () => ({
  suppress_all_p50_ms: timeN(() => db.prepare(SUPPRESS_ALL).all()),
  suppress_all_rows: db.prepare(SUPPRESS_ALL).all().length,
  suppress_targeted_p50_ms: timeN(() => db.prepare(SUPPRESS_TARGETED).all(VICTIM, VICTIM)),
  resolve_lookup_p50_ms: timeN(() => db.prepare(RESOLVE_LOOKUP).get(VICTIM, VICTIM)),
  resolve_lookup_matched_rows: db.prepare(RESOLVE_LOOKUP).get(VICTIM, VICTIM).n,
  resolve_update_p50_ms: timeN(updateWithRestore, 5),
  open_conflicts_p50_ms: timeN(() => db.prepare(OPEN_CONFLICTS).all(VICTIM, VICTIM)),
  plans: {
    suppress_all: plan(db, SUPPRESS_ALL),
    resolve_lookup: plan(db, RESOLVE_LOOKUP, VICTIM, VICTIM),
    open_conflicts: plan(db, OPEN_CONFLICTS, VICTIM, VICTIM),
  },
})

const logPart = { as_shipped: measureLog() }
// the DELETE's foreign-key subprogram: the per-row cascade scans + the supersedes NO ACTION check
logPart.delete_plan = db
  .prepare("EXPLAIN QUERY PLAN DELETE FROM facts WHERE status='archived' AND pinned=0")
  .all()
  .map((r) => r.detail)

db.exec('CREATE INDEX IF NOT EXISTS idx_contradict_fact_a ON contradiction_log(fact_a); CREATE INDEX IF NOT EXISTS idx_contradict_fact_b ON contradiction_log(fact_b)')
db.exec('ANALYZE')
logPart.with_nonpartial_both = measureLog()

// the FALSIFIED variant: partial-only, which the planner cannot use for the OR-with-verdict shape
db.exec('DROP INDEX idx_contradict_fact_a; DROP INDEX idx_contradict_fact_b')
db.exec('CREATE INDEX IF NOT EXISTS bench_cl_open_b ON contradiction_log(fact_b, fact_a) WHERE resolved = 0')
db.exec('ANALYZE')
logPart.with_partial_fact_b_only = measureLog()

// ── 5. the dead index: `touchUsage` runs on EVERY recall, and this one only taxed it ────────
const TOUCH = `UPDATE facts SET retrieval_count = retrieval_count + 1, last_retrieved_at = ?
                WHERE fact_id IN (${Array.from({ length: 10 }, () => '?').join(',')})`
const touchIds = Array.from({ length: 10 }, (_, i) => i + 1)
const touch = () => db.prepare(TOUCH).run('2026-01-01 00:00:00', ...touchIds)
const touchWith = timeN(touch, 30)
db.exec('DROP INDEX IF EXISTS idx_facts_idle')
const touchWithout = timeN(touch, 30)
const deadIndex = {
  touchUsage_with_idx_us: round(touchWith * 1000, 2),
  touchUsage_without_idx_us: round(touchWithout * 1000, 2),
  ratio: touchWithout > 0 ? round(touchWith / touchWithout, 2) : null,
  idle_predicate_plan: plan(db, "SELECT fact_id FROM facts WHERE status='active' AND pinned=0 AND julianday('now') - julianday(COALESCE(last_retrieved_at, created_at)) > 365"),
}

const report = {
  measured_at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: (await import('node:os')).cpus()[0]?.model ?? 'unknown',
  facts: FACTS,
  pairs: PAIRS,
  blob_bytes: BLOB,
  victim: VICTIM,
  facts_page: pagePart,
  contradiction_log: logPart,
  dead_index: deadIndex,
  db_bytes: statSync(join(home, 'memory.db')).size,
  note: [
    'All three index candidates are measured in ONE database, before/after each CREATE INDEX.',
    'with_partial_fact_b_only is the counter-example: plans stay SCAN and timings do not improve,',
    'because `resolved = 0 OR resolved_by = ?` does not imply the partial predicate `resolved = 0`.',
    'delete_plan is printed, not executed: the shipped schema cannot delete a row another row',
    'references through `supersedes_id` (NO ACTION) — that defect is guarded by a unit test.',
    'Every statement here is prepared per call, like the DAOs, so its compile cost is included.',
    'dead_index measures the touchUsage UPDATE with and without idx_facts_idle — that index could',
    'never serve a query (the idle predicate wraps the column in COALESCE + julianday) and only',
    'cost maintenance on every recall. The plan line shows which index the predicate really uses.',
  ],
}

console.log('\n── facts.page (ORDER BY created_at DESC, limit 50) ──')
console.log(JSON.stringify(pagePart, null, 2))
console.log('\n── contradiction_log ──')
console.log(JSON.stringify(logPart, null, 2))
console.log('\n── dead index (idx_facts_idle) ──')
console.log(JSON.stringify(deadIndex, null, 2))
console.log('\n' + JSON.stringify(report.note, null, 2))
if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
db.close()
rmSync(home, { recursive: true, force: true })
