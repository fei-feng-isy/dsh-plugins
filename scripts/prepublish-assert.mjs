#!/usr/bin/env node
/**
 * The publish-time assertions that replace the retired RC projection (review 2026-10-03 §1.5/§7.11).
 *
 * WHY THIS FILE EXISTS. `../dsh-plugins-rc` used to be a whole-repository projection of this checkout,
 * made only so that three differences could exist in the release tree:
 *
 *   1. the RC tooling itself was NOT projected — the release repo is generated, it never generates;
 *   2. `--version <group>=<v>` stamped the ONE manifest a group records its version in;
 *   3. a root `README.md` was generated (the development repo had none).
 *
 * The projection's only remaining contribution was drift risk, so the decision (user, 2026-10-03) is to
 * publish straight from the development tree. That makes the three differences assertions that must hold
 * IN this tree before `pnpm publish`:
 *
 *   1. **nothing that ships carries repository release tooling** — no publishable package's `files`
 *      escapes its own directory or names the release machinery, and the root manifest stays private;
 *   2. **the version is stamped** — each group records its version in exactly ONE manifest, that value
 *      is semver, no private manifest restates it, and the base's baked `VERSION` constant agrees
 *      (the SAME rules as `pnpm version:check`, reused from `scripts/lib/`, never re-implemented);
 *   3. **each package ships its own README** and its first line is `# <package name>` — the npm page.
 *
 * Plus the invariant the whole release surface hangs on: **the publishable set is exactly three
 * packages** (base + the two plugins, in publish order).
 *
 * Usage:
 *   node scripts/prepublish-assert.mjs                                  # the whole release surface
 *   node scripts/prepublish-assert.mjs --package @avantf/dsh-mem        # + assert this is one of the three
 *   node scripts/prepublish-assert.mjs --tarball dist/avantf-dsh-mem-*.tgz   # + assert the packed bytes
 *
 * It only READS: no build, no pack, no publish, no network. Wire it into each publishable manifest's
 * `prepublishOnly` ahead of the existing per-package gate (see root `docs/RELEASING.md`). `--tarball`
 * additionally inspects a tarball a previous `pnpm pack` produced — the per-package `pack-plugin` gates
 * already pack and assert their own shape; this flag is the byte-level half of "no RC tooling shipped".
 *
 * @module scripts/prepublish-assert
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { bakedVersionProblems } from './lib/bootstrap-version.mjs'
import { repoRoot as repo } from './lib/plugins.mjs'
import { versionState } from './lib/versions.mjs'

/** The packages that may be published, and where they live. Order is the PUBLISH order. */
const PUBLISHABLE = new Map([
  ['base/plugin-base', '@avantf/dsh-plugin-base'],
  ['mem/packages/plugin', '@avantf/dsh-mem'],
  ['mission/packages/plugin', '@avantf/dsh-mission'],
  ['identity/packages/plugin', '@avantf/dsh-identity'],
])

/**
 * The workspace globs the publishable packages live under. Compared for EQUALITY with what `pnpm-workspace.yaml`
 * declares: a new glob adds a subtree this gate would otherwise never look at, and a publishable
 * package inside it would escape "the rest stay private" without a trace. Kept in step with
 * `scripts/release-check.mjs` (which asserts the same equality as part of the full release gate);
 * this file's copy exists so a publish can assert the surface without running the whole gate.
 */
const WORKSPACE_PATTERNS = ['base/*', 'mem/packages/*', 'mission/packages/*', 'identity/packages/*']

/**
 * The files that made up the retired projection. They are named here so a future copy that rides a
 * tarball — the one way release tooling could still leak into a published artifact — is a FAILURE and
 * not something a reviewer has to notice.
 */
