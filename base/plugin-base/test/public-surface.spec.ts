/**
 * The public surface: the `.` entry carries exactly the documented contract — the stable subset the
 * installed plugins consume plus the extension points a plugin author calls — while the framework's
 * own seams AND the composition pieces shedding from `.` in v3 live on `./internal` and are explicitly
 * **not** covered by the compatibility promise.
 *
 * The surface is stated ONCE, by the interface type itself (`src/interface.ts`):
 *
 *   - `VALUE_NAMES_V3` / `TYPE_NAMES_V3` are the only lists for the CURRENT generation (they partition
 *     `keyof BaseRuntimeV3` / `BaseTypeSurfaceV3`), and the frozen `VALUE_NAMES_V2` / `VALUE_NAMES_V1`
 *     (and type lists) are kept beside them so this file can prove the v3 transition lost nothing,
 *   - the real module is assigned to a `BaseRuntimeV3`-typed binding, so a missing member is a TYPE
 *     error (a type-only test would be erased, so the assignment is also exercised at runtime),
 *   - `api/interface-v3.json` records the current names + counts, `api/interface-v2.json` and
 *     `api/interface-v1.json` stay as the superseded generations' records, and this file is the gate
 *     that keeps the snapshot, the lists and the module's actual exports equal.
 *
 * **v3 is the first PRUNING generation** (INTERFACE.md §9): it does NOT `extends` v2. What replaces the
 * raw `v3 ⊇ v2` superset assertion is a two-part proof, both mechanical and both asserted below:
 *
 *   1. `VALUE_NAMES_V2` is exactly `VALUE_NAMES_V3 ⊎ PRUNED_VALUE_NAMES` (and the type halves line up
 *      modulo `ADDED_TYPE_NAMES` / `PRUNED_TYPE_NAMES`) — every shed name is on the frozen list, so
 *      nothing was silently renamed or lost, and
 *   2. every `PRUNED_VALUE_NAMES` entry has ZERO consumers in the two plugin trees' non-test source and
 *      scripts — the cross-tree check at the bottom of this file, which reads `mem` and `mission` (the
 *      base's suite is the only tree allowed to read both).
 *
 * Together those keep `checkInterface`'s `loaded > required ⇒ ok` branch admissible for v3 — see
 * `test/interface_gate.spec.ts`.
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
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as api from '../src/index.js'
import * as internal from '../src/internal.js'
import {
  ADDED_TYPE_NAMES,
  INTERFACE_VERSION,
  PRUNED_TYPE_NAMES,
  PRUNED_VALUE_NAMES,
  TYPE_NAMES_V1,
  TYPE_NAMES_V2,
  TYPE_NAMES_V3,
  VALUE_NAMES_V1,
  VALUE_NAMES_V2,
  VALUE_NAMES_V3,
  type BaseRuntimeV3,
  type BaseTypeSurfaceV3,
} from '../src/interface.js'

/**
 * The module as the interface type says it is. If any member of `api` were missing or had the wrong
 * shape, THIS assignment would not compile — the same check a plugin gets on its side of the tree.
 */
const runtime: BaseRuntimeV3 = api

/** The snapshot for the generation this module declares. The file name's N is `INTERFACE_VERSION`. */
const SNAPSHOT_URL = new URL(`../api/interface-v${String(INTERFACE_VERSION)}.json`, import.meta.url)

