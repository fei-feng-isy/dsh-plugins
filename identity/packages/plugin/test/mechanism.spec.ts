/**
 * The mechanism, ported from the offline spike the spec records (§9.1) — same stand-in sections, same
 * assertions, but now driving the REAL plugin (`src/index.ts`) through a real Cordis Context.
 *
 * What it proves:
 *   P1 the identity slot is a named section at order -1000, and a duplicate global registration of
 *      `harness:identity` THROWS (so root-level shadowing is impossible);
 *   P2 filtering by name removes exactly the named sections, leaves every other section
 *      byte-identical, and leaves `tools`/`contexts` untouched;
 *   P3 disabled / empty files ⇒ byte-identical to native;
 *   P4 a delegated child is byte-identical to native, including its own scoped persona;
 *   P5 the global waterfall listener is admitted for a SCOPED assembly.
 *
 * It does NOT prove (needs the real host): the real 20-package section set, the real
 * `agent.session.header` values, or anything about tool schemas in a real session. The mount smoke
 * (`scripts/mount-smoke.mjs`) and the acceptance run cover those.
 */
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { PERSONA_PREFIX_SECTION, type AssembleContext, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, DEFAULT_DROP, inject, name, OWN_SECTION } from '../src/index.js'

const NATIVE_PERSONA = 'You are a coding agent powered by the {{model}} model.'
const SUFFIX = 'Your working directory is {{cwd}}.'
const IDENTITY_TEXT = '你是「小助手」。\n\n语气温和。\n\n禁止编造。'
const PROFILE = 'default'

/** Stand-ins for "the other packages" (names/orders mirror the real `SECTION_ORDERS`). */
const OTHERS: readonly (readonly [string, number, string])[] = [
  ['plan:policy', 500, 'Plan-mode policy prose.'],
  ['team:policy', 600, 'Agent Teams policy prose.'],
  ['tool:bash', 1000, 'bash tool guidance'],
  ['tool:fs', 1100, 'read tool guidance'],
  ['tool:jobs', 1600, 'jobs tool guidance'],
  ['tool:web', 2000, 'web tool guidance'],
  ['tool:workflow', 2600, 'workflow tool guidance'],
  ['tool:subagent', 2800, 'subagent tool guidance'],
  ['mcp:servers', 3100, 'mcp guidance'],
  ['tools:sdk', 5000, 'tools sdk guidance'],
  ['harness:source', 10000, 'The DeepSeek Harness implementation checkout is at /x.'],
  ['app:web-surface', 10100, 'web surface prose'],
]

function otherPackages(): { name: string; inject: string[]; apply(ctx: Context): void } {
  return {
    name: 'other-packages',
    inject: ['systemPrompt'],
    apply(ctx: Context): void {
      for (const [sectionName, order, text] of OTHERS) {
        ctx.effect(() => ctx.systemPrompt.section({ name: sectionName, order, text }), `other:${sectionName}`)
      }
      ctx.effect(() => ctx.systemPrompt.tools(() => ({
        schemas: [{ name: 'bash', description: 'run a command', parameters: { type: 'object' } }],
      })), 'other:tools')
      ctx.effect(() => ctx.systemPrompt.context({ name: 'sandbox-policy', order: 110, text: 'sandbox: danger-full-access' }), 'other:context')
    },
  }
}

function childPersona(): { name: string; inject: string[]; apply(ctx: Context): void } {
  return {
    name: 'child-persona',
    inject: ['systemPrompt'],
    apply(ctx: Context): void {
      ctx.effect(() => ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, text: 'You are the reviewer.' }), 'child:persona')
    },
  }
}

/**
 * Scope keys are opaque identities (`ScopeKey = object` in `dsh-scope`), matched by reference — so a
 * fresh object per scope is the typed spelling of what the spike passed as a string.
 */
const NATIVE_CHILD_SCOPE = {}
const CHILD_SCOPE = {}
const MAIN_SCOPE = {}

const MAIN: AssembleContext = { agent: { session: { header: { cwd: '/w', isSeeded: true } } } } as AssembleContext
const CHILD: AssembleContext = { agent: { session: { header: { cwd: '/w', origin: 'subagent', delegationDepth: 1, parentSession: 's0' } } } } as AssembleContext

/** The names, then the full `{name,text}` + tools/contexts shape — the byte diff the spec asks for. */
const names = (assembly: PromptAssembly): string[] => assembly.sections.map((section) => section.name)
const shapes = (assembly: PromptAssembly): string =>
  JSON.stringify(assembly.sections.map((section) => [section.name, section.text]))
  + '|tools:' + JSON.stringify(assembly.tools)
  + '|ctx:' + JSON.stringify(assembly.contexts)

