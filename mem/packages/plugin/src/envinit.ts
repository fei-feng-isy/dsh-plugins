/**
 * Environment initialisation for the memory plugin, through the family base
 * `@avantf/dsh-plugin-base`.
 *
 * The shape is fixed by the base's DESIGN §7.2 and is the same for every plugin:
 *
 *   bootstrap (inlined) → load the base → register + declare the remaining resources → dispatch the
 *   `background` set → the plugin's own pre-mount check.
 *
 * What this plugin needs, in two phases:
 *
 *   1. **The gate, straight from the base** — the family compatibility gate is part of
 *      `@avantf/dsh-plugin-base` and arrived WITH the module the bootstrap loaded. There is no
 *      `mem:compat` item, no npm download and no managed `<home>/compat/**` copy any more; the base's
 *      `compat` module provides the rules, probes, report and post-registration check, and
 *      `runtimeFromCompat(framework)` derives this plugin's spec from it. The gate has to be runnable
 *      BEFORE anything is registered, because a proven incompatible host must refuse the mount with
 *      nothing half-registered. This replaces the bespoke self-heal the plugin used to run itself
 *      (`@avantf/mem-provision`'s `ensureCompatBase`), whose private root (`<dataHome>/dsh-compat/**`)
 *      the base deliberately does not read.
 *   2. **`mem:pandoc`** (`binary-archive`, `startup: 'background'`) — the documented "expensive but
 *      not startup-blocking" resource. It is declared AFTER the runtime exists, because its spec
 *      comes from the resolved config (`tools.auto_install`, `tools.mirror`), and it is dispatched
 *      without waiting: the caller continues its own initialisation and hooks the outcome through
 *      `onSettled`.
 *   3. **`mem:model`** (`model-cache`, `startup: 'background'`) — the embedding model. It uses the
 *      base's `flat` layout, whose files land at `<root>/<repo>/<file>` — exactly the shape
 *      `@huggingface/transformers` reads under its `cacheDir` — so the runtime loads the base's
 *      copy instead of fetching a second one. For the default repo the file list is the narrow set
 *      the runtime actually opens (see {@link MODEL_FILES}); any other repo omits the list, because
 *      a fixed six-file list made the item fail for a repo whose file set differs. The endpoint is
 *      the mirror only the operator (env) can move. It is NOT declared when the runtime reads its
 *      models elsewhere (`AVANTF_MEM_MODEL_CACHE`) — that would install a second, never-read copy.
 *      A model that cannot be fetched is a WARNING: the semantic path degrades to FTS+entity, it
 *      never refuses the mount.
 *
 * Two hard rules:
 *
 *   - **The base is never statically imported.** Only `import type` and the inlined bootstrap
 *     are static; the value comes from `loadFramework()`. A top-level value import would throw before
 *     the bootstrap ran — exactly the broken-tree case the bootstrap exists for.
 *   - **Nothing here refuses the mount.** "Cannot tell" is not "incompatible": a missing base,
 *     an unavailable gate or a failed resource is a WARNING, and the plugin mounts with its tools,
 *     service, prompt and Remote face intact.
 *
 * @module @avantf/dsh-mem/envinit
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { envAutoDownload, expandHome } from '@avantf/mem-contract'
import { PANDOC_ARTIFACT_ID, PANDOC_BINARY, PANDOC_PACKS, PANDOC_VERSION } from '@avantf/mem-provision'
import type { ProvisionItem, ProvisionReportEntry, Provisioner } from '@avantf/dsh-plugin-base'
import { loadFramework, readDependencyRange } from './envinit-bootstrap.js'
import {
  COMPAT_PACKAGE,
  reasonOf,
  runtimeFromCompat,
  warn,
  type CompatModule,
  type CompatRuntime,
} from './provision.js'

/** The family base package, as declared in this plugin's `peerDependencies`. */
const FRAMEWORK_PACKAGE = '@avantf/dsh-plugin-base'

/** The base's module shape; `import type` only — the value is always loaded dynamically. */
type EnvinitModule = typeof import('@avantf/dsh-plugin-base')

/** The plugin namespace every item is declared under (`<plugin>:<name>`, framework DESIGN §13.4). */
const PLUGIN = 'mem'

/**
 * The item ids. `resolve()` / `onSettled` are keyed by them, so the DSH plugin compares against these
 * names rather than re-spelling literals.
 */
export const PANDOC_ITEM = 'mem:pandoc'
export const MODEL_ITEM = 'mem:model'

