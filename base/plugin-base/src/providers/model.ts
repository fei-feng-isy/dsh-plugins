/**
 * The built-in `model-cache` provider.
 * @module providers/model
 */
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { ProvisionError } from '../errors.js'
import { ATOMIC_TEMP_PREFIX, exists, sweepAtomicTemps } from '../fs.js'
import { isInside, lockPath } from '../layout.js'
import { defaultLock } from '../lock.js'
import { fetchImplOf, readCapped, signalFor } from '../net.js'
import type {
  InstallContext,
  ProbeResult,
  Provider,
  ProviderContext,
  ProviderPlan,
  ProvisionFs,
  ProvisionItem,
  ProvisionPolicy,
  Resolved,
} from '../types.js'

export const MODEL_CACHE_KIND = 'model-cache'
const DEFAULT_ENDPOINT = 'https://huggingface.co'
const DEFAULT_REVISION = 'main'
/** Maximum bytes read for a single model file. */
const MAX_MODEL_BYTES = 4 * 1024 * 1024 * 1024
/** How long the placement lock waits before reporting `lock/timeout`. */
const LOCK_TIMEOUT_MS = 15_000
/** A placement lock older than this whose pid is gone is reclaimed. */
const STALE_LOCK_MS = 60_000

/** A resolved commit id: 40 or 64 lowercase hex. */
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
/** A content-addressed blob name: sha256 lowercase hex. */
const BLOB_PATTERN = /^[0-9a-f]{64}$/
/** C0 controls and DEL may not appear in a path segment. */
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/

/** Monotonic per-process sequence for the same-directory link temps. */
let linkSequence = 0

/** How an item's files are placed under `target.root`.
 *  @stable */
export type ModelCacheLayout = 'hub' | 'flat'

/** The default layout: the content-addressed snapshot tree. */
const DEFAULT_LAYOUT: ModelCacheLayout = 'hub'
/** The layout whose files a runtime reads directly at `<root>/<repo>/<file>`. */
const FLAT_LAYOUT: ModelCacheLayout = 'flat'

/** Sidecar directory under `target.root`; flat state lives here and is never read as model data. */
const SIDECAR_DIR = '.envinit'
const RECORD_FILE = 'record.json'
const RECORD_SCHEMA_VERSION = 1

/** The `spec` of a `model-cache` item. */
export interface ModelCacheSpec {
  /** The repo id, e.g. `org/name`; also the resource name. */
  readonly repo: string
  /** Branch/tag/sha; default `main`. */
  readonly revision?: string
  /** File placement; default `hub`. */
  readonly layout?: ModelCacheLayout
  /** Endpoint override; wins over `policy.mirrors.model`. */
  readonly endpoint?: string
  /** Explicit file list; when absent the repository API's `siblings` are used. */
  readonly files?: readonly string[]
  /** Extra files that must exist for `verify` to pass. */
  readonly requiredFiles?: readonly string[]
}

/** The sidecar state `flat` writes last; its presence is the completion marker. */
interface FlatRecord {
  readonly schemaVersion: number
  readonly repo: string
  readonly revision: string
  readonly sha: string
  readonly files: readonly string[]
  /** Per-file sha256; absent in names-only records written by older builds. */
  readonly digests: Readonly<Record<string, string>>
}

/** Is `value` a resolved commit id? */
function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_PATTERN.test(value)
}

/** Reject a revision that cannot be a safe single path tree under `refs/`. */
function assertSafeRevision(revision: string): void {
  if (revision.trim() === '') {
    throw new ProvisionError('invalid-option', `model-cache 的 spec.revision 不能为空：${JSON.stringify(revision)}`)
  }
  if (CONTROL_PATTERN.test(revision) || revision.includes('\\') || revision.startsWith('/')) {
    throw new ProvisionError('invalid-option', `model-cache 的 spec.revision 不安全：${JSON.stringify(revision)}`)
  }
  const parts = revision.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new ProvisionError('invalid-option', `model-cache 的 spec.revision 不得跳出 refs：${JSON.stringify(revision)}`)
  }
}

