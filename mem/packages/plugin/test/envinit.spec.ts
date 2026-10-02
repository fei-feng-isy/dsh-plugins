/**
 * The environment-initialisation seam, exercised WITHOUT a registry.
 *
 * `test/provision.spec.ts` covers the gate itself over the REAL base `@avantf/dsh-plugin-base`; it
 * never runs the wiring in `src/envinit.ts`. That leaves the interesting half reachable only through
 * the seams below: the loaded base exposed as `kit`, the resources the plugin declares (the pandoc
 * archive and the background model), the documented "cannot tell" paths (base unloadable at all, base
 * loaded but the gate not buildable), and the retry-after-failure rule.
 *
 * Each test imports a FRESH copy of the module — `loadEnvinit` caches its runtime once per process,
 * so sharing one module instance across tests would leak the first fake into every later one.
 */
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as base from '@avantf/dsh-plugin-base'

/**
 * Controls the ONE bootstrap seam the retry test needs.
 *
 * `loadEnvinit` no longer fails when the base is present but the gate is unusable (that is caught and
 * degraded), so the "a failed load must not be cached" rule has to be driven by the real loader: the
 * vendored bootstrap's `loadFramework` is made to reject once.
 */
const bootstrapControl = vi.hoisted(() => ({ failLoads: 0 }))
vi.mock('../src/envinit-bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/envinit-bootstrap.js')>()
  return {
    ...actual,
    loadFramework: async (options: Parameters<typeof actual.loadFramework>[0]) => {
      if (bootstrapControl.failLoads > 0) {
        bootstrapControl.failLoads -= 1
        throw new Error('offline')
      }
      return actual.loadFramework(options)
    },
  }
})

/** Every call the fakes recorded; one shape per fake so a test can assert on any of them. */
interface Calls {
  createOptions: any[]
  register: any[]
  declare: any[]
  ensure: any[]
  resolve: string[]
  dispose: number
  provision: any[]
  megaphone: any[]
  verify: any[]
}

function emptyCalls(): Calls {
  return { createOptions: [], register: [], declare: [], ensure: [], resolve: [], dispose: 0, provision: [], megaphone: [], verify: [] }
}

/** A logger that records what the loader said, so the "never throws" paths are observable. */
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

/**
 * The base surface `src/envinit.ts` uses, with every call recorded.
 *
 * The npm-package provider and its kind are deliberately absent: they moved to
 * `@avantf/dsh-plugin-base/internal` in interface generation v3, and `envinit.ts` never asks for
 * them (it registers the archive and model-cache providers only). A fake that offered them would be
 * testing a surface no plugin can reach through the loaded `.` entry.
 */
function fakeFramework(calls: Calls, resolveState: unknown, opts: { rejectBackgroundEnsure?: boolean } = {}) {
  const provisioner = {
    register: (provider: any) => { calls.register.push(provider); return { dispose: () => undefined } },
    declare: (manifest: any) => { calls.declare.push(manifest) },
    ensure: (options: any) => {
      calls.ensure.push(options)
      // Settle every selected item the way the core would, so `onSettled` is really exercised.
      for (const id of options.only ?? []) {
        options.onSettled?.({ plugin: 'mem', id, key: `k+${String(id)}`, action: 'present', source: 'managed', ms: 1 })
      }
      return Promise.resolve({ ok: true, entries: [] })
    },
    resolve: (id: string) => { calls.resolve.push(id); return resolveState },
    status: () => [],
    repair: () => Promise.resolve({ ok: true, entries: [] }),
    dispose: () => { calls.dispose += 1 },
    experimental: () => ({
      prune: () => Promise.resolve({ moved: [], skipped: [], movedBytes: 0 }),
      on: () => ({ dispose: () => undefined }),
    }),
  }
  // The resources provisioner can be made to REJECT on `ensure`: that path is fire-and-forget, so its
  // handler is what keeps an unhandled rejection from taking the host down — and in this test file an
  // unhandled rejection fails the run, which is the point.
  const rejecting = { ...provisioner, ensure: () => Promise.reject(new Error('background ensure exploded')) }
  return {
    VERSION: '0.0.0',
    ITEM_SCHEMA_VERSION: 1,
    BINARY_ARCHIVE_KIND: 'binary-archive',
    MODEL_CACHE_KIND: 'model-cache',
    createProvisioner: (options: any) => {
      calls.createOptions.push(options)
      return opts.rejectBackgroundEnsure === true && calls.createOptions.length > 0 ? rejecting : provisioner
    },
    binaryArchiveProvider: () => ({ id: '@avantf/dsh-plugin-base/binary-archive', kinds: ['binary-archive'] }),
    modelCacheProvider: () => ({ id: '@avantf/dsh-plugin-base/model-cache', kinds: ['model-cache'] }),
  }
}

