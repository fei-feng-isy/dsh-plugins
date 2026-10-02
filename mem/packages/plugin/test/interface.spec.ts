/**
 * The base's interface, driven ACROSS the tree boundary.
 *
 * `mem/packages/plugin/test/family_pin.spec.ts` pins the path resolvers from an actually linked base;
 * this spec is the same device for the rest of the v1 surface, and it exists because the semantic half
 * of an interface cannot be checked by a type. Every case below takes the REAL implementation off the
 * linked `@avantf/dsh-plugin-base` and compares it with what a consumer is entitled to expect —
 * never a mock, because a mock only proves that the mock is self-consistent (INTERFACE.md §4).
 *
 * What is pinned here:
 *
 *  - the linked module is structurally the base's declared interface (`BaseRuntimeV1`), and the
 *    version it reports is the one this artifact was baked against;
 *  - path resolution: this plugin's layer order and the engine's agree, with the shared
 *    `AVANTF_HOME`/configured precedence;
 *  - `PromptFiles`: a missing file is created with the caller's fallback, an edited file wins
 *    byte-for-byte, and a blank one is refilled — against a real directory;
 *  - `compatReport`: the STRUCTURE is the base's and the WORDS are the caller's;
 *  - the provisioner: a declared item reaches a terminal state with a stable `code`, and the report
 *    entry carries the fields the plugin reads.
 *
 * The peer-dependent specs (`provision.spec.ts` / `envinit.spec.ts`) are excluded from the default
 * `vitest run`; this one is not, because it imports only the base — no `@deepseek-ai/*`.
 *
 * @module test/interface
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import * as base from '@avantf/dsh-plugin-base'
import type { BaseRuntimeV1 } from '@avantf/dsh-plugin-base'
import { resolveDataHome as coreResolveDataHome } from '@avantf/mem'
import { baseIsUsable, interfaceVerdict } from '../src/interface_gate.js'

/** The module AS the interface declares it: a missing or reshaped member fails to compile here. */
const runtime: BaseRuntimeV1 = base

/** The record `scripts/link-envinit.mjs` bakes beside the built entry. */
const BAKED_URL = new URL('../lib/interface-version.json', import.meta.url)

/** Run `body` with `$AVANTF_HOME` set (or removed), restoring what was there. */
function withEnv(value: string | undefined, body: () => void): void {
  const previous = process.env['AVANTF_HOME']
  if (value === undefined) delete process.env['AVANTF_HOME']
  else process.env['AVANTF_HOME'] = value
  try {
    body()
  } finally {
    if (previous === undefined) delete process.env['AVANTF_HOME']
    else process.env['AVANTF_HOME'] = previous
  }
}

describe('the linked base satisfies the declared interface', () => {
  it('exports INTERFACE_VERSION as a positive integer', () => {
    expect(Number.isInteger(runtime.INTERFACE_VERSION)).toBe(true)
    expect(runtime.INTERFACE_VERSION).toBeGreaterThan(0)
  })

  it('was baked against exactly that generation', () => {
    // The RUNTIME half of the gate: the artifact records the generation it was built for, and the one
    // it links must report the same number. A missing record is a failure here (the build always
    // bakes), while at startup the same absence is only a warning.
    const baked = JSON.parse(readFileSync(BAKED_URL, 'utf8')) as { baseVersion?: unknown; interfaceVersion?: unknown }
    expect(typeof baked.baseVersion).toBe('string')
    expect(baked.interfaceVersion).toBe(runtime.INTERFACE_VERSION)
  })
})

