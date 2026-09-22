import { describe, expect, it } from 'vitest'
import { ProvisionError } from '../src/errors.js'
import { assertRange, satisfiesRange, selectVersion } from '../src/semver.js'

/**
 * The supported-range subset, line by line. The important half is the second block: anything outside
 * the subset must **throw**, never silently answer `false`.
 */
describe('semver 子集：支持的形式', () => {
  it('三段精确与 = 前缀', () => {
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true)
    expect(satisfiesRange('1.2.3', '=1.2.3')).toBe(true)
    expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false)
  })

  it('部分精确：1.2 = >=1.2.0 <1.3.0，1 = >=1.0.0 <2.0.0', () => {
    expect(satisfiesRange('1.2.9', '1.2')).toBe(true)
    expect(satisfiesRange('1.3.0', '1.2')).toBe(false)
    expect(satisfiesRange('1.9.9', '1')).toBe(true)
    expect(satisfiesRange('2.0.0', '1')).toBe(false)
  })

  it('caret，含 0.x 特例', () => {
    expect(satisfiesRange('1.9.0', '^1.2.3')).toBe(true)
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false)
    expect(satisfiesRange('0.1.9', '^0.1.0')).toBe(true)
    expect(satisfiesRange('0.2.0', '^0.1.0')).toBe(false)
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false)
  })

  it('tilde', () => {
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false)
    expect(satisfiesRange('1.2.0', '~1.2')).toBe(true)
  })

  it('比较符集合，紧邻写', () => {
    expect(satisfiesRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfiesRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false)
    expect(satisfiesRange('1.5.0', '>=1.0.0, <2.0.0')).toBe(true)
  })

  it('部分比较符按 npm 展开：>1.2 = >=1.3.0，<=1.2 = <1.3.0', () => {
    expect(satisfiesRange('1.2.5', '>1.2')).toBe(false)
    expect(satisfiesRange('1.3.0', '>1.2')).toBe(true)
    expect(satisfiesRange('1.2.5', '<=1.2')).toBe(true)
    expect(satisfiesRange('1.3.0', '<=1.2')).toBe(false)
    expect(satisfiesRange('1.9.9', '>1')).toBe(false)
    expect(satisfiesRange('2.0.0', '>1')).toBe(true)
    expect(satisfiesRange('1.9.9', '<=1')).toBe(true)
    expect(satisfiesRange('2.0.0', '<=1')).toBe(false)
    // `>=`/`<` keep npm's plain 0-padding, and three-part comparators are untouched.
    expect(satisfiesRange('1.2.0', '>=1.2')).toBe(true)
    expect(satisfiesRange('1.1.9', '<1.2')).toBe(true)
    expect(satisfiesRange('1.2.5', '>1.2.4')).toBe(true)
    expect(satisfiesRange('1.2.5', '<=1.2.5')).toBe(true)
    expect(satisfiesRange('1.2.5', '<=1.2.4')).toBe(false)
    // A partial with a prerelease keeps it on `>` (npm: `>1.2-beta` → `>=1.3.0-beta`).
    expect(satisfiesRange('1.3.0', '>1.2-beta')).toBe(true)
    expect(satisfiesRange('1.2.9', '>1.2-beta')).toBe(false)
  })

  it('备选，无空备选', () => {
    expect(satisfiesRange('1.0.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfiesRange('2.1.0', '^1.0.0 || ^2.0.0')).toBe(true)
    expect(satisfiesRange('3.0.0', '^1.0.0 || ^2.0.0')).toBe(false)
  })

  it('`v` 前缀容错', () => {
    expect(satisfiesRange('1.2.3', 'v1.2.3')).toBe(true)
  })

  it('预发布只在比较符同级带预发布时匹配', () => {
    expect(satisfiesRange('1.0.0-rc.1', '>=1.0.0-rc.0 <1.0.0')).toBe(true)
    expect(satisfiesRange('1.0.0-rc.1', '>=1.0.0 <2.0.0')).toBe(false)
  })
})

describe('semver 子集：必须报错而不是静默 false', () => {
  const rejected = [
    '>= 1.0.0',
    '1.2.x',
    '1.x',
    '1.2.3 - 2.0.0',
    'latest',
    'next',
    'npm:foo@1',
    'workspace:*',
    'file:../x',
    'link:../x',
    'git+https://example.test/x.git',
    '^0.1.0 ||',
    '',
  ]
  for (const range of rejected) {
    it(`拒绝 ${JSON.stringify(range)}`, () => {
      expect(() => assertRange(range)).toThrow(ProvisionError)
      try {
        assertRange(range)
      } catch (error) {
        expect((error as ProvisionError).code).toBe('invalid-option')
      }
    })
  }

  it('匹配器 `*` 仍然可用（供内部与离线配置）', () => {
    expect(() => assertRange('*')).not.toThrow()
    expect(satisfiesRange('9.9.9', '*')).toBe(true)
  })
})

describe('selectVersion', () => {
  it('取满足区间的最高版本，忽略非法版本', () => {
    expect(selectVersion(['1.0.0', '1.1.0', '2.0.0', 'not-a-version'], '^1.0.0')).toBe('1.1.0')
  })

  it('没有满足的版本时返回 undefined', () => {
    expect(selectVersion(['1.0.0'], '^2.0.0')).toBeUndefined()
  })
})