/** The base surface `runtimeFromCompat` reads, with every call recorded. */
function fakeCompat(calls: Calls, verdict: unknown) {
  return {
    COMPAT_PREFIX: 'compat:',
    BUILD_VERSIONS_FILE: 'dsh-build.json',
    provision: (ctx: any, log: any, spec: any) => { calls.provision.push({ ctx, log, spec }); return verdict },
    compatReport: () => 'REFUSAL REPORT',
    registerMegaphone: (input: any) => { calls.megaphone.push(input) },
    schemaNamesFrom: () => ['snapshotargs', 'detailargs'],
    verifyRegisteredFaces: (input: any) => { calls.verify.push(input); return { missing: [] } },
    readDeclaredVersions: () => ({ '@deepseek-ai/dsh-tools': '0.1.5-rc.2' }),
    readBuildVersions: () => ({ '@deepseek-ai/dsh-tools': '0.1.5-rc.2' }),
    readRuntimeVersions: () => ({ '@deepseek-ai/dsh-tools': '0.1.5-rc.2' }),
    toolProbeDeclaration: () => () => ({ name: '__dshCompatProbe' }),
  }
}

/** A fresh module instance, so `loadEnvinit`'s once-per-process cache cannot leak between tests. */
async function freshEnvinit(): Promise<typeof import('../src/envinit.js')> {
  vi.resetModules()
  return await import('../src/envinit.js')
}

