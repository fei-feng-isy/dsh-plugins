/**
 * Round-6 shared scaffolding — the RELATION-QUALITY demand-side baseline (P-13).
 *
 * This round asks a different question from rounds 4/5: not "does an improvement help" but
 * "is today's relation surface good enough". It therefore adds three things to the round-4/5
 * boundary and reuses everything else verbatim:
 *
 *   1. a READ-ONLY graph view of one snapshot — the active `triples`, the entity bags
 *      (`fact_entities`), the open contradiction pairs, the `supersedes_id` revision links and
 *      the parseable time expressions. Text is read in-process only to *judge* a triple; the
 *      loaders here never return content to a caller that writes it to the repo.
 *   2. the "leg union" of the three production retrieval legs for one question — the thing a
 *      relation action is compared against when the brief asks whether an action NARROWS the
 *      candidate union (i.e. is implemented as a filter over the union rather than an extra
 *      carrier).
 *   3. an IDENTITY helper for the relation actions: production dispatch (`rt.recall`) vs the
 *      store method it delegates to. Rounds 4/5 asserted script-pass == product on `search`;
 *      the relation actions bypass `hybridSearch`, so their identity assertion is
 *      dispatch == store.
 *
 * PRIVACY: derived strings (questions, entity names, triple text, judgments) go to
 * `/tmp/dsh-r6/` via {@link writeTmp} and are never committed. Repo artifacts are aggregates
 * only and are audited by `bench-r6-9-privacy.mjs` against the round-4 pattern superset.
 *
 * @module scripts/spikes/bench-r6-lib
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as R from './bench-r4-lib.mjs'
import * as L from './bench-spike-lib.mjs'

export const R6_TMP = join(tmpdir(), 'dsh-r6')
/**
 * The database each card snapshots. Defaults to the live store, but `R6_PINNED` lets the whole
 * round measure ONE frozen copy: the live store is written by concurrent sessions, and it grew
 * from 85 to 86 active facts between two of this round's own runs. Set `R6_PINNED` (see
 * `bench-r6-0-pin.mjs`) and every card reports the same corpus.
 */
export const pinSource = () => process.env.R6_PINNED || L.DEFAULT_DB
export const tmpPath = (name) => join(R6_TMP, name)
export function ensureTmp() {
  mkdirSync(R6_TMP, { recursive: true })
  return R6_TMP
}
export function writeTmp(name, obj) {
  ensureTmp()
  const p = tmpPath(name)
  writeFileSync(p, JSON.stringify(obj, null, 1))
  console.log(`  (derived data -> ${p}; never committed)`)
  return p
}
export function readTmp(name) {
  const p = tmpPath(name)
  if (!existsSync(p)) return undefined
  return JSON.parse(readFileSync(p, 'utf8'))
}

// ─── graph view of one snapshot ────────────────────────────────────────────────
/** Active triples with their owning fact id. `{fact_id, subj, pred, obj}`. */
export function activeTriples(db) {
  return db
    .prepare(
      `select t.fact_id, t.subj, t.pred, t.obj from triples t
         join facts f on f.fact_id = t.fact_id and f.status = 'active'`,
    )
    .all()
}

/** All triples (active + archived) — the demand side may need a bridge that was superseded. */
export function allTriples(db) {
  return db.prepare('select fact_id, subj, pred, obj from triples').all()
}

/** `Map<fact_id, Set<entity_name>>` for every fact that has a bag. */
export function entityBags(db) {
  const out = new Map()
  for (const r of db
    .prepare('select fe.fact_id fid, e.name name from fact_entities fe join entities e on e.entity_id = fe.entity_id')
    .all()) {
    if (!out.has(r.fid)) out.set(r.fid, new Set())
    out.get(r.fid).add(r.name)
  }
  return out
}

/** `Set<'min|max'>` of every logged contradiction pair (open or resolved). */
export function contradictionPairs(db) {
  const out = new Set()
  for (const r of db.prepare('select fact_a, fact_b from contradiction_log').all()) {
    const a = Math.min(r.fact_a, r.fact_b)
    const b = Math.max(r.fact_a, r.fact_b)
    out.add(`${a}|${b}`)
  }
  return out
}

