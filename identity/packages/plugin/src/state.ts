/**
 * The identity state: the three files of the effective identity, the preset library, and the
 * read/write actions the settings page drives.
 *
 * The data home arrives ASYNCHRONOUSLY (the base is loaded through the bootstrap after `apply` has
 * already registered the prompt section), so the state starts on the local mirror's answer and is
 * re-pointed once the base answers. Every path is derived from the CURRENT data home and profile, so a
 * settings write that moves either one is picked up on the next read — no restart, no second state.
 *
 * Nothing here throws into assembly: the prompt-rendering path is `sectionText`, whose only failure
 * mode is "no text", which is exactly the documented "fall back to the native prompt".
 *
 * @module @avantf/dsh-identity/state
 */
import { existsSync } from 'node:fs'
import { IdentityDocuments, type DocumentStatus, type DocumentText } from './documents.js'
import type { IdentityLogger } from './log.js'
import {
  FALLBACK_LOCALE,
  IDENTITY_FILES,
  identityRoot,
  presetLocaleDir,
  presetsRoot,
  profileDir,
  resolveDataHomeMirror,
  type IdentityFileName,
} from './paths.js'
import {
  applyPresetToProfile,
  deletePreset,
  isValidPresetId,
  listPresets,
  materializePresets,
  readPreset,
  resolveAssetsDir,
  saveProfileAsPreset,
  writePresetFile,
  type PresetFileText,
  type PresetSummary,
} from './presets.js'

/** One live snapshot of the plugin's Config, read at the moment of use. */
export interface IdentitySettings {
  readonly enabled: boolean
  readonly interpolate: boolean
  readonly replaceScope: 'session' | 'all'
  readonly drop: readonly string[]
  readonly maxBytes: number
  readonly profile: string
  readonly dataHome: string
  readonly activePreset: string
  readonly activeLocale: string
}

/** The `status` result: the wire schema in `wire.ts` is the authority; this mirrors it locally. */
export interface IdentityStatusView {
  readonly enabled: boolean
  readonly profile: string
  readonly dataHome: string
  readonly identityDir: string
  readonly presetsDir: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly maxBytes: number
  readonly interpolate: boolean
  readonly replaceScope: string
  readonly drop: readonly string[]
  readonly fallbackToNative: boolean
  readonly activePreset: string
  readonly activeLocale: string
  readonly locale: string
  readonly localeSource: string
  readonly files: readonly DocumentStatus[]
  readonly presets: readonly { readonly id: string; readonly locales: readonly string[]; readonly active: boolean }[]
}

/** The config the state's own reads need; the gateway owns the write side. */
export interface IdentityStateOptions {
  readonly dataHome: string
  readonly profile: () => string
  readonly maxBytes: () => number
  readonly version: string
  readonly assetsDir?: string
  readonly logger?: IdentityLogger
}

export class IdentityState {
  private dataHomeValue: string
  private documentsCache?: { readonly dir: string; readonly documents: IdentityDocuments }

  constructor(private readonly options: IdentityStateOptions) {
    this.dataHomeValue = options.dataHome
  }

  /** The data home currently in force. */
  get dataHome(): string {
    return this.dataHomeValue
  }

  /** `<data home>/identity`. */
  get root(): string {
    return identityRoot(this.dataHomeValue)
  }

  /** The profile whose identity is effective (the profile context's name, or the configured one). */
  get profile(): string {
    const profile = this.options.profile().trim()
    return profile === '' ? 'default' : profile
  }

  /** `profiles/<profile>/` — the ONE source of the effective identity. */
  get profileDir(): string {
    return profileDir(this.root, this.profile)
  }

  /** `presets/`. */
  get presetsDir(): string {
    return presetsRoot(this.root)
  }

  /** The three files of the effective identity (recreated when the data home or profile moves). */
  get documents(): IdentityDocuments {
    const dir = this.profileDir
    if (this.documentsCache?.dir !== dir) {
      this.documentsCache = {
        dir,
        documents: new IdentityDocuments(dir, {
          ...this.options.logger === undefined ? {} : { logger: this.options.logger },
          maxBytes: this.options.maxBytes,
        }),
      }
    }
    return this.documentsCache.documents
  }

  /** Point the state at the base's answer. A different root drops the cached reader. */
  setDataHome(next: string): void {
    if (next === this.dataHomeValue) return
    this.dataHomeValue = next
    this.documentsCache = undefined
  }

  /**
   * The section text: the rendered files when the switch is on, `''` when it is off. `''` is what
   * makes "off" byte-identical to native — the empty section is dropped by `renderPrompt`, and the
   * waterfall removes it as well.
   */
  sectionText(enabled: boolean): string {
    if (!enabled) return ''
    try {
      return this.documents.render()
    } catch (error) {
      // Assembly must never throw: a broken read is "no identity", which is the documented fallback.
      this.options.logger?.warn(`rendering the identity files failed (${reasonOf(error)}); falling back to the native prompt`)
      return ''
    }
  }

  /** Release the built-in presets (missing-only). Never throws. */
  provision(assetsDir?: string): { readonly copied: readonly string[]; readonly skipped: readonly string[] } {
    const source = assetsDir ?? this.options.assetsDir ?? resolveAssetsDir()
    if (source === undefined || !existsSync(source)) {
      this.options.logger?.warn('the built-in preset assets are missing from this build; no preset was released')
      return { copied: [], skipped: [] }
    }
    return materializePresets({
      assetsDir: source,
      root: this.root,
      version: this.options.version,
      ...this.options.logger === undefined ? {} : { logger: this.options.logger },
    })
  }

