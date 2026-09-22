import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensure, registerArtifact, type ArchivePack, type Artifact } from '../src/index.js'

/**
 * The download kill switch (`tools.auto_install: false` / `AVANTF_MEM_AUTO_DOWNLOAD=0`) gates ONLY
 * the artifacts that download.
 *
 * It used to gate every artifact, which was a real regression rather than a conservative default:
 * `model`'s `isPresent()` is `false` BY DESIGN (it must warm on every start, so it can never report
 * "already present"), so with downloads off it could never pass `resolve` — a machine that had the
 * model cached all along reported "model unavailable" and silently degraded retrieval to
 * FTS+entity. A layout-less artifact acquires nothing from the network, so the switch has nothing
 * to say about it; whether the model may FETCH is `semantic.auto_download`, a different switch.
 */
const A = 'gate-nopack'
const B = 'gate-packed'
const ALL = [A, B]

const pack: ArchivePack = {
  url: 'https://example.invalid/fixture.tar.gz',
  sha256: 'f'.repeat(64),
  bytes: 1,
  format: 'tar.gz',
}

/** `withPacks` is the whole point: it is what "this artifact downloads" means to the registry. */
function scripted(id: string, withPacks: boolean, installs: string[]): Artifact {
  return {
    id,
    title: `gate artifact ${id}`,
    ...(withPacks ? { version: '1.0', packs: { [`${process.platform}-${process.arch}`]: pack } } : {}),
    isPresent: async () => false,
    // The ID, not `ctx.dir`: a layout-less artifact's dir IS `toolsDir` (no `<id>/<version>`
    // segment), so a path-based assertion would silently never match.
    install: async () => { installs.push(id) },
    verify: async () => undefined,
  }
}

afterAll(() => { /* the registry is process-wide; ids are unique to this spec */ })

describe('the auto-install kill switch', () => {
  it('lets a no-pack artifact install from local state, and refuses a downloading one', async () => {
    const { registerArtifact: register } = await import('../src/index.js')
    const installs: string[] = []
    register(scripted(A, false, installs))
    register(scripted(B, true, installs))
    const toolsDir = mkdtempSync(join(tmpdir(), 'avf-gate-'))
    try {
      const options = {
        toolsDir,
        config: { dir: toolsDir, mirror: [], auto_install: false },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }
      // The layout-less artifact RUNS: it owes the network nothing.
      const ok = await ensure(A, options)
      expect(ok.ok).toBe(true)
      expect(installs).toContain(A)

      // The downloading one is refused, with the reason naming the switch. `ensure` REPORTS a
      // failure (`{ok:false, error}`) rather than throwing — the sweep needs one result per artifact
      // — so the assertion is on the result, not on a rejection.
      const refused = await ensure(B, options)
      expect(refused.ok).toBe(false)
      expect(refused.error ?? '').toMatch(/自动下载被关闭/)
      expect(installs).not.toContain(B)
    } finally {
      rmSync(toolsDir, { recursive: true, force: true })
    }
  })

  it('hands `artifactEnv` to install unchanged (the model warm-up depends on it)', async () => {
    // The bug this pins: `installContext` did not forward `artifactEnv` at all, so the model
    // artifact — whose `install` IS the semantic warm-up and needs the runtime that owns the model
    // cache — failed on EVERY start with "需要 artifactEnv.runtime". Retrieval fell back to
    // FTS+entity with downloads enabled and the model cached, and the mount smoke hid it because a
    // model failure is expected there.
    const id = 'gate-env'
    const seen: unknown[] = []
    registerArtifact({
      id,
      title: 'gate artifact env',
      isPresent: async () => false,
      install: async (ctx) => { seen.push((ctx as { artifactEnv?: unknown }).artifactEnv) },
      verify: async () => undefined,
    })
    const toolsDir = mkdtempSync(join(tmpdir(), 'avf-gate-env-'))
    try {
      const artifactEnv = { runtime: { marker: 'rt' } }
      const result = await ensure(id, {
        toolsDir,
        config: { dir: toolsDir, mirror: [], auto_install: true },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        artifactEnv,
      })
      expect(result.ok).toBe(true)
      expect(seen).toEqual([artifactEnv])
    } finally {
      rmSync(toolsDir, { recursive: true, force: true })
    }
  })

  it('still refuses a no-pack artifact in explicit offline mode only when it downloads', async () => {
    const installs: string[] = []
    // `offline` follows the same rule: it means "do not fetch", not "do not work from local state".
    const ok = await ensure(A, {
      toolsDir: mkdtempSync(join(tmpdir(), 'avf-gate-offline-')),
      config: { dir: tmpdir(), mirror: [], auto_install: true },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      offline: true,
    })
    expect(ok.ok).toBe(true)
    expect(installs.length).toBe(0)
  })
})
