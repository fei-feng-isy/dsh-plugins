/**
 * Network helpers for providers: fetch injection, mirrors and digests.
 * @module net
 */
import { createHash } from 'node:crypto'
import { ProvisionError } from './errors.js'
import type { ProgressEvent, ProviderContext } from './types.js'

/** The `fetch` a provider should use: the injected one, else the process global. */
export function fetchImplOf(ctx: ProviderContext): typeof fetch {
  const impl = ctx.fetch ?? globalThis.fetch
  if (impl === undefined) throw new ProvisionError('fetch/failed', '运行环境没有 fetch，且未注入')
  return impl
}

/** Default hard byte cap for one downloaded body. */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

/** Default per-request timeout in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

/** Combine the caller's `AbortSignal` with a timeout signal. */
export function signalFor(ctx: ProviderContext, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return ctx.signal === undefined ? timeout : AbortSignal.any([ctx.signal, timeout])
}

/** Read a response body with a hard byte cap; throws `fetch/failed` when the cap is crossed. */
export async function readCapped(
  response: Response,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProvisionError('fetch/failed', `响应声明 ${String(declared)} 字节，超过上限 ${String(maxBytes)}`)
  }
  const body = response.body
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      throw new ProvisionError('fetch/failed', `响应 ${String(bytes.byteLength)} 字节，超过上限 ${String(maxBytes)}`)
    }
    if (Number.isFinite(declared) && declared !== bytes.byteLength) {
      throw new ProvisionError('fetch/failed', `响应声明 ${String(declared)} 字节，实际收到 ${String(bytes.byteLength)} 字节`)
    }
    return bytes
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new ProvisionError('fetch/failed', `响应超过上限 ${String(maxBytes)} 字节（已读 ${String(total)}）`)
    }
    chunks.push(value)
  }
  if (Number.isFinite(declared) && declared !== total) {
    throw new ProvisionError('fetch/failed', `响应声明 ${String(declared)} 字节，实际收到 ${String(total)} 字节`)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** `{url}` templates → concrete URLs, official source first. */
export function candidateUrls(url: string, mirrors: readonly string[] | undefined): readonly string[] {
  const candidates = [url]
  for (const template of mirrors ?? []) {
    const candidate = template.includes('{url}') ? template.replaceAll('{url}', url) : `${template}${url}`
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }
  return candidates
}

/** Download the first candidate that answers 2xx; throws `fetch/failed` when none does. */
export async function downloadBytes(
  ctx: ProviderContext,
  urls: readonly string[],
  key: string,
  onProgress?: (event: ProgressEvent) => void,
): Promise<{ readonly bytes: Uint8Array; readonly url: string }> {
  const problems: string[] = []
  for (const url of urls) {
    try {
      const response = await fetchImplOf(ctx)(url, { signal: signalFor(ctx) })
      if (!response.ok) {
        problems.push(`${url} → HTTP ${String(response.status)}`)
        continue
      }
      const bytes = await readCapped(response)
      onProgress?.({ key, phase: 'download', loaded: bytes.byteLength, total: bytes.byteLength })
      return { bytes, url }
    } catch (error) {
      problems.push(`${url} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new ProvisionError('fetch/failed', `所有候选源都失败：${problems.join('; ')}`)
}

/** Verify a hex sha256 of an archive. */
export function verifySha256(bytes: Uint8Array, expected: string): void {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected.toLowerCase()) {
    throw new ProvisionError('archive/integrity-mismatch', `sha256 不匹配：期望 ${expected}，实际 ${actual}`)
  }
}

/** `${platform}-${arch}`, the pack key (`linux-x64`, `darwin-arm64`, `win32-x64`, …). */
export function platformKey(): string {
  return `${process.platform}-${process.arch}`
}
