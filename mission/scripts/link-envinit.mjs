#!/usr/bin/env node
/**
 * Vendor `@avantf/dsh-plugin-base`'s bootstrap into this plugin, from the base the plugin loads.
 *
 * The implementation (source resolution, the workspace boundary, the byte-for-byte drift check, the
 * peer-range check and the interface bake) lives in `scripts/lib/link-envinit.mjs`, shared with
 * `mem/`; this file binds it to `mission/`.
 *
 *   node scripts/link-envinit.mjs            # vendor from the workspace link (or the DSH_ENVINIT opt-in)
 *   node scripts/link-envinit.mjs --check    # verify only, change nothing
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLinkEnvinit } from '../../scripts/lib/link-envinit.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.exitCode = await runLinkEnvinit({ repo })