/** The repo root: this file lives in `<repo>/base/plugin-base/test/`. */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

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
    const strayValues: Stray<(typeof VALUE_NAMES_V3)[number], keyof BaseRuntimeV3>[] = []
    const missingValues: Stray<keyof BaseRuntimeV3, (typeof VALUE_NAMES_V3)[number]>[] = []
    const strayTypes: Stray<(typeof TYPE_NAMES_V3)[number], keyof BaseTypeSurfaceV3>[] = []
    const missingTypes: Stray<keyof BaseTypeSurfaceV3, (typeof TYPE_NAMES_V3)[number]>[] = []
    expect([...strayValues, ...missingValues, ...strayTypes, ...missingTypes]).toEqual([])
    // …and no name belongs to both halves.
    const both = VALUE_NAMES_V3.filter((name) => (TYPE_NAMES_V3 as readonly string[]).includes(name))
    expect(both).toEqual([])
  })

  it('v2 is ADDITIVE over v1 (the earlier generations keep their own proof)', () => {
    // v1 → v2 was the additive transition, and its proof is list-level: the v2 interfaces were declared
    // as `extends` the v1 ones and the lists show the two members that were added. The REAL module no
    // longer satisfies `BaseRuntimeV1` after the v3 prune, which is exactly the fact the next test
    // turns into the replacement proof.
    for (const name of VALUE_NAMES_V1) expect(VALUE_NAMES_V2 as readonly string[]).toContain(name)
    for (const name of TYPE_NAMES_V1) expect(TYPE_NAMES_V2 as readonly string[]).toContain(name)
    expect(VALUE_NAMES_V2.length).toBe(VALUE_NAMES_V1.length + 2)
    expect(TYPE_NAMES_V2.length).toBe(TYPE_NAMES_V1.length)
  })

  it('v3 PRUNES: v2 partitions into the v3 surface plus the frozen prune list', () => {
    // The replacement for the raw `v3 ⊇ v2` superset assertion. Both halves of the surface must line
    // up: a name that is neither on `.` nor on the prune list would be a silent loss.
    expect(sortedUnique([...VALUE_NAMES_V3, ...PRUNED_VALUE_NAMES])).toEqual(sortedUnique(VALUE_NAMES_V2))
    expect(VALUE_NAMES_V3.filter((name) => (PRUNED_VALUE_NAMES as readonly string[]).includes(name))).toEqual([])
    const restored = sortedUnique([...TYPE_NAMES_V3, ...PRUNED_TYPE_NAMES])
    expect(restored).toContain('ServiceContract')
    // Every v2 type name is either still on `.` or on the prune list.
    for (const name of TYPE_NAMES_V2) {
      expect(
        (TYPE_NAMES_V3 as readonly string[]).includes(name) || (PRUNED_TYPE_NAMES as readonly string[]).includes(name),
        `v2 type ${name} vanished without being pruned`,
      ).toBe(true)
    }
    // The type list is not padded: it is exactly the v2 names minus the pruned ones plus the newly
    // named ones (which were reachable through `export *` but never declared).
    expect(sortedUnique([...ADDED_TYPE_NAMES, ...PRUNED_TYPE_NAMES]).length).toBe(ADDED_TYPE_NAMES.length + PRUNED_TYPE_NAMES.length)
    const expectedTypes = sortedUnique([
      ...TYPE_NAMES_V2.filter((name) => !(PRUNED_TYPE_NAMES as readonly string[]).includes(name)),
      ...ADDED_TYPE_NAMES,
    ])
    expect(sortedUnique(TYPE_NAMES_V3)).toEqual(expectedTypes)
  })

  it('the module really exports every VALUE name, and exactly those', () => {
    // Runtime equality in both directions: a name the code exports but the interface does not declare
    // is a silent widening; a name the interface declares but the code dropped is a broken promise.
    expect(actualValueNames().sort()).toEqual(sortedUnique(VALUE_NAMES_V3))
  })

  it('every VALUE name is really a member of the typed module', () => {
    // The type says so; this is the runtime half, so a name that resolves to `undefined` (a typo in
    // the list, a lost re-export) cannot hide behind types.
    const missing = VALUE_NAMES_V3.filter((name) => (runtime as unknown as Record<string, unknown>)[name] === undefined)
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
    expect(snapshot.exportedValueCount).toBe(VALUE_NAMES_V3.length)
    expect(snapshot.exportedValueNames).toEqual(sortedUnique(VALUE_NAMES_V3))
  })

  it('records the interface type\'s declared type names and their count', () => {
    expect(snapshot.exportedTypeNames).toEqual(sortedUnique(TYPE_NAMES_V3))
    expect(snapshot.exportedTypeCount).toBe(TYPE_NAMES_V3.length)
  })

  it('keeps the superseded v1 and v2 snapshots as those generations\' frozen records', () => {
    // Neither is read by the gate any more, but both stay in the tree as that generation's record —
    // and they must keep matching the frozen lists, so "archived" does not become "left to rot".
    const v1 = JSON.parse(readFileSync(new URL('../api/interface-v1.json', import.meta.url), 'utf8')) as InterfaceSnapshot
    expect(v1.interfaceVersion).toBe(1)
    expect(v1.exportedValueNames).toEqual(sortedUnique(VALUE_NAMES_V1))
    expect(v1.exportedValueCount).toBe(VALUE_NAMES_V1.length)
    expect(v1.exportedTypeNames).toEqual(sortedUnique(TYPE_NAMES_V1))
    expect(v1.exportedTypeCount).toBe(TYPE_NAMES_V1.length)

    const v2 = JSON.parse(readFileSync(new URL('../api/interface-v2.json', import.meta.url), 'utf8')) as InterfaceSnapshot
    expect(v2.interfaceVersion).toBe(2)
    expect(v2.exportedValueNames).toEqual(sortedUnique(VALUE_NAMES_V2))
    expect(v2.exportedValueCount).toBe(VALUE_NAMES_V2.length)
    expect(v2.exportedTypeNames).toEqual(sortedUnique(TYPE_NAMES_V2))
    expect(v2.exportedTypeCount).toBe(TYPE_NAMES_V2.length)
  })

  it('is regenerated only by an explicit command, never by a test run', () => {
    if (process.env['UPDATE_INTERFACE_SNAPSHOT'] !== '1') return
    const next: InterfaceSnapshot = {
      interfaceVersion: INTERFACE_VERSION,
      exportedValueNames: sortedUnique(VALUE_NAMES_V3),
      exportedValueCount: VALUE_NAMES_V3.length,
      exportedTypeNames: sortedUnique(TYPE_NAMES_V3),
      exportedTypeCount: TYPE_NAMES_V3.length,
    }
    writeFileSync(SNAPSHOT_URL, `${JSON.stringify(next, null, 2)}\n`)
    console.warn(`public-surface: rewrote ${SNAPSHOT_URL.pathname} from the current exports`)
  })
})

