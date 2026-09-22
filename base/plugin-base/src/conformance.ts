/**
 * Provider conformance kit run against one provider.
 * @module conformance
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { findFrameworkImports } from './artifact.js'
import { ProvisionError } from './errors.js'
import { defaultFs } from './fs.js'
import { isInside, lockPath, tempRoot } from './layout.js'
import { INSTALL_MANIFEST_FILE } from './manifest.js'
import { BUILTIN_KINDS, isNamespacedKind } from './lint.js'
import { defaultLock } from './lock.js'
import { createProvisioner } from './provisioner.js'
import type {
  InstallContext,
  Manifest,
  PlanAction,
  ProvisionFs,
  ProvisionItem,
  ProvisionLock,
  ProvisionLogger,
  ProvisionPolicy,
  ProvisionReport,
  ProvisionReportEntry,
  Provider,
  ProviderContext,
  Provisioner,
  Resolved,
  ResourceSource,
} from './types.js'

export type ConformanceCheckStatus = 'pass' | 'fail' | 'skip'

export interface ConformanceCheck {
  /** A stable rule id. */
  readonly id: string
  readonly status: ConformanceCheckStatus
  readonly message: string
}

export interface ConformanceReport {
  readonly provider: string
  readonly ok: boolean
  readonly checks: readonly ConformanceCheck[]
}

/** Version/segment the kit feeds to `targetDir` when the caller gives none. */
export interface ConformanceRef {
  readonly name?: string
  readonly version?: string
  readonly segment?: string
}

export interface ConformanceOptions {
  readonly provider: Provider
  /** At least one item the provider claims, and that is genuinely missing in a fresh home. */
  readonly items: readonly ProvisionItem[]
  /** The provider's npm package name; asserted against `provider.id` when given. */
  readonly packageName?: string
  /** The provider's own module (path or specifier); when given, the kit `import()`s it. */
  readonly providerEntry?: string
  /** Server-side artifacts to scan for a runtime framework import. */
  readonly artifacts?: readonly string[]
  /** Client-side artifacts that must not mention the framework at all. */
  readonly clientArtifacts?: readonly string[]
  /** Injected downloader. */
  readonly fetch?: typeof fetch
  /** Data-plane seam to wrap; defaults to {@link defaultFs}. */
  readonly fs?: ProvisionFs
  /** Synchronisation seam to wrap; defaults to {@link defaultLock}. */
  readonly lock?: ProvisionLock
  readonly clock?: () => number
  readonly policy?: ProvisionPolicy
  readonly logger?: ProvisionLogger
  /** A caller-owned home; when omitted the kit creates and removes a temp one. */
  readonly home?: string
  /** Keep the temp home for inspection. */
  readonly keepHome?: boolean
  /** Run the install round-trip (needs a working downloader). Default `true`. */
  readonly install?: boolean
  /** Set for kinds that own their layout and skip `publish()`. */
  readonly bypassPublish?: boolean
  readonly ref?: ConformanceRef
}

const SILENT_LOGGER: ProvisionLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const PLAN_ACTIONS: readonly PlanAction[] = ['present', 'install', 'skip', 'unknown']
const SOURCES: readonly ResourceSource[] = ['resolved', 'managed', 'installed', 'system', 'explicit']
/** The allowed resource sources per kind. */
const SOURCES_BY_KIND: Readonly<Record<string, readonly ResourceSource[]>> = {
  'npm-package': ['resolved', 'managed', 'installed'],
  'binary-archive': ['explicit', 'managed', 'system', 'installed'],
}

/** The check ids in report order; a short-circuit can still report the tail as skipped. */
const CHECK_ORDER: readonly string[] = [
  'conformance/kinds',
  'conformance/id-is-package-name',
  'conformance/identify-shape',
  'conformance/probe-pure',
  'conformance/plan-pure',
  'conformance/target-dir-safe',
  'conformance/verify-rejects-missing',
  'conformance/install-landing',
  'conformance/install-idempotent',
  'conformance/install-half-failure',
  'conformance/core-rejects-bad-target-dir',
  'conformance/core-quarantines-bad-copy',
  'conformance/report-completeness',
  'conformance/register-conflict',
  'conformance/unknown-provider',
  'conformance/provider-importable',
  'conformance/provider-artifact-type-only',
  'conformance/client-artifact-clean',
  'conformance/recycle-semantics',
]

