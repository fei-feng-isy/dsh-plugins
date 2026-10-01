/**
 * Every pandoc-readable format → GitHub-Flavored Markdown, through one wrapper.
 *
 * ONE converter claims a BATCH of formats because pandoc is one program with one flag naming the
 * reader (`--from=`): a converter per format would be a table row masquerading as a class. The
 * `--from` flag is ALWAYS passed explicitly, never inferred by pandoc from the extension, because an
 * explicitly named file may carry the wrong extension or none at all — the same reason the sniff is
 * content-first.
 *
 * `sniff` is content + extension COMPOSED: the ZIP-borne formats (docx/odt/epub) are recognized by
 * their archive entries (a `.docx` that is really an OLE `.doc` must fall through to the binary
 * path), HTML by page markup at the start of the file, and the rest — which have no magic and are
 * plain text — by extension, with the plain-text extensions the pipeline already serves excluded so
 * this converter cannot hijack a `.md`/`.txt`/`.json`.
 *
 * DELIBERATELY NOT HANDLED HERE, each named in the refusal instead of silently producing junk:
 *   - `.xlsx` → the built-in `xlsx` converter (exceljs), which runs AFTER this one on purpose: pandoc
 *     has no xlsx reader, so this converter must never claim the workbook ZIP;
 *   - `.doc`/`.xls`/`.ppt` (OLE) → LibreOffice, which this project only detects (see
 *     `@avantf/mem-provision`'s `detectLibreOffice`) — pandoc cannot read them;
 *   - `.pptx` → nothing in this release reads it; it reaches the pipeline's binary rejection;
 *   - scanned PDFs → the pipeline's own text layer, no OCR.
 *
 * @module converters/pandoc
 */
import { execFileSync } from 'node:child_process'
import { pandocConverterId } from '@avantf/mem-provision'
import { extensionOf, PLAIN_TEXT_EXTENSIONS, zipEntries } from '../detect.js'
import { pandocBinary } from '../pandoc.js'
import type { ConvertedDocument, ConvertInput, MarkdownConverter } from '../types.js'

/** The converter id is version-qualified (`pandoc-3.11`), so frontmatter records WHICH pandoc ran. */
export const PANDOC_CONVERTER_ID = pandocConverterId()

/** Extensions that mean HTML outright; the content probe covers a page with no usable extension. */
const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml'])

/** Page markup, checked case-insensitively against the decoded prefix. */
const HTML_MARKER = /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<meta\b)/i

/** How much of a candidate is decoded for the content probe. */
const PROBE_BYTES = 8192

/**
 * Extension → pandoc reader, the table that makes this one converter cover a batch of formats.
 *
 * Readers are pandoc's own names, quoted from `pandoc --list-input-formats` (3.11). The `+…`
 * extensions are what make the reader accept the everyday dialect rather than only its strict form:
 * `markdown+pipe_tables` for the "Markdown" formats, `latex+raw_tex` so embedded TeX survives
 * instead of being dropped, and `html+native_divs` so a page's containers do not disappear.
 * `rst` is `rst`; the rest are plain reader names.
 */
export const PANDOC_READERS: ReadonlyMap<string, string> = new Map([
  ['.docx', 'docx'],
  ['.docm', 'docx'],
  ['.odt', 'odt'],
  ['.epub', 'epub'],
  ['.html', 'html+native_divs'],
  ['.htm', 'html+native_divs'],
  ['.xhtml', 'html+native_divs'],
  ['.tex', 'latex+raw_tex'],
  ['.latex', 'latex+raw_tex'],
  ['.ltx', 'latex+raw_tex'],
  ['.rst', 'rst'],
  ['.rest', 'rst'],
  ['.ipynb', 'ipynb'],
  ['.csv', 'csv'],
  ['.tsv', 'tsv'],
  ['.org', 'org'],
  ['.textile', 'textile'],
  ['.fb2', 'fb2'],
  ['.opml', 'opml'],
  ['.bib', 'biblatex'],
  ['.dbk', 'docbook'],
  ['.xml', 'docbook'],
  ['.man', 'man'],
  ['.rtf', 'rtf'],
  ['.typ', 'typst'],
])

/**
 * The extensions this converter REFUSES with a named reason, because the failure a user sees must
 * say what would read the file rather than "unsupported binary".
 */
export const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls', '.ppt'])

/**
 * Extensions in {@link PANDOC_READERS} that the directory WALK must not offer.
 *
 * `.xml` is the case: the DocBook reader is mapped to it so an explicitly named DocBook file
 * converts, but a directory of generic XML is not a directory of documents, and offering every
 * `.xml` in a project tree would be a promise ingestion cannot keep. Kept as its own set so the
 * walk's whitelist and this table cannot disagree silently — `source_picker.spec.ts` asserts their
 * union covers the table.
 */
export const PROBE_ONLY_EXTENSIONS: ReadonlySet<string> = new Set(['.xml'])

/** The ZIP-borne formats, keyed by the archive entry that proves them. Order IS precedence. */
const ZIP_FORMATS: readonly { entry: string; reader: string; aliases: readonly string[] }[] = [
  { entry: 'word/document.xml', reader: 'docx', aliases: [] },
  { entry: 'content.xml', reader: 'odt', aliases: ['mimetype'] },
  { entry: 'mimetype', reader: 'epub', aliases: [] },
]

