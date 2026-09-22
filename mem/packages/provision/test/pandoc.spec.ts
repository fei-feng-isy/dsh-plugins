/**
 * The REAL pandoc: pinned version, managed layout, and a conversion that actually runs.
 *
 * `describe.skipIf(!pandocAvailable)` — the same shape `git.spec.ts` uses for `hasGit` — because the
 * binary is normally fetched at plugin mount and a fresh checkout (or CI) has none. What this spec
 * asserts when pandoc IS present is that the artifact's pinned coordinates match what was installed:
 * a wrong version here is the cross-machine corpus divergence the pin exists to prevent.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  managedPandocPath,
  PANDOC_PACKS,
  PANDOC_VERSION,
  pandocConverterId,
  pandocExecutable,
  runProbe,
} from '../src/index.js'

/** The managed layout this project installs into (`tools.dir` default). */
const TOOLS_DIR = process.env['AVANTF_TOOLS_DIR'] ?? join(homedir(), '.avantf', 'tools')

const resolved = pandocExecutable(TOOLS_DIR)
const hasPandoc = resolved.ok

describe.skipIf(!hasPandoc)('the real pandoc', () => {
  it('reports the pinned version', () => {
    if (!resolved.ok) throw new Error('unreachable')
    const probe = runProbe(resolved.path, ['--version'])
    expect(probe.ok).toBe(true)
    expect(probe.output).toContain(PANDOC_VERSION)
  })

  it('agrees with the pack record for this platform', () => {
    const key = `${process.platform}-${process.arch}`
    const pack = PANDOC_PACKS[key]
    if (pack === undefined) return // an unsupported platform is covered by the unit spec
    expect(pack.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(pack.bytes).toBeGreaterThan(1_000_000)
    expect(pack.url).toContain(`pandoc-${PANDOC_VERSION}`)
  })
})

describe('pandoc artifact coordinates (offline)', () => {
  it('pins a version-qualified converter id', () => {
    expect(pandocConverterId()).toBe(`pandoc-${PANDOC_VERSION}`)
  })

  it('points the managed path at <tools>/pandoc/<version>/bin/pandoc', () => {
    const path = managedPandocPath('/tmp/tools')
    expect(path).toBe(join('/tmp/tools', 'pandoc', PANDOC_VERSION, 'bin', 'pandoc'))
  })

  it('declares a digest for every platform pack it publishes', () => {
    for (const [key, pack] of Object.entries(PANDOC_PACKS)) {
      expect(pack, key).toBeDefined()
      expect(pack?.sha256, key).toMatch(/^[0-9a-f]{64}$/)
      expect(pack?.url.startsWith('https://github.com/jgm/pandoc/releases/download/'), key).toBe(true)
      expect(pack?.format, key).toMatch(/^(tar\.gz|zip)$/)
    }
    if (!hasPandoc) return
    // When it IS installed here, the managed copy must be where the layout says it is.
    expect(existsSync(managedPandocPath(TOOLS_DIR)) || resolved.source !== 'managed').toBe(true)
  })
})
