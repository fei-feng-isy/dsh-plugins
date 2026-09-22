#!/usr/bin/env node
/**
 * Generate the PUBLISH repository's tree from this checkout.
 *
 * The release repository (`avantf-mem-rc`) is a projection of this one, not a fork: every projected
 * file is byte-identical, and the differences are exactly the declared ones — the test
 * infrastructure and repository-internal docs it must not carry (EXCLUDE), the files whose release
 * variant differs (TRANSFORMS, plus OVERLAY for the two READMEs), and the lockfile it regenerates.
 * Keeping that projection in ONE script is what lets the release repo stay un-edited by hand, so
 * "release tree == this tree minus the declared differences" stays mechanically checkable.
 *
 * Usage:
 *   node scripts/make-release-tree.mjs --out <dir> [--force]   # materialize a fresh tree
 *   node scripts/make-release-tree.mjs --into <dir>            # report the drift (exit 1 if any)
 *   node scripts/make-release-tree.mjs --into <dir> --apply    # sync that checkout in place
 *
 * `--version <v>` stamps all eight manifests with the release version (the version is a release cut,
 * not something to project): without it the release tree keeps the development version.
 *
 * `--into` only ever manages files TRACKED BY THE TARGET's git: `node_modules/`, `packages/<pkg>/lib/`,
 * `packages/<pkg>/dist/` and `.git/` are untracked there and are never read, written or deleted. A tracked file the
 * projection does not produce is deleted — that is the direction of truth (this repo is the source).
 *
 * `pnpm-lock.yaml` cannot be projected (removing vitest from seven manifests changes the resolution),
 * so it is REGENERATED with `pnpm install --lockfile-only` in the target tree.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** `--version <v>`: the version every manifest is stamped with (a release cut, not a projection). */
let releaseVersion

// ── what the release tree must NOT contain ────────────────────────────────────────────────────────
// `*` matches within one path segment, `**` matches any depth.
const EXCLUDE = [
  // test infrastructure: the release repo ships no tests, so it ships none of their config either
  'packages/*/test/**',
  'packages/*/tsconfig.test.json',
  'packages/*/vitest.config.ts',
  // repository-internal documentation (the release README is the product doc)
  'AGENTS.md',
  'CHANGELOG.md',
  'DESIGN.md',
  'docs/**',
  // The CLI and the MCP server are development-only entry points (both `private`): the published
  // artifact is one self-contained plugin package, so a release tree that carried them would only
  // invite the question "is this shipped?". They are built and run from THIS repository.
  'packages/cli/**',
  'packages/mcp/**',
  // the dev→release tooling itself: the release repo is generated, it never generates anything
  'scripts/make-release-tree.mjs',
  'scripts/sync-release-repo.sh',
  'release/**',
]

/**
 * Files whose release variant is a different DOCUMENT, not an edit: copied verbatim from the dev
 * path to the release path. `README.md` is the case that forced this mechanism — the release README
 * is release-oriented prose, so rewriting it from the dev README by string surgery would be absurd.
 */
const OVERLAY = {
  // The repository front page AND the package's own README are the same document: npm shows
  // `packages/plugin/README.md` on the registry page, and the release repo's first screen must not say
  // something different. `release/README.md` is the single source for both, and the plan reports drift
  // if either copy ever moves, so the two files cannot silently diverge.
  //
  // Two REAL files, deliberately — not a symlink from the root README to the package one:
  //   - `git` with `core.symlinks=false` (the Windows default) checks a link out as a plain file whose
  //     content is the target path, so a Windows clone would show "packages/plugin/README.md" as the
  //     repository's front page;
  //   - forge-side symlinked-README resolution is version-dependent (Gitee inherits Gitea, which has
  //     had README symlink bugs), and the front page is exactly what this file is for.
  // The duplication is generated, ~6.6 KB, and single-sourced — not hand-maintained.
  'README.md': 'release/README.md',
  'packages/plugin/README.md': 'release/README.md',
}

