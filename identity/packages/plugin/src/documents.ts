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
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

/** `IDENTITY.md` → `IDENTITY`, or `undefined` when the name is not one of the three. */
export function identityNameOf(file: string): IdentityFileName | undefined {
  const bare = file.endsWith('.md') ? file.slice(0, -3) : file
  return (IDENTITY_FILES as readonly string[]).includes(bare) ? bare as IdentityFileName : undefined
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
   * The prompt text: the non-empty bodies joined by one blank line, truncated to `maxBytes` (when it
   * is positive) with a visible notice appended and a warning naming the files that overflowed.
   */
  render(): string {
    const bodies = IDENTITY_FILES.map((name) => this.read(name).trim()).filter((body) => body !== '')
    if (bodies.length === 0) return ''
    const text = bodies.join('\n\n')
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
   * Write one file atomically (temp + rename), so an assembly reading concurrently sees either the old
   * text or the new one, never a half-written file.
   */
  write(name: IdentityFileName, text: string): void {
    // Defence in depth: the callers validate too, and a name that is not one of the three must never
    // be turned into a path segment under the data home.
    if (!(IDENTITY_FILES as readonly string[]).includes(name)) throw new Error(`unknown identity file: ${String(name)}`)
    mkdirSync(this.dir, { recursive: true })
    const target = this.pathOf(name)
    const temporary = `${target}.tmp-${String(process.pid)}`
    try {
      writeFileSync(temporary, text, 'utf8')
      renameSync(temporary, target)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // The temp file may not exist; the original failure is the one that matters.
      }
      throw error
    } finally {
      this.invalidate()
    }
  }

  /** The identity directory itself; exported so a caller need not re-derive it. */
  get root(): string {
    return dirname(this.dir)
  }
}
