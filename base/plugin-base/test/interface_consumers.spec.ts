/**
 * The interface gate has ONE consumer shim, and it lives in EVERY plugin tree.
 *
 * `mem/packages/plugin/src/interface_gate.ts`, `mission/packages/plugin/src/interface_gate.ts` and
 * `identity/packages/plugin/src/interface_gate.ts` are the same file on purpose: the question they
 * answer — "does the base I loaded even HAVE the gate?" — is the one part of the contract that CANNOT
 * live in the base (a base too old to carry the gate cannot report that it lacks it), so the family's
 * rule puts it in the consumer, and EVERY consumer needs the same answer. Everything in the shim is
 * the consumption contract and the ONE verdict→decision mapping; nothing in it is plugin-specific by
 * construction — what IS plugin-specific (which text the prompt layer falls back to, which resources
 * take the legacy path) lives in that plugin's own `envinit.ts`.
 *
 * Byte-identical files with nothing keeping them in step is the shape this repository has been burned
 * by before (the family path copies, the vendored client preset): the copies drift, and the one that
 * drifts is the one nobody rebuilt. So they are all pinned HERE — the base's suite, which is the only
 * tree that may read all of them (a relative path from one plugin into another is what the boundary
 * guard exists to stop) — with the `@module` tag as the single line allowed to differ. The tree list
 * is DISCOVERED (every top-level directory carrying the shim path), so a fourth consumer cannot be
 * silently left out of the pin; `test/public-surface.spec.ts` discovers the same set for the
 * consumer scan.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The repo root: this file lives in `<repo>/base/plugin-base/test/`. */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The convention this file was written against; a move must fail loudly, not skip. */
const SHIM = join('packages', 'plugin', 'src', 'interface_gate.ts')

/** The shim's one plugin-specific line — its `@module` tag, the only thing allowed to differ. */
const MODULE_TAG = /^ \* @module @avantf\/dsh-[\w-]+\/interface_gate$/mu
const PLACEHOLDER = ' * @module @avantf/dsh-<tree>/interface_gate'

/**
 * Every top-level tree that carries the shim — DISCOVERED, never listed. The expected set is the
 * family's three plugin trees; the assertion below states that expectation so a tree dropping out of
 * the pin (a moved/renamed shim) is red rather than silently unpinned.
 */
function discoverShimTrees(): string[] {
  return readdirSync(repo, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .filter(tree => existsSync(join(repo, tree, SHIM)))
    .sort()
}

const TREES = discoverShimTrees()

function readShim(tree: string): string {
  return readFileSync(join(repo, tree, SHIM), 'utf8')
}

/** The first line two copies disagree on, or `(identical)` — a diff makes the failure readable. */
function firstDifference(leftTree: string, left: string, rightTree: string, right: string): string {
  const a = left.split('\n')
  const b = right.split('\n')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) {
      return `line ${String(index + 1)}: ${leftTree} ${JSON.stringify(a[index] ?? '<missing>')} vs ${rightTree} ${JSON.stringify(b[index] ?? '<missing>')}`
    }
  }
  return '(identical)'
}

describe('the interface gate consumers', () => {
  it('discovers every tree that carries the shim (the convention did not move)', () => {
    expect(TREES).toEqual(['identity', 'mem', 'mission'])
  })

  it('run ONE shim: byte-identical apart from the `@module` tag', () => {
    const reference = TREES[0] ?? ''
    const referenceSource = readShim(reference)
    expect(MODULE_TAG.test(referenceSource), `${reference}: the shim carries no @module tag to normalise`).toBe(true)
    const expected = referenceSource.replace(MODULE_TAG, PLACEHOLDER)
    for (const tree of TREES) {
      const source = readShim(tree)
      expect(MODULE_TAG.test(source), `${tree}: the shim carries no @module tag to normalise`).toBe(true)
      expect(
        firstDifference(tree, source.replace(MODULE_TAG, PLACEHOLDER), reference, expected),
        `the ${TREES.length} consumer shims must stay identical — put plugin-specific behaviour in that plugin's envinit.ts, not in this shim`,
      ).toBe('(identical)')
    }
  })

  it('still covers the three exports the plugins consume', () => {
    // The pin above proves the copies agree; this proves the agreed file is the shim (a group of empty
    // files would also be identical). All three names are the plugins' imports.
    for (const tree of TREES) {
      const source = readShim(tree)
      expect(source, `${tree}: interfaceVerdict missing`).toMatch(/export function interfaceVerdict\(/u)
      expect(source, `${tree}: baseIsUsable missing`).toMatch(/export function baseIsUsable\(/u)
      // `stillActive` is the shim's one GENERIC Cordis helper (both startups imported a private copy):
      // the byte pin above is what keeps its readings from drifting.
      expect(source, `${tree}: stillActive missing`).toMatch(/export function stillActive\(/u)
    }
  })
})
