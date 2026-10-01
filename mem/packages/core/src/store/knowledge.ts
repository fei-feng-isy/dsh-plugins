import { existsSync, readFileSync, readdirSync, statSync, type Stats } from 'node:fs'
import { join, basename } from 'node:path'
import {
  DEFAULT_KB_SOURCE,
  describeError,
  expandHome,
  type AvantfLogger,
  type KbUnclaimedFile,

  type Config,
  type DocumentDetail,
  type DocumentSummary,
  type ImportResult,
  type IngestResult,
  type KbConflictReport,
  type KbDocFile,
  type KbIngestConflict,
  type KbSyncReport,
  type KnowledgeConfig,
  type RecallHit,
  type ReindexReport,
} from '@avantf/mem-contract'
import { retrievalLogger } from '@avantf/mem-core'
import type { Reranker, SemanticBackend, VectorStore } from '@avantf/mem-core'
import type { Db } from '../db/conn.js'
import { KNOWLEDGE_SCHEMA, openKnowledgeStore } from '../db/knowledge.js'
import { describeMigrationOutcome, wasUpgraded } from '../db/store.js'
import { ChunksDao, type ChunkHitRow, type ChunkStateRow } from '../db/dao/chunks.js'
import { DocumentsDao } from '../db/dao/documents.js'
import { contentHash } from '../db/hash.js'
import { documentText, type DocumentText } from './document_text.js'
import { classifySource, listTextFiles } from './source_picker.js'
import { bytesToFloat32, float32ToBytes, reloadVectorIndex, vectorCachePath } from '../db/vectors.js'
import { buildFtsQuery, detectFtsTokenizer, reportFtsTokenizerDrift, resolveFtsTokenizer, type FtsTokenizer } from '../db/tokenizer.js'
import { probeTerms, type LexicalProbe } from './lexical.js'
import { applyScoreFloor, applyTermFloor } from './floors.js'
import { hybridSearch, RetrievalInputError, type HybridContext, type HybridDeps, type HybridLeg, type HybridResult } from './hybrid.js'
import { evictVectors as evictVectorsOf, reportForeignVectors, vectorSpaceOf } from './common.js'
import { ENTITY_EXTRACTOR_VERSION, extractEntities } from '../entities/extract.js'
import {
  assertFetchableUrl,
  resolveLocalSource,
  type IngestLimits,
} from './ingest_guard.js'
import { bodyHash, deriveDocTitle, DocFiles } from './doc_files.js'
import { GitRepo } from '../git.js'
import { addKnowledgeDomain } from '../config/domains.js'

/** Options for {@link KnowledgeStore.search}. */
export interface KnowledgeSearchOptions {
  domain?: string
  source?: string
  limit?: number
  /** Overrides the config-derived fusion pool size; never smaller than `limit`. */
  overFetch?: number
  /**
   * Pre-encoded query vector, when the caller already has one — the cross-store router encodes a
   * query ONCE and hands the same vector to both stores. Not verified, so it must come from the
   * same backend.
   */
  queryVector?: Float32Array
  /** Per-call output token budget; `0` = unlimited, omitted = `retriever.max_output_tokens`. */
  maxTokens?: number
  /** See `SearchInput.recordStats`: the cross-store router records the merged query once. */
  recordStats?: boolean
  /**
   * Receives the full `HybridResult` (floors, per-leg floor drops, used tokens) after the search.
   *
   * `search` answers with the hits only, because that is what its callers want; the cross-store
   * router still has to fold THIS store's floor drops into the one merged `kb_query` result, and a
   * store-level "last result" field would race two concurrent queries.
   */
  onResult?: (result: HybridResult<RecallHit>) => void
}

/** Refuse absurd inputs at the ingestion boundary (paste/URI/file all funnel through here). */
const MAX_DOC_CHARS = 20_000_000
/** How many skipped paths an import reports; `skipped_total` carries the true count. */
const SKIPPED_REPORTED = 20
/** Byte cap applied BEFORE reading a file / downloading a URL (UTF-8 worst case ×4). */
const MAX_DOC_BYTES = MAX_DOC_CHARS * 4
/** A `source_uri` fetch must not hang the tool call. */
const FETCH_TIMEOUT_MS = 30_000
/** Per-chunk entity cap so chunk_entities stays bounded on long chunks. */
const MAX_ENTITIES_PER_CHUNK = 32

/** Redirects followed before giving up (each hop is re-validated). */
const MAX_REDIRECTS = 5

/** Human label for a path that is not a regular file, for the refusal message. */
function fileKind(st: Stats): string {
  if (st.isDirectory()) return '目录'
  if (st.isFIFO()) return 'FIFO（命名管道）'
  if (st.isSocket()) return 'socket'
  if (st.isCharacterDevice()) return '字符设备'
  if (st.isBlockDevice()) return '块设备'
  return '特殊文件'
}

/**
 * Read one local document with the two guards that must run BEFORE the read.
 *
 *  - REGULAR FILES ONLY. `readFileSync` on a FIFO blocks until a writer appears, and
 *    because it is synchronous that freezes the whole host event loop — the size check
 *    cannot save it, since a FIFO reports `size === 0`. A `.md`-named FIFO is reachable
 *    both as a direct `source_uri` (the agent has a shell) and by walking an imported
 *    directory, so the check belongs at the read.
 *  - BYTE CAP FIRST: `MAX_DOC_CHARS` lives inside `ingest`, where it can only run after
 *    the whole body is already in memory (see `ingestUri`'s docstring).
 */
async function readLocalDocument(path: string): Promise<DocumentText> {
  const st = statSync(path)
  if (!st.isFile()) throw new Error(`不是普通文件（${fileKind(st)}）—— 拒绝读取：${path}`)
  if (st.size > MAX_DOC_BYTES) throw new Error(`源文件过大：${st.size} 字节（上限 ${MAX_DOC_BYTES}）`)
  // Bytes, not text: a PDF has to be extracted and anything else binary has to be refused
  // (`readFileSync(path, 'utf8')` used to turn both into garbage chunks that looked ingested).
  return await documentText(readFileSync(path), path)
}

/**
 * Fetch an `http(s)` document with a hard byte cap and timeout, aborting as soon
 * as the cap is exceeded instead of buffering an unbounded body.
 *
 * Redirects are followed MANUALLY so every hop can be re-checked by
 * {@link assertFetchableUrl}: the transport's own follow would happily carry a
 * public URL into `127.0.0.1`, which is precisely what the boundary exists to stop.
 */
async function fetchTextCapped(uri: string, limits: IngestLimits): Promise<DocumentText> {
  let target = assertFetchableUrl(uri, limits)
  for (let hop = 0; ; hop++) {
    const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (location === null) throw new Error(`抓取失败：${target.href} —— ${res.status} 但响应里没有 Location 头`)
      if (hop >= MAX_REDIRECTS) throw new Error(`重定向次数过多：${uri}（上限 ${MAX_REDIRECTS}）`)
      target = assertFetchableUrl(new URL(location, target).href, limits)
      continue
    }
    if (!res.ok) throw new Error(`抓取失败：${target.href} —— ${res.status} ${res.statusText}`)
    const declared = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_DOC_BYTES) {
      throw new Error(`远端文档过大：${declared} 字节（上限 ${MAX_DOC_BYTES}）`)
    }
    // Bytes first: the body may be a PDF (which cannot be decoded as it streams) or a binary we
    // must refuse, and both decisions need the leading bytes rather than the content type.
    const chunks: Uint8Array[] = []
    let bytes = 0
    if (res.body === null) {
      chunks.push(new Uint8Array(await res.arrayBuffer()))
    } else {
      const body = res.body as unknown as AsyncIterable<Uint8Array>
      for await (const chunk of body) {
        bytes += chunk.byteLength
        if (bytes > MAX_DOC_BYTES) {
          throw new Error(`远端文档过大：超过 ${MAX_DOC_BYTES} 字节（上限）`)
        }
        chunks.push(chunk)
      }
    }
    return await documentText(Buffer.concat(chunks), target.href)
  }
}

/**
 * Knowledge store: `domain → source → chunk` documents. Backed by knowledge.db
 * (`documents` / `doc_chunks` / `chunk_entities` + trigram FTS). Chunking, entity
 * extraction (at ingest time) and FTS/entity/semantic search live here; the
 * cross-store fusion happens in the router.
 */
/**
 * Vectors per write TRANSACTION. The window bounds each encoded ITEM, so this is purely about
 * amortizing the commit (measured 14.2 µs/row autocommit vs 2.2 µs/row in one transaction); 16
 * keeps a batch's write lock to a handful of UPDATEs.
 */
const WRITE_BATCH = 16

/** How long a candidate file must hold still before it is adopted (see `adoptUnclaimed`). */
const ADOPT_SETTLE_MS = 250

/**
 * One identity a write will land on: the title it will use, the resolved local path it would read
 * (absent for text/URL), and — when the identity is taken — the document already sitting on it.
 */
export interface IngestTarget {
  title: string
  path?: string
  existing?: KbIngestConflict
}

/**
 * What the plan stage resolved, with NO file content read and NO network touched (see
 * {@link KnowledgeStore.ingestRequest}). A directory is expanded to its ingestable FILES here, so
 * the `existing` test uses the basename identity `importPaths` actually writes.
 */