interface Mutation {
  readonly op: string
  readonly path: string
  readonly to?: string
}

interface Recorder {
  readonly fs: ProvisionFs
  readonly mutations: Mutation[]
  /** Only mutations between `record(true)` and `record(false)` are kept. */
  record(on: boolean): void
  reset(): void
}

function recordingFs(inner: ProvisionFs): Recorder {
  const mutations: Mutation[] = []
  // Recording is on by default.
  let recording = true
  const note = (op: string, path: string, to?: string): void => {
    if (recording) mutations.push(to === undefined ? { op, path } : { op, path, to })
  }
  const fs: ProvisionFs = {
    readFile: path => inner.readFile(path),
    readdir: path => inner.readdir(path),
    stat: path => inner.stat(path),
    async writeFile(path, data) {
      note('writeFile', path)
      await inner.writeFile(path, data)
    },
    async atomicWrite(path, data) {
      note('atomicWrite', path)
      await inner.atomicWrite(path, data)
    },
    async rename(from, to) {
      note('rename', from, to)
      await inner.rename(from, to)
    },
    async mkdir(path) {
      note('mkdir', path)
      await inner.mkdir(path)
    },
    async rm(path, options) {
      note('rm', path)
      await inner.rm(path, options)
    },
    async symlink(target, path) {
      note('symlink', path)
      await inner.symlink(target, path)
    },
    readlink: path => inner.readlink(path),
    async copyFile(from, to) {
      note('copyFile', to)
      await inner.copyFile(from, to)
    },
    async chmod(path, mode) {
      note('chmod', path)
      await inner.chmod(path, mode)
    },
  }
  return {
    fs,
    mutations,
    record: on => {
      recording = on
    },
    reset: () => {
      mutations.length = 0
    },
  }
}

interface LockRecorder {
  readonly lock: ProvisionLock
  readonly acquisitions: string[]
}

