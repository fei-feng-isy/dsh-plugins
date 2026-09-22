/**
 * Turning bytes into the text the knowledge base indexes.
 *
 * Three things used to be silent here, and all three ended the same way — garbage chunks that look
 * like a successful ingest:
 *
 * 1. **A PDF was read as UTF-8.** `%PDF-1.4 … /Type /Catalog …` went into the corpus, the visible
 *    text stayed inside Flate-compressed streams, and a search for a sentence on page 3 returned
 *    nothing while the document "existed". PDFs are now extracted.
 * 2. **Any other binary was read as UTF-8 too** (a PNG became mojibake with NUL bytes, and the
 *    embedder happily computed vectors for it). Binaries are refused by magic number / NUL sniff,
 *    with the detected kind named in the error.
 * 3. **A GBK/GB18030 text file decoded to replacement characters.** Text bytes are now decoded
 *    BOM → strict UTF-8 → strict GB18030, and the encoding used is REPORTED back to the caller
 *    (a .txt from a Chinese source is very often GBK, and "convert it first" is a poor answer when
 *    the decoder to do it is already here).
 *
 * The PDF path is a real dependency (`unpdf`, a self-contained pdfjs build): extraction is async, so
 * this is the one place in the ingestion pipeline that is not synchronous.
 *
 * 4. **The convertible formats now run FIRST, through `@avantf/mem-convert`.** docx/xlsx/html/csv
 *    become Markdown before the magic-number sniff below, because a docx is a ZIP and the "known
 *    binary" branch would otherwise refuse it. The converter registry decides; a document no
 *    converter claims takes the text/PDF/binary paths unchanged.
 *
 * @module store/document_text
 */
import { describeError } from '@avantf/mem-contract'
import { convertToMarkdown } from '@avantf/mem-convert'

/** What the first bytes say a document is. */
export type DocumentFormat = 'pdf' | 'binary' | 'text'

/** How text bytes were decoded. Reported so a guess is visible instead of silent. */
export type DocumentEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gb18030'

/** One document's indexable text, and where it came from. */
export interface DocumentText {
  text: string
  /**
   * `pdf` = extracted text layer; `converter` = a document format turned into Markdown (see
   * {@link DocumentText.converter}); `text` = decoded bytes (see {@link DocumentText.encoding}).
   */
  via: 'text' | 'pdf' | 'converter'
  encoding?: DocumentEncoding
  /** Which `@avantf/mem-convert` converter produced the body (only when `via === 'converter'`). */
  converter?: string
  /** What that conversion could not carry over (dropped media, a truncated sheet, …). */
  warnings?: string[]
}

/**
 * The TextDecoder label for each encoding we report.
 *
 * `utf-8-bom` is OUR name for "UTF-8 that carried a BOM": it is not a decoder label (the WHATWG
 * utf-8 decoder strips a leading BOM by itself), so the bytes after the mark are decoded as
 * `utf-8` while the caller is still told a BOM was there.
 */
const DECODER_LABEL: Record<DocumentEncoding, string> = {
  'utf-8': 'utf-8',
  'utf-8-bom': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb18030': 'gb18030',
}

/** Byte-order marks, checked BEFORE any other sniff: UTF-16 text is full of NUL bytes. */
const BOMS: readonly { readonly bytes: readonly number[]; readonly encoding: DocumentEncoding }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8-bom' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
]

