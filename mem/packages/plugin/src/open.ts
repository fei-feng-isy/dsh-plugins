/**
 * Opening a managed document file (or its directory) with the user's own tools.
 *
 * The harness already ships `@deepseek-ai/dsh-host-open-in-app`, whose `/open-in-app/open` route
 * launches a detected application — but that route accepts a DIRECTORY only (a file path is
 * rejected with 404), and 「编辑」 has to open the file itself. So this module owns the launch,
 * with a deliberately small surface:
 *
 * 1. `knowledge.open.editor` (or `$AVANTF_EDITOR`) wins when set.
 * 2. then `$VISUAL` / `$EDITOR` — the answers an interactive shell already carries;
 * 3. then `code` / `cursor` — an editor that can open a file AND a folder;
 * 4. then the platform opener (`xdg-open`, `open`, and on WSL `explorer.exe` via `wslpath`).
 *
 * Everything is fire-and-forget: the child is detached with its stdio on /dev/null, so an editor
 * that outlives the host (or a browser window that closes immediately) is normal. The returned
 * `opener` is what the UI shows, so a wrong editor is diagnosable without reading the host log.
 *
 * WINDOWS. `code` is `code.cmd` there, and Node refuses to spawn a `.cmd`/`.bat` without a shell
 * (CVE-2024-27980). That refusal is a synchronous `EINVAL`; the old `catch {}` swallowed it, so the
 * documented "prefer VS Code" step silently demoted every launch to the `cmd /c start` fallback and
 * the user was never told. Two things changed: the command is resolved to the file that actually
 * exists (`code` → `code.cmd`) and a batch shim goes through `shell: true`; and the catch now
 * SEPARATES "the editor is not installed here" (normal fallback — silent) from "the launch was
 * refused" (a defect — warned through the injectable `warn`, default stderr). A refused launch is
 * also carried in the thrown message, which the `openDoc` Remote returns to the UI.
 *
 * @module open
 */
