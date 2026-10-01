#!/usr/bin/env node
/**
 * The WORKSPACE-level release gate: what must be true of the merged repository before any of its
 * three packages is published.
 *
 * The per-package gates (`pnpm release:check:mem`, `pnpm release:check:mission`, and the base's own
 * `release:check`) prove each tree builds, tests and packs. This script proves the three things that
 * only make sense once `base/`, `mem/` and `mission/` are one workspace:
 *
 *   1. **The publishable set is exactly three packages.** `@avantf/dsh-plugin-base`,
 *      `@avantf/dsh-mem`, `@avantf/dsh-mission` — and every other workspace package is `private: true`.
 *      The merged tree contains a dozen packages (engines, the kit, the CLI/MCP), and a missing
 *      `private` flag publishes an internal package by accident the first time someone runs a
 *      recursive publish.
 *   2. **The publish ORDER is base → plugins.** A plugin declares the base as a REQUIRED peer; a host
 *      that installs the plugin before the base exists fails to resolve it, and the plugin's degraded
 *      path is a runtime WARNING rather than the intended experience. So, unless `--allow-missing-base`
 *      is given for a pre-publication dry run, the registry must already carry a
 *      `@avantf/dsh-plugin-base` version inside the peer range each plugin declares.
 *   3. **The one-zod rule.** `catalog.zod` is `4.6.5` (the version the installed dsh ships) and the
 *      base's own `zod` peer stays the wide `>=4.4.3 <5`, so ONE copy of zod serves the workspace's
 *      engine packages and the host. Two copies — even of one major — have incompatible type
 *      identities (mem DESIGN §20.11).
 *
 * It is deliberately dependency-free: it reads manifests and the workspace file directly and needs no
 * `node_modules`, so it can run as the first step of a release (and be the thing that fails before a
 * half-provisioned environment wastes anyone's time).
 *
 * Usage:
 *   node scripts/release-check.mjs                      # strict; needs the registry
 *   node scripts/release-check.mjs --allow-missing-base # pre-publication dry run (base not on npm yet)
 *   node scripts/release-check.mjs --offline            # skip the registry probe entirely (WARNING)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION_GROUPS, versionState } from './lib/versions.mjs'
import { baseDependencyProblems } from './lib/gates.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── arguments ────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const known = new Set(['--allow-missing-base', '--offline', '--help', '-h'])
const unknown = argv.filter((flag) => !known.has(flag))
if (unknown.length > 0) {
  console.error(`release-check: unknown option ${unknown.join(', ')}`)
  console.error('usage: node scripts/release-check.mjs [--allow-missing-base] [--offline]')
  process.exit(2)
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/release-check.mjs [--allow-missing-base] [--offline]')
  process.exit(0)
}
const allowMissingBase = argv.includes('--allow-missing-base')
const offline = argv.includes('--offline')

const problems = []
const notes = []
const fail = (message) => problems.push(message)
const note = (message) => notes.push(message)

// ── the three packages that may be published, and where they live ────────────────────────────────
/** dir (relative to the repo) → package name. Order is the PUBLISH order (base first). */
const PUBLISHABLE = new Map([
  ['base/plugin-base', '@avantf/dsh-plugin-base'],
  ['mem/packages/plugin', '@avantf/dsh-mem'],
  ['mission/packages/plugin', '@avantf/dsh-mission'],
])
/** The workspace globs the three live under; a package anywhere else is build output, never shipped. */
const WORKSPACE_PATTERNS = ['base/*', 'mem/packages/*', 'mission/packages/*']

const BASE_DIR = 'base/plugin-base'
const BASE = '@avantf/dsh-plugin-base'
const PLUGINS = [
  { dir: 'mem/packages/plugin', name: '@avantf/dsh-mem' },
  { dir: 'mission/packages/plugin', name: '@avantf/dsh-mission' },
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
  if (problems.length === 0) {
    note(`versions: ${VERSION_GROUPS.map((group) => `${group} ${String(versions[group])} (${String(carriers[group])})`).join(', ')}`)
  }
}

// ── 3. per-plugin wiring: REQUIRED peer with a real, wide-enough range ───────────────────────────
const baseManifest = seen.get(BASE_DIR)
const baseVersion = baseManifest?.version

