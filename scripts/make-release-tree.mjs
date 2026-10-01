#!/usr/bin/env node
/**
 * Generate the PUBLISH repository's tree (`dsh-plugins-rc`) from this checkout.
 *
 * The projection is the WHOLE repository: every tracked file of `dsh-plugins`, in place, not one
 * plugin's subtree. That is what makes it both simple and verifiable — the release repo has the same
 * shape as the development repo (one root `pnpm-workspace.yaml` with the one catalog, `base/` + `mem/`
 * + `mission/`, the same tests and the same gates), so nothing has to be rewritten for it to build. The
 * per-plugin projections this replaces had to strip the tests and re-derive each plugin's runtime
 * surface, because a single subtree does not contain the engine packages its bundle inlines.
 *
 * Three deliberate differences from the development tree:
 *
 *   1. The RC tooling itself (`scripts/make-release-tree.mjs`, `scripts/sync-release-repo.sh`) is NOT
 *      projected, and the root manifest loses those two script entries: the release repo is generated,
 *      it never generates anything.
 *   2. `--version <group>=<v>` stamps the ONE manifest a group records its version in (`base` |
 *      `mem` | `mission`): the group's publishable package. Its private siblings carry no `version` at
 *      all, so there is nothing to keep in lockstep and nothing that could be "not in lockstep" —
 *      grouping is by top-level tree only.
 *   3. `README.md` is generated (this repo has no root README to copy): the release repo's front page
 *      says what it is, how it was produced and in which order its three packages are published.
 *
 * The lockfile is projected verbatim and NOT regenerated: workspace package versions do not appear in
 * `pnpm-lock.yaml` (the importers record the manifest's SPECIFIER and a `link:` path), so stamping a
 * group's version cannot invalidate it. `pnpm install --frozen-lockfile` in the release checkout is the
 * assertion for that claim.
 *
 * Usage:
 *   node scripts/make-release-tree.mjs --into <dir>                     # report drift (exit 1 if any)
 *   node scripts/make-release-tree.mjs --into <dir> --apply             # sync that checkout in place
 *   node scripts/make-release-tree.mjs --out <dir> [--force]            # materialize a fresh tree
 *   node scripts/make-release-tree.mjs --print-versions [--rc <dir>]    # TSV: group/dev/rc/effective/source
 *   … [--version base=0.1.4] [--version mem=0.1.2] [--version mission=0.1.1]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION_GROUPS, publishableManifest, versionState } from './lib/versions.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A crash must not look like drift. `sync-release-repo.sh` reads exit 1 as "the projection differs"
 * and continues to confirm/apply, but an uncaught exception also exits 1 — which is how a broken
 * generator once printed `(drift above; a sync would apply it)` and then applied nothing. Crashes exit
 * `CRASH_EXIT`, so the two are distinguishable.
 */
const CRASH_EXIT = 70
const crash = (message) => {
  console.error(`make-release-tree: ${message}`)
  process.exit(CRASH_EXIT)
}
process.on('uncaughtException', (error) => crash(`crashed — ${error?.stack ?? String(error)}`))
process.on('unhandledRejection', (reason) => crash(`crashed — ${reason instanceof Error ? reason.stack : String(reason)}`))

const toPosix = (path) => path.split(sep).join('/')

/** Files whose source is the RC tooling itself, plus the root README this script generates. */
const EXCLUDE = ['scripts/make-release-tree.mjs', 'scripts/sync-release-repo.sh']
const ROOT_MANIFEST = 'package.json'
/** Root-manifest scripts whose target files are excluded above; removed from the projection. */
const RC_SCRIPTS = ['release:tree', 'sync:rc']
/** The version groups, keyed by the top-level directory that owns the manifests. */
const GROUPS = ['base', 'mem', 'mission']

