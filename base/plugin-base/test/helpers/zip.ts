/**
 * Test helper: build a zip in memory (store or deflate), so zip tests need no fixtures on disk.
 *
 * @module helpers/zip
 */
import { deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  readonly name: string
  readonly data?: string
  readonly deflate?: boolean
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

/** Serialise entries into a zip archive (no CRC — the reader does not verify it). */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const raw = encoder.encode(entry.data ?? '')
    const method = entry.deflate === true ? 8 : 0
    const body = entry.deflate === true ? new Uint8Array(deflateRawSync(raw)) : raw

    const local = new Uint8Array(30 + name.length + body.length)
    writeU32(local, 0, 0x04034b50)
    writeU16(local, 4, 20)
    writeU16(local, 8, method)
    writeU32(local, 18, body.length)
    writeU32(local, 22, raw.length)
    writeU16(local, 26, name.length)
    local.set(name, 30)
    local.set(body, 30 + name.length)
    locals.push(local)

    const central = new Uint8Array(46 + name.length)
    writeU32(central, 0, 0x02014b50)
    writeU16(central, 4, 20)
    writeU16(central, 6, 20)
    writeU16(central, 10, method)
    writeU32(central, 20, body.length)
    writeU32(central, 24, raw.length)
    writeU16(central, 28, name.length)
    writeU16(central, 30, 0)
    writeU16(central, 32, 0)
    writeU32(central, 42, offset)
    central.set(name, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  writeU32(eocd, 0, 0x06054b50)
  writeU16(eocd, 8, entries.length)
  writeU16(eocd, 10, entries.length)
  writeU32(eocd, 12, centralSize)
  writeU32(eocd, 16, offset)

  const total = offset + centralSize + eocd.length
  const archive = new Uint8Array(total)
  let cursor = 0
  for (const part of [...locals, ...centrals, eocd]) {
    archive.set(part, cursor)
    cursor += part.length
  }
  return archive
}
