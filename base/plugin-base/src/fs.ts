/**
 * The default data-plane IO, built on `node:fs/promises`; implements {@link ProvisionFs}.
 * @module fs
 */
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProvisionFs } from './types.js'

/** Is the path present? */
export async function exists(fs: ProvisionFs, path: string): Promise<boolean> {
  return (await fs.stat(path)) !== undefined
}

/** Prefix of the same-directory temp files {@link defaultFs}'s `atomicWrite` creates. */
export const ATOMIC_TEMP_PREFIX = '.atomic-'

/** Remove leftover `atomicWrite` temps from `dir`; missing directories are ignored. */
export async function sweepAtomicTemps(fs: ProvisionFs, dir: string): Promise<void> {
  let entries: readonly string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(ATOMIC_TEMP_PREFIX)) continue
    await fs.rm(join(dir, entry)).catch(() => undefined)
  }
}

/** Temps older than this certainly belong to a writer that will never rename them. */
const STALE_TEMP_MS = 5 * 60 * 1000

/** Best-effort removal of long-dead same-directory temps before a new `atomicWrite`. */
async function sweepStaleTemps(dir: string): Promise<void> {
  let entries: readonly string[]
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.startsWith(ATOMIC_TEMP_PREFIX)) continue
    const path = join(dir, entry)
    try {
      const info = await fsp.stat(path)
      if (now - info.mtimeMs > STALE_TEMP_MS) await fsp.rm(path, { force: true })
    } catch {
      // A temp that vanished under us is already gone.
    }
  }
}

/** Recursively copy a directory tree through the seam. */
async function copyTree(fs: ProvisionFs, from: string, to: string): Promise<void> {
  // An existing destination directory (a concurrent writer's) is reused, not an error.
  await fs.mkdir(to).catch(() => undefined)
  for (const entry of await fs.readdir(from)) {
    const source = join(from, entry)
    const destination = join(to, entry)
    const info = await fs.stat(source)
    if (info === undefined) continue
    if (info.isDirectory) await copyTree(fs, source, destination)
    else await fs.copyFile(source, destination)
  }
}

/**
 * Make `path` resolve to `target`: a symlink, or a copy when the symlink fails.
 * Returns `'linked'` or `'copied'`; `onFallback` runs before the fallback copy.
 */
export async function linkOrCopy(
  fs: ProvisionFs,
  target: string,
  path: string,
  options: { readonly copy?: () => Promise<void>; readonly onFallback?: (error: unknown) => void } = {},
): Promise<'linked' | 'copied'> {
  await fs.mkdir(dirname(path))
  try {
    await fs.symlink(target, path)
    return 'linked'
  } catch (error) {
    options.onFallback?.(error)
    await (options.copy ?? (() => copyTree(fs, target, path)))()
    return 'copied'
  }
}

/** Default IO implementation. */
export function defaultFs(): ProvisionFs {
  return {
    async readFile(path) {
      return new Uint8Array(await fsp.readFile(path))
    },
    async writeFile(path, data) {
      await fsp.mkdir(dirname(path), { recursive: true })
      await fsp.writeFile(path, data)
    },
    async atomicWrite(path, data) {
      await fsp.mkdir(dirname(path), { recursive: true })
      await sweepStaleTemps(dirname(path))
      const temp = join(dirname(path), `${ATOMIC_TEMP_PREFIX}${String(process.pid)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
      await fsp.writeFile(temp, data)
      try {
        await fsp.rename(temp, path)
      } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => undefined)
        throw error
      }
    },
    async rename(from, to) {
      await fsp.rename(from, to)
    },
    async mkdir(path) {
      await fsp.mkdir(path, { recursive: true })
    },
    async readdir(path) {
      return fsp.readdir(path)
    },
    async stat(path) {
      try {
        const info = await fsp.stat(path)
        return { size: info.size, mtimeMs: info.mtimeMs, isDirectory: info.isDirectory(), mode: info.mode }
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return undefined
        throw error
      }
    },
    async rm(path, options) {
      await fsp.rm(path, { recursive: options?.recursive ?? false, force: true })
    },
    async symlink(target, path) {
      await fsp.symlink(target, path)
    },
    async readlink(path) {
      try {
        return await fsp.readlink(path)
      } catch {
        return undefined
      }
    },
    async copyFile(from, to) {
      await fsp.mkdir(dirname(to), { recursive: true })
      await fsp.copyFile(from, to)
    },
    async chmod(path, mode) {
      await fsp.chmod(path, mode)
    },
  }
}
