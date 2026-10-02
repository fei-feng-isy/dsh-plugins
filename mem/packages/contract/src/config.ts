import { z } from 'zod'

/**
 * Input window of the SHIPPED models: `Xenova/bge-small-zh-v1.5` (embedder) and
 * `Xenova/bge-reranker-base` (reranker) both read 512 tokens.
 *
 * Exported because more than one default derives from it: the embedder's fallback window, the
 * reranker's pair budget (retrieval-core), and `knowledge.chunk_size` below. transformers.js
 * truncates past the window SILENTLY, so every derivation has to agree on the number.
 */
export const DEFAULT_MODEL_WINDOW_TOKENS = 512

/**
 * Upper bound on tokens handed to the embedder. 0 = auto (the loaded model's declared
 * window); a positive value is clamped to it. Past the window transformers.js truncates
 * with no error, so the adapter bounds the text first and warns once (DESIGN §20).
 */
const maxInputTokens = z.number().int().nonnegative().default(0)

const semanticSchema = z.object({
  // string (not enum) so a third-party backend can be registered; built-in: `local_bge`.
  backend: z.string().default('local_bge'),
  // Must be an ONNX repo — transformers.js cannot load the PyTorch-only `BAAI/*`
  // originals (they silently degrade to FTS+entity). Xenova/* are the ONNX ports.
  local_model: z.string().default('Xenova/bge-small-zh-v1.5'),
  dim: z.number().int().positive().default(512),
  max_input_tokens: maxInputTokens,
  // model download / warmup
  mirror: z.string().default('https://hf-mirror.com'), // domestic mirror by default
  // Empty = "the family root's `models`", resolved by the loader (`familyModelsDir()`); the
  // pre-framework `~/.avantf/models` is NOT a fallback anywhere any more.
  cache_dir: z.string().default(''),
  auto_download: z.boolean().default(true),
})

const rerankSchema = z.object({
  // string (not enum) for the same reason; built-ins: `bge_reranker`, `none`.
  backend: z.string().default('none'),
  // ONNX port of bge-reranker-base (see semantic note above).
  local_model: z.string().default('Xenova/bge-reranker-base'),
  // Same knob for the cross-encoder, but the budget is shared with the QUERY: the document
  // is bounded to `window - query - specials` (the question is never truncated).
  max_input_tokens: maxInputTokens,
  mirror: z.string().default('https://hf-mirror.com'),
  // See the semantic note: empty = the family root's `models`.
  cache_dir: z.string().default(''),
  auto_download: z.boolean().default(true),
})

const vectorStoreSchema = z.object({
  // string (not enum) for the same reason; built-ins: `local_numpy`, `hnswlib`, `auto`
  // (`faiss`/`pgvector`/`qdrant` are recognized names that warn and fall back to `local_numpy`).
  backend: z.string().default('auto'),
  /**
   * Vector counts at which `backend: auto` migrates to an ANN index.
   *
   * Measured with `node scripts/bench-vstore.mjs` (2000 and 8000 uniform-random vectors, dim 512,
   * k=50): at 2000 the brute-force store answers in a few ms and hnswlib in under 1 ms
   * (3.3 ms → 0.83 ms on the machine that measured it; the RATIO moves with the CPU, so compare
   * your own run of the script rather than this pair) at recall 0.999, so migrating there is both
   * worthwhile and nearly exact. Two reasons not to lower
   * it: the native index takes ~0.9 s to BUILD (paid on the upgrade and on every batch eviction,
   * i.e. on the write path), and below a few hundred vectors brute force is already
   * sub-millisecond. At 8000 recall falls to 0.89, so for a larger corpus raise
   * `hnswlib_ef_search` (or accept the loss) instead of moving this threshold.
   */
  auto_thresholds: z
    .object({
      hnswlib: z.number().int().positive().default(2000),
    })
    .default({ hnswlib: 2000 }),
  /**
   * ANN search beam width (`ef`). This is the recall/speed knob of the hnswlib index, and it is
   * NOT optional in practice: the library's own default (10) returned 0.45 of the true top-10 in
   * a measured benchmark at dim 512, while 256 returned 1.00 at ~0.7 ms per query (brute force:
   * ~3 ms at n=2000). Recall falls as the corpus grows, so raise this before raising
   * `auto_thresholds.hnswlib`. The store uses `max(ef_search, 8 × k)`.
   */
  hnswlib_ef_search: z.number().int().min(16).max(2048).default(256),
})

