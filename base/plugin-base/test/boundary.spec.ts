import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The workspace's hard boundary: a plugin tree reaches only the family base and its own packages.
 *
 *   base      ← every plugin tree        allowed (the ONE shared package)
 *   own tree  ← itself                   allowed
 *   tree A    ↔ tree B                   FORBIDDEN, in both directions
 *
 * The plugins are independent products (own package name, version, bundling and release); sharing code
 * is what `base/` is for, and a cross-plugin import would be invisible in a green build because pnpm
 * would happily link one workspace package into the other.
 *
 * The rules and the scan live in ONE place — `scripts/boundary-guard.mjs` at the repository root — and
 * this spec RUNS it. The two used to be copies kept in step by hand ("change BOTH when a rule changes"),
 * which is exactly how a rule quietly stops being enforced; spawning the single implementation makes
 * agreement structural. The script is dependency-free (node builtins only), so this spec needs no
 * install either, and because the plugin set is DISCOVERED, a new plugin tree lands under the same rules
 * without editing either file.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const guard = resolve(repo, 'scripts', 'boundary-guard.mjs')

/**
 * The discovery contract, mirrored here on purpose: the spec must not simply trust the script it runs.
 * A plugin tree is a top-level directory whose `package.json` defines a `build:dsh` script.
 */
function discoveredTrees(): string[] {
  return readdirSync(repo, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .filter((entry) => {
      try {
        const manifest = JSON.parse(readFileSync(join(repo, entry.name, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>
        }
        return typeof manifest.scripts?.['build:dsh'] === 'string'
      } catch {
        return false
      }
    })
    .map((entry) => entry.name)
}

describe('plugin import boundary', () => {
  it('has plugin trees to guard (the scan is not vacuous by construction)', () => {
    expect(discoveredTrees().length).toBeGreaterThan(0)
  })

  it('holds for every discovered plugin tree', () => {
    const result = spawnSync(process.execPath, [guard, '--verbose'], { cwd: repo, encoding: 'utf8' })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.status, output).toBe(0)
    // Every tree the workspace discovers must have been scanned, not just none of them.
    for (const id of discoveredTrees()) {
      expect(output, `${id}/ was not scanned by boundary-guard`).toContain(`scan  ${id}:`)
    }
  })
})
