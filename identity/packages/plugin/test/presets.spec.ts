/**
 * The preset library: missing-only release, locale fallback, the four write actions, and the
 * "environment failure is a WARN, never a throw" rule.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PRESET_ID,
  applyPresetToProfile,
  applyProfileEditToProfile,
  deletePreset,
  dropProfileEdit,
  isValidPresetId,
  listPresets,
  materializePresets,
  profileDiffersFromPreset,
  readPreset,
  readProfileEdit,
  readReleasedPresets,
  saveProfileAsPreset,
  seedProfileIfEmpty,
  snapshotProfileEdit,
  writePresetFile,
} from '../src/presets.js'
import { provisionMarker } from '../src/paths.js'

let root: string
let assets: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'avantf-identity-presets-'))
  assets = mkdtempSync(join(tmpdir(), 'avantf-identity-assets-'))
  for (const id of ['coder', 'assistant']) {
    for (const locale of ['zh', 'en']) {
      mkdirSync(join(assets, id, locale), { recursive: true })
      writeFileSync(join(assets, id, locale, 'IDENTITY.md'), `${id}/${locale} identity\n`)
      writeFileSync(join(assets, id, locale, 'SOUL.md'), `${id}/${locale} soul\n`)
      writeFileSync(join(assets, id, locale, 'RULES.md'), `${id}/${locale} rules\n`)
    }
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(assets, { recursive: true, force: true })
})

describe('preset ids', () => {
  it('accepts kebab-case ids and refuses anything path-like', () => {
    expect(isValidPresetId('coder')).toBe(true)
    expect(isValidPresetId('my-preset-2')).toBe(true)
    expect(isValidPresetId('Coder')).toBe(false)
    expect(isValidPresetId('../escape')).toBe(false)
    expect(isValidPresetId('a/b')).toBe(false)
    expect(isValidPresetId('')).toBe(false)
  })
})

describe('materializePresets', () => {
  it('releases every built-in preset and records the release', () => {
    const result = materializePresets({ assetsDir: assets, root, version: '1.2.3' })
    expect([...result.copied].sort()).toEqual(['assistant', 'coder'])
    expect(existsSync(join(root, 'presets', 'coder', 'zh', 'SOUL.md'))).toBe(true)
    expect(readReleasedPresets(provisionMarker(root))?.sort()).toEqual(['assistant', 'coder'])
    expect(JSON.parse(readFileSync(provisionMarker(root), 'utf8')).version).toBe('1.2.3')
  })

  it('NEVER overwrites a file the user has edited', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    const edited = join(root, 'presets', 'coder', 'zh', 'SOUL.md')
    writeFileSync(edited, 'USER TEXT\n')
    materializePresets({ assetsDir: assets, root, version: '1.0.1' })
    expect(readFileSync(edited, 'utf8')).toBe('USER TEXT\n')
  })

  it('does NOT resurrect a preset the user deleted', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    deletePreset(root, 'coder')
    expect(existsSync(join(root, 'presets', 'coder'))).toBe(false)
    const again = materializePresets({ assetsDir: assets, root, version: '1.0.1' })
    expect(again.copied).toEqual([])
    expect(existsSync(join(root, 'presets', 'coder'))).toBe(false)
  })

  it('reads a missing marker as "first run" and an unreadable one as "unknown", never as "empty"', () => {
    // The two are NOT the same fact. No marker at all is the genuine first run (release everything);
    // a marker that exists but cannot be used means the ids a previous release put down are unknown,
    // and the caller must be conservative rather than copy over the user's deletions.
    expect(readReleasedPresets(provisionMarker(root))).toEqual([])
    writeFileSync(provisionMarker(root), 'not json at all\n', 'utf8')
    expect(readReleasedPresets(provisionMarker(root))).toBeUndefined()
    writeFileSync(provisionMarker(root), JSON.stringify({ version: '1.0.0' }), 'utf8')
    expect(readReleasedPresets(provisionMarker(root))).toBeUndefined()
  })

  it('does NOT resurrect a deleted preset when the marker is unreadable', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    deletePreset(root, 'coder')
    writeFileSync(provisionMarker(root), '{ not json\n', 'utf8')
    const again = materializePresets({ assetsDir: assets, root, version: '1.0.1' })
    expect(again.copied).toEqual([])
    expect(existsSync(join(root, 'presets', 'coder'))).toBe(false)
    // The rewrite records the packaged set, so the corruption does not freeze the library forever: a
    // preset the package GAINS in a later release is still released, while none of these can come back.
    expect(readReleasedPresets(provisionMarker(root))?.sort()).toEqual(['assistant', 'coder'])
    mkdirSync(join(assets, 'analyst', 'en'), { recursive: true })
    writeFileSync(join(assets, 'analyst', 'en', 'IDENTITY.md'), 'analyst/en identity\n')
    expect(materializePresets({ assetsDir: assets, root, version: '1.1.0' }).copied).toEqual(['analyst'])
  })

  it('DOES release a preset the package gained after a previous release', () => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    mkdirSync(join(assets, 'analyst', 'en'), { recursive: true })
    writeFileSync(join(assets, 'analyst', 'en', 'IDENTITY.md'), 'analyst/en identity\n')
    const again = materializePresets({ assetsDir: assets, root, version: '1.1.0' })
    expect(again.copied).toEqual(['analyst'])
  })

  it('fills only the MISSING files of a partially-existing preset on the first release', () => {
    // A directory that already exists (created by hand, or half-populated) is descended into: the
    // files that are there are kept, the ones that are not are added.
    const partial = join(root, 'presets', 'coder', 'zh')
    mkdirSync(partial, { recursive: true })
    writeFileSync(join(partial, 'SOUL.md'), 'MY OWN SOUL\n')
    const result = materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    expect(result.copied).toEqual(['assistant', 'coder'])
    expect(readFileSync(join(partial, 'SOUL.md'), 'utf8')).toBe('MY OWN SOUL\n')
    expect(readFileSync(join(partial, 'IDENTITY.md'), 'utf8')).toBe('coder/zh identity\n')
    expect(existsSync(join(root, 'presets', 'coder', 'en', 'RULES.md'))).toBe(true)
  })

  it('WARNs and returns instead of throwing when the data directory cannot be created', () => {
    const warnings: string[] = []
    // A path whose parent is a FILE cannot be a directory: mkdir -p fails with ENOTDIR.
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'not a directory\n')
    const result = materializePresets({
      assetsDir: assets,
      root: join(blocked, 'identity'),
      version: '1.0.0',
      logger: { info: () => undefined, warn: (message) => { warnings.push(message) }, error: () => undefined },
    })
    expect(result.copied).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('failed')
  })
})

describe('reading presets', () => {
  beforeEach(() => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
  })

  it('lists the presets and their locales', () => {
    expect(listPresets(root).map((preset) => [preset.id, preset.locales])).toEqual([
      ['assistant', ['en', 'zh']],
      ['coder', ['en', 'zh']],
    ])
  })

  it('reads the requested locale', () => {
    const preset = readPreset(root, 'coder', 'zh')
    expect(preset?.resolvedLocale).toBe('zh')
    expect(preset?.fellBack).toBe(false)
    expect(preset?.files.find((file) => file.name === 'SOUL')?.text).toBe('coder/zh soul\n')
  })

  it('falls back to English and says so', () => {
    rmSync(join(root, 'presets', 'coder', 'zh'), { recursive: true, force: true })
    const preset = readPreset(root, 'coder', 'zh')
    expect(preset?.resolvedLocale).toBe('en')
    expect(preset?.fellBack).toBe(true)
    expect(preset?.requestedLocale).toBe('zh')
  })

  it('returns undefined when neither locale exists', () => {
    expect(readPreset(root, 'coder', 'fr')).toBeDefined()
    expect(readPreset(root, 'nope', 'zh')).toBeUndefined()
    expect(readPreset(root, '../escape', 'zh')).toBeUndefined()
  })
})

describe('the four write actions', () => {
  beforeEach(() => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'web', 'IDENTITY.md'), 'profile identity\n')
    writeFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'profile soul\n')
  })

  it('apply overwrites the effective identity with the resolved locale', () => {
    const applied = applyPresetToProfile({ root, profile: 'web', id: 'coder', locale: 'zh' })
    expect(applied?.resolvedLocale).toBe('zh')
    expect(readFileSync(join(root, 'profiles', 'web', 'IDENTITY.md'), 'utf8')).toBe('coder/zh identity\n')
    expect(readFileSync(join(root, 'profiles', 'web', 'RULES.md'), 'utf8')).toBe('coder/zh rules\n')
  })

  it('apply falls back to English when the locale is missing', () => {
    rmSync(join(root, 'presets', 'coder', 'zh'), { recursive: true, force: true })
    const applied = applyPresetToProfile({ root, profile: 'web', id: 'coder', locale: 'zh' })
    expect(applied?.resolvedLocale).toBe('en')
    expect(applied?.fellBack).toBe(true)
  })

  it('apply leaves a file the preset does not carry as it was', () => {
    writeFileSync(join(root, 'profiles', 'web', 'RULES.md'), 'profile rules\n')
    rmSync(join(root, 'presets', 'coder', 'zh', 'RULES.md'))
    const applied = applyPresetToProfile({ root, profile: 'web', id: 'coder', locale: 'zh' })
    expect(applied?.missing).toEqual(['RULES.md'])
    expect(readFileSync(join(root, 'profiles', 'web', 'RULES.md'), 'utf8')).toBe('profile rules\n')
  })

  it('editing a preset never touches the effective identity', () => {
    writePresetFile(root, 'coder', 'zh', 'SOUL', 'edited preset soul\n')
    expect(readFileSync(join(root, 'presets', 'coder', 'zh', 'SOUL.md'), 'utf8')).toBe('edited preset soul\n')
    expect(readFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'utf8')).toBe('profile soul\n')
  })

  it('save-as refuses an id that already exists', () => {
    expect(saveProfileAsPreset({ root, profile: 'web', id: 'coder', locale: 'zh' })).toBeUndefined()
  })

  it('save-as writes the non-empty profile files under the new id', () => {
    const saved = saveProfileAsPreset({ root, profile: 'web', id: 'mine', locale: 'zh' })
    expect(saved?.written).toEqual(['IDENTITY.md', 'SOUL.md'])
    expect(readFileSync(join(root, 'presets', 'mine', 'zh', 'SOUL.md'), 'utf8')).toBe('profile soul\n')
  })

  it('a save-as with nothing to save leaves no preset directory behind', () => {
    // A blank profile must not leave an empty id in the library: the next save-as under that id would be
    // refused as "already exists", and the user's retry (after writing something) would be stuck.
    for (const name of ['IDENTITY', 'SOUL', 'RULES']) writeFileSync(join(root, 'profiles', 'web', `${name}.md`), '  \n')
    expect(saveProfileAsPreset({ root, profile: 'web', id: 'empty', locale: 'zh' })?.written).toEqual([])
    expect(existsSync(join(root, 'presets', 'empty'))).toBe(false)
    writeFileSync(join(root, 'profiles', 'web', 'IDENTITY.md'), 'now there is text\n')
    expect(saveProfileAsPreset({ root, profile: 'web', id: 'empty', locale: 'zh' })?.written).toEqual(['IDENTITY.md'])
  })

  it('delete removes the preset directory', () => {
    expect(deletePreset(root, 'coder')).toBe(true)
    expect(existsSync(join(root, 'presets', 'coder'))).toBe(false)
    expect(deletePreset(root, 'coder')).toBe(false)
    expect(deletePreset(root, '../escape')).toBe(false)
  })
})

/**
 * The switch's first enable: the first run releases the preset LIBRARY only, so a profile that was never
 * given files had nothing to turn on — enabling it left the prompt native and the three editors empty.
 */
