/**
 * The public data model.
 * @module types
 */
import type { ProvisionCode } from './errors.js'

// ─────────────────────────────────────────────────────────────────────────────
// Items and manifests
// ─────────────────────────────────────────────────────────────────────────────

/** The kinds the framework ships providers for; these names are reserved.
 *  @stable */
export type BuiltinKind = 'npm-package' | 'binary-archive' | 'model-cache'

/** A kind is a namespaced string; third-party kinds must carry a prefix.
 *  @stable */
export type Kind = BuiltinKind | (string & {})

/** What to do at mount time when the item is not ready.
 *  @stable */
export type AtStartup = 'degrade' | 'refuse'
/** What to do when the item is used and is not ready.
 *  @stable */
export type AtUse = 'degrade' | 'error'

/** Whether `ensure()` waits for an item at mount. Default `'blocking'`. */
export type Startup = 'blocking' | 'background'

/** Per-item strictness; each field defaults on its own, and an illegal value falls back per field.
 *  @stable */
export interface OnMissing {
  readonly atStartup?: AtStartup
  readonly atUse?: AtUse
}

/** Mirrors are split by distribution network.
 *  @stable */
export interface MirrorPolicy {
  readonly archive: readonly string[]
  readonly npm?: readonly string[]
  /** Endpoints for `model-cache` items, tried before the built-in default endpoint. */
  readonly model?: readonly string[]
}

/** Framework-known per-item policy; provider-private keys must be namespaced.
 *  @stable */
export interface ItemPolicy {
  readonly mirrors?: MirrorPolicy
  readonly concurrency?: number
  /** Per-request timeout in ms for this item's downloads; `0` = wait indefinitely, undeclared = 300 000.
   *
   *  It is the escape hatch a multi-gigabyte model needs on a link slower than 14 MB/s; the core
   *  copies it into the provider's `policy.timeoutMs`, where `signalFor` reads it. */
  readonly timeoutMs?: number
  readonly platforms?: readonly string[]
  readonly [providerScopedKey: string]: unknown
}

/** One resource a plugin needs; `target.root` is relative to `home` and carries no version.
 *   @stable */
export interface ProvisionItem {
  /** Stable, plugin-namespaced item id. */
  readonly id: string
  readonly kind: Kind
  /** Interpreted by the provider for this kind (npm range, packs, repository revision, …). */
  readonly spec: unknown
  readonly target: { readonly root: string }
  readonly onMissing?: OnMissing
  /** Wait for it at mount, or dispatch it and report later. Default `'blocking'`. */
  readonly startup?: Startup
  /** Other items in the **same** plugin this one needs first. */
  readonly needs?: readonly string[]
  readonly policy?: ItemPolicy
  /** Descriptor version. */
  readonly schemaVersion: number
}

/** What a plugin declares at startup.
 *   @stable */
