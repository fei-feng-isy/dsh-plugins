#!/usr/bin/env node
/**
 * One-command release gate: everything that must be green at the tag, plus the two metadata checks
 * that only matter when cutting a version (the packages agree, and the CHANGELOG has the section).
 *
 * Why a script instead of a list in a document: the plugin's most important surface — that it
 * MOUNTS in a real DSH host — cannot run in CI (the harness's transitive deps are not all published,
 * see `docs/RELEASING.md`), so it is exactly the step a human forgets. Running the whole set with one
 * command, and failing the run if any step does, is the only enforcement that exists for it.
 *
 * The steps before the plugin ones are what CI already runs: keeping them here means a release
 * candidate is verified as ONE tree rather than as "CI was green at some commit".
 *
 * Usage:
 *   pnpm release:check                  # STRICT: the two CHANGELOG-cut checks must pass (tag time)
 *   pnpm release:check --allow-uncut     # pre-tag dry run: same gates, the cut checks only warn
 * Needs an installed global `dsh` (`npm i -g @deepseek-ai/dsh`) for the three LOCAL plugin steps
 * (see `scripts/link-dsh.mjs`). Exits non-zero if any step fails. No harness source checkout is
 * needed to compile, type-check or mount — the client preset is pinned in this repository.
 *
 * Packing the single installable package (`scripts/pack-plugin.mjs`) is one of the steps BELOW, not a
 * step the release repository adds. `scripts/sync-release-repo.sh --gate` and the RC's
 * `pnpm release:check:mem` run a projected copy of THIS script, so if the pack step lived only in RC
 * the two would either double-pack or each assume the other did it. Keeping it here means the
 * tarball-level assertions (self-contained bundle, shipped declaration surface, README/LICENSE,
 * `workspace:`/`catalog:` leftovers, lib strays) run in both checkouts, from one definition.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findHarness } from '../../scripts/lib/harness-path.mjs'
import { spawnToolSync } from '../../scripts/lib/win-spawn.mjs'
import { versionState } from '../../scripts/lib/versions.mjs'
import { presetDriftWarning } from './check-preset-drift.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The workspace root: `versions.mjs` and the release projection live there, one level above mem/. */
const workspaceRoot = resolve(repo, '..')

const argv = process.argv.slice(2)
const known = ['--allow-uncut', '--help', '-h']
const unknown = argv.filter((flag) => !known.includes(flag))
if (unknown.length > 0) {
  console.error(`release-check: unknown option ${unknown.join(', ')}`)
  console.error('usage: node scripts/release-check.mjs [--allow-uncut]')
  process.exit(2)
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/release-check.mjs [--allow-uncut]')
  process.exit(0)
}

/**
 * Every package this checkout actually contains, derived from the directory rather than hardcoded:
 * the release tree ships only the plugin and the engine it inlines (cli/mcp are development-only), so
 * a fixed list would either crash there or have to be kept in two places.
 */
const PACKAGES = readdirSync(join(repo, 'packages'))
  .filter((name) => existsSync(join(repo, 'packages', name, 'package.json')))
  .sort()
if (!PACKAGES.includes('plugin')) {
  console.error('release-check: packages/plugin is missing from this checkout')
  process.exitCode = 1
}

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(repo, 'packages', dir, 'package.json'), 'utf8'))
}

/**
 * The body of the `## [Unreleased]` section, up to the next version heading (or the end of the file).
 *
 * Split by lines rather than matched by one regex: the previous pattern ended its lookahead with
 * `\Z`, which is NOT a JavaScript regex token — it matches a literal "Z". The capture then ran to
 * the first capital Z anywhere later in the file, and when there was none the whole match failed, so
 * `unreleased` was '' and "[Unreleased] still carries entries" could never fire. A release gate that
 * silently stops checking is worse than no gate, because it still prints PASSED.
 */
function unreleasedSection(changelog) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.startsWith('## [Unreleased]'))
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^## \[/.test(line))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

/**
 * Parse a tsconfig, which is JSONC: `//` and block comments and trailing commas are legal there and
 * `JSON.parse` rejects all three. Comments are skipped only OUTSIDE a string, so a URL in a value
 * (`https://…`) survives.
 */
