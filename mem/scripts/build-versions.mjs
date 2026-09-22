#!/usr/bin/env node
/**
 * Bake the exact versions of the LINKED dsh packages next to the built entry.
 *
 * The startup gate compares two versions, and both are about the same thing: **this artifact and the
 * dsh its links point at**. The `runtime` side resolves those links at startup; the `declared` side
 * must be frozen at BUILD time, or it degrades into a peer range's floor — a lower bound the artifact
 * tolerates, which says nothing about the copy `tsc` actually compiled against. After an in-place
 * upgrade of the installed dsh, a floor therefore produces a weak, half-true warning. This script
 * removes the guess: it reads the versions straight off the links `scripts/link-dsh.mjs` just made and
 * writes them to `packages/plugin/lib/dsh-build.json`, where
 * `@avantf/dsh-plugin-base`'s `readBuildVersions()` reads them back from the bundled `lib/index.js`
 * (`import.meta.url` names the bundle, so `./dsh-build.json` sits beside it).
 *
 * `packages/plugin/package.json` ships `files: ["lib"]`, so the JSON travels with the published
 * package automatically — `scripts/pack-plugin.mjs` needs no special case for it. The tsdown preset
 * bundling the node half runs with `clean: false`, so a file written before the bundle survives it;
 * this script runs after linking and is safe to re-run after the compile.
 *
 * A missing file is not a failure at runtime — the gate falls back per package to the peer floors —
 * but writing one here is what makes the version line mean "the dsh I was built against".
 *
 *   node scripts/build-versions.mjs     # writes packages/plugin/lib/dsh-build.json
 *
 * Also importable: `writeBuildVersions()` / `readLinkedVersions()` are used by `link-dsh.mjs`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The gate's file name, mirroring `@avantf/dsh-plugin-base`'s `BUILD_VERSIONS_FILE`. */
export const BUILD_VERSIONS_FILE = 'dsh-build.json'

/** Where `scripts/link-dsh.mjs` puts the `@deepseek-ai/*` links this build compiles against. */
export const LINKED_DSH_DIR = join(repo, 'packages', 'plugin', 'node_modules', '@deepseek-ai')

/** Where the node half is emitted (`lib/index.js` is the bundle that reads its neighbour). */
export const PLUGIN_LIB_DIR = join(repo, 'packages', 'plugin', 'lib')

/**
 * Read the versions of the linked `@deepseek-ai/dsh-*` packages.
 *
 * Every `dsh-*` entry is recorded, not a hand-kept list of two: which packages the gate compares is
 * the PLUGIN's declaration (`provision.ts` → `VERSION_PACKAGES`), and a stale copy of that list here
 * would silently weaken the comparison. Baking the whole linked set keeps the two from drifting.
 * @param dir - the linked `@deepseek-ai` directory.
 * @returns package → version, or `undefined` when the directory does not exist (nothing is linked).
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

/**
 * Write the baked version file. Throws when the peers are not linked, because writing an empty file
 * would silently turn the declared side into "unknown" for every package.
 * @param input - overrides for tests / alternate layouts.
 * @returns the file written and the versions in it.
 */
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

// Only when run directly: link-dsh.mjs imports the helpers above and calls its own write.
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
