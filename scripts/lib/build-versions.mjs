#!/usr/bin/env node
/**
 * Bake the exact versions of the LINKED dsh packages next to the built entry — ONE implementation
 * for every plugin tree.
 *
 * The startup gate compares two versions, and both are about the same thing: **this artifact and the
 * dsh its links point at**. The `runtime` side resolves those links at startup; the `declared` side
 * must be frozen at BUILD time, or it degrades into a peer range's floor — a lower bound the artifact
 * tolerates, which says nothing about the copy `tsc` actually compiled against. After an in-place
 * upgrade of the installed dsh, a floor therefore produces a weak, half-true warning. This removes
 * the guess: it reads the versions straight off the links `scripts/link-dsh.mjs` just made and writes
 * them to `packages/plugin/lib/dsh-build.json`, where `@avantf/dsh-plugin-base`'s
 * `readBuildVersions()` reads them back from the bundled `lib/index.js` (`import.meta.url` names the
 * bundle, so `./dsh-build.json` sits beside it).
 *
 * `packages/plugin/package.json` ships `files: ["lib"]`, so the JSON travels with the published
 * package automatically — `pack-plugin` needs no special case for it. A bundling pass that runs with
 * `clean: false` leaves a file written before it alone; a `tsc`-only tree copies it forward.
 *
 * A missing file is not a failure at runtime — the gate falls back per package to the peer floors —
 * but writing one here is what makes the version line mean "the dsh I was built against".
 *
 * The two plugin trees used to carry a byte-identical copy of this script each (only the comments
 * differed); it lives in `scripts/lib/` because the boundary guard allows a subtree to reach that
 * directory and nothing else outside itself. Each tree's `scripts/build-versions.mjs` is a thin entry
 * that binds {@link makeBuildVersions} to its own repo root.
 *
 * Every `dsh-*` entry is recorded, not a hand-kept list: which packages the gate COMPARES is the
 * plugin's own declaration (`VERSION_PACKAGES`), and a stale copy of that list here would silently
 * weaken the comparison. Baking the whole linked set keeps the two from drifting.
 *
 * @module scripts/lib/build-versions
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The gate's file name, mirroring `@avantf/dsh-plugin-base`'s `BUILD_VERSIONS_FILE`. */
export const BUILD_VERSIONS_FILE = 'dsh-build.json'

/**
 * The two package-relative directories a plugin build cares about: where `link-dsh` put the
 * `@deepseek-ai/*` links it compiles against, and where the node half is emitted.
 * @param repo - the plugin tree root (`<repo>/mem` or `<repo>/mission`).
 */
export function buildVersionsPaths(repo) {
  return {
    linked: join(repo, 'packages', 'plugin', 'node_modules', '@deepseek-ai'),
    lib: join(repo, 'packages', 'plugin', 'lib'),
  }
}

/**
 * Read the versions of the linked `@deepseek-ai/dsh-*` packages.
 * @param dir - the linked `@deepseek-ai` directory.
 * @returns package → version, or `undefined` when the directory does not exist (nothing is linked).
 */
export function readLinkedVersions(dir) {
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
 * @param input - `linked` (the `@deepseek-ai` link dir) and `dir` (the plugin's `lib/`) are required;
 *   `file` defaults to {@link BUILD_VERSIONS_FILE}.
 * @returns the file written and the versions in it.
 */
export function writeBuildVersions({ linked, dir, file = BUILD_VERSIONS_FILE } = {}) {
  if (linked === undefined || dir === undefined) {
    throw new Error('writeBuildVersions: needs both `linked` and `dir`')
  }
  const versions = readLinkedVersions(linked)
  if (versions === undefined) {
    throw new Error(`the DSH peers are not linked at ${linked}; run scripts/link-dsh.mjs first`)
  }
  mkdirSync(dir, { recursive: true })
  const target = join(dir, file)
  writeFileSync(target, `${JSON.stringify(versions, null, 2)}\n`)
  return { file: target, versions }
}

/**
 * Bind the module to ONE tree: this is what a tree's thin `scripts/build-versions.mjs` re-exports,
 * and what `scripts/link-dsh.mjs` calls when it bakes what it just linked.
 * @param repo - the plugin tree root.
 */
export function makeBuildVersions(repo) {
  const { linked, lib } = buildVersionsPaths(repo)
  return {
    BUILD_VERSIONS_FILE,
    LINKED_DSH_DIR: linked,
    PLUGIN_LIB_DIR: lib,
    readLinkedVersions: (dir = linked) => readLinkedVersions(dir),
    writeBuildVersions: (input = {}) => writeBuildVersions({
      linked: input.linked ?? linked,
      dir: input.dir ?? lib,
      file: input.file ?? BUILD_VERSIONS_FILE,
    }),
    /** The standalone CLI (`node scripts/build-versions.mjs`): bake, print, exit 1 on failure. */
    runCli() {
      try {
        const { file, versions } = this.writeBuildVersions()
        console.log(`build-versions: baked ${String(Object.keys(versions).length)} linked dsh version(s) into ${file}`)
        for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol']) {
          if (versions[name] !== undefined) console.log(`  ${name} ${versions[name]}`)
        }
      } catch (error) {
        console.error(`build-versions: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    },
  }
}

/** Whether `argv1` names `moduleUrl` — i.e. this module is the process entry point, not an import. */
export function isMain(argv1, moduleUrl) {
  return argv1 !== undefined && resolve(argv1) === fileURLToPath(moduleUrl)
}
