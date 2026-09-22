/**
 * Just enough ZIP to tell docx from xlsx from pptx from epub.
 *
 * docx, xlsx, pptx and epub are all ZIP archives, and they all begin with the same four bytes, so
 * the magic number alone cannot separate them — the only honest discriminator is an entry NAME from
 * the archive's central directory (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`,
 * and epub's uncompressed `mimetype`). This reader therefore exists purely to answer "does this ZIP
 * contain entry X?".
 *
 * It is deliberately ~60 lines rather than a new dependency: the archive libraries already in the
 * tree (mammoth's jszip, exceljs's unzip) are TRANSITIVE, and reaching through a dependency's
 * dependency is a break waiting for a version bump. Entries are not inflated, extracted or
 * validated — names only, which is all a sniff needs.
 *
 * @module zip
 */

/** End of central directory: the fixed trailer every archive ends with (plus an optional comment). */
const EOCD_SIGNATURE = 0x06054b50
/** Central directory file header. */
const CENTRAL_SIGNATURE = 0x02014b50
/** EOCD is 22 bytes with no comment; the comment is at most 0xffff, so the scan window is bounded. */
const EOCD_MIN_LENGTH = 22
const MAX_COMMENT_LENGTH = 0xffff

/**
 * The archive's entry names, or `null` when these bytes are not a readable (non-ZIP64) archive.
 *
 * ZIP64 (`0xffffffff` offsets) is refused rather than half-parsed: the formats this reader serves
 * are small enough that ZIP64 never appears, and returning `null` makes the docx/xlsx sniff decline
 * — after which the pipeline's binary path reports the ZIP honestly instead of guessing.
 */
export function zipEntryNames(bytes: Uint8Array): string[] | null {
  const directory = centralDirectory(bytes)
  if (directory === null) return null
  const { view, count, offset } = directory
  const decoder = new TextDecoder('utf-8')
  const names: string[] = []
  let at = offset
  for (let index = 0; index < count; index++) {
    const header = centralHeaderAt(view, at, bytes.byteLength)
    if (header === null) return null
    // ASCII for the entries this reader is used on, so UTF-8 versus the legacy CP437 fallback
    // cannot differ here; the entry flag is not consulted for that reason.
    names.push(decoder.decode(bytes.subarray(header.nameStart, header.nameStart + header.nameLength)))
    at = header.next
  }
  return names
}

/**
 * What the archive DECLARES it will cost to unpack: entry count and total uncompressed bytes.
 *
 * `null` for the same reason {@link zipEntryNames} returns `null` — these bytes are not a readable
 * non-ZIP64 archive.
 *
 * This is a PRE-FILTER, not a guarantee: the sizes come from the central directory, so an archive
 * that lies (declares a few bytes and inflates to gigabytes) is not caught here. What it does catch
 * is the ordinary bomb shape — a few megabytes on the wire declaring gigabytes of sheet XML — before
 * a reader library inflates any of it into the host's heap. Catching a lying archive would mean
 * inflating it ourselves under a running cap instead of handing it to the library, which is a
 * different (and much larger) piece of work; see the note at the xlsx call site.
 */
export function zipDeclaredCost(bytes: Uint8Array): { entries: number; uncompressed: number } | null {
  const directory = centralDirectory(bytes)
  if (directory === null) return null
  const { view, count, offset } = directory
  let uncompressed = 0
  let at = offset
  for (let index = 0; index < count; index++) {
    const header = centralHeaderAt(view, at, bytes.byteLength)
    if (header === null) return null
    // A ZIP64 archive stores 0xffffffff here; `centralDirectory` already refused those offsets.
    if (header.uncompressedSize === 0xffffffff) return null
    uncompressed += header.uncompressedSize
    at = header.next
  }
  return { entries: count, uncompressed }
}

/** The parsed central-directory location, or `null` when the trailer is missing or inconsistent. */
function centralDirectory(bytes: Uint8Array): { view: DataView; count: number; offset: number } | null {
  if (bytes.byteLength < EOCD_MIN_LENGTH) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Scan BACKWARDS for the trailer: the comment may itself contain the signature, but only the
  // real EOCD sits exactly `22 + commentLength` bytes before the end.
  const lowest = Math.max(0, bytes.byteLength - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH)
  let eocd = -1
  for (let at = bytes.byteLength - EOCD_MIN_LENGTH; at >= lowest; at--) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue
    const commentLength = view.getUint16(at + 20, true)
    if (at + EOCD_MIN_LENGTH + commentLength !== bytes.byteLength) continue
    eocd = at
    break
  }
  if (eocd < 0) return null

  const count = view.getUint16(eocd + 10, true)
  const directorySize = view.getUint32(eocd + 12, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) return null
  if (directoryOffset + directorySize > bytes.byteLength) return null
  return { view, count, offset: directoryOffset }
}

/** One central-directory file header: its name span, its declared uncompressed size, and the next. */
function centralHeaderAt(
  view: DataView,
  at: number,
  byteLength: number,
): { nameStart: number; nameLength: number; uncompressedSize: number; next: number } | null {
  if (at + 46 > byteLength || view.getUint32(at, true) !== CENTRAL_SIGNATURE) return null
  const nameLength = view.getUint16(at + 28, true)
  const extraLength = view.getUint16(at + 30, true)
  const commentLength = view.getUint16(at + 32, true)
  const nameStart = at + 46
  if (nameStart + nameLength > byteLength) return null
  return {
    nameStart,
    nameLength,
    uncompressedSize: view.getUint32(at + 24, true),
    next: nameStart + nameLength + extraLength + commentLength,
  }
}
