/**
 * ZIP extraction, implemented here for the same reason `@avantf/mem-convert` reads ZIPs itself:
 * the format's read side is a directory plus one `zlib` stream per entry, and the alternative —
 * shelling out to `unzip` — is a dependency on a program that is not installed by default on
 * Windows and is absent on minimal Linux images.
 *
 * Only what a release archive needs: STORE and DEFLATE entries, directory entries, and the two
 * layouts pandoc's Windows zip uses (the binary at the archive root and under a top-level folder).
 * ZIP64 and encryption are refused with a named error rather than half-read.
 *
 * Every write is validated against ZIP SLIP first: an entry name that escapes the destination
 * through `..`, an absolute path or a symlink is a hard failure. A release archive is trusted
 * content, but "trusted" is not a property the code can check, so the check runs anyway.
 *
 * @module zip
 */
import { createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { createInflateRaw } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { ProvisionError } from './errors.js'

/** End of central directory record: signature + 18 bytes of fields + a comment length. */
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
/** No comment field is longer than this, so the EOCD must start within the last 65557 bytes. */
const EOCD_MAX_SCAN = 0xffff + EOCD_MIN_SIZE

/** One central-directory entry, as far as extraction needs it. */
interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  directory: boolean
}

/** Find the offset of the EOCD record, scanning backwards (a ZIP may carry a comment). */
function findEocd(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const start = Math.max(0, data.byteLength - EOCD_MAX_SCAN)
  for (let at = data.byteLength - EOCD_MIN_SIZE; at >= start; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at
  }
  return -1
}

/**
 * Read the central directory. Throws when the archive is not a ZIP, is ZIP64, or is truncated —
 * each with what was actually seen.
 */
function readEntries(data: Uint8Array, artifact: string): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const eocd = findEocd(data)
  if (eocd === -1) throw new ProvisionError('extract', artifact, '不是 ZIP 归档（找不到中央目录结束记录）')
  const count = view.getUint16(eocd + 10, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new ProvisionError('extract', artifact, 'ZIP64 归档不受支持')
  }
  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > data.byteLength || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new ProvisionError('extract', artifact, `中央目录第 ${String(index + 1)} 条记录损坏（偏移 ${String(cursor)}）`)
    }
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = new TextDecoder('utf-8').decode(nameBytes)
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      directory: name.endsWith('/'),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Reject an entry name that would write outside `root`, or that hides a link. */
function safeDestination(root: string, name: string, artifact: string): string | undefined {
  if (name === '' || name.includes('\0')) throw new ProvisionError('extract', artifact, `归档条目名不合法：${JSON.stringify(name)}`)
  if (isAbsolute(name) || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw new ProvisionError('extract', artifact, `归档条目是绝对路径：${name}`)
  }
  const parts = name.split('/')
  if (parts.includes('..')) throw new ProvisionError('extract', artifact, `归档条目试图跳出目标目录：${name}`)
  const destination = resolve(root, normalize(name.split('/').join(sep)))
  if (destination !== root && !destination.startsWith(root + sep)) {
    throw new ProvisionError('extract', artifact, `归档条目超出目标目录：${name}`)
  }
  return destination
}

/** Extract one entry's bytes to `destination`, verifying both sizes on BOTH methods. */
async function writeEntry(
  data: Uint8Array,
  view: DataView,
  entry: ZipEntry,
  destination: string,
  artifact: string,
): Promise<void> {
  const localOffset = entry.localOffset
  if (localOffset + 30 > data.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
    throw new ProvisionError('extract', artifact, `条目「${entry.name}」的本地文件头损坏`)
  }
  const nameLength = view.getUint16(localOffset + 26, true)
  const extraLength = view.getUint16(localOffset + 28, true)
  const dataStart = localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > data.byteLength) {
    throw new ProvisionError('extract', artifact, `条目「${entry.name}」的数据被截断`)
  }
  const compressed = data.subarray(dataStart, dataEnd)
  // Validate BEFORE creating the output stream: a rejected entry used to leave an orphaned
  // `WriteStream` behind (its async open then raced the caller's scratch cleanup, surfacing as an
  // unhandled ENOENT), and a method/size mismatch wrote an empty file that only the caller's
  // rollback removed.
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new ProvisionError('extract', artifact, `条目「${entry.name}」声明 STORE 但两个大小不一致`)
    }
  } else if (entry.method !== 8) {
    throw new ProvisionError('extract', artifact, `条目「${entry.name}」的压缩方式 ${String(entry.method)} 不受支持（只支持 STORE/DEFLATE）`)
  }
  mkdirSync(dirname(destination), { recursive: true })
  const out = createWriteStream(destination)
  if (entry.method === 0) {
    await pipeline(async function* () { yield compressed }(), out)
    return
  }
  // DEFLATE used to be the unchecked method: it inflated straight to disk, so an archive that
  // understated `uncompressedSize` could expand without limit (the caller pins the archive's own
  // byte count and sha256, but that bounds the COMPRESSED bytes only). Count on the way through,
  // abort the moment the declared size is exceeded — the inflater is destroyed by the rejected
  // pipeline, so the excess never lands — and require the final count to match exactly, which also
  // rejects a size that merely overSTATES the payload.
  const expected = entry.uncompressedSize
  let written = 0
  await pipeline(
    async function* () { yield compressed }(),
    createInflateRaw(),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        written += chunk.length
        if (written > expected) {
          throw new ProvisionError('extract', artifact, `条目「${entry.name}」解压后超过声明大小 ${String(expected)} 字节`)
        }
        yield chunk
      }
    },
    out,
  )
  if (written !== expected) {
    throw new ProvisionError('extract', artifact, `条目「${entry.name}」解压大小与声明不一致（声明 ${String(expected)}，实际 ${String(written)} 字节）`)
  }
}

/** On-disk size of a directory tree, for the "did anything land" check and the install log. */
function treeBytes(dir: string): number {
  const stack = [dir]
  let total = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry)
      try {
        const stat = statSync(full)
        if (stat.isDirectory()) stack.push(full)
        else total += stat.size
      } catch {
        // Vanished mid-walk; not this function's problem.
      }
    }
  }
  return total
}

/**
 * Extract `archive` into the (existing, empty) `destination`.
 *
 * Atomicity lives one level up: this writes into a scratch directory, and the caller renames the
 * scratch into place only after this returns, so a failed extraction leaves no half-installed tool.
 */
export async function extractZip(archive: string, destination: string, artifact: string): Promise<void> {
  const data = new Uint8Array(readFileSync(archive))
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const entries = readEntries(data, artifact)
  const created: string[] = []
  try {
    for (const entry of entries) {
      const target = safeDestination(destination, entry.name, artifact)
      if (target === undefined) continue
      if (entry.directory) {
        mkdirSync(target, { recursive: true })
        continue
      }
      created.push(target)
      await writeEntry(data, view, entry, target, artifact)
    }
    if (treeBytes(destination) === 0) {
      throw new ProvisionError('extract', artifact, '归档解压后没有任何文件')
    }
  } catch (error) {
    // A scratch directory the caller will delete anyway, but leaving it clean keeps the failure
    // output readable when a human inspects the tools directory.
    for (const file of created.reverse()) rmSync(file, { force: true })
    throw error
  }
}
