import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, familyHome, familyModelsDir, familyToolsDir } from '@avantf/mem-contract'
import { defaultToolsDir, parseToolsConfig, resolveToolsDir } from '@avantf/mem-provision'

/**
 * The managed-directory convention, pinned in one place.
 *
 * Two packages spell out the family root: the contract (which everything else may import) and
 * `@avantf/provision` (which is deliberately dependency-free — node builtins only — so it cannot).
 * This spec keeps the two copies from drifting, and pins the decidable half of a rule that is
 * otherwise invisible until a machine is missing a directory: **the pre-framework
 * `~/.avantf/{tools,models}` is not a fallback anywhere**. Its only purpose now would be to keep a
 * compatibility symlink alive, which is exactly what this removed.
 */
describe('the family managed-directory convention', () => {
  it('resolves the family root, honouring $AVANTF_HOME and expanding ~/', () => {
    expect(familyHome({})).toBe(join(homedir(), '.avantf', 'env'))
    expect(familyHome({ AVANTF_HOME: '/tmp/fam' })).toBe('/tmp/fam')
    expect(familyHome({ AVANTF_HOME: '~/custom' })).toBe(join(homedir(), 'custom'))
    // Blank is "unset", not "the filesystem root".
    expect(familyHome({ AVANTF_HOME: '   ' })).toBe(join(homedir(), '.avantf', 'env'))
    expect(familyToolsDir({})).toBe(join(homedir(), '.avantf', 'env', 'tools'))
    expect(familyModelsDir({})).toBe(join(homedir(), '.avantf', 'env', 'models'))
  })

  it('keeps the provision package\'s mirror of the convention in step', () => {
    // Same rule, two implementations: this is the assertion that makes the duplication safe.
    expect(defaultToolsDir({})).toBe(familyToolsDir({}))
    expect(defaultToolsDir({ AVANTF_HOME: '/tmp/fam' })).toBe(familyToolsDir({ AVANTF_HOME: '/tmp/fam' }))
    // The schema default (blank) resolves to the family root; an explicit dir still wins.
    expect(resolveToolsDir(parseToolsConfig(undefined), {})).toBe(familyToolsDir({}))
    expect(resolveToolsDir(parseToolsConfig({ dir: '/tmp/other' }), {})).toBe('/tmp/other')
    expect(resolveToolsDir(parseToolsConfig(undefined), { AVANTF_TOOLS_DIR: '/tmp/hatch' })).toBe('/tmp/hatch')
  })

  it('leaves no pre-framework directory as a built-in default', () => {
    // Blank = "resolve me to the family root" (the loader does that at layer ①). A literal legacy
    // path here is what would make a compatibility symlink load-bearing again.
    expect(defaultConfig.tools.dir).toBe('')
    expect(defaultConfig.semantic.cache_dir).toBe('')
    expect(defaultConfig.rerank.cache_dir).toBe('')
  })
})
