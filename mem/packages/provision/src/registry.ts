/**
 * The artifact registry: resolution, installation, verification, and the startup sweep.
 *
 * Registration order is not precedence (each artifact is asked about itself by id), but `ensure`
 * resolves in a FIXED order that is the whole point of the module:
 *
 *   ① an explicit path from config → ② the managed copy under `~/.avantf/tools` → ③ a system
 *   installation on `PATH` → ④ explicit failure naming every platform's install command.
 *
 * Step ④ is where this differs from a convenience installer: a missing tool must never be papered
 * over by "using whatever is there", because a different pandoc version produces a different corpus
 * from the same input. Silence is a correctness bug here, not a nicety.
 *
 * @module registry
 */
import { isAbsolute, join } from 'node:path'
import { ProvisionError, describeError } from './errors.js'
import { fetchToFile } from './fetch.js'
import { installBinaryArtifact, runProbe, versionDir } from './tools.js'
import { applyToolsEnv } from './config.js'
import { currentPlatform, findOnPath, isExecutableFile, packKey } from './platform.js'
import type {
  ArchivePack,
  Artifact,
  ArtifactSource,
  EnsureOptions,
  EnsureResult,
  PlatformKey,
  ProvisionConfig,
  ProvisionLogger,
} from './types.js'

const REGISTRY: Artifact[] = []

/** Add an artifact. A duplicate id is a programming error (the second would be unreachable). */
export function registerArtifact(artifact: Artifact): void {
  if (REGISTRY.some(existing => existing.id === artifact.id)) {
    throw new Error(`provision artifact id 重复注册：${artifact.id}`)
  }
  REGISTRY.push(artifact)
}

/** The registered artifacts, in registration order (a copy — callers cannot reorder the registry). */
export function artifacts(): readonly Artifact[] {
  return [...REGISTRY]
}

/** True when `id` is registered. */
export function hasArtifact(id: string): boolean {
  return REGISTRY.some(artifact => artifact.id === id)
}

/** Look one up, or throw naming what IS registered. */
export function artifactById(id: string): Artifact {
  const found = REGISTRY.find(artifact => artifact.id === id)
  if (found === undefined) {
    throw new ProvisionError('resolve', id, `未注册；已注册的是：${REGISTRY.map(a => a.id).join(', ') || '(空)'}`)
  }
  return found
}

/** The pack for a platform, or a failure that names the platform and what DOES have a pack. */
export function packFor(artifact: Artifact, platform: PlatformKey = currentPlatform()): ArchivePack {
  const key = packKey(platform)
  const pack = artifact.packs?.[key]
  if (pack === undefined) {
    const available = Object.keys(artifact.packs ?? {}).sort()
    throw new ProvisionError(
      'resolve',
      artifact.id,
      `没有 ${key} 的发布包${available.length === 0 ? '（该 artifact 未声明任何平台包）' : `；已声明的平台：${available.join(', ')}`}`,
    )
  }
  return pack
}

/** A binary artifact's own executable: the name on PATH, the managed layout, and the version probe. */
export interface BinarySpec {
  /** Executable file name (`pandoc`, `soffice`). */
  binary: string
  /** Arguments of the version probe (`['--version']`). */
  versionArgs: readonly string[]
  /**
   * The `--version` output must contain this (the exact version that was pinned). Omitted for a tool
   * this project only DETECTS (LibreOffice): a detection has no pinned rendering to protect.
   */
  versionMarker?: string
  /** Environment variable holding an explicit path to this tool (`AVANTF_PANDOC`). */
  envVar: string
  /** Config key that may hold an explicit path, quoted in the "your path is stale" message. */
  configPath?: string
}

/** How a binary was resolved, or why it could not be. */
export type BinaryResolution =
  | { ok: true; path: string; source: ArtifactSource; version?: string }
  | { ok: false; reason: string }

/** The manifest every binary artifact's install writes, so a later `managedPath` can be trusted. */
export const INSTALL_MANIFEST = 'install.json'

/** What {@link installBinaryArtifact} records next to the executable. */
export interface InstallManifest {
  id: string
  version: string
  binary: string
  url: string
  sha256: string
  /** ISO date of the install, so a hand-placed directory can be told from a fetched one. */
  installed_at: string
}

/**
 * Resolve a binary through the fixed order above, WITHOUT installing anything.
 *
 * Exported because some callers only want to know (the UI's "is pandoc available?" line, the
 * LibreOffice probe) and because `ensure` is built on it.
 */
