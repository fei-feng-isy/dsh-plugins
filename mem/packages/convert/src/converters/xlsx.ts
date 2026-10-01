/**
 * `.xlsx` → Markdown: one section per sheet, one GFM table per sheet.
 *
 * The reader is `exceljs`, deliberately: the well-known npm `xlsx`/SheetJS package is stale on the
 * registry (its maintained releases are not published there), so depending on it would mean pinning
 * a version with a standing advisory. `exceljs` reads `.xlsx` (and only `.xlsx`; the legacy binary
 * `.xls` is not this converter's business) and reports cell values as plain JS.
 *
 * Every sheet is emitted under its own `##` heading so the chunker writes a real `headings_path`,
 * and both dimensions are CAPPED with a warning — a spreadsheet can be a million rows, and silently
 * ingesting the first 64 columns of it would look like a complete document.
 *
 * @module converters/xlsx
 */
import { zipEntries } from '../detect.js'
import { zipDeclaredCost } from '../zip.js'
import { renderTable } from '../table.js'
import type { ConvertedDocument, ConvertInput, MarkdownConverter } from '../types.js'

const ID = 'xlsx'
/** The workbook part; its presence, not the extension, is what makes a ZIP an xlsx. */
const WORKBOOK_ENTRY = 'xl/workbook.xml'
/** Rows ingested per sheet before truncation (the remainder is reported, never dropped silently). */
const MAX_ROWS = 2000
/** Columns ingested per sheet; wider sheets keep their first `MAX_COLS` columns. */
const MAX_COLS = 64
/**
 * Total uncompressed bytes a workbook may DECLARE before it is refused outright.
 *
 * `exceljs` inflates the whole archive and materializes every cell as JS objects, so the row/column
 * caps below only bound the OUTPUT — they run after the memory has already been spent. A few
 * megabytes on the wire can declare gigabytes of sheet XML, and ingesting a user-supplied file must
 * not be a way to exhaust the host. 64 MiB is far above any workbook this converter would keep
 * (2000 rows × 64 columns per sheet) and far below what a bomb declares.
 *
 * A PRE-FILTER, not a guarantee: the sizes are the archive's own claim, so one that lies still
 * inflates. Bounding that would mean inflating under a running cap ourselves instead of using the
 * library's loader — see `zipDeclaredCost`.
 */
const MAX_DECLARED_BYTES = 64 * 1024 * 1024

/** One cell as text, unwrapping the shapes `exceljs` returns (rich text, formula, hyperlink, date). */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    const cell = value as Record<string, unknown>
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((run) => (typeof run?.text === 'string' ? run.text : '')).join('')
    }
    if (typeof cell.text === 'string') return cell.text // hyperlink
    if ('error' in cell) return String(cell.error)
    if ('formula' in cell || 'sharedFormula' in cell) {
      // The cached result is the value Excel last computed; with none, the formula text is the only
      // thing left to keep (and is visibly a formula, not a number).
      if (cell.result !== undefined && cell.result !== null) return formatCell(cell.result)
      return `=${String(cell.formula ?? cell.sharedFormula ?? '')}`
    }
  }
  return String(value)
}

export const xlsxConverter: MarkdownConverter = {
  id: ID,

  sniff(input: ConvertInput): boolean {
    return zipEntries(input.bytes)?.includes(WORKBOOK_ENTRY) === true
  },

  async convert(input: ConvertInput): Promise<ConvertedDocument> {
    const label = input.path ?? 'xlsx 任务簿'
    // BEFORE the reader sees a byte of it: `load` inflates and materializes the entire workbook, so
    // the row/column caps below cannot protect the host from a large one.
    const declared = zipDeclaredCost(input.bytes)
    if (declared !== null && declared.uncompressed > MAX_DECLARED_BYTES) {
      throw new Error(
        `${label}：任务簿声明解压后 ${Math.round(declared.uncompressed / 1024 / 1024)} MB`
        + `（${String(declared.entries)} 个条目），超过 ${String(MAX_DECLARED_BYTES / 1024 / 1024)} MB 上限，已拒绝转换。`
        + '请先在原文件里删掉不需要的任务表或行，或导出为 CSV 后入库。',
      )
    }
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    // `exceljs` declares its own `interface Buffer extends ArrayBuffer` alias, so a Node Buffer is
    // not nominally assignable to `load`'s parameter even though the runtime accepts one.
    const data = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength)
    await workbook.xlsx.load(data as unknown as ArrayBuffer)

    const warnings: string[] = []
    const sections: string[] = []
    for (const worksheet of workbook.worksheets) {
      const rowCount = worksheet.rowCount
      const columnCount = worksheet.columnCount
      if (rowCount === 0 || columnCount === 0) {
        warnings.push(`任务表「${worksheet.name}」为空，未产出表格`)
        continue
      }
      const rows: string[][] = []
      const rowLimit = Math.min(rowCount, MAX_ROWS)
      for (let r = 1; r <= rowLimit; r++) {
        const values = worksheet.getRow(r).values
        if (!Array.isArray(values)) continue
        const cells: string[] = []
        for (let c = 1; c <= Math.min(columnCount, MAX_COLS); c++) cells.push(formatCell(values[c]))
        rows.push(cells)
      }
      if (rowCount > MAX_ROWS) {
        warnings.push(`任务表「${worksheet.name}」共 ${String(rowCount)} 行，只转换前 ${String(MAX_ROWS)} 行`)
      }
      if (columnCount > MAX_COLS) {
        warnings.push(`任务表「${worksheet.name}」共 ${String(columnCount)} 列，只转换前 ${String(MAX_COLS)} 列`)
      }
      const table = renderTable(rows, `任务表「${worksheet.name}」`)
      if (table.synthesizedHeader) {
        warnings.push(`任务表「${worksheet.name}」首行是数值，已按数据行处理并合成列名`)
      }
      sections.push(`## ${worksheet.name}\n\n${table.markdown}`)
    }

    if (sections.length === 0) {
      throw new Error(`${label}：转换后没有可入库的表格（任务簿里没有非空任务表）`)
    }
    return { markdown: sections.join('\n\n'), converter: ID, warnings }
  },
}
