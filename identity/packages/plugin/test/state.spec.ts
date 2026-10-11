/**
 * `IdentityState.ensureProfile` — the seam the settings page's "enable" action reaches through the
 * gateway. `presets.spec.ts` pins the file semantics; what only this level shows is that the state's own
 * path resolution (data home → profile → the three files) ends up somewhere the page can read: the
 * profile is read while empty, and the SAME state must then answer with the seeded text.
 *
 * (The read cache is deliberately not the claim under test: `IdentityDocuments.read` only caches files it
 * read successfully, and the seed only writes where there was nothing to read — so no stale hit is
 * possible here. `ensureProfile` still invalidates because every write in that module does; the ablation
 * that removes it leaves these cases green, which is why this comment says so rather than claiming a
 * cache bug it does not catch.)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import type { StatusView } from '../src/client/api.js'
import { materializePresets } from '../src/presets.js'
import { IdentityState } from '../src/state.js'
import { statusResultSchema } from '../src/wire.js'

let dataHome: string
let root: string
let assets: string

beforeEach(() => {
  dataHome = mkdtempSync(join(tmpdir(), 'avantf-identity-state-'))
  root = join(dataHome, 'identity')
  assets = mkdtempSync(join(tmpdir(), 'avantf-identity-state-assets-'))
  for (const id of ['assistant', 'coder']) {
    for (const locale of ['zh', 'en']) {
      mkdirSync(join(assets, id, locale), { recursive: true })
      writeFileSync(join(assets, id, locale, 'IDENTITY.md'), `${id}/${locale} identity\n`)
      writeFileSync(join(assets, id, locale, 'SOUL.md'), `${id}/${locale} soul\n`)
      writeFileSync(join(assets, id, locale, 'RULES.md'), `${id}/${locale} rules\n`)
    }
  }
})

afterEach(() => {
  rmSync(dataHome, { recursive: true, force: true })
  rmSync(assets, { recursive: true, force: true })
})

/** The state under the profile this page runs in. */
function state(): IdentityState {
  return new IdentityState({
    dataHome,
    profile: () => 'web',
    maxBytes: () => 65536,
    version: '0.0.0-test',
  })
}

describe('IdentityState.ensureProfile', () => {
  it('seeds the profile, and the already-warmed reader serves the new text', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    const identity = state()

    // Warm the reader exactly like the page's first mount read does: an empty profile.
    expect(identity.readProfile().files.map((file) => file.text)).toEqual(['', '', ''])

    const seed = identity.ensureProfile('zh')
    expect(seed).toMatchObject({ seeded: true, preset: 'assistant', resolvedLocale: 'zh' })

    // The same reader instance must now answer with the seeded text (no stale cache).
    expect(identity.readProfile().files.map((file) => file.text)).toEqual([
      'assistant/zh identity\n',
      'assistant/zh soul\n',
      'assistant/zh rules\n',
    ])
    expect(identity.documents.status().every((file) => file.present)).toBe(true)
  })

  it('leaves a profile that already has an identity untouched', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'MINE\n')
    const identity = state()

    expect(identity.ensureProfile('zh')).toMatchObject({ seeded: false, written: [] })
    expect(readFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'utf8')).toBe('MINE\n')
    expect(identity.readProfile().files.find((file) => file.name === 'SOUL')?.text).toBe('MINE\n')
  })

  it('answers an error instead of throwing when the data root is unusable', () => {
    // `<data home>/identity` cannot exist: its parent is a regular file.
    const blocked = join(dataHome, 'blocked')
    writeFileSync(blocked, 'not a directory\n')
    const identity = new IdentityState({
      dataHome: join(blocked, 'nested'),
      profile: () => 'web',
      maxBytes: () => 65536,
      version: '0.0.0-test',
    })
    const seed = identity.ensureProfile('zh')
    expect(seed.seeded).toBe(false)
    expect(seed.error).toBeTypeOf('string')
  })
})

/**
 * Switching identities must be REVERSIBLE: the text you wrote for an identity comes back when you
 * return to it, instead of the preset library's factory text.
 */
