import type {
  AdminRequest,
  FloorProfile,
  KbAddRequest,
  KbConflictReport,
  KbRequest,
  QueryRequest,
  RecallRequest,
  RecallResult,
  RememberRequest,
} from '@avantf/mem-contract'
import {
  defaultLogger,
  type AvantfLogger,
  type StatsSummary,
} from '@avantf/mem-contract'
import {
  recordRetrieval,
  resolveSemantic,
  resolveReranker,
  resolveVStore,
  retrievalHealthSummary,
  setRetrievalLogger,
  type SemanticBackend,
} from '@avantf/mem-retrieval'
import { setPandocProvisioning } from '@avantf/mem-convert'
import { parseToolsConfig, resolveToolsDir } from '@avantf/mem-provision'
import { loadConfig, type LoadedConfig } from './config/loader.js'
import { knowledgeConfigPath } from './config/paths.js'
import { MEMORY_SCHEMA, openMemoryStore, type Db } from './db/conn.js'
import { describeSqlite } from './db/sqlite.js'
import { describeMigrationOutcome, wasUpgraded } from './db/store.js'
import { looksRelevant, type RelevanceHit } from './store/lexical.js'
import { droppedLegs, emptyFloorDrops, totalFloorDrops, type FloorLeg } from './store/floors.js'
import { MemoryStore } from './store/memory.js'
import { KnowledgeStore } from './store/knowledge.js'
import { crossQuery } from './router.js'

export interface RuntimeOptions {
  dataHome?: string
  memoryDbPath?: string
  /** Host logger; defaults to the prefixed console logger. */
  logger?: AvantfLogger
  /**
   * Override the semantic backend instead of resolving `semantic.backend` through the
   * registry. A seam for tests and embedders, NOT a second pluggability path: the registry
   * + config stays the documented way to swap backends (DESIGN §5). The override must
   * produce vectors of `config.semantic.dim`, since the vector stores are built from it.
   */
  semantic?: SemanticBackend
  /**
   * The family framework's managed roots, as the built-in defaults for `tools.dir` and
   * `semantic.cache_dir` / `rerank.cache_dir` (see `LoadConfigOptions.managedRoots`).
   *
   * The DSH plugin passes `<family home>/tools` and `<family home>/models` while
   * `@avantf/dsh-plugin-base` owns the fetching; the CLI and the MCP server pass nothing, because they
   * provision through `@avantf/mem-provision` as before.
   *
   * This also decides WHEN the local models warm: with managed roots the framework may still be
   * writing the model into that root, so the backends are resolved with `deferWarm` and the plugin
   * warms them once the framework's item settles. Without managed roots the adapters keep their
   * eager constructor warm.
   */
  managedRoots?: { readonly tools?: string; readonly models?: string }
}

/**
 * The awaited result of a store method — what a dispatch overload promises.
 *
 * Every member below is written in terms of the METHOD that produces it rather than a type
 * spelled out by hand. That is the whole point: an invented type (`Promise<RecallResult>` for
 * `related`, which answers with entity counts) compiles perfectly and then lies to every caller,
 * while `ReturnType<Store['method']>` cannot disagree with the store. The trailing general
 * overloads keep dynamic dispatchers (the plugin's tool runner, MCP) compiling, where the request
 * arrives as the whole union.
 *
 * Exported because the DSH plugin's Remote gateway is a dynamic dispatcher too, and it should be able
 * to say what each key answers without inventing a shape: `StoreResult<MemoryStore, 'add'>` is the
 * fact the store actually wrote, whatever the store's author later changes it to.
 */
export type StoreResult<S, M extends keyof S> = Awaited<ReturnType<Extract<S[M], (...args: never[]) => unknown>>>

/**
 * A caller-error payload — the shape every self-made refusal in the `switch` returns.
 *
 * Named so the return sites can assert it (`satisfies DispatchError`): these payloads are the
 * only ones NOT produced by a store method, so they have no `ReturnType` to be tied to.
 */
export type DispatchError = { error: string }

/**
 * `admin.stats`: the store counts plus the process-wide retrieval health block (DESIGN §20) — the one
 * admin payload no store method produces, because the runtime composes it.
 */
