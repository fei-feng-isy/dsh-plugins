import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import {
  ConfigSchema,
  defaultConfig,
  defaultLogger,
  familyModelsDir,
  familyToolsDir,
  MemoryConfigSchema,
  KnowledgeConfigSchema,
  envAutoDownload,
  type AvantfLogger,
  type Config,
  type MemoryConfig,
  type KnowledgeConfig,
} from '@avantf/mem-contract'
import {
  commonConfigPath,
  memoryConfigPath,
  knowledgeConfigPath,
  memoryDbPath,
  knowledgeDbPath,
  knowledgeDocsDir,
  ensureDataLayout,
  resolveDataHome,
  expandHome,
} from './paths.js'
import { ensureCommonConfigFile } from './config_files.js'

/**
 * Resolve a configured store path.
 *
 * `~/` expands against the USER home — the same rule `paths.expandHome` applies to
 * `dataHome` — and an absolute path is used as-is. An empty value falls back to
 * `memoryDbPath(home)` / `knowledgeDbPath(home)` (under the data home), and
 * `AVANTF_MEM_DB` / `AVANTF_KNOWLEDGE_DB` still act as that fallback's env layer.
 */
function resolveStorePath(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback
  return expandHome(raw)
}

export interface LoadedConfig {
  home: string
  common: Config
  memory: MemoryConfig
  knowledge: KnowledgeConfig
}

/**
 * Read one config YAML, or `null` when it is absent / unreadable / not a mapping.
 *
 * A PARSE FAILURE IS NOT SILENT. Treating a broken file as "no configuration" is the right behaviour
 * — the process must keep starting — but the settings it silently drops include the security knobs
 * (`knowledge.ingest.local_roots`, `allow_outside_workspace`, `allow_private_network`, `trust.*`), so
 * one bad indent used to change the ingestion boundary with no trace anywhere. `warnUnknownKeys`
 * below calls itself "the one message that tells an operator their config file is partly ignored";
 * the branch where the WHOLE file is ignored was the one with no message at all.
 *
 * Still returns `null` (behaviour unchanged, every value falls back to its default). This is a
 * warning, deliberately not a fail-closed: refusing to start on a syntax error is a host-behaviour
 * change that needs a user decision, not a drive-by fix.
 */
function readYamlOrNull(path: string, logger: AvantfLogger): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    const parsed = parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch (error) {
    logger.warn(
      `${path}: YAML parse failed (${error instanceof Error ? error.message : String(error)})`
      + ' — the WHOLE file is ignored and every setting falls back to its default',
    )
    return null
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * The plain shape object of a zod object, unwrapping `default` / `optional` / `nullable`
 * wrappers. `.unwrap()` does not exist on every wrapper, so the definition's `innerType` is the
 * fallback route.
 *
 * Reads `def.innerType` — zod v4's key. (`_def` still exists there as a legacy alias for the
 * same object, and this used to depend on it; relying on a deprecated alias is the kind of
 * implicit dependency that fails silently on the next upgrade, so it names the current key.)
 */
function zodShape(schema: unknown): Record<string, unknown> | undefined {
  let cur: unknown = schema
  for (let depth = 0; depth < 4; depth++) {
    if (cur === null || typeof cur !== 'object') return undefined
    const shape = (cur as { shape?: unknown }).shape
    if (shape !== null && typeof shape === 'object') return shape as Record<string, unknown>
    const unwrap = (cur as { unwrap?: () => unknown }).unwrap
    if (typeof unwrap === 'function') {
      cur = unwrap.call(cur)
      continue
    }
    const inner = (cur as { def?: { innerType?: unknown } }).def?.innerType
    if (inner === undefined) return undefined
    cur = inner
  }
  return undefined
}

/**
 * Warn once about unknown config keys — at the ROOT level and inside known sections
 * (TRUST_MODEL.md §7 / review R15+R23). This is generic typo protection, not legacy
 * compatibility: `vector_store` or `semantics` are exactly the mistakes it catches.
 *
 * Goes to the injected logger, not the process-wide default: this is the one message
 * that tells an operator their config file is being partly ignored, and the DSH host
 * only surfaces what the plugin's logger carries.
 */
function warnUnknownKeys(source: string, raw: Record<string, unknown>, rootShape: Record<string, unknown>, logger: AvantfLogger): void {
  const unknown: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    const section = rootShape[key]
    if (section === undefined) {
      unknown.push(key)
      continue
    }
    const childShape = zodShape(section)
    if (childShape === undefined || !isPlainObject(value)) continue
    for (const childKey of Object.keys(value)) {
      if (childShape[childKey] === undefined) unknown.push(`${key}.${childKey}`)
    }
  }
  if (unknown.length > 0) {
    logger.warn(`${source}: unknown config key(s) ignored: ${unknown.join(', ')} — check the spelling against docs/DESIGN.md §3`)
  }
}

