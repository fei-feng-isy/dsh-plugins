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
