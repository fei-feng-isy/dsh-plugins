/**
 * The base's INTERFACE TYPE — the named, frozen surface of `@avantf/dsh-plugin-base`'s `.` entry.
 *
 * Plugins load the base through the inlined bootstrap and never name it by specifier at runtime; they
 * describe what they loaded with `typeof import('@avantf/dsh-plugin-base')`, a namespace type that
 * grows silently with every new export. This file is the other half: named types an author can hold in
 * their head, stating which members are the contract and what each one means. The compiler checks them
 * structurally against the real module in `test/public-surface.spec.ts`, and the cross-tree behaviour
 * tests in `mem/packages/plugin/test/interface.spec.ts` / `mission/packages/plugin/test/interface.spec.ts`
 * drive the SAME members from a base that is actually linked — because the semantic half of the
 * contract (which directory a path resolves to, what `ensure` guarantees, what a refusal says) cannot
 * be caught by a type.
 *
 * The surface has TWO halves and they are named separately because they are checked differently:
 *
 *  - {@link BaseRuntimeV2} — the VALUE members of the CURRENT generation. A real module can be
 *    structurally assigned to it, so a missing or reshaped value member is a compile error, and
 *    `keyof` matches the runtime exports.
 *  - {@link BaseTypeSurfaceV2} — the TYPES a caller names when using those members (types are erased,
 *    so no runtime value can carry them). `keyof` is the type-name list.
 *
 * GENERATIONS WERE ADDITIVE through v2, and that is what made `loaded > required ⇒ ok` sound:
 * {@link BaseRuntimeV1} / {@link BaseTypeSurfaceV1} are the v1 record, v2 `extends` them, and the gate
 * asserts v2 is a superset of v1 (INTERFACE.md §5). **v3 is the first PRUNING generation**: it drops
 * the 18 zero-consumer members to `./internal` (INTERFACE.md §9), so it deliberately does NOT `extend`
 * {@link BaseRuntimeV2}. What keeps the newer-is-ok rule admissible is the replacement proof, asserted
 * in `test/public-surface.spec.ts`: `VALUE_NAMES_V3 ∪ PRUNED_VALUE_NAMES === VALUE_NAMES_V2` (nothing
 * was silently renamed or lost — every shed name is in the frozen {@link PRUNED_VALUE_NAMES}) and each
 * pruned name has zero consumers across the two plugin trees' non-test source and scripts. A generation
 * that drops a name with a consumer would fail that second half.
 *
 * `VALUE_NAMES_V1` / `TYPE_NAMES_V1` are the frozen v1 lists and `VALUE_NAMES_V2` / `TYPE_NAMES_V2`
 * the frozen v2 lists; `VALUE_NAMES_V3` / `TYPE_NAMES_V3` are the current ones. The v1/v2 interfaces
 * stay exported unchanged as their generations' records.
 *
 * The name lists are the same surface as data, because the snapshot gate needs to compare string sets.
 * The gate asserts they are exactly the two `keyof`s, so a member can never be added to the interface
 * and forgotten in the snapshot (or vice versa).
 *
 * `INTERFACE_VERSION` is the integer the plugins bake at build time and compare against the value
 * reported by the base they actually loaded at startup. It moves only for an INTERFACE change (the set
 * of names below, a signature in it, or the meaning of a member) — not for a behaviour/flow change and
 * not for a fix. The package version remains the INSTALL-time gate (the plugin's peer range); this
 * constant is the RUNTIME one.
 *
 * @module @avantf/dsh-plugin-base/interface
 */
import type { ArchivePack, BinaryArchiveSpec } from './providers/archive.js'
import type { ModelCacheLayout, ModelCacheSpec } from './providers/model.js'
import type { CompatContext, CompatEvidence, CompatLine, CompatLogger, CompatReportWords, CompatSpec, CompatVerdict, ProbeOutcome, ServiceContract, ServiceProbe } from './compat.js'
import type { ProvisionCode } from './errors.js'
import type { InterfaceRequirement, InterfaceVerdict } from './interface_gate.js'
import type { DataHomeInput } from './kit/family.js'
import type { PluginLogger, PluginLoggerHost, PluginLoggerOptions } from './kit/logger.js'
import type { LoadedPromptText, PromptFileSpec, PromptFilesIo, PromptFilesLogger, PromptFilesOptions } from './kit/prompt_files.js'
import type { StrictCodec } from './kit/typert.js'
import type {
  AtStartup,
  AtUse,
  BuiltinKind,
  Disposable,
  EnsureOptions,
  InstallContext,
  InstallManifest,
  ItemPolicy,
  Kind,
  Manifest,
  MirrorPolicy,
  OnMissing,
  Plan,
  PlanAction,
  PlanEntry,
  PlanOptions,
  ProbeResult,
  ProgressEvent,
  Provider,
  ProviderContext,
  ProviderPlan,
  ProvisionEvent,
  ProvisionFs,
  ProvisionItem,
  ProvisionLock,
  ProvisionLogger,
  ProvisionPolicy,
  ProvisionReport,
  ProvisionReportEntry,
  ProvisionStatus,
  Provisioner,
  ProvisionerExperimental,
  ProvisionerOptions,
  PrunePolicy,
  PruneReport,
  PublishMeta,
  ReportAction,
  Resolved,
  ResourceHandle,
  ResourceIdentity,
  ResourceSource,
  ResourceState,
  Startup,
} from './types.js'

