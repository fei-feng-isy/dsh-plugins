/**
 * Shared scaffolding for the "test before you change" measurement campaign
 * (`mem/docs/spikes/IMPROVEMENT_SPIKE_BRIEF.md`).
 *
 * WHAT THIS IS. Every spike benchmark needs the same four things, and getting any of them wrong
 * makes the numbers meaningless, so they live here once:
 *
 *   1. a READ-ONLY view of the live store — `VACUUM INTO` a temp snapshot and never touch
 *      `~/.avantf/**` (see {@link snapshotDb}); the live configs are never read either, every
 *      runtime gets a fresh temp `dataHome` with a script-written `configs/common.yaml`;
 *   2. the real corpus metadata (ids / lengths / signals) with NO text ever printed
 *      ({@link loadActiveTexts} returns the text only because the FTS coverage arm must grade it;
 *      every writer in this directory emits ids, lengths and scores only);
 *   3. a REPRODUCTION of the three production legs plus `fuse`, so an arm can change exactly one
 *      layer while everything else stays byte-identical — and an IDENTITY ASSERTION that the
 *      reproduction returns the SAME order as the product (`rt.recall`) on the same snapshot;
 *   4. the two shared query networks: the 20-query real set (RERANK_AB_REAL.md §1) and the frozen
 *      41-query `eval_zh_relations.jsonl` driver.
 *
 * WHY THE REPRODUCTION IS SOUND (and where it could break). The legs are rebuilt in the script by
 * calling the PRODUCTION leg methods on the runtime instance (`MemoryStore.ftsPath` /
 * `semanticPath` / `jaccardPath`) — those are TypeScript-`private` only at compile time, so at
 * runtime they are reachable. That keeps the SQL, the tokenizer, the cap and the entity-anchor
 * preparation identical to production while leaving the SCORE MAP open for an arm to replace.
 * `fuse` / `applyScoreFloor` / `applyTermFloor` / `resolveFloors` are imported from the built lib,
 * i.e. they are the production definitions, not copies. The script drives the pass itself
 * (augmentation, per-variant floor clamp, union, fuse, live filter, slice, budget) so the
 * orchestration is visible and an arm can be inserted; the identity assertion proves the
 * orchestration it drives agrees with `hybridSearch` on every query measured.
 *
 * A caveat that is stated rather than hidden: the identity assertion pins the ORDER of the returned
 * `ref_id`s and their fused scores. It does not re-derive `dropped_by_floor`, `weights` or the
 * budgeted text — an arm that changed those would not be covered by the assertion.
 *
 * @module scripts/spikes/bench-spike-lib
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const lib = (p) => join(REPO, 'packages', p)
export const FIXTURE = join(REPO, 'packages/core/test/fixtures/eval_zh_relations.jsonl')
export const DEFAULT_MODEL = 'Xenova/bge-base-zh-v1.5'
export const DEFAULT_DIM = 768
export const DEFAULT_DB = join(homedir(), '.avantf/memory/memory.db')
export const DEFAULT_CACHE = process.env.AVANTF_MEM_MODEL_CACHE ?? join(homedir(), '.avantf/env/models')
export const QUIET = { info() {}, warn() {}, error() {}, debug() {} }
export const round4 = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v)
/** Machine load at measurement time — every raw JSON records it (absolute ms are host-noisy). */
export const loadavg = () => require('node:os').loadavg()

// ─── shared libs (the production definitions, imported not copied) ─────────────
export const { buildRuntime } = await import(lib('core/lib/index.js'))
export const { hybridSearch, applyOutputBudget, legCapFor } = await import(lib('core/lib/store/hybrid.js'))
export const { fuse, scaleByMax } = await import(lib('retrieval-core/lib/fusion.js'))
export const { fitToTokenBudget } = await import(lib('retrieval-core/lib/budget.js'))
export const { estimateTokens, truncateToTokens, CJK_TOKENS_PER_CHAR } = await import(lib('retrieval-core/lib/text_budget.js'))
export const { applyScoreFloor, applyTermFloor, resolveFloors, countMatchedTerms, totalFloorDrops, effectiveTermFloor } =
  await import(lib('core/lib/store/floors.js'))
