/**
 * The host Remote face and the wire face must be the SAME set of methods.
 *
 * `src/wire.ts`'s `descriptors` are what the browser half may call: the page's transport builds its
 * requests from them, and the compatibility gate probes the registered face. `src/gateway.ts`'s
 * `@Remote(...)` markers are what the Cordis/Typert gateway actually publishes. Nothing used to make
 * the two agree, and the drift is not hypothetical — the mount smoke's hand-written method list had
 * already lost `resetToPreset`, so "the gateway stopped publishing a declared method" was invisible.
 *
 * `remoteMethods` is the protocol's OWN reader for those markers (the same descriptor the gateway
 * discovers its face from), so this compares two real faces instead of adding a third hand-kept list.
 */
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { IdentityGateway } from '../src/gateway.js'
import { IdentityState, type IdentitySettings } from '../src/state.js'
import { descriptors } from '../src/wire.js'

/** A gateway built on a real Context, exactly the way `apply()` builds it. */
function gateway(): IdentityGateway {
  const ctx = new Context()
  const state = new IdentityState({
    dataHome: '/nonexistent-identity-data-home',
    profile: () => 'web',
    maxBytes: () => 65536,
    version: '0.0.0-test',
  })
  const settings = (): IdentitySettings => ({
    enabled: false,
    interpolate: false,
    replaceScope: 'session',
    drop: [],
    maxBytes: 65536,
    profile: 'web',
    dataHome: '/nonexistent-identity-data-home',
    activePreset: '',
    activeLocale: '',
  })
  return new IdentityGateway(ctx, state, settings, { info: () => undefined, warn: () => undefined, error: () => undefined })
}

describe('the gateway face and the wire face', () => {
  it('publish exactly the same set of Remote methods', () => {
    const marked = remoteMethods(gateway()).map(marker => marker.method)
    const declared = descriptors.map(descriptor => descriptor.method)
    // A vacuous pass would be `[] === []`: assert both sides are populated first.
    expect(marked.length).toBeGreaterThan(0)
    expect(declared.length).toBeGreaterThan(0)
    // Set equality in both directions: a `@Remote` method the wire does not declare is a method the
    // page can never call, and a declared method the gateway does not publish fails at call time.
    expect([...marked].sort()).toEqual([...declared].sort())
    // …and no duplicates, which the set comparison above would collapse silently.
    expect(new Set(marked).size).toBe(marked.length)
    expect(new Set(declared).size).toBe(declared.length)
  })
})
