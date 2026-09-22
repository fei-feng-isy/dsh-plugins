import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The workspace's hard boundary, as an executable test.
 *
 * The merged repository has three dependency directions and only two of them exist:
 *
 *   base  ← mem         allowed
 *   base  ← work        allowed
 *   mem  ↔ work         FORBIDDEN, in both directions
 *
 * The plugins are independent products (own package name, version, bundling and release); sharing
 * code is what `base/` is for. A cross-plugin import would create exactly the coupling the merge is
 * supposed to avoid — and it would be invisible in a green build, because pnpm would happily link
 * one workspace package into the other.
 *
 * The scan is source-level on purpose: it sees a violation the moment it is written, before any
 * build has a chance to inline it away.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'release', '.git', 'vendor', '.vitest'])
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u

/** Every `.ts`/`.js` source file under `dir`, excluding build output and vendored trees. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
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
 * comment that merely SPELLS an import — `* \`import "@avantf/dsh-old"\``, of which there are several
 * in this repository — is not read as one. The dynamic/require forms may appear anywhere, so the
 * `(?:^|[^\w$])` guard is enough there.
 */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const found: string[] = []
  for (const pattern of [
    /(?:^|[;\n}])\s*import\s[^;'"]*?from\s*['"]([^'"]+)['"]/gmu,
    // A SIDE-EFFECT import (`import '@avantf/dsh-work'`) has no `from` and is a real dependency; miss
    // it and the boundary test is green on exactly the import that pulls the other plugin in.
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
function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '')
}

/** True when a relative specifier leaves its own half of the repository. */
function escapesInto(file: string, specifier: string, otherHalf: string): boolean {
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
] as const

describe('mem ↔ work import boundary', () => {
  it('finds both halves (the scan is not vacuous)', () => {
    for (const half of HALVES) {
      expect(sourceFiles(half.dir).length, `${half.name} has no sources`).toBeGreaterThan(10)
    }
  })

  for (const half of HALVES) {
    it(`${half.name}/ imports nothing from ${half.otherHalf}/`, () => {
      const violations: string[] = []
      for (const file of sourceFiles(half.dir)) {
        for (const specifier of specifiersOf(file)) {
          const name = packageName(specifier)
          if (half.foreignPackages.includes(name as never)) {
            violations.push(`${relative(repo, file)} → ${specifier}`)
          } else if (half.foreignPackagePrefixes.some((prefix) => name.startsWith(prefix))) {
            violations.push(`${relative(repo, file)} → ${specifier}`)
          } else if (escapesInto(file, specifier, half.otherHalf)) {
            violations.push(`${relative(repo, file)} → ${specifier}`)
          }
        }
      }
      expect(violations).toEqual([])
    })
  }

  it('only the base may be shared, and only from base/', () => {
    // `@avantf/dsh-plugin-base` is the ONE family package mem/ and work/ may reach. `kit` is NOT in
    // this list on purpose: it has no package of its own any more — its source lives in `base/` and
    // the plugins take it off the base module at runtime, so a `@avantf/dsh-plugin-kit` specifier
    // would name a package nobody publishes. The retired `@avantf/dsh-envinit` / `@avantf/dsh-compat`
    // are absent for the same reason: their code is in the base now and neither gets a new release.
    const allowed = new Set([
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
    const unknown: string[] = []
    for (const half of HALVES) {
      for (const file of sourceFiles(half.dir)) {
        for (const specifier of specifiersOf(file)) {
          if (!specifier.startsWith('@avantf/')) continue
          const name = packageName(specifier)
          if (!allowed.has(name)) unknown.push(`${relative(repo, file)} → ${specifier}`)
        }
      }
    }
    expect(unknown).toEqual([])
  })
})
