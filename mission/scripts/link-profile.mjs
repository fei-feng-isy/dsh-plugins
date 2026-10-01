#!/usr/bin/env node
/**
 * Install this plugin into a dsh profile as a `link:` dependency, and verify that the live process
 * would share the host's module identities.
 *
 * `link:` (not a tarball copy) is the point: a symlink to this repo means every rebuild is the
 * version the profile loads. It is safe only if the symlink points at THIS repo and the plugin's
 * `@deepseek-ai/*` links point at the INSTALLED dsh, not the harness checkout — a symlinked package
 * resolves its peers from this workspace's realpath, so dev links would give the running host a
 * second cordis / schemastery / zod.
 *
 *   node scripts/link-profile.mjs [--profile <name>] [--check]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { execToolSync, spawnToolSync } from '../../scripts/lib/win-spawn.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: node scripts/link-profile.mjs [--profile <name>] [--check]')
  console.log('  --profile <name>  dsh profile to link into (default: web)')
  console.log('  --check           verify the current install; change nothing')
  process.exit(0)
}
const check = args.includes('--check')
const profileIndex = args.indexOf('--profile')
const profileName = profileIndex >= 0 ? args[profileIndex + 1] : 'web'
if (profileName === undefined || profileName.startsWith('--')) {
  console.error('link-profile: --profile needs a name')
  process.exit(2)
}

const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
const profileDir = join(home, 'profiles', profileName)
const pluginDir = join(repo, 'packages', 'plugin')
const installed = join(profileDir, 'node_modules', '@avantf', 'dsh-mission')

/** The `@deepseek-ai/*` directory of the dsh install the live profile runs. */
function installedDshPeers() {
  try {
    const globalRoot = execToolSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    return join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
  } catch {
    return undefined
  }
}

/** Packages whose physical identity decides whether the host accepts our objects. */
const PEERS = [
  'cordis',
  'cordis-plugin-timer',
  'schemastery',
  'dsh-agent',
  'dsh-commands',
  'dsh-llm',
  'dsh-session',
  'dsh-session-query',
  'dsh-spill',
  'dsh-storage-domain',
  'dsh-subagent',
  'dsh-system-prompt',
  'dsh-tools',
  'dsh-typert-protocol',
  'dsh-typert-registry',
  'dsh-util-values',
]

/**
 * The zod a package resolves: its version and the real path of that copy.
 *
 * Two things, because two different questions get asked — the version is what must match the host's,
 * and the path is what makes a mismatch diagnosable (it names WHICH copy).
 *
 * @param from - a `createRequire` rooted at the package doing the resolving.
 * @returns the copy, or undefined when zod does not resolve from there.
 */
function resolvedZod(from) {
  try {
    const path = realpathSync(from.resolve('zod'))
    const version = JSON.parse(readFileSync(join(dirname(path), 'package.json'), 'utf8')).version
    return { path, version }
  } catch {
    return undefined
  }
}

/** Newest mtime under a directory tree, or undefined when it does not exist. */function newest(directory) {
  if (!existsSync(directory)) return undefined
  let latest = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) latest = Math.max(latest, statSync(path).mtimeMs)
    }
  }
  walk(directory)
  return latest === 0 ? undefined : latest
}

