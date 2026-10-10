/**
 * The data-home mirror, pinned against the LINKED base.
 *
 * `paths.ts`'s `resolveDataHomeMirror` is a deliberate copy of `base/plugin-base/src/kit/family.ts`'s
 * `resolveDataHome`, used only when that module cannot be loaded. A copy nobody compares is a copy that
 * drifts, so this spec calls BOTH implementations over a table of inputs and requires the same answer —
 * a real cross-tree pin (the base is the linked workspace/base build, not a mock, which the boundary
 * rules explicitly allow in tests).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDataHome } from '@avantf/dsh-plugin-base'
import { identityRoot, presetLocaleDir, presetsRoot, profileDir, provisionMarker, resolveDataHomeMirror } from '../src/paths.js'

const CASES: readonly { readonly label: string; readonly input: { explicit?: string; env?: Record<string, string | undefined>; configured?: string } }[] = [
  { label: 'nothing configured', input: { env: {} } },
  { label: '$AVANTF_HOME', input: { env: { AVANTF_HOME: '/tmp/av' } } },
  { label: '$AVANTF_HOME blank is not a value', input: { env: { AVANTF_HOME: '   ' } } },
  { label: 'configured only', input: { env: {}, configured: '/tmp/configured' } },
  { label: 'env outranks configured', input: { env: { AVANTF_HOME: '/tmp/env' }, configured: '/tmp/configured' } },
  { label: 'explicit outranks env', input: { explicit: '/tmp/explicit', env: { AVANTF_HOME: '/tmp/env' }, configured: '/tmp/configured' } },
  { label: 'explicit outranks configured', input: { explicit: '/tmp/explicit', env: {}, configured: '/tmp/configured' } },
  { label: '~ expands to the home directory', input: { env: { AVANTF_HOME: '~' } } },
  { label: '~/x expands to <home>/x', input: { env: { AVANTF_HOME: '~/nested' } } },
  { label: 'whitespace is trimmed', input: { env: { AVANTF_HOME: '  /tmp/padded  ' } } },
]

describe('resolveDataHomeMirror', () => {
  it('answers exactly what the linked base answers', () => {
    for (const entry of CASES) {
      expect(resolveDataHomeMirror(entry.input), entry.label).toBe(resolveDataHome(entry.input))
    }
  })

  it('defaults to ~/.avantf like the base', () => {
    expect(resolveDataHomeMirror({ env: {} })).toBe(join(homedir(), '.avantf'))
    expect(resolveDataHomeMirror({ env: {} })).toBe(resolveDataHome({ env: {} }))
  })
})

describe('the identity layout', () => {
  it('names the single identity tree under the data home', () => {
    expect(identityRoot('/data')).toBe('/data/identity')
    expect(profileDir('/data/identity', 'web')).toBe('/data/identity/profiles/web')
    expect(presetsRoot('/data/identity')).toBe('/data/identity/presets')
    expect(presetLocaleDir('/data/identity', 'coder', 'zh')).toBe('/data/identity/presets/coder/zh')
    expect(provisionMarker('/data/identity')).toBe('/data/identity/.provisioned')
  })
})
