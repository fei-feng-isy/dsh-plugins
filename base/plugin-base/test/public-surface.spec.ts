/**
 * The public surface: the `.` entry carries exactly the documented contract — the composition root,
 * the data model, the shared kit and the compatibility gate — while the framework's own seams live on
 * `./internal` and are explicitly **not** covered by the compatibility promise.
 *
 * The surface is stated ONCE, by the interface type itself (`src/interface.ts`):
 *
 *   - `VALUE_NAMES_V2` / `TYPE_NAMES_V2` are the only lists for the CURRENT generation (they partition
 *     `keyof BaseRuntimeV2`), and the frozen `VALUE_NAMES_V1` / `TYPE_NAMES_V1` are kept beside them so
 *     this file can prove v2 is ADDITIVE over v1,
 *   - the real module is assigned to a `BaseRuntimeV2`-typed binding, so a missing member is a
 *     TYPE error (a type-only test would be erased, so the assignment is also exercised at runtime),
 *   - `api/interface-v2.json` records the current names + counts, `api/interface-v1.json` stays as the
 *     superseded generation's record, and this file is the gate that keeps the snapshot, the lists and
 *     the module's actual exports equal.
 *
 * There is deliberately NO hand-written equality whitelist here any more: a second copy of the surface
 * is exactly the drift the snapshot exists to prevent. `INTERFACE.md` §5.
 *
 * `UPDATE_INTERFACE_SNAPSHOT=1 pnpm -C base/plugin-base test public-surface` rewrites the snapshot with
 * the current exports — the mechanical way to cut vN. Bumping `INTERFACE_VERSION` is a SEPARATE, manual
 * act (a new `api/interface-vN.json` and a version decision), which is why this file never invents one.
 *
 * @module test/public-surface
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'
import * as internal from '../src/internal.js'
import {
  INTERFACE_VERSION,
  TYPE_NAMES_V1,
  TYPE_NAMES_V2,
  VALUE_NAMES_V1,
  VALUE_NAMES_V2,
  type BaseRuntimeV1,
  type BaseRuntimeV2,
  type BaseTypeSurfaceV2,
} from '../src/interface.js'

/**
 * The module as the interface type says it is. If any member of `api` were missing or had the wrong
 * shape, THIS assignment would not compile — the same check a plugin gets on its side of the tree.
 */
const runtime: BaseRuntimeV2 = api

/** The snapshot for the generation this module declares. The file name's N is `INTERFACE_VERSION`. */
const SNAPSHOT_URL = new URL(`../api/interface-v${String(INTERFACE_VERSION)}.json`, import.meta.url)

interface InterfaceSnapshot {
  readonly interfaceVersion: number
  readonly exportedValueNames: readonly string[]
  readonly exportedValueCount: number
  readonly exportedTypeNames: readonly string[]
  readonly exportedTypeCount: number
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as InterfaceSnapshot

/** `default` is the CJS interop shim, not part of the surface. */
function actualValueNames(): string[] {
  return Object.keys(api).filter((name) => name !== 'default')
}

/**
 * `A`'s members that `B` does not accept. Both arguments are unions of string literals, so this is a
 * compile-time check: the assertions below fail to type-check the moment the interface and its lists
 * disagree, which is what keeps the "single carrier" honest rather than merely documented.
 */
type Stray<A extends string, B extends string> = Exclude<A, B>

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort()
}

describe('the interface type is the single carrier of the public surface', () => {
  it('each name list is exactly the `keyof` its interface declares', () => {
    // Compile-time completeness: an interface member that appears in NEITHER list, or a list entry
    // that is not a member, is a type error here before any runtime assertion runs.
    const strayValues: Stray<(typeof VALUE_NAMES_V2)[number], keyof BaseRuntimeV2>[] = []
    const missingValues: Stray<keyof BaseRuntimeV2, (typeof VALUE_NAMES_V2)[number]>[] = []
    const strayTypes: Stray<(typeof TYPE_NAMES_V2)[number], keyof BaseTypeSurfaceV2>[] = []
    const missingTypes: Stray<keyof BaseTypeSurfaceV2, (typeof TYPE_NAMES_V2)[number]>[] = []
    expect([...strayValues, ...missingValues, ...strayTypes, ...missingTypes]).toEqual([])
    // …and no name belongs to both halves.
    const both = VALUE_NAMES_V2.filter((name) => (TYPE_NAMES_V2 as readonly string[]).includes(name))
    expect(both).toEqual([])
  })

  it('v2 is ADDITIVE over v1: every v1 name survives, and nothing else moved', () => {
    // Compile-time half: v2 `extends` v1, and a real v2 module still satisfies the v1 type — a member
    // that v2 dropped or reshaped would stop this assignment from compiling.
    const v1View: BaseRuntimeV1 = api
    expect(v1View.INTERFACE_VERSION).toBe(INTERFACE_VERSION)
    // Runtime half: the v1 lists are subsets of the v2 lists…
    for (const name of VALUE_NAMES_V1) expect(VALUE_NAMES_V2 as readonly string[]).toContain(name)
    for (const name of TYPE_NAMES_V1) expect(TYPE_NAMES_V2 as readonly string[]).toContain(name)
    // …and the only additions are the two well-formed-text members (v2 adds no named type), so the
    // bump cannot hide a rename or a removal inside "additive".
    expect(VALUE_NAMES_V2.length).toBe(VALUE_NAMES_V1.length + 2)
    expect(TYPE_NAMES_V2.length).toBe(TYPE_NAMES_V1.length)
  })

  it('the module really exports every VALUE name, and exactly those', () => {
    // Runtime equality in both directions: a name the code exports but the interface does not declare
    // is a silent widening; a name the interface declares but the code dropped is a broken promise.
    expect(actualValueNames().sort()).toEqual(sortedUnique(VALUE_NAMES_V2))
  })

  it('every VALUE name is really a member of the typed module', () => {
    // The type says so; this is the runtime half, so a name that resolves to `undefined` (a typo in
    // the list, a lost re-export) cannot hide behind types.
    const missing = VALUE_NAMES_V2.filter((name) => (runtime as unknown as Record<string, unknown>)[name] === undefined)
    expect(missing).toEqual([])
  })

  it('the interface is the ONE place the surface is stated', () => {
    // Guards against reintroducing the old hand-written whitelist next to the type.
    const source = readFileSync(new URL(import.meta.url), 'utf8')
    expect(source).not.toMatch(/const\s+PUBLIC_VALUES/u)
    expect(source).not.toMatch(/const\s+TYPE_NAMES:\s/u)
  })
})

