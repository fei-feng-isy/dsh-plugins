import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProvisionError } from '../src/errors.js'
import { defaultFs } from '../src/fs.js'
import { assertLinkStaysInside, extractTarGz } from '../src/tar.js'
import { tarGz } from './helpers/tar.js'

describe('tar 解包', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'envinit-tar-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('strip=1 后写到目标目录（npm 的 package/ 前缀）', async () => {
    const archive = tarGz([
      { name: 'package/', type: '5' },
      { name: 'package/package.json', data: '{"name":"x"}' },
      { name: 'package/lib/index.js', data: 'export const x = 1\n' },
    ])
    const destination = join(root, 'out')
    await extractTarGz(archive, destination, defaultFs(), { strip: 1 })
    expect(await readFile(join(destination, 'package.json'), 'utf8')).toBe('{"name":"x"}')
    expect(await readFile(join(destination, 'lib', 'index.js'), 'utf8')).toBe('export const x = 1\n')
  })

  it('拒绝跳出目标的条目', async () => {
    const archive = tarGz([{ name: 'package/../evil.txt', data: 'nope' }])
    await expect(extractTarGz(archive, join(root, 'out'), defaultFs(), { strip: 1 })).rejects.toMatchObject({
      code: 'archive/path-traversal',
    })
  })

  it('拒绝绝对路径条目', async () => {
    const archive = tarGz([{ name: '/etc/passwd', data: 'nope' }])
    const error = await extractTarGz(archive, join(root, 'out'), defaultFs()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProvisionError)
    expect((error as ProvisionError).code).toBe('archive/path-traversal')
  })

  it('拒绝跳出目标的符号链接', async () => {
    const archive = tarGz([{ name: 'package/link', type: '2', link: '../../outside' }])
    await expect(extractTarGz(archive, join(root, 'out'), defaultFs(), { strip: 1 })).rejects.toMatchObject({
      code: 'archive/path-traversal',
    })
  })

  describe('符号链接判定的 win32 形态（显式断言；仍需 Windows 实机复核）', () => {
    it('win32 反斜杠路径的子目录链接不再被误判越界', () => {
      // Old code: posix.relative('C:\\dest','C:\\dest\\sub') === '../C:\\dest\\sub' → every
      // sub-directory symlink was rejected on Windows.
      expect(() => {
        assertLinkStaysInside('C:\\dest', 'C:\\dest\\sub', 'target')
      }).not.toThrow()
      expect(() => {
        assertLinkStaysInside('C:\\dest', 'C:\\dest', 'a/b/target')
      }).not.toThrow()
    })

    it('win32 反斜杠的 `..` 目标仍被拒绝（fail-closed）', () => {
      expect(() => {
        assertLinkStaysInside('C:\\dest', 'C:\\dest\\sub', '..\\..\\evil')
      }).toThrow(ProvisionError)
    })

    it('UNC 目标按绝对路径拒绝（旧代码不识别前导 `\\\\`）', () => {
      expect(() => {
        assertLinkStaysInside('C:\\dest', 'C:\\dest', '\\\\srv\\share\\payload')
      }).toThrow(ProvisionError)
    })
  })
})
