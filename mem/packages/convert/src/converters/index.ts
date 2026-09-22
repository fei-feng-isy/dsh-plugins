/**
 * The built-in converters, registered in precedence order.
 *
 * Order is specific → loose. `pandoc-<version>` goes FIRST because it is the project's canonical
 * converter: one pandoc version means the same document renders the same way on every machine, and
 * putting it first makes that the default rather than one option among several. `xlsx` follows, and
 * the two cannot collide — pandoc has no spreadsheet reader, so `xl/workbook.xml` is only ever
 * claimed by exceljs. A document neither one claims falls through to the pipeline's text/PDF/binary
 * paths unchanged.
 *
 * Adding a format = implement `MarkdownConverter` + register it here. Neither the knowledge store
 * nor the ingestion pipeline changes.
 *
 * @module converters
 */
import { registerConverter } from '../registry.js'
import { pandocConverter } from './pandoc.js'
import { xlsxConverter } from './xlsx.js'

registerConverter(pandocConverter)
registerConverter(xlsxConverter)