describe('the snapshot is the frozen name surface (api/interface-vN.json)', () => {
  it('the file name and the exported constant are the same fact', () => {
    expect(snapshot.interfaceVersion).toBe(INTERFACE_VERSION)
    expect(Number(/interface-v(\d+)\.json$/u.exec(SNAPSHOT_URL.pathname)?.[1])).toBe(INTERFACE_VERSION)
  })

  it('records the code\'s actual value names and their count', () => {
    // A set comparison, not an ordered one: the snapshot is alphabetically ordered for review, while
    // the interface lists members in a reading order that carries meaning.
    expect([...snapshot.exportedValueNames].sort()).toEqual(actualValueNames().sort())
    expect(snapshot.exportedValueCount).toBe(actualValueNames().length)
    expect(snapshot.exportedValueCount).toBe(VALUE_NAMES_V2.length)
    expect(snapshot.exportedValueNames).toEqual(sortedUnique(VALUE_NAMES_V2))
  })

  it('records the interface type\'s declared type names and their count', () => {
    expect(snapshot.exportedTypeNames).toEqual(sortedUnique(TYPE_NAMES_V2))
    expect(snapshot.exportedTypeCount).toBe(TYPE_NAMES_V2.length)
  })

  it('keeps the superseded v1 snapshot as the frozen v1 record', () => {
    // v1 is not read by the gate any more, but it stays in the tree as that generation's record — and
    // it must keep matching the frozen v1 lists, so "archived" does not become "left to rot".
    const v1 = JSON.parse(readFileSync(new URL('../api/interface-v1.json', import.meta.url), 'utf8')) as InterfaceSnapshot
    expect(v1.interfaceVersion).toBe(1)
    expect(v1.exportedValueNames).toEqual(sortedUnique(VALUE_NAMES_V1))
    expect(v1.exportedValueCount).toBe(VALUE_NAMES_V1.length)
    expect(v1.exportedTypeNames).toEqual(sortedUnique(TYPE_NAMES_V1))
    expect(v1.exportedTypeCount).toBe(TYPE_NAMES_V1.length)
  })

  it('is regenerated only by an explicit command, never by a test run', () => {
    if (process.env['UPDATE_INTERFACE_SNAPSHOT'] !== '1') return
    const next: InterfaceSnapshot = {
      interfaceVersion: INTERFACE_VERSION,
      exportedValueNames: sortedUnique(VALUE_NAMES_V2),
      exportedValueCount: VALUE_NAMES_V2.length,
      exportedTypeNames: sortedUnique(TYPE_NAMES_V2),
      exportedTypeCount: TYPE_NAMES_V2.length,
    }
    writeFileSync(SNAPSHOT_URL, `${JSON.stringify(next, null, 2)}\n`)
    console.warn(`public-surface: rewrote ${SNAPSHOT_URL.pathname} from the current exports`)
  })
})

describe('the private seams stay off the public entry', () => {
  /** Seams and codecs that must stay off the public entry. */
  const INTERNAL_ONLY: readonly string[] = [
    'assertSafeRelativePath',
    'candidateUrls',
    'defaultFs',
    'defaultLock',
    'extractTarGz',
    'fetchImplOf',
    'lintManifest',
    'mergeRows',
    'persistStatus',
    'readStatus',
    'stagingDir',
    'versionSegment',
  ]

  it('内部件不在 `.` 上，而在 `./internal` 上（兼容面因此可控）', () => {
    const leaked = INTERNAL_ONLY.filter((name) => (api as Record<string, unknown>)[name] !== undefined)
    expect(leaked).toEqual([])
    const missing = INTERNAL_ONLY.filter((name) => (internal as Record<string, unknown>)[name] === undefined)
    expect(missing).toEqual([])
  })

  it('公开入口不泄漏子路径入口的实现符号', () => {
    // A subpath (`./preset` / `./conformance` / `./bootstrap`) is its own entry, not a re-export.
    expect(Object.keys(api)).not.toContain('envinitPreset')
    expect(Object.keys(api)).not.toContain('runProviderConformance')
    expect(Object.keys(api)).not.toContain('ensureFramework')
  })
})
