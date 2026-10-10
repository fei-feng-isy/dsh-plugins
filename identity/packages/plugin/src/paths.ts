/**
 * Where identity lives on disk, and the base-less data-home fallback.
 *
 * **Family convention (single source of truth: `base/plugin-base/src/kit/family.ts`).** The data root
 * resolves ⑤ explicit → ④ `$AVANTF_HOME` → ② the configured `dataHome` → `~/.avantf`; anything else is
 * read from the base module the inlined bootstrap loaded.
 *
 * {@link resolveDataHomeMirror} is the DELIBERATE MIRROR of the base's `resolveDataHome`, used only
 * when that module cannot be loaded (absent, older, or a generation mismatch). It is not a second
 * opinion: it is the same rule, spelled out here so a base-less mount still finds the user's files
 * instead of inventing a directory. `test/paths.spec.ts` pins it against the LINKED base by comparing
 * the two answers over a table of inputs — a real cross-tree pin, not a mock — and it is registered in
 * the root `AGENTS.md` mirror list, so a fourth place that copies this rule is a documented miss
 * rather than a silent drift.
 *
 * The LAYOUT lives here too, because both halves (the host's file service and the browser half's
 * labels) name the same three files:
 *
 *   <data home>/identity/
 *     profiles/<profile>/{IDENTITY,SOUL,RULES}.md      # the effective identity (flat, any language)
 *     presets/<preset>/<locale>/{IDENTITY,SOUL,RULES}.md
 *     .provisioned                                    # the built-in release marker
 *
 * @module @avantf/dsh-identity/paths
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The three files that make up one identity, in render order. */
export const IDENTITY_FILES = ['IDENTITY', 'SOUL', 'RULES'] as const

/** One of {@link IDENTITY_FILES}. */
export type IdentityFileName = (typeof IDENTITY_FILES)[number]

/** The locales the family ships presets in (`dsh-client-locale`'s published `LOCALE_IDS`). */
export const LOCALE_IDS = ['zh', 'en'] as const

/** The locale a preset falls back to when the requested one has no directory. */
export const FALLBACK_LOCALE = 'en'

/** `coder` / `assistant` / `analyst` — a NEW preset id is rejected unless it matches this. */
export const PRESET_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/** The data-home input shape, mirrored from the base so {@link resolveDataHomeMirror} takes named slots. */
export interface DataHomeInput {
  /** Layer ⑤: an explicit caller value; blank or omitted means "not given". */
  readonly explicit?: string
  /** Layer ④: the environment map; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>
  /** Layer ②: the configured `common.dataHome`; blank or omitted means "not configured". */
  readonly configured?: string
}

/** `~/x` → `<home>/x`, `~` → `<home>`; anything else is used as given. Mirrors the base's `expandHome`. */
export function expandHomeMirror(path: string, home: string = homedir()): string {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/**
 * The data root, with the base's exact layer order and named slots.
 * @see module note — this is a mirror, pinned against the linked base by `test/paths.spec.ts`.
 */
export function resolveDataHomeMirror(input: DataHomeInput = {}): string {
  const layer5 = input.explicit?.trim() ?? ''
  const env = input.env ?? process.env
  const fromEnv = env['AVANTF_HOME']?.trim() ?? ''
  const layer2 = input.configured?.trim() ?? ''
  const base = layer5 !== '' ? layer5 : fromEnv !== '' ? fromEnv : layer2 !== '' ? layer2 : join(homedir(), '.avantf')
  return expandHomeMirror(base)
}

/** `<data home>/identity` — the whole identity tree for this data home. */
export function identityRoot(dataHome: string): string {
  return join(dataHome, 'identity')
}

/** `<identity root>/profiles/<profile>` — the effective identity. */
export function profileDir(root: string, profile: string): string {
  return join(root, 'profiles', profile)
}

/** `<identity root>/presets` — the preset library. */
export function presetsRoot(root: string): string {
  return join(root, 'presets')
}

/** `<identity root>/presets/<id>/<locale>`. */
export function presetLocaleDir(root: string, id: string, locale: string): string {
  return join(presetsRoot(root), id, locale)
}

/** `<identity root>/.provisioned` — the one-time built-in release marker. */
export function provisionMarker(root: string): string {
  return join(root, '.provisioned')
}
