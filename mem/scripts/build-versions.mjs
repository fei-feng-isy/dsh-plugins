#!/usr/bin/env node
/**
 * Bake the exact versions of the LINKED dsh packages next to the built entry (`lib/dsh-build.json`).
 *
 *   node scripts/build-versions.mjs     # writes packages/plugin/lib/dsh-build.json
 *
 * The implementation (link reading, the file name, the bake) lives in `scripts/lib/build-versions.mjs`
 * so this tree and `mission/` cannot drift; this file binds it to `mem/packages/plugin` and stays the
 * module `scripts/link-dsh.mjs` imports.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain, makeBuildVersions } from '../../scripts/lib/build-versions.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const versions = makeBuildVersions(repo)

export const BUILD_VERSIONS_FILE = versions.BUILD_VERSIONS_FILE
/** Where `scripts/link-dsh.mjs` puts the `@deepseek-ai/*` links this build compiles against. */
export const LINKED_DSH_DIR = versions.LINKED_DSH_DIR
/** Where the node half is emitted (`lib/index.js` is the bundle that reads its neighbour). */
export const PLUGIN_LIB_DIR = versions.PLUGIN_LIB_DIR
export const readLinkedVersions = versions.readLinkedVersions
export const writeBuildVersions = versions.writeBuildVersions

// Only when run directly: link-dsh.mjs imports the helpers above and calls its own write.
if (isMain(process.argv[1], import.meta.url)) versions.runCli()
