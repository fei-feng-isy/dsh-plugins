import { describeError } from '@avantf/mem-contract'
import {
  ensure,
  ensureAllAsync,
  hasArtifact,
  parseToolsConfig,
  registerArtifact,
  registerPandocArtifact,
  resolveToolsDir,
  whenEventLoopIdle,
} from '@avantf/mem-provision'
import { jiebaAvailable } from './entities/extract.js'
import type { AvantfRuntime } from './runtime.js'

/**
 * This module does NOT import the family base `@avantf/dsh-plugin-base` — and nothing else in the
 * engine does either.
 *
 * `@avantf/mem` is inlined into the plugin bundle, and the base is a **peer of the plugin** (plus a
 * `devDependency` that is only the source of the declared range): the plugin's inlined zero-dependency
 * bootstrap resolves the installed base at startup and loads it by file URL (`plugin/src/envinit.ts`).
 * A static import here would therefore put a top-level `import "@avantf/dsh-plugin-base"` in the
 * artifact that may resolve nowhere — the artifact would throw `ERR_MODULE_NOT_FOUND` during module
 * evaluation, before any of our code ran, which is exactly the failure the family forbids ("the base
 * missing must degrade the plugin, never prevent it from loading"). The plugin computes the verdict
 * itself (off the runtime-loaded base) and hands it over as PLAIN DATA; this module only reads it
 * (see AGENTS.md, «The three family hard constraints»).
 */
const COMPAT_PREFIX = 'compat:'

/** The statuses the base's verdict can carry (kept structural — see the note above). */
export type DshCompatStatus = 'ok' | 'version-mismatch' | 'version-unknown' | 'probe-skipped' | 'probe-failed'

/**
 * The slice of the base's verdict this package reads.
 *
 * `load: false` means a probe PROVED the host API incompatible (only `probe-failed`); a version
 * difference is a warning, never a skip. Structural on purpose: a full `CompatVerdict` from the base
 * satisfies it, and this package needs no import of (or dependency on) the base to say so.
 */
export interface DshCompatVerdict {
  readonly load: boolean
  readonly status: DshCompatStatus
  readonly reason: string
}

/** Hard cap on the host-readiness wait (see {@link WarmOptions.waitForCapMs}). */
const WAIT_FOR_HOST_MS = 30_000

/** A timer-based delay, the only await in this module that is not tied to real mission. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** Options for {@link warmModels}. */
export interface WarmOptions {
  /**
   * Resolve before the tokenizer parse starts. The DSH plugin passes its host's readiness signal
   * (`loader.await()`), the same one that gates the `dsh web` URL line, so the synchronous parse
   * runs once the host is up instead of delaying it.
   */
  waitFor?: Promise<unknown>
  /**
   * Hard cap on {@link waitFor} (default {@link WAIT_FOR_HOST_MS}).
   *
   * The host's own readiness signal is not bounded by the host (its URL print relies on the same
   * promise), so a loader row that never settles would leave the tokenizer un-warmed for the whole
   * process life — every first query then pays the ~1.2 s. Bounded here on principle, and
   * injectable so a caller can shorten it without waiting the real interval.
   */
  waitForCapMs?: number
  /**
   * Wait for an idle event loop before loading nodejieba (the host-boot path). Off for the CLI,
   * which calls `warmModels` inline: there the process is already idle and the gate would only add
   * its quiet window to every command.
   */
  deferTokenizerUntilIdle?: boolean
}

/**
 * Fire-and-forget model bootstrap for DSH startup. Configures the semantic /
 * rerank model env (mirror + cache) and triggers the model download/load
 * asynchronously, without blocking the plugin's `apply`. Returns the availability
 * of the semantic path once the download/load completes.
 *
 * Every stage logs through the runtime logger so a plugin mount is traceable in
 * the DSH host output: warm start (mirror/cache/model), then ready or degraded.
 *
 * @param rt - the runtime whose memory store owns the semantic backend.
 * @param options - host-readiness and idle-gating options (see {@link WarmOptions}).
 * @param reportFinal - log the one-line verdict (`true`, the default). The provisioning sweep turns
 *   the same verdict into the artifact's result line and would otherwise print it twice; the CLI
 *   path keeps it, because there the caller only sees this logger.
 */
