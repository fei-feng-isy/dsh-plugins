/**
 * Entity + HRR channel value measurement — the evidence behind
 * `docs/ENTITY_TOKENIZER_VALUE.md` (Q2-measure).
 *
 * QUESTION: "would a stronger tokenizer raise memory retrieval hit-rate?"
 * The tokenizer (nodejieba) feeds ONLY entity extraction (`entities/extract.ts`), and the entity
 * product feeds exactly two probes that SHARE one candidate set and one floor: the Jaccard leg and
 * the HRR probe (`store/floors.ts` §`droppedLegs`). The FTS leg (`relevanceTerms`: CJK 3-grams +
 * latin words) and the semantic leg (the embedder) do NOT touch the tokenizer. So the tokenizer's
 * entire possible effect is the value of THAT channel — this script measures that value.
 *
 * THREE SECTIONS (each can be skipped with a flag):
 *   1. `--eval`   frozen 41-query set (`eval_zh_relations.jsonl`), semantic-LIVE with the shipped
 *                 `Xenova/bge-base-zh-v1.5` (768d), channel ON vs OFF.
 *   2. `--real`   the live store's 80 active facts, copied to a temp data home (the original is
 *                 only ever opened read-only), same ON/OFF plus the HRR probe's marginal effect.
 *   3. `--stats`  entity-quality statistics on the live store (read-only, ids/counts only — no
 *                 fact body and no personal entity is printed).
 *
 * The OFF arm is config-only (no code is touched): `weight_jaccard = 0` AND `min_jaccard = 1`.
 * The weight kills the Jaccard/HRR legs' contribution to the fused score; the floor kills every
 * candidate whose Jaccard is below 1 (i.e. all except an exact entity-set match), which is also what
 * empties the HRR probe's shared candidate set. Both are needed: a zero-weight leg still POOLS its
 * candidates into `fuse` (total score 0), and a floor of 1 alone still leaves zero-weight entries.
 *
 * Usage:
 *   node scripts/bench-entity-channel.mjs [--model Xenova/bge-base-zh-v1.5] [--dim 768]
 *                                         [--skip eval|real|stats] [--json out.json]
 *                                         [--real-db ~/.avantf/memory/memory.db]
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
const { tagText, extractEntities } = await import(lib('core/lib/entities/extract.js'))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)
const skip = new Set(String(arg('skip', '')).split(',').filter(Boolean))

const MODEL = arg('model', 'Xenova/bge-base-zh-v1.5')
const DIM = Number(arg('dim', 768))
const CACHE = arg('cache-dir', join(homedir(), '.avantf/env/models'))
const REAL_DB = arg('real-db', join(homedir(), '.avantf/memory/memory.db'))
const jsonOut = arg('json', null)
const FIXTURE = join(repo, 'packages/core/test/fixtures/eval_zh_relations.jsonl')
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const r4 = (v) => Math.round(v * 1e4) / 1e4
const r3 = (v) => Math.round(v * 1e3) / 1e3
const ids = (hits) => hits.map((h) => h.ref_id)
const overlap = (a, b) => a.filter((x) => b.includes(x)).length

/** The channel-OFF configuration (see the module comment). */
const OFF = { weight_jaccard: 0, min_jaccard: 1 }
const withChannel = (rt, on) => {
  const r = rt.config.common.retriever
  r.weight_jaccard = on ? 0.15 : OFF.weight_jaccard
  r.min_jaccard = on ? 0.2 : OFF.min_jaccard
  return r
}