import { accessSync, constants, existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { delimiter, join, dirname } from 'node:path'

/** Which of the two things a document row can open. */
export type OpenTarget = 'file' | 'dir'

/** What was launched, for the UI's status line. */
export interface OpenOutcome {
  path: string
  target: OpenTarget
  /** The command that was actually used (`code`, `explorer.exe`, …). */
  opener: string
}

/**
 * The file names one command can have on PATH.
 *
 * On Windows a shim is `code.cmd` (or `.exe`/`.bat`), never the bare `code`, so probing only the
 * bare name silently loses the editor and falls back to the OS default application. `PATHEXT` is
 * what the shell itself uses; the default list is the fallback when it is not exported.
 */
export function commandFileNames(
  command: string,
  platform: NodeJS.Platform = process.platform,
  pathext: string | undefined = process.env['PATHEXT'],
): string[] {
  if (platform !== 'win32') return [command]
  const exts = (pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => ext !== '')
  return [command, ...exts.map(ext => `${command}${ext.toLowerCase()}`), ...exts.map(ext => `${command}${ext}`)]
}

/**
 * The file name of `command` that actually exists on `env.PATH`, or `undefined`.
 *
 * Returning the NAME (not a boolean) is what lets the launcher see `code.cmd` and know it holds a
 * batch shim. `[win]` — the win32 form is asserted from Linux with an injected platform/env.
 */
export function resolveOnPath(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const path = env['PATH']
  if (path === undefined || path === '') return undefined
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    for (const name of commandFileNames(command, platform, env['PATHEXT'])) {
      try {
        accessSync(join(dir, name), constants.X_OK)
        return name
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined
}

/** True for a Windows batch shim — the one shape Node will not spawn without a shell. */
export function isWindowsBatchShim(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/iu.test(command)
}

/** Why a launch failed: the editor is not here (fall through) or the launch was refused (report). */
export type LaunchFailure = 'missing' | 'refused'

/**
 * Classify a synchronous spawn failure.
 *
 * `ENOENT` means the command is not there after all — the documented priority order just moves on,
 * with no warning. Everything else (the `EINVAL` a `.cmd` gets without a shell, `EACCES`, a bad
 * argument) is a wiring defect, and swallowing it is exactly how "open in VS Code" disappeared.
 */
export function classifyLaunchFailure(error: unknown): LaunchFailure {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT' ? 'missing' : 'refused'
}

/** The options the launch hands to `spawn`. */
export interface LaunchOptions {
  detached: boolean
  stdio: 'ignore'
  /** Required on Windows for a `.cmd`/`.bat` shim (CVE-2024-27980 forbids a shell-less spawn). */
  shell?: boolean
}

/** What to hand to `spawn` for one candidate. */
export interface LaunchPlan {
  command: string
  args: string[]
  options: LaunchOptions
}

/** The slice of `child_process.spawn` this module uses — narrow so a test can inject a fake. */
export type SpawnLike = (command: string, args: string[], options: LaunchOptions) => { unref: () => void }

/**
 * `cmd.exe` builds the line for `shell: true`, so anything that would split it has to be quoted.
 *
 * Wrapping alone is not enough: an embedded `"` would END the quoted run early and hand the rest of
 * the value to cmd as syntax (a `$EDITOR` like `C:\Program "Files"\ed.exe`, or a document under a
 * folder whose name holds a quote, breaks the launch). cmd's convention for a literal quote inside a
 * quoted argument is to DOUBLE it, so `a"b` becomes `"a""b"` — the same shape
 * `mission/scripts/build.mjs` `quoteForCmd` produces for its own `shell: true` line.
 * A value with nothing to quote is returned verbatim.
 */
function cmdQuote(value: string): string {
  return /[\s"&|<>^()]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

/**
 * The concrete spawn shape for one candidate on `platform`.
 *
 * TWO Windows-only rules, both from the same root cause (CVE-2024-27980): a `.cmd`/`.bat` shim is
 * spawned through `shell: true`; and the last-resort fallback is `cmd /c start`, whose quoted path
 * must follow its own title argument or cmd treats the path AS the title. The plan is pure and
 * takes the platform, so the win32 shapes are asserted on Linux (`[win]`, real-machine re-check
 * still owed).
 */
export function launchPlan(command: string, arg: string, platform: NodeJS.Platform = process.platform): LaunchPlan {
  if (isWindowsBatchShim(command, platform)) {
    return {
      command: cmdQuote(command),
      args: [cmdQuote(arg)],
      options: { detached: true, stdio: 'ignore', shell: true },
    }
  }
  if (command === 'cmd') {
    // `start` needs its own title argument before the path, or a quoted path becomes the title.
    return { command: 'cmd', args: ['/c', 'start', '', `"${arg}"`], options: { detached: true, stdio: 'ignore' } }
  }
  return { command, args: [arg], options: { detached: true, stdio: 'ignore' } }
}

/** Is this a WSL process (where a Windows-side opener is often the only one that works)? */
function isWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform === 'linux' && (env['WSL_DISTRO_NAME'] !== undefined || env['WSL_INTEROP'] !== undefined)
}

/** The Windows form of a WSL path, or `undefined` when `wslpath` cannot answer. */
function windowsPath(path: string): string | undefined {
  try {
    const out = spawnSync('wslpath', ['-w', path], { encoding: 'utf8' })
    const converted = out.status === 0 ? out.stdout.trim() : ''
    return converted === '' ? undefined : converted
  } catch {
    return undefined
  }
}

/** One launch candidate: a command plus how its argument is derived. */
interface Candidate {
  command: string
  arg: (path: string) => string | undefined
  /** A shell builtin (`cmd`), which is not a PATH entry and must not be resolved. */
  raw?: boolean
}

/** Candidates in the order above, resolved against the given machine. */
function candidates(configured: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Candidate[] {
  const list: Candidate[] = []
  const explicit = configured !== '' ? configured : (env['AVANTF_EDITOR'] ?? '')
  if (explicit !== '') list.push({ command: explicit, arg: path => path })
  const shellEditor = env['VISUAL'] ?? env['EDITOR'] ?? ''
  if (shellEditor !== '') list.push({ command: shellEditor, arg: path => path })
  for (const editor of ['code', 'cursor']) {
    // Probed by the platform file names (`commandFileNames`); the loop then resolves the bare name
    // to the file that exists — `code.cmd` on Windows, which is what tells `launchPlan` a shell is
    // mandatory.
    if (resolveOnPath(editor, platform, env) !== undefined) list.push({ command: editor, arg: path => path })
  }
  if (platform === 'darwin') list.push({ command: 'open', arg: path => path })
  if (platform === 'linux') {
    if (resolveOnPath('xdg-open', platform, env) !== undefined) list.push({ command: 'xdg-open', arg: path => path })
    // Last resort on WSL: Explorer opens a folder natively and hands a file to its default
    // application. It needs a Windows path, which `wslpath` is the only reliable source of.
    if (isWsl(platform, env)) list.push({ command: 'explorer.exe', arg: path => windowsPath(path) })
  }
  if (platform === 'win32') list.push({ command: 'cmd', raw: true, arg: path => path })
  return list
}

/**
 * The file that will actually be spawned for `command`: a bare name is resolved on PATH (so
 * `code` becomes `code.cmd` on Windows), an explicit path is kept when it exists — and `undefined`
 * means the editor is simply not installed here.
 */
function resolveCommand(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (command.includes('/') || command.includes('\\')) return existsSync(command) ? command : undefined
  return resolveOnPath(command, platform, env)
}

/** Where a refused launch is reported; injectable so both failure paths are assertable. */
export type WarnSink = (message: string) => void

/** Host facts and side effects a caller (or a test) may replace. */
export interface OpenDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: SpawnLike
  /** Defaults to `console.warn` (stderr): a refused launch must leave a trace. */
  warn?: WarnSink
}

/**
 * Launch the configured/detected tool on one document path.
 *
 * @param documentPath - the managed `.md` path.
 * @param target - `file` opens the document, `dir` opens the directory that holds it.
 * @param configured - `knowledge.open.editor` from config (empty ⇒ auto-detect).
 * @param deps - platform / env / spawn / warning sink, for tests.
 * @throws when no candidate is available or every one of them fails to start.
 */
export function openDocumentPath(
  documentPath: string,
  target: OpenTarget,
  configured: string,
  deps: OpenDeps = {},
): OpenOutcome {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const launch: SpawnLike = deps.spawn ?? ((command, args, options) => spawn(command, args, options))
  const warn: WarnSink = deps.warn ?? ((message: string): void => { console.warn(message) })
  const wanted = target === 'dir' ? dirname(documentPath) : documentPath
  const tried: string[] = []
  const missing: string[] = []
  const refused: string[] = []
  for (const candidate of candidates(configured, platform, env)) {
    const arg = candidate.arg(wanted)
    if (arg === undefined) continue
    const command = candidate.raw === true
      ? candidate.command
      : resolveCommand(candidate.command, platform, env)
    if (command === undefined) {
      // Not installed here: the documented order falls through, and that is normal — no warning.
      missing.push(candidate.command)
      continue
    }
    tried.push(command)
    const plan = launchPlan(command, arg, platform)
    try {
      launch(plan.command, plan.args, plan.options).unref()
      return { path: wanted, target, opener: command }
    } catch (error) {
      if (classifyLaunchFailure(error) === 'missing') {
        // It was not there after all (a stale configured path, or it vanished between the probe and
        // the spawn). That is the same "editor missing" fall-through as above, not a defect.
        tried.pop()
        missing.push(command)
        continue
      }
      // Not "there is no such editor" but "the system refused this launch" — the case the old
      // empty catch hid. Warn, then still give the next candidate a chance.
      const reason = error instanceof Error ? error.message : String(error)
      refused.push(`${command}（${reason}）`)
      warn(`[avantf-mem] 无法用 ${command} 打开「${wanted}」：${reason}；改用下一个候选`)
    }
  }
  if (tried.length === 0) {
    throw new Error(
      missing.length === 0
        ? '没有可用的编辑器：设置 knowledge.open.editor（或 $EDITOR / $AVANTF_EDITOR），或安装 code / xdg-open'
        : `没有可用的编辑器：${missing.join('、')} 不存在（PATH 上没有该命令，或该路径不可用）`,
    )
  }
  const detail = refused.length === 0 ? '' : `；启动被拒绝：${refused.join('、')}`
  throw new Error(`无法启动编辑器（试过：${tried.join('、')}${detail}）`)
}