/**
 * The integer interface generation this module implements.
 *
 * `3` is the CURRENT generation: the v2 surface MINUS the 18 zero-consumer members that moved to
 * `./internal` (INTERFACE.md §9) and PLUS the one newly-named compat type (`ServiceContract`). The
 * file name's `N` and this constant are the SAME fact — `test/public-surface.spec.ts` asserts that the
 * snapshot for this constant exists and that its `interfaceVersion` field equals it, so "the JSON says
 * v4, the constant says 3" cannot happen. Bump it (and add `api/interface-vN.json`) only for an
 * interface change (INTERFACE.md §1); a behaviour change or a fix does NOT touch it. The plugins bake
 * this number into their artifacts and compare it, at startup, with the number the base they loaded
 * reports — a difference is a warning and a capability-level degradation, never a refused mount.
 *
 * `2` and `1` are the earlier frozen generations (`api/interface-v2.json`, `api/interface-v1.json`).
 * They stay in the tree as those generations' records and as the types the plugins still import.
 */
export const INTERFACE_VERSION = 3

/**
 * The VALUE half of the v1 `.` surface: every member that exists at runtime.
 *
 * Members are typed `typeof import('./x.js').name` — one reference to the source of truth, never a
 * restated signature — so a change to an implementation's signature is a compile error where a real
 * module is assigned to this type, not two silently disagreeing declarations. `keyof BaseRuntimeV1` is
 * exactly the module's runtime export set (the gate asserts it against `Object.keys`).
 *
 * The `kit` group is the family's shared, DSH-free code: the reason a shared-helper fix needs only a
 * base release. Plugins take those members off the module they loaded at runtime instead of inlining a
 * copy. `resolveDataHome` takes the NAMED slot object {@link DataHomeInput}, which is the one breaking
 * change that produced this generation.
 */
export interface BaseRuntimeV1 {
  // ── generation / identity constants ──────────────────────────────────────────────────────────
  /** The interface generation; see {@link INTERFACE_VERSION}. */
  readonly INTERFACE_VERSION: typeof INTERFACE_VERSION
  /** The compat log token (`compat:`) every line the gate emits begins with. */
  readonly COMPAT_PREFIX: typeof import('./compat.js').COMPAT_PREFIX
  /** The baked build-record file name (`dsh-build.json`) read beside a plugin's entry. */
  readonly BUILD_VERSIONS_FILE: typeof import('./compat.js').BUILD_VERSIONS_FILE
  /** The name of the throwaway tool the tools probe registers. */
  readonly COMPAT_PROBE_TOOL: typeof import('./compat.js').COMPAT_PROBE_TOOL
  /** The item schema generation this build understands. */
  readonly ITEM_SCHEMA_VERSION: typeof import('./provisioner.js').ITEM_SCHEMA_VERSION
  /** The default ensure deadline, in milliseconds. */
  readonly DEFAULT_DEADLINE_MS: typeof import('./provisioner.js').DEFAULT_DEADLINE_MS
  /** The provisioner's capability list. */
  readonly CAPABILITIES: typeof import('./provisioner.js').CAPABILITIES

  // ── the runtime interface gate ───────────────────────────────────────────────────────────────
  /**
   * Decide whether a loaded module implements the interface generation a caller requires. Pure,
   * total, guarded and asymmetric — the ONE implementation of the verdict semantics, so a fix to them
   * is a base release and not two plugin rebuilds. Only a base OLDER than the build is
   * `incompatible`; a base NEWER than the build is `ok` plus a warning, because generations are
   * additive and every member the older build requires is still present.
   */
  readonly checkInterface: typeof import('./interface_gate.js').checkInterface
  /**
   * Read the `{ baseVersion, interfaceVersion }` record a plugin artifact was baked with; a missing
   * or malformed file is `undefined` ("not baked"), never a throw.
   */
  readonly readInterfaceRequirement: typeof import('./interface_gate.js').readInterfaceRequirement