function verify() {
  const problems = []
  const notes = []

  if (!existsSync(profileDir)) {
    problems.push(`profile directory not found: ${profileDir}`)
    return { problems, notes }
  }
  if (!existsSync(installed)) {
    problems.push(`@avantf/dsh-mission is not installed in the profile: ${installed}`)
  } else if (!lstatSync(installed).isSymbolicLink()) {
    problems.push(
      `${installed} is a COPY, not a symlink — a rebuild would not reach the profile; `
      + `install with: dsh plugin --profile ${profileName} add link:${pluginDir}`,
    )
  } else {
    const target = realpathSync(installed)
    if (target !== realpathSync(pluginDir)) {
      problems.push(`the profile symlink points elsewhere: ${target}`)
    } else {
      notes.push(`profile symlink → ${target}`)
    }
  }

  const peersRoot = installedDshPeers()
  if (peersRoot === undefined) {
    notes.push('cannot locate the installed dsh (npm root -g); skipped the peer identity check')
  } else if (existsSync(join(installed, 'lib', 'index.js'))) {
    const require = createRequire(join(installed, 'lib', 'index.js'))
    const mismatched = []
    for (const peer of PEERS) {
      const expected = join(peersRoot, peer)
      if (!existsSync(expected)) continue
      const specifier = `@deepseek-ai/${peer}`
      const root = realpathSync(expected)
      try {
        // Containment, not equality: `resolve` hands back the entry file, while the
        // install layout names the package directory.
        const resolved = realpathSync(require.resolve(specifier))
        if (resolved !== root && !resolved.startsWith(`${root}/`)) {
          mismatched.push(`${specifier}\n      plugin: ${resolved}\n      host:   ${root}`)
        }
      } catch (error) {
        mismatched.push(`${specifier}: unresolvable (${error.code ?? 'error'})`)
      }
    }
    if (mismatched.length > 0) {
      problems.push(
        `the plugin does not resolve the host's own copies for ${String(mismatched.length)} package(s) — `
        + `run: node scripts/link-dsh.mjs --runtime\n    ${mismatched.join('\n    ')}`,
      )
    } else {
      notes.push(`peer identity: ${String(PEERS.length)} package(s) resolve to the installed dsh`)
    }

    // zod is not a `@deepseek-ai/*` package: what keeps the storage domain's record schemas compatible
    // with the records this plugin writes is that the plugin and the HOST run the same VERSION. They are
    // necessarily separate physical copies, so identity-by-path cannot be the test — nor can the
    // WORKSPACE PIN, which only says what this repo installed and would report ok while a host upgraded
    // to a newer zod diverges. So compare against what the installed dsh actually resolves.
    const workspaceZod = join(pluginDir, 'node_modules', 'zod')
    if (!existsSync(workspaceZod)) {
      problems.push(`the workspace zod link is missing at ${workspaceZod} — run: pnpm install`)
    } else {
      // The pin is still worth naming in the failure: it is the one-line fix.
      const pinned = JSON.parse(readFileSync(join(workspaceZod, 'package.json'), 'utf8')).version
      const pluginZod = resolvedZod(require)
      const hostZod = peersRoot === undefined
        ? undefined
        : resolvedZod(createRequire(join(peersRoot, 'dsh-storage-domain', 'package.json')))
      if (pluginZod === undefined) {
        problems.push('zod: unresolvable from the plugin — run: pnpm install')
      } else if (hostZod === undefined) {
        notes.push(`zod: ${pluginZod.version} (the installed dsh did not yield a copy to compare against; workspace pin ${pinned})`)
      } else if (pluginZod.version !== hostZod.version) {
        problems.push(
          `zod version mismatch: the plugin resolves ${pluginZod.version} (${pluginZod.path}), `
          + `the installed dsh resolves ${hostZod.version} (${hostZod.path}) — set pnpm-workspace.yaml's `
          + `zod to ${hostZod.version}, then run: pnpm install && node scripts/link-dsh.mjs --runtime`,
        )
      } else {
        notes.push(`zod: ${pluginZod.version} — the version the installed dsh itself resolves`)
      }
    }
  }

  for (const artifact of ['lib/index.js', 'lib/client.js']) {
    if (!existsSync(join(pluginDir, artifact))) problems.push(`missing ${join(pluginDir, artifact)} — run: pnpm build:dsh`)
  }
  const srcNewest = Math.max(newest(join(pluginDir, 'src')) ?? 0, newest(join(repo, 'packages', 'core', 'src')) ?? 0)
  // Compare the sources against the ENTRY ARTIFACTS, not the whole `lib/` tree: `link-dsh` writes
  // `lib/dsh-build.json` during `pnpm typecheck`, which would refresh the tree's newest mtime without
  // producing anything and silence this warning for a genuinely stale build — the "changed it,
  // restarted, still the old behaviour" accident.
  const libNewest = Math.max(0, ...[
    join(pluginDir, 'lib', 'index.js'),
    join(pluginDir, 'lib', 'envinit.js'),
    join(pluginDir, 'lib', 'client.js'),
    join(repo, 'packages', 'core', 'lib', 'index.js'),
  ].map((file) => {
    try {
      return statSync(file).mtimeMs
    } catch {
      return 0
    }
  }))
  if (srcNewest > libNewest) {
    notes.push('src/ is newer than lib/ — run: pnpm build:dsh (the profile then loads the new build on its next reload)')
  }

  // The framework peer and its vendored bootstrap are part of "this install resolves what it will
  // run": without the install the live process mounts DEGRADED — the inlined bootstrap only warns
  // and returns `undefined` (it never throws and never installs anything) — while a bootstrap that
  // drifted from the install runs a loader from a different version. `--check` is the only place
  // that catches either, so it has to be reachable from here.
  const envinit = spawnSync(process.execPath, [join(repo, 'scripts', 'link-envinit.mjs'), '--check'], {
    cwd: repo,
    encoding: 'utf8',
    env: process.env,
  })
  if (envinit.status !== 0) {
    // No suggested command of our own: `link-envinit --check` already prints one `FAIL … / fix: …`
    // pair per finding, and the fixes differ by cause (`pnpm install` for a missing install, the
    // script itself for drift). A second, wrong suggestion in front of those only buries the right one.
    const detail = `${envinit.stdout ?? ''}${envinit.stderr ?? ''}`.trim().split('\n').join('\n    ')
    problems.push(`@avantf/dsh-plugin-base is not usable as built (the framework install or its vendored bootstrap):\n    ${detail}`)
  } else {
    notes.push(`@avantf/dsh-plugin-base: ${(envinit.stdout ?? '').trim()}`)
  }

  return { problems, notes }
}