function parseJsonc(text) {
  let out = ''
  let inString = false
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]
    const next = text[at + 1]
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        at += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      while (at < text.length && text[at] !== '\n') at += 1
      out += '\n'
      continue
    }
    if (char === '/' && next === '*') {
      at += 2
      while (at < text.length && !(text[at] === '*' && text[at + 1] === '/')) at += 1
      at += 1
      continue
    }
    out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/**
 * Every `types` entry point a package declares, as paths relative to that package.
 *
 * Both the top-level `types` field and each `exports` condition, because a consumer's resolver may
 * read either one.
 */
function declaredTypeEntryPoints(manifest) {
  return [
    manifest.types,
    ...Object.values(manifest.exports ?? {}).flatMap((entry) =>
      typeof entry === 'object' && entry !== null ? [entry.types] : []),
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => value.replace(/^\.\//, ''))
}

/**
 * After the build: every declared type entry point must EXIST.
 *
 * The failure this catches is silent by construction — when a `types` condition points at a file that
 * is not there, TypeScript falls back to the `default` condition and finds the neighbouring `.d.ts`
 * anyway. Seven packages shipped `lib/types/index.d.ts` while `tsc` emitted `lib/index.d.ts`: working
 * in this workspace, broken for anything that resolves `exports` strictly (and for the moment
 * `@avantf/mem` is published). `packages/plugin` is the one that really does emit to `lib/types`,
 * because tsdown owns `lib` there — which is why this is a file check and not a hardcoded layout.
 */
function missingTypeEntryPoints() {
  const problems = []
  for (const name of PACKAGES) {
    const declared = declaredTypeEntryPoints(manifestOf(name))
    if (declared.length === 0) {
      problems.push(`${name}: declares no "types" entry point at all`)
      continue
    }
    for (const relative of declared) {
      if (!existsSync(join(repo, 'packages', name, relative))) {
        problems.push(`${name}: "types" declares ${relative}, which the build did not produce`)
      }
    }
  }
  return problems
}

/**
 * The same entry points, checked statically BEFORE any build: a cheap early signal when the tree has
 * not been built yet, and the reason a wrong `types` path is caught in preflight rather than only
 * after a full build.
 *
 * Two conditions, because "starts with `outDir`" alone is not enough: a path INSIDE `outDir` but in a
 * subdirectory `tsc` never writes — `lib/types/index.d.ts` while `outDir` is `lib` — passes that test
 * and is exactly the stale shape this gate was added for (seven packages shipped it). So the suffix
 * is also checked against the SOURCES: `outDir/X.d.ts` exists only if `src/X.ts` (or `.tsx`/`.mts`/
 * `.cts`) does. That is the general rule tsc follows here (`rootDir: src`), not a hardcoded layout —
 * which matters because `packages/plugin` really does emit to `lib/types`.
 */
function typeEntryPointProblems() {
  const problems = []
  for (const name of PACKAGES) {
    const manifest = manifestOf(name)
    let tsconfig
    try {
      tsconfig = parseJsonc(readFileSync(join(repo, 'packages', name, 'tsconfig.json'), 'utf8'))
    } catch {
      problems.push(`${name}: tsconfig.json is missing or not parseable — cannot verify its type entry points`)
      continue
    }
    const outDir = tsconfig.compilerOptions?.declarationDir ?? tsconfig.compilerOptions?.outDir
    if (typeof outDir !== 'string') continue
    const base = `${outDir.replace(/\/+$/, '')}/`
    for (const relative of declaredTypeEntryPoints(manifest)) {
      if (!relative.startsWith(base)) {
        problems.push(`${name}: "types" points at ${relative} but tsc writes to ${base} — the path does not exist and consumers silently fall back`)
        continue
      }
      const suffix = relative.slice(base.length).replace(/\.d\.ts$/, '')
      const source = ['ts', 'tsx', 'mts', 'cts']
        .some((ext) => existsSync(join(repo, 'packages', name, 'src', `${suffix}.${ext}`)))
      if (!source) {
        problems.push(`${name}: "types" declares ${relative}, but tsc emits that only for a source at src/${suffix}.ts — nothing is written there`)
      }
    }
  }
  return problems
}

/** Metadata checks: cheap, and each one has actually been wrong at some point. */
function preflight(allowUncut) {
  const problems = []
  const warnings = []
  // ONE version per group, recorded in exactly one manifest: the publishable package. Every private
  // manifest must carry NO version (a second copy is a second thing to update) — the rule and the
  // mapping live in the workspace root's `scripts/lib/versions.mjs`, shared with the root gate and the
  // release projection, so this checkout cannot disagree with either.
  const state = versionState(workspaceRoot)
  problems.push(...state.problems, ...typeEntryPointProblems())
  const version = state.versions.mem
  if (version === undefined) problems.push('the mem group records no version (packages/plugin/package.json)')
  // The two "cut the release" checks: at the tag, the FIRST versioned section must be this version
  // and [Unreleased] must be empty ("has a section" is not the property that matters — a stale old
  // section would satisfy it). They only apply where a CHANGELOG exists: the release repository
  // ships the source without one, and a gate that refuses to run there would just be turned off.
  const changelogPath = join(repo, 'CHANGELOG.md')
  const hasChangelog = existsSync(changelogPath)
  if (!hasChangelog) {
    console.log('note: no CHANGELOG.md in this checkout — version-consistency checked, changelog cut NOT checked')
  } else {
    const changelog = readFileSync(changelogPath, 'utf8')
    const versioned = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]).filter((name) => name !== 'Unreleased')
    const unreleased = unreleasedSection(changelog)
    if (!allowUncut) {
      if (versioned[0] !== version) {
        problems.push(`CHANGELOG.md's first versioned section is "${versioned[0] ?? '(none)'}" but the packages are ${version} — rename [Unreleased] to [${version}] at the tag`)
      }
      if (/^### /m.test(unreleased)) {
        problems.push('[Unreleased] still carries entries — cut them into the version section before tagging')
      }
    } else if (versioned[0] !== version || /^### /m.test(unreleased)) {
      warnings.push('running with --allow-uncut: the CHANGELOG is not cut for a tag yet (expected before the cut)')
    }
  }
  // The harness peers are resolved by `scripts/link-dsh.mjs`, never by pnpm (the packages are not
  // all published), so a stale range is invisible to every other gate. A release must not claim a
  // window it has never run against.
  const plugin = JSON.parse(readFileSync(join(repo, 'packages', 'plugin', 'package.json'), 'utf8'))
  const peers = Object.entries(plugin.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
  if (peers.length === 0) problems.push('packages/plugin declares no @deepseek-ai/dsh peer')
  // ONE package is published: the plugin inlines the engine, so the other five are workspace-only and
  // carry `private: true`. That is a property of the manifests, not of everyone's memory — a stray
  // `pnpm -r publish` must be impossible, and a plugin that quietly became private must be caught.
  const publishable = PACKAGES.filter((name) => {
    const manifest = JSON.parse(readFileSync(join(repo, 'packages', name, 'package.json'), 'utf8'))
    return manifest.private !== true
  })
  if (publishable.join(',') !== 'plugin') {
    problems.push(`only packages/plugin may be publishable, but ${publishable.join(', ') || '(none)'} would publish — the engine/CLI/MCP are workspace-only (private: true)`)
  }
  return { version, problems, warnings, peers, hasChangelog }
}

// A fresh checkout has no `packages/plugin/node_modules/@deepseek-ai` at all — the peers are
// declared, deliberately not installed (`autoInstallPeers: false`), so the LOCAL steps link them from
// the INSTALLED global dsh. Linking here (rather than documenting a prerequisite) is what makes the
// gate runnable on a clone, which is the only place it is ever run in full.
//
// A harness source checkout takes no part in compiling. When one IS present it is used for one
// optional thing: comparing the preset pinned under `packages/plugin/vendor/dsh-client-preset/`
// against its origin, so a drift is never silent. Printed as a note (not a failed step): a checkout
// legitimately moves ahead between re-alignments.
const harness = findHarness()
if (harness !== undefined) {
  const presetDrift = presetDriftWarning(harness)
  if (presetDrift !== undefined) console.log(`note: ${presetDrift}`)
}

const STEPS = [
  ['frozen lockfile (what CI installs)', 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
  // The family base FIRST: the plugin's peer types come from its `dist/`, and `build:dsh` re-builds
  // it anyway. Publishing order is base → plugins, and this is that order inside one gate.
  ['build the family base (@avantf/dsh-plugin-base)', 'pnpm', ['--filter', '@avantf/dsh-plugin-base', 'run', 'build']],
  ['build (engine packages)', 'pnpm', ['build']],
  ['typecheck (src + tests)', 'pnpm', ['typecheck']],
  ['test (all packages)', 'pnpm', ['test']],
  ["link the plugin's DSH peers (LOCAL: the installed dsh)", process.execPath,
    ['scripts/link-dsh.mjs']],
  ['plugin typecheck (LOCAL: the installed dsh)', 'pnpm', ['typecheck:dsh']],
  ['plugin build + mount smoke (LOCAL: the installed dsh)', 'pnpm', ['build:dsh']],
  // The tarball a user actually installs: `build:dsh` above is what it packs, so this MUST come after
  // it. It is what runs the artifact-level assertions (single self-contained package, shipped
  // declarations free of unpublished `@avantf/*`, no sourcemap strays) that no test or type-checker
  // can see — the shape H2/M9 shipped in 0.3.1 precisely because this step was missing here.
  ['pack the installable tarball + assert its bytes', process.execPath, ['scripts/pack-plugin.mjs']],
  // LAST on purpose: it relinks to the OLDEST dsh the plugin's own peer range declares, re-runs the
  // plugin's local steps against it, and restores the machine (relink + rebuild) — so it must not
  // run before the steps above, whose artifact is the one this checkout is built from.
  ['old-dsh gate (LOCAL: the declared dsh floor)', 'pnpm', ['check:old-dsh']],
]

const allowUncut = process.argv.includes('--allow-uncut')
const { version, problems, warnings, peers, hasChangelog } = preflight(allowUncut)
console.log(`avantf-mem release gate — version ${version}`)
console.log(`DSH peers: ${peers.map(([n, r]) => `${n.replace('@deepseek-ai/', '')}@${r}`).join(', ')}`)
if (problems.length > 0) {
  console.error('\npreflight FAILED:')
  for (const problem of problems) console.error(`  - ${problem}`)
} else {
  console.log(`preflight OK (versions agree${hasChangelog ? (allowUncut ? '' : ', CHANGELOG cut') : ', no CHANGELOG in this checkout'})`)
}
for (const warning of warnings) console.log(`note: ${warning}`)

const results = []
for (const [label, command, args] of STEPS) {
  process.stdout.write(`\n=== ${label} ===\n`)
  const result = spawnToolSync(command, args, { cwd: repo, stdio: 'inherit' })
  results.push([label, result.status === 0])
}

// The installed global dsh is a hard requirement of the three LOCAL steps, so say it is missing
// rather than leaving a bare "command failed" for the reader to decode.
if (!existsSync(join(repo, 'packages', 'plugin', 'node_modules', '@deepseek-ai', 'dsh-tools'))) {
  console.log('\nnote: packages/plugin/node_modules/@deepseek-ai is not linked — run `node scripts/link-dsh.mjs` for the LOCAL steps')
}

// The declared type entry points can only be verified against a BUILT tree, so this runs after the
// build step rather than in preflight (see `missingTypeEntryPoints`).
const built = results.some(([label, ok]) => label.startsWith('build') && ok)
if (built) {
  const missing = missingTypeEntryPoints()
  results.push(['declared type entry points exist', missing.length === 0])
  for (const problem of missing) console.error(`  - ${problem}`)
}

console.log('\n──────── release gate summary ────────')
let failed = problems.length > 0
for (const [label, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed = true
}
console.log(failed ? '\nRELEASE GATE FAILED' : `\nRELEASE GATE PASSED (${version})`)
process.exitCode = failed ? 1 : 0
