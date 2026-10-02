/**
 * The runtime interface gate: `checkInterface` decides, `readInterfaceRequirement` supplies the
 * caller's side.
 *
 * The gate is the family's MAIN compatibility contract now, so its properties are pinned here rather
 * than in each plugin: only the MISSING-members direction is `incompatible`, a NEWER loaded base is
 * `ok` + a WARNING (generations are additive — the added surface must not downgrade anyone), a side
 * that cannot be read is `cannot-tell` (never incompatible), the property read is guarded against a
 * hostile module, and nothing it is handed can make it throw. The additive premise the newer-is-ok
 * branch rests on is asserted against the REAL module below, not just promised in a comment.
 * `readInterfaceRequirement` is the ONE reader of a bake record, and "missing" and "malformed" both
 * mean `undefined` — the plugins' startup path turns that into a warning, so a throw here would
 * reject a mount the family forbids rejecting.
 *
 * @module test/interface_gate
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'
import { INTERFACE_VERSION, VALUE_NAMES_V1 } from '../src/interface.js'
import { checkInterface, readInterfaceRequirement } from '../src/interface_gate.js'

/** A module that throws on ANY property read — the shape a loader must survive. */
const hostile = new Proxy({}, { get: () => { throw new Error('shape mismatch') } })

describe('checkInterface decides in both directions', () => {
  it('is `ok` with no warning when both sides name the same generation', () => {
    const verdict = checkInterface(1, { INTERFACE_VERSION: 1 })
    expect(verdict.status).toBe('ok')
    expect(verdict.required).toBe(1)
    expect(verdict.loaded).toBe(1)
    expect(verdict.reason).toBeUndefined()
    expect(verdict.warning).toBeUndefined()
  })

  it('is `incompatible` when the loaded base is OLDER than the build (members may be missing)', () => {
    const verdict = checkInterface(3, { INTERFACE_VERSION: 2 })
    expect(verdict.status).toBe('incompatible')
    expect(verdict.required).toBe(3)
    expect(verdict.loaded).toBe(2)
    expect(verdict.reason).toContain('generation 3')
    expect(verdict.reason).toContain('reports 2')
    expect(verdict.reason).toContain('older generation')
    expect(verdict.warning).toBeUndefined()
  })

  it('is `ok` + a WARNING when the loaded base is NEWER than the build (pure addition)', () => {
    // The family's safe case: generations are additive, so every member this build requires is still
    // there. "In range but another generation" is exactly the case `supportedRange` cannot see, so the
    // gate must see it — and must NOT degrade the old build over an ADDED surface.
    const verdict = checkInterface(1, { INTERFACE_VERSION: 2 })
    expect(verdict.status).toBe('ok')
    expect(verdict.required).toBe(1)
    expect(verdict.loaded).toBe(2)
    expect(verdict.warning).toContain('newer')
    expect(verdict.warning).toContain('generation 2')
    expect(verdict.warning).toContain('pure additions')
    // `reason` stays reserved for a non-`ok` verdict, so a caller that logs it only then stays correct.
    expect(verdict.reason).toBeUndefined()
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

describe('the `loaded > required` = ok rule rests on a MECHANICAL superset proof', () => {
  // `checkInterface` is generic over integers, so it cannot itself know that v2 ⊇ v1 — that fact lives
  // in the generation declarations and `public-surface.spec.ts`. These two assertions tie the gate's
  // admission rule to that proof: if a future generation is NOT a superset of the one before it, the
  // real module stops carrying the previous generation's members and this block fails, which is the
  // signal that the newer-is-ok branch must not be used for it.
  it('every v1 VALUE name is really still exported by the v2 module (the real v2 IS a v1)', () => {
    const module = api as unknown as Record<string, unknown>
    const missing = VALUE_NAMES_V1.filter((name) => module[name] === undefined)
    expect(missing).toEqual([])
  })

  it('a v1 build meeting the REAL v2 module gets `ok` + a WARNING, not a degradation', () => {
    // End to end on the real module: the case R1 turns into reality — an old plugin, an updated host
    // base — judged usable, with the additive rule named in the warning.
    const verdict = checkInterface(1, api)
    expect(verdict.status).toBe('ok')
    expect(verdict.warning).toContain('pure additions')
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