export async function warmModels(
  rt: AvantfRuntime,
  options: WarmOptions = {},
  reportFinal = true,
): Promise<boolean> {
  const semanticReady = await warmSemantic(rt, reportFinal)
  await warmTokenizer(rt, options)
  return semanticReady
}

/**
 * Warm ONLY the embedding model: load it from `semantic.cache_dir` and mark the engine ready.
 *
 * Split out of {@link warmModels} for the plugin's envinit path. There the framework fetches the
 * model in the BACKGROUND, so the warm has to wait for the item to settle instead of running at
 * mount — and the runtime's own constructor warm is deferred for exactly that reason
 * (`RuntimeOptions.managedRoots` → `deferWarm`), which is what stops it racing the install and
 * leaving a second copy behind. While the item is unsettled NOTHING warms; this function is the
 * explicit "files are there now, look" step, and it still runs when the item skipped/failed so
 * `semantic.auto_download` can decide between the runtime's own fetch and degradation.
 *
 * @param rt - the runtime whose memory store owns the semantic backend.
 * @param reportFinal - log the one-line verdict (default `true`).
 * @returns whether the semantic path is available.
 */
export async function warmSemantic(rt: AvantfRuntime, reportFinal = true): Promise<boolean> {
  const started = Date.now()
  const { semantic } = rt.config.common
  rt.logger.info(
    `model bootstrap: warm start — model=${semantic.local_model} backend=${semantic.backend} `
    + `mirror=${semantic.mirror} cache=${semantic.cache_dir} autoDownload=${semantic.auto_download}`,
  )
  const semanticReady = await rt.memory.warmupSemantic()
  const elapsed = Date.now() - started
  if (reportFinal) {
    if (semanticReady) rt.logger.info(`model bootstrap: warm complete in ${elapsed}ms — semantic path active`)
    else rt.logger.warn(`model bootstrap: warm finished in ${elapsed}ms — semantic path UNAVAILABLE, retrieval degrades to FTS+entity (retries on the next retrieval)`)
  }
  return semanticReady
}

/**
 * Warm ONLY the tokenizer, after the host-readiness signal and (when asked) an idle event loop.
 *
 * nodejieba loads its dictionary lazily on the FIRST `tag()` (measured ~950 ms, after which a call
 * is 0.1 ms), so without this the first write/query of a session pays it while the user waits. Its
 * cost belongs to startup, and an unavailable jieba is worth saying out loud — entity extraction
 * silently degrades to the regex fallback (weaker entity/jaccard legs).
 *
 * @param rt - the runtime whose logger reports the outcome.
 * @param options - the host-readiness signal and the idle gate (see {@link WarmOptions}).
 */
export async function warmTokenizer(rt: AvantfRuntime, options: WarmOptions = {}): Promise<void> {
  if (options.waitFor !== undefined) {
    // A host whose boot FAILED must still get a warmed tokenizer: the signal is a synchronization
    // point, not a precondition. A host whose boot HUNG must not block the warm forever either —
    // the host does not bound this promise (its URL print waits on the same one), so we do.
    rt.logger.info('model bootstrap: tokenizer warm waits for the host readiness signal')
    const cap = options.waitForCapMs ?? WAIT_FOR_HOST_MS
    await Promise.race([options.waitFor.catch(() => undefined), delay(cap)])
  }
  if (options.deferTokenizerUntilIdle === true) {
    const waited = await whenEventLoopIdle()
    if (waited >= 200) rt.logger.info(`model bootstrap: tokenizer warm waited ${waited}ms for an idle event loop`)
  }
  const jiebaStarted = Date.now()
  if (await jiebaAvailable()) {
    rt.logger.info(`model bootstrap: tokenizer ready in ${Date.now() - jiebaStarted}ms (nodejieba)`)
  } else {
    rt.logger.warn(
      `model bootstrap: nodejieba unavailable in ${Date.now() - jiebaStarted}ms — `
      + 'entity/triple extraction falls back to the regex path (weaker entity + jaccard legs)',
    )
  }
}

