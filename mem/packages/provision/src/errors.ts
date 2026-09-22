/**
 * Typed, STEP-NAMED provisioning failures.
 *
 * Every failure this package raises says which step failed — resolving a source, downloading (with
 * the URL and HTTP status), checking the digest (with both values), extracting, or verifying the
 * artifact runs. That is the whole point of the type: "install failed" is unactionable, while
 * "下载失败（步骤 fetch）… http 404" tells the operator whether the mirror is stale, the network is
 * intercepted, or the pinned version was yanked.
 *
 * @module errors
 */

/** The step that failed. Kept in the message so a log line is self-describing. */
export type ProvisionStep = 'resolve' | 'fetch' | 'verify-checksum' | 'extract' | 'verify-binary'

/** An artifact could not be provided. */
export class ProvisionError extends Error {
  override readonly name = 'ProvisionError'
  constructor(
    readonly step: ProvisionStep,
    /** The artifact id, or `'(unregistered)'`. */
    readonly artifact: string,
    message: string,
    readonly options?: { cause?: unknown },
  ) {
    super(`[${artifact}] ${step}：${message}`, options)
  }
}

/** An unknown throwable, as a message. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
