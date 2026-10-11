/**
 * The preset library: releasing the built-in presets, reading/editing them, and moving text between a
 * preset and the effective identity.
 *
 * The four write actions are the spec's §5.4 table, and the ONE rule they all share is that the
 * effective identity has exactly one source (`profiles/<name>/`): editing a preset never touches it,
 * and only `apply` writes it.
 *
 * "Missing-only, never overwrite" is the discipline this file exists to enforce: the built-in presets
 * are the USER's files from the moment they are written, so a release never clobbers an edit, never
 * resurrects a preset the user deleted, and never fills a gap the user made on purpose. The
 * `.provisioned` marker records that the release happened (with the package version), so "which
 * release put these here" is answerable without guessing.
 *
 * Every failure here is a returned error or a WARN — never a throw into `apply`, and never a mount
 * failure. A read-only data directory degrades to "no presets"; the plugin still mounts.
 *
 * @module @avantf/dsh-identity/presets
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileAtomically } from './atomic-write.js'
import type { IdentityLogger } from './log.js'
import {
  FALLBACK_LOCALE,
  IDENTITY_FILES,
  LOCALE_IDS,
  PRESET_ID_PATTERN,
  presetLocaleDir,
  presetsRoot,
  profileDir,
  profileEditDir,
  provisionMarker,
  type IdentityFileName,
} from './paths.js'

/** One preset, as the settings page lists it. */
export interface PresetSummary {
  readonly id: string
  readonly locales: readonly string[]
}

/** One preset file's text. */
export interface PresetFileText {
  readonly name: IdentityFileName
  readonly file: string
  readonly text: string
  readonly present: boolean
  readonly bytes: number
}

/** A read preset: the locale that answered, and whether the requested one had to fall back. */
export interface PresetRead {
  readonly id: string
  readonly requestedLocale: string
  readonly resolvedLocale: string
  readonly fellBack: boolean
  readonly files: readonly PresetFileText[]
}

/** A locale id this plugin is willing to turn into a path segment. */
const LOCALE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/**
 * The built-in preset a profile with NO identity is seeded from.
 *
 * `assistant` is the neutral one (`analyst` / `coder` are specific roles); the two specific ones are a
 * deliberate choice by the user, never a default.
 */
export const DEFAULT_PRESET_ID = 'assistant'

/** What {@link seedProfileIfEmpty} did: whether it wrote anything, from which preset, and why it did not. */
export interface ProfileSeed {
  readonly seeded: boolean
  readonly preset?: string
  readonly resolvedLocale?: string
  readonly fellBack?: boolean
  readonly written: readonly string[]
  readonly error?: string
}

/** Whether `id` is a preset id this plugin will use as a directory name. */
export function isValidPresetId(id: string): boolean {
  return PRESET_ID_PATTERN.test(id)
}

/** Whether `locale` is a locale this plugin will use as a directory name. */
export function isValidLocale(locale: string): boolean {
  return LOCALE_PATTERN.test(locale)
}

/**
 * Where the built-in preset resources live at runtime.
 *
 * Both candidates are real, for different builds: the host entry is BUNDLED into `lib/index.js`, so
 * `./assets/presets` finds `lib/assets/presets` (the only location that ships); under `vitest` the
 * module is `src/…`, so `../assets/presets` finds the source tree's `assets/presets`.
 */
export function resolveAssetsDir(from: string = import.meta.url): string | undefined {
  for (const relative of ['./assets/presets', '../assets/presets']) {
    try {
      const candidate = fileURLToPath(new URL(relative, from))
      if (existsSync(candidate)) return candidate
    } catch {
      // A malformed URL is "not found", not a failure to report.
    }
  }
  return undefined
}

