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
  type IdentityFileName,
} from './paths.js'
import {
  applyPresetToProfile,
  applyProfileEditToProfile,
  deletePreset,
  dropProfileEdit,
  isValidPresetId,
  listPresets,
  materializePresets,
  profileDiffersFromPreset,
  readPreset,
  resolveAssetsDir,
  saveProfileAsPreset,
  seedProfileIfEmpty,
  snapshotProfileEdit,
  writePresetFile,
  type PresetFileText,
  type PresetSummary,
  type ProfileSeed,
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
  /** Whether the effective identity differs from what the active preset ships. */
  readonly hasLocalEdit: boolean
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

  /**
   * Switch the effective identity to `id`.
   *
   * `previousId` is the identity being LEFT (the caller's live `activePreset`): its current content is
   * filed away under that id FIRST, so coming back to it later restores what the user wrote instead of
   * the library's factory text. The incoming identity is then taken from this profile's own version when
   * one exists, and from the library preset otherwise.
   *
   * `previousId === ''` with a non-empty effective identity means the user hand-wrote content that no
   * identity owns: switching away would leave it nowhere to come back to, so it is REFUSED with an
   * explanation rather than silently destroyed.
   */
  applyPreset(id: string, locale: string, previousId = ''): { readonly ok: boolean; readonly error?: string; readonly resolvedLocale?: string; readonly fellBack?: boolean; readonly files?: readonly string[]; readonly restoredEdit?: boolean } {
    try {
      const effective = this.documents.readAll()
      if (previousId === '' && effective.some((file) => file.present)) {
        return { ok: false, error: 'this identity has no preset id, so switching away would destroy it; use "save as preset" first' }
      }
      // The same read serves the refusal check and the file-away, so a switch reads the effective identity once.
      if (previousId !== '') snapshotProfileEdit({ root: this.root, profile: this.profile, id: previousId, files: effective })
      const restored = applyProfileEditToProfile({ root: this.root, profile: this.profile, id })
      if (restored !== undefined) {
        this.documents.invalidate()
        return { ok: true, files: restored.written, restoredEdit: true }
      }
      return this.fromLibraryPreset(id, locale)
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  /** Discard this profile's own version of `id` and put the library preset's text back in force. */
  resetToPreset(id: string, locale: string): { readonly ok: boolean; readonly error?: string; readonly resolvedLocale?: string; readonly fellBack?: boolean; readonly files?: readonly string[]; readonly dropped?: boolean } {
    try {
      const dropped = dropProfileEdit({ root: this.root, profile: this.profile, id })
      const applied = this.fromLibraryPreset(id, locale)
      return applied.ok ? { ...applied, dropped } : applied
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  /**
   * Write a library preset's text into the effective identity and shape the answer both callers return.
   *
   * Always invalidates the reader: the write went behind its back, and a stale cache would keep serving
   * the old identity until the mtime happened to move.
   */
  private fromLibraryPreset(id: string, locale: string): { readonly ok: boolean; readonly error?: string; readonly resolvedLocale?: string; readonly fellBack?: boolean; readonly files?: readonly string[] } {
    const applied = applyPresetToProfile({ root: this.root, profile: this.profile, id, locale })
    if (applied === undefined) return { ok: false, error: `preset not found or has no ${FALLBACK_LOCALE} copy: ${id}` }
    this.documents.invalidate()
    return { ok: true, resolvedLocale: applied.resolvedLocale, fellBack: applied.fellBack, files: applied.written }
  }

  /**
   * Whether the effective identity differs from what preset `id` ships in `locale`.
   * @param effectiveFiles - the effective files already read, when the caller has them.
   */
  hasLocalEdit(id: string, locale: string, effectiveFiles?: readonly DocumentText[]): boolean {
    return profileDiffersFromPreset({ root: this.root, profile: this.profile, id, locale, ...effectiveFiles === undefined ? {} : { effectiveFiles } })
  }

  /**
   * Materialize an effective identity for THIS profile when it has none — what the switch's first
   * enable asks the host for (see `presets.seedProfileIfEmpty`). Never overwrites the user's files.
   */
  ensureProfile(locale: string): ProfileSeed {
    try {
      const seed = seedProfileIfEmpty({ root: this.root, profile: this.profile, locale })
      // Every write in this module invalidates the reader. The seed only writes where there was nothing
      // to read (a failed `stat` is never cached), so this is not load-bearing today — it is here because
      // "wrote files, kept serving the old text" must not become possible by accident.
      this.documents.invalidate()
      return seed
    } catch (error) {
      return { seeded: false, written: [], error: reasonOf(error) }
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

  /**
   * Delete one preset from the library.
   *
   * This profile's own version of it goes too: once the identity is out of the dropdown, that version
   * is unreachable — keeping it would only leave a shadow that a future release could resurrect.
   */
  deletePreset(id: string): { readonly ok: boolean; readonly error?: string } {
    try {
      if (!deletePreset(this.root, id)) return { ok: false, error: `preset not found: ${id}` }
      dropProfileEdit({ root: this.root, profile: this.profile, id })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    }
  }

  /**
   * The header's one call: everything the settings page renders above the editors.
   *
   * The three effective files are read ONCE here and reused for both the status rows and the
   * "you have your own version" comparison — reading them a second time was pure work, and this call
   * also walks the preset library (see `presetSummaries`).
   */
  status(settings: IdentitySettings, locale: { readonly locale: string; readonly source: string }): IdentityStatusView {
    const entries = this.documents.readAll()
    const files: DocumentStatus[] = entries.map((file) => ({
      name: file.name,
      file: file.file,
      path: this.documents.pathOf(file.name),
      present: file.present,
      bytes: file.bytes,
    }))
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
      // "You have your own version of the identity in force" — what enables 「恢复预设原文」.
      hasLocalEdit: settings.activePreset !== '' && this.hasLocalEdit(settings.activePreset, locale.locale, entries),
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
}

/** Accept `IDENTITY`, `IDENTITY.md`, or the lower-case spellings a UI may send. */
function identityNameOfLoose(name: string): IdentityFileName | undefined {
  const upper = name.trim().toUpperCase().replace(/\.MD$/u, '')
  return (IDENTITY_FILES as readonly string[]).includes(upper) ? upper as IdentityFileName : undefined
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
