/**
 * The gate's wiring: reading a live context, the post-registration check, and the megaphone.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
// Type-only: this is what declares `ctx.interval` on Context.
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import {
  COMPAT_PREFIX,
  compatReport,
  gatherEvidence,
  provision,
  registerMegaphone,
  toolProbeDeclaration,
  verifyRegisteredFaces,
  type CompatContext,
  type CompatLogger,
  type CompatSpec,
  type CompatVerdict,
} from '../src/index.js'
// The individual compat probes are composition pieces of `gatherEvidence`; generation v3 moved them
// off `.` to `./internal` (INTERFACE.md §9).
import { checkInterval, checkServices } from '../src/internal.js'

const PACKAGE = '@avantf/dsh-plugin-base'

/** A logger that keeps its lines. */
function recorder(): { lines: string[]; log: CompatLogger } {
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

/** A spec that only declares what a synthetic context provides. */
function spec(overrides: Partial<CompatSpec> = {}): CompatSpec {
  return {
    packageId: PACKAGE,
    services: [{ name: 'tools', required: true, methods: ['register', 'get'] }],
    declared: {},
    // A spec that wants the tools probe supplies the declaration builder; the helper is the caller's.
    probeTool: toolProbeDeclaration(defineTool),
    events: [],
    ...overrides,
  }
}

describe('reading a live context', () => {
  it('reports a present service, an absent one, and a renamed method', () => {
    const ctx = new Context()
    ctx.provide('tools', { register: () => () => undefined, get: () => undefined })
    ctx.provide('agents', {})
    const services = checkServices(ctx, [
      { name: 'tools', required: true, methods: ['register', 'get'] },
      { name: 'agents', required: true, methods: ['get'] },
      { name: 'spillStore', required: false, methods: ['saveText'] },
    ])
    expect(services[0]).toEqual({ name: 'tools', required: true, present: true, missing: [] })
    expect(services[1]).toEqual({ name: 'agents', required: true, present: true, missing: ['get'] })
    expect(services[2]).toEqual({ name: 'spillStore', required: false, present: false, missing: ['saveText'] })
  })

  it('reads the timer off the context', () => {
    const bare = new Context()
    expect(checkInterval(bare)).toBe(false)
    const mixed = new Context()
    mixed.mixin('timer', ['interval'])
    mixed.provide('timer', { interval: () => () => undefined })
    expect(checkInterval(mixed)).toBe(true)
  })

  it('gathers the evidence a spec describes, and logs one ok line through provision', () => {
    const ctx = new Context()
    // A tools stub that satisfies the probe: the registration must be visible via `get` and the
    // disposal must really unregister, which is what the real registry does.
    const registered: { name: string }[] = []
    ctx.provide('tools', {
      register: (definition: { name: string }) => {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
      get: (name: string) => registered.find((definition) => definition.name === name),
    })
    ctx.mixin('timer', ['interval'])
    ctx.provide('timer', { interval: () => () => undefined })
    const evidence = gatherEvidence(ctx, spec({ needsInterval: true }))
    expect(evidence.services).toHaveLength(1)
    expect(evidence.interval).toBe(true)
    expect(evidence.needsInterval).toBe(true)
    // Both probes ran here: the tools stub answers, and no typert registry is mounted at all.
    expect(evidence.toolsProbe).toEqual({ ran: true, passed: true, problems: [] })
    expect(registered, 'the probe must be withdrawn').toEqual([])
    expect(evidence.typertProbe).toBeUndefined()

    const { lines, log } = recorder()
    const verdict = provision(ctx, log, spec({ needsInterval: true }))
    expect(verdict.load).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`${COMPAT_PREFIX} ok`)
  })

  it('loads anyway when the check itself explodes, and says so', () => {
    const exploding = { get: () => { throw new Error('context is on fire') } }
    const { lines, log } = recorder()
    const verdict = provision(exploding, log, spec())
    expect(verdict.load).toBe(true)
    expect(verdict.status).toBe('probe-skipped')
    expect(lines.join('\n')).toContain('the compatibility check itself failed')
  })

  it('never throws when the LOGGER itself explodes — the module header promises "Never throws"', () => {
    // Two independent call sites reach the caller's logger: the verdict loop (one line per verdict,
    // and a healthy verdict always has at least the `ok` line) and the catch branch that reports a
    // check which could not run. A logger that throws is not evidence of anything, and the gate it
    // exists to keep non-fatal must not become the crash — so neither call site may propagate.
    const throwing = {
      info: () => { throw new Error('logger exploded') },
      warn: () => { throw new Error('logger exploded') },
      error: () => { throw new Error('logger exploded') },
    } satisfies CompatLogger
    const ctx = new Context()
    // A tools stub the probe can actually pass: register recorded, `get` answering. A stub that
    // always answers `undefined` would make the probe fail and the verdict `load: false`, which is
    // the wrong subject for this test.
    const registered: { name: string }[] = []
    ctx.provide('tools', {
      register: (definition: { name: string }) => {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
      get: (name: string) => registered.find((definition) => definition.name === name),
    })
    let healthy: CompatVerdict | undefined
    expect(() => { healthy = provision(ctx, throwing, spec()) }).not.toThrow()
    expect(healthy?.load).toBe(true)
    expect(healthy?.status).toBe('ok')
    // The catch branch logs the "the check itself failed" line through the same hostile logger.
    const exploding = { get: () => { throw new Error('context is on fire') } }
    let degraded: CompatVerdict | undefined
    expect(() => { degraded = provision(exploding, throwing, spec()) }).not.toThrow()
    expect(degraded?.load).toBe(true)
    expect(degraded?.status).toBe('probe-skipped')
  })
})

describe('the post-registration check', () => {
  it("finds every real wire schema on the host's real Typert registry", async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(TypertRegistry)
    const typert = ctx.get('typert') as { register: (contribution: unknown) => unknown }
    typert.register({
      package: PACKAGE,
      face: 'host',
      schemas: [{ name: 'one', schema: {}, create: () => ({}) }, { name: 'two', schema: {}, create: () => ({}) }],
      model: { services: [], events: [], objects: [] },
      invocations: [],
    })

    const { log } = recorder()
    expect(verifyRegisteredFaces({ ctx, packageId: PACKAGE, schemaNames: ['one', 'two'], toolNames: [], log }).missing)
      .toEqual([])
    await fiber.dispose()
  })

  it('reports exactly the registrations that did not land, and stays warn-only', () => {
    const ctx = new Context()
    ctx.provide('typert', { list: () => [{ key: `${PACKAGE}#one` }] })
    ctx.provide('tools', { get: (name: string) => (name === 'create_job' ? { name } : undefined) })

    const { lines, log } = recorder()
    const { missing } = verifyRegisteredFaces({
      ctx,
      packageId: PACKAGE,
      schemaNames: ['one', 'two'],
      toolNames: ['create_job', 'adjust_job'],
      log,
    })
    expect(missing).not.toContain(`${PACKAGE}#one`)
    expect(missing).not.toContain('create_job')
    expect(missing).toContain(`${PACKAGE}#two`)
    expect(missing).toContain('adjust_job')
    expect(lines.join('\n')).toContain('real registrations are not visible afterwards')
  })

  it('says nothing when everything landed', () => {
    const ctx = new Context()
    const { lines, log } = recorder()
    verifyRegisteredFaces({ ctx, packageId: PACKAGE, toolNames: [], log })
    expect(lines).toEqual([])
  })

  it('calls the service METHOD, so a `this`-dependent `get` really runs (the 0.5.1 defect)', () => {
    // The defect this pins, measured on dsh 0.2.0-rc.2: a live Cordis service hands out PROXIED
    // methods, and `@deepseek-ai/dsh-tools`' `get` body is `this.view(scope).visible.get(name)`. An
    // extracted call (`const g = tools.get; g(name, scope)`) runs with `this === undefined`, throws
    // `Cannot read properties of undefined (reading 'view')`, and the wide catch turned that into
    // `missing` — every scoped name reported as not-visible on a registry that was answering fine.
    //
    // The double therefore refuses to answer unless it is called as a method (`this` bound to the
    // service, exactly as cordis' shadow-method proxy does). A plain arrow-function double cannot
    // catch this class of bug at all: it ignores `this` and looks healthy either way.
    const service = {
      calls: 0,
      get(this: { calls: number }, name: string, scope?: unknown): unknown {
        this.calls += 1
        return scope === 'agent-1' ? { name } : undefined
      },
    }
    const ctx = { get: (name: string) => (name === 'tools' ? service : undefined) }
    const { lines, log } = recorder()

    const { missing } = verifyRegisteredFaces({
      ctx: ctx as unknown as CompatContext,
      packageId: PACKAGE,
      toolNames: ['create_job', 'adjust_job'],
      log,
      scope: 'agent-1',
    })
    expect(service.calls).toBe(2)
    expect(missing).toEqual([])
    expect(lines).toEqual([])
  })

  it('falls back to the GLOBAL tools view when `scope` is omitted — the v3 reading, exactly', () => {
    // The scoped `get` below answers ONLY for the scope it was handed. With no `scope` in the input,
    // `verifyRegisteredFaces` must call `tools.get(name)` — the one-argument, global reading every
    // generation through v3 performed — and therefore see the scoped tool as missing. This is the
    // regression half of the v4 widening (INTERFACE.md §10): an old caller passes no `scope` and must
    // not silently change verdict.
    const calls: unknown[][] = []
    const scopedOnly = { token: 'agent-7' }
    const ctx = { get: (name: string) => (name === 'tools'
      ? {
          get: (...args: unknown[]) => {
            calls.push(args)
            return args[1] === scopedOnly ? { name: 'create_job' } : undefined
          },
        }
      : undefined) }
    const { log } = recorder()
    const omitted = verifyRegisteredFaces({ ctx: ctx as unknown as CompatContext, packageId: PACKAGE, toolNames: ['create_job'], log })
    expect(omitted.missing).toEqual(['create_job'])
    // `input.scope` is `undefined` here, so the second argument reaching `get` is `undefined` — exactly
    // what a one-parameter v3-registry observed before (it ignores it, and `args.length` is not part of
    // any registry contract). What matters is the VALUE: no scope was named, so the global view applies.
    expect(calls).toEqual([['create_job', undefined]])
  })

  it('judges through the CALLER\'s scope when one is given (interface generation v4)', () => {
    // The widening this generation exists for: a registry whose `get` is scope-addressed answers only
    // for the scope it is asked about, so the same names that are reported as missing without a scope
    // are all found once the caller names the scope it registered them in. Base does NOT interpret the
    // value — every lookup sees the very object the caller passed, which the identity assertion pins.
    const scopedOnly = { token: 'agent-7' }
    const seen: unknown[] = []
    const tools = {
      get: (toolName: string, scope?: unknown) => {
        seen.push(scope)
        return scope === scopedOnly ? { name: toolName } : undefined
      },
    }
    const ctx = { get: (name: string) => (name === 'tools' ? tools : undefined) }
    const { log } = recorder()

    // Without the scope: the same registry reports both names missing (the false-missing shape v4 fixes).
    const global = verifyRegisteredFaces({ ctx: ctx as unknown as CompatContext, packageId: PACKAGE, toolNames: ['create_job', 'adjust_job'], log })
    expect(global.missing).toEqual(['create_job', 'adjust_job'])

    // With it: both are visible, and `get` saw the exact object every time.
    seen.length = 0
    const scoped = verifyRegisteredFaces({
      ctx: ctx as unknown as CompatContext,
      packageId: PACKAGE,
      toolNames: ['create_job', 'adjust_job'],
      log,
      scope: scopedOnly,
    })
    expect(scoped.missing).toEqual([])
    expect(seen).toEqual([scopedOnly, scopedOnly])
  })

  it('accepts any opaque scope value, and forwards it unchanged', () => {
    // Base has no DSH dependency and therefore no scope TYPE: the field is `unknown` and forwarded
    // as-is. An OBJECT scope (what a dsh `ScopeKey` is — an opaque, identity-compared object, never a
    // string), an arbitrary object, and `undefined` must all be legal inputs, and an omitted scope must
    // reach `get` exactly the way `undefined` does — the real registry cannot tell "no scope named"
    // from "the undefined scope" (`scopeChainOf(undefined)` is the empty chain either way), and the
    // widening must not invent a distinction.
    //
    // The samples are object-shaped ON PURPOSE: base cannot enforce "an object" from here, so a consumer
    // passing anything else compiles, gets forwarded, resolves no scope and reads the GLOBAL view —
    // reporting every scoped registration as missing. A test demonstrating the field with a string would
    // teach precisely that mistake, so none of the values below is one.
    const calls: unknown[][] = []
    const ctx = { get: (name: string) => (name === 'tools'
      ? { get: (...args: unknown[]) => { calls.push(args); return undefined } }
      : undefined) }
    const { log } = recorder()
    const scopeOfAgent = { opaque: 'agent-7' }
    verifyRegisteredFaces({ ctx: ctx as unknown as CompatContext, packageId: PACKAGE, toolNames: ['a'], log, scope: scopeOfAgent })
    verifyRegisteredFaces({ ctx: ctx as unknown as CompatContext, packageId: PACKAGE, toolNames: ['a'], log, scope: { nested: true } })
    verifyRegisteredFaces({ ctx: ctx as unknown as CompatContext, packageId: PACKAGE, toolNames: ['a'], log, scope: undefined })
    verifyRegisteredFaces({ ctx: ctx as unknown as CompatContext, packageId: PACKAGE, toolNames: ['a'], log })
    expect(calls).toEqual([['a', scopeOfAgent], ['a', { nested: true }], ['a', undefined], ['a', undefined]])
  })
})

describe('the megaphone', () => {
  it('registers one command whose handler reports the refusal', async () => {
    const ctx = new Context()
    const registered: unknown[] = []
    ctx.provide('commands', {
      register: (definition: unknown) => {
        registered.push(definition)
        return () => undefined
      },
    })
    const { lines, log } = recorder()
    registerMegaphone({
      ctx,
      log,
      command: { name: 'job', description: 'why not' },
      text: 'not loaded',
    })
    expect(registered).toHaveLength(1)
    const command = registered[0] as { name: string; handler: () => Promise<{ kind: string; text?: string }> }
    expect(command.name).toBe('job')
    expect(await command.handler()).toEqual({ kind: 'error', text: 'not loaded' })
    expect(lines.join('\n')).toContain('registered a /job command')
  })

  it('does not throw when even the commands service is gone', () => {
    const { log } = recorder()
    expect(() => registerMegaphone({
      ctx: new Context(),
      log,
      command: { name: 'job', description: 'why not' },
      text: 'not loaded',
    })).not.toThrow()
  })

  it('builds the standard report: heading, problems, warnings, fix, log hint', () => {
    const verdict: CompatVerdict = {
      load: false,
      skipped: false,
      status: 'probe-failed',
      problems: ['service "agents" is mounted but exposes no get'],
      warnings: ['this build was compiled against X, but its links now resolve to Y'],
      notes: [],
      lines: [],
      reason: 'service "agents" is mounted but exposes no get',
    }
    const text = compatReport(verdict, {
      heading: '插件未加载',
      warningsLabel: '风险提示：',
      warnings: verdict.warnings,
      fix: '重建：pnpm build',
      logPointer: (prefix) => `完整诊断见宿主日志里 ${prefix} 开头的行。`,
    })
    expect(text).toContain('插件未加载')
    expect(text).toContain('- service "agents" is mounted but exposes no get')
    expect(text).toContain('风险提示：')
    expect(text).toContain('重建：pnpm build')
    expect(text.endsWith(`完整诊断见宿主日志里 ${COMPAT_PREFIX} 开头的行。`)).toBe(true)
  })

  it('omits the log tail when the caller does not supply its own wording', () => {
    // The tail is a SENTENCE, so it belongs to the caller like every other line. Base is published: a
    // plugin compiled against an older base passes no `logPointer`, and the honest output for it is the
    // report WITHOUT a tail — not a sentence in a language that plugin never chose.
    const verdict: CompatVerdict = {
      load: false,
      skipped: false,
      status: 'probe-failed',
      problems: ['p'],
      warnings: [],
      notes: [],
      lines: [],
      reason: 'p',
    }
    const text = compatReport(verdict, { heading: 'Not loaded', warningsLabel: 'Warnings:', warnings: [], fix: 'Rebuild.' })
    expect(text).toBe('Not loaded\n\n- p\n\nRebuild.')
    expect(text).not.toContain(COMPAT_PREFIX)
    expect(text).not.toContain('宿主日志')
  })
})