/** The preset ids the shipped resource tree carries, in name order. */
export function packagedPresetIds(assetsDir: string): string[] {
  try {
    return readdirSync(assetsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidPresetId(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

/**
 * Release the built-in presets into `<identity root>/presets/`, MISSING-ONLY.
 *
 * A preset directory that already exists is left completely alone — that single rule covers both
 * "never overwrite an edit" and "do not resurrect a preset the user deleted". The `.provisioned`
 * marker then records which release ran, so a later release only has to add preset directories that
 * are genuinely new.
 */
export function materializePresets(options: {
  readonly assetsDir: string
  readonly root: string
  readonly version: string
  readonly logger?: IdentityLogger
}): { readonly copied: readonly string[]; readonly skipped: readonly string[] } {
  const copied: string[] = []
  const skipped: string[] = []
  const target = presetsRoot(options.root)
  const marker = provisionMarker(options.root)
  const packaged = packagedPresetIds(options.assetsDir)
  // What a PREVIOUS release put here. With this list, "delete a built-in preset" is permanent: an id
  // the marker already names is never copied again, while an id the package gained since is (it is
  // absent from the list AND absent on disk). A MISSING marker is the genuine first run; an
  // UNREADABLE one is handled through `known` below and is never treated as "first run".
  const released = readReleasedPresets(marker)
  // A marker that EXISTS but cannot be read is NOT "first run": the ids a previous release put down
  // are unknown, so every packaged id counts as already released and nothing is copied. That is what
  // keeps "the user deleted this preset" permanent even when the marker is corrupt. The write below
  // then records the packaged set, so a preset a LATER package gains is still released while none of
  // the deletable ones can come back.
  const known = released ?? packaged
  try {
    mkdirSync(target, { recursive: true })
    for (const id of packaged) {
      const destination = join(target, id)
      // A preset a PREVIOUS release already put down is NEVER touched again — that is what makes
      // "the user deleted this preset" permanent rather than a race with the next mount.
      if (known.includes(id)) {
        skipped.push(id)
        continue
      }
      // First time this package sees the preset: fill in exactly what is missing. An existing FILE is
      // never overwritten (the user's edit wins), and an existing directory is descended into rather
      // than skipped, so a half-populated preset is completed instead of silently left alone.
      if (copyMissing(join(options.assetsDir, id), destination)) copied.push(id)
      else skipped.push(id)
    }
    // One write, and one that may rewrite the marker: it is OURS, not the user's. The released list
    // grows monotonically, so a later release still knows what an earlier one put down. Atomic like
    // every other write in this module: a reader must never see a half-written marker and read it as
    // "corrupt" (which now means "copy nothing").
    writeFileAtomically(marker, `${JSON.stringify({
      version: options.version,
      at: new Date().toISOString(),
      presets: [...new Set([...known, ...copied])].sort((left, right) => left.localeCompare(right)),
      copied,
    }, null, 2)}\n`)
  } catch (error) {
    // A read-only or permission-denied data directory is an environment failure: one WARN, and the
    // plugin mounts with whatever presets are already on disk.
    options.logger?.warn(`releasing the built-in presets into ${target} failed (${reasonOf(error)}); the plugin mounts with the presets already on disk`)
    return { copied, skipped }
  }
  if (copied.length > 0) options.logger?.info(`released built-in presets: ${copied.join(', ')}`)
  return { copied, skipped }
}

/**
 * Copy the files of one preset tree that are missing at the destination; NEVER overwrite an existing
 * file. Returns whether anything was written.
 */
function copyMissing(source: string, destination: string): boolean {
  if (!existsSync(source)) return false
  let wrote = false
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      if (copyMissing(from, to)) wrote = true
      continue
    }
    if (existsSync(to)) continue
    copyFileSync(from, to)
    wrote = true
  }
  return wrote
}

/**
 * The preset ids a previous release recorded.
 *
 * `[]` means "no marker at all" — a genuine first run, where nothing has been released yet. `undefined`
 * means a marker EXISTS but cannot be used (unreadable, not JSON, no `presets` array): which ids it
 * recorded is UNKNOWN, and the caller must not treat that as "nothing was released" — copying then
 * would resurrect a preset the user deleted, which `identity/README.md` promises never happens.
 */
export function readReleasedPresets(marker: string): string[] | undefined {
  let raw: string
  try {
    raw = readFileSync(marker, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as { presets?: unknown }
    if (!Array.isArray(parsed.presets)) return undefined
    return parsed.presets.filter((id): id is string => typeof id === 'string' && isValidPresetId(id))
  } catch {
    return undefined
  }
}

/** Every preset on disk, with the locales each has a directory for. */
export function listPresets(root: string): PresetSummary[] {
  const base = presetsRoot(root)
  let ids: string[] = []
  try {
    ids = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidPresetId(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return ids.sort((left, right) => left.localeCompare(right)).map((id) => {
    let locales: string[] = []
    try {
      locales = readdirSync(join(base, id), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isValidLocale(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
    } catch {
      locales = []
    }
    return { id, locales }
  })
}

/** The locale directory that answers for `requested`: itself when present, else the English fallback. */
function resolvingLocale(root: string, id: string, requested: string): string | undefined {
  if (isValidLocale(requested) && existsSync(presetLocaleDir(root, id, requested))) return requested
  if (existsSync(presetLocaleDir(root, id, FALLBACK_LOCALE))) return FALLBACK_LOCALE
  return undefined
}

/**
 * Read the three identity files of ONE directory, in render order.
 *
 * The single reader for every "three files in a directory" site: a preset's locale directory, a
 * profile's own version (`.edits/<id>/`), and the effective profile directory. Absent, unreadable and
 * not-a-file all read as "no text" with `present: false` — the same answer the prompt assembly needs —
 * so a directory that does not exist yet is simply three absent files.
 */
function identityFilesIn(dir: string): PresetFileText[] {
  return IDENTITY_FILES.map((name) => {
    const file = `${name}.md`
    let text = ''
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      text = ''
    }
    return { name, file, text, present: text.trim() !== '', bytes: Buffer.byteLength(text, 'utf8') }
  })
}

/**
 * Write the NON-EMPTY files of `files` into `dir`, reporting the empty ones as `missing`.
 *
 * "Take this text" is never "blank what this set of files does not mention": an empty body is skipped,
 * so a preset (or a profile version) that carries nothing for one file leaves whatever is there.
 *
 * The directory is created only when something is actually written. That keeps "nothing to write" from
 * leaving an EMPTY store behind — an empty `.edits/<id>/` would read as "this profile has a version of
 * `<id>`" and make a switch restore nothing instead of applying the preset.
 */
function writeIdentityFiles(dir: string, files: readonly PresetFileText[]): { written: string[]; missing: string[] } {
  const written: string[] = []
  const missing: string[] = []
  let ready = false
  for (const file of files) {
    if (!file.present) {
      missing.push(file.file)
      continue
    }
    // Once, on the first actual write — not per file, and not at all when there is nothing to write.
    if (!ready) {
      mkdirSync(dir, { recursive: true })
      ready = true
    }
    writeFileAtomically(join(dir, file.file), file.text)
    written.push(file.file)
  }
  return { written, missing }
}

/** Read one preset's three files, falling back to English when the requested locale is absent. */
export function readPreset(root: string, id: string, requestedLocale: string): PresetRead | undefined {
  if (!isValidPresetId(id)) return undefined
  const requested = isValidLocale(requestedLocale) ? requestedLocale : FALLBACK_LOCALE
  const resolved = resolvingLocale(root, id, requested)
  if (resolved === undefined) return undefined
  return {
    id,
    requestedLocale: requested,
    resolvedLocale: resolved,
    fellBack: resolved !== requested,
    files: identityFilesIn(presetLocaleDir(root, id, resolved)),
  }
}

/** Write one preset file atomically; the caller decides whether the locale exists. */
export function writePresetFile(root: string, id: string, locale: string, name: IdentityFileName, text: string): void {
  if (!isValidPresetId(id)) throw new Error(`invalid preset id: ${id}`)
  if (!isValidLocale(locale)) throw new Error(`invalid locale: ${locale}`)
  const dir = presetLocaleDir(root, id, locale)
  mkdirSync(dir, { recursive: true })
  writeFileAtomically(join(dir, `${name}.md`), text)
}

/** Remove one preset directory entirely. */
export function deletePreset(root: string, id: string): boolean {
  if (!isValidPresetId(id)) return false
  const dir = join(presetsRoot(root), id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * Apply a preset to the effective identity: copy its resolved-locale files into
 * `profiles/<profile>/`, OVERWRITING (the UI owns the second confirmation).
 *
 * A file the preset does not carry is left as it is rather than blanked: applying a preset is "take
 * this text", never "delete what this preset happens not to mention".
 */
export function applyPresetToProfile(options: {
  readonly root: string
  readonly profile: string
  readonly id: string
  readonly locale: string
}): { readonly resolvedLocale: string; readonly fellBack: boolean; readonly written: readonly string[]; readonly missing: readonly string[] } | undefined {
  const preset = readPreset(options.root, options.id, options.locale)
  if (preset === undefined) return undefined
  const { written, missing } = writeIdentityFiles(profileDir(options.root, options.profile), preset.files)
  return { resolvedLocale: preset.resolvedLocale, fellBack: preset.fellBack, written, missing }
}

/**
 * Give `profiles/<profile>/` an identity to start from, when it has none.
 *
 * The switch's first enable asks for this. The first run materializes the PRESET LIBRARY only — it never
 * writes an effective identity — so a profile that was never given files has nothing to replace the
 * native prompt with: enabling the switch would leave the prompt untouched and the three editors empty.
 *
 * NEVER overwrites: any one non-empty file means the user has an identity, and nothing is written. The
 * built-in {@link DEFAULT_PRESET_ID} is preferred; when the user has deleted it, the first preset still
 * in the library stands in. An empty library is REPORTED (the caller surfaces the reason) rather than
 * invented — this function does not know what the user's identity should say.
 */
export function seedProfileIfEmpty(options: {
  readonly root: string
  readonly profile: string
  readonly locale: string
}): ProfileSeed {
  const dir = profileDir(options.root, options.profile)
  if (identityFilesIn(dir).some((file) => file.present)) return { seeded: false, written: [] }
  const available = listPresets(options.root).map((preset) => preset.id)
  const id = available.includes(DEFAULT_PRESET_ID) ? DEFAULT_PRESET_ID : available[0]
  if (id === undefined) {
    return { seeded: false, written: [], error: 'no preset is available to seed this identity; apply a preset or write the files' }
  }
  const applied = applyPresetToProfile({ root: options.root, profile: options.profile, id, locale: options.locale })
  if (applied === undefined) return { seeded: false, written: [], error: `preset could not be read: ${id}` }
  return {
    seeded: true,
    preset: id,
    resolvedLocale: applied.resolvedLocale,
    fellBack: applied.fellBack,
    written: applied.written,
  }
}

/**
 * The identity edits a profile owns: `<profiles/<profile>>/.edits/<id>/`.
 *
 * WHY THIS EXISTS. `applyPresetToProfile` overwrites the effective identity, so without a copy the
 * user's own text for the identity they were on would be destroyed by switching to another one — and
 * switching back would hand them the preset's factory text instead of what they wrote. The edit store
 * is what makes the switch REVERSIBLE: leaving an identity files its current content away under that id,
 * and coming back to the id restores that content in preference to the library's.
 *
 * It is per PROFILE on purpose: an edit is one person's version of an identity, so it must not leak into
 * another profile, and the library keeps the pristine text (「恢复预设原文」drops the edit).
 */

/** Whether this profile has its own version of `id` — the directory exists and carries any text. */
export function readProfileEdit(options: {
  readonly root: string
  readonly profile: string
  readonly id: string
}): { readonly files: readonly PresetFileText[]; readonly bytes: number } | undefined {
  if (!isValidPresetId(options.id)) return undefined
  const dir = profileEditDir(options.root, options.profile, options.id)
  if (!existsSync(dir)) return undefined
  const files = identityFilesIn(dir)
  return { files, bytes: files.reduce((total, file) => total + file.bytes, 0) }
}

/**
 * File the CURRENT effective identity away as this profile's version of `id`.
 *
 * Called when the user leaves `id` for another identity. An empty effective identity files nothing (an
 * empty version would shadow the library's text on the way back for no reason) — the edit directory is
 * then left as it was. Nothing else is touched: the effective files stay where they are until the caller
 * applies the next identity.
 */
export function snapshotProfileEdit(options: {
  readonly root: string
  readonly profile: string
  readonly id: string
  /** The effective files, already read (in render order) by a caller that just needed them. */
  readonly files?: readonly PresetFileText[]
}): { readonly written: readonly string[] } | undefined {
  if (!isValidPresetId(options.id)) return undefined
  const files = options.files ?? identityFilesIn(profileDir(options.root, options.profile))
  const { written } = writeIdentityFiles(profileEditDir(options.root, options.profile, options.id), files)
  return { written }
}

/** Write this profile's version of `id` into the effective identity (overwriting the effective files). */
export function applyProfileEditToProfile(options: {
  readonly root: string
  readonly profile: string
  readonly id: string
}): { readonly written: readonly string[] } | undefined {
  const edit = readProfileEdit(options)
  if (edit === undefined) return undefined
  const { written } = writeIdentityFiles(profileDir(options.root, options.profile), edit.files)
  return { written }
}

/** Remove this profile's version of `id`, so `id` falls back to the library's text. */
export function dropProfileEdit(options: {
  readonly root: string
  readonly profile: string
  readonly id: string
}): boolean {
  if (!isValidPresetId(options.id)) return false
  const dir = profileEditDir(options.root, options.profile, options.id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * Whether the EFFECTIVE identity differs from the library preset's text — "you have your own version in
 * force". Computed from the two texts rather than from the edit store existing, because a hand-edited
 * identity has no stored version yet and still must be restorable.
 *
 * Every locale the preset ships counts as a match, not just the one the page is showing: a preset applied
 * in `zh` and then read with an `en` UI is NOT a local edit, and reporting it as one would offer a
 * destructive 「restore」 that silently switched the identity's language.
 */
export function profileDiffersFromPreset(options: {
  readonly root: string
  readonly profile: string
  readonly id: string
  readonly locale: string
  /** The effective files, already read (in render order) by a caller that just read them. */
  readonly effectiveFiles?: readonly PresetFileText[]
}): boolean {
  if (!isValidPresetId(options.id)) return false
  const files = options.effectiveFiles ?? identityFilesIn(profileDir(options.root, options.profile))
  const effective = files.map((file) => file.text.trim())
  const locales = [...new Set([options.locale, ...LOCALE_IDS])]
  const matchesSomeLocale = locales.some((locale) => {
    const preset = readPreset(options.root, options.id, locale)
    if (preset === undefined) return false
    // A file the preset does not carry reads as '' on its side, exactly as it does for the renderer.
    return IDENTITY_FILES.every((name, index) => {
      const file = preset.files.find((candidate) => candidate.file === `${name}.md`)
      return effective[index] === (file?.present === true ? file.text.trim() : '')
    })
  })
  return !matchesSomeLocale
}

/** Save the effective identity as a new preset under `<locale>`. Refuses an id that already exists. */
export function saveProfileAsPreset(options: {
  readonly root: string
  readonly profile: string
  readonly id: string
  readonly locale: string
}): { readonly written: readonly string[] } | undefined {
  if (!isValidPresetId(options.id)) return undefined
  const locale = isValidLocale(options.locale) ? options.locale : FALLBACK_LOCALE
  const dir = presetLocaleDir(options.root, options.id, locale)
  if (existsSync(dir)) return undefined
  const files = identityFilesIn(profileDir(options.root, options.profile))
  const { written } = writeIdentityFiles(dir, files)
  return { written }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
