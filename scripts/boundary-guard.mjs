#!/usr/bin/env node
/**
 * The workspace's hard boundary, as a runnable check.
 *
 * The merged repository has three dependency directions and only two of them exist:
 *
 *   base  ← mem         allowed
 *   base  ← work        allowed
 *   mem  ↔ work         FORBIDDEN, in both directions
 *
 * The plugins are independent products (own package name, version, bundling and release); sharing code
 * is what `base/` is for. A cross-plugin import would create exactly the coupling the merge exists to
 * avoid — and pnpm would happily link one workspace package into the other, so a green build would
 * not notice.
 *
 * This is the dependency-free mirror of `base/plugin-base/test/boundary.spec.ts`, which is the
 * authoritative gate (`pnpm -C base/plugin-base test` runs it). This script exists so the boundary can
 * be checked with no `node_modules` at all — before an install, in CI's first step, and by hand. The
 * two must agree: when a rule changes, change BOTH (the spec's own `only the base may be shared` list
 * is the one this script checks below).
 *
 * Usage:
 *   node scripts/boundary-guard.mjs            # scan, non-zero on a violation
 *   node scripts/boundary-guard.mjs --verbose  # also print the scan roots and package count
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const verbose = process.argv.includes('--verbose')

const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'release', '.git', 'vendor', '.vitest'])
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u

/** Every `.ts`/`.js` source file under `dir`, excluding build output and vendored trees. */
function sourceFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(current, entry.name))
        continue
      }
      if (!SOURCE.test(entry.name)) continue
      out.push(join(current, entry.name))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

/**
 * Every module specifier a file reaches: static import/export, side-effect import, dynamic import(),
 * require().
 *
 * The static forms are anchored to the start of a statement (`^`, `;`, `}` or a newline) so a doc
 * comment that merely SPELLS an import is not read as one. The dynamic/require forms may appear
 * anywhere, so the `(?:^|[^\w$])` guard is enough there.
 */
function specifiersOf(file) {
  const text = readFileSync(file, 'utf8')
  const found = []
  for (const pattern of [
    /(?:^|[;\n}])\s*import\s[^;'"]*?from\s*['"]([^'"]+)['"]/gmu,
    // A SIDE-EFFECT import (`import '@avantf/dsh-work'`) has no `from`; miss it and the guard is green
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

/** True when a relative specifier leaves its own half of the repository. */
function escapesInto(file, specifier, otherHalf) {
  if (!specifier.startsWith('.')) return false
  const target = resolve(dirname(file), specifier)
  const otherRoot = join(repo, otherHalf)
  return target === otherRoot || target.startsWith(otherRoot + sep)
}

const HALVES = [
  {
    name: 'mem',
    dir: join(repo, 'mem'),
    foreignPackages: ['@avantf/dsh-work'],
    foreignPackagePrefixes: ['@avantf/work'],
    otherHalf: 'work',
  },
  {
    name: 'work',
    dir: join(repo, 'work'),
    foreignPackages: ['@avantf/dsh-mem'],
    foreignPackagePrefixes: ['@avantf/mem'],
    otherHalf: 'mem',
  },
]

/**
 * The `@avantf/*` names a plugin may reach. `@avantf/dsh-plugin-base` is the one shared package;
 * the rest are each half's own engine packages. A new name here is a deliberate act: it is the
 * moment a plugin gains a dependency on something outside its own tree.
 */
const ALLOWED = new Set([
  '@avantf/dsh-plugin-base',
  '@avantf/mem',
  '@avantf/mem-contract',
  '@avantf/mem-convert',
  '@avantf/mem-core',
  '@avantf/mem-provision',
  '@avantf/mem-mcp',
  '@avantf/dsh-mem',
  '@avantf/work-core',
  '@avantf/dsh-work',
])

const problems = []

// The scan must not be vacuous: a moved/renamed tree would otherwise pass by finding nothing.
for (const half of HALVES) {
  const count = sourceFiles(half.dir).length
  if (verbose) console.log(`  scan  ${half.name}: ${count} source files under ${relative(repo, half.dir)}/`)
  if (count <= 10) problems.push(`${half.name}/ has only ${count} source files — the scan is vacuous or the tree moved`)
}

for (const half of HALVES) {
  for (const file of sourceFiles(half.dir)) {
    for (const specifier of specifiersOf(file)) {
      const name = packageName(specifier)
      const where = `${relative(repo, file)} → ${specifier}`
      if (half.foreignPackages.includes(name)) {
        problems.push(`${where} (imports the other plugin)`)
      } else if (half.foreignPackagePrefixes.some((prefix) => name.startsWith(prefix))) {
        problems.push(`${where} (imports the other plugin's engine)`)
      } else if (escapesInto(file, specifier, half.otherHalf)) {
        problems.push(`${where} (relative path escapes into ${half.otherHalf}/)`)
      } else if (specifier.startsWith('@avantf/') && !ALLOWED.has(name)) {
        problems.push(`${where} (unknown @avantf package — only base and this half's own packages may be reached)`)
      }
    }
  }
}

for (const problem of problems) console.error(`  FAIL  ${problem}`)
if (problems.length > 0) {
  console.error(`\nboundary-guard: FAILED (${problems.length} violation${problems.length === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('boundary-guard ok — mem/ and work/ reach only base and their own trees')
