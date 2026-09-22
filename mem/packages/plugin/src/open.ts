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
 * @module open
 */
import { accessSync, constants } from 'node:fs'
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
export function commandFileNames(command: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [command]
  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => ext !== '')
  return [command, ...exts.map(ext => `${command}${ext.toLowerCase()}`), ...exts.map(ext => `${command}${ext}`)]
}

/** True when `command` is an executable on PATH (any of its platform file names). */
function onPath(command: string): boolean {
  const path = process.env['PATH']
  if (path === undefined || path === '') return false
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    for (const name of commandFileNames(command)) {
      try {
        accessSync(join(dir, name), constants.X_OK)
        return true
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return false
}

/** Is this a WSL process (where a Windows-side opener is often the only one that works)? */
function isWsl(): boolean {
  return process.platform === 'linux' && (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined)
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
}

/** Candidates in the order above, resolved against this machine. */
function candidates(configured: string): Candidate[] {
  const list: Candidate[] = []
  const explicit = configured !== '' ? configured : (process.env['AVANTF_EDITOR'] ?? '')
  if (explicit !== '') list.push({ command: explicit, arg: path => path })
  const shellEditor = process.env['VISUAL'] ?? process.env['EDITOR'] ?? ''
  if (shellEditor !== '') list.push({ command: shellEditor, arg: path => path })
  for (const editor of ['code', 'cursor']) {
    if (onPath(editor)) list.push({ command: editor, arg: path => path })
  }
  if (process.platform === 'darwin') list.push({ command: 'open', arg: path => path })
  if (process.platform === 'linux') {
    if (onPath('xdg-open')) list.push({ command: 'xdg-open', arg: path => path })
    // Last resort on WSL: Explorer opens a folder natively and hands a file to its default
    // application. It needs a Windows path, which `wslpath` is the only reliable source of.
    if (isWsl()) list.push({ command: 'explorer.exe', arg: path => windowsPath(path) })
  }
  if (process.platform === 'win32') list.push({ command: 'cmd', arg: path => path })
  return list
}

/**
 * Launch the configured/detected tool on one document path.
 *
 * @param documentPath - the managed `.md` path.
 * @param target - `file` opens the document, `dir` opens the directory that holds it.
 * @param configured - `knowledge.open.editor` from config (empty ⇒ auto-detect).
 * @throws when no candidate is available or every one of them fails to start.
 */
export function openDocumentPath(documentPath: string, target: OpenTarget, configured: string): OpenOutcome {
  const wanted = target === 'dir' ? dirname(documentPath) : documentPath
  const tried: string[] = []
  for (const candidate of candidates(configured)) {
    const arg = candidate.arg(wanted)
    if (arg === undefined) continue
    tried.push(candidate.command)
    try {
      const child = candidate.command === 'cmd'
        // `start` needs its own title argument before the path, or a quoted path becomes the title.
        ? spawn('cmd', ['/c', 'start', '', `"${arg}"`], { detached: true, stdio: 'ignore' }) // quoted: an
          // unquoted path with `&`/`^` would be parsed as a second command by cmd
        : spawn(candidate.command, [arg], { detached: true, stdio: 'ignore' })
      child.unref()
      // Spawn reports a missing binary asynchronously; a synchronous throw covers a bad
      // configuration (e.g. a path that is not executable), which is the case worth reporting.
      return { path: wanted, target, opener: candidate.command }
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    tried.length === 0
      ? '没有可用的编辑器：设置 knowledge.open.editor（或 $EDITOR / $AVANTF_EDITOR），或安装 code / xdg-open'
      : `无法启动编辑器（试过：${tried.join('、')}）`,
  )
}
