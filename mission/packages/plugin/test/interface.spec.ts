/**
 * The base's interface, driven ACROSS the tree boundary — the mission side.
 *
 * The same device as `mem/packages/plugin/test/interface.spec.ts`: every case takes the REAL
 * implementation off the linked `@avantf/dsh-plugin-base` (never a mock, because a mock only proves
 * that the mock is self-consistent — INTERFACE.md §4) and checks the behaviour this plugin is entitled
 * to expect. What is mission-specific here is the wiring: this plugin's own `promptDir` fallback must
 * hand the base the same NAMED slots and reach the same directory, and its `PromptFiles` use is the
 * one the guidance section depends on.
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
import { baseIsUsable, interfaceVerdict } from '../src/interface_gate.js'
import { promptDir, resolveDataHome as workResolveDataHome } from '../src/prompt.js'

/** The module AS the interface declares it: a missing or reshaped member fails to compile here. */
const runtime: BaseRuntimeV1 = base

/** The record `scripts/link-envinit.mjs` bakes beside the built entry. */
const BAKED_URL = new URL('../lib/interface-version.json', import.meta.url)

describe('the linked base satisfies the declared interface', () => {
  it('reports the generation this artifact was baked against', () => {
    const baked = JSON.parse(readFileSync(BAKED_URL, 'utf8')) as { baseVersion?: unknown; interfaceVersion?: unknown }
    expect(typeof baked.baseVersion).toBe('string')
    expect(Number.isInteger(runtime.INTERFACE_VERSION)).toBe(true)
    expect(baked.interfaceVersion).toBe(runtime.INTERFACE_VERSION)
  })
})

describe('path resolution is the same answer on both sides of the tree', () => {
  it('agrees with this plugin\'s base-less fallback for every layer combination', () => {
    for (const configured of [undefined, '', '  ', '/tmp/configured', '~/custom', '~']) {
      for (const env of [{}, { AVANTF_HOME: '/tmp/family' }, { AVANTF_HOME: '   ' }, { AVANTF_HOME: '~' }]) {
        expect(workResolveDataHome({ configured, env }), `configured=${String(configured)} env=${JSON.stringify(env)}`)
          .toBe(runtime.resolveDataHome({ configured, env }))
      }
    }
    expect(workResolveDataHome({ explicit: '/tmp/caller', configured: '/tmp/configured', env: { AVANTF_HOME: '/tmp/family' } }))
      .toBe(runtime.resolveDataHome({ explicit: '/tmp/caller', configured: '/tmp/configured', env: { AVANTF_HOME: '/tmp/family' } }))
  })

  it('hands the BASE the configured value in the named layer ② slot, never as explicit', () => {
    // The whole point of the named object: a caller cannot promote layer ② above ④ by putting the
    // config value in the wrong position. The stub records the object `promptDir` actually passes.
    const seen: { explicit?: string; env?: Record<string, string | undefined>; configured?: string }[] = []
    const resolver = (input: { explicit?: string; env?: Record<string, string | undefined>; configured?: string }) => {
      seen.push(input)
      return '/sentinel'
    }
    expect(promptDir('/tmp/configured', { AVANTF_HOME: '/tmp/family' }, resolver)).toBe('/sentinel/prompts')
    expect(seen[0]).toEqual({ explicit: undefined, env: { AVANTF_HOME: '/tmp/family' }, configured: '/tmp/configured' })
    // And with the real base resolver, the same call gives the same directory this plugin's own
    // fallback does — no third answer.
    expect(promptDir('/tmp/configured', { AVANTF_HOME: '/tmp/family' }, runtime.resolveDataHome))
      .toBe(join(runtime.resolveDataHome({ env: { AVANTF_HOME: '/tmp/family' }, configured: '/tmp/configured' }), 'prompts'))
    expect(promptDir(undefined, {}, runtime.resolveDataHome)).toBe(join(homedir(), '.avantf', 'prompts'))
  })
})

