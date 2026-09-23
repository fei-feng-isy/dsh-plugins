#!/usr/bin/env node
/**
 * Generate the PUBLISH repository's tree (`avantf-work-rc`) from this checkout.
 *
 * The release repository is a projection of this one, not a fork: every projected file is
 * byte-identical, and the differences are exactly the declared ones — the test infrastructure and
 * repository-internal docs it must not carry (EXCLUDE), the files whose release variant differs
 * (TRANSFORMS, plus OVERLAY for the two READMEs), and the lockfile it regenerates. Keeping that
 * projection in ONE script is what lets the release repo stay un-edited by hand, so "release tree ==
 * this tree minus the declared differences" stays mechanically checkable.
 *
 * Usage:
 *   node scripts/make-release-tree.mjs --out <dir> [--force]   # materialize a fresh tree
 *   node scripts/make-release-tree.mjs --into <dir>            # report the drift (exit 1 if any)
 *   node scripts/make-release-tree.mjs --into <dir> --apply    # sync that checkout in place
 *
 * `--version <v>` stamps all three manifests with the release version (the version is a release
 * cut, not something to project): without it the release tree keeps the development version.
 *
 * `--into` only ever manages files TRACKED BY THE TARGET's git: `node_modules/`, `packages/<pkg>/lib/`,
 * `packages/<pkg>/dist/`, `release/` and `.git/` are untracked there and are never read, written or
 * deleted. A tracked file the projection does not produce is deleted — that is the direction of truth
 * (this repo is the source).
 *
 * `pnpm-lock.yaml` cannot be projected (dropping the test toolchain from the manifests changes the
 * resolution), so it is REGENERATED with `pnpm install --lockfile-only` in the target tree.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A crash must not look like drift. `sync-release-repo.sh` reads exit 1 as "the projection differs"
 * and continues to confirm/apply, but an uncaught exception ALSO exits 1 — which is how a broken
 * generator came to print `(drift above; a sync would apply it)` and then apply nothing. Crashes exit
 * `CRASH_EXIT` (and say what happened) so the two are distinguishable; the merged-layout refusal below
 * is the same signal.
 */
const CRASH_EXIT = 70
const crash = (message) => {
  console.error(`make-release-tree: ${message}`)
  process.exit(CRASH_EXIT)
}
process.on('uncaughtException', (error) => crash(`crashed — ${error?.stack ?? String(error)}`))
process.on('unhandledRejection', (reason) => crash(`crashed — ${reason instanceof Error ? reason.stack : String(reason)}`))

// The merge moved the ONE workspace file to the repository root; this script still projects a subtree
// that had its own. Refuse with the reason instead of an ENOENT stack from deep inside `projectTree`.
if (!existsSync(join(dirname(repo), 'pnpm-workspace.yaml')) && !existsSync(join(repo, 'pnpm-workspace.yaml'))) {
  crash(
    'no pnpm-workspace.yaml at the repository root — this script still expects the pre-merge layout '
    + '(one workspace file per subtree). See AGENTS.md §"Known leftover": release:tree/sync:rc must be '
    + 're-parameterised onto the merged workspace before the next RC.',
  )
}

/** `--version <v>`: the version every manifest is stamped with (a release cut, not a projection). */
let releaseVersion

// ── what the release tree must NOT contain ────────────────────────────────────────────────────────
// `*` matches within one path segment, `**` matches any depth.
const EXCLUDE = [
  // test infrastructure: the release repo ships no tests, so it ships none of their config either
  'packages/*/test/**',
  'packages/*/tsconfig.test.json',
  'packages/*/vitest.config.ts',
  'vitest.config.ts',
  // repository-internal documentation (the release README is the product doc)
  'docs/**',
  // Development-only entry points. `release:check` never calls them, and their targets are either
  // absent from the release tree (docs) or a source checkout the release repo does not have:
  //   - link-profile installs THIS checkout into a live DSH profile as a `link:` dependency;
  //   - workspace-doctor repairs this workspace's own pnpm-workspace.yaml document;
  //   - worker-usage / spike-cold-resume are diagnostics that read the development session store.
  'scripts/link-profile.mjs',
  'scripts/workspace-doctor.mjs',
  'scripts/worker-usage.mjs',
  'scripts/spike-cold-resume.mjs',
  // the dev→release tooling itself: the release repo is generated, it never generates anything
  'scripts/make-release-tree.mjs',
  'scripts/sync-release-repo.sh',
  'release/**',
]

