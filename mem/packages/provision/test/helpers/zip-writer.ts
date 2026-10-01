/**
 * A minimal ZIP WRITER for fixtures.
 *
 * Written here rather than reached from a dependency so the extractor spec is a round trip between
 * two independent implementations: `src/zip.ts` parses the central directory by hand, and this writes
 * one by hand. Using a third-party writer would make "the extractor agrees with the writer" partially
 * a test of that library rather than of our reader.
 *
 * @module test/helpers/zip-writer
 */
import { deflateRawSync } from 'node:zlib'

/** One file to store; directories are implied by the names. */
export interface ZipFileSpec {
  name: string
  data: Buffer
  /** Force STORE (method 0) instead of DEFLATE (method 8). */
  store?: boolean
  /**
   * Write a size that does NOT match `data.length` into both size fields — the "lying archive" a
   * size check exists for. Omitted, the real length is written, as a correct writer would.
   */
  declaredUncompressedSize?: number
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Build a ZIP archive from `files`, returning its bytes. */
export function zipSync(files: readonly ZipFileSpec[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const compressed = file.store === true ? file.data : deflateRawSync(file.data, { level: 9 })
    const method = file.store === true ? 0 : 8
    const crc = crc32(file.data)
    const uncompressedSize = file.declaredUncompressedSize ?? file.data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0, 12) // date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(uncompressedSize, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localParts.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(uncompressedSize, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38) // external attrs: a regular file
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + compressed.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // disk
  eocd.writeUInt16LE(0, 6) // central directory disk
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment length
  return Buffer.concat([...localParts, centralDirectory, eocd])
}
