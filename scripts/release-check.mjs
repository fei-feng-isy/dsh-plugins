#!/usr/bin/env node
/**
 * The WORKSPACE-level release gate: what must be true of the merged repository before any of its
 * publishable packages is published.
 *
 * The per-package gates (`pnpm release:check:mem`, `pnpm release:check:mission`,
 * `pnpm release:check:identity`, and the base's own `release:check`) prove each tree builds, tests and
 * packs. This script proves the four things that only make sense once `base/` and the plugin trees are
 * one workspace:
 *
 *   1. **The publishable set is exactly those four packages.** `@avantf/dsh-plugin-base`,
 *      `@avantf/dsh-mem`, `@avantf/dsh-mission`, `@avantf/dsh-identity` — and every other workspace
 *      package is `private: true`.
 *      The merged tree contains a dozen packages (engines, the kit, the CLI/MCP), and a missing
 *      `private` flag publishes an internal package by accident the first time someone runs a
 *      recursive publish.
 *   2. **The publish ORDER is base → plugins.** A plugin declares the base as a plain (runtime)
 *      DEPENDENCY; a host that installs the plugin before the base exists fails to resolve it, and the
 *      plugin's degraded path is a runtime WARNING rather than the intended experience. So, unless
 *      `--allow-missing-base` is given for a pre-publication dry run, the registry must already carry a
 *      `@avantf/dsh-plugin-base` version inside the dependency range each plugin declares — and both
 *      plugins must declare the SAME range, or the installer resolves two physical copies instead of
 *      one (measured on pnpm isolated / pnpm hoisted / npm flat).
 *   3. **The one-zod rule.** `catalog.zod` is `4.6.5` (the version the installed dsh ships), the
 *      base's own `zod` peer stays the wide `>=4.4.3 <5`, and `@avantf/dsh-mem` — the plugin that uses
 *      zod at runtime — takes it as a REQUIRED peer. So ONE copy of zod serves the workspace's engine
 *      packages and the host. Two copies — even of one major — have incompatible type identities (mem
 *      DESIGN §20.11); a peer that drifts into `dependencies`, or turns optional, forks the copy.
 *   4. **The published base's interface GENERATION is high enough (R1).** The range check in (2) says
 *      a base VERSION is acceptable, not that the generation inside it is. The highest published base
 *      version each plugin's peer range accepts is unpacked and its generation read: below the plugin's
 *      baked generation, the plugin would mount against an already-installed base and silently lose the
 *      compat gate / prompt-file layer / envinit provisioner. That one case is fatal; offline, an
 *      unreachable registry and an artifact that records nothing are WARNINGS.
 *
 * It is deliberately dependency-free: it reads manifests and the workspace file directly and needs no
 * `node_modules`, so it can run as the first step of a release (and be the thing that fails before a
 * half-provisioned environment wastes anyone's time).
 *
 * Usage:
 *   node scripts/release-check.mjs                      # strict; needs the registry
 *   node scripts/release-check.mjs --allow-missing-base # pre-publication dry run (base not on npm yet)
 *   node scripts/release-check.mjs --offline            # skip the registry probe entirely (WARNING)
 *   node scripts/release-check.mjs --fixture <file>     # judge a fixture instead of the registry (tests)
 *       fixture: { baseVersions?: [{ version, tarball? }], artifacts?: { <version>: { record?, source? } } }
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION_GROUPS, versionState } from './lib/versions.mjs'
import { bakedVersionProblems } from './lib/bootstrap-version.mjs'
import { baseDependencyProblems, requiredPeerProblems } from './lib/gates.mjs'
import { INTERFACE_VERSION_FILE, readInterfaceVersion } from './lib/interface-version.mjs'
import {
  INTERFACE_RECORD_PATH,
  INTERFACE_SOURCE_PATH,
  interfaceGenerationVerdict,
  publishedInterfaceGeneration,
  readTarballEntry,
} from './lib/published-base.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── arguments ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const known = new Set(['--allow-missing-base', '--offline', '--fixture', '--help', '-h'])
const fixtureIndex = argv.indexOf('--fixture')
const fixturePath = fixtureIndex === -1 ? undefined : argv[fixtureIndex + 1]
if (fixtureIndex !== -1 && (fixturePath === undefined || fixturePath.startsWith('--'))) {
  console.error('release-check: --fixture needs a file')
  process.exit(2)
}
const unknown = argv.filter((flag, index) => !known.has(flag) && (fixtureIndex === -1 || index !== fixtureIndex + 1))
if (unknown.length > 0) {
  console.error(`release-check: unknown option ${unknown.join(', ')}`)
  console.error('usage: node scripts/release-check.mjs [--allow-missing-base] [--offline] [--fixture <file>]')
  process.exit(2)
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/release-check.mjs [--allow-missing-base] [--offline] [--fixture <file>]')
  console.log('  --fixture <file>  judge baseVersions/artifacts from a JSON fixture instead of the registry:')
  console.log('                    { baseVersions?: [{ version, tarball? }], artifacts?: { <version>: { record?, source? } } }')
  process.exit(0)
}
const allowMissingBase = argv.includes('--allow-missing-base')
const offline = argv.includes('--offline')
const fixture = fixturePath === undefined ? undefined : JSON.parse(readFileSync(resolve(fixturePath), 'utf8'))

const problems = []
const notes = []
const fail = (message) => problems.push(message)
const note = (message) => notes.push(message)

// ── the packages that may be published, and where they live ──────────────────────────────────────
/** dir (relative to the repo) → package name. Order is the PUBLISH order (base first). */
const PUBLISHABLE = new Map([
  ['base/plugin-base', '@avantf/dsh-plugin-base'],
  ['mem/packages/plugin', '@avantf/dsh-mem'],
  ['mission/packages/plugin', '@avantf/dsh-mission'],
  ['identity/packages/plugin', '@avantf/dsh-identity'],
])
/** The workspace globs the publishable packages live under; anywhere else is build output, never shipped. */
const WORKSPACE_PATTERNS = ['base/*', 'mem/packages/*', 'mission/packages/*', 'identity/packages/*']