/**
 * The default ONNX embedding repository — the one `semantic.local_model` defaults to and the one
 * {@link MODEL_FILES} describes. A DIFFERENT repo is a different file set, which is why the item
 * omits `spec.files` for it (see {@link managedModelSpec}).
 */
export const DEFAULT_MODEL_REPO = 'Xenova/bge-small-zh-v1.5'

/**
 * The files the local embedding runtime actually requests for the DEFAULT ONNX model.
 *
 * Measured, not guessed: with an empty cache, `@huggingface/transformers@4.x` resolving
 * `feature-extraction` for `Xenova/bge-small-zh-v1.5` fetches exactly these four — `config.json`,
 * `tokenizer.json`, `tokenizer_config.json` and the fp32 `onnx/model.onnx`. The repo ALSO carries
 * `special_tokens_map.json`, `vocab.txt` and seven other ONNX quantisations the default run never
 * opens; declaring them would download hundreds of megabytes of dead weight. The list stays narrow
 * to what is read.
 */
export const MODEL_FILES: readonly string[] = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model.onnx',
]

/** Startup budget for the blocking set; the framework's default is the same. */
const DEADLINE_MS = 15_000

/** This module's warning token, so one grep finds every environment-initialisation line. */
const OWN_PREFIX = 'envinit:'

/** The logging surface this module needs — `AvantfLogger` satisfies it. */
export interface EnvinitLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * What the engine resolved from its config, handed to {@link EnvinitRuntime.provisionResources}.
 *
 * `pandoc` is "this build needs it": when `tools.auto_install` is off the item is NOT declared, so the
 * framework never fetches something the operator disabled per feature. The model is declared either
 * way (unless the runtime reads its models elsewhere), because WHEN it is off is a DOWNLOAD question,
 * not a declaration question — see {@link ResourcePlan.modelAutoDownload}.
 */
export interface ResourcePlan {
  readonly pandoc: boolean
  /** `tools.mirror` — URL templates tried before the official source, for archive downloads. */
  readonly archiveMirrors: readonly string[]
  /**
   * May the MODEL item fetch from the network? `semantic.auto_download`.
   *
   * Passed per call, because only the runtime knows the resolved config: the framework's own
   * `autoDownload` policy was fixed before the config existed, so `semantic.auto_download: false`
   * used to be ignored and the item still went to the network. Off → the item is still declared (its
   * terminal state is `skipped (policy/download-disabled)`, the diagnosis an operator looks for) but
   * the framework probes disk only; the engine then degrades to FTS+entity.
   */
  readonly modelAutoDownload: boolean
  /**
   * The embedding model to provision through `model-cache`, or `undefined` when the semantic backend
   * is not a local model OR the runtime reads its models from somewhere the framework does not own
   * (an `AVANTF_MEM_MODEL_CACHE` override — see {@link managedModelSpec}). `endpoint` is the
   * resolved mirror, `files` the explicit set the runtime reads for the DEFAULT repo (empty for any
   * other repo, where the item falls back to the repository's own file list).
   */
  readonly model:
    | { readonly repo: string; readonly files: readonly string[]; readonly endpoint: string }
    | undefined
}

/**
 * The model item the framework should own, or `undefined` when it should not.
 *
 * Two refusals, both deliberate:
 *
 *   1. **Not a local backend** — nothing to provision.
 *   2. **The runtime reads its models from elsewhere** — `semantic.cache_dir` is not the framework's
 *      `<home>/models`. That happens through the operator escape hatch `AVANTF_MEM_MODEL_CACHE`
 *      (env layer ④): the runtime loads from that directory, so a `mem:model` item would install a
 *      full second copy under `<home>/models` that nothing ever reads (~190 MB). Declaring nothing
 *      is the fix; the caller warms from the override directory instead.
 *
 * `files` is the narrow {@link MODEL_FILES} set only for the DEFAULT repo; a user-changed repo has a
 * different file set, and a stale six-file list would make the item `failed` while the runtime could
 * serve it. Empty means "omit `spec.files`": the framework then installs the repository's own file
 * list.
 */
export function managedModelSpec(
  semantic: {
    readonly backend: string
    readonly local_model: string
    readonly cache_dir: string
    readonly mirror: string
  },
  modelsRoot: string,
): ResourcePlan['model'] {
  if (semantic.backend !== 'local_bge') return undefined
  if (!sameDir(semantic.cache_dir, modelsRoot)) return undefined
  return {
    repo: semantic.local_model,
    files: semantic.local_model === DEFAULT_MODEL_REPO ? MODEL_FILES : [],
    endpoint: semantic.mirror,
  }
}