export function resolveBinary(
  spec: BinarySpec,
  options: { toolsDir: string; artifact: Artifact; explicit?: string; platform?: PlatformKey },
): BinaryResolution {
  const { toolsDir, artifact, explicit } = options
  const configured = explicit ?? process.env[spec.envVar]
  if (configured !== undefined && configured.trim() !== '') {
    const path = configured.trim()
    if (!isExecutableFile(path)) {
      // Step ① is a promise the operator made; a stale path must be reported, not skipped over —
      // silently falling through to a different pandoc is the cross-machine divergence in disguise.
      return { ok: false, reason: `配置指定的路径不存在或不可执行：${path}（来自 ${spec.configPath ?? spec.envVar}）` }
    }
    return probeCandidate(spec, path, 'explicit')
  }
  // ② the managed copy: only counted when it reports the PINNED version, so a stale directory under
  // `~/.avantf/tools` cannot shadow the correct one and a wrong-version install is re-installed.
  const rejected: string[] = []
  const managed = managedBinaryPath(spec, artifact, toolsDir)
  if (managed !== undefined && isExecutableFile(managed)) {
    const considered = probeCandidate(spec, managed, 'managed')
    if (considered.ok) return { ...considered, version: considered.version ?? artifact.version }
    rejected.push(considered.reason)
  }
  // ③ a system installation, held to the same version rule (`pandoc 3.1` renders differently).
  const onPath = findOnPath(spec.binary, options.platform?.os ?? process.platform)
  if (onPath !== undefined) {
    const considered = probeCandidate(spec, onPath, 'system')
    if (considered.ok) return considered
    rejected.push(considered.reason)
  }
  // A candidate that exists but is the WRONG VERSION is reported as such: "nothing found" would send
  // the operator looking for a missing file when the fix is a version mismatch.
  return {
    ok: false,
    reason: rejected.length === 0
      ? '既没有配置指定，也不在受管目录或 PATH 上'
      : `受管目录与 PATH 上都没有符合要求的版本：${rejected.join('；')}`,
  }
}

/**
 * Probe one candidate and check its version against the pin.
 *
 * An artifact with no pin (`versionMarker` undefined) accepts any runnable candidate; one with a pin
 * accepts only a runnable candidate whose `--version` output carries the marker. The marker is why a
 * wrong-version binary is not "present": the whole point of pinning is that the version is load
 * bearing, and a silent fallback to another one changes the output.
 */
function probeCandidate(spec: BinarySpec, path: string, source: ArtifactSource): BinaryResolution {
  const probe = runProbe(path, spec.versionArgs)
  if (!probe.ok) {
    return { ok: false, reason: `${path} 无法执行：${probe.output}` }
  }
  const version = firstLine(probe.output)
  if (spec.versionMarker !== undefined && spec.versionMarker !== '' && !probe.output.includes(spec.versionMarker)) {
    return { ok: false, reason: `${path} 的版本不是 ${spec.versionMarker}：${version}（跨版本转换结果不可比）` }
  }
  return { ok: true, path, source, version }
}

/** Where a versioned artifact's executable lives, or `undefined` for a layout-less artifact. */
export function managedBinaryPath(spec: BinarySpec, artifact: Artifact, toolsDir: string): string | undefined {
  if (artifact.version === undefined) return undefined
  return join(versionDir(toolsDir, artifact.id, artifact.version), 'bin', spec.binary)
}

/** The first non-empty line of a probe's output (pandoc's `pandoc 3.11`). */
function firstLine(output: string): string {
  return output.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
}

/**
 * The install command(s) to print when a binary cannot be provided.
 *
 * Every message names the OS-specific package manager, because the reader is a human on one machine
 * and "install pandoc" is not an instruction. A bare `{binary} --version` is offered as the check.
 */
export function installHints(spec: BinarySpec, platform: PlatformKey = currentPlatform()): string {
  if (spec.binary === 'pandoc') {
    const lines: Record<string, string[]> = {
      linux: [
        'Debian/Ubuntu：sudo apt install pandoc（仓库版本较旧，与本项目钉住的版本可能不同）',
        '静态包（不挑系统库）：从 https://github.com/jgm/pandoc/releases 取 pandoc-<版本>-linux-amd64.tar.gz，解压后把 bin/pandoc 放到 受管目录/pandoc/<版本>/bin/pandoc',
      ],
      darwin: ['Homebrew：brew install pandoc', '官方包：https://github.com/jgm/pandoc/releases 的 macOS zip/pkg'],
      win32: ['winget：winget install --source winget JohnMacFarlane.Pandoc', '官方 zip：https://github.com/jgm/pandoc/releases 的 pandoc-<版本>-windows-x86_64.zip'],
    }
    return (lines[platform.os] ?? ['见 https://pandoc.org/installing.html']).join('；')
  }
  return `请自行安装 ${spec.binary} 并确保它在 PATH 上`
}

