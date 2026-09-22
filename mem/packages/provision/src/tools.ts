/**
 * Installing a versioned binary artifact: fetch → digest → extract → atomically publish → probe.
 *
 * The layout is `~/.avantf/tools/<id>/<version>/`, with the executable always copied to
 * `bin/<binary>` so callers get one stable path regardless of how the release archive is arranged
 * (pandoc's Linux tarball puts it under `pandoc-3.11/bin/`, its Windows zip puts it at the root).
 * Versions live in separate directories on purpose: an upgrade installs beside the old one, so a
 * rollback is a config change rather than a re-download.
 *
 * @module tools
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ProvisionError, describeError } from './errors.js'
import { downloadAnySource, extractArchive, makeScratch, publishAtomically } from './fetch.js'
import { PROBE_TIMEOUT_MS } from './platform.js'
import type { ArchivePack, InstallContext, ProvisionConfig } from './types.js'

/** The version directory: `<toolsDir>/<id>/<version>`. */
export function versionDir(toolsDir: string, id: string, version: string): string {
  return join(toolsDir, id, version)
}

/** The stable location of a versioned binary's executable. */
export function binaryPath(toolsDir: string, id: string, version: string, binary: string): string {
  return join(versionDir(toolsDir, id, version), 'bin', binary)
}

/** Resolve `relative` under `root`, refusing an escape (`..`, an absolute path). */
function insideDirectory(root: string, relative: string, artifact: string): string {
  const parts = relative.split('/').filter(part => part !== '' && part !== '.')
  if (parts.includes('..')) {
    throw new ProvisionError('extract', artifact, `pack 的 binary 路径不能包含 ..：${relative}`)
  }
  return join(root, ...parts)
}

/**
 * Find the extracted executable, trying the pack's `binary` path (if given) and then a shallow
 * recursive search by file name.
 *
 * The search is bounded (depth 4) and only accepts an exact file-name match, because a release
 * tarball's top directory name is a version string that changes every release — hard-coding it would
 * turn this release's pack into next release's install failure.
 */
function locateBinary(root: string, binary: string, declared: string | undefined, artifact: string): string {
  if (declared !== undefined) {
    const candidate = insideDirectory(root, declared, artifact)
    const stat = statSync(candidate, { throwIfNoEntry: false })
    if (stat !== undefined && stat.isFile()) return candidate
  }
  const wanted = new Set([binary, `${binary}.exe`])
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const entry of readdirSync(current.dir, { withFileTypes: true })) {
      const full = join(current.dir, entry.name)
      if (entry.isFile() && wanted.has(entry.name)) return full
      if (entry.isDirectory() && current.depth < 4) queue.push({ dir: full, depth: current.depth + 1 })
    }
  }
  throw new ProvisionError(
    'extract',
    artifact,
    declared === undefined
      ? `解压后找不到可执行文件 ${binary}`
      : `解压后找不到可执行文件：pack 写的 ${declared} 不存在，按文件名 ${binary} 也没找到`,
  )
}

/**
 * Install one binary artifact into `<toolsDir>/<id>/<version>/bin/<binary>`.
 *
 * Everything happens in a scratch directory and is published with one rename, so an interrupted
 * install leaves either the previous state or nothing — never a partial tool that later looks
 * "present". The scratch directory is removed on every path out, including failure.
 */
export async function installBinaryArtifact(options: {
  artifact: string
  toolsDir: string
  version: string
  binary: string
  pack: ArchivePack
  config: ProvisionConfig
  logger: InstallContext['logger']
}): Promise<string> {
  const { artifact, toolsDir, version, binary, pack, config, logger } = options
  const target = versionDir(toolsDir, artifact, version)
  const scratch = makeScratch(toolsDir, artifact)
  try {
    const archivePath = join(scratch.dir, basename(new URL(pack.url).pathname))
    logger.info(`provision[${artifact}]: 下载 ${pack.url}（${String(pack.bytes)} 字节）`)
    await downloadAnySource(pack, config, archivePath, artifact)
    logger.info(`provision[${artifact}]: sha256 校验通过`)

    const unpacked = join(scratch.dir, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    await extractArchive(pack, archivePath, unpacked, artifact)

    const staged = join(scratch.dir, 'staged')
    const stagedBin = join(staged, 'bin')
    mkdirSync(stagedBin, { recursive: true })
    const found = locateBinary(unpacked, binary, pack.binary, artifact)
    copyFileSync(found, join(stagedBin, basename(found)))
    // `copyFileSync` carries the mode on Linux/macOS; an explicit chmod keeps the executable bit
    // even when the source arrived through a filesystem that drops it (a zip on some tooling).
    chmodSync(join(stagedBin, basename(found)), 0o755)

    publishAtomically(staged, target, artifact)
    logger.info(`provision[${artifact}]: 已原子落盘到 ${target}`)
    return binaryPath(toolsDir, artifact, version, binary)
  } catch (error) {
    // Defence in depth: `publishAtomically` already refuses a partial rename, but a failure between
    // "target removed" and "rename" would otherwise leave nothing where the previous install was.
    if (existsSync(target) && !existsSync(binaryPath(toolsDir, artifact, version, binary))) {
      rmSync(target, { recursive: true, force: true })
    }
    throw error
  } finally {
    scratch.dispose()
  }
}

/** The outcome of running an artifact's own probe. */
export interface ProbeOutcome {
  ok: boolean
  /** Combined stdout/stderr, trimmed; the observed output on failure. */
  output: string
  /** Exit status when the process ran, or undefined when it never started/timed out. */
  status?: number
}

/**
 * Run `command args…` and report the outcome WITHOUT throwing on a non-zero exit.
 *
 * No shell: `execFileSync` takes an argument array, so a path with spaces or a quote in it is one
 * argument. A probe that cannot start (ENOENT, no execute permission) is a failure with the OS error
 * in `output`, not an exception — `verify` turns it into an artifact-specific message.
 */
export function runProbe(command: string, args: readonly string[], timeoutMs = PROBE_TIMEOUT_MS): ProbeOutcome {
  try {
    const stdout = execFileSync(command, [...args], { stdio: 'pipe', timeout: timeoutMs, encoding: 'utf8' })
    return { ok: true, output: stdout.trim() }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string; signal?: string }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
    return {
      ok: false,
      output: output !== '' ? output : describeError(error),
      ...(typeof failure.status === 'number' ? { status: failure.status } : {}),
    }
  }
}
