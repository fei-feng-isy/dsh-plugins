/**
 * Which machine we are on, and how to find an executable on it.
 *
 * The PATH probe is the pattern `packages/plugin/src/open.ts` already uses for editors, lifted here
 * because the pandoc lookup has the same problem: on Windows the executable is `pandoc.exe` (or a
 * shim carrying a `PATHEXT` suffix), and probing only the bare name silently finds nothing. The
 * probe never goes through a shell — `execFileSync` with an argument array, so a path with spaces or
 * a quote is one argument, not a command line.
 *
 * @module platform
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { PlatformKey } from './types.js'

/** The running machine, in the form the artifact packs are keyed by. */
export function currentPlatform(): PlatformKey {
  return { os: process.platform, arch: normalizeArch(process.arch) }
}

/** `PlatformKey` → the pack key (`linux-x64`). */
export function packKey(key: PlatformKey = currentPlatform()): string {
  return `${key.os}-${key.arch}`
}

/** Node's arch names, mapped to the ones the release packs use. */
function normalizeArch(arch: string): string {
  if (arch === 'x64' || arch === 'arm64' || arch === 'arm' || arch === 'ia32') return arch
  return arch
}

/**
 * The file names one command can have on `platform` — `open.ts`'s rule, reused verbatim.
 *
 * `PATHEXT` is what the shell itself consults; the default list is the fallback for a process that
 * inherited no environment (a service host, a bare cron).
 */
export function commandFileNames(command: string, platform: string = process.platform): string[] {
  if (platform !== 'win32') return [command]
  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => ext !== '')
  return [command, ...exts.map(ext => `${command}${ext.toLowerCase()}`), ...exts.map(ext => `${command}${ext}`)]
}

/**
 * Absolute path of `command` on PATH, or `undefined`.
 *
 * On win32 a bare name is matched through {@link commandFileNames}; elsewhere the entry must carry
 * the executable bit. A DIRECTORY with the command's name is not a hit (`statSync().isFile()`), which
 * happens on PATHs that contain a `pandoc/` directory.
 */
export function findOnPath(command: string, platform: string = process.platform): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined
  const path = process.env['PATH']
  if (path === undefined || path === '') return undefined
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    for (const name of commandFileNames(command, platform)) {
      const candidate = join(dir, name)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here (or not executable); keep looking.
      }
    }
  }
  return undefined
}

/** True when `file` exists and this process may execute it. */
export function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * How long an artifact's own probe may run before it is declared unrunnable.
 *
 * Generous on purpose: the first execution of a cold binary on a network filesystem can take
 * seconds, and a false "not runnable" would trigger a needless re-download.
 */
export const PROBE_TIMEOUT_MS = 30_000
