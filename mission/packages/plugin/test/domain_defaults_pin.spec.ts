/**
 * ONE answer from the TWO default encoders — `domain.ts`'s zod schema and core's `normalizeLoaded`.
 *
 * The durability story is deliberately doubled: a persisted record is brought into shape by the zod
 * schema the storage domain parses through, AND again by the core at the one boundary where durable
 * records enter memory. The doubling is on purpose (core must be able to eat a BARE record — another
 * `TreeStore`, an artifact written before a field existed), but the two sides used to encode the same
 * defaults independently, with nothing holding them to the same answer: adding a durable field meant
 * remembering to touch both, and a missed half drifted silently.
 *
 * This pin drives the SAME dirty record through both readers and asserts, field by field, that they
 * agree — and that the value they agree on is the documented default:
 *
 * - **path A** — the durable reader, `treeDocumentSchema.parse`, exactly as the storage domain runs it.
 * - **path B** — the core reader, `MissionTree.open()` over a store that hands it the RAW record
 *   (no zod), which is what a non-plugin store does.
 * - **path C** — the stacked pipeline, core over path A's output: production's actual shape. Its
 *   answer must equal path B's, so zod can never pre-empt a normalization core owns (blank `unit`,
 *   out-of-range `weight`) and core can never lose a default zod supplied.
 *
 * The field list is DERIVED from the schema, not written out here: every field the schema accepts
 * while missing becomes a row, and the test asserts that set is exactly the documented-default table
 * below. A new durable field therefore cannot be added on one side only — it either appears in the
 * table (and must be matched by core) or the set comparison fails.
 */
import { describe, expect, it } from 'vitest'
import { MissionTree, type NodeRecord, type TreeRecord } from '@avantf/mission-core'
import { nodeSchema, treeSchema, treeDocumentSchema, type TreeDocument } from '../src/domain.js'
import { toState } from '../src/store.js'

const ROOT = 'n0001'

/** A tree with exactly the fields the schema requires. */
const REQUIRED_TREE: Record<string, unknown> = { rootId: ROOT, ownerSessionId: 'owner', createdAt: 1 }

/** A node with exactly the fields the schema REQUIRES today (the fields the first build wrote). Every
 *  other durable field is exercised by omission, so a field added to the schema automatically joins
 *  the table below. */
function requiredNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROOT,
    rootId: ROOT,
    parentId: null,
    title: 'Ship it',
    description: 'd',
    context: ['because'],
    status: 'done',
    createdAt: 1,
    depth: 1,
    claimedBy: null,
    claimedAt: 0,
    attempts: 1,
    result: 'done',
    hasResult: true,
    resultReadAt: null,
    resultRef: null,
    children: [],
    updatedAt: 9,
    ...overrides,
  }
}

function rawDocument(
  node: Record<string, unknown>,
  tree: Record<string, unknown> = REQUIRED_TREE,
): Record<string, unknown> {
  return { tree: { ...tree }, nodes: { [ROOT]: node } }
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record }
  delete copy[key]
  return copy
}

/** The core reader: `open()` over a store handing it the record AS WRITTEN, no schema in between. */
async function openOver(document: TreeDocument): Promise<{ node: NodeRecord; tree: TreeRecord }> {
  const tree = new MissionTree(
    {
      loadAll: () => Promise.resolve([toState(document)]),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    },
    {
      isAgentLive: () => false,
      probeOwner: () => Promise.resolve({ kind: 'exists' }),
      spill: () => Promise.resolve(null),
      now: () => 1,
      newId: () => 'generated',
    },
  )
  await tree.open()
  const node = tree.node(ROOT)
  const record = tree.treeOf(ROOT)
  if (node === undefined || record === undefined) throw new Error('the fixture did not load')
  return { node, tree: record }
}

/** Read a field off a record whose TypeScript type is the strict one but whose value may predate it. */
function field(record: object, key: string): unknown {
  return (record as Record<string, unknown>)[key]
}

/** Whether a parsed value is the dirty input passed through verbatim (a legal value, not a default). */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const NODE_KEYS = Object.keys(nodeSchema.shape)
const TREE_KEYS = Object.keys(treeSchema.shape)