const README = `# avantf DSH plugins — release source

This repository is **generated**: it is the whole of \`dsh-plugins\` projected for release by
\`pnpm sync:rc\` (\`scripts/make-release-tree.mjs\` in the development checkout). Edit the development
repository, never this one — the next sync reports any difference as drift and overwrites it.

It publishes **three packages, in this order** (the base first: each plugin declares it as a REQUIRED
peer, so a plugin published before its base is un-installable):

| package | directory | what it is |
| --- | --- | --- |
| \`@avantf/dsh-plugin-base\` | \`base/plugin-base\` | envinit + the host compatibility gate + the shared kit |
| \`@avantf/dsh-mem\` | \`mem/packages/plugin\` | the memory/knowledge plugin |
| \`@avantf/dsh-mission\` | \`mission/packages/plugin\` | the mission-tree plugin |

Everything else in the tree is \`private: true\` and is inlined into the plugin that uses it.

\`\`\`bash
pnpm install --frozen-lockfile
pnpm guard                     # mem/ and mission/ reach only the base and their own trees
pnpm release:check             # publish surface: exactly three packages, one zod, no link:/file:
pnpm proof:base-swap           # the shared logic really comes off the base at runtime
pnpm release:check:base        # per-package gates: typecheck → build → test → pack
pnpm release:check:mem         #   (mem/mission also run the real Cordis mount smoke)
pnpm release:check:mission
pnpm -C base/plugin-base publish --access public
pnpm -C mem/packages/plugin publish --access public
pnpm -C mission/packages/plugin publish --access public
\`\`\`
`

/** `git ls-files -z` in `dir` — the authoritative, deterministic file set (untracked never leaks). */
function trackedFiles(dir) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter((file) => file !== '').map(toPosix).sort()
}

// ── versions, per group ───────────────────────────────────────────────────────────────────────────
/** The version a group records (its publishable manifest), refusing to project a tree that is inconsistent. */
function devVersion(group) {
  const { versions, problems } = versionState(repo)
  if (problems.length > 0) crash(problems.join('\n  '))
  const value = versions[group]
  if (typeof value !== 'string') crash(`group ${group} records no version`)
  return value
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** `--version <group>=<v>` (repeatable) or `--version <v>` for every group. */
function requestedVersions(argv) {
  const wanted = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--version') continue
    const raw = argv[i + 1]
    if (raw === undefined) crash('--version needs a value')
    const [maybeGroup, maybeVersion] = raw.includes('=') ? raw.split('=') : [undefined, raw]
    if (maybeGroup !== undefined && !GROUPS.includes(maybeGroup)) {
      crash(`--version: unknown group '${maybeGroup}' (expected ${GROUPS.join(', ')} or a bare version)`)
    }
    if (!SEMVER.test(maybeVersion ?? '')) crash(`--version ${raw} is not a semver version`)
    for (const group of maybeGroup === undefined ? GROUPS : [maybeGroup]) wanted.set(group, maybeVersion)
  }
  return wanted
}

/** The version the release checkout currently records for a group (undefined when it has no manifest). */
function rcVersion(dir, group) {
  const file = publishableManifest(repo, group).file
  const candidate = file === undefined ? undefined : join(dir, file)
  if (candidate === undefined || !existsSync(candidate)) return undefined
  const version = JSON.parse(readFileSync(candidate, 'utf8')).version
  return typeof version === 'string' && version !== '' ? version : undefined
}

// ── the projection ────────────────────────────────────────────────────────────────────────────────
const compile = (pattern) => {
  let rx = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { rx += '(?:.*/)?'; i += 2 } else { rx += '.*'; i += 1 }
      } else rx += '[^/]*'
    } else if (ch === '?') rx += '[^/]'
    else rx += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${rx}$`)
}
const compiledExclude = EXCLUDE.map((pattern) => compile(pattern))
const excluded = (path) => compiledExclude.some((rx) => rx.test(path))

const isBinary = (buffer) => buffer.includes(0)

/** Untracked files are never projected (the source set is `git ls-files`). Say so LOUDLY: an untracked
 * NEW file — a README, a source module — is exactly what a projection drops silently, and the release
 * checkout then fails a gate far away from the cause. (That is how this warning came to exist: a new
 * package README was left untracked, the projection deleted the old one, and the rc pack gate — which
 * asserts the tarball carries its own README — blew up on a package with no README at all.) */
function warnUntracked() {
  const out = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  const untracked = out.split('\0').filter((file) => file !== '')
  if (untracked.length === 0) return
  console.error(`warning: ${String(untracked.length)} untracked file(s) are NOT projected — \`git add\` them if they belong in the release:`)
  for (const file of untracked.slice(0, 10)) console.error(`  ${file}`)
  if (untracked.length > 10) console.error(`  …and ${String(untracked.length - 10)} more`)
}

