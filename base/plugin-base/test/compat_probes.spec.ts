/**
 * The probes, run against the HOST's real registries.
 *
 * This is the safety net for the whole package: a probe that fails against a healthy host turns a
 * working plugin into a refused one. So the two probes are pointed at the real services
 * (`@deepseek-ai/dsh-tools`'s `ToolRuntime`, `@deepseek-ai/dsh-typert-registry`'s `TypertRegistry`)
 * rather than at stubs, and the withdrawal is checked on those real registries too.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import {
  BUILD_VERSIONS_FILE,
  readBuildVersions,
  readDeclaredVersions,
  readRuntimeVersions,
  schemaNamesFrom,
  toolProbeDeclaration,
} from '../src/index.js'
// The individual probes are the composition pieces `gatherEvidence` is built from; generation v3
// moved them off `.` to `./internal` (INTERFACE.md §9).
import {
  COMPAT_PROBE_TOOL,
  declaredSchemaKeys,
  probeToolsRegistry,
  probeTypertRegistry,
  resolveRuntimeVersion,
} from '../src/internal.js'

const PACKAGE = '@avantf/dsh-plugin-base'

/**
 * The MINIMAL contribution shape, as a FIXTURE only.
 *
 * It used to be exported from the package as a convenience stand-in, and that is exactly the mistake
 * documented on `CompatSpec.probeTypert`: a probe declaration that is not the real one passed while
 * the plugin's real contribution threw halfway through `apply` on a live 0.1.6 host. No production
 * caller ever used it, so it lives here, where "not the real declaration" is the point of the test.
 */
function minimalTypertProbeDeclaration(packageId: string): Record<string, unknown> {
  const schema = (): unknown => z.object({ probe: z.literal(true) })
  return {
    package: packageId,
    face: 'host',
    schemas: [{ name: 'compatProbe', schema: schema(), create: schema }],
    model: { services: [], events: [], objects: [] },
    invocations: [],
  }
}

/** The probe declaration a real plugin supplies: its own `defineTool`, so the probe mirrors it. */
const buildProbe = toolProbeDeclaration(defineTool)

/**
 * A wire probe that mirrors a REAL face: one declared schema AND one invocation carrying a strict
 * codec — the member whose contract moved (`create()` became required). A probe without a codec
 * cannot see that move, which is exactly how a false `ok` happens.
 */
function buildWireProbe(withCreate: boolean): () => unknown {
  const schema = z.object({ probe: z.literal(true) })
  const codec = {
    mode: 'strict',
    typeSymbol: `${PACKAGE}#probeArgs`,
    schema,
    ...(withCreate ? { create: () => schema } : {}),
  }
  return () => ({
    package: PACKAGE,
    face: 'host',
    schemas: [{ name: 'compatProbe', schema, create: () => schema }],
    model: { services: [], events: [], objects: [] },
    invocations: [{
      // The host validates every member of this: id, service key, wire names, and one codec per
      // parameter plus the result.
      id: `${PACKAGE}#compatProbe/probe`,
      service: 'compatProbe',
      namespace: 'compatProbe',
      method: 'probe',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'args', wire: 'args', source: 'json', codec }],
      result: codec,
    }],
  })
}

/** A minimal `systemPrompt`; mounting the real `ToolRuntime` only needs the registration surface. */
function provideSystemPrompt(ctx: Context): void {
  ctx.provide('systemPrompt', {
    section: () => () => undefined,
    context: () => () => undefined,
    tools: () => () => undefined,
    getSectionOrder: () => 1600,
    getContextOrder: () => 120,
  })
}

