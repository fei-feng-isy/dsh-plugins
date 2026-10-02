import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * User-editable prompt text: one `.md` per prompt section, in the family's shared prompt directory
 * (`<data home>/prompts`, where each plugin owns a prefix — `mem-*` in the memory plugin, `mission-*`
 * in the mission engine). Since generation v3 that prefix can be declared as
 * {@link PromptFilesOptions.namespace} and is then validated by this module, so a mistyped prefix can
 * no longer silently read or fill another plugin's user file; omitting the field keeps the pre-v3
 * behaviour (no prefix check) for callers built against v1/v2.
 *
 * This lived, byte-for-byte identical except for its header comment, in BOTH plugins
 * (`@avantf/dsh-mem`'s and `@avantf/dsh-mission`'s `packages/plugin/src/prompt_files.ts`) — the copy
 * was deliberate while the two were separate repositories with no shared family package, and the two
 * headers said "if a third consumer appears, hoist it into one shared package rather than copy it
 * again". The merge into one workspace is that moment: it now lives in the base
 * (`@avantf/dsh-plugin-base/kit`), and a plugin takes it off the base module at RUNTIME, loaded by
 * the inlined bootstrap. It is deliberately NOT inlined into a plugin bundle: a fix to the shared
 * prompt layer must ship as ONE base release, with no rebuild or republish of any plugin. When the
 * base is absent, the plugin degrades instead of failing — the prompt layer is unavailable and the
 * plugin uses its OWN built-in default bodies (the defaults are the plugin's content, not a copy of
 * this module).
 *
 * Every prompt section a plugin contributes has the SAME lifecycle — the file has to exist, a
 * missing or blank one is filled with the built-in default, and what is on disk wins on the next
 * start — so that flow lives here ONCE instead of once per section next to each default string. The
 * caller owns the manifest (file name, which section it feeds, the default body); this owns HOW the
 * file is materialized and read, the same division of labour `GitRepo` (in the engine) uses for the
 * on-disk artifacts it versions without knowing what they are.
 *
 * THREE PROPERTIES ARE LOAD-BEARING, and they are why this is not `readFileSync` at each call site:
 *
 *  - **It never throws.** A read-only data home, a directory sitting where a file should be, a
 *    permission error — none of them may keep a plugin from mounting, because a throwing `apply`
 *    fails the whole `dsh web` boot (measured). Every failure warns and falls back to the default
 *    text, the same rule `IngestResult.file_error` follows for the managed document copy.
 *  - **It never overwrites what the user wrote.** Only a missing file or a blank one is written; one
 *    visible character makes the file the user's, including a wrong one.
 *  - **The file IS the prompt.** Its whole body is injected (outer whitespace trimmed, BOM stripped,
 *    CRLF normalized). There is no frontmatter, no marker and no header comment to strip — a comment
 *    would be injected into the model's prompt too, so the default files carry none, and the
 *    documentation for them lives in DESIGN and the README.
 */
export interface PromptFileSpec {
  /** File name inside the prompt directory; it is also the handle used in log lines. */
  readonly file: string
  /** Written when the file is missing or blank; also the text used when the disk is unusable. */
  readonly fallback: string
}

export interface LoadedPromptText {
  readonly file: string
  readonly path: string
  /** The text to inject: the file's body, or the fallback when the file could not be used. */
  readonly text: string
  /**
   * `file` — read from disk and used as-is.
   * `default` — the default was used, either because it was just written (missing/blank) or because
   * the file could not be read/created. `wrote` says which.
   */
  readonly source: 'file' | 'default'
  /** True when this call created or filled the file. */
  readonly wrote: boolean
}

/** The filesystem slice this module uses; injectable so its specs need no real directory. */
export interface PromptFilesIo {
  exists(path: string): boolean
  read(path: string): string
  /** Must land atomically (temp file + rename), so a crash cannot leave a half-written prompt. */
  write(path: string, text: string): void
  ensureDir(path: string): void
}

/** Structurally what a plugin logger already is; declared locally to keep this module dependency-free. */
export interface PromptFilesLogger {
  info(message: string): void
  warn(message: string): void
}

