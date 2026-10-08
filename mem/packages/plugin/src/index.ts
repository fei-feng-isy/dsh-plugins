/**
 * @avantf/dsh-mem — DSH native Cordis host plugin (standard plugin form).
 *
 * Built inside the DSH harness workspace (its `@deepseek-ai/dsh-tools` /
 * `@deepseek-ai/dsh-typert-protocol` deps resolve there). It does NOT use the
 * dynamic-package `harness` builtin — model tools register via
 * `ctx.tools.register(defineTool(...))` and the client↔host bridge is a
 * `TypertRemoteService`, so a normal DSH profile plugin can run it.
 *
 * Tool inputs are declared explicitly for the model: the contract's zod unions
 * are flattened into DSH ParameterSchemaSpec with per-field `description`,
 * array `items`, enums and integer types, and every call is re-validated with
 * the contract schema before dispatch so a bad call returns a structured error
 * instead of a raw runtime exception.
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
// Augments `Context` with the prompt registry below; type-only, so nothing of the package lands
// in the bundle — the service itself is the host's.
import type {} from '@deepseek-ai/dsh-system-prompt'
import { buildPromptSections, PROMPT_NAMESPACE, promptFileSpecs, promptTextWarnings } from './prompt.js'
import { hintText, messageText } from './hints.js'
import z from '@deepseek-ai/schemastery'
import { defineTool, type GenericCallView, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  awaitStartupGate,
  buildRuntime,
  dispatchToolKey,
  installTrustHeartbeat,
  provisionToolchainAsync,
  runToolSpec as runToolSpecShared,
  warmSemanticAsync,
  warmTokenizerAsync,
  type AvantfRuntime,
  type KnowledgeStore,
  type MemoryStore,
  type RelevanceHit,
  type StoreResult,
} from '@avantf/mem'
import {
  REMEMBER_TOOL,
  RECALL_TOOL,
  ADMIN_TOOL,
  KB_TOOL,
  QUERY_TOOL,
  TOOL_SPECS,
  adoptWellFormed,
  createConsoleLogger,
  describeError,
  toolErr,
  validationError,
  remoteErrorText,
  type BrowseListing,
  type OpenOutcome,
  type OpenTarget,
  type RecallResult,
  type RemoteEnvelope,
  type RemoteErr,
  type SourceClassification,
  type AvantfLogger,
  type ToolSpec,
} from '@avantf/mem-contract'
import { hostContribution, wireErr, wireOk } from './remote.js'
import { configDataHome } from './data_home.js'
import { provision, registerCompatMegaphone, verifyRegisteredFaces, type CompatVerdict } from './provision.js'
import { createCorpusReconciler } from './reconcile.js'
import {
  managedModelSpec,
  MODEL_ITEM,
  PANDOC_ITEM,
  loadEnvinit,
  type EnvinitRuntime,
  type ResourcePlan,
} from './envinit.js'
import { parseToolsConfig, resolveToolsDir } from '@avantf/mem-provision'
import { resetPandocResolution, setPandocProvisioning } from '@avantf/mem-convert'
import { openDocumentPath } from './open.js'
import { createVectorMigration } from './vectorMigration.js'
import { browseDirectory, classifySource } from '@avantf/mem'
import { flattenToolSpec } from './tool_schema.js'
import { OUTPUT } from './render.js'

export const name = 'avantf-mem'
export { inject } from './inject.js'

// The section text lives in its own module so it is testable without this entry's harness imports.
export { KNOWLEDGE_PROMPT_SECTION, MEMORY_PROMPT_SECTION } from './prompt.js'

// The pluggable retrieval surface, re-exported on the PUBLISHED face (DESIGN §5 "可选注册新适配器"):
// register a backend under a name, put that name in `config.<semantic|vectorStore>.backend`, and
// `buildRuntime` resolves it — the business flow never changes. Without this re-export the promise was
// unkeepable from outside the repo: the registries live in `@avantf/mem-retrieval`, a private package
// that is inlined into `lib/index.js` and is not on npm. These are the same registry instance
// `buildRuntime` reads, because both are this one bundled engine.
export {
  registerSemanticBackend,
  registerVectorStore,
  type SemanticBackend,
  type VectorStore,
} from '@avantf/mem'

export interface Config {
  mode?: 'cordis' | 'mcp'
  dataHome?: string
}
export const Config: z<Config> = z.object({
  mode: z.union([z.const('cordis'), z.const('mcp')]).default('cordis'),
  // Deliberately NO default: this is a CONFIGURED value (layer ②), so `$AVANTF_HOME` (④) has to be
  // able to outrank it — and a literal `~/.avantf` default would make "unset" indistinguishable from
  // "configured as the default", which is how merely having a default used to kill the env var. Left
  // unset, resolution falls through ④ to the default (see `configDataHome`).
  dataHome: z.string(),
})

/**
 * Facts whose entity/triple rows the heartbeat may rebuild per beat.
 *
 * Tagging is ~0.02 ms for an ordinary fact (nodejieba, measured), so this batch is tens of
 * milliseconds on a quiet moment — small enough for a 60-minute heartbeat and large enough to
 * adopt a whole corpus over a few beats after an extraction change.
 */
const ENTITY_SWEEP_PER_HEARTBEAT = 2000

/** Minimum spacing between corpus drift checks (`tools/result` fires for EVERY tool). */
const RECONCILE_MIN_INTERVAL_MS = 2000

