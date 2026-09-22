/**
 * xlsx conversion: one section per sheet, one table per sheet, truncation and emptiness both
 * reported rather than silently absorbed.
 */
import { describe, it, expect } from 'vitest'
import { convertToMarkdown } from '../src/index.js'
import { buildSampleXlsx, buildXlsx } from './helpers/fixtures.js'
import { buildTestArchive } from './helpers/archive.js'

describe('xlsx → markdown', () => {
  it('emits a section and a GFM table per sheet', async () => {
    const result = await convertToMarkdown({ bytes: await buildSampleXlsx(), path: 'config.xlsx' })
    expect(result?.converter).toBe('xlsx')
    expect(result?.markdown).toContain('## 配置')
    expect(result?.markdown).toContain('| 键 | 值 |')
    expect(result?.markdown).toContain('| timeout | 30 |')
    expect(result?.markdown).toContain('| retries | 3 |')
  })

  it('warns about an empty sheet instead of dropping it silently', async () => {
    const result = await convertToMarkdown({ bytes: await buildSampleXlsx() })
    expect(result?.warnings.some(warning => warning.includes('空表') && warning.includes('为空'))).toBe(true)
  })

  it('caps a huge sheet and says how much was not converted', async () => {
    const rows: string[][] = [['序号', '说明']]
    for (let index = 1; index <= 2000; index++) rows.push([String(index), `第 ${String(index)} 行`])
    const result = await convertToMarkdown({ bytes: await buildXlsx([{ name: '长表', rows }]) })
    // 2001 rows total (header + 2000 data); the table keeps the first 2000, i.e. data through 1999.
    expect(result?.warnings.some(warning => warning.includes('2001') && warning.includes('2000'))).toBe(true)
    expect(result?.markdown).toContain('| 1999 |')
    expect(result?.markdown).not.toContain('| 2000 |')
  })

  it('renders a numeric first row as data with a synthesized header', async () => {
    const result = await convertToMarkdown({ bytes: await buildXlsx([{ name: '数据', rows: [[1, 2], [3, 4]] }]) })
    expect(result?.markdown).toContain('| 列1 | 列2 |')
    expect(result?.markdown).toContain('| 1 | 2 |')
    expect(result?.warnings.some(warning => warning.includes('首行是数值'))).toBe(true)
  })

  it('refuses a workbook that declares more than it may inflate, BEFORE reading it', async () => {
    // The row/column caps bound the OUTPUT only: `exceljs` inflates the archive and materializes
    // every cell first, so ingesting one user-supplied file was a way to exhaust the host's memory.
    // A few bytes on the wire claiming gigabytes of sheet XML is the ordinary bomb shape.
    const bomb = buildTestArchive([
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      { name: 'xl/worksheets/sheet1.xml', data: 'x'.repeat(64), declaredUncompressed: 2 * 1024 * 1024 * 1024 },
    ])
    await expect(convertToMarkdown({ bytes: bomb, path: 'bomb.xlsx' }))
      .rejects.toThrow(/超过 64 MB 上限/)
  })

  it('fails loudly when every sheet is empty', async () => {
    await expect(convertToMarkdown({ bytes: await buildXlsx([{ name: '空表', rows: [] }]), path: 'empty.xlsx' }))
      .rejects.toThrow(/没有可入库的表格/)
  })
})