/** Options for {@link ensure} / {@link ensureAll}. */
export interface EnsureArtifactOptions extends EnsureOptions {
  /** The managed root (`~/.avantf/tools` by default; see `resolveToolsDir`). */
  toolsDir: string
  config: ProvisionConfig
  logger: ProvisionLogger
  /** Explicit path for a binary artifact, from config or the environment. */
  explicit?: string
  /** Install even when something equivalent is already present. */
  force?: boolean
}

/** A no-op logger for callers that only care about the result. */
export const silentLogger: ProvisionLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** The install context one artifact is handed. */
/**
 * The pack an artifact that DECLARED packs must see. The registry resolves it before `install`, so a
 * missing one here means the artifact's own declaration and the install path disagree.
 */
export function requirePack(ctx: { pack?: ArchivePack }, id: string): ArchivePack {
  if (ctx.pack === undefined) throw new ProvisionError('resolve', id, '该 artifact 声明了发布包，但 install 时没有解析到')
  return ctx.pack
}

/**
 * The context one `install` runs with.
 *
 * `pack` is ABSENT for a layout-less artifact (no `packs`: the model warm-up, the LibreOffice
 * probe) — those install nothing from a release archive, so there is nothing to resolve and
 * `fetch` is a programming error rather than a silent no-op.
 */
export function installContext(options: EnsureArtifactOptions, artifact: Artifact, pack?: ArchivePack): {
  dir: string
  pack?: ArchivePack
  fetch: (url: string, dest: string) => Promise<void>
  config: ProvisionConfig
  logger: ProvisionLogger
  artifactEnv?: unknown
} {
  const dir = artifact.version === undefined ? options.toolsDir : versionDir(options.toolsDir, artifact.id, artifact.version)
  return {
    dir,
    ...(pack === undefined ? {} : { pack }),
    fetch: async (url, dest) => {
      if (pack === undefined) throw new ProvisionError('fetch', artifact.id, '该 artifact 没有声明发布包，不能下载')
      await fetchToFile(url, dest, pack, artifact.id)
    },
    config: options.config,
    logger: options.logger,
    ...(options.artifactEnv === undefined ? {} : { artifactEnv: options.artifactEnv }),
  }
}

/**
 * Make sure one artifact is usable, installing it when it is missing.
 *
 * The flow is `isPresent → (install → verify)` and nothing else: an artifact that installed
 * successfully but does not run is a FAILURE, not a success with a warning, because the alternative
 * is discovering it later inside a document conversion.
 */
export async function ensure(id: string, options: EnsureArtifactOptions): Promise<EnsureResult> {
  const started = Date.now()
  const artifact = artifactById(id)
  const logger = options.logger
  try {
    if (options.force !== true && await artifact.isPresent(options.artifactEnv)) {
      const location = await locate(artifact, options)
      logger.info(`provision[${id}]: 已就绪${location === undefined ? '' : `（${location}）`}，无需安装`)
      return { id, ok: true, elapsedMs: Date.now() - started, ...(location === undefined ? {} : { location }) }
    }
    // THE GATES APPLY ONLY TO ARTIFACTS THAT DOWNLOAD. `packs` is what "download" means here: an
    // artifact without packs acquires nothing from the network — the model warms from the local cache
    // (its own `semantic.auto_download` governs whether that may fetch) and LibreOffice is only
    // probed. Refusing those when the kill switch is set was a real regression: `model`'s
    // `isPresent()` is always false BY DESIGN (it must warm on every start), so it could never pass
    // resolve with downloads off, and retrieval silently degraded to FTS+entity on a machine that
    // had the model cached all along.
    if (artifact.packs !== undefined) {
      if (options.offline === true) {
        throw new ProvisionError('resolve', id, '离线模式（offline）下没有可用的安装，且不允许下载')
      }
      // The env kill switch is applied HERE rather than at each call site, so every path into a
      // download (the startup sweep, an `ensure` at the moment of use) is offline when it is set.
      if (applyToolsEnv(options.config).auto_install !== true) {
        throw new ProvisionError(
          'resolve',
          id,
          '本机没有可用的安装，且自动下载被关闭（tools.auto_install=false 或 AVANTF_MEM_AUTO_DOWNLOAD=0）',
        )
      }
    }
    // A layout-less artifact has no pack to resolve (and `packFor` would throw): it provides
    // itself from local state, which is exactly what the model warm-up does.
    const pack = artifact.packs === undefined ? undefined : packFor(artifact)
    const verb = artifact.verb ?? '安装'
      logger.info(`provision[${id}]: ${verb}中${pack === undefined ? '（本地）' : `（${packKey()}）`}`)
    await artifact.install(installContext(options, artifact, pack))
    const dir = artifact.version === undefined ? options.toolsDir : versionDir(options.toolsDir, artifact.id, artifact.version)
    await artifact.verify({
      dir,
      logger,
      ...(options.artifactEnv === undefined ? {} : { artifactEnv: options.artifactEnv }),
    })
    const location = await locate(artifact, options)
    logger.info(`provision[${id}]: ${verb}完成（${String(Date.now() - started)}ms）${location === undefined ? '' : ` → ${location}`}`)
    return { id, ok: true, source: 'installed', elapsedMs: Date.now() - started, ...(location === undefined ? {} : { location }) }
  } catch (error) {
    const message = describeError(error)
    logger.error(`provision[${id}]: 失败 — ${message}`)
    return { id, ok: false, error: message, elapsedMs: Date.now() - started }
  }
}

