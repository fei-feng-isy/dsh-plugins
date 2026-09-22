import { familyModelsDir } from '@avantf/mem-contract'
import type { Reranker } from '../interfaces.js'
import { applyModelEnv, type ModelEnv, type TransformersModule } from './local_bge.js'
import { describeError, envAutoDownload } from '@avantf/mem-contract'
import { retrievalLogger } from '../log.js'
import { recordTruncation } from '../stats.js'
import { declaredWindowOf, estimateTokens, resolveWindow, truncateToTokens } from '../text_budget.js'
import { WarmGate } from './warm_gate.js'

/** One text-classification result: transformers.js yields `{label, score}`; tolerate a raw `{data}` tensor too. */
type ClassifyResult = { label?: string; score?: number; data?: number[] }
/** The injected pipeline surface: a batch of (query, document) pairs in, scores out. */
export type ClassifyFn = (inputs: [string, string][], opts?: Record<string, unknown>) => Promise<ClassifyResult[]>
/** Injectable seam: tests supply a fake classifier instead of the transformers.js import. */
export type RerankerPipeFactory = (model: string, env: ModelEnv) => Promise<ClassifyFn>

/** Rerank pairs are classified in batches to bound peak memory. */
const RERANK_BATCH = 32

/**
 * Tokens a pair costs around the two texts: `[CLS] query [SEP] doc [SEP]`.
 *
 * The QUERY is never truncated — cutting the question changes what is being scored — so the
 * document absorbs the whole budget. `bge-reranker-base` shares the 512-token window of the
 * embedder, which means an 800-character Chinese chunk has even less room here than it does
 * in `encode()` (the query takes its share first).
 */
const PAIR_SPECIAL_TOKENS = 3
/** Never hand the classifier a degenerate document; below this the score is meaningless. */
export const MIN_DOC_TOKENS = 16

/**
 * Local cross-encoder reranker via `@huggingface/transformers` (`bge-reranker`).
 * Lazily imported; `warmUp()` configures the mirror/cache and triggers a load.
 * Degrades to identity order when the package/model is not available.
 *
 * Like {@link LocalBgeBackend}, a failed warmup is retryable through
 * `ensureWarm()` rather than being final until the next restart.
 */
export class LocalReranker implements Reranker {
  readonly name = 'bge_reranker'
  private _available = false
  private _pipe: ClassifyFn | null = null
  private _warming: Promise<void> | null = null
  private _lengthWarned = false
  private _window: number | null = null
  private readonly configuredMax: number
  private readonly model: string
  private readonly env: ModelEnv
  private readonly pipeFactory: RerankerPipeFactory
  private readonly gate: WarmGate

  constructor(model: string, env?: Partial<ModelEnv>, pipeFactory: RerankerPipeFactory = createClassifier) {
    this.model = model
    this.configuredMax = env?.maxInputTokens ?? 0
    this.pipeFactory = pipeFactory
    this.env = {
      mirror: process.env['AVANTF_MEM_MODEL_MIRROR'] ?? process.env['HF_ENDPOINT'] ?? env?.mirror ?? 'https://hf-mirror.com',
      cacheDir: process.env['AVANTF_MEM_MODEL_CACHE'] ?? blankToFamilyModels(env?.cacheDir),
      autoDownload: envAutoDownload() ?? env?.autoDownload ?? true,
    }
    this.gate = new WarmGate(() => this.env.autoDownload)
    // Same opt-out as the embedder: the DSH plugin lets the framework install the model first, then
    // warms from `onSettled` (see `ModelEnv.deferWarm` in `local_bge.ts`).
    if (env?.deferWarm !== true) void this.warmUp()
  }

  isAvailable(): boolean {
    return this._available
  }