/** The whole projected tree: relative path → Buffer. */
function projectTree(stamps) {
  warnUntracked()
  const files = new Map()
  const missing = []
  const paths = [...new Set([...trackedFiles(repo), 'README.md'])].sort()
  for (const path of paths) {
    if (excluded(path)) continue
    // This repository has no root README to copy, so the projection generates one. If one ever appears
    // in the development tree it wins: the branch below only fires when the file is absent.
    if (path === 'README.md' && !existsSync(join(repo, path))) {
      files.set(path, Buffer.from(README, 'utf8'))
      continue
    }
    const source = join(repo, path)
    if (!existsSync(source)) {
      // Tracked by git but gone from the working tree: a deletion not yet committed. The projection
      // follows the WORKING TREE, so it drops the file (and reports it), rather than crashing on the
      // normal state of a refactor in progress.
      missing.push(path)
      continue
    }
    const raw = readFileSync(source)
    if (statSync(source).size === 0 || isBinary(raw)) {
      files.set(path, raw)
      continue
    }
    let text = raw.toString('utf8')
    if (path === ROOT_MANIFEST) {
      const manifest = JSON.parse(text)
      for (const name of RC_SCRIPTS) {
        if (typeof manifest.scripts?.[name] !== 'string') crash(`${path}: no scripts["${name}"] to remove (renamed?)`)
        delete manifest.scripts[name]
      }
      text = `${JSON.stringify(manifest, null, 2)}\n`
    } else if (path.endsWith('package.json')) {
      // A version stamp lands ONLY on the group's version carrier (its publishable manifest): the other
      // manifests are private and carry no version at all. This is what makes `--version <group>=<v>` an
      // rc-only cut, and it keeps the release checkout passing its own `pnpm version:check`.
      const group = VERSION_GROUPS.find((candidate) => publishableManifest(repo, candidate).file === path)
      const stamp = group === undefined ? undefined : stamps.get(group)
      if (stamp !== undefined) {
        const manifest = JSON.parse(text)
        manifest.version = stamp
        text = `${JSON.stringify(manifest, null, 2)}\n`
      }
    }
    files.set(path, Buffer.from(text, 'utf8'))
  }
  if (missing.length > 0) {
    console.error(`note: ${String(missing.length)} file(s) are tracked but missing from the working tree (dropped from the projection):`)
    for (const path of missing.slice(0, 10)) console.error(`  ${path}`)
  }
  return files
}

/**
 * Refuse to project a workspace that still carries a `link:`/`file:` override: the projection is
 * verbatim, so such an entry would be committed into the release repo, where the sibling checkout it
 * points at does not exist.
 */
function assertNoWorkspaceLinks() {
  const text = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')
  const offender = /^\s+"?(@?[^":\s]+)"?:\s*(link|file):\S+\s*$/mu.exec(text)
  if (offender !== null) {
    crash(
      `pnpm-workspace.yaml still overrides "${offender[1]}" with a ${offender[2]}: specifier `
      + `(${offender[0].trim()}). Remove the override (and run \`pnpm install\`) before projecting.`,
    )
  }
}

