/**
 * Well-formed text on the mission tree: the inbound write funnel and the outbound prompt boundary.
 *
 * The defect is ONE shape (a lone UTF-16 surrogate) and it has exactly two jobs here — never let one
 * INTO the tree, and never let a stored one OUT into a model's context. The strict-parser evidence
 * behind it (`printf '"\\ud800"' | jq .` → `parse error: Invalid \uXXXX\uXXXX surrogate pair escape`)
 * is reproduced in comments on the source modules; these cases pin the behaviour.
 *
 * The local copy is the DEGRADATION path: the canonical repair is the base kit's, injected by the
 * plugin (`resolveWellFormed`). A tree constructed without an injected source must still repair,
 * which is what every case below except the injection one exercises.
 */
import { describe, expect, it } from 'vitest'
import {
  LOCAL_WELL_FORMED,
  MissionTree,
  buildProgressLine,
  buildWorkerPrompt,
  wellFormedDeep,
  wellFormedText,
  type DispatchView,
  type NodeRecord,
  type TreeState,
  type TreeStore,
  type WellFormedSource,
} from '../src/index.js'

// ── the defect's shapes ───────────────────────────────────────────────────────────────────────
/** An unpaired HIGH half (`D800–DBFF`): half of an emoji, with nothing after it. */
const LONE_HIGH = '\uD800'
/** An unpaired LOW half (`DC00–DFFF`): the second half with no first. */
const LONE_LOW = '\uDC00'
/** Half of 😀 (its high half only) — the shape a bad truncation produces. */
const HALF_EMOJI = 'x\uD83D'
/** A COMPLETE astral character: must survive untouched. */
const EMOJI = '\u{1F600}'
/** A CJK Extension B character (`𠮷`): astral, must survive untouched. */
const CJK_EXT_B = '\u{20BB7}'
/** The characters a naive "strip non-ASCII" repair would also mangle; all must survive byte-for-byte. */
const PUNCT = 'quote " backslash \\ newline \n tab \t'