const RC_TOOLING = ['scripts/make-release-tree.mjs', 'scripts/sync-release-repo.sh']
const RC_TOOLING_NAMES = new Set(RC_TOOLING.map((path) => path.split('/').at(-1)))

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** The `packages:` globs `pnpm-workspace.yaml` declares (same reader as `scripts/release-check.mjs`). */
function declaredWorkspacePatterns(text) {
  const list = /^packages:[ \t]*\n([\s\S]*?)(?=^[^\s#]|$(?![\s\S]))/mu.exec(text)
  if (list === null) return []
  return [...list[1].matchAll(/^[ \t]+-\s*['"]?([^'"\s#]+)['"]?\s*$/gmu)].map((match) => match[1])
}

/** Every directory one workspace glob matches that carries a `package.json`, plus any glob problem. */
function expandWorkspacePattern(pattern) {
  const star = pattern.indexOf('*')
  const parent = (star === -1 ? pattern : pattern.slice(0, star)).replace(/\/+$/, '')
  const base = join(repo, parent)
  if (!existsSync(base)) return { dirs: [], problem: `workspace pattern ${pattern} matches no directory (${parent}/ is missing)` }
  if (star === -1) return { dirs: existsSync(join(base, 'package.json')) ? [parent] : [], problem: undefined }
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map((entry) => `${parent}/${entry.name}`)
  return { dirs, problem: undefined }
}

// ── 1. the publishable set is exactly the three ─────────────────────────────────────────────────
function checkPublishableSet() {
  const found = []
  const workspaceFile = join(repo, 'pnpm-workspace.yaml')
  if (!existsSync(workspaceFile)) return { problems: ['pnpm-workspace.yaml is missing — this is not the merged workspace'], note: undefined }

  const declared = declaredWorkspacePatterns(readFileSync(workspaceFile, 'utf8'))
  for (const pattern of declared.filter((candidate) => !WORKSPACE_PATTERNS.includes(candidate))) {
    found.push(`pnpm-workspace.yaml lists workspace pattern ${pattern}, which this publish gate does not know — `
      + 'add it to WORKSPACE_PATTERNS here AND to scripts/release-check.mjs, then decide the publishable set')
  }
  for (const pattern of WORKSPACE_PATTERNS.filter((candidate) => !declared.includes(candidate))) {
    found.push(`pnpm-workspace.yaml does not list packages: ${pattern}`)
  }

  const dirs = new Set()
  for (const pattern of declared) {
    const expanded = expandWorkspacePattern(pattern)
    if (expanded.problem !== undefined) found.push(expanded.problem)
    for (const dir of expanded.dirs) dirs.add(dir)
  }
  const sorted = [...dirs].sort()
  const seen = new Set()
  for (const dir of sorted) {
    const manifest = readManifest(dir)
    if (manifest === undefined) continue
    const expected = PUBLISHABLE.get(dir)
    const publishable = manifest.private !== true
    if (publishable && expected === undefined) {
      found.push(`${manifest.name ?? dir} (${dir}) is publishable but is NOT one of the three release packages — `
        + 'add `"private": true` (an internal engine/kit package must never reach npm)')
    }
    if (!publishable && expected !== undefined) {
      found.push(`${dir} is one of the three release packages but declares \`"private": true\``)
    }
    if (expected !== undefined) {
      seen.add(dir)
      if (manifest.name !== expected) found.push(`${dir} is named ${manifest.name}, expected ${expected}`)
    }
  }
  for (const [dir, name] of PUBLISHABLE) {
    if (!seen.has(dir)) found.push(`missing release package ${name} at ${dir}`)
  }

  const rootManifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  if (rootManifest.private !== true) {
    found.push('the root manifest is not `"private": true` — the workspace (scripts, gates, release tooling) would be publishable')
  } else if (found.length === 0) {
    return { problems: [], note: `publishable set is exactly ${[...PUBLISHABLE.values()].join(', ')} `
      + `(${sorted.length} workspace packages, the rest private; the root manifest is private)` }
  }
  return { problems: found, note: undefined }
}

// ── 2. the version is stamped: ONE manifest per group, and base's baked constant agrees ──────────
function checkVersionStamping() {
  // Same functions `pnpm version:check` uses, so a rule can never fork between the gate and a publish.
  const state = versionState(repo)
  const found = state.problems.map((problem) => `version stamping: ${problem}`)
  found.push(...bakedVersionProblems(repo, state.versions).map((problem) => `version stamping: ${problem}`))
  const note = found.length === 0
    ? `version stamped in one manifest per group (base ${state.versions.base}, mem ${state.versions.mem}, mission ${state.versions.mission}, identity ${state.versions.identity})`
    : undefined
  return { problems: found, note }
}

// ── 3. each package ships its own README, and its first line names the package ──────────────────
function checkReadmes() {
  const found = []
  for (const [dir, name] of PUBLISHABLE) {
    const readme = join(repo, dir, 'README.md')
    if (!existsSync(readme)) {
      found.push(`${dir}: no README.md — the npm page has to be the package's own README`)
      continue
    }
    const text = readFileSync(readme, 'utf8')
    const firstLine = text.split('\n')[0]?.trim() ?? ''
    if (text.trim() === '') found.push(`${dir}/README.md is empty — the npm page has to be the package's own README`)
    else if (firstLine !== `# ${name}`) {
      found.push(`${dir}/README.md starts with ${JSON.stringify(firstLine)}, expected "# ${name}" `
        + '(a copy/rename slip would publish another package\'s page)')
    }
  }
  return { problems: found, note: found.length === 0 ? 'each publishable package has its own README, first line = the package name' : undefined }
}

// ── 4. nothing that ships carries repository release tooling ────────────────────────────────────
// The projection used to guarantee this by omitting the RC files from the release tree. Without a
// projection there is no tree to omit them from, so the invariant moves onto what a package may ship:
// `files` stays inside the package, and no shipped path names the release machinery.
function checkNoReleaseTooling() {
  const found = []
  for (const [dir] of PUBLISHABLE) {
    const manifest = readManifest(dir)
    if (manifest === undefined) continue
    for (const raw of Array.isArray(manifest.files) ? manifest.files : []) {
      if (typeof raw !== 'string') continue
      const entry = raw.replace(/^!/u, '')
      if (entry.startsWith('/') || entry.split('/').includes('..')) {
        found.push(`${dir}: \`files\` entry ${JSON.stringify(raw)} escapes the package directory — a published tarball may only carry files from its own package (this is how repository tooling would leak)`)
        continue
      }
      if (RC_TOOLING_NAMES.has(entry.split('/').at(-1))) {
        found.push(`${dir}: \`files\` entry ${JSON.stringify(raw)} is retired release tooling — it must never ship`)
      }
    }
    for (const [label, value] of [['main', manifest.main], ['types', manifest.types]]) {
      if (typeof value === 'string' && RC_TOOLING_NAMES.has(value.split('/').at(-1))) {
        found.push(`${dir}: \`${label}\` names retired release tooling (${value}) — it must never ship`)
      }
    }
  }
  return { problems: found, note: found.length === 0 ? 'no publishable package ships (or points at) repository release tooling' : undefined }
}

// ── 5. optional: assert the packed BYTES too ─────────────────────────────────────────────────────
function tarEntries(tarball) {
  return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter((line) => line !== '')
}
function tarFile(tarball, entry) {
  return execFileSync('tar', ['-xzOf', tarball, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function checkTarballs(tarballs) {
  const found = []
  for (const tarball of tarballs) {
    if (!existsSync(tarball)) {
      found.push(`--tarball ${tarball}: no such file`)
      continue
    }
    const entries = tarEntries(tarball)
    for (const entry of entries) {
      if (RC_TOOLING.includes(entry.replace(/^package\//u, '')) || RC_TOOLING_NAMES.has(entry.split('/').at(-1))) {
        found.push(`${tarball}: carries repository release tooling (${entry}) — the published artifact must not ship the release machinery`)
      }
    }
    const readmeEntry = 'package/README.md'
    if (!entries.includes(readmeEntry)) {
      found.push(`${tarball}: no package/README.md — the npm page has to be the package's own README`)
      continue
    }
    const firstLine = tarFile(tarball, readmeEntry).split('\n')[0]?.trim() ?? ''
    let name
    try {
      name = JSON.parse(tarFile(tarball, 'package/package.json')).name
    } catch {
      name = undefined
    }
    if (name === undefined) found.push(`${tarball}: package/package.json is unreadable — cannot check the README title`)
    else if (firstLine !== `# ${name}`) found.push(`${tarball}: README.md starts with ${JSON.stringify(firstLine)}, expected "# ${name}"`)
  }
  return { problems: found, note: tarballs.length > 0 && found.length === 0
    ? `packed tarball(s) carry no release tooling and ship the right README: ${tarballs.join(', ')}`
    : undefined }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const USAGE = `usage:
  node scripts/prepublish-assert.mjs [--package <name|dir>] [--tarball <path>]…

asserts the release surface before publishing straight from this checkout:
  · the publishable set is exactly base + the two plugins;
  · each group's version is stamped in ONE manifest and the base's baked VERSION agrees;
  · each package ships its own README (first line "# <package name>");
  · nothing that ships carries repository release tooling.
--tarball additionally inspects a tarball a previous \`pnpm pack\` produced.`

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}

const problems = []
const notes = []
let selected
const tarballs = []
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  const takeValue = () => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`prepublish-assert: ${arg} needs a value`)
      process.exit(2)
    }
    index += 1
    return value
  }
  if (arg === '--package') selected = takeValue()
  else if (arg === '--tarball') tarballs.push(takeValue())
  else {
    console.error(`prepublish-assert: unknown option ${arg}`)
    console.error(USAGE)
    process.exit(2)
  }
}

if (selected !== undefined && !PUBLISHABLE.has(selected) && ![...PUBLISHABLE.values()].includes(selected)) {
  problems.push(`--package ${selected}: not one of the publishable packages (${[...PUBLISHABLE.values()].join(', ')})`)
} else if (selected !== undefined) {
  notes.push(`--package ${selected}: is a publishable package`)
}

// ── run the checks ───────────────────────────────────────────────────────────────────────────────
for (const check of [checkPublishableSet(), checkVersionStamping(), checkReadmes(), checkNoReleaseTooling()]) {
  problems.push(...check.problems)
  if (check.note !== undefined) notes.push(check.note)
}
if (tarballs.length > 0) {
  const packed = checkTarballs(tarballs)
  problems.push(...packed.problems)
  if (packed.note !== undefined) notes.push(packed.note)
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
for (const note of notes) console.log(`ok   ${note}`)
if (problems.length > 0) {
  console.error(`\nprepublish-assert FAILED (${String(problems.length)}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nA failing assertion means this tree is NOT safe to publish. Fix the cause; never publish around it.')
  process.exit(1)
}
console.log('\n✓ prepublish-assert ok — the development tree satisfies the release invariants the RC projection used to enforce')
