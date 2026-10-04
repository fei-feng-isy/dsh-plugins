import { familyModelsDir } from '@avantf/mem-contract'
import type { SemanticBackend, SemanticRepresentation } from '../interfaces.js'
import { describeError, envAutoDownload, expandHome } from '@avantf/mem-contract'
import { retrievalLogger } from '../log.js'
import { modelFilesPresent, readModelRevision } from '../representation.js'
import { recordTruncation } from '../stats.js'
import { declaredWindowOf, resolveWindow, truncateToTokens } from '../text_budget.js'
import { WarmGate } from './warm_gate.js'

/**
 * The injected pipeline surface: one text OR an array of texts in, a tensor out.
 *
 * The array form matters: transformers.js runs a batch through the model in one call (its own
 * per-call overhead — session dispatch, tokenizer batching — is amortized), while a serial loop of
 * single-text calls pays it per chunk. `dims` is the tensor shape (`[n, dim]`); the single-text
 * form may omit it.
 */
export type PipelineFn = (
  text: string | string[],
  opts?: Record<string, unknown>,
) => Promise<{ data: Float32Array | number[]; dims?: number[] }>
/** The slice of the transformers.js module this project reads and configures. */
export type TransformersModule = { env?: Record<string, unknown>; pipeline?: (task: string, model: string) => Promise<unknown> }
/** Injectable seam: tests supply a fake pipeline instead of the transformers.js import. */
export type PipeFactory = (model: string, env: ModelEnv) => Promise<PipelineFn>

/** Tokens the tokenizer adds around every input (`[CLS]` / `[SEP]`). */
const SPECIAL_TOKENS = 2

/**
 * Items per batched forward pass inside {@link LocalBgeBackend.encodeBatch}. Bounds peak tensor
 * memory; the padding waste that makes batching a loss on long texts is handled by sorting, not by
 * this number.
 */
const BATCH_WINDOW = 16

export interface ModelEnv {
  /** Mirror host for model downloads (default domestic). */
  mirror: string
  /** Local cache dir for downloaded weights. */
  cacheDir: string
  /** Whether to auto-download on warmup. */
  autoDownload: boolean
  /**
   * Upper bound on tokens handed to the model; `0`/unset = auto (the loaded model's declared
   * window). Past the window transformers.js truncates SILENTLY, so the adapter bounds the
   * text first and logs it once (`text_budget.ts`).
   */
  maxInputTokens?: number
  /**
   * Pooling strategy handed to the feature-extraction pipeline (`mean` by default). Part of the
   * representation fingerprint (`representationKey`): `mean` and `cls` produce DIFFERENT
   * coordinates from the same weights, so a change here is a data migration, not a tuning knob.
   */
  pooling?: string
  /**
   * Whether the pipeline L2-normalizes (`true` by default). Also part of the representation:
   * an un-normalized vector ranks differently under cosine, so switching it invalidates every
   * persisted vector exactly like a model swap does.
   */
  normalize?: boolean
  /**
   * Do NOT warm in the constructor: the first `encode()` / `encodeBatch()` warms lazily.
   *
   * Set when something ELSE owns the model root and will put the files there asynchronously — the
   * DSH plugin does, because the family framework fetches the model as a background item. Warming
   * in the constructor would race that install and let this process fetch its own copy; the caller
   * warms explicitly once the item settles. Unset (the CLI / MCP / every direct construction) keeps
   * the eager constructor warm.
   */
  deferWarm?: boolean
}

/**
 * Local BGE embedder via `@huggingface/transformers` (transformers.js, ONNX).
 * Lazily imports the package; `warmUp()` (async, idempotent) sets the mirror +
 * cache dir, then triggers a model load/download. Until warmup completes,
 * `isAvailable()` is false and the retrieval pipeline stays degraded.
 *
 * A warmup that fails is not final: `ensureWarm()` lets observing call sites
 * retry it cheaply (see `warm_gate.ts`), so a transient mirror outage does not
 * degrade a long-lived host until the next restart.
 */
