#!/usr/bin/env node
/**
 * The workspace's hard boundary, as a runnable check.
 *
 * The merged repository has exactly two dependency directions inside a plugin tree:
 *
 *   base      ← every plugin tree        allowed (the ONE shared package)
 *   own tree  ← itself                   allowed
 *   tree A    ↔ tree B                   FORBIDDEN, in both directions
 *
 * The plugins are independent products (own package name, version, bundling and release); sharing code
 * is what `base/` is for. A cross-plugin import would create exactly the coupling the merge exists to
 * avoid — and pnpm would happily link one workspace package into the other, so a green build would not
 * notice.
 *
 * The plugin set is DISCOVERED (`scripts/lib/plugins.mjs`), like the build dispatcher: a plugin tree is
 * a top-level directory whose `package.json` defines a `build:dsh` script. So adding `notes/` puts it
 * under this guard with no change here, and the rules below then apply to it automatically. The base
 * is scanned too, through `discoverGuardTrees()`: it is not a plugin (no manifest at `base/`), which
 * is exactly why the forbidden `base` → plugin direction had been invisible to every gate.
 *
 * Rules, per tree T (source files, build output and vendored trees excluded):
 *
 *   1. no specifier may name a package owned by ANOTHER tree;
 *   2. no RELATIVE specifier may resolve outside T — the only exception is the workspace-level shared
 *      helper directory `scripts/lib/` (the two helpers hoisted out of both trees);
 *   3. no PLUGIN file that gets BUNDLED may import the base by VALUE: `import type` — and `typeof
 *      import(…)` in a type position — are the only static references a plugin may have, everything
 *      else must come off the base module the inlined bootstrap loaded at runtime. A static value
 *      import leaves `import '@avantf/dsh-plugin-base'` in the artifact and makes the whole plugin
 *      module fail to load wherever the base is absent, which is the failure the family forbids.
 *      Tests are exempt: they are never bundled and may use the base's real values. This rule is
 *      about PLUGINS taking the base by value; it does NOT apply to the base's own files (`isBase`),
 *      which ARE the base — rules 1 and 2 are what the base is scanned for.
 *   4. any other `@avantf/*` specifier must be a package of T itself. A new name is the moment a
 *      plugin gains a dependency outside its own tree — a deliberate act, not something discovery
 *      should absorb silently.
 *
 * Rule 1 lets every tree import the base in whatever form it likes, because the base is the ONE
 * shared package; the base's own packages are therefore never "foreign" (a plugin importing the base
 * is the whole point). Only a tree importing ANOTHER tree is a violation, in either direction.
 *
 * `base/plugin-base/test/boundary.spec.ts` — the vitest mirror — RUNS this script instead of copying
 * its rules, so the two can no longer drift apart.
 *
 * Usage:
 *   node scripts/boundary-guard.mjs            # scan, non-zero on a violation
 *   node scripts/boundary-guard.mjs --verbose  # also print each tree's scan size and package count
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BASE_PACKAGE, discoverGuardTrees, repoRoot as repo } from './lib/plugins.mjs'

const USAGE = `usage: node scripts/boundary-guard.mjs [--verbose]

Scans every discovered plugin tree (top-level directory with a \`build:dsh\` script) AND the family
base, and fails when a source file reaches another tree's package, escapes its own tree by a relative
path (except scripts/lib/), imports the base by value where a plugin bundles it, or names an unknown
@avantf package. The base is scanned for the first two rules only: it is not a plugin, so the
"bundle must not take the base by value" rule does not apply to the base's own files.`

const KNOWN = new Set(['--verbose', '--help', '-h'])

const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'release', '.git', 'vendor', '.vitest'])
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u
/** The workspace-level shared helpers: the one thing a subtree may reach by path. */
const SHARED_LIB = join(repo, 'scripts', 'lib')