/** Section-aware merge: top-level sections merge one level deep, scalars/arrays replace. */
function mergeConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const baseValue = out[key]
    out[key] = isPlainObject(baseValue) && isPlainObject(value) ? { ...baseValue, ...value } : value
  }
  return out
}

/**
 * The model download knobs an end user may no longer set through `config.yaml`.
 *
 * Where a model lands and where it is fetched from are decided by the family framework and by the
 * operator, not by each user's config file: the framework's managed root is the ONE landing site
 * (`LoadConfigOptions.managedRoots`), and the mirror comes from the environment escape hatch
 * (`AVANTF_MEM_MODEL_MIRROR` / `HF_ENDPOINT`). A `config.yaml` that still sets them is a stale
 * config from before that handover, so it is ignored with a warning that names the replacement
 * rather than silently keeping a second source of truth.
 */
const MANAGED_MODEL_KEYS: readonly (readonly [section: string, key: string])[] = [
  ['semantic', 'cache_dir'],
  ['semantic', 'mirror'],
]

/** Remove {@link MANAGED_MODEL_KEYS} from a parsed common YAML, warning once about each. */
function stripManagedModelKeys(raw: Record<string, unknown>, source: string, logger: AvantfLogger): void {
  const ignored: string[] = []
  for (const [section, key] of MANAGED_MODEL_KEYS) {
    const child = raw[section]
    if (!isPlainObject(child) || !(key in child)) continue
    delete child[key]
    ignored.push(`${section}.${key}`)
  }
  if (ignored.length > 0) {
    logger.warn(
      `${source}: ignoring ${ignored.join(', ')} — model cache/mirror are managed, not config-file settings;`
      + ' use AVANTF_MEM_MODEL_CACHE / AVANTF_MEM_MODEL_MIRROR (or HF_ENDPOINT) for the operator escape hatch',
    )
  }
}

/**
 * Env layer ④: a minimal, documented set of overrides applied above the YAML layers.
 *
 * Four groups, and each is the ONLY source of truth for what it controls:
 *
 *   - `AVANTF_MEM_AUTO_DOWNLOAD` / `AVANTF_ENVINIT_AUTO_DOWNLOAD` (see `envAutoDownload`) — off if
 *     EITHER is `0`/`false`; the family switch is a master gate, so it must reach `rt.config` (and
 *     therefore the adapters) and not only the framework's own provisioning.
 *   - `AVANTF_MEM_MODEL_MIRROR`, else `HF_ENDPOINT` — the model source. `config.yaml` cannot set the
 *     mirror ({@link MANAGED_MODEL_KEYS} strips it), so this layer IS where the operator's escape
 *     hatch has to land: the plugin reads `semantic.mirror` to fill the `mem:model` item's
 *     `spec.endpoint`, and the adapters read it as `remoteHost`.
 *   - `AVANTF_MEM_MODEL_CACHE` — where the runtime reads and writes models. It lands here so the
 *     plugin can see that the runtime's cache is NOT the framework root and skip declaring
 *     `mem:model` (declaring it would install a second, never-read copy under `<home>/models`).
 */
function applyEnvLayer(common: Config): Config {
  let next = common
  const autoDownload = envAutoDownload()
  if (autoDownload !== undefined) {
    next = {
      ...next,
      semantic: { ...next.semantic, auto_download: autoDownload },
    }
  }
  const mirror = process.env['AVANTF_MEM_MODEL_MIRROR'] || process.env['HF_ENDPOINT']
  if (mirror !== undefined && mirror.trim() !== '') {
    next = {
      ...next,
      semantic: { ...next.semantic, mirror: mirror.trim() },
    }
  }
  const cacheDir = process.env['AVANTF_MEM_MODEL_CACHE']
  if (cacheDir !== undefined && cacheDir.trim() !== '') {
    next = {
      ...next,
      semantic: { ...next.semantic, cache_dir: cacheDir.trim() },
    }
  }
  return next
}

export interface LoadConfigOptions {
  dataHome?: string
  /** Sink for load-time warnings (unknown keys). Defaults to the console logger. */
  logger?: AvantfLogger
  /**
   * The MANAGED ROOTS the caller wants as this process's built-in defaults.
   *
   * This is layer ① (built-in defaults), not a new precedence level: the DSH plugin replaces the
   * default locations with the family framework's root (`<home>/tools`, `<home>/models`) because
   * `@avantf/dsh-plugin-base` — not this engine — now fetches pandoc and the embedding model.
   *
   * `tools.dir` is still an ordinary configurable location, so a `config.yaml` entry or an
   * `AVANTF_*` escape hatch keeps winning. The MODEL locations are different: they are managed, so
   * {@link MANAGED_MODEL_KEYS} are stripped from `config.yaml` before it is merged (the environment
   * escape hatch stays). When the framework is unavailable the plugin passes nothing and the schema
   * defaults (the legacy directories) apply unchanged.
   */
  managedRoots?: { readonly tools?: string; readonly models?: string }
}