describe('path resolution is the same answer on both sides of the tree', () => {
  it('agrees with the mem engine for every layer combination', () => {
    const cases: { readonly configured: string; readonly env: string | undefined; readonly explicit?: string }[] = [
      { configured: '', env: undefined },
      { configured: '', env: '/tmp/from-env' },
      { configured: '/tmp/from-config', env: undefined },
      { configured: '/tmp/from-config', env: '/tmp/from-env' },
      { configured: '~/from-config', env: undefined },
      { configured: '~', env: undefined },
      { configured: '/tmp/from-config', env: '/tmp/from-env', explicit: '/tmp/from-caller' },
    ]
    for (const { configured, env, explicit } of cases) {
      withEnv(env, () => {
        const fromBase = runtime.resolveDataHome({ explicit, env: { AVANTF_HOME: env }, configured })
        const fromEngine = coreResolveDataHome({ common: { dataHome: configured }, explicit })
        expect(fromEngine, `configured=${configured} env=${String(env)} explicit=${String(explicit)}`).toBe(fromBase)
      })
    }
  })

  it('keeps the documented layer order, with ⑤ over ④ over ② over the default', () => {
    withEnv('/tmp/from-env', () => {
      expect(runtime.resolveDataHome({ env: { AVANTF_HOME: '/tmp/from-env' }, configured: '/tmp/from-config' }))
        .toBe('/tmp/from-env')
      expect(runtime.resolveDataHome({ explicit: '/tmp/caller', env: { AVANTF_HOME: '/tmp/from-env' }, configured: '/tmp/from-config' }))
        .toBe('/tmp/caller')
    })
    withEnv(undefined, () => {
      expect(runtime.resolveDataHome({ configured: '/tmp/from-config' })).toBe('/tmp/from-config')
      expect(runtime.resolveDataHome({})).toBe(join(homedir(), '.avantf'))
    })
  })
})