export class LocalBgeBackend implements SemanticBackend {
  readonly name = 'local_bge'
  readonly dim: number
  private _available = false
  private _pipe: PipelineFn | null = null
  private _warming: Promise<void> | null = null
  private _dimWarned = false
  private _lengthWarned = false
  private _window: number | null = null
  /** Cached so the fingerprint cannot move while the process runs (see {@link representation}). */
  private _representation: SemanticRepresentation | null = null
  private readonly configuredMax: number
  private readonly pooling: string
  private readonly normalize: boolean
  private readonly model: string
  private readonly env: ModelEnv
  private readonly pipeFactory: PipeFactory
  private readonly gate: WarmGate

  constructor(model: string, dim: number, env?: Partial<ModelEnv>, pipeFactory: PipeFactory = createFeatureExtraction) {
    this.model = model
    this.dim = dim
    this.configuredMax = env?.maxInputTokens ?? 0
    this.pooling = env?.pooling ?? 'mean'
    this.normalize = env?.normalize ?? true
    this.pipeFactory = pipeFactory
    this.env = {
      mirror: process.env['AVANTF_MEM_MODEL_MIRROR'] ?? process.env['HF_ENDPOINT'] ?? env?.mirror ?? 'https://hf-mirror.com',
      cacheDir: process.env['AVANTF_MEM_MODEL_CACHE'] ?? blankToFamilyModels(env?.cacheDir),
      autoDownload: envAutoDownload() ?? env?.autoDownload ?? true,
    }
    this.gate = new WarmGate(() => this.env.autoDownload)
    // Eager UNLESS the caller owns the warm schedule (`deferWarm`): the DSH plugin sets it because
    // the framework is still fetching the model into the same root, and warming here would race the
    // install. `encode()` / `encodeBatch()` / `warmUp()` still warm on first use either way.
    if (env?.deferWarm !== true) void this.warmUp()
  }

  isAvailable(): boolean {
    return this._available
  }

  /**
   * The representation knobs this adapter applies, resolved ONCE per instance.
   *
   * Resolved once on purpose: the model revision comes from disk, and a fingerprint that changed
   * mid-process (install settles, sidecar appears) would make the store declare the rows it just
   * wrote stale. The cost of reading it early is bounded and honest — a process that starts BEFORE
   * the family provisioner lands the model writes a revision-less fingerprint for that session, and
   * the next start re-encodes once into the revision-carrying one. The alternative (reading late)
   * would re-encode on every restart instead.
   *
   * A missing sidecar is reported once, as a DEGRADATION: the fingerprint then cannot see a repo
   * whose weights were re-pushed under the same name, which is a real (narrow) blind spot and must
   * not be mistaken for a healthy state. It never throws, and it stays quiet while the weights are
   * not on disk yet (a fresh install in flight has nothing to fingerprint; the sidecar arrives with
   * the weights). The resolved representation is CACHED, so the warning is one line per process.
   */
  representation(): SemanticRepresentation {
    if (this._representation !== null) return this._representation
    const read = readModelRevision(this.env.cacheDir, this.model)
    if (read.revision === undefined && modelFilesPresent(this.env.cacheDir, this.model)) {
      retrievalLogger().warn(
        `semantic: no model revision for ${this.model} (${read.detail}) — the vector-space fingerprint omits it, `
        + 'so re-pushed weights under the same repo name cannot be detected as a representation change',
      )
    }
    this._representation = {
      pooling: this.pooling,
      normalize: this.normalize,
      maxInputTokens: this.configuredMax,
      ...(read.revision === undefined ? {} : { revision: read.revision }),
    }
    return this._representation
  }

  /**
   * Fire-and-forget retry for call sites that only observe availability. No-op
   * while the model is ready or an attempt is already in flight; otherwise
   * throttled by {@link WarmGate}.
   */
  ensureWarm(): void {
    if (this._available || this._warming !== null) return
    this.gate.nudge(() => {
      void this.warmUp()
    })
  }

  /** Idempotent warmup: configure transformers.js env and load/download the model. */
  warmUp(): Promise<void> {
    if (this._available) return Promise.resolve()
    if (this._warming) return this._warming
    this._warming = this._doWarmup().finally(() => {
      this._warming = null
    })
    return this._warming
  }

