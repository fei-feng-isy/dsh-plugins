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
  checkInterval,
  checkServices,
  compatReport,
  gatherEvidence,
  provision,
  registerMegaphone,
  toolProbeDeclaration,
  verifyRegisteredFaces,
  type CompatLogger,
  type CompatSpec,
  type CompatVerdict,
} from '../src/index.js'

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