const backend = new LocalBgeBackend(MODEL, DIM, { cacheDir: CACHE, autoDownload: false })
await backend.warmUp()
const semLive = backend.isAvailable()
if (!semLive) {
  console.error(`bench-entity-channel: model ${MODEL} not available in ${CACHE} — nothing measured.`)
  process.exit(1)
}
const weights = { default: null, degraded: null }
const probeHome = mkdtempSync(join(tmpdir(), 'avantf-probe-'))
const baseCfg = buildRuntime({ dataHome: probeHome, memoryDbPath: join(probeHome, 'memory.db'), semantic: backend, logger: quiet })
weights.default = { semantic: baseCfg.config.common.retriever.weight_semantic, fts: baseCfg.config.common.retriever.weight_fts, jaccard: baseCfg.config.common.retriever.weight_jaccard }
weights.floors = { semantic: baseCfg.config.common.retriever.min_semantic_similarity, fts: baseCfg.config.common.retriever.min_fts_terms, jaccard: baseCfg.config.common.retriever.min_jaccard }
const { DEGRADED_WEIGHTS } = await import(lib('contract/lib/types.js'))
weights.degraded = { ...DEGRADED_WEIGHTS }
baseCfg.shutdown()
rmSync(probeHome, { recursive: true, force: true })

/**
 * An UNAVAILABLE 768-dim stub. `isAvailable() === false` puts the engine in the degraded weights
 * (`DEGRADED_WEIGHTS`: semantic 0, fts 0.65, jaccard 0.35) with the semantic leg inert — which is
 * exactly the mode the frozen `eval_zh.spec.ts` asserts for its first 35 queries (vitest pins the
 * model cache away, so no embedder is available there). Measuring the channel in BOTH modes is the
 * point: with the embedder live the entity leg is redundant, with it down the entity leg is one of
 * only two legs left.
 */
const degradedBackend = {
  name: 'bench-unavailable',
  dim: DIM,
  isAvailable: () => false,
  encode: async () => new Float32Array(DIM),
  encodeBatch: async (texts) => texts.map(() => new Float32Array(DIM)),
}

const out = { measured_at: new Date().toISOString(), node: process.version, model: MODEL, dim: DIM, weights, eval: null, real: null, stats: null }