const retrieverSchema = z.object({
  weight_semantic: z.number().min(0).max(1).default(0.55),
  weight_fts: z.number().min(0).max(1).default(0.3),
  weight_jaccard: z.number().min(0).max(1).default(0.15),
  /**
   * Token budget for a retrieval RESULT (`0` = unlimited). `limit` bounds how many hits, never
   * how much text, so a broad query could otherwise pour tens of thousands of characters into a
   * model's context while a narrow one poured in a paragraph (DESIGN §20). Hits shortened by the
   * budget are marked `truncated`.
   */
  max_output_tokens: z.number().int().nonnegative().default(8000),
  over_fetch_factor: z.number().int().positive().default(5),
  /**
   * Relevance floor for the SEMANTIC leg, in cosine units (`0` = off).
   *
   * Applied to the leg's RAW score BEFORE `fuse()`: fusion scales each leg by its own maximum, so
   * the fused number is relative to the query and cannot carry an absolute cutoff (DESIGN §7 /
   * §20.19). A score EQUAL to the floor is kept — only strictly-lower candidates are dropped.
   *
   * The default is calibrated for the shipped embedder (`Xenova/bge-small-zh-v1.5`, dim 512,
   * mean-pooled AND normalized). A different model is a different cosine scale: re-measure before
   * keeping 0.5 (see DESIGN §20.19).
   */
  min_semantic_similarity: z.number().min(0).max(1).default(0.5),
  /**
   * Relevance floor for the FTS leg: the minimum number of DISTINCT query terms a row must hit
   * (`0` = off). Judged PER ROW — the terms are `store/lexical.ts`'s `relevanceTerms()` (latin words
   * ≥ 5 chars + every CJK 3-gram), and a row that hits fewer is dropped.
   *
   * `bm25` itself is unbounded and query-relative, so it cannot host an absolute floor. With the
   * semantic leg unavailable this value is relaxed to 1 by the orchestration (FTS + entity are then
   * the only evidence a short query has); a configured `0` stays off either way.
   */
  min_fts_terms: z.number().int().nonnegative().default(2),
  /**
   * Relevance floor for the entity-overlap (Jaccard) leg, as a ratio of the union (`0` = off).
   * A score EQUAL to the floor is kept.
   */
  min_jaccard: z.number().min(0).max(1).default(0.2),
  /**
   * Rows one non-semantic retrieval leg may hand to fusion (`0` = derived: `max(200, 4×overFetch)`).
   *
   * The legs used to return the whole matching corpus — a common phrase matched every fact — and
   * `fuse` normalized and sorted all of it. The headroom exists so each leg can fill the pool on its
   * own; fusion scales each leg by its own MAXIMUM, so for a leg that returns its entries in score
   * order trimming its tail cannot rescale the survivors (the HRR probe is the exception — it can
   * be capped in a non-score order; see `retrieval-core/src/fusion.ts`).
   *
   * `0` is the shipped behaviour. A positive value is for tests and for operators who would rather
   * spend less memory than lose the tail: it is `retriever.leg_cap` that makes the cap a
   * measurable variable instead of a constant baked into the store.
   */
  leg_cap: z.number().int().nonnegative().default(0),
})

/**
 * Trust & forgetting (TRUST_MODEL.md). The aging clock is the ACTIVE-DAY counter
 * (`avantf_stats.trust_clock`), not wall time: downtime counts as at most
 * `presence.gap_cap_days` so a shut-down system never "starves" its memories.
 */
const presenceSchema = z.object({
  // D3 / §7: presence IS the process being alive (startup + heartbeat). `process` is
  // the only mode the model defines, so the enum admits exactly one value: anything
  // else fails loudly at config load instead of being accepted and silently ignored.
  mode: z.enum(['process']).default('process'),
  /** One presence advances the clock by at most this many days (downtime ⇒ 1 day). */
  gap_cap_days: z.number().min(0).default(1),
  /** Long-lived surfaces (plugin / MCP) tick this often; 0 = startup pass only. */
  heartbeat_minutes: z.number().int().nonnegative().default(60),
})

