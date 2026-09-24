/**
 * The runtime interface gate: `checkInterface` decides, `readInterfaceRequirement` supplies the
 * caller's side.
 *
 * The gate is the family's MAIN compatibility contract now, so its properties are pinned here rather
 * than in each plugin: both directions are incompatible, a side that cannot be read is `cannot-tell`
 * (never incompatible), the property read is guarded against a hostile module, and nothing it is
 * handed can make it throw. `readInterfaceRequirement` is the ONE reader of a bake record, and
 * "missing" and "malformed" both mean `undefined` — the plugins' startup path turns that into a
 * warning, so a throw here would reject a mount the family forbids rejecting.
 *
 * @module test/interface_gate
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INTERFACE_VERSION } from '../src/interface.js'
import { checkInterface, readInterfaceRequirement } from '../src/interface_gate.js'

/** A module that throws on ANY property read — the shape a loader must survive. */
const hostile = new Proxy({}, { get: () => { throw new Error('shape mismatch') } })

describe('checkInterface decides in both directions', () => {
  it('is `ok` when both sides name the same generation', () => {
    const verdict = checkInterface(1, { INTERFACE_VERSION: 1 })
    expect(verdict.status).toBe('ok')
    expect(verdict.required).toBe(1)
    expect(verdict.loaded).toBe(1)
    expect(verdict.reason).toBeUndefined()
  })

  it('is `incompatible` when the loaded base is OLDER than the build', () => {
    const verdict = checkInterface(3, { INTERFACE_VERSION: 2 })
    expect(verdict.status).toBe('incompatible')
    expect(verdict.required).toBe(3)
    expect(verdict.loaded).toBe(2)
    expect(verdict.reason).toContain('generation 3')
    expect(verdict.reason).toContain('reports 2')
    expect(verdict.reason).toContain('older generation')
  })

  it('is `incompatible` when the loaded base is NEWER than the build', () => {
    // "In range but another generation" is exactly the case `supportedRange` cannot see, so the gate
    // must see it in the direction a package version never moves.
    const verdict = checkInterface(1, { INTERFACE_VERSION: 2 })
    expect(verdict.status).toBe('incompatible')
    expect(verdict.reason).toContain('newer generation')
  })

  it('is `cannot-tell` when the loaded module reports no generation', () => {
    for (const module of [{}, { INTERFACE_VERSION: 'v1' }, { INTERFACE_VERSION: 1.5 }, { INTERFACE_VERSION: -1 }, { INTERFACE_VERSION: 0 }]) {
      const verdict = checkInterface(1, module)
      expect(verdict.status, JSON.stringify(module)).toBe('cannot-tell')
      expect(verdict.reason).toContain('reports no INTERFACE_VERSION')
    }
  })

  it('is `cannot-tell` when the build has no usable generation either', () => {
    for (const required of [0, -2, 1.5, Number.NaN, undefined as unknown as number]) {
      const verdict = checkInterface(required, { INTERFACE_VERSION: 2 })
      expect(verdict.status, String(required)).toBe('cannot-tell')
      expect(verdict.reason).toContain('no usable baked interface generation')
    }
  })

  it('reads a hostile module as "reports none" — it never throws and never rejects a mount', () => {
    let verdict: ReturnType<typeof checkInterface> | undefined
    expect(() => { verdict = checkInterface(1, hostile) }).not.toThrow()
    expect(verdict?.status).toBe('cannot-tell')
    expect(verdict?.loaded).toBeUndefined()
  })

  it('is wired to the generation this module actually declares', () => {
    expect(checkInterface(INTERFACE_VERSION, { INTERFACE_VERSION: INTERFACE_VERSION }).status).toBe('ok')
  })
})

describe('readInterfaceRequirement is the ONE bake reader', () => {
  it('reads a well-formed record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-interface-gate-'))
    const url = pathToFileURL(join(dir, 'interface-version.json'))
    writeFileSync(url, JSON.stringify({ baseVersion: '0.3.0', interfaceVersion: INTERFACE_VERSION }))
    expect(readInterfaceRequirement(url)).toEqual({ baseVersion: '0.3.0', interfaceVersion: INTERFACE_VERSION })
  })

  it('answers `undefined` for missing and malformed records — never a throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-interface-gate-'))
    const missing = pathToFileURL(join(dir, 'nope.json'))
    expect(readInterfaceRequirement(missing)).toBeUndefined()
    const cases: string[] = [
      '',
      '{}',
      '[]',
      'null',
      '{ not json',
      JSON.stringify({ baseVersion: '', interfaceVersion: 1 }),
      JSON.stringify({ baseVersion: '0.3.0' }),
      JSON.stringify({ baseVersion: '0.3.0', interfaceVersion: '1' }),
      JSON.stringify({ baseVersion: '0.3.0', interfaceVersion: 0 }),
      JSON.stringify({ baseVersion: '0.3.0', interfaceVersion: 1.5 }),
    ]
    cases.forEach((text, index) => {
      const url = pathToFileURL(join(dir, `case-${String(index)}.json`))
      writeFileSync(url, text)
      expect(readInterfaceRequirement(url), text).toBeUndefined()
    })
  })
})