/** Every file under `dir` whose basename matches, excluding build output and vendored trees. */
function walkFiles(dir, match) {
  const out = []
  const step = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        step(join(current, entry.name))
        continue
      }
      if (match(entry.name)) out.push(join(current, entry.name))
    }
  }
  if (existsSync(dir)) step(dir)
  return out
}

/**
 * Vitest writes a temporary `<config>.timestamp-<ms>-<hash>.mjs` beside the config it was given and
 * deletes it when the run ends — so a scan that runs WHILE a suite runs can list it and then fail to
 * read it. It is build noise by definition, never a source of record.
 */
const VITEST_TEMP = /\.timestamp-\d+-[0-9a-f]+\.mjs$/u

const sourceFiles = (dir) => walkFiles(dir, (name) => SOURCE.test(name) && !VITEST_TEMP.test(name))

function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The package names a tree owns: every `package.json` inside it. */
function ownedPackages(tree) {
  const names = new Set()
  for (const file of walkFiles(tree, (name) => name === 'package.json')) {
    const name = readManifest(file)?.name
    if (typeof name === 'string' && name.length > 0) names.add(name)
  }
  return names
}

/** Read a UTF-8 file, or `undefined` when it is gone (ENOENT only — anything else still throws). */
function readIfPresent(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * The file's CODE: comments blanked out one-for-one (newlines kept), so a specifier that appears only
 * in prose is not read as an import — several modules here document `await import('@avantf/…')` or
 * `import "@avantf/dsh-old"` in their doc comments, and a guard that reads those is a guard that cries
 * wolf. Strings and template literals are respected, so the `//` of `'https://…'` is not a comment.
 * This is a scanner, not a parser: it tracks quotes and escapes, nothing else.
 */
function codeOf(file) {
  // `undefined` when the file vanished between the listing and this read: another process may be
  // creating and deleting its own scratch files (see `VITEST_TEMP`). A file that is gone has no
  // specifiers, and that is not a violation.
  const text = readIfPresent(file)
  if (text === undefined) return undefined
  let out = ''
  let i = 0
  let mode = 'code'
  while (i < text.length) {
    const char = text[i]
    const next = text[i + 1]
    if (mode === 'code') {
      if (char === '/' && next === '/') { mode = 'line'; out += '  '; i += 2; continue }
      if (char === '/' && next === '*') { mode = 'block'; out += '  '; i += 2; continue }
      if (char === "'") mode = 'single'
      else if (char === '"') mode = 'double'
      else if (char === '`') mode = 'template'
      out += char
      i += 1
      continue
    }
    if (mode === 'line') {
      if (char === '\n') mode = 'code'
      out += char === '\n' ? char : ' '
      i += 1
      continue
    }
    if (mode === 'block') {
      if (char === '*' && next === '/') { mode = 'code'; out += '  '; i += 2; continue }
      out += char === '\n' ? char : ' '
      i += 1
      continue
    }
    // Inside a string: keep the content as-is (the patterns need `'…'` intact), honour escapes.
    if (char === '\\') {
      out += char + (next ?? '')
      i += 2
      continue
    }
    if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"') || (mode === 'template' && char === '`')) {
      mode = 'code'
    }
    out += char
    i += 1
  }
  return out
}

/**
 * Every module specifier a file reaches: static import/export, side-effect import, dynamic import(),
 * require(). Run on `codeOf()` output, so what is scanned is code — the statement anchors below are a
 * second layer for the static forms.
 */
function specifiersOf(file) {
  const text = codeOf(file)
  if (text === undefined) return []
  const found = []
  for (const pattern of [
    /(?:^|[;\n}])\s*import\s[^;'"]*?from\s*['"]([^'"]+)['"]/gmu,
    // A SIDE-EFFECT import (`import '@avantf/dsh-mission'`) has no `from`; miss it and the guard is green
    // on exactly the import that pulls the other plugin in.
    /(?:^|[;\n}])\s*import\s*['"]([^'"]+)['"]/gmu,
    /(?:^|[^\w$])import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /(?:^|[^\w$])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /(?:^|[;\n}])\s*export\s[^;'"]*?from\s*['"]([^'"]+)['"]/gmu,
  ]) {
    for (const match of text.matchAll(pattern)) found.push(match[1] ?? '')
  }
  return found
}