/**
 * Files whose release variant is a different DOCUMENT, not an edit: copied verbatim from the dev
 * path to the release path. `README.md` is the case that forced this mechanism — the release README
 * is consumer-oriented prose, so rewriting it from the dev README by string surgery would be absurd.
 */
const OVERLAY = {
  // The repository front page AND the package's own README are the same document: npm shows
  // `packages/plugin/README.md` on the registry page, and the release repo's first screen must not
  // say something different. `release/README.md` is the single source for both, and the plan reports
  // drift if either copy ever moves, so the two files cannot silently diverge.
  //
  // Two REAL files, deliberately — not a symlink from the root README to the package one: git with
  // `core.symlinks=false` checks a link out as a plain file whose content is the target path (so a
  // Windows clone would show "packages/plugin/README.md" as the front page), and forge-side
  // symlinked-README resolution is version-dependent.
  'README.md': 'release/README.md',
  'packages/plugin/README.md': 'release/README.md',
}

/**
 * Mechanical edits, as literal `[before, after]` pairs. Every `before` must occur EXACTLY once, so a
 * change in the source text fails the generation instead of silently shipping a stale release file.
 */
const TRANSFORMS = {
  // The release tree ships no tests, so the test toolchain leaves the catalog. `@avantf/dsh-plugin-base`
  // needs no transform: it is a normal registry dependency in BOTH trees, so that part is verbatim.
  'pnpm-workspace.yaml': [['  vitest: ^2.1.0\n', '']],
  // `--typecheck` also type-checks the tests here (the only place their types are checked, since
  // vitest transpiles without checking). The release tree has no tests and no `tsconfig.test.json`,
  // so that step would fail on a missing project.
  'scripts/build.mjs': [
    [
      "  compile(dir, 'tsconfig.json', check && name !== 'core')\n"
      + '  if (check) {\n'
      + '    // Tests are transpiled without type-checking by vitest, so this is the only place their types are verified.\n'
      + '    console.log(`\\n▶ typecheck @avantf/work-${name} (tests)`)\n'
      + "    compile(dir, 'tsconfig.test.json', true)\n"
      + '  }\n',
      "  compile(dir, 'tsconfig.json', check && name !== 'core')\n",
    ],
  ],
  // The release tree has neither `link-profile.mjs` nor a test toolchain, and this header names both.
  'scripts/link-dsh.mjs': [
    [
      ' * `--no-bake` is for callers that LINK but do not COMPILE (`typecheck.mjs`, `link-profile.mjs`): a run that\n'
      + ' * emits nothing must not re-certify a stale `lib/index.js` against a dsh it was never compiled with. Toolchain\n'
      + ' * packages (`typescript` / `vitest`) and `zod` come from the workspace install; `zod` is pinned in\n'
      + ' * `pnpm-workspace.yaml` to the release the installed dsh ships, because `@deepseek-ai/dsh-storage-domain`\n'
      + ' * types its record schemas with its own zod.\n',
      ' * `--no-bake` is for callers that LINK but do not COMPILE (`typecheck.mjs`): a run that emits nothing must\n'
      + ' * not re-certify a stale `lib/index.js` against a dsh it was never compiled with. `zod` comes from the\n'
      + ' * workspace install, pinned in `pnpm-workspace.yaml` to the release the installed dsh ships, because\n'
      + ' * `@deepseek-ai/dsh-storage-domain` types its record schemas with its own zod.\n',
    ],
  ],
  'scripts/release-check.mjs': [
    // the gate no longer runs tests
    [
      ' * The gate to run before releasing: typecheck, build, test, verify, pack.\n',
      ' * The gate to run before releasing: typecheck, build, verify, pack.\n',
    ],
    // …and with no tests in the tree, neither does it invoke the test runner
    [
      '  [\n'
      + "    'test core',\n"
      + "    join(repo, 'packages/core/node_modules/.bin/vitest'),\n"
      + "    ['run'],\n"
      + "    join(repo, 'packages/core'),\n"
      + '  ],\n'
      + '  [\n'
      + "    'test plugin',\n"
      + "    join(repo, 'packages/plugin/node_modules/.bin/vitest'),\n"
      + "    ['run'],\n"
      + "    join(repo, 'packages/plugin'),\n"
      + '  ],\n',
      '',
    ],
  ],
}