export interface PromptFilesOptions {
  /** Directory holding one `.md` per section. Created when missing. */
  readonly dir: string
  /**
   * The plugin's file-name prefix inside the SHARED prompt directory — `mem` for `mem-*.md`,
   * `mission` for `mission-*.md`.
   *
   * `<data home>/prompts` is one directory shared by every plugin in the family, and until v3 the
   * `mem-*` / `mission-*` prefix was a convention with NO machine check: a third plugin could declare
   * `mem-foo.md` and silently take over (or fill) a file the memory plugin's user owns. Naming the
   * namespace here turns that convention into a field the base validates.
   *
   * **Optional, and omitting it is fully backward compatible** — a caller that does not pass it gets
   * byte-for-byte the pre-v3 behaviour (no prefix check at all). That is deliberate: the two installed
   * plugins were built against v1/v2 and must keep working against a v3 base without a change.
   *
   * A namespace must be a kebab-case token (`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`). An ILLEGAL namespace
   * is a caller bug, but this module's absolute property is that the prompt layer never throws: a bad
   * namespace therefore makes every {@link PromptFiles.load} on this instance degrade to the caller's
   * fallback with a WARNING, WITHOUT touching the disk (never a throw, never a read or write). When the
   * namespace IS valid, every {@link PromptFileSpec.file} must be `<namespace>-…` and must be a bare
   * file name; a spec that is not is skipped the same way (warning + fallback, no disk access), so a
   * mistyped prefix can never read or overwrite another plugin's user file.
   */
  readonly namespace?: string
  readonly logger?: PromptFilesLogger
  /** Overridable for tests; defaults to the real filesystem. */
  readonly io?: PromptFilesIo
}

/** A legal namespace: lowercase kebab-case, starting with a letter. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** The temp files {@link nodeIo.write} leaves beside a prompt file, and the age past which one
 *  certainly belongs to a writer that will never rename it. Same discipline as the provisioner's
 *  `fs.ts`, which sweeps `.atomic-*` the same way. */
const TEMP_SUFFIX = /\.tmp-\d+$/
const STALE_TEMP_MS = 5 * 60_000

/** Best-effort removal of dead sibling temps, so a crash never leaves litter in the user's own
 *  `prompts/` directory — that directory is theirs (hand-edited files live in it), not ours. */
function sweepStaleTemps(dir: string, keep: string): void {
  let entries: readonly string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!TEMP_SUFFIX.test(entry)) continue
    const candidate = join(dir, entry)
    if (candidate === keep) continue
    try {
      if (now - statSync(candidate).mtimeMs > STALE_TEMP_MS) rmSync(candidate, { force: true })
    } catch {
      // A temp that vanished under us is already gone.
    }
  }
}

const nodeIo: PromptFilesIo = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => {
    const tmp = `${path}.tmp-${String(process.pid)}`
    // Write-then-rename so a reader never sees a half-written prompt. A crash in between used to
    // leave `.tmp-<pid>` behind FOREVER: sweep the dead ones first, and drop this one if the rename
    // is the step that fails (a directory sitting where the file belongs is the everyday case).
    sweepStaleTemps(dirname(path), tmp)
    try {
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, path)
    } catch (error) {
      rmSync(tmp, { force: true })
      throw error
    }
  },
  ensureDir: (path) => {
    mkdirSync(path, { recursive: true })
  },
}

