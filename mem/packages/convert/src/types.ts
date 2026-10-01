/**
 * The converter contract: bytes in, Markdown out.
 *
 * This package is deliberately standalone — it imports neither `@avantf/mem-contract` nor
 * `@avantf/mem` — because it is a plain library about DOCUMENT FORMATS, not about the knowledge
 * base. The store knows only two things about it: `id` (what produced the body, reported to the
 * caller and recorded in frontmatter) and the Markdown itself.
 *
 * `sniff` is synchronous and cheap: the ingestion pipeline asks every registered converter about
 * every document, so a converter that reads a whole workbook to answer "is this mine?" would tax
 * every unrelated ingest. `convert` is where the real mission (and the heavy dependency) lives, which
 * is also why each implementation imports its library lazily.
 */

/** What a converter is given. `path` is a HINT for extension-based sniffing; the bytes are truth. */
export interface ConvertInput {
  /** The whole document, already bounded by the caller's byte cap. */
  bytes: Uint8Array
  /**
   * Where the bytes came from — a file path or a URL. Only the trailing extension is read, and only
   * as a hint: an explicitly named file may carry the wrong one (or none), so a sniff that needs a
   * ZIP structure or page markup must find it in the bytes. `undefined` for pasted content.
   */
  path?: string
}

/** One conversion's result. */
export interface ConvertedDocument {
  /** The body the knowledge base indexes, as Markdown. Never empty (a converter throws instead). */
  markdown: string
  /** The {@link MarkdownConverter.id} that produced it. Travels into `IngestResult.converter`. */
  converter: string
  /**
   * What the conversion could NOT carry over faithfully — dropped media, a truncated sheet, a
   * library diagnostic. Visible by construction: a converter must never silently emit a body that
   * lost content.
   */
  warnings: string[]
  /** The document's own title, when the format carries one (HTML `<title>`); a hint, not identity. */
  title?: string
}

/**
 * One document format, as the registry sees it.
 *
 * `sniff` must answer `false` for anything it cannot actually convert — a ZIP that is not a docx,
 * an HTML-shaped file it would mangle — because the FIRST claimant wins and a wrong claim replaces
 * the pipeline's normal text/binary handling.
 */
export interface MarkdownConverter {
  /** Stable id, unique in the registry; reported in results and written to frontmatter. */
  id: string
  sniff(input: ConvertInput): boolean
  /** Throws (with a Chinese, user-facing message) when the document cannot be converted. */
  convert(input: ConvertInput): Promise<ConvertedDocument>
}