/** Same directory, after `~/` expansion and normalisation (a trailing slash is not a difference). */
function sameDir(a: string, b: string): boolean {
  return resolve(expandHome(a)) === resolve(expandHome(b))
}

/** The loaded framework + gate + the roots the runtime should use. */
export interface EnvinitRuntime {
  /**
   * The loaded base module itself — the runtime source of the shared KIT (prompt files, logger,
   * family paths). `undefined` only in the test seam that injects a partial framework; the real
   * load always has it. A capability missing here is a DEGRADATION, never a refusal.
   */
  readonly kit: EnvinitModule | undefined
  /** The family root (`<home>` of the framework); resources live under it. */
  readonly home: string
  /** The gate runtime, or `undefined` when the base could not be provided (mount anyway). */
  readonly compat: CompatRuntime | undefined
  /** The engine's managed roots while the framework is usable. */
  readonly roots: { readonly tools: string; readonly models: string }
  /**
   * Declare the expensive resources and dispatch them in the BACKGROUND.
   *
   * Returns immediately; each item reaches `onSettled` when it settles (usually `present` right
   * away, or `installed`/`failed`/`skipped` later). A callback that throws is logged by the
   * framework, never fatal.
   */
  provisionResources(plan: ResourcePlan, onSettled: (entry: ProvisionReportEntry) => void): void
  /** Release every provisioner this runtime created (leases included). */
  dispose(): void
}

/** Options for {@link loadEnvinit}. */
export interface EnvinitLoadOptions {
  readonly log?: EnvinitLogger
  /** The family root; default `$AVANTF_HOME`, else `~/.avantf/env` (framework DESIGN §6.3). */
  readonly home?: string
  /** May a missing resource be downloaded? Default both kill switches on (see `envAutoDownload` in the contract). */
  readonly autoDownload?: boolean
  readonly deadlineMs?: number
  /** Test seam: the base module, instead of resolving it through the inlined bootstrap. */
  readonly framework?: EnvinitModule
  /** Test seam: a partial module to derive the gate from, instead of `framework` itself. */
  readonly compatModule?: CompatModule
}

/**
 * The family root: `$AVANTF_HOME`, else `~/.avantf/env`.
 *
 * `AVANTF_HOME` is the same variable the engine uses for its DATA home (`memory/`, `knowledge/`),
 * and that is deliberate: setting it redirects a whole tree (data AND managed resources), which is
 * exactly what a test or a sandboxed host needs. Unset — the normal case — the family root is the
 * framework's documented default and the data home stays `~/.avantf`.
 */
function resolveHome(): string {
  const configured = process.env['AVANTF_HOME']
  return configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.avantf', 'env')
}

/**
 * The download gate. Off when EITHER switch is off:
 *
 *   - `AVANTF_MEM_AUTO_DOWNLOAD=0` — this project's documented kill switch (the CLI, the MCP server
 *     and every test honour it);
 *   - `AVANTF_ENVINIT_AUTO_DOWNLOAD=0` — the family framework's switch, so an operator can turn the
 *     whole family's provisioning off in one place.
 *
 * The two-variable rule lives in ONE place (`@avantf/mem-contract`'s `envAutoDownload`), which the
 * config loader and both model adapters also call: a family switch that stops the framework but not
 * the runtime's own fetch is exactly the bug that duplication would reintroduce.
 */
function envDownloadsAllowed(): boolean {
  return envAutoDownload() ?? true
}

/** A `ProvisionLogger` over the plugin's own logger (the framework also wants `debug`). */
function provisionLogger(log: EnvinitLogger | undefined): {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
} {
  return {
    debug: (message) => { log?.info(message) },
    info: (message) => { log?.info(message) },
    warn: (message) => { log?.warn(message) },
    error: (message) => { log?.error(message) },
  }
}

/**
 * The `mem:pandoc` item: the pinned pandoc release as a `binary-archive`.
 *
 * The packs are `@avantf/mem-provision`'s (`PANDOC_PACKS`), the single source of the URLs and the
 * measured digests; this only re-spells them in the framework's vocabulary (`format` → `archive`,
 * and the binary as a NAME the archive search finds rather than a path inside the archive). The
 * framework installs it to `<home>/tools/pandoc/3.11/bin/pandoc` — the same layout the converter
 * already resolves, which is what makes the handover a config change and not a code change.
 */
