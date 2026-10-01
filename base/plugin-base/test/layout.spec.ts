/**
 * The disk layout primitives: the version segment that
 * keeps Windows paths under the budget, and the two guards that keep a `target.root` / provider
 * path inside `home`.
 *
 * @module test/layout
 */
import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSafeRelativePath, assertSafeRelativeRoot, isInside, versionSegment } from '../src/layout.js'

const digestOf = (name: string, version: string): string => createHash('sha256').update(`${name}@${version}`).digest('hex')

/** The stable code of a refusal, or `undefined` when it did not refuse. */
function codeOf(run: () => void): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('磁盘布局原语', () => {
  describe('versionSegment（长路径回退）', () => {
    it('路径够短时就是版本号本身', () => {
      expect(versionSegment('/home/u/.avantf', 'runtime', 'demo-pkg', '1.0.0')).toBe('1.0.0')
      expect(versionSegment('/home/u/.avantf', 'runtime', '@scope/pkg', '1.0.0')).toBe('1.0.0')
    })

    it('超过预算时先试 sha256(name@version) 的前 8 位', () => {
      const home = '/home/u/.avantf'
      const prefix = `${home}/runtime/demo-pkg/`.length
      const version = '1.0.0-beta.1234567890'
      // The version does not fit, but the 8-character segment does.
      expect(versionSegment(home, 'runtime', 'demo-pkg', version, prefix + 10)).toBe(digestOf('demo-pkg', version).slice(0, 8))
    })

    it('8 位仍然超长时取前 12 位', () => {
      const home = '/home/u/.avantf'
      const prefix = `${home}/runtime/demo-pkg/`.length
      const version = '1.0.0-beta.1234567890'
      const segment = versionSegment(home, 'runtime', 'demo-pkg', version, prefix + 4)
      expect(segment).toBe(digestOf('demo-pkg', version).slice(0, 12))
    })

    it('同样的 name@version 得到同样的段，不同版本得到不同的段', () => {
      const first = versionSegment('/home/u/.avantf', 'runtime', 'demo-pkg', '1.0.0', 1)
      const again = versionSegment('/home/u/.avantf', 'runtime', 'demo-pkg', '1.0.0', 1)
      const other = versionSegment('/home/u/.avantf', 'runtime', 'demo-pkg', '1.0.1', 1)
      expect(again).toBe(first)
      expect(other).not.toBe(first)
    })

    it('长 home 下的普通名字也会退到 12 位哈希（Windows 260 字符预算）', () => {
      const longHome = `/home/${'x'.repeat(180)}/.avantf`
      expect(versionSegment(longHome, 'runtime', 'demo-pkg', '1.0.0')).toBe(digestOf('demo-pkg', '1.0.0').slice(0, 12))
    })
  })

  describe('assertSafeRelativeRoot（lint / declare 判据）', () => {
    it('接受 home 下的普通相对路径', () => {
      for (const root of ['tools', 'runtime', 'models', '@scope/tools', 'a/b/c']) {
        expect(() => {
          assertSafeRelativeRoot(root)
        }, root).not.toThrow()
      }
    })

    it('拒绝绝对路径、空路径与跳出 home 的路径', () => {
      for (const root of ['', '/abs', 'C:\\abs', 'C:/abs', '../escape', 'a/../../b', 'a\0b']) {
        expect(codeOf(() => assertSafeRelativeRoot(root)), root).toBe('invalid-option')
      }
    })
  })

  describe('assertSafeRelativePath（provider 落盘判据）', () => {
    it('接受 provider 给出的普通子路径', () => {
      for (const path of ['demo-pkg/1.0.0', 'bin/demo', 'node_modules/@scope/pkg']) {
        expect(() => {
          assertSafeRelativePath(path)
        }, path).not.toThrow()
      }
    })

    it('拒绝绝对路径与含 .. 的路径', () => {
      for (const path of ['', '/abs', 'D:\\abs', '../escape', 'demo/../../escape']) {
        expect(codeOf(() => assertSafeRelativePath(path)), path).toBe('invalid-option')
      }
    })
  })

  describe('isInside（win32 用 path.win32 显式注入；仍需 Windows 实机复核）', () => {
    it('POSIX：普通子路径在内、父路径相等在内、跳出在外', () => {
      expect(isInside('/home/u/.avantf/env', '/home/u/.avantf/env/tools/demo')).toBe(true)
      expect(isInside('/home/u/.avantf/env', '/home/u/.avantf/env')).toBe(true)
      expect(isInside('/home/u/.avantf/env', '/home/u/.avantf/evil')).toBe(false)
      expect(isInside('/home/u/.avantf/env', '/home/u/.avantf')).toBe(false)
    })

    it('win32：跨盘恒不在内——旧代码的 `relative` 返回 `D:\\evil\\x`，不以 `..` 开头即被当作在内', () => {
      // Measured: win32.relative('C:\\avantf\\env','D:\\evil\\x') === 'D:\\evil\\x'.
      expect(isInside('C:\\avantf\\env', 'D:\\evil\\x', win32)).toBe(false)
      expect(isInside('C:\\avantf\\env', 'D:\\evil\\x\\tools', win32)).toBe(false)
    })

    it('win32：同盘正常判定，且 UNC 共享不同即在外', () => {
      expect(isInside('C:\\avantf\\env', 'C:\\avantf\\env\\tools\\demo', win32)).toBe(true)
      expect(isInside('C:\\avantf\\env', 'C:\\avantf\\env', win32)).toBe(true)
      expect(isInside('C:\\avantf\\env', 'C:\\avantf\\evil', win32)).toBe(false)
      // Drive letters and UNC names are case-insensitive.
      expect(isInside('C:\\Avantf\\Env', 'c:\\avantf\\env\\tools', win32)).toBe(true)
      expect(isInside('\\\\srv\\share\\env', '\\\\srv\\share\\env\\tools', win32)).toBe(true)
      expect(isInside('\\\\srv\\share\\env', '\\\\other\\share\\x', win32)).toBe(false)
    })
  })
})
