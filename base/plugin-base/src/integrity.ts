/**
 * Integrity strings in one place; the framework reads SRI strings and lowercase sha256 hex.
 * @module integrity
 */
import { createHash } from 'node:crypto'
import { ProvisionError } from './errors.js'

const ALGORITHMS = ['sha512', 'sha384', 'sha256', 'sha1'] as const

/** A lowercase hex sha256 → SRI. Anything else is passed through as `sha256-<as-is>`. */
export function sriOfSha256(hex: string): string {
  return /^[0-9a-f]{64}$/i.test(hex) ? `sha256-${Buffer.from(hex, 'hex').toString('base64')}` : `sha256-${hex}`
}

/** Verify `bytes` against an SRI string. A `sha1-` anchor is only honoured when explicit. */
export function verifyIntegrity(bytes: Uint8Array, integrity: string): void {
  const dash = integrity.indexOf('-')
  if (dash <= 0) throw new ProvisionError('npm/no-integrity', `无法解析 integrity：${JSON.stringify(integrity)}`)
  const algorithm = integrity.slice(0, dash)
  const expected = integrity.slice(dash + 1)
  if (!(ALGORITHMS as readonly string[]).includes(algorithm)) {
    throw new ProvisionError('npm/no-integrity', `不支持的 integrity 算法：${algorithm}`)
  }
  const digest = createHash(algorithm).update(bytes).digest()
  if (algorithm === 'sha1') {
    if (digest.toString('hex') !== expected) {
      throw new ProvisionError('npm/integrity-mismatch', `sha1 不匹配（期望 ${expected}）`)
    }
    return
  }
  if (digest.toString('base64') !== expected) {
    throw new ProvisionError('npm/integrity-mismatch', `${algorithm} 不匹配`)
  }
}
