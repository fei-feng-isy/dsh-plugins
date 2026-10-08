/**
 * The environment-initialisation seam, exercised WITHOUT a real host or a registry.
 *
 * Since the merge the base (`@avantf/dsh-plugin-base`) carries BOTH the environment framework AND
 * the compatibility gate, and this plugin loads it through the inlined bootstrap. There is no
 * `mission:compat` item, no npm download, no managed `~/.avantf/env/compat/**`, and — the point of the
 * shape below — the SAME loaded module is also the runtime source of the shared KIT, which is why
 * `loadCompat` hands it back on `runtime.kit`.
 *
 * `loadCompat` exposes two seams (`framework`, `compatModule`), and each test imports a FRESH copy of
 * the module — `loadCompat` caches its runtime once per process, so sharing one module instance
 * across tests would leak the first fake into every later one. Shapes that drift fail here instead
 * of on the one path where the `/mission` report is the user's only channel.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import * as realBase from '@avantf/dsh-plugin-base'

/** `mission/packages/plugin` — the source the shape assertions below read. */
const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every call the fakes recorded; one shape per fake so a test can assert on any of them. */
interface Calls {
  provision: any[]
  megaphone: any[]
  compatReport: any[]
  verify: any[]
  declared: { url: string; packages: readonly string[] }[]
  buildVersionsUrl?: string
  buildVersionsPackages?: readonly string[]
  runtimePackages?: readonly string[]
}

/** A fresh recorder, so one test's calls never bleed into another's assertions. */
function emptyCalls(): Calls {
  return { provision: [], megaphone: [], compatReport: [], verify: [], declared: [] }
}

/** A logger that records what the loader said, so the "never throws" path is observable. */
function recordingLogger() {
  const lines = { info: [] as string[], warn: [] as string[], error: [] as string[] }
  return {
    lines,
    log: {
      info: (message: string) => { lines.info.push(message) },
      warn: (message: string) => { lines.warn.push(message) },
      error: (message: string) => { lines.error.push(message) },
    },
  }
}

/** The kit half's prompt-file loader, present only to show it rides the SAME module. */
class FakePromptFiles {
  constructor(readonly options: unknown) {}
  load(specs: readonly unknown[]) { return specs }
}

/**
 * The base module as the plugin sees it: the gate half AND the kit half on ONE object.
 *
 * `kit` is not a separate seam on purpose — production takes both halves off the same dynamically
 * imported module, and a test that let them come from different objects would not notice if the
 * loader started mixing them up.
 */
function fakeBase(calls: Calls) {
  return {
    COMPAT_PREFIX: 'compat:',
    BUILD_VERSIONS_FILE: 'dsh-build.json',
    // ── the kit half ────────────────────────────────────────────────────────
    PromptFiles: FakePromptFiles,
    resolveDataHome: (input: { explicit?: string } = {}) => input.explicit ?? '/tmp/avantf-base-data',
    // ── the gate half ───────────────────────────────────────────────────────
    readDeclaredVersions: (url: string | URL, packages: readonly string[]) => {
      calls.declared.push({ url: String(url), packages })
      return { '@deepseek-ai/dsh-tools': '0.1.5-rc.2', '@deepseek-ai/dsh-typert-protocol': '0.1.5-rc.2' }
    },
    readBuildVersions: (url: string | URL, packages: readonly string[], fallback: Record<string, string | undefined>) => {
      calls.buildVersionsUrl = String(url)
      calls.buildVersionsPackages = packages
      return { ...fallback, '@deepseek-ai/dsh-tools': '9.9.9' }
    },
    readRuntimeVersions: (packages: readonly string[]) => {
      calls.runtimePackages = packages
      return { '@deepseek-ai/dsh-tools': '9.9.9', '@deepseek-ai/dsh-typert-protocol': '9.9.9' }
    },
    toolProbeDeclaration: () => () => ({ name: '__dshCompatProbe' }),
    schemaNamesFrom: () => ['snapshotargs', 'detailargs'],
  }
}

