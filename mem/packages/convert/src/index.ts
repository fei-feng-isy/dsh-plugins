/**
 * `@avantf/mem-convert` — document formats → Markdown, behind a registry.
 *
 * A standalone library: it depends on neither `@avantf/mem-contract` nor `@avantf/mem`, so the
 * knowledge store reaches it through one function ({@link convertToMarkdown}) and knows nothing
 * else about formats. Importing this module registers the built-in converters; a caller that needs
 * a different set can import the registry alone and register its own.
 *
 * Supported: everything the pinned **pandoc** reads — `.docx`/`.docm`/`.odt`/`.epub`/`.html`/`.htm`/
 * `.xhtml`/`.tex`/`.rst`/`.ipynb`/`.csv`/`.tsv`/`.org`/`.rtf`/`.fb2`/`.opml`/`.bib`/`.docbook`/
 * `.man`/`.typ` and more (the full reader table is in `converters/pandoc.ts`) — plus `.xlsx` through
 * the built-in exceljs converter, because pandoc has no spreadsheet reader. The pandoc binary comes
 * from `@avantf/mem-provision` (pinned version, managed directory, mirror-first download), and the
 * converter id it reports is version-qualified (`pandoc-3.11`), so which build produced a document
 * is visible in the result and in frontmatter.
 *
 * Deliberately NOT supported, each refused with the detected type rather than converted: PDF (the
 * pipeline's own `unpdf` text layer stays), legacy `.doc`/`.xls`/`.ppt` (OLE; only LibreOffice reads
 * them, and this project only detects an existing installation), `.pptx`, and images/OCR. Every one
 * of those is a new `MarkdownConverter` away — no pipeline change — which is the point of the
 * registry.
 *
 * @module index
 */
// Side-effect import: registers the built-ins before anything can call `convertToMarkdown`.
import './converters/index.js'

export type { ConvertedDocument, ConvertInput, MarkdownConverter } from './types.js'
export { converters, convertToMarkdown, registerConverter } from './registry.js'
export { zipDeclaredCost, zipEntryNames } from './zip.js'
export {
  LEGACY_OFFICE_EXTENSIONS,
  pandocClaim,
  pandocConverter,
  PANDOC_CONVERTER_ID,
  PANDOC_READERS,
  PROBE_ONLY_EXTENSIONS,
  type PandocClaim,
} from './converters/pandoc.js'
export {
  pandocAvailable,
  pandocBinary,
  pandocProvisioning,
  resetPandocResolution,
  setPandocProvisioning,
  type PandocProvisioning,
} from './pandoc.js'
