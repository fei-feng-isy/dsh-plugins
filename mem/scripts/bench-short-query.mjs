/**
 * Short-query FTS reachability measurement (task E1) — the evidence behind
 * `docs/SHORT_QUERY_FTS_REACHABILITY.md`.
 *
 * QUESTION: a 2-char CJK query cannot be expressed by the trigram index (`buildFtsQuery` returns
 * `null`), so on a store whose facts carry wide entity bags the entity leg is the ONLY leg — and in
 * the degraded window with `min_jaccard` at its strict value that leg is empty too ("three legs
 * empty"). What does the substring fallback buy, and what does it cost?
 *
 * SECTIONS (each skippable with `--skip`):
 *   1. `--eval`  frozen 41-query set, `semantic-degraded` (deterministic unavailable stub) and
 *                `semantic-live` (the shipped `Xenova/bge-base-zh-v1.5`, 768d), each at
 *                `production` and `strict` floors. The six aggregate metrics plus the per-query
 *                actual ids (so two runs — fallback on/off — can be diffed query by query).
 *   2. `--real`  a temp COPY of the live store (the original is only ever opened read-only),
 *                14 queries: 6 self-referential, 3 non-self-referential, 5 two-char entity-type.
 *                For the 2-char ones the hit criterion is "top-1's text contains the query"
 *                (there is no gold labelling in the live store), which is exactly the lexical
 *                evidence the fallback is supposed to restore.
 *   3. `--unrelated`  a noise guard: unrelated 2-char queries on the live-store copy must stay
 *                EMPTY (or at least must not return a fact that does not contain the term).
 *
 * Usage:
 *   node scripts/bench-short-query.mjs [--model Xenova/bge-base-zh-v1.5] [--dim 768]
 *                                      [--skip eval|real|unrelated] [--json out.json]
 *                                      [--real-db ~/.avantf/memory/memory.db]
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const skip = new Set(String(arg('skip', '')).split(',').filter(Boolean))

const MODEL = arg('model', 'Xenova/bge-base-zh-v1.5')
const DIM = Number(arg('dim', 768))
const CACHE = arg('cache-dir', join(homedir(), '.avantf/env/models'))
const REAL_DB = arg('real-db', join(homedir(), '.avantf/memory/memory.db'))
const jsonOut = arg('json', null)
const FIXTURE = join(repo, 'packages/core/test/fixtures/eval_zh_relations.jsonl')
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const r4 = (v) => Math.round(v * 1e4) / 1e4
const ids = (hits) => hits.map((h) => h.ref_id)

const backend = new LocalBgeBackend(MODEL, DIM, { cacheDir: CACHE, autoDownload: false })
await backend.warmUp()
if (!backend.isAvailable()) {
  console.error(`bench-short-query: model ${MODEL} not available in ${CACHE} — nothing measured.`)
  process.exit(1)
}
/** An UNAVAILABLE 768-dim stub: degraded weights, semantic leg inert. */
const degradedBackend = {
  name: 'bench-unavailable',
  dim: DIM,
  isAvailable: () => false,
  encode: async () => new Float32Array(DIM),
  encodeBatch: async (texts) => texts.map(() => new Float32Array(DIM)),
}
const MODES = { 'semantic-live': backend, 'semantic-degraded': degradedBackend }
const out = { measured_at: new Date().toISOString(), node: process.version, model: MODEL, dim: DIM, eval: {}, real: {}, unrelated: null }

// ─── section 1: frozen 41-query set ─────────────────────────────────────────
if (!skip.has('eval')) {
  const cases = loadEvalCases(FIXTURE)
  const nQueries = cases.flatMap((c) => c.queries).length
  const row = (rep) => ({
    precision_at_k: r4(rep.summary.mean_precision_at_k),
    recall_at_k: r4(rep.summary.mean_recall_at_k),
    mrr: r4(rep.summary.mrr),
    must_include: r4(rep.summary.must_include_pass_rate),
    must_exclude: r4(rep.summary.must_exclude_pass_rate),
    empty: r4(rep.summary.empty_rate),
    n_queries: rep.summary.n_queries,
  })
  for (const [mode, sem] of Object.entries(MODES)) {
    for (const profile of ['production', 'strict']) {
      const dirs = []
      const runtimes = []
      let cached = null
      const retrieve = async (query, k, facts) => {
        if (!cached || cached.facts !== facts) {
          const dir = mkdtempSync(join(tmpdir(), 'avantf-short-'))
          dirs.push(dir)
          mkdirSync(join(dir, 'configs'), { recursive: true })
          writeFileSync(join(dir, 'configs/common.yaml'), `semantic:\n  local_model: ${MODEL}\n  dim: ${DIM}\n  auto_download: false\n`)
          const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: sem, logger: quiet })
          runtimes.push(rt)
          const factIds = []
          for (const f of facts) factIds.push((await rt.remember({ action: 'add', content: f })).fact_id)
          cached = { facts, rt, factIds }
        }
        const res = await cached.rt.memory.search({ query, limit: k, track: false, ...(profile === 'strict' ? { floors: 'strict' } : {}) })
        return ids(res.hits).map((id) => cached.factIds.indexOf(id)).filter((i) => i >= 0).slice(0, k)
      }
      const report = await evaluateCases(cases, retrieve)
      // Per-query detail, printed so a fallback-off run can be diffed against a fallback-on run.
      const perQuery = report.perQuery.map((q) => ({
        query: q.query,
        k: q.k,
        actual: q.actual_ids,
        expected: q.expected_ids,
        rank1: q.actual_ids[0] === q.expected_ids[0],
        empty: q.actual_ids.length === 0,
        must_include: q.must_include_satisfied,
        must_exclude: q.must_exclude_satisfied,
      }))
      out.eval[`${mode}/${profile}`] = { ...row(report), per_query: perQuery }
      for (const rt of runtimes) rt.shutdown()
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
      const r = out.eval[`${mode}/${profile}`]
      const two = perQuery.filter((q) => (q.query.match(/[\u4e00-\u9fff]/g) ?? []).length <= 2)
      console.log(`eval ${mode}/${profile}: P@k=${r.precision_at_k} R@k=${r.recall_at_k} MRR=${r.mrr} mi=${r.must_include} me=${r.must_exclude} empty=${r.empty}`)
      console.log(`  2-char queries: ${two.map((q) => `${q.query}->${JSON.stringify(q.actual)}${q.rank1 ? '✓' : '✗'}${q.empty ? '(empty)' : ''}`).join(' ')}`)
      console.log(`  empty queries: ${perQuery.filter((q) => q.empty).map((q) => q.query).join(' ')}`)
    }
  }
  out.eval_queries = nQueries
}