describe('IdentityState switching keeps your own version of an identity', () => {
  it('comes back to what you wrote, not to the library text', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    const identity = state()
    identity.ensureProfile('zh') // seeded from `assistant`
    identity.writeProfileFile('IDENTITY', 'MY identity\n')

    // Leave `assistant` for `coder`: the state must file the edited text away under `assistant`.
    const away = identity.applyPreset('coder', 'zh', 'assistant')
    expect(away).toMatchObject({ ok: true })
    expect(identity.readProfile().files.find((file) => file.name === 'IDENTITY')?.text).toBe('coder/zh identity\n')

    // Come back: the profile's own version wins over the library's `assistant` text.
    const back = identity.applyPreset('assistant', 'zh', 'coder')
    expect(back).toMatchObject({ ok: true, restoredEdit: true })
    expect(identity.readProfile().files.find((file) => file.name === 'IDENTITY')?.text).toBe('MY identity\n')
    expect(identity.hasLocalEdit('assistant', 'zh')).toBe(true)
  })

  it('refuses to leave an identity that no preset owns, instead of destroying it', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    const identity = state()
    identity.writeProfileFile('IDENTITY', 'HAND WRITTEN\n')

    const result = identity.applyPreset('coder', 'zh', '')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('save as preset')
    expect(identity.readProfile().files.find((file) => file.name === 'IDENTITY')?.text).toBe('HAND WRITTEN\n')
  })

  it('restores the preset text on request and forgets the local version', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    const identity = state()
    identity.ensureProfile('zh')
    identity.writeProfileFile('IDENTITY', 'MY identity\n')
    identity.applyPreset('coder', 'zh', 'assistant') // files the edit away
    identity.applyPreset('assistant', 'zh', 'coder') // restores it
    expect(identity.hasLocalEdit('assistant', 'zh')).toBe(true)

    const reset = identity.resetToPreset('assistant', 'zh')
    expect(reset).toMatchObject({ ok: true, dropped: true })
    expect(identity.readProfile().files.find((file) => file.name === 'IDENTITY')?.text).toBe('assistant/zh identity\n')
    expect(identity.hasLocalEdit('assistant', 'zh')).toBe(false)
  })

  it('deleting a preset takes this profile’s version of it too', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    const identity = state()
    identity.ensureProfile('zh')
    identity.writeProfileFile('IDENTITY', 'MY identity\n')
    identity.applyPreset('coder', 'zh', 'assistant')
    expect(existsSync(join(root, 'profiles', 'web', '.edits', 'assistant'))).toBe(true)

    expect(identity.deletePreset('assistant')).toMatchObject({ ok: true })
    expect(existsSync(join(root, 'profiles', 'web', '.edits', 'assistant'))).toBe(false)
  })

  it('reports hasLocalEdit=false for a seeded identity nobody has touched', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    const identity = state()
    identity.ensureProfile('zh')
    expect(identity.hasLocalEdit('assistant', 'zh')).toBe(false)
  })
})

describe('IdentityState.status', () => {
  it('reports the three effective files with their paths, and the local-version flag', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    const identity = state()
    identity.ensureProfile('zh') // seeded from `assistant`: present, and NOT a local version

    const view = identity.status(
      {
        enabled: true,
        interpolate: false,
        replaceScope: 'session',
        drop: [],
        maxBytes: 65536,
        profile: 'web',
        dataHome,
        activePreset: 'assistant',
        activeLocale: 'zh',
      },
      { locale: 'zh', source: 'client' },
    )

    expect(view.files.map((file) => [file.name, file.file, file.present])).toEqual([
      ['IDENTITY', 'IDENTITY.md', true],
      ['SOUL', 'SOUL.md', true],
      ['RULES', 'RULES.md', true],
    ])
    // The `path` row is what the settings page reports as the file's location (the status view is built
    // from the same read that feeds the editors, so a dropped field here would be invisible).
    expect(view.files.every((file) => file.path === join(root, 'profiles', 'web', file.file))).toBe(true)
    expect(view.fileCount).toBe(3)
    expect(view.totalBytes).toBeGreaterThan(0)
    expect(view.hasLocalEdit).toBe(false)

    identity.writeProfileFile('SOUL', 'MINE\n')
    expect(identity.status(
      { enabled: true, interpolate: false, replaceScope: 'session', drop: [], maxBytes: 65536, profile: 'web', dataHome, activePreset: 'assistant', activeLocale: 'zh' },
      { locale: 'zh', source: 'client' },
    ).hasLocalEdit).toBe(true)
  })
})

/** True only when every key of `A` is also a key of `B` — a typo'd or stale field makes this `false`
 *  at the assignment below, i.e. a COMPILE error, not a silently passing runtime comparison. */
type IsSubset<A extends string, B extends string> = [Exclude<A, B>] extends [never] ? true : false

/**
 * The `status` view is stated THREE times: `IdentityStatusView` (the producer's type), `statusResultSchema`
 * (the wire face the host projects and whose strict codec shapes the payload) and `StatusView` (the
 * browser half's type, a pure type and therefore invisible at runtime). Nothing used to make them agree,
 * and the failure is silent by design — a `strict` codec DROPS a field the schema does not name, so a
 * page field missing from the wire arrives as `undefined` instead of failing. This pins the sets.
 */
describe('IdentityState.status is the same set as the wire schema', () => {
  it('produces exactly the keys statusResultSchema declares, and covers the page’s type', () => {
    const shape = (statusResultSchema as unknown as { def: { shape: Record<string, unknown> } }).def.shape
    const view = state().status(
      {
        enabled: true,
        interpolate: false,
        replaceScope: 'session',
        drop: [],
        maxBytes: 65536,
        profile: 'web',
        dataHome,
        activePreset: '',
        activeLocale: '',
      },
      { locale: 'zh', source: 'client' },
    )
    // The producer and the wire, key for key (both directions): a field the schema names but `status()`
    // does not emit reaches the page as `undefined`; a field `status()` emits but the schema does not
    // name is dropped by the codec before it ever leaves the host.
    expect(Object.keys(view).sort()).toEqual(Object.keys(shape).sort())
    // The browser half's type must stay a SUBSET of the wire face, checked by the compiler: if
    // `StatusView` gains a field the schema does not declare, `clientWithinWire` is typed `false` and
    // this file stops compiling — which is the cheapest place to catch a page/wire drift.
    const clientWithinWire: IsSubset<keyof StatusView, keyof z.infer<typeof statusResultSchema>> = true
    expect(clientWithinWire).toBe(true)
  })
})
