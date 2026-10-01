/**
 * `extractZip`'s SIZE ACCOUNTING, per compression method.
 *
 * The extractor's own doc comment promised "verifying both sizes", but only the STORE branch compared
 * anything: the DEFLATE branch inflated straight to disk, so an archive that understated an entry's
 * `uncompressedSize` could expand without limit. These cases pin both directions on both methods:
 * understated (must abort mid-inflate) and overstated (must fail the equality check), plus the
 * happy path, so the size check cannot be "fixed" by refusing everything.
 *
 * The archives come from the INDEPENDENT hand-written writer in `helpers/zip-writer.ts`, which can be
 * told to write a size field that does not match the payload.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProvisionError } from '../src/errors.js'
import { extractZip } from '../src/zip.js'
import { zipSync, type ZipFileSpec } from './helpers/zip-writer.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-zip-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write one archive into the fixture directory and return its path. */
function archive(name: string, files: ZipFileSpec[]): string {
  const path = join(dir, name)
  writeFileSync(path, zipSync(files))
  return path
}

describe('extractZip size accounting', () => {
  it('extracts a DEFLATE entry whose declared size is the truth', async () => {
    const dest = join(dir, 'out-ok')
    const bytes = Buffer.from('pandoc 3.11\n'.repeat(200), 'utf8')
    await extractZip(archive('ok.zip', [{ name: 'pandoc', data: bytes }]), dest, 'faketool')
    expect(readFileSync(join(dest, 'pandoc'))).toEqual(bytes)
  })

  it('aborts a DEFLATE entry that inflates PAST its declared size, and leaves no file', async () => {
    // `declaredUncompressedSize: 16` against a 64 KiB payload: the old code inflated all 64 KiB to
    // disk and reported success. The check must fire on the way through, not after the fact.
    const dest = join(dir, 'out-over')
    const bytes = Buffer.from('A'.repeat(64 * 1024), 'utf8')
    const path = archive('over.zip', [{ name: 'pandoc', data: bytes, declaredUncompressedSize: 16 }])
    await expect(extractZip(path, dest, 'faketool')).rejects.toThrow(ProvisionError)
    await expect(extractZip(path, dest, 'faketool')).rejects.toThrow(/超过声明大小/)
    // The partially written entry is cleaned up with the rest of the scratch extraction.
    expect(existsSync(join(dest, 'pandoc'))).toBe(false)
  })

  it('refuses a DEFLATE entry whose declared size OVERSTATES the payload', async () => {
    // A size that merely disagrees is corruption too: the check is equality, not a ceiling.
    const dest = join(dir, 'out-under')
    const bytes = Buffer.from('B'.repeat(1024), 'utf8')
    const path = archive('under.zip', [{ name: 'pandoc', data: bytes, declaredUncompressedSize: 4096 }])
    await expect(extractZip(path, dest, 'faketool')).rejects.toThrow(/与声明不一致/)
    expect(existsSync(join(dest, 'pandoc'))).toBe(false)
  })

  it('still extracts a STORE entry and refuses one whose two sizes disagree', async () => {
    const dest = join(dir, 'out-store')
    const bytes = Buffer.from('stored binary\n'.repeat(10), 'utf8')
    await extractZip(archive('store.zip', [{ name: 'tool', data: bytes, store: true }]), dest, 'faketool')
    expect(readFileSync(join(dest, 'tool'))).toEqual(bytes)

    const lying = archive('store-lie.zip', [{ name: 'tool', data: bytes, store: true, declaredUncompressedSize: bytes.length + 1 }])
    await expect(extractZip(lying, join(dir, 'out-store-lie'), 'faketool')).rejects.toThrow(/两个大小不一致/)
  })
})