// ─── shared: a temp copy of the live store ──────────────────────────────────
const copyLiveStore = () => {
  const home = mkdtempSync(join(tmpdir(), 'avantf-short-real-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  const dest = join(home, 'memory', 'memory.db')
  copyFileSync(REAL_DB, dest)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(REAL_DB + suffix)) copyFileSync(REAL_DB + suffix, dest + suffix)
  }
  return home
}

const SELF = ['我是谁？', '我叫什么', '我的名字', '我是做什么的', '我叫啥', '本人是谁']
const NON_SELF = ['插件的安装方法', '任务怎么拆分', '知识库在哪里']
const ENTITY2 = ['冯飞', '阿里', '用户', '插件', '任务']
const UNRELATED2 = ['量子', '三文', '宋朝', '边牧', '诗云']
const IDENTITY_FACTS = [4, 5]

/** Query the whole copied store in one mode; returns per-query rows. */
async function realRun(sem, mode) {
  const home = copyLiveStore()
  const rt = buildRuntime({ dataHome: home, memoryDbPath: join(home, 'memory', 'memory.db'), semantic: sem, logger: quiet })
  const active = rt.db.prepare("SELECT count(*) c FROM facts WHERE status='active'").get().c
  const rows = []
  const run = async (query, family) => {
    const res = await rt.memory.search({ query, limit: 5, track: false, floors: 'strict' })
    const texts = res.hits.map((h) => h.text)
    return {
      query,
      family,
      ids: ids(res.hits),
      top1: res.hits[0]?.ref_id ?? null,
      hits: res.hits.length,
      relaxed: res.relaxed === true,
      floors: res.floors,
      dropped: res.dropped_by_floor,
      // For 2-char lexical queries: does the top-1 text actually carry the term?
      top1_contains: texts.length > 0 ? texts[0].includes(query) : null,
      any_contains: texts.some((t) => t.includes(query)),
      top1_is_identity: family === 'self' ? (res.hits[0]?.ref_id != null && IDENTITY_FACTS.includes(res.hits[0].ref_id)) : null,
    }
  }
  for (const q of [...SELF, ...NON_SELF, ...ENTITY2]) rows.push(await run(q, SELF.includes(q) ? 'self' : NON_SELF.includes(q) ? 'non_self' : 'entity2'))
  const unrelated = []
  if (!skip.has('unrelated')) for (const q of UNRELATED2) unrelated.push(await run(q, 'unrelated2'))
  rt.shutdown()
  rmSync(home, { recursive: true, force: true })
  const self = rows.filter((r) => r.family === 'self')
  const ent = rows.filter((r) => r.family === 'entity2')
  const summary = {
    active,
    self_top1_identity: `${self.filter((r) => r.top1_is_identity).length}/${self.length}`,
    entity2_top1_contains: `${ent.filter((r) => r.top1_contains === true).length}/${ent.length}`,
    entity2_nonempty: `${ent.filter((r) => r.hits > 0).length}/${ent.length}`,
  }
  console.log(`\n=== real store copy (${active} active facts) — ${mode}, floors:'strict' ===`)
  for (const r of rows) {
    console.log(`${r.query}\t${r.family}\ttop1=${r.top1}\thits=${r.hits}\tcontains=${r.top1_contains}\tdropped=${JSON.stringify(r.dropped)}\tfloors=${JSON.stringify(r.floors)}`)
  }
  console.log(`self top-1 = identity fact: ${summary.self_top1_identity};  2-char top-1 contains the term: ${summary.entity2_top1_contains};  2-char non-empty: ${summary.entity2_nonempty}`)
  if (unrelated.length) {
    console.log(`unrelated 2-char queries (must stay empty): ${unrelated.map((r) => `${r.query}->${JSON.stringify(r.ids)}`).join(' ')}`)
  }
  return { summary, rows, unrelated }
}

// ─── section 2/3: live store copy ───────────────────────────────────────────
if (!skip.has('real')) {
  for (const [mode, sem] of Object.entries(MODES)) {
    const run = await realRun(sem, mode)
    out.real[mode] = run
    if (run.unrelated.length) out.unrelated = out.unrelated ?? {}
    if (run.unrelated.length) out.unrelated[mode] = run.unrelated.map((r) => ({ query: r.query, ids: r.ids, empty: r.hits === 0, any_contains: r.any_contains }))
  }
}

if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(out, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
