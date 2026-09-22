/**
 * Minimal PDFs, built byte by byte, so the ingestion tests can pin "bytes → text" without
 * committing a binary blob.
 *
 * Both shapes matter: an uncompressed content stream puts the text in the clear, and a
 * Flate-compressed one (what every real-world PDF uses) hides it inside a zlib stream — the case
 * that used to be ingested as `%PDF-1.4 …` with the visible text nowhere in the corpus.
 */
import { deflateSync } from 'node:zlib'

/** Escape the three characters a PDF literal string cannot carry raw. */
function literal(text: string): string {
  return text.replace(/[\\()]/g, ch => `\\${ch}`)
}

function assemble(objects: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')]
  const offsets: number[] = []
  let size = parts[0]!.length
  objects.forEach((object, index) => {
    offsets.push(size)
    const chunk = Buffer.concat([
      Buffer.from(`${String(index + 1)} 0 obj\n`, 'latin1'),
      object,
      Buffer.from('\nendobj\n', 'latin1'),
    ])
    parts.push(chunk)
    size += chunk.length
  })
  const xref = [`xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`]
  for (const offset of offsets) xref.push(`${String(offset).padStart(10, '0')} 00000 n \n`)
  xref.push(`trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(size)}\n%%EOF\n`)
  parts.push(Buffer.from(xref.join(''), 'latin1'))
  return Buffer.concat(parts)
}

/** A one-page PDF whose text layer contains `text`, optionally Flate-compressed. */
export function tinyPdf(text: string, options: { compress?: boolean } = {}): Buffer {
  const content = Buffer.from(`BT /F1 18 Tf 10 50 Td (${literal(text)}) Tj ET`, 'latin1')
  const compress = options.compress === true
  const stream = compress ? deflateSync(content) : content
  const filter = compress ? ' /Filter /FlateDecode' : ''
  return assemble([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      'latin1',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${String(stream.length)}${filter} >>\nstream\n`, 'latin1'),
      stream,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'latin1'),
  ])
}

/**
 * A one-page PDF that draws NOTHING — the scanned/image-only shape as far as a text extractor can
 * tell, which must fail loudly instead of ingesting an empty document.
 */
export function textlessPdf(): Buffer {
  return assemble([
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R >>', 'latin1'),
    Buffer.from('<< /Length 0 >>\nstream\n\nendstream', 'latin1'),
  ])
}