/**
 * Mechanical edits, as literal `[before, after]` pairs. Every `before` must occur EXACTLY once, so a
 * change in the source text fails the generation instead of silently shipping a stale release file.
 */
const TRANSFORMS = {
  '.github/workflows/ci.yml': [
    ['  build-test:\n', '  build:\n'],
    [
      '      # The test tsconfigs (`tsconfig.test.json`) are the reason this is a gate at all — `build`\n'
      + '      # only covers `src`, so without this step a spec can reference a type that does not exist,\n'
      + '      # implement an interface partially, or assert a field the runtime never returns, and pass.\n'
      + '      - name: Typecheck (src + tests)\n'
      + '        run: pnpm typecheck\n'
      + '      - name: Test (all packages)\n'
      + '        run: pnpm test\n',
      '      - name: Typecheck (src)\n'
      + '        run: pnpm typecheck\n',
    ],
    [
      '      # half is built and mount-verified inside the DSH harness workspace. Its\n'
      + '      # harness-free units (tools schema derivation, Remote envelope decoding) run\n'
      + '      # here like every other package\'s; `packages/plugin/test` must stay clear of\n'
      + '      # `@deepseek-ai/*` VALUE imports for that to hold (`import type` is erased and\n'
      + '      # stays CI-safe). The two specs whose subject IS the harness-facing wiring\n'
      + '      # (`test/provision.spec.ts` + `test/envinit.spec.ts`: both load\n'
      + '      # `src/provision.ts`, which value-imports `@deepseek-ai/dsh-tools`, so a\n'
      + '      # peer-less tree cannot even LOAD them) are excluded from the default run by\n'
      + '      # `packages/plugin/vitest.config.ts` and run in the LOCAL gate instead\n'
      + '      # (`pnpm test:dsh`, a step of `pnpm build:dsh`).\n',
      '      # half is built and mount-verified inside the DSH harness workspace, which is why\n'
      + '      # both steps above filter it out (`!@avantf/dsh-mem`): CI never covers the plugin.\n',
    ],
  ],
  'pnpm-workspace.yaml': [
    // vitest is a test-only tool; the release manifests do not declare it, so the catalog drops it
    ['  vitest: ^2.1.0\n', ''],
    // `@avantf/dsh-plugin-base` needs no transform: it is a normal registry dependency in BOTH trees
    // (published 0.1.0), so the file is projected verbatim. A locally re-added `link:` override —
    // the documented way to co-develop the base — would be unresolvable here, so it is caught by
    // `assertNoWorkspaceLinks()` before anything is written, not silently carried over.
  ],
  'scripts/bench-indexes.mjs': [
    // the benchmark's note referenced a unit test as the guard for this constraint
    [
      "    'references through `supersedes_id` (NO ACTION) — that defect is guarded by a unit test.',\n",
      "    'references through `supersedes_id` (NO ACTION) — that constraint is load-bearing.',\n",
    ],
  ],
  'scripts/release-check.mjs': [
    // The release gate's header also describes the pack step it adds below. The `before` half must
    // track the development tree's wording EXACTLY: this projection fails loudly when an anchor no
    // longer matches, which is what caught the header rewrite that left this entry behind.
    [
      ' * Needs an installed global `dsh` (`npm i -g @deepseek-ai/dsh`) for the three LOCAL plugin steps\n'
      + ' * (see `scripts/link-dsh.mjs`). Exits non-zero if any step fails. No harness source checkout is\n'
      + ' * needed to compile, type-check or mount — the client preset is pinned in this repository.\n'
      + ' *\n'
      + ' * The RELEASE repository\'s gate adds one more step — packing the single installable package\n'
      + ' * (`scripts/pack-plugin.mjs`) and, with a global dsh, installing and mounting that tarball. That step\n'
      + ' * holds here too: the plugin manifest is the same shape in both trees (engine in `devDependencies`,\n'
      + ' * so tsdown inlines it), which `scripts/make-release-tree.mjs` now ASSERTS rather than performs.\n',
      ' * Needs an installed global `dsh` (`npm i -g @deepseek-ai/dsh`) for the three LOCAL plugin steps\n'
      + ' * (see `scripts/link-dsh.mjs`). Exits non-zero if any step fails. The final step packs the one\n'
      + ' * package users install (`scripts/pack-plugin.mjs`) — with `--mount` when a global dsh is installed,\n'
      + ' * so the tarball a release would upload is proven to install and mount, not just to build here.\n',
    ],
    // the pack step's inputs: the installed dsh (only the packed-artifact mount needs it)
    [
      '// A fresh checkout',
      '// The last step packs the ONE package users install and asserts the tarball is self-contained.\n'
      + '// Its mount half needs the INSTALLED global dsh (the peers a real profile would hand the plugin),\n'
      + '// so it is added only when one is present rather than failing a machine that has none linked.\n'
      + 'const globalRoot = spawnSync(\'npm\', [\'root\', \'-g\'], { encoding: \'utf8\' }).stdout?.trim() ?? \'\'\n'
      + 'const hasInstalledDsh = globalRoot !== \'\' && existsSync(join(globalRoot, \'@deepseek-ai\', \'dsh\'))\n'
      + '// A fresh checkout',
    ],
    // the whole step list: no tests, plus the pack step
    [
      "  ['typecheck (src + tests)', 'pnpm', ['typecheck']],\n"
      + "  ['test (all packages)', 'pnpm', ['test']],\n"
      + "  [\"link the plugin's DSH peers (LOCAL: the installed dsh)\", process.execPath,\n"
      + "    ['scripts/link-dsh.mjs']],\n"
      + "  ['plugin typecheck (LOCAL: the installed dsh)', 'pnpm', ['typecheck:dsh']],\n"
      + "  ['plugin build + mount smoke (LOCAL: the installed dsh)', 'pnpm', ['build:dsh']],\n"
      + ']\n',
      "  ['typecheck (src)', 'pnpm', ['typecheck']],\n"
      + "  [\"link the plugin's DSH peers (LOCAL: the installed dsh)\", process.execPath,\n"
      + "    ['scripts/link-dsh.mjs']],\n"
      + "  ['plugin typecheck (LOCAL: the installed dsh)', 'pnpm', ['typecheck:dsh']],\n"
      + "  ['plugin build + mount smoke (LOCAL: the installed dsh)', 'pnpm', ['build:dsh']],\n"
      + "  ['pack the single installable package (asserts self-containment)', 'pnpm',\n"
      + "    ['pack:plugin', ...(hasInstalledDsh ? ['--mount'] : [])]],\n"
      + ']\n',
    ],
    // the packed tarball is asserted but not mounted when no global dsh is installed
    [
      "for (const warning of warnings) console.log(`note: ${warning}`)\n",
      "for (const warning of warnings) console.log(`note: ${warning}`)\n"
      + 'if (!hasInstalledDsh) {\n'
      + "  console.log('note: no installed global dsh found — the packed tarball was asserted but not installed and mounted')\n"
      + '}\n',
    ],
    // the "where a CHANGELOG exists" note is about THIS checkout: true in the release repo, false here
    [
      '  // section would satisfy it). They only apply where a CHANGELOG exists: the release repository\n'
      + '  // ships the source without one, and a gate that refuses to run there would just be turned off.\n',
      '  // section would satisfy it). They only apply where a CHANGELOG exists: this repository ships the\n'
      + '  // source without one, and a gate that refuses to run there would just be turned off.\n',
    ],
  ],
}