  /** Fire-and-forget retry for call sites that only observe availability (see `warm_gate.ts`). */
  ensureWarm(): void {
    if (this._available || this._warming !== null) return
    this.gate.nudge(() => {
      void this.warmUp()
    })
  }

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
    log.info(`rerank: loading reranker model ${this.model} (mirror=${this.env.mirror}, cache=${this.env.cacheDir})`)
    try {
      this._pipe = await this.pipeFactory(this.model, this.env)
      this._available = true
      log.info(`rerank: reranker ready ${this.model} (${Date.now() - started}ms)`)
    } catch (error) {
      this._available = false
      const hint = this.env.autoDownload
        ? ' (will retry on the next retrieval)'
        : ' (auto_download is disabled — a local-only miss does not retry)'
      log.warn(`rerank: reranker unavailable — keeping fused order (${this.model}, ${Date.now() - started}ms): ${describeError(error)}${hint}`)
    }
  }

  private window(): number {
    this._window ??= resolveWindow(this.configuredMax, declaredWindowOf(this._pipe))
    return this._window
  }

  /**
   * Bound one document for a pair, given how much of the window the query already spends.
   * Returns the document text unchanged when it fits.
   */
  private boundDocument(query: string, doc: string): string {
    const budget = Math.max(MIN_DOC_TOKENS, this.window() - estimateTokens(query) - PAIR_SPECIAL_TOKENS)
    const out = truncateToTokens(doc, budget)
    if (out.truncated) {
      recordTruncation('rerank')
      if (!this._lengthWarned) {
        this._lengthWarned = true
        retrievalLogger().warn(
          `rerank: (query, document) pair exceeded the ${this.window()}-token window of ${this.model} — documents are truncated `
          + `before scoring (${out.omittedTokens} tokens dropped here); check knowledge.chunk_size and rerank.max_input_tokens`,
        )
      }
    }
    return out.text
  }

  async rerank(query: string, candidates: { id: number; text: string }[]): Promise<number[]> {
    if (candidates.length === 0) return []
    await this.warmUp()
    if (!this._available || !this._pipe) return candidates.map((c) => c.id)
    const scores: number[] = []
    for (let i = 0; i < candidates.length; i += RERANK_BATCH) {
      const batch = candidates.slice(i, i + RERANK_BATCH)
      // Keep each (query, document) pair intact — flattening would classify
      // query and document as unrelated single inputs.
      const pairs: [string, string][] = batch.map((c) => [query, this.boundDocument(query, c.text)])
      let out: ClassifyResult[]
      try {
        out = await this._pipe(pairs)
      } catch (error) {
        retrievalLogger().warn(`rerank: inference failed — keeping fused order: ${error instanceof Error ? error.message : String(error)}`)
        return candidates.map((c) => c.id)
      }
      for (let j = 0; j < batch.length; j++) scores.push(extractScore(out[j]))
    }
    const scored = candidates.map((c, i) => ({ id: c.id, score: scores[i] ?? 0 }))
    scored.sort((a, b) => b.score - a.score)
    return scored.map((s) => s.id)
  }
}

/** transformers.js text-classification yields `{label, score}`; a raw tensor shape exposes `data`. */
function extractScore(result: ClassifyResult | undefined): number {
  if (!result) return 0
  if (typeof result.score === 'number') return result.score
  if (Array.isArray(result.data) && typeof result.data[0] === 'number') return result.data[0]
  return 0
}

async function createClassifier(model: string, env: ModelEnv): Promise<ClassifyFn> {
  const modName = '@huggingface/transformers'
  const mod = (await import(modName)) as unknown as TransformersModule
  if (!mod.pipeline) throw new Error('transformers.js 的 pipeline 不可用')
  // One policy for both adapters, applied in one place: `mod.env` is process-global, so a key set
  // here is also in force for the embedder (see `applyModelEnv`).
  applyModelEnv(mod, env)
  return (await mod.pipeline('text-classification', model)) as unknown as ClassifyFn
}

/** A blank `cache_dir` means "not configured": the family root's `models`, never the pre-framework path. */
function blankToFamilyModels(configured: string | undefined): string {
  return configured !== undefined && configured.trim() !== '' ? configured : familyModelsDir()
}
