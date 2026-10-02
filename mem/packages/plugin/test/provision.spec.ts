/**
 * This plugin's side of the compatibility gate: the SPEC it declares, the gate wiring, and the
 * refusal megaphone.
 *
 * The rules, the probes and the post-registration check are tested where they live
 * (the base `@avantf/dsh-plugin-base`, against the host's real registries). What is tested here is what is true
 * only of this plugin: its spec covers everything the plugin injects, the wire probe IS the real
 * contribution (codecs and all), a proven break refuses while "cannot tell" still loads, and a
 * refusal leaves exactly one command that explains why.
 *
 * The live `apply()` path — the empty mount, the runtime, the 8 tools — is covered end to end by
 * `scripts/mount-smoke.mjs`, which needs a real Cordis context.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { floorOf } from '@avantf/dsh-plugin-base/internal'
import { TOOL_SPECS } from '@avantf/mem-contract'
import { inject } from '../src/inject.js'
import {
  SERVICE_CONTRACTS,
  VERSION_PACKAGES,
  runtimeFromCompat,
  provision,
  registerCompatMegaphone,
  verifyRegisteredFaces,
  type CompatModule,
} from '../src/provision.js'
import { hostContribution } from '../src/remote.js'

/**
 * The gate runtime, exactly as `apply()` builds it once the framework has provisioned the base.
 *
 * `@avantf/dsh-plugin-base` is a devDependency in this checkout, so the REAL module is imported
 * directly — the same object `runtimeFromCompat` would be handed after the inlined bootstrap loaded
 * the base. That the bootstrap finds and loads it is `envinit.spec.ts`'s subject; here the point
 * is the spec, the gate and the refusal report this plugin derives from it.
 */
const compat = runtimeFromCompat((await import('@avantf/dsh-plugin-base')) as CompatModule)
const COMPAT_PREFIX = compat.prefix
const COMPAT_SPEC = compat.spec
const SCHEMA_NAMES = compat.schemaNames

/**
 * A host identical to the build target, CONSTRUCTED rather than assumed.
 *
 * `declared` is what this build was compiled against; the production derivation reads it from the
 * JSON the build baked beside the entry, and falls back per package to the peer range's FLOOR. A src
 * run has no baked file (`src/dsh-build.json` does not exist — the bake lands in `lib/`), so it falls
 * back to the floor, which equals this machine's installed dsh only on the release the range was last
 * bumped for. Stating the healthy host explicitly keeps this case about the GATE's rule (identical
 * versions ⇒ `ok`) instead of about which dsh happens to be installed here; the floor-vs-install
 * drift a real machine can have is `version-mismatch`, which the next case covers on purpose.
 */
const HEALTHY_SPEC = { ...COMPAT_SPEC, declared: COMPAT_SPEC.runtime ?? {} }

/** A logger that keeps its lines, so "did it log the verdict?" is assertable. */
function recorder(): { lines: string[]; log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } } {
  const lines: string[] = []
  return {
    lines,
    log: {
      info: (message: string) => { lines.push(message) },
      warn: (message: string) => { lines.push(message) },
      error: (message: string) => { lines.push(message) },
    },
  }
}

/** Schema rows a real registry builds from a contribution: key `<package>#<schema name>`. */
function typertSchemaRows(contributions: { package: string; face: string; schemas: { name: string }[] }[]) {
  return contributions.flatMap(contribution => contribution.schemas.map(schema => ({
    ...schema,
    package: contribution.package,
    face: contribution.face,
    key: `${contribution.package}#${schema.name}`,
  })))
}

/**
 * A typert registry stub faithful enough to be a falsifier: it records contributions, answers
 * `get`/`list`/`listPackages` from them (exact `key` form, like the real registry), withdraws them
 * on dispose, and projects through `toJSONSchema`. Each option models one way a changed host fails.
 */
