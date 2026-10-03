/**
 * Managed document files: one editable `.md` per document, under `knowledge.docs.dir`.
 *
 * Why a copy at all, given the database already stores the body as chunks: so the corpus can be
 * maintained with ordinary tools (`vim`, `git diff`, `rg`) instead of through a form. The file is
 * the thing a human edits; the database stays the thing that can be searched (FTS, vectors,
 * entities) and the thing that owns IDENTITY — hence the frontmatter, which carries the `doc_id`
 * the file belongs to. That is what keeps a rename or a title tweak from silently becoming a
 * second document: the path is derived, but the `doc_id` in the file is the authority, and a file
 * whose `doc_id` disagrees gets its own suffixed path instead of stealing another document's.
 *
 * The copy is a SNAPSHOT: `source_uri` is read once at ingest time, so editing or deleting these
 * files can never touch the file a document came from. The flip side is that a later change to
 * that origin is invisible here — pulling it in means ingesting it again.
 *
 * Staleness is a content hash, not an mtime: `content_hash` records the body that was ingested,
 * so "edited since" is exact even when a tool rewrites the file with the same timestamp. mtime is
 * only a cheap pre-check.
 *
 * @module store/doc_files
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { forEachYielding } from './common.js'

/** The frontmatter a managed file carries; `content_hash` is the body AS INGESTED. */
interface DocFileMeta {
  doc_id: number
  domain: string
  source: string
  title: string
  source_uri: string | null
  ingested_at: string
  content_hash: string
  /**
   * The `@avantf/mem-convert` converter that produced the body, when the source was converted
   * (absent for text and PDF, and for every file written before this field existed — readers must
   * treat it as optional, which is why it is not `null`).
   */
  converter?: string
}

/** One managed file as the file system sees it now. */
interface DocFileState {
  path: string
  stale: boolean
  missing: boolean
}

/** A parsed managed file: frontmatter (possibly partial — a hand-written file may omit it) + body. */
interface ParsedDocFile {
  meta: Partial<DocFileMeta>
  body: string
}

const FRONTMATTER_OPEN = '---\n'
const FRONTMATTER_CLOSE = '\n---\n'

/** Characters no portable file name may contain, plus the Windows reserved punctuation. */
const UNSAFE = /[\\/:*?"<>|]/g
/** Control characters are illegal in file names on every platform. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g
/** A path segment longer than this is truncated; well under every platform's 255-byte limit. */
const MAX_SEGMENT = 80
/**
 * Windows device names. `CON.md` is still the console device there, so a document titled "con"
 * would make the managed copy impossible to write (and the write is the only step that could fail
 * silently — it is reported, but the file would simply never exist).
 */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** One path segment, made safe and human-readable; `fallback` covers names that sanitize away. */
export function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(UNSAFE, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  const capped = cleaned.length > MAX_SEGMENT ? cleaned.slice(0, MAX_SEGMENT).replace(/[. ]+$/, '') : cleaned
  if (capped === '') return fallback
  // Prefix rather than suffix: `CON-` is fine on Windows, and the name stays recognizable.
  return WINDOWS_DEVICE.test(capped) ? `_${capped}` : capped
}

/**
 * Strip the block-level markers a line can open with, so a first-line title is readable text.
 *
 * Order matters only for stacking (`> - item`); each pattern is anchored, so a `#` that is part of a
 * word (`#include`) simply loses the `#` rather than being mistaken for a heading.
 */
function stripLineMarkers(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^(?:>\s*)+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim()
}

/**
 * A stable title for a body that arrived as TEXT (a paste), where there is no file name to borrow.
 *
 * Pasted text has no `source_uri` to name it after, and `source` defaults to the same value for
 * every paste — so without this, every untitled paste into one domain collapsed onto one identity
 * and the second ingest silently replaced the first. The rule: the first Markdown ATX heading,
 * else the first non-empty line with its block markers stripped.
 *
 * Fenced code is stepped over in BOTH halves: `#include` is not a heading, and a fence opener is
 * not a title. `MAX_SEGMENT` is the same cap the file name uses, so a long line cannot produce a
 * title the managed path has to truncate differently. Empty input falls back to `untitled`, and the
 * result depends only on the text (same body → same title), which is what keeps a re-paste
 * landing on the SAME identity instead of quietly creating a sibling every time.
 */
export function deriveDocTitle(text: string): string {
  let inFence = false
  let heading: string | null = null
  let firstLine: string | null = null
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (heading === null) {
      const match = /^#{1,6}\s+(.+)$/.exec(trimmed)
      if (match) heading = match[1]!.trim()
    }
    if (firstLine === null) firstLine = stripLineMarkers(trimmed)
  }
  const raw = (heading ?? firstLine ?? '').trim()
  const capped = raw.length > MAX_SEGMENT ? raw.slice(0, MAX_SEGMENT).trim() : raw
  return capped === '' ? 'untitled' : capped
}

