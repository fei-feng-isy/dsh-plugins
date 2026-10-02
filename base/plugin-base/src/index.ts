/**
 * Plugin environment initialisation at startup.
 * @module index
 */
export {
  CAPABILITIES,
  DEFAULT_DEADLINE_MS,
  ITEM_SCHEMA_VERSION,
  createProvisioner,
  normalizeOnMissing,
} from './provisioner.js'
export { ProvisionError, reasonOf } from './errors.js'
export type { ProvisionCode } from './errors.js'
export { npmPackageProvider, NPM_PACKAGE_KIND } from './providers/npm.js'
export type { NpmPackageSpec } from './providers/npm.js'
export { binaryArchiveProvider, BINARY_ARCHIVE_KIND } from './providers/archive.js'
export type { ArchivePack, BinaryArchiveSpec } from './providers/archive.js'
export { modelCacheProvider, MODEL_CACHE_KIND } from './providers/model.js'
export type { ModelCacheLayout, ModelCacheSpec } from './providers/model.js'

// The compatibility gate lives in the SAME package now (it used to be `@avantf/dsh-compat`,
// provisioned into the framework's managed root as an `npm-package` item). Re-exported from the root
// so a plugin that loaded this package through the inlined bootstrap already holds the gate — no
// second import path, and no plugin ever names the base by specifier at runtime.
export * from './compat.js'

// The shared KIT: pure, DSH-free helpers (prompt files, plugin logger, Typert wire conventions).
// They are part of THIS package on purpose — fixing or extending a shared helper must be possible
// with one base release, without rebuilding or republishing any plugin. Plugins therefore never
// inline this code: they load the base at startup and take these capabilities from it at runtime.
export * from './kit/index.js'

// The INTERFACE TYPE: the named, frozen surface of this `.` entry. Plugins hold ONE of these names
// instead of the whole `typeof import(...)` namespace, and `api/interface-vN.json` records the current
// generation's names as a machine-checked snapshot. `INTERFACE_VERSION` is the integer plugins bake at
// build time and compare against the value the base they loaded at runtime reports — it is the one
// value here whose job is the RUNTIME interface gate rather than a caller's API, so it belongs on `.`.
//
// The types are ADDITIVE: `BaseRuntimeV2` extends `BaseRuntimeV1`, so a caller still compiled against
// v1 (both plugins are) keeps a name that the v2 module satisfies structurally. The v1 interfaces stay
// exported for exactly that reason.
//
// `VALUE_NAMES_V1` / `VALUE_NAMES_V2` / `TYPE_NAMES_V1` / `TYPE_NAMES_V2` are deliberately NOT
// re-exported: they are the snapshot gate's data (read from the source by
// `test/public-surface.spec.ts`), and exporting them would put the inventory itself into the inventory
// it describes.
export { INTERFACE_VERSION } from './interface.js'
export type { BaseRuntimeV1, BaseRuntimeV2, BaseTypeSurfaceV1, BaseTypeSurfaceV2 } from './interface.js'

// The runtime interface gate: the verdict function the plugins call with the generation they baked,
// and the ONE reader of a plugin's `lib/interface-version.json`. They live here rather than in each
// plugin so their semantics (bidirectional, guarded, total) are fixable with one base release; the
// plugins keep only the consumption and the degrade decision.
export { checkInterface, readInterfaceRequirement } from './interface_gate.js'
export type { InterfaceVerdict, InterfaceRequirement } from './interface_gate.js'

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

// The kit's own shapes, named by the interface type (`BaseRuntimeV1`). They were reachable before
// only through the `typeof import(...)` namespace; naming them here is what makes the interface
// type's type members resolvable from `.` as well.
export type {
  PluginLogger,
  PluginLoggerOptions,
  PromptFilesIo,
  PromptFilesLogger,
  PromptFilesOptions,
  StrictCodec,
} from './kit/index.js'