/**
 * An artifact's current location, when it knows one.
 *
 * Optional and best-effort: it is log/UI information, so an artifact that cannot answer (the model
 * warm-up) simply has no `location`. Declared structurally rather than on {@link Artifact} so an
 * artifact that has nothing to add does not have to write a stub.
 */
async function locate(artifact: Artifact, options: EnsureArtifactOptions): Promise<string | undefined> {
  const locator = artifact.location
  if (locator === undefined) return undefined
  try {
    return await locator.call(artifact, {
      toolsDir: options.toolsDir,
      ...(options.artifactEnv === undefined ? {} : { artifactEnv: options.artifactEnv }),
    })
  } catch {
    return undefined
  }
}

/**
 * Sweep every registered artifact, in registration order.
 *
 * Failures do NOT stop the sweep: a host that cannot download pandoc must still get its embedding
 * model, and the caller receives one result per artifact so the startup log can say exactly which
 * part of the toolchain is degraded. The sweep is sequential on purpose — two 35 MB downloads in
 * parallel compete for the same link, and registration order is the documented precedence.
 */
export async function ensureAll(options: EnsureArtifactOptions): Promise<EnsureResult[]> {
  const results: EnsureResult[] = []
  for (const artifact of artifacts()) results.push(await ensure(artifact.id, options))
  return results
}

/**
 * The startup form: fire the sweep, do not await it, report each artifact as it lands.
 *
 * Like the model warm-up it replaces, this must never delay the host's boot (the harness prints its
 * URL within milliseconds, and a 35 MB download belongs after that). The returned promise exists for
 * tests and for a caller that genuinely needs the outcome.
 */
/**
 * The summary's suffix for one artifact: the VERB it was provided with, or nothing at all.
 *
 * Only a fresh acquisition is labelled (`model=预热`, `pandoc=安装`) — that is the case the operator
 * has to know about, and the word matches the per-artifact lines above it. An artifact that was
 * already present prints as a bare id, because its provenance is already spelled out one line
 * earlier (`provision[pandoc]: 已就绪（…（managed））`).
 *
 * `EnsureResult.source` also has `explicit | managed | system` in its type; the sweep does not
 * populate those today (an already-present artifact returns without a source), so they are
 * deliberately not mapped here rather than mapped into labels nothing can produce.
 */
function sourceLabel(result: EnsureResult): string {
  if (result.source !== 'installed') return ''
  const verb = hasArtifact(result.id) ? artifactById(result.id).verb ?? '安装' : '安装'
  return `=${verb}`
}

export function ensureAllAsync(options: EnsureArtifactOptions): Promise<EnsureResult[]> {
  const { logger } = options
  logger.info(
    `provision: 启动预装已调度（非阻塞；artifact=${artifacts().map(a => a.id).join(', ') || '(空)'}，`
    + `受管目录=${options.toolsDir}，auto_install=${String(options.config.auto_install)}）`,
  )
  return ensureAll(options).then((results) => {
    const failed = results.filter(result => !result.ok)
    if (failed.length === 0) {
      logger.info(`provision: 全部就绪（${results.map(r => `${r.id}${sourceLabel(r)}`).join(', ')}）`)
    } else {
      logger.warn(`provision: ${String(failed.length)}/${String(results.length)} 未就绪 — ${failed.map(r => `${r.id}: ${r.error ?? ''}`).join(' | ')}`)
    }
    return results
  }).catch((error: unknown) => {
    // `ensure` already converts per-artifact failures into results; only a registry-level bug can
    // reach here, and it must be visible in the host log rather than an unhandled rejection.
    logger.error(`provision: 预装调度失败 — ${describeError(error)}`)
    return []
  })
}

/** `isAbsolute` and the PATH delimiter, re-exported so callers need not import `node:path`. */
export { isAbsolute as isAbsolutePath }