export interface Manifest {
  /** Plugin namespace; must match the item id prefix. */
  readonly plugin: string
  readonly items: readonly ProvisionItem[]
  readonly requires?: {
    readonly capabilities?: readonly string[]
    readonly providers?: readonly { readonly package: string; readonly kinds: readonly string[] }[]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource state and handles
// ─────────────────────────────────────────────────────────────────────────────

/** @stable */
export type ResourceSource = 'resolved' | 'managed' | 'installed' | 'system' | 'explicit'

/** A ready resource: where it is, what it is, and what env it contributes.
 *   @stable */
export interface ResourceHandle {
  readonly id: string
  /** Normalised resource key `kind+name` — one half of the row identity. */
  readonly key: string
  readonly kind: Kind
  readonly version?: string
  readonly source: ResourceSource
  /** The usable entry directory (npm: `<versionDir>/node_modules/<name>`). */
  readonly dir: string
  /** Environment a child process needs (PATH, …). */
  readonly env: Readonly<Record<string, string>>
}

/** The five states `resolve()` can answer with.
 *   @stable */
export type ResourceState =
  | { readonly state: 'ready'; readonly handle: ResourceHandle }
  | { readonly state: 'pending'; readonly since: number }
  | { readonly state: 'failed'; readonly code: ProvisionCode; readonly detail?: string; readonly retryAfter?: number }
  | { readonly state: 'skipped'; readonly code: ProvisionCode; readonly detail?: string }
  | { readonly state: 'missing' }

// ─────────────────────────────────────────────────────────────────────────────
// Plan and report
// ─────────────────────────────────────────────────────────────────────────────

/** @stable */
export type PlanAction = 'present' | 'install' | 'skip' | 'unknown'
/** @stable */
export type ReportAction = 'present' | 'installed' | 'skipped' | 'failed'

/** @stable */
export interface PlanEntry {
  readonly key: string
  readonly action: PlanAction
  readonly version?: string
  readonly source?: ResourceSource
  readonly urls?: readonly string[]
}

/** @stable */
export interface Plan {
  readonly entries: readonly PlanEntry[]
  readonly offline: boolean
}

/** @stable */
export interface PlanOptions {
  readonly only?: readonly string[]
  readonly offline?: boolean
}

/** @stable */
export interface EnsureOptions {
  readonly only?: readonly string[]
  readonly offline?: boolean
  readonly signal?: AbortSignal
  /** This call's startup budget, overriding `policy.deadlineMs` for the call. */
  readonly deadlineMs?: number
  /** Called **once per item** when it reaches a terminal state, with the same line the report
   *  carries; a throw is logged and ignored. */
  readonly onSettled?: (entry: ProvisionReportEntry) => void
  /** Byte-level progress from this call's installs, forwarded to `InstallContext.onProgress`. */
  readonly onProgress?: (event: ProgressEvent) => void
}

/** @stable */
export interface ProvisionReportEntry {
  readonly plugin: string
  readonly id: string
  readonly key: string
  readonly action: ReportAction
  readonly source: ResourceSource
  readonly version?: string
  readonly ms: number
  readonly code?: ProvisionCode
  readonly reason?: string
}

/** @stable */
export interface ProvisionReport {
  readonly entries: readonly ProvisionReportEntry[]
  readonly ok: boolean
}

/** One row of `status()`; the row identity is `key × version`.
 *   @stable */
export interface ProvisionStatus {
  readonly key: string
  /** Part of the row identity; the empty string until a version has been resolved. */
  readonly version: string
  readonly items: readonly string[]
  readonly plugins: readonly string[]
  readonly state: ResourceState
  readonly source?: ResourceSource
  readonly updatedAt: number
  readonly lastError?: { readonly code: ProvisionCode; readonly detail?: string; readonly retryAfter?: number }
}

/** Late-arrival and reporting notifications; the union narrows on `type`.
 *   @stable */
export type ProvisionEvent =
  | { readonly type: 'availability'; readonly key: string; readonly state: ResourceState }
  | { readonly type: 'report'; readonly key: string; readonly entry: ProvisionReportEntry }

// ─────────────────────────────────────────────────────────────────────────────
// Policy and injection seams
// ─────────────────────────────────────────────────────────────────────────────

/** @stable */
export interface ProvisionPolicy {
  /** Whether automatic download is allowed: overall, or per-kind override. Default `true`. */
  readonly autoDownload?: boolean | Partial<Record<string, boolean>>
  /** Maps a kind to the provider that claims it; the only way to lift a `provider/conflict`. */
  readonly kindProviders?: Readonly<Record<string, string>>
  readonly mirrors?: MirrorPolicy
  readonly packumentMirrors?: readonly string[]
  /** Per-request timeout in ms for this item's downloads; `0` = wait indefinitely.
   *
   *  The core fills it from `item.policy.timeoutMs`; an item that does not declare one keeps the
   *  300 000 ms default. It exists so a multi-gigabyte model on a slow link is not cut off by a
   *  timeout sized for metadata. */
  readonly timeoutMs?: number
  /** Startup critical-path budget in ms. Default 15 000. */
  readonly deadlineMs?: number
  readonly quotaBytes?: number
  /** Grace period before `.trash` entries may be removed. Default 7 days. */
  readonly trashGraceMs?: number
  readonly gc?: 'off' | 'background'
  /** Offline/preloaded source directories. */
  readonly preloaded?: readonly string[]
}

/** @stable */
export interface ProvisionLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/** Byte-level progress, only on request.
 *  @experimental */
export interface ProgressEvent {
  readonly key: string
  readonly phase: 'download' | 'extract'
  readonly loaded: number
  readonly total?: number
}

/** @stable */
export interface Disposable {
  dispose(): void
}

/** Data-plane IO. Every mutation goes through this seam.
 *   @stable */
export interface ProvisionFs {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  /** Same-directory temp file + rename; metadata such as `install.json` must use it. */
  atomicWrite(path: string, data: Uint8Array): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string): Promise<void>
  readdir(path: string): Promise<readonly string[]>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory: boolean; mode: number } | undefined>
  rm(path: string, options?: { recursive?: boolean }): Promise<void>
  symlink(target: string, path: string): Promise<void>
  /** The link target when `path` is a symlink, else `undefined`. */
  readlink(path: string): Promise<string | undefined>
  copyFile(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
}

/** Control-plane mutual exclusion; the default is `<home>/.envinit/.lock`.
 *   @stable */
export interface ProvisionLock {
  acquire(path: string, options: { timeoutMs: number; staleMs: number }): Promise<Disposable>
}

/** @stable */
export interface ProvisionerOptions {
  /** Family root. Default `~/.avantf/env`. */
  readonly home?: string
  /** Built-in layout name. Default `v1`. */
  readonly layout?: string
  /** The framework range this plugin declared (`peerDependencies`, read with
   *  `readDependencyRange`); an unsatisfied range skips every declared item. */
  readonly envinitRange?: string
  readonly policy?: ProvisionPolicy
  readonly logger: ProvisionLogger
  readonly fetch?: typeof fetch
  readonly fs?: ProvisionFs
  readonly lock?: ProvisionLock
  readonly clock?: () => number
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider contract
// ─────────────────────────────────────────────────────────────────────────────

/** The resource identity a provider assigns to an item; the core rejects a provider-supplied key.
 *  @stable */
export interface ResourceIdentity {
  readonly name: string
  /** The selection range/fingerprint, when the kind has one (npm range, repository revision, …). */
  readonly range?: string
}

/** @stable */
export type ProbeResult =
  | {
      readonly found: true
      readonly version?: string
      readonly dir: string
      readonly source: ResourceSource
      /** Environment additions for the handle (a managed binary's PATH). */
      readonly env?: Readonly<Record<string, string>>
    }
  | { readonly found: false }

/** @stable */
export interface PublishMeta {
  readonly name: string
  readonly version: string
  readonly integrity?: string
  readonly tarball?: string
  readonly source?: ResourceSource
  /** The executable's path relative to the version directory (archive kinds). */
  readonly entry?: string
  /** The usable entry **directory**, relative to the version directory (npm: `node_modules/<name>`). */
  readonly entryDir?: string
}

/** What a completed install published: the version directory plus its identity.
 *  @stable */
export interface Resolved {
  /** The normalised resource key; filled by the core, so a provider that does not publish may omit it. */
  readonly key?: string
  readonly name: string
  readonly version: string
  /** The **version directory** (published unit). */
  readonly dir: string
  /** The usable entry directory. */
  readonly entryDir: string
  readonly integrity?: string
  readonly source: ResourceSource
  /** Environment additions for the handle (a managed binary's PATH). */
  readonly env?: Readonly<Record<string, string>>
}

/** @stable */
export interface ProviderContext {
  readonly home: string
  readonly logger: ProvisionLogger
  readonly policy: ProvisionPolicy
  /** The data-plane seam the core uses. */
  readonly fs: ProvisionFs
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
  /** The core's control-plane lock, so a provider that places files itself can serialise. */
  readonly lock?: ProvisionLock
}

/** Providers never hold the publish lock: download outside, publish through the core.
 *   @stable */
export interface InstallContext extends ProviderContext {
  /** A fresh staging directory under `<home>/.envinit/.tmp/`. */
  stage(): Promise<string>
  /** Core writes `install.json` here, then renames the staging tree to the version directory. */
  publish(staging: string, meta: PublishMeta): Promise<Resolved>
  onProgress?(event: ProgressEvent): void
}

/** A provider's plan for one item; the core wraps it into a {@link PlanEntry}.
 *   @stable */
export interface ProviderPlan {
  readonly action: PlanAction
  readonly version?: string
  readonly urls?: readonly string[]
}

/** @stable */
export interface Provider {
  /** Provider identity; a third-party provider must use its npm package name. */
  readonly id: string
  /** Kinds it claims; third-party kinds must be namespaced. */
  readonly kinds: readonly string[]
  /** The resource identity used to build the normalised key. */
  identify(item: ProvisionItem): ResourceIdentity
  /** Cheap presence/version check. Never downloads, never mutates. */
  probe(item: ProvisionItem, ctx: ProviderContext): Promise<ProbeResult>
  /** What would be done, as data (pure; no disk, no network). */
  plan(item: ProvisionItem, ctx: ProviderContext): ProviderPlan | Promise<ProviderPlan>
  /** The **version directory** relative path under `item.target.root` (safe, no `..`). */
  targetDir(item: ProvisionItem, ref: { readonly name: string; readonly version: string; readonly segment: string }): string
  /** Download/extract outside the lock and publish through `ctx.publish()`. */
  install(item: ProvisionItem, ctx: InstallContext): Promise<Resolved>
  /** Prove the result is usable; the core quarantines the directory when this throws. */
  verify(item: ProvisionItem, resolved: Resolved, ctx: ProviderContext): Promise<void>
}

/** What the core writes into every version directory.
 *   @stable */
export interface InstallManifest {
  readonly schemaVersion: number
  readonly name: string
  readonly version: string
  readonly dir: string
  readonly integrity?: string
  readonly tarball?: string
  readonly entry?: string
  /** The usable entry directory relative to the version directory (npm: `node_modules/<name>`). */
  readonly entryDir?: string
  readonly installed_at: string
  readonly source: ResourceSource
  readonly layout: string
}

/** What to keep when reclaiming versions.
 *  @experimental */
export interface PrunePolicy {
  /** Keep the newest N versions per resource. */
  readonly keepVersions?: number
  /** Keep versions younger than M days. */
  readonly keepDays?: number
  /** Family-root quota, counting `.trash`. Same name and meaning as `ProvisionPolicy.quotaBytes`. */
  readonly quotaBytes?: number
  /** Reclaim versions nothing currently declares. Off by default. */
  readonly orphan?: boolean
}

/** What a prune moved aside; `movedBytes` is the moved amount, not the released amount.
 *  @experimental */
export interface PruneReport {
  readonly moved: readonly string[]
  readonly skipped: readonly string[]
  readonly movedBytes: number
}

/** Experimental members; reaching them requires `experimental()`.
 *  @experimental */
export interface ProvisionerExperimental {
  /** No-op in this build: reclamation is not implemented, so it warns and reports nothing. */
  prune(policy?: PrunePolicy): Promise<PruneReport>
  on(event: 'availability' | 'report', listener: (event: ProvisionEvent) => void): Disposable
}

/** The composition root; every member here is **stable**. Experimental members live on
 *  {@link ProvisionerExperimental}. */
export interface Provisioner {
  register(provider: Provider): Disposable
  declare(manifest: Manifest): void
  plan(options?: PlanOptions): Promise<Plan>
  ensure(options?: EnsureOptions): Promise<ProvisionReport>
  resolve(itemId: string): ResourceState
  status(): readonly ProvisionStatus[]
  repair(itemId: string): Promise<ProvisionReport>
  experimental(): ProvisionerExperimental
  /** Abort mission still in flight and drop subscriptions; the instance is not reused. */
  dispose(): void
}
