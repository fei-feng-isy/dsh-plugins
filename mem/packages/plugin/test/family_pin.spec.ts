/**
 * The family's path conventions, pinned ACROSS trees.
 *
 * `AGENTS.md` says the family/data path resolution has two copies — the base kit is the original and
 * `@avantf/mem-contract` keeps its own dependency-free one, because the CLI and the MCP server have
 * no DSH host and never load the base — and that "有一个测试把两份副本钉在一起". That test did not
 * exist, and by the time anyone looked the copies had already drifted on two inputs (a bare `~`, and
 * the order of `$AVANTF_HOME` against a configured `dataHome`), which is the worst kind of drift here:
 * it decides which directory the user's memory, knowledge and prompts live in.
 *
 * This spot is the only one that can see all three: the plugin depends on the base (as a peer) and
 * on the mem engine (inlined at build time), so the pin lives here rather than in either subtree.
 * `mem/packages/core/test/family_paths.spec.ts` keeps pinning the two IN-TREE copies (contract ↔
 * provision); this one closes the cross-tree gap.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as base from '@avantf/dsh-plugin-base'
import * as contract from '@avantf/mem-contract'
import { resolveDataHome as coreResolveDataHome } from '@avantf/mem'

/** Run `body` with `AVANTF_HOME` set to `value` (or removed), restoring what was there. */
function withEnv(value: string | undefined, body: () => void): void {
  const previous = process.env['AVANTF_HOME']
  if (value === undefined) delete process.env['AVANTF_HOME']
  else process.env['AVANTF_HOME'] = value
  try {
    body()
  } finally {
    if (previous === undefined) delete process.env['AVANTF_HOME']
    else process.env['AVANTF_HOME'] = previous
  }
}

describe('the family path copies agree', () => {
  it('expands `~/…` and a BARE `~` identically', () => {
    // The bare form is not a corner case: `AVANTF_HOME=~` is what a shell makes easy to type, and the
    // contract copy used to return it unchanged — a RELATIVE path named `~`, i.e. data written into
    // whatever directory the process happened to start in.
    for (const input of ['~', '~/custom', '/abs/path', 'relative/path', '']) {
      expect(contract.expandHome(input), `expandHome(${JSON.stringify(input)})`).toBe(base.expandHome(input))
    }
    expect(base.expandHome('~')).toBe(homedir())
  })

  it('resolves the family root identically, including blank-is-unset', () => {
    for (const env of [{}, { AVANTF_HOME: '/tmp/fam' }, { AVANTF_HOME: '~/custom' }, { AVANTF_HOME: '   ' }]) {
      expect(contract.familyHome(env), JSON.stringify(env)).toBe(base.familyHome(env))
      expect(contract.familyToolsDir(env), JSON.stringify(env)).toBe(base.familyToolsDir(env))
      expect(contract.familyModelsDir(env), JSON.stringify(env)).toBe(base.familyModelsDir(env))
    }
  })

  it('resolves the DATA root by the same rule: ⑤ explicit → ④ env → ② config → ~/.avantf', () => {
    // The configured value travels in its OWN (third) parameter on the base side, exactly as layer ②
    // travels in the `common` argument on this side. Passing it as `explicit` instead — which the
    // work plugin used to do — promotes layer ② above layer ④, and the same config then resolves to
    // two different directories: `$AVANTF_HOME` silently stops mattering on one side of the family.
    const cases: { readonly configured: string; readonly env: string | undefined; readonly explicit?: string }[] = [
      { configured: '', env: undefined },
      { configured: '', env: '/tmp/from-env' },
      { configured: '/tmp/from-config', env: undefined },
      { configured: '/tmp/from-config', env: '/tmp/from-env' },
      { configured: '~/from-config', env: undefined },
      { configured: '~', env: undefined },
      { configured: '/tmp/from-config', env: '/tmp/from-env', explicit: '/tmp/from-caller' },
    ]
    for (const { configured, env, explicit } of cases) {
      withEnv(env, () => {
        const fromBase = base.resolveDataHome(explicit, { AVANTF_HOME: env }, configured)
        const fromCore = coreResolveDataHome({ dataHome: configured }, explicit)
        expect(fromCore, `configured=${configured} env=${String(env)} explicit=${String(explicit)}`).toBe(fromBase)
      })
    }
    // And the rule itself, spelled out on the case that used to differ: the environment is the
    // deployment override and outranks the config file; an explicit value outranks both.
    withEnv('/tmp/from-env', () => {
      expect(coreResolveDataHome({ dataHome: '/tmp/from-config' })).toBe('/tmp/from-env')
      expect(coreResolveDataHome({ dataHome: '/tmp/from-config' }, '/tmp/from-caller')).toBe('/tmp/from-caller')
      expect(base.resolveDataHome(undefined, { AVANTF_HOME: '/tmp/from-env' }, '/tmp/from-config'))
        .toBe('/tmp/from-env')
    })
  })
})