export type AdminStatsResult = StatsSummary

/**
 * The payload of the four hits-returning recall actions, which one overload groups because a
 * caller may hold them as a union (`action: 'chain' | 'reason'`).
 *
 * Grouping them is a CLAIM — that `probe`, `chain` and `reason` all answer like `search` — so it is
 * proven rather than assumed: a type-level check asserts that each store method's result equals this
 * one, and a divergence fails there instead of the grouped overload quietly lying about it. (Only
 * `probe` holds by construction, because it calls `memory.search`.)
 */
export type RecallHitsResult = StoreResult<MemoryStore, 'search'>

/**
 * `remember` dispatches to five store operations whose RESULTS differ: `add`/`update` return the
 * written fact, `remove` a flag, the feedback actions the new counter (or `null`). One plain
 * signature would either say `unknown` — leaving every caller to invent a cast, which is how a
 * caller ends up reading a field that does not exist — or a union that forces every caller to
 * narrow first. The callable type says what each ACTION returns.
 */
export type RememberDispatch = {
  (req: Extract<RememberRequest, { action: 'add' }>): Promise<StoreResult<MemoryStore, 'add'>>
  (req: Extract<RememberRequest, { action: 'update' }>): Promise<StoreResult<MemoryStore, 'update'>>
  (req: Extract<RememberRequest, { action: 'remove' }>): Promise<StoreResult<MemoryStore, 'remove'>>
  (req: Extract<RememberRequest, { action: 'helpful' | 'unhelpful' }>): Promise<StoreResult<MemoryStore, 'helpful'>>
  (req: RememberRequest): Promise<unknown>
}

/**
 * Same per-action idea as {@link RememberDispatch}. `ask` may also report a caller error, and
 * `related` answers with ENTITY COUNTS rather than hits (`memory.related`) — a distinction that
 * only showed up once this type existed, because the callers had been casting to whatever they
 * assumed.
 */
export type RecallDispatch = {
  (req: Extract<RecallRequest, { action: 'search' | 'probe' | 'chain' | 'reason' }>): Promise<RecallHitsResult>
  (req: Extract<RecallRequest, { action: 'ask' }>): Promise<StoreResult<MemoryStore, 'ask'> | DispatchError>
  (req: Extract<RecallRequest, { action: 'related' }>): Promise<StoreResult<MemoryStore, 'related'>>
  (req: Extract<RecallRequest, { action: 'contradict' }>): Promise<StoreResult<MemoryStore, 'listContradictions'>>
  (req: RecallRequest): Promise<unknown>
}

/**
 * `admin` is the widest dispatcher: counts, a fact page, a detail, flags, and five diagnostic
 * reports. `ReturnType<…>` keeps each member tied to the store method that actually produces it,
 * so a change there propagates instead of leaving callers with a cast they invented.
 */
export type AdminDispatch = {
  (req: Extract<AdminRequest, { action: 'stats' }>): AdminStatsResult
  (req: Extract<AdminRequest, { action: 'list' }>): StoreResult<MemoryStore, 'list'>
  (req: Extract<AdminRequest, { action: 'detail' }>): StoreResult<MemoryStore, 'get'> | DispatchError
  (req: Extract<AdminRequest, { action: 'archive' }>): StoreResult<MemoryStore, 'archive'>
  (req: Extract<AdminRequest, { action: 'restore' }>): StoreResult<MemoryStore, 'restore'>
  (req: Extract<AdminRequest, { action: 'pin' }>): StoreResult<MemoryStore, 'pin'>
  (req: Extract<AdminRequest, { action: 'unpin' }>): StoreResult<MemoryStore, 'unpin'>
  (req: Extract<AdminRequest, { action: 'trust_diagnose' }>): StoreResult<MemoryStore, 'trustDiagnose'>
  (req: Extract<AdminRequest, { action: 'vectors_diagnose' }>): StoreResult<MemoryStore, 'vectorsDiagnose'>
  (req: Extract<AdminRequest, { action: 'vectors_fix' }>): StoreResult<MemoryStore, 'vectorsFix'>
  (req: Extract<AdminRequest, { action: 'contradict_check' }>): StoreResult<MemoryStore, 'checkContradictions'>
  (req: Extract<AdminRequest, { action: 'contradict_resolve' }>): StoreResult<MemoryStore, 'resolveContradiction'>
  (req: Extract<AdminRequest, { action: 'maintenance' }>): StoreResult<MemoryStore, 'maintenance'>
  (req: AdminRequest): unknown
}

