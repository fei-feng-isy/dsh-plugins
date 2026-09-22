/**
 * Office-shaped fixtures for the ingestion specs, written here rather than committed.
 *
 * The `.docx` is a REAL WordprocessingML package — `[Content_Types].xml`, package and document
 * relationships, a styles part that DEFINES the heading styles, core properties, and the document
 * body — because the pipeline converts through pandoc, which reads the package format rather than
 * guessing at a bare `word/document.xml`. A docx carrying only that one part is accepted by this
 * fixture's own ZIP writer and mis-read by a real reader, which would make a spec pass for the wrong
 * reason.
 *
 * The same writer produces the ZIPs that must NOT be claimed (a plain zip, a pptx), which is the
 * counterexample the conversion tests need. Entries are DEFLATED, so this is a real archive writer
 * rather than a stored-bytes shortcut.
 *
 * @module test/fixtures/office
 */
import { deflateRawSync } from 'node:zlib'

interface Entry {
  name: string
  data: string | Buffer
}

/** CRC-32, as the ZIP headers store it. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Build a ZIP from `entries` (DEFLATE, method 8). */
function zip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data
    const data = deflateRawSync(raw, { level: 9 })
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '</Types>'

const PACKAGE_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>'

const DOCUMENT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>'

/** Heading 1..2 and Normal, so the heading style ids in the body mean something to a reader. */
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>'
  + '<w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>'
  + '<w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>'
  + '</w:styles>'

function coreProperties(title: string): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:title>${title}</dc:title></cp:coreProperties>`
}

function paragraph(text: string, style?: string): string {
  const properties = style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
  return `<w:p>${properties}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

/**
 * A minimal but COMPLETE WordprocessingML document: a `Heading1` title, an optional `Heading2`
 * section, and body paragraphs. The heading style ids match the definitions in `styles.xml`, which
 * is what lets the heading hierarchy survive the conversion.
 */
export function docxBytes(title: string, body: string, section?: { heading: string; text: string }): Buffer {
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + paragraph(title, 'Heading1')
    + (section === undefined ? '' : paragraph(section.heading, 'Heading2') + paragraph(section.text))
    + paragraph(body)
    + '</w:body></w:document>'
  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: PACKAGE_RELS },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: DOCUMENT_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'docProps/core.xml', data: coreProperties(title) },
  ])
}

/**
 * A ZIP that IS claimed as a docx (it carries `word/document.xml`) but whose XML is unparseable.
 *
 * The claimant must FAIL on it rather than fall through: once a converter has said "this document is
 * mine", silently handing the bytes to the text path is how a broken document becomes mojibake
 * chunks instead of an error.
 */
export function brokenDocxBytes(): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: 'word/document.xml', data: '<w:document><w:body>not closed' },
  ])
}

/** A ZIP that is neither a docx nor an xlsx — the "ZIP is still a binary" counterexample. */
export function plainZipBytes(): Buffer {
  return zip([{ name: 'notes/readme.txt', data: '这只是一个普通 zip' }])
}

/** A pptx-shaped ZIP: recognized as a ZIP, converted by nothing in this release. */
export function pptxBytes(): Buffer {
  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: 'ppt/presentation.xml', data: '<p:presentation/>' },
  ])
}