// ─── section 1: frozen 41-query eval set, channel ON vs OFF ──────────────────
if (!skip.has('eval')) {
  const cases = loadEvalCases(FIXTURE)
  const nQueries = cases.flatMap((c) => c.queries).length

  /** Run one arm on one floor profile. Fresh runtimes per arm so reinforcement state matches. */
  const runArm = async (on, profile, sem) => {
    const dirs = []
    const runtimes = []
    let cached = null
    const retrieve = async (query, k, facts) => {
      if (!cached || cached.facts !== facts) {
        const dir = mkdtempSync(join(tmpdir(), 'avantf-entity-'))
        dirs.push(dir)
        mkdirSync(join(dir, 'configs'), { recursive: true })
        writeFileSync(join(dir, 'configs/common.yaml'), `semantic:\n  local_model: ${MODEL}\n  dim: ${DIM}\n  auto_download: false\n`)
        const rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: sem, logger: quiet })
        withChannel(rt, on)
        runtimes.push(rt)
        const factIds = []
        for (const f of facts) factIds.push((await rt.remember({ action: 'add', content: f })).fact_id)
        cached = { facts, rt, factIds }
      }
      const res = await cached.rt.memory.search({
        query,
        limit: k,
        track: false,
        ...(profile === 'strict' ? { floors: 'strict' } : {}),
      })
      return ids(res.hits).map((id) => cached.factIds.indexOf(id)).filter((i) => i >= 0).slice(0, k)
    }
    const report = await evaluateCases(cases, retrieve)
    for (const rt of runtimes) rt.shutdown()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    return report
  }

  const section = { cases: cases.length, queries: nQueries, profiles: {} }
  const modes = { 'semantic-live': backend, 'semantic-degraded': degradedBackend }
  for (const [mode, sem] of Object.entries(modes)) {
    for (const profile of ['production', 'strict']) {
      const on = await runArm(true, profile, sem)
      const off = await runArm(false, profile, sem)
      const row = (rep) => ({
        precision_at_k: r4(rep.summary.mean_precision_at_k),
        recall_at_k: r4(rep.summary.mean_recall_at_k),
        mrr: r4(rep.summary.mrr),
        must_include: r4(rep.summary.must_include_pass_rate),
        must_exclude: r4(rep.summary.must_exclude_pass_rate),
        empty: r4(rep.summary.empty_rate),
      })
      // per-query movement
      const moved = []
      for (let i = 0; i < on.perQuery.length; i++) {
        const a = on.perQuery[i]
        const b = off.perQuery[i]
        if (a.actual_ids.join(',') !== b.actual_ids.join(',')) {
          moved.push({ query: a.query, on: a.actual_ids, off: b.actual_ids, k: a.k, expected: a.expected_ids, must_include: a.must_include_satisfied, must_include_off: b.must_include_satisfied, rank1_on: a.actual_ids[0] === a.expected_ids[0], rank1_off: b.actual_ids[0] === b.expected_ids[0] })
        }
      }
      section.profiles[`${mode}/${profile}`] = { on: row(on), off: row(off), queries_moved: moved.length, queries_losing_top1: moved.filter((m) => m.rank1_on && !m.rank1_off).length, queries_gaining_top1: moved.filter((m) => !m.rank1_on && m.rank1_off).length, moved }
    }
  }
  console.log(`\n=== 1. frozen eval set (${cases.length} cases / ${nQueries} queries) — channel ON vs OFF ===`)
  for (const [profile, r] of Object.entries(section.profiles)) {
    console.log(`profile=${profile}`)
    console.log('  arm\tP@k\tR@k\tMRR\tmust_inc\tmust_exc\tempty')
    console.log(`  ON \t${r.on.precision_at_k}\t${r.on.recall_at_k}\t${r.on.mrr}\t${r.on.must_include}\t${r.on.must_exclude}\t${r.on.empty}`)
    console.log(`  OFF\t${r.off.precision_at_k}\t${r.off.recall_at_k}\t${r.off.mrr}\t${r.off.must_include}\t${r.off.must_exclude}\t${r.off.empty}`)
    console.log(`  sets moved: ${r.queries_moved}  (loses top-1: ${r.queries_losing_top1}, gains top-1: ${r.queries_gaining_top1})`)
    for (const m of r.moved) console.log(`    ${m.query}: ON ${JSON.stringify(m.on)} → OFF ${JSON.stringify(m.off)}  expected ${JSON.stringify(m.expected)}`)
  }
  out.eval = section
}

// ─── shared: a temp copy of the live store ──────────────────────────────────
const copyLiveStore = () => {
  const home = mkdtempSync(join(tmpdir(), 'avantf-real-'))
  mkdirSync(join(home, 'memory'), { recursive: true })
  const dest = join(home, 'memory', 'memory.db')
  copyFileSync(REAL_DB, dest)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(REAL_DB + suffix)) copyFileSync(REAL_DB + suffix, dest + suffix)
  }
  return home
}