/** Manifests that lose the test script (and, in the packages, the test toolchain). */
const ROOT_MANIFEST = 'package.json'
const PACKAGE_MANIFESTS = ['packages/core/package.json', 'packages/plugin/package.json']

/**
 * Scripts that only make sense in THIS repository: their target file is part of the development
 * tooling, which is not projected. Kept as a list (with an existence assertion below) so renaming one
 * fails the generation instead of silently shipping a script that points at nothing.
 */
const DEV_ONLY_SCRIPTS = [
  'test',
  'link:profile',
  'workers:usage',
  'workspace:doctor',
  'spike:cold-resume',
  'release:tree',
  'sync:rc',
]

/** `packages/plugin/package.json` — the manifest of the ONE package users install. */
const PLUGIN_MANIFEST = 'packages/plugin/package.json'

/**
 * Assert the shipped manifest's production surface, instead of performing it.
 *
 * Three properties are load-bearing for the published artifact and would fail SILENTLY if the
 * development manifest drifted:
 *   - `dependencies` stays empty: the plugin's only non-host import is the engine, which the build
 *     inlines (`bundleHost`); a runtime dependency here would ship a package that resolves nothing;
 *   - `@avantf/dsh-plugin-base` is a REQUIRED peer: a consumer's package manager installs a required peer
 *     on its own, and the plugin mounts degraded without the framework;
 *   - `@avantf/work-core` is INTERNAL: it may sit only in `devDependencies`, because the entry
 *     inlines its runtime and `lib/work-core/` carries its types.
 */
function assertPluginManifest(pkg) {
  const deps = Object.keys(pkg.dependencies ?? {})
  if (deps.length > 0) {
    throw new Error(
      `${PLUGIN_MANIFEST}: dependencies must stay EMPTY — the engine is inlined and every other `
      + `package comes from the host as a peer, found: ${deps.join(', ')}`,
    )
  }
  if (typeof pkg.peerDependencies?.['@avantf/dsh-plugin-base'] !== 'string') {
    throw new Error(`${PLUGIN_MANIFEST}: @avantf/dsh-plugin-base is not a peer — the host must supply the framework`)
  }
  if (pkg.peerDependenciesMeta?.['@avantf/dsh-plugin-base']?.optional === true) {
    throw new Error(
      `${PLUGIN_MANIFEST}: @avantf/dsh-plugin-base is marked an optional peer — it must be REQUIRED, `
      + 'or installing this package does not install the framework',
    )
  }
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkg[section]?.['@avantf/work-core'] !== undefined) {
      throw new Error(
        `${PLUGIN_MANIFEST}: @avantf/work-core sits in ${section} — it is INTERNAL and must stay in `
        + 'devDependencies, or the artifact names a package nothing outside this workspace can resolve',
      )
    }
  }
  if (pkg.devDependencies?.['@avantf/work-core'] === undefined) {
    throw new Error(`${PLUGIN_MANIFEST}: @avantf/work-core is missing from devDependencies — the plugin inlines it, so both trees must declare it there`)
  }
  if (typeof pkg.scripts?.test !== 'string') throw new Error(`${PLUGIN_MANIFEST}: no scripts.test to remove`)
  if (typeof pkg.devDependencies?.vitest !== 'string') throw new Error(`${PLUGIN_MANIFEST}: no devDependencies.vitest to drop`)
}