/**
 * Non-blocking embedding warm, for a caller that knows the model files are already on disk.
 *
 * The plugin's envinit path calls this from the model item's `onSettled`, which is the "continue
 * initialisation once the background resource is there" step (framework DESIGN §7.2 step 5).
 *
 * @param rt - the runtime to warm.
 * @param reportFinal - log the one-line verdict (default `true`).
 */
export function warmSemanticAsync(rt: AvantfRuntime, reportFinal = true): void {
  void warmSemantic(rt, reportFinal).catch((error: unknown) => {
    rt.logger.error(`model bootstrap: warm failed — ${describeError(error)}`)
  })
}

/**
 * Non-blocking tokenizer warm for the plugin startup path: the host is still mounting plugins and
 * composing its client bundles, so the synchronous dictionary parse waits for the host's readiness
 * signal (when one is available) and then for a quiet turn, instead of competing with the boot.
 *
 * @param rt - the runtime to warm.
 * @param options - the host-readiness signal and the idle gate (see {@link WarmOptions}).
 */
export function warmTokenizerAsync(rt: AvantfRuntime, options: WarmOptions = {}): void {
  void warmTokenizer(rt, { ...options, deferTokenizerUntilIdle: true }).catch((error: unknown) => {
    rt.logger.error(`model bootstrap: warm failed — ${describeError(error)}`)
  })
}

/** Non-blocking variant for the plugin startup path. */
export function warmModelsAsync(rt: AvantfRuntime, options: WarmOptions = {}): void {
  // Host boot: the harness is still mounting plugins and composing its client bundles, so the
  // tokenizer's synchronous parse waits for the host's readiness signal (when one is available) and
  // then for a quiet turn, instead of competing with the boot for the main thread.
  void warmModels(rt, { ...options, deferTokenizerUntilIdle: true }).catch((error: unknown) => {
    // `describeError` keeps the cause: a bare `fetch failed` hides DNS poisoning
    // vs. an unreachable mirror vs. a connect timeout.
    rt.logger.error(`model bootstrap: warm failed — ${describeError(error)}`)
  })
}

/**
 * Options for {@link provisionToolchainAsync}: the warm-up options plus the host-side dsh verdict.
 */
export interface ProvisionSweepOptions extends WarmOptions {
  /**
   * The verdict the DSH plugin ALREADY computed (see `packages/plugin/src/provision.ts`), as plain
   * data. The plugin computes it once and this package reads it — no second derivation, and no
   * import of the base. Absent for callers with no dsh context (the standalone MCP entry), in which
   * case no gate runs.
   */
  dshCompat?: DshCompatVerdict
}

/** Outcome of {@link provisionToolchainAsync}. */
export interface ProvisionSweepResult {
  /**
   * `true` when the sweep did NOT run because the host dsh is incompatible: no artifact was
   * resolved, installed or warmed. `false` means the sweep was dispatched as usual.
   */
  skipped: boolean
  /** Verdict status when the gate ran (`probe-failed` is the only value that skips). */
  status?: DshCompatStatus
  /** Why it was skipped (the proven incompatibility detail). */
  reason?: string
}

/**
 * The ONE startup initialization for this plugin: register every artifact this build needs, then run
 * the provisioning sweep (non-blocking).
 *
 * It replaced a `warmModelsAsync(rt, …)` call that sat beside a separate tools sweep, which meant two
 * initialization paths, two logging vocabularies, and no single answer to "is this host fully
 * provisioned?". Callers (the DSH plugin mount, the MCP entry) now make one call, and the per-artifact
 * result lines in the host log come from the same mechanism that installs pandoc.
 *
 * The FIRST step is the dsh compatibility gate: an incompatible host means NOTHING is resolved,
 * installed or warmed — preparing an environment for an API we cannot drive is wasted mission.
 *
 * @param rt - the runtime, whose resolved `tools` config and logger the sweep uses.
 * @param options - the host's readiness signal and the dsh compatibility evidence.
 * @returns whether the sweep ran or was skipped for incompatibility.
 */
