/**
 * Decoding a document's bytes to text before conversion.
 *
 * The knowledge pipeline has its own decoder (`document_text.ts`), but this package must not import
 * it: a converter is asked about every document, including ones the pipeline would serve as text,
 * and the whole point of the registry is that it stands alone. The rule is the same one, though,
 * because a wrong guess must not become silent mojibake — BOM first, then strict UTF-8, then strict
 * GB18030, and a failure names the encoding problem instead of returning replacement characters.
 *
 * @module decode
 */

interface Bom {
  readonly bytes: readonly number[]
  readonly encoding: 'utf-8-bom' | 'utf-16le' | 'utf-16be'
}

const BOMS: readonly Bom[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8-bom' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
]

const DECODER_LABEL = { 'utf-8-bom': 'utf-8', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be' } as const

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte)
}

function strict(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * One document's text, or a thrown error naming what could not be decoded.
 *
 * @param bytes - the whole document.
 * @param label - the path or URL, used verbatim in the error.
 */
export function decodeDocumentText(bytes: Uint8Array, label: string): string {
  for (const bom of BOMS) {
    if (!startsWith(bytes, bom.bytes)) continue
    const text = strict(bytes.subarray(bom.bytes.length), DECODER_LABEL[bom.encoding])
    if (text === null) throw new Error(`${label}：带 BOM 的 ${bom.encoding} 文本无法解码`)
    return text
  }
  const utf8 = strict(bytes, 'utf-8')
  if (utf8 !== null) return utf8
  const gb18030 = strict(bytes, 'gb18030')
  if (gb18030 !== null) return gb18030
  throw new Error(`${label}：无法按 UTF-8 / GB18030 解码，也没有可识别的 BOM`)
}
