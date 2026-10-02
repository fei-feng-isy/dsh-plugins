/**
 * The built-in `npm-package` provider.
 * @module providers/npm
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ProvisionError } from '../errors.js'
import { exists, linkOrCopy } from '../fs.js'
import { verifyIntegrity } from '../integrity.js'
import { isInside, assertSafeRelativePath } from '../layout.js'
import { decodeJson, readInstallManifest } from '../manifest.js'
import { DEFAULT_MAX_BYTES, METADATA_MAX_BYTES, candidateUrls, fetchImplOf, readCapped, signalFor } from '../net.js'
import { assertPackageName } from '../package-name.js'
import { parseRange, parseVersion, satisfiesRange, selectVersion } from '../semver.js'
import { extractTarGz } from '../tar.js'
import type { InstallContext, ProbeResult, Provider, ProviderContext, ProviderPlan, ProvisionItem, PublishMeta, Resolved } from '../types.js'

export const NPM_PACKAGE_KIND = 'npm-package'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const VERIFY_TIMEOUT_MS = 15_000
/** Depth limit for the `verify` scan for a prebuilt native module. */
const NATIVE_SCAN_DEPTH = 3

/** The `spec` of an `npm-package` item. */
export interface NpmPackageSpec {
  readonly name: string
  readonly range: string
  readonly registry?: string
  /** Expected integrity for private mirrors; overrides `dist.integrity`. */
  readonly expectedIntegrity?: string
  /** Extra peers the caller wants linked, with an explicit resolved directory when it has one. */
  readonly peers?: readonly { readonly name: string; readonly optional?: boolean; readonly dir?: string }[]
}

interface PackumentVersion {
  readonly dist?: { readonly tarball?: string; readonly integrity?: string; readonly shasum?: string }
  readonly engines?: { readonly node?: string }
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  readonly deprecated?: string
}

function parseSpec(item: ProvisionItem): NpmPackageSpec {
  const spec = item.spec
  if (typeof spec !== 'object' || spec === null) {
    throw new ProvisionError('invalid-option', `npm-package 的 spec 必须是 {name, range}：${String(item.id)}`)
  }
  const record = spec as Record<string, unknown>
  const name = record['name']
  const range = record['range']
  if (typeof name !== 'string' || name === '' || typeof range !== 'string' || range === '') {
    throw new ProvisionError('invalid-option', `npm-package 的 spec 缺少 name/range：${String(item.id)}`)
  }
  assertPackageName(name)
  return spec as NpmPackageSpec
}