function recordingLock(inner: ProvisionLock): LockRecorder {
  const acquisitions: string[] = []
  return {
    acquisitions,
    lock: {
      async acquire(path, options) {
        acquisitions.push(path)
        return inner.acquire(path, options)
      },
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function check(id: string, status: ConformanceCheckStatus, message: string): ConformanceCheck {
  return { id, status, message }
}

/** Does a published version directory exist anywhere under `root`? */
async function containsInstallManifest(fs: ProvisionFs, root: string): Promise<boolean> {
  const info = await fs.stat(root).catch(() => undefined)
  if (info === undefined || !info.isDirectory) return false
  const entries = await fs.readdir(root).catch(() => [] as readonly string[])
  for (const entry of entries) {
    if (entry === INSTALL_MANIFEST_FILE) return true
    if (await containsInstallManifest(fs, join(root, entry))) return true
  }
  return false
}

/** The resource name a provider assigns, or the item id when `identify` cannot answer. */
function safeName(provider: Provider, item: ProvisionItem): string {
  try {
    const identity = provider.identify(item)
    return typeof identity.name === 'string' && identity.name !== '' ? identity.name : item.id
  } catch {
    return item.id
  }
}

/** Run the whole kit against one provider; every outcome is a {@link ConformanceCheck}. */
export async function runProviderConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const provider = options.provider
  const items = [...options.items]
  const innerFs = options.fs ?? defaultFs()
  const logger = options.logger ?? SILENT_LOGGER
  const policy = options.policy ?? {}
  const clock = options.clock ?? Date.now
  const fetchImpl = options.fetch ?? globalThis.fetch
  const recorder = recordingFs(innerFs)
  const locks = recordingLock(options.lock ?? defaultLock({ clock }))
  const created = options.home === undefined
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'envinit-conformance-')))
  const checks: ConformanceCheck[] = []
  const push = (entry: ConformanceCheck): void => {
    checks.push(entry)
  }
  const skipRestFrom = (id: string, reason: string): void => {
    const start = CHECK_ORDER.indexOf(id)
    for (const rest of CHECK_ORDER.slice(start + 1)) push(check(rest, 'skip', reason))
  }

  const providerContext = (): ProviderContext => ({
    home,
    logger,
    policy,
    fs: recorder.fs,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  })

  try {
    // ── registration contract ────────────────────────────────────────────────
    const kindProblems: string[] = []
    if (typeof provider.id !== 'string' || provider.id === '') kindProblems.push('provider.id 为空')
    if (!Array.isArray(provider.kinds) || provider.kinds.length === 0) {
      kindProblems.push('provider.kinds 为空')
    } else {
      const seen = new Set<string>()
      for (const kind of provider.kinds) {
        if (typeof kind !== 'string' || kind === '') {
          kindProblems.push('kinds 含非字符串项')
          continue
        }
        if (seen.has(kind)) kindProblems.push(`kind 重复：${kind}`)
        seen.add(kind)
        if (!BUILTIN_KINDS.includes(kind) && !isNamespacedKind(kind)) {
          kindProblems.push(`第三方 kind 必须带 @scope/ 或 plugin: 前缀：${kind}`)
        }
      }
    }
    push(
      check(
        'conformance/kinds',
        kindProblems.length === 0 ? 'pass' : 'fail',
        kindProblems.length === 0 ? `id=${provider.id}；kinds=${provider.kinds.join(', ')}` : kindProblems.join('；'),
      ),
    )
    if (kindProblems.length > 0) {
      skipRestFrom('conformance/kinds', 'conformance/kinds 未通过，后续检查跳过')
      return finish()
    }

    push(
      options.packageName === undefined
        ? check('conformance/id-is-package-name', 'skip', '未提供 packageName')
        : options.packageName === provider.id
          ? check('conformance/id-is-package-name', 'pass', `id = ${provider.id}`)
          : check(
              'conformance/id-is-package-name',
              'fail',
              `provider.id (${provider.id}) 必须等于它的 npm 包名 (${options.packageName})`,
            ),
    )

    const identityProblems: string[] = []
    for (const item of items) {
      try {
        const identity = provider.identify(item)
        if (typeof identity.name !== 'string' || identity.name === '') {
          identityProblems.push(`${item.id}: identify().name 为空`)
        }
        if (identity.range !== undefined && typeof identity.range !== 'string') {
          identityProblems.push(`${item.id}: identify().range 必须是字符串`)
        }
        if ('key' in (identity as unknown as Record<string, unknown>)) {
          identityProblems.push(`${item.id}: identify() 不得自带 key（键归核心）`)
        }
      } catch (error) {
        identityProblems.push(`${item.id}: identify() 抛错：${messageOf(error)}`)
      }
    }
    push(
      check(
        'conformance/identify-shape',
        identityProblems.length === 0 ? 'pass' : 'fail',
        identityProblems.length === 0 ? `${String(items.length)} 个 item 的资源身份可用` : identityProblems.join('；'),
      ),
    )

    // ── probe / plan purity ──────────────────────────────────────────────────
    let networkCalls = 0
    const purityFetch = (async () => {
      networkCalls += 1
      throw new Error('conformance: purity checks forbid the network')
    }) as unknown as typeof fetch
    const purityContext: ProviderContext = { home, logger, policy, fs: recorder.fs, fetch: purityFetch }

    const probeProblems: string[] = []
    for (const item of items) {
      recorder.reset()
      networkCalls = 0
      try {
        const first = await provider.probe(item, purityContext)
        const second = await provider.probe(item, purityContext)
        if (recorder.mutations.length > 0) probeProblems.push(`${item.id}: probe 改动了磁盘（${recorder.mutations[0]?.op ?? '?'}）`)
        if (networkCalls > 0) probeProblems.push(`${item.id}: probe 尝试联网`)
        if (!isDeepStrictEqual(first, second)) probeProblems.push(`${item.id}: 两次 probe 结果不一致`)
      } catch (error) {
        probeProblems.push(`${item.id}: probe 抛错：${messageOf(error)}`)
      }
    }
    push(
      check(
        'conformance/probe-pure',
        probeProblems.length === 0 ? 'pass' : 'fail',
        probeProblems.length === 0 ? 'probe 不改盘、不联网、可重复' : probeProblems.join('；'),
      ),
    )

    const planProblems: string[] = []
    for (const item of items) {
      recorder.reset()
      networkCalls = 0
      try {
        const first = await provider.plan(item, purityContext)
        const second = await provider.plan(item, purityContext)
        if (!PLAN_ACTIONS.includes(first.action)) planProblems.push(`${item.id}: plan().action 非法：${String(first.action)}`)
        if (recorder.mutations.length > 0) planProblems.push(`${item.id}: plan 改动了磁盘（${recorder.mutations[0]?.op ?? '?'}）`)
        if (networkCalls > 0) planProblems.push(`${item.id}: plan 尝试联网`)
        if (!isDeepStrictEqual(first, second)) planProblems.push(`${item.id}: 两次 plan 结果不一致`)
      } catch (error) {
        planProblems.push(`${item.id}: plan 抛错：${messageOf(error)}`)
      }
    }
    push(
      check(
        'conformance/plan-pure',
        planProblems.length === 0 ? 'pass' : 'fail',
        planProblems.length === 0 ? 'plan 是纯函数且可重复' : planProblems.join('；'),
      ),
    )

    // ── targetDir safety ─────────────────────────────────────────────────────
    const targetProblems: string[] = []
    for (const item of items) {
      const ref = {
        name: options.ref?.name ?? safeName(provider, item),
        version: options.ref?.version ?? '0.0.0',
        segment: options.ref?.segment ?? '0.0.0',
      }
      try {
        const raw = provider.targetDir(item, ref)
        if (typeof raw !== 'string' || raw === '') {
          targetProblems.push(`${item.id}: targetDir() 必须返回非空字符串`)
          continue
        }
        const normalized = raw.replaceAll('\\', '/')
        if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
          targetProblems.push(`${item.id}: targetDir() 不得是绝对路径：${raw}`)
          continue
        }
        const segments = normalized.split('/')
        if (segments.includes('..')) {
          targetProblems.push(`${item.id}: targetDir() 含 ..：${raw}`)
          continue
        }
        const root = resolve(home, item.target.root)
        if (!isInside(root, resolve(root, ...segments))) {
          targetProblems.push(`${item.id}: targetDir() 跳出 target.root：${raw}`)
        }
      } catch (error) {
        targetProblems.push(`${item.id}: targetDir() 抛错：${messageOf(error)}`)
      }
    }
    push(
      check(
        'conformance/target-dir-safe',
        targetProblems.length === 0 ? 'pass' : 'fail',
        targetProblems.length === 0 ? 'targetDir() 是 root 下的安全相对路径' : targetProblems.join('；'),
      ),
    )

    // ── verify on a missing directory ────────────────────────────────────────
    const verifyProblems: string[] = []
    for (const [index, item] of items.entries()) {
      recorder.reset()
      const name = safeName(provider, item)
      const missing = join(home, 'conformance-missing', `${String(index)}-${item.kind.replace(/[^a-zA-Z0-9._-]/g, '_')}`)
      const resolved: Resolved = {
        key: `${item.kind}+${name}`,
        name,
        version: '0.0.0',
        dir: missing,
        entryDir: join(missing, 'entry'),
        source: 'installed',
      }
      try {
        await provider.verify(item, resolved, providerContext())
        verifyProblems.push(`${item.id}: verify 接受了不存在的目录 ${missing}`)
      } catch {
        const first = recorder.mutations[0]
        if (first !== undefined) verifyProblems.push(`${item.id}: verify 改动了磁盘（${first.op} ${first.path}）`)
      }
    }
    push(
      check(
        'conformance/verify-rejects-missing',
        verifyProblems.length === 0 ? 'pass' : 'fail',
        verifyProblems.length === 0 ? 'verify 拒绝坏副本且只读' : verifyProblems.join('；'),
      ),
    )

    // ── install round-trip ───────────────────────────────────────────────────
    if (options.install === false) {
      push(check('conformance/install-landing', 'skip', 'install === false：跳过落盘检查'))
      push(check('conformance/install-idempotent', 'skip', 'install === false：跳过幂等检查'))
      push(check('conformance/install-half-failure', 'skip', 'install === false：跳过故障注入'))
    } else {
      const targetHome = join(home, 'round-trip')
      await innerFs.mkdir(targetHome)
      const roundTrip = await installRoundTrip(targetHome)
      push(roundTrip.landing)
      push(roundTrip.idempotent)
      push(await halfFailure())
    }

    push(await rejectsHostileTargetDir())
    push(await quarantinesBadCopy())
    push(await reportCompleteness())
    push(await conflictOutcome())
    push(await unknownOutcome())
    push(await providerImportable())
    push(await artifactCheck(options.artifacts, false))
    push(await artifactCheck(options.clientArtifacts, true))
    push(await recycleSemantics())

    return finish()
  } finally {
    if (created && options.keepHome !== true) await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }

  // ── run-scoped helpers ─────────────────────────────────────────────────────
  function finish(): ConformanceReport {
    return { provider: provider.id, ok: checks.every(entry => entry.status !== 'fail'), checks }
  }

  function provisionerOptions(targetHome: string): Parameters<typeof createProvisioner>[0] {
    return {
      home: targetHome,
      logger,
      fs: recorder.fs,
      lock: locks.lock,
      clock,
      policy,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    }
  }

  function pluginName(): string {
    const first = items[0]
    if (first === undefined) return 'conformance'
    const colon = first.id.indexOf(':')
    return colon > 0 ? first.id.slice(0, colon) : 'conformance'
  }

  function declareAll(instance: Provisioner): void {
    const manifest: Manifest = { plugin: pluginName(), items }
    instance.declare(manifest)
  }

  async function installRoundTrip(targetHome: string): Promise<{ landing: ConformanceCheck; idempotent: ConformanceCheck }> {
    locks.acquisitions.length = 0
    recorder.reset()
    const violations: string[] = []

    const wrapped: Provider = {
      ...provider,
      async install(item: ProvisionItem, ctx: InstallContext): Promise<Resolved> {
        recorder.reset()
        recorder.record(true)
        try {
          return await provider.install(item, ctx)
        } finally {
          recorder.record(false)
          const root = resolve(targetHome, item.target.root)
          const staging = resolve(tempRoot(targetHome))
          for (const mutation of recorder.mutations) {
            const inStaging = isInside(staging, mutation.path)
            const inTarget = isInside(root, mutation.path)
            const renamedInto =
              mutation.op === 'rename' && mutation.to !== undefined && isInside(staging, mutation.path) && isInside(root, resolve(mutation.to))
            if (!inStaging && !inTarget && !renamedInto) {
              violations.push(`${item.id}: install 在 ${mutation.op} 时写到 ${mutation.path}`)
              break
            }
          }
        }
      },
    }

    const instance = createProvisioner(provisionerOptions(targetHome))
    instance.register(wrapped)
    declareAll(instance)

    let first: ProvisionReport
    try {
      first = await instance.ensure()
    } catch (error) {
      const reason = `ensure 抛错：${messageOf(error)}`
      return { landing: check('conformance/install-landing', 'fail', reason), idempotent: check('conformance/install-idempotent', 'fail', reason) }
    }

    const ready = first.entries.filter(entry => entry.action === 'installed' || entry.action === 'present')
    if (ready.length !== items.length) {
      const detail = first.entries.map(entry => `${entry.id}=${entry.action}${entry.code === undefined ? '' : `(${entry.code})`}`).join(', ')
      violations.push(`ensure 未能就绪全部 item：${detail}`)
    }
    if (!first.entries.some(entry => entry.action === 'installed')) {
      violations.push('ensure 没有发生任何安装（item 在空 home 里就被判定为已就绪）；落盘路径无法验证')
    }
    if (options.bypassPublish !== true && !locks.acquisitions.includes(lockPath(targetHome))) {
      violations.push('install 未经过 ctx.publish()：整个安装期没有取得发布锁')
    }
    const landing = check(
      'conformance/install-landing',
      violations.length === 0 ? 'pass' : 'fail',
      violations.length === 0 ? 'install 只经 staging / target.root 落盘，且经 ctx.publish() 取锁' : violations.join('；'),
    )

    const idemProblems: string[] = []
    try {
      const second = await instance.ensure()
      for (const entry of second.entries) {
        if (entry.action !== 'present') {
          idemProblems.push(`${entry.id}: 第二次 ensure 是 ${entry.action}${entry.code === undefined ? '' : `(${entry.code})`}`)
        }
      }
      for (const item of items) {
        const state = instance.resolve(item.id)
        if (state.state !== 'ready') {
          idemProblems.push(`${item.id}: resolve() 是 ${state.state}`)
        } else {
          const allowed = SOURCES_BY_KIND[item.kind] ?? SOURCES
          if (!allowed.includes(state.handle.source)) {
            idemProblems.push(`${item.id}: kind ${item.kind} 的 source 只能是 ${allowed.join(' / ')}，得到 ${String(state.handle.source)}`)
          }
        }
      }
    } catch (error) {
      idemProblems.push(`第二次 ensure 抛错：${messageOf(error)}`)
    }
    const idempotent = check(
      'conformance/install-idempotent',
      idemProblems.length === 0 ? 'pass' : 'fail',
      idemProblems.length === 0 ? '第二次 ensure 全部 present，resolve() 就绪' : idemProblems.join('；'),
    )
    return { landing, idempotent }
  }

  /** Injects a corrupt download body and asserts no usable directory is left behind. */
  async function halfFailure(): Promise<ConformanceCheck> {
    const targetHome = join(home, 'half-failure')
    await innerFs.mkdir(targetHome)
    const corrupt = (async () => new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]), { status: 200 })) as unknown as typeof fetch
    const instance = createProvisioner({
      home: targetHome,
      logger,
      fs: innerFs,
      lock: locks.lock,
      clock,
      policy,
      fetch: corrupt,
    })
    instance.register(provider)
    declareAll(instance)

    let report: ProvisionReport
    try {
      report = await instance.ensure()
    } catch (error) {
      return check('conformance/install-half-failure', 'fail', `坏体注入时 ensure 抛错：${messageOf(error)}`)
    }
    const failed = report.entries.filter(entry => entry.action === 'failed')
    if (failed.length === 0) {
      return check('conformance/install-half-failure', 'skip', '坏体注入后没有失败项：该 provider 不依赖下载，注入不适用')
    }
    const problems: string[] = []
    for (const entry of failed) {
      const item = items.find(candidate => candidate.id === entry.id)
      if (item === undefined) continue
      const state = instance.resolve(item.id)
      if (state.state === 'ready') problems.push(`${item.id}: 半截失败后 resolve() 仍报 ready`)
      if (options.bypassPublish !== true && (await containsInstallManifest(innerFs, join(targetHome, item.target.root)))) {
        problems.push(`${item.id}: 半截失败后 target.root 里留下了已发布的目录`)
      }
    }
    return check(
      'conformance/install-half-failure',
      problems.length === 0 ? 'pass' : 'fail',
      problems.length === 0 ? `${String(failed.length)} 项坏体失败后没有留下可用目录` : problems.join('；'),
    )
  }

  async function conflictOutcome(): Promise<ConformanceCheck> {
    const clone: Provider = { ...provider, id: `${provider.id}-conformance-clone` }
    const orders: readonly (readonly Provider[])[] = [
      [provider, clone],
      [clone, provider],
    ]
    const { kindProviders: _lifted, ...rest } = policy
    const problems: string[] = []
    for (const [index, order] of orders.entries()) {
      const targetHome = join(home, `conflict-${String(index)}`)
      await innerFs.mkdir(targetHome)
      const instance = createProvisioner({
        home: targetHome,
        logger,
        fs: recorder.fs,
        lock: locks.lock,
        clock,
        policy: rest,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
      })
      for (const candidate of order) instance.register(candidate)
      declareAll(instance)
      try {
        const report = await instance.ensure()
        for (const entry of report.entries) {
          if (entry.code !== 'provider/conflict') {
            problems.push(`注册顺序 ${String(index)}：${entry.id} 得到 ${entry.action}/${String(entry.code)}，应为 provider/conflict`)
          }
        }
      } catch (error) {
        problems.push(`注册顺序 ${String(index)}：ensure 抛错：${messageOf(error)}`)
      }
    }
    return check(
      'conformance/register-conflict',
      problems.length === 0 ? 'pass' : 'fail',
      problems.length === 0 ? '同 kind 冲突 fail-closed，且与注册顺序无关' : problems.join('；'),
    )
  }

  /** A shim provider that publishes whatever the core asks, for the core-level checks. */
  function shimPipe(overrides: Partial<Provider>): Provider {
    return {
      ...provider,
      probe: async () => ({ found: false }),
      plan: () => ({ action: 'install' }),
      install: async (_item, ctx) => ctx.publish(await ctx.stage(), { name: 'shim', version: '1.0.0' }),
      verify: async () => undefined,
      ...overrides,
    }
  }

  /** Any `install.json` left under `root` within `depth` levels — i.e. a published version directory. */
  async function findManifests(fs_: ProvisionFs, root: string, depth: number): Promise<readonly string[]> {
    if (depth < 0) return []
    const found: string[] = []
    const entries = await fs_.readdir(root).catch(() => [] as string[])
    for (const entry of entries) {
      const path = join(root, entry)
      if (await fs_.stat(join(path, INSTALL_MANIFEST_FILE)).then(info => info !== undefined).catch(() => false)) {
        found.push(path)
        continue
      }
      found.push(...(await findManifests(fs_, path, depth - 1)))
    }
    return found
  }

  async function withShim(shim: Provider, home_: string): Promise<ProvisionReportEntry | undefined> {
    const instance = createProvisioner({ home: home_, logger, fs: recorder.fs, lock: locks.lock, clock })
    instance.register(shim)
    for (const item of items) instance.declare({ plugin: 'conformance', items: [item] })
    const report = await instance.ensure()
    return report.entries.find(entry => entry.plugin === 'conformance')
  }

  async function rejectsHostileTargetDir(): Promise<ConformanceCheck> {
    const targetHome = join(home, 'hostile-target')
    await innerFs.mkdir(targetHome)
    try {
      const entry = await withShim(shimPipe({ targetDir: () => '../../escape' }), targetHome)
      const ok = entry?.code === 'invalid-option'
      return check(
        'conformance/core-rejects-bad-target-dir',
        ok ? 'pass' : 'fail',
        ok ? '核心拒绝跳出 target.root 的 targetDir' : `targetDir 返回 ../../escape 时得到 ${String(entry?.action)}/${String(entry?.code)}`,
      )
    } catch (error) {
      return check('conformance/core-rejects-bad-target-dir', 'fail', `ensure 抛错：${messageOf(error)}`)
    }
  }

  async function quarantinesBadCopy(): Promise<ConformanceCheck> {
    const targetHome = join(home, 'quarantine')
    await innerFs.mkdir(targetHome)
    try {
      const entry = await withShim(
        shimPipe({ verify: async () => Promise.reject(new ProvisionError('verify/failed', 'kit: verify 必定失败')) }),
        targetHome,
      )
      const failed = entry?.code === 'verify/failed'
      const quarantined = await innerFs.readdir(join(targetHome, '.envinit', '.quarantine')).catch(() => [] as string[])
      // No version directory with a manifest may remain under the item's target root.
      const left = await findManifests(innerFs, join(targetHome, items[0]?.target.root ?? 'runtime'), 2)
      const ok = failed && quarantined.length > 0 && left.length === 0
      return check(
        'conformance/core-quarantines-bad-copy',
        ok ? 'pass' : 'fail',
        ok ? 'verify 失败 ⇒ 核心把已发布目录改名进 .quarantine' : `verify 失败后：code=${String(entry?.code)}，隔离 ${String(quarantined.length)} 个，目标根仍留 ${String(left.length)} 个版本目录`,
      )
    } catch (error) {
      return check('conformance/core-quarantines-bad-copy', 'fail', `ensure 抛错：${messageOf(error)}`)
    }
  }

  async function reportCompleteness(): Promise<ConformanceCheck> {
    const targetHome = join(home, 'report')
    await innerFs.mkdir(targetHome)
    try {
      const instance = createProvisioner({ home: targetHome, logger, fs: recorder.fs, lock: locks.lock, clock, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) })
      instance.register(provider)
      for (const item of items) instance.declare({ plugin: 'conformance', items: [item] })
      const report = await instance.ensure()
      const problems: string[] = []
      for (const entry of report.entries) {
        if (entry.source === undefined) problems.push(`${entry.id}: source 为空`)
        if ((entry.action === 'failed' || entry.action === 'skipped') && entry.code === undefined) {
          problems.push(`${entry.id}: ${entry.action} 没有 code`)
        }
      }
      return check(
        'conformance/report-completeness',
        problems.length === 0 ? 'pass' : 'fail',
        problems.length === 0 ? '每行都带 source，失败/跳过都带 code' : problems.join('；'),
      )
    } catch (error) {
      return check('conformance/report-completeness', 'fail', `ensure 抛错：${messageOf(error)}`)
    }
  }

  async function providerImportable(): Promise<ConformanceCheck> {
    const entry = options.providerEntry
    if (entry === undefined || entry === '') {
      return check('conformance/provider-importable', 'skip', '未提供 providerEntry：无法验证 import() 成功')
    }
    try {
      const specifier = entry.startsWith('/') || entry.startsWith('.') ? pathToFileURL(entry).href : entry
      const loaded: unknown = await import(specifier)
      const ok = typeof loaded === 'object' && loaded !== null
      return check('conformance/provider-importable', ok ? 'pass' : 'fail', ok ? `provider 产物可 import：${entry}` : `import 结果不是模块：${entry}`)
    } catch (error) {
      return check('conformance/provider-importable', 'fail', `provider 产物 import 失败：${entry}（${messageOf(error)}）`)
    }
  }

  async function recycleSemantics(): Promise<ConformanceCheck> {
    return check('conformance/recycle-semantics', 'skip', '回收（prune/GC/配额）尚未实现；当前 `prune` 是空实现')
  }

  async function unknownOutcome(): Promise<ConformanceCheck> {
    const targetHome = join(home, 'unknown-provider')
    await innerFs.mkdir(targetHome)
    const instance = createProvisioner(provisionerOptions(targetHome))
    declareAll(instance)
    try {
      const report = await instance.ensure()
      const wrong = report.entries.filter(entry => entry.code !== 'unknown-provider')
      return check(
        'conformance/unknown-provider',
        wrong.length === 0 ? 'pass' : 'fail',
        wrong.length === 0 ? '无人认领的 kind 报 unknown-provider' : wrong.map(entry => `${entry.id} 得到 ${String(entry.code)}`).join('；'),
      )
    } catch (error) {
      return check('conformance/unknown-provider', 'fail', `ensure 抛错：${messageOf(error)}`)
    }
  }

  async function artifactCheck(paths: readonly string[] | undefined, client: boolean): Promise<ConformanceCheck> {
    const id = client ? 'conformance/client-artifact-clean' : 'conformance/provider-artifact-type-only'
    if (paths === undefined || paths.length === 0) {
      return check(id, 'skip', client ? '未提供 client 产物' : '未提供 provider 产物')
    }
    const offenders: string[] = []
    for (const path of paths) {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        offenders.push(`${path}: 不可读（${messageOf(error)}）`)
        continue
      }
      const specifiers = [...new Set(findFrameworkImports(text).map(found => found.specifier))]
      if (specifiers.length > 0) {
        offenders.push(
          client
            ? `${path}: client 产物不得 import 框架（${specifiers.join(', ')}）`
            : `${path}: provider 产物对框架只能 import type，产物里不得留下（${specifiers.join(', ')}）`,
        )
      }
    }
    return check(
      id,
      offenders.length === 0 ? 'pass' : 'fail',
      offenders.length === 0
        ? `${String(paths.length)} 个${client ? 'client' : 'provider'}产物无框架 value import`
        : offenders.join('；'),
    )
  }
}

/** Throw when any check failed; the message lists the failing rule ids. */
export function assertProviderConformance(report: ConformanceReport): void {
  const failed = report.checks.filter(entry => entry.status === 'fail')
  if (failed.length === 0) return
  throw new Error(
    `provider ${report.provider} 未通过 conformance：\n${failed.map(entry => `  [${entry.id}] ${entry.message}`).join('\n')}`,
  )
}
