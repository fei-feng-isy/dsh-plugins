/**
 * The INTERFACE VERSION baked into a plugin artifact — the RUNTIME half of the family's interface gate.
 *
 * `@avantf/dsh-plugin-base` exports an integer `INTERFACE_VERSION` and the plugins compare it at
 * startup with the value the base they actually loaded reports. The comparison needs the number the
 * plugin was BUILT against to travel with the artifact, so the link step bakes it into
 * `lib/interface-version.json` beside the entry — the same discipline as `dsh-build.json` (which
 * records the dsh versions a build compiled against) and for the same reason: a peer RANGE is a lower
 * bound the artifact tolerates, not the generation it was written for, and silently falling back to it
 * turns a real mismatch into "looks fine".
 *
 * The mechanism paid for itself once already, on the sibling bake: a partially written record let the
 * gate fall back to the range floor and report `ok` against a host the artifact was never compiled
 * with. So the file carries two fields — the interface number and the base package version it was
 * taken from — and the writer and the reader check them together.
 *
 * ONE implementation, used by both trees' `scripts/link-envinit.mjs` (the step that already vendors
 * the base's bootstrap) so re-baking is not something a human has to remember, and by the plugins'
 * tests. It lives under `scripts/lib/` because the boundary guard allows a subtree to reach that
 * directory and nothing else outside itself.
 *
 * @module scripts/lib/interface-version
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The file name, relative to a built plugin's `lib/`. */
export const INTERFACE_VERSION_FILE = 'interface-version.json'

/**
 * The `INTERFACE_VERSION` a BUILT base exports.
 *
 * Imported rather than regex-read: the constant is a real ESM export, and a regex here would be a
 * second parser for the same fact. A base whose `dist/index.js` is missing or does not export the
 * constant is an error, not `undefined` — silently skipping the bake is exactly the failure this
 * exists to catch.
 * @param baseDir - a built `@avantf/dsh-plugin-base` directory.
 * @returns the integer the base exports.
 */
export async function readBaseInterfaceVersion(baseDir) {
  const entry = join(baseDir, 'dist', 'index.js')
  if (!existsSync(entry)) {
    throw new Error(`${entry} is missing — build the base first (pnpm --filter @avantf/dsh-plugin-base run build)`)
  }
  const module = await import(pathToFileURL(entry).href)
  const value = module.INTERFACE_VERSION
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${entry} does not export a positive integer INTERFACE_VERSION (found ${JSON.stringify(value)})`)
  }
  return value
}

/**
 * The bundled package version of a built base — the other half of the baked record.
 *
 * The base's own `interface-vN.json` asserts "file name N == exported constant". This is the mirror on
 * the plugin side: the interface number is what the runtime gate speaks in, and the package version is
 * what the dependency range speaks in, so both travel with the artifact.
 * @param baseDir - a built `@avantf/dsh-plugin-base` directory.
 * @returns the version string from the base's manifest.
 */
export function readBasePackageVersion(baseDir) {
  const manifest = JSON.parse(readFileSync(join(baseDir, 'package.json'), 'utf8'))
  const version = manifest.version
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${join(baseDir, 'package.json')} has no version`)
  }
  return version
}

/**
 * The exact bytes a bake writes; shared by the writer and the drift check so they cannot disagree.
 * @param baseVersion - the base package version the bake was taken from.
 * @param interfaceVersion - the interface generation that base exports.
 * @returns the file's text.
 */
export function interfaceVersionText(baseVersion, interfaceVersion) {
  return `${JSON.stringify({ baseVersion, interfaceVersion }, null, 2)}\n`
}

/**
 * Bake the interface version beside a plugin's built entry. Idempotent: identical bytes are left
 * alone, so a rebuild does not churn mtimes.
 * @param pluginDir - the plugin package directory (`<tree>/packages/plugin`).
 * @param baseDir - a built base to take the number from.
 * @returns the file written and the values in it.
 */
export async function bakeInterfaceVersion(pluginDir, baseDir) {
  const baseVersion = readBasePackageVersion(baseDir)
  const interfaceVersion = await readBaseInterfaceVersion(baseDir)
  const file = join(pluginDir, 'lib', INTERFACE_VERSION_FILE)
  const next = interfaceVersionText(baseVersion, interfaceVersion)
  mkdirSync(join(pluginDir, 'lib'), { recursive: true })
  let current
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    current = undefined
  }
  if (current !== next) writeFileSync(file, next)
  return { file, baseVersion, interfaceVersion, changed: current !== next }
}

/**
 * The baked file's contents, or `undefined` when it is absent or malformed.
 *
 * Malformed is `undefined` on purpose: every caller is a startup path that must degrade to a warning,
 * never throw, and a half-written file must read as "not baked" rather than as a version.
 * @param url - the file's URL, normally `new URL('./interface-version.json', import.meta.url)`.
 * @returns `{ baseVersion, interfaceVersion }`, or `undefined`.
 */
export function readInterfaceVersion(url) {
  try {
    const parsed = JSON.parse(readFileSync(url, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { baseVersion, interfaceVersion } = parsed
    if (typeof baseVersion !== 'string' || baseVersion === '') return undefined
    if (!Number.isInteger(interfaceVersion) || interfaceVersion <= 0) return undefined
    return { baseVersion, interfaceVersion }
  } catch {
    return undefined
  }
}
