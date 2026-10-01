#!/usr/bin/env node
/**
 * The release version of each group: ONE file, and nothing to propagate.
 *
 * A group's version is recorded in exactly one place — the manifest of its publishable package
 * (`base/plugin-base`, `mem/packages/plugin`, `mission/packages/plugin`) — and every other manifest of the
 * group carries no `version` at all. So:
 *
 *   pnpm version:set mem 0.1.2   # the bump: edits mem/packages/plugin/package.json, and that is all
 *   pnpm version:check           # prints the table; fails if a private manifest grew a version again
 *   pnpm version:prune           # removes a stray `version` from a private manifest
 *
 * Because the number is not restated anywhere, there is no sync step and no way to drift. The gate and
 * the release projection read the same mapping (`scripts/lib/versions.mjs`).
 *
 * NOT handled here: `mem/CHANGELOG.md`. A version is not a release — the CHANGELOG's first versioned
 * section has to be cut to match before publishing, and mem's own release gate checks that.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot as root } from './lib/plugins.mjs'
import { bakedVersionProblems, writeBakedVersion } from './lib/bootstrap-version.mjs'
import { VERSION_GROUPS, groupManifests, publishableManifest, versionState } from './lib/versions.mjs'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

const USAGE = `usage:
  node scripts/version.mjs                     # check (also prints the table)
  node scripts/version.mjs check               # same
  node scripts/version.mjs set <group> <ver>   # the bump: edit that group's ONE manifest
  node scripts/version.mjs set <group>=<ver>   # same
  node scripts/version.mjs prune               # remove a stray version from a private manifest

groups: ${VERSION_GROUPS.join(', ')}   (group = top-level subtree; only its publishable package carries a
version, everything else in the group is private and has none)`

const table = (state) =>
  VERSION_GROUPS.map((group) => `${group} ${String(state.versions[group] ?? '?')} (${state.carriers[group] ?? '?'})`).join('\n  ')

function check() {
  const state = versionState(root)
  for (const group of VERSION_GROUPS) {
    console.log(`  ${group.padEnd(5)} ${String(state.versions[group] ?? '?').padEnd(8)} ${state.carriers[group] ?? '(no carrier)'}`)
  }
  // The base's version also exists as a constant baked into `src/bootstrap.ts`; `version:set` moves
  // both, and this is the assertion that keeps a hand-edit from splitting them (see the module header
  // of `lib/bootstrap-version.mjs` for what the split costs).
  const problems = [...state.problems, ...bakedVersionProblems(root, state.versions)]
  for (const problem of problems) console.error(`  FAIL  ${problem}`)
  if (problems.length > 0) {
    console.error(`\nversion:check FAILED (${String(problems.length)})`)
    process.exit(1)
  }
  console.log(`version:check ok — one file per group records it:\n  ${table(state)}`)
}

/** Drop `version` from a private manifest (the only drift this design can still have). */
function prune() {
  let pruned = 0
  for (const group of VERSION_GROUPS) {
    const carrier = publishableManifest(root, group).file
    for (const file of groupManifests(root, group)) {
      if (file === carrier) continue
      const path = join(root, file)
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (manifest.version === undefined) continue
      // Read BEFORE deleting: this log line is the only place that says which version was dropped.
      const dropped = manifest.version
      delete manifest.version
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
      console.log(`  ${file}: dropped version ${JSON.stringify(dropped)}`)
      pruned += 1
    }
  }
  console.log(pruned === 0
    ? 'version:prune ok — no private manifest carries a version'
    : `version:prune ok — ${String(pruned)} stray version field(s) removed`)
}

const argv = process.argv.slice(2)
const command = argv[0] ?? 'check'

if (command === '--help' || command === '-h') {
  console.log(USAGE)
  process.exit(0)
}

if (command === 'check' && argv.length <= 1) {
  check()
  process.exit(0)
}

if (command === 'prune' && argv.length === 1) {
  prune()
  process.exit(0)
}

if (command === 'set') {
  // `set mem 0.1.2` and `set mem=0.1.2` both mission: the second is what `pnpm version:set mem=0.1.2` passes.
  const [pair, second] = [argv[1], argv[2]]
  const [group, version] = pair === undefined ? [] : (pair.includes('=') ? pair.split('=') : [pair, second])
  if (group === undefined || version === undefined) {
    console.error(USAGE)
    process.exit(2)
  }
  if (!VERSION_GROUPS.includes(group)) {
    console.error(`version:set: unknown group '${group}' (expected ${VERSION_GROUPS.join(', ')})`)
    process.exit(2)
  }
  if (!SEMVER.test(version)) {
    console.error(`version:set: '${version}' is not a semver version`)
    process.exit(2)
  }
  const { file, problems } = publishableManifest(root, group)
  if (file === undefined) {
    for (const problem of problems) console.error(`  FAIL  ${problem}`)
    process.exit(1)
  }
  const path = join(root, file)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const was = manifest.version
  manifest.version = version
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`  ${file}: ${String(was)} → ${version}`)
  const baked = writeBakedVersion(root, group, version)
  if (baked !== undefined) console.log(`  ${baked.file}: ${String(baked.was)} → ${version} (baked constant)`)
  console.log('next: cut mem/CHANGELOG.md if this is a mem release, then `pnpm sync:rc`')
  process.exit(0)
}

console.error(USAGE)
process.exit(2)