/** Manifests lose the test script; the seven packages also lose vitest and re-point `typecheck`. */
const ROOT_MANIFEST = 'package.json'
const PACKAGE_MANIFESTS = [
  'packages/contract/package.json',
  'packages/retrieval-core/package.json',
  'packages/core/package.json',
  'packages/convert/package.json',
  'packages/provision/package.json',
  // cli/mcp are excluded from the projection entirely, so these two are inert unless that changes
  'packages/cli/package.json',
  'packages/mcp/package.json',
  'packages/plugin/package.json',
]

/** The engine whose runtime dependencies the published plugin must declare (it inlines them). */
const ENGINE_MANIFESTS = [
  'packages/contract/package.json',
  'packages/retrieval-core/package.json',
  'packages/core/package.json',
  // The conversion library is engine too, reached from `core` and inlined with it: its third-party
  // runtime deps (exceljs) are what the published plugin has to declare.
  'packages/convert/package.json',
  // The provisioning library is engine too, reached from `core` (and `convert`) and inlined with it.
  // It has NO third-party runtime dependencies by design — everything it needs is a `node:` builtin —
  // so it contributes nothing to the plugin's production surface, which the assertion below enforces
  // in the direction that ships.
  'packages/provision/package.json',
]

/**
 * Scripts that only make sense in THIS repository: their target file is part of the development
 * tooling, which is not projected. Kept as a list (with an existence assertion below) so renaming one
 * fails the generation instead of silently shipping a script that points at nothing.
 */
