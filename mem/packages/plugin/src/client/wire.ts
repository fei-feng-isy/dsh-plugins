/**
 * The client half's wire-revision diagnostics.
 *
 * WHY THE TWO HALVES DRIFT. The browser bundle is re-read on every page load; the host half is loaded
 * once, when `dsh web` starts. So a rebuilt client routinely talks to an older host, and the ONE
 * failure this must never produce is a bare gateway 404 — it reads exactly like "the record or the
 * file is gone", which it does not mean. The host stamps `WIRE_VERSION` (see `src/remote.ts`) onto
 * every answer; `unwrapRemoteEnvelope` carries it back; these functions turn "the numbers disagree"
 * into a sentence that names the remedy, and are also the gate a call added AFTER the marker uses to
 * refuse itself against a host that cannot have registered it.
 *
 * Kept free of React (this package's tests stay free of the DSH client runtime): the transport
 * edge is plain data in, plain text out.
 *
 * @module @avantf/dsh-mem/client/wire
 */
import { WIRE_VERSION } from '../remote.js'

/**
 * The version-skew note for a host's reported revision, or `undefined` when the two halves agree.
 *
 * A NOTE, not a throw: an unrecognized revision usually still carries the fields the panels render,
 * and blanking them is exactly the degradation the marker exists to avoid. `hostWire` is read off
 * the DECODED envelope (`unwrapRemoteEnvelope`), so `undefined` means "an older host that predates
 * the marker", never a decode failure.
 */
export function hostSkew(hostWire: unknown): string | undefined {
  if (hostWire === WIRE_VERSION) return undefined
  if (hostWire === undefined) {
    return '宿主没有回报 wire 版本（它比本客户端旧）：面板可能缺少新字段，重启 dsh web 让两半对齐。'
      + `（本客户端说 wire=${String(WIRE_VERSION)}）`
  }
  return `宿主回报的 wire 版本是 ${String(hostWire)}，本客户端只认识 ${String(WIRE_VERSION)}：`
    + '面板继续显示，但两半可能已经错位——重启 dsh web 后再试。'
}

/**
 * Whether a host reporting `hostWire` can have registered a method introduced at `required`.
 *
 * `undefined` is "no revision observed yet", and is reported as NOT supported by this predicate —
 * the caller decides whether "unknown" means "refuse" (see the gate in `client/index.ts`, which only
 * refuses when it has actually SEEN an older revision).
 */
export function hostSupports(hostWire: number | undefined, required: number): boolean {
  return hostWire !== undefined && hostWire >= required
}

/**
 * The sentence for a call this client refuses to SEND because the host's REPORTED revision predates
 * the method.
 *
 * The call is never sent, so this must not read as a transport failure: the host's own revision says
 * the method does not exist, and the remedy (restart dsh web) is specific. Only called with a known
 * revision — an unobserved one is sent and diagnosed by {@link transportHint} instead.
 */
export function staleHostText(hostWire: number, required: number, what: string): string {
  return `宿主仍在运行旧版本（wire ${String(hostWire)} < ${String(required)}）：`
    + `它还没有注册 ${what} 这条调用，所以这次请求没有发出去。重启 dsh web 后再试。`
}

/**
 * Name a transport failure that is really a VERSION SKEW.
 *
 * A gateway answers a method the host never published with an HTTP 404, which reads exactly like
 * "the record or the file is gone". The sentence therefore names the missing REGISTRATION (an older
 * host, or one never restarted) rather than only repeating the transport text; anything that is not
 * a 404 is returned verbatim, because then the transport's own words are the useful ones.
 */
export function transportHint(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause)
  if (!/404|not found/iu.test(text)) return text
  return '宿主可能没有注册这个接口（旧版本 / 未重启）：客户端会随页面刷新，宿主只在 dsh web 启动时加载一次，'
    + `所以 dsh web 很可能还在跑旧的宿主代码。重启 dsh web 后再试。（原始错误：${text}）`
}