/** A stand-in for the gate half, with every call recorded. */
function fakeCompat(calls: Calls, verdict: unknown) {
  return {
    // The gate sits ON TOP of the full base surface: production hands over ONE module for both
    // halves, and `runtimeFrom` reads the version/schema helpers off the same object it provisions
    // with. A seam that supplied only `provision` would look fine and then fail to build a runtime.
    ...fakeBase(calls),
    provision: (ctx: any, log: any, spec: any) => { calls.provision.push({ ctx, log, spec }); return verdict },
    compatReport: (v: any, words: any) => { calls.compatReport.push({ v, words }); return 'REFUSAL REPORT' },
    registerMegaphone: (input: any) => { calls.megaphone.push(input) },
    verifyRegisteredFaces: (input: any) => { calls.verify.push(input); return { missing: ['missing-key'] } },
  }
}

/** A fresh module instance, so `loadCompat`'s once-per-process cache cannot leak between tests. */
async function freshEnvinit(): Promise<typeof import('../src/envinit.js')> {
  vi.resetModules()
  return await import('../src/envinit.js')
}

const OK_VERDICT = { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' }

describe('envinit loader', () => {
  it('loads the base, derives the spec from this build, and hands the same module back as the kit', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const base = fakeBase(calls)
    const gate = fakeCompat(calls, OK_VERDICT)

    const runtime = await env.loadCompat({
      log: recordingLogger().log,
      framework: base as never,
      compatModule: gate as never,
    })

    expect(runtime).toBeDefined()
    if (runtime === undefined) return
    expect(runtime.prefix).toBe('compat:')
    expect(runtime.schemaNames).toEqual(['snapshotargs', 'detailargs'])
    // The kit IS the loaded base module — the whole reason a shared-helper fix needs only a base release.
    expect(runtime.kit).toBe(base)

    // There is no `mission:compat` item any more: nothing declares, ensures or resolves one. The gate is
    // the loaded base itself, so a fake provisioner that was never built cannot be called.
    expect(calls.provision).toEqual([])

    // The declared side is the baked build record (read from beside the entry), falling back per
    // package to the peer range floor — never a hardcoded range.
    expect(calls.buildVersionsUrl).toContain('dsh-build.json')
    expect(calls.buildVersionsPackages).toContain('@deepseek-ai/dsh-tools')
    expect(calls.runtimePackages).toContain('@deepseek-ai/dsh-typert-protocol')
    // The manifest is this plugin's own, read as a file URL relative to the built entry.
    expect(calls.declared[0]?.url).toContain('package.json')
    expect(calls.declared[0]?.packages).toContain('@deepseek-ai/dsh-tools')
  })

  it('passes this plugin\'s own declaration into the gate, never a generic one', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const base = fakeBase(calls)
    const verdict = { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' }
    const gate = fakeCompat(calls, verdict)
    const runtime = await env.loadCompat({ framework: base as never, compatModule: gate as never })
    expect(runtime).toBeDefined()
    if (runtime === undefined) return

    const { log } = recordingLogger()
    const ctx = { get: () => undefined }
    expect(env.provision(ctx, log, runtime).load).toBe(true)
    expect(calls.provision).toHaveLength(1)
    const spec = calls.provision[0].spec
    expect(spec.packageId).toBe('@avantf/dsh-mission')
    // The required services are this plugin's real call surface, and the interval requirement is
    // declared because `host.ts` arms the sweep inside `start()`.
    expect(spec.services).toContainEqual({ name: 'tools', required: true, methods: ['register'] })
    expect(spec.services).toContainEqual({ name: 'subagents', required: true, methods: ['startContinuable', 'sendMessage', 'interrupt'] })
    expect(spec.events).toContain('agent/pre-step')
    expect(spec.needsInterval).toBe(true)
    // The probe IS the real host face, so a host whose codec contract moved is caught before mount.
    expect(typeof spec.probeTool).toBe('function')
    expect(typeof spec.probeTypert).toBe('function')
    expect(spec.schemaNames).toEqual(['snapshotargs', 'detailargs'])
  })

  it("reports a refusal through the megaphone with the base's own report text", async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const base = fakeBase(calls)
    const verdict = { load: false, skipped: false, status: 'probe-failed', problems: ['tools.register is gone'], warnings: ['w1'], notes: [], lines: [], reason: 'incompatible' }
    const gate = fakeCompat(calls, verdict)

    const runtime = await env.loadCompat({ framework: base as never, compatModule: gate as never })
    expect(runtime).toBeDefined()
    if (runtime === undefined) return

    const { log } = recordingLogger()
    const ctx = { get: () => undefined }
    const run = env.provision(ctx, log, runtime)
    expect(run.load).toBe(false)

    env.registerCompatMegaphone(ctx, run, log, runtime)
    expect(calls.compatReport).toHaveLength(1)
    // The report structure comes from the base; the wording is this plugin's.
    expect(calls.compatReport[0].words.heading).toContain('任务插件未加载')
    expect(calls.compatReport[0].words.warnings).toEqual(['w1'])
    // The fix is written for an npm user, who has no repository to rebuild in.
    expect(calls.compatReport[0].words.fix).toContain('换到本插件声明兼容的 dsh 版本')
    expect(calls.compatReport[0].words.fix).not.toContain('pnpm build:dsh')
    expect(calls.megaphone).toHaveLength(1)
    expect(calls.megaphone[0].command.name).toBe('mission')
    expect(calls.megaphone[0].text).toBe('REFUSAL REPORT')
    expect(calls.megaphone[0].ctx).toBe(ctx)
  })

  it('passes the real tool names into the post-registration check and returns its finding', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const base = fakeBase(calls)
    const gate = fakeCompat(calls, OK_VERDICT)
    const runtime = await env.loadCompat({ framework: base as never, compatModule: gate as never })
    expect(runtime).toBeDefined()
    if (runtime === undefined) return

    const { log } = recordingLogger()
    const missing = env.verifyRegisteredFaces({ ctx: { get: () => undefined }, toolNames: ['create_mission', 'list_missions'], log, compat: runtime })
    expect(missing.missing).toEqual(['missing-key'])
    expect(calls.verify[0].toolNames).toEqual(['create_mission', 'list_missions'])
    expect(calls.verify[0].packageId).toBe('@avantf/dsh-mission')
    expect(calls.verify[0].schemaNames).toEqual(['snapshotargs', 'detailargs'])
  })

  it('never throws when the loaded module misbehaves — it degrades and warns', async () => {
    const env = await freshEnvinit()
    const { log, lines } = recordingLogger()
    // A module whose gate surface is missing a member this build calls: reading it throws.
    const broken = { COMPAT_PREFIX: 'compat:', BUILD_VERSIONS_FILE: 'dsh-build.json' }
    const runtime = await env.loadCompat({ log, framework: broken as never })
    expect(runtime).toBeUndefined()
    expect(lines.warn.join('\n')).toContain('compatibility gate could not be initialised')
    expect(lines.warn.join('\n')).toContain('mount anyway')
    // VERBATIM: a base that cannot be READ as a gate is "absent", which is `cannot-tell`. Mission's
    // prefix is `compat:` where mem's is `envinit:`; the sentence itself is shared.
    expect(lines.warn).toContain(
      'compat: WARNING — interface: the loaded base has no interface gate (checkInterface / readInterfaceRequirement missing)'
      + ' — it predates the runtime interface contract, so which generation it implements cannot be told;'
      + ' using the loaded base anyway ("cannot tell" is never "incompatible")',
    )
  })

  it('degrades to undefined with its own WARNING when the base cannot be loaded at all', async () => {
    vi.resetModules()
    // Simulate the peer being absent: the inlined bootstrap's loader answers `undefined`.
    vi.doMock('../src/envinit-bootstrap.js', () => ({ loadFramework: () => Promise.resolve(undefined) }))
    try {
      const env = await import('../src/envinit.js')
      const { log, lines } = recordingLogger()
      const runtime = await env.loadCompat({ log })
      expect(runtime).toBeUndefined()
      expect(lines.warn.join('\n')).toContain('@avantf/dsh-plugin-base could not be made available')
      expect(lines.warn.join('\n')).toContain('mounts anyway')
    } finally {
      vi.doUnmock('../src/envinit-bootstrap.js')
    }
  })

  it('never throws when the refusal report itself cannot be registered', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const base = fakeBase(calls)
    const verdict = { load: false, skipped: false, status: 'probe-failed', problems: ['p'], warnings: [], notes: [], lines: [], reason: 'incompatible' }
    const gate = fakeCompat(calls, verdict)
    // The refusal path is where the report is the user's ONLY channel; a shape mismatch here must
    // not reject `apply` and take the fiber (and the report) down with it.
    gate.registerMegaphone = () => { throw new Error('no command face') }
    const runtime = await env.loadCompat({ framework: base as never, compatModule: gate as never })
    expect(runtime).toBeDefined()
    if (runtime === undefined) return

    const { log, lines } = recordingLogger()
    const ctx = { get: () => undefined }
    const run = env.provision(ctx, log, runtime)
    expect(run.load).toBe(false)

    expect(() => { env.registerCompatMegaphone(ctx, run, log, runtime) }).not.toThrow()
    expect(lines.warn.join('\n')).toContain('the refusal report could not be registered')
    expect(lines.warn.join('\n')).toContain('no command face')
  })

  it('retries after a failed load instead of caching "cannot tell" for the whole process', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const good = fakeBase(calls)
    let attempts = 0
    // Fails once — a shape mismatch, a half-written install — then behaves. A cached failure would
    // make the second call below return the first result forever, even after the tree is repaired.
    // No `compatModule` seam here: the framework module IS both halves, which is what production does.
    const flaky = {
      ...good,
      readDeclaredVersions: (url: string | URL, packages: readonly string[]) => {
        attempts += 1
        if (attempts === 1) throw new Error('half-written install')
        return good.readDeclaredVersions(url, packages)
      },
    }

    const first = recordingLogger()
    expect(await env.loadCompat({ log: first.log, framework: flaky as never })).toBeUndefined()
    expect(attempts).toBe(1)
    // This failure is INSIDE `loadCompatOnce`'s own try/catch (the gate could not be built), which is
    // the other degradation line — the outer guard's falls below.
    expect(first.lines.warn).toContain(
      'compat: WARNING — the @avantf/dsh-plugin-base compatibility gate could not be initialised'
      + ' (half-written install); the compatibility gate is SKIPPED and the plugin will mount anyway',
    )

    const runtime = await env.loadCompat({ log: recordingLogger().log, framework: flaky as never })
    expect(attempts).toBe(2)
    expect(runtime?.prefix).toBe('compat:')
    expect(runtime?.kit).toBe(flaky)
  })

  it('turns a throwing bootstrap into one WARNING and a degraded mount — never a rejection', async () => {
    // The OUTER guard, whose wording differs between the two trees: mem says `the framework is
    // SKIPPED`, mission says `the compatibility gate is SKIPPED`. A shared loader must receive that
    // sentence, not own it. Reached only when the throw escapes `loadCompatOnce` — here the module
    // loader itself, exactly like a missing, half-written install.
    vi.resetModules()
    vi.doMock('../src/envinit-bootstrap.js', () => ({ loadFramework: () => { throw new Error('offline') } }))
    try {
      const env = await import('../src/envinit.js')
      const { log, lines } = recordingLogger()
      expect(await env.loadCompat({ log })).toBeUndefined()
      expect(lines.warn).toContain(
        'compat: WARNING — environment initialisation failed (offline);'
        + ' the compatibility gate is SKIPPED and the plugin will mount anyway',
      )
    } finally {
      vi.doUnmock('../src/envinit-bootstrap.js')
    }
  })
})