function pandocItem(framework: EnvinitModule): ProvisionItem {
  const packs: Record<string, { url: string; sha256: string; archive: 'tar.gz' | 'zip' }> = {}
  for (const [key, pack] of Object.entries(PANDOC_PACKS)) {
    if (pack === undefined) continue
    packs[key] = { url: pack.url, sha256: pack.sha256, archive: pack.format }
  }
  return {
    id: PANDOC_ITEM,
    kind: framework.BINARY_ARCHIVE_KIND,
    spec: {
      id: PANDOC_ARTIFACT_ID,
      version: PANDOC_VERSION,
      binary: PANDOC_BINARY,
      packs,
    },
    target: { root: 'tools' },
    // A missing converter degrades the knowledge base's document ingestion, never the mount.
    onMissing: { atStartup: 'degrade', atUse: 'error' },
    startup: 'background',
    schemaVersion: framework.ITEM_SCHEMA_VERSION,
  }
}

/**
 * The `mem:model` item: the embedding model as a `model-cache` in the framework's `flat` layout.
 *
 * `flat` places the files at `<home>/models/<repo>/<file>` — the same tree `semantic.cache_dir`
 * points at (the framework root, through `managedRoots`) and the same shape the local runtime reads.
 * `files` is the narrow default-repo set (see {@link MODEL_FILES}); it is OMITTED for any other repo,
 * whose file set this build cannot know, so the framework installs the repository's own list instead
 * of failing on a missing fixed path. `endpoint` is the mirror resolved from the operator's env
 * escape hatch, so neither the landing site nor the source is chosen by an end user's `config.yaml`.
 *
 * A missing model is a degraded semantic path, NOT a refused mount: both `onMissing` axes are
 * `degrade`, and the engine falls back to FTS+entity.
 */
function modelItem(framework: EnvinitModule, model: NonNullable<ResourcePlan['model']>): ProvisionItem {
  return {
    id: MODEL_ITEM,
    kind: framework.MODEL_CACHE_KIND,
    spec: {
      repo: model.repo,
      revision: 'main',
      layout: 'flat',
      ...(model.files.length === 0 ? {} : { files: [...model.files] }),
      endpoint: model.endpoint,
    },
    target: { root: 'models' },
    onMissing: { atStartup: 'degrade', atUse: 'degrade' },
    startup: 'background',
    schemaVersion: framework.ITEM_SCHEMA_VERSION,
  }
}

let loaded: EnvinitRuntime | undefined
let loading: Promise<EnvinitRuntime | undefined> | undefined

/**
 * Ensure the framework, then the compatibility base, then dispatch the expensive resources.
 *
 * Never throws. Returns `undefined` when the framework cannot be loaded — the caller then warns and
 * mounts on the legacy provisioning path (the engine's own `@avantf/mem-provision` sweep, whose
 * default directories are the pre-migration ones). A framework that loads but cannot provide the
 * base still returns a runtime, with `compat: undefined`: the mount must continue, and the resource
 * items are still worth dispatching.
 *
 * The result is cached per process; a FAILED load is not, so a profile reload retries instead of
 * replaying the first failure for the whole process lifetime.
 *
 * @param options - logger, family root, download policy and the test seams.
 * @returns the loaded runtime, or `undefined` when the framework itself is unavailable.
 */
export async function loadEnvinit(options: EnvinitLoadOptions = {}): Promise<EnvinitRuntime | undefined> {
  if (loaded !== undefined) return loaded
  if (loading !== undefined) return loading
  loading = loadGuarded(options).then(
    (runtime) => {
      // A failure is "cannot tell", not a verdict — and it may be transient (offline at boot,
      // registry hiccup). Drop the cache so a profile reload, or a second instance in the same
      // process, retries instead of replaying the first failure for the whole process lifetime.
      if (runtime === undefined) loading = undefined
      else loaded = runtime
      return runtime
    },
    () => {
      loading = undefined
      return undefined
    },
  )
  return loading
}

/** The guard that makes "never throws" true: every failure is a warning plus `undefined`. */
async function loadGuarded(options: EnvinitLoadOptions): Promise<EnvinitRuntime | undefined> {
  try {
    return await loadOnce(options)
  } catch (error) {
    warn(
      options.log,
      `${OWN_PREFIX} WARNING — environment initialisation failed (${reasonOf(error)}); the framework is SKIPPED and the plugin will mount anyway`,
    )
    return undefined
  }
}