function parseSpec(item: ProvisionItem): ModelCacheSpec {
  const spec = item.spec
  if (typeof spec !== 'object' || spec === null || typeof (spec as { repo?: unknown }).repo !== 'string') {
    throw new ProvisionError('invalid-option', `model-cache 的 spec 必须是 {repo, revision?, layout?}：${String(item.id)}`)
  }
  const layout = (spec as { layout?: unknown }).layout
  if (layout !== undefined && layout !== DEFAULT_LAYOUT && layout !== FLAT_LAYOUT) {
    throw new ProvisionError('invalid-option', `model-cache 的 spec.layout 只能是 ${DEFAULT_LAYOUT} 或 ${FLAT_LAYOUT}：${JSON.stringify(layout)}`)
  }
  const revision = (spec as { revision?: unknown }).revision
  if (revision !== undefined) {
    if (typeof revision !== 'string') {
      throw new ProvisionError('invalid-option', `model-cache 的 spec.revision 必须是字符串：${JSON.stringify(revision)}`)
    }
    assertSafeRevision(revision)
  }
  const parsed = spec as ModelCacheSpec
  if (parsed.layout === FLAT_LAYOUT) assertFlatRepo(parsed.repo)
  return parsed
}

/** An explicitly blank endpoint is a spec error, not a silent fallback to the built-in one. */
function assertEndpoint(spec: ModelCacheSpec): void {
  if (spec.endpoint !== undefined && (typeof spec.endpoint !== 'string' || spec.endpoint.trim() === '')) {
    throw new ProvisionError('invalid-option', `model-cache 的 spec.endpoint 不能为空白：${JSON.stringify(spec.endpoint)}`)
  }
}

function layoutOf(spec: ModelCacheSpec): ModelCacheLayout {
  return spec.layout ?? DEFAULT_LAYOUT
}

/** The `flat` layout joins the repo id onto `target.root`, so every segment must stay inside it. */
function assertFlatRepo(repo: string): void {
  const normalized = repo.replaceAll('\\', '/')
  const parts = normalized.split('/')
  const unsafe =
    normalized.startsWith('/') ||
    CONTROL_PATTERN.test(normalized) ||
    parts.some(part => part === '' || part === '.' || part === '..')
  if (unsafe || parts[0] === SIDECAR_DIR) {
    throw new ProvisionError('invalid-option', `${FLAT_LAYOUT} 布局的 repo 必须是安全相对路径，且第一段不得为 ${SIDECAR_DIR}：${JSON.stringify(repo)}`)
  }
}

/** Join one repo-relative file name onto `root`, refusing anything that escapes it. */
function fileUnder(root: string, file: string): string {
  const parts = file.replaceAll('\\', '/').split('/')
  if (file === '' || file.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(file) || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new ProvisionError('invalid-option', `模型文件路径不安全：${JSON.stringify(file)}`)
  }
  return join(root, ...parts)
}

function cacheDirName(repo: string): string {
  return `models--${repo.replaceAll('\\', '/').replaceAll('/', '--')}`
}

function hubRoot(home: string, targetRoot: string, repo: string): string {
  return join(home, targetRoot, cacheDirName(repo))
}

function flatDataDir(home: string, targetRoot: string, repo: string): string {
  return join(home, targetRoot, ...repo.replaceAll('\\', '/').split('/'))
}