async function boot(enabled: boolean | undefined): Promise<Context> {
  const app = new Context()
  await app.plugin(SystemPrompt, { personaPrefix: NATIVE_PERSONA, personaSuffix: SUFFIX })
  await app.plugin(otherPackages())
  if (enabled !== undefined) {
    const plugin = { name, inject, apply } as unknown as Parameters<Context['plugin']>[0]
    await app.plugin(plugin, {
      enabled,
      interpolate: false,
      replaceScope: 'session',
      drop: [...DEFAULT_DROP],
      maxBytes: 65536,
      profile: PROFILE,
    })
  }
  return app
}

let root: string
let profileDir: string
let appNative: Context
let appOff: Context
let appOn: Context
let native: PromptAssembly
let off: PromptAssembly
let on: PromptAssembly

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'avantf-identity-mechanism-'))
  // The family data root: the plugin's files are read from `<root>/identity/profiles/<profile>/`.
  process.env['AVANTF_HOME'] = root
  profileDir = join(root, 'identity', 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'IDENTITY.md'), '你是「小助手」。\n', 'utf8')
  writeFileSync(join(profileDir, 'SOUL.md'), '语气温和。\n', 'utf8')
  writeFileSync(join(profileDir, 'RULES.md'), '禁止编造。\n', 'utf8')

  appNative = await boot(undefined)
  appOff = await boot(false)
  appOn = await boot(true)
  native = await appNative.systemPrompt.assemble(MAIN)
  off = await appOff.systemPrompt.assemble(MAIN)
  on = await appOn.systemPrompt.assemble(MAIN)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('P1 the identity slot is a named section', () => {
  it('resolves HARNESS_IDENTITY to order -1000', () => {
    expect(appNative.systemPrompt.getSectionOrder('HARNESS_IDENTITY')).toBe(-1000)
  })

  it('native assembly starts with the harness identity and the deployment persona', () => {
    expect(native.sections[0]?.name).toBe('harness:identity')
    expect(native.sections.find((section) => section.name === PERSONA_PREFIX_SECTION)?.text).toBe(NATIVE_PERSONA)
  })

  it('a duplicate global registration of harness:identity THROWS', () => {
    expect(() => {
      appNative.systemPrompt.section({ name: 'harness:identity', order: -1000, text: 'x' })
    }).toThrow(/already registered/u)
  })
})

describe('P3 mounted but disabled is a no-op', () => {
  it('is byte-identical to native', () => {
    expect(shapes(off)).toBe(shapes(native))
  })

  it('keeps the harness identity section', () => {
    expect(names(off)).toEqual(names(native))
  })
})

describe('P2 enabled replaces exactly the named sections', () => {
  it('drops harness:identity and deployment:persona-prefix', () => {
    expect(names(on)).not.toContain('harness:identity')
    expect(names(on)).not.toContain(PERSONA_PREFIX_SECTION)
  })

  it('puts the identity section FIRST, carrying the file text', () => {
    expect(on.sections[0]?.name).toBe(OWN_SECTION)
    expect(on.sections[0]?.text).toBe(IDENTITY_TEXT)
  })

  it('leaves every other section byte-identical (name+text)', () => {
    const survivorsNative = native.sections.filter((section) => !DEFAULT_DROP.includes(section.name))
    const survivorsOn = on.sections.filter((section) => section.name !== OWN_SECTION)
    expect(survivorsOn).toEqual(survivorsNative)
    expect(survivorsOn).toHaveLength(OTHERS.length + 1)
  })

  it('leaves the section count at native - 2 dropped + 1 added', () => {
    expect(on.sections).toHaveLength(native.sections.length - 1)
  })

  it('leaves tools and contexts untouched', () => {
    expect(on.tools).toEqual(native.tools)
    expect(on.contexts).toEqual(native.contexts)
  })
})