function fakeTypert(options: { getMissing?: boolean; jsonThrows?: boolean } = {}) {
  const contributions: { package: string; face: string; schemas: { name: string }[] }[] = []
  return {
    contributions,
    register: (value: unknown) => {
      const contribution = value as (typeof contributions)[number]
      contributions.push(contribution)
      return () => {
        const index = contributions.indexOf(contribution)
        if (index >= 0) contributions.splice(index, 1)
      }
    },
    get: (key: string) => (options.getMissing === true ? undefined : typertSchemaRows(contributions).find(row => row.key === key)),
    list: (filter?: { package?: string }) => typertSchemaRows(contributions)
      .filter(row => filter?.package === undefined || row.package === filter.package),
    listPackages: (filter?: { package?: string }) => contributions
      .filter(contribution => filter?.package === undefined || contribution.package === filter.package)
      .map(contribution => ({ package: contribution.package, face: contribution.face, key: `${contribution.package}#${contribution.face}` })),
    toJSONSchema: (key: string) => {
      if (options.jsonThrows === true) throw new Error('toJSONSchema is gone')
      const row = typertSchemaRows(contributions).find(candidate => candidate.key === key)
      if (row === undefined) throw new Error(`typert: cannot resolve "${key}"`)
      return { $ref: `#/definitions/${row.name}` }
    },
  }
}

/** A tools registry faithful enough for the tools probe: register (with disposer), get by name. */
function fakeTools() {
  const registered: { name: string }[] = []
  return {
    registered,
    register: (tool: unknown) => {
      const entry = tool as { name: string }
      registered.push(entry)
      return () => {
        const index = registered.indexOf(entry)
        if (index >= 0) registered.splice(index, 1)
      }
    },
    get: (name: string) => registered.find(tool => tool.name === name),
  }
}

/**
 * A structural context — no Cordis needed, because the gate only ever calls `ctx.get()`.
 * @param options.typert - the typert registry to expose (or a hostile one).
 */
function fakeContext(options: { typert?: unknown; commands?: unknown[] } = {}) {
  const tools = fakeTools()
  const typert = options.typert ?? fakeTypert()
  const commands = options.commands ?? []
  const services: Record<string, unknown> = {
    tools,
    systemPrompt: { section: () => () => undefined, context: () => () => undefined },
    typert,
    commands: { register: (definition: unknown) => { commands.push(definition); return () => undefined } },
  }
  return { ctx: { get: (name: string) => services[name] }, tools, typert, commands }
}

