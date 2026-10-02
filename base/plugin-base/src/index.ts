/**
 * Plugin environment initialisation at startup — the `.` entry, written as an EXPLICIT list.
 *
 * Generation v3 (INTERFACE.md §9) replaced the two `export *` re-exports this file used to carry
 * (`./compat.js`, `./kit/index.js`) with the list below. That is the whole point of the generation:
 * before v3 the frozen surface was "whatever those two files happened to export", so adding an
 * internal helper to `compat.ts` was silently an interface change. Now `.` carries the members the
 * installed plugins actually consume plus the extension points a plugin author is expected to call,
 * and nothing else: the zero-consumer composition pieces moved to `./internal` (see that module).
 *
 * The same surface is stated as a type + two name lists in `./interface.js`; `api/interface-v3.json`
 * is its snapshot, and `test/public-surface.spec.ts` keeps the three in step. Do not add a member
 * here without a generation decision.
 *
 * @module index
 */
export { ITEM_SCHEMA_VERSION, createProvisioner } from './provisioner.js'
export { ProvisionError, reasonOf } from './errors.js'
export type { ProvisionCode } from './errors.js'
export { binaryArchiveProvider, BINARY_ARCHIVE_KIND } from './providers/archive.js'
export type { ArchivePack, BinaryArchiveSpec } from './providers/archive.js'
export { modelCacheProvider, MODEL_CACHE_KIND } from './providers/model.js'
export type { ModelCacheLayout, ModelCacheSpec } from './providers/model.js'

// The compatibility gate (rules / probes / verdict / report / post-registration check). It used to
// be the separate `@avantf/dsh-compat` package, provisioned into the framework's managed root; it
// lives in THIS package now and its composition-layer members are on `.` — a plugin that loaded the
// base through the inlined bootstrap already holds the gate, with no second import path. The
// INDIVIDUAL probes (`floorOf` / `checkServices` / `probeToolsRegistry` …) are composition pieces of
// `gatherEvidence` and moved to `./internal` in v3.
export {
  BUILD_VERSIONS_FILE,
  COMPAT_PREFIX,
  compatReport,
  gatherEvidence,
  provision,
  readBuildVersions,
  readDeclaredVersions,
  readRuntimeVersions,
  registerMegaphone,
  schemaNamesFrom,
  toolProbeDeclaration,
  verdictOf,
  verifyRegisteredFaces,
} from './compat.js'
export type {
  CompatContext,
  CompatEvidence,
  CompatLine,
  CompatLogger,
  CompatReportWords,
  CompatSpec,
  CompatVerdict,
  ProbeOutcome,
  ServiceContract,
  ServiceProbe,
} from './compat.js'

// The shared KIT: pure, DSH-free helpers (prompt files, family paths, well-formed text). They are
// part of THIS package on purpose — fixing or extending a shared helper must be possible with one
// base release, without rebuilding or republishing any plugin. Plugins therefore never inline this
// code: they load the base at startup and take these capabilities from it at runtime.
//
// Generation v3 moved the members with no runtime consumer off `.`: `createPluginLogger` (both trees
// use their own logger, which must exist before the base is resolved) and the Typert symbol kit
// (`strictCodec` / `endpointId` / `fieldSymbol` / `resultSymbol`), which both trees keep as local
// two-line mirrors because the Remote/wire faces are assembled at module load. Both live on
// `./internal` now.
export { expandHome, familyHome, familyModelsDir, familyToolsDir, resolveDataHome } from './kit/family.js'
export type { DataHomeInput } from './kit/family.js'
export { PromptFiles } from './kit/prompt_files.js'
export type { LoadedPromptText, PromptFileSpec, PromptFilesIo, PromptFilesLogger, PromptFilesOptions } from './kit/prompt_files.js'
export { wellFormedDeep, wellFormedText } from './kit/wellformed.js'

// The INTERFACE TYPE: the named, frozen surface of this `.` entry. Plugins hold ONE of these names
// instead of the whole `typeof import(...)` namespace, and `api/interface-vN.json` records the current
// generation's names as a machine-checked snapshot. `INTERFACE_VERSION` is the integer plugins bake at
// build time and compare against the value the base they loaded at runtime reports — it is the one
// value here whose job is the RUNTIME interface gate rather than a caller's API, so it belongs on `.`.
//
// v1/v2 stay exported as their generations' type records: a caller compiled against them keeps a
// name. v3 is the first generation that is NOT `extends` its predecessor — it PRUNES the zero-consumer
// members to `./internal` (INTERFACE.md §9); the proof that this lost nothing is
// `VALUE_NAMES_V3 ∪ PRUNED_VALUE_NAMES === VALUE_NAMES_V2` plus the cross-tree zero-consumer check in
// `test/public-surface.spec.ts`.
export { INTERFACE_VERSION } from './interface.js'
export type {
  BaseRuntimeV1,
  BaseRuntimeV2,
  BaseRuntimeV3,
  BaseTypeSurfaceV1,
  BaseTypeSurfaceV2,
  BaseTypeSurfaceV3,
} from './interface.js'

// The runtime interface gate: the verdict function the plugins call with the generation they baked,
// and the ONE reader of a plugin's `lib/interface-version.json`. They live here rather than in each
// plugin so their semantics (asymmetric, guarded, total) are fixable with one base release; the
// plugins keep only the consumption and the degrade decision.
export { checkInterface, readInterfaceRequirement } from './interface_gate.js'
export type { InterfaceRequirement, InterfaceVerdict } from './interface_gate.js'

export type {
  // items and manifests
  AtStartup,
  AtUse,
  BuiltinKind,
  ItemPolicy,
  Kind,
  Manifest,
  MirrorPolicy,
  OnMissing,
  ProvisionItem,
  // state and handles
  ResourceHandle,
  ResourceSource,
  ResourceState,
  Startup,
  // plan and report
  EnsureOptions,
  Plan,
  PlanAction,
  PlanEntry,
  PlanOptions,
  ProvisionEvent,
  ProvisionReport,
  ProvisionReportEntry,
  ProvisionStatus,
  ReportAction,
  // policy and seams
  Disposable,
  ProgressEvent,
  ProvisionFs,
  ProvisionLock,
  ProvisionLogger,
  ProvisionPolicy,
  Provisioner,
  ProvisionerExperimental,
  ProvisionerOptions,
  PrunePolicy,
  PruneReport,
  // provider contract
  InstallContext,
  InstallManifest,
  Provider,
  ProviderContext,
  ProviderPlan,
  ProbeResult,
  PublishMeta,
  Resolved,
  ResourceIdentity,
} from './types.js'