  // ── the compatibility gate ───────────────────────────────────────────────────────────────────
  /** Run the gate against a live context: register nothing, decide `load`, log the diagnosis. */
  readonly provision: typeof import('./compat.js').provision
  /** Build the refusal report from a verdict plus the CALLER's wording. */
  readonly compatReport: typeof import('./compat.js').compatReport
  /** Keep one user-visible command that reports a refusal (the only channel on that path). */
  readonly registerMegaphone: typeof import('./compat.js').registerMegaphone
  /** The wire schema names a contribution declares (the post-registration check's input). */
  readonly schemaNamesFrom: typeof import('./compat.js').schemaNamesFrom
  /** Confirm, after mounting, that every declared schema and tool is really registered. */
  readonly verifyRegisteredFaces: typeof import('./compat.js').verifyRegisteredFaces
  /** The peer-range FLOORS of the packages that identify the host (the `declared` fallback). */
  readonly readDeclaredVersions: typeof import('./compat.js').readDeclaredVersions
  /** The versions this BUILD was compiled against, baked next to the entry. */
  readonly readBuildVersions: typeof import('./compat.js').readBuildVersions
  /** The versions THIS build's links resolve to at startup. */
  readonly readRuntimeVersions: typeof import('./compat.js').readRuntimeVersions
  /** Build the probe tool declaration from the caller's own `defineTool`. */
  readonly toolProbeDeclaration: typeof import('./compat.js').toolProbeDeclaration
  /** The rules as a pure function of evidence (no host, no I/O). */
  readonly verdictOf: typeof import('./compat.js').verdictOf
  /** The lower bound one declared peer range names. */
  readonly floorOf: typeof import('./compat.js').floorOf
  /** The versions THIS build's links resolve to for one package. */
  readonly resolveRuntimeVersion: typeof import('./compat.js').resolveRuntimeVersion
  /** The services a live context actually exposes, against the caller's contracts. */
  readonly checkServices: typeof import('./compat.js').checkServices
  /** Whether the context carries the effect-scoped timer (`ctx.interval`) the engine needs. */
  readonly checkInterval: typeof import('./compat.js').checkInterval
  /** Gather the plain evidence {@link verdictOf} consumes from a live context. */
  readonly gatherEvidence: typeof import('./compat.js').gatherEvidence
  /** Probe a tools registry with the caller's real declaration (`not probed` is not a break). */
  readonly probeToolsRegistry: typeof import('./compat.js').probeToolsRegistry
  /** Probe the Typert registry with the caller's real wire contribution. */
  readonly probeTypertRegistry: typeof import('./compat.js').probeTypertRegistry
  /** The registry keys a package's schema names become (`<packageId>#<name>`). */
  readonly declaredSchemaKeys: typeof import('./compat.js').declaredSchemaKeys

  // ── the shared kit (taken off the loaded module at runtime, never inlined) ────────────────────
  /** Ensure + read the family's user-editable prompt files. */
  readonly PromptFiles: typeof import('./kit/prompt_files.js').PromptFiles
  /** Build a plugin logger with the family's line format and host mirror. */
  readonly createPluginLogger: typeof import('./kit/logger.js').createPluginLogger
  /** The family root: `$AVANTF_HOME`, else `~/.avantf/env`. */
  readonly familyHome: typeof import('./kit/family.js').familyHome
  /** `<family root>/tools`. */
  readonly familyToolsDir: typeof import('./kit/family.js').familyToolsDir
  /** `<family root>/models`. */
  readonly familyModelsDir: typeof import('./kit/family.js').familyModelsDir
  /**
   * The DATA root, by the family's layer order: ⑤ explicit → ④ `$AVANTF_HOME` → ② the configured
   * `dataHome` → `~/.avantf`. Every slot is NAMED ({@link DataHomeInput}) — the positional form is
   * what let the two copies of this rule disagree about where the profile's `dataHome` belongs.
   */
  readonly resolveDataHome: typeof import('./kit/family.js').resolveDataHome
  /** `~/x` → `<home>/x`, `~` → `<home>`; anything else unchanged. */
  readonly expandHome: typeof import('./kit/family.js').expandHome
  /** Build the family's Typert `<pkg>#<namespace>/<method>:<field>` wire codec. */
  readonly strictCodec: typeof import('./kit/typert.js').strictCodec
  /** `<package>#<namespace>/<method>`. */
  readonly endpointId: typeof import('./kit/typert.js').endpointId
  /** The type symbol of one field of one method. */
  readonly fieldSymbol: typeof import('./kit/typert.js').fieldSymbol
  /** The type symbol of a method's result. */
  readonly resultSymbol: typeof import('./kit/typert.js').resultSymbol

  // ── the provisioner (startup resources: declare → probe → fetch → verify → report) ────────────
  /** Build a provisioner over a family root. */
  readonly createProvisioner: typeof import('./provisioner.js').createProvisioner
  /** The policy value that normalizes an `onMissing` shorthand. */
  readonly normalizeOnMissing: typeof import('./provisioner.js').normalizeOnMissing
  /** The error a failed provision throws, with its machine-readable `code`. */
  readonly ProvisionError: typeof import('./errors.js').ProvisionError
  /** The machine-readable code of a provision failure. */
  readonly reasonOf: typeof import('./errors.js').reasonOf
  /** The binary-archive provider factory. */
  readonly binaryArchiveProvider: typeof import('./providers/archive.js').binaryArchiveProvider
  /** The binary-archive item kind. */
  readonly BINARY_ARCHIVE_KIND: typeof import('./providers/archive.js').BINARY_ARCHIVE_KIND
  /** The npm-package provider factory. */
  readonly npmPackageProvider: typeof import('./providers/npm.js').npmPackageProvider
  /** The npm-package item kind. */
  readonly NPM_PACKAGE_KIND: typeof import('./providers/npm.js').NPM_PACKAGE_KIND
  /** The model-cache provider factory. */
  readonly modelCacheProvider: typeof import('./providers/model.js').modelCacheProvider
  /** The model-cache item kind. */
  readonly MODEL_CACHE_KIND: typeof import('./providers/model.js').MODEL_CACHE_KIND
}

/**
 * The VALUE half of the FROZEN v2 `.` surface: v1 plus the well-formed-text kit. It stays exported as that generation's record; the CURRENT generation is {@link BaseRuntimeV3}.
 *
 * Additive by construction — it `extends` {@link BaseRuntimeV1}, so a v2 that dropped or reshaped a v1
 * member is a compile error, and `keyof BaseRuntimeV2` is exactly v1's members plus the two below. The
 * members come off the loaded module at runtime, never inlined (root `AGENTS.md` 「抽取共用业务」): the
 * well-formed repair is generic, non-DSH knowledge, so one base release must be able to fix it for
 * every consumer.
 */