const DEV_ONLY_SCRIPTS = ['release:tree', 'sync:rc']

/** `packages/plugin/package.json` — the manifest of the ONE package users install. */
const PLUGIN_MANIFEST = 'packages/plugin/package.json'

/**
 * The packages that must never sit in the plugin's production sections, in EITHER tree.
 *
 * The engine (`@avantf/mem-contract` → `@avantf/mem-core` → `@avantf/mem`, plus `@avantf/mem-convert`
 * which `core` reaches) is INLINED into `lib/index.js` by the harness tsdown preset, and that preset
 * keys off the manifest sections: production sections stay imports, everything else inlines. An
 * engine package that drifts back into `dependencies` therefore silently UN-inlines it and ships a
 * package that cannot resolve `@avantf/*` on a user's machine — the failure mode
 * `scripts/pack-plugin.mjs` exists to catch. `react` / `react-dom` are the browser half's, served by
 * the host's module table at runtime.
 *
 * Both trees keep them in `devDependencies`: the release tree because that is what it publishes, and
 * the development tree because `pnpm build:dsh` must produce the same self-contained artifact a user
 * would install — a dev-tree build that leaks `@avantf/*` imports works here (workspace node_modules)
 * and dies the moment it is copied into a DSH profile.
 */
const BROWSER_OR_ENGINE_DEPS = ['@avantf/mem', '@avantf/mem-contract', '@avantf/mem-convert', '@avantf/mem-provision', 'react', 'react-dom']

/**
 * Family packages that ship as REAL runtime dependencies rather than inlined engine code.
 *
 * Empty, and deliberately so: the compatibility base `@avantf/dsh-plugin-base` used to be the one entry,
 * but the plugin is wired to `@avantf/dsh-plugin-base` now — the framework PROVISIONS the base into its
 * family root and the plugin loads it from there, so nothing under `@avantf/` may appear in the
 * production sections any more. The framework itself is a **peer** (the host provides it), declared
 * in `peerDependencies`, which this projection leaves untouched; the base lives in
 * `devDependencies` only as the source of the range it declares. Both must be published BEFORE this
 * package — `scripts/pack-plugin.mjs` refuses a tarball still carrying `link:`/`file:`.
 */
const FAMILY_RUNTIME_DEPS = []

/**
 * The engine's third-party runtime surface — what has to stay an IMPORT in the bundle, because the
 * inlined engine reaches it at run time and cannot carry it along.
 *
 * The plugin declares these itself (they are the published package's own dependencies, not the
 * engine's), so this is a CROSS-CHECK rather than a derivation: a production section that misses one
 * makes tsdown inline it, and a bundled native module does not survive the round trip (`bindings`,
 * reached by `better-sqlite3`, reads `__filename`, which an ES module does not have). Deriving and
 * overwriting would hide exactly that, in the direction that ships.
 */