if (!check) {
  console.log('▶ link DSH peers (runtime: the installed dsh the live profile shares)')
  const linked = spawnSync(process.execPath, [join(repo, 'scripts', 'link-dsh.mjs'), '--runtime', '--no-bake'], {
    cwd: repo,
    stdio: 'inherit',
    env: process.env,
  })
  if (linked.status !== 0) {
    console.error('link-profile: could not link the DSH peers')
    process.exit(1)
  }

  // The framework is a registry dependency; `link-envinit` vendors the bootstrap the artifact
  // inlines from the installed copy, so the profile must run it before the plugin is rebuilt.
  console.log('\n▶ vendor the @avantf/dsh-plugin-base bootstrap (from the installed framework)')
  const envinit = spawnSync(process.execPath, [join(repo, 'scripts', 'link-envinit.mjs')], {
    cwd: repo,
    stdio: 'inherit',
    env: process.env,
  })
  if (envinit.status !== 0) {
    console.error('link-profile: could not vendor the @avantf/dsh-plugin-base bootstrap')
    process.exit(1)
  }

  console.log(`\n▶ install @avantf/dsh-mission into profile "${profileName}"`)
  const added = spawnToolSync(
    'dsh',
    ['plugin', '--profile', profileName, 'add', `link:${pluginDir}`],
    { cwd: repo, stdio: 'inherit', env: process.env },
  )
  if (added.error !== undefined || added.status !== 0) {
    console.error(
      `link-profile: could not run \`dsh plugin --profile ${profileName} add link:${pluginDir}\``
      + `${added.error === undefined ? '' : ` (${added.error.message})`}`,
    )
    process.exit(1)
  }
}

const { problems, notes } = verify()
console.log('')
for (const note of notes) console.log(`  ok   ${note}`)
for (const problem of problems) console.log(`  FAIL ${problem}`)
if (problems.length > 0) {
  console.error('\nlink-profile: FAILED')
  process.exit(1)
}
console.log('\nlink-profile: OK')
console.log(`  host half: rebuild with \`pnpm build:dsh\`, then restart dsh (or let the profile reload)`)
console.log('  client half: `pnpm build:dsh` alone is enough — refresh the page')
