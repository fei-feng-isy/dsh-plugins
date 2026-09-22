/**
 * The startup sweep: every artifact in one pass, one result each, and failures that do not stop the
 * others.
 *
 * This is the contract the plugin mount depends on — the sweep replaced a model warm-up call that
 * lived beside the tools initialization, so the two properties that matter are "both kinds of
 * artifact are in the SAME sweep" and "one artifact's failure still lets the next one run".
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAll, ensureAllAsync, silentLogger, type Artifact, type ProvisionLogger } from '../src/index.js'

/** A logger that records every line, so the sweep's reporting can be asserted. */
function recordingLogger(lines: string[]): ProvisionLogger {
  return {
    info: (message: string) => lines.push(`INFO ${message}`),
    warn: (message: string) => lines.push(`WARN ${message}`),
    error: (message: string) => lines.push(`ERROR ${message}`),
  }
}

/**
 * An artifact whose behavior is scripted: what `isPresent` says and whether `install` throws.
 *
 * It declares a pack because a real artifact always has one and `ensure` resolves it before
 * installing — an artifact with no pack for this platform is a resolve failure, not an install.
 */
function scripted(id: string, behavior: { present: boolean; fail?: string; installs?: string[] }): Artifact {
  return {
    id,
    title: `脚本 artifact ${id}`,
    version: '1.0',
    packs: { [`${process.platform}-${process.arch}`]: { url: 'https://example.invalid/fixture.tar.gz', sha256: 'f'.repeat(64), bytes: 1, format: 'tar.gz' } },
    isPresent: async () => behavior.present,
    install: async (ctx) => {
      behavior.installs?.push(ctx.dir)
      if (behavior.fail !== undefined) throw new Error(behavior.fail)
    },
    verify: async () => undefined,
  }
}

/**
 * The sweep reads the REGISTERED artifacts, so an artifact registered by one spec runs in another
 * spec's sweep too. That is the production behaviour (registration is process-wide by design), and
 * these specs assert only on their own ids.
 */
const A = 'sweep-ok-a'
const B = 'sweep-fail-b'
const C = 'sweep-ok-c'
const installs: string[] = []

/** The suite-wide kill switch is cleared for this file; restored in `afterAll`. */
const previousAutoDownload = process.env['AVANTF_MEM_AUTO_DOWNLOAD']
process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = '1'

/**
 * The config passed here is `auto_install: true` with an empty mirror list, and this file clears the
 * suite-wide `AVANTF_MEM_AUTO_DOWNLOAD=0` — because the SWEEP is what is under test, and the property
 * that matters is that one artifact's failure does not stop the next. Nothing actually reaches the
 * network: every real artifact (pandoc, the model) reports itself already present, and the scripted
 * ones only record that their `install` ran.
 */

afterAll(() => {
  if (previousAutoDownload === undefined) delete process.env['AVANTF_MEM_AUTO_DOWNLOAD']
  else process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = previousAutoDownload
})