  /** Every preset on disk, marking the one this profile is currently using. */
  presetSummaries(activePreset: string): { readonly id: string; readonly locales: readonly string[]; readonly active: boolean }[] {
    return listPresets(this.root).map((preset: PresetSummary) => ({
      id: preset.id,
      locales: preset.locales,
      active: preset.id === activePreset,
    }))
  }

  /** The effective identity's three files, with their text. */
  readProfile(): { readonly profile: string; readonly identityDir: string; readonly totalBytes: number; readonly files: readonly DocumentText[] } {
    const files = this.documents.readAll()
    return {
      profile: this.profile,
      identityDir: this.profileDir,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      files,
    }
  }

  /** Write one effective-identity file. Answers an error string instead of throwing. */
  writeProfileFile(name: string, text: string): { readonly ok: boolean; readonly error?: string } {
    const file = identityNameOfLoose(name)
    if (file === undefined) return { ok: false, error: `unknown identity file: ${name}` }
    try {
      this.documents.write(file, text)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  /** Read one preset with locale fallback; `undefined` when the preset or its English copy is absent. */
  readPreset(id: string, locale: string): { readonly found: boolean; readonly id: string; readonly requestedLocale: string; readonly resolvedLocale: string; readonly fellBack: boolean; readonly files: readonly PresetFileText[] } {
    const read = readPreset(this.root, id, locale)
    if (read === undefined) {
      return { found: false, id, requestedLocale: locale, resolvedLocale: FALLBACK_LOCALE, fellBack: false, files: [] }
    }
    return { found: true, ...read }
  }

  /** Write one preset file in one locale. */
  writePresetFile(id: string, name: string, text: string, locale: string): { readonly ok: boolean; readonly error?: string } {
    const file = identityNameOfLoose(name)
    if (file === undefined) return { ok: false, error: `unknown identity file: ${name}` }
    if (!isValidPresetId(id)) return { ok: false, error: `invalid preset id: ${id}` }
    try {
      writePresetFile(this.root, id, locale, file, text)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  /** Apply a preset to the effective identity (overwrite; the UI owns the confirmation). */
  applyPreset(id: string, locale: string): { readonly ok: boolean; readonly error?: string; readonly resolvedLocale?: string; readonly fellBack?: boolean; readonly files?: readonly string[] } {
    try {
      const applied = applyPresetToProfile({ root: this.root, profile: this.profile, id, locale })
      if (applied === undefined) return { ok: false, error: `preset not found or has no ${FALLBACK_LOCALE} copy: ${id}` }
      // Refresh the reader: the write went behind its back, and a stale cache would keep serving the
      // old identity until the mtime happened to move.
      this.documents.invalidate()
      return { ok: true, resolvedLocale: applied.resolvedLocale, fellBack: applied.fellBack, files: applied.written }
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  /** Save the effective identity as a new preset. */
  saveAsPreset(id: string, locale: string): { readonly ok: boolean; readonly error?: string; readonly files?: readonly string[] } {
    if (!isValidPresetId(id)) return { ok: false, error: `invalid preset id: ${id}` }
    try {
      const saved = saveProfileAsPreset({ root: this.root, profile: this.profile, id, locale })
      if (saved === undefined) return { ok: false, error: `preset already exists: ${id}` }
      if (saved.written.length === 0) return { ok: false, error: 'the effective identity is empty; nothing to save' }
      return { ok: true, files: saved.written }
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  /** Delete one preset from the library. */
  deletePreset(id: string): { readonly ok: boolean; readonly error?: string } {
    try {
      return deletePreset(this.root, id) ? { ok: true } : { ok: false, error: `preset not found: ${id}` }
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  /** The header's one call: everything the settings page renders above the editors. */
  status(settings: IdentitySettings, locale: { readonly locale: string; readonly source: string }): IdentityStatusView {
    const files = this.documents.status()
    const present = files.filter((file) => file.present)
    return {
      enabled: settings.enabled,
      profile: this.profile,
      dataHome: this.dataHomeValue,
      identityDir: this.profileDir,
      presetsDir: this.presetsDir,
      fileCount: present.length,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      maxBytes: settings.maxBytes,
      interpolate: settings.interpolate,
      replaceScope: settings.replaceScope,
      drop: settings.drop,
      fallbackToNative: !settings.enabled || present.length === 0,
      activePreset: settings.activePreset,
      activeLocale: settings.activeLocale,
      locale: locale.locale,
      localeSource: locale.source,
      files,
      presets: this.presetSummaries(settings.activePreset),
    }
  }

  /** The preset locale directory (read-only accessor for diagnostics and tests). */
  presetDir(id: string, locale: string): string {
    return presetLocaleDir(this.root, id, locale)
  }

  /** The data home the local mirror answers, used before the base loads. */
  static mirrorDataHome(input: { readonly explicit?: string; readonly configured?: string } = {}): string {
    return resolveDataHomeMirror(input)
  }
}

/** Accept `IDENTITY`, `IDENTITY.md`, or the lower-case spellings a UI may send. */
function identityNameOfLoose(name: string): IdentityFileName | undefined {
  const upper = name.trim().toUpperCase().replace(/\.MD$/u, '')
  return (IDENTITY_FILES as readonly string[]).includes(upper) ? upper as IdentityFileName : undefined
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
