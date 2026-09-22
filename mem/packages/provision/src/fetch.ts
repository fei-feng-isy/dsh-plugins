/**
 * Fetching, digest verification, extraction, and atomic publication — the plumbing every artifact
 * install shares.
 *
 * The stages are deliberately separable because each failure has a different fix, and the code must
 * be able to say WHICH one failed: a wrong URL, a wrong digest, a truncated archive, or an archive
 * whose layout is not what the artifact's `binary` path claims. Each stage therefore names itself in
 * its error.
 *
 * @module fetch
 */
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { ProvisionError, describeError } from './errors.js'
import { extractZip } from './zip.js'
import type { ArchivePack, ProvisionConfig } from './types.js'

/** How long the whole download may take. A stalled mirror must not hold startup forever. */
const DOWNLOAD_TIMEOUT_MS = 600_000

/** A URL for a mirror template: `{url}` is the original URL, `{file}` its last path segment. */
export function mirrorUrl(template: string, original: string): string {
  const file = original.split('/').pop() ?? original
  return template.split('{url}').join(original).split('{file}').join(file)
}

/** The candidate URLs for one pack: mirrors first (domestic by default), the official source last. */
export function sourceUrls(pack: ArchivePack, config: ProvisionConfig): string[] {
  const urls = config.mirror.filter(template => template.trim() !== '').map(template => mirrorUrl(template, pack.url))
  urls.push(pack.url)
  return [...new Set(urls)]
}

/** Download one URL to `dest`, verifying the declared digest and size — thumbprint or nothing. */
export async function fetchToFile(
  url: string,
  dest: string,
  expected: { sha256: string; bytes: number },
  artifact: string,
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    throw new ProvisionError('fetch', artifact, `无法连接 ${url}：${describeError(error)}`)
  }
  if (!response.ok) {
    throw new ProvisionError('fetch', artifact, `${url} 返回 HTTP ${String(response.status)} ${response.statusText}`)
  }
  if (response.body === null) {
    throw new ProvisionError('fetch', artifact, `${url} 返回了空响应体`)
  }
  const hash = createHash('sha256')
  let bytes = 0
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    hash.update(chunk)
  })
  try {
    await pipeline(source, createWriteStream(dest))
  } catch (error) {
    rmSync(dest, { force: true })
    throw new ProvisionError('fetch', artifact, `${url} 下载中断：${describeError(error)}`)
  }
  // The size check runs BEFORE the digest: it names the likeliest cause (a truncated transfer or an
  // HTML error page saved as an archive) instead of merely reporting a mismatch.
  if (bytes !== expected.bytes) {
    rmSync(dest, { force: true })
    throw new ProvisionError(
      'verify-checksum',
      artifact,
      `${url} 得到 ${String(bytes)} 字节，期望 ${String(expected.bytes)} 字节（下载被截断或该地址返回的不是归档）`,
    )
  }
  const actual = hash.digest('hex')
  if (actual !== expected.sha256) {
    rmSync(dest, { force: true })
    throw new ProvisionError(
      'verify-checksum',
      artifact,
      `sha256 不符：${url} 得到 ${actual}，期望 ${expected.sha256}（镜像可能被篡改或缓存了旧版本）`,
    )
  }
}

/**
 * Download from the first working source into `dest`.
 *
 * Failures are ACCUMULATED, not swallowed: every candidate is tried because the point of a mirror
 * list is that one of them may be down, but if none works the error carries the whole list of
 * `url → reason` so the operator sees whether it was DNS, a TLS interception, or a 404.
 */
export async function downloadAnySource(
  pack: ArchivePack,
  config: ProvisionConfig,
  dest: string,
  artifact: string,
): Promise<void> {
  const urls = sourceUrls(pack, config)
  const failures: string[] = []
  for (const url of urls) {
    try {
      await fetchToFile(url, dest, pack, artifact)
      return
    } catch (error) {
      failures.push(describeError(error))
    }
  }
  throw new ProvisionError(
    'fetch',
    artifact,
    `所有下载源都失败（${String(urls.length)} 个）：\n${failures.map(line => `  - ${line}`).join('\n')}`,
  )
}

/**
 * Extract a `.tar.gz` archive into `destination`.
 *
 * `tar` is used where it exists because it is correct (hardlinks, permissions, extended headers) and
 * ships with Linux and macOS; Windows 10+ carries `bsdtar` as `tar` as well. Windows artifacts use
 * the zip path (see {@link extractArchive}).
 */
export function extractTarGz(archive: string, destination: string, artifact: string): void {
  mkdirSync(destination, { recursive: true })
  try {
    execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'pipe', timeout: 300_000 })
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr
    const detail = stderr === undefined ? describeError(error) : stderr.toString('utf8').trim()
    throw new ProvisionError('extract', artifact, `tar 解压失败：${detail}`)
  }
}

/** Extract one pack's archive into `destination`, dispatching on the pack's declared format. */
export async function extractArchive(
  pack: ArchivePack,
  archive: string,
  destination: string,
  artifact: string,
): Promise<void> {
  if (pack.format === 'tar.gz') {
    extractTarGz(archive, destination, artifact)
    return
  }
  if (pack.format === 'zip') {
    await extractZip(archive, destination, artifact)
    return
  }
  throw new ProvisionError('extract', artifact, `pack 的 format 是 ${String(pack.format)}，无法解压`)
}

/**
 * Atomically publish a fully-built directory as the artifact's version directory.
 *
 * `renameSync` inside one filesystem is atomic, so a reader (another process, or the next `ensure`)
 * sees either the old state or the complete new one — never a half-written tool. A pre-existing
 * target is REPLACED: a retry after a failed verification must not be blocked by the wreckage of the
 * previous attempt.
 */
export function publishAtomically(staging: string, target: string, artifact: string): void {
  mkdirSync(dirname(target), { recursive: true })
  rmSync(target, { recursive: true, force: true })
  try {
    renameSync(staging, target)
  } catch (error) {
    throw new ProvisionError('extract', artifact, `原子落盘失败（${staging} → ${target}）：${describeError(error)}`)
  }
}

/**
 * A scratch directory for one install attempt, plus a cleanup that always runs.
 *
 * It is created under the managed root's `.tmp/` (same filesystem, so the final rename is a real
 * rename rather than a copy) with a per-process, per-attempt name. The `finally` removes it, which is
 * what keeps a failed install from leaving residue behind.
 */
export interface Scratch {
  dir: string
  dispose(): void
}

export function makeScratch(toolsDir: string, id: string): Scratch {
  const base = `${toolsDir}/.tmp`
  mkdirSync(base, { recursive: true })
  const dir = `${base}/${id}-${String(process.pid)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    dispose(): void {
      rmSync(dir, { recursive: true, force: true })
      // Remove `.tmp` itself when this was its last child, so an idle tools directory stays clean.
      try {
        if (statSync(base).isDirectory() && readdirSync(base).length === 0) rmdirSync(base)
      } catch {
        // Another attempt is using it, or it is gone; either way not an error.
      }
    },
  }
}