/** Every node field the schema accepts while missing — DERIVED, so a new one is never skipped. */
function optionalNodeKeys(): string[] {
  return NODE_KEYS.filter((key) => treeDocumentSchema.safeParse(rawDocument(without(requiredNode(), key))).success)
}

/** Every tree field the schema accepts while missing. */
function optionalTreeKeys(): string[] {
  return TREE_KEYS.filter((key) =>
    treeDocumentSchema.safeParse(rawDocument(requiredNode(), without(REQUIRED_TREE, key))).success)
}

/**
 * The documented default of every optional durable node field, as `domain.ts` states it. The test
 * below asserts the schema's optional set is EXACTLY these keys: a new durable field that is not
 * listed here fails the pin (rather than being silently skipped), which is the drift this whole file
 * exists to catch.
 */
const NODE_DEFAULTS: Record<string, unknown> = {
  unit: null,
  weight: 1,
  roundMs: null,
  // The two dispatch clocks. A record written before them reads as "never dispatched" / "still in
  // play" — `null`, never `undefined`, because `endedAt !== null` is the "is this over" test.
  dispatchedAt: null,
  endedAt: null,
  lastWorkerId: null,
  executorSessionId: null,
  correctionsDeliveredUpTo: 0,
  dispatchBaseline: null,
  analysisAuthor: null,
  corrections: [],
  analysisNotes: [],
  analysisAttempt: 0,
  failures: 0,
  spawnFailures: 0,
  parkedWorker: null,
  progressAt: 0,
  activityAt: 0,
  stalls: 0,
  hungCount: 0,
  stalledNotifiedAt: null,
  resultHint: null,
}

const TREE_DEFAULTS: Record<string, unknown> = { closedAt: null, reportedAt: null }

/** Values that are NOT the field's type; a `.catch(...)` field degrades them instead of failing. */
const DIRTY_VALUES: readonly unknown[] = [{ __dirty: true }, '__dirty__', 12345, true, [], null]

