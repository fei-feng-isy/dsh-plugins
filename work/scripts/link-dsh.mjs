#!/usr/bin/env node
/**
 * Link the DSH peer packages into the plugin's node_modules — from the INSTALLED dsh, and nowhere else:
 * the plugin is installed into a profile as a `link:` dependency, so these links are both the compilation
 * target and the runtime identity the live host shares, and no harness source checkout is read.
 *
 *   node scripts/link-dsh.mjs                  # the globally installed dsh
 *   node scripts/link-dsh.mjs --runtime <dir>  # an explicit installation
 *   node scripts/link-dsh.mjs --no-bake        # link only; do not write the "compiled against" record
 *
 * `--no-bake` is for callers that LINK but do not COMPILE (`typecheck.mjs`, `link-profile.mjs`): a run that
 * emits nothing must not re-certify a stale `lib/index.js` against a dsh it was never compiled with. Toolchain
 * packages (`typescript` / `vitest`) and `zod` come from the workspace install; `zod` is pinned in
 * `pnpm-workspace.yaml` to the release the installed dsh ships, because `@deepseek-ai/dsh-storage-domain`
 * types its record schemas with its own zod.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeBuildVersions } from './build-versions.mjs'

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

const args = process.argv.slice(2)
const runtimeIndex = args.indexOf('--runtime')
/** Flags that take no value; keep in step with the usage block at the top. */
const FLAGS = ['--runtime', '--no-bake']
for (const [index, arg] of args.entries()) {
  // `--runtime` takes one optional positional directory; everything else is a flag.
  if (arg.startsWith('--') && !FLAGS.includes(arg)) {
    console.error(`link-dsh: unknown option ${arg}`)
    process.exit(2)
  }
  if (!arg.startsWith('--') && args[index - 1] !== '--runtime') {
    console.error(`link-dsh: unexpected argument ${arg}`)
    process.exit(2)
  }
}

const arg = runtimeIndex >= 0 ? args[runtimeIndex + 1] : undefined
let source
if (arg !== undefined && !arg.startsWith('--')) {
  source = arg.endsWith('@deepseek-ai') ? arg : join(arg, 'node_modules', '@deepseek-ai')
} else {
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
    source = join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
  } catch {
    console.error('link-dsh: cannot discover the global npm root; pass --runtime <dshDir>')
    process.exit(1)
  }
}
if (!existsSync(source)) {
  console.error(`link-dsh: installed dsh packages not found at ${source}`)
  console.error('  install it first: npm i -g @deepseek-ai/dsh')
  process.exit(1)
}
console.log(`installed dsh: ${source}`)

const target = join(repo, 'packages', 'plugin', 'node_modules', '@deepseek-ai')
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

let linked = 0
let firstLinked
for (const pkg of LINKS) {
  const from = join(source, pkg)
  if (!existsSync(from)) {
    console.warn(`link-dsh: skip @deepseek-ai/${pkg} (not found at ${from})`)
    continue
  }
  const to = join(target, pkg)
  symlinkSync(from, to, 'dir')
  firstLinked ??= to
  linked += 1
}

console.log(`link-dsh: linked ${String(linked)} package(s) into packages/plugin/node_modules`)
if (firstLinked !== undefined) console.log(`  ${readlinkSync(firstLinked)}`)

// Bake what was just linked: these ARE the versions this build compiles against, and the gate's
// `declared` side must be that exact set rather than a peer range's floor (a failure here is only a
// warning — without the file the gate falls back to the floors).
//
// Only when the caller actually compiles: a link-only run (`--no-bake`) must not date the record to a
// run that produced no artifact, or a stale `lib/index.js` would report `compat: ok` against a dsh it was never compiled with.
if (process.argv.includes('--no-bake')) {
  console.log('link-dsh: --no-bake — left the baked build versions untouched (this run emits no artifact)')
} else {
  try {
    const { file, versions } = writeBuildVersions()
    console.log(
      `build-versions: baked ${String(Object.keys(versions).length)} linked dsh version(s) into ${file}`
      + ' (the compatibility gate\'s "compiled against" side)',
    )
  } catch (error) {
    console.warn(`link-dsh: could not bake the linked versions (${error instanceof Error ? error.message : String(error)})`)
  }
}