/**
 * The gate seam has to be COMPILE-checked, not cast away.
 *
 * The kit half has always been typed through `EnvinitModule`; the gate half used to bypass the
 * compiler with `framework as unknown as CompatModule`, so every gate signature (`provision`,
 * `compatReport`, `registerMegaphone`, `schemaNamesFrom`, `verifyRegisteredFaces`, the
 * `read*Versions` family) could change and this file still built — and the gate is precisely the half
 * whose semantics are hardest to see in a diff. Only the TEST seam may be cast: it is a partial
 * module by construction. No type-level rule can pin "do not cast", so the source shape is the guard
 * (same device as the seat readers in `seat.spec.ts`). It is a guard against the STYLE coming back, not
 * against bypasses — `const m: unknown = framework` then `m as CompatModule` would still pass it; what
 * makes the gate half compile-checked is the annotated assignment itself having to satisfy the type.
 */
describe('the gate module is structurally checked', () => {
  it('never routes the real base module through `unknown`', () => {
    const source = readFileSync(join(pluginDir, 'src', 'envinit.ts'), 'utf8')
    // Deliberately NOT comment-stripped: the obvious way to do that (`replace(/\/\*[\s\S]*?\*\//gu)`)
    // is itself a trap — this file contains `env/compat/**` inside a `//` line, whose `/*` opens a
    // "block comment" that swallows everything up to the next `*/`, i.e. the assignment under test.
    // So the source comment above the assignment names the old cast without reproducing it verbatim,
    // and the guard below matches the two things that must stay true.
    expect(source).not.toMatch(/as\s+unknown\s+as\s+CompatModule/u)
    // …and the real load still lands in a `CompatModule`-annotated binding, which is what makes the
    // compiler compare mission's hand-written subset against what base actually exports.
    expect(source).toMatch(/:\s*CompatModule\s*=\s*options\.compatModule \?\? framework/u)
  })
})