/** BOM off, CRLF in, outer whitespace off: what the file means, not what the editor left behind. */
function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/gu, '\n').trim()
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PromptFiles {
  readonly dir: string
  /** The validated namespace prefix, or `undefined` (pre-v3 behaviour: no prefix check). */
  readonly namespace: string | undefined
  /** Set when `namespace` was supplied but illegal; every `load` then degrades without touching disk. */
  private readonly namespaceError: string | undefined
  private readonly logger: PromptFilesLogger | undefined
  private readonly io: PromptFilesIo

  constructor(options: PromptFilesOptions) {
    if (options.namespace !== undefined && !NAMESPACE_PATTERN.test(options.namespace)) {
      // A caller bug, not an environment failure. It must not throw (this module never throws — a
      // throwing apply can fail a host boot), but it must also not fall back to "no prefix check",
      // which would silently re-open the takeover hole. So the instance refuses to touch the prompt
      // directory at all and warns on every load.
      this.namespaceError = `PromptFiles: namespace ${JSON.stringify(options.namespace)} is not a legal prefix; expected lowercase kebab-case matching ${String(NAMESPACE_PATTERN)}`
      this.namespace = undefined
    } else {
      this.namespaceError = undefined
      this.namespace = options.namespace
    }
    this.dir = options.dir
    this.logger = options.logger
    this.io = options.io ?? nodeIo
  }

  /**
   * Whether `file` belongs to this instance's namespace. `true` when no namespace was given (the
   * legacy contract: the caller owns the whole directory naming convention as before).
   */
  private ownsFile(file: string): boolean {
    const prefix = this.namespace
    if (prefix === undefined) return true
    if (!file.startsWith(`${prefix}-`)) return false
    return !file.includes('/') && !file.includes('\\')
  }

  /**
   * Ensure every spec's file exists with content, then return the text to inject. Ordered like the
   * manifest, so the caller can zip the result back onto its sections.
   */
  load(specs: readonly PromptFileSpec[]): readonly LoadedPromptText[] {
    const fallbackOf = (spec: PromptFileSpec): LoadedPromptText => ({
      file: spec.file,
      path: join(this.dir, spec.file),
      text: normalize(spec.fallback),
      source: 'default',
      wrote: false,
    })
    if (this.namespaceError !== undefined) {
      this.logger?.warn(`${this.namespaceError}; using the built-in defaults and not touching the prompt directory`)
      return specs.map(fallbackOf)
    }
    if (this.namespace !== undefined && specs.some((spec) => !this.ownsFile(spec.file))) {
      // Never touch disk for the offending spec: the whole point of the namespace is that a mistyped
      // prefix must not read or write a file another plugin's user owns. Warn per offending file and
      // degrade to the caller's fallback, exactly like the unusable-directory path.
      for (const spec of specs) {
        if (!this.ownsFile(spec.file)) {
          this.logger?.warn(
            `prompt file ${spec.file} is outside the "${this.namespace}-" namespace; using the built-in default and not touching the prompt directory`,
          )
        }
      }
      return specs.map((spec) => (this.ownsFile(spec.file) ? this.loadOne(spec) : fallbackOf(spec)))
    }
    try {
      this.io.ensureDir(this.dir)
    } catch (error) {
      // One warning for the directory, not one per file: the cause is the same for all of them.
      this.logger?.warn(`prompt directory ${this.dir} is unusable (${reason(error)}); using the built-in prompts`)
      return specs.map(fallbackOf)
    }
    return specs.map((spec) => this.loadOne(spec))
  }

  private loadOne(spec: PromptFileSpec): LoadedPromptText {
    const path = join(this.dir, spec.file)
    const fallback = normalize(spec.fallback)
    const failed = (error: unknown): LoadedPromptText => {
      this.logger?.warn(`prompt file ${path} is unusable (${reason(error)}); using the built-in default`)
      return { file: spec.file, path, text: fallback, source: 'default', wrote: false }
    }
    try {
      if (this.io.exists(path)) {
        const text = normalize(this.io.read(path))
        // A file the user edited is used verbatim — including one we would word differently.
        if (text !== '') return { file: spec.file, path, text, source: 'file', wrote: false }
        // Blank is not an edit, it is an unfinished one: fill it (the caller's own rule).
        this.io.write(path, `${fallback}\n`)
        this.logger?.info(`prompt file was blank and has been filled: ${path}`)
        return { file: spec.file, path, text: fallback, source: 'default', wrote: true }
      }
      this.io.write(path, `${fallback}\n`)
      this.logger?.info(`prompt file created: ${path}`)
      return { file: spec.file, path, text: fallback, source: 'default', wrote: true }
    } catch (error) {
      return failed(error)
    }
  }
}