describe('the durable reader and the core reader encode one set of defaults', () => {
  it('defaults every optional node field to the same documented value on both paths', async () => {
    const optional = optionalNodeKeys()
    // The schema's defaulted set IS the table — a new field must be listed (and matched by core).
    expect(optional.slice().sort()).toEqual(Object.keys(NODE_DEFAULTS).slice().sort())

    for (const key of optional) {
      const raw = rawDocument(without(requiredNode(), key))
      const zod = treeDocumentSchema.parse(raw)
      const { node: core } = await openOver(raw as unknown as TreeDocument)

      // Field first, so a drift names the field it is about…
      expect(field(zod.nodes[ROOT] ?? {}, key), `node field ${key}: domain default`).toEqual(NODE_DEFAULTS[key])
      expect(field(core, key), `node field ${key}: core default`).toEqual(NODE_DEFAULTS[key])
    }
    for (const key of optional) {
      const raw = rawDocument(without(requiredNode(), key))
      const zod = treeDocumentSchema.parse(raw)
      const { node: core } = await openOver(raw as unknown as TreeDocument)
      // …then the whole record, so neither reader may invent or drop anything else.
      expect(core, `node field ${key}: core vs domain`).toEqual(zod.nodes[ROOT])
    }
  })

  it('defaults every optional tree field on both paths', async () => {
    const optional = optionalTreeKeys()
    expect(optional.slice().sort()).toEqual(Object.keys(TREE_DEFAULTS).slice().sort())

    for (const key of optional) {
      const raw = rawDocument(requiredNode(), without(REQUIRED_TREE, key))
      const zod = treeDocumentSchema.parse(raw)
      const { tree: core } = await openOver(raw as unknown as TreeDocument)

      expect(field(zod.tree, key), `tree field ${key}: domain default`).toEqual(TREE_DEFAULTS[key])
      expect(field(core, key), `tree field ${key}: core default`).toEqual(TREE_DEFAULTS[key])
      expect(core, `tree field ${key}: core vs domain`).toEqual(zod.tree)
    }
  })

  it('degrades a wrong-shaped value to the same reading on both paths', async () => {
    // Only fields with a `.catch(...)` on the durable side can be compared here: for the rest zod
    // refuses the WHOLE document, so core never sees such a record in production.
    let compared = 0
    for (const key of optionalNodeKeys()) {
      for (const dirty of DIRTY_VALUES) {
        const raw = rawDocument({ ...requiredNode(), [key]: dirty })
        const parsed = treeDocumentSchema.safeParse(raw)
        if (!parsed.success) continue
        const zodValue = field(parsed.data.nodes[ROOT] ?? {}, key)
        if (sameJson(zodValue, dirty)) continue // a legal value, not a degraded one
        compared += 1
        const { node: core } = await openOver(raw as unknown as TreeDocument)
        expect(field(core, key), `${key} ← ${JSON.stringify(dirty)}`).toEqual(zodValue)
      }
    }
    // The guards that exist today: unit / weight / roundMs / analysisAuthor / executorSessionId /
    // hungCount / dispatchBaseline. A guard removed on either side drops this count and fails.
    expect(compared).toBeGreaterThanOrEqual(7)
  })

  it('composes: core over the durable reader is the bare core reader\'s answer', async () => {
    // Production runs BOTH, in this order. Whatever zod supplies, core must not lose it; whatever
    // core normalizes (blank `unit`, out-of-range `weight`), zod must not have pre-empted.
    const inputs: Record<string, unknown>[] = []
    for (const key of optionalNodeKeys()) inputs.push(rawDocument(without(requiredNode(), key)))
    for (const key of optionalTreeKeys()) inputs.push(rawDocument(requiredNode(), without(REQUIRED_TREE, key)))
    for (const key of optionalNodeKeys()) {
      for (const dirty of DIRTY_VALUES) {
        const raw = rawDocument({ ...requiredNode(), [key]: dirty })
        if (treeDocumentSchema.safeParse(raw).success) inputs.push(raw)
      }
    }

    for (const raw of inputs) {
      const bare = await openOver(raw as unknown as TreeDocument)
      const stacked = await openOver(treeDocumentSchema.parse(raw) as unknown as TreeDocument)
      expect(stacked.node).toEqual(bare.node)
      expect(stacked.tree).toEqual(bare.tree)
    }
  })

  it('reads the baseline holder, and a malformed baseline, the same on both paths', async () => {
    const valid = { corrections: 1, notes: 2, terminalChildren: 3, fingerprint: 'f', attempts: 1 }

    // A baseline written before `holder` existed: both sides fill `null` (= author unknown).
    const missingHolder = rawDocument(requiredNode({ dispatchBaseline: valid }))
    expect(field(treeDocumentSchema.parse(missingHolder).nodes[ROOT]?.dispatchBaseline ?? {}, 'holder')).toBeNull()
    expect(field((await openOver(missingHolder as unknown as TreeDocument)).node.dispatchBaseline ?? {}, 'holder'))
      .toBeNull()

    // A dirty holder is `null` on both sides rather than a fabricated author.
    const dirtyHolder = rawDocument(requiredNode({ dispatchBaseline: { ...valid, holder: 7 } }))
    expect(field(treeDocumentSchema.parse(dirtyHolder).nodes[ROOT]?.dispatchBaseline ?? {}, 'holder')).toBeNull()
    expect(field((await openOver(dirtyHolder as unknown as TreeDocument)).node.dispatchBaseline ?? {}, 'holder'))
      .toBeNull()

    // A partially-written baseline is not a weaker snapshot, it is a wrong one: zod's `.catch(null)`
    // and core's `asBaseline` both reject the whole object (rather than trusting invented numbers).
    const partial = rawDocument(requiredNode({ dispatchBaseline: { corrections: 1 } }))
    expect(treeDocumentSchema.parse(partial).nodes[ROOT]?.dispatchBaseline).toBeNull()
    expect((await openOver(partial as unknown as TreeDocument)).node.dispatchBaseline).toBeNull()
  })
})