/**
 * The runtime interface gate, consumed from the linked base and ACTED ON by this loader.
 *
 * The DECISION is the base's (`checkInterface` + its reader of the bake record); what this file pins
 * is the plugin's side: `incompatible` withholds the base (the same route as "the base is
 * unavailable", so the caller's prompt fallback and gate-skip apply) while the mount still happens,
 * and `cannot-tell` uses the base normally. The gate itself is driven from the REAL base, never a
 * mock, and the hostile-module case is the one that matters: a gate that throws while deciding would
 * reject a mount it is not allowed to reject.
 */
describe('the interface generation gate', () => {
  /** The real base gate, with a bake record naming one generation (or none at all). */
  function gated(calls: Calls, required: number | undefined) {
    return {
      ...fakeBase(calls),
      INTERFACE_VERSION: realBase.INTERFACE_VERSION,
      checkInterface: realBase.checkInterface,
      readInterfaceRequirement: () =>
        required === undefined ? undefined : { baseVersion: '0.3.0', interfaceVersion: required },
    }
  }

  it('is asymmetric, hostile-safe and total (the base gate itself)', () => {
    // Only the OLDER-base direction is unsafe: this build may need members that base never had.
    expect(realBase.checkInterface(2, { INTERFACE_VERSION: 1 }).status).toBe('incompatible')
    // The NEWER-base direction is the family's safe case (generations are additive): `ok` + a warning.
    const newer = realBase.checkInterface(1, { INTERFACE_VERSION: 2 })
    expect(newer.status).toBe('ok')
    expect(newer.warning).toContain('host base is newer')
    expect(realBase.checkInterface(1, {}).status).toBe('cannot-tell')
    const hostile = new Proxy({}, { get: () => { throw new Error('shape mismatch') } })
    expect(() => realBase.checkInterface(1, hostile)).not.toThrow()
    expect(realBase.checkInterface(1, hostile).status).toBe('cannot-tell')
  })

  it('degrades instead of refusing when the loaded base is from another generation', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const { log, lines } = recordingLogger()
    const frame = gated(calls, realBase.INTERFACE_VERSION + 1)

    const runtime = await env.loadCompat({ log, framework: frame as never })
    // The base is WITHHELD — `undefined` is the "base unavailable" route the caller already handles,
    // so its prompt layer falls back to this plugin's own default and the gate is skipped. The mount
    // itself still happens: tools/service/Remote/UI are registered unconditionally by the caller.
    expect(runtime).toBeUndefined()
    expect(lines.warn.join('\n')).toContain('shared capabilities are NOT used')
    // VERBATIM, reason and tail included. Mission's tail omits the `legacy provisioning` that mem's
    // names; that one difference is what any shared loader has to receive as a parameter.
    const expected = realBase.checkInterface(realBase.INTERFACE_VERSION + 1, frame as never)
    expect(expected.status).toBe('incompatible')
    expect(lines.warn).toContain(
      `compat: WARNING — interface: ${expected.reason ?? 'the loaded base implements another interface generation'};`
      + " the base's shared capabilities are NOT used (own prompt defaults, gate skipped) and the plugin mounts anyway",
    )
    // Nothing was ever run through the withheld base's gate.
    expect(calls.provision).toEqual([])
  })

  it('uses the base normally when the generation cannot be told', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const { log, lines } = recordingLogger()
    const frame = gated(calls, undefined)
    const gate = fakeCompat(calls, OK_VERDICT)

    const runtime = await env.loadCompat({ log, framework: frame as never, compatModule: gate as never })
    expect(runtime).toBeDefined()
    expect(runtime?.kit).toBe(frame)
    expect(lines.warn.join('\n')).toContain('no baked interface requirement')
    expect(lines.warn.join('\n')).toContain('using the loaded base anyway')
    // VERBATIM: byte-identical to mem's line except the caller's `compat:` prefix, which is exactly
    // why a shared loader must not own the prefix or the tail.
    expect(lines.warn).toContain(
      'compat: WARNING — interface: this build has no baked interface requirement (lib/interface-version.json is missing or malformed),'
      + ' so the runtime interface gate cannot run; using the loaded base anyway ("cannot tell" is never "incompatible")',
    )
  })
})
