/**
 * The filesystem boundary for the agent-callable maintenance actions (`mem_admin` export / import /
 * merge / restore_snapshot).
 *
 * WHY THIS IS A SEPARATE MODULE. The mem tools run in the HOST process, whose filesystem access is
 * NOT bounded by the agent sandbox. A path parameter that accepted anything would make `mem_admin` a
 * generic file API — a way around the sandbox the agent is otherwise held to. Every maintenance path
 * is therefore resolved against the data root of THIS run and must stay inside it:
 *
 *   - relative paths resolve against the data root (not the process cwd, which the host controls);
 *   - `..`, absolute paths outside the root and symlinks that point outside are refused;
 *   - input files must be regular files (a directory, FIFO or device is not a snapshot);
 *   - inputs are capped at {@link MAINTENANCE_MAX_FILE_BYTES}; an oversized file is refused before
 *     anything is read into memory.
 *
 * The CLI remains the operator's entry point for paths outside the data root; it deliberately does
 * not go through the containment check. The operator surfaces still share the pieces that must not
 * drift: `/mem export` uses {@link defaultFactsExportPath} and {@link writeFileAtomic}, and the CLI
 * writes its `--out` with the same atomic writer.
 *
 * CONTAINMENT IS REALPATH-BASED. A lexical `startsWith` check alone would accept a symlink that
 * lives inside the root but points outside it. The resolver realpaths the existing part of the path
 * (the target itself for an input, the nearest existing ancestor for a not-yet-created export) and
 * compares THAT with `realpath(<home>)`.
 *
 * @module maintenance_paths
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { expandHome } from '@avantf/mem-contract'
import type { FactsExportCodec } from './facts_io.js'

/** Hard cap on a file a maintenance action will read (import / merge / restore_snapshot). */
export const MAINTENANCE_MAX_FILE_BYTES = 512 * 1024 * 1024

/** Where an export lands when the caller does not name a file. */
export const MAINTENANCE_BACKUP_DIRNAME = 'backups'

/** The suffix each container writes — the same extension rule `codecForExportPath` reads. */
const EXPORT_SUFFIX: Readonly<Record<FactsExportCodec, string>> = {
  brotli: '.json.br',
  gzip: '.json.gz',
  none: '.json',
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** ENOENT / ENOTDIR: "this path has no file here", never "a permission or I/O failure". */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The data root as the FILESYSTEM sees it (symlinks resolved), or a clear refusal. */
function dataRoot(home: string): string {
  const declared = resolve(home)
  try {
    return realpathSync(declared)
  } catch {
    throw new Error(`数据根不存在或不可访问：${declared}`)
  }
}

/** True when `candidate` is `root` itself or lives below it. */
function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

/**
 * The one refusal for "outside the data root".
 *
 * Deliberately does NOT echo the resolved path: a symlink target would disclose whether a path
 * outside the root exists, which is exactly the detail this boundary must not leak. The allowed root
 * IS named, so the caller can correct the input.
 */
function outsideRoot(root: string): Error {
  return new Error(
    `路径不在允许的数据根内：${root}。mem 工具只能维护本次运行的数据根；数据根之外的路径请用 avantf-mem CLI。`,
  )
}

/** `~` expands like a shell; a relative path resolves against the data root, never the cwd. */
function candidateOf(root: string, input: string): string {
  const expanded = expandHome(input)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded)
}

/** The deepest existing ancestor of `path` (the caller has already established the path is missing). */
function nearestExisting(path: string): string {
  let current = path
  for (;;) {
    try {
      statSync(current)
      return current
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const parent = dirname(current)
    if (parent === current) throw new Error(`无法解析目标路径的父目录：${path}`)
    current = parent
  }
}

/** Local `YYYYMMDD-HHMMSS`, sortable by name and rendered in the user's time zone. */
function timestampName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate())
    + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
}

/**
 * `<data home>/backups/memory-YYYYMMDD-HHMMSS.<ext>` — never inside `memory/`.
 *
 * Brotli is the default because it is the smallest (measured: 70.6 KiB vs 92.3 gzip vs 300.0 plain
 * for 233 facts). A caller that passes another codec keeps the file name truthful by changing the
 * suffix along with the bytes.
 */