export const { gradedTerms, relevanceTerms, substringTerms } = await import(lib('core/lib/store/lexical.js'))
export const { selfQueryRewrite } = await import(lib('core/lib/store/self_query.js'))
export const { selectAnchors, anchoredOverlap, ENTITY_UNION_CAP, anchorCeiling } = await import(lib('core/lib/store/entity_leg.js'))
export const { extractEntities } = await import(lib('core/lib/entities/extract.js'))
export const { loadEvalCases } = await import(lib('core/lib/eval/loader.js'))
export const { buildFtsQuery } = await import(lib('core/lib/db/tokenizer.js'))
export const { evaluateCases } = await import(lib('core/lib/eval/runner.js'))
export const { LocalBgeBackend } = await import(lib('retrieval-core/lib/adapters/local_bge.js'))
export const { DEGRADED_WEIGHTS } = await import(lib('contract/lib/index.js'))

// ─── argv helpers ──────────────────────────────────────────────────────────────
export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
export const hasFlag = (name) => process.argv.includes(`--${name}`)

export function writeJson(path, obj) {
  const abs = resolve(path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, JSON.stringify(obj, null, 2))
  console.log(`\nwrote ${abs}`)
  return abs
}

// ─── the snapshot + read-only corpus view ──────────────────────────────────────
/** `VACUUM INTO` a consistent copy of `src`; the source connection is read-only. */
export function snapshotDb(src, dst) {
  rmSync(dst, { force: true })
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(src, { readOnly: true })
  try {
    db.exec(`VACUUM INTO '${dst.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
  return dst
}

export function openReadOnly(path) {
  const { DatabaseSync } = require('node:sqlite')
  return new DatabaseSync(path, { readOnly: true })
}

/**
 * Open a SNAPSHOT COPY read-write (round 2: the schema-simulation cards ALTER a copy, never the
 * live file). The caller is responsible for having `VACUUM INTO`-ed a copy first — this helper
 * exists so the round-2 scripts have one place that says "writes go to the copy".
 */
export function openWritable(path) {
  const { DatabaseSync } = require('node:sqlite')
  return new DatabaseSync(path)
}

/**
 * A semantic backend that is present but UNAVAILABLE — the "semantic leg down" network (R2-1).
 *
 * `isAvailable() === false` is what makes `hybridSearch` choose `DEGRADED_WEIGHTS` and makes
 * `searchLegs` return an EMPTY semantic leg without ever calling `encode`. `dim` must match the
 * configured `semantic.dim` or `buildRuntime` refuses the override (measured: 768).
 */
export function degradedSemantic(dim = DEFAULT_DIM) {
  return {
    name: 'spike-degraded-semantic',
    dim,
    isAvailable: () => false,
    async encode() {
      throw new Error('spike: degraded semantic backend must never be asked to encode')
    },
    async warmUp() {},
    ensureWarm() {},
  }
}

/** Current resident set size in MiB (R2-7), from the process itself. */
export function rssMiB() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10
}

/**
 * The active corpus, text INCLUDED — the coverage arm has to grade the text, so it has to be read.
 * Nothing in this directory prints it: every table/JSON emitter writes ids, lengths and scores.
 */
export function loadActiveTexts(dbPath) {
  const db = openReadOnly(dbPath)
  try {
    const rows = db
      .prepare(
        `select fact_id id, content, length(content) len, category, trust_score trust, pinned,
                created_at created, updated_at updated, embedding_model model
           from facts where status = 'active' order by fact_id`,
      )
      .all()
    const texts = new Map()
    const meta = new Map()
    for (const r of rows) {
      texts.set(r.id, String(r.content))
      meta.set(r.id, {
        id: r.id,
        len: r.len,
        category: r.category,
        trust: r.trust,
        pinned: r.pinned === 1,
        created: r.created,
        updated: r.updated,
        model: r.model,
      })
    }
    return { texts, meta, ids: rows.map((r) => r.id) }
  } finally {
    db.close()
  }
}

export function goldByEntity(dbPath, entity) {
  const db = openReadOnly(dbPath)
  try {
    return db
      .prepare(
        `select f.fact_id id from facts f join fact_entities fe on fe.fact_id = f.fact_id
           join entities e on e.entity_id = fe.entity_id
          where f.status = 'active' and e.name = ? order by f.fact_id`,
      )
      .all(entity)
      .map((r) => r.id)
  } finally {
    db.close()
  }
}

// ─── embedder + runtime ────────────────────────────────────────────────────────
export async function warmEmbedder({ model = DEFAULT_MODEL, dim = DEFAULT_DIM, cacheDir = DEFAULT_CACHE } = {}) {
  const backend = new LocalBgeBackend(model, dim, { cacheDir, autoDownload: false })
  await backend.warmUp()
  if (!backend.isAvailable()) {
    throw new Error(`spike: embedder ${model} unavailable in ${cacheDir} — nothing measured.`)
  }
  return backend
}

/**
 * A runtime over one snapshot copy, with its own temp `dataHome`. `trackRuntime` collects the temp
 * dirs so the caller can clean up; the live store is never opened read-write.
 */
export function newRuntime({ snapPath, model = DEFAULT_MODEL, dim = DEFAULT_DIM, semantic, track }) {
  const home = mkdtempSync(join(tmpdir(), 'avantf-spike-home-'))
  mkdirSync(join(home, 'configs'), { recursive: true })
  writeFileSync(join(home, 'configs/common.yaml'), `semantic:\n  local_model: ${model}\n  dim: ${dim}\n  auto_download: false\n`)
  const rt = buildRuntime({ dataHome: home, memoryDbPath: snapPath, semantic, logger: QUIET })
  track?.runtimes.push(rt)
  track?.dirs.push(home)
  return rt
}

// ─── the 20-query real set (RERANK_AB_REAL.md §1) ──────────────────────────────
export const REAL_QUERIES = [
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

/** Fill each entity2 query's gold from the snapshot (entity bag membership), like the threshold bench. */
export function resolveRealGolds(snapPath, { texts }) {
  const out = REAL_QUERIES.map((q) => ({ ...q }))
  for (const q of out) {
    if (q.kind === 'entity2') q.gold = goldByEntity(snapPath, q.entity)
    if (q.gold) {
      for (const id of q.gold) {
        if (!texts.has(id)) throw new Error(`spike: gold id ${id} for ${q.id} is not active — fix the query set.`)
      }
    }
  }
  return out
}

// ─── the script-side pass (reproduction + arm hooks) ───────────────────────────
/**
 * One variant's RAW legs, straight from the production store methods.
 *
 * The entity half repeats what `MemoryStore.searchLegs` does before `jaccardPath` (extract → anchor
 * filter → candidate SQL), because that preparation is part of the leg's candidate legality and an
 * arm must not change it by accident.
 */
export async function rawLegs(rt, query, { category, overFetch, legCap }) {
  const memory = rt.memory
  const qEntities = Array.from(new Set((await extractEntities(query)).map((e) => e.name)))
  const anchors = qEntities.length > 0
    ? selectAnchors(qEntities, memory.entities.activeDocFrequency(qEntities), memory.facts.countActive())
    : []
  const candidates = anchors.length > 0
    ? memory.entities.candidateFactsForAnyEntity(anchors, category, legCap, qEntities.length, ENTITY_UNION_CAP)
    : []
  // Mirror `searchLegs`: an unavailable backend returns an EMPTY semantic leg and is never asked to
  // encode (round-2 addition — round-1 callers always had an available backend, so this is a no-op
  // for them).
  const semantic = memory.semantic.isAvailable()
    ? await memory.semanticPath(query, category, overFetch)
    : new Map()
  const jaccard = memory.jaccardPath(anchors, qEntities.length, candidates)
  const fts = memory.ftsPath(query, category, legCap)
  return { semantic, jaccard, fts, qEntities, anchors, candidates }
}

/** Union two runs' leg arrays by INDEX with `max` — the 方案 A augmentation rule from hybrid.ts. */
export function unionLegs(runs) {
  const [first, ...rest] = runs
  const out = (first ?? []).map((leg) => ({ ...leg, scores: new Map(leg.scores) }))
  for (const run of rest) {
    run.forEach((leg, index) => {
      const current = out[index]
      if (current === undefined) {
        out.push({ ...leg, scores: new Map(leg.scores) })
        return
      }
      for (const [id, score] of leg.scores) {
        const previous = current.scores.get(id)
        if (previous === undefined || score > previous) current.scores.set(id, score)
      }
      if (leg.leg !== undefined) current.leg = leg.leg
      if (leg.droppedByFloor !== undefined) current.droppedByFloor = Math.max(current.droppedByFloor ?? 0, leg.droppedByFloor)
    })
  }
  return out
}

/** The leg index of the FTS leg in `searchLegs`' array (semantic, jaccard, fts[, hrr]). */
export const FTS_LEG_INDEX = 2

/**
 * Run ONE script-side pass for `query` and return the fully processed ids + the pieces an arm or a
 * report may want.
 *
 * `arm` (all optional, all default = production):
 *   - `arm.fts(raw, meta) -> Map<id, score>` : replace the RAW FTS scores;
 *   - `arm.jaccard(raw, meta) -> Map<id, score>` : replace the RAW entity-leg scores;
 *   - `arm.appendLegs(meta) -> [{weight, scores, leg}]` : add legs (same index on every variant);
 *   - `arm.fuse(hits, ctx) -> hits` : transform the fused pool (already sorted, length <= overFetch);
 *   - `arm.budget(hits, {config, maxTokens, texts}) -> kept[]` : replace `applyOutputBudget`.
 * `meta` carries `{variant, terms, texts, overFetch, legCap, raw, qEntities, anchors, candidates}` so
 * an arm can re-query the snapshot without re-deriving the production prep.
 */
export async function runScript(rt, query, opts) {
  const { limit = 5, maxTokens = 0, floors: profile, arm = {}, track = null, category } = opts
  const config = rt.memory.config
  const retriever = config.retriever
  const semAvail = rt.memory.semantic.isAvailable()
  // Round-2 extension: `arm.weights` lets a card change the WEIGHT vector (e.g. semantic 0 /
  // fts 1) without touching the legs. Default = production's own resolution, so every round-1
  // caller is byte-identical.
  const weights = arm.weights ?? (semAvail
    ? { semantic: retriever.weight_semantic, fts: retriever.weight_fts, jaccard: retriever.weight_jaccard }
    : DEGRADED_WEIGHTS)
  const overFetch = Math.max(limit, opts.overFetch ?? limit * (retriever.over_fetch_factor || 5))
  const legCap = opts.legCap ?? legCapFor(config, overFetch)
  const original = query.trim()
  const augment = selfQueryRewrite(original)
  const variants = augment !== undefined && augment !== original ? [original, augment] : [original]
  const texts = track?.texts ?? null

  /** One full pass under ONE floor profile — the script's copy of `runPass` in hybrid.ts. */
  const runPass = async (passProfile, relaxLegs) => {
    const runs = []
    const perVariant = []
    for (const variant of variants) {
      const raw = await rawLegs(rt, variant, { category, overFetch, legCap })
      const termCount = gradedTerms(variant).length
      const own = resolveFloors(retriever, semAvail, { profile: passProfile, termCount, ...(relaxLegs === undefined ? {} : { relaxLegs }) })
      if (variant === original) {
        // The reported/envelope floors are the original query's; every variant run is held to at
        // least that bar (hybrid.ts: the clamp is one-directional).
        runPass.reported = own
      }
      const reported = runPass.reported
      const variantFloors = { ...own, fts: Math.max(reported.fts, own.fts) }
      const meta = {
        variant,
        terms: gradedTerms(variant),
        texts,
        overFetch,
        legCap,
        raw,
        qEntities: raw.qEntities,
        anchors: raw.anchors,
        candidates: raw.candidates,
      }
      const jaccardRaw = arm.jaccard ? arm.jaccard(raw.jaccard, meta) : raw.jaccard
      const semRaw = arm.semantic ? arm.semantic(raw.semantic, meta) : raw.semantic
      const sem = applyScoreFloor(semRaw, variantFloors.semantic)
      const jac = applyScoreFloor(jaccardRaw, variantFloors.jaccard)
      const armRaw = arm.fts ? arm.fts(raw.fts, meta) : raw.fts
      const fts = applyTermFloor(armRaw, texts, variant, variantFloors.fts)
      const legs = [
        { weight: weights.semantic, scores: sem.scores, leg: 'semantic', droppedByFloor: sem.dropped },
        { weight: weights.jaccard, scores: jac.scores, leg: 'jaccard', droppedByFloor: jac.dropped },
        { weight: weights.fts, scores: fts.scores, leg: 'fts', droppedByFloor: fts.dropped },
      ]
      // Extra legs an arm wants to add (same INDEX on every variant run, so the augmentation union
      // still merges like-with-like). The arm owns the weight.
      if (arm.appendLegs) {
        for (const extra of arm.appendLegs(meta) ?? []) {
          legs.push({ weight: extra.weight, scores: extra.scores, leg: extra.leg, droppedByFloor: extra.droppedByFloor ?? 0 })
        }
      }
      runs.push(legs)
      perVariant.push({ variant, termCount, floors: variantFloors, raw, legs, meta })
    }
    const legs = variants.length === 1 ? runs[0] : unionLegs(runs)
    let pool = fuse(legs.map((l) => ({ weight: l.weight, scores: l.scores })), overFetch)
    if (arm.fuse) pool = arm.fuse(pool, { overFetch, limit, passProfile, legs, weights }) ?? pool
    const live = texts === null ? pool : pool.filter((h) => texts.has(h.id))
    const ranked = live.slice(0, limit)
    // The budget operates on the caller-facing hit shape (`text` + `score`), exactly as
    // `deps.hits()` hands it to `applyOutputBudget` in production.
    const textOf = texts ?? rt.memory.loadTexts(ranked.map((h) => h.id))
    const hitObjs = ranked.map((h) => ({ id: h.id, ref_id: h.id, score: h.score, text: textOf.get(h.id) ?? '' }))
    const budgeted = arm.budget
      ? arm.budget(hitObjs, { config, maxTokens, texts: textOf })
      : applyOutputBudget(config, hitObjs, maxTokens).kept
    const dropped = { semantic: 0, fts: 0, jaccard: 0, hrr: 0 }
    for (const leg of legs) if (leg.leg !== undefined && leg.droppedByFloor !== undefined) dropped[leg.leg] += leg.droppedByFloor
    return {
      ids: budgeted.map((h) => h.ref_id ?? h.id),
      pool,
      ranked,
      hitObjs,
      budgeted,
      used_tokens: budgeted.reduce((n, h) => n + estimateTokens(h.text ?? ''), 0),
      legs,
      perVariant,
      floors: runPass.reported,
      dropped,
    }
  }

  // The retry rule (DESIGN §20.19), copied from hybridSearch: an explicit profile suppresses it.
  let chosen = await runPass(profile === 'loose' ? 'loose' : 'strict', opts.relaxLegs)
  let relaxed = false
  if (profile === undefined && chosen.ids.length === 0 && totalFloorDrops(chosen.dropped) > 0) {
    const relaxing = ['semantic', 'fts', 'jaccard'].filter((l) => chosen.dropped[l] > 0)
    const loosened = await runPass('loose', relaxing)
    if (loosened.ids.length > 0) {
      chosen = loosened
      relaxed = true
    }
  }
  return {
    ...chosen,
    scores: chosen.pool.map((h) => ({ id: h.id, score: round4(h.score) })),
    overFetch,
    legCap,
    variants,
    relaxed,
  }
}

/** The product's own answer for the same plan (the identity reference). */
export async function prodResult(rt, query, { limit = 5, maxTokens = 0, floors: profile, category } = {}) {
  return rt.recall({
    action: 'search',
    query,
    limit,
    max_tokens: maxTokens,
    ...(profile === undefined ? {} : { floors: profile }),
    ...(category === undefined ? {} : { category }),
  })
}

export function sameOrder(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * The共同纪律 check: the production arm of the script reproduces `rt.recall` on the same snapshot.
 * Returns a JSON-serializable record; `ok` is what an arm must assert before its numbers count.
 */
export async function identityCheck(rt, query, opts = {}) {
  const prod = await prodResult(rt, query, opts)
  const script = await runScript(rt, query, { ...opts, track: opts.track ?? null, arm: {} })
  const prodIds = prod.hits.map((h) => h.ref_id)
  return {
    query,
    prod_ids: prodIds,
    script_ids: script.ids,
    ok: sameOrder(prodIds, script.ids),
    prod_scores: prod.hits.map((h) => round4(h.score)),
    script_scores: script.ids.map((id) => script.scores.find((s) => s.id === id)?.score ?? null),
  }
}

// ─── frozen 41-query driver ────────────────────────────────────────────────────
/**
 * Build a `retrieve(query, k, setupFacts)` for `evaluateCases`, one arm deep.
 *
 * Memoized per `(arm.name, setupFacts)` exactly like `bench-floors.mjs`: one temp runtime per case,
 * real `remember` + a script pass per query. `arm` is the same shape {@link runScript} takes.
 * `onIdentity` receives each per-query identity record so the caller can assert none failed.
 */
export function makeEvalRetriever({ emb, model = DEFAULT_MODEL, dim = DEFAULT_DIM, arm = {}, track, profile = 'strict', maxTokens = 0, onIdentity, afterPass }) {
  const cache = new Map()
  return async (query, k, setupFacts) => {
    const key = `${arm.name ?? 'base'}\u0000${setupFacts.join('\u0001')}`
    let cached = cache.get(key)
    if (cached === undefined) {
      const work = mkdtempSync(join(tmpdir(), 'avantf-spike-eval-'))
      track.dirs.push(work)
      const snap = join(work, 'memory.db')
      const home = mkdtempSync(join(tmpdir(), 'avantf-spike-evalhome-'))
      track.dirs.push(home)
      mkdirSync(join(home, 'configs'), { recursive: true })
      writeFileSync(join(home, 'configs/common.yaml'), `semantic:\n  local_model: ${model}\n  dim: ${dim}\n  auto_download: false\n`)
      const rt = buildRuntime({ dataHome: home, memoryDbPath: snap, semantic: emb, logger: QUIET })
      track.runtimes.push(rt)
      const ids = []
      for (const f of setupFacts) ids.push((await rt.remember({ action: 'add', content: f })).fact_id)
      const texts = new Map()
      for (let i = 0; i < setupFacts.length; i += 1) texts.set(ids[i], setupFacts[i])
      cached = { rt, ids, texts }
      cache.set(key, cached)
    }
    const record = await identityCheck(cached.rt, query, { limit: k, maxTokens, floors: profile, track: cached })
    onIdentity?.(record)
    const pass = await runScript(cached.rt, query, { limit: k, maxTokens, floors: profile, arm, track: cached })
    afterPass?.(query, pass)
    return pass.ids.map((id) => cached.ids.indexOf(id)).filter((i) => i >= 0).slice(0, k)
  }
}

/** Load the frozen cases once. */
export function frozenCases() {
  return loadEvalCases(FIXTURE)
}

/** Shut down runtimes and remove temp dirs. */
export function teardown(track) {
  for (const rt of track.runtimes ?? []) {
    try {
      rt.shutdown()
    } catch {
      /* a runtime that never opened is fine to skip */
    }
  }
  for (const d of track.dirs ?? []) rmSync(d, { recursive: true, force: true })
}

/** The standard header every spike script prints (ids/sizes only — never text). */
export function banner(name, extra = {}) {
  console.log(`== ${name} ==`)
  for (const [k, v] of Object.entries(extra)) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
  console.log(`  node: ${process.version}  loadavg: ${require('node:os').loadavg().map((x) => x.toFixed(2)).join('/')}`)
}

export { existsSync, mkdtempSync, tmpdir, join, resolve, homedir }
