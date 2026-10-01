#!/usr/bin/env node
/**
 * Bake the exact versions of the LINKED dsh packages next to the built entry, so the startup
 * compatibility gate's `declared` side is what `tsc` compiled against rather than a peer range's floor.
 *
 *   node scripts/build-versions.mjs     # writes packages/plugin/lib/dsh-build.json
 *
 * The implementation lives in `scripts/lib/build-versions.mjs` (shared with `mem/`); this file binds
 * it to `mission/packages/plugin`.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain, makeBuildVersions } from '../../scripts/lib/build-versions.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const versions = makeBuildVersions(repo)

export const BUILD_VERSIONS_FILE = versions.BUILD_VERSIONS_FILE
export const LINKED_DSH_DIR = versions.LINKED_DSH_DIR
export const PLUGIN_LIB_DIR = versions.PLUGIN_LIB_DIR
export const readLinkedVersions = versions.readLinkedVersions
export const writeBuildVersions = versions.writeBuildVersions

if (isMain(process.argv[1], import.meta.url)) versions.runCli()
