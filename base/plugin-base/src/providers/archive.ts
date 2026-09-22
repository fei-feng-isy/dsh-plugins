/**
 * The built-in `binary-archive` provider.
 * @module providers/archive
 */
import { delimiter, dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { ProvisionError } from '../errors.js'
import { exists } from '../fs.js'
import { sriOfSha256 } from '../integrity.js'
import { decodeJson, readInstallManifest } from '../manifest.js'
import { candidateUrls, downloadBytes, platformKey, verifySha256 } from '../net.js'
import { extractTarGz } from '../tar.js'
import { extractZip } from '../zip.js'
import type { InstallContext, ProbeResult, Provider, ProviderContext, ProviderPlan, ProvisionItem, PublishMeta, Resolved } from '../types.js'
import type { ProvisionFs } from '../types.js'

export const BINARY_ARCHIVE_KIND = 'binary-archive'
const VERIFY_TIMEOUT_MS = 15_000
/** Timeout for the short version probe that confirms a PATH hit. */
const PROBE_TIMEOUT_MS = 3_000
const UNPACK_DIR = '.unpack'
const MAX_SEARCH_DEPTH = 4

/** One platform pack of an archive artifact. */
export interface ArchivePack {
  readonly url: string
  readonly sha256: string
  /** Default `tar.gz`. */
  readonly archive?: 'tar.gz' | 'zip'
  /** Executable name inside the archive; defaults to the spec's. */
  readonly binary?: string
}

/** The `spec` of a `binary-archive` item. */
export interface BinaryArchiveSpec {
  /** Artifact identity, also the resource name. */
  readonly id: string
  readonly version: string
  /** `${platform}-${arch}` → pack. */
  readonly packs: Readonly<Record<string, ArchivePack>>
  /** The executable name; defaults to `id`. */
  readonly binary?: string
  /** Explicit path to an already-installed executable (highest probe priority). */
  readonly entry?: string
  /** Environment variable that overrides the explicit path. */
  readonly envVar?: string
  /** Arguments for the `--version` probe; defaults to `['--version']`. */
  readonly versionArgs?: readonly string[]
}

function parseSpec(item: ProvisionItem): BinaryArchiveSpec {
  const spec = item.spec
  if (typeof spec !== 'object' || spec === null) {
    throw new ProvisionError('invalid-option', `binary-archive 的 spec 必须是 {id, version, packs}：${String(item.id)}`)
  }
  const record = spec as Record<string, unknown>
  if (typeof record['id'] !== 'string' || typeof record['version'] !== 'string' || typeof record['packs'] !== 'object' || record['packs'] === null) {
    throw new ProvisionError('invalid-option', `binary-archive 的 spec 缺少 id/version/packs：${String(item.id)}`)
  }
  return spec as BinaryArchiveSpec
}

function binaryOf(spec: BinaryArchiveSpec, pack?: ArchivePack): string {
  return pack?.binary ?? spec.binary ?? spec.id
}

/** Search a tree for the executable, preferring shallower matches. */
async function findBinary(root: string, name: string, fs: ProvisionFs, depth = 0): Promise<string | undefined> {
  if (depth > MAX_SEARCH_DEPTH) return undefined
  let entries: readonly string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return undefined
  }
  const directories: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    const info = await fs.stat(path)
    if (info === undefined) continue
    if (info.isDirectory) {
      directories.push(path)
      continue
    }
    if (entry === name || entry === `${name}.exe`) return path
  }
  for (const directory of directories.sort()) {
    const found = await findBinary(directory, name, fs, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** Every executable candidate on `PATH`, in scan order. */
async function findAllOnPath(binary: string, fs: ProvisionFs): Promise<readonly string[]> {
  const names = process.platform === 'win32' ? [binary, `${binary}.exe`, `${binary}.cmd`] : [binary]
  const path = process.env['PATH'] ?? ''
  const found: string[] = []
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue
    for (const candidate of names) {
      const full = join(directory, candidate)
      if (await exists(fs, full)) found.push(full)
    }
  }
  return found
}

/** PATH contribution of a managed/explicit executable directory. */
function pathEnvOf(dir: string): Readonly<Record<string, string>> {
  return { PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}` }
}

/** Run the `--version` probe; `'timeout'` means the version is unknown. */
function runVersionProbe(
  path: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<'ok' | 'failed' | 'timeout'> {
  return new Promise(resolve => {
    execFile(
      path,
      [...args],
      {
        timeout: options.timeoutMs ?? VERIFY_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      error => {
        if (error === null) {
          resolve('ok')
          return
        }
        const killed = (error as { killed?: boolean }).killed === true || (error as { code?: string }).code === 'ETIMEDOUT'
        resolve(killed ? 'timeout' : 'failed')
      },
    )
  })
}

/** Build the built-in binary-archive provider. */
export function binaryArchiveProvider(options: { readonly id?: string } = {}): Provider {
  const id = options.id ?? '@avantf/dsh-plugin-base/binary-archive'
  return {
    id,
    kinds: [BINARY_ARCHIVE_KIND],

    identify(item) {
      const spec = parseSpec(item)
      return { name: spec.id, range: spec.version }
    },

    targetDir(_item, ref) {
      return `${ref.name}/${ref.segment}`
    },

    /** Return `install` with the pinned version and pack URLs, or `unknown` without a pack. */
    plan(item, ctx): ProviderPlan {
      const spec = parseSpec(item)
      const pack = spec.packs[platformKey()]
      if (pack === undefined) return { action: 'unknown' }
      return { action: 'install', version: spec.version, urls: candidateUrls(pack.url, ctx.policy.mirrors?.archive) }
    },

    async probe(item, ctx: ProviderContext): Promise<ProbeResult> {
      const spec = parseSpec(item)
      const binary = binaryOf(spec)
      const args = spec.versionArgs ?? ['--version']

      // A PATH/explicit hit is confirmed with the same `--version` probe as verify.
      const check = async (path: string): Promise<{ version?: string } | undefined> => {
        if (args.length === 0) return { version: spec.version }
        const outcome = await runVersionProbe(path, args, { timeoutMs: PROBE_TIMEOUT_MS, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) })
        if (outcome === 'ok') return { version: spec.version }
        if (outcome === 'timeout') {
          ctx.logger.warn(`${path} 的 ${args.join(' ')} 探针超时；按"存在但版本未知"处理`)
          return {}
        }
        return undefined
      }

      const fromEnv = spec.envVar === undefined ? undefined : process.env[spec.envVar]
      const explicit = spec.entry ?? (fromEnv === undefined || fromEnv === '' ? undefined : fromEnv)
      if (explicit !== undefined && (await exists(ctx.fs, explicit))) {
        const confirmed = await check(explicit)
        if (confirmed !== undefined) {
          return { found: true, ...confirmed, dir: dirname(explicit), source: 'explicit', env: pathEnvOf(dirname(explicit)) }
        }
      }

      const root = join(ctx.home, item.target.root, spec.id)
      try {
        for (const entry of await ctx.fs.readdir(root)) {
          const manifestPath = join(root, entry, 'install.json')
          if ((await ctx.fs.stat(manifestPath)) === undefined) continue
          const manifest = readInstallManifest(decodeJson(await ctx.fs.readFile(manifestPath)), BINARY_ARCHIVE_KIND)
          if (manifest === undefined || manifest.version !== spec.version) continue
          // The manifest's entry is authoritative.
          const relative = manifest.entry ?? `bin/${binaryOf(spec, spec.packs[platformKey()])}`
          const executable = join(root, entry, ...relative.split('/'))
          if (await exists(ctx.fs, executable)) {
            const dir = dirname(executable)
            return { found: true, version: spec.version, dir, source: 'managed', env: pathEnvOf(dir) }
          }
        }
      } catch {
        // No managed root yet: fall through to PATH.
      }

      // A failed PATH candidate does not stop the scan; rejected candidates are reported once.
      const rejected: string[] = []
      for (const candidate of await findAllOnPath(binary, ctx.fs)) {
        const confirmed = await check(candidate)
        if (confirmed !== undefined) {
          if (rejected.length > 0) {
            ctx.logger.warn(`PATH 上的 ${rejected.join('、')} 未通过 ${args.join(' ')} 探针，已跳过；改用 ${candidate}`)
          }
          return { found: true, ...confirmed, dir: dirname(candidate), source: 'system' }
        }
        rejected.push(candidate)
      }
      if (rejected.length > 0) {
        ctx.logger.warn(`PATH 上的 ${rejected.join('、')} 均未通过 ${args.join(' ')} 探针；按未安装处理`)
      }
      return { found: false }
    },

    async install(item, ctx: InstallContext): Promise<Resolved> {
      const spec = parseSpec(item)
      const key = platformKey()
      const pack = spec.packs[key]
      if (pack === undefined) {
        throw new ProvisionError('archive/no-platform-pack', `${spec.id}@${spec.version} 没有 ${key} 的 pack`)
      }
      const urls = candidateUrls(pack.url, ctx.policy.mirrors?.archive)
      const { bytes } = await downloadBytes(ctx, urls, `${BINARY_ARCHIVE_KIND}+${spec.id}`, ctx.onProgress)
      verifySha256(bytes, pack.sha256)

      const staging = await ctx.stage()
      const unpack = join(staging, UNPACK_DIR)
      if ((pack.archive ?? 'tar.gz') === 'zip') await extractZip(bytes, unpack, ctx.fs)
      else await extractTarGz(bytes, unpack, ctx.fs)

      const binary = binaryOf(spec, pack)
      const found = await findBinary(unpack, binary, ctx.fs)
      if (found === undefined) {
        throw new ProvisionError('extract/failed', `${spec.id}@${spec.version} 的归档里找不到可执行物 ${binary}`)
      }
      const binDir = join(staging, 'bin')
      await ctx.fs.mkdir(binDir)
      const target = join(binDir, binary)
      await ctx.fs.copyFile(found, target)
      await ctx.fs.chmod(target, 0o755)
      await ctx.fs.rm(unpack, { recursive: true })

      const meta: PublishMeta = {
        name: spec.id,
        version: spec.version,
        integrity: sriOfSha256(pack.sha256),
        tarball: pack.url,
        source: 'installed',
        entry: `bin/${binary}`,
        entryDir: 'bin',
      }
      return ctx.publish(staging, meta)
    },

    async verify(item, resolved, ctx): Promise<void> {
      const spec = parseSpec(item)
      // The published entry is the manifest's.
      const manifest = readInstallManifest(decodeJson(await ctx.fs.readFile(join(resolved.dir, 'install.json'))), BINARY_ARCHIVE_KIND)
      const entry = manifest?.entry
      const path = entry === undefined ? join(resolved.entryDir, binaryOf(spec)) : join(resolved.dir, ...entry.split('/'))
      if (!(await exists(ctx.fs, path))) {
        throw new ProvisionError('verify/failed', `归档可执行物不存在：${path}`)
      }
      await ctx.fs.chmod(path, 0o755)
      const args = spec.versionArgs ?? ['--version']
      if (args.length === 0) return
      const outcome = await runVersionProbe(path, args, { ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) })
      if (outcome === 'timeout') {
        // A timeout leaves the binary usable; only a failed probe fails verification.
        ctx.logger.warn(`${path} 的 ${args.join(' ')} 探针超时；按可用处理`)
        return
      }
      if (outcome === 'failed') {
        throw new ProvisionError('verify/failed', `${path} 的 ${args.join(' ')} 探针失败`)
      }
    },
  }
}