const BASE_DIR = 'base/plugin-base'
const BASE = '@avantf/dsh-plugin-base'
const PLUGINS = [
  { dir: 'mem/packages/plugin', name: '@avantf/dsh-mem' },
  { dir: 'mission/packages/plugin', name: '@avantf/dsh-mission' },
  { dir: 'identity/packages/plugin', name: '@avantf/dsh-identity' },
]

function readJson(relative) {
  return JSON.parse(readFileSync(join(repo, relative), 'utf8'))
}

/**
 * The `packages:` globs `pnpm-workspace.yaml` actually declares.
 *
 * Read, not assumed: this list used to be hardcoded, and `workspacePackages()` only ever expanded it —
 * so adding `notes/packages/*` to the workspace put a whole subtree OUTSIDE the "the rest stay private"
 * check, silently. The declared set is compared for EQUALITY with {@link WORKSPACE_PATTERNS}: widening
 * the workspace is a deliberate act, and it must come with a decision about the publishable set below.
 */
function declaredWorkspacePatterns(text) {
  // The block runs from `packages:` up to the next line that starts at column 0 (the next top-level
  // key) or the end of the file; comments inside it are ignored by the item pattern below.
  const list = /^packages:[ \t]*\n([\s\S]*?)(?=^[^\s#]|$(?![\s\S]))/mu.exec(text)
  if (list === null) return []
  return [...list[1].matchAll(/^[ \t]+-\s*['"]?([^'"\s#]+)['"]?\s*$/gmu)].map((match) => match[1])
}

/** Every directory a workspace glob matches that carries a `package.json`. */
function expandWorkspacePattern(pattern) {
  const star = pattern.indexOf('*')
  const parent = (star === -1 ? pattern : pattern.slice(0, star)).replace(/\/+$/, '')
  const base = join(repo, parent)
  if (!existsSync(base)) {
    fail(`workspace pattern ${pattern} matches no directory (${parent}/ is missing)`)
    return []
  }
  if (star === -1) return existsSync(join(base, 'package.json')) ? [parent] : []
  const found = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = `${parent}/${entry.name}`
    if (existsSync(join(repo, dir, 'package.json'))) found.push(dir)
  }
  return found
}

// ── 1. the pnpm workspace itself: coverage, one zod, workspace linking ───────────────────────────
const workspaceText = existsSync(join(repo, 'pnpm-workspace.yaml'))
  ? readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')
  : undefined
if (workspaceText === undefined) {
  fail('pnpm-workspace.yaml is missing — this is not the merged workspace')
} else {
  const declared = declaredWorkspacePatterns(workspaceText)
  if (declared.length === 0) {
    fail('pnpm-workspace.yaml declares no `packages:` globs — the workspace has nothing to scan')
  }
  // EQUALITY, not coverage: a new glob adds a subtree this gate would otherwise never look at, and a
  // publishable package inside it would escape "the rest stay private" without a trace.
  const unexpected = declared.filter((pattern) => !WORKSPACE_PATTERNS.includes(pattern))
  const missing = WORKSPACE_PATTERNS.filter((pattern) => !declared.includes(pattern))
  if (unexpected.length > 0) {
    fail(
      `pnpm-workspace.yaml lists workspace pattern(s) ${unexpected.join(', ')} that this gate does not know — `
      + 'add them to WORKSPACE_PATTERNS (and, if they carry a publishable package, to PUBLISHABLE): the release '
      + 'surface is reviewed, never discovered',
    )
  }
  if (missing.length > 0) {
    fail(`pnpm-workspace.yaml does not list packages: ${missing.join(', ')}`)
  }
  const zod = /^\s+zod:\s*(\S+)\s*$/mu.exec(workspaceText)
  if (zod === null) {
    fail('pnpm-workspace.yaml has no `catalog.zod` entry — the one-zod rule lives there')
  } else if (zod[1] !== '4.6.5') {
    fail(`catalog.zod is ${zod[1]}, expected the installed dsh's 4.6.5 (bump the catalog line, never a package.json)`)
  } else {
    note('catalog.zod = 4.6.5 (one copy for the workspace and the installed dsh)')
  }
  if (!/^linkWorkspacePackages:\s*true\s*$/mu.test(workspaceText)) {
    fail(
      'pnpm-workspace.yaml does not set `linkWorkspacePackages: true` — the plugins\' devDependency '
      + `on ${BASE} would then be fetched from the registry instead of linked from base/, so a local `
      + 'build would run against a published copy (or fail before the base is published at all)',
    )
  } else {
    note('linkWorkspacePackages: true (base/ is linked, not fetched)')
  }
}

// ── 2. the publishable set is exactly the three ─────────────────────────────────────────────────
// Expanded from the DECLARED globs (section 1 already proved they are the expected set), so no subtree
// can sit outside this scan.
const packages = [...new Set(declaredWorkspacePatterns(workspaceText ?? '').flatMap(expandWorkspacePattern))].sort()
const seen = new Map()
for (const dir of packages) {
  let manifest
  try {
    manifest = readJson(`${dir}/package.json`)
  } catch (error) {
    fail(`${dir}/package.json is not readable JSON (${error instanceof Error ? error.message : String(error)})`)
    continue
  }
  const publishable = manifest.private !== true
  const expectedName = PUBLISHABLE.get(dir)
  if (publishable && expectedName === undefined) {
    fail(
      `${manifest.name ?? dir} (${dir}) is publishable but is NOT one of the three release packages — `
      + 'add `"private": true` (an internal engine/kit package must never reach npm)',
    )
  }
  if (!publishable && expectedName !== undefined) {
    fail(`${dir} declares \`"private": true\` but ${expectedName} is one of the three release packages`)
  }
  if (expectedName !== undefined) seen.set(dir, manifest)
}
for (const [dir, name] of PUBLISHABLE) {
  const manifest = seen.get(dir)
  if (manifest === undefined) {
    if (existsSync(join(repo, dir, 'package.json'))) continue // already reported above
    fail(`missing release package ${name} at ${dir}`)
    continue
  }
  if (manifest.name !== name) {
    fail(`${dir} is named ${manifest.name}, expected ${name}`)
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    fail(`${name} has no version`)
  }
}
if (problems.length === 0) {
  note(`publishable set: ${[...PUBLISHABLE.values()].join(', ')} (${packages.length} workspace packages, the rest private)`)
}

// ── 2b. one version per group, recorded in exactly ONE manifest ──────────────────────────────────
// A group's version lives in its publishable package's manifest; every other manifest of the group is
// private and must carry NO version. `pnpm version:set <group> <version>` edits that one file, and
// `pnpm version:prune` removes a stray one — see scripts/lib/versions.mjs.
{
  const { versions, carriers, problems } = versionState(repo)
  for (const problem of problems) fail(problem)
  // The base's version is ALSO baked into `src/bootstrap.ts` (the zero-dependency bootstrap cannot read
  // package.json at runtime). `version:set base` moves both; this is the release-time assertion that
  // they agree — a split makes base's own tests and every plugin's vendoring stop with the misleading
  // "the base was built from a mismatched source tree".
  for (const problem of bakedVersionProblems(repo, versions)) fail(problem)
  if (problems.length === 0) {
    note(`versions: ${VERSION_GROUPS.map((group) => `${group} ${String(versions[group])} (${String(carriers[group])})`).join(', ')}`)
  }
}

// ── 3. per-plugin wiring: a plain, wide, IDENTICAL runtime dependency on the base ───────────────
const baseManifest = seen.get(BASE_DIR)
const baseVersion = baseManifest?.version

const pluginRanges = []
for (const plugin of PLUGINS) {
  const manifest = seen.get(plugin.dir)
  if (manifest === undefined) continue
  // The base is a PLAIN DEPENDENCY of each plugin: dsh writes `autoInstallPeers: false` into every
  // profile it manages, so a peer would never be installed and "install the plugin, get the base"
  // would be false. The one-copy invariant is not "a peer, never a runtime dep" — it is "both plugins
  // name the SAME range" (measured: pnpm isolated / pnpm hoisted / npm flat each install exactly one
  // physical copy when the ranges agree, and fork only when they differ). `previous` is what makes
  // that drift fatal rather than a warning.
  const wiring = baseDependencyProblems(plugin.name, manifest, BASE, pluginRanges.at(-1))
  for (const problem of wiring.problems) fail(problem)
  if (wiring.range !== undefined) {
    // `dev` is reported, not asserted: the published range is what a host install resolves. Keeping
    // the dev half at the same range is what lets `pnpm install` link the workspace base at all.
    pluginRanges.push({ plugin: plugin.name, dir: plugin.dir, range: wiring.range, dev: manifest.devDependencies?.[BASE] })
    if (baseVersion !== undefined && !satisfies(wiring.range, baseVersion)) {
      fail(
        `${plugin.name}'s dependency range ${wiring.range} does not accept the workspace base ${baseVersion} — `
        + 'a local mount would refuse the base that is right there',
      )
    }
  }
}
if (pluginRanges.length > 0) {
  note(
    `plugin base wiring: ${pluginRanges.map((p) => `${p.plugin} dependency ${p.range} (dev ${String(p.dev)})`).join(', ')}`,
  )
}

// ── 4. the base's own contract: no runtime deps, wide zod peer ──────────────────────────────────
if (baseManifest !== undefined) {
  const runtime = Object.keys(baseManifest.dependencies ?? {})
  if (runtime.length > 0) {
    fail(
      `${BASE} declares runtime dependencies (${runtime.join(', ')}) — it is loaded by file URL from the `
      + 'host and must stay self-contained (zod is a peer, provided by the host)',
    )
  }
  const zodPeer = baseManifest.peerDependencies?.zod
  if (zodPeer !== '>=4.4.3 <5') {
    fail(`${BASE}'s zod peer is ${String(zodPeer)}, expected the wide ">=4.4.3 <5" that serves both this workspace and the installed dsh`)
  } else if (!satisfies(zodPeer, '4.4.3') || !satisfies(zodPeer, '4.6.5') || satisfies(zodPeer, '5.0.0')) {
    fail(`${BASE}'s zod peer ">=4.4.3 <5" does not behave as advertised (4.4.3 and 4.6.5 in, 5.0.0 out)`)
  } else {
    note(`${BASE} peer zod = ">=4.4.3 <5" (4.4.3 and the dsh's 4.6.5 both accepted)`)
  }
}

// ── 4b. the one-zod rule's PLUGIN half: BOTH plugins take the host's copy, never a nested one ────
// Section 4 pins the base's zod PEER; this pins the other two manifests that use zod at runtime (N15):
// mem's wire codecs AND mission's `domain.ts`/`wire.ts` are runtime VALUE imports of the host's copy.
// A `zod` moved out of `peerDependencies`, or marked optional, would let the installer nest a second
// copy — two copies, even of one major, have incompatible schema type identities (mem DESIGN §20.11).
// Declaring it optional while the runtime resolves it is a DISHONEST manifest: the install succeeds
// and the plugin then loads a zod the host never agreed to provide. Both trees must say the same
// thing, because a host install is judged by whichever manifest it happens to read.
//
// The RANGE is a note, not a failure: `^4.4.3` and `>=4.4.3 <5` denote the same set, and the one-zod
// rule is about WHERE zod comes from, not the spelling of the range (S1 aligned the spelling anyway).
{
  const zodRanges = new Map()
  for (const plugin of PLUGINS) {
    const manifest = seen.get(plugin.dir)
    if (manifest === undefined) continue
    const zodProblems = requiredPeerProblems(plugin.name, manifest, 'zod')
    for (const problem of zodProblems) fail(problem)
    if (zodProblems.length === 0) {
      zodRanges.set(plugin.name, manifest.peerDependencies.zod)
      note(`${plugin.name} peer zod = "${manifest.peerDependencies.zod}" (required, host-provided: one copy)`)
    }
  }
  const distinctZodRanges = new Set(zodRanges.values())
  if (distinctZodRanges.size > 1) {
    note(
      `WARNING: the two plugins declare different zod peer ranges (${[...distinctZodRanges].join(', ')}) `
      + '— keep them in step: one zod, one set of accepted versions',
    )
  }
}

// ── 5. the tarball rule, checked statically on every publishable manifest ───────────────────────
for (const [dir, name] of PUBLISHABLE) {
  const manifest = seen.get(dir)
  if (manifest === undefined) continue
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
  for (const section of sections) {
    for (const [dep, range] of Object.entries(manifest[section] ?? {})) {
      if (typeof range === 'string' && /^(?:link|file):/u.test(range)) {
        fail(
          `${name}'s ${section}["${dep}"] = ${range} — a published artifact must resolve from the `
          + 'registry, never from a local path (`link:`/`file:`). pnpm rewrites `workspace:`/`catalog:` '
          + 'at pack time; it cannot rewrite a hand-written path.',
        )
      }
    }
  }
}
if (problems.length === 0) note('no `link:`/`file:` specifier in any publishable manifest')

// ── 6. the publish order: the registry already carries a compatible base, whose INTERFACE
//       generation is high enough for what the plugins baked (R1) ───────────────────────────────
const artifactCache = new Map()
let baseVersions
let probed = false
if (fixture !== undefined) {
  baseVersions = (fixture.baseVersions ?? [])
    .map((entry) => (typeof entry === 'string' ? { version: entry } : entry))
    .sort((left, right) => compareVersions(left.version, right.version))
  probed = true
  note(`registry probe replaced by fixture ${fixturePath} (${baseVersions.length} published base version(s))`)
} else if (offline) {
  note(
    'WARNING: registry probe skipped (--offline) — the base→plugin publish order AND the published '
    + 'base interface generation were NOT verified',
  )
} else {
  baseVersions = await publishedBaseVersions()
  probed = true
}
if (probed && baseVersions === undefined) {
  const detail =
    `${BASE} could not be looked up on the registry (offline, or the registry is unreachable). `
    + 'The publish order (base first) could not be verified.'
  if (allowMissingBase) note(`WARNING: ${detail}`)
  else {
    fail(
      `${detail}\n    Fix: publish the base BEFORE the plugins —\n`
      + `      pnpm -C ${BASE_DIR} publish\n`
      + '    or, for a pre-publication dry run where the base is not on npm yet, re-run with:\n'
      + '      node scripts/release-check.mjs --allow-missing-base',
    )
  }
} else if (probed && baseVersions.length === 0) {
  if (allowMissingBase) {
    note(`WARNING: ${BASE} is not published yet — publish it BEFORE the plugins (--allow-missing-base given, so this is not fatal)`)
  } else {
    fail(
      `${BASE} has no published version, but the plugins depend on it at runtime.\n`
      + `    Publish the base FIRST:\n      pnpm -C ${BASE_DIR} publish\n`
      + '    or, for a pre-publication dry run, re-run with:\n'
      + '      node scripts/release-check.mjs --allow-missing-base',
    )
  }
} else if (probed) {
  for (const { plugin, dir, range } of pluginRanges) {
    const accepted = baseVersions.filter((entry) => satisfies(range, entry.version))
    if (accepted.length === 0) {
      const detail =
        `${BASE} is published (${baseVersions.map((entry) => entry.version).join(', ')}) but no version satisfies ${plugin}'s dependency `
        + `range ${range} — installing the plugin would fail to resolve a base it accepts.`
      if (allowMissingBase) note(`WARNING: ${detail}`)
      else fail(`${detail}\n    Fix: publish a ${BASE} version inside ${range} first.`)
      continue
    }
    const newest = accepted[accepted.length - 1]
    note(`${plugin} ${range} → registry has ${BASE}@${newest.version}`)
    // The range accepted a VERSION; this asks whether the GENERATION inside it is high enough. The
    // plugin's bake is the generation it was compiled for; the artifact's is what users would load.
    const bake = readInterfaceVersion(join(repo, dir, 'lib', INTERFACE_VERSION_FILE))
    const published = await publishedInterfaceFor(newest, artifactCache)
    const verdict = interfaceGenerationVerdict({
      plugin, baseDir: BASE_DIR, baseVersion: newest.version, published, bake, allowMissingBase,
    })
    if (verdict.level === 'fail') fail(verdict.message)
    else note(verdict.message)
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
for (const line of notes) console.log(`  note  ${line}`)
for (const problem of problems) console.error(`  FAIL  ${problem}`)
if (problems.length > 0) {
  console.error(`\nrelease-check: FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nrelease-check ok — four publishable packages, base before plugins, one zod')

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
/**
 * The published `@avantf/dsh-plugin-base` versions (with the tarball URL the generation is read from),
 * ascending, or `undefined` when the registry could not be asked. A 404 is an empty list (the package
 * does not exist yet), not an error.
 */
async function publishedBaseVersions() {
  try {
    const response = await fetch('https://registry.npmjs.org/@avantf%2Fdsh-plugin-base', {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404) return []
    if (!response.ok) return undefined
    const body = await response.json()
    const versions = body?.versions
    if (versions === undefined || versions === null || typeof versions !== 'object') return []
    return Object.entries(versions)
      .filter(([version]) => typeof version === 'string')
      .map(([version, manifest]) => ({ version, tarball: manifest?.dist?.tarball }))
      .sort((left, right) => compareVersions(left.version, right.version))
  } catch {
    return undefined
  }
}

/**
 * The interface generation inside one published base version — from the fixture when one was given,
 * otherwise by downloading and unpacking its tarball.
 *
 * The network half of R1 lives HERE, not in the verdict: every failure to obtain the number is
 * returned as an `unreadable` result that the verdict turns into a WARNING, so a release machine with
 * a flaky mirror never sees a red gate for a reason that is not the base's generation. Results are
 * cached by version because both plugins usually accept the same newest base.
 */
async function publishedInterfaceFor(entry, cache) {
  if (cache.has(entry.version)) return cache.get(entry.version)
  let result
  const fromFixture = fixture?.artifacts?.[entry.version]
  if (fromFixture !== undefined) {
    result = publishedInterfaceGeneration(fromFixture)
  } else if (typeof entry.tarball !== 'string' || entry.tarball === '') {
    result = { status: 'unreadable', detail: `the registry metadata for ${entry.version} advertises no tarball URL` }
  } else {
    try {
      const response = await fetch(entry.tarball, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) {
        result = { status: 'unreadable', detail: `its tarball could not be downloaded (HTTP ${response.status})` }
      } else {
        const tarball = Buffer.from(await response.arrayBuffer())
        result = publishedInterfaceGeneration({
          record: readTarballEntry(tarball, INTERFACE_RECORD_PATH),
          source: readTarballEntry(tarball, INTERFACE_SOURCE_PATH),
        })
      }
    } catch (error) {
      result = {
        status: 'unreadable',
        detail: `its tarball could not be read (${error instanceof Error ? error.message : String(error)})`,
      }
    }
  }
  cache.set(entry.version, result)
  return result
}

/**
 * A deliberately small semver subset — enough for the ranges this repository writes, and no more:
 * `*`, exact versions, `^`, `~`, and whitespace-separated comparator sets (`>=4.4.3 <5`), joined by
 * `||`. It is NOT a general implementation; a range it cannot parse makes the check FAIL loudly
 * rather than pass silently, which is the only safe direction for a release gate.
 */
function satisfies(range, version) {
  const wanted = parseVersion(version)
  if (wanted === undefined) return false
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/u).filter(Boolean)
    if (comparators.length === 0) return false
    return comparators.every((comparator) => comparatorSatisfied(comparator, wanted))
  })
}

function comparatorSatisfied(comparator, version) {
  if (comparator === '*' || comparator === '' || comparator.toLowerCase() === 'x') return true
  let match
  if ((match = /^\^(.*)$/u.exec(comparator)) !== null) {
    const floor = parseVersion(match[1])
    if (floor === undefined) throw new Error(`release-check: cannot parse range ${comparator}`)
    return compare(version, floor) >= 0 && compare(version, caretCeiling(floor)) < 0
  }
  if ((match = /^~(.*)$/u.exec(comparator)) !== null) {
    const floor = parseVersion(match[1])
    if (floor === undefined) throw new Error(`release-check: cannot parse range ${comparator}`)
    return compare(version, floor) >= 0 && compare(version, { ...floor, minor: floor.minor + 1, patch: 0, pre: [] }) < 0
  }
  if ((match = /^(>=|<=|>|<|=)?\s*(.+)$/u.exec(comparator)) !== null) {
    const operator = match[1] ?? '='
    const bound = parseVersion(match[2])
    if (bound === undefined) throw new Error(`release-check: cannot parse range ${comparator}`)
    const order = compare(version, bound)
    if (operator === '>=') return order >= 0
    if (operator === '>') return order > 0
    if (operator === '<=') return order <= 0
    if (operator === '<') return order < 0
    return order === 0
  }
  throw new Error(`release-check: cannot parse range ${comparator}`)
}

/** `^0.1.3` → `0.2.0`; `^1.2.3` → `2.0.0` (0.x rule: the leftmost non-zero field is the ceiling). */
function caretCeiling(version) {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0, pre: [] }
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0, pre: [] }
  return { major: 0, minor: 0, patch: version.patch + 1, pre: [] }
}

function parseVersion(text) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/u.exec(String(text).trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compare(left, right) {
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
  }
  // A prerelease sorts BEFORE the release with the same numbers (1.2.3-rc < 1.2.3).
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  for (let at = 0; at < Math.max(left.pre.length, right.pre.length); at += 1) {
    const a = left.pre[at]
    const b = right.pre[at]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const numericA = /^\d+$/u.test(a)
    const numericB = /^\d+$/u.test(b)
    if (numericA && numericB) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1
    } else if (numericA !== numericB) {
      return numericA ? -1 : 1
    } else if (a !== b) {
      return a < b ? -1 : 1
    }
  }
  return 0
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return String(left).localeCompare(String(right))
  return compare(a, b)
}
