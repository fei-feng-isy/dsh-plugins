/**
 * A minimal ZIP writer for the specs.
 *
 * The reader under test is `src/zip.ts`, so the fixtures cannot come from a library the reader
 * shares code with — and a committed binary blob would be unreviewable. This writes the three
 * structures a real archive has (local headers, central directory, EOCD) so a spec can build a
 * docx-shaped archive, an xlsx-shaped one, an EPUB, or a plain zip that must NOT be claimed.
 *
 * @module test/helpers/archive
 */
import { deflateRawSync } from 'node:zlib'

export interface ArchiveEntry {
  name: string
  data: Uint8Array | string
  /** Stored (`false` = deflate by default). EPUB's `mimetype` requires stored. */
  store?: boolean
  /**
   * LIE about the uncompressed size in both headers.
   *
   * This is a decompression bomb's shape — a few bytes on the wire claiming gigabytes — and it lets
   * a spec pin the refusal without building a real multi-gigabyte archive. `zipDeclaredCost` reads
   * exactly this claim.
   */
  declaredUncompressed?: number
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

/** Encode one entry's stored bytes and compression method. */
function stored(entry: ArchiveEntry): { data: Uint8Array; method: number; rawLength: number } {
  const raw = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data
  if (entry.store === true) return { data: raw, method: 0, rawLength: raw.length }
  return { data: new Uint8Array(deflateRawSync(raw)), method: 8, rawLength: raw.length }
}

/** Build a ZIP archive (no ZIP64, no data descriptors) from `entries`. */
export function buildTestArchive(entries: readonly ArchiveEntry[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name)
    const packed = stored(entry)
    const data = packed.data
    const method = packed.method
    const rawLength = entry.declaredUncompressed ?? packed.rawLength
    const crc = crc32(data)

    const local = new Uint8Array(30 + name.length + data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, method, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, data.length, true) // compressed size
    localView.setUint32(22, rawLength, true) // uncompressed size
    localView.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(data, 30 + name.length)
    locals.push(local)

    const central = new Uint8Array(46 + name.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(10, method, true)
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, data.length, true) // compressed size
    centralView.setUint32(24, rawLength, true) // uncompressed size
    centralView.setUint16(28, name.length, true)
    centralView.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)
    offset += local.length
  }

  const directorySize = centrals.reduce((total, part) => total + part.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, directorySize, true)
  eocdView.setUint32(16, offset, true)

  return Buffer.concat([...locals, ...centrals, eocd])
}