// ─── dispatch: validate with the contract schema, never leak a raw exception ──────────────────
//
// The validation → dispatch → agent-envelope path is the ENGINE's (`@avantf/mem`'s `runToolSpec`),
// shared with the MCP server; only what surrounds the envelope (the `present` view, the Remote
// gateway) is this file's. It used to be duplicated, and the copy that drifted was the MCP one: the
// four `kb_*` tools were advertised to the model and answered `unknown tool key` on every call.

async function runToolSpec(spec: ToolSpec, rt: AvantfRuntime, args: unknown): Promise<Record<string, JsonValue>> {
  // The envelope's element type is the contract's `ToolEnvelope`; the DSH tool face wants the same
  // object seen as an indexable record. One cast, at the boundary, with the shared function as the
  // oracle in between.
  return await runToolSpecShared(rt, spec, args) as unknown as Record<string, JsonValue>
}

function present(spec: ToolSpec, args: Record<string, unknown>): GenericCallView {
  return { card: 'generic', title: spec.name, kind: 'other', rawInput: args }
}

// ─── client↔host Remote gateway (replaces the dynamic `harness.handle`) ──────────────────────

type WireArgs = Record<string, unknown>

/** Drop wire keys explicitly set to undefined so they cannot clobber defaults. */
function defined(args: WireArgs): WireArgs {
  return Object.fromEntries(Object.entries(args ?? {}).filter(([, value]) => value !== undefined))
}

/**
 * Pass-through gateway mirroring the five agent tools. Every payload is
 * re-validated with the contract zod union before dispatch (same guarantee the
 * tools give the model), and results are wrapped in the contract's
 * `{ok:true,value}` / `{ok:false,error,violations}` RemoteEnvelope the client decodes.
 *
 * Every envelope — success and failure, tool-backed and UI-only — is built through `wireOk`/`wireErr`
 * so it carries this build's `WIRE_VERSION`. That is what lets a freshly reloaded browser half tell
 * whether the host process predates a method it is about to call, instead of reading the gateway's
 * 404 as "the record is gone" (see `remote.ts`).
 */
export class AvantfMemGateway extends TypertRemoteService {
  private readonly rt: AvantfRuntime
  constructor(ctx: Context, rt: AvantfRuntime) {
    super(ctx, 'avantfMem')
    this.rt = rt
  }

  /**
   * Run one already-validated tool call and wrap the answer in the contract envelope.
   *
   * `T` is the payload the tool key is DECLARED to answer, spelled at each `@Remote` below; this used
   * to be `unknown` everywhere, which made the host half the one seam in the type chain where nothing
   * said what crosses the wire. The single `as T` is unavoidable and is the honest part: the dispatch
   * table is keyed by `ToolSpec.key` (a `string`), so its result is `unknown` by construction. Naming
   * the type is what turns "the client assumed a shape" into "the engine's own type is what the host
   * claims to send".
   */
  private async call<T>(key: string, spec: ToolSpec, payload: WireArgs): Promise<RemoteEnvelope<T>> {
    const parsed = spec.input.safeParse(payload)
    if (!parsed.success) {
      // Same message + violations format the agent tools return (contract helper).
      return wireErr(validationError(spec.name, parsed.error.issues) as Omit<RemoteErr, 'wire'>)
    }
    try {
      const value = await dispatchToolKey(this.rt, key, parsed.data as WireArgs)
      return wireOk((value ?? null) as T)
    } catch (error) {
      return wireErr({ ok: false, error: remoteErrorText(error) })
    }
  }

  /**
   * Each payload is written as the ENGINE type that produces it (`StoreResult<…>`, or a contract
   * interface), never as a hand-copied shape: if a store method's result changes, the declaration
   * here stops compiling instead of quietly misdescribing the wire.
   */
  @Remote('remember')
  remember(args: WireArgs): Promise<RemoteEnvelope<StoreResult<MemoryStore, 'add'>>> {
    const payload = defined(args)
    return this.call('remember', REMEMBER_TOOL, { action: 'add', ...payload })
  }

  @Remote('recall')
  recall(args: WireArgs): Promise<RemoteEnvelope<StoreResult<MemoryStore, 'search'>>> {
    const payload = defined(args)
    return this.call('recall', RECALL_TOOL, { action: 'search', ...payload })
  }

  @Remote('admin')
  admin(args: WireArgs): Promise<RemoteEnvelope<StoreResult<MemoryStore, 'list'>>> {
    const payload = defined(args)
    return this.call('admin', ADMIN_TOOL, { action: 'list', ...payload })
  }

  /**
   * The one method that keeps `unknown`, and deliberately: its payload is whichever of the seven
   * corpus actions the caller asked for (a page, one document, an ingest report, a conflict report, a
   * reindex plan …), so there is no single engine type to name. The engine's `KbDispatch` spells all
   * seven out; the client names its expectation at each call site (`callRemote<…>(…)`).
   */
  @Remote('kb')
  kb(args: WireArgs): Promise<RemoteEnvelope<unknown>> {
    // No safe default action for kb — a missing action fails contract validation
    // with an explicit violation instead of guessing.
    return this.call('kb', KB_TOOL, defined(args))
  }

  @Remote('query')
  query(args: WireArgs): Promise<RemoteEnvelope<RecallResult>> {
    return this.call('query', QUERY_TOOL, defined(args))
  }