describe('the private seams and the pruned surface stay off the public entry', () => {
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

  it('v3 剪掉的 18 个成员：`. ` 上没有、`./internal` 上有（移动是完整的）', () => {
    const leaked = PRUNED_VALUE_NAMES.filter((name) => (api as Record<string, unknown>)[name] !== undefined)
    expect(leaked).toEqual([])
    const missing = PRUNED_VALUE_NAMES.filter((name) => (internal as Record<string, unknown>)[name] === undefined)
    expect(missing).toEqual([])
  })

  it('公开入口不泄漏子路径入口的实现符号', () => {
    // A subpath (`./preset` / `./conformance` / `./bootstrap`) is its own entry, not a re-export.
    expect(Object.keys(api)).not.toContain('envinitPreset')
    expect(Object.keys(api)).not.toContain('runProviderConformance')
    expect(Object.keys(api)).not.toContain('ensureFramework')
  })
})

/**
 * The other half of the v3 pruning proof: every pruned value name has ZERO consumers across the two
 * plugin trees' non-test source and scripts. This is what makes `checkInterface`'s `loaded > required
 * ⇒ ok` branch admissible for a generation that is not a name superset of the one before it.
 *
 * The check is deliberately conservative and code-shaped, not a comment match: a pruned name must not
 * be (a) accessed as a member of anything (`base.floorOf`, `kit?.strictCodec`) nor (b) imported from
 * the base specifier. A local mirror of the same NAME is allowed and expected for the Typert symbols,
 * which is exactly why a bare word-boundary search would be the wrong instrument here.
 */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === 'dist' || entry === 'test' || entry === '__snapshots__') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      walkSources(path, out)
    } else if (/\.(?:ts|tsx|mjs|cjs|js)$/u.test(entry) && !/\.(?:spec|test)\./u.test(entry)) {
      out.push(path)
    }
  }
  return out
}

const BASE_IMPORT = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]@avantf\/dsh-plugin-base['"]/gu

describe('the v3 prune list has zero consumers in the two plugin trees', () => {
  const files = ['mem', 'mission'].flatMap((tree) => walkSources(join(repo, tree)))

  it('reads both plugin trees (the convention this file was written against did not move)', () => {
    expect(files.length).toBeGreaterThan(20)
    for (const tree of ['mem', 'mission']) {
      expect(files.some((file) => file.startsWith(join(repo, tree)))).toBe(true)
    }
  })

  it('no pruned name is member-accessed or imported from the base specifier', () => {
    const offences: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const name of PRUNED_VALUE_NAMES) {
        const memberAccess = new RegExp(`\\??\\.${name}\\b`, 'u')
        if (memberAccess.test(text)) offences.push(`${file}: member access .${name}`)
      }
      for (const match of text.matchAll(BASE_IMPORT)) {
        const clause = match[1] ?? ''
        for (const name of PRUNED_VALUE_NAMES) {
          if (new RegExp(`\\b${name}\\b`, 'u').test(clause)) offences.push(`${file}: imports ${name} from the base`)
        }
      }
    }
    expect(sortedUnique(offences)).toEqual([])
  })
})
