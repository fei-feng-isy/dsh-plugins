/**
 * Transport-shape helpers shared by the DSH Remote host gateway (@avantf/dsh-mem)
 * and its client pages.
 *
 * There are TWO nested envelopes on the client↔host Remote path:
 *
 *  1. the **transport** envelope, added by DSH itself: every `@Remote` method call
 *     resolves to `{ok:true, value:<host method return>}` (or `{ok:false, error}`
 *     on a carrier/host failure) — see the harness Typert client
 *     (`packages/api/gateway/src/client/index.ts`). The host method must NOT add
 *     this layer itself.
 *  2. the **application** envelope this plugin's gateway returns deliberately, so
 *     the settings pages can show contract-validation violations instead of a raw
 *     exception: `{ok:true, value}` / `{ok:false, error, violations}`.
 *
 * `unwrapRemoteEnvelope` peels both, in order, and also tolerates a bare payload
 * (a gateway that returns raw values, or a future protocol change), so the pages
 * never render an envelope as if it were data.
 *
 * The application envelope also carries the **wire revision** (`wire`, optional): the host stamps
 * the revision of the Remote FACE it publishes onto every answer (see `@avantf/dsh-mem`'s
 * `remote.ts` `WIRE_VERSION`), and the client half reads it back to tell a rebuilt browser bundle
 * from the host process that `dsh web` loaded before it. It rides the envelope rather than one
 * method's payload because this plugin has no single entry point — each tab makes its own first
 * call — while the envelope is the one object every answer shares. Absent means "a host older
 * than the marker": still readable, but the client may not assume a method it knows about exists.
 */

/** Successful application result. */
export interface RemoteOk<T> {
  ok: true
  value: T
  /** The publisher's wire revision, when it reports one (see the module doc). */
  wire?: number
}

/** Failed application result (validation violations are optional). */
export interface RemoteErr {
  ok: false
  error: string
  violations?: string[]
  /** The publisher's wire revision, when it reports one (see the module doc). */
  wire?: number
}

export type RemoteEnvelope<T> = RemoteOk<T> | RemoteErr

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Best-effort human-readable text for any error carrier (string, Error, object). */
export function remoteErrorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (isRecord(error) && typeof error['message'] === 'string') return error['message']
  if (error === undefined || error === null) return 'unknown error'
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Decode one Remote call result into the application envelope.
 *
 * @param result - whatever the client transport resolved with.
 * @returns the application payload, or the application error + violations.
 */
export function unwrapRemoteEnvelope<T>(result: unknown): RemoteEnvelope<T> {
  // A bare, non-envelope result is the payload itself.
  if (!isRecord(result) || typeof result['ok'] !== 'boolean') {
    return { ok: true, value: result as T }
  }

  // Layer 1: the transport envelope. `ok:false` here is a carrier/host failure.
  if (result['ok'] === false) {
    return { ok: false, error: remoteErrorText(result['error']) }
  }

  const inner = result['value']
  // Layer 2: the application envelope, when the host adds one.
  if (isRecord(inner) && typeof inner['ok'] === 'boolean') {
    // The wire revision rides the application envelope. Carried through so the caller's ONE decode
    // point is also where the host's revision is observed — an unrecognized/absent revision must
    // stay a note the caller can read, never a decode failure (see the module doc).
    const wire = typeof inner['wire'] === 'number' ? inner['wire'] : undefined
    if (inner['ok'] === false) {
      const violations = Array.isArray(inner['violations']) ? inner['violations'].map(String) : undefined
      return {
        ok: false,
        error: remoteErrorText(inner['error']),
        ...(violations && violations.length > 0 ? { violations } : {}),
        ...(wire === undefined ? {} : { wire }),
      }
    }
    return { ok: true, value: inner['value'] as T, ...(wire === undefined ? {} : { wire }) }
  }

  // Transport succeeded and the host returned a bare payload.
  return { ok: true, value: inner as T }
}

/** Render a violation list for display (used by the settings pages). */
export function formatViolations(violations: string[] | undefined): string {
  return violations && violations.length > 0 ? violations.join('；') : ''
}

/**
 * The envelope every AGENT-facing tool result uses, on BOTH surfaces: the DSH
 * `defineTool` tools (`@avantf/dsh-mem`) and the standalone MCP server
 * (`@avantf/mem-mcp`). Keeping one shape means a model/consumer sees the same
 * response whether it talks to the plugin or to the MCP process.
 *
 * Note the deliberate difference from {@link RemoteEnvelope}: the payload key is
 * `result` (tools) vs `value` (settings-page Remote calls).
 */
export type ToolEnvelope<T> = { ok: true; result: T } | { ok: false; error: string; violations?: string[] }

/** Wrap a successful tool payload (a null/undefined payload becomes explicit null). */
export function toolOk<T>(result: T): ToolEnvelope<T | null> {
  return { ok: true, result: (result ?? null) as T | null }
}

/** Wrap a failed tool call (message + optional contract violations). */
export function toolErr(error: unknown, violations?: string[]): ToolEnvelope<never> {
  const message = remoteErrorText(error)
  return violations && violations.length > 0
    ? { ok: false, error: message, violations }
    : { ok: false, error: message }
}

/** Contract-validation failure message shared by both tool surfaces. */
export function validationError(toolName: string, issues: readonly { path: PropertyKey[]; message: string }[]): ToolEnvelope<never> {
  return toolErr(
    `参数不合法（${toolName}）：请按各字段说明补齐/修正后重试。`,
    issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`),
  )
}
