import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, familyHome, familyModelsDir, familyToolsDir } from '@avantf/mem-contract'
import { defaultToolsDir, parseToolsConfig, resolveToolsDir } from '@avantf/mem-provision'
import { loadConfig } from '../src/config/loader.js'

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
  })

  it('pins the WHOLE `tools` default, not only `dir` (mirror / auto_install drift silently)', () => {
    // `parseToolsConfig(undefined)` is the provision package's mirror of the contract's `tools`
    // section, and its own comment says "the config schema defaults to exactly this shape". The old
    // pin covered `dir` only, so a changed mirror list or auto_install would have been invisible —
    // users would simply stop being able to install anything, with no test failing.
    const provisionDefaults = parseToolsConfig(undefined)
    expect(provisionDefaults.mirror).toEqual(defaultConfig.tools.mirror)
    expect(provisionDefaults.auto_install).toBe(defaultConfig.tools.auto_install)
    // Field-by-field above AND the whole object: a NEW field added on either side has to be mirrored.
    expect(provisionDefaults).toEqual(defaultConfig.tools)
  })

  it('pins the `cache_dir` chain: blank → the family models root → the envinit `mem:model` gate', () => {
    // Leg ①: the schema default is blank ("resolve me"), never a literal directory.
    expect(defaultConfig.semantic.cache_dir).toBe('')
    // Leg ②: the loader turns blank into `familyModelsDir()` (layer ① of loadConfig). It is run for
    // real; only the two env escape hatches are neutralised, because the test environment sets one of
    // them (vitest.config.ts points AVANTF_MEM_MODEL_CACHE at a throwaway directory).
    const savedHome = process.env['AVANTF_HOME']
    const savedCache = process.env['AVANTF_MEM_MODEL_CACHE']
    delete process.env['AVANTF_HOME']
    delete process.env['AVANTF_MEM_MODEL_CACHE']
    const dir = mkdtempSync(join(tmpdir(), 'avantf-cache-dir-'))
    try {
      const loaded = loadConfig({ dataHome: dir })
      expect(loaded.common.semantic.cache_dir).toBe(familyModelsDir({}))
    } finally {
      if (savedHome !== undefined) process.env['AVANTF_HOME'] = savedHome
      if (savedCache !== undefined) process.env['AVANTF_MEM_MODEL_CACHE'] = savedCache
      rmSync(dir, { recursive: true, force: true })
    }
    // Leg ③: the plugin declares `mem:model` exactly when the runtime's cache dir IS the framework's
    // models root (`sameDir`). That entry cannot be imported from this package (it is another
    // package of the tree, which the `rootDir` of this tsconfig forbids, and it loads the base), so
    // the linkage is pinned as SOURCE: the gate must compare exactly the two values leg ② resolved.
    // See the delivery report — the executable half lives in the plugin's `test/envinit.spec.ts`.
    const envinit = readFileSync(new URL('../../plugin/src/envinit.ts', import.meta.url), 'utf8')
    expect(envinit).toContain('if (!sameDir(semantic.cache_dir, modelsRoot)) return undefined')
  })
})