export interface BaseRuntimeV2 extends BaseRuntimeV1 {
  /**
   * Repair lone surrogates in ONE string: every unpaired UTF-16 code unit in `D800–DFFF` becomes
   * U+FFFD. Pure, idempotent and total — it uses `String.prototype.toWellFormed()` when the engine has
   * it (Node ≥20) and an EQUIVALENT `charCodeAt` scan otherwise, so an older Node degrades in
   * behaviour, never in availability. It does NOT normalize (NFC is a persistence policy that belongs
   * to the caller).
   */
  readonly wellFormedText: typeof import('./kit/wellformed.js').wellFormedText
  /**
   * {@link BaseRuntimeV2.wellFormedText} over a JSON-shaped value: strings and object KEYS are
   * repaired, arrays are mapped, and everything else (including any object with a `toJSON`) is
   * returned as-is, so the value's JSON meaning cannot change.
   */
  readonly wellFormedDeep: typeof import('./kit/wellformed.js').wellFormedDeep
}

/**
 * The VALUE half of the CURRENT (v3) `.` surface: the STABLE SUBSET the installed plugins consume.
 *
 * v3 does NOT `extends` {@link BaseRuntimeV2} — it is the first pruning generation (INTERFACE.md §9).
 * The 18 members with zero consumers across both plugin trees moved to `./internal`
 * ({@link PRUNED_VALUE_NAMES}); the 32 below are what is left, and every one is either taken off the
 * loaded module by a plugin today or is an extension point a plugin author is meant to call
 * (`createProvisioner` + providers, family paths, the gate, the provisioner error type).
 *
 * A real v3 module is still structurally a v1/v2 module — the shed values remain reachable through the
 * package (`./internal` and the `./compat` subpath) and, in practice, plugins never named them — but
 * that is a consumer-level fact proven in `test/public-surface.spec.ts`, not a structural one, which
 * is exactly why the generation number moved.
 */
export interface BaseRuntimeV3 {
  // ── generation / identity constants ──────────────────────────────────────────────────────────
  /** The interface generation; see {@link INTERFACE_VERSION}. */
  readonly INTERFACE_VERSION: typeof INTERFACE_VERSION
  /** The compat log token (`compat:`) every line the gate emits begins with. */
  readonly COMPAT_PREFIX: typeof import('./compat.js').COMPAT_PREFIX
  /** The baked build-record file name (`dsh-build.json`) read beside a plugin's entry. */
  readonly BUILD_VERSIONS_FILE: typeof import('./compat.js').BUILD_VERSIONS_FILE
  /** The item schema generation this build understands. */
  readonly ITEM_SCHEMA_VERSION: typeof import('./provisioner.js').ITEM_SCHEMA_VERSION

  // ── the runtime interface gate ───────────────────────────────────────────────────────────────
  /** Decide whether a loaded module implements the interface generation a caller requires. */
  readonly checkInterface: typeof import('./interface_gate.js').checkInterface
  /** Read the `{ baseVersion, interfaceVersion }` record a plugin artifact was baked with. */
  readonly readInterfaceRequirement: typeof import('./interface_gate.js').readInterfaceRequirement

  // ── the compatibility gate (composition layer only) ─────────────────────────────────────────
  /** Run the gate against a live context: register nothing, decide `load`, log the diagnosis. */
  readonly provision: typeof import('./compat.js').provision
  /** Build the refusal report from a verdict plus the CALLER's wording. */
  readonly compatReport: typeof import('./compat.js').compatReport
  /** Keep one user-visible command that reports a refusal (the only channel on that path). */
  readonly registerMegaphone: typeof import('./compat.js').registerMegaphone
  /** The wire schema names a contribution declares (the post-registration check's input). */
  readonly schemaNamesFrom: typeof import('./compat.js').schemaNamesFrom
  /** Confirm, after mounting, that every declared schema and tool is really registered. */
  readonly verifyRegisteredFaces: typeof import('./compat.js').verifyRegisteredFaces
  /** The peer-range FLOORS of the packages that identify the host (the `declared` fallback). */
  readonly readDeclaredVersions: typeof import('./compat.js').readDeclaredVersions
  /** The versions this BUILD was compiled against, baked next to the entry. */
  readonly readBuildVersions: typeof import('./compat.js').readBuildVersions
  /** The versions THIS build's links resolve to at startup. */
  readonly readRuntimeVersions: typeof import('./compat.js').readRuntimeVersions
  /** Build the probe tool declaration from the caller's own `defineTool`. */
  readonly toolProbeDeclaration: typeof import('./compat.js').toolProbeDeclaration
  /** The rules as a pure function of evidence (no host, no I/O). */
  readonly verdictOf: typeof import('./compat.js').verdictOf
  /** Gather the plain evidence {@link BaseRuntimeV3.verdictOf} consumes from a live context. */
  readonly gatherEvidence: typeof import('./compat.js').gatherEvidence

