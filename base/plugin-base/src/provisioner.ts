/**
 * The provisioner orchestration core.
 * @module provisioner
 */
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { ProvisionError, reasonOf } from './errors.js'
import type { ProvisionCode } from './errors.js'
import { defaultFs, exists } from './fs.js'
import {
  assertSafeRelativePath,
  assertSafeRelativeRoot,
  isInside,
  lockPath,
  quarantineDir,
  stagingDir,
  versionSegment,
} from './layout.js'
import { VERSION as FRAMEWORK_VERSION } from './bootstrap.js'
import { defaultLock } from './lock.js'
import {
  INSTALL_MANIFEST_FILE,
  MANIFEST_SCHEMA_VERSION,
  decodeJson,
  encodeInstallManifest,
  readInstallManifest,
} from './manifest.js'
import { ITEM_FIELDS, MANIFEST_FIELDS, UNIMPLEMENTED_POLICY_KEYS, UNIMPLEMENTED_PROVISION_POLICY_KEYS, unknownFields } from './lint.js'
import { parseVersion, satisfiesRange } from './semver.js'
import {
  persistStatus,
  readLayout,
  readStatus,
  recordDeclared,
  writeLayout,
} from './state.js'
import type { StatusRow } from './state.js'
import type {
  AtStartup,
  AtUse,
  Disposable,
  EnsureOptions,
  InstallManifest,
  Manifest,
  MirrorPolicy,
  Plan,
  PlanEntry,
  PlanOptions,
  ProbeResult,
  ProviderPlan,
  Provider,
  ProviderContext,
  ProgressEvent,
  ProvisionEvent,
  ProvisionItem,
  ProvisionLogger,
  ProvisionPolicy,
  ProvisionReport,
  ProvisionReportEntry,
  ProvisionStatus,
  Provisioner,
  ProvisionerExperimental,
  ProvisionerOptions,
  PublishMeta,
  Resolved,
  ResourceIdentity,
  ResourceSource,
  ResourceState,
} from './types.js'

/** The capability names this copy implements. @stable */
export const CAPABILITIES: readonly string[] = ['events', 'resolve-record', 'progress']

/** Startup critical-path budget in ms. @stable */
export const DEFAULT_DEADLINE_MS = 15_000

/** Descriptor version this build understands. @stable */
export const ITEM_SCHEMA_VERSION = 1

/** Staging/quarantine sequence, monotonic per process. */
let stagingSequence = 0
/** How long a publish waits for the family lock before reporting `lock/timeout`. */
const LOCK_TIMEOUT_MS = 15_000
/** A lock older than this whose pid is gone is reclaimed. */
const STALE_LOCK_MS = 60_000

interface NormalizedMissing {
  readonly atStartup: AtStartup
  readonly atUse: AtUse
}

/** `onMissing` defaults, per axis: `degrade` / `error` (see `docs/DESIGN.md`). Absent and `{}` are the
 *  SAME request — the two used to disagree on `atUse`, so "omit the object" quietly meant something
 *  other than "declare no preference". (`atUse` is declarative today: nothing consumes it yet, which
 *  is exactly why the documented default has to be the one the code reports.) */
export function normalizeOnMissing(value: ProvisionItem['onMissing']): NormalizedMissing {
  if (value === undefined) return { atStartup: 'degrade', atUse: 'error' }
  const atStartup: AtStartup = value.atStartup === 'degrade' || value.atStartup === 'refuse' ? value.atStartup : 'degrade'
  const atUse: AtUse = value.atUse === 'degrade' || value.atUse === 'error' ? value.atUse : 'error'
  return { atStartup, atUse }
}

interface DeclaredItem {
  readonly plugin: string
  readonly item: ProvisionItem
  readonly identity: ResourceIdentity | undefined
  readonly key: string
  /** The `requires.providers` package expected for this item's kind, when declared. */
  readonly expectedProvider: string | undefined
}

const SILENT_LOGGER: ProvisionLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Resource key: `kind+name`, or a best-effort `kind+id` when no provider claims the kind. */
function resourceKey(kind: string, identity: ResourceIdentity | undefined, itemId: string): string {
  return `${kind}+${identity?.name ?? itemId}`
}

/** A timer that never keeps the process alive on its own. */
function delay(ms: number): Promise<undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
}

function rowKeyOf(key: string, version: string): string {
  return `${key}\u0000${version}`
}

/** The provisioner-wide signal, plus a per-call signal when supplied. */
function combineSignals(base: AbortSignal, extra: AbortSignal | undefined): AbortSignal {
  return extra === undefined ? base : AbortSignal.any([base, extra])
}

/** Create a provisioner instance.
 *  @stable */