  /**
   * UI-only: what IS this string? Answered against the ingestion boundary, so the UI can label the
   * input and pick the right `kb_manage` action (URL → fetch, file → ingest, directory → import,
   * text → ingest the string itself, missing → refuse and say why).
   */
  @Remote('classifySource')
  async classifySource(args: WireArgs): Promise<RemoteEnvelope<SourceClassification>> {
    try {
      const payload = defined(args)
      const text = typeof payload.text === 'string' ? payload.text : ''
      return wireOk(classifySource(text, this.rt.config.knowledge.ingest))
    } catch (error) {
      return wireErr({ ok: false, error: remoteErrorText(error) })
    }
  }

  /** UI-only: one directory listing for the 选择 picker (same boundary as ingestion). */
  @Remote('browseDir')
  async browseDir(args: WireArgs): Promise<RemoteEnvelope<BrowseListing>> {
    try {
      const payload = defined(args)
      const path = typeof payload.path === 'string' && payload.path !== '' ? payload.path : undefined
      return wireOk(browseDirectory(path, this.rt.config.knowledge.ingest))
    } catch (error) {
      return wireErr({ ok: false, error: remoteErrorText(error) })
    }
  }

  /**
   * UI-only: the 知识页 domain picker's options — the configured `knowledge.domains` allowlist
   * together with the domains the library already holds — plus whether the allowlist is active
   * (non-empty). The host is the only side that knows either half.
   */
  @Remote('kbDomains')
  async kbDomains(_args: WireArgs): Promise<RemoteEnvelope<StoreResult<KnowledgeStore, 'domainCatalog'>>> {
    try {
      return wireOk(this.rt.knowledge.domainCatalog())
    } catch (error) {
      return wireErr({ ok: false, error: remoteErrorText(error) })
    }
  }

  /**
   * UI-only: add one 知识域 to the store config's `domains` allowlist AND to the live set, so the
   * 知识 tab's 「+」 works without a restart. No agent tool mirrors this on purpose — the model must
   * stay bounded by the configured list, while the user can widen it.
   */
  @Remote('kbAddDomain')
  async kbAddDomain(args: WireArgs): Promise<RemoteEnvelope<StoreResult<KnowledgeStore, 'addDomain'>>> {
    try {
      const payload = defined(args)
      const domain = typeof payload.domain === 'string' ? payload.domain : ''
      return wireOk(this.rt.knowledge.addDomain(domain))
    } catch (error) {
      return wireErr({ ok: false, error: remoteErrorText(error) })
    }
  }

  /**
   * UI-only: hand one managed document file — or the directory that holds it — to the user's
   * editor. No agent tool mirrors this, so it carries its own envelope instead of going through
   * `dispatchToolKey`; the path is resolved from `doc_id` here, so nothing the client sends is
   * trusted.
   */
  @Remote('openDoc')
  async openDoc(args: WireArgs): Promise<RemoteEnvelope<OpenOutcome>> {
    try {
      const payload = defined(args)
      const docId = typeof payload.doc_id === 'number' ? payload.doc_id : undefined
      if (docId === undefined) return wireErr({ ok: false, error: 'openDoc 需要 doc_id' })
      const path = this.rt.knowledge.docFilePath(docId)
      if (path === null) return wireErr({ ok: false, error: `文档 #${String(docId)} 不存在` })
      const target: OpenTarget = payload.target === 'dir' ? 'dir' : 'file'
      if (target === 'file' && !existsSync(path)) {
        return wireErr({ ok: false, error: `受管文件不存在：${path}（重新摄入会重建它）` })
      }
      const outcome = openDocumentPath(path, target, this.rt.config.knowledge.open.editor)
      return wireOk(outcome)
    } catch (error) {
      return wireErr({ ok: false, error: remoteErrorText(error) })
    }
  }
}

/**
 * Startup/lifecycle logging sink.
 *
 * DSH's `ctx.logger` currently has only a buffered exporter, so lines written
 * through it never reach the terminal. Startup diagnostics therefore go to
 * stderr (the CLI/MCP convention, keeping stdout free for data) and are mirrored
 * into the host logger for any in-app log surface.
 */
function hostLogger(ctx: Context): AvantfLogger {
  const local = createConsoleLogger('[avantf-mem]')
  const host = ctx.logger
  return {
    info: (message) => { local.info(message); host.info(message) },
    warn: (message) => { local.warn(message); host.warn(message) },
    error: (message) => { local.error(message); host.error(message) },
  }
}

/**
 * Whether this plugin's fiber is still alive after the environment await.
 *
 * The environment gate can take the whole startup budget (15 s on a first run) and the framework may
 * even fetch the gate's base during it. A profile reload or unload landing inside that window clears
 * the fiber's uid, after which every Cordis call throws `INACTIVE_EFFECT` — the plugin would then
 * half-register (the Remote face cannot be rolled back) instead of stopping cleanly. An unknown
 * shape is "cannot tell", so only an explicitly cleared uid counts as disposed.
 */
function stillActive(ctx: Context): boolean {
  const fiber = (ctx as unknown as { fiber?: { uid?: unknown } }).fiber
  return fiber === undefined || fiber.uid !== null
}

