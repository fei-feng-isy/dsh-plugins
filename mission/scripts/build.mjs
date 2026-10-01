#!/usr/bin/env node
/**
 * Build the workspace in dependency order: `@avantf/mission-core` emits declarations first because the
 * plugin type-checks against them (`lib/types` does not exist until the core has been built), then
 * the plugin compiles. `--typecheck` runs the same order, still emitting the core, with `--noEmit`
 * for the plugin.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readBootstrapVersion } from '../../scripts/lib/bootstrap-version.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--typecheck')
const packages = ['core', 'plugin']

function compile(dir, project, noEmit) {
  const args = ['-p', join(dir, project), ...(noEmit ? ['--noEmit'] : [])]
  const launch = binLaunch(dir, 'tsc', args)
  const result = spawnSync(launch.command, launch.args, { ...launch.options, cwd: dir, stdio: 'inherit', env: process.env })
  if (result.error) {
    console.error(`  cannot run ${launch.command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

/**
 * Stale output is not cosmetic. `lib/types` and `lib/mission-core` are inside the tarball's `files`, and
 * `tsc` never removes a file whose source is gone — so a renamed declaration would ship forever. Only
 * what this build regenerates is removed: NOT the whole `lib/`, which also holds `lib/client.js` (the
 * browser half, built separately) and the previous host bundle that `bundleHost` replaces.
 */
function cleanGenerated() {
  const lib = join(repo, 'packages', 'plugin', 'lib')
  for (const entry of ['types', 'mission-core', 'index.js.map']) {
    rmSync(join(lib, entry), { recursive: true, force: true })
  }
}

/**
 * Launch one `node_modules/.bin` tool on `platform`.
 *
 * POSIX installs a `.bin/tsc` you can exec directly (a sh shim that `exec`s the real JS entry). On
 * Windows the same path is that sh script — the runnable launchers are `tsc.cmd` / `tsc.ps1` — and
 * since CVE-2024-27980 Node REFUSES to spawn a `.cmd`/`.bat` without a shell (EINVAL), so a failed
 * build there read as a terminal "cannot run …\\.bin\\tsc". Naming `<name>.cmd` AND asking for the
 * shell is the fix; both halves are a function of an INJECTED platform, so the win32 shape is
 * asserted from Linux (`[win]` — a real Windows box still has to confirm it launches).
 *
 * `shell: true` hands the whole line to `cmd.exe`, which does not quote arguments for us: a
 * workspace under `C:\\Users\\Foo Bar\\…` would otherwise split at the space, so win32 args go
 * through {@link quoteForCmd}.
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

function main() {
  if (!check) cleanGenerated()

  for (const name of packages) {
    const dir = join(repo, 'packages', name)
    console.log(`\n▶ ${check ? 'typecheck' : 'build'} @avantf/mission-${name}`)
    // Core emits even under --typecheck: the plugin resolves `@avantf/mission-core` to core's emitted declarations, so `--noEmit` here would check it against a stale core.
    compile(dir, 'tsconfig.json', check && name !== 'core')
    if (check) {
      // Tests are transpiled without type-checking by vitest, so this is the only place their types are verified.
      console.log(`\n▶ typecheck @avantf/mission-${name} (tests)`)
      compile(dir, 'tsconfig.test.json', true)
    }
  }

  if (!check) {
    copyVendoredBootstrap()
    bundleHost()
    inlineCoreTypes()
  }

  console.log(`\n${check ? 'typecheck' : 'build'}: ok`)
}

/**
 * The plugin is `tsc`-only, so the framework's `bootstrap.js` is a copied file imported by relative
 * path; it must match the framework it was linked against, or a build inlines a different version
 * than the one it was checked with.
 */