function flatSidecarDir(home: string, targetRoot: string, repo: string): string {
  return join(home, targetRoot, SIDECAR_DIR, cacheDirName(repo))
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function text(value: unknown): string {
  return new TextDecoder().decode(value as Uint8Array)
}

/** One model file waiting to be placed, plus its content-addressed blob. */
interface Placement {
  readonly file: string
  readonly blob: string
  readonly digest: string
}

/**
 * The endpoints to try, in order: an explicit `spec.endpoint`, else `policy.mirrors.model`
 * followed by the default endpoint. Trailing slashes are normalised away.
 */
function endpointsOf(spec: ModelCacheSpec, policy: ProvisionPolicy): readonly string[] {
  const candidates = spec.endpoint === undefined ? [...(policy.mirrors?.model ?? []), DEFAULT_ENDPOINT] : [spec.endpoint]
  const endpoints: string[] = []
  for (const candidate of candidates) {
    const endpoint = candidate.trim().replace(/\/+$/, '')
    if (endpoint !== '' && !endpoints.includes(endpoint)) endpoints.push(endpoint)
  }
  return endpoints.length === 0 ? [DEFAULT_ENDPOINT] : endpoints
}

/** The files `verify` and the `flat` probe insist on; `config.json` is always required. */
function requiredFilesOf(spec: ModelCacheSpec): readonly string[] {
  return [...new Set(['config.json', ...(spec.requiredFiles ?? [])])]
}

async function resolveRevision(ctx: ProviderContext, spec: ModelCacheSpec): Promise<string> {
  const revision = spec.revision ?? DEFAULT_REVISION
  // Only a full 40/64-hex commit sha short-circuits the lookup.
  if (isSha(revision)) return revision
  const problems: string[] = []
  for (const endpoint of endpointsOf(spec, ctx.policy)) {
    const url = `${endpoint}/api/models/${spec.repo}/revision/${revision}`
    try {
      const response = await fetchImplOf(ctx)(url, { headers: { accept: 'application/json' }, signal: signalFor(ctx) })
      if (!response.ok) {
        problems.push(`${url} → HTTP ${String(response.status)}`)
        continue
      }
      const body: unknown = await response.json()
      const sha = typeof body === 'object' && body !== null ? (body as { sha?: unknown }).sha : undefined
      if (!isSha(sha)) {
        problems.push(`${url} → 响应 sha 不是 40/64 位小写十六进制`)
        continue
      }
      return sha
    } catch (error) {
      problems.push(`${url} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new ProvisionError('fetch/failed', `无法解析 ${spec.repo}@${revision}：${problems.join('; ')}`)
}

/** The explicitly declared file list; an explicit empty list is a spec error, not a remote query. */
function declaredFiles(spec: ModelCacheSpec): readonly string[] | undefined {
  if (spec.files === undefined) return undefined
  if (spec.files.length === 0) throw new ProvisionError('invalid-option', `${spec.repo} 的 spec.files 为空`)
  return spec.files
}

async function listFiles(ctx: ProviderContext, spec: ModelCacheSpec): Promise<readonly string[]> {
  const declared = declaredFiles(spec)
  if (declared !== undefined) return declared
  const problems: string[] = []
  for (const endpoint of endpointsOf(spec, ctx.policy)) {
    const url = `${endpoint}/api/models/${spec.repo}`
    try {
      const response = await fetchImplOf(ctx)(url, { headers: { accept: 'application/json' }, signal: signalFor(ctx) })
      if (!response.ok) {
        problems.push(`${url} → HTTP ${String(response.status)}`)
        continue
      }
      const body: unknown = await response.json()
      const siblings = typeof body === 'object' && body !== null ? (body as { siblings?: unknown }).siblings : undefined
      const names = Array.isArray(siblings)
        ? siblings.map(row => (typeof row === 'object' && row !== null ? (row as { rfilename?: unknown }).rfilename : undefined))
        : []
      const files = names.filter((name): name is string => typeof name === 'string' && name !== '')
      if (files.length === 0) {
        problems.push(`${url} → 文件列表为空`)
        continue
      }
      return files
    } catch (error) {
      problems.push(`${url} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new ProvisionError('fetch/failed', `无法列出 ${spec.repo} 的文件：${problems.join('; ')}`)
}

/**
 * Download one file, trying each endpoint in order. A length or integrity failure is final: only
 * transport-level failures fall through to the next mirror.
 */
async function downloadFile(
  ctx: ProviderContext,
  endpoints: readonly string[],
  repo: string,
  sha: string,
  file: string,
): Promise<Uint8Array> {
  const problems: string[] = []
  for (const endpoint of endpoints) {
    const url = `${endpoint}/${repo}/resolve/${sha}/${file}`
    try {
      const response = await fetchImplOf(ctx)(url, { signal: signalFor(ctx) })
      if (!response.ok) {
        problems.push(`${url} → HTTP ${String(response.status)}`)
        continue
      }
      return await readCapped(response, MAX_MODEL_BYTES)
    } catch (error) {
      if (error instanceof ProvisionError) throw error
      problems.push(`${url} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new ProvisionError('fetch/failed', `下载 ${repo}/${file} 失败：${problems.join('; ')}`)
}

/** The cached snapshot directory for the declared revision, or `undefined` when not cached. */
async function findSnapshot(ctx: ProviderContext, root: string, spec: ModelCacheSpec): Promise<string | undefined> {
  const revision = spec.revision ?? DEFAULT_REVISION
  const refPath = join(root, 'refs', revision)
  if (!(await exists(ctx.fs, refPath))) return undefined
  const recorded = text(await ctx.fs.readFile(refPath)).trim()
  // A ref must name a commit id; anything else is a corrupt or hostile marker.
  if (!isSha(recorded)) return undefined
  // A sha-pinned revision resolves to exactly that sha; a branch resolves to whatever it records.
  const pinned = isSha(revision) ? revision : undefined
  if (pinned !== undefined && recorded !== pinned) return undefined
  const candidate = join(root, 'snapshots', recorded)
  return (await exists(ctx.fs, candidate)) ? candidate : undefined
}

function encodeRecord(record: FlatRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`)
}

function decodeRecord(bytes: Uint8Array): FlatRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text(bytes))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (record['schemaVersion'] !== RECORD_SCHEMA_VERSION) return undefined
  if (typeof record['repo'] !== 'string' || typeof record['revision'] !== 'string' || !isSha(record['sha'])) return undefined
  const files = record['files']
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) return undefined
  // Digests are optional: a names-only record from an older build stays usable.
  const rawDigests = record['digests']
  const digests = Object.create(null) as Record<string, string>
  if (typeof rawDigests === 'object' && rawDigests !== null && !Array.isArray(rawDigests)) {
    for (const [file, value] of Object.entries(rawDigests as Record<string, unknown>)) {
      if (typeof value === 'string' && BLOB_PATTERN.test(value)) digests[file] = value
    }
  }
  return { schemaVersion: RECORD_SCHEMA_VERSION, repo: record['repo'], revision: record['revision'], sha: record['sha'], files, digests }
}

/** Run `mission` under the core's placement lock. */
async function withLock<T>(ctx: ProviderContext, mission: () => Promise<T>): Promise<T> {
  const lock = ctx.lock ?? defaultLock()
  const handle = await lock.acquire(lockPath(ctx.home), { timeoutMs: LOCK_TIMEOUT_MS, staleMs: STALE_LOCK_MS })
  try {
    return await mission()
  } finally {
    handle.dispose()
  }
}

/**
 * Make `destination` resolve to `blob`: keep an existing link that already resolves to the blob,
 * else place a fresh temp symlink and rename it over the destination. When links are unsupported,
 * atomically write the blob's bytes. A destination that is a directory is cleared first.
 */
async function linkOrWrite(fs: ProvisionFs, blob: string, destination: string): Promise<void> {
  const parent = dirname(destination)
  const expected = relative(parent, blob)
  const current = await fs.readlink(destination)
  if (current !== undefined && resolve(parent, current) === resolve(blob)) return
  await fs.mkdir(parent)
  const info = await fs.stat(destination)
  if (info?.isDirectory === true) await fs.rm(destination, { recursive: true })
  // A temp name is retried once before falling back, so a stray temp never becomes a copy.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temp = join(parent, `${ATOMIC_TEMP_PREFIX}link-${String(process.pid)}-${String((linkSequence += 1))}`)
    await fs.rm(temp).catch(() => undefined)
    try {
      await fs.symlink(expected, temp)
      await fs.rename(temp, destination)
      return
    } catch {
      await fs.rm(temp).catch(() => undefined)
    }
  }
  await fs.atomicWrite(destination, await fs.readFile(blob))
}

/** Write `bytes` to a content-addressed `blob`, repairing a missing, directory or wrong-sized blob. */
async function writeBlob(fs: ProvisionFs, blob: string, bytes: Uint8Array): Promise<void> {
  const info = await fs.stat(blob)
  if (info?.isDirectory === true) await fs.rm(blob, { recursive: true })
  else if (info !== undefined && info.size === bytes.byteLength) return
  await fs.atomicWrite(blob, bytes)
}

/** Throw a `verify/failed` for the first file that is not provably usable. */
function verifyFailure(message: string): never {
  throw new ProvisionError('verify/failed', message)
}

/** Probe the `flat` layout from the sidecar alone: no network, no mutation. */
async function probeFlat(ctx: ProviderContext, item: ProvisionItem, spec: ModelCacheSpec): Promise<ProbeResult> {
  const dataDir = flatDataDir(ctx.home, item.target.root, spec.repo)
  const recordPath = join(flatSidecarDir(ctx.home, item.target.root, spec.repo), RECORD_FILE)
  try {
    if (!(await exists(ctx.fs, recordPath))) return { found: false }
    const record = decodeRecord(await ctx.fs.readFile(recordPath))
    if (record === undefined || record.repo !== spec.repo) return { found: false }
    const revision = spec.revision ?? DEFAULT_REVISION
    const pinned = isSha(revision) ? revision : undefined
    if (pinned === undefined ? record.revision !== revision : record.sha !== pinned) return { found: false }
    for (const file of [...new Set([...record.files, ...requiredFilesOf(spec)])]) {
      const path = fileUnder(dataDir, file)
      const info = await ctx.fs.stat(path)
      if (info === undefined || info.isDirectory || info.size === 0) return { found: false }
      const expected = record.digests[file]
      // A link must name the recorded digest; a real file is proven by `verify` instead.
      if (expected !== undefined) {
        const link = await ctx.fs.readlink(path)
        if (link !== undefined && basename(resolve(dirname(path), link)) !== expected) return { found: false }
      }
    }
    return { found: true, version: record.sha, dir: dataDir, source: 'managed' }
  } catch {
    // A malformed record or an unsafe path is a miss, not a crash.
    return { found: false }
  }
}

/** Prove every required snapshot entry is its content-addressed blob, without touching the network. */
async function verifyHub(ctx: ProviderContext, item: ProvisionItem, spec: ModelCacheSpec, resolved: Resolved): Promise<void> {
  const blobs = join(hubRoot(ctx.home, item.target.root, spec.repo), 'blobs')
  for (const file of requiredFilesOf(spec)) {
    const path = fileUnder(resolved.entryDir, file)
    const info = await ctx.fs.stat(path)
    if (info === undefined) verifyFailure(`模型文件缺失 ${file}：${resolved.entryDir}`)
    if (info.isDirectory) verifyFailure(`模型文件是目录 ${file}：${path}`)
    if (info.size === 0) verifyFailure(`模型文件为空 ${file}：${path}`)
    const digest = sha256Hex(await ctx.fs.readFile(path))
    const link = await ctx.fs.readlink(path)
    if (link !== undefined) {
      // The entry resolves into blobs, so the read above already proved the blob's bytes.
      const target = resolve(dirname(path), link)
      if (!isInside(blobs, target)) verifyFailure(`模型文件的链接指向 blobs 之外：${path}`)
      const named = basename(target)
      if (!BLOB_PATTERN.test(named)) verifyFailure(`模型文件的链接目标名不是 sha256：${path}`)
      if (digest !== named) verifyFailure(`模型文件内容与 blob 名不符 ${file}：${path}`)
      continue
    }
    // A real-file fallback carries no expectation; the blob named by its digest must exist intact.
    const blobPath = join(blobs, digest)
    const blobInfo = await ctx.fs.stat(blobPath)
    if (blobInfo === undefined || blobInfo.isDirectory || blobInfo.size === 0) verifyFailure(`blob 缺失或为空：${blobPath}`)
    if (sha256Hex(await ctx.fs.readFile(blobPath)) !== digest) verifyFailure(`blob 内容与名字不符：${blobPath}`)
  }
}

/** Prove every required `flat` entry matches its recorded digest or the blob its link names. */
async function verifyFlat(ctx: ProviderContext, item: ProvisionItem, spec: ModelCacheSpec): Promise<void> {
  const dataDir = flatDataDir(ctx.home, item.target.root, spec.repo)
  const blobs = join(flatSidecarDir(ctx.home, item.target.root, spec.repo), 'blobs')
  let record: FlatRecord | undefined
  try {
    record = decodeRecord(await ctx.fs.readFile(join(flatSidecarDir(ctx.home, item.target.root, spec.repo), RECORD_FILE)))
  } catch {
    record = undefined
  }
  const digests = record?.digests ?? {}
  for (const file of requiredFilesOf(spec)) {
    const path = fileUnder(dataDir, file)
    const info = await ctx.fs.stat(path)
    if (info === undefined) verifyFailure(`模型文件缺失 ${file}：${dataDir}`)
    if (info.isDirectory) verifyFailure(`模型文件是目录 ${file}：${path}`)
    if (info.size === 0) verifyFailure(`模型文件为空 ${file}：${path}`)
    const digest = sha256Hex(await ctx.fs.readFile(path))
    const link = await ctx.fs.readlink(path)
    if (link !== undefined) {
      // The entry resolves into the sidecar, so the read above already proved the blob's bytes.
      const target = resolve(dirname(path), link)
      if (!isInside(blobs, target)) verifyFailure(`模型文件的链接指向 blobs 之外：${path}`)
      const named = basename(target)
      if (!BLOB_PATTERN.test(named)) verifyFailure(`模型文件的链接目标名不是 sha256：${path}`)
      if (digest !== named) verifyFailure(`模型文件内容与 blob 名不符 ${file}：${path}`)
    }
    // A names-only record cannot prove content; a recorded digest always can.
    const expected = digests[file]
    if (expected !== undefined && digest !== expected) verifyFailure(`模型文件内容与 record.json 不符 ${file}：${path}`)
  }
}

/** Build the built-in model-cache provider. */
export function modelCacheProvider(options: { readonly id?: string } = {}): Provider {
  const id = options.id ?? '@avantf/dsh-plugin-base/model-cache'
  return {
    id,
    kinds: [MODEL_CACHE_KIND],

    identify(item) {
      const spec = parseSpec(item)
      return { name: spec.repo, range: spec.revision ?? DEFAULT_REVISION }
    },

    targetDir(_item, ref) {
      return `${cacheDirName(ref.name)}/${ref.segment}`
    },

    plan(): ProviderPlan {
      return { action: 'install' }
    },

    async probe(item, ctx): Promise<ProbeResult> {
      const spec = parseSpec(item)
      const layout = layoutOf(spec)
      if (layout === FLAT_LAYOUT) return probeFlat(ctx, item, spec)
      const root = hubRoot(ctx.home, item.target.root, spec.repo)
      const snapshot = await findSnapshot(ctx, root, spec)
      if (snapshot === undefined) return { found: false }
      for (const file of requiredFilesOf(spec)) {
        const info = await ctx.fs.stat(fileUnder(snapshot, file))
        if (info === undefined || info.isDirectory || info.size === 0) return { found: false }
      }
      const version = snapshot.split(/[\\/]/).pop()
      return { found: true, ...(version === undefined ? {} : { version }), dir: snapshot, source: 'managed' }
    },

    async install(item, ctx: InstallContext): Promise<Resolved> {
      const spec = parseSpec(item)
      assertEndpoint(spec)
      const layout = layoutOf(spec)
      const endpoints = endpointsOf(spec, ctx.policy)
      // A declared list is validated before any network use, so an empty one fails as `invalid-option`.
      const declared = declaredFiles(spec)
      const sha = await resolveRevision(ctx, spec)
      const files = [...new Set(declared ?? (await listFiles(ctx, spec)))]
      const revision = spec.revision ?? DEFAULT_REVISION

      if (layout === FLAT_LAYOUT) {
        const dataDir = flatDataDir(ctx.home, item.target.root, spec.repo)
        const sidecar = flatSidecarDir(ctx.home, item.target.root, spec.repo)
        const blobs = join(sidecar, 'blobs')
        await ctx.fs.mkdir(blobs)
        const placements: Placement[] = []
        for (const file of files) {
          const bytes = await downloadFile(ctx, endpoints, spec.repo, sha, file)
          ctx.onProgress?.({ key: `${MODEL_CACHE_KIND}+${spec.repo}`, phase: 'download', loaded: bytes.byteLength, total: bytes.byteLength })
          const digest = sha256Hex(bytes)
          const blob = join(blobs, digest)
          // Content-addressed blobs are written atomically.
          await writeBlob(ctx.fs, blob, bytes)
          placements.push({ file, blob, digest })
        }
        // Placement and the completion marker are one critical section.
        await withLock(ctx, async () => {
          for (const placement of placements) await linkOrWrite(ctx.fs, placement.blob, fileUnder(dataDir, placement.file))
          await sweepAtomicTemps(ctx.fs, sidecar)
          await ctx.fs.atomicWrite(
            join(sidecar, RECORD_FILE),
            encodeRecord({
              schemaVersion: RECORD_SCHEMA_VERSION,
              repo: spec.repo,
              revision,
              sha,
              files,
              digests: Object.fromEntries(placements.map(placement => [placement.file, placement.digest])),
            }),
          )
        })
        return { name: spec.repo, version: sha, dir: dataDir, entryDir: dataDir, source: 'installed' }
      }

      const root = hubRoot(ctx.home, item.target.root, spec.repo)
      const snapshot = join(root, 'snapshots', sha)
      const blobs = join(root, 'blobs')
      await ctx.fs.mkdir(blobs)
      await ctx.fs.mkdir(snapshot)
      const placements: Placement[] = []
      for (const file of files) {
        const bytes = await downloadFile(ctx, endpoints, spec.repo, sha, file)
        ctx.onProgress?.({ key: `${MODEL_CACHE_KIND}+${spec.repo}`, phase: 'download', loaded: bytes.byteLength, total: bytes.byteLength })
        const digest = sha256Hex(bytes)
        const blob = join(blobs, digest)
        // Content-addressed blobs are written atomically.
        await writeBlob(ctx.fs, blob, bytes)
        placements.push({ file, blob, digest })
      }
      // Snapshot links and the ref marker are one critical section.
      await withLock(ctx, async () => {
        for (const placement of placements) await linkOrWrite(ctx.fs, placement.blob, fileUnder(snapshot, placement.file))
        await sweepAtomicTemps(ctx.fs, join(root, 'refs'))
        await ctx.fs.mkdir(join(root, 'refs'))
        await ctx.fs.atomicWrite(join(root, 'refs', revision), new TextEncoder().encode(sha))
      })

      // This kind bypasses `publish()`: no `install.json`, and `dir` is this snapshot.
      return { name: spec.repo, version: sha, dir: snapshot, entryDir: snapshot, source: 'installed' }
    },

    async verify(item, resolved, ctx): Promise<void> {
      const spec = parseSpec(item)
      if (layoutOf(spec) === FLAT_LAYOUT) return verifyFlat(ctx, item, spec)
      return verifyHub(ctx, item, spec, resolved)
    },
  }
}