/** The body of {@link loadEnvinit}; the cache above makes it run at most once per process. */
async function loadOnce(options: EnvinitLoadOptions): Promise<EnvinitRuntime | undefined> {
  const home = options.home ?? resolveHome()
  const range = await readDependencyRange(fileURLToPath(import.meta.url))
  const autoDownload = options.autoDownload ?? envDownloadsAllowed()
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS

  // Step 1–2: bootstrap → the framework itself (the package manager's copy, zero download). The
  // plugin's declared range is not judged here; it goes to `envinitRange` below, per manifest.
  const framework = options.framework ?? await loadFramework<EnvinitModule>({
    logger: {
      warn: (message) => { warn(options.log, `${FRAMEWORK_PACKAGE}: ${message}`) },
      info: (message) => { options.log?.info(`${FRAMEWORK_PACKAGE}: ${message}`) },
    },
  })
  if (framework === undefined) {
    warn(
      options.log,
      `${OWN_PREFIX} WARNING — ${FRAMEWORK_PACKAGE} could not be made available; the plugin falls back to its own provisioning and mounts anyway`,
    )
    return undefined
  }

  // The compatibility gate is part of the base package and arrived WITH it: there is no `mem:compat`
  // item, no npm download and no managed `~/.avantf/env/compat/**` any more. `runtimeFromCompat`
  // takes the loaded base module directly. A gate that cannot be built is a WARNING (the plugin
  // mounts and writes its own default prompts), never a refusal.
  const disposers: Provisioner[] = []
  let compat: CompatRuntime | undefined
  try {
    compat = runtimeFromCompat(options.compatModule ?? framework)
  } catch (error) {
    warn(
      options.log,
      `${OWN_PREFIX} WARNING — the ${COMPAT_PACKAGE} compatibility gate could not be initialised (${reasonOf(error)}); the compatibility gate is SKIPPED and the plugin will mount anyway`,
    )
  }

  let disposed = false
  return {
    home,
    kit: framework,
    compat,
    roots: { tools: join(home, 'tools'), models: join(home, 'models') },
    provisionResources(plan, onSettled) {
      if (disposed) return
      const items: ProvisionItem[] = []
      if (plan.pandoc) items.push(pandocItem(framework))
      if (plan.model !== undefined) items.push(modelItem(framework, plan.model))
      if (items.length === 0) return

      // A SECOND provisioner, on purpose: `policy.mirrors.archive` is the engine's `tools.mirror`,
      // which is only known after the runtime resolved its config — while the compat provisioner had
      // to exist before that, to run the gate. Two instances sharing one family root are supported by
      // design (framework DESIGN §13.1), and their item sets are disjoint.
      //
      // `autoDownload` is per KIND: the env kill switches turn everything off, otherwise the model
      // follows `semantic.auto_download` while pandoc keeps its own gate (`tools.auto_install`,
      // which decides whether it is declared at all). Folding the two into one boolean would let
      // `semantic.auto_download: false` skip a pandoc the operator explicitly asked for — or, the
      // other way round, let a disabled model still hit the network.
      const resources = framework.createProvisioner({
        home,
        envinitRange: range,
        logger: provisionLogger(options.log),
        policy: {
          autoDownload: autoDownload ? { [framework.MODEL_CACHE_KIND]: plan.modelAutoDownload } : false,
          deadlineMs,
          mirrors: { archive: [...plan.archiveMirrors] },
        },
      })
      resources.register(framework.binaryArchiveProvider())
      resources.register(framework.modelCacheProvider())
      resources.declare({ plugin: PLUGIN, items })
      disposers.push(resources)
      // Dispatched, not awaited: `startup: 'background'` items never occupy the ensure budget.
      // The `.catch` is not decoration: an unhandled rejection is FATAL on a strict host (Node's
      // default `--unhandled-rejections=throw`), and a memory plugin must not be able to take the
      // host down over a resource it could not fetch. The compat ensure above is awaited instead,
      // so its rejection is handled by `loadGuarded`.
      void resources.ensure({
        only: items.map(item => item.id),
        onSettled: (entry) => {
          try {
            onSettled(entry)
          } catch (error) {
            warn(options.log, `${OWN_PREFIX} WARNING — the onSettled callback failed (${reasonOf(error)})`)
          }
        },
      }).catch((error: unknown) => {
        warn(options.log, `${OWN_PREFIX} WARNING — declaring the background resources failed (${reasonOf(error)}); the plugin continues (tools stay registered)`)
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const instance of disposers.splice(0)) {
        try {
          instance.dispose()
        } catch {
          // Disposal is best-effort; a throwing release must not break unmount.
        }
      }
      loaded = undefined
      loading = undefined
    },
  }
}