/** The reader a ZIP's entries prove, or `undefined` when no entry set matches. */
function zipReader(entries: readonly string[]): string | undefined {
  for (const format of ZIP_FORMATS) {
    if (!entries.includes(format.entry)) continue
    if (format.aliases.every(alias => entries.includes(alias))) return format.reader
  }
  return undefined
}

/** The reader an extension names, or `undefined`. */
function extensionReader(extension: string): string | undefined {
  return PANDOC_READERS.get(extension)
}

/**
 * Does `bytes` look like an HTML page? ASCII markers at the very start, so a cut multi-byte run is
 * fine. A non-`Uint8Array` (a caller that forgot to await) decodes as an empty probe rather than
 * throwing: `sniff` must answer yes/no for every document the pipeline hands it, never crash it.
 */
function looksLikeHtml(bytes: Uint8Array): boolean {
  if (typeof (bytes as { subarray?: unknown }).subarray !== 'function') return false
  return HTML_MARKER.test(new TextDecoder('utf-8').decode(bytes.subarray(0, PROBE_BYTES)))
}

/**
 * What to convert this document as, or why it cannot be converted here.
 *
 * `{ read: reader }` means "convert", `{ error }` means "refuse with this message", and `undefined`
 * means "not mine" — the difference matters: a refusal must not fall through to the text path (an
 * OLE `.doc` decoded as GB18030 is exactly the mojibake this pipeline exists to prevent).
 */
export type PandocClaim = { read: string } | { error: string } | undefined

/** Decide the claim for one document. Exported so the spec can assert the decision table directly. */
export function pandocClaim(input: ConvertInput): PandocClaim {
  const extension = extensionOf(input.path)
  const entries = zipEntries(input.bytes)
  if (entries !== null) {
    const reader = zipReader(entries)
    // A ZIP this converter does not know: not mine. `.xlsx` lands here (the built-in converter
    // claims it) and so does a plain zip (the pipeline rejects it as binary).
    return reader === undefined ? undefined : { read: reader }
  }
  if (LEGACY_OFFICE_EXTENSIONS.has(extension)) {
    return {
      error: `旧版 ${extension} 是 OLE 复合文档，pandoc 无法读取；只有 LibreOffice 能读，而本项目只探测不自动安装`,
    }
  }
  // A plain-text extension the pipeline already serves (`.md`, `.txt`, `.json`, `.yaml`…) is never
  // converted: those formats are the text path's own, and a Markdown file that happens to contain
  // `<html` must keep reaching it unchanged.
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) return undefined
  if (HTML_EXTENSIONS.has(extension)) return { read: 'html+native_divs' }
  const byExtension = extensionReader(extension)
  if (byExtension !== undefined) return { read: byExtension }
  // Content decides only for an extension the READER TABLE does not know — an extensionless
  // `report.final`, or a `.final`. A KNOWN plain-text extension already returned above, so this can
  // never hijack a `.md`/`.txt`/`.json`, which is the case that matters.
  return looksLikeHtml(input.bytes) ? { read: 'html+native_divs' } : undefined
}

/** How long pandoc may run on one document. Generous: a large ODT is a few seconds of mission. */
const CONVERT_TIMEOUT_MS = 120_000

/** Cap on the Markdown pandoc may emit, so a pathological document cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** The literal text `--extract-media` would need; media is dropped and REPORTED, never extracted. */
const MEDIA_NOTE = 'pandoc 不会解出文档里的图片等媒体，只保留文字（媒体没有随文入库）'

export const pandocConverter: MarkdownConverter = {
  id: PANDOC_CONVERTER_ID,

  sniff(input: ConvertInput): boolean {
    return pandocClaim(input) !== undefined
  },

  async convert(input: ConvertInput): Promise<ConvertedDocument> {
    const label = input.path ?? 'pandoc 文档'
    const claim = pandocClaim(input)
    if (claim === undefined) {
      throw new Error(`${label}：没有可用的 pandoc reader（该扩展名/内容不在支持表里）`)
    }
    if ('error' in claim) throw new Error(`${label}：${claim.error}`)

    const binary = await pandocBinary()
    const warnings: string[] = [MEDIA_NOTE]
    const args = [
      `--from=${claim.read}`,
      '--to=gfm',
      // Deterministic output: LF endings (a CRLF body would make the corpus depend on the source
      // machine) and no 72-column re-wrapping (pandoc's default reflows prose, which changes the
      // text the retriever sees).
      '--eol=lf',
      '--wrap=none',
      '--markdown-headings=atx',
    ]
    let output: string
    try {
      output = execFileSync(binary, args, {
        input: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: CONVERT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
      })
    } catch (error) {
      const failure = error as { stderr?: string; status?: number | null; signal?: string }
      const stderr = (failure.stderr ?? '').trim()
      const reason = stderr !== '' ? stderr : (error instanceof Error ? error.message : String(error))
      // The `文档转换失败（<id>）` prefix is what the registry's wrapper recognizes, so the label and
      // the reader that was used travel with the failure instead of being replaced by a generic one.
      throw new Error(
        `${label}：pandoc 转换失败（--from=${claim.read}，退出码 ${String(failure.status ?? '无')}`
        + `${failure.signal === undefined ? '' : `，信号 ${failure.signal}`}）：${reason}`,
      )
    }
    const markdown = output.trim()
    if (markdown === '') {
      throw new Error(`${label}：pandoc 转换后没有可入库的正文（文档可能只含图片、公式等非文本内容）`)
    }
    return { markdown, converter: PANDOC_CONVERTER_ID, warnings }
  },
}