const trustSchema = z.object({
  /** false = no presence, no decay, no reinforcement, no pinning (TTL/idle/purge keep running). */
  enabled: z.boolean().default(true),
  /** Initial trust of a new fact. */
  start: z.number().min(0).max(1).default(0.5),
  /** Linear decay per active day: `0.5 / 90` ⇒ 90 active days from start to 0. */
  decay_per_day: z.number().min(0).max(1).default(0.5 / 90),
  /** Trust ≤ this ⇒ forgotten (archived 'forgot'). 0 = "reaching zero is forgetting". */
  forget_threshold: z.number().min(0).max(1).default(0),
  /** Reaching this via explicit feedback promotes to permanent (snapped to 1.0). */
  permanent_threshold: z.number().min(0).max(1).default(0.9),
  /** A recall of something at/below this raises it straight back to this value. */
  recall_floor: z.number().min(0).max(1).default(0.5),
  /** Per-recall gain (before marginal decay). */
  recall_delta: z.number().min(0).max(1).default(0.03),
  /** Effective reinforcement events per fact per 24h (R10: zero-gain ones don't count). */
  recall_daily_cap: z.number().int().nonnegative().default(3),
  /** 1 = every in-window gain is equal; 0.5 = 0.03 / 0.015 / 0.0075 … */
  recall_marginal_decay: z.number().min(0).max(1).default(1),
  /** Recall alone can never exceed this (and never pins — see D11). */
  recall_ceiling: z.number().min(0).max(1).default(0.85),
  /** Explicit `helpful` / `unhelpful` step. */
  feedback_delta: z.number().min(0).max(1).default(0.05),
  /** 0 = unlimited; >0 also caps feedback reinforcement per fact per 24h. */
  feedback_daily_cap: z.number().int().nonnegative().default(0),
  /** A revised fact inherits the settled trust (and pin) of the row it replaces. */
  inherit_trust_on_update: z.boolean().default(true),
  /** Pinned (permanent) facts are never physically purged. */
  purge_skips_pinned: z.boolean().default(true),
  /** Calendar fallback: unused for this many days ⇒ archived 'idle'. */
  idle_calendar_days: z.number().int().positive().default(365),
  /** Per-tick budget for the settle sweep (the other sweeps only touch critical rows). */
  tick_max_facts: z.number().int().positive().default(5000),
  presence: presenceSchema.prefault({}),
})

const lifecycleSchema = z.object({
  /** Purge window, measured in ACTIVE days since `archived_clock`. */
  purge_after_archived_days: z.number().int().nonnegative().default(365),
  contradiction_threshold: z.number().min(0).max(1).default(0.6),
})

/**
 * External tools and derived runtime state the plugin must PROVIDE, not merely use (DESIGN §13).
 *
 * npm dependencies are pnpm's job; this section is about everything else — the pandoc binary the
 * document pipeline converts through, and the embedding model warmed at startup. They live in the
 * SAME section because they share one mechanism (`@avantf/mem-provision`: a managed directory, a
 * mirror list, a startup sweep), and two configuration surfaces for one mechanism is exactly how the
 * two initialization paths this replaced drifted apart.
 *
 * The mirror list defaults to DOMESTIC proxies, with the official source always tried last — a
 * 35 MB download from GitHub is the difference between a usable first run and an abandoned one.
 */
const toolsSchema = z.object({
  /** Managed install root; `<dir>/<tool>/<version>/bin/<binary>` per artifact. */
  // Empty = "the family root's `tools`" (`familyToolsDir()`); see `resolveToolsDir`.
  dir: z.string().default(''),
  /** URL templates tried before the official source; `{url}` is the original URL, `{file}` its name. */
  mirror: z.array(z.string()).default([
    'https://ghfast.top/{url}',
    'https://ghproxy.net/{url}',
    'https://gh-proxy.com/{url}',
  ]),
  /** Download a missing artifact at startup. `false` = use only what is already on this machine. */
  auto_install: z.boolean().default(true),
})

/** The merged runtime config shared by memory and knowledge stores. */
export const ConfigSchema = z.object({
  dataHome: z.string().default('~/.avantf'),
  semantic: semanticSchema.prefault({}),
  rerank: rerankSchema.prefault({}),
  vectorStore: vectorStoreSchema.prefault({}),
  retriever: retrieverSchema.prefault({}),
  lifecycle: lifecycleSchema.prefault({}),
  trust: trustSchema.prefault({}),
  tools: toolsSchema.prefault({}),
})