function engineRuntimeSurface(readManifest) {
  const deps = {}
  const optional = {}
  for (const file of ENGINE_MANIFESTS) {
    const engine = JSON.parse(readManifest(file))
    for (const [name, spec] of Object.entries(engine.dependencies ?? {})) {
      if (!name.startsWith('@avantf/') || FAMILY_RUNTIME_DEPS.includes(name)) deps[name] = spec
    }
    for (const [name, spec] of Object.entries(engine.optionalDependencies ?? {})) optional[name] = spec
  }
  return { deps, optional }
}

function projectPluginManifest(pkg, readManifest) {
  // The split is the SOURCE manifest's job, not this projection's — assert it instead of performing
  // it, so a silent move either way fails the generation rather than the user's install.
  const dev = { ...(pkg.devDependencies ?? {}) }
  for (const name of BROWSER_OR_ENGINE_DEPS) {
    if ((pkg.dependencies ?? {})[name] !== undefined) {
      throw new Error(`${PLUGIN_MANIFEST}: "${name}" is in dependencies — the engine/browser split belongs in devDependencies, or tsdown un-inlines it`)
    }
    if (dev[name] === undefined) {
      throw new Error(`${PLUGIN_MANIFEST}: "${name}" is missing from devDependencies — the plugin inlines it, so both trees must declare it there`)
    }
  }
  const runtime = { ...(pkg.dependencies ?? {}) }
  const optional = { ...(pkg.optionalDependencies ?? {}) }
  const engine = engineRuntimeSurface(readManifest)
  // A family runtime package is the PLUGIN's own dependency now (the engine does not import the base
  // any more), so the expected surface has to include the ones the plugin declares — otherwise a
  // perfectly valid production section reads as a mismatch. The range comes from the plugin, and the
  // dead-dependency check in `pack-plugin.mjs` remains the guard against declaring an unused one.
  for (const name of FAMILY_RUNTIME_DEPS) {
    if (runtime[name] !== undefined) engine.deps[name] = runtime[name]
  }
  const namesOf = (map) => Object.keys(map).sort().join(', ')
  for (const [section, declared, actual] of [['dependencies', runtime, engine.deps], ['optionalDependencies', optional, engine.optional]]) {
    if (namesOf(declared) !== namesOf(actual)) {
      throw new Error(`${PLUGIN_MANIFEST}: ${section} must be exactly the engine's runtime surface — expected "${namesOf(actual)}", found "${namesOf(declared) || '(none)'}"`)
    }
  }

  const sorted = (map) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)))
  // Rebuild in the manifest's own key order, replacing `dependencies` with the four release sections.
  const out = {}
  for (const [key, value] of Object.entries(pkg)) {
    if (key === 'dependencies') {
      out.dependencies = sorted(runtime)
      out.optionalDependencies = sorted(optional)
      out.devDependencies = sorted(dev)
      out.engines = JSON.parse(readManifest(ROOT_MANIFEST)).engines
      continue
    }
    if (key === 'devDependencies' || key === 'optionalDependencies') continue
    out[key] = value
  }
  return out
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

/** Read another manifest of THIS repo (the plugin's release sections are derived from the engine). */
const readManifest = (rel) => readFileSync(join(repo, rel), 'utf8')