describe('seeding a profile that has no identity', () => {
  beforeEach(() => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
  })

  it('writes the default preset into the profile when it has no files at all', () => {
    const seed = seedProfileIfEmpty({ root, profile: 'web', locale: 'zh' })
    expect(seed).toMatchObject({ seeded: true, preset: DEFAULT_PRESET_ID, resolvedLocale: 'zh', fellBack: false })
    expect(readFileSync(join(root, 'profiles', 'web', 'IDENTITY.md'), 'utf8')).toBe(`${DEFAULT_PRESET_ID}/zh identity\n`)
    expect(readFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'utf8')).toBe(`${DEFAULT_PRESET_ID}/zh soul\n`)
    expect(readFileSync(join(root, 'profiles', 'web', 'RULES.md'), 'utf8')).toBe(`${DEFAULT_PRESET_ID}/zh rules\n`)
  })

  it('NEVER overwrites an identity the profile already has', () => {
    mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'web', 'IDENTITY.md'), 'MINE\n')
    const seed = seedProfileIfEmpty({ root, profile: 'web', locale: 'zh' })
    expect(seed).toMatchObject({ seeded: false, written: [] })
    expect(readFileSync(join(root, 'profiles', 'web', 'IDENTITY.md'), 'utf8')).toBe('MINE\n')
    // The other two files are NOT filled in either: one non-empty file means the user has an identity.
    expect(existsSync(join(root, 'profiles', 'web', 'SOUL.md'))).toBe(false)
  })

  it('treats files that exist but are blank as "no identity", exactly like the prompt assembly does', () => {
    mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'web', 'IDENTITY.md'), '   \n')
    const seed = seedProfileIfEmpty({ root, profile: 'web', locale: 'zh' })
    expect(seed.seeded).toBe(true)
    expect(readFileSync(join(root, 'profiles', 'web', 'IDENTITY.md'), 'utf8')).toBe(`${DEFAULT_PRESET_ID}/zh identity\n`)
  })

  it('stands in with the first preset still in the library when the default was deleted', () => {
    deletePreset(root, DEFAULT_PRESET_ID)
    const seed = seedProfileIfEmpty({ root, profile: 'web', locale: 'zh' })
    expect(seed).toMatchObject({ seeded: true, preset: 'coder' })
    expect(readFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'utf8')).toBe('coder/zh soul\n')
  })

  it('reports an empty library instead of inventing an identity', () => {
    rmSync(join(root, 'presets'), { recursive: true, force: true })
    const seed = seedProfileIfEmpty({ root, profile: 'web', locale: 'zh' })
    expect(seed.seeded).toBe(false)
    expect(seed.error).toContain('no preset is available')
    expect(existsSync(join(root, 'profiles', 'web'))).toBe(false)
  })
})