describe('the tools registry probe', () => {
  it("passes against the host's real ToolRuntime, and withdraws", async () => {
    const ctx = new Context()
    provideSystemPrompt(ctx)
    const fiber = await ctx.plugin(ToolRuntime)
    const tools = ctx.get('tools') as unknown
    expect(tools, 'the real ToolRuntime did not mount').toBeDefined()

    expect(probeToolsRegistry(tools, buildProbe)).toEqual({ ran: true, passed: true, problems: [] })
    // The probe is gone: a leftover would be a phantom tool no assertion would expect.
    expect((tools as { get: (name: string) => unknown }).get(COMPAT_PROBE_TOOL)).toBeUndefined()
    await fiber.dispose()
  })

  it('says "not probed" instead of "broken" without a declaration or without a register/get pair', () => {
    // No builder in the spec ⇒ nothing was proven, and nothing is blocked either.
    expect(probeToolsRegistry({ register: () => undefined, get: () => undefined }, undefined))
      .toEqual({ ran: false, passed: false, problems: [] })
    expect(probeToolsRegistry({}, buildProbe)).toEqual({ ran: false, passed: false, problems: [] })
    expect(probeToolsRegistry(undefined, buildProbe)).toEqual({ ran: false, passed: false, problems: [] })
  })

  it('reports what a refusing registry said, without throwing', () => {
    const outcome = probeToolsRegistry({
      register: () => { throw new Error('nope') },
      get: () => undefined,
    }, buildProbe)
    expect(outcome.ran).toBe(true)
    expect(outcome.passed).toBe(false)
    expect(outcome.problems.join('\n')).toContain('nope')
  })

  it('reports a registration that was accepted but never recorded', () => {
    const outcome = probeToolsRegistry({ register: () => () => undefined, get: () => undefined }, buildProbe)
    expect(outcome.passed).toBe(false)
    expect(outcome.problems.join('\n')).toContain('was not recorded')
  })
})

describe('the typert registry probe', () => {
  it("passes against the host's real TypertRegistry, and withdraws", async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(TypertRegistry)
    const typert = ctx.get('typert') as unknown
    expect(typert, 'the real Typert registry did not mount').toBeDefined()

    expect(probeTypertRegistry(typert, PACKAGE, buildWireProbe(true)))
      .toEqual({ ran: true, passed: true, problems: [] })
    expect((typert as { listPackages: (filter?: unknown) => unknown[] }).listPackages({ package: PACKAGE })).toEqual([])
    await fiber.dispose()
  })

  it('verifies the face the DECLARATION names, not a hardcoded host face', async () => {
    // The registry accepts TWO faces (`host` and `client`). A probe that assumed `host` reported a
    // working client-face registration as "not listed" — a false refusal of a plugin the host can
    // drive, and exactly the failure this package's "probe your real declaration" rule exists to avoid.
    const ctx = new Context()
    const fiber = await ctx.plugin(TypertRegistry)
    const typert = ctx.get('typert') as unknown
    const clientId = `${PACKAGE}-client`
    const schema = z.object({ probe: z.literal(true) })
    expect(probeTypertRegistry(typert, clientId, () => ({
      package: clientId,
      face: 'client',
      schemas: [{ name: 'compatProbe', schema, create: () => schema }],
      model: { services: [], events: [], objects: [] },
      invocations: [],
    }))).toEqual({ ran: true, passed: true, problems: [] })
    expect((typert as { listPackages: (filter?: unknown) => unknown[] }).listPackages({ package: clientId })).toEqual([])
    await fiber.dispose()
  })

  it('verifies the package face even when the declaration carries no schema', () => {
    // A model-only face declares no schema key to read back; nesting the face check under "has
    // schemas" would let a registration that never listed pass as if it had been probed.
    const outcome = probeTypertRegistry({
      register: () => () => undefined,
      list: () => [],
      get: () => undefined,
      listPackages: () => [],
      toJSONSchema: () => ({}),
    }, PACKAGE, () => ({
      package: PACKAGE,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [],
    }))
    expect(outcome.ran).toBe(true)
    expect(outcome.passed).toBe(false)
    expect(outcome.problems.join('\n')).toContain("did not list the probe's host face")
  })

  it('submits the codec to the host validator — the member whose contract moves', async () => {
    // Not a version test: it asserts the probe actually HANDS OVER a codec, whichever member this
    // host checks. A probe without one is how a live host reported `ok` and then half-mounted the
    // plugin when 0.1.6 started requiring `create()` where 0.1.5 required `schema.parse`.
    const ctx = new Context()
    const fiber = await ctx.plugin(TypertRegistry)
    const typert = ctx.get('typert')

    // A codec carrying BOTH members (`schema` for the older validator, `create` for the newer) is
    // accepted — that is the shape a plugin must ship to serve both.
    expect(probeTypertRegistry(typert, PACKAGE, buildWireProbe(true)))
      .toEqual({ ran: true, passed: true, problems: [] })

    // A codec the host cannot accept is refused WITH a reason: the probe really did hand it over.
    // BOTH members go: which one this host checks MOVED (0.1.5 reads `schema`, 0.1.6+ calls
    // `create`, 0.1.7 dropped `schema` from its codec type), so stripping only the older member is
    // accepted by the newer host and this assertion would pass for the wrong reason. Which member
    // the host *complains* about stays its business — the assertion below remains portable.
    const broken = buildWireProbe(true)
    const outcome = probeTypertRegistry(typert, PACKAGE, () => {
      const contribution = broken() as { invocations: { parameters: { codec: Record<string, unknown> }[] }[] }
      delete contribution.invocations[0]?.parameters[0]?.codec['schema']
      delete contribution.invocations[0]?.parameters[0]?.codec['create']
      return contribution
    })
    expect(outcome.ran).toBe(true)
    expect(outcome.passed).toBe(false)
    expect(outcome.problems.length).toBeGreaterThan(0)
    await fiber.dispose()
  })

  it('says "not probed" without a declaration, or when the query surface is incomplete', () => {
    // No declaration ⇒ nothing is claimed. This is the honest alternative to inventing a shape.
    expect(probeTypertRegistry({}, PACKAGE, undefined)).toEqual({ ran: false, passed: false, problems: [] })
    expect(probeTypertRegistry({ register: () => undefined }, PACKAGE, minimalTypertProbeDeclaration)).toEqual({
      ran: false,
      passed: false,
      problems: [],
    })
  })
})

