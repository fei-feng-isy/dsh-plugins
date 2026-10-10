/**
 * The preset library: missing-only release, locale fallback, the four write actions, and the
 * "environment failure is a WARN, never a throw" rule.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPresetToProfile,
  deletePreset,
  isValidPresetId,
  listPresets,
  materializePresets,
  readPreset,
  readReleasedPresets,
  saveProfileAsPreset,
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
    expect(readReleasedPresets(provisionMarker(root)).sort()).toEqual(['assistant', 'coder'])
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

  it('delete removes the preset directory', () => {
    expect(deletePreset(root, 'coder')).toBe(true)
    expect(existsSync(join(root, 'presets', 'coder'))).toBe(false)
    expect(deletePreset(root, 'coder')).toBe(false)
    expect(deletePreset(root, '../escape')).toBe(false)
  })
})
