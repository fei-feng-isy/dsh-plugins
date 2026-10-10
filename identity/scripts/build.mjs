#!/usr/bin/env node
/**
 * Build `@avantf/dsh-identity`:
 *
 *   1. `tsc` the plugin (src → `lib/`, declarations → `lib/types/`);
 *   2. copy the vendored bootstrap into `lib/` (it is a copied file the entry imports relatively, so
 *      a build can never inline a bootstrap other than the base it was checked against);
 *   3. copy the built-in preset assets into `lib/assets/` — the only shape in which they BOTH ship
 *      (`files: ["lib"]`) and can be located with `new URL('./assets/…', import.meta.url)`;
 *   4. bundle the host entry with esbuild so `lib/index.js` is self-contained apart from the
 *      framework's copied bootstrap (the release gates read THAT file, not a sibling-importing tsc
 *      emit).
 *
 * `--typecheck` runs step 1 only, with `--noEmit` for the plugin and a second pass over
 * `tsconfig.test.json` (tests are transpiled without type-checking by vitest, so this is the only
 * place their types are verified).
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readBootstrapVersion } from '../../scripts/lib/bootstrap-version.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const check = process.argv.includes('--typecheck')

/**
 * Launch one `node_modules/.bin` tool. POSIX installs a `.bin/tsc` you can exec directly; on Windows
 * the runnable launchers are `tsc.cmd` / `tsc.ps1`, and Node refuses to spawn a `.cmd`/`.bat` without
 * a shell (CVE-2024-27980), so the win32 shape names `<name>.cmd` and asks for the shell.
 */
export function binLaunch(dir, name, args, platform = process.platform) {
  const shim = join(dir, 'node_modules', '.bin', name)
  if (platform !== 'win32') return { command: shim, args, options: {} }
  return { command: quoteForCmd(`${shim}.cmd`), args: args.map(quoteForCmd), options: { shell: true } }
}

/** Best-effort `cmd.exe` quoting for one argument of a `shell: true` line. */
export function quoteForCmd(arg) {
  return /[\s"&|<>^()]/u.test(arg) ? `"${arg.replace(/"/gu, '""')}"` : arg
}

function compile(project, noEmit) {
  const args = ['-p', join(pluginDir, project), ...(noEmit ? ['--noEmit'] : [])]
  const launch = binLaunch(pluginDir, 'tsc', args)
  const result = spawnSync(launch.command, launch.args, { ...launch.options, cwd: pluginDir, stdio: 'inherit', env: process.env })
  if (result.error) {
    console.error(`  cannot run ${launch.command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/**
 * Stale output is not cosmetic: `lib/types` is inside the tarball's `files`, and `tsc` never removes a
 * file whose source is gone — so a renamed declaration would ship forever. Only what this build
 * regenerates is removed: NOT the whole `lib/`, which also holds `lib/client.js` (the browser half,
 * built separately) and the previous host bundle `bundleHost` replaces.
 */
function cleanGenerated() {
  for (const entry of ['types', 'index.js.map']) {
    rmSync(join(pluginDir, 'lib', entry), { recursive: true, force: true })
  }
}

/**
 * The framework's `bootstrap.js` is a copied file imported by relative path; it must match the
 * framework it was linked against, or a build inlines a different version than the one it was
 * checked with.
 */
function copyVendoredBootstrap() {
  const source = join(pluginDir, 'src', 'envinit-bootstrap.js')
  const target = join(pluginDir, 'lib', 'envinit-bootstrap.js')
  if (!existsSync(source)) {
    console.error(`  missing vendored bootstrap ${source} — run: node scripts/link-envinit.mjs`)
    process.exit(1)
  }
  const vendored = readBootstrapVersion(source)
  // Not skippable: an unlinked peer would silently disable the check that a build never inlines a
  // bootstrap other than the framework it was checked against.
  const linked = join(pluginDir, 'node_modules', '@avantf', 'dsh-plugin-base', 'package.json')
  if (!existsSync(linked)) {
    console.error(`  cannot verify the vendored bootstrap: @avantf/dsh-plugin-base is not installed at ${linked}`)
    console.error('  fix: pnpm install')
    process.exit(1)
  }
  const version = JSON.parse(readFileSync(linked, 'utf8')).version
  if (vendored !== version) {
    console.error(`  vendored bootstrap is ${String(vendored)} but @avantf/dsh-plugin-base is ${version}`)
    console.error('  re-vendor: node scripts/link-envinit.mjs')
    process.exit(1)
  }
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  console.log(`\n▶ inline bootstrap ${String(vendored)} → packages/plugin/lib/envinit-bootstrap.js`)
}

/**
 * The built-in presets, copied (not imported) so they ship in the tarball and are locatable from the
 * built entry. Rebuilt from scratch: a preset deleted from `assets/` must not keep shipping.
 */
function copyAssets() {
  const source = join(pluginDir, 'assets', 'presets')
  const target = join(pluginDir, 'lib', 'assets', 'presets')
  if (!existsSync(source)) {
    console.error(`  missing preset assets ${source} — the package cannot ship without its built-in presets`)
    process.exit(1)
  }
  console.log('\n▶ copy built-in presets → packages/plugin/lib/assets/presets')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
}

/**
 * Inline everything but the framework's copied bootstrap, so `lib/index.js` is the self-contained
 * artifact the host loads (`prove-base-swap` refuses a tsc emit that imports siblings). Everything
 * the PROFILE owns stays external — a bundled cordis / schemastery / zod would be a second identity
 * in the host; `import.meta.url` survives because modules are emitted FLAT into `lib/`, which is what
 * keeps `./assets/presets` pointing at `lib/assets/presets`.
 */
function bundleHost() {
  const entry = join(pluginDir, 'lib', 'index.js')
  const bundle = join(pluginDir, 'lib', 'index.bundle.js')
  const externals = ['@deepseek-ai/*', 'zod', '@avantf/dsh-plugin-base', './envinit-bootstrap.js']
  console.log('\n▶ bundle the host entry (self-contained apart from the copied bootstrap)')
  const launch = binLaunch(pluginDir, 'esbuild', [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=es2022',
    // esbuild's default `charset=ascii` escapes the Chinese preset text to `\uXXXX`: runtime-identical,
    // but the artifact turns unreadable and `grep` can no longer find the prompt it carries.
    '--charset=utf8',
    `--outfile=${bundle}`,
    '--log-level=warning',
    ...externals.map((name) => `--external:${name}`),
  ])
  const result = spawnSync(launch.command, launch.args, { ...launch.options, cwd: pluginDir, stdio: 'inherit', env: process.env })
  if (result.error) {
    console.error(`  cannot run ${launch.command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
  // Replace the entry only once the bundle exists: a failed bundling must not leave the artifact
  // pointing at a half-written file.
  renameSync(bundle, entry)
  console.log(`  ${entry} (self-contained)`)
}

function main() {
  if (!check) cleanGenerated()

  console.log(`\n▶ ${check ? 'typecheck' : 'build'} @avantf/dsh-identity (plugin)`)
  compile('tsconfig.json', check)
  if (check) {
    console.log('\n▶ typecheck @avantf/dsh-identity (tests)')
    compile('tsconfig.test.json', true)
  }

  if (!check) {
    copyVendoredBootstrap()
    copyAssets()
    bundleHost()
  }

  console.log(`\n${check ? 'typecheck' : 'build'}: ok`)
}

// Only run when executed as a script: importing this file must not build.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