export interface IngestPlan {
  kind: 'text' | 'url' | 'file' | 'paths'
  /** The pasted body (kind `text`). */
  text?: string
  /** The URL, or the `realpath` of the local file (kinds `url`/`file`). */
  uri?: string
  /** The caller's paths (kind `paths`), for the replace dispatch through `importPaths`. */
  paths?: string[]
  /** Every ingestable file the request expands to. */
  files: string[]
  /** Files a directory walk refused by format (reported by a batch import). */
  skipped: string[]
  targets: IngestTarget[]
}

/** One ingestion request, whichever field it came from. `overwrite` only matters in replace mode. */
export interface IngestRequest {
  text?: string
  source_uri?: string
  paths?: string[]
  domain: string
  source?: string
  title?: string
  overwrite?: boolean
}

/** The two runtime faces of {@link KnowledgeStore.ingestRequest}. */
export type IngestMode = 'add' | 'replace'

/** The add-only refusal, naming the collision and the two ways out. */
function addConflictMessage(conflict: KbIngestConflict): string {
  return `已存在同一篇文档（doc_id=${String(conflict.doc_id)}，标题「${conflict.title}」）：只新增、不覆盖。`
    + `它的受管文件：${conflict.path}。`
    + '要另存一篇，换一个标题；要修改这一篇，改那份 .md 文件后索引会自动跟随。'
}

/** The knowledge FTS table; its tokenizer is read from the database at open (see `ftsTokenizer`). */
const KNOWLEDGE_FTS_TABLE = 'doc_chunks_fts'

export class KnowledgeStore {
  private readonly db: Db
  /**
   * The tokenizer `doc_chunks_fts` was ACTUALLY built with, read from the database at open.
   *
   * Not `resolveFtsTokenizer()`: `CREATE VIRTUAL TABLE IF NOT EXISTS` never rebuilds an existing
   * table, so a database created under another SQLite build keeps the tokenizer it was born with,
   * and building MATCH expressions for the wrong one is silent zero recall (see `db/tokenizer.ts`).
   */
  private readonly ftsTokenizer: FtsTokenizer
  private readonly config: Config
  private readonly kbConfig: KnowledgeConfig
  /** All SQL for this store lives behind these (DESIGN §19). */
  private readonly docs: DocumentsDao
  private readonly chunks: ChunksDao
  /** The editable `.md` copy of every document (`knowledge.docs.dir`). */
  private readonly docFiles: DocFiles
  /** > 0 while a batch (directory import) is writing: commits and baseline refreshes wait. */
  private deferCorpusWrites = 0

  /**
   * Per-file stamps (`path → mtimeMs:size`) and the file-set they were taken from, so a reconcile
   * can ask "what changed?" for the price of one `stat` per document instead of reading and
   * hashing the whole corpus. `null` = no baseline yet.
   */
  private corpusStamps: Map<string, string> | null = null
  private corpusFileSet: string | null = null
  /** Version control for the corpus (`knowledge.git`); a failure here is never fatal. */
  private readonly corpusGit: GitRepo
  /**
   * The LIVE domain allowlist — seeded at boot from `knowledge.domains` ∪ the library's existing
   * domains, then kept in step with the store config by {@link addDomain}. The config itself is
   * read once at startup (layer ③ of `loader.ts`), so a freshly added domain must land HERE or the
   * very next write would refuse it until a restart.
   */
  private readonly allowedDomains: Set<string>
  /** Whether the config allowlist is active (non-empty); `false` = `domains: []` = no restriction. */
  private readonly domainsRestricted: boolean

  constructor(
    dbPath: string,
    config: Config,
    kbConfig: KnowledgeConfig,
    private readonly semantic: SemanticBackend,
    private readonly vstore: VectorStore,
    private readonly reranker: Reranker,
    /** The store config file `addDomain` writes the allowlist back to (`knowledgeConfigPath(home)`). */
    private readonly domainConfigPath: string,
    private readonly logger?: AvantfLogger,
  ) {
    this.config = config
    this.kbConfig = kbConfig
    const opened = openKnowledgeStore(dbPath)
    // Same rule as the memory store: report only an actual upgrade, so a normal boot stays quiet.
    if (wasUpgraded(opened.migration)) {
      logger?.info(`knowledge: ${describeMigrationOutcome(KNOWLEDGE_SCHEMA, opened.migration)}`)
    }
    this.db = opened.db
    const detectedFts = detectFtsTokenizer(this.db, KNOWLEDGE_FTS_TABLE)
    this.ftsTokenizer = detectedFts ?? resolveFtsTokenizer()
    reportFtsTokenizerDrift('kb index', KNOWLEDGE_FTS_TABLE, detectedFts, 'kb_reindex')
    this.docs = new DocumentsDao(this.db)
    this.chunks = new ChunksDao(this.db)
    this.docFiles = new DocFiles(kbConfig.docs.dir)
    this.domainsRestricted = kbConfig.domains.length > 0
    this.allowedDomains = new Set(kbConfig.domains)
    for (const domain of this.docs.domains()) this.allowedDomains.add(domain)
    this.corpusGit = new GitRepo({
      root: kbConfig.git.root,
      mode: kbConfig.git.mode,
      ignore: kbConfig.git.ignore,
      logger,
    })
    // Same as the memory store: let the index cache itself beside the database, space-qualified,
    // so the reload below can restore the graph instead of rebuilding it at every startup.
    const cachePrefix = vectorCachePath(dbPath, this.vectorSpace())
    if (cachePrefix !== null) this.vstore.attachPersistence?.(cachePrefix)
    this.reloadIndex()
  }

  /**
   * Rebuild the in-memory vstore from persisted chunk vectors.
   *
   * Also detects a VECTOR-SPACE change, which the reload itself cannot see: `reloadVectorIndex`
   * checks the width, and a different model at the same width produces dim-valid vectors that are
   * then ranked against the current query's — two spaces mixed in one index, with no error anywhere.
   * The memory store always said something about this; the knowledge store did not, so a model swap
   * degraded every semantic query here until someone happened to run `kb_reindex`.
   */
  private reloadIndex(): void {
    const space = this.vectorSpace()
    const persisted = this.chunks.vectorRows()
    reloadVectorIndex(this.vstore, persisted, 'knowledge')
    reportForeignVectors(
      'knowledge',
      space,
      persisted.filter((r) => r.embedding_model !== space).length,
      'kb_reindex (dry_run=true previews the count)',
    )
  }

  /**
   * The write-side domain allowlist AND the 知识页 picker's data, in one place: the configured
   * `knowledge.domains` allowlist ∪ the domains already present in `documents` ∪ the domains added
   * through {@link addDomain} this session.
   *
   * `restricted: false` means the allowlist is EXPLICITLY empty (`domains: []`), the documented
   * "no restriction" value. The union half is not a compatibility layer: without it, narrowing
   * the allowlist would make every existing document un-re-ingestable, and the picker would offer
   * a name the store then refuses.
   */
  domainCatalog(): { domains: string[]; restricted: boolean } {
    return { domains: [...this.allowedDomains], restricted: this.domainsRestricted }
  }

  /** Refuse a `domain` outside the allowlist, naming every value that IS allowed. */
  private assertDomainAllowed(domain: string): void {
    // Explicit `[]` = no restriction: neither a check nor a query.
    if (!this.domainsRestricted) return
    // The live set holds the config allowlist, the library's domains and this session's additions,
    // so the ordinary write is one membership test and never touches the database.
    if (this.allowedDomains.has(domain)) return
    // Slow path only (the write is about to be refused): another PROCESS may have added a document
    // in this domain since this store booted, and "the library's existing domains stay usable" must
    // not depend on which process wrote them.
    if (this.docs.domains().includes(domain)) {
      this.allowedDomains.add(domain)
      return
    }
    throw new Error(
      `知识域「${domain}」不在允许清单里：${[...this.allowedDomains].join('、')}。`
      + '新增领域请改配置 knowledge.domains（空数组 = 不限制），或在界面用「+」新增。',
    )
  }

  /**
   * Add one domain to the live allowlist AND to the store config's `domains` list.
   *
   * The UI-only path (`kbAddDomain`) — deliberately NOT an agent tool: the asymmetry is the point,
   * because an autonomous writer is exactly where domain sprawl would come from. The store owns the
   * rules (trim / reject path separators / treat an existing name as a selection) so both halves
   * agree, and it REFUSES while the allowlist is `[]` ("no restriction"): appending to an unfettered
   * list would silently turn it into a restricted one.
   */
  addDomain(raw: string): { domains: string[]; restricted: boolean } {
    const domain = raw.trim()
    if (domain === '') throw new Error('知识域不能为空')
    // The name becomes one level of the managed path (`docs/<domain>/<source>/<title>.md`) and
    // `sanitizeSegment` would rewrite a separator — so the picker would show a name that is not the
    // directory name. Refuse instead of writing something the user did not type.
    if (domain.includes('/') || domain.includes('\\')) {
      throw new Error(`知识域不能包含 “/” 或 “\\”：${domain}（它会成为受管目录的一级目录名）`)
    }
    // Already selectable (configured ∪ library ∪ added this session): a selection, not a write.
    if (this.allowedDomains.has(domain)) return this.domainCatalog()
    if (!this.domainsRestricted) {
      throw new Error('knowledge.domains 为空数组（不限制），不需要新增领域')
    }
    addKnowledgeDomain(this.domainConfigPath, domain)
    this.allowedDomains.add(domain)
    return this.domainCatalog()
  }