/** sha256 of a document body — the staleness key. */
export function bodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/**
 * Render one managed file: frontmatter (JSON-encoded values, so any title/URI survives) + body.
 *
 * The body is written VERBATIM — no trailing newline is added. `content_hash` records the ingested
 * text, and `state` compares it against the file's body, so anything this function normalizes
 * would make every document read as edited the moment it was written.
 *
 * An `undefined` value is OMITTED rather than rendered: JSON.stringify(undefined) is the bare token
 * `undefined`, which the tolerant parser would then hand back as the string "undefined". Optional
 * keys (today: `converter`) therefore simply do not appear for the documents that lack them.
 */
export function renderDocFile(meta: DocFileMeta, body: string): string {
  const lines = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `${FRONTMATTER_OPEN}${lines.join('\n')}${FRONTMATTER_CLOSE}${body}`
}

/**
 * Split one managed file into frontmatter and body.
 *
 * Deliberately tolerant: a file without frontmatter (or with a hand-mangled one) is ALL body —
 * the user's content is never thrown away because a header key is missing, and the caller decides
 * what an unknown `doc_id` means.
 */
export function parseDocFile(text: string): ParsedDocFile {
  if (!text.startsWith(FRONTMATTER_OPEN)) return { meta: {}, body: text }
  const end = text.indexOf(FRONTMATTER_CLOSE, FRONTMATTER_OPEN.length)
  if (end < 0) return { meta: {}, body: text }
  const meta: Record<string, unknown> = {}
  for (const line of text.slice(FRONTMATTER_OPEN.length, end).split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const raw = line.slice(at + 1).trim()
    try {
      meta[key] = JSON.parse(raw)
    } catch {
      meta[key] = raw
    }
  }
  return { meta: meta as Partial<DocFileMeta>, body: text.slice(end + FRONTMATTER_CLOSE.length) }
}

/** True when this file's frontmatter says it belongs to `docId`. */
function belongsTo(meta: Partial<DocFileMeta>, docId: number): boolean {
  return meta.doc_id === docId
}

/**
 * The managed document directory.
 *
 * Paths are `<root>/<domain>/<source>/<title>.md`, sanitized per segment. Collisions resolve by
 * asking the EXISTING file who it belongs to: a file whose frontmatter names another `doc_id` is
 * left alone and this document takes the `<title>~<doc_id>.md` variant. Without that check two
 * documents that sanitize to the same name would take turns clobbering each other.
 */
export class DocFiles {
  constructor(private readonly root: string) {}

  /** The directory holding one document's file (created on write, not here). */
  dirFor(domain: string, source: string): string {
    return join(this.root, sanitizeSegment(domain, 'domain'), sanitizeSegment(source, 'source'))
  }

  /**
   * The file NAME for a title, minus the directory: a title that is already a Markdown file name
   * (`kb ingest --uri notes.md` names the document after the file) must not become `notes.md.md`.
   */
  fileName(title: string, suffix = ''): string {
    const stem = sanitizeSegment(title, 'document').replace(/\.md$/i, '') || 'document'
    return `${stem}${suffix}.md`
  }

  /** The base path for a title (before collision handling). */
  basePath(domain: string, source: string, title: string): string {
    return join(this.dirFor(domain, source), this.fileName(title))
  }