/**
 * Load config with layering: ① built-in defaults → ② `~/.avantf/configs/common.yaml`
 * (common) → ③ `~/.avantf/{memory,knowledge}/config.yaml` (store) → ④ env →
 * ⑤ explicit. Returns the resolved per-store config + data home.
 */
export function loadConfig(opts?: LoadConfigOptions): LoadedConfig {
  const logger = opts?.logger ?? defaultLogger
  let common: Config = {
    ...defaultConfig,
    // Layer ①: the two MANAGED directories. Empty means "not configured", so it resolves to the
    // FAMILY root here — at LOAD time, so `$AVANTF_HOME` is honoured, and in ONE place instead of
    // every consumer. The pre-framework `~/.avantf/{tools,models}` is deliberately not a fallback:
    // nothing has to survive as a compatibility symlink for the engine to find pandoc or the model.
    tools: { ...defaultConfig.tools, dir: defaultConfig.tools.dir === '' ? familyToolsDir() : defaultConfig.tools.dir },
    semantic: {
      ...defaultConfig.semantic,
      cache_dir: defaultConfig.semantic.cache_dir === '' ? familyModelsDir() : defaultConfig.semantic.cache_dir,
    },
  }
  // The family framework's roots (when it is up) name the same two directories explicitly. Applied
  // BEFORE the file/env layers so a `config.yaml` entry or an `AVANTF_*` hatch can still override.
  const managed = opts?.managedRoots
  if (managed !== undefined) {
    common = {
      ...common,
      tools: managed.tools === undefined ? common.tools : { ...common.tools, dir: managed.tools },
      semantic: managed.models === undefined ? common.semantic : { ...common.semantic, cache_dir: managed.models },
    }
  }
  if (opts?.dataHome) common = ConfigSchema.parse({ ...common, dataHome: opts.dataHome })

  // The explicit value is passed as its OWN NAMED layer (⑤): `common.dataHome` is only
  // layer ②/④ bookkeeping and must not be able to masquerade as an explicit one.
  const home = resolveDataHome({ common, explicit: opts?.dataHome })
  ensureDataLayout(home)
  // Missing or blank is an UNFINISHED edit, not an empty configuration: materialize the all-comment
  // default so the knobs are discoverable. A file with any content is the user's and is left alone.
  ensureCommonConfigFile(commonConfigPath(home), logger)

  const commonYaml = readYamlOrNull(commonConfigPath(home), logger)
  if (commonYaml) {
    // Managed keys are removed BEFORE parsing: a stale config.yaml must not become a second source
    // of truth for where models land or where they come from.
    stripManagedModelKeys(commonYaml, commonConfigPath(home), logger)
    warnUnknownKeys(commonConfigPath(home), commonYaml, zodShape(ConfigSchema) ?? {}, logger)
    common = ConfigSchema.parse(mergeConfig(common as unknown as Record<string, unknown>, commonYaml))
  }
  common = ConfigSchema.parse(applyEnvLayer(common))

  // Layer ③: per-store YAML overrides ARE merged into the store schema defaults
  // (they were previously parsed and thrown away).
  const memYaml = readYamlOrNull(memoryConfigPath(home), logger)
  if (memYaml) warnUnknownKeys(memoryConfigPath(home), memYaml, zodShape(MemoryConfigSchema) ?? {}, logger)
  let memory = MemoryConfigSchema.parse(memYaml ?? {})
  memory = { ...memory, db: { ...memory.db, path: resolveStorePath(memory.db.path, memoryDbPath(home)) } }

  const kbYaml = readYamlOrNull(knowledgeConfigPath(home), logger)
  if (kbYaml) warnUnknownKeys(knowledgeConfigPath(home), kbYaml, zodShape(KnowledgeConfigSchema) ?? {}, logger)
  let knowledge = KnowledgeConfigSchema.parse(kbYaml ?? {})
  knowledge = {
    ...knowledge,
    db: { ...knowledge.db, path: resolveStorePath(knowledge.db.path, knowledgeDbPath(home)) },
    docs: { ...knowledge.docs, dir: resolveStorePath(knowledge.docs.dir, knowledgeDocsDir(home)) },
    git: { ...knowledge.git, root: resolveStorePath(knowledge.git.root, resolveStorePath(knowledge.docs.dir, knowledgeDocsDir(home))) },
  }

  return { home, common, memory, knowledge }
}