/**
 * A profile's OWN version of an identity (`.edits/<id>/`).
 *
 * This is what makes "switch away and come back" restore the user's text instead of the library's: the
 * effective identity is a single flat set, so leaving an identity has to file that set away somewhere
 * before the next one overwrites it.
 */
describe("a profile's own version of an identity", () => {
  beforeEach(() => {
    materializePresets({ assetsDir: assets, root, version: '1.0.0' })
    mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'web', 'IDENTITY.md'), 'MINE identity\n')
    writeFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'MINE soul\n')
    writeFileSync(join(root, 'profiles', 'web', 'RULES.md'), 'MINE rules\n')
  })

  it('files the effective identity away under the identity being left', () => {
    const snapshot = snapshotProfileEdit({ root, profile: 'web', id: 'assistant' })
    expect(snapshot?.written).toEqual(['IDENTITY.md', 'SOUL.md', 'RULES.md'])
    expect(readFileSync(join(root, 'profiles', 'web', '.edits', 'assistant', 'SOUL.md'), 'utf8')).toBe('MINE soul\n')
    // Filing away does not disturb the effective files themselves.
    expect(readFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'utf8')).toBe('MINE soul\n')
  })

  it('files nothing away for a blank effective identity', () => {
    for (const name of ['IDENTITY', 'SOUL', 'RULES']) writeFileSync(join(root, 'profiles', 'web', `${name}.md`), '  \n')
    expect(snapshotProfileEdit({ root, profile: 'web', id: 'assistant' })?.written).toEqual([])
    expect(existsSync(join(root, 'profiles', 'web', '.edits', 'assistant'))).toBe(false)
  })

  it("restores the profile's version over whatever the library now says", () => {
    snapshotProfileEdit({ root, profile: 'web', id: 'assistant' })
    writeFileSync(join(root, 'presets', 'assistant', 'zh', 'SOUL.md'), 'LIBRARY soul\n')
    const restored = applyProfileEditToProfile({ root, profile: 'web', id: 'assistant' })
    expect(restored?.written).toEqual(['IDENTITY.md', 'SOUL.md', 'RULES.md'])
    expect(readFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'utf8')).toBe('MINE soul\n')
  })

  it('has nothing to read or apply when this profile never had a version', () => {
    expect(readProfileEdit({ root, profile: 'web', id: 'coder' })).toBeUndefined()
    expect(applyProfileEditToProfile({ root, profile: 'web', id: 'coder' })).toBeUndefined()
  })

  it('drops it on request, so the library text applies again', () => {
    snapshotProfileEdit({ root, profile: 'web', id: 'assistant' })
    expect(dropProfileEdit({ root, profile: 'web', id: 'assistant' })).toBe(true)
    expect(dropProfileEdit({ root, profile: 'web', id: 'assistant' })).toBe(false)
    const applied = applyPresetToProfile({ root, profile: 'web', id: 'assistant', locale: 'zh' })
    expect(applied?.written).toEqual(['IDENTITY.md', 'SOUL.md', 'RULES.md'])
    expect(readFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'utf8')).toBe('assistant/zh soul\n')
  })

  it('refuses path-like ids on every entry point', () => {
    expect(snapshotProfileEdit({ root, profile: 'web', id: '../escape' })).toBeUndefined()
    expect(readProfileEdit({ root, profile: 'web', id: '../escape' })).toBeUndefined()
    expect(applyProfileEditToProfile({ root, profile: 'web', id: '../escape' })).toBeUndefined()
    expect(dropProfileEdit({ root, profile: 'web', id: '../escape' })).toBe(false)
  })

  it('says whether the effective identity differs from the preset it is on', () => {
    expect(profileDiffersFromPreset({ root, profile: 'web', id: 'assistant', locale: 'zh' })).toBe(true)
    writeFileSync(join(root, 'profiles', 'web', 'IDENTITY.md'), 'assistant/zh identity\n')
    writeFileSync(join(root, 'profiles', 'web', 'SOUL.md'), 'assistant/zh soul\n')
    writeFileSync(join(root, 'profiles', 'web', 'RULES.md'), 'assistant/zh rules\n')
    expect(profileDiffersFromPreset({ root, profile: 'web', id: 'assistant', locale: 'zh' })).toBe(false)
    // Reading it from a DIFFERENT locale is not a local edit: every locale the preset ships counts as a
    // match, so switching the UI language cannot offer a destructive restore of the other language.
    expect(profileDiffersFromPreset({ root, profile: 'web', id: 'assistant', locale: 'en' })).toBe(false)
  })
})