/**
 * Declare the expensive resources through the family framework, warm the tokenizer and the embedding
 * model, and continue initialisation as each item settles.
 *
 * Everything here is fire-and-forget: `background` items never occupy the startup budget, and the
 * callbacks ARE the "continue once the resource is there" step (framework DESIGN §7.2 step 5).
 *
 * **What the framework owns here.** `mem:pandoc` and `mem:model` are framework items. The embedding
 * model is a `model-cache` in the framework's `flat` layout, so its files land at
 * `<home>/models/<repo>/<file>` — the tree `semantic.cache_dir` resolves to (the family root, via
 * `managedRoots`) and the shape `@huggingface/transformers` reads under `env.cacheDir`. The runtime
 * therefore loads the framework's copy instead of fetching a second one.
 *
 * The model is NOT declared when the runtime's cache dir is somewhere else (`AVANTF_MEM_MODEL_CACHE`
 * — `managedModelSpec` decides): the framework's root would then collect a copy nothing reads. In
 * that case, and whenever no item will warm the model, the warm is started here directly.
 *
 * Outcomes handled below:
 *
 *   - `mem:model` settles (present/installed) → warm the semantic path from the managed root, now
 *     that the files are on disk. That ordering is the whole point: the runtime's constructor warm is
 *     deferred while the framework is up (`deferWarm`), so nothing can race the install, and the
 *     explicit warm here is what starts the model.
 *   - `mem:model` failed/skipped → one WARNING, then STILL warm: with `semantic.auto_download` on the
 *     runtime takes its own download path, and with it off the semantic leg degrades to FTS+entity.
 *     Either way the mount is untouched.
 *   - `mem:pandoc` unavailable → point the converter back at the pre-migration tools directory, so an
 *     already-installed copy (or one on PATH) keeps document ingestion working.
 *   - anything failed/skipped → one WARNING, with the framework's stable reason code.
 *
 * @param env - the loaded framework runtime.
 * @param rt - the built engine runtime (its resolved config drives the specs).
 * @param logger - the plugin's logger.
 * @param waitFor - the host's readiness signal, for the tokenizer warm.
 */