  private async _doWarmup(): Promise<void> {
    const started = Date.now()
    const log = retrievalLogger()
    this.gate.markAttempt()
    log.info(`semantic: loading embedding model ${this.model} (mirror=${this.env.mirror}, cache=${expandHome(this.env.cacheDir)}, autoDownload=${this.env.autoDownload})`)
    try {
      this._pipe = await this.pipeFactory(this.model, this.env)
      this._available = true
      log.info(`semantic: embedding model ready ${this.model} (dim=${this.dim}, ${Date.now() - started}ms)`)
    } catch (error) {
      this._available = false
      log.warn(
        `semantic: embedding model unavailable — retrieval degrades to FTS+entity (${this.model}, ${Date.now() - started}ms): `
        + `${describeError(error)}${this.retryHint()}`,
      )
    }
  }

  /** Tell the operator whether the failure is recoverable in-process. */
  private retryHint(): string {
    return this.env.autoDownload
      ? ' (will retry on the next retrieval)'
      : ' (auto_download is disabled — a local-only miss does not retry)'
  }

  /**
   * The model's usable input window, resolved once per process: an explicit
   * `semantic.max_input_tokens` cap clamped to the loaded tokenizer's declared
   * `model_max_length`, or the declared window itself when the config says "auto" (0).
   */
  private window(): number {
    this._window ??= resolveWindow(this.configuredMax, declaredWindowOf(this._pipe))
    return this._window
  }

  /**
   * Bound `text` to the window BEFORE it reaches transformers.js.
   *
   * This is the only place the guard can live: the feature-extraction pipeline's `_call`
   * accepts `{pooling, normalize, quantize, precision}` and nothing else, so `max_length`
   * cannot be raised or lowered from the call site — past `model_max_length` the tokenizer
   * truncates and says nothing.
   */
  private bound(text: string): { text: string; truncated: boolean; omittedTokens: number } {
    const budget = Math.max(1, this.window() - SPECIAL_TOKENS)
    const out = truncateToTokens(text, budget)
    if (out.truncated) {
      recordTruncation('embedding')
      if (!this._lengthWarned) {
        this._lengthWarned = true
        retrievalLogger().warn(
          `semantic: input exceeded the ${this.window()}-token window of ${this.model} — text is truncated before encoding `
          + `(${out.omittedTokens} tokens dropped here); check knowledge.chunk_size and semantic.max_input_tokens`,
        )
      }
    }
    return out
  }

  async encode(text: string): Promise<Float32Array> {
    await this.warmUp()
    if (!this._available || !this._pipe) throw new Error('local_bge：语义后端不可用（请安装 @huggingface/transformers 并等模型下载完成）')
    const bounded = this.bound(text)
    const out = await this._pipe(bounded.text, { pooling: this.pooling, normalize: this.normalize })
    const arr = Array.from(out.data as Float32Array | number[])
    if (arr.length !== this.dim && !this._dimWarned) {
      this._dimWarned = true
      retrievalLogger().warn(
        `semantic: model ${this.model} outputs dim=${arr.length} but config semantic.dim=${this.dim} — vectors are truncated/padded; `
        + `set semantic.dim to ${arr.length} and reindex`,
      )
    }
    const vec = new Float32Array(this.dim)
    for (let i = 0; i < this.dim && i < arr.length; i++) vec[i] = arr[i]
    return vec
  }

