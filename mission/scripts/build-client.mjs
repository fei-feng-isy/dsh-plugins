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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')

const PLUGIN_ID = '@avantf/dsh-mission'

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
const metaPath = join(pluginDir, 'lib', 'client.meta.json')
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
    // Minified: the browser reads this file on every page load and the host's client assembly
    // re-processes it. Measured 899 KB → 534 KB (uncompressed) on 2026-10-03, then 535 KB → 171 KB
    // once zod's locale namespace was tree-shaken (namespace imports in src/wire.ts / src/domain.ts;
    // the assertion below keeps it that way) — see `docs/review/2026-10-03-performance-review.md` §7.2.
    '--minify',
    `--outfile=${bundlePath}`,
    // A metafile, not a hand-written mirror: it names every file that went INTO the bundle, which is
    // the only way to see a shell module that should have been external but was inlined instead.
    `--metafile=${metaPath}`,
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

// The intermediate keeps the source map honest; it is not shipped. `rmSync`, not `spawnSync('rm')`:
// the exit code of that spawn was ignored, so on a machine without `rm` the `.cjs` stayed behind —
// and `pack-plugin` asserts there are no unreferenced files under `lib/` that the tarball would carry.
rmSync(bundlePath, { force: true })

// ── the shell modules must all still be EXTERNAL ─────────────────────────────
// `EXTERNAL` above is a hand-written mirror of the shell's platform module table. If the client imports
// a shell package that is NOT listed, esbuild inlines it, and the bundle then carries a SECOND React /
// slot registry / cordis — the module-identity trap, which `client-smoke` cannot see because it only
// stubs the `require` form. The metafile is the direct evidence, and the rule needs no list: this
// browser half may never inline a package the shell provides.
const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
rmSync(metaPath, { force: true })
const SHELL_PACKAGE = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@deepseek-ai|react|react-dom)(?:\/|$)/u
const inlined = Object.keys(meta.inputs ?? {}).filter((input) => SHELL_PACKAGE.test(input))
if (inlined.length > 0) {
  console.error('build-client: shell module(s) were INLINED instead of staying external:')
  for (const input of inlined.slice(0, 10)) console.error(`  ${input}`)
  console.error('  add the package(s) they belong to to EXTERNAL in this script (a second React or slot')
  console.error('  registry breaks the running app in ways the smoke cannot catch)')
  process.exit(1)
}

// ── zod's locale files must stay tree-shaken OUT of the browser bundle ───────
// WHY THIS ASSERTION EXISTS: zod's entry point re-exports `locales` as a namespace. A NAMED import
// (`import { z } from 'zod'`) made esbuild materialise all of them — measured 2026-10-03, 64 locale
// files = 264 KB minified = 49% of a 535 KB bundle (95 zod inputs in total). A NAMESPACE import
// (`import * as z from 'zod'`, the form in `src/domain.ts` / `src/wire.ts`) lets them be tree-shaken:
// 171 KB, one locale input. The default English locale (`en.js`, ~2.7 KB) is a real dependency of
// zod's error messages, so it is the only one allowed. Without this check a later zod or esbuild
// upgrade could silently restore the other 63 and nothing else in the build would notice — the bundle
// would just be 3× again.
//
// It reads the PER-OUTPUT `inputs`, not the top-level `meta.inputs`: the latter is every file esbuild
// SCANNED, including ones it then shook to zero bytes (a locale that is tree-shaken out still appears
// there). The output's `inputs` (with `bytesInOutput`) is what actually made it into the artifact.
const outputs = Object.values(meta.outputs ?? {})
const bundleInputs = outputs.length > 0
  ? Object.assign({}, ...outputs.map((output) => output.inputs ?? {}))
  : (meta.inputs ?? {})
const ZOD_LOCALE = /(?:^|\/)zod\/v\d+\/locales\/([^/]+)\.js$/u
const DEFAULT_ZOD_LOCALES = new Set(['en'])
const localeInputs = Object.keys(bundleInputs)
  .map((input) => input.replace(/\\/gu, '/'))
  .map((input) => [input, ZOD_LOCALE.exec(input)])
  .filter(([, match]) => match !== null)
const extraLocales = localeInputs.filter(([, match]) => !DEFAULT_ZOD_LOCALES.has(match[1]))
if (extraLocales.length > 0) {
  console.error('build-client: zod locale files were INLINED into the browser bundle:')
  for (const [input] of extraLocales.slice(0, 10)) console.error(`  ${input}`)
  console.error(`  ${String(extraLocales.length)} non-default locale file(s); only en.js is expected.`)
  console.error('  why this matters: the full locale set is ~264 KB of the ~535 KB bundle — a 3× regression')
  console.error('  on every page load. It is pulled in by a NAMED `import { z } from \'zod\'`; the import')
  console.error('  in src/domain.ts and src/wire.ts must stay `import * as z from \'zod\'` (namespace).')
  console.error('  if zod/esbuild just changed its layout, re-run esbuild with --metafile and inspect the')
  console.error('  inputs before relaxing this assertion.')
  process.exit(1)
}

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
