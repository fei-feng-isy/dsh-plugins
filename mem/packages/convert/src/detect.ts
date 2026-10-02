/**
 * Shared detection helpers: what the path says, and what the leading bytes say.
 *
 * @module detect
 */
import { zipEntryNames } from './zip.js'

/** The ZIP local-file header, the first bytes of docx/xlsx/pptx/epub (and any ordinary zip). */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

/** Does this document begin with a ZIP local-file header? */
export function startsWithZipMagic(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte)
}

/**
 * The archive's entry names when the bytes are a ZIP, `null` otherwise.
 *
 * Central-directory names are what separates the Office formats; callers must not fall back to the
 * extension when this returns `null`, because "it is named .docx" is not evidence that mammoth can
 * read it (an OLE `.doc` renamed to `.docx` is the everyday counterexample).
 */
export function zipEntries(bytes: Uint8Array): string[] | null {
  if (!startsWithZipMagic(bytes)) return null
  return zipEntryNames(bytes)
}

/**
 * The lower-cased extension of a path or URL, dot included, or `''`.
 *
 * A URL's query/fragment is stripped first (`…/data.csv?raw=1` is still a `.csv`) and Windows
 * separators are accepted, because a `source_uri` on Windows arrives with backslashes.
 */
export function extensionOf(path: string | undefined): string {
  if (path === undefined) return ''
  const cleaned = path.replace(/\\/g, '/').split(/[?#]/, 1)[0] ?? ''
  const base = cleaned.slice(cleaned.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/**
 * Extensions whose content the pipeline already serves as plain text.
 *
 * Content-based sniffing (HTML markup, a delimited table) declines these, so a Markdown file that
 * happens to contain `<html` or a `.txt` of comma-separated prose keeps taking the ordinary text
 * path it took before this package existed. A format that is recognized by BYTES (docx/xlsx) is not
 * affected: magic wins over the extension in both directions.
 */
export const PLAIN_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.text', '.json', '.jsonl', '.yaml', '.yml',
])
