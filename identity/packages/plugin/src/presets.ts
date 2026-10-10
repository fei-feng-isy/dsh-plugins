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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IdentityLogger } from './log.js'
import {
  FALLBACK_LOCALE,
  IDENTITY_FILES,
  PRESET_ID_PATTERN,
  presetLocaleDir,
  presetsRoot,
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
  // absent from the list AND absent on disk). A missing or unreadable marker reads as "no previous
  // release", which is the correct first-run answer.
  const released = readReleasedPresets(marker)
  try {
    mkdirSync(target, { recursive: true })
    for (const id of packaged) {
      const destination = join(target, id)
      // A preset a PREVIOUS release already put down is NEVER touched again — that is what makes
      // "the user deleted this preset" permanent rather than a race with the next mount.
      if (released.includes(id)) {
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
    // grows monotonically, so a later release still knows what an earlier one put down.
    writeFileSync(marker, `${JSON.stringify({
      version: options.version,
      at: new Date().toISOString(),
      presets: [...new Set([...released, ...copied])].sort((left, right) => left.localeCompare(right)),
      copied,
    }, null, 2)}\n`, 'utf8')
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

/** The preset ids a previous release recorded, or `[]` when there is no readable marker. */
export function readReleasedPresets(marker: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { presets?: unknown }
    if (!Array.isArray(parsed.presets)) return []
    return parsed.presets.filter((id): id is string => typeof id === 'string' && isValidPresetId(id))
  } catch {
    return []
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

/** Read one preset's three files, falling back to English when the requested locale is absent. */
export function readPreset(root: string, id: string, requestedLocale: string): PresetRead | undefined {
  if (!isValidPresetId(id)) return undefined
  const requested = isValidLocale(requestedLocale) ? requestedLocale : FALLBACK_LOCALE
  const resolved = resolvingLocale(root, id, requested)
  if (resolved === undefined) return undefined
  const dir = presetLocaleDir(root, id, resolved)
  const files = IDENTITY_FILES.map((name) => {
    const path = join(dir, `${name}.md`)
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      text = ''
    }
    return { name, file: `${name}.md`, text, present: text.trim() !== '', bytes: Buffer.byteLength(text, 'utf8') }
  })
  return { id, requestedLocale: requested, resolvedLocale: resolved, fellBack: resolved !== requested, files }
}

/** Write one preset file atomically; the caller decides whether the locale exists. */
export function writePresetFile(root: string, id: string, locale: string, name: IdentityFileName, text: string): void {
  if (!isValidPresetId(id)) throw new Error(`invalid preset id: ${id}`)
  if (!isValidLocale(locale)) throw new Error(`invalid locale: ${locale}`)
  const dir = presetLocaleDir(root, id, locale)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `${name}.md`)
  const temporary = `${target}.tmp-${String(process.pid)}`
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file may not exist; the original failure is the one that matters.
    }
    throw error
  }
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
  const dir = join(options.root, 'profiles', options.profile)
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  const missing: string[] = []
  for (const file of preset.files) {
    if (!file.present) {
      missing.push(file.file)
      continue
    }
    writeFileSync(join(dir, file.file), file.text, 'utf8')
    written.push(file.file)
  }
  return { resolvedLocale: preset.resolvedLocale, fellBack: preset.fellBack, written, missing }
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
  const source = join(options.root, 'profiles', options.profile)
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (const name of IDENTITY_FILES) {
    const path = join(source, `${name}.md`)
    let text: string | undefined
    try {
      if (statSync(path).isFile()) text = readFileSync(path, 'utf8')
    } catch {
      text = undefined
    }
    if (text === undefined || text.trim() === '') continue
    writeFileSync(join(dir, `${name}.md`), text, 'utf8')
    written.push(`${name}.md`)
  }
  return { written }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
