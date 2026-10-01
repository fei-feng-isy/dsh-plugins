#!/usr/bin/env node
/**
 * Link the DSH peer packages into this plugin's `packages/plugin/node_modules` — from the INSTALLED
 * dsh, and nowhere else: the plugin is installed into a profile as a `link:` dependency, so these
 * links are both the compilation target and the runtime identity the live host shares, and no harness
 * source checkout is read.
 *
 * The shared implementation (source resolution, the fail-closed missing-peer policy, the version
 * bake) lives in `scripts/lib/link-dsh.mjs`; this entry supplies mission's peer list. Toolchain
 * packages (`typescript` / `vitest`) and `zod` come from the workspace install; `zod` is pinned in
 * `pnpm-workspace.yaml` to the release the installed dsh ships, because
 * `@deepseek-ai/dsh-storage-domain` types its record schemas with its own zod.
 *
 *   node scripts/link-dsh.mjs                  # the globally installed dsh
 *   node scripts/link-dsh.mjs --runtime <dir>  # an explicit installation
 *   node scripts/link-dsh.mjs --no-bake        # link only; do not write the "compiled against" record
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLinkDsh } from '../../scripts/lib/link-dsh.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every `@deepseek-ai/*` package this plugin imports. */
const LINKS = [
  'cordis',
  'cordis-plugin-timer',
  'schemastery',
  'dsh-tools',
  'dsh-system-prompt',
  'dsh-agent',
  'dsh-session',
  'dsh-commands',
  'dsh-storage',
  'dsh-storage-domain',
  'dsh-subagent',
  'dsh-spill',
  'dsh-typert-protocol',
  'dsh-typert-registry',
  'dsh-session-query',
  'dsh-llm',
  'dsh-brand',
  'dsh-util-values',
]

runLinkDsh({
  repo,
  links: LINKS,
  bakeNote: '(the compatibility gate\'s "compiled against" side)',
})