  // ── the shared kit (taken off the loaded module at runtime, never inlined) ────────────────────
  /** Ensure + read the family's user-editable prompt files. */
  readonly PromptFiles: typeof import('./kit/prompt_files.js').PromptFiles
  /** The family root: `$AVANTF_HOME`, else `~/.avantf/env`. */
  readonly familyHome: typeof import('./kit/family.js').familyHome
  /** `<family root>/tools`. */
  readonly familyToolsDir: typeof import('./kit/family.js').familyToolsDir
  /** `<family root>/models`. */
  readonly familyModelsDir: typeof import('./kit/family.js').familyModelsDir
  /** The DATA root, by the family's layer order: ⑤ explicit → ④ `$AVANTF_HOME` → ② configured → `~/.avantf`. */
  readonly resolveDataHome: typeof import('./kit/family.js').resolveDataHome
  /** `~/x` → `<home>/x`, `~` → `<home>`; anything else unchanged. */
  readonly expandHome: typeof import('./kit/family.js').expandHome
  /** Repair lone surrogates in ONE string (U+FFFD), engine-independent and total. */
  readonly wellFormedText: typeof import('./kit/wellformed.js').wellFormedText
  /** {@link BaseRuntimeV3.wellFormedText} over a JSON-shaped value. */
  readonly wellFormedDeep: typeof import('./kit/wellformed.js').wellFormedDeep

  // ── the provisioner (startup resources: declare → probe → fetch → verify → report) ────────────
  /** Build a provisioner over a family root. */
  readonly createProvisioner: typeof import('./provisioner.js').createProvisioner
  /** The error a failed provision throws, with its machine-readable `code`. */
  readonly ProvisionError: typeof import('./errors.js').ProvisionError
  /** The machine-readable code of a provision failure. */
  readonly reasonOf: typeof import('./errors.js').reasonOf
  /** The binary-archive provider factory. */
  readonly binaryArchiveProvider: typeof import('./providers/archive.js').binaryArchiveProvider
  /** The binary-archive item kind. */
  readonly BINARY_ARCHIVE_KIND: typeof import('./providers/archive.js').BINARY_ARCHIVE_KIND
  /** The model-cache provider factory. */
  readonly modelCacheProvider: typeof import('./providers/model.js').modelCacheProvider
  /** The model-cache item kind. */
  readonly MODEL_CACHE_KIND: typeof import('./providers/model.js').MODEL_CACHE_KIND
}

/**
 * The TYPE half of the v1 `.` surface: every type a caller names when it uses the members above.
 *
 * These members exist only at compile time (types are erased), so they are declared as properties of
 * their own name and never checked against a runtime value. `keyof` them, though, and you have the
 * type-name list — which is what makes the list data (`TYPE_NAMES_V1`) mechanical rather than a second
 * hand-kept inventory.
 *
 * Most are re-exported from `.` in v1/v2. An entry is needed exactly for the ones that a caller can
 * obtain ONLY through a public signature: `CompatReportWords` was the example (it is a parameter type of
 * `compatReport` and was not re-exported on its own). A name that `.` exported wholesale — such as
 * `ServiceContract`, via the v1/v2 `export * from './compat.js'` — needed no entry here, and naming it
 * would have made this list a second hand-kept inventory. **v3 replaced that rule**: `src/index.ts` is
 * an explicit list, so {@link BaseTypeSurfaceV3} names every type `.` exports. The snapshot's type list
 * is derived from this interface, so a member added here and not to the JSON (or the reverse) is a red
 * gate.
 */
export interface BaseTypeSurfaceV1 {
  readonly EnsureOptions: EnsureOptions
  readonly InstallContext: InstallContext
  readonly InstallManifest: InstallManifest
  readonly ItemPolicy: ItemPolicy
  readonly Kind: Kind
  readonly Manifest: Manifest
  readonly MirrorPolicy: MirrorPolicy
  readonly OnMissing: OnMissing
  readonly Plan: Plan
  readonly PlanEntry: PlanEntry
  readonly PlanOptions: PlanOptions
  readonly ProbeResult: ProbeResult
  readonly ProgressEvent: ProgressEvent
  readonly PromptFileSpec: PromptFileSpec
  readonly LoadedPromptText: LoadedPromptText
  readonly PromptFilesIo: PromptFilesIo
  readonly PromptFilesLogger: PromptFilesLogger
  readonly PromptFilesOptions: PromptFilesOptions
  readonly Provider: Provider
  readonly ProviderContext: ProviderContext
  readonly ProviderPlan: ProviderPlan
  readonly ProvisionCode: ProvisionCode
  readonly ProvisionEvent: ProvisionEvent
  readonly ProvisionFs: ProvisionFs
  readonly ProvisionLock: ProvisionLock
  readonly ProvisionLogger: ProvisionLogger
  readonly ProvisionPolicy: ProvisionPolicy
  readonly ProvisionReport: ProvisionReport
  readonly ProvisionReportEntry: ProvisionReportEntry
  readonly ProvisionStatus: ProvisionStatus
  readonly Provisioner: Provisioner
  readonly ProvisionerExperimental: ProvisionerExperimental
  readonly ProvisionerOptions: ProvisionerOptions
  readonly PrunePolicy: PrunePolicy
  readonly PruneReport: PruneReport
  readonly PublishMeta: PublishMeta
  readonly Resolved: Resolved
  readonly ResourceHandle: ResourceHandle
  readonly ResourceIdentity: ResourceIdentity
  readonly ResourceState: ResourceState
  readonly Startup: Startup
  readonly CompatContext: CompatContext
  readonly CompatEvidence: CompatEvidence
  readonly CompatLine: CompatLine
  readonly CompatLogger: CompatLogger
  readonly CompatSpec: CompatSpec
  readonly CompatVerdict: CompatVerdict
  readonly CompatReportWords: CompatReportWords
  readonly ProbeOutcome: ProbeOutcome
  readonly ServiceProbe: ServiceProbe
  readonly PluginLogger: PluginLogger
  readonly PluginLoggerHost: PluginLoggerHost
  readonly PluginLoggerOptions: PluginLoggerOptions
  readonly StrictCodec: StrictCodec
  readonly DataHomeInput: DataHomeInput
  readonly InterfaceVerdict: InterfaceVerdict
  readonly InterfaceRequirement: InterfaceRequirement
}