export function defaultFactsExportPath(home: string, now = new Date(), codec: FactsExportCodec = 'brotli'): string {
  return join(home, MAINTENANCE_BACKUP_DIRNAME, 'memory-' + timestampName(now) + EXPORT_SUFFIX[codec])
}

/** A resolved export destination, plus whether this call will overwrite an existing file. */
export interface MaintenanceExportTarget {
  file: string
  existed: boolean
}

/**
 * Resolve an export destination inside the data root.
 *
 * The TARGET may not exist yet (that is the normal case), so containment is established on the
 * nearest existing ancestor: every component below it is one this call will create, and a
 * not-yet-created component cannot be a symlink. When the target DOES exist, its realpath is
 * checked — a symlink pointing outside is refused rather than followed.
 */
export function resolveMaintenanceExportTarget(home: string, input?: string): MaintenanceExportTarget {
  const root = dataRoot(home)
  const candidate = input === undefined ? defaultFactsExportPath(root) : candidateOf(root, input)
  if (!within(root, candidate)) throw outsideRoot(root)

  let existing: string | undefined
  try {
    existing = realpathSync(candidate)
  } catch (error) {
    if (!isMissing(error)) {
      throw new Error(`无法访问导出路径：${candidate}（允许的数据根：${root}）：${messageOf(error)}`)
    }
  }
  if (existing !== undefined) {
    if (!within(root, existing)) throw outsideRoot(root)
    const stat = statSync(existing)
    if (!stat.isFile()) throw new Error(`不是普通文件：${existing}（允许的数据根：${root}）`)
    return { file: existing, existed: true }
  }

  const ancestor = nearestExisting(dirname(candidate))
  const actualAncestor = realpathSync(ancestor)
  if (!within(root, actualAncestor)) throw outsideRoot(root)
  const file = join(actualAncestor, relative(ancestor, candidate))
  if (!within(root, file)) throw outsideRoot(root)
  return { file, existed: false }
}

/**
 * Resolve an INPUT file (import / merge / restore_snapshot) inside the data root.
 *
 * The file must exist, be a regular file, and be no larger than {@link MAINTENANCE_MAX_FILE_BYTES}.
 * A symlink to a regular file INSIDE the root is usable; a symlink that escapes it is refused before
 * the size or existence of the outside target is examined.
 */
export function resolveMaintenanceInputFile(home: string, input: string): string {
  const root = dataRoot(home)
  const candidate = candidateOf(root, input)
  if (!within(root, candidate)) throw outsideRoot(root)

  let actual: string
  try {
    actual = realpathSync(candidate)
  } catch (error) {
    if (isMissing(error)) throw new Error(`文件不存在：${candidate}（允许的数据根：${root}）`)
    throw new Error(`无法访问文件：${candidate}（允许的数据根：${root}）：${messageOf(error)}`)
  }
  if (!within(root, actual)) throw outsideRoot(root)

  const stat = statSync(actual)
  if (!stat.isFile()) throw new Error(`不是普通文件：${actual}（允许的数据根：${root}）`)
  if (stat.size > MAINTENANCE_MAX_FILE_BYTES) {
    throw new Error(
      `文件过大：${actual} 为 ${String(stat.size)} 字节，超过上限 ${String(MAINTENANCE_MAX_FILE_BYTES)} 字节（512 MiB）`,
    )
  }
  return actual
}

/**
 * Write a file atomically: a sibling temp file, then one `rename` (same directory, so the rename
 * cannot cross a filesystem). An overwrite is therefore either the old bytes or the new bytes, never
 * a truncated export. The temp file is removed when anything fails.
 */
export function writeFileAtomic(path: string, bytes: Buffer | string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, '.' + basename(path) + '.tmp-' + String(process.pid) + '-' + randomBytes(4).toString('hex'))
  try {
    writeFileSync(tmp, bytes)
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temp file may not have been created; the original failure is the one worth reporting.
    }
    throw error
  }
}
