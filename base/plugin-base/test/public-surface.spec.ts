/**
 * The public surface: the `.` entry carries exactly the documented
 * contract — the composition root, the data model and the built-in provider factories — while the
 * framework's own seams live on `./internal` and are explicitly **not** covered by the
 * compatibility promise. A type-only test would be erased, so the map below both references each
 * type and is asserted at runtime.
 *
 * @module test/public-surface
 */
import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'
import * as internal from '../src/internal.js'
import type {
  Disposable,
  EnsureOptions,
  InstallContext,
  InstallManifest,
  ItemPolicy,
  LoadedPromptText,
  Manifest,
  MirrorPolicy,
  Plan,
  PlanEntry,
  PlanOptions,
  PluginLogger,
  PluginLoggerHost,
  PluginLoggerOptions,
  ProbeResult,
  ProgressEvent,
  PromptFileSpec,
  PromptFilesIo,
  PromptFilesLogger,
  PromptFilesOptions,
  Provider,
  ProviderContext,
  ProviderPlan,
  ProvisionCode,
  ProvisionEvent,
  ProvisionFs,
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
  Resolved,
  ResourceHandle,
  ResourceIdentity,
  ResourceState,
  Startup,
  StrictCodec,
} from '../src/index.js'

/** Every public type, referenced so a removal or rename fails the type check. */
interface PublicSurface {
  readonly provisionerOptions: ProvisionerOptions
  readonly provisioner: Provisioner
  readonly experimental: ProvisionerExperimental
  readonly prunePolicy: PrunePolicy
  readonly pruneReport: PruneReport
  readonly planOptions: PlanOptions
  readonly ensureOptions: EnsureOptions
  readonly state: ResourceState
  readonly startup: Startup
  readonly handle: ResourceHandle
  readonly identity: ResourceIdentity
  readonly manifest: Manifest
  readonly providerPlan: ProviderPlan
  readonly provider: Provider
  readonly providerContext: ProviderContext
  readonly installContext: InstallContext
  readonly publishMeta: PublishMeta
  readonly installManifest: InstallManifest
  readonly resolved: Resolved
  readonly probeResult: ProbeResult
  readonly planEntry: PlanEntry
  readonly plan: Plan
  readonly status: ProvisionStatus
  readonly event: ProvisionEvent
  readonly report: ProvisionReport
  readonly reportEntry: ProvisionReportEntry
  readonly policy: ProvisionPolicy
  readonly mirrorPolicy: MirrorPolicy
  readonly itemPolicy: ItemPolicy
  readonly logger: ProvisionLogger
  readonly fs: ProvisionFs
  readonly lock: ProvisionLock
  readonly progress: ProgressEvent
  readonly disposable: Disposable
  readonly code: ProvisionCode
  // The shared KIT the plugins take off this module at runtime: if any of these leaves the root
  // entry, a plugin loses the ability to reuse shared code without being rebuilt.
  readonly promptFileSpec: PromptFileSpec
  readonly loadedPromptText: LoadedPromptText
  readonly promptFilesIo: PromptFilesIo
  readonly promptFilesLogger: PromptFilesLogger
  readonly promptFilesOptions: PromptFilesOptions
  readonly pluginLogger: PluginLogger
  readonly pluginLoggerHost: PluginLoggerHost
  readonly pluginLoggerOptions: PluginLoggerOptions
  readonly strictCodec: StrictCodec
}

const TYPE_NAMES: readonly (keyof PublicSurface)[] = [
  'provisionerOptions',
  'provisioner',
  'experimental',
  'prunePolicy',
  'pruneReport',
  'planOptions',
  'ensureOptions',
  'state',
  'startup',
  'handle',
  'identity',
  'manifest',
  'providerPlan',
  'provider',
  'providerContext',
  'installContext',
  'publishMeta',
  'installManifest',
  'resolved',
  'probeResult',
  'planEntry',
  'plan',
  'status',
  'event',
  'report',
  'reportEntry',
  'policy',
  'mirrorPolicy',
  'itemPolicy',
  'logger',
  'fs',
  'lock',
  'progress',
  'disposable',
  'code',
  'promptFileSpec',
  'loadedPromptText',
  'promptFilesIo',
  'promptFilesLogger',
  'promptFilesOptions',
  'pluginLogger',
  'pluginLoggerHost',
  'pluginLoggerOptions',
  'strictCodec',
]