  /**
   * The shared ingestion entry: **① plan → ② classify → ③ dispatch**, in that fixed order.
   *
   * Stage ① resolves the domain allowlist, insists on one of `text`/`source_uri`/`paths`, derives
   * the identity every target will be written under, and looks each one up — using the SAME
   * {@link classifySource} the source picker uses, so the type (text / URL / local file / directory)
   * is decided once. Stage ① MUST NOT read a file or touch the network: identity only needs
   * `realpath`/`stat`/`readdir` plus the body of a pasted `text`, which the caller already holds. That
   * is what makes "conflict before read" observable (a colliding `source_uri` answers with the
   * collision even when the URL is unreachable or the file is a binary the reader would refuse).
   *
   * Stage ③ dispatches on the plan: `ingest` / `ingestUri` / `importPaths`. Those keep their
   * replace-by-identity semantics; this entry only puts the plan in front of them.
   *
   * The two modes are the two public faces:
   *  - `add` (`rt.kbAdd`, the model's `kb_add`): never replaces. A single collision throws an
   *    actionable Chinese error; a batch collision is per-file (see `importNew`), because one
   *    existing file in a 100-file import must not fail the other 99.
   *  - `replace` (`rt.kb`, the UI/CLI): a collision comes back as a {@link KbConflictReport} and
   *    writes NOTHING unless the caller confirmed with `overwrite: true`; then it re-runs the whole
   *    request. All-or-nothing, so a partial write can never sit behind a confirmation dialog.
   */
  async ingestRequest(req: IngestRequest, mode: IngestMode): Promise<IngestResult | ImportResult | KbConflictReport> {
    const source = req.source ?? DEFAULT_KB_SOURCE
    const plan = this.planIngest({ ...req, source })
    const conflicts = plan.targets.flatMap((target) => (target.existing === undefined ? [] : [target.existing]))
    if (mode === 'add') return this.runAdd(plan, req.domain, source)
    if (conflicts.length > 0 && req.overwrite !== true) {
      return this.conflictReport(conflicts, plan.targets.length - conflicts.length)
    }
    return this.runReplace(plan, req.domain, source)
  }

  /**
   * Stage ①/②: resolve the request to its targets without reading anything.
   *
   * `paths` wins over `text`, which wins over `source_uri` — the same precedence the old
   * `kb_add`/`rt.kb` split applied, kept so a call that sends two fields means the same thing.
   */
  private planIngest(req: IngestRequest & { source: string }): IngestPlan {
    this.assertDomainAllowed(req.domain)
    if (req.paths !== undefined && req.paths.length > 0) return this.planPaths(req.paths, req.domain, req.source)
    if (req.text !== undefined && req.text !== '') return this.planText(req.text, req.domain, req.source, req.title)
    if (req.source_uri !== undefined && req.source_uri !== '') return this.planUri(req.source_uri, req.domain, req.source, req.title)
    throw new Error('入库需要 text、source_uri 或 paths 三者之一。')
  }

  /** One target's identity plus whatever document already owns it. */
  private target(title: string, path: string | undefined, domain: string, source: string): IngestTarget {
    const row = this.docs.find(domain, source, title)
    const existing = row === null
      ? undefined
      : { doc_id: row.doc_id, title: row.title, path: this.docFilePathOf(row) }
    return { title, ...(path === undefined ? {} : { path }), ...(existing === undefined ? {} : { existing }) }
  }

  private planText(text: string, domain: string, source: string, title?: string): IngestPlan {
    // `deriveDocTitle`, never `source`: `source` defaults to one shared value, so using it would
    // collapse every untitled paste in a domain onto one identity (the data-loss defect).
    return { kind: 'text', text, files: [], skipped: [], targets: [this.target(title ?? deriveDocTitle(text), undefined, domain, source)] }
  }

  private planUri(uri: string, domain: string, source: string, title?: string): IngestPlan {
    const info = classifySource(uri, this.ingestLimits)
    if (info.kind === 'url') {
      // A URL's identity IS the URL string, so the collision is known before the fetch.
      return { kind: 'url', uri, files: [], skipped: [], targets: [this.target(title ?? uri, undefined, domain, source)] }
    }
    if (info.kind === 'file') {
      const path = info.paths[0]!
      return { kind: 'file', uri: path, files: [path], skipped: [], targets: [this.target(title ?? basename(path), path, domain, source)] }
    }
    if (info.kind === 'directory') throw new Error(`source_uri 是目录 —— 目录请用 kb import：${info.paths.join('、')}`)
    throw new Error(info.kind === 'missing'
      ? info.reasons[0] ?? `找不到 source_uri：${uri}`
      : `source_uri 不是 http(s) URL，也不是存在的本地路径：${uri}`)
  }

  /**
   * A batch request: each caller path is classified (file or directory) and a directory is WALKED
   * for its ingestable files. Only the walk filters by extension — an explicitly named file is taken
   * as given, exactly like `importPaths`. Target identity is each FILE's `basename`, which is the
   * identity `importPaths` actually writes (never the directory name).
   */
  private planPaths(paths: string[], domain: string, source: string): IngestPlan {
    const files: string[] = []
    const skipped: string[] = []
    const targets: IngestTarget[] = []
    for (const raw of paths) {
      const info = classifySource(raw, this.ingestLimits)
      if (info.kind === 'missing') throw new Error(info.reasons[0] ?? `导入路径不存在：${raw}`)
      if (info.kind === 'url' || info.kind === 'text') throw new Error(`导入路径必须是本地文件或目录：${raw}`)
      for (const path of info.paths) {
        const walked = statSync(path).isDirectory() ? listTextFiles(path) : { files: [path], skipped: [] }
        files.push(...walked.files)
        skipped.push(...walked.skipped)
        for (const file of walked.files) targets.push(this.target(basename(file), file, domain, source))
      }
    }
    return { kind: 'paths', paths: [...paths], files, skipped, targets }
  }

  /** Stage ③, add mode: refuse a single collision, and split a batch's collisions into `failed`. */
  private async runAdd(plan: IngestPlan, domain: string, source: string): Promise<IngestResult | ImportResult> {
    if (plan.kind === 'paths') return this.importNew(plan, domain, source)
    const target = plan.targets[0]!
    if (target.existing !== undefined) throw new Error(addConflictMessage(target.existing))
    if (plan.kind === 'text') return this.ingest(plan.text!, domain, source, target.title)
    return this.ingestUri(plan.uri!, domain, source, target.title)
  }

  /**
   * Batch add: the plan already knows which targets exist, so those are reported in `failed` (with
   * the actionable text) and only the NEW files are handed to `importPaths`. Passing the expanded
   * file list — not the caller's directories — is what keeps a walk from re-writing a colliding
   * file; the walk's own `skipped` list is carried over because explicit files are never filtered.
   */
  private async importNew(plan: IngestPlan, domain: string, source: string): Promise<ImportResult> {
    const conflicts = plan.targets.filter((target) => target.existing !== undefined)
    const fresh = plan.targets.flatMap((target) => (target.existing === undefined && target.path !== undefined ? [target.path] : []))
    const result: ImportResult = fresh.length > 0
      ? await this.importPaths(fresh, domain, source)
      : { imported: [], failed: [], skipped: [], skipped_total: 0 }
    return {
      imported: result.imported,
      failed: [
        ...conflicts.map((target) => ({ path: target.path ?? target.title, error: addConflictMessage(target.existing!) })),
        ...result.failed,
      ],
      skipped: plan.skipped.slice(0, SKIPPED_REPORTED),
      skipped_total: plan.skipped.length,
    }
  }

  /** Stage ③, replace mode (the caller confirmed, or nothing collided). */
  private async runReplace(plan: IngestPlan, domain: string, source: string): Promise<IngestResult | ImportResult> {
    if (plan.kind === 'paths') return this.importPaths(plan.paths!, domain, source)
    if (plan.kind === 'text') return this.ingest(plan.text!, domain, source, plan.targets[0]!.title)
    return this.ingestUri(plan.uri!, domain, source, plan.targets[0]!.title)
  }

  /** The machine-readable "nothing was written; confirm to overwrite" answer (UI + CLI). */
  private conflictReport(conflicts: KbIngestConflict[], wouldAdd: number): KbConflictReport {
    const named = conflicts.map((conflict) => `doc_id=${String(conflict.doc_id)}「${conflict.title}」`).join('、')
    return {
      conflict: true,
      error: `已存在同名文档：${named}。本次没有写入任何内容；确认覆盖请带 overwrite=true 重试。`,
      conflicts,
      would_overwrite: conflicts.length,
      would_add: wouldAdd,
    }
  }

  /**
   * Add one document from TEXT, and never replace an existing one.
   *
   * This is the PASTE entry point of the add-only face, and the distinction is the whole point:
   * `ingest` is replace-by-identity (what `ingestUri`, `importPaths`, `sync`'s re-ingest and `adopt`
   * need), while a paste that lands on an existing identity is an ADD mistake — the user meant to
   * save a new note, not to overwrite the one already filed. So this refuses instead of writing
   * anything, naming the document it collided with (its `doc_id`, title and managed file) so the
   * caller can choose a different title or edit that file.
   */
  async ingestNew(
    text: string,
    domain: string,
    source: string = DEFAULT_KB_SOURCE,
    title?: string,
  ): Promise<IngestResult> {
    return await this.ingestRequest({ text, domain, source, title }, 'add') as IngestResult
  }