export async function provisionToolchainAsync(
  rt: AvantfRuntime,
  options: ProvisionSweepOptions = {},
): Promise<ProvisionSweepResult> {
  // ── STEP 1: the dsh compatibility gate, before any artifact is touched ─────────────────────────
  // The plugin already judged the host; `load: false` only ever means a probe PROVED the API moved
  // (`probe-failed`). A missing verdict means the check could not run — "cannot tell" is not
  // "incompatible", so the sweep proceeds.
  const verdict = options.dshCompat
  if (verdict !== undefined && !verdict.load) {
    const reason = verdict.reason === '' ? 'the host dsh API is incompatible' : verdict.reason
    rt.logger.warn(
      `${COMPAT_PREFIX} WARNING — environment preparation skipped: ${reason}; no artifact was resolved, installed or warmed`,
    )
    return { skipped: true, status: verdict.status, reason }
  }

  registerModelArtifact()
  registerPandocArtifact()
  const { tools } = rt.config.common
  const toolsDir = resolveToolsDir(parseToolsConfig(tools))
  void ensureAllAsync({
    toolsDir,
    config: parseToolsConfig(tools),
    logger: rt.logger,
    artifactEnv: {
      runtime: rt,
      ...(options.waitFor === undefined ? {} : { waitFor: options.waitFor }),
      ...(options.waitForCapMs === undefined ? {} : { waitForCapMs: options.waitForCapMs }),
    } satisfies ModelArtifactEnv,
  }).then((results) => {
    // The model artifact is the one whose failure the operator must know about immediately: retrieval
    // degrades to FTS+entity, which is a functional loss rather than a missing converter.
    const model = results.find(result => result.id === MODEL_ARTIFACT_ID)
    if (model !== undefined && !model.ok) {
      rt.logger.warn('model bootstrap: semantic path UNAVAILABLE, retrieval degrades to FTS+entity (retries on the next retrieval)')
    }
  }).catch((error: unknown) => {
    // `ensureAllAsync` reports per-artifact failures through its results, so this is the unexpected
    // path — but it is a detached promise, and an unhandled rejection here would surface nowhere
    // (or, on a strict host, take the process down) while the operator sees a healthy startup.
    rt.logger.warn(`model bootstrap: the provisioning sweep failed (${error instanceof Error ? error.message : String(error)})`)
  })
  // Dispatched, not awaited: the sweep must never delay the host boot (see `ensureAllAsync`).
  return { skipped: false }
}

// ─── the model warm-up as a provisioning artifact ───────────────────────────────────────────────

/** The artifact id, used in the startup log and in `ensureModelArtifact`'s errors. */
export const MODEL_ARTIFACT_ID = 'model'

/** The environment a model-artifact call runs under: the runtime that owns the model cache. */
export interface ModelArtifactEnv {
  runtime: AvantfRuntime
}

/** The slice of an artifact call this module needs (`@avantf/mem-provision`'s InstallContext). */
interface ModelInstallContext {
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
  artifactEnv?: unknown
  config: { auto_install: boolean }
}

/** Read the runtime out of the per-call env, or fail with an explanation of what is missing. */
function runtimeOf(artifactEnv: unknown): AvantfRuntime {
  const env = artifactEnv as ModelArtifactEnv | undefined
  const runtime = env?.runtime
  if (runtime === undefined) {
    throw new Error(`${MODEL_ARTIFACT_ID} artifact 需要 artifactEnv.runtime（拥有模型缓存的 runtime）`)
  }
  return runtime
}