/**
 * `kb_manage`: ingest/import report a batch, list/detail the corpus, remove a flag, reindex a
 * plan. Members are pinned to the store methods that produce them (`ReturnType<…>`) so the
 * shapes cannot drift into "whatever the caller assumed".
 *
 * `ingest`/`import` may instead answer with a {@link KbConflictReport}: this face is the UI/CLI
 * REPLACE mode, where an unconfirmed collision writes nothing and comes back as a structured
 * list. The add-only face (`kbAdd`) never returns one — it refuses.
 */
export type KbDispatch = {
  (req: Extract<KbRequest, { action: 'ingest' }>): Promise<StoreResult<KnowledgeStore, 'ingest'> | KbConflictReport | DispatchError>
  (req: Extract<KbRequest, { action: 'import' }>): Promise<StoreResult<KnowledgeStore, 'importPaths'> | KbConflictReport>
  (req: Extract<KbRequest, { action: 'list' }>): Promise<StoreResult<KnowledgeStore, 'list'>>
  (req: Extract<KbRequest, { action: 'detail' }>): Promise<StoreResult<KnowledgeStore, 'detail'>>
  (req: Extract<KbRequest, { action: 'remove' }>): Promise<StoreResult<KnowledgeStore, 'remove'>>
  (req: Extract<KbRequest, { action: 'reindex' }>): Promise<StoreResult<KnowledgeStore, 'reindex'>>
  (req: KbRequest): Promise<unknown>
}

export interface AvantfRuntime {
  config: LoadedConfig
  db: Db
  memory: MemoryStore
  knowledge: KnowledgeStore
  /** Logger every startup/lifecycle line goes through. */
  logger: AvantfLogger
  remember: RememberDispatch
  recall: RecallDispatch
  admin: AdminDispatch
  kb: KbDispatch
  /**
   * The ADD-ONLY face of the same shared ingestion entry (`kb_add`): same plan/classify/dispatch,
   * but a collision is refused instead of replaced. Kept as its own runtime method — not a field on
   * the request — so the model-facing `KB_ADD_TOOL.input` cannot even express "replace".
   */
  kbAdd(req: KbAddRequest): Promise<unknown>
  query(req: QueryRequest): Promise<RecallResult>
  /**
   * Plugin-internal, NOT a tool and not model-facing: does either store already hold something
   * relevant to `text`? A boolean (`store/lexical.ts`) because the one tool the hint names
   * (`kb_query`) retrieves from both stores, so "which one matched" changes no downstream decision.
   * Synchronous on purpose — the caller renders it into a prompt provider that cannot await
   * (DESIGN §12).
   */
  relevance(text: string): RelevanceHit
  /**
   * True once {@link shutdown} has run: the databases are closed and no background pass may start.
   * A gated startup job checks this (as well as the plugin's fiber) before touching the stores.
   */
  readonly closed: boolean
  shutdown(): void
}

