/**
 * What one pasted "source" string IS, and browsing the machine for one.
 *
 * The 知识 tab has a single input for "where the document comes from", so something has to decide
 * between a URL, a local file, a local directory, and a paragraph of pasted text. That decision
 * needs the FILE SYSTEM (`existsSync`, realpath, the ingestion boundary), which only the host has —
 * a browser can check `^https?://` and nothing else. Both functions here therefore live in core and
 * answer over the UI-only Remote methods, and both use the SAME boundary as ingestion:
 * {@link resolveLocalSource}, so a path the picker offers is a path `kb_manage ingest` can read.
 *
 * @module store/source_picker
 */
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { allowedLocalRoots, resolveLocalSource, type IngestLimits } from './ingest_guard.js'

/**
 * Extensions a directory walk will take. The single source for both the walk and the picker.
 *
 * A curated list, matching the formats the pipeline actually serves: the pipeline's own text formats
 * and PDF, everything the pinned pandoc reads (the reader table is `PANDOC_READERS` in
 * `@avantf/mem-convert`), and `.xlsx` (the built-in exceljs converter, because pandoc has no
 * spreadsheet reader). A format that is NOT here (pptx, the legacy OLE .doc/.xls/.ppt, images) is
 * reported as skipped by a walk, and refused with its detected type when named explicitly — an
 * explicitly named file is never filtered by this list (see `classifySource`).
 *
 * Kept in sync with the model-facing description in `@avantf/mem-contract`'s `kb_add`/`kb_manage`
 * specs and with DESIGN §8; `source_picker.spec.ts` asserts the two never drift apart.
 */
const INGESTABLE = /\.(md|markdown|txt|text|json|jsonl|yaml|yml|pdf|docx|docm|odt|epub|html|htm|xhtml|tex|latex|ltx|rst|rest|ipynb|csv|tsv|org|textile|fb2|opml|bib|dbk|man|rtf|typ|xlsx)$/i

/** What one source string turned out to be. */
export type SourceKind = 'url' | 'file' | 'directory' | 'text' | 'missing'

/** The answer the UI needs to label the input and pick the right `kb_manage` action. */
export interface SourceClassification {
  kind: SourceKind
  /** Resolved, boundary-checked absolute paths (when `kind` is `file`/`directory`). */
  paths: string[]
  /** Inputs that look like paths but do not resolve, or resolve outside the allowed roots. */
  missing: string[]
  /** Why the missing ones are missing (the boundary's own message; they differ per input). */
  reasons: string[]
  /** How many files a directory holds that ingestion would actually take. */
  files: number
}

/** Split one source string the way `kb import` does: whitespace or comma separated. */
export function splitSourceInput(raw: string): string[] {
  return raw.split(/[\s,，]+/).map(part => part.trim()).filter(Boolean)
}

/**
 * Walk one directory for ingestable files: text formats plus PDF.
 *
 * Everything else is reported as SKIPPED rather than dropped silently — a directory of 200 files
 * where 3 were ingested and 197 ignored used to look exactly like a directory of 3 files.
 */
export function listTextFiles(dir: string): { files: string[]; skipped: string[] } {
  const files: string[] = []
  const skipped: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue // never follow symlinks: avoids loops and escaping the tree
    if (entry.isDirectory()) {
      const inner = listTextFiles(path)
      files.push(...inner.files)
      skipped.push(...inner.skipped)
    } else if (INGESTABLE.test(entry.name)) files.push(path)
    else skipped.push(path)
  }
  return { files, skipped }
}

/** Would ingestion take this file name? */
export function isIngestableFile(name: string): boolean {
  return INGESTABLE.test(name)
}

/**
 * Does this token READ as a path rather than as a word of prose?
 *
 * Used only to tell "no, this is a paragraph" from "this looks like a path that does not exist":
 * a typo'd `~/docs/spce.md` must be reported as missing, while `网关设计规范：平台组负责…` must be
 * treated as text. A slash, a leading `~`/`.`/`/`, or an ingestable extension is the whole test.
 */
function pathShaped(token: string): boolean {
  return token.startsWith('/') || token.startsWith('~') || token.startsWith('.')
    || token.includes('/') || token.includes('\\') || INGESTABLE.test(token)
}