/** Regenerated in the target (never copied): its content follows from the rewritten manifests. */
const REGENERATED = ['pnpm-lock.yaml']

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────
const toPosix = (p) => p.split(sep).join('/')

/** `git ls-files -z` in `dir` — the authoritative, deterministic file set (untracked never leaks). */
function trackedFiles(dir) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter((f) => f !== '').map(toPosix).sort()
}

/** Glob match with `*` (one segment), `**` (any depth) and `?` (one character). */
function compile(pattern) {
  let rx = ''
  for (let i = 0; i < pattern.length; i++) {
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
const compiled = new Map(EXCLUDE.map((pattern) => [pattern, compile(pattern)]))
const excluded = (path) => EXCLUDE.some((pattern) => compiled.get(pattern).test(path))

/** Apply the transforms for one path; throws when a `before` snippet is absent or ambiguous. */
function project(path, source) {
  if (path === ROOT_MANIFEST) {
    const pkg = JSON.parse(source)
    for (const name of DEV_ONLY_SCRIPTS) {
      if (typeof pkg.scripts?.[name] !== 'string') throw new Error(`${path}: no scripts["${name}"] to remove`)
      delete pkg.scripts[name]
    }
    if (releaseVersion !== undefined) pkg.version = releaseVersion
    return `${JSON.stringify(pkg, null, 2)}\n`
  }

  if (PACKAGE_MANIFESTS.includes(path)) {
    const pkg = JSON.parse(source)
    if (path === PLUGIN_MANIFEST) assertPluginManifest(pkg)
    if (typeof pkg.scripts?.test !== 'string') throw new Error(`${path}: no scripts.test to remove`)
    delete pkg.scripts.test
    if (typeof pkg.devDependencies?.vitest !== 'string') throw new Error(`${path}: no devDependencies.vitest to drop`)
    delete pkg.devDependencies.vitest
    if (releaseVersion !== undefined) pkg.version = releaseVersion
    return `${JSON.stringify(pkg, null, 2)}\n`
  }

  let out = source
  for (const [before, after] of TRANSFORMS[path] ?? []) {
    const first = out.indexOf(before)
    if (first === -1) throw new Error(`${path}: transform source text not found:\n${before.split('\n')[0]}`)
    if (out.indexOf(before, first + 1) !== -1) throw new Error(`${path}: transform source text is ambiguous (appears twice): ${before.split('\n')[0]}`)
    out = out.slice(0, first) + after + out.slice(first + before.length)
  }
  return out
}

/**
 * Refuse to project a workspace that still carries a `link:`/`file:` override.
 *
 * Co-developing a family package from a sibling checkout is a documented convenience, but a release
 * tree has no sibling: the entry would be projected verbatim and the lockfile regeneration would fail
 * there with a resolution error that never mentions the override. Catch it here, where the fix is one
 * line to delete.
 */
function assertNoWorkspaceLinks() {
  const path = join(repo, 'pnpm-workspace.yaml')
  const text = readFileSync(path, 'utf8')
  const offender = /^\s+"?(@?[^":\s]+)"?:\s*(link|file):\S+\s*$/m.exec(text)
  if (offender !== null) {
    throw new Error(
      `pnpm-workspace.yaml still overrides "${offender[1]}" with a ${offender[2]}: specifier `
      + `(${offender[0].trim()}). The release tree has no sibling checkout — remove the override `
      + '(and run `pnpm install`) before projecting.',
    )
  }
}