describe("this plugin's spec", () => {
  it('declares a contract for every injected service', () => {
    // `inject` is what cordis WAITS for, so a service added there without a contract here would go
    // unverified. The reverse is fine: optional services are read with `ctx.get()`.
    const declared = new Set(SERVICE_CONTRACTS.map(contract => contract.name))
    for (const service of inject) expect(declared, `${service} needs a contract`).toContain(service)
  })

  it('declares a version for every package that identifies the host', () => {
    expect(Object.keys(COMPAT_SPEC.declared).sort()).toEqual([...VERSION_PACKAGES].sort())
    expect(COMPAT_SPEC.declared['@deepseek-ai/dsh-tools']).toMatch(/^\d+\.\d+\.\d+/)
    expect(COMPAT_SPEC.runtime?.['@deepseek-ai/dsh-tools']).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('sources `declared` from the baked build file, falling back per package to the peer floor', () => {
    // Tests run from `src/`, where there is no `dsh-build.json`, so the value must be the peer
    // range's FLOOR — exactly what this plugin declared before there was anything to bake. A built
    // artifact has `lib/dsh-build.json` beside the bundled `lib/index.js` (written by
    // `scripts/build-versions.mjs`) and the exact version there wins. This pins the fallback; the
    // base package's tests pin that a present file wins.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      peerDependencies?: Record<string, string>
    }
    const peers = manifest.peerDependencies ?? {}
    for (const name of VERSION_PACKAGES) {
      expect(COMPAT_SPEC.declared[name], `${name} must fall back to its peer floor`).toBe(floorOf(peers[name]))
    }
  })

  it('supplies the declarations the shared gate needs', () => {
    // Nothing here is optional in practice: a missing builder would silently downgrade a probe to
    // "not probed", and a missing schema list would drop the post-registration check.
    expect(typeof COMPAT_SPEC.probeTool).toBe('function')
    // The wire probe must be the REAL face, not a lookalike — see the codec guard below.
    expect(COMPAT_SPEC.probeTypert?.('@avantf/dsh-mem')).toBe(hostContribution)
    expect(COMPAT_SPEC.packageId).toBe('@avantf/dsh-mem')
    expect(SCHEMA_NAMES).toHaveLength(20)
    expect(COMPAT_SPEC.schemaNames).toEqual(SCHEMA_NAMES)
    expect(COMPAT_SPEC.events?.length).toBeGreaterThan(0)
    // This plugin uses a plain `setInterval`, never `ctx.interval`, so it must not demand the timer.
    expect(COMPAT_SPEC.needsInterval).not.toBe(true)
  })

  it('carries both codec members, so one build serves either host validator', () => {
    // Regression guard for a live failure: 0.1.6 requires `create()` where 0.1.5 requires
    // `schema.parse`, and the host checks only its own. A codec missing either one is refused — and
    // if the wire probe did not carry a codec at all, the refusal would land halfway through apply.
    const contribution = hostContribution as unknown as {
      invocations: {
        id: string
        result: { schema?: { parse?: unknown }; create?: unknown }
        parameters: { name: string; codec: { schema?: { parse?: unknown }; create?: unknown } }[]
      }[]
      schemas: { name: string; schema?: { parse?: unknown }; create?: unknown }[]
    }
    const codecs = contribution.invocations.flatMap(descriptor => [
      { subject: `${descriptor.id} result`, codec: descriptor.result },
      ...descriptor.parameters.map(parameter => ({
        subject: `${descriptor.id} ${parameter.name}`,
        codec: parameter.codec,
      })),
    ])
    expect(codecs.length).toBeGreaterThan(0)
    for (const { subject, codec } of codecs) {
      expect(typeof codec.schema?.parse, `${subject} must satisfy the 0.1.5 validator`).toBe('function')
      expect(typeof codec.create, `${subject} must satisfy the 0.1.6 validator`).toBe('function')
    }
    // The registered schema ENTRIES carry both members too (0.1.6 calls `schema.create()`).
    expect(contribution.schemas.length).toBeGreaterThan(0)
    for (const schema of contribution.schemas) {
      expect(typeof schema.schema?.parse, `${schema.name} must satisfy the 0.1.5 registry`).toBe('function')
      expect(typeof schema.create, `${schema.name} must satisfy the 0.1.6 registry`).toBe('function')
    }
  })

  it('keeps every declared schema projectable, so the real-face probe passes on a healthy host', () => {
    // The pre-load probe registers the REAL face and runs the HOST's `toJSONSchema` over the first
    // declared schema. A field written as `z.union([z.undefined(), X])` accepts the same payloads as
    // `X.optional()` but is invisible to that projector, so it made a healthy host read as
    // incompatible. This pins the whole face, not just the one key the probe happens to project.
    const contribution = hostContribution as unknown as { schemas: { name: string; schema: unknown }[] }
    for (const { name, schema } of contribution.schemas) {
      expect(() => z.toJSONSchema(schema as never), `${name} must be representable`).not.toThrow()
    }
  })
})

describe('the gate', () => {
  it('loads on a healthy host, in one line', () => {
    const { ctx, typert } = fakeContext()
    const { lines, log } = recorder()
    const run = provision(ctx, log, compat, HEALTHY_SPEC)
    expect(run.verdict.load).toBe(true)
    expect(run.verdict.status).toBe('ok')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`${COMPAT_PREFIX} ok`)
    // Both probes withdraw themselves: the registries are exactly as they were found.
    expect((typert as { contributions: unknown[] }).contributions).toEqual([])
  })

  it('withdraws its probe tool, leaving the tool surface as it found it', () => {
    const { ctx, tools } = fakeContext()
    provision(ctx, recorder().log, compat)
    expect(tools.registered).toEqual([])
    expect(tools.registered.map(tool => tool.name)).not.toContain('__dshCompatProbe')
  })

  it('REFUSES to load when the wire probe proves the host API moved', () => {
    const { ctx } = fakeContext({ typert: fakeTypert({ getMissing: true }) })
    const { lines, log } = recorder()
    const run = provision(ctx, log, compat)
    expect(run.verdict.load).toBe(false)
    expect(run.verdict.status).toBe('probe-failed')
    expect(run.verdict.reason).toContain('declared schemas are missing after registration')
    expect(lines.some(line => line.includes(`${COMPAT_PREFIX} INCOMPATIBLE`))).toBe(true)
  })

  it('LOADS with one warning when only the version number differs', () => {
    // A version difference is a risk signal, not proof: it must never take a working plugin out of a
    // deployment that merely upgraded. Only the version the build declares is overridden here.
    const { ctx } = fakeContext()
    const { lines, log } = recorder()
    const run = provision(ctx, log, compat, {
      ...HEALTHY_SPEC,
      runtime: { ...HEALTHY_SPEC.runtime, '@deepseek-ai/dsh-tools': '0.9.9' },
    })
    expect(run.verdict.load).toBe(true)
    expect(run.verdict.status).toBe('version-mismatch')
    expect(run.verdict.warnings).toHaveLength(1)
    expect(lines.filter(line => line.includes(`${COMPAT_PREFIX} WARNING`))).toHaveLength(1)
  })

  it('never throws, and never refuses, when the host cannot be probed at all', () => {
    // A registry whose members throw on ACCESS: the probe cannot run, which is "cannot tell" — not
    // "incompatible". The check itself must not become the crash it exists to prevent.
    const hostile = new Proxy({}, { get: () => { throw new Error('no such member') } })
    const { ctx } = fakeContext({ typert: hostile })
    const throwingLogger = { info: () => { throw new Error('logger exploded') }, warn: () => { throw new Error('logger exploded') }, error: () => { throw new Error('logger exploded') } }
    let run: ReturnType<typeof provision> | undefined
    expect(() => { run = provision(ctx, throwingLogger, compat) }).not.toThrow()
    expect(run?.verdict.load).toBe(true)
    expect(run?.verdict.status).toBe('probe-skipped')
  })
})