function startManagedResources(
  env: EnvinitRuntime,
  rt: AvantfRuntime,
  logger: AvantfLogger,
  waitFor: Promise<unknown> | undefined,
): void {
  const { semantic, tools } = rt.config.common
  // `undefined` in two cases: the semantic backend is not a local model, or the runtime reads models
  // from an operator override instead of the framework root (see `managedModelSpec`).
  const model = managedModelSpec(semantic, env.roots.models)
  const plan: ResourcePlan = {
    pandoc: tools.auto_install,
    archiveMirrors: tools.mirror,
    // The item is still declared when downloads are off — its `skipped (policy/download-disabled)`
    // line is the diagnosis — but the framework then probes disk only, never the network.
    modelAutoDownload: semantic.auto_download,
    model,
  }
  // The tokenizer needs no provisioning — nodejieba is an optional npm dependency — so it warms
  // behind the same host-readiness signal the legacy sweep used.
  warmTokenizerAsync(rt, { ...(waitFor === undefined ? {} : { waitFor }) })

  if (model === undefined && semantic.backend === 'local_bge') {
    // No `mem:model` item owns the model: nobody will call back, so warm from wherever the runtime
    // reads (the `AVANTF_MEM_MODEL_CACHE` directory). `semantic.auto_download` decides whether a
    // missing cache is fetched or degrades.
    warmSemanticAsync(rt)
  }

  env.provisionResources(plan, (entry) => {
    if (entry.id === MODEL_ITEM) {
      // The model files are (or are not) on disk now; only now may the runtime look. On success it
      // reads `<repo>/<file>` from the managed root; on failure it takes its own download or degrades
      // to FTS+entity. Warming on both paths is deliberate — the warning below is the diagnosis.
      warmSemanticAsync(rt)
    }
    const unavailable = entry.action === 'failed' || entry.action === 'skipped'
    if (unavailable) {
      logger.warn(
        `envinit: ${entry.id} is ${entry.action} (${String(entry.code)}${entry.reason === undefined ? '' : ` — ${entry.reason}`})`,
      )
      if (entry.id === PANDOC_ITEM) {
        // No legacy directory to fall back TO any more: the resolved managed root is the family
        // root, so this is simply "the converter may install/read it itself".
        const fallback = resolveToolsDir(parseToolsConfig(rt.config.common.tools))
        logger.warn(`envinit: pandoc unavailable from the framework; the converter will use ${fallback} (override with tools.dir or AVANTF_PANDOC)`)
        setPandocProvisioning({
          toolsDir: fallback,
          mirror: rt.config.common.tools.mirror,
          autoInstall: rt.config.common.tools.auto_install,
          logger,
        })
        resetPandocResolution()
      }
      return
    }
    logger.info(`envinit: ${entry.id} ${entry.action} (${entry.source}${entry.version === undefined ? '' : ` ${entry.version}`})`)
  })
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = hostLogger(ctx)

  // ── environment initialisation — FIRST, before the runtime allocates anything ────────────────
  // The family base's fixed sequence (its DESIGN §7.2): bootstrap (inlined) → load
  // `@avantf/dsh-plugin-base` → derive the compatibility gate from the loaded module → declare the
  // remaining resources. The check runs before anything is registered, so "do not load" costs
  // nothing to unwind.
  //
  // The base (`@avantf/dsh-plugin-base`, whose `compat` module used to be `@avantf/dsh-compat`) IS
  // the framework the bootstrap loads, and it brings the gate with it: no `mem:compat` item and no
  // managed copy to download. The plugin no longer carries its own self-heal through
  // `@avantf/mem-provision`, whose private root the base deliberately does not read. When the base
  // itself is unavailable the plugin keeps mounting (see below) and falls back to its legacy
  // provisioning path, whose default directories are the pre-migration ones.
  //
  // When the base cannot be obtained at all we do NOT refuse: a `compat:` WARNING is logged and the
  // plugin mounts normally (tools/service/prompt/remote all register), because the gate is a safety
  // net and "cannot tell" is not "incompatible". Only a PROVEN break (`probe-failed`) refuses.
  const env = await loadEnvinit({ log: logger })

  // The await above can last the whole startup budget (15 s on a first run). A profile reload or
  // unload during it clears this fiber's uid, and every later Cordis call — `ctx.effect`, `ctx.on`,
  // `ctx.tools.register` — then throws `INACTIVE_EFFECT`. Re-assert liveness and stop cleanly here
  // rather than half-registering (the Remote face cannot be rolled back).
  if (!stillActive(ctx)) {
    logger.warn('unmounted while preparing the environment; stopping before registering anything')
    return
  }

  // ── the base's well-formed helpers, when the loaded base carries them (interface v2) ──────────
  // The family decision rule for this knowledge: "can ONE base release fix it?" YES — the lone
  // surrogate repair is the base kit's `wellFormedText` / `wellFormedDeep` — so the plugin takes the
  // implementation off the module the bootstrap LOADED, not from an inline copy. The base cannot be
  // statically imported (it may be absent), so the module instance is the bridge:
  // `adoptWellFormed` hands the loaded base to the engine's mirror (`@avantf/mem-contract`), which
  // is what the write entry (`normalizeWrite`) and this file's model-facing `OUTPUT` both call.
  //
  // Availability is judged PER MEMBER — `typeof kit.wellFormedText === 'function'` — never by the
  // interface generation: the v2 members are an OPTIONAL capability, and a v1 base (or a
  // `cannot-tell` module) must keep mounting with the mirror. `env` is `undefined` on the two
  // degradation routes the loader already handles (base absent, interface `incompatible`), so this
  // is also the exact point where "no host" resolves to the mirror. It cannot throw, and it changes
  // nothing about the mount.
  const wellFormed = adoptWellFormed(env?.kit)
  logger.info(
    wellFormed.text && wellFormed.deep
      ? "well-formed repair: the base kit's wellFormedText/wellFormedDeep (interface v2)"
      : 'well-formed repair: the mem mirror (the base is absent, or predates the v2 helpers)',
  )

  const compat = env?.compat
  let verdict: CompatVerdict | undefined
  if (compat === undefined) {
    logger.warn('plugin mount: the dsh compatibility gate is ABSENT (@avantf/dsh-plugin-base unavailable — see the WARNING above); mounting the full plugin anyway')
  } else {
    const run = provision(ctx, logger, compat)
    if (!run.verdict.load) {
      registerCompatMegaphone(ctx, run.verdict, logger, compat)
      logger.warn('plugin not loaded: the host dsh API is incompatible (compat check above) — nothing was registered; switch to a dsh version this package declares compatible, or upgrade this plugin')
      return
    }
    verdict = run.verdict
  }

  // The model-facing set comes from the contract's `TOOL_SPECS` — ONE list, so adding or splitting a
  // tool cannot leave this file behind. (It WAS hardcoded here, and that is exactly what happened:
  // splitting `kb_manage` into `kb_add`/`kb_list`/`kb_remove`/`kb_reindex` left the plugin still
  // registering the old five until this line was found.)
  const toolSpecs = TOOL_SPECS
  if (config.mode === 'mcp') {
    // The MCP entry is a standalone stdio process (@avantf/mem-mcp); an in-process
    // DSH plugin cannot own the host's stdio. Warn and mount the cordis toolset.
    logger.warn('config mode=mcp is not served in-process — mounting the cordis toolset; run @avantf/mem-mcp standalone for MCP')
  }
  // Resolved through the CONFIG layer, not used as an explicit value: `$AVANTF_HOME` outranks the
  // profile's `dataHome`, the same way it outranks the mission plugin's (see `data_home.ts`).
  const dataHome = configDataHome(config.dataHome)
  // Both halves are logged: what was configured, and where it actually landed — the runtime's own
  // init line repeats the latter, but a reader of this line should not have to join two log lines to
  // find out that a configured value was overridden by the environment.
  logger.info(
    `plugin mount: mode=${config.mode ?? 'cordis'} dataHome=${dataHome}`
    + ` (configured ${config.dataHome ?? 'unset'})`,
  )

  let rt: AvantfRuntime
  try {
    rt = buildRuntime({
      dataHome,
      logger,
      // The family framework owns pandoc and the embedding model when it is up: its managed roots
      // become this process's built-in defaults, so the converter and the semantic backend look
      // where the framework publishes. A `tools.dir` / `semantic.cache_dir` in config.yaml (or an
      // `AVANTF_*` escape hatch) still wins — the framework roots are only layer ①.
      ...(env === undefined ? {} : { managedRoots: { tools: env.roots.tools, models: env.roots.models } }),
    })
  } catch (error) {
    // A memory plugin must not be able to stop the host from booting. Everything that can fail here
    // is environmental — a corrupt or locked database, an unwritable data home, or a database
    // written by a NEWER version (`SchemaDowngradeError`) — and the loader treats a throwing `apply`
    // as a failed row, which is enough to fail the whole `dsh web` boot (observed). Degrade instead:
    // the eight tools stay registered and each answers with the REASON, so the model and the operator
    // get a diagnosis instead of a missing tool and a silent absence.
    const reason = describeError(error)
    logger.error(`runtime unavailable — mounting DEGRADED (tools answer with the reason): ${reason}`)
    const message = `memory unavailable: ${reason}`
    for (const spec of toolSpecs) {
      ctx.tools.register(
        defineTool({
          name: spec.name,
          description: spec.description,
          parameters: flattenToolSpec(spec) as unknown as ParameterSchemaSpec,
          output: OUTPUT,
          execute: () => Promise.resolve(toolErr(message) as unknown as Record<string, JsonValue>),
          presentCall: (args) => present(spec, args as Record<string, unknown>),
        }),
      )
      logger.info(`tool registered (DEGRADED): ${spec.name}`)
    }
    logger.warn('client tabs unavailable: no runtime to serve the `avantfMem` remote (fix the error above, then restart)')
    return
  }
  ctx.provide('avantfMemory', rt)
  logger.info('service registered: avantfMemory')

  // ONE initialization path for everything this plugin must PROVIDE: the pandoc binary every
  // document conversion goes through, and the embedding model + tokenizer warm-up.
  //
  // WHICH mechanism does the fetching is decided by whether the family framework came up:
  //
  //   - framework available → `mem:pandoc` and `mem:model` are declared as BACKGROUND items and
  //     dispatched now; the plugin keeps initialising and continues on each `onSettled`. Nothing here
  //     waits for a 35 MB archive or a ~90 MB model. The engine's managed roots were already pointed
  //     at the family root above, so the semantic backend reads the very tree the framework fills,
  //     and the warm starts from the model item's settle callback rather than racing it.
  //   - framework unavailable → the legacy `@avantf/mem-provision` sweep, over the pre-migration
  //     default directories, exactly as before.
  //
  // nodejieba's dictionary parse is ~1.2 s of SYNCHRONOUS main-thread mission, so it must not run
  // while the host is still booting: measured, `dsh web` printed its URL line 0.09 s after our
  // "tokenizer ready" line, i.e. the parse was the last thing gating startup. The host's own
  // readiness signal is its loader tree settling (`loader.await()` — what the web app awaits before
  // printing the URL); both paths warm the tokenizer behind it.
  const loader = (ctx as unknown as { get(name: string): { await?: () => Promise<unknown> } | undefined }).get('loader')
  const waitFor = loader?.await === undefined ? undefined : loader.await()
  if (env !== undefined) {
    startManagedResources(env, rt, logger, waitFor)
  } else {
    // The verdict the front gate JUST computed is handed to the sweep, whose first step reads `load`
    // (see `provisionToolchainAsync`): an incompatible host provisions NOTHING. Dispatched, not
    // awaited. Omitted when the gate could not run at all (`compat === undefined`), in which case
    // "cannot tell" means the sweep runs as usual.
    void provisionToolchainAsync(rt, {
      ...(waitFor === undefined ? {} : { waitFor }),
      ...(verdict === undefined ? {} : { dshCompat: verdict }),
    })
  }

  // ── bounding the "changed embedding space" repair ──────────────────────────────────────────
  // A changed default model/width makes every persisted vector unusable by the semantic leg; both
  // stores say so LOUDLY at open (count + reason + manual entry) and this controller re-encodes them
  // in the background, in bounded batches, behind the startup gate below — never in the boot window
  // (§20.14), never blocking a query, and resumable because "what is stale" is re-derived from each
  // database on every pass. ONE pass covers both libraries (`store/vector_repair.ts`).
  // `semantic.auto_migrate: false` turns the automatic half off and leaves the warning + `vectors
  // --fix`; the shared flow catches per-batch failures.
  const vectorMigration = createVectorMigration({
    rt,
    logger,
    isActive: () => stillActive(ctx),
  })
  // Dispose with the fiber: a reload must stop the loop at its next batch boundary instead of writing
  // into a closed database. `isActive` is the second guard (a harness may close the runtime without
  // disposing the fiber).
  ctx.effect(() => () => { vectorMigration.stop() })

  // Derived state follows the RULES, not the write: a fact written before an extraction change
  // keeps the old entity/triple rows (and the HRR bundle derived from them) until a sweep visits
  // it. ONE bounded batch per call — the store's in-flight guard drops an overlapping call rather
  // than letting two passes select the same rows — and the remainder is picked up next time.
  const sweepEntities = (): void => {
    void rt.memory.reindexEntities(ENTITY_SWEEP_PER_HEARTBEAT)
      .then((swept) => {
        if (swept.rebuilt > 0) {
          logger.info(`entity sweep: rebuilt ${swept.rebuilt} fact(s) written by older rules (${swept.deferred} still stale)`)
        }
      })
      .catch((error: unknown) => {
        logger.warn(`entity sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  // FIRST trigger is here, at mount — not on the first beat. A rule change used to reach old facts
  // only after `heartbeat_minutes` (60 by default), and never at all when that was 0.
  //
  // It runs BEHIND the same startup gate the tokenizer warm uses (host readiness + one idle turn):
  // `reindexEntities` tags stale rows through nodejieba, whose dictionary parse is ~1.2 s of
  // SYNCHRONOUS main-thread mission, so firing it at mount put that parse back inside the boot
  // window §20.14 moved the tokenizer warm out of. The waits are not preconditions (a failed or
  // hung boot still resolves them — see `awaitStartupGate`), and the heartbeat triggers below need
  // no gate: by then the host has long been up.
  //
  // The vector migration rides the SAME gate, for the same reason (model warm + first ONNX batch must
  // not be in the boot window) plus one more: the migration needs the model the gate waits for, so
  // firing it earlier would just log "model unavailable" and retry on the next heartbeat.
  void awaitStartupGate({ ...(waitFor === undefined ? {} : { waitFor }), deferTokenizerUntilIdle: true })
    .then(() => {
      // The gate can outlive a short-lived mount (a reload lands inside it): the runtime's databases
      // are closed by `stop`, so a sweep fired then would only log "database is not open". Same
      // unmount discipline as the reconciler's stop rule, checked against BOTH the fiber and the
      // runtime's own lifetime (a harness may shut the service down without disposing the fiber).
      if (!rt.closed && stillActive(ctx)) {
        sweepEntities()
        vectorMigration.start()
      }
    })
    .catch((error: unknown) => {
      logger.warn(`entity sweep gate failed: ${error instanceof Error ? error.message : String(error)}`)
    })

  // Trust heartbeat: the active-day clock advances on presence, and the tick performs
  // the settle/forget/idle/purge sweeps (TRUST_MODEL.md §5). `0` = startup pass only. The tick and
  // the interval are the ENGINE's (`installTrustHeartbeat`), shared with the MCP server; this
  // caller adds its own per-beat work and keeps its own disposer and interval line.
  const heartbeatMinutes = rt.config.common.trust.presence.heartbeat_minutes
  if (heartbeatMinutes > 0) {
    ctx.effect(() => {
      const stop = installTrustHeartbeat({
        memory: rt.memory,
        logger,
        heartbeatMinutes,
        onBeat: () => {
          sweepEntities()
          // Retry whatever the last migration pass could not finish (model still cold, a batch write
          // failed). A current store is a quiet no-op, so this is cheap.
          vectorMigration.start()
        },
        tickFailed: (message) => `trust tick failed: ${message}`,
      })
      logger.info(`trust heartbeat: every ${heartbeatMinutes}min (active-day clock + lifecycle sweep)`)
      return stop
    })
  }

  // Three usage sections, and only usage: when a fact is worth writing / when to read memory before
  // answering, when the document library is worth querying, and how to CHANGE a document. Retention mechanics stay out of
  // both (the store's business, and the only action such text invites is rewriting a fact to
  // refresh it — which defeats the policy it describes); the module-level reasons are on
  // MEMORY_PROMPT_SECTION and KNOWLEDGE_PROMPT_SECTION.
  //
  // The TEXT is the user's to edit: one `.md` per section under `<data home>/prompts`, ensured and
  // read by the engine's generic `PromptFiles` on this path only (a degraded mount registers no
  // sections at all — see the `catch` above). Read ONCE, here: an edit takes effect on the next
  // start, which keeps "what is in the prompt" the same for the whole life of the process.
  //
  // The directory is SHARED by the family's plugins and each plugin owns its prefix (`mem-*` here,
  // `mission-*` in the mission engine): every avantf plugin's system prompt sits in one place, and no
  // plugin has to guess which files are its own. That prefix is passed to the base as `namespace`
  // (interface v3), which REFUSES any spec outside `mem-*` — so it is checked, not just a convention.
  // Omitting it would be valid too (pre-v3 behaviour); passing it is what closes the takeover hole.
  const promptDir = join(rt.config.home, 'prompts')
  // The loader is the BASE's, taken at RUNTIME off the module the bootstrap already loaded: fixing
  // or extending the shared prompt-file logic takes one base release, not a plugin rebuild.
  // DEGRADATION, when the base (or its kit) is unavailable: the section texts fall back to this
  // plugin's OWN built-in defaults — the defaults are this plugin's content, not shared code — and
  // nothing is written to disk.
  const kit = env?.kit
  const loadedPrompts = kit?.PromptFiles === undefined
    ? promptFileSpecs().map((spec) => ({
        file: spec.file,
        path: join(promptDir, spec.file),
        text: spec.fallback,
        source: 'default' as const,
        wrote: false,
      }))
    : new kit.PromptFiles({ dir: promptDir, logger, namespace: PROMPT_NAMESPACE }).load(promptFileSpecs())
  const promptSections = buildPromptSections(loadedPrompts)
  for (const section of promptSections) {
    ctx.systemPrompt.section(section)
    logger.info(`prompt section registered: ${section.name} (order ${String(section.order)})`)
  }
  // The defaults are held to hard rules by `prompt_section.spec.ts`; edited text is the user's, so
  // it only gets these warnings — injected exactly as written either way.
  for (const warning of promptTextWarnings(promptSections)) logger.warn(`prompt text: ${warning}`)
  logger.info(
    `prompt files: ${promptDir} (${loadedPrompts.map((entry) => `${entry.file}:${entry.source}`).join(', ')})`,
  )

  // The CONDITIONAL hint, ONE contribution (DESIGN §12). Recomputed synchronously the moment the
  // agent is handed a USER message, so it is in place before THIS step's prompt is assembled: the
  // provider below cannot await, which is exactly why the probe is the lexical one (`@avantf/mem`'s
  // `relevance` — the semantic leg needs an encode and would land a step late).
  const hints = new WeakMap<object, RelevanceHit>()
  ctx.on('agent/inbox/inserted', (payload: { agent?: object; message?: unknown }) => {
    const agent = payload.agent
    if (agent === undefined) return
    // Only what the USER sent moves the verdict. The inbox also carries this plugin's own wake-ups
    // and other plugins' notices; probing those would let a "任务 n1 已结束" wake rewrite a hint
    // that claims to be about the user's last message.
    if ((payload.message as { source?: { kind?: string } } | null)?.source?.kind !== 'user') return
    const text = messageText(payload.message)
    // Never let a probe failure reach the event bus: a missing hint is harmless (the usage
    // sections still tell the model to query), a throwing listener is only log noise.
    try {
      hints.set(agent, text !== '' && rt.relevance(text))
    } catch {
      hints.set(agent, false)
    }
  })
  ctx.systemPrompt.context({
    name: 'avantf:mem-hint',
    order: 130,
    // The assembly scope IS the agent object (`dsh-agent`'s `assembleContextFor` passes
    // `scope: agent`), so keying by it keeps two sessions from seeing each other's hint. No state
    // for this agent (or a false verdict) renders as empty text, which contributes nothing.
    text: (context) => {
      const hit = context.scope === undefined ? undefined : hints.get(context.scope)
      return hit === undefined ? '' : hintText(hit)
    },
  })
  logger.info('prompt context registered: avantf:mem-hint (order 130)')


  // Corpus reconciliation, done PRECISELY rather than on a timer or a watcher: the agent reaches
  // the corpus through tool calls, so a finished tool call is the moment to ask "did anything under
  // `knowledge.docs.dir` change?" — and `corpusDrift()` answers that with one `stat` per document,
  // reading nothing. Only the files whose stamp moved get re-ingested, which is what makes this
  // cheap enough to run after EVERY tool result. The throttle (with a trailing run) and the rule
  // that an IN-FLIGHT pass stops at its next `await` once unmounted both live in `reconcile.ts`,
  // where `test/reconcile.spec.ts` can drive them without mounting the plugin.
  const reconciler = createCorpusReconciler({
    corpus: {
      sync: (options) => rt.knowledge.sync(options),
      corpusDrift: () => rt.knowledge.corpusDrift(),
    },
    minIntervalMs: RECONCILE_MIN_INTERVAL_MS,
    onError: (error) => {
      logger.warn(`知识库自动同步失败（不影响已有内容）：${error instanceof Error ? error.message : String(error)}`)
    },
  })
  // The reconciler's own fiber-owned resources: the trailing timer must not outlive the plugin, and
  // a check that is already in flight must not start another step against a closed database.
  ctx.effect(() => () => reconciler.stop())
  // Once at mount, for whatever changed while the host was not running; then after every tool call.
  void reconciler.request(true)
  ctx.on('tools/result', () => {
    void reconciler.request(false)
  })

  for (const spec of toolSpecs) {
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        // Structurally a ParameterSchemaSpec; the derivation lives in `tool_schema.ts`
        // so it can be unit-tested without a harness checkout.
        parameters: flattenToolSpec(spec) as unknown as ParameterSchemaSpec,
        output: OUTPUT,
        execute: args => runToolSpec(spec, rt, args),
        presentCall: (args) => present(spec, args as Record<string, unknown>),
      }),
    )
    logger.info(`tool registered: ${spec.name}`)
  }

  new AvantfMemGateway(ctx, rt) // binder for the client `ctx.remote.avantfMem.*` bridge
  logger.info('remote registered: avantfMem (client ctx.remote.avantfMem.*)')

  // Strict host wire face: hand-written descriptors registered through the
  // documented manual path (see src/remote.ts). Without this the gateway falls
  // back to SRC discovery, which needs the generator workspace.
  const disposeTypert = ctx.typert.register(hostContribution)
  logger.info('typert registered: avantfMem host face (5 tools + 5 UI-only)')

  // Post-registration health check: every REAL schema key (and every real tool name) must have
  // landed, matched by exact key — never by a bare `list()` total, which a not-yet-withdrawn probe
  // could inflate. A failure here is a WARNING only; the plugin is already mounted, so there is no
  // clean "do not load" left to take. Skipped when the gate itself could not run (no base).
  if (compat !== undefined) {
    verifyRegisteredFaces({ ctx, toolNames: toolSpecs.map(spec => spec.name), log: logger, compat })
  }

  ctx.effect(() => () => {
    logger.info('plugin unmount: disposing runtime (closing databases)')
    rt.shutdown()
    void disposeTypert()
    // Release the framework's leases (and drop its per-process cache) with the fiber: a disposed
    // plugin must not keep a managed copy marked as in use.
    env?.dispose()
    logger.info('plugin unmount: runtime disposed')
  })

  logger.info(`plugin ready: ${toolSpecs.length} tools + avantfMemory service + avantfMem remote`)
}
