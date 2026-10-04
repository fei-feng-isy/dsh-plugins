import type { Config } from '@avantf/mem-contract'
import type { SemanticBackend, VectorStore } from './interfaces.js'
import { LocalBgeBackend } from './adapters/local_bge.js'
import { LocalNumpyVectorStore } from './adapters/local_numpy.js'
import { HnswlibVectorStore } from './adapters/hnswlib.js'
import { AutoVectorStore } from './adapters/auto_vstore.js'
import { retrievalLogger } from './log.js'

type Factory<T> = (cfg: Config, opts?: ResolveOptions) => T

/**
 * How a backend is resolved.
 *
 * Only `deferWarm` exists, and only because the DSH plugin cannot let a backend warm itself: the
 * family framework installs the model into the managed root ASYNCHRONOUSLY, so a constructor-time
 * warm would race that install and fetch a second copy. The plugin passes `deferWarm: true` and
 * warms from the model item's `onSettled`; every other caller (CLI, MCP, tests) keeps the eager
 * constructor warm. `encode()` still warms lazily, so deferring never loses the model.
 */
export interface ResolveOptions {
  /** Skip the constructor warm; the caller warms explicitly (see `ModelEnv.deferWarm`). */
  readonly deferWarm?: boolean
}

/** Adapter surfaces that are not implemented yet resolve to the numpy fallback — loudly. */
function unimplementedVStore(name: string): Factory<VectorStore> {
  return (cfg) => {
    retrievalLogger().warn(
      `向量库后端 '${name}' 还没有具体适配器 —— 回退到 local_numpy（暴力检索）。`
      + `实现方式见 docs/VECTOR_STORES.md（通过 registerVectorStore 注册）。`,
    )
    return new LocalNumpyVectorStore(cfg.semantic.dim)
  }
}

/**
 * Pluggable backend registries. The DSH plugin does NOT expose these as Cordis
 * services; replacement happens inside avantf-mem by config + registry (DESIGN §5).
 * The business flow resolves backends only through these factories.
 *
 * The two `register*` functions below are the whole pluggability contract: register a name, put
 * that name in `config.<semantic|vectorStore>.backend`, and the resolver picks it up — no
 * business-flow change. They are re-exported on the PUBLISHED plugin face (`@avantf/dsh-mem`) so a
 * consumer OUTSIDE this repo can actually use the promise DESIGN §5 makes; see `packages/core/src/index.ts`
 * and `packages/plugin/src/index.ts`. Resolution stays a registry lookup, never duck-typing.
 */
const semanticRegistry: Record<string, Factory<SemanticBackend>> = {
  local_bge: (cfg, opts) =>
    new LocalBgeBackend(cfg.semantic.local_model, cfg.semantic.dim, {
      mirror: cfg.semantic.mirror,
      cacheDir: cfg.semantic.cache_dir,
      autoDownload: cfg.semantic.auto_download,
      maxInputTokens: cfg.semantic.max_input_tokens,
      deferWarm: opts?.deferWarm,
    }),
}

const vstoreRegistry: Record<string, Factory<VectorStore>> = {
  local_numpy: (cfg) => new LocalNumpyVectorStore(cfg.semantic.dim),
  hnswlib: (cfg) => new HnswlibVectorStore(cfg.semantic.dim, cfg.vectorStore.hnswlib_ef_search),
  faiss: unimplementedVStore('faiss'),
  pgvector: unimplementedVStore('pgvector'),
  qdrant: unimplementedVStore('qdrant'),
}

export function registerSemanticBackend(name: string, factory: Factory<SemanticBackend>): void {
  semanticRegistry[name] = factory
}
export function registerVectorStore(name: string, factory: Factory<VectorStore>): void {
  vstoreRegistry[name] = factory
}

export function resolveSemantic(cfg: Config, opts?: ResolveOptions): SemanticBackend {
  const f = semanticRegistry[cfg.semantic.backend]
  if (!f) throw new Error(`未知的语义后端：${cfg.semantic.backend}`)
  return f(cfg, opts)
}

export function resolveVStore(cfg: Config): VectorStore {
  const backend = cfg.vectorStore.backend
  if (backend === 'auto') {
    return new AutoVectorStore(cfg.semantic.dim, cfg.vectorStore.auto_thresholds.hnswlib, cfg.vectorStore.hnswlib_ef_search)
  }
  const f = vstoreRegistry[backend]
  if (!f) throw new Error(`未知的向量库后端：${backend}`)
  return f(cfg)
}