/** The package name of a bare specifier (`@scope/name/sub` → `@scope/name`). */
function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '')
}

/**
 * True when the file is compiled into a SHIPPED bundle — the only place a static value import of the
 * base is dangerous. Tests, tooling (`scripts/`) and config files are not bundled and may use the
 * base's real values.
 *
 * `root` is the repository root the path is judged against — a parameter so the rule can be replayed
 * on a constructed tree (it defaults to the real repository).
 */
function isBundled(file, root = repo) {
  const path = relative(root, file)
  if (/(?:^|\/)(?:tests?|__tests__|scripts)\//u.test(path)) return false
  if (/(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/u.test(path)) return false
  return !/\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path)
}

const escapeRegExp = (text) => text.replace(/[/\\^$*+?.()|[\]{}]/gu, '\\$&')
const BASE = escapeRegExp(BASE_PACKAGE)

/** True for `import type …` and for `import { type A, type B }` — every specifier type-only. */
function isTypeOnlyClause(clause) {
  const trimmed = clause.trim()
  if (/^type\b/u.test(trimmed)) return true
  const braces = /\{([^}]*)\}/u.exec(trimmed)
  if (braces === null) return false
  const inside = braces[1].split(',').map((part) => part.trim()).filter((part) => part !== '')
  return inside.length > 0 && inside.every((part) => /^type\b/u.test(part))
}

/** How a BUNDLED file imports the base by value — empty when it only takes types. */
function baseValueImports(file) {
  const text = codeOf(file)
  if (text === undefined) return []
  const found = []
  for (const match of text.matchAll(new RegExp(`(?:^|[;\\n}])\\s*(?:import|export)\\s+([^;'"]*?)from\\s*['"]${BASE}['"]`, 'gmu'))) {
    if (isTypeOnlyClause(match[1] ?? '')) continue
    found.push('a static value import')
  }
  for (const _ of text.matchAll(new RegExp(`(?:^|[;\\n}])\\s*import\\s*['"]${BASE}['"]`, 'gmu'))) {
    found.push('a side-effect import')
  }
  const dynamic = new RegExp(`(?:^|[^\\w$])(import|require)\\s*\\(\\s*['"]${BASE}['"]\\s*\\)`, 'gu')
  for (const match of text.matchAll(dynamic)) {
    const keyword = (match.index ?? 0) + match[0].indexOf(match[1])
    // `typeof import('…')` is a TYPE position and is erased at compile time — not a value import.
    if (/typeof\s*$/u.test(text.slice(Math.max(0, keyword - 16), keyword))) continue
    found.push(match[1] === 'require' ? 'a require()' : 'a dynamic import()')
  }
  return found
}

// ── rules ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Judge every boundary rule for a set of scan trees and return the violations.
 *
 * `trees` entries are `{ id, tree, packageDir?, packages: Set<string>, files: string[], isBase? }`
 * (`discoverGuardTrees()` + `ownedPackages`/`sourceFiles` build them). Pure apart from reading the
 * files it is given, and `root` is the repository the paths are judged against — so the whole rule
 * set can be replayed on a constructed tree without a workspace, which is how "a reverse import from
 * the base is a violation" is proven (the base's sources must stay clean either way).
 *
 * @param {Array<object>} trees
 * @param {string} [root] repository root the paths are relative to.
 * @returns {string[]} one line per violation.
 */
