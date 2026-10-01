/**
 * A minimal zero-dependency `tar` reader (plus gzip) with path-traversal checks.
 * @module tar
 */
import { dirname, join, posix } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { ProvisionError } from './errors.js'
import type { ProvisionFs } from './types.js'

/** Hard cap for one decompressed archive. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024

const BLOCK = 512

/** Decode a NUL-terminated field. */
function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  const bytes = end === -1 ? slice : slice.subarray(0, end)
  return new TextDecoder().decode(bytes)
}

/** Octal field; empty fields are zero. */
function readOctal(block: Uint8Array, offset: number, length: number, field: string): number {
  const raw = readString(block, offset, length).trim()
  if (raw === '') return 0
  const value = Number.parseInt(raw, 8)
  if (Number.isNaN(value) || value < 0) {
    throw new ProvisionError('extract/failed', `tar 头字段 ${field} 不是合法的八进制数：${JSON.stringify(raw)}`)
  }
  return value
}

/** Sum of the header with the checksum field treated as spaces. */
function headerChecksumIsValid(block: Uint8Array): boolean {
  const recorded = readOctal(block, 148, 8, 'chksum')
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0)
  }
  return sum === recorded
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let index = 0; index < BLOCK; index += 1) if (block[index] !== 0) return false
  return true
}

/** Normalise an entry name to a destination-relative path; `undefined` to skip, throws on escape. */
export function safeEntryPath(name: string): string | undefined {
  if (name === '' || name === '.' || name === './') return undefined
  if (name.includes('\0')) {
    throw new ProvisionError('archive/path-traversal', `归档条目名含 NUL：${JSON.stringify(name)}`)
  }
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw new ProvisionError('archive/path-traversal', `归档条目是绝对路径：${name}`)
  }
  // Check the raw segments before normalisation.
  const raw = name.replaceAll('\\', '/').split('/')
  if (raw.some(part => part === '..')) {
    throw new ProvisionError('archive/path-traversal', `归档条目试图跳出目标目录：${name}`)
  }
  const normalised = posix.normalize(name.replaceAll('\\', '/'))
  const parts = normalised.split('/').filter(part => part !== '' && part !== '.')
  if (parts.length === 0) return undefined
  return parts.join('/')
}

/** Parse one pax extended header record set for `path`. */
function paxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data)
  let cursor = 0
  let path: string | undefined
  while (cursor < text.length) {
    const space = text.indexOf(' ', cursor)
    if (space === -1) break
    const length = Number.parseInt(text.slice(cursor, space), 10)
    if (Number.isNaN(length) || length <= 0) break
    const record = text.slice(space + 1, cursor + length).replace(/\n$/, '')
    const equals = record.indexOf('=')
    if (equals > 0 && record.slice(0, equals) === 'path') path = record.slice(equals + 1)
    cursor += length
  }
  return path
}

export interface ExtractOptions {
  /** Drop this many leading path segments. */
  readonly strip?: number
}

/** Extract an in-memory `.tar.gz` into `destination` through the injected {@link ProvisionFs}. */
export async function extractTarGz(
  archive: Uint8Array,
  destination: string,
  fs: ProvisionFs,
  options: ExtractOptions = {},
): Promise<void> {
  let data: Uint8Array
  try {
    data = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES })
  } catch (error) {
    throw new ProvisionError('extract/failed', `gzip 解压失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const strip = options.strip ?? 0
  await fs.mkdir(destination)

  let offset = 0
  let pendingLongName: string | undefined
  let pendingPaxPath: string | undefined

  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) {
      offset += BLOCK
      continue
    }
    if (!headerChecksumIsValid(header)) {
      throw new ProvisionError('extract/failed', `tar 头校验和不匹配（偏移 ${offset}）`)
    }
    const size = readOctal(header, 124, 12, 'size')
    const type = String.fromCharCode(header[156] ?? 0)
    const bodyStart = offset + BLOCK
    const body = data.subarray(bodyStart, bodyStart + size)
    const next = bodyStart + Math.ceil(size / BLOCK) * BLOCK

    if (type === 'L') {
      pendingLongName = readString(body, 0, body.length)
      offset = next
      continue
    }
    if (type === 'x') {
      pendingPaxPath = paxPath(body) ?? pendingPaxPath
      offset = next
      continue
    }
    if (type === 'g') {
      offset = next
      continue
    }

    const prefix = readString(header, 345, 155)
    const rawName = pendingLongName ?? pendingPaxPath ?? (prefix === '' ? readString(header, 0, 100) : `${prefix}/${readString(header, 0, 100)}`)
    pendingLongName = undefined
    pendingPaxPath = undefined

    const relative = safeEntryPath(rawName)
    if (relative !== undefined) {
      const stripped = stripSegments(relative, strip)
      if (stripped !== undefined) {
        const target = join(destination, ...stripped.split('/'))
        const isDirectory = type === '5' || rawName.endsWith('/')
        if (isDirectory) {
          await fs.mkdir(target)
        } else if (type === '0' || type === '\0' || type === '') {
          await fs.mkdir(dirname(target))
          await fs.writeFile(target, body)
        } else if (type === '2') {
          const link = readString(header, 157, 100)
          assertLinkStaysInside(destination, dirname(target), link)
          await fs.mkdir(dirname(target))
          await fs.symlink(link, target)
        } else if (type === '1') {
          throw new ProvisionError('extract/failed', `不支持 tar 硬链接条目：${rawName}`)
        }
        // Other typeflags (character devices, fifos, …) are ignored.
      }
    }
    offset = next
  }
}

function stripSegments(relative: string, strip: number): string | undefined {
  if (strip === 0) return relative
  const parts = relative.split('/')
  if (parts.length <= strip) return undefined
  return parts.slice(strip).join('/')
}

/** A symlink may point anywhere inside the destination, never outside it.
 *
 *  Every path here is normalised to forward slashes before the POSIX computation, because on Windows
 *  the destination/dir come from `path.join` (backslashes) and feeding those to `posix.relative`
 *  yielded `../C:\…` — i.e. every sub-directory symlink was rejected. Normalising the link too keeps
 *  a `..\..\evil` Windows-shaped target from being treated as one opaque segment (fail-closed). */
export function assertLinkStaysInside(destination: string, fromDir: string, link: string): void {
  const slash = (path: string): string => path.replaceAll('\\', '/')
  const linkPath = slash(link)
  if (linkPath.startsWith('/') || /^[a-zA-Z]:\//.test(linkPath)) {
    throw new ProvisionError('archive/path-traversal', `归档符号链接指向绝对路径：${link}`)
  }
  const base = posix.relative(slash(destination), slash(fromDir))
  const resolved = posix.normalize(posix.join(base === '' ? '.' : base, linkPath))
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new ProvisionError('archive/path-traversal', `归档符号链接跳出目标目录：${link}`)
  }
}