describe('PromptFiles behaves as the guidance layer expects', () => {
  it('creates the section file with the caller\'s default and reads an edited one verbatim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-mission-interface-'))
    try {
      const specs = [{ file: 'mission-tree-guide.md', fallback: '内置的指导正文' }]
      const created = new runtime.PromptFiles({ dir }).load(specs)
      expect(created[0]?.source).toBe('default')
      expect(created[0]?.wrote).toBe(true)
      expect(created[0]?.text).toBe('内置的指导正文')
      expect(readFileSync(join(dir, 'mission-tree-guide.md'), 'utf8').trim()).toBe('内置的指导正文')

      // A user's edit is injected exactly as written (outer whitespace trimmed, nothing else changed).
      const edited = '只讲任务。这条是用户写的。'
      writeFileSync(join(dir, 'mission-tree-guide.md'), `\n${edited}\n`, 'utf8')
      const loaded = new runtime.PromptFiles({ dir }).load(specs)
      expect(loaded[0]?.source).toBe('file')
      expect(loaded[0]?.text).toBe(edited)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('compatReport keeps the structure and takes the caller\'s words', () => {
  it('renders the caller\'s sentences and passes the base\'s own prefix to logPointer', () => {
    const report = runtime.compatReport(
      {
        load: false,
        skipped: false,
        status: 'probe-failed',
        problems: ['tools.register is gone'],
        warnings: ['w1'],
        notes: [],
        lines: [],
        reason: 'incompatible',
      },
      {
        heading: '任务插件未加载：兼容性检查未通过。',
        warningsLabel: '风险提示：',
        warnings: ['w1'],
        fix: '修复：升级 dsh 或重建本插件。',
        logPointer: (prefix) => `完整诊断见 ${prefix} 开头的行。`,
      },
    )
    expect(report).toContain('任务插件未加载：兼容性检查未通过。')
    expect(report).toContain('w1')
    expect(report).toContain('修复：升级 dsh 或重建本插件。')
    expect(report).toContain('完整诊断见 compat: 开头的行。')
  })
})

describe('the provisioner reaches a terminal state the caller can branch on', () => {
  it('reports a stable action and code for an item the policy disables', async () => {
    const home = mkdtempSync(join(tmpdir(), 'avantf-mission-interface-home-'))
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
      expect(entry?.plugin).toBe('interface-probe')
      expect(entry?.action).toBe('skipped')
      expect(entry?.code).toBe('policy/download-disabled')
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
 * semantics are pinned HERE, across the tree, from the REAL implementation — both directions are
 * incompatible, a hostile module reads as "reports none", and the plugin's consumer maps the verdict
 * to the loader's decision (withhold the base on `incompatible` only). The loader-level consequences
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

  it('is `incompatible` in BOTH directions and `cannot-tell` for a side it cannot read', () => {
    expect(runtime.checkInterface(1, { INTERFACE_VERSION: 2 }).status).toBe('incompatible')
    expect(runtime.checkInterface(2, { INTERFACE_VERSION: 1 }).status).toBe('incompatible')
    expect(runtime.checkInterface(1, {}).status).toBe('cannot-tell')
    expect(runtime.checkInterface(1, { INTERFACE_VERSION: 'v1' }).status).toBe('cannot-tell')
    expect(runtime.checkInterface(0, { INTERFACE_VERSION: 1 }).status).toBe('cannot-tell')
  })

  it('reads a hostile module as "reports none" and never throws', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('shape mismatch') } })
    expect(() => runtime.checkInterface(1, hostile)).not.toThrow()
    expect(runtime.checkInterface(1, hostile).status).toBe('cannot-tell')
  })

  it('consumes the base gate: ok / both mismatch directions / cannot-tell', () => {
    const generation = runtime.INTERFACE_VERSION
    const current = bake({ baseVersion: '0.3.0', interfaceVersion: generation })
    expect(interfaceVerdict(base, current).status).toBe('ok')

    // The build requires a NEWER generation than the base it loaded…
    const newer = bake({ baseVersion: '0.3.0', interfaceVersion: generation + 1 })
    expect(interfaceVerdict(base, newer).status).toBe('incompatible')
    // …and the other direction: the build is old, the base is new.
    expect(interfaceVerdict({ ...base, INTERFACE_VERSION: generation + 1 }, current).status).toBe('incompatible')
    // The generation becomes readable again as soon as both sides agree.
    expect(interfaceVerdict({ ...base, INTERFACE_VERSION: generation + 1 }, newer).status).toBe('ok')
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