// ─── section 2: live store, channel ON vs OFF (+ HRR marginal) ──────────────
if (!skip.has('real')) {
  const SELF = ['我是谁？', '我叫什么', '我的名字', '我是做什么的', '我叫啥', '本人是谁']
  const NON_SELF = ['插件的安装方法', '任务怎么拆分', '知识库在哪里']
  const ENTITY = ['版本号', '插件', '任务', '用户', 'dsh']
  const QUERIES = [...SELF, ...NON_SELF, ...ENTITY]
  const IDENTITY_FACT = 4 // the 9-char identity fact in the live store

  const outModes = {}
  for (const [mode, sem] of Object.entries({ 'semantic-live': backend, 'semantic-degraded': degradedBackend })) {
    const home = copyLiveStore()
    const rt = buildRuntime({ dataHome: home, memoryDbPath: join(home, 'memory', 'memory.db'), semantic: sem, logger: quiet })
    const activeCount = rt.db.prepare("SELECT count(*) c FROM facts WHERE status='active'").get().c

    const search = async (query, on, includeHrr = false) => {
      withChannel(rt, on)
      const res = await rt.memory.search({ query, limit: 5, track: false, floors: 'strict', includeHrr })
      return {
        ids: ids(res.hits),
        scores: res.hits.map((h) => r4(h.score)),
        relaxed: res.relaxed === true,
        floors: res.floors,
        dropped: res.dropped_by_floor,
      }
    }

    const rows = []
    for (const q of QUERIES) {
      const on = await search(q, true)
      const off = await search(q, false)
      rows.push({
        query: q,
        family: SELF.includes(q) ? 'self' : NON_SELF.includes(q) ? 'non_self' : 'entity',
        on_top: on.ids[0] ?? null,
        off_top: off.ids[0] ?? null,
        on_ids: on.ids,
        off_ids: off.ids,
        top1_changed: (on.ids[0] ?? null) !== (off.ids[0] ?? null),
        set_overlap_at5: overlap(on.ids, off.ids),
        on_dropped: on.dropped,
        off_dropped: off.dropped,
        on_relaxed: on.relaxed,
        off_relaxed: off.relaxed,
        top1_is_identity: SELF.includes(q) ? on.ids[0] === IDENTITY_FACT : null,
        top1_is_identity_off: SELF.includes(q) ? off.ids[0] === IDENTITY_FACT : null,
      })
    }

    // HRR probe's MARGINAL effect over the Jaccard leg: `search` (no HRR) vs `probe` (HRR), same
    // candidate set and same weight. Both under the ON config.
    const hrrRows = []
    for (const q of QUERIES) {
      const noHrr = await search(q, true, false)
      const hrr = await search(q, true, true)
      hrrRows.push({ query: q, no_hrr_top: noHrr.ids[0] ?? null, hrr_top: hrr.ids[0] ?? null, top1_changed: (noHrr.ids[0] ?? null) !== (hrr.ids[0] ?? null), overlap_at5: overlap(noHrr.ids, hrr.ids), no_hrr_ids: noHrr.ids, hrr_ids: hrr.ids })
    }

    console.log(`\n=== 2. live store copy (${activeCount} active facts) — ${mode}, channel ON vs OFF, floors:'strict' ===`)
    console.log('query\tfamily\ton_top\toff_top\ttop1_changed\toverlap@5\ton_dropped_jaccard\toff_dropped_jaccard')
    for (const r of rows) {
      console.log(`${r.query}\t${r.family}\t${r.on_top}\t${r.off_top}\t${r.top1_changed}\t${r.set_overlap_at5}\t${r.on_dropped.jaccard}\t${r.off_dropped.jaccard}`)
    }
    const selfHits = rows.filter((r) => r.family === 'self')
    console.log(`self-query top-1 = identity fact: ON ${selfHits.filter((r) => r.top1_is_identity).length}/${selfHits.length}, OFF ${selfHits.filter((r) => r.top1_is_identity_off).length}/${selfHits.length}`)
    console.log(`top-1 changed by killing the channel: ${rows.filter((r) => r.top1_changed).length}/${rows.length};  HRR probe top-1 changed vs no-HRR: ${hrrRows.filter((r) => r.top1_changed).length}/${hrrRows.length}`)
    outModes[mode] = { active: activeCount, identity_fact: IDENTITY_FACT, top1_changed: rows.filter((r) => r.top1_changed).length, rows, hrr: hrrRows }
    rt.shutdown()
    rmSync(home, { recursive: true, force: true })
  }
  out.real = outModes
}

