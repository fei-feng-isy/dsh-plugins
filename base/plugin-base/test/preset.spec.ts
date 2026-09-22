import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertEnvinitArtifacts, assertEnvinitPreset, assertEnvinitPresetChecks, envinitPreset } from '../src/preset.js'
import type { PresetCheck } from '../src/preset.js'

const FRAMEWORK_VERSION = '0.1.3'
/** This package's own root, for the "the base's real manifest passes its own rule" assertion. */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface Fixture {
  readonly cwd: string
  readonly frameworkDir: string
  readonly peer: string
  readonly dev: string
  readonly server: string
  readonly client: string
  readonly frameworkVersion: string
  readonly frameworkDeps: boolean
  readonly frameworkPeers: Record<string, string>
}

describe('dsh-plugin-base preset', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'envinit-preset-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function fixture(overrides: Partial<Fixture> = {}): Promise<Fixture> {
    const cwd = overrides.cwd ?? join(root, 'plugin')
    const frameworkDir = overrides.frameworkDir ?? join(cwd, 'node_modules', '@avantf', 'dsh-plugin-base')
    const frameworkVersion = overrides.frameworkVersion ?? FRAMEWORK_VERSION
    const frameworkPeers = overrides.frameworkPeers ?? {}
    await mkdir(join(cwd, 'dist'), { recursive: true })
    await mkdir(frameworkDir, { recursive: true })
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        name: 'demo-plugin',
        private: true,
        peerDependencies: { '@avantf/dsh-plugin-base': overrides.peer ?? '^0.1.3' },
        devDependencies: { '@avantf/dsh-plugin-base': overrides.dev ?? overrides.peer ?? '^0.1.3' },
      }),
    )
    await writeFile(
      join(frameworkDir, 'package.json'),
      JSON.stringify({
        name: '@avantf/dsh-plugin-base',
        version: frameworkVersion,
        type: 'module',
        ...(overrides.frameworkDeps === true ? { dependencies: { 'left-pad': '^1.0.0' } } : {}),
        ...(Object.keys(frameworkPeers).length > 0 ? { peerDependencies: frameworkPeers } : {}),
      }),
    )
    const server = overrides.server ?? join(cwd, 'dist', 'server.js')
    const client = overrides.client ?? join(cwd, 'dist', 'client.js')
    await writeFile(server, `import { createProvisioner } from '@avantf/dsh-plugin-base'\nconsole.log(createProvisioner)\n`)
    await writeFile(client, `console.log('browser half')\n`)
    return {
      cwd,
      frameworkDir,
      peer: overrides.peer ?? '^0.1.3',
      dev: overrides.dev ?? overrides.peer ?? '^0.1.3',
      server,
      client,
      frameworkVersion,
      frameworkDeps: overrides.frameworkDeps === true,
      frameworkPeers,
    }
  }

  const statusOf = (checks: readonly PresetCheck[], id: string): string | undefined =>
    checks.find(entry => entry.id === id)?.status

  it('passes on a well-formed plugin repo', async () => {
    const f = await fixture()
    const preset = envinitPreset({ cwd: f.cwd })
    expect(preset.ok).toBe(true)
    expect(preset.declaredRange).toBe('^0.1.3')
    expect(preset.external).toEqual(['@avantf/dsh-plugin-base'])
    expect(preset.noExternal).toEqual(['@avantf/dsh-plugin-base/bootstrap'])
    expect(statusOf(preset.checks, 'preset/framework-self-contained')).toBe('pass')
    expect(statusOf(preset.checks, 'preset/bootstrap-version-in-range')).toBe('pass')
    expect(() => {
      assertEnvinitPreset(preset)
    }).not.toThrow()
  })

  it('merges the plugin whitelist into external without duplicating the framework', async () => {
    const f = await fixture()
    const preset = envinitPreset({ cwd: f.cwd, external: ['react', '@avantf/dsh-plugin-base'] })
    expect(preset.external).toEqual(['@avantf/dsh-plugin-base', 'react'])
  })

  it('fails when no framework copy can be resolved', async () => {
    const cwd = join(root, 'empty-plugin')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'empty', peerDependencies: { '@avantf/dsh-plugin-base': '^0.1.0' } }))
    const preset = envinitPreset({ cwd })
    expect(preset.ok).toBe(false)
    expect(statusOf(preset.checks, 'preset/framework-resolvable')).toBe('fail')
    expect(() => {
      assertEnvinitPreset(preset)
    }).toThrow(/preset\/framework-resolvable/)
  })

  it('fails when the plugin does not declare a peer range', async () => {
    const f = await fixture()
    await writeFile(join(f.cwd, 'package.json'), JSON.stringify({ name: 'demo-plugin' }))
    const preset = envinitPreset({ cwd: f.cwd })
    expect(statusOf(preset.checks, 'preset/peer-range-declared')).toBe('fail')
  })

  it('fails when devDependencies disagrees with the peer range', async () => {
    const f = await fixture({ dev: '^1.0.0' })
    const preset = envinitPreset({ cwd: f.cwd })
    expect(statusOf(preset.checks, 'preset/range-single-source')).toBe('fail')
    expect(statusOf(preset.checks, 'preset/peer-range-declared')).toBe('pass')
  })

  it('fails when an explicit range contradicts peerDependencies', async () => {
    const f = await fixture()
    const preset = envinitPreset({ cwd: f.cwd, range: '~0.1.0' })
    expect(statusOf(preset.checks, 'preset/range-single-source')).toBe('fail')
  })

  it('fails when the framework package is not self-contained', async () => {
    const f = await fixture({ frameworkDeps: true })
    const preset = envinitPreset({ cwd: f.cwd })
    expect(statusOf(preset.checks, 'preset/framework-self-contained')).toBe('fail')
  })

  it('accepts the base\'s one permitted peer (zod)', async () => {
    const f = await fixture({ frameworkPeers: { zod: '>=4.4.3 <5' } })
    const preset = envinitPreset({ cwd: f.cwd })
    expect(statusOf(preset.checks, 'preset/framework-self-contained')).toBe('pass')
  })

  it('fails on any second framework peer', async () => {
    const f = await fixture({ frameworkPeers: { zod: '>=4.4.3 <5', react: '^18.3.0' } })
    const preset = envinitPreset({ cwd: f.cwd })
    expect(statusOf(preset.checks, 'preset/framework-self-contained')).toBe('fail')
    expect(preset.checks.find(entry => entry.id === 'preset/framework-self-contained')?.message).toContain('react')
  })

  it('this base package\'s own manifest satisfies the rule it enforces', () => {
    // The base merged the compatibility gate (which needs `zod`) into itself; this pins that the
    // merge did not turn the base's own manifest into a self-containment failure.
    const checks = envinitPreset({ cwd: repo, frameworkDir: repo }).checks
    expect(statusOf(checks, 'preset/framework-self-contained')).toBe('pass')
  })

  it('fails when the framework copy is a different version', async () => {
    const f = await fixture({ frameworkVersion: '9.9.9' })
    const preset = envinitPreset({ cwd: f.cwd })
    expect(statusOf(preset.checks, 'preset/preset-version-matches-package')).toBe('fail')
    expect(statusOf(preset.checks, 'preset/bootstrap-version-matches-package')).toBe('fail')
    expect(preset.ok).toBe(false)
  })

  it('fails when the bootstrap version is outside the declared range', async () => {
    const f = await fixture({ peer: '^9.0.0', dev: '^9.0.0' })
    const preset = envinitPreset({ cwd: f.cwd })
    expect(statusOf(preset.checks, 'preset/bootstrap-version-in-range')).toBe('fail')
  })

  it('accepts a server artifact that keeps the framework external', async () => {
    const f = await fixture()
    const checks = assertEnvinitArtifacts({ artifacts: [f.server], clientArtifacts: [f.client] })
    expect(checks.map(entry => [entry.id, entry.status])).toEqual([
      ['preset/server-artifacts-external-only', 'pass'],
      ['preset/client-artifacts-clean', 'pass'],
    ])
    expect(() => {
      assertEnvinitPresetChecks(checks)
    }).not.toThrow()
  })

  it('fails when the bootstrap was left external instead of inlined', async () => {
    const f = await fixture()
    await writeFile(f.server, `import { ensureFramework } from '@avantf/dsh-plugin-base/bootstrap'\nconsole.log(ensureFramework)\n`)
    const checks = assertEnvinitArtifacts({ artifacts: [f.server] })
    expect(statusOf(checks, 'preset/server-artifacts-external-only')).toBe('fail')
    expect(() => {
      assertEnvinitPresetChecks(checks)
    }).toThrow(/server-artifacts-external-only/)
  })

  it('fails when the server artifact inlined the framework instead of externalising it', async () => {
    const f = await fixture()
    await writeFile(f.server, `const layout = '.status.lock' + '.layout.json' + '.quarantine'\nconsole.log(layout)\n`)
    const checks = assertEnvinitArtifacts({ artifacts: [f.server] })
    expect(statusOf(checks, 'preset/server-artifacts-external-only')).toBe('fail')
    expect(checks[0]?.message).toMatch(/被内联/)
  })

  it('tolerates a single control-plane literal', async () => {
    const f = await fixture()
    await writeFile(f.server, `const only = '.envinit'\nconsole.log(only)\n`)
    const checks = assertEnvinitArtifacts({ artifacts: [f.server] })
    expect(statusOf(checks, 'preset/server-artifacts-external-only')).toBe('pass')
  })

  it('fails when the client half imports the framework', async () => {
    const f = await fixture()
    await writeFile(f.client, `import '@avantf/dsh-plugin-base/bootstrap'\n`)
    const checks = assertEnvinitArtifacts({ clientArtifacts: [f.client] })
    expect(statusOf(checks, 'preset/client-artifacts-clean')).toBe('fail')
  })

  it('skips artifact checks that were not given paths', () => {
    const checks = assertEnvinitArtifacts({})
    expect(checks.every(entry => entry.status === 'skip')).toBe(true)
  })
})