/** Apply the transforms for one path; throws when a `before` snippet is absent or ambiguous. */
function project(path, source) {
  if (path === PLUGIN_MANIFEST) {
    const pkg = projectPluginManifest(JSON.parse(source), readManifest)
    if (typeof pkg.scripts?.test !== 'string') throw new Error(`${path}: no scripts.test to remove`)
    if (typeof pkg.scripts.typecheck !== 'string') throw new Error(`${path}: no scripts.typecheck to re-point`)
    delete pkg.scripts.test
    pkg.scripts.typecheck = 'tsc -p tsconfig.json --noEmit'
    if (typeof pkg.devDependencies?.vitest !== 'string') throw new Error(`${path}: no devDependencies.vitest to drop`)
    delete pkg.devDependencies.vitest
    if (releaseVersion !== undefined) pkg.version = releaseVersion
    return `${JSON.stringify(pkg, null, 2)}\n`
  }

  if (path === ROOT_MANIFEST || PACKAGE_MANIFESTS.includes(path)) {
    const pkg = JSON.parse(source)
    const full = PACKAGE_MANIFESTS.includes(path)
    if (typeof pkg.scripts?.test !== 'string') throw new Error(`${path}: no scripts.test to remove`)
    delete pkg.scripts.test
    if (!full) {
      for (const name of DEV_ONLY_SCRIPTS) {
        if (typeof pkg.scripts[name] !== 'string') throw new Error(`${path}: no scripts["${name}"] to remove`)
        delete pkg.scripts[name]
      }
    }
    if (full) {
      if (typeof pkg.scripts.typecheck !== 'string') throw new Error(`${path}: no scripts.typecheck to re-point`)
      if (typeof pkg.devDependencies?.vitest !== 'string') throw new Error(`${path}: no devDependencies.vitest to drop`)
      pkg.scripts.typecheck = 'tsc -p tsconfig.json --noEmit'
      delete pkg.devDependencies.vitest
    }
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
 * Co-developing `@avantf/dsh-plugin-base` from a sibling checkout is a documented convenience (add an
 * `overrides:` entry to `pnpm-workspace.yaml`), but a release tree has no sibling: the entry would be
 * projected verbatim and the lockfile regeneration would fail there with a resolution error that
 * never mentions the override. Catch it here, where the fix is one line to delete.
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
  // Overlay targets are not necessarily tracked here (`packages/plugin/README.md` exists only in the
  // projection), so the path set is the tracked files UNION the overlay targets.
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
    // The projection drops the workspace override, so every `@avantf/*` range resolves from the
    // REGISTRY here — and while a family package is still unpublished that resolution is a 404, whose
    // message above names the package but not the rule. Say the rule: the family ships first.
    throw new Error(
      `pnpm install --lockfile-only failed in ${dir} (exit ${String(result.status)}). `
      + 'The release tree resolves `@avantf/*` from the registry (this tree has no sibling checkout, '
      + 'so the workspace `overrides:` entry is projected away): PUBLISH the family package(s) before '
      + 'generating the release tree — see AGENTS.md and pnpm-workspace.yaml.',
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
// drift: the projection's job is the working tree, and staging is the release repo's business (the
// `--commit` path stages everything). Without this, every sync that removes tracked files would fail
// its own verification until someone committed by hand.
const deleted = [...owned]
  .filter((path) => !files.has(path) && !REGENERATED.includes(path) && existsSync(join(target, path)))
  .sort()

console.log(`release tree: ${String(total)} files — ${String(added.length)} to add, ${String(modified.length)} to change, ${String(deleted.length)} to delete, ${String(same.length)} already identical`)
if (releaseVersion !== undefined) console.log(`release version: ${releaseVersion} (stamped into all eight manifests)`)
const list = (label, paths) => {
  if (paths.length === 0) return
  console.log(`\n${label} (${String(paths.length)}):`)
  for (const path of paths.slice(0, 200)) console.log(`  ${path}`)
  if (paths.length > 200) console.log(`  …and ${String(paths.length - 200)} more`)
}
list('+ add', added)
list('~ change', modified)
list('- delete', deleted)
if (Object.keys(OVERLAY).length > 0 && modified.includes('README.md')) {
  console.log('\nnote: README.md comes from release/README.md (edit that file, not the generated one)')
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
// `--lockfile-only` keep stale importers — it reported "Already up to date" while the lock still
// listed a package the release tree no longer has. Drop the lock and resolve it fresh in that case.
const packageSetChanged = [...added, ...deleted].some((path) => /^packages\/[^/]+\/package\.json$/.test(path))
if (packageSetChanged && existsSync(join(target, 'pnpm-lock.yaml'))) {
  rmSync(join(target, 'pnpm-lock.yaml'))
  console.log('package set changed — regenerating the lockfile from scratch')
}
console.log('regenerating the lockfile…')
regenerateLockfile(target)
console.log('\ndone — review with `git -C ' + intoDir + ' status`, then commit there')