  /**
   * Ingest one document: chunk (paragraph/heading aware), persist chunks + entities,
   * then encode vectors. Fully awaited — when ingest resolves, the document is
   * searchable through every path (FTS, entity, semantic).
   */
  async ingest(
    text: string,
    domain: string,
    // The `source` default lives HERE, not only in the contract: `source` is part of the document
    // identity `(domain, source, title)`, and a caller that bypasses the contract (`rt.kb(...)` /
    // a direct store call) used to produce the identity `domain/undefined/title` and then fail with
    // "upsert 之后找不到自己的行". The default belongs with the identity rule it protects.
    source: string = DEFAULT_KB_SOURCE,
    title?: string,
    sourceUri?: string,
    encoding?: string,
    /** What the automatic git commit should say this was (`adopt` = recovered from an overwrite). */
    gitAction: 'ingest' | 'sync' | 'adopt' = 'ingest',
    /** The converter that produced `text` (absent for text/PDF and for a body re-read from disk). */
    converter?: string,
    /** What that conversion could not carry over. */
    warnings?: string[],
  ): Promise<IngestResult> {
    this.assertDomainAllowed(domain)
    if (text.length > MAX_DOC_CHARS) throw new Error(`文档过大：${text.length} 字符（上限 ${MAX_DOC_CHARS}）`)
    const chunks = chunkText(text, this.kbConfig.chunk_size, this.kbConfig.chunk_overlap)
    // `source` no longer doubles as a title: it defaults to one shared value, so a paste without a
    // title would land on one identity per domain. The title is DERIVED from the body instead
    // (`ingestUri`/`importPaths` pass an explicit basename or URL, so they never reach this fallback).
    const docTitle = title ?? deriveDocTitle(text)
    // IMMEDIATE, not the default DEFERRED: this is a read-modify-write (upsert the doc → read the
    // old chunk ids → delete → re-insert) and a DEFERRED transaction takes its write lock only at the
    // first write, AFTER the reads. A shared data home is a supported shape (plugin and CLI at once),
    // so two processes ingesting the same document could both read, then commit in either order: the
    // later committer deletes the earlier one's chunk rows while the earlier one still encodes and
    // `setVector`s those now-dead chunk ids — leaving phantom vectors in the live index. Taking the
    // write lock up front serializes the pair, like `memory.ts` does for the same shape.
    const tx = this.db.transaction(() => {
      const docId = this.docs.upsert(domain, source, docTitle, sourceUri)
      const oldChunkIds = this.chunks.idsForDoc(docId)
      // Read the vectors BEFORE the replace, keyed by content hash: a chunk whose text did not
      // change keeps its embedding instead of paying the ONNX forward pass again. `--overwrite`, a
      // repeated ingest and `adoptUnclaimed` (recovering an overwritten file) all take this path.
      const reusable = this.reusableByHash(docId, this.vectorSpace())
      this.chunks.deleteForDoc(docId) // re-ingest replaces chunks
      this.docs.touch(docId, sourceUri)
      const newChunkIds = this.chunks.insertMany(
        docId,
        chunks.map((chunk, idx) => ({
          idx,
          text: chunk.text,
          headingsPath: chunk.headingsPath,
          sourceRef: `${domain}:${source}:${docId}:${idx}`,
          charStart: chunk.start,
          charEnd: chunk.end,
        })),
      )
      return { doc_id: docId, oldChunkIds, newChunkIds, reusable }
    })
    const result = tx.immediate()
    this.evictVectors(result.oldChunkIds)
    const indexed = await this.indexChunks(result.newChunkIds, result.reusable)
    return {
      doc_id: result.doc_id,
      chunks: chunks.length,
      // Absent when every chunk was indexed, so a healthy ingest stays as quiet as it was.
      ...(indexed.vectors_failed === 0 ? {} : { vectors_failed: indexed.vectors_failed }),
      // How the bytes became this text (`utf-8` / `utf-8-bom` / `utf-16le` / `utf-16be` / `gb18030`,
      // or nothing at all for pasted text and PDF text layers). Reported so a decode GUESS is
      // visible in the tool result instead of silently shaping the corpus.
      ...(encoding === undefined ? {} : { encoding }),
      // Which converter produced the body, and what it warned about. A converted document is the
      // one ingest path whose body is derived rather than read, so both travel to the caller.
      ...(converter === undefined ? {} : { converter }),
      ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }),
      // The managed copy is written AFTER the index is live, and a failure here must not fail the
      // ingest: the document is searchable either way, and `sync` reports the document as
      // `missing` so the user sees why the file buttons have nothing to open.
      ...this.writeManagedFile(result.doc_id, { domain, source, title: docTitle, sourceUri, converter }, text, gitAction),
    }
  }

  /** Materialize one document's editable copy; returns the `file` / `file_error` result fields. */
  private writeManagedFile(
    docId: number,
    doc: { domain: string; source: string; title: string; sourceUri?: string; converter?: string },
    body: string,
    action: 'ingest' | 'sync' | 'adopt',
  ): { file?: string; file_error?: string } {
    try {
      const file = this.docFiles.write({
        doc_id: docId,
        domain: doc.domain,
        source: doc.source,
        title: doc.title,
        source_uri: doc.sourceUri ?? null,
        ingested_at: new Date().toISOString(),
        content_hash: bodyHash(body),
        // Omitted (not `null`) for text/PDF: `renderDocFile` drops undefined keys, so an old file
        // and a newly ingested text file stay byte-identical.
        ...(doc.converter === undefined ? {} : { converter: doc.converter }),
      }, body)
      // Version the corpus (never fatal; see `DocGit`). Committed AFTER the write so the tree the
      // commit records is the one on disk.
      this.commitCorpus(`${action}: ${doc.domain}/${doc.source}/${doc.title}`)
      return { file }
    } catch (error) {
      return { file_error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Batched eviction from the live vector index (removeMany when the backend supports it). */
  private evictVectors(ids: number[]): void {
    evictVectorsOf(this.vstore, ids)
  }

  /** The resolved ingestion boundary (see `ingest_guard.ts`). */
  private get ingestLimits(): IngestLimits {
    return this.kbConfig.ingest
  }

  /**
   * Ingest from a source URI (DESIGN D5): local file paths (workspace files are the
   * priority source) are read from disk; `http(s)` URIs are fetched. The URI itself
   * is NEVER stored as the document body — that was the old broken behavior.
   *
   * Both paths are bounded BEFORE materializing the content (the `MAX_DOC_CHARS`
   * guard inside `ingest` can only run once the whole body is already in memory),
   * and both are checked against the ingestion boundary: a local path must resolve
   * inside the allowed roots and a URL must not address private space (see
   * `ingest_guard.ts`).
   *
   * The URL-vs-path decision goes through the store's ONE classifier ({@link classifySource}, the
   * same one the source picker and the plan stage use) — a second `^https?://` test here would be a
   * second answer to "what is this string".
   */
  async ingestUri(uri: string, domain: string, source: string = DEFAULT_KB_SOURCE, title?: string): Promise<IngestResult> {
    const info = classifySource(uri, this.ingestLimits)
    let decoded: DocumentText
    let resolvedTitle = title
    let storedUri = uri
    if (info.kind === 'url') {
      decoded = await fetchTextCapped(uri, this.ingestLimits)
      resolvedTitle ??= uri
    } else if (info.kind === 'file') {
      // `paths[0]` is the `realpath` the classifier resolved through the boundary; `readLocalDocument`
      // owns the regular-file + byte-cap checks (a FIFO here would block `readFileSync` forever).
      const p = info.paths[0]!
      decoded = await readLocalDocument(p)
      resolvedTitle ??= basename(p)
      // Record the path that was actually read: it is the `realpath`, which a later
      // `kb_doc_detail` can be trusted to point at the same file.
      storedUri = p
    } else if (info.kind === 'directory') {
      throw new Error(`source_uri 是目录 —— 目录请用 kb import：${info.paths.join('、')}`)
    } else {
      throw new Error(info.kind === 'missing'
        ? info.reasons[0] ?? `找不到 source_uri：${uri}`
        : `source_uri 不是 http(s) URL，也不是存在的本地路径：${uri}`)
    }
    return this.ingest(
      decoded.text, domain, source, resolvedTitle, storedUri, decoded.encoding, 'ingest',
      decoded.converter, decoded.warnings,
    )
  }

  /**
   * Extract entities per chunk (persisted) and encode/persist chunk vectors.
   *
   * Returns how many chunks did NOT get a vector, so the caller can put it in the tool result. A
   * missing model counts every chunk that had no reusable vector: the document is still searchable by
   * text and entity, but not semantically, and "入库成功 N 段" must not imply otherwise.
   */
  private async indexChunks(chunkIds: number[], reusable?: ReadonlyMap<string, Buffer>): Promise<{ vectors_failed: number }> {
    if (!chunkIds.length) return { vectors_failed: 0 }
    const rows = this.chunks.texts(chunkIds)
    await this.replaceChunkEntities(rows)
    // Record what produced the rows, so a later reindex can tell "already done" from "stale"
    // instead of re-extracting the whole corpus (DESIGN §20).
    this.chunks.setEntitiesVersion(rows.map((r) => r.chunk_id), ENTITY_EXTRACTOR_VERSION)
    const space = this.vectorSpace()
    // Reuse FIRST, and before the model is even consulted: the vector of an unchanged chunk is
    // already in the database AND in hand, so it costs no encode — and when the model is unavailable
    // this is what keeps a re-ingest from dropping vectors it did not have to drop.
    const { remaining } = this.writeReusedVectors(rows, space, reusable)
    if (!this.semantic.isAvailable()) {
      // Observing call site: keep a failed bootstrap retryable (see warm_gate.ts).
      this.semantic.ensureWarm?.()
      return { vectors_failed: remaining.length }
    }
    const { failed } = await this.encodeAndStore(remaining, space)
    return { vectors_failed: failed }
  }

  /**
   * The doc's stored vectors that still APPLY, keyed by content hash (see {@link vectorReusable}).
   *
   * Called inside the ingest transaction, before the replace: two chunks with the same text are one
   * hash, and the first row wins — the reuse is only a cache lookup, so a duplicate entry cannot be
   * distinguished from a hit and need not be.
   */
  private reusableByHash(docId: number, space: string): Map<string, Buffer> {
    const out = new Map<string, Buffer>()
    for (const row of this.chunks.vectorStateForDoc(docId)) {
      if (row.vec === null || row.content_hash === null) continue
      if (!this.vectorReusable(row, space)) continue
      if (!out.has(row.content_hash)) out.set(row.content_hash, row.vec)
    }
    return out
  }

  /**
   * Write back the vectors a re-ingest can reuse, and report which rows still need the model.
   *
   * A row is only reused when the lookup misses nothing: any row whose write fails, or whose text has
   * no reusable vector, comes back in `remaining` and is encoded as before — so the reuse path cannot
   * leave a chunk unindexed that the plain path would have indexed.
   */
  private writeReusedVectors(
    rows: readonly { chunk_id: number; text: string }[],
    space: string,
    reusable: ReadonlyMap<string, Buffer> | undefined,
  ): { reused: number; remaining: { chunk_id: number; text: string }[] } {
    if (reusable === undefined || reusable.size === 0) return { reused: 0, remaining: [...rows] }
    const remaining: { chunk_id: number; text: string }[] = []
    const writes: { chunk_id: number; bytes: Buffer; embeddingModel: string; text: string }[] = []
    for (const r of rows) {
      const bytes = reusable.get(contentHash(r.text))
      if (bytes === undefined) remaining.push(r)
      else writes.push({ chunk_id: r.chunk_id, bytes, embeddingModel: space, text: r.text })
    }
    if (writes.length === 0) return { reused: 0, remaining }
    try {
      // The DB write is the all-or-nothing one; the live index follows it, and a failure there is
      // the benign direction (the next process reloads the on-disk vector).
      this.chunks.setVectors(writes)
    } catch {
      // Fall back to encoding: a failed write must not silently drop the chunk's vector.
      return { reused: 0, remaining: [...remaining, ...writes.map((w) => ({ chunk_id: w.chunk_id, text: w.text }))] }
    }
    for (const w of writes) {
      const vec = bytesToFloat32(w.bytes)
      if (vec !== null && vec.length === this.vstore.dim) this.vstore.add(w.chunk_id, vec)
    }
    return { reused: writes.length, remaining }
  }

  /**
   * Encode texts ONE AT A TIME, writing every `WRITE_BATCH` vectors in one transaction.
   *
   * The model call is deliberately NOT batched, and that is a MEASURED decision, not an omission:
   * a batched forward pass pads each item to the longest in its group, and real chunks span 53–550
   * characters (median 303). On 299 real chunks: serial 31.2 ms/text, batched in document order
   * 55.7 ms/text (1.79x SLOWER), batched after sorting by length 31.9 ms/text (a wash). Batching
   * only pays for SHORT homogeneous texts, which chunks are not — so the review's "batch the
   * encode" suggestion was tested and rejected. `LocalBgeBackend.encodeBatch` remains correct (and
   * length-sorted) for callers whose texts suit it.
   *
   * What DID pay off is the write side: one commit per `WRITE_BATCH` chunks instead of one per
   * chunk (measured 14.2 µs/row vs 2.2 µs/row), and the transaction never spans an `await`.
   */
  private async encodeAndStore(
    rows: readonly { chunk_id: number; text: string }[],
    space: string,
  ): Promise<{ encoded: number; failed: number }> {
    let encoded = 0
    let failed = 0
    for (let i = 0; i < rows.length; i += WRITE_BATCH) {
      const group = rows.slice(i, i + WRITE_BATCH)
      const writes: { chunk_id: number; bytes: Buffer; embeddingModel: string }[] = []
      for (const r of group) {
        // Every step of one chunk is inside the boundary: an encode failure (no model, bad input)
        // AND a write failure (SQLITE_BUSY under multi-process contention, dim mismatch) must skip
        // THAT chunk, not reject the whole ingest. The rows are already committed and their old
        // vectors evicted by this point, so a throw here would leave the caller with a failed ingest
        // and NO COUNT of what was skipped. The shortfall travels back to the tool result
        // (`IngestResult.vectors_failed`) instead of living only in a log line.
        try {
          const vec = await this.semantic.encode(r.text)
          this.vstore.add(r.chunk_id, vec)
          writes.push({ chunk_id: r.chunk_id, bytes: float32ToBytes(vec), embeddingModel: space })
        } catch {
          failed += 1
        }
      }
      if (!writes.length) continue
      try {
        this.chunks.setVectors(writes)
        encoded += writes.length
      } catch {
        failed += writes.length
        // The live index got these vectors in the loop above and the DB did not (setVectors is one
        // transaction, so it is all-or-nothing). Leaving them would be the divergence the memory side
        // calls out as the worse of the two failures: this process ranks chunks the next process
        // cannot see, and nothing else would ever mention it. Evict, so both sides agree on "the
        // vectors are missing" — which `kb_reindex` can then fix.
        this.evictVectors(writes.map((w) => w.chunk_id))
      }
    }
    if (failed > 0) {
      retrievalLogger().warn(
        `kb index: ${String(failed)} of ${String(rows.length)} chunk vector(s) were not written — run kb_reindex to retry `
        + `(the text/entity/FTS indexes are complete; only the semantic vectors are affected)`,
      )
    }
    return { encoded, failed }
  }

  /**
   * Identity of the vector space this store currently writes into (DESIGN §20): a change of
   * backend, model or width makes every stored chunk vector stale, and the whole point of
   * recording it is that such a change is DETECTED instead of silently mixing two spaces.
   */
  private vectorSpace(): string {
    return vectorSpaceOf(this.semantic, this.config.semantic.local_model)
  }

  /**
   * A stored vector is reusable when it exists, matches the space, and its text is unchanged.
   *
   * The three checks answer different questions, and the hash is deliberately the RAREST of them
   * to fire (see `db/hash.ts`): `ingest` replaces chunks rather than editing their text, so a
   * re-ingested change is caught by the missing vector, and a rule change by `entities_version`.
   * The hash is what catches a text mutation that skipped the ingest path entirely — without it
   * the store would keep serving a vector for text it no longer holds.
   */
  private vectorReusable(row: ChunkStateRow, space: string): boolean {
    if (row.has_vector !== 1) return false
    if (row.embedding_model !== space) return false
    return row.content_hash === contentHash(row.text)
  }

  /** One transaction replacing the entity rows of the given chunks (shared by ingest + reindex). */
  private async replaceChunkEntities(rows: { chunk_id: number; text: string }[], replace: boolean = false): Promise<void> {
    const extracted: { chunk_id: number; names: string[] }[] = []
    for (const r of rows) {
      const names = (await extractEntities(r.text)).map((e) => e.name).slice(0, MAX_ENTITIES_PER_CHUNK)
      extracted.push({ chunk_id: r.chunk_id, names })
    }
    this.chunks.replaceEntities(extracted, replace)
  }

  /**
   * Ingest local files/directories. Every path goes through the SAME boundary as
   * `ingestUri` — a bare `kb_import` on `~/.ssh` would otherwise be the exact
   * exfiltration hole the `source_uri` guard closes.
   *
   * Failure split: a caller-supplied path that is missing or out of bounds THROWS
   * (validating the arguments up front, and the operator needs to know), while a file
   * reached by walking a directory is reported in `failed` — the previous `catch {}`
   * dropped those silently, so "imported 60 of 100 files" was indistinguishable from
   * a complete import.
   */
  async importPaths(paths: string[], domain: string, source: string = DEFAULT_KB_SOURCE): Promise<ImportResult> {
    // Validate the domain up front: a directory whose entries are ALL skipped would otherwise
    // never reach `ingest`, and the call would look like a successful import of zero files.
    this.assertDomainAllowed(domain)
    // `~` is expanded BEFORE the existence check: `existsSync('~/x')` is always false, so
    // the pre-check used to reject every `~/…` path that `resolveLocalSource` — and the
    // settings page's `如 ~/docs` placeholder — promise to support.
    const expanded = paths.map((p) => expandHome(p))
    const missing = expanded.filter((p) => !existsSync(p))
    if (missing.length) throw new Error(`导入路径不存在：${missing.join('、')}`)
    const imported: IngestResult[] = []
    const failed: { path: string; error: string }[] = []
    const skipped: string[] = []
    // BATCH: a directory import used to produce one git commit AND one full stat pass per file
    // (3–5 git subprocesses each, plus O(N²) `stat` as `noteCorpusWrite` re-walked an
    // ever-growing corpus). Defer both and do them once, at the end.
    this.deferCorpusWrites += 1
    try {
      for (const p of expanded) {
      const root = resolveLocalSource(p, this.ingestLimits)
      const stat = statSync(root)
      // A caller-supplied path that is not a regular file is an argument error, like a
      // missing one — only entries reached by WALKING a directory go to `failed`.
      if (!stat.isDirectory() && !stat.isFile()) {
        throw new Error(`导入路径不是普通文件（${fileKind(stat)}）：${root}`)
      }
      // An explicitly named file is taken as given (any extension); only a WALKED directory entry
      // is filtered by format, and its rejections are reported instead of dropped.
      const walked = stat.isDirectory() ? listTextFiles(root) : { files: [root], skipped: [] }
      skipped.push(...walked.skipped)
      for (const f of walked.files) {
        try {
          // Boundary first: a walked entry that resolves outside the roots (a link) is
          // refused, not silently skipped either.
          const real = resolveLocalSource(f, this.ingestLimits)
          const decoded = await readLocalDocument(real)
          imported.push(await this.ingest(
            decoded.text, domain, source, basename(real), real, decoded.encoding, 'ingest',
            decoded.converter, decoded.warnings,
          ))
          } catch (error) {
            failed.push({ path: f, error: describeError(error) })
          }
        }
      }
    } finally {
      this.deferCorpusWrites -= 1
    }
    this.commitCorpus(`import: ${domain}/${source}（${String(imported.length)} 篇）`)
    return { imported, failed, skipped: skipped.slice(0, SKIPPED_REPORTED), skipped_total: skipped.length }
  }

  /**
   * One corpus commit + one baseline refresh, unless a batch is in flight.
   *
   * Every owned write calls this; `deferCorpusWrites` is what turns N writes into 1 commit during
   * an import. Never throws (`GitRepo` swallows), and the baseline refresh is a no-op until one
   * exists.
   */
  private commitCorpus(message: string): void {
    if (this.deferCorpusWrites > 0) return
    this.corpusGit.commit(message)
    this.noteCorpusWrite()
  }

  list(domain?: string, source?: string, limit?: number, offset?: number): DocumentSummary[] {
    return this.docs.list(domain, source, limit, offset)
  }

  detail(docId: number): DocumentDetail | null {
    const doc = this.docs.get(docId)
    if (!doc) return null
    return { ...doc, chunks: this.chunks.rowsForDoc(docId) }
  }

  remove(docId: number): boolean {
    const doc = this.docs.get(docId)
    if (doc === null) return false
    // The managed file goes FIRST, and a failure to delete it aborts the removal: the file and
    // the row are one document from the user's point of view, and a row deleted under a file that
    // is still there is exactly the inconsistency `sync` would then report as an orphan. A file
    // that is already gone is not an error.
    this.docFiles.remove(docId, doc.domain, doc.source, doc.title)
    const chunkIds = this.chunks.idsForDoc(docId)
    const removed = this.docs.remove(docId)
    // The most important commit of the four: the file it just deleted exists nowhere else, so this
    // history is the only way back.
    if (removed) this.commitCorpus(`remove: ${doc.domain}/${doc.source}/${doc.title}`)
    // The DB cascade removes chunks/entities/FTS; the live vector index needs explicit eviction,
    // or stale chunk vectors keep occupying semantic top-k slots until restart.
    this.evictVectors(chunkIds)
    return removed
  }

  /**
   * The managed path for a document ROW the caller already holds — skips the `docs.get` that
   * `docFilePath` does, which matters because `kb_list` needs a path for every row it renders.
   */
  docFilePathOf(doc: { doc_id: number; domain: string; source: string; title: string }): string {
    return this.docFiles.pathFor(doc.doc_id, doc.domain, doc.source, doc.title)
  }

  /** The managed file this document owns (whether or not it exists yet), or `null` for a missing doc. */
  docFilePath(docId: number): string | null {
    const doc = this.docs.get(docId)
    if (doc === null) return null
    return this.docFiles.pathFor(docId, doc.domain, doc.source, doc.title)
  }

  /**
   * Reconcile the managed files with what the KB indexed (DESIGN: knowledge maintenance).
   *
   * `dryRun` answers "what changed?" without touching the index — that is what the 知识 tab's list
   * uses to mark documents whose file was edited. Otherwise every STALE document is re-ingested
   * from its file body, which replaces its chunks and re-encodes its vectors (the document keeps
   * its `doc_id`: identity is `domain → source → title`, and the file records the same one).
   *
   * `missing` documents are reported, never invented: a file that was deleted by hand leaves the
   * indexed copy alone until the user deletes the document itself. `orphans` are managed files no
   * document claims — leftovers from a row deleted outside `remove` — and are only reported.
   */
  /**
   * Stat-only reconcile check: which managed files look changed since the last call, and whether
   * the file SET changed (a new or vanished `.md` — an orphan or a restore).
   *
   * Nothing here reads a file, so the common answer ("nothing changed") costs one `stat` per
   * document. A stamp is a TRIGGER, not a judgement: the caller re-ingests through `sync`, which
   * hashes the body and decides. The first call only seeds the baseline and reports nothing —
   * use `sync` once at startup if a process may have been down while the corpus changed.
   */
  corpusDrift(): { changed: number[]; missing: number[]; fileSetChanged: boolean } {
    const paths = this.docFiles.listPaths()
    const fileSet = paths.join('\n')
    const previous = this.corpusStamps
    const previousSet = this.corpusFileSet
    const stamps = new Map<string, string>()
    const changed: number[] = []
    const missing: number[] = []
    for (const doc of this.docs.list()) {
      // `basePath`, never `pathFor`: `pathFor` resolves a collision by READING the file's
      // frontmatter, so a file whose frontmatter was destroyed (a whole-file overwrite by an
      // editor or a `write` tool) makes it answer with a different, non-existent path — and the
      // edit would be invisible to exactly the check that exists to catch it. The base path is a
      // pure function of the identity, so it cannot be fooled.
      const path = this.docFiles.basePath(doc.domain, doc.source, doc.title)
      const stamp = this.docFiles.stamp(path)
      if (stamp === null) {
        // Only a CHANGE is reported: a file that was never there is not news.
        if (previous?.has(path) === true) missing.push(doc.doc_id)
        continue
      }
      stamps.set(path, stamp)
      if (previous !== null && previous.get(path) !== stamp) changed.push(doc.doc_id)
    }
    this.corpusStamps = stamps
    this.corpusFileSet = fileSet
    return { changed, missing, fileSetChanged: previousSet !== null && previousSet !== fileSet }
  }

  /**
   * Re-take the baseline after a write this store made ITSELF.
   *
   * Without this, every `ingest` would look like an external edit on the next drift check and cost
   * a redundant (if harmless) sync; with it, only edits from OUTSIDE the store are reported. Cheap:
   * one `stat` per document, no reads. A no-op until a baseline exists.
   */
  private noteCorpusWrite(): void {
    if (this.corpusStamps === null) return
    const stamps = new Map<string, string>()
    for (const doc of this.docs.list()) {
      const path = this.docFiles.basePath(doc.domain, doc.source, doc.title)
      const stamp = this.docFiles.stamp(path)
      if (stamp !== null) stamps.set(path, stamp)
    }
    this.corpusStamps = stamps
    this.corpusFileSet = this.docFiles.listPaths().join('\n')
  }

  /**
   * Take back a file that lost its frontmatter, when the caller explicitly asks for it.
   *
   * Cheap refusals, all of them deliberate: a file that CLAIMS another document is a collision and
   * is left alone; an EMPTY body is refused because `ingest` has no lower bound (`chunkText('')`
   * returns no chunks), so adopting one would silently replace a good document with nothing.
   */
  private async adoptUnclaimed(doc: DocumentSummary | undefined, opts: { settle: boolean }): Promise<number> {
    if (doc === undefined) return 0
    const base = this.docFiles.basePath(doc.domain, doc.source, doc.title)
    if (opts.settle) {
      // THE STAMP MUST BE STABLE. An editor saves by writing a temp file and renaming it over the
      // target, and an agent's `write` streams the body: mid-write, the file can be non-empty and
      // frontmatter-less, i.e. pass every other guard while being a half-written document.
      const first = this.docFiles.stamp(base)
      if (first === null) return 0
      await new Promise(resolve => setTimeout(resolve, ADOPT_SETTLE_MS))
      if (this.docFiles.stamp(base) !== first) return 0
    }
    const parsed = this.docFiles.read(base)
    if (parsed === null || parsed.meta.doc_id !== undefined || parsed.body.trim() === '') return 0
    await this.ingest(
      parsed.body, doc.domain, doc.source, doc.title, doc.source_uri ?? undefined, undefined, 'adopt',
      parsed.meta.converter,
    )
    return 1
  }

  async sync(opts: { docId?: number; dryRun?: boolean; adopt?: boolean } = {}): Promise<KbSyncReport> {
    const all = this.docs.list()
    const docs = opts.docId === undefined ? all : all.filter(doc => doc.doc_id === opts.docId)
    const stale: KbDocFile[] = []
    const missing: KbDocFile[] = []
    for (const doc of docs) {
      const state = this.docFiles.state(doc.doc_id, doc.domain, doc.source, doc.title)
      const entry: KbDocFile = {
        doc_id: doc.doc_id,
        title: doc.title,
        path: state.path,
        stale: state.stale,
        missing: state.missing,
      }
      if (state.missing) missing.push(entry)
      else if (state.stale) stale.push(entry)
    }
    // A single-document reconcile has no business walking the whole tree: `orphans` is a
    // corpus-level answer, and that walk is exactly the cost the per-document path exists to avoid.
    const known = new Set(all.map(doc => doc.doc_id))
    const orphans = opts.docId !== undefined
      ? []
      : this.docFiles
          .scan()
          .filter(file => file.doc_id === undefined || !known.has(file.doc_id))
          .map(file => file.path)
          .sort()
    // Adoptable = the document's own file is gone, and its PATH holds a file that claims nothing.
    // Every guard here is a refusal that was argued for explicitly (see CHANGELOG):
    //  - a file declaring ANY doc_id is not unclaimed, it is claimed — possibly by another document
    //    whose title sanitizes to the same file name (a collision we must not guess through);
    //  - an empty body is refused because `ingest` has no lower bound, so adopting one would
    //    silently empty a good document;
    //  - a path two documents share is refused for the same reason as the first.
    const baseCounts = new Map<string, number>()
    for (const doc of all) {
      const base = this.docFiles.basePath(doc.domain, doc.source, doc.title)
      baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
    }
    const unclaimed: KbUnclaimedFile[] = missing.flatMap((entry) => {
      const doc = docs.find(candidate => candidate.doc_id === entry.doc_id)
      if (doc === undefined) return []
      const base = this.docFiles.basePath(doc.domain, doc.source, doc.title)
      if ((baseCounts.get(base) ?? 0) !== 1) return []
      const parsed = this.docFiles.read(base)
      if (parsed === null || parsed.meta.doc_id !== undefined || parsed.body.trim() === '') return []
      return [{ doc_id: doc.doc_id, title: doc.title, path: base }]
    })
    if (opts.dryRun === true) {
      return { checked: docs.length, stale, missing, orphans, unclaimed, reingested: 0, adopted: 0, dry_run: true }
    }
    let adopted = 0
    if (opts.adopt === true && opts.docId !== undefined) {
      adopted += await this.adoptUnclaimed(docs[0], { settle: false })
    }
    // AUTOMATIC adoption, guarded. This is the path that makes "the agent overwrote the file with
    // `write` instead of editing it" recover on its own, instead of waiting for a human to press a
    // button — which is what the user asked for, WITH the refusals above plus the settle check.
    for (const entry of unclaimed) {
      adopted += await this.adoptUnclaimed(docs.find(candidate => candidate.doc_id === entry.doc_id), { settle: true })
    }
    let reingested = 0
    for (const entry of stale) {
      const doc = docs.find(candidate => candidate.doc_id === entry.doc_id)
      const parsed = doc === undefined ? null : this.docFiles.read(entry.path)
      if (doc === undefined || parsed === null) continue
      // `ingest`, never `ingestUri`: the body is already in hand, and the managed directory is not
      // necessarily inside `knowledge.ingest.local_roots` (it is not a user source at all). The
      // converter id is carried back over from the frontmatter: editing the Markdown of a converted
      // document must not silently erase where the document came from.
      await this.ingest(
        parsed.body, doc.domain, doc.source, doc.title, doc.source_uri ?? undefined, undefined, 'sync',
        parsed.meta.converter,
      )
      reingested += 1
    }
    return { checked: docs.length, stale, missing, orphans, unclaimed, reingested, adopted, dry_run: false }
  }

  /**
   * Rebuild the read model: FTS, per-chunk entities, and vectors — incrementally.
   *
   * `domain` scopes the rebuild to one knowledge domain. One corpus SELECT feeds both legs, and
   * each row is skipped when its derivation is provably still valid (same text digest, same
   * vector space, same extractor version). Without that, the only way to know whether a chunk
   * needed mission was to redo the mission: an ONNX forward pass plus a jieba pass per chunk over the
   * whole corpus, every time.
   *
   * `dryRun` answers "how much would this cost?" without writing anything — including without
   * the FTS rebuild, which is a write.
   */
  async reindex(domain?: string, opts?: { dryRun?: boolean }): Promise<ReindexReport> {
    const dryRun = opts?.dryRun === true
    const space = this.vectorSpace()
    const rows = this.chunks.corpusState(domain)
    const staleEntities = rows.filter((r) => r.entities_version !== ENTITY_EXTRACTOR_VERSION)
    // A row inserted before this state existed carries NULL for all three columns, so it looks
    // stale exactly once and is adopted by the first rebuild — that is the intended migration
    // path, and why the columns are nullable rather than defaulted to a guess.
    const staleVectors = rows.filter((r) => !this.vectorReusable(r, space))
    const semanticAvailable = this.semantic.isAvailable()
    const report: ReindexReport = {
      chunks: rows.length,
      entities_rebuilt: 0,
      vectors_stale: staleVectors.length,
      vectors_encoded: 0,
      semantic_available: semanticAvailable,
      dry_run: dryRun,
    }
    if (dryRun) return report

    this.chunks.rebuildFts()
    if (staleEntities.length) {
      await this.replaceChunkEntities(staleEntities, true)
      this.chunks.setEntitiesVersion(staleEntities.map((r) => r.chunk_id), ENTITY_EXTRACTOR_VERSION)
      report.entities_rebuilt = staleEntities.length
    }
    if (!semanticAvailable) {
      // Nothing can be re-encoded without the model, but ask for one so the next reindex (or
      // query) can finish the mission; `vectors_stale > vectors_encoded` is how a caller sees it.
      this.semantic.ensureWarm?.()
    } else if (staleVectors.length) {
      report.vectors_encoded = (await this.encodeAndStore(staleVectors, space)).encoded
    }
    // NO `reloadIndex()` here: the vectors were just added to the live index as they were encoded,
    // and a full reload re-read every BLOB in the corpus and rebuilt the store (measured 1.76 s
    // for a 4499-chunk corpus with ZERO stale chunks). Evictions are handled where they happen —
    // `ingest` and `remove` both call `evictVectors`.
    return report
  }

  close(): void {
    this.db.close()
  }

  count(): { documents: number; chunks: number } {
    return { documents: this.docs.count(), chunks: this.chunks.count() }
  }

  /** Chunk search over the knowledge corpus (semantic + FTS + entity, joint fusion). */
  async search(query: string, opts?: KnowledgeSearchOptions): Promise<RecallHit[]> {
    const result = await hybridSearch<RecallHit>(this.hybridDeps(opts), {
      query,
      limit: opts?.limit,
      overFetch: opts?.overFetch,
      maxTokens: opts?.maxTokens,
      queryVector: opts?.queryVector,
      recordStats: opts?.recordStats,
    })
    opts?.onResult?.(result)
    return result.hits
  }

  /**
   * This store's half of the shared orchestration (`store/hybrid.ts`): the legs, the chunk-row load
   * and the chunk→hit mapping.
   *
   * The limit normalization, the over-fetch factor, the leg cap, the capped-leg counter, the
   * degraded weights, the rerank and the output budget all live there now. They used to be copied
   * here, and every fix landed on the memory side only — a `NaN` limit reached this store's SQL and
   * took the whole cross-store query down with it, `retriever.over_fetch_factor` meant something
   * different per store, and a capped knowledge leg was invisible to the health counters.
   */
  private hybridDeps(opts?: KnowledgeSearchOptions): HybridDeps<RecallHit> {
    // Per call: the fused rows are read ONCE — for the live filter and the reranker's text — and
    // reused for the hit bodies, so a search does not query `chunks.hits` twice.
    const rowsById = new Map<number, ChunkHitRow>()
    return {
      kind: 'knowledge',
      config: this.config,
      semantic: this.semantic,
      reranker: this.reranker,
      legs: (ctx) => this.searchLegs(opts, ctx),
      texts: (ids) => {
        rowsById.clear()
        for (const row of this.chunks.hits(ids)) rowsById.set(row.chunk_id, row)
        return new Map([...rowsById].map(([id, row]) => [id, row.text] as const))
      },
      hits: (ranked) => {
        const entitiesById = this.chunks.entityBags(ranked.map((h) => h.id))
        // A fused id with no row is a stale vector from a removed document; the orchestrator has
        // already dropped those from the live set, so this is a belt-and-braces filter.
        return ranked.flatMap((h) => {
          const row = rowsById.get(h.id)
          if (row === undefined) return []
          return [{
            kind: 'doc_chunk' as const,
            ref_id: h.id,
            text: row.text,
            score: h.score,
            domain: row.domain,
            source: row.source,
            source_ref: row.source_ref,
            entities: entitiesById.get(h.id) ?? [],
            created_at: row.created_at ?? '',
            updated_at: row.updated_at,
          }]
        })
      },
    }
  }

  /**
   * The knowledge legs: semantic, FTS, and entity overlap against the entities extracted AT INGEST
   * time (`chunk_entities`) — no corpus scan.
   *
   * Same cap as the memory store: fusion keeps `overFetch` entries, so a leg that returns the whole
   * matching corpus only makes `fuse` normalize and sort it (see `MemoryStore.searchLegs`).
   */
  private async searchLegs(
    opts: KnowledgeSearchOptions | undefined,
    ctx: HybridContext,
  ): Promise<readonly (HybridLeg | Promise<HybridLeg>)[]> {
    /**
     * Wrap one leg's floored scores. `raw` is the PRE-floor set: `capped` must be measured there,
     * because the relevance floor removes the tail anyway and re-deriving the flag afterwards would
     * erase the "cut at legCap" signal exactly when it bound.
     */
    const leg = (
      scores: Map<number, number>,
      weight: number,
      name: 'semantic' | 'fts' | 'jaccard',
      dropped: number,
      raw?: Map<number, number>,
    ): HybridLeg => ({
      weight,
      scores,
      // `size === cap` is the only observable "this leg was cut" signal, and it is what makes the
      // cap measurable instead of a silent quality cliff (DESIGN §20.17).
      capped: (raw ?? scores).size === ctx.legCap,
      leg: name,
      droppedByFloor: dropped,
    })
    const ftsRaw = this.ftsPath(ctx.query, opts?.domain, opts?.source, ctx.legCap)
    const ftsFloored = applyTermFloor(ftsRaw, this.chunkTexts([...ftsRaw.keys()]), ctx.query, ctx.floors.fts)
    return [
      // The semantic leg is capped by the pool size, not by `legCap`, so it is not flagged: comparing
      // it against `legCap` would report a trim that did not happen.
      ctx.semAvail
        ? this.semanticPath(ctx.query, ctx.overFetch, opts, ctx.queryVector)
            .then((raw) => {
              const floored = applyScoreFloor(raw, ctx.floors.semantic)
              return { weight: ctx.weights.semantic, scores: floored.scores, leg: 'semantic' as const, droppedByFloor: floored.dropped } satisfies HybridLeg
            })
        : { weight: ctx.weights.semantic, scores: new Map<number, number>(), leg: 'semantic' as const, droppedByFloor: 0 },
      leg(ftsFloored.scores, ctx.weights.fts, 'fts', ftsFloored.dropped, ftsRaw),
      this.jaccardPath(ctx.query, opts?.domain, opts?.source, ctx.legCap)
        .then((raw) => {
          const floored = applyScoreFloor(raw, ctx.floors.jaccard)
          return leg(floored.scores, ctx.weights.jaccard, 'jaccard', floored.dropped, raw)
        }),
    ]
  }

  /** The texts of a candidate set, for the per-row FTS floor (one batched query). */
  private chunkTexts(ids: number[]): Map<number, string> {
    if (ids.length === 0) return new Map()
    return new Map(this.chunks.hits(ids).map((row) => [row.chunk_id, row.text] as const))
  }

  /**
   * Semantic leg. `queryVector` short-circuits the encode when the caller already
   * encoded this exact query (the cross-store router does, for both stores at once).
   */
  private async semanticPath(
    query: string,
    k: number,
    opts?: { domain?: string; source?: string },
    queryVector?: Float32Array,
  ): Promise<Map<number, number>> {
    const vec = queryVector ?? await this.semantic.encode(query)
    // A caller-supplied vector is trusted to come from this backend (see the option's doc), but the
    // dimension is cheap to check and a mismatch would otherwise score as garbage. It is an INPUT
    // error, not a leg failure: the orchestrator isolates a dead leg so the query still answers, but
    // a wrong width means the caller encoded with a different backend, and quietly answering from
    // the other legs would hide that for the rest of the session.
    if (vec.length !== this.vstore.dim) {
      throw new RetrievalInputError(`queryVector 维度不符：${vec.length} != ${this.vstore.dim}`)
    }
    const topk = this.vstore.topk(vec, Math.max(50, k))
    if (!topk.length) return new Map()
    if (!opts?.domain && !opts?.source) return new Map(topk.map((t) => [t.id, t.score]))
    // One batched lookup instead of a per-candidate query.
    const meta = new Map(this.chunks.meta(topk.map((t) => t.id)).map((r) => [r.chunk_id, r]))
    const out = new Map<number, number>()
    for (const t of topk) {
      const r = meta.get(t.id)
      if (!r) continue
      if (opts.domain && r.domain !== opts.domain) continue
      if (opts.source && r.source !== opts.source) continue
      out.set(t.id, t.score)
    }
    return out
  }

  /**
   * Sync relevance probe for the plugin's conditional hint (DESIGN §12). Same contract as
   * `MemoryStore.lexicalProbe` — see `store/lexical.ts`.
   */
  lexicalProbe(text: string, stopAt = Number.POSITIVE_INFINITY): LexicalProbe {
    return probeTerms(text, (term) => {
      const fts = buildFtsQuery(term, this.ftsTokenizer)
      return fts !== null && this.chunks.ftsSearch(fts, undefined, undefined, 1).length > 0
    }, stopAt)
  }

  private ftsPath(query: string, domain: string | undefined, source: string | undefined, cap: number): Map<number, number> {
    const ftsQuery = buildFtsQuery(query, this.ftsTokenizer)
    if (!ftsQuery) return new Map()
    const rows = this.chunks.ftsSearch(ftsQuery, domain, source, cap)
    // FTS5 bm25() is negative (more negative = better match); negate so higher = better.
    return new Map(rows.map((r) => [r.id, -r.rank]))
  }

  /** Entity overlap against entities extracted AT INGEST time (chunk_entities) — no corpus scan. */
  private async jaccardPath(query: string, domain: string | undefined, source: string | undefined, cap: number): Promise<Map<number, number>> {
    const qEntities = new Set((await extractEntities(query)).map((e) => e.name))
    if (qEntities.size === 0) return new Map()
    const candIds = this.chunks.candidatesByEntityNames([...qEntities], domain, source, cap)
    if (!candIds.length) return new Map()
    const stored = this.chunks.entityBags(candIds)
    const out = new Map<number, number>()
    for (const id of candIds) {
      const factSet = new Set(stored.get(id) ?? [])
      const union = new Set([...qEntities, ...factSet])
      if (union.size === 0) continue
      const overlap = [...qEntities].filter((e) => factSet.has(e)).length
      const jaccard = overlap / union.size
      if (jaccard > 0) out.set(id, jaccard)
    }
    // Truncate the UNION, not just each name-batch: `candidatesByEntityNames` limits per batch and
    // unions, so it can hand back more than `cap` ids. Two consequences, both fixed here. The leg was
    // handing `fuse` a candidate set unbounded by `cap` (the very thing the cap exists to bound), and
    // `size === legCap` — the only observable "this leg was cut" signal (DESIGN §20.17) — reported NOT
    // capped for exactly the legs that overshot, i.e. the heavily-trimmed ones. Sorting by the real
    // jaccard (the DB ordered each batch, but a union of per-batch tops is not a top-N) and slicing
    // keeps the best `cap`, so this flag means what the FTS leg's flag means.
    if (out.size <= cap) return out
    return new Map([...out].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, cap))
  }
}

export interface Chunk {
  text: string
  headingsPath: string
  /** Inclusive start offset in the source text. */
  start: number
  /** Exclusive end offset in the source text. */
  end: number
}

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/

/**
 * Paragraph + heading aware chunking (DESIGN §8): markdown headings open a new
 * block and maintain a headings stack; blank lines separate blocks; blocks are
 * packed greedily up to `chunkSize`; oversized blocks are hard-split with
 * `overlap`; consecutive chunks finally share `overlap` characters of context.
 * Offsets always refer to the ORIGINAL text so `source_ref`/char positions stay
 * faithful for provenance.
 */
export function chunkText(text: string, chunkSize = 800, overlap = 80): Chunk[] {
  if (!text.trim()) return []
  if (chunkSize <= 0) throw new Error('chunkSize 必须为正数')
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(chunkSize / 2)))

  // Blocks: paragraph/heading-delimited units with source offsets.
  const lines: { text: string; start: number }[] = []
  let pos = 0
  for (const line of text.split('\n')) {
    lines.push({ text: line, start: pos })
    pos += line.length + 1
  }
  interface Block { start: number; end: number; headingsPath: string }
  const blocks: Block[] = []
  let headings: string[] = []
  let cur: Block | null = null
  const flush = (): void => {
    if (cur && cur.end > cur.start && text.slice(cur.start, cur.end).trim()) blocks.push(cur)
    cur = null
  }
  for (const line of lines) {
    const m = HEADING_RE.exec(line.text)
    if (m) {
      flush()
      const level = m[1].length
      headings = headings.slice(0, level - 1)
      headings.push(m[2])
      cur = { start: line.start, end: line.start + line.text.length, headingsPath: headings.join(' > ') }
      continue
    }
    if (!line.text.trim()) {
      flush()
      continue
    }
    if (!cur) cur = { start: line.start, end: line.start + line.text.length, headingsPath: headings.join(' > ') }
    else cur.end = line.start + line.text.length
    if (cur.end - cur.start > chunkSize) flush()
  }
  flush()
  if (!blocks.length) return []

  // Pack contiguous blocks into chunks up to chunkSize (source-slice text keeps offsets honest).
  const chunks: Chunk[] = []
  // Chunks whose text ALREADY carries `safeOverlap` of the previous chunk (the
  // hard-split branch steps by `chunkSize - safeOverlap`); the tail loop below
  // must not subtract the overlap a second time.
  const overlapApplied = new Set<number>()
  let gi = 0
  while (gi < blocks.length) {
    const groupStart = blocks[gi].start
    const headingsPath = blocks[gi].headingsPath
    let groupEnd = blocks[gi].end
    let j = gi + 1
    while (j < blocks.length && blocks[j].end - groupStart <= chunkSize) {
      groupEnd = blocks[j].end
      j++
    }
    if (groupEnd - groupStart > chunkSize) {
      // Single oversized block: hard split with overlap stepping.
      const step = Math.max(1, chunkSize - safeOverlap)
      for (let p = groupStart; p < groupEnd; p += step) {
        const end = Math.min(p + chunkSize, groupEnd)
        const index = chunks.length
        chunks.push({ text: text.slice(p, end), headingsPath, start: p, end })
        if (index > 0 && p > groupStart) overlapApplied.add(index)
        if (end === groupEnd) break
      }
    } else {
      chunks.push({ text: text.slice(groupStart, groupEnd), headingsPath, start: groupStart, end: groupEnd })
    }
    gi = j
  }

  // Context overlap between consecutive chunks that do not already share context.
  for (let i = 1; i < chunks.length; i++) {
    if (overlapApplied.has(i)) continue
    const c = chunks[i]
    const prev = chunks[i - 1]
    const newStart = Math.max(prev.start, c.start - safeOverlap)
    if (newStart < c.start) {
      c.start = newStart
      c.text = text.slice(newStart, c.end)
    }
  }
  return chunks
}
