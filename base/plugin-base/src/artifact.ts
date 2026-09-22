/**
 * Build-time artifact scanning.
 * @module artifact
 */

/** The framework package name. */
export const FRAMEWORK_PACKAGE = '@avantf/dsh-plugin-base'

/** The one subpath a plugin build must inline rather than externalise. */
export const BOOTSTRAP_SUBPATH = `${FRAMEWORK_PACKAGE}/bootstrap`

/** How a specifier was referenced, when it really is a module reference. */
export type FrameworkImportKind = 'static' | 'side-effect' | 'dynamic' | 'require'

export interface FrameworkImportRef {
  readonly specifier: string
  readonly kind: FrameworkImportKind
  /** True for `@avantf/dsh-plugin-base/bootstrap` and anything under it. */
  readonly bootstrap: boolean
  /** Byte offset of the specifier in the scanned text. */
  readonly index: number
}

/** True for the bootstrap subpath. */
export function isBootstrapSpecifier(specifier: string): boolean {
  return specifier === BOOTSTRAP_SUBPATH || specifier.startsWith(`${BOOTSTRAP_SUBPATH}/`)
}

/** Control-plane literals of the framework's own implementation; counted once {@link MIN_INLINING_BEACONS} distinct names appear. */
export const FRAMEWORK_INLINING_BEACONS: readonly string[] = [
  '.status.lock',
  '.layout.json',
  '.quarantine',
  '.envinit',
  'status.json',
  'declared.json',
]

/** How many distinct beacons count as "the framework was inlined". */
export const MIN_INLINING_BEACONS = 3

/** The inlining beacons present in one artifact. */
export function findInliningBeacons(text: string): readonly string[] {
  return FRAMEWORK_INLINING_BEACONS.filter(beacon => text.includes(beacon))
}

const ESCAPED_PACKAGE = FRAMEWORK_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SPECIFIER = new RegExp(`(['"])(${ESCAPED_PACKAGE}(?:/[^'"]*)?)\\1`, 'g')
const WINDOW = 40

/** Classify a specifier by the token in front of the literal. */
function classify(prefix: string): FrameworkImportKind | undefined {
  const trimmed = prefix.trimEnd()
  if (/(?:^|[^\w$])import\s*\($/.test(trimmed)) return 'dynamic'
  if (/require\s*\($/.test(trimmed)) return 'require'
  if (/(?:^|[^\w$])from$/.test(trimmed)) return 'static'
  if (/(?:^|[^\w$])import$/.test(trimmed)) return 'side-effect'
  return undefined
}

/** Every framework module reference in one emitted artifact, in source order. */
export function findFrameworkImports(text: string): readonly FrameworkImportRef[] {
  const found: FrameworkImportRef[] = []
  SPECIFIER.lastIndex = 0
  for (let match = SPECIFIER.exec(text); match !== null; match = SPECIFIER.exec(text)) {
    const specifier = match[2]
    if (specifier === undefined) continue
    const index = match.index
    const kind = classify(text.slice(Math.max(0, index - WINDOW), index))
    if (kind === undefined) continue
    found.push({ specifier, kind, bootstrap: isBootstrapSpecifier(specifier), index })
  }
  return found
}
