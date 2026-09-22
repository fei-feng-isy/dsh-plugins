/**
 * Format sniffing: which converter claims which bytes.
 *
 * The load-bearing assertions are the DECLINES. A ZIP is several formats at the magic-number level,
 * so "it is a ZIP" is not enough: a plain zip and a pptx must walk away from the pandoc converter,
 * a workbook must reach the xlsx converter rather than pandoc, and the plain-text formats the
 * pipeline already serves must never be claimed — while an OLE `.doc` is refused BY NAME instead of
 * being decoded as text.
 */
import { describe, it, expect } from 'vitest'
import { converters, pandocClaim } from '../src/index.js'
import type { ConvertInput, MarkdownConverter } from '../src/types.js'
import { PANDOC_CONVERTER_ID } from '../src/converters/pandoc.js'
import {
  buildEpub,
  buildOle,
  buildPlainZip,
  buildPng,
  buildPptx,
  buildSampleDocx,
  buildSampleXlsx,
} from './helpers/fixtures.js'

function byId(id: string): MarkdownConverter {
  const found = converters().find(converter => converter.id === id)
  if (found === undefined) throw new Error(`no converter ${id}`)
  return found
}

const claims = (id: string, input: ConvertInput): boolean => byId(id).sniff(input)
const encoder = new TextEncoder()

describe('converter precedence', () => {
  it('registers pandoc before the format it cannot read (xlsx)', () => {
    expect(converters().map(converter => converter.id)).toEqual([PANDOC_CONVERTER_ID, 'xlsx'])
  })

  it('qualifies the converter id with the pinned pandoc version', () => {
    expect(PANDOC_CONVERTER_ID).toBe('pandoc-3.11')
  })
})

describe('pandoc sniffing: ZIP-borne formats come from the archive entries', () => {
  it('claims a docx by word/document.xml, extension or not', () => {
    const docx = buildSampleDocx()
    expect(pandocClaim({ bytes: docx })).toEqual({ read: 'docx' })
    expect(pandocClaim({ bytes: docx, path: '/tmp/report.txt' })).toEqual({ read: 'docx' })
    expect(pandocClaim({ bytes: docx, path: 'C:\\\\docs\\\\report.docx' })).toEqual({ read: 'docx' })
  })

  it('claims an EPUB by its mimetype entry', () => {
    expect(pandocClaim({ bytes: buildEpub(), path: 'book.epub' })).toEqual({ read: 'epub' })
  })

  it('declines a plain zip and a pptx — nothing here reads them', () => {
    expect(claims(PANDOC_CONVERTER_ID, { bytes: buildPlainZip(), path: 'archive.docx' })).toBe(false)
    expect(claims(PANDOC_CONVERTER_ID, { bytes: buildPptx(), path: 'slides.pptx' })).toBe(false)
  })

  it('leaves .xlsx to the xlsx converter', async () => {
    const xlsx = await buildSampleXlsx()
    expect(pandocClaim({ bytes: xlsx, path: 'book.xlsx' })).toBeUndefined()
    expect(claims('xlsx', { bytes: xlsx, path: 'book.xlsx' })).toBe(true)
  })
})

describe('pandoc sniffing: legacy OLE formats are refused by name', () => {
  it('names the reason and still claims the document (so it cannot fall through to text)', () => {
    const claim = pandocClaim({ bytes: buildOle(), path: 'old.doc' })
    expect(claim).not.toBeUndefined()
    if (claim === undefined || !('error' in claim)) throw new Error('expected a refusal')
    expect(claim.error).toContain('OLE')
    expect(claim.error).toContain('.doc')
    expect(claims(PANDOC_CONVERTER_ID, { bytes: buildOle(), path: 'old.doc' })).toBe(true)
  })
})

describe('pandoc sniffing: text formats by extension, HTML by markup', () => {
  const page = encoder.encode('<!doctype html><html><head><title>标题</title></head><body>正文</body></html>')

  it('claims the documented reader table', () => {
    for (const [extension, reader] of [
      ['.html', 'html+native_divs'],
      ['.htm', 'html+native_divs'],
      ['.xhtml', 'html+native_divs'],
      ['.tex', 'latex+raw_tex'],
      ['.rst', 'rst'],
      ['.ipynb', 'ipynb'],
      ['.csv', 'csv'],
      ['.tsv', 'tsv'],
      ['.org', 'org'],
      ['.rtf', 'rtf'],
    ] as const) {
      expect(pandocClaim({ bytes: encoder.encode('x'), path: `doc${extension}` }), extension).toEqual({ read: reader })
    }
  })

  it('claims page markup with no usable extension, and never a known plain-text extension', () => {
    expect(pandocClaim({ bytes: page })).toEqual({ read: 'html+native_divs' })
    expect(pandocClaim({ bytes: page, path: '/tmp/report.final' })).toEqual({ read: 'html+native_divs' })
    expect(pandocClaim({ bytes: page, path: 'notes.txt' })).toBeUndefined()
    expect(pandocClaim({ bytes: page, path: 'notes.md' })).toBeUndefined()
    expect(pandocClaim({ bytes: encoder.encode('# 标题\n\n正文'), path: 'notes.md' })).toBeUndefined()
  })

  it('never claims a non-markup file that carries an unknown extension', () => {
    expect(pandocClaim({ bytes: encoder.encode('a,b\n1,2\n'), path: 'server.log' })).toBeUndefined()
    expect(pandocClaim({ bytes: encoder.encode('just some text'), path: 'data.bin' })).toBeUndefined()
  })

  it('declines ordinary prose with no extension at all', () => {
    expect(pandocClaim({ bytes: encoder.encode('这是一段普通文本，没有任何标记。') })).toBeUndefined()
    expect(claims(PANDOC_CONVERTER_ID, { bytes: buildPng() })).toBe(false)
  })
})