export function createProvisioner(options: ProvisionerOptions): Provisioner {
  const fs = options.fs ?? defaultFs()
  const clock = options.clock ?? Date.now
  const lock = options.lock ?? defaultLock({ clock })
  const logger = options.logger ?? SILENT_LOGGER
  const home = options.home ?? join(homedir(), '.avantf', 'env')
  const layout = options.layout ?? 'v1'
  const policy: ProvisionPolicy = options.policy ?? {}

  const warnedUnimplemented = new Set<string>()
  /** Warn once per present unimplemented setting key. */
  const noteUnimplemented = (known: readonly string[], present: readonly string[], where: string): void => {
    for (const key of known) {
      if (!present.includes(key)) continue
      const id = `${where}.${key}`
      if (warnedUnimplemented.has(id)) continue
      warnedUnimplemented.add(id)
      logger.warn(`ignored-field: ${id} 本实现不读取，设置它不会生效`)
    }
  }
  noteUnimplemented(UNIMPLEMENTED_PROVISION_POLICY_KEYS, Object.keys(policy), 'policy')

  /** Whether the loaded framework satisfies the declared range; missing passes. */
  const unsupported: ProvisionCode | undefined = (() => {
    const range = options.envinitRange
    if (range === undefined) return undefined
    try {
      return satisfiesRange(FRAMEWORK_VERSION, range) ? undefined : 'unsupported-envinit'
    } catch {
      return 'unsupported-envinit'
    }
  })()
  let unsupportedWarned = false

  /** Auto-download gate, per kind. */
  const autoDownload = (kind: string): boolean => {
    const value = policy.autoDownload
    if (value === undefined) return true
    if (typeof value === 'boolean') return value
    return value[kind] ?? true
  }

  // ── provider registry ──────────────────────────────────────────────────────
  const claims = new Map<string, Provider[]>()
  const providers = new Map<string, Provider>()

  const refresh = (kind: string): void => {
    const list = claims.get(kind) ?? []
    if (list.length === 0) {
      providers.delete(kind)
      return
    }
    if (list.length === 1) {
      const only = list[0]
      if (only !== undefined) providers.set(kind, only)
      return
    }
    const chosen = policy.kindProviders?.[kind]
    const picked = chosen === undefined ? undefined : list.find(provider => provider.id === chosen)
    if (picked === undefined) {
      logger.warn(`provider/conflict: kind "${kind}" is claimed by ${list.map(p => p.id).join(', ')}; failing closed`)
      providers.delete(kind)
      return
    }
    providers.set(kind, picked)
  }

  type Lookup = { readonly provider: Provider } | { readonly code: ProvisionCode }
  const lookup = (kind: string): Lookup => {
    const list = claims.get(kind) ?? []
    if (list.length === 0) return { code: 'unknown-provider' }
    const provider = providers.get(kind)
    if (provider === undefined) return { code: 'provider/conflict' }
    return { provider }
  }

  const register = (provider: Provider): Disposable => {
    for (const kind of provider.kinds) {
      const list = claims.get(kind) ?? []
      if (!list.includes(provider)) list.push(provider)
      claims.set(kind, list)
      refresh(kind)
    }
    return {
      dispose: () => {
        for (const kind of provider.kinds) {
          const list = (claims.get(kind) ?? []).filter(candidate => candidate !== provider)
          if (list.length === 0) claims.delete(kind)
          else claims.set(kind, list)
          refresh(kind)
        }
      },
    }
  }

  // ── declared items ─────────────────────────────────────────────────────────
  const items = new Map<string, DeclaredItem>()
  const rows = new Map<string, ProvisionStatus>()
  const itemRows = new Map<string, string>()
  const listeners = new Set<{ readonly event: ProvisionEvent['type']; readonly listener: (event: ProvisionEvent) => void }>()
  /** Layout read-only state, decided once per process. */
  let readOnly: ProvisionCode | undefined
  let homeChecked = false
  const pendingDeclared: Promise<void>[] = []

  /** Decide the home's layout once. */
  const checkHome = async (): Promise<void> => {
    if (homeChecked) return
    homeChecked = true
    if (unsupported !== undefined && !unsupportedWarned) {
      unsupportedWarned = true
      logger.warn(
        `unsupported-envinit: 本副本 ${FRAMEWORK_VERSION} 不满足插件声明的区间 "${String(options.envinitRange)}"；跳过该清单、降级挂载`,
      )
    }
    try {
      const result = await readLayout(fs, home, layout)
      if (result.kind === 'none') {
        await writeLayout(fs, home, layout, 'dsh-plugin-base')
      } else if (result.kind === 'too-new') {
        readOnly = 'layout/too-new'
        logger.warn(`layout/too-new: ${home} 由更新的布局写入；本次只读不写`)
      } else if (result.kind === 'mismatch') {
        readOnly = 'layout/mismatch'
        logger.warn(`layout/mismatch: ${home} 的布局是 "${result.file.layout}"，本次是 "${layout}"；本次只读不写`)
      }
    } catch (error) {
      // A read failure keeps the read-only CONSEQUENCE but gets its own code: every item's report
      // would otherwise say `layout/too-new` — "a NEWER layout wrote this, leave it alone" — about a
      // home whose layout nobody managed to read at all.
      logger.warn(`layout: 无法读写 .layout.json（${reasonOf(error).message}）；按只读继续`)
      readOnly = 'layout/unreadable'
    }
  }

  /**
   * The failure a persisted row should carry: an explicit `lastError` if something ever sets one,
   * otherwise the row's OWN terminal state.
   *
   * The fallback is the point. `lastError` has no writer anywhere, so before this the field was
   * never persisted at all: a failed item whose version was still unknown wrote a bare
   * `{key, version: "", items, plugins}` and a reader of `status.json` had no way to tell "still
   * installing" from "all four mirrors failed" — the review of 76408fb read exactly that row as a
   * missing field. The row stays (it is the resource's unresolved face, and folding it into the
   * versioned row on success is what removes it); what it now carries is the reason.
   */
  const lastErrorOf = (row: ProvisionStatus): StatusRow['last_error'] | undefined => {
    if (row.lastError !== undefined) return row.lastError
    if (row.state.state === 'failed') {
      return {
        code: row.state.code,
        ...(row.state.detail === undefined ? {} : { detail: row.state.detail }),
        ...(row.state.retryAfter === undefined ? {} : { retry_after: row.state.retryAfter }),
      }
    }
    if (row.state.state === 'skipped') {
      return { code: row.state.code, ...(row.state.detail === undefined ? {} : { detail: row.state.detail }) }
    }
    return undefined
  }

  /** The persisted view of the current rows (identity `key × version`). */
  const statusRows = (): StatusRow[] =>
    [...rows.values()].map(row => {
      const lastError = lastErrorOf(row)
      return {
        key: row.key,
        version: row.version,
        items: row.items,
        plugins: row.plugins,
        ...(row.source === undefined ? {} : { source: row.source }),
        updated_at: row.updatedAt,
        ...(lastError === undefined ? {} : { last_error: lastError }),
      }
    })

  const emit = (event: ProvisionEvent): void => {
    for (const entry of listeners) {
      // One subscription receives one event kind.
      if (entry.event !== event.type) continue
      try {
        entry.listener(event)
      } catch (error) {
        logger.warn(`a provision listener threw: ${reasonOf(error).message}`)
      }
    }
  }

  const putRow = (declared: DeclaredItem, version: string, state: ResourceState, source?: ResourceSource): void => {
    const key = rowKeyOf(declared.key, version)
    const previous = rows.get(key)
    // A version-less row is the resource's unresolved face.
    const unresolvedKey = version === '' ? undefined : rowKeyOf(declared.key, '')
    const unresolved = unresolvedKey === undefined ? undefined : rows.get(unresolvedKey)
    if (unresolvedKey !== undefined && unresolved !== undefined) {
      rows.delete(unresolvedKey)
      // Items that read the unresolved row now read the versioned one.
      for (const id of unresolved.items) itemRows.set(id, key)
    }
    const plugins = new Set([...(previous?.plugins ?? []), ...(unresolved?.plugins ?? [])])
    plugins.add(declared.plugin)
    const itemIds = new Set([...(previous?.items ?? []), ...(unresolved?.items ?? [])])
    itemIds.add(declared.item.id)
    rows.set(key, {
      key: declared.key,
      version,
      items: [...itemIds].sort(),
      plugins: [...plugins].sort(),
      state,
      ...(source === undefined ? {} : { source }),
      updatedAt: clock(),
    })
    itemRows.set(declared.item.id, key)
    emit({ type: 'availability', key: declared.key, state })
  }

  const declare = (manifest: Manifest): void => {
    if (manifest.plugin === '') throw new ProvisionError('invalid-option', 'Manifest.plugin 不能为空')
    // Unknown fields are ignored, never fatal; they are surfaced as `ignored-field`.
    for (const key of unknownFields(manifest, MANIFEST_FIELDS)) {
      logger.warn(`ignored-field: manifest(${manifest.plugin}) 携带框架不认识的字段：${key}`)
    }
    for (const capability of manifest.requires?.capabilities ?? []) {
      if (!CAPABILITIES.includes(capability)) {
        logger.warn(`ignored-field: manifest(${manifest.plugin}) 声明了本副本不具备的能力：${capability}`)
      }
    }
    const reaches = (from: string, target: string, seen: Set<string>): boolean => {
      for (const need of items.get(from)?.item.needs ?? []) {
        if (need === target) return true
        if (seen.has(need)) continue
        seen.add(need)
        if (reaches(need, target, seen)) return true
      }
      return false
    }
    for (const item of manifest.items) {
      for (const key of unknownFields(item, ITEM_FIELDS)) {
        logger.warn(`ignored-field: ${item.id} 携带框架不认识的字段：${key}`)
      }
      noteUnimplemented(UNIMPLEMENTED_POLICY_KEYS, Object.keys(item.policy ?? {}), `${item.id}.policy`)
      // An illegal `onMissing` value falls back to that axis's default after a warning.
      if (item.onMissing !== undefined) {
        const normalized = normalizeOnMissing(item.onMissing)
        const raw = item.onMissing as { readonly atStartup?: unknown; readonly atUse?: unknown }
        for (const [axis, fallback] of [
          ['atStartup', normalized.atStartup],
          ['atUse', normalized.atUse],
        ] as const) {
          if (raw[axis] !== undefined && raw[axis] !== fallback) {
            logger.warn(`invalid-option: ${item.id}.onMissing.${axis} 取值非法（${String(raw[axis])}）；按缺省 ${fallback} 处理`)
          }
        }
      }
      const startup: unknown = item.startup
      if (startup !== undefined && startup !== 'blocking' && startup !== 'background') {
        logger.warn(`invalid-option: ${item.id}.startup 取值非法（${String(startup)}）；按缺省 blocking 处理`)
      }
      if (items.has(item.id)) {
        throw new ProvisionError('invalid-option', `item id 重复：${item.id}`)
      }
      if ((item.needs ?? []).some(need => need === item.id || reaches(need, item.id, new Set()))) {
        throw new ProvisionError('invalid-option', `needs 成环：${item.id}`)
      }
      assertSafeRelativeRoot(item.target.root)
      const found = lookup(item.kind)
      const identity = 'provider' in found ? found.provider.identify(item) : undefined
      const key = resourceKey(item.kind, identity, item.id)
      // `requires.providers` maps an absent provider to `provider/unavailable`.
      const expectedProvider = (manifest.requires?.providers ?? []).find(entry => entry.kinds.includes(item.kind))?.package
      items.set(item.id, { plugin: manifest.plugin, item, identity, key, expectedProvider })
      // Declaration registry: one entry per (key, plugin), appended under the status short lock —
      // but NOT written here. The home's layout verdict is the authority on whether this home may be
      // touched at all, and `declare` is the synchronous collecting pass, so it has not been reached
      // yet. Writing eagerly meant the ONE case the invariant exists for — a home written by a NEWER
      // layout — still got a declaration registry appended to it. The write now waits for the verdict
      // and skips when the verdict is read-only.
      pendingDeclared.push((async () => {
        await checkHome()
        if (readOnly !== undefined) return
        await recordDeclared(fs, lock, home, key, manifest.plugin, logger)
      })())
    }
  }

  // ── selection and ordering ─────────────────────────────────────────────────
  interface Selection {
    readonly ordered: readonly DeclaredItem[]
    readonly invalid: readonly string[]
  }

  const select = (only?: readonly string[]): Selection => {
    const invalid: string[] = []
    let chosen: DeclaredItem[]
    if (only === undefined) {
      chosen = [...items.values()]
    } else {
      const wanted = new Set<string>()
      for (const id of only) {
        if (!items.has(id)) {
          invalid.push(id)
          continue
        }
        wanted.add(id)
      }
      // `only` pulls in the `needs` closure among declared items.
      let grew = true
      while (grew) {
        grew = false
        for (const id of [...wanted]) {
          const declared = items.get(id)
          for (const need of declared?.item.needs ?? []) {
            if (items.has(need) && !wanted.has(need)) {
              wanted.add(need)
              grew = true
            }
          }
        }
      }
      chosen = [...wanted].map(id => items.get(id)).filter((entry): entry is DeclaredItem => entry !== undefined)
    }
    // Topological order over `needs` (stable by declaration order).
    const ordered: DeclaredItem[] = []
    const visiting = new Set<string>()
    const done = new Set<string>()
    const byId = new Map(chosen.map(entry => [entry.item.id, entry]))
    const visit = (entry: DeclaredItem): void => {
      if (done.has(entry.item.id) || visiting.has(entry.item.id)) return
      visiting.add(entry.item.id)
      for (const need of entry.item.needs ?? []) {
        const next = byId.get(need)
        if (next !== undefined) visit(next)
      }
      visiting.delete(entry.item.id)
      done.add(entry.item.id)
      ordered.push(entry)
    }
    for (const entry of chosen) visit(entry)
    return { ordered, invalid }
  }

  // ── item pipeline ─────────────────────────────────────────────────────────
  /** The provisioner's own controller: `dispose()` aborts everything still in flight. */
  const shutdown = new AbortController()

  /** The policy a provider sees for one item; item-level fields win per field.
   *
   *  `timeoutMs` rides along so `signalFor(ctx)` can honour it without providers reaching into
   *  `ProvisionItem`; `0` (= no timeout) and any illegal value are passed through as declared and
   *  normalised once, in `signalFor`. */
  const policyFor = (item: ProvisionItem): ProvisionPolicy => {
    const timeoutMs = item.policy?.timeoutMs
    const withTimeout: ProvisionPolicy = timeoutMs === undefined ? policy : { ...policy, timeoutMs }
    const scoped = item.policy?.mirrors as Partial<MirrorPolicy> | undefined
    if (scoped === undefined) return withTimeout
    const archive = scoped.archive ?? policy.mirrors?.archive ?? []
    const npm = scoped.npm ?? policy.mirrors?.npm
    const model = scoped.model ?? policy.mirrors?.model
    return {
      ...withTimeout,
      mirrors: {
        archive,
        ...(npm === undefined ? {} : { npm }),
        ...(model === undefined ? {} : { model }),
      },
    }
  }

  const contextOf = (signal?: AbortSignal, item?: ProvisionItem): ProviderContext => ({
    home,
    logger,
    policy: item === undefined ? policy : policyFor(item),
    fs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    lock,
    signal: combineSignals(shutdown.signal, signal),
  })

  const entryOf = (
    declared: DeclaredItem,
    fields: { action: ProvisionReportEntry['action']; source: ResourceSource; started: number; version?: string; code?: ProvisionCode; reason?: string },
  ): ProvisionReportEntry => ({
    plugin: declared.plugin,
    id: declared.item.id,
    key: declared.key,
    action: fields.action,
    source: fields.source,
    ms: clock() - fields.started,
    ...(fields.version === undefined ? {} : { version: fields.version }),
    ...(fields.code === undefined ? {} : { code: fields.code }),
    ...(fields.reason === undefined ? {} : { reason: fields.reason }),
  })

  const readManifestAt = async (directory: string, kind: string): Promise<InstallManifest | undefined> => {
    const path = join(directory, INSTALL_MANIFEST_FILE)
    const info = await fs.stat(path)
    if (info === undefined) return undefined
    return readInstallManifest(decodeJson(await fs.readFile(path)), kind)
  }

  /** Move a version directory aside; renaming is never deletion. */
  const quarantine = async (directory: string): Promise<void> => {
    const destination = quarantineDir(home, (stagingSequence += 1))
    await fs.mkdir(dirname(destination))
    await fs.rename(directory, destination)
  }

  /** Move a published directory aside while holding the publish lock. */
  const quarantineLocked = async (directory: string): Promise<void> => {
    const handle = await lock.acquire(lockPath(home), { timeoutMs: LOCK_TIMEOUT_MS, staleMs: STALE_LOCK_MS })
    try {
      await quarantine(directory)
    } finally {
      handle.dispose()
    }
  }

  const publish = async (declared: DeclaredItem, staging: string, meta: PublishMeta): Promise<Resolved> => {
    const { item } = declared
    const segment = versionSegment(home, item.target.root, meta.name, meta.version)
    const provider = providers.get(item.kind)
    if (provider === undefined) throw new ProvisionError('unknown-provider', `没有 provider 认领 ${item.kind}`)
    const rel = provider.targetDir(item, { name: meta.name, version: meta.version, segment })
    assertSafeRelativePath(rel)
    const target = join(home, item.target.root, ...rel.split('/'))
    if (!isInside(home, target)) {
      throw new ProvisionError('invalid-option', `落盘目标跳出 home：${target}`)
    }

    const manifest: InstallManifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      name: meta.name,
      version: meta.version,
      dir: segment,
      ...(meta.integrity === undefined ? {} : { integrity: meta.integrity }),
      ...(meta.tarball === undefined ? {} : { tarball: meta.tarball }),
      ...(meta.entry === undefined ? {} : { entry: meta.entry }),
      installed_at: new Date(clock()).toISOString(),
      source: meta.source ?? 'installed',
      layout,
      ...(meta.entryDir === undefined ? {} : { entryDir: meta.entryDir }),
    }
    // The manifest is written into staging before the rename.
    await fs.writeFile(join(staging, INSTALL_MANIFEST_FILE), encodeInstallManifest(manifest))

    const handle = await lock.acquire(lockPath(home), { timeoutMs: LOCK_TIMEOUT_MS, staleMs: STALE_LOCK_MS })
    try {
      if (await exists(fs, target)) {
        const existing = await readManifestAt(target, item.kind)
        // Reuse only a manifest that describes *this* version; anything else is renamed aside.
        if (existing !== undefined && existing.version === meta.version) {
          // The staging tree this call just downloaded and verified is deleted in the `finally`, so
          // "same version" is not enough: the bytes ON DISK were never checked. When both sides carry
          // an integrity, a mismatch means the resident copy is not what this call verified — isolate
          // it and publish the verified staging instead of trusting the version string.
          if (meta.integrity !== undefined && existing.integrity !== undefined && existing.integrity !== meta.integrity) {
            logger.warn(
              `target 已存在但 install.json 的 integrity（${existing.integrity}）与本次校验值（${meta.integrity}）不符：隔离后重取（${target}）`,
            )
            await quarantine(target)
          } else {
            if (existing.integrity === undefined) {
              logger.warn(`unverifiable: ${target} 的 install.json 没有 integrity（旧形状或未校验来源）；按可用处理，不隔离`)
            }
            return resolvedOf(declared, target, existing)
          }
        } else {
          // Both branches are logged rather than renamed silently.
          logger.warn(
            existing === undefined
              ? `target 已存在但没有可用的 install.json：隔离后重取（${target}）`
              : `target 已存在但描述的是 ${existing.version}，期望 ${meta.version}：隔离后重取（${target}）`,
          )
          await quarantine(target)
        }
      }
      await fs.mkdir(dirname(target))
      try {
        await fs.rename(staging, target)
      } catch (error) {
        if ((error as { code?: string }).code === 'EXDEV') {
          throw new ProvisionError('publish/cross-device', `staging 与目标不在同一文件系统：${staging} → ${target}`)
        }
        throw error
      }
    } finally {
      handle.dispose()
    }
    return resolvedOf(declared, target, manifest)
  }

  const resolvedOf = (declared: DeclaredItem, target: string, manifest: InstallManifest): Resolved => {
    const entryDir = manifest.entryDir
    const dir = entryDir === undefined ? target : join(target, ...entryDir.split('/'))
    // Only an archive carries an executable, so only it contributes PATH.
    const pathEnv =
      manifest.entry === undefined || manifest.entryDir === undefined
        ? undefined
        : { PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}` }
    return {
      key: declared.key,
      name: manifest.name,
      version: manifest.version,
      dir: target,
      entryDir: dir,
      ...(manifest.integrity === undefined ? {} : { integrity: manifest.integrity }),
      source: manifest.source,
      ...(pathEnv === undefined ? {} : { env: pathEnv }),
    }
  }

  /** Set one terminal state and build its matching report entry. */
  const settle = (
    declared: DeclaredItem,
    started: number,
    kind: 'skipped' | 'failed',
    code: ProvisionCode,
    detail?: string,
  ): ProvisionReportEntry => {
    const extra = detail === undefined ? {} : { detail }
    const state: ResourceState = kind === 'skipped' ? { state: 'skipped', code, ...extra } : { state: 'failed', code, ...extra }
    putRow(declared, '', state)
    return entryOf(declared, { action: kind, source: 'managed', started, code, ...(detail === undefined ? {} : { reason: detail }) })
  }

  const ensureOne = async (
    declared: DeclaredItem,
    signal?: AbortSignal,
    offline = false,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<ProvisionReportEntry> => {
    const started = clock()
    const { item } = declared

    // Decisions made before any provider is consulted.
    if (readOnly !== undefined) return settle(declared, started, 'skipped', readOnly)
    if (unsupported !== undefined) return settle(declared, started, 'skipped', unsupported)
    if (item.schemaVersion > ITEM_SCHEMA_VERSION) {
      return settle(declared, started, 'skipped', 'unsupported-item-schema')
    }

    // A `need` this build could not read makes its dependents fail too.
    const unmetNeeds = (item.needs ?? []).filter(need => {
      const rowKey = itemRows.get(need)
      const state = rowKey === undefined ? undefined : rows.get(rowKey)?.state
      return state?.state === 'skipped' && state.code === 'unsupported-item-schema'
    })
    const missingNeeds = [...(item.needs ?? []).filter(need => !items.has(need)), ...unmetNeeds]
    if (missingNeeds.length > 0) {
      return settle(declared, started, 'failed', 'missing-need', missingNeeds.join(', '))
    }

    const found = lookup(item.kind)
    if (!('provider' in found)) {
      const code: ProvisionCode = found.code === 'unknown-provider' && declared.expectedProvider !== undefined ? 'provider/unavailable' : found.code
      return settle(declared, started, 'failed', code, code === 'provider/unavailable' ? `声明的 provider ${String(declared.expectedProvider)} 未注册` : undefined)
    }
    const provider = found.provider
    const ctx = contextOf(signal, item)

    let probed: ProbeResult
    try {
      probed = await provider.probe(item, ctx)
    } catch (error) {
      const { code, message } = reasonOf(error)
      return settle(declared, started, 'failed', code, message)
    }
    if (probed.found) {
      const version = probed.version ?? ''
      const state: ResourceState = {
        state: 'ready',
        handle: {
          id: item.id,
          key: declared.key,
          kind: item.kind,
          ...(probed.version === undefined ? {} : { version: probed.version }),
          source: probed.source,
          dir: probed.dir,
          env: probed.env ?? {},
        },
      }
      putRow(declared, version, state, probed.source)
      return entryOf(declared, {
        action: 'present',
        source: probed.source,
        started,
        ...(probed.version === undefined ? {} : { version: probed.version }),
      })
    }

    // Two policy skips: the auto-download gate and `--offline`.
    if (!autoDownload(item.kind)) return settle(declared, started, 'skipped', 'policy/download-disabled')
    if (offline) return settle(declared, started, 'skipped', 'policy/offline')

    const staging = stagingDir(home, item.id, (stagingSequence += 1))
    let published: Resolved | undefined
    const installCtx = {
      ...ctx,
      stage: async (): Promise<string> => {
        await fs.mkdir(staging)
        return staging
      },
      publish: async (dir: string, meta: PublishMeta): Promise<Resolved> => {
        const resolved = await publish(declared, dir, meta)
        published = resolved
        return resolved
      },
      ...(onProgress === undefined
        ? {}
        : {
            onProgress: (event: ProgressEvent): void => {
              try {
                onProgress(event)
              } catch (error) {
                logger.warn(`an onProgress callback threw: ${reasonOf(error).message}`)
              }
            },
          }),
    }
    try {
      await fs.mkdir(staging)
      const installed = await provider.install(item, installCtx)
      // The core fills `Resolved.key`.
      const resolved: Resolved = { ...installed, key: declared.key }
      published = resolved
      await provider.verify(item, resolved, ctx)
      const state: ResourceState = {
        state: 'ready',
        handle: {
          id: item.id,
          key: declared.key,
          kind: item.kind,
          version: resolved.version,
          source: resolved.source,
          dir: resolved.entryDir,
          env: resolved.env ?? {},
        },
      }
      putRow(declared, resolved.version, state, resolved.source)
      return entryOf(declared, { action: 'installed', source: resolved.source, started, version: resolved.version })
    } catch (error) {
      const { code, message } = reasonOf(error)
      // A published-but-unusable directory is quarantined, never deleted.
      if (published !== undefined) {
        try {
          await quarantineLocked(published.dir)
          logger.warn(`quarantined ${published.dir}: ${message}`)
        } catch (renameError) {
          logger.warn(`could not quarantine ${published.dir}: ${reasonOf(renameError).message}`)
        }
      }
      const state: ResourceState = { state: 'failed', code, detail: message }
      putRow(declared, published?.version ?? '', state)
      return entryOf(declared, {
        action: 'failed',
        source: published?.source ?? 'managed',
        started,
        ...(published === undefined ? {} : { version: published.version }),
        code,
        reason: message,
      })
    } finally {
      await fs.rm(staging, { recursive: true }).catch(() => undefined)
    }
  }

  const inflight = new Map<string, Promise<ProvisionReportEntry>>()

  const ensureOneDeduped = async (
    declared: DeclaredItem,
    signal?: AbortSignal,
    offline = false,
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<ProvisionReportEntry> => {
    const running = inflight.get(declared.item.id)
    if (running !== undefined) return running
    const promise = ensureOne(declared, signal, offline, onProgress)
    inflight.set(declared.item.id, promise)
    try {
      return await promise
    } finally {
      inflight.delete(declared.item.id)
    }
  }

  /** `{state:'pending'}` for an item that ran past the startup budget. */
  const putPending = (declared: DeclaredItem): void => {
    const current = itemRows.get(declared.item.id)
    const row = current === undefined ? undefined : rows.get(current)
    // A ready row is never downgraded by a later `pending` write.
    if (row?.state.state === 'ready') return
    putRow(declared, '', { state: 'pending', since: clock() })
  }

  /** Start every selected item and wait only for the shared startup budget. */
  const runEnsure = async (ensureOptions?: EnsureOptions): Promise<{ entries: ProvisionReportEntry[]; background: Promise<ProvisionReportEntry>[]; invalid: readonly string[] }> => {
    await checkHome()
    await Promise.all(pendingDeclared)
    pendingDeclared.length = 0
    const selection = select(ensureOptions?.only)
    const entries: ProvisionReportEntry[] = []
    for (const invalid of selection.invalid) {
      const separator = invalid.indexOf(':')
      const entry: ProvisionReportEntry = {
        plugin: separator > 0 ? invalid.slice(0, separator) : '',
        id: invalid,
        key: invalid,
        action: 'skipped',
        source: 'managed',
        ms: 0,
        code: 'invalid-option',
        reason: 'only 指向未声明的 item id',
      }
      entries.push(entry)
      notifySettled(ensureOptions, entry)
    }
    const background: Promise<ProvisionReportEntry>[] = []
    // `background` items are dispatched, not waited for.
    const blocking = new Set<string>()
    for (const declared of selection.ordered) {
      if (declared.item.startup !== 'background') blocking.add(declared.item.id)
    }
    let grew = true
    while (grew) {
      grew = false
      for (const declared of selection.ordered) {
        if (!blocking.has(declared.item.id)) continue
        for (const need of declared.item.needs ?? []) {
          if (items.has(need) && !blocking.has(need)) {
            blocking.add(need)
            grew = true
          }
        }
      }
    }

    // One budget for the whole startup critical path; a caller may override it for this call.
    const deadline = clock() + Math.max(0, ensureOptions?.deadlineMs ?? policy.deadlineMs ?? DEFAULT_DEADLINE_MS)
    let settled = 0
    for (const declared of selection.ordered) {
      const promise = ensureOneDeduped(declared, ensureOptions?.signal, ensureOptions?.offline === true, ensureOptions?.onProgress)
      if (!blocking.has(declared.item.id)) {
        // Dispatched, not awaited: mark it `pending` and spend no budget on it.
        putPending(declared)
        background.push(promise)
        // The real handler is installed in `ensure()` only after `await persistStatus()`; a rejection
        // inside that window would be an unhandledRejection (FATAL on a strict host). This no-op
        // catch claims the rejection now — `ensure()`'s `.catch` still does the real work.
        void promise.catch(() => undefined)
        continue
      }
      let done = false
      const tracked = promise.then(
        entry => {
          done = true
          return entry
        },
        (error: unknown) => {
          done = true
          throw error
        },
      )
      const remaining = deadline - clock()
      const entry = remaining <= 0 ? undefined : await Promise.race([tracked, delay(remaining)])
      if (entry === undefined) {
        // Only a genuinely unfinished item becomes `pending`.
        if (!done) putPending(declared)
        background.push(tracked)
        continue
      }
      entries.push(entry)
      notifySettled(ensureOptions, entry)
      settled += 1
    }
    // One read-modify-write for the whole batch.
    if (settled > 0 && readOnly === undefined) await persistStatus(fs, lock, home, statusRows(), logger)
    return { entries, background, invalid: selection.invalid }
  }

  /** Whether a recorded version still fits this item's range. */
  const recordSatisfies = (declared: DeclaredItem, version: string): boolean => {
    const range = declared.identity?.range
    if (range === undefined) return true
    // A recorded value that is not a semver cannot be judged, so the record is kept.
    if (parseVersion(version) === undefined) return true
    try {
      return satisfiesRange(version, range)
    } catch {
      // An out-of-subset range cannot be judged: keep the record rather than guessing.
      return true
    }
  }

  /** Hand one settled item to the caller's callback; a throwing callback is logged, not fatal. */
  const notifySettled = (options: EnsureOptions | undefined, entry: ProvisionReportEntry): void => {
    const callback = options?.onSettled
    if (callback === undefined) return
    try {
      callback(entry)
    } catch (error) {
      logger.warn(`an onSettled callback threw: ${reasonOf(error).message}`)
    }
  }

  /** Persisted resolution records by key; newest `updated_at` wins. */
  const readRecords = async (): Promise<Map<string, { readonly version: string; readonly source?: ResourceSource; readonly updatedAt: number }>> => {
    const map = new Map<string, { version: string; source?: ResourceSource; updatedAt: number }>()
    try {
      const read = await readStatus(fs, home)
      if (read.kind !== 'ok') return map
      for (const row of read.rows) {
        if (row.version === '') continue
        const previous = map.get(row.key)
        if (previous !== undefined && previous.updatedAt >= row.updated_at) continue
        map.set(row.key, {
          version: row.version,
          ...(row.source === undefined ? {} : { source: row.source }),
          updatedAt: row.updated_at,
        })
      }
    } catch {
      // No readable records is not an error; `plan()` falls back to probing.
    }
    return map
  }

  const plan = async (planOptions?: PlanOptions): Promise<Plan> => {
    await checkHome()
    await Promise.all(pendingDeclared)
    const selection = select(planOptions?.only)
    const entries: PlanEntry[] = []
    for (const invalid of selection.invalid) entries.push({ key: invalid, action: 'unknown' })
    // With a resolution record the plan reuses its version with no network.
    const records = await readRecords()
    for (const declared of selection.ordered) {
      if (unsupported !== undefined) {
        entries.push({ key: declared.key, action: 'skip' })
        continue
      }
      const found = lookup(declared.item.kind)
      if (!('provider' in found)) {
        entries.push({ key: declared.key, action: 'unknown' })
        continue
      }
      let probed: ProbeResult | undefined
      try {
        probed = await found.provider.probe(declared.item, contextOf(undefined, declared.item))
      } catch {
        probed = undefined // a probe that cannot answer is "unknown", not a failed plan
      }
      if (probed?.found === true) {
        entries.push({
          key: declared.key,
          action: 'present',
          ...(probed.version === undefined ? {} : { version: probed.version }),
          source: probed.source,
        })
        continue
      }
      // The provider's pure plan; consulted only when the record cannot answer.
      let planned: ProviderPlan | undefined
      try {
        planned = await found.provider.plan(declared.item, contextOf(undefined, declared.item))
      } catch {
        planned = undefined // a provider that cannot plan does not fail the plan
      }
      const plannedUrls = planned?.urls === undefined || planned.urls.length === 0 ? undefined : planned.urls

      const record = records.get(declared.key)
      // A record is filtered by this item's range before it is reused.
      if (record !== undefined && recordSatisfies(declared, record.version)) {
        entries.push({
          key: declared.key,
          action: 'install',
          version: record.version,
          ...(record.source === undefined ? {} : { source: record.source }),
          ...(plannedUrls === undefined ? {} : { urls: plannedUrls }),
        })
        continue
      }
      // Only an explicit `install` counts as an answer; anything else leaves the entry `unknown`.
      if (planned?.action === 'install' && planned.version !== undefined) {
        entries.push({
          key: declared.key,
          action: 'install',
          version: planned.version,
          ...(plannedUrls === undefined ? {} : { urls: plannedUrls }),
        })
        continue
      }
      entries.push({ key: declared.key, action: 'unknown' })
    }
    return { entries, offline: planOptions?.offline === true }
  }

  const ensure = async (ensureOptions?: EnsureOptions): Promise<ProvisionReport> => {
    const { entries, background } = await runEnsure(ensureOptions)
    for (const entry of entries) emit({ type: 'report', key: entry.key, entry })
    // Late items report out of band; `resolve()` flips to ready as their `onSettled` fires.
    for (const promise of background) {
      void promise
        .then(async entry => {
          emit({ type: 'report', key: entry.key, entry })
          notifySettled(ensureOptions, entry)
          if (readOnly === undefined) await persistStatus(fs, lock, home, statusRows(), logger)
        })
        .catch((error: unknown) => {
          logger.warn(`后台预装失败：${reasonOf(error).message}`)
        })
    }
    return { entries, ok: entries.every(entry => entry.action !== 'failed') }
  }

  const resolve = (itemId: string): ResourceState => {
    if (!items.has(itemId)) return { state: 'missing' }
    const key = itemRows.get(itemId)
    if (key === undefined) return { state: 'missing' }
    const row = rows.get(key)
    return row?.state ?? { state: 'missing' }
  }

  const status = (): readonly ProvisionStatus[] =>
    [...rows.values()].sort((a, b) => (a.key === b.key ? a.version.localeCompare(b.version) : a.key.localeCompare(b.key)))

  const repair = async (itemId: string): Promise<ProvisionReport> => {
    await checkHome()
    await Promise.all(pendingDeclared)
    pendingDeclared.length = 0
    const declared = items.get(itemId)
    if (declared === undefined) {
      return { entries: [], ok: false }
    }
    const entry = await ensureOneDeduped(declared)
    emit({ type: 'report', key: entry.key, entry })
    if (readOnly === undefined) await persistStatus(fs, lock, home, statusRows(), logger)
    return { entries: [entry], ok: entry.action !== 'failed' }
  }

  const experimental = (): ProvisionerExperimental => ({
    // `prune` only warns and makes no changes.
    prune: () => {
      logger.warn('prune: 回收（prune/GC/配额）尚未实现，本次未做任何事')
      return Promise.resolve({ moved: [], skipped: [], movedBytes: 0 })
    },
    on: (event, listener) => {
      const entry = { event, listener }
      listeners.add(entry)
      return { dispose: () => listeners.delete(entry) }
    },
  })

  /** Abort everything in flight and drop listeners; the instance is not reused afterwards. */
  const dispose = (): void => {
    shutdown.abort()
    listeners.clear()
  }

  return { register, declare, plan, ensure, resolve, status, repair, experimental, dispose }
}
