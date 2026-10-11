/**
 * `zod`'s version is declared in TWO places per plugin tree — the required peer range in the plugin
 * manifest (`>=4.4.3 <5`) and the `catalog:` entry the workspace resolves for its own build
 * (`pnpm-workspace.yaml`) — and nothing asserted that the catalog's version actually SATISFIES the
 * peer range.
 *
 * The drift is silent and expensive: the host supplies zod (one physical copy, or the schema types
 * of `@deepseek-ai/dsh-storage-domain` stop being the same identity the engine's are), so if the
 * catalog ever moved to a version the published peer range excludes, every local build would compile
 * and test against a zod the installed plugin never sees.
 *
 * This reads two files (plus the other two plugin trees, to keep the declared range identical across
 * them the way `scripts/release-check.mjs` requires) — it deliberately has no runtime dependency on
 * the repository root beyond a path relative to this spec.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const rootYaml = readFileSync(new URL('../../../../pnpm-workspace.yaml', import.meta.url), 'utf8')
const catalog = (parse(rootYaml) as { catalog?: Record<string, string> }).catalog ?? {}
const catalogZod = catalog['zod']

function manifest(relative: string): { peer?: string; dev?: string } {
  const json = JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as {
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return { peer: json.peerDependencies?.['zod'], dev: json.devDependencies?.['zod'] }
}

/** `4.6.5` → `[4, 6, 5]`; a partial `5` means `5.0.0` (the way npm ranges read it). */
function versionParts(version: string): number[] {
  const core = version.trim().split('-')[0] ?? ''
  const parts = core.split('.').map((part) => Number(part))
  expect(parts.length).toBeGreaterThan(0)
  expect(parts.every((part) => Number.isInteger(part) && part >= 0), `unreadable version ${version}`).toBe(true)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function compare(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return (left[i] as number) - (right[i] as number)
  }
  return 0
}

/** The `>=A <B` shape the three trees declare (a one-sided or `||`-chain range must fail loudly). */
function bounds(range: string): { min: string; max: string } {
  const match = /^>=\s*(\S+)\s+<\s*(\S+)$/.exec(range.trim())
  expect(match, `the zod peer range must be a plain ">=A <B" pair, got "${range}"`).not.toBeNull()
  return { min: match?.[1] as string, max: match?.[2] as string }
}

/** Does `version` satisfy `range` (as bounds)? */
function satisfies(version: string, range: string): boolean {
  const { min, max } = bounds(range)
  return compare(version, min) >= 0 && compare(version, max) < 0
}

describe('the zod peer range and the workspace catalog agree', () => {
  it('resolves a catalog version inside the peer range every plugin tree declares', () => {
    expect(catalogZod, 'pnpm-workspace.yaml must carry a catalog.zod entry').toBeDefined()
    const memPeer = manifest('../../plugin/package.json').peer
    expect(memPeer, 'the mem plugin must declare a required `zod` peer').toBeDefined()
    expect(satisfies(catalogZod as string, memPeer as string)).toBe(true)
    // Non-vacuousness, proved without touching another package's manifest: the same helper REJECTS
    // both ends of the declared range (`<5` excludes 5.0.0 even though it satisfies the ">=4.4.3"
    // half, and 4.4.2 is below the floor).
    expect(satisfies('5.0.0', memPeer as string)).toBe(false)
    expect(satisfies('4.4.2', memPeer as string)).toBe(false)
    expect(satisfies('4.4.3', memPeer as string)).toBe(true)
  })

  it('keeps `catalog:` in devDependencies (the local build resolves through the catalog)', () => {
    // A version literal here instead of `catalog:` forks the resolution: the manifest would be
    // installable while this workspace compiled against a second zod.
    for (const tree of ['../../plugin/package.json', '../../../../mission/packages/plugin/package.json', '../../../../identity/packages/plugin/package.json']) {
      expect(manifest(tree).dev, `${tree} must resolve zod through the catalog`).toBe('catalog:')
    }
  })

  it('declares the SAME peer range in all three plugin trees (release-check requires it)', () => {
    const memPeer = manifest('../../plugin/package.json').peer
    for (const tree of ['../../../../mission/packages/plugin/package.json', '../../../../identity/packages/plugin/package.json']) {
      expect(manifest(tree).peer).toBe(memPeer)
    }
  })
})
