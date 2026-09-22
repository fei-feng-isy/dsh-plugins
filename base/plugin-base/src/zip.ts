/**
 * A minimal zero-dependency `zip` reader (stored + deflate) with path-traversal checks.
 * @module zip
 */
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { ProvisionError } from './errors.js'
import { safeEntryPath } from './tar.js'
import type { ProvisionFs } from './types.js'

/** Hard cap for one decompressed entry. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_MARKER = 0xffffffff

interface CentralEntry {
  readonly name: string
  readonly method: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0
}

/** Locate the end-of-central-directory record, scanning back over a possible comment. */
function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const earliest = Math.max(0, bytes.length - 65_557)
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (readU32(bytes, offset) === EOCD_SIGNATURE) return offset
  }
  throw new ProvisionError('extract/failed', 'zip 缺少中央目录记录（不是有效的 zip？）')
}

function readCentralDirectory(bytes: Uint8Array): readonly CentralEntry[] {
  const eocd = findEndOfCentralDirectory(bytes)
  const count = readU16(bytes, eocd + 10)
  const directorySize = readU32(bytes, eocd + 12)
  const directoryOffset = readU32(bytes, eocd + 16)
  if (directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER) {
    throw new ProvisionError('extract/failed', '不支持 ZIP64 归档')
  }
  const entries: CentralEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (readU32(bytes, cursor) !== CENTRAL_SIGNATURE) {
      throw new ProvisionError('extract/failed', `zip 中央目录第 ${String(index)} 条签名不对`)
    }
    const method = readU16(bytes, cursor + 10)
    const compressedSize = readU32(bytes, cursor + 20)
    const uncompressedSize = readU32(bytes, cursor + 24)
    const nameLength = readU16(bytes, cursor + 28)
    const extraLength = readU16(bytes, cursor + 30)
    const commentLength = readU16(bytes, cursor + 32)
    const localOffset = readU32(bytes, cursor + 42)
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      throw new ProvisionError('extract/failed', `不支持 ZIP64 条目：${name}`)
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Read one entry's bytes, following its local header for the actual data offset. */
function readEntry(bytes: Uint8Array, entry: CentralEntry): Uint8Array {
  const local = entry.localOffset
  if (readU32(bytes, local) !== LOCAL_SIGNATURE) {
    throw new ProvisionError('extract/failed', `zip 本地头签名不对：${entry.name}`)
  }
  const nameLength = readU16(bytes, local + 26)
  const extraLength = readU16(bytes, local + 28)
  const start = local + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  const raw = bytes.subarray(start, end)
  if (entry.method === 0) return raw
  if (entry.method === 8) {
    try {
      const inflated = new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_UNPACKED_BYTES }))
      // The inflated size must equal the declared uncompressed size.
      if (inflated.byteLength !== entry.uncompressedSize) {
        throw new ProvisionError(
          'extract/failed',
          `zip 条目 ${entry.name} 的实际大小 ${String(inflated.byteLength)} 与头部声明 ${String(entry.uncompressedSize)} 不符`,
        )
      }
      return inflated
    } catch (error) {
      throw new ProvisionError('extract/failed', `zip 解压失败：${entry.name}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
  throw new ProvisionError('extract/failed', `不支持的 zip 压缩方法 ${String(entry.method)}：${entry.name}`)
}

export interface ZipExtractOptions {
  /** Drop this many leading path segments. */
  readonly strip?: number
}

/** Extract an in-memory zip into `destination`, rejecting any traversal attempt. */
export async function extractZip(
  archive: Uint8Array,
  destination: string,
  fs: ProvisionFs,
  options: ZipExtractOptions = {},
): Promise<void> {
  await fs.mkdir(destination)
  for (const entry of readCentralDirectory(archive)) {
    const relative = safeEntryPath(entry.name)
    if (relative === undefined) continue
    const parts = relative.split('/')
    const strip = options.strip ?? 0
    if (parts.length <= strip) continue
    const stripped = parts.slice(strip).join('/')
    const target = join(destination, ...stripped.split('/'))
    if (entry.name.endsWith('/')) {
      await fs.mkdir(target)
      continue
    }
    await fs.mkdir(dirname(target))
    await fs.writeFile(target, readEntry(archive, entry))
  }
}
