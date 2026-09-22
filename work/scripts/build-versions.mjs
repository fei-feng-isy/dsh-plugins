#!/usr/bin/env node
/**
 * Bake the exact versions of the LINKED dsh packages next to the built entry, so the startup
 * compatibility gate's `declared` side is what `tsc` compiled against rather than a peer range's floor.
 *
 *   node scripts/build-versions.mjs     # writes packages/plugin/lib/dsh-build.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The gate's file name, mirroring `@avantf/dsh-plugin-base`'s `BUILD_VERSIONS_FILE`. */
export const BUILD_VERSIONS_FILE = 'dsh-build.json'

export const LINKED_DSH_DIR = join(repo, 'packages', 'plugin', 'node_modules', '@deepseek-ai')

export const PLUGIN_LIB_DIR = join(repo, 'packages', 'plugin', 'lib')

/**
 * Read the versions of the linked `@deepseek-ai/dsh-*` packages, or `undefined` when nothing is linked:
 * every `dsh-*` entry is recorded, not a hand-kept list, so this cannot drift from the plugin's `VERSION_PACKAGES`.
 */
export function readLinkedVersions(dir = LINKED_DSH_DIR) {
  if (!existsSync(dir)) return undefined
  const versions = {}
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (!entry.name.startsWith('dsh-')) continue
    const manifest = join(dir, entry.name, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof parsed.version === 'string' && parsed.version !== '') {
        versions[`@deepseek-ai/${entry.name}`] = parsed.version
      }
    } catch {
      // An unreadable peer manifest is skipped, not fatal: the gate falls back per package.
    }
  }
  return versions
}

/** Write the baked version file; throws when the peers are not linked, because an empty file would turn the declared side into "unknown" for every package. */
export function writeBuildVersions(input = {}) {
  const linked = input.linked ?? LINKED_DSH_DIR
  const dir = input.dir ?? PLUGIN_LIB_DIR
  const versions = readLinkedVersions(linked)
  if (versions === undefined) {
    throw new Error(`the DSH peers are not linked at ${linked}; run scripts/link-dsh.mjs first`)
  }
  mkdirSync(dir, { recursive: true })
  const file = join(dir, input.file ?? BUILD_VERSIONS_FILE)
  writeFileSync(file, `${JSON.stringify(versions, null, 2)}\n`)
  return { file, versions }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { file, versions } = writeBuildVersions()
    console.log(`build-versions: baked ${String(Object.keys(versions).length)} linked dsh version(s) into ${file}`)
    for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol']) {
      if (versions[name] !== undefined) console.log(`  ${name} ${versions[name]}`)
    }
  } catch (error) {
    console.error(`build-versions: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