/** `Map<fact_id, supersedes_id>` for active facts that carry one. */
export function supersedesLinks(db) {
  const out = new Map()
  for (const r of db.prepare("select fact_id, supersedes_id from facts where status = 'active' and supersedes_id is not null").all()) {
    out.set(r.fact_id, r.supersedes_id)
  }
  return out
}

/** `Map<fact_id, {start,end,rule}>` — the FIRST parseable time expression on each active fact. */
export function factTimeWindows(db, now = new Date()) {
  const out = new Map()
  for (const r of db.prepare("select fact_id id, content, created_at created from facts where status = 'active'").all()) {
    const exprs = R.allTimeExpressions(String(r.content), now)
    if (exprs.length) out.set(r.id, exprs[0])
  }
  return out
}

/** `Map<fact_id, {created, len, status}>` for every fact (both statuses). */
export function factMeta(db) {
  const out = new Map()
  for (const r of db
    .prepare('select fact_id id, length(content) len, status, created_at created, updated_at updated from facts')
    .all()) {
    out.set(r.id, { id: r.id, len: r.len, status: r.status, created: r.created, updated: r.updated })
  }
  return out
}

// ─── leg union + identity for the relation actions ────────────────────────────
/**
 * The union of the three production retrieval legs (semantic + jaccard + fts), RAW (before any
 * floor), for one question. This is the "并集" a relation action is checked against: if the
 * action's own id set is a strict subset of this union it can only ever narrow what hybrid
 * search would have offered.
 */
export async function legUnionIds(rt, query, { category, limit = 10, overFetch } = {}) {
  const over = overFetch ?? Math.max(limit, limit * (rt.memory.config.retriever.over_fetch_factor || 5))
  const legCap = L.legCapFor(rt.memory.config, over)
  const raw = await L.rawLegs(rt, query, { category, overFetch: over, legCap })
  const ids = new Set()
  for (const leg of [raw.semantic, raw.jaccard, raw.fts]) for (const id of leg.keys()) ids.add(id)
  return ids
}

/**
 * Identity assertion for one relation action: production `rt.recall(req)` vs the store method the
 * dispatch case calls. `ok` is what a card must assert before its action numbers count.
 */
export async function actionIdentity(rt, req, storeFn) {
  const prod = await rt.recall(req)
  const direct = await storeFn()
  const ids = (r) => (r?.hits ?? []).map((h) => h.ref_id ?? h.id)
  return {
    action: req.action,
    prod_ids: ids(prod),
    store_ids: ids(direct),
    ok: L.sameOrder(ids(prod), ids(direct)),
  }
}

// ─── text helpers (in-process only) ───────────────────────────────────────────
/** Character 3-grams of a string (the FTS trigram vocabulary shape). */
export function trigrams(s) {
  const out = []
  const clean = String(s).replace(/\s+/g, '')
  for (let i = 0; i + 3 <= clean.length; i += 1) out.push(clean.slice(i, i + 3))
  return out
}

/** Distribution summary (min/p25/median/p75/max/mean) of a numeric array. */
export function dist(values) {
  const v = [...values].sort((a, b) => a - b)
  if (v.length === 0) return { n: 0 }
  const at = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]
  return {
    n: v.length,
    min: v[0],
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: v[v.length - 1],
    mean: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100,
  }
}

/** Histogram of integer counts → `{value: n}`. */
export function histogram(values) {
  const out = {}
  for (const v of values) out[v] = (out[v] ?? 0) + 1
  return out
}

/** Round a ratio to 4 decimals. */
export const ratio = (a, b) => (b === 0 ? null : Math.round((a / b) * 1e4) / 1e4)

export { R, L }
export const {
  banner, arg, hasFlag, writeJson, snapshotDb, openReadOnly, openWritable, loadActiveTexts,
  newRuntime, warmEmbedder, identityCheck, runScript, prodResult, sameOrder, teardown,
  resolveRealGolds, frozenCases, makeEvalRetriever, degradedSemantic, rssMiB,
  REAL_QUERIES, DEFAULT_DB, REPO, lib: libPath, round4, loadavg,
} = L
