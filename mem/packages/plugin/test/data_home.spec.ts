/**
 * The plugin's data root, pinned at the point where the plugin USES the family rule.
 *
 * `mem/packages/plugin/test/family_pin.spec.ts` already pins the resolvers against each other; what
 * this spec pins is the layer the PLUGIN hands its own `config.dataHome` to. It used to hand it to the
 * engine's explicit slot, which made the profile's value outrank `$AVANTF_HOME` here while the work
 * plugin let the environment outrank it — so with both set, the two halves read DIFFERENT `<data
 * home>/prompts` directories, and the prompt file a user edited was read by one plugin only.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configDataHome } from '../src/data_home.js'

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

describe('the profile dataHome is a configured value (layer ②)', () => {
  it('lets $AVANTF_HOME (④) outrank it — the same answer the work plugin gives', () => {
    withEnv('/tmp/from-env', () => {
      expect(configDataHome('/tmp/from-config')).toBe('/tmp/from-env')
      expect(configDataHome(undefined)).toBe('/tmp/from-env')
      expect(configDataHome('~/from-config')).toBe('/tmp/from-env')
    })
  })

  it('uses the configured value when the environment is unset, and expands `~`', () => {
    withEnv(undefined, () => {
      expect(configDataHome('/tmp/from-config')).toBe('/tmp/from-config')
      expect(configDataHome('~/custom')).toBe(join(homedir(), 'custom'))
      expect(configDataHome('')).toBe(join(homedir(), '.avantf'))
      expect(configDataHome(undefined)).toBe(join(homedir(), '.avantf'))
    })
  })
})
