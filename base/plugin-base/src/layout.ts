/**
 * Disk layout: control-plane and resource directories under `<home>`.
 * @module layout
 */
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { ProvisionError } from './errors.js'

/** The control-plane directory name under `home`. */
export const CONTROL_DIR = '.envinit'

/** Default path budget before the version segment switches to a short hash. */
export const DEFAULT_MAX_PATH = 200

export function controlRoot(home: string): string {
  return join(home, CONTROL_DIR)
}
export function lockPath(home: string): string {
  return join(controlRoot(home), '.lock')
}
export function statusLockPath(home: string): string {
  return join(controlRoot(home), '.status.lock')
}
export function layoutPath(home: string): string {
  return join(controlRoot(home), '.layout.json')
}
export function statusPath(home: string): string {
  return join(controlRoot(home), 'status.json')
}
export function declaredPath(home: string): string {
  return join(controlRoot(home), 'declared.json')
}
export function tempRoot(home: string): string {
  return join(controlRoot(home), '.tmp')
}
export function quarantineRoot(home: string): string {
  return join(controlRoot(home), '.quarantine')
}

/**
 * A staging directory for one install attempt under {@link tempRoot}.
 * `sequence` must be monotonic per process.
 */
export function stagingDir(home: string, itemId: string, sequence: number): string {
  const safe = itemId.replaceAll(/[^A-Za-z0-9._-]/g, '-')
  return join(tempRoot(home), `${safe}-${String(process.pid)}-${String(sequence)}`)
}

/** A quarantine directory for one bad version directory. */
export function quarantineDir(home: string, sequence: number): string {
  return join(quarantineRoot(home), `${String(Date.now())}-${String(process.pid)}-${String(sequence)}`)
}

/** Is `child` inside `parent` (or equal to it)? Both are absolute and already normalised. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`))
}

/** Reject a `target.root` that is absolute or escapes `home` (`invalid-option`). */
export function assertSafeRelativeRoot(root: string): void {
  if (root === '' || root.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(root) || root.includes('\0')) {
    throw new ProvisionError('invalid-option', `target.root 必须是 home 下的相对路径：${JSON.stringify(root)}`)
  }
  const parts = root.replaceAll('\\', '/').split('/')
  if (parts.some(part => part === '..')) {
    throw new ProvisionError('invalid-option', `target.root 不得跳出 home：${JSON.stringify(root)}`)
  }
}

/** Reject a provider-supplied relative path that is absolute or escapes its root. */
export function assertSafeRelativePath(path: string): void {
  if (path === '' || path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.includes('\0')) {
    throw new ProvisionError('invalid-option', `provider 给出的相对路径不安全：${JSON.stringify(path)}`)
  }
  const parts = path.replaceAll('\\', '/').split('/')
  if (parts.some(part => part === '..')) {
    throw new ProvisionError('invalid-option', `provider 给出的相对路径跳出目标根：${JSON.stringify(path)}`)
  }
}

/** The version segment: the version, or a short hash when the path is too long. */
export function versionSegment(
  home: string,
  targetRoot: string,
  name: string,
  version: string,
  maxPathLength: number = DEFAULT_MAX_PATH,
): string {
  const candidate = join(home, targetRoot, ...name.split('/'), version)
  if (candidate.length <= maxPathLength) return version
  const digest = createHash('sha256').update(`${name}@${version}`).digest('hex')
  const short8 = digest.slice(0, 8)
  if (join(home, targetRoot, ...name.split('/'), short8).length <= maxPathLength) return short8
  return digest.slice(0, 12)
}
