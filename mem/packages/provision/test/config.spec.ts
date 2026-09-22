/**
 * The `tools` section: defaults, environment override, and rejection of a hand-written mistake.
 *
 * These matter because the values decide where a 35 MB download lands and which hosts are contacted;
 * a typo'd `mirror` (a bare string) or `auto_install` (the string `"false"`) must fail loudly here
 * rather than reaching the installer as a surprise.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_MIRRORS, DEFAULT_TOOLS_CONFIG, defaultToolsDir, mirrorUrl, parseToolsConfig, resolveToolsDir } from '../src/index.js'

describe('parseToolsConfig', () => {
  it('returns the domestic-mirror defaults when the section is absent', () => {
    const parsed = parseToolsConfig(undefined)
    expect(parsed).toEqual(DEFAULT_TOOLS_CONFIG)
    expect(parsed.auto_install).toBe(true)
    // Empty = "resolve me to the family root" (`defaultToolsDir()`), never the pre-framework path.
    expect(parsed.dir).toBe('')
    expect(defaultToolsDir({})).toBe(join(homedir(), '.avantf', 'env', 'tools'))
    expect(parsed.mirror).toEqual([...DEFAULT_MIRRORS])
    // The first candidate is a domestic proxy, not the official source: the official source is
    // appended LAST by `sourceUrls`, never configured as the primary.
    expect(parsed.mirror[0]).toContain('ghfast.top')
  })

  it('keeps an explicit mirror list, including an empty one', () => {
    expect(parseToolsConfig({ mirror: [] }).mirror).toEqual([])
    expect(parseToolsConfig({ mirror: ['https://mirror.example/{url}'] }).mirror).toEqual(['https://mirror.example/{url}'])
  })

  it('rejects a mistyped section instead of coercing it', () => {
    expect(() => parseToolsConfig({ mirror: 'https://x/{url}' })).toThrow(/字符串数组/)
    expect(() => parseToolsConfig({ mirror: [1] })).toThrow(/字符串数组/)
    expect(() => parseToolsConfig({ auto_install: 'false' })).toThrow(/布尔值/)
    expect(() => parseToolsConfig({ dir: 5 })).toThrow(/字符串/)
    expect(() => parseToolsConfig('tools')).toThrow(/对象/)
  })
})

describe('resolveToolsDir', () => {
  it('prefers the environment, then the config, then the default', () => {
    expect(resolveToolsDir(DEFAULT_TOOLS_CONFIG, { AVANTF_TOOLS_DIR: '/tmp/env-tools' })).toBe('/tmp/env-tools')
    expect(resolveToolsDir({ ...DEFAULT_TOOLS_CONFIG, dir: '/tmp/conf-tools' }, {})).toBe('/tmp/conf-tools')
    expect(resolveToolsDir({ ...DEFAULT_TOOLS_CONFIG, dir: '' }, {})).toBe(defaultToolsDir({}))
    expect(resolveToolsDir({ ...DEFAULT_TOOLS_CONFIG, dir: '' }, { AVANTF_HOME: '/tmp/fam' })).toBe('/tmp/fam/tools')
  })

  it('expands a ~ path against the user home', () => {
    expect(resolveToolsDir({ ...DEFAULT_TOOLS_CONFIG, dir: '~/x/tools' }, {})).toBe(join(homedir(), 'x', 'tools'))
  })
})

describe('mirrorUrl', () => {
  it('substitutes the whole url and the bare file name', () => {
    const original = 'https://github.com/jgm/pandoc/releases/download/3.11/pandoc-3.11-linux-amd64.tar.gz'
    expect(mirrorUrl('https://ghfast.top/{url}', original)).toBe(`https://ghfast.top/${original}`)
    expect(mirrorUrl('https://mirror.example/{file}', original)).toBe('https://mirror.example/pandoc-3.11-linux-amd64.tar.gz')
  })
})