/** Bytes that identify a format we cannot index; `kind` is what the error message calls it. */
const SIGNATURES: readonly { readonly magic: readonly number[]; readonly kind: string }[] = [
  { magic: [0x50, 0x4b, 0x03, 0x04], kind: 'ZIP 压缩包（Office 的 .docx/.xlsx/.pptx，或普通 zip）' },
  { magic: [0x89, 0x50, 0x4e, 0x47], kind: 'PNG 图片' },
  { magic: [0xff, 0xd8, 0xff], kind: 'JPEG 图片' },
  { magic: [0x47, 0x49, 0x46, 0x38], kind: 'GIF 图片' },
  { magic: [0x42, 0x4d], kind: 'BMP 图片' },
  { magic: [0x52, 0x49, 0x46, 0x46], kind: 'RIFF 容器（WAV/AVI/WebP）' },
  { magic: [0x1f, 0x8b], kind: 'gzip 压缩包' },
  { magic: [0x37, 0x7a, 0xbc, 0xaf], kind: '7z 压缩包' },
  { magic: [0x52, 0x61, 0x72, 0x21], kind: 'RAR 压缩包' },
  { magic: [0xd0, 0xcf, 0x11, 0xe0], kind: 'OLE 复合文档（旧版 Office .doc/.xls）' },
  { magic: [0x7f, 0x45, 0x4c, 0x46], kind: 'ELF 可执行文件' },
  { magic: [0x00, 0x61, 0x73, 0x6d], kind: 'WebAssembly 模块' },
  { magic: [0x53, 0x51, 0x4c, 0x69], kind: 'SQLite 数据库' },
  { magic: [0x66, 0x4c, 0x61, 0x43], kind: 'FLAC 音频' },
  { magic: [0x4f, 0x67, 0x67, 0x53], kind: 'Ogg 容器' },
  { magic: [0x49, 0x44, 0x33], kind: 'MP3 音频' },
  { magic: [0x77, 0x4f, 0x46, 0x46], kind: 'WOFF 字体' },
  { magic: [0x25, 0x21, 0x50, 0x53], kind: 'PostScript 文档' },
]

/** The PDF header, which is the one "binary" we can read. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-

/** How much of a document the sniff and the encoding check look at. */
const SNIFF_BYTES = 8192

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false
  return magic.every((byte, index) => bytes[index] === byte)
}

/** Classify one document by its leading bytes. */
export function sniffFormat(bytes: Uint8Array): { format: DocumentFormat; kind?: string } {
  if (startsWith(bytes, PDF_MAGIC)) return { format: 'pdf' }
  // A BOM outranks the NUL sniff below: UTF-16 text is mostly NUL bytes and would otherwise be
  // reported as "binary data (NUL bytes)" — a wrong answer for a perfectly ordinary text file.
  for (const bom of BOMS) if (startsWith(bytes, bom.bytes)) return { format: 'text' }
  for (const { magic, kind } of SIGNATURES) {
    if (startsWith(bytes, magic)) return { format: 'binary', kind }
  }
  const window = bytes.subarray(0, SNIFF_BYTES)
  // A NUL byte in text is the cheapest binary tell there is, and it is exactly what made a PNG look
  // like an ingestable document.
  if (window.includes(0)) return { format: 'binary', kind: '二进制数据（含 NUL 字节）' }
  return { format: 'text' }
}

/**
 * Restore the ideographs pdfjs sometimes reports as compatibility codepoints.
 *
 * Some CJK PDFs extract `⽹站` (KANGXI RADICAL NET + 站) instead of `网站` — visually identical,
 * different codepoints, so a search for the real word misses. Only those three compatibility ranges
 * are normalized: NFKC over the whole text would also rewrite full-width punctuation (，。！？),
 * which is real content and must survive verbatim.
 */
export function normalizeCjkCompatibility(text: string): string {
  return text.replace(/[\u2e80-\u2eff\u2f00-\u2fdf\uf900-\ufaff]/g, ch => ch.normalize('NFKC'))
}

/** One strict decode attempt: `null` when the bytes are not valid in that encoding. */
function strictDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Decode text bytes: BOM first, then strict UTF-8, then strict GB18030.
 *
 * The order is the whole heuristic, and it needs no thresholds: a GBK/GB18030 Chinese file is not
 * valid UTF-8, so strict UTF-8 rejects it and GB18030 — a superset of GBK — decodes it correctly.
 * (The previous "count replacement characters" rule had a floor of 100, which a SHORT GBK file
 * never reached: it was decoded as UTF-8 mojibake and ingested without a word.)
 *
 * The residual risk is a file in some third encoding (windows-1252, shift_jis, big5): it is not
 * UTF-8 either, so it decodes as GB18030 noise. That is why the chosen encoding travels back to
 * the caller and into the ingest result — a wrong guess is reported, not hidden. Convert those
 * files to UTF-8 (or, for big5, decode them yourself) before ingesting.
 */