const pluginRanges = []
for (const plugin of PLUGINS) {
  const manifest = seen.get(plugin.dir)
  if (manifest === undefined) continue
  // BOTH sides of the base wiring: a required peer with a registry range, and the SAME range in
  // devDependencies (pnpm-workspace.yaml's "asserts both sides" — the dev half had no assertion).
  const wiring = baseDependencyProblems(plugin.name, manifest, BASE)
  for (const problem of wiring.problems) fail(problem)
  if (wiring.peer !== undefined) {
    pluginRanges.push({ plugin: plugin.name, dir: plugin.dir, range: wiring.peer, dev: manifest.devDependencies?.[BASE] })
    if (baseVersion !== undefined && !satisfies(wiring.peer, baseVersion)) {
      fail(
        `${plugin.name}'s peer range ${wiring.peer} does not accept the workspace base ${baseVersion} — `
        + 'a local mount would refuse the base that is right there',
      )
    }
    // Wide enough for a base-only fix: a caret range on 0.x accepts patch releases, which is what
    // "fix shared code with one base release" needs. An exact pin or a `~` range would block it.
    if (/^[~=]|^\d+\.\d+\.\d+$/u.test(wiring.peer)) {
      fail(
        `${plugin.name}'s peer range for ${BASE} is ${wiring.peer} — too narrow: a patch/minor base release `
        + '(one base release must be enough to fix shared code) would fall outside it',
      )
    }
  }
  if (manifest.peerDependenciesMeta?.[BASE]?.optional === true) {
    fail(`${plugin.name} marks ${BASE} an OPTIONAL peer — it must be required (a missing base degrades at runtime, not at install time)`)
  }
  for (const section of ['dependencies', 'optionalDependencies']) {
    if (manifest[section]?.[BASE] !== undefined) {
      fail(
        `${plugin.name} lists ${BASE} in ${section} — it must be a PEER: a runtime dependency would let `
        + 'the installer place it inside the plugin, and the plugin must load the host-provided copy',
      )
    }
  }
}
if (pluginRanges.length > 0) {
  note(
    `plugin base wiring: ${pluginRanges.map((p) => `${p.plugin} peer ${p.range} = dev ${String(p.dev)}`).join(', ')}`,
  )
}
const distinctRanges = new Set(pluginRanges.map((p) => p.range))
if (distinctRanges.size > 1) {
  note(`WARNING: the two plugins declare different ${BASE} peer ranges (${[...distinctRanges].join(', ')}) — keep them in step`)
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

// ── 6. the publish order: the registry already carries a compatible base ────────────────────────
let baseVersions
if (offline) {
  note('registry probe skipped (--offline) — base→plugin publish order NOT verified')
} else {
  baseVersions = await publishedBaseVersions()
  if (baseVersions === undefined) {
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
  } else if (baseVersions.length === 0) {
    if (allowMissingBase) {
      note(`WARNING: ${BASE} is not published yet — publish it BEFORE the plugins (--allow-missing-base given, so this is not fatal)`)
    } else {
      fail(
        `${BASE} has no published version, but the plugins declare it as a required peer.\n`
        + `    Publish the base FIRST:\n      pnpm -C ${BASE_DIR} publish\n`
        + '    or, for a pre-publication dry run, re-run with:\n'
        + '      node scripts/release-check.mjs --allow-missing-base',
      )
    }
  } else {
    for (const { plugin, range } of pluginRanges) {
      const accepted = baseVersions.filter((version) => satisfies(range, version))
      if (accepted.length === 0) {
        const detail =
          `${BASE} is published (${baseVersions.join(', ')}) but no version satisfies ${plugin}'s peer `
          + `range ${range} — the plugin would install without a base it accepts.`
        if (allowMissingBase) note(`WARNING: ${detail}`)
        else fail(`${detail}\n    Fix: publish a ${BASE} version inside ${range} first.`)
      } else {
        note(`${plugin} ${range} → registry has ${BASE}@${accepted[accepted.length - 1]}`)
      }
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
for (const line of notes) console.log(`  note  ${line}`)
for (const problem of problems) console.error(`  FAIL  ${problem}`)
if (problems.length > 0) {
  console.error(`\nrelease-check: FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nrelease-check ok — three publishable packages, base before plugins, one zod')

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
/**
 * The versions of `@avantf/dsh-plugin-base` on the registry, or `undefined` when it could not be
 * asked. A 404 is an empty list (the package does not exist yet), not an error.
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
    return Object.keys(versions).sort(compareVersions)
  } catch {
    return undefined
  }
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