function copyVendoredBootstrap() {
  const pluginDir = join(repo, 'packages', 'plugin')
  const source = join(pluginDir, 'src', 'envinit-bootstrap.js')
  const target = join(pluginDir, 'lib', 'envinit-bootstrap.js')
  if (!existsSync(source)) {
    console.error(`  missing vendored bootstrap ${source} — run: node scripts/link-envinit.mjs`)
    process.exit(1)
  }
  const vendored = readBootstrapVersion(source)
  // Not skippable: an unlinked peer would silently disable the check that a build never inlines a bootstrap other than the framework it was checked against.
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
 * Inline `@avantf/mission-core` into the host entry so the artifact carries no runtime dependency:
 * `dependencies` is empty by design, so a leftover import of it would be unresolvable in a tarball
 * installed elsewhere. Everything the PROFILE owns stays external — a bundled cordis / schemastery /
 * zod would be a second identity in the host, and `./envinit-bootstrap.js` must stay the copied file
 * `pack-plugin` asserts; `import.meta.url` survives because modules are emitted FLAT into `lib/`.
 */
function bundleHost() {
  const pluginDir = join(repo, 'packages', 'plugin')
  const entry = join(pluginDir, 'lib', 'index.js')
  const bundle = join(pluginDir, 'lib', 'index.bundle.js')
  const externals = ['@deepseek-ai/*', 'zod', '@avantf/dsh-plugin-base', './envinit-bootstrap.js']
  console.log('\n▶ inline @avantf/mission-core into the host entry')
  const launch = binLaunch(pluginDir, 'esbuild', [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=es2022',
    // esbuild's default `charset=ascii` escapes the Chinese prompt text to `\uXXXX`: runtime-identical, but the artifact turns unreadable and `grep` can no longer find the prompt it carries.
    '--charset=utf8',
    `--outfile=${bundle}`,
    '--log-level=warning',
    ...externals.map((name) => `--external:${name}`),
  ])
  const result = spawnSync(launch.command, launch.args, {
    ...launch.options, cwd: pluginDir, stdio: 'inherit', env: process.env,
  })
  if (result.error) {
    console.error(`  cannot run ${launch.command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
  // Replace the entry only once the bundle exists: a failed bundling must not leave the artifact pointing at a half-written file.
  renameSync(bundle, entry)
  console.log(`  ${entry} (self-contained)`)
}

/**
 * Carry `@avantf/mission-core`'s types into the plugin: the core is not published, so a surviving `from
 * '@avantf/mission-core'` in `lib/types/*.d.ts` is a hard error (or silently `any` with `skipLibCheck`).
 * Copied, not re-declared: the declarations reference each other by relative path, so it stays consistent.
 */
function inlineCoreTypes() {
  const coreTypes = join(repo, 'packages', 'core', 'lib', 'types')
  const pluginTypes = join(repo, 'packages', 'plugin', 'lib', 'types')
  const target = join(repo, 'packages', 'plugin', 'lib', 'mission-core')
  console.log('\n▶ carry @avantf/mission-core types into the plugin (it is not published)')
  // Rebuilt from scratch: `tsc` never cleans its outDir, so a renamed/removed declaration would
  // otherwise stay here and ship.
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  let copied = 0
  // RECURSIVE, mirroring the repoint walk below: a copy that only took the top level while the
  // repointing was recursive would leave a new `lib/types/<sub>/` pointing at files that never ship —
  // and nothing noticed, because the pack gate skips relative specifiers on purpose.
  const copy = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const source = join(from, entry.name)
      const destination = join(to, entry.name)
      if (entry.isDirectory()) {
        mkdirSync(destination, { recursive: true })
        copy(source, destination)
        continue
      }
      if (!entry.name.endsWith('.d.ts')) continue
      // The source-map comment points at a `.map` this step does not carry; a dangling reference is noise, so it goes.
      const text = readFileSync(source, 'utf8').replace(/\n?\/\/# sourceMappingURL=\S*\s*$/u, '\n')
      writeFileSync(destination, text)
      copied += 1
    }
  }
  copy(coreTypes, target)
  // Repoint only specifiers that NAMED the package, leaving prose comments that mention it by name untouched.
  let rewritten = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.d.ts')) continue
      const before = readFileSync(path, 'utf8')
      const specifier = relative(dirname(path), join(target, 'index.js')).split(sep).join('/')
      const after = before.replace(/(\bfrom\s+['"])@avantf\/mission-core(['"])/gu, `$1${specifier}$2`)
      if (after === before) continue
      writeFileSync(path, after)
      rewritten += 1
    }
  }
  walk(pluginTypes)
  console.log(
    `  ${String(copied)} declaration file(s) → lib/mission-core, `
    + `${String(rewritten)} declaration file(s) repointed`,
  )
}

// Only run when executed as a script: importing this file (the launch tests do) must not build.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