  /**
   * Encode several texts in ONE model call.
   *
   * This used to be a serial loop over `encode()`, and production code never called it — so
   * ingest paid the per-call overhead once per chunk (measured: the dominant cost of `kb ingest`,
   * 33.7 ms/chunk at 450 characters). Every text is bounded individually first (the window
   * belongs to the model, not to the batch), and a failed batch falls back to per-text calls so
   * an injected single-string pipeline (tests) and a memory-bound real batch both keep working.
   */
  async encodeBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    if (texts.length === 1) return [await this.encode(texts[0]!)]
    await this.warmUp()
    if (!this._available || !this._pipe) throw new Error('local_bge：语义后端不可用（请安装 @huggingface/transformers 并等模型下载完成）')
    // Encode in LENGTH-SORTED groups, then restore the caller's order.
    //
    // Why: a batched forward pass pads every item to the longest one in ITS group, so document
    // order (real chunks span 53–550 characters, median 303) wastes ~1.8x the compute. Measured on
    // 299 real chunks: serial 31.2 ms/text, batched in document order 55.7 ms/text, batched after
    // sorting by length 31.9 ms/text. Sorting makes this method never WORSE than serial, and still
    // better where the per-call overhead dominates (100-char texts: 9.96 → 6.71 ms/text).
    const sorted = texts.map((text, index) => ({ text, index })).sort((a, b) => a.text.length - b.text.length)
    const result = new Array<Float32Array>(texts.length)
    for (let i = 0; i < sorted.length; i += BATCH_WINDOW) {
      const group = sorted.slice(i, i + BATCH_WINDOW)
      const vecs = await this.encodeGroup(group.map((g) => g.text))
      group.forEach((g, j) => { result[g.index] = vecs[j]! })
    }
    return result
  }

  /** One model call for a length-homogeneous group; falls back to per-text calls on failure. */
  private async encodeGroup(texts: string[]): Promise<Float32Array[]> {
    // `encodeBatch` already checked availability; re-check locally so the narrowing holds here too
    // (and so this method is safe to call on its own).
    const pipe = this._pipe
    if (pipe === null) throw new Error('local_bge：语义后端不可用')
    const bounded = texts.map((t) => this.bound(t).text)
    try {
      const out = await pipe(bounded, { pooling: this.pooling, normalize: this.normalize })
      const flat = out.data as Float32Array | number[]
      // No shape means the pipeline answered a single text per call (an injected fake, or an older
      // binding): guessing `rows = texts.length` would slice one vector into N garbage ones. Throw
      // instead — `encodeBatch`'s catch falls back to per-text calls, which is correct for both.
      const rows = out.dims?.[0]
      if (rows === undefined) throw new Error('local_bge：批式编码没有返回张量形状')
      const width = Math.floor(flat.length / rows)
      if (rows !== texts.length || width === 0) {
        throw new Error(`local_bge：批式编码返回 ${rows} 行、每行宽 ${width}，而输入有 ${texts.length} 条`)
      }
      if (width !== this.dim && !this._dimWarned) {
        this._dimWarned = true
        retrievalLogger().warn(
          `semantic: model ${this.model} outputs dim=${width} but config semantic.dim=${this.dim} — vectors are truncated/padded; `
          + `set semantic.dim to ${width} and reindex`,
        )
      }
      return Array.from({ length: texts.length }, (_, i) => {
        const vec = new Float32Array(this.dim)
        const base = i * width
        for (let d = 0; d < this.dim && d < width; d++) vec[d] = Number(flat[base + d])
        return vec
      })
    } catch {
      const out: Float32Array[] = []
      for (const t of texts) out.push(await this.encode(t))
      return out
    }
  }
}

async function createFeatureExtraction(model: string, env: ModelEnv): Promise<PipelineFn> {
  const modName = '@huggingface/transformers'
  const mod = (await import(modName)) as unknown as TransformersModule
  if (!mod.pipeline) throw new Error('transformers.js 的 pipeline 不可用')
  applyModelEnv(mod, env)
  return (await mod.pipeline('feature-extraction', model)) as PipelineFn
}

/**
 * Apply this project's cache/mirror policy to transformers.js.
 *
 * `mod.env` is PROCESS-GLOBAL and last-writer-wins. Setting the keys from a single place is what
 * keeps every future adapter over this module from disagreeing: `allowLocalModels` is already the
 * library default, stated here so the policy is explicit rather than inherited.
 */
export function applyModelEnv(mod: TransformersModule, env: ModelEnv): void {
  if (!mod.env) return
  mod.env.remoteHost = env.mirror
  mod.env.cacheDir = expandHome(env.cacheDir)
  mod.env.allowRemoteModels = env.autoDownload
  mod.env.allowLocalModels = true
}

/** A blank `cache_dir` means "not configured": the family root's `models`, never the pre-framework path. */
function blankToFamilyModels(configured: string | undefined): string {
  return configured !== undefined && configured.trim() !== '' ? configured : familyModelsDir()
}
