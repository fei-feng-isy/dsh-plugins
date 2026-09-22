/**
 * Package-name validation for names that become path segments; the guard keeps them single, safe segments.
 * @module package-name
 */
import { ProvisionError } from './errors.js'

const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Reject a package or peer name that would not stay a safe path segment. */
export function assertPackageName(name: string, what = '包名'): void {
  if (!PACKAGE_NAME.test(name)) {
    throw new ProvisionError('invalid-option', `${what}不是合法的 npm 包标识（会作为路径的一段）：${JSON.stringify(name)}`)
  }
}