/** The projected tree: relative path → Buffer. */
function projectTree() {
  assertNoWorkspaceLinks()
  const files = new Map()
  // Overlay targets are not necessarily tracked here, so the path set is the tracked files UNION the
  // overlay targets.
  const paths = [...new Set([...trackedFiles(repo), ...Object.keys(OVERLAY)])].sort()
  for (const path of paths) {
    if (excluded(path)) continue
    if (REGENERATED.includes(path)) continue
    const overlay = OVERLAY[path]
    const sourcePath = overlay === undefined ? join(repo, path) : join(repo, overlay)
    if (!existsSync(sourcePath)) throw new Error(`${path}: source ${relative(repo, sourcePath)} does not exist`)
    const raw = readFileSync(sourcePath)
    files.set(path, statSync(sourcePath).size === 0 || isBinary(raw) ? raw : Buffer.from(project(path, raw.toString('utf8')), 'utf8'))
  }
  return files
}

/** Binary assets are copied verbatim (the transforms only ever apply to text). */
const isBinary = (buf) => buf.includes(0)

/** Regenerate the lockfile in `dir` from its (already written) manifests. */
function regenerateLockfile(dir) {
  const result = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
    cwd: dir, stdio: 'inherit', shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(
      `pnpm install --lockfile-only failed in ${dir} (exit ${String(result.status)}). `
      + 'The release tree resolves every dependency from the registry (the workspace manifest is '
      + 'projected, so `catalog:` entries it drops are gone): a failure here is a registry or '
      + 'network problem, and the lockfile it would have written is not one a release can use.',
    )
  }
}