/** One absolute path, or the reason it could not be used. */
function resolveCandidate(token: string, limits: IngestLimits): { path: string } | { error: string } {
  try {
    return { path: resolveLocalSource(token, limits) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Classify one source input without ingesting anything.
 *
 * The order matters: a URL wins outright, then anything that resolves on disk (several paths, a
 * directory, a file), then a path-SHAPED input that does not resolve is `missing` (a typo, or a
 * path outside the boundary — the reason says which), and only then is it pasted text. Long or
 * many-token inputs skip the filesystem probes entirely: prose is not a path list, and a paragraph
 * should not cost thousands of `stat` calls.
 */
export function classifySource(raw: string, limits: IngestLimits): SourceClassification {
  const text = raw.trim()
  if (/^https?:\/\//i.test(text)) return { kind: 'url', paths: [], missing: [], reasons: [], files: 0 }

  // The WHOLE input is tried as ONE path before any splitting. A path may contain spaces — very
  // common on Windows (`C:\\Users\\me\\My Documents\\a.md`) and ordinary anywhere else — and the picker
  // hands back exactly such a path. Splitting first made those come back as "not found".
  if (text.length <= 1024) {
    const single = resolveCandidate(text, limits)
    if ('path' in single) return describePaths([single.path])
  }

  const tokens = splitSourceInput(text)
  const probe = tokens.length > 0 && tokens.length <= 8 && text.length <= 1024
  if (!probe) return { kind: 'text', paths: [], missing: [], reasons: [], files: 0 }

  const paths: string[] = []
  const missing: string[] = []
  const reasons: string[] = []
  for (const token of tokens) {
    const candidate = resolveCandidate(token, limits)
    if ('path' in candidate) paths.push(candidate.path)
    else {
      missing.push(token)
      reasons.push(candidate.error)
    }
  }
  if (missing.length > 0) {
    // Partly-resolvable input is a broken path LIST (a typo, or one path outside the roots); prose
    // never resolves even one token, and that case is handled below.
    return paths.length > 0 || tokens.some(pathShaped)
      ? { kind: 'missing', paths, missing, reasons, files: 0 }
      : { kind: 'text', paths: [], missing: [], reasons: [], files: 0 }
  }

  return describePaths(paths)
}

/** One resolved path list → the kind the UI dispatches on (a directory means `kb_manage import`). */
function describePaths(paths: string[]): SourceClassification {
  const directories = paths.filter(path => statSync(path).isDirectory())
  if (directories.length > 0) {
    const files = directories.reduce((total, dir) => total + listTextFiles(dir).files.length, 0)
    return { kind: 'directory', paths, missing: [], reasons: [], files }
  }
  return { kind: 'file', paths, missing: [], reasons: [], files: paths.length }
}

/** One row of a directory listing. */
export interface BrowseEntry {
  name: string
  path: string
  /** `dir` navigates; `ingestable` can be picked; `other` exists but ingestion would refuse it. */
  kind: 'dir' | 'ingestable' | 'other'
}

/** One directory as the picker sees it. */
export interface BrowseListing {
  path: string
  /** The parent directory, or `null` when this is an allowed root (or the filesystem root). */
  parent: string | null
  /** The configured roots — what the picker may walk when `unrestricted` is false. */
  roots: string[]
  /**
   * `knowledge.ingest.allow_outside_workspace`: the whole filesystem is fair game, so `roots` is
   * informational only and the UI must say "不限制" rather than show a boundary it does not honour.
   */
  unrestricted: boolean
  entries: BrowseEntry[]
}

function insideRoots(path: string, roots: readonly string[], allowAnywhere: boolean): boolean {
  if (allowAnywhere) return true
  return roots.some(root => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))
}

/**
 * List one directory for the picker.
 *
 * `requested` empty ⇒ the first allowed root. Every requested path goes through
 * {@link resolveLocalSource}, so the picker can never show (or hand back) a directory that
 * ingestion would refuse; `parent` stops at a root for the same reason.
 */
export function browseDirectory(requested: string | undefined, limits: IngestLimits): BrowseListing {
  const roots = allowedLocalRoots(limits)
  // With the boundary lifted, `roots` is just [cwd] and starting there would drop the operator into
  // the DSH profile directory; their home is where their documents actually are.
  const start = limits.allow_outside_workspace ? homedir() : roots[0] ?? process.cwd()
  const wanted = requested === undefined || requested.trim() === '' ? start : requested.trim()
  const path = resolveLocalSource(wanted, limits)
  if (!statSync(path).isDirectory()) throw new Error(`不是目录：${path}`)
  const entries = readdirSync(path, { withFileTypes: true })
    .map((entry): BrowseEntry => ({
      name: entry.name,
      path: join(path, entry.name),
      kind: entry.isDirectory() ? 'dir' : entry.isFile() && INGESTABLE.test(entry.name) ? 'ingestable' : 'other',
    }))
    .sort((a, b) => {
      const rank = (entry: BrowseEntry): number => (entry.kind === 'dir' ? 0 : entry.kind === 'ingestable' ? 1 : 2)
      return rank(a) - rank(b) || a.name.localeCompare(b.name)
    })
  const up = dirname(path)
  const parent = up !== path && insideRoots(up, roots, limits.allow_outside_workspace) ? up : null
  return { path, parent, roots, unrestricted: limits.allow_outside_workspace, entries }
}
