import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, familyHome, familyModelsDir, familyToolsDir } from '@avantf/mem-contract'
import { defaultToolsDir, parseToolsConfig, resolveToolsDir } from '@avantf/mem-provision'

/**
 * The managed-directory convention, pinned in one place.
 *
 * The family root is spelled out in THREE places: `base/plugin-base/src/kit/family.ts` is the
 * canonical copy, `@avantf/mem-contract` keeps a dependency-free one (CLI / MCP never load a DSH
 * host), and `@avantf/mem-provision` keeps a third because it runs before/without the base. This spec
 * pins the two copies reachable here — contract ↔ provision — together, and pins the decidable half
 * of a rule that is otherwise invisible until a machine is missing a directory: **the pre-framework
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
    // The provision copy's own `~/` branch (its `expandHome`), which the absolute-path cases above
    // never reach: `AVANTF_HOME=~/x` must resolve under the user home, not to a relative `<cwd>/~/x`.
    expect(defaultToolsDir({ AVANTF_HOME: '~/x' })).toBe(join(homedir(), 'x', 'tools'))
    expect(defaultToolsDir({ AVANTF_HOME: '~/x' })).toBe(familyToolsDir({ AVANTF_HOME: '~/x' }))
    // Blank is "unset", not the filesystem root — the same rule the contract copy pins.
    expect(defaultToolsDir({ AVANTF_HOME: '   ' })).toBe(join(homedir(), '.avantf', 'env', 'tools'))
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
