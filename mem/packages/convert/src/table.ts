/**
 * A rectangular grid of strings → a GitHub-flavored Markdown table.
 *
 * The grid renderer behind the XLSX converter (CSV reaches a table through pandoc's own reader).
 * Two decisions matter: what the header row IS, and how a cell's content survives inside a
 * `|`-delimited row. GFM tables have no
 * "no header" form, so a first row that is plainly data (every cell numeric) is treated as data and
 * a synthetic `列1…列N` header is emitted above it — the alternative would be promoting the first
 * data row to a header and losing it from the body.
 *
 * @module table
 */

/** A cell that is a number and nothing else — the tell that a first row is data, not a header. */
const NUMERIC = /^[-+]?\d+(?:[.,]\d+)*(?:[eE][-+]?\d+)?%?$/

/** `|` would split the cell and a newline would break the row out of the table. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim()
}

/** Fill in a name for a blank/absent header cell: GFM requires a non-empty header row. */
function synthHeader(cells: readonly string[], columns: number): string[] {
  return Array.from({ length: columns }, (_, index) => {
    const cell = (cells[index] ?? '').trim()
    return cell === '' ? `列${String(index + 1)}` : escapeCell(cell)
  })
}

/** One Markdown table plus what had to be decided to produce it. */
interface MarkdownTable {
  markdown: string
  /** True when the first row was data and a `列N` header was synthesized. */
  synthesizedHeader: boolean
  /** How many rows were padded or truncated to the header's width. */
  raggedRows: number
}

/**
 * Render rows as one table; `rows` may be ragged (normalized to the header's width).
 *
 * @throws when there is no table at all (no rows, or a single row that is a header) — an empty body
 * is never a valid conversion result.
 */
export function renderTable(rows: readonly (readonly string[])[], label: string): MarkdownTable {
  if (rows.length === 0) throw new Error(`${label}：没有可转换的表格行`)
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (width < 2) throw new Error(`${label}：内容不是表格（列数 < 2）`)

  const first = rows[0]
  const firstIsData = first.length > 0 && first.every(cell => NUMERIC.test(cell.trim()))
  const header = firstIsData ? synthHeader([], width) : synthHeader(first, width)
  const body = firstIsData ? rows : rows.slice(1)

  let ragged = 0
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const row of body) {
    if (row.length !== width) ragged += 1
    const cells = Array.from({ length: width }, (_, index) => escapeCell(row[index] ?? ''))
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return { markdown: lines.join('\n'), synthesizedHeader: firstIsData, raggedRows: ragged }
}
