/**
 * Bytes → text: PDF extraction, binary refusal, encoding refusal.
 *
 * Each case below is a document that used to be ingested as garbage *without any error* — the
 * failure mode this module exists to remove. The PDFs are generated (see `fixtures/pdf.ts`) rather
 * than committed, so what "a PDF with a text layer" means is readable in the test itself.
 */
import { describe, it, expect } from 'vitest'
import { documentText, normalizeCjkCompatibility, sniffFormat } from '../src/store/document_text.js'
import { textlessPdf, tinyPdf } from './fixtures/pdf.js'
import { brokenDocxBytes, docxBytes, plainZipBytes, pptxBytes } from './fixtures/office.js'

const bytes = (input: Buffer | string): Uint8Array => (typeof input === 'string' ? Buffer.from(input, 'utf8') : input)

describe('sniffFormat', () => {
  it('recognizes a PDF by its header', () => {
    expect(sniffFormat(bytes(tinyPdf('x')))).toEqual({ format: 'pdf' })
  })

  it('recognizes binaries by magic number, and names what it found', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    expect(sniffFormat(bytes(png))).toEqual({ format: 'binary', kind: 'PNG 图片' })
    const zip = Buffer.from('PK\u0003\u0004rest', 'latin1')
    expect(sniffFormat(bytes(zip)).format).toBe('binary')
    expect(sniffFormat(bytes(zip)).kind).toContain('ZIP')
  })

  it('treats NUL bytes as binary even without a known signature', () => {
    expect(sniffFormat(bytes(Buffer.from([0x41, 0x00, 0x42]))).format).toBe('binary')
  })

  it('treats ordinary text as text', () => {
    expect(sniffFormat(bytes('# 标题\n正文\n'))).toEqual({ format: 'text' })
  })
})

describe('documentText', () => {
  it('extracts the text layer of a PDF instead of ingesting its syntax', async () => {
    const decoded = await documentText(bytes(tinyPdf('Gateway design spec v2')), 'plain.pdf')
    expect(decoded.text).toContain('Gateway design spec v2')
    expect(decoded.text).not.toContain('%PDF-')
    expect(decoded.text).not.toContain('/Type /Catalog')
    expect(decoded.via).toBe('pdf')
    expect(decoded.encoding).toBeUndefined() // a text LAYER has no byte encoding of its own
  })

  it('extracts from a Flate-compressed content stream (the real-world shape)', async () => {
    const decoded = await documentText(bytes(tinyPdf('Gateway design spec v2', { compress: true })), 'flate.pdf')
    expect(decoded.text).toContain('Gateway design spec v2')
  })

  it('fails loudly for a PDF with no text layer instead of ingesting nothing', async () => {
    await expect(documentText(bytes(textlessPdf()), 'scanned.pdf')).rejects.toThrow(/没有可抽取的文本层/)
  })

  it('refuses a binary with the detected kind, rather than decoding it as UTF-8', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
    await expect(documentText(bytes(png), 'shot.png')).rejects.toThrow(/不支持的二进制文件（PNG 图片）/)
  })

  it('decodes GBK bytes as GB18030 and says so (a short file used to slip through as mojibake)', async () => {
    // GBK for 「网关设计规范」 — 12 bytes, not valid UTF-8. The old "count replacement characters,
    // reject above 100" rule never fired for a file this short: it was ingested as garbage.
    const gbk = Buffer.from([0xcd, 0xf8, 0xb9, 0xd8, 0xc9, 0xe8, 0xbc, 0xc6, 0xb9, 0xe6, 0xb7, 0xb6])
    const decoded = await documentText(bytes(gbk), 'gbk.txt')
    expect(decoded.text).toBe('网关设计规范')
    expect(decoded.encoding).toBe('gb18030')
    expect(decoded.via).toBe('text')
  })

  it('strips a UTF-8 BOM and reports it', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('网关设计', 'utf8')])
    const decoded = await documentText(bytes(withBom), 'bom.txt')
    expect(decoded.text).toBe('网关设计')
    expect(decoded.encoding).toBe('utf-8-bom')
  })

  it('decodes BOM-prefixed UTF-16 instead of calling it binary (its bytes are half NUL)', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('网关设计', 'utf16le')])
    expect(sniffFormat(bytes(utf16)).format).toBe('text')
    const decoded = await documentText(bytes(utf16), 'utf16.txt')
    expect(decoded.text).toBe('网关设计')
    expect(decoded.encoding).toBe('utf-16le')
  })

  it('still refuses bytes that no supported encoding decodes', async () => {
    // 0xFF is invalid UTF-8 AND invalid GB18030 (as is a truncated multi-byte tail), so there is
    // nothing honest to index — the loud path survives the GB18030 fallback.
    await expect(documentText(bytes(Buffer.from([0xff, 0x41])), 'junk.bin')).rejects.toThrow(/无法作为文本解码/)
    await expect(documentText(bytes(Buffer.from([0x81])), 'truncated.txt')).rejects.toThrow(/无法作为文本解码/)
  })

  it('reports the GB18030 guess when neither encoding is a clean fit', async () => {
    // A stray 0x80 is not UTF-8; GB18030 happily maps it to `€`. That is a guess, and the point of
    // returning `encoding` is that the caller can SEE it rather than trust a silent decode.
    const decoded = await documentText(bytes(Buffer.from([0x80, 0x41])), 'guess.bin')
    expect(decoded.encoding).toBe('gb18030')
  })
})