describe('PromptFiles behaves as the caller expects, against a real directory', () => {
  it('creates a missing file with the caller\'s fallback and reads an edited one verbatim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-mem-interface-'))
    try {
      const specs = [{ file: 'mem-probe.md', fallback: '内置默认正文\n' }]
      const created = new runtime.PromptFiles({ dir }).load(specs)
      expect(created).toHaveLength(1)
      expect(created[0]?.file).toBe('mem-probe.md')
      expect(created[0]?.path).toBe(join(dir, 'mem-probe.md'))
      expect(created[0]?.source).toBe('default')
      expect(created[0]?.wrote).toBe(true)
      expect(created[0]?.text).toBe('内置默认正文')
      // The file really exists and holds the fallback (outer whitespace trimmed by the loader).
      expect(readFileSync(join(dir, 'mem-probe.md'), 'utf8').trim()).toBe('内置默认正文')

      // What the user wrote wins, byte for byte.
      const mine = '用户写的第一行\n第二行'
      writeFileSync(join(dir, 'mem-probe.md'), `${mine}\n`, 'utf8')
      const loaded = new runtime.PromptFiles({ dir }).load(specs)
      expect(loaded[0]?.source).toBe('file')
      expect(loaded[0]?.wrote).toBe(false)
      expect(loaded[0]?.text).toBe(mine)
      expect(readFileSync(join(dir, 'mem-probe.md'), 'utf8')).toBe(`${mine}\n`)

      // Blank is an unfinished edit, not an edit: the fallback is written back in.
      writeFileSync(join(dir, 'mem-probe.md'), '   \n', 'utf8')
      const refilled = new runtime.PromptFiles({ dir }).load(specs)
      expect(refilled[0]?.source).toBe('default')
      expect(refilled[0]?.wrote).toBe(true)
      expect(refilled[0]?.text).toBe('内置默认正文')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never throws on an unusable directory — it warns and uses the fallback', () => {
    // A file sitting where the prompt directory belongs is the everyday failure. The contract is
    // absolute: a prompt-layer failure degrades to the caller's default, it never fails a mount.
    const dir = mkdtempSync(join(tmpdir(), 'avantf-mem-interface-'))
    const file = join(dir, 'not-a-directory')
    const warnings: string[] = []
    try {
      writeFileSync(file, 'x', 'utf8')
      const loaded = new runtime.PromptFiles({ dir: file, logger: { info: () => {}, warn: (message) => { warnings.push(message) } } })
        .load([{ file: 'mem-probe.md', fallback: '默认' }])
      expect(loaded[0]?.text).toBe('默认')
      expect(loaded[0]?.source).toBe('default')
      expect(loaded[0]?.wrote).toBe(false)
      expect(warnings.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('compatReport keeps the structure and takes the caller\'s words', () => {
  it('renders the caller\'s sentences and never invents one of its own', () => {
    const verdict = {
      load: false,
      skipped: false,
      status: 'probe-failed' as const,
      problems: ['tools.register is gone'],
      warnings: ['a version moved'],
      notes: ['events cannot be proven'],
      lines: [],
      reason: 'incompatible',
    }
    const report = runtime.compatReport(verdict, {
      heading: '记忆插件未加载：兼容性检查未通过。',
      warningsLabel: '风险提示：',
      warnings: verdict.warnings,
      fix: '修复：升级 dsh 或重建插件。',
      logPointer: (prefix) => `完整诊断见 ${prefix} 开头的日志行。`,
    })
    for (const sentence of ['记忆插件未加载：兼容性检查未通过。', 'a version moved', '修复：升级 dsh 或重建插件。']) {
      expect(report).toContain(sentence)
    }
    // The tail line is the CALLER's wording, built from the prefix the base passes in.
    expect(report).toContain('完整诊断见 compat: 开头的日志行。')
    // The base's own token is passed to the caller's callback — that is the one string the base owns.
    expect(runtime.COMPAT_PREFIX).toBe('compat:')
  })
})

describe('the provisioner reaches a terminal state the caller can branch on', () => {
  it('reports a stable action and code for an item the policy disables', async () => {
    const home = mkdtempSync(join(tmpdir(), 'avantf-mem-interface-home-'))
    try {
      const provisioner = runtime.createProvisioner({
        home,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        policy: { autoDownload: false },
      })
      provisioner.register(runtime.npmPackageProvider())
      provisioner.declare({
        plugin: 'interface-probe',
        items: [{
          id: 'interface-probe:x',
          kind: runtime.NPM_PACKAGE_KIND,
          spec: { name: 'left-pad', range: '^1.0.0' },
          target: { root: 'tools' },
          onMissing: { atStartup: 'degrade', atUse: 'error' },
          schemaVersion: runtime.ITEM_SCHEMA_VERSION,
        }],
      })
      const report = await provisioner.ensure({ only: ['interface-probe:x'] })
      const entry = report.entries.find((candidate) => candidate.id === 'interface-probe:x')
      // The caller zips this back onto its own declaration, so the identity fields are the contract.
      expect(entry?.plugin).toBe('interface-probe')
      expect(entry?.action).toBe('skipped')
      expect(entry?.code).toBe('policy/download-disabled')
      expect(typeof entry?.ms).toBe('number')
      // `resolve()` answers the same terminal state the report carried.
      expect(provisioner.resolve('interface-probe:x').state).toBe('skipped')
      provisioner.dispose()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

/**
 * The runtime interface gate: the base's decision, this plugin's consumption.
 *
 * The gate is a member of the v1 surface now (`checkInterface` + `readInterfaceRequirement`), so its
 * semantics are pinned HERE, across the tree, from the REAL implementation — they are ASYMMETRIC: a
 * build meeting an OLDER base is `incompatible`, one meeting a NEWER base is `ok` + a warning
 * (generations are additive, so nothing it requires is missing), a hostile module reads as "reports
 * none", and the plugin's consumer maps the verdict to the loader's decision (withhold the base on
 * `incompatible` only). The loader-level consequences
 * themselves — prompt fallback, gate skipped, provisioning legacy, still mounted with a WARNING — are
 * asserted in `envinit.spec.ts`, because that file is the one allowed to import the peer-dependent
 * `src/envinit.ts` (this spec must stay loadable without `@deepseek-ai/*`).
 */
describe('the runtime interface gate is the base\'s, and this plugin consumes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'avantf-mem-interface-gate-'))
  let sequence = 0
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  /** Write a bake record (or a malformed one) and return its URL. */
  function bake(record: unknown): URL {
    sequence += 1
    const url = pathToFileURL(join(dir, `bake-${String(sequence)}.json`))
    writeFileSync(url, typeof record === 'string' ? record : JSON.stringify(record))
    return url
  }

  it('carries the gate on the linked module', () => {
    expect(typeof runtime.checkInterface).toBe('function')
    expect(typeof runtime.readInterfaceRequirement).toBe('function')
    expect(runtime.checkInterface(runtime.INTERFACE_VERSION, base).status).toBe('ok')
  })

  it('is asymmetric: older base `incompatible`, newer base `ok` + warning, unreadable side `cannot-tell`', () => {
    // `loaded < required` is the ONE unsafe direction: this build may ask for members the base never had.
    expect(runtime.checkInterface(2, { INTERFACE_VERSION: 1 }).status).toBe('incompatible')
    // `loaded > required` is the family's safe case (generations are additive): usable, with a WARNING.
    const newer = runtime.checkInterface(1, { INTERFACE_VERSION: 2 })
    expect(newer.status).toBe('ok')
    expect(newer.warning).toContain('host base is newer')
    expect(newer.reason).toBeUndefined()
    // Equal generations are plain `ok`: no warning, no reason.
    const equal = runtime.checkInterface(2, { INTERFACE_VERSION: 2 })
    expect(equal.status).toBe('ok')
    expect(equal.warning).toBeUndefined()
    expect(equal.reason).toBeUndefined()
    // A side that cannot be read stays `cannot-tell`, never `incompatible`.
    expect(runtime.checkInterface(1, {}).status).toBe('cannot-tell')
    expect(runtime.checkInterface(1, { INTERFACE_VERSION: 'v1' }).status).toBe('cannot-tell')
    expect(runtime.checkInterface(0, { INTERFACE_VERSION: 1 }).status).toBe('cannot-tell')
  })

  it('reads a hostile module as "reports none" and never throws', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('shape mismatch') } })
    expect(() => runtime.checkInterface(1, hostile)).not.toThrow()
    expect(runtime.checkInterface(1, hostile).status).toBe('cannot-tell')
  })

  it('consumes the base gate: ok / older base incompatible / newer base ok + warning / cannot-tell', () => {
    const generation = runtime.INTERFACE_VERSION
    const current = bake({ baseVersion: '0.3.0', interfaceVersion: generation })
    const equal = interfaceVerdict(base, current)
    expect(equal.status).toBe('ok')
    expect(equal.warning).toBeUndefined()

    // The build requires a NEWER generation than the base it loaded: members it asks for may be gone.
    const newer = bake({ baseVersion: '0.3.0', interfaceVersion: generation + 1 })
    expect(interfaceVerdict(base, newer).status).toBe('incompatible')
    // …and the other direction is the SAFE one: the build is old, the loaded base is new, generations
    // are additive, so the base stays usable — `ok` plus a warning, never a degradation.
    const ahead = interfaceVerdict({ ...base, INTERFACE_VERSION: generation + 1 }, current)
    expect(ahead.status).toBe('ok')
    expect(ahead.warning).toContain('host base is newer')
    // Both sides agree again, so the generations are equal and there is nothing to warn about.
    const agreed = interfaceVerdict({ ...base, INTERFACE_VERSION: generation + 1 }, newer)
    expect(agreed.status).toBe('ok')
    expect(agreed.warning).toBeUndefined()
  })

  it('maps the verdict to the ONE degrade rule: only `incompatible` withholds the base', () => {
    expect(baseIsUsable({ status: 'ok' })).toBe(true)
    expect(baseIsUsable({ status: 'cannot-tell', reason: 'x' })).toBe(true)
    expect(baseIsUsable({ status: 'incompatible', required: 1, loaded: 2, reason: 'x' })).toBe(false)
  })

  it('treats a base without the gate, and a missing or malformed bake, as "cannot tell"', () => {
    const current = bake({ baseVersion: '0.3.0', interfaceVersion: runtime.INTERFACE_VERSION })
    // A base older than the gate: there is no function to call, so the generation cannot be told.
    const old = interfaceVerdict({ INTERFACE_VERSION: runtime.INTERFACE_VERSION }, current)
    expect(old.status).toBe('cannot-tell')
    expect(old.reason).toContain('no interface gate')
    // No bake record at all, a malformed one, and one with a non-integer generation.
    const missing = pathToFileURL(join(dir, 'missing.json'))
    expect(interfaceVerdict(base, missing).status).toBe('cannot-tell')
    expect(interfaceVerdict(base, missing).reason).toContain('no baked interface requirement')
    expect(interfaceVerdict(base, bake('{ not json')).status).toBe('cannot-tell')
    expect(interfaceVerdict(base, bake({ baseVersion: '0.3.0', interfaceVersion: '1' })).status).toBe('cannot-tell')
  })

  it('survives a hostile module at the consumer level too', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('shape mismatch') } })
    expect(() => interfaceVerdict(hostile)).not.toThrow()
    expect(interfaceVerdict(hostile).status).toBe('cannot-tell')
  })

  it('reads its own real bake record through the base\'s reader', () => {
    // The build bakes `lib/interface-version.json`; the base's reader must recognize it, and its
    // generation must be the one the loaded base reports (the cross-tree pin the old private reader
    // had, now driven through the base).
    const baked = readFileSync(BAKED_URL, 'utf8')
    const record = runtime.readInterfaceRequirement(BAKED_URL)
    expect(record).toBeDefined()
    expect(record?.interfaceVersion).toBe(runtime.INTERFACE_VERSION)
    expect(baked).toContain('"baseVersion"')
  })
})