/**
 * The embedding model (plus the nodejieba tokenizer it shares its warm-up budget with) as an
 * ARTIFACT, so the startup sweep in `@avantf/mem-provision` is the only initialization path.
 *
 * It used to be a parallel `warmModelsAsync(...)` call beside the tools sweep, which meant two
 * startup mechanisms with two logging vocabularies and no single place that answered "is this host
 * fully provisioned?". The model has no pinned version and no managed directory of its own ON THIS
 * (the flat `<repo>/<file>` layout the transformers.js cache reads), so it
 * declares neither; its `isPresent` is `false` because "is the model warm?" is not a question that
 * can be answered without attempting the warm-up, and the warm-up is cheap when the cache is
 * already there (measured ~1.2 s, in the background). The DSH plugin uses this sweep only when the
 * family framework is unavailable — with the framework up, `mem:model` owns the model root instead
 * and this artifact is not registered.
 */
export const modelArtifact = {
  id: MODEL_ARTIFACT_ID,
  title: '嵌入模型 + 分词器（启动预热）',
    // Not an install: every process rebuilds this from the local cache (see `isPresent`).
    verb: '预热',

  async isPresent(): Promise<boolean> {
    // Always warm: see the module note above.
    return false
  },

  async install(ctx: ModelInstallContext): Promise<void> {
    const rt = runtimeOf(ctx.artifactEnv)
    // NO `tools.auto_install` GUARD HERE. That switch is about downloading, and this artifact has no
    // `packs` — it never downloads on its own: the semantic warm-up loads the cache and only fetches
    // when `semantic.auto_download` says so. Refusing here meant a machine with the model already
    // cached reported "model unavailable" whenever downloads were switched off, degrading retrieval
    // to FTS+entity for exactly the operator who wanted no network traffic.
    const env = ctx.artifactEnv as ModelArtifactEnv & { waitFor?: Promise<unknown>; waitForCapMs?: number }
    const ready = await warmModels(
      rt,
      {
        deferTokenizerUntilIdle: true,
        ...(env.waitFor === undefined ? {} : { waitFor: env.waitFor }),
        ...(env.waitForCapMs === undefined ? {} : { waitForCapMs: env.waitForCapMs }),
      },
      false,
    )
    if (!ready) {
      // Reported as a FAILED artifact, not a warning: the retrieval path really is degraded, and the
      // sweep's per-artifact result is the one place a host operator looks for that.
      throw new Error('嵌入模型不可用（本机没有缓存，且 semantic.auto_download 关闭或模型不可加载），检索退化为 FTS+entity（下次检索会重试加载）')
    }
  },

  async verify(ctx: { logger: ModelInstallContext['logger'] }): Promise<void> {
    // `warmModels` already reported ready/degraded through the runtime logger, and `install` turns a
    // degraded result into a failure, so there is nothing left for a separate verification to add.
    ctx.logger.info('model bootstrap: artifact 已完成预热（语义路径可用）')
  },
}

/** Register the model artifact once per process (idempotent for a test that mounts twice). */
export function registerModelArtifact(): void {
  if (!hasArtifact(MODEL_ARTIFACT_ID)) registerArtifact(modelArtifact)
}

/**
 * `ensure('model')` with the runtime attached — the form the provisioning sweep calls.
 *
 * Exported so a test (or the MCP entry, which awaits the warm-up itself) can run the model artifact
 * alone without re-implementing the env plumbing.
 */
export async function ensureModelArtifact(
  rt: AvantfRuntime,
  options: { waitFor?: Promise<unknown>; waitForCapMs?: number; offline?: boolean } = {},
): Promise<void> {
  registerModelArtifact()
  const result = await ensure(MODEL_ARTIFACT_ID, {
    toolsDir: resolveToolsDir(parseToolsConfig(rt.config.common.tools)),
    config: parseToolsConfig(rt.config.common.tools),
    logger: rt.logger,
    artifactEnv: {
      runtime: rt,
      ...(options.waitFor === undefined ? {} : { waitFor: options.waitFor }),
      ...(options.waitForCapMs === undefined ? {} : { waitForCapMs: options.waitForCapMs }),
    } satisfies ModelArtifactEnv,
    ...(options.offline === true ? { offline: true } : {}),
  })
  if (!result.ok) throw new Error(result.error ?? `${MODEL_ARTIFACT_ID} artifact 失败`)
}