/** Remove now-empty directories left behind by deletions, up to (not including) `root`. */
function pruneEmptyDirs(root, startDir) {
  let dir = startDir
  while (dir !== root && dir.startsWith(root) && existsSync(dir) && readdirSync(dir).length === 0) {
    // `rmdirSync`, not `rmSync`: removing a DIRECTORY with `rmSync` needs `recursive`, and this one is
    // empty by the loop condition. (The first real deletion — `mem/release/README.md` — is what found
    // this: the file went, then the empty directory threw EISDIR and aborted the apply.)
    rmdirSync(dir)
    dir = dirname(dir)
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const USAGE = `usage:
  node scripts/make-release-tree.mjs --into <dir> [--apply] [--version <group>=<v>]…
  node scripts/make-release-tree.mjs --out <dir> [--force] [--version <group>=<v>]…
  node scripts/make-release-tree.mjs --print-versions [--rc <dir>] [--version <group>=<v>]…

projects the WHOLE repository (every tracked file except the RC tooling itself) into the release
checkout. --version stamps one version group: base | mem | mission (bare <v> = all three).
--print-versions writes one `|`-separated line per group: group, dev, rc, effective, source.`

if (flag('--help') || flag('-h')) {
  console.log(USAGE)
  process.exit(0)
}

const outDir = value('--out')
const intoDir = value('--into')
const printVersions = flag('--print-versions')
/** `--print-versions` resolution: the development tree's version wins unless this is set. */
const preferRcVersions = flag('--prefer-rc-versions')
const stamps = requestedVersions(argv)

if (printVersions) {
  const rcDir = value('--rc')
  for (const group of GROUPS) {
    const dev = devVersion(group)
    const rc = rcDir === undefined ? undefined : rcVersion(rcDir, group)
    const requested = stamps.get(group)
    const effective = requested ?? (preferRcVersions ? (rc ?? dev) : dev)
    const source = requested !== undefined
      ? 'requested'
      : preferRcVersions && rc !== undefined
        ? 'kept from rc'
        : 'from the development tree'
    // `|`-separated, not TSV: a tab is IFS *whitespace*, so `read` collapses the empty rc field and
    // every following field lands one column to the left.
    console.log([group, dev, rc ?? '-', effective, source].join('|'))
  }
  process.exit(0)
}

if ((outDir === undefined) === (intoDir === undefined)) {
  console.error(USAGE)
  process.exit(2)
}

const target = resolve(outDir ?? intoDir)
if (target === repo) crash('refusing to project the development repository onto itself')

assertNoWorkspaceLinks()
const files = projectTree(stamps)
// The projected tree must satisfy the same rule the development tree does: exactly one manifest per group
// (its carrier, stamped above) carries a version, and no private manifest carries one.
const carriers = new Set()
for (const group of VERSION_GROUPS) {
  const carrier = publishableManifest(repo, group).file
  if (carrier === undefined) crash(`group ${group} has no publishable manifest to carry its version`)
  carriers.add(carrier)
  const projected = files.get(carrier)
  const version = projected === undefined ? undefined : JSON.parse(projected.toString('utf8')).version
  if (typeof version !== 'string' || version === '') crash(`${carrier}: projected carrier has no version`)
}
for (const [path, content] of files) {
  if (path === ROOT_MANIFEST || !path.endsWith('package.json') || carriers.has(path)) continue
  const version = JSON.parse(content.toString('utf8')).version
  if (version !== undefined) crash(`${path}: projected private manifest carries version ${JSON.stringify(version)} — only ${[...carriers].join(', ')} may`)
}

if (outDir !== undefined) {
  if (existsSync(target) && readdirSync(target).length > 0 && !flag('--force')) {
    crash(`${target} is not empty — pass --force to overwrite it`)
  }
  mkdirSync(target, { recursive: true })
  let written = 0
  for (const [path, content] of files) {
    const destination = join(target, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
    written += 1
  }
  console.log(`wrote ${String(written)} files to ${target}`)
  process.exit(0)
}

if (!existsSync(join(target, '.git'))) {
  crash(`${target} is not a git checkout (needed to know which files it owns)`)
}

// ── --into: report the drift, or apply it ─────────────────────────────────────────────────────────
// Drift is about the FILES ON DISK in the target, not about the target's git index: a first sync into a
// fresh checkout has every file present-but-untracked right after `--apply`, and comparing against
// `git ls-files` alone would report the whole tree as still missing (so the wrapper's post-apply verify
// could never pass). The index is used for exactly one thing — the DELETABLE set: an untracked file in
// the target (`node_modules/`, a build output, a tarball) is never removed by a projection.
const owned = new Set(trackedFiles(target))
const added = []
const modified = []
const deleted = []
for (const [path, content] of files) {
  const current = join(target, path)
  if (existsSync(current) && readFileSync(current).equals(content)) continue
  if (existsSync(current)) modified.push(path)
  else added.push(path)
}
for (const path of owned) {
  if (files.has(path)) continue
  if (!existsSync(join(target, path))) continue
  deleted.push(path)
}

const list = (label, paths) => {
  if (paths.length === 0) return
  console.log(`\n${label} (${String(paths.length)}):`)
  for (const path of paths.slice(0, 200)) console.log(`  ${path}`)
  if (paths.length > 200) console.log(`  …and ${String(paths.length - 200)} more`)
}
list('+ add', added)
list('~ change', modified)
list('- delete', deleted)

const drift = added.length + modified.length + deleted.length
if (!flag('--apply')) {
  console.log(drift === 0
    ? '\nno drift in the projected files — the release checkout is exactly the projection'
    : `\n${String(drift)} file(s) drift from the projection (run again with --apply)`)
  process.exit(drift === 0 ? 0 : 1)
}

for (const path of [...added, ...modified]) {
  const destination = join(target, path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, files.get(path))
}
for (const path of deleted) {
  const destination = join(target, path)
  // Tracked but already gone from the working tree (a removal not yet committed) is not an error.
  if (existsSync(destination)) rmSync(destination)
  pruneEmptyDirs(target, dirname(destination))
}
console.log(`\napplied: +${String(added.length)} ~${String(modified.length)} -${String(deleted.length)}`)