function decodeText(bytes: Uint8Array, label: string): { text: string; encoding: DocumentEncoding } {
  for (const bom of BOMS) {
    if (!startsWith(bytes, bom.bytes)) continue
    const text = strictDecode(bytes.subarray(bom.bytes.length), DECODER_LABEL[bom.encoding])
    if (text === null) throw new Error(`${label}：带 BOM 的 ${bom.encoding} 文本无法解码`)
    return { text, encoding: bom.encoding }
  }
  const utf8 = strictDecode(bytes, 'utf-8')
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' }
  const gb18030 = strictDecode(bytes, 'gb18030')
  if (gb18030 !== null) return { text: gb18030, encoding: 'gb18030' }
  throw new Error(
    `${label}：无法作为文本解码（不是合法的 UTF-8 / GB18030，也不是带 BOM 的 UTF-16）；请先转成 UTF-8 再入库`,
  )
}

/** Extract a PDF's text layer. Throws when there is none (a scanned/image-only PDF). */
async function extractPdfText(bytes: Uint8Array, label: string): Promise<string> {
  // Imported lazily: the knowledge store must open (and every non-PDF ingest must run) without
  // paying for the pdfjs build, and a checkout whose install skipped optional deps still works.
  const { extractText, getDocumentProxy } = await import('unpdf')
  let body: string
  try {
    // unpdf insists on a plain `Uint8Array` and rejects a Node `Buffer` outright — which is exactly
    // what `readFileSync` hands us, so the conversion is not optional.
    const data = bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes)
    // `verbosity: 0` silences pdfjs's per-font warnings, which would otherwise land in the host log
    // for every slightly unusual PDF.
    const pdf = await getDocumentProxy(data, { verbosity: 0 })
    const { text } = await extractText(pdf, { mergePages: true })
    body = Array.isArray(text) ? text.join('\n\n') : text
  } catch (error) {
    throw new Error(`${label}：无法读取该 PDF（${describeError(error)}）`)
  }
  const normalized = normalizeCjkCompatibility(body).trim()
  if (normalized === '') {
    throw new Error(
      `${label}：PDF 没有可抽取的文本层（可能是扫描件或图片型 PDF；本项目不做 OCR）—— 未入库任何内容`,
    )
  }
  return normalized
}

/**
 * The text of one document, whatever its bytes are.
 *
 * CONVERSION RUNS FIRST, before the magic-number sniff and therefore before the binary rejection.
 * docx/xlsx/html/csv are converted to Markdown here, and the order is not cosmetic: docx and xlsx
 * are ZIPs, so a sniff-first pipeline would file them under "known binary" and refuse them. A
 * document no converter claims falls through to the text/PDF/binary paths unchanged.
 *
 * @param bytes - the whole document (already bounded by the byte cap).
 * @param label - the path or URL, used verbatim in error messages and as the sniff's extension hint.
 * @throws when the document is a binary we cannot read, is not decodable, or is a PDF without a
 * text layer.
 */
export async function documentText(bytes: Uint8Array, label: string): Promise<DocumentText> {
  const converted = await convertToMarkdown({ bytes, path: label })
  if (converted !== null) {
    return {
      text: converted.markdown,
      via: 'converter',
      converter: converted.converter,
      ...(converted.warnings.length === 0 ? {} : { warnings: converted.warnings }),
    }
  }
  const sniffed = sniffFormat(bytes)
  if (sniffed.format === 'pdf') return { text: await extractPdfText(bytes, label), via: 'pdf' }
  if (sniffed.format === 'binary') {
    throw new Error(
      `${label}：不支持的二进制文件（${sniffed.kind ?? '二进制数据'}）；只能摄入文本、PDF 与可转换的文档格式`,
    )
  }
  return { ...decodeText(bytes, label), via: 'text' }
}
