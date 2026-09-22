/**
 * The ZIP central-directory reader: the sniff's only evidence, so its refusals matter as much as
 * its reads. A false positive would hand a plain zip to mammoth; a false negative would report a
 * real docx as "unsupported binary".
 */
import { describe, it, expect } from 'vitest'
import { zipDeclaredCost, zipEntryNames } from '../src/zip.js'
import { buildTestArchive } from './helpers/archive.js'
import { buildPlainZip, buildPptx } from './helpers/fixtures.js'

describe('zipEntryNames', () => {
  it('reads every entry name, including stored and nested ones', () => {
    const archive = buildTestArchive([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'word/document.xml', data: '<w:document/>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet/>' },
    ])
    expect(zipEntryNames(archive)).toEqual([
      'mimetype',
      'word/document.xml',
      'xl/worksheets/sheet1.xml',
    ])
  })

  it('finds the trailer even when the archive comment contains the EOCD signature', () => {
    // A comment is raw bytes after the EOCD; the signature inside it must not be mistaken for the
    // trailer, or the entry count/offset would be read from the wrong place.
    const base = Buffer.from(buildTestArchive([{ name: 'word/document.xml', data: 'x' }]))
    const comment = Buffer.from('PK\x05\x06')
    base.writeUInt16LE(comment.length, base.length - 22 + 20)
    expect(zipEntryNames(Buffer.concat([base, comment]))).toEqual(['word/document.xml'])
  })

  it('returns null for a truncated archive instead of inventing names', () => {
    const archive = buildPlainZip()
    expect(zipEntryNames(archive.subarray(0, archive.length - 30))).toBeNull()
  })

  it('returns null for bytes that are not an archive', () => {
    expect(zipEntryNames(Buffer.from('hello world, not a zip at all'))).toBeNull()
    expect(zipEntryNames(Buffer.from([0x50, 0x4b]))).toBeNull()
  })

  it('reads the two Office shapes and the pptx shape apart', () => {
    expect(zipEntryNames(buildPptx())).toContain('ppt/presentation.xml')
    expect(zipEntryNames(buildPlainZip())).toEqual(['notes/readme.txt'])
  })
})

/**
 * The declared cost of an archive — what a reader library is about to inflate into the host's heap.
 *
 * `xlsx` conversion caps rows and columns, but only AFTER `exceljs` has materialized every cell, so
 * the cap has to be checked against the archive's own claim first.
 */
describe('zipDeclaredCost', () => {
  it('sums the entries and their declared uncompressed sizes', () => {
    const archive = buildTestArchive([
      { name: 'xl/workbook.xml', data: 'x'.repeat(100) },
      { name: 'xl/worksheets/sheet1.xml', data: 'y'.repeat(250) },
    ])
    expect(zipDeclaredCost(archive)).toEqual({ entries: 2, uncompressed: 350 })
  })

  it('reads a bomb claim, which is the whole point', () => {
    // 2 GiB per entry: the most a non-ZIP64 header can state, and far past what a spreadsheet this
    // converter would keep (2000 rows × 64 columns) could ever need.
    const declared = 2 * 1024 * 1024 * 1024
    const archive = buildTestArchive([
      { name: 'xl/worksheets/sheet1.xml', data: 'small', declaredUncompressed: declared },
      { name: 'xl/worksheets/sheet2.xml', data: 'small', declaredUncompressed: declared },
    ])
    // Summed across entries, so a bomb spread over many sheets cannot slip under a per-entry check.
    expect(zipDeclaredCost(archive)).toEqual({ entries: 2, uncompressed: 2 * declared })
  })

  it('returns null for bytes that are not a readable archive', () => {
    expect(zipDeclaredCost(Buffer.from('hello world, not a zip at all'))).toBeNull()
    expect(zipDeclaredCost(Buffer.from([0x50, 0x4b]))).toBeNull()
  })
})