/**
 * The TYPE half of the FROZEN v2 `.` surface. It stays exported as that generation's record; the CURRENT generation is {@link BaseTypeSurfaceV3}.
 *
 * v2 is additive at runtime only: the well-formed-text helpers take and return `string` / a generic
 * `T`, so they introduce no named type. This interface therefore adds nothing to
 * {@link BaseTypeSurfaceV1}; it exists so the generation's type half has a name of its own and
 * `TYPE_NAMES_V2` derives from something.
 */
export interface BaseTypeSurfaceV2 extends BaseTypeSurfaceV1 {}

/**
 * The TYPE half of the CURRENT (v3) `.` surface.
 *
 * v3 does NOT `extends` {@link BaseTypeSurfaceV2}: it is the pruning generation. It drops the four
 * types that existed only for the shed values (`StrictCodec`, `PluginLogger`, `PluginLoggerHost`,
 * `PluginLoggerOptions` — now on `./internal`) and it NAMES thirteen types that `export *` used to
 * make reachable without a declaration, so the surface is now stated instead of inherited — most
 * importantly `ServiceContract`, which `mem`'s compat spec imports by name today. See
 * {@link ADDED_TYPE_NAMES}.
 */
export interface BaseTypeSurfaceV3 {
  // provisioner / provider types
  ArchivePack: ArchivePack
  BinaryArchiveSpec: BinaryArchiveSpec
  ModelCacheLayout: ModelCacheLayout
  ModelCacheSpec: ModelCacheSpec
  ProvisionCode: ProvisionCode
  // item / manifest / plan model
  AtStartup: AtStartup
  AtUse: AtUse
  BuiltinKind: BuiltinKind
  Disposable: Disposable
  EnsureOptions: EnsureOptions
  InstallContext: InstallContext
  InstallManifest: InstallManifest
  ItemPolicy: ItemPolicy
  Kind: Kind
  Manifest: Manifest
  MirrorPolicy: MirrorPolicy
  OnMissing: OnMissing
  Plan: Plan
  PlanAction: PlanAction
  PlanEntry: PlanEntry
  PlanOptions: PlanOptions
  ProbeResult: ProbeResult
  ProgressEvent: ProgressEvent
  Provider: Provider
  ProviderContext: ProviderContext
  ProviderPlan: ProviderPlan
  ProvisionEvent: ProvisionEvent
  ProvisionFs: ProvisionFs
  ProvisionItem: ProvisionItem
  ProvisionLock: ProvisionLock
  ProvisionLogger: ProvisionLogger
  ProvisionPolicy: ProvisionPolicy
  ProvisionReport: ProvisionReport
  ProvisionReportEntry: ProvisionReportEntry
  ProvisionStatus: ProvisionStatus
  Provisioner: Provisioner
  ProvisionerExperimental: ProvisionerExperimental
  ProvisionerOptions: ProvisionerOptions
  PrunePolicy: PrunePolicy
  PruneReport: PruneReport
  PublishMeta: PublishMeta
  ReportAction: ReportAction
  Resolved: Resolved
  ResourceHandle: ResourceHandle
  ResourceIdentity: ResourceIdentity
  ResourceSource: ResourceSource
  ResourceState: ResourceState
  Startup: Startup
  // compatibility gate
  CompatContext: CompatContext
  CompatEvidence: CompatEvidence
  CompatLine: CompatLine
  CompatLogger: CompatLogger
  CompatReportWords: CompatReportWords
  CompatSpec: CompatSpec
  CompatVerdict: CompatVerdict
  ProbeOutcome: ProbeOutcome
  ServiceContract: ServiceContract
  ServiceProbe: ServiceProbe
  // shared kit
  DataHomeInput: DataHomeInput
  LoadedPromptText: LoadedPromptText
  PromptFileSpec: PromptFileSpec
  PromptFilesIo: PromptFilesIo
  PromptFilesLogger: PromptFilesLogger
  PromptFilesOptions: PromptFilesOptions
  // runtime interface gate
  InterfaceRequirement: InterfaceRequirement
  InterfaceVerdict: InterfaceVerdict
}

/**
 * Every VALUE name of the v1 `.` surface, in {@link BaseRuntimeV1} declaration order.
 *
 * The `satisfies readonly (keyof BaseRuntimeV1)[]` makes a typo or a stale entry a compile error, and
 * the gate asserts that this list and the module's actual exports are the same set — and that it is
 * the whole `keyof`, so nothing can live in the interface without also being in the snapshot.
 */