/** Build the runtime: load config, open the memory DB, construct the stores. */
export function buildRuntime(opts?: RuntimeOptions): AvantfRuntime {
  const logger = opts?.logger ?? defaultLogger
  const started = Date.now()
  // The logger is threaded INTO the load, not installed after it: config warnings
  // (unknown keys) are the operator's only signal that a file is being partly ignored.
  const config = loadConfig({
    dataHome: opts?.dataHome,
    logger,
    ...(opts?.managedRoots === undefined ? {} : { managedRoots: opts.managedRoots }),
  })
  // The vector stores are built from `semantic.dim`, so a backend that encodes a different
  // width would put mismatched vectors into them — a failure that surfaces much later as
  // garbage scores. Reject it BEFORE opening the database (and before anything is created).
  if (opts?.semantic !== undefined && opts.semantic.dim !== config.common.semantic.dim) {
    throw new Error(
      `语义覆盖维度 ${opts.semantic.dim} ≠ 配置里的 semantic.dim ${config.common.semantic.dim} `
      + `（后端 '${opts.semantic.name}'）：向量库是按 semantic.dim 建的，维度不一致会在很久以后表现为乱码分数`,
    )
  }
  const memDb = opts?.memoryDbPath ?? config.memory.db.path
  setRetrievalLogger(logger)
  // The document pipeline's only external binary. `@avantf/mem-provision` owns the managed
  // directory, the mirror list, and the pinned version; here the runtime hands it the RESOLVED
  // `tools` section, so a conversion on the first ingest already knows where to look (and, when
  // allowed, may fetch it) without the knowledge store knowing anything about pandoc.
  setPandocProvisioning({
    toolsDir: resolveToolsDir(parseToolsConfig(config.common.tools)),
    mirror: config.common.tools.mirror,
    autoInstall: config.common.tools.auto_install,
    logger,
  })
  logger.info(
    `runtime init: dataHome=${config.home} memory.db=${memDb} knowledge.db=${config.knowledge.db.path} `
    + `semantic=${config.common.semantic.backend}/${config.common.semantic.local_model} `
    + `rerank=${config.common.rerank.backend} `
    + `vectorStore=${config.common.vectorStore.backend} `
    // Which SQLite build is answering: the whole engine runs on the runtime's own `node:sqlite`, and
    // the version travels with the host, so this is the first thing to quote when two hosts behave
    // differently (and the one line that names a runtime that cannot serve a store at all).
    + `sqlite=${describeSqlite()}`,
  )
  const memoryStore = openMemoryStore(memDb)
  // Startup auto-upgrade is silent by design unless it actually did something: an up-to-date store
  // adds no line, an upgraded one names the version jump and every step it ran (the schema lives at
  // `PRAGMA user_version`, so this is the only place an operator can see it happen).
  if (wasUpgraded(memoryStore.migration)) {
    logger.info(`memory: ${describeMigrationOutcome(MEMORY_SCHEMA, memoryStore.migration)}`)
  }
  const db = memoryStore.db
  // When the family framework owns the model root (`managedRoots`), the model files may still be
  // being installed: warming in the constructor here would race that install and fetch a SECOND
  // copy into the very same root. So the backends are resolved with their constructor warm
  // deferred, and the plugin warms explicitly from the model item's `onSettled` (a first
  // `encode()` would warm lazily too, so nothing is lost if the explicit warm never runs).
  const deferWarm = opts?.managedRoots !== undefined
  const semantic = opts?.semantic ?? resolveSemantic(config.common, { deferWarm })
  // The reranker is resolved through the registry (rerank.backend) — the single
  // canonical rerank switch; stores never duck-type it off the semantic backend.
  const reranker = resolveReranker(config.common, { deferWarm })
  const vstore = resolveVStore(config.common)
  const kbVstore = resolveVStore(config.common)
  const memory = new MemoryStore(db, config.common, semantic, vstore, reranker, memDb)
  const knowledge = new KnowledgeStore(config.knowledge.db.path, config.common, config.knowledge, semantic, kbVstore, reranker, knowledgeConfigPath(config.home), logger)
  logger.info(`runtime ready in ${Date.now() - started}ms (embeddings warm asynchronously)`)

  /**
   * Set by {@link AvantfRuntime.shutdown}. Exposed because a background job that the plugin starts
   * behind a startup gate (the entity sweep) can otherwise fire after the databases are closed and
   * log a spurious failure.
   */
  let closed = false
  const api = {
    config,
    db,
    memory,
    knowledge,
    logger,
    relevance(text: string): RelevanceHit {
      // The closure consts, not `this`: this method takes no `this` and must not depend on the
      // literal's inferred shape.
      // `stopAt = 2` because `looksRelevant` asks exactly that: the probes otherwise run up to
      // 24 `LIMIT 1` FTS lookups each, on the SYNCHRONOUS path that assembles the prompt. The `||`
      // is a real short-circuit: a memory hit answers the question without probing knowledge at all.
      return looksRelevant(memory.lexicalProbe(text, 2)) || looksRelevant(knowledge.lexicalProbe(text, 2))
    },
    async remember(req: RememberRequest) {
      switch (req.action) {
        case 'add':
          return this.memory.add(req.content, req.category, req.ttl_days)
        case 'update':
          return this.memory.update(req.fact_id, req.content, req.category, req.ttl_days)
        case 'remove':
          return this.memory.remove(req.fact_id, req.reason)
        case 'helpful':
          return this.memory.helpful(req.fact_id)
        case 'unhelpful':
          return this.memory.unhelpful(req.fact_id)
      }
    },
    async recall(req: RecallRequest) {
      switch (req.action) {
        case 'search':
          return this.memory.search({ query: req.query, category: req.category, limit: req.limit, maxTokens: req.max_tokens, floors: req.floors })
        case 'ask': {
          if (req.query) return this.memory.ask(req.query, req.limit ?? 10)
          if (!req.subj && !req.pred && !req.obj) {
            return { error: 'recall.ask requires query, or at least one of subj/pred/obj' } satisfies DispatchError
          }
          const pattern = {
            ...(req.subj ? { subj: req.subj } : {}),
            ...(req.pred ? { pred: req.pred } : {}),
            ...(req.obj ? { obj: req.obj } : {}),
          }
          return this.memory.askByPattern(pattern, req.limit ?? 10)
        }
        case 'chain': {
          return this.memory.chain(req.subj, req.pred, req.second_pred, req.limit ?? 10)
        }
        case 'probe': {
          // probe = hybrid search PLUS the HRR entity-similarity leg (the reason
          // hrr_vector is persisted at all).
          return this.memory.search({ query: req.entity, category: req.category, limit: req.limit, includeHrr: true })
        }
        case 'contradict': {
          return this.memory.listContradictions({ category: req.category, limit: req.limit })
        }
        case 'related': {
          return this.memory.related(req.entity, req.limit ?? 10, req.category)
        }
        case 'reason': {
          return this.memory.reason(req.entities ?? [], req.limit ?? 10)
        }
        default:
          return { error: `recall.${(req as { action: string }).action} not implemented; implemented: search, ask, chain, probe, related, reason, contradict` } satisfies DispatchError
      }
    },
    admin(req: AdminRequest) {
      switch (req.action) {
        case 'stats':
          // Store counts plus the retrieval health counters: "how is retrieval behaving" cannot
          // be reconstructed from the tables afterwards (DESIGN §20). The `satisfies` is what ties
          // this HAND-BUILT payload to the overload that promises it — a spread cannot be checked
          // by `ReturnType`.
          return { ...this.memory.countByStatus(), retrieval: retrievalHealthSummary() } satisfies AdminStatsResult
        case 'list':
          return this.memory.list(req.category, req.status ?? 'active', req.limit ?? 50, req.offset ?? 0)
        case 'detail':
          return this.memory.get(req.fact_id) ?? ({ error: `fact_id=${req.fact_id} not found` } satisfies DispatchError)
        case 'archive':
          return this.memory.archive(req.fact_id, req.reason)
        case 'restore':
          return this.memory.restore(req.fact_id)
        case 'pin':
          return this.memory.pin(req.fact_id)
        case 'unpin':
          return this.memory.unpin(req.fact_id)
        case 'trust_diagnose':
          return this.memory.trustDiagnose()
        case 'contradict_check':
          return this.memory.checkContradictions()
        case 'contradict_resolve':
          return this.memory.resolveContradiction(req.contradiction_id, req.resolution, req.loser_fact_id)
        case 'maintenance':
          // Store-owned: runMaintenance + live-index eviction happen in one place.
          return this.memory.maintenance()
        case 'vectors_diagnose':
          return this.memory.vectorsDiagnose()
        case 'vectors_fix':
          return this.memory.vectorsFix(req.dry_run ?? false)
        default:
          return { error: `admin.${(req as { action: string }).action} not implemented` } satisfies DispatchError
      }
    },
    async kb(req: KbRequest) {
      switch (req.action) {
        case 'ingest': {
          if (!req.text && !req.source_uri) return { error: 'ingest requires text or source_uri' } satisfies DispatchError
          // ONE shared entry, replace mode: a collision comes back as a structured report and writes
          // nothing unless the caller confirmed with `overwrite: true`. This is the UI/CLI face.
          return this.knowledge.ingestRequest({
            ...(req.text === undefined ? {} : { text: req.text }),
            ...(req.source_uri === undefined ? {} : { source_uri: req.source_uri }),
            domain: req.domain,
            source: req.source,
            title: req.title,
            overwrite: req.overwrite,
          }, 'replace')
        }
        case 'import':
          return this.knowledge.ingestRequest({
            paths: req.paths, domain: req.domain, source: req.source, overwrite: req.overwrite,
          }, 'replace')
        case 'list':
          return this.knowledge.list(req.domain, req.source, req.limit, req.offset)
        case 'detail':
          return this.knowledge.detail(req.doc_id)
        case 'remove':
          return this.knowledge.remove(req.doc_id)
        case 'reindex':
          return this.knowledge.reindex(req.domain, { dryRun: req.dry_run })
        case 'sync':
          return this.knowledge.sync({ docId: req.doc_id, dryRun: req.dry_run, adopt: req.adopt })
      }
    },
    async kbAdd(req: KbAddRequest) {
      // The ADD-ONLY face: same plan/classify, but never a replacement. A single collision throws
      // the actionable Chinese error; a batch collision is per-file (`ImportResult.failed`).
      return this.knowledge.ingestRequest({
        ...(req.text === undefined ? {} : { text: req.text }),
        ...(req.source_uri === undefined ? {} : { source_uri: req.source_uri }),
        ...(req.paths === undefined ? {} : { paths: req.paths }),
        domain: req.domain,
        source: req.source,
        title: req.title,
      }, 'add')
    },
    async query(req: QueryRequest) {
      // `domain`/`source` are knowledge-base taxonomy — they must NOT be mapped onto
      // memory categories; the router filters memory hits out when a domain is set.
      // Over-fetch for fusion WITHOUT recording retrieval stats: the router may
      // still drop these hits (kind/domain/source), and stats feed dormancy.
      // The two store legs are independent — run them concurrently.
      //
      // The query is encoded ONCE for both legs: they share this backend and model, so a
      // per-store encode was the same vector computed twice (~4 ms on every `kb_query`).
      // When the model is unavailable the stores keep their own degraded handling.
      const startedAt = Date.now()
      // The tool boundary parses through the contract, where `limit` defaults to 10 — but this is
      // a public method that embedders and benchmarks also call, and `req.limit * 3` with an
      // omitted limit produced `NaN` all the way into the stores (the semantic leg then returned
      // NOTHING because `slice(0, NaN)` is empty, and a leg cap turned it into a SQLITE_MISMATCH).
      // Defaulting here keeps the runtime honest on its own.
      const limit = req.limit ?? 10
      const queryVector = semantic.isAvailable() ? await semantic.encode(req.query) : undefined
      /**
       * ONE cross-store pass under ONE floor policy.
       *
       * The profile is pinned on both store calls (`'strict'` / `'loose'`) so neither store runs its
       * own relaxed fallback: only the MERGED result may decide whether relaxing is warranted,
       * otherwise a store that happens to be empty would inject its relaxed tail into an answer the
       * other store filled strictly.
       *
       * `relaxLegs` is the same "only the legs that actually dropped" rule the single-store retry
       * applies (`store/floors.ts`'s `droppedLegs`), read off the MERGED strict pass — relaxing a leg
       * that dropped nothing admits no candidate, so this only keeps the reported `floors` honest.
       */
      const crossPass = async (profile: FloorProfile, relaxLegs?: readonly FloorLeg[]): Promise<RecallResult> => {
        // The knowledge store answers with hits only; capture its floor report so the ONE merged
        // result can carry both stores' drops (the memory side brings its own on the result object).
        let kbDroppedByFloor: RecallResult['dropped_by_floor']
        const [memory, kb] = await Promise.all([
          // The per-store budgets are lifted for the fusion pool: the router ranks the merged
          // pool and applies the caller's budget to what it finally returns. `recordStats: false`
          // for both legs: ONE user query must produce ONE health event (`kind: 'cross'`, below),
          // or `queries`/`zero_result_rate`/`avg_latency` count legs — two per `kb_query` — and the
          // knowledge leg's zero-result case was not counted at all.
          this.memory.search({
            query: req.query, limit: limit * 3, track: false, recordStats: false, queryVector, maxTokens: 0, floors: profile,
            ...(relaxLegs === undefined ? {} : { relaxLegs }),
          }),
          this.knowledge.search(req.query, {
            domain: req.domain,
            source: req.source,
            limit: limit * 3,
            recordStats: false,
            queryVector,
            maxTokens: 0,
            floors: profile,
            ...(relaxLegs === undefined ? {} : { relaxLegs }),
            onResult: (r) => { kbDroppedByFloor = r.dropped_by_floor },
          }),
        ])
        return crossQuery(memory, kb, {
          limit,
          kind: req.kind ?? 'all',
          domain: req.domain,
          source: req.source,
          maxTokens: req.max_tokens ?? config.common.retriever.max_output_tokens,
          ...(kbDroppedByFloor === undefined ? {} : { kbDroppedByFloor }),
        })
      }
      // The retry rule lives HERE, not in the stores (see `crossPass`). An explicit profile
      // suppresses it; an omitted one gets the strict pass, then ONE relaxed pass if the merged
      // result was empty BECAUSE the floors dropped candidates.
      let result = await crossPass(req.floors === 'loose' ? 'loose' : 'strict')
      if (req.floors === undefined && result.hits.length === 0) {
        const dropped = result.dropped_by_floor ?? emptyFloorDrops()
        if (totalFloorDrops(dropped) > 0) {
          const loosened = await crossPass('loose', droppedLegs(dropped))
          // Only a pass that produced something replaces the strict answer: if relaxing changes
          // nothing, the caller keeps the strict result and its honest "the floors removed N" report.
          if (loosened.hits.length > 0) result = { ...loosened, relaxed: true }
        }
      }
      // The merged outcome is what the caller saw, so it is what the health counters describe:
      // `results` is the post-filter/post-budget count, and latency is the whole cross query
      // (both legs + encode + fusion), not one leg's share of it.
      const rerank = this.memory.rerankState()
      recordRetrieval({
        kind: 'cross',
        results: result.hits.length,
        latencyMs: Date.now() - startedAt,
        semanticLive: semantic.isAvailable(),
        rerankUsed: rerank.used,
        rerankFallback: rerank.fallback,
        ...(result.dropped_by_floor === undefined ? {} : { droppedByFloor: result.dropped_by_floor }),
      })
      // Only the facts actually returned to the caller count as recalled (R5/R21).
      this.memory.reinforce(result.hits.filter((h) => h.kind === 'fact').map((h) => h.ref_id))
      return result
    },
    shutdown() {
      if (closed) return
      closed = true
      // Diagnostics that live in memory are flushed before the handle goes away; closing the
      // DB is the runtime's job (it owns the handle), so this is not a `close()`.
      memory.flushHealth()
      // Vector-index snapshots too: an ANN graph is a serialized structure, and paying the write
      // once here (measured ~1.5 ms at 8000 vectors) saves a full rebuild on the next start.
      vstore.flush?.()
      kbVstore.flush?.()
      db.close()
      this.knowledge.close()
    },
  }
  // The four dispatchers are the ONLY place the per-action result types meet the runtime `switch`
  // (which cannot narrow per branch), so the mapping is asserted here once, in one place.
  // Everything else is still checked against `AvantfRuntime` by this return type.
  return {
    ...api,
    // Re-declared because the spread above would SNAPSHOT the getter's value at this moment
    // (`false`), leaving `runtime.closed` stuck at `false` after `shutdown()`.
    get closed(): boolean { return closed },
    remember: api.remember as RememberDispatch,
    recall: api.recall as RecallDispatch,
    admin: api.admin as AdminDispatch,
    kb: api.kb as KbDispatch,
  }
}