describe('documentText: format conversion', () => {
  it('converts a docx to Markdown BEFORE the binary sniff can refuse its ZIP magic', async () => {
    // The whole ordering constraint in one assertion: these bytes begin with `PK\x03\x04`, which
    // `sniffFormat` calls a binary, so a sniff-first pipeline would reject the document.
    const docx = docxBytes('网关设计规范', '本文说明限流策略。')
    expect(sniffFormat(bytes(docx)).format).toBe('binary')
    const decoded = await documentText(bytes(docx), 'gateway.docx')
    expect(decoded.via).toBe('converter')
    // The id is version-qualified on purpose: the pandoc that produced the body is visible in the
    // result and in frontmatter, so a corpus built by another version is identifiable.
    expect(decoded.converter).toBe('pandoc-3.11')
    expect(decoded.text).toContain('# 网关设计规范')
    expect(decoded.text).toContain('本文说明限流策略。')
    expect(decoded.encoding).toBeUndefined()
  })

  it('converts a csv to a Markdown table through the same converter', async () => {
    const decoded = await documentText(bytes('键,值\n超时,30\n重试,3\n'), 'data.csv')
    expect(decoded.via).toBe('converter')
    expect(decoded.converter).toBe('pandoc-3.11')
    // The table is GFM, so the chunker reads real rows rather than one comma-joined paragraph.
    expect(decoded.text).toMatch(/\|\s*键\s*\|\s*值\s*\|/)
    expect(decoded.text).toMatch(/\|\s*超时\s*\|\s*30\s*\|/)
  })

  it('STILL refuses a ZIP that is neither a docx nor an xlsx (the counterexample)', async () => {
    // A converter registry that claimed every ZIP would swallow every ordinary archive. The refusal
    // must name what the bytes are, exactly as before conversion existed.
    await expect(documentText(bytes(plainZipBytes()), 'archive.zip'))
      .rejects.toThrow(/不支持的二进制文件（ZIP 压缩包/)
    await expect(documentText(bytes(pptxBytes()), 'slides.pptx'))
      .rejects.toThrow(/不支持的二进制文件（ZIP 压缩包/)
  })

  it('fails loudly when a claimant cannot convert the document', async () => {
    // A ZIP carrying word/document.xml (so the converter claims it) whose XML is unparseable: the
    // failure is reported with the converter id instead of falling through to the text path, which
    // would turn a broken Office document into mojibake chunks.
    await expect(documentText(bytes(brokenDocxBytes()), 'broken.docx'))
      .rejects.toThrow(/文档转换失败（pandoc-3\.11）：broken\.docx.*pandoc 转换失败/s)
  })
})

describe('normalizeCjkCompatibility', () => {
  it('restores ideographs that some CJK PDFs report as Kangxi radicals', () => {
    // ⽹站 / ⼩艺 / ⽅式 are the compatibility forms pdfjs produced for a real Chinese PDF.
    expect(normalizeCjkCompatibility('⽹站 ⼩艺 ⽅式')).toBe('网站 小艺 方式')
  })

  it('leaves full-width punctuation and ordinary text alone', () => {
    // NFKC over the whole string would rewrite these; the targeted ranges must not.
    expect(normalizeCjkCompatibility('第一，二。三！四？')).toBe('第一，二。三！四？')
    expect(normalizeCjkCompatibility('plain ASCII, 汉字')).toBe('plain ASCII, 汉字')
  })
})