describe('the refusal megaphone', () => {
  it('leaves exactly one /mem command that prints the reason and the fix', async () => {
    const commands: unknown[] = []
    const { ctx } = fakeContext({ typert: fakeTypert({ getMissing: true }), commands })
    const { log } = recorder()
    const run = provision(ctx, log, compat)
    registerCompatMegaphone(ctx, run.verdict, log, compat)
    expect(commands).toHaveLength(1)
    const command = commands[0] as { name: string; handler: () => Promise<{ kind: string; text?: string }> }
    expect(command.name).toBe('mem')
    const outcome = await command.handler()
    expect(outcome.kind).toBe('error')
    const text = String(outcome.text)
    expect(text).toContain('兼容性检查未通过')
    expect(text).toContain('declared schemas are missing after registration')
    // The fix is written for an npm user, who has no repository to rebuild in.
    expect(text).toContain('换到本插件声明兼容的 dsh 版本')
    expect(text).not.toContain('pnpm build:dsh')
    expect(text).toContain(COMPAT_PREFIX)
  })

  it('still reports through the log when even the commands service is gone', () => {
    // No `commands` service at all: the megaphone cannot register, and that must not become a throw
    // on top of the refusal.
    const { ctx } = fakeContext({ typert: {} })
    const { log } = recorder()
    const run = provision(ctx, log, compat)
    expect(() => { registerCompatMegaphone(ctx, run.verdict, log, compat) }).not.toThrow()
  })
})

describe('verifyRegisteredFaces', () => {
  const toolNames = TOOL_SPECS.map(spec => spec.name)

  it('finds every real registration on the real contribution', () => {
    const { ctx } = fakeContext()
    // Register the real contribution by hand (the probe is not the real face).
    ;(ctx.get('typert') as { register: (value: unknown) => unknown }).register(hostContribution)
    for (const name of toolNames) (ctx.get('tools') as { register: (value: unknown) => unknown }).register({ name })
    const { lines, log } = recorder()
    const { missing } = verifyRegisteredFaces({ ctx, toolNames, log, compat })
    expect(missing).toEqual([])
    // Healthy means silent: the post-registration check must not add a line of its own.
    expect(lines).toEqual([])
  })

  it('warns by EXACT key when the real face is incomplete (a leaked probe cannot inflate this)', () => {
    const { ctx, typert } = fakeContext()
    // The real face landed only partially: one schema of twenty.
    ;(typert as { register: (value: unknown) => unknown }).register({
      package: '@avantf/dsh-mem',
      face: 'host',
      schemas: [{ name: 'rememberResult' }],
    })
    for (const name of toolNames) (ctx.get('tools') as { register: (value: unknown) => unknown }).register({ name })
    const { lines, log } = recorder()
    const { missing } = verifyRegisteredFaces({ ctx, toolNames, log, compat })
    // 20 declared schemas, 1 present: the missing list is the OTHER 19 — by exact key, so a leaked
    // probe (which would add a row) can neither hide nor inflate this.
    expect(missing).toHaveLength(19)
    expect(missing).toContain('@avantf/dsh-mem#recallResult')
    expect(missing).not.toContain('@avantf/dsh-mem#rememberResult')
    expect(lines.some(line => line.includes(`${COMPAT_PREFIX} WARNING`))).toBe(true)
  })
})