// ─── section 3: entity-quality statistics (live store, read-only) ───────────
if (!skip.has('stats')) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(REAL_DB, { readOnly: true })
  const one = (sql, ...a) => db.prepare(sql).get(...a)
  const all = (sql, ...a) => db.prepare(sql).all(...a)
  const CJK1 = "length(e.name)=1 AND e.name GLOB '[一-龥]*'"

  const facts = all("SELECT fact_id, content FROM facts WHERE status='active'")
  const links = all(`SELECT fe.fact_id AS fact_id, e.name AS name FROM fact_entities fe
                     JOIN entities e ON e.entity_id = fe.entity_id
                     JOIN facts f ON f.fact_id = fe.fact_id WHERE f.status='active'`)
  const bags = new Map()
  for (const r of links) {
    if (!bags.has(r.fact_id)) bags.set(r.fact_id, [])
    bags.get(r.fact_id).push(r.name)
  }
  const widths = facts.map((f) => (bags.get(f.fact_id) ?? []).length).sort((a, b) => a - b)
  const pct = (p) => widths[Math.min(widths.length - 1, Math.ceil((p / 100) * widths.length) - 1)]

  // Raw tokenizer output over the live corpus: what the `length<2` filter in
  // `entitiesFromTokens` discards, split by the tag that would be needed to keep it.
  let tokens = 0
  let dropped = 0
  let droppedCJK = 0
  let droppedNr = 0
  let droppedNsNt = 0
  const splitExamples = new Map() // tag -> count of dropped CJK proper-noun tokens
  for (const f of facts) {
    for (const t of (await tagText(f.content)) ?? []) {
      tokens += 1
      const w = t.word.trim()
      if (!w || [...w].length >= 2) continue
      dropped += 1
      if (/[\u4e00-\u9fff]/.test(w)) {
        droppedCJK += 1
        if (t.tag === 'nr' || t.tag === 'nrt') {
          droppedNr += 1
          splitExamples.set(t.tag, (splitExamples.get(t.tag) ?? 0) + 1)
        }
        if (t.tag === 'ns' || t.tag === 'nt') droppedNsNt += 1
      }
    }
  }

  // Query-side examples: what the tagger does to the probe queries the product actually gets.
  const probes = ['我是谁？', '用户是谁', '我的名字', '李娜', '张伟', '王强', '风控', '缓存', '网关', '数据库']
  const queryTags = []
  for (const q of probes) {
    const tags = (await tagText(q)) ?? []
    const ents = (await extractEntities(q)).map((e) => e.name)
    // entities that share no fact in the live store are "dead ends"; count them by exact name.
    const linked = new Set(links.map((r) => r.name))
    queryTags.push({ query: q, tags: tags.map((t) => `${t.word}:${t.tag}`), entities: ents, dead_entities: ents.filter((e) => !linked.has(e)) })
  }

  const stats = {
    active_facts: facts.length,
    zero_entity_facts: widths.filter((w) => w === 0).length,
    entity_links: links.length,
    distinct_entities: one('SELECT count(*) c FROM entities').c,
    distinct_entities_active: new Set(links.map((r) => r.name)).size,
    entity_width: { min: widths[0], p25: pct(25), median: pct(50), p75: pct(75), max: widths[widths.length - 1], mean: r3(widths.reduce((a, b) => a + b, 0) / widths.length) },
    single_char_entities_all: one("SELECT count(*) c FROM entities WHERE length(name)=1").c,
    single_char_cjk_entities_all: one(`SELECT count(*) c FROM entities e WHERE ${CJK1}`).c,
    single_char_cjk_entity_links_active: one(`SELECT count(*) c FROM fact_entities fe JOIN entities e ON e.entity_id=fe.entity_id JOIN facts f ON f.fact_id=fe.fact_id WHERE f.status='active' AND ${CJK1}`).c,
    tagger_tokens_live: tokens,
    dropped_len1_tokens: dropped,
    dropped_len1_share: r4(dropped / tokens),
    dropped_len1_cjk: droppedCJK,
    dropped_len1_nr: droppedNr,
    dropped_len1_ns_nt: droppedNsNt,
    stored_extraction_method: all('SELECT extraction_method, count(*) c FROM entities GROUP BY extraction_method'),
    stored_entity_type: all('SELECT entity_type, count(*) c FROM entities GROUP BY entity_type'),
    query_tags: queryTags,
  }
  console.log('\n=== 3. entity-quality statistics (live store, read-only) ===')
  console.log(JSON.stringify(stats, null, 1))
  out.stats = stats
  db.close()
}

if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(out, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