/** Remove now-empty directories left behind by deletions, up to (not including) `root`. */
function pruneEmptyDirs(root, startDir) {
  let dir = startDir
  while (dir !== root && dir.startsWith(root) && existsSync(dir) && readdirSync(dir).length === 0) {
    rmSync(dir)
    dir = dirname(dir)
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
if (flag('--help') || flag('-h') || argv.length === 0) {
  console.log('usage: node scripts/make-release-tree.mjs --out <dir> [--force] | --into <dir> [--apply] [--version <v>]')
  process.exit(argv.length === 0 ? 2 : 0)
}

const outDir = value('--out')
const intoDir = value('--into')
releaseVersion = value('--version')
if (releaseVersion !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) {
  console.error(`make-release-tree: --version ${releaseVersion} is not a semver version`)
  process.exit(2)
}
if ((outDir === undefined) === (intoDir === undefined)) {
  console.error('make-release-tree: pass exactly one of --out <dir> or --into <dir>')
  process.exit(2)
}

// The projection reads the WORKING TREE through the index: a file that is not `git add`ed is not in
// the release tree at all, and an edited tracked file ships as-is. Say both out loud — the untracked
// case is invisible otherwise (the file simply never appears).
{
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    .split('\n').filter((line) => line !== '')
  const untracked = status.filter((line) => line.startsWith('??')).map((line) => line.slice(3))
  const dirty = status.filter((line) => !line.startsWith('??')).map((line) => line.slice(3))
  if (untracked.length > 0) {
    console.warn(`warning: ${String(untracked.length)} untracked file(s) are NOT projected — \`git add\` them if they belong in the release:`)
    for (const path of untracked.slice(0, 10)) console.warn(`  ${path}`)
    if (untracked.length > 10) console.warn(`  …and ${String(untracked.length - 10)} more`)
  }
  if (dirty.length > 0) {
    console.warn(`warning: ${String(dirty.length)} tracked file(s) have uncommitted changes — the projection uses the working-tree content`)
  }
}

const files = projectTree()
const total = files.size

// ── --out: materialize a fresh tree ──────────────────────────────────────────────────────────────
if (outDir !== undefined) {
  const target = resolve(outDir)
  if (target === repo) {
    console.error('make-release-tree: refusing to materialize over the development repository')
    process.exit(2)
  }
  if (existsSync(target) && readdirSync(target).length > 0 && !flag('--force')) {
    console.error(`make-release-tree: ${target} is not empty — pass --force to overwrite it`)
    process.exit(2)
  }
  for (const [path, content] of files) {
    const dest = join(target, path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, content)
  }
  console.log(`wrote ${String(total)} files to ${target}`)
  console.log('regenerating the lockfile…')
  regenerateLockfile(target)
  console.log(`\ndone: ${target}`)
  console.log('next: run `pnpm install --frozen-lockfile && pnpm release:check` in that tree')
  process.exit(0)
}

// ── --into: plan (default) or apply ─────────────────────────────────────────────────────────────
const target = resolve(intoDir)
if (target === repo) {
  console.error('make-release-tree: refusing to sync the development repository onto itself')
  process.exit(2)
}
if (!existsSync(join(target, '.git'))) {
  console.error(`make-release-tree: ${target} is not a git checkout (needed to know which files it owns)`)
  process.exit(2)
}

const owned = new Set(trackedFiles(target))
const added = []
const modified = []
const same = []
for (const [path, content] of files) {
  // Content decides add/change — NOT the target's index: a file that is only untracked there (a sync
  // not yet committed) is not drift. The index is what decides DELETIONS, because only tracked files
  // belong to the release repo and untracked ones (`node_modules/`, `lib/`, scratch) are never ours.
  const dest = join(target, path)
  if (!existsSync(dest)) { added.push(path); continue }
  if (Buffer.compare(readFileSync(dest), content) === 0) same.push(path)
  else modified.push(path)
}
// Regenerated files are rewritten, not deleted (and are not part of the comparison). A tracked file
// that is ALREADY gone from the target's working tree is a deletion awaiting its commit there, not
// drift: the projection's job is the working tree, and staging is the release repo's business.
const deleted = [...owned]
  .filter((path) => !files.has(path) && !REGENERATED.includes(path) && existsSync(join(target, path)))
  .sort()

console.log(`release tree: ${String(total)} files — ${String(added.length)} to add, ${String(modified.length)} to change, ${String(deleted.length)} to delete, ${String(same.length)} already identical`)
if (releaseVersion !== undefined) console.log(`release version: ${releaseVersion} (stamped into all ${String(1 + PACKAGE_MANIFESTS.length)} manifests)`)
const list = (label, paths) => {
  if (paths.length === 0) return
  console.log(`\n${label} (${String(paths.length)}):`)
  for (const path of paths.slice(0, 200)) console.log(`  ${path}`)
  if (paths.length > 200) console.log(`  …and ${String(paths.length - 200)} more`)
}
list('+ add', added)
list('~ change', modified)
list('- delete', deleted)
if (modified.includes('README.md') || modified.includes('packages/plugin/README.md')) {
  console.log('\nnote: the two READMEs come from release/README.md (edit that file, not the generated ones)')
}

const drift = added.length + modified.length + deleted.length
if (!flag('--apply')) {
  console.log(drift === 0
    ? '\nno drift in the projected files — the release tree is exactly the projection'
    : `\n${String(drift)} file(s) drift from the projection (run again with --apply)`)
  console.log('note: pnpm-lock.yaml is not compared (it is regenerated by --apply, not projected)')
  process.exit(drift === 0 ? 0 : 1)
}

for (const [path, content] of files) {
  if (!added.includes(path) && !modified.includes(path)) continue
  const dest = join(target, path)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, content)
}
for (const path of deleted) {
  const dest = join(target, path)
  // tracked but already gone from the working tree (a removal not yet committed) is not an error
  if (existsSync(dest)) rmSync(dest)
  pruneEmptyDirs(target, dirname(dest))
}
console.log(`\napplied: ${String(added.length)} added, ${String(modified.length)} changed, ${String(deleted.length)} deleted`)
// A change in the SET of workspace packages (a package added or removed) makes pnpm's incremental
// `--lockfile-only` keep stale importers, so drop the lock and resolve it fresh in that case.
const packageSetChanged = [...added, ...deleted].some((path) => /^packages\/[^/]+\/package\.json$/.test(path))
if (packageSetChanged && existsSync(join(target, 'pnpm-lock.yaml'))) {
  rmSync(join(target, 'pnpm-lock.yaml'))
  console.log('package set changed — regenerating the lockfile from scratch')
}
console.log('regenerating the lockfile…')
regenerateLockfile(target)
console.log('\ndone — review with `git -C ' + intoDir + ' status`, then commit there')