describe('the version helpers', () => {
  it('pins NO dsh version: this package must serve every dsh release', () => {
    // The requirement, asserted: no `@deepseek-ai/*` entry anywhere in the manifest, and no runtime
    // dependency at all beyond the zod peer.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const dsh = (section: Record<string, string> | undefined): string[] =>
      Object.keys(section ?? {}).filter((name) => name.startsWith('@deepseek-ai/'))
    expect(dsh(manifest.dependencies)).toEqual([])
    expect(dsh(manifest.peerDependencies)).toEqual([])
    expect(dsh(manifest.devDependencies)).toEqual([])
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(['zod'])
    // The zod peer is deliberately WIDE. This package only builds live probe schemas, and the family
    // consumers ship different — both working — zod copies: 4.4.3 (the one the harness checkout
    // aligns to) and 4.6.5 (the one the installed dsh carries). `^4.6.5` refused the former; both
    // ends are proven by running `pnpm typecheck && pnpm test` under each copy.
    expect(manifest.peerDependencies?.['zod']).toBe('>=4.4.3 <5')
  })

  it('reads the declared floor out of a manifest it is pointed at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-manifest-'))
    const manifest = join(dir, 'package.json')
    writeFileSync(manifest, JSON.stringify({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.5-rc.2' } }))
    const declared = readDeclaredVersions(manifest, ['@deepseek-ai/dsh-tools', '@deepseek-ai/does-not-exist'])
    expect(declared['@deepseek-ai/dsh-tools']).toBe('0.1.5-rc.2')
    expect(declared['@deepseek-ai/does-not-exist']).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('resolves a runtime version through the linked install, and answers undefined otherwise', () => {
    expect(resolveRuntimeVersion('@deepseek-ai/dsh-tools')).toMatch(/^\d+\.\d+\.\d+/)
    expect(resolveRuntimeVersion('@deepseek-ai/definitely-not-installed')).toBeUndefined()
  })

  it('resolves from the base the caller passes, and answers undefined for one without links', () => {
    // A caller passes its own module URL: the packages that identify the host are ITS peers, and this
    // package may not be able to see all of them.
    expect(readRuntimeVersions(['@deepseek-ai/dsh-tools'], import.meta.url)['@deepseek-ai/dsh-tools'])
      .toMatch(/^\d+\.\d+\.\d+/)
    expect(resolveRuntimeVersion('@deepseek-ai/dsh-tools', 'file:///nonexistent/index.js')).toBeUndefined()
  })

  it('never throws on an unreadable manifest', () => {
    expect(readDeclaredVersions('/nonexistent/package.json', ['@deepseek-ai/dsh-tools'])).toEqual({
      '@deepseek-ai/dsh-tools': undefined,
    })
  })

  it('prefers the version a build baked, and falls back PER PACKAGE to the peer floor', () => {
    // The build-time JSON is what makes `declared` mean "the dsh this artifact was compiled against"
    // instead of "the floor of a range". It is read from beside the built entry.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-build-'))
    const file = join(dir, BUILD_VERSIONS_FILE)
    writeFileSync(file, JSON.stringify({
      '@deepseek-ai/dsh-tools': '0.1.5-rc.2',
      '@deepseek-ai/dsh-typert-protocol': '', // an empty string is not a version
    }))
    const floors = {
      '@deepseek-ai/dsh-tools': '0.1.5-rc.1',
      '@deepseek-ai/dsh-typert-protocol': '0.1.5-rc.2',
      '@deepseek-ai/dsh-third': '9.9.9',
    }
    const versions = readBuildVersions(file, [
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/dsh-third',
      '@deepseek-ai/dsh-fourth',
    ], floors)
    // Baked wins over the floor; an unusable entry falls back; a package the file never mentions
    // falls back; one with neither source stays undefined (reported as unknown, never as a mismatch).
    expect(versions).toEqual({
      '@deepseek-ai/dsh-tools': '0.1.5-rc.2',
      '@deepseek-ai/dsh-typert-protocol': '0.1.5-rc.2',
      '@deepseek-ai/dsh-third': '9.9.9',
      '@deepseek-ai/dsh-fourth': undefined,
    })
    // The caller's real form is a URL (`new URL('./dsh-build.json', import.meta.url)`), not a path.
    expect(readBuildVersions(pathToFileURL(file), ['@deepseek-ai/dsh-tools'], floors))
      .toEqual({ '@deepseek-ai/dsh-tools': '0.1.5-rc.2' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats a missing, malformed or non-object build file as "no baked version", never as a throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-compat-build-bad-'))
    const floors = { '@deepseek-ai/dsh-tools': '0.1.5-rc.2' }
    const packages = ['@deepseek-ai/dsh-tools']
    // No file at all: the dev-tree and test-run case.
    expect(readBuildVersions(join(dir, BUILD_VERSIONS_FILE), packages, floors))
      .toEqual({ '@deepseek-ai/dsh-tools': '0.1.5-rc.2' })
    // Not JSON, then JSON that is not an object: both fall back.
    const file = join(dir, BUILD_VERSIONS_FILE)
    writeFileSync(file, 'not json')
    expect(readBuildVersions(file, packages, floors)).toEqual({ '@deepseek-ai/dsh-tools': '0.1.5-rc.2' })
    writeFileSync(file, JSON.stringify(['0.1.5-rc.2']))
    expect(readBuildVersions(file, packages, floors)).toEqual({ '@deepseek-ai/dsh-tools': '0.1.5-rc.2' })
    // A non-string value is not a version either.
    writeFileSync(file, JSON.stringify({ '@deepseek-ai/dsh-tools': 42 }))
    expect(readBuildVersions(file, packages, floors)).toEqual({ '@deepseek-ai/dsh-tools': '0.1.5-rc.2' })
    // No fallback given: still no throw, just "unknown".
    expect(readBuildVersions(file, packages)).toEqual({ '@deepseek-ai/dsh-tools': undefined })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('the schema helpers', () => {
  it('derives the names a contribution declares, and the keys they become', () => {
    const contribution = { schemas: [{ name: 'snapshotargs' }, { name: 'snapshotResult' }, { nope: true }] }
    expect(schemaNamesFrom(contribution)).toEqual(['snapshotargs', 'snapshotResult'])
    expect(declaredSchemaKeys(PACKAGE, ['snapshotargs'])).toEqual([`${PACKAGE}#snapshotargs`])
    expect(schemaNamesFrom(undefined)).toEqual([])
    expect(schemaNamesFrom({})).toEqual([])
  })
})