export const VALUE_NAMES_V1 = [
  'INTERFACE_VERSION',
  'COMPAT_PREFIX',
  'BUILD_VERSIONS_FILE',
  'COMPAT_PROBE_TOOL',
  'ITEM_SCHEMA_VERSION',
  'DEFAULT_DEADLINE_MS',
  'CAPABILITIES',
  'checkInterface',
  'readInterfaceRequirement',
  'provision',
  'compatReport',
  'registerMegaphone',
  'schemaNamesFrom',
  'verifyRegisteredFaces',
  'readDeclaredVersions',
  'readBuildVersions',
  'readRuntimeVersions',
  'toolProbeDeclaration',
  'verdictOf',
  'floorOf',
  'resolveRuntimeVersion',
  'checkServices',
  'checkInterval',
  'gatherEvidence',
  'probeToolsRegistry',
  'probeTypertRegistry',
  'declaredSchemaKeys',
  'PromptFiles',
  'createPluginLogger',
  'familyHome',
  'familyToolsDir',
  'familyModelsDir',
  'resolveDataHome',
  'expandHome',
  'strictCodec',
  'endpointId',
  'fieldSymbol',
  'resultSymbol',
  'createProvisioner',
  'normalizeOnMissing',
  'ProvisionError',
  'reasonOf',
  'binaryArchiveProvider',
  'BINARY_ARCHIVE_KIND',
  'npmPackageProvider',
  'NPM_PACKAGE_KIND',
  'modelCacheProvider',
  'MODEL_CACHE_KIND',
] as const satisfies readonly (keyof BaseRuntimeV1)[]

/**
 * Every TYPE name of the v1 `.` surface, in {@link BaseTypeSurfaceV1} declaration order.
 *
 * Types are erased, so this is the only form in which they can be enumerated at runtime. The
 * `satisfies` clause keeps it honest against the interface, and the gate asserts the two together are
 * exactly the interface's members.
 */
export const TYPE_NAMES_V1 = [
  'EnsureOptions',
  'InstallContext',
  'InstallManifest',
  'ItemPolicy',
  'Kind',
  'Manifest',
  'MirrorPolicy',
  'OnMissing',
  'Plan',
  'PlanEntry',
  'PlanOptions',
  'ProbeResult',
  'ProgressEvent',
  'PromptFileSpec',
  'LoadedPromptText',
  'PromptFilesIo',
  'PromptFilesLogger',
  'PromptFilesOptions',
  'Provider',
  'ProviderContext',
  'ProviderPlan',
  'ProvisionCode',
  'ProvisionEvent',
  'ProvisionFs',
  'ProvisionLock',
  'ProvisionLogger',
  'ProvisionPolicy',
  'ProvisionReport',
  'ProvisionReportEntry',
  'ProvisionStatus',
  'Provisioner',
  'ProvisionerExperimental',
  'ProvisionerOptions',
  'PrunePolicy',
  'PruneReport',
  'PublishMeta',
  'Resolved',
  'ResourceHandle',
  'ResourceIdentity',
  'ResourceState',
  'Startup',
  'CompatContext',
  'CompatEvidence',
  'CompatLine',
  'CompatLogger',
  'CompatSpec',
  'CompatVerdict',
  'CompatReportWords',
  'ProbeOutcome',
  'ServiceProbe',
  'PluginLogger',
  'PluginLoggerHost',
  'PluginLoggerOptions',
  'StrictCodec',
  'DataHomeInput',
  'InterfaceVerdict',
  'InterfaceRequirement',
] as const satisfies readonly (keyof BaseTypeSurfaceV1)[]

/**
 * Every VALUE name of the FROZEN v2 `.` surface, in {@link BaseRuntimeV2} declaration order: the v1
 * list verbatim, then the two well-formed-text members.
 *
 * The spread is the point — an additive generation states itself as "v1 plus these", so a member that
 * disappears from v1 cannot quietly disappear from v2 too. The `satisfies` clause still checks the
 * whole v2 `keyof`, so a member added to the interface and not to this list is a compile error.
 */
export const VALUE_NAMES_V2 = [
  ...VALUE_NAMES_V1,
  'wellFormedText',
  'wellFormedDeep',
] as const satisfies readonly (keyof BaseRuntimeV2)[]

/**
 * Every TYPE name of the FROZEN v2 `.` surface, in {@link BaseTypeSurfaceV2} declaration order.
 *
 * v2 adds no named type, so this is the v1 list; the `satisfies` clause still ties it to
 * {@link BaseTypeSurfaceV2}, and the gate asserts v1 ⊆ v2 for both halves.
 */
export const TYPE_NAMES_V2 = [...TYPE_NAMES_V1] as const satisfies readonly (keyof BaseTypeSurfaceV2)[]

/**
 * The VALUE names v3 shed from `.` — the frozen PRUNE list (INTERFACE.md §9).
 *
 * Every one of them has zero consumers across the two plugin trees' non-test source and scripts (the
 * proof is `PUBLIC-SURFACE`'s cross-tree check), and every one of them now lives on `./internal`
 * instead. This list is not documentation: `test/public-surface.spec.ts` asserts
 * `VALUE_NAMES_V2 === [...VALUE_NAMES_V3, ...PRUNED_VALUE_NAMES]` (both directions), so a v4 cannot
 * quietly drop a name that is neither in the surface nor on this list.
 */