  /**
   * The file this document owns: the base path, or its `~<doc_id>` variant when the base path is
   * taken by a DIFFERENT document. Purely derived — no state is written to answer this.
   */
  pathFor(docId: number, domain: string, source: string, title: string): string {
    const base = this.basePath(domain, source, title)
    const current = this.read(base)
    if (current === null || belongsTo(current.meta, docId)) return base
    return join(this.dirFor(domain, source), this.fileName(title, `~${String(docId)}`))
  }

  /** Write the managed file for one document (atomic: temp file + rename). Returns its path. */
  write(meta: DocFileMeta, body: string): string {
    const path = this.pathFor(meta.doc_id, meta.domain, meta.source, meta.title)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${String(process.pid)}`
    writeFileSync(tmp, renderDocFile(meta, body), 'utf8')
    renameSync(tmp, path)
    return path
  }

  /** Parse one managed file, or `null` when it does not exist. */
  read(path: string): ParsedDocFile | null {
    if (!existsSync(path)) return null
    try {
      return parseDocFile(readFileSync(path, 'utf8'))
    } catch {
      // An unreadable file (permissions, race with an editor's atomic save) reads as absent
      // rather than throwing out of a status call.
      return null
    }
  }

  /**
   * A cheap per-file stamp — `mtimeMs:size`, no reads — or `null` when the file is absent.
   *
   * This is a TRIGGER, never a judgement: same-second edits, coarse filesystem timestamps and
   * `cp -p` can all leave it unchanged, so a matching stamp means "probably unchanged" and only
   * `state()` (which hashes the body) decides. The point is that the common case costs one `stat`
   * per file instead of reading and hashing every file in the corpus.
   */
  stamp(path: string): string | null {
    try {
      const info = statSync(path)
      return `${String(info.mtimeMs)}:${String(info.size)}`
    } catch {
      return null
    }
  }

  /** Every `.md` path under the root. A directory walk WITHOUT reads — no frontmatter, no hashing. */
  listPaths(): string[] {
    const out: string[] = []
    const walk = (dir: string): void => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path)
      }
    }
    walk(this.root)
    return out.sort()
  }

  /** Is this document's file there, and does it still match what was ingested? */
  state(docId: number, domain: string, source: string, title: string): DocFileState {
    const path = this.pathFor(docId, domain, source, title)
    const parsed = this.read(path)
    if (parsed === null || !belongsTo(parsed.meta, docId)) return { path, stale: false, missing: true }
    return {
      path,
      stale: parsed.meta.content_hash === undefined || parsed.meta.content_hash !== bodyHash(parsed.body),
      missing: false,
    }
  }

  /** Delete this document's file. `false` when there was nothing to delete. */
  remove(docId: number, domain: string, source: string, title: string): boolean {
    const path = this.pathFor(docId, domain, source, title)
    if (!existsSync(path)) return false
    rmSync(path)
    return true
  }

  /**
   * Every `.md` under the root, with the `doc_id` its frontmatter names (when it names one).
   * Used to report orphans — files left behind by a document that no longer exists.
   *
   * ASYNC and batched: the walk itself is an async recursive `readdir` (a `readdirSync` gathers
   * every entry in one ~41 ms call at 10k files), and the per-file parse is a `read` — at 10k
   * documents that is a second full read of the corpus on top of `sync`'s staleness pass, and it
   * used to be one uninterrupted synchronous block (performance review §7.5 / P6).
   */
  async scan(): Promise<{ path: string; doc_id?: number }[]> {
    if (!existsSync(this.root)) return []
    const found: { path: string; doc_id?: number }[] = []
    // The WALK is async too: `readdirSync(recursive)` gathers every entry in one synchronous call
    // (measured ~41 ms at 10k files) before the first yield, which would dominate the block the
    // batched reads below are trying to remove.
    const files = (await readdir(this.root, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    await forEachYielding(files, (entry) => {
      // `parentPath` is Node ≥20.12; the fallback keeps this working on anything older.
      const path = join(entry.parentPath ?? this.root, entry.name)
      const parsed = this.read(path)
      found.push({
        path: relative(this.root, path).split(sep).join('/'),
        ...(parsed?.meta.doc_id === undefined ? {} : { doc_id: parsed.meta.doc_id }),
      })
    })
    return found
  }
}
