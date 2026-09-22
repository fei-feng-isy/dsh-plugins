import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertProviderConformance, runProviderConformance } from '../src/conformance.js'
import { ProvisionError } from '../src/errors.js'
import { defaultFs, exists } from '../src/fs.js'
import { downloadBytes } from '../src/net.js'
import { npmPackageProvider } from '../src/providers/npm.js'
import { binaryArchiveProvider } from '../src/providers/archive.js'
import { modelCacheProvider } from '../src/providers/model.js'
import { extractTarGz } from '../src/tar.js'
import type { InstallContext, Provider, ProviderContext, ProvisionItem, Resolved } from '../src/types.js'
import { tarGz } from './helpers/tar.js'
import { removeHome } from './helpers/tmp.js'

const KIND = 'plugin:demo'

function item(overrides: Partial<ProvisionItem> = {}): ProvisionItem {
  return {
    id: 'demo:widget',
    kind: KIND,
    spec: { version: '1.0.0' },
    target: { root: 'tools' },
    schemaVersion: 1,
    ...overrides,
  }
}

const payload = tarGz([{ name: 'payload/payload.txt', data: 'hello\n' }])

function servingFetch(): typeof fetch {
  return (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch
}

interface StubBehaviour {
  readonly probeMutates?: boolean
  readonly planUnstable?: boolean
  readonly targetDir?: string
  readonly verifyAcceptsMissing?: boolean
  readonly installWritesOutside?: boolean
  /** Write straight into the target root and skip `publish()`. */
  readonly bypassPublish?: boolean
}

function demoProvider(behaviour: StubBehaviour = {}): Provider {
  const resolveVersion = (item: ProvisionItem): string => (item.spec as { version: string }).version
  const managedDir = (ctx: ProviderContext, item: ProvisionItem): string =>
    join(ctx.home, item.target.root, behaviour.bypassPublish === true ? 'demo-direct' : 'demo', resolveVersion(item))

  return {
    id: '@avantf/demo-provider',
    kinds: [KIND],

    identify: item => ({ name: 'demo', range: resolveVersion(item) }),

    plan: () => (behaviour.planUnstable === true ? { action: 'install' as const, urls: [String(Math.random())] } : { action: 'install' as const }),

    targetDir: (_item, ref) => behaviour.targetDir ?? join('demo', ref.segment),

    async probe(item, ctx) {
      if (behaviour.probeMutates === true) await ctx.fs.writeFile(join(ctx.home, 'probe-touched'), new Uint8Array())
      const found = await exists(ctx.fs, join(managedDir(ctx, item), 'payload', 'payload.txt'))
      return found ? { found: true, version: resolveVersion(item), dir: managedDir(ctx, item), source: 'managed' as const } : { found: false }
    },

    async install(item, ctx: InstallContext): Promise<Resolved> {
      if (behaviour.installWritesOutside === true) {
        await ctx.fs.writeFile(join(ctx.home, 'outside-the-staging-root.txt'), new Uint8Array())
      }
      if (behaviour.bypassPublish === true) {
        const root = join(ctx.home, item.target.root, 'demo-direct', resolveVersion(item))
        await ctx.fs.writeFile(join(root, 'payload', 'payload.txt'), new TextEncoder().encode('hello\n'))
        return {
          key: '',
          name: 'demo',
          version: resolveVersion(item),
          dir: root,
          entryDir: join(root, 'payload'),
          source: 'installed',
        }
      }
      const staging = await ctx.stage()
      const { bytes } = await downloadBytes(ctx, ['https://example.test/demo.tar.gz'], `${KIND}+demo`)
      await extractTarGz(bytes, staging, ctx.fs)
      return ctx.publish(staging, { name: 'demo', version: resolveVersion(item), source: 'installed', entryDir: 'payload' })
    },

    async verify(_item, resolved, ctx) {
      if (behaviour.verifyAcceptsMissing === true) return
      if (!(await exists(ctx.fs, join(resolved.entryDir, 'payload.txt')))) {
        throw new ProvisionError('verify/failed', `缺少 payload.txt：${resolved.entryDir}`)
      }
    },
  }
}

describe('provider conformance kit', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'envinit-conformance-test-'))
  })
  afterEach(async () => {
    await removeHome(home)
  })

  const statusOf = (report: { checks: readonly { id: string; status: string }[] }, id: string): string | undefined =>
    report.checks.find(entry => entry.id === id)?.status

  function run(overrides: Partial<Parameters<typeof runProviderConformance>[0]> = {}) {
    return runProviderConformance({
      provider: demoProvider(),
      items: [item()],
      home,
      fetch: servingFetch(),
      ...overrides,
    })
  }

  it('passes a well-behaved provider end to end', async () => {
    const report = await run({ packageName: '@avantf/demo-provider' })
    expect(report.checks.filter(entry => entry.status === 'fail')).toEqual([])
    expect(report.ok).toBe(true)
    expect(statusOf(report, 'conformance/install-landing')).toBe('pass')
    expect(statusOf(report, 'conformance/install-idempotent')).toBe('pass')
    expect(statusOf(report, 'conformance/install-half-failure')).toBe('pass')
    expect(statusOf(report, 'conformance/register-conflict')).toBe('pass')
    expect(statusOf(report, 'conformance/unknown-provider')).toBe('pass')
    expect(statusOf(report, 'conformance/provider-artifact-type-only')).toBe('skip')
    expect(statusOf(report, 'conformance/core-rejects-bad-target-dir')).toBe('pass')
    expect(statusOf(report, 'conformance/core-quarantines-bad-copy')).toBe('pass')
    expect(statusOf(report, 'conformance/report-completeness')).toBe('pass')
    // Honest deferral: reclamation lands with stage 3, and the kit says so instead of faking a pass.
    expect(statusOf(report, 'conformance/recycle-semantics')).toBe('skip')
    expect(() => {
      assertProviderConformance(report)
    }).not.toThrow()
  })

  it('lists the failing rule ids when it throws', async () => {
    const report = await run({ provider: demoProvider({ verifyAcceptsMissing: true }) })
    expect(report.ok).toBe(false)
    expect(() => {
      assertProviderConformance(report)
    }).toThrow(/conformance\/verify-rejects-missing/)
  })

  it('rejects a provider that mutates the disk during probe', async () => {
    const report = await run({ provider: demoProvider({ probeMutates: true }), install: false })
    expect(statusOf(report, 'conformance/probe-pure')).toBe('fail')
    expect(statusOf(report, 'conformance/plan-pure')).toBe('pass')
  })

  it('rejects a plan that is not repeatable', async () => {
    const report = await run({ provider: demoProvider({ planUnstable: true }), install: false })
    expect(statusOf(report, 'conformance/plan-pure')).toBe('fail')
  })

  it('rejects a targetDir that escapes the item root', async () => {
    for (const escaping of ['../evil', '/abs/evil', 'demo/../../evil']) {
      const report = await run({ provider: demoProvider({ targetDir: escaping }), install: false })
      expect(statusOf(report, 'conformance/target-dir-safe')).toBe('fail')
    }
  })

  it('accepts a targetDir that is a plain relative path', async () => {
    const report = await run({ provider: demoProvider({ targetDir: 'demo/1.0.0' }), install: false })
    expect(statusOf(report, 'conformance/target-dir-safe')).toBe('pass')
  })

  it('rejects a verify that accepts a missing directory', async () => {
    const report = await run({ provider: demoProvider({ verifyAcceptsMissing: true }), install: false })
    expect(statusOf(report, 'conformance/verify-rejects-missing')).toBe('fail')
  })

  it('rejects an install that writes outside staging and the target root', async () => {
    const report = await run({ provider: demoProvider({ installWritesOutside: true }) })
    expect(statusOf(report, 'conformance/install-landing')).toBe('fail')
    expect(report.checks.find(entry => entry.id === 'conformance/install-landing')?.message).toMatch(/outside-the-staging-root/)
  })

  it('requires the publish lock unless the kind bypasses publish', async () => {
    const strict = await run({ provider: demoProvider({ bypassPublish: true }), home: join(home, 'strict') })
    expect(statusOf(strict, 'conformance/install-landing')).toBe('fail')
    expect(strict.checks.find(entry => entry.id === 'conformance/install-landing')?.message).toMatch(/ctx\.publish/)

    const allowed = await run({ provider: demoProvider({ bypassPublish: true }), bypassPublish: true, home: join(home, 'allowed') })
    expect(statusOf(allowed, 'conformance/install-landing')).toBe('pass')
    expect(statusOf(allowed, 'conformance/install-idempotent')).toBe('pass')
  })

  it('skips the round-trip when install is disabled', async () => {
    const report = await run({ install: false })
    expect(statusOf(report, 'conformance/install-landing')).toBe('skip')
    expect(statusOf(report, 'conformance/install-idempotent')).toBe('skip')
    expect(statusOf(report, 'conformance/install-half-failure')).toBe('skip')
    expect(report.ok).toBe(true)
  })

  it('rejects a third-party kind without a namespace, and skips the rest', async () => {
    const report = await run({ provider: { ...demoProvider(), kinds: ['demo'] }, install: false })
    expect(statusOf(report, 'conformance/kinds')).toBe('fail')
    expect(statusOf(report, 'conformance/probe-pure')).toBe('skip')
    expect(report.checks).toHaveLength(19)
  })

  it('rejects a provider id that is not its package name', async () => {
    const report = await run({ packageName: '@avantf/something-else', install: false })
    expect(statusOf(report, 'conformance/id-is-package-name')).toBe('fail')
  })

  it('flags framework imports in provider and client artifacts', async () => {
    const providerArtifact = join(home, 'provider.js')
    const clientArtifact = join(home, 'client.js')
    const cleanArtifact = join(home, 'clean.js')
    await writeFile(providerArtifact, `import { createProvisioner } from '@avantf/dsh-plugin-base'\n`)
    await writeFile(clientArtifact, `import '@avantf/dsh-plugin-base/bootstrap'\n`)
    await writeFile(cleanArtifact, `const PACKAGE = '@avantf/dsh-plugin-base'\nexport default PACKAGE\n`)

    const bad = await run({ artifacts: [providerArtifact], clientArtifacts: [clientArtifact], install: false })
    expect(statusOf(bad, 'conformance/provider-artifact-type-only')).toBe('fail')
    expect(statusOf(bad, 'conformance/client-artifact-clean')).toBe('fail')

    const good = await run({ artifacts: [cleanArtifact], install: false })
    expect(statusOf(good, 'conformance/provider-artifact-type-only')).toBe('pass')
  })

  it('leaves no usable directory behind when the download body is corrupt', async () => {
    const report = await run()
    expect(statusOf(report, 'conformance/install-half-failure')).toBe('pass')
    // The corrupt-body run used its own sub-home and published nothing.
    await expect(exists(defaultFs(), join(home, 'half-failure', 'tools'))).resolves.toBe(false)
  })

  it('skips the fault-injection check for a provider that needs no download', async () => {
    const localOnly: Provider = {
      ...demoProvider(),
      async install(item, ctx): Promise<Resolved> {
        const root = join(ctx.home, item.target.root, 'demo', '1.0.0')
        await ctx.fs.writeFile(join(root, 'payload', 'payload.txt'), new TextEncoder().encode('hello\n'))
        return { key: '', name: 'demo', version: '1.0.0', dir: root, entryDir: join(root, 'payload'), source: 'installed' }
      },
    }
    const report = await run({ provider: localOnly, home: join(home, 'local-only') })
    expect(statusOf(report, 'conformance/install-half-failure')).toBe('skip')
  })

  it('reports every check even when the provider is unusable', async () => {
    const report = await run({ provider: { ...demoProvider(), kinds: [] }, install: false })
    expect(report.checks.map(entry => entry.id)).toEqual([
      'conformance/kinds',
      'conformance/id-is-package-name',
      'conformance/identify-shape',
      'conformance/probe-pure',
      'conformance/plan-pure',
      'conformance/target-dir-safe',
      'conformance/verify-rejects-missing',
      'conformance/install-landing',
      'conformance/install-idempotent',
      'conformance/install-half-failure',
      'conformance/core-rejects-bad-target-dir',
      'conformance/core-quarantines-bad-copy',
      'conformance/report-completeness',
      'conformance/register-conflict',
      'conformance/unknown-provider',
      'conformance/provider-importable',
      'conformance/provider-artifact-type-only',
      'conformance/client-artifact-clean',
      'conformance/recycle-semantics',
    ])
  })

  it('never removes a home the caller owns', async () => {
    const owned = join(home, 'owned')
    await mkdir(owned)
    const report = await run({ home: owned, install: false })
    expect(report.ok).toBe(true)
    await expect(exists(defaultFs(), owned)).resolves.toBe(true)
  })

  describe('the built-in providers', () => {
    it('passes the kit for npm-package, binary-archive and model-cache', { timeout: 30_000 }, async () => {
      const cases: readonly { readonly provider: Provider; readonly item: ProvisionItem }[] = [
        {
          provider: npmPackageProvider(),
          item: item({ id: 'demo:npm', kind: 'npm-package', spec: { name: 'left-pad', range: '^1.0.0' }, target: { root: 'runtime' } }),
        },
        {
          provider: binaryArchiveProvider(),
          item: item({ id: 'demo:bin', kind: 'binary-archive', spec: { id: 'demo', version: '1.0.0', packs: {} }, target: { root: 'tools' } }),
        },
        {
          provider: modelCacheProvider(),
          item: item({ id: 'demo:model', kind: 'model-cache', spec: { repo: 'org/model' }, target: { root: 'models' } }),
        },
      ]
      for (const entry of cases) {
        const report = await runProviderConformance({ provider: entry.provider, items: [entry.item], home, install: false })
        const failures = report.checks.filter(check => check.status === 'fail')
        expect(failures, `${entry.provider.id}: ${failures.map(check => `${check.id} ${check.message}`).join(' | ')}`).toEqual([])
        expect(report.ok).toBe(true)
      }
    })
  })

  it('drives the real core so a landed directory is actually usable', async () => {
    const report = await run()
    expect(report.ok).toBe(true)
    // The stub published `payload/payload.txt` under `<home>/tools/demo/1.0.0`.
    await expect(readFile(join(home, 'round-trip', 'tools', 'demo', '1.0.0', 'payload', 'payload.txt'), 'utf8')).resolves.toBe('hello\n')
    const manifest: unknown = JSON.parse(await readFile(join(home, 'round-trip', 'tools', 'demo', '1.0.0', 'install.json'), 'utf8'))
    expect(manifest).toMatchObject({ name: 'demo', version: '1.0.0', entryDir: 'payload' })
  })
})