export const PRUNED_VALUE_NAMES = [
  'CAPABILITIES',
  'COMPAT_PROBE_TOOL',
  'DEFAULT_DEADLINE_MS',
  'NPM_PACKAGE_KIND',
  'checkInterval',
  'checkServices',
  'createPluginLogger',
  'declaredSchemaKeys',
  'endpointId',
  'fieldSymbol',
  'floorOf',
  'normalizeOnMissing',
  'npmPackageProvider',
  'probeToolsRegistry',
  'probeTypertRegistry',
  'resolveRuntimeVersion',
  'resultSymbol',
  'strictCodec',
] as const satisfies readonly (keyof BaseRuntimeV2)[]

/**
 * Every VALUE name of the CURRENT (v3) `.` surface, in {@link BaseRuntimeV3} declaration order.
 *
 * NOT a spread of v2: v3 prunes, so it is stated as itself. The `satisfies` clause ties it to
 * {@link BaseRuntimeV3}, and the gate asserts the whole `keyof`, so a member added to the interface
 * and not to this list is a compile error.
 */
export const VALUE_NAMES_V3 = [
  'INTERFACE_VERSION',
  'COMPAT_PREFIX',
  'BUILD_VERSIONS_FILE',
  'ITEM_SCHEMA_VERSION',
  'checkInterface',
  'readInterfaceRequirement',
  'provision',
  'compatReport',
  'registerMegaphone',
  'schemaNamesFrom',
  'verifyRegisteredFaces',
  'readDeclaredVersions',
  'readBuildVersions',
  'readRuntimeVersions',
  'toolProbeDeclaration',
  'verdictOf',
  'gatherEvidence',
  'PromptFiles',
  'familyHome',
  'familyToolsDir',
  'familyModelsDir',
  'resolveDataHome',
  'expandHome',
  'wellFormedText',
  'wellFormedDeep',
  'createProvisioner',
  'ProvisionError',
  'reasonOf',
  'binaryArchiveProvider',
  'BINARY_ARCHIVE_KIND',
  'modelCacheProvider',
  'MODEL_CACHE_KIND',
] as const satisfies readonly (keyof BaseRuntimeV3)[]

/**
 * The TYPE names v3 NAMES for the first time — they were reachable through `export *` in v2 but were
 * never declared in {@link BaseTypeSurfaceV2}, so they had no entry and no promise. v3's explicit
 * `.` states them; `ServiceContract` is the load-bearing one (mem's compat spec imports it by name).
 */
export const ADDED_TYPE_NAMES = [
  'ArchivePack',
  'AtStartup',
  'AtUse',
  'BinaryArchiveSpec',
  'BuiltinKind',
  'Disposable',
  'ModelCacheLayout',
  'ModelCacheSpec',
  'PlanAction',
  'ProvisionItem',
  'ReportAction',
  'ResourceSource',
  'ServiceContract',
] as const satisfies readonly (keyof BaseTypeSurfaceV3)[]

/**
 * The TYPE names v3 sheds: the types that existed only for the values that moved to `./internal`.
 * They live on `./internal` too, so the move is complete on both halves of the surface.
 */
export const PRUNED_TYPE_NAMES = [
  'PluginLogger',
  'PluginLoggerHost',
  'PluginLoggerOptions',
  'StrictCodec',
] as const satisfies readonly (keyof BaseTypeSurfaceV2)[]

/**
 * Every TYPE name of the CURRENT (v3) `.` surface, in {@link BaseTypeSurfaceV3} declaration order.
 *
 * v3 is a pruning generation, so this is stated explicitly rather than spread. The gate asserts it
 * partitions v2 together with {@link PRUNED_TYPE_NAMES} and {@link ADDED_TYPE_NAMES}.
 */
export const TYPE_NAMES_V3 = [
  'ArchivePack',
  'BinaryArchiveSpec',
  'ModelCacheLayout',
  'ModelCacheSpec',
  'ProvisionCode',
  'AtStartup',
  'AtUse',
  'BuiltinKind',
  'Disposable',
  'EnsureOptions',
  'InstallContext',
  'InstallManifest',
  'ItemPolicy',
  'Kind',
  'Manifest',
  'MirrorPolicy',
  'OnMissing',
  'Plan',
  'PlanAction',
  'PlanEntry',
  'PlanOptions',
  'ProbeResult',
  'ProgressEvent',
  'Provider',
  'ProviderContext',
  'ProviderPlan',
  'ProvisionEvent',
  'ProvisionFs',
  'ProvisionItem',
  'ProvisionLock',
  'ProvisionLogger',
  'ProvisionPolicy',
  'ProvisionReport',
  'ProvisionReportEntry',
  'ProvisionStatus',
  'Provisioner',
  'ProvisionerExperimental',
  'ProvisionerOptions',
  'PrunePolicy',
  'PruneReport',
  'PublishMeta',
  'ReportAction',
  'Resolved',
  'ResourceHandle',
  'ResourceIdentity',
  'ResourceSource',
  'ResourceState',
  'Startup',
  'CompatContext',
  'CompatEvidence',
  'CompatLine',
  'CompatLogger',
  'CompatReportWords',
  'CompatSpec',
  'CompatVerdict',
  'ProbeOutcome',
  'ServiceContract',
  'ServiceProbe',
  'DataHomeInput',
  'LoadedPromptText',
  'PromptFileSpec',
  'PromptFilesIo',
  'PromptFilesLogger',
  'PromptFilesOptions',
  'InterfaceRequirement',
  'InterfaceVerdict',
] as const satisfies readonly (keyof BaseTypeSurfaceV3)[]
