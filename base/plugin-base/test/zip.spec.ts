import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFs } from '../src/fs.js'
import { extractZip } from '../src/zip.js'
import { buildZip } from './helpers/zip.js'

describe('zip 解包', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'envinit-zip-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('store 与 deflate 两种方法都能解出内容', async () => {
    const archive = buildZip([
      { name: 'pkg/', data: '' },
      { name: 'pkg/plain.txt', data: 'stored' },
      { name: 'pkg/deflated.txt', data: 'deflated content that compresses', deflate: true },
    ])
    const destination = join(root, 'out')
    await extractZip(archive, destination, defaultFs(), { strip: 1 })
    expect(await readFile(join(destination, 'plain.txt'), 'utf8')).toBe('stored')
    expect(await readFile(join(destination, 'deflated.txt'), 'utf8')).toBe('deflated content that compresses')
  })

  it('拒绝跳出目标的条目', async () => {
    const archive = buildZip([{ name: '../evil.txt', data: 'nope' }])
    await expect(extractZip(archive, join(root, 'out'), defaultFs())).rejects.toMatchObject({
      code: 'archive/path-traversal',
    })
  })

  it('拒绝绝对路径条目', async () => {
    const archive = buildZip([{ name: '/etc/passwd', data: 'nope' }])
    await expect(extractZip(archive, join(root, 'out'), defaultFs())).rejects.toMatchObject({
      code: 'archive/path-traversal',
    })
  })

  it('不是 zip 时报 extract/failed', async () => {
    const archive = new TextEncoder().encode('not a zip at all')
    await expect(extractZip(archive, join(root, 'out'), defaultFs())).rejects.toMatchObject({ code: 'extract/failed' })
  })
})