describe('ensureAll', () => {
  it('names what install is DOING, so a per-process warm-up does not read as a missing install', async () => {
    // The model's `install` is the semantic warm-up, rebuilt in every process from the local cache —
    // it printed "开始安装" on every start and made a working cache look like a missing dependency.
    const id = 'verb-warm'
    const { registerArtifact } = await import('../src/index.js')
    registerArtifact({
      id,
      title: '脚本 artifact（预热型）',
      verb: '预热',
      isPresent: async () => false,
      install: async () => undefined,
      verify: async () => undefined,
    })
    const toolsDir = mkdtempSync(join(tmpdir(), 'avf-verb-'))
    try {
      const lines: string[] = []
      // `ensureAllAsync` is the one that prints the SUMMARY line; the sync `ensureAll` does not.
      await ensureAllAsync({ toolsDir, config: { dir: toolsDir, mirror: [], auto_install: true }, logger: recordingLogger(lines) })
      const mine = lines.filter((line) => line.includes(`provision[${id}]`))
      expect(mine.some((line) => line.includes('预热中（本地）'))).toBe(true)
      expect(mine.some((line) => line.includes('预热完成'))).toBe(true)
      // The SUMMARY line must use the same word: it printed `model=installed`, contradicting the
      // `预热中 / 预热完成` lines right above it.
      expect(lines.some((line) => line.includes('全部就绪') && line.includes(`${id}=预热`))).toBe(true)
      // And the packed artifacts keep the default verb.
      expect(lines.some((line) => line.includes('安装中') || line.includes('已就绪'))).toBe(true)
    } finally {
      rmSync(toolsDir, { recursive: true, force: true })
    }
  })

  it('runs every artifact and reports one result each, without stopping at a failure', async () => {
    const { registerArtifact } = await import('../src/index.js')
    registerArtifact(scripted(A, { present: true }))
    registerArtifact(scripted(B, { present: false, fail: '下载失败：HTTP 404（镜像全部不可用）', installs }))
    registerArtifact(scripted(C, { present: false, installs }))

    const toolsDir = mkdtempSync(join(tmpdir(), 'avf-sweep-'))
    try {
      const lines: string[] = []
      const results = await ensureAll({ toolsDir, config: { dir: toolsDir, mirror: [], auto_install: true }, logger: recordingLogger(lines) })
      // Only this spec's artifacts: the registry is process-wide, so the real ones (pandoc, model)
      // are swept too and their outcome belongs to their own specs.
      const mine = results.filter(result => [A, B, C].includes(result.id))
      expect(mine.map(result => [result.id, result.ok])).toEqual([[A, true], [B, false], [C, true]])
      // The failure line names the artifact AND carries the reason (the aggregate summary line is
      // `ensureAllAsync`'s, asserted in the next spec).
      expect(lines.some(line => line.includes(`provision[${B}]: 失败`) && line.includes('HTTP 404'))).toBe(true)
      // C ran even though B failed, and both written installs happened.
      expect(installs.some(dir => dir.includes(B))).toBe(true)
      expect(installs.some(dir => dir.includes(C))).toBe(true)
      expect(lines.some(line => line.includes(`provision[${A}]: 已就绪`))).toBe(true)
      expect(lines.some(line => line.includes(`provision[${B}]: 失败`))).toBe(true)
      expect(lines.some(line => line.includes(`provision[${C}]: 安装完成`))).toBe(true)
    } finally {
      rmSync(toolsDir, { recursive: true, force: true })
    }
  })

  it('reports a degraded run through the non-blocking startup form', async () => {
    const toolsDir = mkdtempSync(join(tmpdir(), 'avf-sweep-async-'))
    try {
      const lines: string[] = []
      await ensureAllAsync({ toolsDir, config: { dir: toolsDir, mirror: [], auto_install: true }, logger: recordingLogger(lines) })
      // The scheduling line names every artifact it is about to sweep, which is what an operator
      // reads to know the host is provisioning something at all.
      const scheduled = lines.find(line => line.startsWith('INFO provision: 启动预装已调度'))
      expect(scheduled).toBeDefined()
      for (const id of [A, B, C]) expect(scheduled).toContain(id)
      expect(lines.some(line => line.includes('未就绪'))).toBe(true)
    } finally {
      rmSync(toolsDir, { recursive: true, force: true })
    }
  })

  it('reports an artifact that is already present without installing it', async () => {
    const { registerArtifact } = await import('../src/index.js')
    registerArtifact(scripted('sweep-present', { present: true }))
    const toolsDir = mkdtempSync(join(tmpdir(), 'avf-sweep-present-'))
    try {
      const results = await ensureAll({ toolsDir, config: { dir: toolsDir, mirror: [], auto_install: true }, logger: silentLogger })
      const present = results.find(result => result.id === 'sweep-present')
      expect(present?.ok).toBe(true)
    } finally {
      rmSync(toolsDir, { recursive: true, force: true })
    }
  })
})
