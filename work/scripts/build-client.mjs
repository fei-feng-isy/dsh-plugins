#!/usr/bin/env node
/**
 * Build the browser half into the one artifact a DSH client assembly loads.
 *
 * DSH's own client preset reverse-looks-up its target by globbing the harness workspace and refuses a
 * package it cannot find, so the bundle is built here with esbuild: CommonJS wrapped in the shell's
 * `window.__ModuleLoader__.load({ id, factory })` preamble, shell-seeded modules external, everything
 * else inlined. Output: `lib/client.js`.
 *
 *   node scripts/build-client.mjs [--check]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')

const PLUGIN_ID = '@avantf/dsh-work'

/**
 * Modules the browser shell provides (mirrors the harness's `PLATFORM_MODULES`). These MUST stay
 * external: a bundled React would be a second React instance and a bundled `ui-slots` a second slot
 * registry — the same module-identity trap, here breaking the running app.
 */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const entry = join(pluginDir, 'src', 'client', 'index.ts')
const outfile = join(pluginDir, 'lib', 'client.js')

if (!existsSync(entry)) {
  console.error(`build-client: missing entry ${entry}`)
  process.exit(1)
}
mkdirSync(dirname(outfile), { recursive: true })

const bundlePath = join(pluginDir, 'lib', 'client.bundle.cjs')
const esbuild = join(pluginDir, 'node_modules', '.bin', 'esbuild')

const result = spawnSync(
  esbuild,
  [
    entry,
    '--bundle',
    '--format=cjs',
    '--platform=browser',
    '--target=es2022',
    '--jsx=automatic',
    `--outfile=${bundlePath}`,
    '--log-level=warning',
    ...EXTERNAL.map((name) => `--external:${name}`),
  ],
  { cwd: pluginDir, stdio: 'inherit', env: process.env },
)
if (result.error) {
  console.error(`build-client: cannot run esbuild (${result.error.message})`)
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status ?? 1)

// Wrap in the shell's loader preamble: esbuild's CJS output assigns `module.exports`, so the wrapper
// must declare that module and return it, or the bundle throws `module is not defined` inside the factory.
const body = readFileSync(bundlePath, 'utf8')
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {\n`
  + 'var module = { exports: {} }; var exports = module.exports;\n'
const footer = '\nreturn module.exports; } });\n'
writeFileSync(outfile, `${banner}${body}${footer}`, 'utf8')

// The intermediate keeps the source map honest; it is not shipped.
spawnSync('rm', ['-f', bundlePath])

const bytes = readFileSync(outfile).length
console.log(`build-client: ${outfile} (${String(bytes)} bytes, ${String(EXTERNAL.length)} externals)`)

if (process.argv.includes('--check')) {
  const check = spawnSync(process.execPath, [join(repo, 'scripts', 'client-smoke.mjs')], {
    cwd: repo,
    stdio: 'inherit',
    env: process.env,
  })
  process.exit(check.status ?? 1)
}
