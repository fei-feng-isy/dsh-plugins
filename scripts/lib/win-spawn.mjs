/**
 * The ONE place that knows how to launch a `.cmd`-shimmed tool (`npm`, `pnpm`, …).
 *
 * WHY THIS EXISTS. On Windows `npm` / `pnpm` are `.cmd` shims, and since the CVE-2024-27980 fix Node
 * refuses to spawn a `.cmd` through the no-shell path — so every bare `execFileSync('npm', …)` in this
 * repo failed there. Naming the file (`npm.cmd`) does NOT fix it: Node still refuses the no-shell
 * spawn of a `.cmd`. Both were measured on a real Windows box (node v25.2.1, via WSL interop):
 *
 *   execFileSync('npm.cmd', ['root', '-g'])                    -> EINVAL
 *   execFileSync('npm.cmd', ['root', '-g'], { shell: true })  -> OK, but Node emits DEP0190
 *                                                                 (arguments are concatenated, not escaped)
 *   execFileSync('cmd.exe', ['/c', 'npm.cmd', 'root', '-g'])   -> OK, no warning
 *   execFileSync('.bin/tsc.cmd', …) with no shell              -> EINVAL
 *
 * So the preferred shape is `cmd.exe /c <tool>.cmd <argv…>`: no shell on Node's side (no DEP0190), and
 * the arguments reach `cmd.exe` as real argv entries instead of a concatenated command line. The
 * `.bin/*.cmd` case is handled where it already was (`shell: true` with no arguments in
 * `binLaunch`), because there Node's own quoting of a single path is enough.
 *
 * The platform is an ARGUMENT, not `process.platform` read inside, so the win32 shape is assertable
 * from Linux (`scripts/check-dsh-lines.test.mjs`). A real Windows box still has to confirm the launch
 * end to end (`pnpm -C base/plugin-base test`, `pnpm build:dsh`).
 *
 * @module scripts/lib/win-spawn
 */
import { execFileSync, spawnSync } from 'node:child_process'

/**
 * The command line for launching tool `name` with `args` on `platform`.
 *
 * - win32, bare tool name: `cmd.exe /c <name>.cmd <args…>` (no shell).
 * - win32, a path to a `.cmd`/`.bat`: `cmd.exe /c <path> <args…>` — still a batch file.
 * - win32, anything else that is already a path or an `.exe`: spawned as given — `process.execPath`
 *   and a `node scripts/x.mjs` step must NOT be rewritten into `node.exe.cmd`.
 * - POSIX: the tool runs under its own name.
 *
 * Pure (no process state, no IO) so both shapes are directly testable.
 *
 * @param {NodeJS.Platform | string} platform
 * @param {string} name bare tool name (`npm`, `pnpm`) or an executable path
 * @param {readonly string[]} [args]
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function toolInvocation(platform, name, args = []) {
  if (platform !== 'win32') return { command: name, args: [...args], shell: false }
  const lower = name.toLowerCase()
  const isBatch = lower.endsWith('.cmd') || lower.endsWith('.bat')
  const isPath = name.includes('/') || name.includes('\\') || /\.(?:exe|com)$/u.test(lower)
  if (isBatch) return { command: 'cmd.exe', args: ['/c', name, ...args], shell: false }
  if (isPath) return { command: name, args: [...args], shell: false }
  return { command: 'cmd.exe', args: ['/c', `${name}.cmd`, ...args], shell: false }
}

/**
 * The npm command line on `platform` — `toolInvocation` with the tool named, kept as its own function
 * because "how do I run npm here" is the question the call sites actually ask.
 *
 * @param {NodeJS.Platform | string} [platform]
 * @param {readonly string[]} [args]
 */
export function npmInvocation(platform = process.platform, args = []) {
  return toolInvocation(platform, 'npm', args)
}

/**
 * `execFileSync`, with the platform's `.cmd` shim shape applied. Same signature and return value as
 * `execFileSync`: it throws on a non-zero exit or a spawn error.
 *
 * @param {string} name
 * @param {readonly string[]} [args]
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 */
export function execToolSync(name, args = [], options = {}) {
  const invocation = toolInvocation(process.platform, name, args)
  return execFileSync(invocation.command, invocation.args, { ...options, shell: invocation.shell })
}

/**
 * `spawnSync`, with the platform's `.cmd` shim shape applied — for callers that want the result object
 * (`status`, `stdout`, `error`) rather than a throw.
 *
 * @param {string} name
 * @param {readonly string[]} [args]
 * @param {import('node:child_process').SpawnSyncOptions} [options]
 */
export function spawnToolSync(name, args = [], options = {}) {
  const invocation = toolInvocation(process.platform, name, args)
  return spawnSync(invocation.command, invocation.args, { ...options, shell: invocation.shell })
}