describe('envinit loader', () => {
  it('loads the base as the kit and derives the gate with no provisioning item', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    const framework = fakeFramework(calls, undefined)
    const module = fakeCompat(calls, { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' })

    const runtime = await env.loadEnvinit({
      log: recordingLogger().log,
      home,
      autoDownload: false,
      framework: framework as never,
      compatModule: module as never,
    })

    expect(runtime).toBeDefined()
    // The loaded base module IS the runtime source of the shared kit (prompt files, logger, family
    // paths, wire codec helpers): the plugin takes those off it at runtime, never from an inline copy.
    expect(runtime?.kit).toBe(framework)
    expect(runtime?.compat?.prefix).toBe('compat:')
    expect(runtime?.compat?.schemaNames).toEqual(['snapshotargs', 'detailargs'])
    // The engine's managed roots: the family root's `tools`/`models`, not the legacy defaults.
    expect(runtime?.roots).toEqual({ tools: join(home, 'tools'), models: join(home, 'models') })

    // The gate arrived WITH the base: loading it declares nothing, downloads nothing and resolves
    // nothing. The old `mem:compat` npm item and its managed `<home>/compat/**` copy are gone.
    expect(calls.createOptions).toEqual([])
    expect(calls.declare).toEqual([])
    expect(calls.ensure).toEqual([])
    expect(calls.resolve).toEqual([])
  })

  it('expands the $AVANTF_HOME default branch — `~/x` becomes an ABSOLUTE family root (M3)', async () => {
    // Every other test passes `home`, so this production branch (`options.home ?? resolveHome()`)
    // was never executed. `resolveHome` returned the raw env value, so `AVANTF_HOME=~/x` reached the
    // base's layout verbatim and the provisioner wrote into the RELATIVE path `<cwd>/~/x/…` (a
    // directory literally named `~`), while the engine expanded the same string and read
    // `/home/<user>/x/…`. Trim + `~` expansion is the family's one rule (`familyHome`/`expandHome`);
    // returning an absolute path here is what keeps the two halves on the same root.
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const framework = fakeFramework(calls, undefined)
    const module = fakeCompat(calls, { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' })
    const saved = process.env['AVANTF_HOME']
    process.env['AVANTF_HOME'] = '~/x'
    try {
      const runtime = await env.loadEnvinit({ autoDownload: false, framework: framework as never, compatModule: module as never })
      expect(runtime?.home).toBe(join(homedir(), 'x'))
      expect(runtime?.roots).toEqual({ tools: join(homedir(), 'x', 'tools'), models: join(homedir(), 'x', 'models') })
    } finally {
      if (saved === undefined) delete process.env['AVANTF_HOME']
      else process.env['AVANTF_HOME'] = saved
    }
  })

  it('declares pandoc and the flat model as background items', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    const framework = fakeFramework(calls, undefined)
    const module = fakeCompat(calls, { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' })
    const runtime = await env.loadEnvinit({ home, autoDownload: false, framework: framework as never, compatModule: module as never })
    expect(runtime).toBeDefined()
    if (runtime === undefined) return

    const settled: unknown[] = []
    runtime.provisionResources({
      pandoc: true,
      archiveMirrors: ['https://mirror.example/{url}'],
      modelAutoDownload: true,
      model: { repo: 'Xenova/bge-small-zh-v1.5', files: ['config.json', 'onnx/model.onnx'], endpoint: 'https://hf-mirror.com' },
    }, (entry) => { settled.push(entry) })

    // A second instance, with the engine's archive mirror list and its own provider set: the archive
    // provider for pandoc, the model-cache provider for the embedding model. With the env kill switch
    // OFF (`autoDownload: false` here) policy is a plain `false` — every kind is gated at once; the
    // per-kind map is asserted by the `semantic.auto_download: false` test below.
    // A single provisioner, with the archive provider for pandoc and the model-cache provider for
    // the embedding model. With the env kill switch OFF (`autoDownload: false` here) policy is a
    // plain `false` — every kind is gated at once; the per-kind map is asserted below.
    expect(calls.createOptions).toHaveLength(1)
    expect(calls.createOptions[0].home).toBe(home)
    expect(calls.createOptions[0].policy.mirrors.archive).toEqual(['https://mirror.example/{url}'])
    expect(calls.createOptions[0].policy.autoDownload).toBe(false)
    expect(calls.register.map((provider) => provider.id)).toEqual([
      '@avantf/dsh-plugin-base/binary-archive',
      '@avantf/dsh-plugin-base/model-cache',
    ])

    expect(calls.declare).toHaveLength(1)
    const items = calls.declare[0].items
    expect(items.map((item: { id: string }) => item.id)).toEqual(['mem:pandoc', 'mem:model'])
    for (const item of items) {
      expect(item.startup).toBe('background')
      expect(item.schemaVersion).toBe(1)
    }
    const [pandoc, model] = items
    expect(pandoc.kind).toBe('binary-archive')
    expect(pandoc.target).toEqual({ root: 'tools' })
    expect(pandoc.spec.id).toBe('pandoc')
    expect(pandoc.spec.version).toBe('3.11')
    // The measured digest and the archive format, re-spelled in the framework's vocabulary.
    expect(pandoc.spec.packs['linux-x64']).toMatchObject({
      sha256: '37edb3bbcf722f921a009941bf5874e2e0c09263226c9b4a2d980788cb062ab6',
      archive: 'tar.gz',
    })

    // The model is a FLAT model-cache: files land where the runtime reads them, the list is explicit,
    // and the source is the operator's endpoint. Missing it degrades, it never refuses the mount.
    expect(model.kind).toBe('model-cache')
    expect(model.target).toEqual({ root: 'models' })
    expect(model.onMissing).toEqual({ atStartup: 'degrade', atUse: 'degrade' })
    expect(model.spec).toMatchObject({
      repo: 'Xenova/bge-small-zh-v1.5',
      revision: 'main',
      layout: 'flat',
      endpoint: 'https://hf-mirror.com',
      files: ['config.json', 'onnx/model.onnx'],
    })

    // Dispatched, not awaited: the caller's hook got both items' lines.
    expect(settled.map((entry) => (entry as { id: string }).id)).toEqual(['mem:pandoc', 'mem:model'])
    // `dispose()` releases the provisioner (leases included).
    runtime.dispose()
    expect(calls.dispose).toBe(1)
  })

  it('keeps mounting when the base is loaded but the gate cannot be initialised', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    // A module good enough to declare resources, but without the gate's exports: the base is
    // "present" yet unusable for the compatibility check. That is "cannot tell", never a refusal.
    const framework = fakeFramework(calls, undefined)
    const { log, lines } = recordingLogger()

    const runtime = await env.loadEnvinit({ log, home, autoDownload: false, framework: framework as never })
    // The base loaded, so the runtime exists and resources can still be declared…
    expect(runtime).toBeDefined()
    // …but the gate is absent, with a warning that names the reason.
    expect(runtime?.kit).toBe(framework)
    expect(runtime?.compat).toBeUndefined()
    expect(lines.warn.join('\n')).toContain('compatibility gate could not be initialised')
  })

  it('never throws when the base module is hostile — it degrades and warns', async () => {
    const env = await freshEnvinit()
    const { log, lines } = recordingLogger()
    // Every member access throws: the module cannot even be read as a gate, and it cannot report an
    // interface generation either. The mount must continue, and the interface gate must read that as
    // "cannot tell" rather than joining the failure. (Vitest runs before any `lib/` exists, so the
    // baked side is absent too — what matters is that the gate emitted a line instead of throwing,
    // which is what the two assertions below would catch if the check were unguarded.)
    const hostile = new Proxy({}, { get: () => { throw new Error('shape mismatch') } })
    const runtime = await env.loadEnvinit({ log, home: '/tmp/avantf-mem-envinit-hostile', framework: hostile as never })
    expect(runtime).toBeDefined()
    expect(runtime?.compat).toBeUndefined()
    expect(lines.warn.join('\n')).toContain('compatibility gate could not be initialised')
    expect(lines.warn.join('\n')).toContain('shape mismatch')
    expect(lines.warn.join('\n')).toContain('interface:')
  })

  it('withholds the base (never refuses the mount) when the interface generation differs', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    const { log, lines } = recordingLogger()
    // The REAL base gate, with a bake record that names a generation the loaded base does not
    // implement — exactly the runtime condition the interface axis exists for.
    const framework = {
      ...fakeFramework(calls, undefined),
      INTERFACE_VERSION: base.INTERFACE_VERSION,
      checkInterface: base.checkInterface,
      readInterfaceRequirement: () => ({ baseVersion: '0.3.0', interfaceVersion: base.INTERFACE_VERSION + 1 }),
    }
    const runtime = await env.loadEnvinit({ log, home, autoDownload: false, framework: framework as never })
    // DEGRADED, not refused: `undefined` is the SAME route the caller already handles for "the base is
    // unavailable", so the prompt layer uses this plugin's own defaults, the compatibility gate is
    // skipped and provisioning takes the legacy path. Tools/service/Remote/UI are the caller's and
    // still mount (the mount smoke proves that end to end).
    expect(runtime).toBeUndefined()
    expect(lines.warn.join('\n')).toContain('interface:')
    expect(lines.warn.join('\n')).toContain('shared capabilities are NOT used')
    // Nothing was registered or declared through the withheld base.
    expect(calls.provision).toHaveLength(0)
    expect(calls.declare).toHaveLength(0)
  })

  it('withholds a v1 base too — the v2 well-formed helpers are optional, so the mirror takes over', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    const { log, lines } = recordingLogger()
    // The OTHER direction of the interface axis, and the one this task's degradation path rides on:
    // the loaded base reports generation 1 (it predates `wellFormedText`/`wellFormedDeep`), while the
    // build was baked against the current generation. `checkInterface` says incompatible, so
    // `loadEnvinit` returns `undefined` — exactly the route "the base is unavailable" takes — and the
    // plugin's consumption point (`adoptWellFormed(env?.kit)` in `index.ts`) sees no kit, leaving the
    // mem mirror in force. The mount itself is never refused (the mount smoke proves that end to end).
    const framework = {
      ...fakeFramework(calls, undefined),
      INTERFACE_VERSION: 1,
      checkInterface: base.checkInterface,
      readInterfaceRequirement: () => ({ baseVersion: '0.2.0', interfaceVersion: base.INTERFACE_VERSION }),
    }
    const runtime = await env.loadEnvinit({ log, home, autoDownload: false, framework: framework as never })
    expect(runtime).toBeUndefined()
    expect(lines.warn.join('\n')).toContain('interface:')
    expect(lines.warn.join('\n')).toContain('shared capabilities are NOT used')
    expect(calls.provision).toHaveLength(0)
    expect(calls.declare).toHaveLength(0)
  })

  it('uses the base normally when the interface generation cannot be told', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    const { log, lines } = recordingLogger()
    const module = fakeCompat(calls, { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' })
    // The gate is present but there is no bake record: "cannot tell", which is never "incompatible".
    const framework = {
      ...fakeFramework(calls, undefined),
      INTERFACE_VERSION: base.INTERFACE_VERSION,
      checkInterface: base.checkInterface,
      readInterfaceRequirement: () => undefined,
    }
    const runtime = await env.loadEnvinit({ log, home, autoDownload: false, framework: framework as never, compatModule: module as never })
    expect(runtime).toBeDefined()
    expect(runtime?.kit).toBe(framework)
    expect(runtime?.compat).toBeDefined()
    expect(lines.warn.join('\n')).toContain('no baked interface requirement')
    expect(lines.warn.join('\n')).toContain('using the loaded base anyway')
  })

  it('retries after a failed load instead of caching "cannot tell" for the whole process', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    const framework = fakeFramework(calls, undefined)
    const module = fakeCompat(calls, { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' })
    const options = { log: recordingLogger().log, home, autoDownload: false, framework: framework as never, compatModule: module as never }

    // Fails once — an offline boot, a registry hiccup — then behaves. A cached rejection would make
    // the second call below return the first failure forever, even once the base is reachable.
    bootstrapControl.failLoads = 1
    expect(await env.loadEnvinit({ ...options, framework: undefined })).toBeUndefined()
    expect(bootstrapControl.failLoads).toBe(0)

    const runtime = await env.loadEnvinit(options)
    expect(runtime?.compat?.prefix).toBe('compat:')
  })

  it('keeps mounting when the BACKGROUND ensure rejects (a detached rejection must not take the host down)', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    const framework = fakeFramework(calls, undefined, { rejectBackgroundEnsure: true })
    const module = fakeCompat(calls, { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' })
    const { log, lines } = recordingLogger()
    const runtime = await env.loadEnvinit({ log, home, autoDownload: false, framework: framework as never, compatModule: module as never })
    expect(runtime).toBeDefined()
    if (runtime === undefined) return

    // The caller continues its own initialisation: this call returns immediately and the rejection
    // arrives later. An unhandled rejection fails this whole file, so reaching the assertions below
    // IS the "the handler is attached" half of the test.
    runtime.provisionResources({ pandoc: true, archiveMirrors: [], modelAutoDownload: true, model: undefined }, () => {})
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(lines.warn.join('\n')).toContain('declaring the background resources failed')
    expect(lines.warn.join('\n')).toContain('background ensure exploded')

    // Still disposable, and it releases both provisioners.
    runtime.dispose()
    expect(calls.dispose).toBe(1)
  })

  it('turns model downloads off PER KIND when semantic.auto_download is false', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    const framework = fakeFramework(calls, undefined)
    const module = fakeCompat(calls, { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' })
    // The env kill switches are ON (autoDownload true): the model's refusal must come from the
    // resolved config alone, which is the M4 case (`semantic.auto_download: false` with no env var).
    const runtime = await env.loadEnvinit({ home, autoDownload: true, framework: framework as never, compatModule: module as never })
    expect(runtime).toBeDefined()
    if (runtime === undefined) return

    const settled: unknown[] = []
    runtime.provisionResources({
      pandoc: true,
      archiveMirrors: [],
      modelAutoDownload: false,
      model: { repo: 'Xenova/bge-small-zh-v1.5', files: ['config.json', 'onnx/model.onnx'], endpoint: 'https://hf-mirror.com' },
    }, (entry) => { settled.push(entry) })

    // The item is STILL declared — the framework's `skipped (policy/download-disabled)` line is the
    // diagnosis — but the model kind may not touch the network, while pandoc keeps its own gate.
    expect(calls.createOptions[0].policy.autoDownload).toEqual({ 'model-cache': false })
    expect(calls.declare[0].items.map((item: { id: string }) => item.id)).toEqual(['mem:pandoc', 'mem:model'])
    expect(settled.map((entry) => (entry as { id: string }).id)).toEqual(['mem:pandoc', 'mem:model'])
    runtime.dispose()
  })

  it('omits spec.files (instead of failing on a fixed list) for a non-default repo', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    const framework = fakeFramework(calls, undefined)
    const module = fakeCompat(calls, { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' })
    const runtime = await env.loadEnvinit({ home, autoDownload: false, framework: framework as never, compatModule: module as never })
    if (runtime === undefined) throw new Error('runtime')

    runtime.provisionResources({
      pandoc: false,
      archiveMirrors: [],
      modelAutoDownload: true,
      // An empty list means "this build does not know the repo's file set": the framework then uses
      // the repository's own `siblings` list.
      model: { repo: 'Fake/bge-no-vocab', files: [], endpoint: 'https://hf-mirror.com' },
    }, () => {})

    const model = calls.declare[0].items.find((item: { id: string }) => item.id === 'mem:model')
    expect(model.spec.repo).toBe('Fake/bge-no-vocab')
    expect(model.spec.layout).toBe('flat')
    expect('files' in model.spec).toBe(false)
    runtime.dispose()
  })

  it('declares the model item\'s per-request budget, and never an inverted ensure deadline', async () => {
    const env = await freshEnvinit()
    const calls = emptyCalls()
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-envinit-'))
    const framework = fakeFramework(calls, undefined)
    const module = fakeCompat(calls, { load: true, skipped: false, status: 'ok', problems: [], warnings: [], notes: [], lines: [], reason: '' })
    const runtime = await env.loadEnvinit({ home, autoDownload: false, framework: framework as never, compatModule: module as never })
    if (runtime === undefined) throw new Error('runtime')

    runtime.provisionResources({
      pandoc: true,
      archiveMirrors: [],
      modelAutoDownload: true,
      model: { repo: 'Xenova/bge-small-zh-v1.5', files: ['config.json'], endpoint: 'https://hf-mirror.com' },
    }, () => {})

    const model = calls.declare[0].items.find((item: { id: string }) => item.id === 'mem:model')
    // The budget is the base's own default made EXPLICIT (300 s), not inherited silently: the review
    // found the `timeoutMs` mechanism implemented but unused by every item.
    expect(model.policy).toEqual({ timeoutMs: 300_000 })
    // The ensure deadline must not sit BELOW a declared per-request budget — the base's inversion
    // check. The 15 s default would, so it is raised to cover the longest declared item.
    const policy = calls.createOptions[0].policy
    expect(policy.deadlineMs).toBeGreaterThanOrEqual(model.policy.timeoutMs)
    // Pandoc declares no budget of its own: it keeps the base's default untouched.
    const pandoc = calls.declare[0].items.find((item: { id: string }) => item.id === 'mem:pandoc')
    expect(pandoc.policy).toBeUndefined()
    runtime.dispose()
  })

  it('scopes the model item to repos whose files the runtime really reads (managedModelSpec)', async () => {
    const env = await freshEnvinit()
    const root = join(tmpdir(), 'avantf-mem-envinit-models')
    const semantic = { backend: 'local_bge', local_model: 'Xenova/bge-small-zh-v1.5', cache_dir: root, mirror: 'https://hf-mirror.com' }

    // The default repo gets the measured narrow list: exactly what transformers.js requests.
    const managed = env.managedModelSpec(semantic, root)
    expect(managed).toEqual({
      repo: 'Xenova/bge-small-zh-v1.5',
      files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'],
      endpoint: 'https://hf-mirror.com',
    })

    // A user-changed repo has a different file set → no fixed list (the item tolerates it).
    expect(env.managedModelSpec({ ...semantic, local_model: 'Fake/bge-no-vocab' }, root)?.files).toEqual([])

    // `AVANTF_MEM_MODEL_CACHE` (resolved into `cache_dir`) is NOT the framework root: declaring the
    // item would install a second, never-read copy there.
    expect(env.managedModelSpec({ ...semantic, cache_dir: join(root, 'elsewhere') }, root)).toBeUndefined()

    // No local model to provision.
    expect(env.managedModelSpec({ ...semantic, backend: 'none' }, root)).toBeUndefined()
  })
})
