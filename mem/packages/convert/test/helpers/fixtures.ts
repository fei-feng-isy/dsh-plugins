/**
 * Deterministic documents for the conversion specs.
 *
 * Built in-process rather than committed: a docx is a ZIP (see `archive.ts`), an xlsx comes from the
 * same `exceljs` the converter reads, and the "binary that is not ours" cases are a handful of
 * magic bytes. Nothing here depends on a network or on a fixture's bytes surviving an editor.
 *
 * @module test/helpers/fixtures
 */
import { buildTestArchive } from './archive.js'

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const DOCUMENT_NAMESPACE = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
].join(' ')

/** One paragraph, optionally in a named style (`Heading1` matches mammoth's default style map). */
function paragraph(text: string, style?: string): string {
  const properties = style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

/** One table row from cell texts. */
function tableRow(cells: readonly string[]): string {
  const items = cells.map(text => `<w:tc>${paragraph(text)}</w:tc>`).join('')
  return `<w:tr>${items}</w:tr>`
}

/** A WordprocessingML document with the given body XML. */
function buildDocx(body: string): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${DOCUMENT_NAMESPACE}><w:body>${body}</w:body></w:document>`
  return buildTestArchive([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: 'word/document.xml', data: document },
  ])
}

/** A docx whose body is a heading, a paragraph and a 2×2 table. */
export function buildSampleDocx(): Uint8Array {
  return buildDocx(
    paragraph('网关设计规范', 'Heading1')
    + paragraph('本文说明网关的限流策略。')
    + `<w:tbl>${tableRow(['组件', '职责'])}${tableRow(['路由', '转发'])}</w:tbl>`,
  )
}

/** One worksheet to build: a name and its rows (`[]` makes an empty sheet). */
interface SheetSpec {
  name: string
  rows: (string | number)[][]
}

/** An xlsx built by `exceljs` itself — the same library the converter reads. */
export async function buildXlsx(sheets: readonly SheetSpec[]): Promise<Uint8Array> {
  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name)
    for (const row of spec.rows) sheet.addRow(row)
  }
  const buffer = await workbook.xlsx.writeBuffer()
  return new Uint8Array(buffer)
}

/** An xlsx built by `exceljs` itself: two sheets, the second empty. */
export async function buildSampleXlsx(): Promise<Uint8Array> {
  return buildXlsx([
    { name: '配置', rows: [['键', '值'], ['timeout', 30], ['retries', 3]] },
    { name: '空表', rows: [] },
  ])
}

/** A ZIP that is neither an Office document nor an EPUB — the refusal case. */
export function buildPlainZip(): Uint8Array {
  return buildTestArchive([{ name: 'notes/readme.txt', data: '这不是 Office 文档' }])
}

/** A pptx-shaped ZIP: a ZIP, recognized by nobody in this release. */
export function buildPptx(): Uint8Array {
  return buildTestArchive([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: 'ppt/presentation.xml', data: '<p:presentation/>' },
  ])
}

/** An EPUB-shaped ZIP: `mimetype` stored first, as the spec requires. */
export function buildEpub(): Uint8Array {
  return buildTestArchive([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: '<container/>' },
  ])
}

/** An OLE compound document — the old `.doc`/`.xls` container. */
export function buildOle(): Uint8Array {
  return Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00])
}

/** A PNG whose magic must reach the pipeline's binary rejection. */
export function buildPng(): Uint8Array {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
}