export type Config = z.infer<typeof ConfigSchema>

/** Built-in defaults — the lowest precedence layer. */
export const defaultConfig: Config = ConfigSchema.parse({})

/**
 * Memory store-specific config. Overrides on top of the common Config.
 * Note: `db.path` is the single authoritative path for the memory DB.
 */
export const MemoryConfigSchema = z.object({
  // Empty default -> loader falls back to the home-relative `memoryDbPath(home)`
  // (`join(home, 'memory', 'memory.db')`). A literal `~/.avantf/...` default would
  // be re-joined onto `home` (already `~/.avantf`) and double the directory.
  db: z.object({ path: z.string().default('') }).prefault({}),
})

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>

/**
 * Ingestion boundary (DESIGN §8 / D5). `kb_ingest`'s `source_uri` is RESOLVED —
 * a local path is read, an http(s) URL is fetched — and everything it reads lands
 * in an index the agent retrieves from, so an unguarded boundary is a
 * read-any-file / probe-the-intranet primitive for a steered agent. Safe by
 * default, with one explicit opt-in per resource kind.
 */
const ingestSchema = z.object({
  /** Roots a local `source_uri`/`kb_import` path may be read from; empty ⇒ the process workspace (`cwd`). */
  local_roots: z.array(z.string()).default([]),
  /** Lift the roots check entirely — read any local path. */
  allow_outside_workspace: z.boolean().default(false),
  /** Allow `http(s)` fetches to loopback/private/link-local addresses. */
  allow_private_network: z.boolean().default(false),
})

/** Knowledge store-specific config. */
export const KnowledgeConfigSchema = z.object({
  db: z.object({ path: z.string().default('') }).prefault({}),
  /**
   * The managed document directory: one editable `.md` per document, holding the body the KB
   * indexed. Empty ⇒ `<dataHome>/knowledge/docs`. It holds a COPY, never the origin: a
   * `source_uri` is read once at ingest, so editing or deleting these files cannot touch
   * whatever the document came from.
   */
  docs: z.object({ dir: z.string().default('') }).prefault({}),
  /**
   * Version control for the store's on-disk text, via the reusable `GitRepo`.
   *
   * `root` defaults to the managed-document directory, which is exactly the "content" layer: one
   * file per document, body stored VERBATIM — while `knowledge.db` beside it is a derived index and
   * must not enter the history. Point `root` higher (e.g. at the whole store directory) to share
   * more, and `ignore` is what keeps the databases out; the defaults already cover them.
   */
  git: z
    .object({
      mode: z.enum(['auto', 'off']).default('auto'),
      root: z.string().default(''),
      ignore: z.array(z.string()).default(['*.db', '*.db-wal', '*.db-shm']),
    })
    .prefault({}),
  open: z.object({ editor: z.string().default('') }).prefault({}),
  /**
   * The knowledge-domain allowlist: the `domain` names a write may use. The default is a small
   * general set; a deployment narrows or widens it here. An EXPLICIT EMPTY array means no
   * restriction, so `domains: []` is the documented "accept any domain" value — a store whose
   * allowlist is non-empty additionally accepts every domain already present in its `documents`
   * table, so renaming the taxonomy never strands existing documents.
   */
  domains: z.array(z.string()).default(['design', 'api', 'ops', 'research', 'notes']),
  /**
   * Characters per chunk, derived from the SHIPPED model's window rather than chosen by feel:
   * `bge-small-zh-v1.5` reads {@link DEFAULT_MODEL_WINDOW_TOKENS} tokens and Chinese costs
   * ~1 token per character, so ~510 characters fit minus the two wrapper tokens; 500 leaves
   * room and keeps the number round. Longer chunks are not
   * rejected — the embedder bounds them and warns once — but their tail would only reach the
   * FTS leg, so raise this only together with `semantic.max_input_tokens`.
   */
  chunk_size: z.number().int().positive().default(500),
  /** 10% of `chunk_size`: consecutive chunks share this much context (unchanged ratio). */
  chunk_overlap: z.number().int().nonnegative().default(50),
  source_priority: z.enum(['workspace', 'none']).default('workspace'),
  ingest: ingestSchema.prefault({}),
})

export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>