async function fetchPackument(ctx: ProviderContext, spec: NpmPackageSpec): Promise<Record<string, PackumentVersion>> {
  const registry = spec.registry ?? DEFAULT_REGISTRY
  const url = `${registry.replace(/\/+$/, '')}/${spec.name}`
  let response: Response
  try {
    response = await fetchImplOf(ctx)(url, { headers: { accept: 'application/json' }, signal: signalFor(ctx) })
  } catch (error) {
    throw new ProvisionError('fetch/failed', `无法获取 packument：${url}（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (!response.ok) throw new ProvisionError('fetch/failed', `packument ${url} 返回 HTTP ${String(response.status)}`)
  // Metadata read through a hard byte cap of its own (`METADATA_MAX_BYTES`, not the 256 MiB archive
  // cap): a hostile or broken mirror must not OOM the host with an unbounded `response.json()`, and
  // because a packument is `JSON.parse`d its cap has to bound the PARSED size, not just the wire size.
  const body: unknown = JSON.parse(new TextDecoder().decode(await readCapped(response, METADATA_MAX_BYTES))) as unknown
  const versions = typeof body === 'object' && body !== null ? (body as { versions?: unknown }).versions : undefined
  if (typeof versions !== 'object' || versions === null) {
    throw new ProvisionError('fetch/failed', `packument ${url} 没有 versions`)
  }
  return versions as Record<string, PackumentVersion>
}

async function download(ctx: ProviderContext, urls: readonly string[], integrity: string): Promise<{ readonly bytes: Uint8Array; readonly url: string }> {
  const problems: string[] = []
  for (const url of urls) {
    let bytes: Uint8Array
    try {
      const response = await fetchImplOf(ctx)(url, { signal: signalFor(ctx) })
      if (!response.ok) {
        problems.push(`${url} → HTTP ${String(response.status)}`)
        continue
      }
      bytes = await readCapped(response, DEFAULT_MAX_BYTES)
    } catch (error) {
      problems.push(`${url} → ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    // Only transport failures fall through to the next candidate.
    verifyIntegrity(bytes, integrity)
    return { bytes, url }
  }
  throw new ProvisionError('fetch/failed', `npm 包的所有候选源都失败：${problems.join('; ')}`)
}

/** npm's `os`/`cpu` semantics: bare names allow, `!name` denials win. */
function listAllows(list: readonly string[] | undefined, value: string): boolean {
  if (list === undefined || list.length === 0) return true
  const negatives = list.filter(entry => entry.startsWith('!')).map(entry => entry.slice(1))
  if (negatives.includes(value)) return false
  const positives = list.filter(entry => !entry.startsWith('!'))
  return positives.length === 0 || positives.includes(value)
}

function nodeAllows(range: string | undefined, runtime: string): boolean {
  if (range === undefined || range === '') return true
  try {
    return satisfiesRange(runtime, range)
  } catch {
    return true // an engine range outside the supported subset is ignored
  }
}

/** Versions a range names with an exact comparator, i.e. those allowed to be deprecated. */
function pinnedVersions(range: string): ReadonlySet<string> {
  const pinned = new Set<string>()
  try {
    for (const alternative of parseRange(range)) {
      for (const comparator of alternative) {
        if (comparator.op !== '=') continue
        const { major, minor, patch, prerelease } = comparator.version
        pinned.add(`${String(major)}.${String(minor)}.${String(patch)}${prerelease.length === 0 ? '' : `-${prerelease.join('.')}`}`)
      }
    }
  } catch {
    return pinned
  }
  return pinned
}

/** Pick the highest release satisfying the range, engine, `os`/`cpu` and deprecation filters. */
function resolveVersion(
  versions: Record<string, PackumentVersion>,
  spec: NpmPackageSpec,
  platform: string,
  arch: string,
  runtime: string,
): string | undefined {
  const pinned = pinnedVersions(spec.range)
  const usable = Object.entries(versions).filter(([text, candidate]) => {
    if (candidate === undefined || parseVersion(text) === undefined) return false
    if (!nodeAllows(candidate.engines?.node, runtime)) return false
    if (!listAllows(candidate.os, platform)) return false
    if (!listAllows(candidate.cpu, arch)) return false
    if (candidate.deprecated !== undefined && !pinned.has(text)) return false
    return true
  })
  return selectVersion(
    usable.map(([text]) => text),
    spec.range,
  )
}

/** Depth-first search for a prebuilt native module (`*.node`). */
async function findNativeModule(ctx: ProviderContext, dir: string, depth = 0): Promise<string | undefined> {
  if (depth > NATIVE_SCAN_DEPTH) return undefined
  let entries: readonly string[]
  try {
    entries = await ctx.fs.readdir(dir)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (entry.endsWith('.node')) return join(dir, entry)
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    const info = await ctx.fs.stat(path)
    if (info?.isDirectory === true) {
      const found = await findNativeModule(ctx, path, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

async function packageVersionOf(ctx: ProviderContext, dir: string): Promise<string | undefined> {
  try {
    const raw = decodeJson(await ctx.fs.readFile(join(dir, 'package.json')))
    if (typeof raw !== 'object' || raw === null) return undefined
    const version = (raw as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    return undefined
  }
}

/** Does `dir` end with the package's path segments? Compares segments, not a raw string suffix.
 *
 *  `dir.endsWith(name)` never matched a scoped peer on Windows (`…\node_modules\@scope\pkg` does not
 *  end with `@scope/pkg`), so peer resolution silently fell through. Comparing the trailing segments
 *  on forward slashes works with either separator; no match stays a `peer/unsatisfied` (fail-closed). */
function dirIsPackage(dir: string, name: string): boolean {
  const wanted = name.split('/')
  const got = dir.replaceAll('\\', '/').replace(/\/+$/, '').split('/')
  if (got.length < wanted.length) return false
  const tail = got.slice(got.length - wanted.length)
  return tail.every((segment, index) => segment === wanted[index])
}

/** Walk up from a resolved entry to the owning package directory.
 *
 *  The candidate is checked BEFORE stepping up (the entry usually sits directly in the package), and
 *  `dirnameImpl` is the platform `dirname` so the win32 separator path is covered from Linux. */
export function packageDirOf(entry: string, name: string, dirnameImpl: (path: string) => string = dirname): string | undefined {
  let dir = dirnameImpl(entry)
  for (let depth = 0; depth < 6; depth += 1) {
    if (dirIsPackage(dir, name)) return dir
    const parent = dirnameImpl(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** Resolve a peer directory from this module's tree, falling back to the host CWD with a warning.
 *
 *  The order matters: `import.meta.url` is the tree that actually loaded this provider, while the CWD
 *  is wherever the host happened to start. A peer resolved from the CWD becomes an ABSOLUTE symlink
 *  inside the published version directory (see {@link linkPeers}); it dangles the moment the host
 *  starts elsewhere or that tree is removed, and it made "one zod" depend on the launch directory.
 *  The CWD stays as a last resort, but never silently. */
function resolvePeerDir(peer: string, ctx: ProviderContext): string | undefined {
  const from = (root: string): string | undefined => {
    try {
      return dirname(createRequire(root).resolve(`${peer}/package.json`))
    } catch {
      // fall through to the entry walk-up
    }
    try {
      const entry = createRequire(root).resolve(peer)
      return packageDirOf(entry, peer)
    } catch {
      return undefined
    }
  }
  const own = from(import.meta.url)
  if (own !== undefined) return own
  const cwd = join(process.cwd(), 'noop.js')
  const fromCwd = from(cwd)
  if (fromCwd !== undefined) {
    ctx.logger.warn(
      `peer ${peer} 只能从宿主启动目录解析到（${process.cwd()} → ${fromCwd}）；发布物里嵌的是该位置的绝对链接，换目录/卸载后会悬空`,
    )
    return fromCwd
  }
  return undefined
}

async function linkPeers(
  pkgDir: string,
  spec: NpmPackageSpec,
  staging: string,
  ctx: ProviderContext,
): Promise<void> {
  const raw = decodeJson(await ctx.fs.readFile(join(pkgDir, 'package.json')))
  if (typeof raw !== 'object' || raw === null) return
  const manifest = raw as { peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }
  const peers = manifest.peerDependencies ?? {}
  const meta = manifest.peerDependenciesMeta ?? {}
  for (const [peer, range] of Object.entries(peers)) {
    assertPackageName(peer, 'peer 名')
    const declared = spec.peers?.find(candidate => candidate.name === peer)
    const optional = meta[peer]?.optional === true || declared?.optional === true
    const dir = declared?.dir ?? resolvePeerDir(peer, ctx)
    if (dir === undefined) {
      if (optional) continue
      throw new ProvisionError('peer/unsatisfied', `peer ${peer}@${range} 不可满足（调用方未解析该 peer，也没有提供目录）`)
    }
    // A peer that is present but does not satisfy the range makes the item unusable.
    const installed = await packageVersionOf(ctx, dir)
    if (installed !== undefined) {
      let satisfied = true
      try {
        satisfied = satisfiesRange(installed, range)
      } catch {
        ctx.logger.warn(`peer ${peer} 的区间 "${range}" 不在支持的 semver 子集内，按满足处理`)
      }
      if (!satisfied) {
        if (optional) continue
        throw new ProvisionError('peer/unsatisfied', `peer ${peer} 需要 ${range}，调用方解析到的是 ${installed}`)
      }
    }
    const linkPath = join(staging, 'node_modules', ...peer.split('/'))
    // Fall back to a real copy when symlinks are unavailable.
    await linkOrCopy(ctx.fs, dir, linkPath, {
      onFallback: () => ctx.logger.warn(`peer ${peer} 退化为复制：identity 不再保证`),
    })
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProvisionError('verify/failed', message)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The entry-file candidates a `package.json` points at, in Node's resolution order. */
function entryCandidatesOf(pkgDir: string, pkg: Record<string, unknown>): readonly string[] {
  const exported = pkg['exports']
  let relativePath: string | undefined
  let exact = false
  if (typeof exported === 'string') {
    relativePath = exported
    exact = true
  } else if (typeof exported === 'object' && exported !== null) {
    const dot = (exported as Record<string, unknown>)['.'] ?? exported
    if (typeof dot === 'string') {
      relativePath = dot
      exact = true
    } else if (typeof dot === 'object' && dot !== null) {
      const conditions = dot as Record<string, unknown>
      for (const key of ['import', 'default', 'require']) {
        const value = conditions[key]
        if (typeof value === 'string') {
          relativePath = value
          exact = true
          break
        }
      }
    }
  }
  if (relativePath === undefined && typeof pkg['main'] === 'string') {
    const main = pkg['main']
    // An empty or root-relative `main` maps to index.js.
    relativePath = main === '' || main === '.' || main === './' ? 'index.js' : main
  }
  if (relativePath === undefined) relativePath = 'index.js'
  const base = join(pkgDir, relativePath)
  if (exact) return [base]
  return [base, `${base}.js`, `${base}.json`, `${base}.node`, join(base, 'index.js')]
}

/** Build the built-in npm provider. */
export function npmPackageProvider(options: { readonly id?: string } = {}): Provider {
  const id = options.id ?? '@avantf/dsh-plugin-base/npm'
  // Version directories already reported as `unverifiable`, warned once per provider instance.
  const warnedUnverifiable = new Set<string>()
  return {
    id,
    kinds: [NPM_PACKAGE_KIND],

    identify(item) {
      const spec = parseSpec(item)
      return { name: spec.name, range: spec.range }
    },

    targetDir(_item, ref) {
      return `${ref.name}/${ref.segment}`
    },

    async probe(item, ctx): Promise<ProbeResult> {
      const spec = parseSpec(item)
      const root = join(ctx.home, item.target.root, ...spec.name.split('/'))
      let entries: readonly string[]
      try {
        entries = await ctx.fs.readdir(root)
      } catch {
        return { found: false }
      }
      const candidates: { version: string; versionDir: string; entryDir: string; installedAt: number }[] = []
      for (const entry of entries) {
        if (entry.startsWith('.')) continue
        const versionDir = join(root, entry)
        const manifestPath = join(versionDir, 'install.json')
        if ((await ctx.fs.stat(manifestPath)) === undefined) continue
        const manifest = readInstallManifest(decodeJson(await ctx.fs.readFile(manifestPath)), NPM_PACKAGE_KIND)
        if (manifest === undefined) continue
        if (!satisfiesRange(manifest.version, spec.range)) continue
        if (manifest.integrity === undefined && !warnedUnverifiable.has(versionDir)) {
          // Without integrity the copy is still reusable, but is reported once as unverifiable.
          warnedUnverifiable.add(versionDir)
          ctx.logger.warn(`unverifiable: ${versionDir} 的 install.json 没有 integrity；按可用处理`)
        }
        const relativeEntry = manifest.entryDir ?? `node_modules/${spec.name}`
        // The read-back side of the same check `publish()` runs on write: an `install.json` whose
        // entryDir is absolute or `..`-escaping must not be joined into a path at all.
        try {
          assertSafeRelativePath(relativeEntry)
        } catch {
          ctx.logger.warn(`install.json 的 entryDir 不安全，已跳过：${relativeEntry}（${versionDir}）`)
          continue
        }
        const entryDir = join(versionDir, ...relativeEntry.split('/'))
        if (!isInside(versionDir, entryDir)) continue
        // A copy whose entry directory is missing is not usable.
        if (!(await exists(ctx.fs, entryDir))) continue
        candidates.push({
          version: manifest.version,
          versionDir,
          entryDir,
          installedAt: Date.parse(manifest.installed_at) || 0,
        })
      }
      // The newest `installed_at` wins when several directories describe one version.
      const best = candidates.sort((a, b) => b.installedAt - a.installedAt)[0]
      if (best === undefined) return { found: false }
      return { found: true, version: best.version, dir: best.entryDir, source: 'managed' }
    },

    plan(): ProviderPlan {
      return { action: 'install' }
    },

    async install(item, ctx: InstallContext): Promise<Resolved> {
      const spec = parseSpec(item)
      const versions = await fetchPackument(ctx, spec)
      const version = resolveVersion(versions, spec, process.platform, process.arch, process.version)
      if (version === undefined) {
        throw new ProvisionError(
          'npm/no-satisfying-version',
          `${spec.name} 没有同时满足 "${spec.range}" 与本机（node ${process.version} / ${process.platform}-${process.arch}）的版本`,
        )
      }
      const candidate = versions[version]
      const dist = candidate?.dist
      const integrity = spec.expectedIntegrity ?? dist?.integrity
      if (integrity === undefined) {
        throw new ProvisionError('npm/no-integrity', `${spec.name}@${version} 的 packument 没有 dist.integrity（只有 shasum 的包一律拒绝）`)
      }
      const tarball = dist?.tarball
      if (tarball === undefined || tarball === '') {
        throw new ProvisionError('fetch/failed', `${spec.name}@${version} 的 packument 没有 dist.tarball`)
      }

      const staging = await ctx.stage()
      const urls = candidateUrls(tarball, ctx.policy.mirrors?.npm)
      const downloaded = await download(ctx, urls, integrity)
      if (downloaded.url !== tarball) ctx.logger.debug(`tarball 来自镜像：${downloaded.url}`)
      const bytes = downloaded.bytes
      const pkgDir = join(staging, 'node_modules', ...spec.name.split('/'))
      await extractTarGz(bytes, pkgDir, ctx.fs, { strip: 1 })
      await linkPeers(pkgDir, spec, staging, ctx)
      const meta: PublishMeta = {
        name: spec.name,
        version,
        integrity,
        tarball,
        source: 'installed',
        entryDir: `node_modules/${spec.name}`,
      }
      return ctx.publish(staging, meta)
    },

    async verify(item, resolved, ctx): Promise<void> {
      const pkgDir = resolved.entryDir
      const packageJsonPath = join(pkgDir, 'package.json')
      if (!(await exists(ctx.fs, packageJsonPath))) {
        throw new ProvisionError('verify/failed', `包缺少 package.json：${pkgDir}`)
      }
      const parsed = decodeJson(await ctx.fs.readFile(packageJsonPath))
      if (typeof parsed !== 'object' || parsed === null) {
        throw new ProvisionError('verify/failed', `package.json 不可解析：${packageJsonPath}`)
      }
      const pkg = parsed as Record<string, unknown>
      const scripts = (pkg['scripts'] ?? {}) as Record<string, unknown>
      for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
        const command = scripts[lifecycle]
        if (typeof command === 'string' && command !== '') {
          throw new ProvisionError(
            'npm/lifecycle-script-unsupported',
            `${specNameOf(item)} 声明了 ${lifecycle} 脚本；本设施手动解包、不执行 lifecycle scripts，请手动预置`,
          )
        }
      }
      if (await exists(ctx.fs, join(pkgDir, 'binding.gyp'))) {
        throw new ProvisionError('verify/failed', `${specNameOf(item)} 是原生模块（binding.gyp）；本设施不接管原生模块，请走平台 prebuilt 或二进制归档路线`)
      }
      const native = await findNativeModule(ctx, pkgDir)
      if (native !== undefined) {
        throw new ProvisionError('verify/failed', `${specNameOf(item)} 带预编译原生模块（${native}）；本设施不接管原生模块，请走平台 prebuilt 或二进制归档路线`)
      }

      const candidates = entryCandidatesOf(pkgDir, pkg)
      // A candidate must be a real descendant of the package directory.
      const safe = candidates.filter(candidate => candidate !== pkgDir && isInside(pkgDir, candidate))
      if (safe.length === 0) {
        throw new ProvisionError('verify/failed', `package.json 的入口跳出包目录：${String(pkg['exports'] ?? pkg['main'])}`)
      }
      let entry: string | undefined
      for (const candidate of safe) {
        if (await exists(ctx.fs, candidate)) {
          entry = candidate
          break
        }
      }
      // A missing entry file means the tarball is incomplete.
      if (entry === undefined) {
        throw new ProvisionError('verify/failed', `${specNameOf(item)} 的入口文件不存在：${safe[0] ?? pkgDir}（包自身不完整）`)
      }
      const url = pathToFileURL(entry).href
      try {
        await withTimeout(import(url), VERIFY_TIMEOUT_MS, `import() 超时：${url}`)
      } catch (error) {
        if (error instanceof ProvisionError) throw error
        throw new ProvisionError('verify/failed', `import() 失败：${url}（${error instanceof Error ? error.message : String(error)}）`)
      }
    },
  }
}

function specNameOf(item: ProvisionItem): string {
  return parseSpec(item).name
}