/** `String.prototype.isWellFormed` where the engine has it, and an equivalent scan where it does not. */
function isWellFormed(value: string): boolean {
  const native = (String.prototype as { isWellFormed?: () => boolean }).isWellFormed
  if (typeof native === 'function') return native.call(value)
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
      continue
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

/** Every string reachable inside a node, with the field name that carries it (for a readable failure). */
function stringsOfNode(node: NodeRecord): [string, string][] {
  const fields: [string, string][] = [
    ['title', node.title],
    ['description', node.description],
    ['result', node.result ?? ''],
    ['resultRef', node.resultRef ?? ''],
    ['resultHint', node.resultHint ?? ''],
    ['unit', node.unit ?? ''],
    ...node.context.map((text, index): [string, string] => [`context[${String(index)}]`, text]),
    ...node.corrections.map((text, index): [string, string] => [`corrections[${String(index)}]`, text]),
    ...node.analysisNotes.map((text, index): [string, string] => [`analysisNotes[${String(index)}]`, text]),
  ]
  return fields
}

/** Assert every string a node carries is well-formed. */
function expectNodeWellFormed(node: NodeRecord | undefined): void {
  expect(node).toBeDefined()
  if (node === undefined) return
  for (const [field, value] of stringsOfNode(node)) {
    expect(isWellFormed(value), `${field} carries a lone surrogate: ${JSON.stringify(value)}`).toBe(true)
  }
}

/** An in-memory store (the same shape `tree.spec.ts` uses). */
function memoryStore(): TreeStore {
  const documents = new Map<string, TreeState>()
  return {
    loadAll: () => Promise.resolve([...documents.values()]),
    put: (state) => {
      documents.set(state.tree.rootId, state)
      return Promise.resolve()
    },
    remove: (rootId) => {
      documents.delete(rootId)
      return Promise.resolve()
    },
  }
}

/** A tree with a controllable clock, live set and id sequence; `wellFormed` injects a source. */
function makeTree(wellFormed?: WellFormedSource): MissionTree {
  const live = new Set<string>(['owner'])
  let tick = 0
  let sequence = 0
  return new MissionTree(memoryStore(), {
    isAgentLive: (sessionId) => live.has(sessionId),
    probeOwner: () => Promise.resolve({ kind: 'exists' as const }),
    spill: (text) => Promise.resolve({ locator: `spill:${String(text.length)}`, hint: 'read it with the read tool' }),
    now: () => (tick += 1),
    newId: () => `n${String(++sequence).padStart(4, '0')}`,
    ...(wellFormed === undefined ? {} : { wellFormed }),
  })
}

/** Root a tree with the given (possibly defective) strings; returns the root id. */
async function root(tree: MissionTree, input: { title: string; description: string; analysis: readonly string[] }): Promise<string> {
  const created = await tree.createRoot({ ownerSessionId: 'owner', ...input })
  if (!created.ok) throw new Error(`root creation failed: ${created.message}`)
  return created.value.id
}

/** Dispatch a node and return the claim id it is bound to. */
async function dispatch(tree: MissionTree, nodeId: string, claim = 'mission-1'): Promise<string> {
  const decision = await tree.dispatch(nodeId, claim)
  if (!decision.ok) throw new Error(`dispatch failed: ${decision.message}`)
  return claim
}

describe('the local repair (the degradation copy)', () => {
  it('replaces every unpaired surrogate and leaves paired astral characters alone', () => {
    expect(wellFormedText(LONE_HIGH)).toBe('\uFFFD')
    expect(wellFormedText(LONE_LOW)).toBe('\uFFFD')
    expect(wellFormedText(HALF_EMOJI)).toBe('x\uFFFD')
    expect(wellFormedText(EMOJI)).toBe(EMOJI)
    expect(wellFormedText(CJK_EXT_B)).toBe(CJK_EXT_B)
    expect(isWellFormed(wellFormedText(EMOJI))).toBe(true)
  })

  it('touches nothing else: quotes, backslashes, newlines and tabs come back byte-for-byte', () => {
    expect(wellFormedText(PUNCT)).toBe(PUNCT)
  })

  it('is idempotent', () => {
    const once = wellFormedText(`${LONE_HIGH}${EMOJI}${HALF_EMOJI}`)
    expect(wellFormedText(once)).toBe(once)
  })

  it('repairs a whole JSON shape recursively, including keys, without changing any type', () => {
    const withBadKey: Record<string, unknown> = {}
    withBadKey[`k${LONE_HIGH}`] = `v${LONE_LOW}`
    withBadKey['count'] = 3
    withBadKey['flag'] = true
    withBadKey['nested'] = { deep: LONE_HIGH, keep: EMOJI }
    const repaired = wellFormedDeep(withBadKey)
    expect(Object.keys(repaired).every((key) => isWellFormed(key))).toBe(true)
    expect(repaired['k\uFFFD']).toBe('v\uFFFD')
    expect(repaired['count']).toBe(3)
    expect(repaired['flag']).toBe(true)
    expect((repaired['nested'] as { deep: string }).deep).toBe('\uFFFD')
    expect((repaired['nested'] as { keep: string }).keep).toBe(EMOJI)
    // A Date is a different TYPE: it must come back by identity, never as `{}`.
    const date = new Date(0)
    expect(wellFormedDeep(date)).toBe(date)
  })

  it('exposes the same pair as the degradation source', () => {
    expect(LOCAL_WELL_FORMED.text(LONE_HIGH)).toBe('\uFFFD')
    expect(LOCAL_WELL_FORMED.deep(['a', LONE_LOW])).toEqual(['a', '\uFFFD'])
  })
})

describe('inbound: the tree write funnel', () => {
  it('repairs create_mission title / description / analysis at the single root entry', async () => {
    const tree = makeTree()
    const id = await root(tree, {
      title: `Ship ${LONE_HIGH} it`,
      description: `Move every caller ${HALF_EMOJI}`,
      analysis: [`v1 is deprecated ${LONE_LOW}`, `keep ${EMOJI} and ${CJK_EXT_B}`, PUNCT],
    })
    const node = tree.node(id)
    expectNodeWellFormed(node)
    // The good characters are not collateral damage.
    expect(node?.title).toBe('Ship \uFFFD it')
    expect(node?.description).toBe('Move every caller x\uFFFD')
    expect(node?.context[1]).toBe(`keep ${EMOJI} and ${CJK_EXT_B}`)
    expect(node?.context[2]).toBe(PUNCT)
  })

  it('repairs decompose_mission title / description / context / unit for every child', async () => {
    const tree = makeTree()
    const id = await root(tree, { title: 'Root', description: 'Split me', analysis: [] })
    await dispatch(tree, id)
    await tree.recordAnalysis(id, 'mission-1', 'why')
    const split = await tree.decompose(id, 'mission-1', [
      { title: `child ${LONE_HIGH}`, description: `desc ${LONE_LOW}`, context: [`why ${HALF_EMOJI}`], unit: `/tmp/${LONE_HIGH}` },
      { title: `child ${EMOJI}`, description: 'fine', context: [CJK_EXT_B] },
    ])
    expect(split.ok).toBe(true)
    if (!split.ok) return
    for (const childId of split.value.created) expectNodeWellFormed(tree.node(childId))
    // A well-formed child is not rewritten.
    const good = split.value.created[1] ?? ''
    expect(tree.node(good)?.title).toBe(`child ${EMOJI}`)
    expect(tree.node(good)?.context[0]).toBe(CJK_EXT_B)
  })

  it('repairs note_mission (recordAnalysis) before storing', async () => {
    const tree = makeTree()
    const id = await root(tree, { title: 'Root', description: 'Work', analysis: [] })
    await dispatch(tree, id)
    const noted = await tree.recordAnalysis(id, 'mission-1', `blocked on ${LONE_HIGH} premise`)
    expect(noted.ok).toBe(true)
    expectNodeWellFormed(tree.node(id))
    expect(tree.node(id)?.analysisNotes[0]).toContain('\uFFFD')
  })

  it('repairs submit_mission (submitResult) before storing', async () => {
    const tree = makeTree()
    const id = await root(tree, { title: 'Root', description: 'Work', analysis: [] })
    await dispatch(tree, id)
    const submitted = await tree.submitResult(id, 'mission-1', `done ${HALF_EMOJI}`)
    expect(submitted.ok).toBe(true)
    expectNodeWellFormed(tree.node(id))
    expect(tree.node(id)?.result).toBe('done x\uFFFD')
  })

  it('repairs adjust_mission (correct) before the duplicate check', async () => {
    const tree = makeTree()
    const id = await root(tree, { title: 'Root', description: 'Work', analysis: [] })
    const corrected = await tree.correct(id, 'owner', `instead do ${LONE_LOW}`)
    expect(corrected.ok).toBe(true)
    expectNodeWellFormed(tree.node(id))
    expect(tree.node(id)?.corrections).toEqual(['instead do \uFFFD'])
    // The idempotent repair also means the duplicate check cannot be defeated by the defect: the same
    // correction arriving once with a lone surrogate and once clean is ONE correction.
    await tree.correct(id, 'owner', 'instead do \uFFFD')
    expect(tree.node(id)?.corrections).toEqual(['instead do \uFFFD'])
  })

  it('uses an INJECTED source (how the plugin hands over the loaded base kit)', async () => {
    const calls = { text: 0, deep: 0 }
    const injected: WellFormedSource = {
      text: (value) => {
        calls.text += 1
        return wellFormedText(value)
      },
      deep: (value) => {
        calls.deep += 1
        return wellFormedDeep(value)
      },
    }
    const tree = makeTree(injected)
    const id = await root(tree, { title: `t${LONE_HIGH}`, description: 'd', analysis: ['a'] })
    expect(calls.deep).toBeGreaterThan(0)
    await dispatch(tree, id)
    await tree.recordAnalysis(id, 'mission-1', `n${LONE_HIGH}`)
    expect(calls.text).toBeGreaterThan(0)
    expectNodeWellFormed(tree.node(id))
  })
})

describe('outbound: the worker prompt boundary', () => {
  function badNode(overrides: Partial<NodeRecord> = {}): NodeRecord {
    return {
      id: 'n0001',
      rootId: 'n0001',
      parentId: null,
      title: 'Root',
      description: 'Work',
      unit: null,
      weight: 1,
      roundMs: null,
      context: [],
      corrections: [],
      correctionsDeliveredUpTo: 0,
      analysisNotes: [],
      analysisAttempt: 0,
      analysisAuthor: null,
      status: 'running',
      createdAt: 1,
      dispatchedAt: null,
      endedAt: null,
      depth: 1,
      claimedBy: 'mission-1',
      claimedAt: 1,
      attempts: 1,
      failures: 0,
      spawnFailures: 0,
      parkedWorker: null,
      lastWorkerId: null,
      executorSessionId: 'mission-1',
      executorReleasedAt: null,
      dispatchBaseline: null,
      progressAt: 0,
      activityAt: 0,
      stalls: 0,
      hungCount: 0,
      stalledNotifiedAt: null,
      result: null,
      hasResult: false,
      resultReadAt: null,
      resultRef: null,
      resultHint: null,
      children: [],
      updatedAt: 1,
      ...overrides,
    }
  }

  it('repairs a wholly defective view (node, chain, children) before assembling anything', () => {
    const child = badNode({
      id: 'n0002',
      title: `child ${LONE_HIGH}`,
      status: 'done',
      hasResult: true,
      result: `body ${HALF_EMOJI}`,
      resultRef: `/tmp/${LONE_LOW}`,
    })
    const view: DispatchView = {
      node: badNode({
        title: `root ${LONE_HIGH}`,
        description: `desc ${LONE_LOW}`,
        context: [`fact ${HALF_EMOJI}`],
        analysisNotes: [`note ${LONE_HIGH}`],
        corrections: [`fix ${LONE_LOW}`],
      }),
      chain: [badNode({ id: 'n0000', title: `ancestor ${HALF_EMOJI}` })],
      children: [child],
    }
    const prompt = buildWorkerPrompt(view, { corrections: [`only ${LONE_HIGH}`] })
    expect(isWellFormed(prompt), `prompt carries a lone surrogate: ${JSON.stringify(prompt)}`).toBe(true)
    // The good characters survive.
    expect(prompt).toContain('\uFFFD')
    expect(prompt).toContain('child')
  })

  it('repairs the guidance progress line too (same file, same outbound rule)', () => {
    const line = buildProgressLine({ roots: [badNode({ status: 'done', title: `root ${LONE_HIGH}` })], ongoing: 0, troubled: false })
    expect(isWellFormed(line)).toBe(true)
  })

  it('uses an INJECTED source', () => {
    let calls = 0
    const injected: WellFormedSource = {
      text: wellFormedText,
      deep: (value) => {
        calls += 1
        return wellFormedDeep(value)
      },
    }
    const prompt = buildWorkerPrompt({ node: badNode({ title: LONE_HIGH }), chain: [], children: [] }, {}, injected)
    expect(calls).toBeGreaterThan(0)
    expect(isWellFormed(prompt)).toBe(true)
  })
})
