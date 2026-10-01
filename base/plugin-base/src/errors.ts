/**
 * Stable machine codes for every way provisioning can fail; `detail` and the message may change.
 * @module errors
 */

/** Every stable code this framework reports.
 *  @stable */
export type ProvisionCode =
  // ── input / policy ─────────────────────────────────────────────────────────
  | 'invalid-option'
  | 'ignored-field'
  | 'missing-need'
  | 'policy/download-disabled'
  | 'policy/offline'
  // ── provider resolution ────────────────────────────────────────────────────
  | 'unknown-provider'
  | 'provider/unavailable'
  | 'provider/conflict'
  | 'peer/unsatisfied'
  // ── npm provider ───────────────────────────────────────────────────────────
  | 'npm/no-satisfying-version'
  | 'npm/no-integrity'
  | 'npm/integrity-mismatch'
  | 'npm/lifecycle-script-unsupported'
  // ── archives ───────────────────────────────────────────────────────────────
  | 'archive/path-traversal'
  | 'archive/integrity-mismatch'
  /** This artifact has no pack for the running platform. */
  | 'archive/no-platform-pack'
  // ── versions and layout ────────────────────────────────────────────────────
  | 'unsupported-envinit'
  | 'unsupported-item-schema'
  | 'layout/too-new'
  | 'layout/mismatch'
  /** `.layout.json` exists but could not be read (EACCES / ENOSPC / half-written). It shares the
   *  read-only CONSEQUENCE with the two above and not their meaning: "a newer layout wrote this, do
   *  not touch it" is a verdict about the home, while this is a fact about the read. */
  | 'layout/unreadable'
  // ── storage / concurrency ──────────────────────────────────────────────────
  | 'lock/timeout'
  | 'publish/cross-device'
  | 'fetch/failed'
  /** A response body crossed a hard byte cap — either the declared `content-length` or the bytes
   *  actually read. Unlike a short read (which is a truncated DOWNLOAD and retries the next mirror),
   *  this is TERMINAL: every mirror serves the same oversized object, so trying another one cannot
   *  help. Providers branch on this code to decide whether to fall through. */
  | 'fetch/too-large'
  | 'extract/failed'
  | 'verify/failed'
  // ── catch-all ──────────────────────────────────────────────────────────────
  | 'unknown-error'

/** An error that carries a stable `code`; a caller branches on `code`, never on message text. */
export class ProvisionError extends Error {
  readonly code: ProvisionCode
  /** Optional structured detail; never branched on. */
  readonly detail: string | undefined

  constructor(code: ProvisionCode, message: string, detail?: string) {
    super(message)
    this.name = 'ProvisionError'
    this.code = code
    this.detail = detail
  }
}

/** Narrow an unknown throwable into a stable code + one-line reason. */
export function reasonOf(error: unknown): { code: ProvisionCode; message: string } {
  if (error instanceof ProvisionError) return { code: error.code, message: error.message }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    // Append Node's errno code when the thrown error carries one.
    return { code: 'unknown-error', message: code === undefined ? error.message : `${error.message} (${String(code)})` }
  }
  return { code: 'unknown-error', message: String(error) }
}