export function judgeTrees(trees, root = repo) {
  const problems = []

  if (trees.length === 0) {
    problems.push('no plugin tree discovered — a plugin tree is a top-level directory with a `build:dsh` script, so this scan would be vacuous')
  }

  for (const tree of trees) {
    // A tree that carries the family layout must yield real sources: otherwise a moved or gutted tree
    // would pass by scanning nothing.
    if (tree.packageDir !== undefined && tree.files.length <= 10) {
      problems.push(`${tree.id}/ has only ${tree.files.length} source file(s) but carries a known package layout — the scan is vacuous or the tree moved`)
    }
  }

  for (const tree of trees) {
    const foreign = new Map()
    for (const other of trees) {
      // The base is importable from EVERY tree — it is the one shared package, in both directions
      // spelled out above. Only the base's own scan must not treat a plugin tree as reachable.
      if (other === tree || other.isBase === true) continue
      for (const name of other.packages) foreign.set(name, other.id)
    }

    for (const file of tree.files) {
      const where = relative(root, file)
      for (const specifier of specifiersOf(file)) {
        const name = packageName(specifier)
        const owner = foreign.get(name)
        if (owner !== undefined) {
          problems.push(`${where} → ${specifier} (a package of ${owner}/ — no tree imports another tree; the base is the only shared package)`)
          continue
        }
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier)
          const inside = target === tree.tree || target.startsWith(tree.tree + sep)
          const shared = target === SHARED_LIB || target.startsWith(SHARED_LIB + sep)
          if (!inside && !shared) {
            problems.push(`${where} → ${specifier} (resolves to ${relative(root, target)}, outside ${tree.id}/ — the only shared code reachable by path is scripts/lib/)`)
          }
          continue
        }
        if (name.startsWith('@avantf/') && name !== BASE_PACKAGE && !tree.packages.has(name)) {
          problems.push(`${where} → ${specifier} (names no package of ${tree.id}/ or the family base — a new @avantf dependency is a deliberate act, not something discovery absorbs silently)`)
        }
      }
      // Rule 3 is about a PLUGIN taking the base by value into a shipped bundle. The base IS the base,
      // so a static reference to itself is not the failure this rule exists for (rules 1/2 are what
      // the base is scanned for). `isBase` makes that scope explicit rather than incidental.
      if (tree.isBase !== true && isBundled(file, root)) {
        for (const how of baseValueImports(file)) {
          problems.push(`${where} → ${BASE_PACKAGE} (${how}: only \`import type\` may be static — values come off the base module the inlined bootstrap loaded at runtime)`)
        }
      }
    }
  }

  return problems
}

// ── executable ───────────────────────────────────────────────────────────────────────────────────

function main(argv = process.argv.slice(2)) {
  const unknown = argv.filter((flag) => !KNOWN.has(flag))
  if (unknown.length > 0) {
    console.error(`boundary-guard: unknown option ${unknown.join(', ')}`)
    console.error(USAGE)
    return 2
  }
  if (argv.some((flag) => flag === '--help' || flag === '-h')) {
    console.log(USAGE)
    return 0
  }
  const verbose = argv.includes('--verbose')

  const trees = discoverGuardTrees().map((tree) => ({
    ...tree,
    packages: ownedPackages(tree.tree),
    files: sourceFiles(tree.tree),
  }))

  if (verbose) {
    for (const tree of trees) {
      console.log(`  scan  ${tree.id}: ${tree.files.length} source file(s), ${tree.packages.size} package name(s)`)
    }
  }

  const problems = judgeTrees(trees)
  for (const problem of problems) console.error(`  FAIL  ${problem}`)
  if (problems.length > 0) {
    console.error(`\nboundary-guard: FAILED (${problems.length} violation${problems.length === 1 ? '' : 's'})`)
    return 1
  }

  const pluginIds = trees.filter((tree) => tree.isBase !== true).map((tree) => tree.id)
  console.log(`boundary-guard ok — ${pluginIds.join(', ')} reach only the base and their own trees; base/ reaches into no plugin tree`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
