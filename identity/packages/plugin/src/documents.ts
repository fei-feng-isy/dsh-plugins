/**
 * The three files of one identity: reading them, rendering them into prompt text, and writing them.
 *
 * The render is the spec's §3.5: `IDENTITY.md` → `SOUL.md` → `RULES.md`, non-empty bodies only, one
 * blank line between them, no headings and no frontmatter — the file's whole text IS the prompt, the
 * same discipline the family's `PromptFiles` follows. A read is cached per `(mtimeMs, size)` so an
 * assembly does not hit the disk three times per model step, and the cache is invalidated explicitly
 * after a UI write (an external editor's change is picked up by the stat, not by a watcher — the
 * semantics the README states).
 *
 * Nothing here throws: this runs inside prompt assembly, where a throw would destroy a model call. An
 * unreadable file reads as absent, and an unwritable one answers its caller with an error string.
 *
 * @module @avantf/dsh-identity/documents
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from './atomic-write.js'
import type { IdentityLogger } from './log.js'
import { IDENTITY_FILES, type IdentityFileName } from './paths.js'

/** One file's state, as the settings page reports it. */
export interface DocumentStatus {
  readonly name: IdentityFileName
  readonly file: string
  readonly path: string
  readonly present: boolean
  readonly bytes: number
}

/** One file's content, as the settings page reads it. */
export interface DocumentText {
  readonly name: IdentityFileName
  readonly file: string
  readonly text: string
  readonly present: boolean
  readonly bytes: number
}

interface CacheEntry {
  readonly mtimeMs: number
  readonly size: number
  readonly text: string
}

/** `IDENTITY` → `IDENTITY.md`. */
export function fileNameOf(name: string): string {
  return `${name}.md`
}

/**
 * The heading the rendered prompt puts above the rules part, in the language of the rules text.
 *
 * `RULES.md` is the one part the render adds a heading to (see {@link IdentityDocuments.render} for why
 * the other two are left alone). Two things about it are deliberate:
 *
 *  - **The language follows the body, not the UI.** The renderer has no locale service (it runs inside
 *    prompt assembly, where the client's language is neither knowable nor stable), and following the
 *    client would make the SAME session's prompt text depend on a live setting — the one thing §3.6
 *    freezes. Reading it off the text is deterministic: the same file always renders the same bytes.
 *  - **`规则`, the same word the settings page shows.** A heading the user cannot find in the UI is a
 *    second vocabulary to learn; `硬约束` (what the built-in presets call it in their own first line)
 *    would be a third.
 */
function rulesHeading(body: string): string {
  return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(body) ? '**规则**' : '**Rules**'
}

/** The rendered text of one identity directory, plus its per-file provenance. */
export class IdentityDocuments {
  private readonly cache = new Map<IdentityFileName, CacheEntry>()

  constructor(
    private readonly dir: string,
    private readonly options: { readonly logger?: IdentityLogger; readonly maxBytes: () => number } = { maxBytes: () => 0 },
  ) {}

  /** The directory the three files live in. */
  get directory(): string {
    return this.dir
  }

  /** One file's path. */
  pathOf(name: IdentityFileName): string {
    return join(this.dir, fileNameOf(name))
  }

  /**
   * Read one file, or `''` when it is absent or unreadable.
   *
   * Cached on `(mtimeMs, size)`: the two together are what a text editor changes, and the stat is an
   * order of magnitude cheaper than the read for the tens-of-KB files this holds.
   */
  read(name: IdentityFileName): string {
    const path = this.pathOf(name)
    try {
      const stat = statSync(path)
      const cached = this.cache.get(name)
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.text
      const text = readFileSync(path, 'utf8')
      this.cache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, text })
      return text
    } catch {
      this.cache.delete(name)
      return ''
    }
  }

  /** Every file's text, in render order. */
  readAll(): DocumentText[] {
    return IDENTITY_FILES.map((name) => {
      const text = this.read(name)
      return { name, file: fileNameOf(name), text, present: text.trim() !== '', bytes: Buffer.byteLength(text, 'utf8') }
    })
  }

  /** Every file's presence and size, without rendering. */
  status(): DocumentStatus[] {
    return IDENTITY_FILES.map((name) => {
      const text = this.read(name)
      return {
        name,
        file: fileNameOf(name),
        path: this.pathOf(name),
        present: text.trim() !== '',
        bytes: Buffer.byteLength(text, 'utf8'),
      }
    })
  }

  /**
   * The prompt text: the non-empty bodies joined by one blank line, the rules part under its own
   * heading (see {@link RULES_HEADING}), truncated to `maxBytes` (when it is positive) with a visible
   * notice appended and a warning naming the files that overflowed.
   */
  render(): string {
    const parts = IDENTITY_FILES
      .map((name) => ({ name, body: this.read(name).trim() }))
      .filter((part) => part.body !== '')
    if (parts.length === 0) return ''
    // ONE heading, on the rules part only, and only when it has a body. The other two are not labelled
    // on purpose: their difference is a matter of emphasis, not of kind, and a heading would freeze a
    // taxonomy the user may not share (write your own heading in the file — the file IS the prompt).
    // The rules are the one part whose TYPE differs (hard constraints vs descriptive identity), and
    // they are the part a reader most needs to be able to find again in a long prompt.
    const text = parts
      .map((part) => (part.name === 'RULES' ? `${rulesHeading(part.body)}\n\n${part.body}` : part.body))
      .join('\n\n')
    const maxBytes = this.options.maxBytes()
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return text
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
    // Truncate by BYTES, then drop a trailing partial code point: the budget is a byte budget because
    // that is what a model context is measured in, but a mangled final character would be the first
    // thing a reader notices.
    const truncated = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '')
    this.options.logger?.warn(
      `identity files exceed maxBytes=${String(maxBytes)}; truncated (files: ${this.status().filter((s) => s.present).map((s) => s.file).join(', ')})`,
    )
    return `${truncated}\n\n[identity files truncated at ${String(maxBytes)} bytes; the full text is in ${this.dir}]`
  }

  /** Total rendered-model bytes across the three files, without truncation. */
  bytes(): number {
    return this.status().reduce((total, file) => total + file.bytes, 0)
  }

  /** Drop the read cache, so the next read comes from disk. Called after every write. */
  invalidate(): void {
    this.cache.clear()
  }

  /**
   * Write one file atomically, so an assembly reading concurrently sees either the old text or the new
   * one, never a half-written file. The write itself is `writeFileAtomically`'s (shared with the preset
   * writers); the cache is dropped here, in a `finally`, so a failed write cannot leave it serving text
   * that is no longer on disk.
   */
  write(name: IdentityFileName, text: string): void {
    // Defence in depth: the callers validate too, and a name that is not one of the three must never
    // be turned into a path segment under the data home.
    if (!(IDENTITY_FILES as readonly string[]).includes(name)) throw new Error(`unknown identity file: ${String(name)}`)
    mkdirSync(this.dir, { recursive: true })
    try {
      writeFileAtomically(this.pathOf(name), text)
    } finally {
      this.invalidate()
    }
  }

  /** The identity directory itself; exported so a caller need not re-derive it. */
  get root(): string {
    return dirname(this.dir)
  }
}
