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

/**
 * Combine the caller's `AbortSignal` with a timeout signal.
 *
 * `timeoutMs` (or, when omitted, the item's `policy.timeoutMs`) is the item's per-request budget;
 * an undeclared value keeps the 300 s default. `0` means NO timeout — the escape hatch a 4 GiB model
 * needs on a link slower than 14 MB/s, which the fixed default could never finish. `ctx.signal`
 * (shutdown/caller abort) still applies in every case.
 */
export function signalFor(ctx: ProviderContext, timeoutMs?: number): AbortSignal {
  const configured = timeoutMs ?? ctx.policy.timeoutMs
  if (configured === 0) {
    return ctx.signal ?? new AbortController().signal
  }
  const effective = configured === undefined || !Number.isFinite(configured) || configured < 0 ? DEFAULT_REQUEST_TIMEOUT_MS : configured
  const timeout = AbortSignal.timeout(effective)
  return ctx.signal === undefined ? timeout : AbortSignal.any([ctx.signal, timeout])
}

/**
 * Read a response body with a hard byte cap.
 *
 * Two failures that used to share `fetch/failed` are deliberately DIFFERENT codes, because a caller
 * has to treat them differently:
 *
 *   - the cap is crossed (declared `content-length`, or bytes actually read) → `fetch/too-large`, a
 *     TERMINAL failure: another mirror serves the same oversized object, so falling through cannot
 *     help;
 *   - the declared length does not match what was read → `fetch/failed`, a TRANSPORT failure: that is
 *     a truncated download, exactly the shape that should try the next candidate source.
 *
 * `docs/DESIGN.md` §6 states the same invariant; `providers/model.ts` and `downloadBytes` below are the
 * two places that branch on it.
 */
export async function readCapped(
  response: Response,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProvisionError('fetch/too-large', `响应声明 ${String(declared)} 字节，超过上限 ${String(maxBytes)}`)
  }
  const body = response.body
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      throw new ProvisionError('fetch/too-large', `响应 ${String(bytes.byteLength)} 字节，超过上限 ${String(maxBytes)}`)
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
      throw new ProvisionError('fetch/too-large', `响应超过上限 ${String(maxBytes)} 字节（已读 ${String(total)}）`)
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

/**
 * Download the first candidate that answers 2xx; throws `fetch/failed` when none does (and
 * `fetch/too-large` immediately when a body crosses the hard cap — see {@link readCapped}).
 *
 * DOWNLOADING IS THE SLOWEST THING THIS FRAMEWORK DOES and it used to be completely silent: a 223 MB
 * archive on a mirror that eventually times out looked like eight minutes of nothing, and the first
 * evidence of trouble was the final `fetch/failed` after every candidate had been tried (measured on
 * DSH Desktop — GitHub plus three mirrors, all aborted). One line per attempt, one when a candidate
 * is passed over with its reason, and one on success makes the wait legible while it is happening.
 */
export async function downloadBytes(
  ctx: ProviderContext,
  urls: readonly string[],
  key: string,
  onProgress?: (event: ProgressEvent) => void,
): Promise<{ readonly bytes: Uint8Array; readonly url: string }> {
  const problems: string[] = []
  for (const [index, url] of urls.entries()) {
    const position = `${String(index + 1)}/${String(urls.length)}`
    // The last candidate gets no "trying the next one" promise: there is none.
    const next = index + 1 < urls.length ? '，改用下一个候选源' : '，没有更多候选源'
    ctx.logger.info(`${key}：尝试候选源 ${position} ${url}`)
    try {
      const response = await fetchImplOf(ctx)(url, { signal: signalFor(ctx) })
      if (!response.ok) {
        problems.push(`${url} → HTTP ${String(response.status)}`)
        ctx.logger.warn(`${key}：${url} 返回 HTTP ${String(response.status)}${next}`)
        continue
      }
      // A short body is a TRANSPORT failure and retries the next mirror, like a bad status or a
      // network error — deliberately unlike an integrity check (those run in the providers and are
      // terminal: complete bytes with the wrong content do not get better at another URL). That
      // distinction IS the invariant; `docs/DESIGN.md` §6 states it in the same words.
      const bytes = await readCapped(response)
      onProgress?.({ key, phase: 'download', loaded: bytes.byteLength, total: bytes.byteLength })
      ctx.logger.info(`${key}：下载完成 ${String(bytes.byteLength)} 字节（${url}）`)
      return { bytes, url }
    } catch (error) {
      // The byte cap is the one fetch failure that is TERMINAL: every mirror serves the same
      // oversized object, so retrying just burns the remaining candidates. `readCapped` separates it
      // from a truncated body (`fetch/failed`) for exactly this branch.
      if (error instanceof ProvisionError && error.code === 'fetch/too-large') throw error
      const reason = error instanceof Error ? error.message : String(error)
      problems.push(`${url} → ${reason}`)
      ctx.logger.warn(`${key}：${url} 失败（${reason}）${next}`)
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