/** What `.` must export at runtime: the documented API, nothing else. */
const PUBLIC_VALUES: readonly string[] = [
  'CAPABILITIES',
  'DEFAULT_DEADLINE_MS',
  'ITEM_SCHEMA_VERSION',
  'ProvisionError',
  'binaryArchiveProvider',
  'createProvisioner',
  'modelCacheProvider',
  'normalizeOnMissing',
  'npmPackageProvider',
  'reasonOf',
  'BINARY_ARCHIVE_KIND',
  'MODEL_CACHE_KIND',
  'NPM_PACKAGE_KIND',
  // compat — the gate used to be `@avantf/dsh-compat`; it is in THIS package now and must be
  // reachable from the one module a plugin loads through the bootstrap.
  'COMPAT_PREFIX',
  'compatReport',
  'floorOf',
  'provision',
  'verdictOf',
  // The rest of the gate's reachable surface. It is here because the assertion below is an EQUALITY:
  // a name missing from this list is a name the test would otherwise refuse to see, and a name the
  // gate exports without being listed is a name nobody decided to publish.
  'BUILD_VERSIONS_FILE',
  'COMPAT_PROBE_TOOL',
  'checkInterval',
  'checkServices',
  'declaredSchemaKeys',
  'gatherEvidence',
  'probeToolsRegistry',
  'probeTypertRegistry',
  'readBuildVersions',
  'readDeclaredVersions',
  'readRuntimeVersions',
  'registerMegaphone',
  'resolveRuntimeVersion',
  'schemaNamesFrom',
  'toolProbeDeclaration',
  'verifyRegisteredFaces',
  // kit — the shared, DSH-free helpers the plugins consume at runtime.
  'PromptFiles',
  'createPluginLogger',
  'endpointId',
  'expandHome',
  'familyHome',
  'familyModelsDir',
  'familyToolsDir',
  'fieldSymbol',
  'resolveDataHome',
  'resultSymbol',
  'strictCodec',
]

/** Seams and codecs that must stay off the public entry. */
const INTERNAL_ONLY: readonly string[] = [
  'assertSafeRelativePath',
  'candidateUrls',
  'defaultFs',
  'defaultLock',
  'extractTarGz',
  'fetchImplOf',
  'lintManifest',
  'mergeRows',
  'persistStatus',
  'readStatus',
  'stagingDir',
  'versionSegment',
]

describe('公开面', () => {
  it('每个类型都能从 . import', () => {
    // The interface above is the assertion: it cannot compile unless every import resolves.
    expect(TYPE_NAMES.length).toBe(44)
  })

  it('`.` 恰好导出公开面：组合根、数据模型与三个内置 provider 工厂', () => {
    // EQUALITY, not a subset: `missing === []` passes for every NEW export, which is how the name of
    // this test ("`.` exports exactly the public surface") grew larger than the assertion under it.
    // `default` is the CJS interop shim, not part of the surface.
    const actual = Object.keys(api).filter(name => name !== 'default').sort()
    expect(actual).toEqual([...PUBLIC_VALUES].sort())
  })

  it('内部件不在 `.` 上，而在 `./internal` 上（兼容面因此可控）', () => {
    const leaked = INTERNAL_ONLY.filter(name => (api as Record<string, unknown>)[name] !== undefined)
    expect(leaked).toEqual([])
    const missing = INTERNAL_ONLY.filter(name => (internal as Record<string, unknown>)[name] === undefined)
    expect(missing).toEqual([])
  })

  it('公开入口不泄漏子路径入口的实现符号', () => {
    // A subpath (`./preset` / `./conformance` / `./bootstrap`) is its own entry, not a re-export.
    expect(Object.keys(api)).not.toContain('envinitPreset')
    expect(Object.keys(api)).not.toContain('runProviderConformance')
    expect(Object.keys(api)).not.toContain('ensureFramework')
  })
})
