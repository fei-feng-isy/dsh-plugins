/**
 * Test helper: build a `.tar.gz` in memory, so tar tests need no fixtures on disk.
 *
 * @module helpers/tar
 */
import { gzipSync } from 'node:zlib'

export interface TarEntry {
  readonly name: string
  readonly data?: string
  /** `0` file (default), `5` directory, `2` symlink. */
  readonly type?: '0' | '5' | '2'
  readonly link?: string
}

function writeField(block: Uint8Array, offset: number, value: string, length: number): void {
  const bytes = new TextEncoder().encode(value)
  block.set(bytes.subarray(0, length), offset)
}

function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(512)
  const type = entry.type ?? '0'
  const data = entry.type === '2' ? '' : (entry.data ?? '')
  const size = entry.type === '2' ? 0 : new TextEncoder().encode(data).length
  writeField(block, 0, entry.name, 100)
  writeField(block, 100, '0000644\0', 8)
  writeField(block, 108, '0000000\0', 8)
  writeField(block, 116, '0000000\0', 8)
  writeField(block, 124, `${size.toString(8).padStart(11, '0')}\0`, 12)
  writeField(block, 136, '00000000000\0', 12)
  block[156] = type.charCodeAt(0)
  if (entry.type === '2' && entry.link !== undefined) writeField(block, 157, entry.link, 100)
  writeField(block, 257, 'ustar\0', 6)
  writeField(block, 263, '00', 2)
  for (let index = 148; index < 156; index += 1) block[index] = 32
  let sum = 0
  for (const byte of block) sum += byte
  writeField(block, 148, `${sum.toString(8).padStart(6, '0')}\0 `, 8)
  return block
}

/** Serialise entries into a gzipped tar archive. */
export function tarGz(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    chunks.push(header(entry))
    if ((entry.type ?? '0') === '0' && entry.data !== undefined && entry.data !== '') {
      const body = new TextEncoder().encode(entry.data)
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512)
      padded.set(body)
      chunks.push(padded)
    }
  }
  chunks.push(new Uint8Array(1024))
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const archive = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    archive.set(chunk, offset)
    offset += chunk.length
  }
  return new Uint8Array(gzipSync(archive))
}