describe('P4 a delegated child is untouched', () => {
  it('is byte-identical to the native child assembly', async () => {
    const child = await appOn.systemPrompt.assemble(CHILD)
    const nativeChild = await appNative.systemPrompt.assemble(CHILD)
    expect(shapes(child)).toBe(shapes(nativeChild))
  })

  it('keeps harness:identity and never sees the identity section', async () => {
    const child = await appOn.systemPrompt.assemble(CHILD)
    expect(names(child)).toContain('harness:identity')
    expect(names(child)).not.toContain(OWN_SECTION)
  })

  it('keeps its own scoped persona, byte-identical to the native scoped child', async () => {
    const childScope = createScope(appOn, CHILD_SCOPE)
    await childScope.ctx.plugin(childPersona() as unknown as Parameters<Context['plugin']>[0])
    const withPersona = await appOn.systemPrompt.assemble({ ...CHILD, scope: CHILD_SCOPE })

    const nativeScope = createScope(appNative, NATIVE_CHILD_SCOPE)
    await nativeScope.ctx.plugin(childPersona() as unknown as Parameters<Context['plugin']>[0])
    const nativeWithPersona = await appNative.systemPrompt.assemble({ ...CHILD, scope: NATIVE_CHILD_SCOPE })

    expect(withPersona.sections.find((section) => section.name === PERSONA_PREFIX_SECTION)?.text).toBe('You are the reviewer.')
    expect(shapes(withPersona)).toBe(shapes(nativeWithPersona))
  })

  it('runs for a SCOPED main-agent assembly too (P5)', async () => {
    // The direct functional proof that the GLOBAL listener is admitted for a scoped assembly: if it
    // were not, the scoped assembly would still carry `harness:identity`.
    createScope(appOn, MAIN_SCOPE)
    const scoped = await appOn.systemPrompt.assemble({ ...MAIN, scope: MAIN_SCOPE })
    expect(names(scoped)).not.toContain('harness:identity')
    expect(names(scoped)).not.toContain(PERSONA_PREFIX_SECTION)
    expect(names(scoped)).toContain(OWN_SECTION)
  })
})

describe('the scope guard', () => {
  it('treats a header with origin subagent as a child', async () => {
    const child = await appOn.systemPrompt.assemble(CHILD)
    expect(names(child)).toContain('harness:identity')
  })

  it('treats a non-zero delegationDepth as a child', async () => {
    const deep = await appOn.systemPrompt.assemble({
      agent: { session: { header: { delegationDepth: 2 } } },
    } as AssembleContext)
    expect(names(deep)).toContain('harness:identity')
    expect(names(deep)).not.toContain(OWN_SECTION)
  })

  it('treats an unknown header shape as the main agent (cannot tell is never "child")', async () => {
    const unknown = await appOn.systemPrompt.assemble({ agent: { session: {} } } as AssembleContext)
    expect(names(unknown)).not.toContain('harness:identity')
    expect(names(unknown)).toContain(OWN_SECTION)
  })
})

describe('P6 the identity is frozen for the life of a session', () => {
  /** A fresh session object per call: object identity IS the session key the plugin freezes against. */
  const session = (): AssembleContext =>
    ({ agent: { session: { header: { cwd: '/w', isSeeded: true } } } }) as unknown as AssembleContext
  const ownText = (assembly: PromptAssembly): string =>
    assembly.sections.find((section) => section.name === OWN_SECTION)?.text ?? ''
  const NEXT_IDENTITY = '换了一版身份。\n'

  it('keeps what the session started with, and lets the NEXT session read the new files', async () => {
    const running = session()
    const started = await appOn.systemPrompt.assemble(running)
    expect(ownText(started)).toBe(IDENTITY_TEXT)

    writeFileSync(join(profileDir, 'IDENTITY.md'), NEXT_IDENTITY, 'utf8')
    try {
      // The same session: the prompt does not move under the reader (and its prefix stays cached).
      expect(ownText(await appOn.systemPrompt.assemble(running))).toBe(IDENTITY_TEXT)
      // A new session reads the files again.
      expect(ownText(await appOn.systemPrompt.assemble(session()))).toContain(NEXT_IDENTITY.trim())
    } finally {
      writeFileSync(join(profileDir, 'IDENTITY.md'), '你是「小助手」。\n', 'utf8')
    }
  })

  it('freezes the OFF state too, so a mid-session switch flip cannot bring the native identity back', async () => {
    // `appOff` is the same plugin with `enabled: false`: its session is frozen to the empty text, which
    // is exactly the "off is byte-identical to native" case — and it stays that way for that session.
    const running = session()
    const started = await appOff.systemPrompt.assemble(running)
    expect(names(started)).toContain('harness:identity')
    expect(ownText(started)).toBe('')
    expect(shapes(await appOff.systemPrompt.assemble(running))).toBe(shapes(started))
  })
})

describe('the harness identity section name is pinned', () => {
  // The literal is upstream's (`PromptSectionOrderName.HARNESS_IDENTITY` is a NUMBER, not a name): if
  // upstream renames the section, this assertion is the first thing to go red, and the fallback is
  // harmless anyway — a name that is not in the assembly removes nothing.
  it('is the literal the drop list and the order lookup agree on', () => {
    expect(DEFAULT_DROP).toContain('harness:identity')
    expect(DEFAULT_DROP).toContain(PERSONA_PREFIX_SECTION)
    expect(DEFAULT_DROP).toEqual(['harness:identity', PERSONA_PREFIX_SECTION])
  })
})
