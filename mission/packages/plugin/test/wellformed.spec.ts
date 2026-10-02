/**
 * Well-formed text on the plugin's boundaries: the base-kit resolution, the inbound tool paths, the
 * outbound tool render, and the historical-bad-data cases.
 *
 * The defect is one lone UTF-16 surrogate. `JSON.stringify` emits it verbatim (`"\ud800"`), JS's own
 * `JSON.parse` accepts it, and a strict consumer rejects the whole document — measured:
 * `printf '"\\ud800"' | jq .` → `parse error: Invalid \uXXXX\uXXXX surrogate pair escape`. Node's
 * `isWellFormed` / `toWellFormed` (Node ≥20) is the repair.
 *
 * The real plugin mount runs here, so the tree, the tool registry and the worker prompt are the
 * production ones; `wellformed-mount.spec.ts` is the sibling that varies WHICH base the plugin loads.
 */
import { describe, expect, it } from 'vitest'
import * as realBase from '@avantf/dsh-plugin-base'
import {
  LOCAL_WELL_FORMED,
  buildWorkerPrompt,
  wellFormedDeep,
  type NodeRecord,
} from '@avantf/mission-core'
import { resolveWellFormed } from '../src/wellformed.js'
import { persistedTree, WORKER } from './fixtures.js'
import { callTool, executorFor, mount, type Mounted } from './mount.js'

// ── the defect's shapes ───────────────────────────────────────────────────────────────────────
const LONE_HIGH = '\uD800'
const LONE_LOW = '\uDC00'
const HALF_EMOJI = 'x\uD83D'
const EMOJI = '\u{1F600}'
const CJK_EXT_B = '\u{20BB7}'
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

/** Every string a node carries, for a readable failure message. */
function nodeStrings(node: NodeRecord): [string, string][] {
  return [
    ['title', node.title],
    ['description', node.description],
    ['result', node.result ?? ''],
    ...node.context.map((text, index): [string, string] => [`context[${String(index)}]`, text]),
    ...node.corrections.map((text, index): [string, string] => [`corrections[${String(index)}]`, text]),
    ...node.analysisNotes.map((text, index): [string, string] => [`analysisNotes[${String(index)}]`, text]),
  ]
}

function expectNodeWellFormed(node: NodeRecord | undefined): void {
  expect(node).toBeDefined()
  if (node === undefined) return
  for (const [field, value] of nodeStrings(node)) {
    expect(isWellFormed(value), `${field}: ${JSON.stringify(value)}`).toBe(true)
  }
}

/** Render one registered tool's answer the way the model receives it (the terminal text block). */
function renderTool(mounted: Mounted, name: string, value: unknown): string {
  const tool = mounted.registered.find((entry) => entry.name === name)
  if (tool?.output === undefined) throw new Error(`tool ${name} has no output contract`)
  return tool.output.render({}, value).map((block) => block.text).join('')
}

describe('resolveWellFormed: base kit first, local copy as the degradation', () => {
  it('takes the loaded base kit when it carries both functions (interface v2)', () => {
    const resolved = resolveWellFormed(realBase)
    expect(resolved.text).toBe(realBase.wellFormedText)
    expect(resolved.deep).toBe(realBase.wellFormedDeep)
    // Both halves repair; the well-formed characters are untouched.
    expect(resolved.text(`a${LONE_HIGH}b`)).toBe('a\uFFFDb')
    expect(resolved.deep([EMOJI, CJK_EXT_B])).toEqual([EMOJI, CJK_EXT_B])
  })

  it('falls back to the local copy when the base is absent, or older than v2, or half-populated', () => {
    expect(resolveWellFormed(undefined)).toBe(LOCAL_WELL_FORMED)
    // A v1 base: a module with the kit's OTHER members but neither of the two well-formed functions.
    const v1Base: Record<string, unknown> = { PromptFiles: class {}, resolveDataHome: () => '/tmp' }
    expect(resolveWellFormed(v1Base)).toBe(LOCAL_WELL_FORMED)
    // Half-populated is not a usable source: two halves must give the same answer.
    expect(resolveWellFormed({ wellFormedText: (value: string) => value })).toBe(LOCAL_WELL_FORMED)
    expect(resolveWellFormed({ wellFormedDeep: (value: unknown) => value })).toBe(LOCAL_WELL_FORMED)
    // The fallback still repairs.
    expect(resolveWellFormed(undefined).text(LONE_HIGH)).toBe('\uFFFD')
  })

  it('produces the same repair from either source', () => {
    const base = resolveWellFormed(realBase)
    const local = resolveWellFormed(undefined)
    const sample = { title: `a${LONE_HIGH}`, list: [`b${LONE_LOW}`, EMOJI, CJK_EXT_B, PUNCT] }
    expect(base.deep(sample)).toEqual(local.deep(sample))
  })
})

describe('inbound: the tool paths into the tree', () => {
  it('repairs create_mission and note_mission before the text is stored', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_mission',
      { title: `Ship ${LONE_HIGH}`, description: `Move every caller ${HALF_EMOJI}`, analysis: [`note ${LONE_LOW}`] },
      mounted.owner,
    )
    expect(created.ok, created.summary).toBe(true)
    const root = String(created.data?.['root_id'] ?? '')
    expectNodeWellFormed(mounted.nodeFor(root))
    expect(mounted.nodeFor(root)?.title).toBe('Ship \uFFFD')

    const worker = executorFor(mounted, root)
    const noted = await callTool(mounted, 'note_mission', { node_id: root, analysis: `blocked ${LONE_HIGH} premise` }, worker)
    expect(noted.ok, noted.summary).toBe(true)
    expectNodeWellFormed(mounted.nodeFor(root))
    expect(mounted.nodeFor(root)?.analysisNotes[0]).toBe('blocked \uFFFD premise')
  })

  it('repairs decompose_mission children (title / description / context) at the single entry', async () => {
    const mounted = await mount()
    const created = await callTool(
      mounted,
      'create_mission',
      { title: 'Split me', description: 'Work', analysis: [] },
      mounted.owner,
    )
    const root = String(created.data?.['root_id'] ?? '')
    const worker = executorFor(mounted, root)
    const noted = await callTool(mounted, 'note_mission', { node_id: root, analysis: 'why' }, worker)
    expect(noted.ok).toBe(true)
    const split = await callTool(
      mounted,
      'decompose_mission',
      {
        node_id: root,
        children: [
          { title: `child ${LONE_HIGH}`, description: `desc ${LONE_LOW}`, context: [`why ${HALF_EMOJI}`] },
          { title: `child ${EMOJI}`, description: 'fine', context: [`keep ${CJK_EXT_B}`] },
        ],
      },
      worker,
    )
    expect(split.ok, split.summary).toBe(true)
    const created2 = (split.data?.['created'] as string[] | undefined) ?? []
    expect(created2).toHaveLength(2)
    for (const id of created2) expectNodeWellFormed(mounted.nodeFor(id))
    expect(mounted.nodeFor(created2[1] ?? '')?.title).toBe(`child ${EMOJI}`)
    expect(mounted.nodeFor(created2[1] ?? '')?.context[0]).toBe(`keep ${CJK_EXT_B}`)
  })

  it('repairs submit_mission before storing the result', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_mission', { title: 'Root', description: 'Work', analysis: [] }, mounted.owner)
    const root = String(created.data?.['root_id'] ?? '')
    const worker = executorFor(mounted, root)
    const submitted = await callTool(mounted, 'submit_mission', { node_id: root, result: `done ${HALF_EMOJI}` }, worker)
    expect(submitted.ok, submitted.summary).toBe(true)
    expectNodeWellFormed(mounted.nodeFor(root))
    expect(mounted.nodeFor(root)?.result).toBe('done x\uFFFD')
  })

  it('repairs adjust_mission before the correction is stored', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_mission', { title: 'Root', description: 'Work', analysis: [] }, mounted.owner)
    const root = String(created.data?.['root_id'] ?? '')
    const adjusted = await callTool(mounted, 'adjust_mission', { root_id: root, adjustment: `instead do ${LONE_LOW}` }, mounted.owner)
    expect(adjusted.ok, adjusted.summary).toBe(true)
    expectNodeWellFormed(mounted.nodeFor(root))
    expect(mounted.nodeFor(root)?.corrections).toEqual(['instead do \uFFFD'])
  })

  it('repairs the /mission command text entry, including the title slice', async () => {
    const mounted = await mount()
    // 78 ASCII chars then an emoji then more: `TITLE_MAX` is 80, so the ellipsis slice cuts the
    // emoji in half and MANUFACTURES a lone surrogate out of well-formed input.
    const longTitle = `${'x'.repeat(78)}${EMOJI}tail`
    const result = await mounted.runCommand('mission', `${longTitle}\nbody ${HALF_EMOJI}`, mounted.owner)
    expect(result.kind).toBe('success')
    expect(isWellFormed(result.text ?? '')).toBe(true)
    const rootId = /\[([0-9a-f]{8})\]/u.exec(result.text ?? '')?.[1]
    expect(rootId).toBeDefined()
    const node = mounted.nodeFor(String(rootId))
    expectNodeWellFormed(node)
    expect(node?.title).toContain('\uFFFD')
  })
})

describe('outbound: the tool result boundary', () => {
  it('repairs the SUMMARY branch before it becomes the terminal text', async () => {
    const mounted = await mount()
    const created = await callTool(mounted, 'create_mission', { title: 'Root', description: 'Work', analysis: [] }, mounted.owner)
    const root = String(created.data?.['root_id'] ?? '')
    // A result has to exist before `mission_result` will read the node.
    const submitted = await callTool(mounted, 'submit_mission', { node_id: root, result: `the body ${HALF_EMOJI}` }, executorFor(mounted, root))
    expect(submitted.ok, submitted.summary).toBe(true)
    const read = await callTool(mounted, 'mission_result', { node_id: root }, mounted.owner)
    expect(read.ok, read.summary).toBe(true)
    const text = renderTool(mounted, 'mission_result', read)
    expect(isWellFormed(text), `summary text: ${JSON.stringify(text)}`).toBe(true)
    // The title and the body are both echoed into the summary, repaired.
    expect(text).toContain('Root')
    expect(text).toContain('the body x\uFFFD')
  })

  it('repairs the JSON branch recursively, so the text parses and is well-formed throughout', async () => {
    const mounted = await mount()
    // The JSON branch is taken when there is no string `summary`; no live tool produces that, so the
    // contract is driven directly. This is the case the requirement names: `JSON.parse` must succeed
    // AND every string inside must be well-formed — JS's parser accepts a lone surrogate, which is
    // exactly why "it parsed" alone would prove nothing.
    const text = renderTool(mounted, 'mission_result', {
      ok: false,
      data: { title: `a${LONE_HIGH}`, notes: [`b${HALF_EMOJI}`, EMOJI, CJK_EXT_B] },
    })
    expect(isWellFormed(text)).toBe(true)
    const parsed = JSON.parse(text) as { data: { title: string; notes: string[] } }
    expect(isWellFormed(parsed.data.title)).toBe(true)
    expect(parsed.data.title).toBe('a\uFFFD')
    expect(parsed.data.notes[0]).toBe('bx\uFFFD')
    // The good characters survive the round trip.
    expect(parsed.data.notes[1]).toBe(EMOJI)
    expect(parsed.data.notes[2]).toBe(CJK_EXT_B)
  })
})

describe('historical bad data: a tree written before the inbound funnel existed', () => {
  /**
   * One persisted document with a lone surrogate in the fields the two boundaries read.
   * `done` carries a result so `mission_result` can read it; `ready` is what the engine can dispatch,
   * which is how the worker-prompt boundary is driven through the real host.
   */
  async function seededBadTree(kind: 'ready' | 'done'): Promise<{ document: Awaited<ReturnType<typeof persistedTree>>; rootId: string }> {
    const document = await persistedTree({ workerId: WORKER, dispatched: false })
    const rootId = document.tree.rootId
    const stored = document.nodes[rootId] as NodeRecord
    document.nodes[rootId] = {
      ...stored,
      title: `old title ${LONE_HIGH}`,
      description: `old body ${HALF_EMOJI}`,
      context: [`old fact ${LONE_LOW}`],
      ...(kind === 'done'
        ? { status: 'done' as const, hasResult: true, result: `old result ${HALF_EMOJI}` }
        : {}),
    }
    return { document, rootId }
  }

  it('① the tool result is still well-formed', async () => {
    const { document, rootId } = await seededBadTree('done')
    const mounted = await mount({ seedDocuments: [document] })
    const read = await callTool(mounted, 'mission_result', { node_id: rootId }, mounted.owner)
    expect(read.ok, read.summary).toBe(true)
    const text = renderTool(mounted, 'mission_result', read)
    expect(isWellFormed(text), `tool text: ${JSON.stringify(text)}`).toBe(true)
    expect(text).toContain('old title \uFFFD')
  })

  it('② the dispatched worker prompt is still well-formed', async () => {
    const { document, rootId } = await seededBadTree('ready')
    const mounted = await mount({ seedDocuments: [document] })
    // `dispatched: false` left the node ready, so the engine dispatches it here and the host builds
    // the prompt through the REAL boundary (`buildWorkerPrompt(view, {}, host.wellFormed)`).
    await mounted.flush()
    const prompt = mounted.dispatched.find((entry) => entry.prompt.includes(rootId))?.prompt ?? ''
    expect(prompt).not.toBe('')
    expect(isWellFormed(prompt), `worker prompt: ${JSON.stringify(prompt)}`).toBe(true)
    expect(prompt).toContain('old title \uFFFD')
  })

  it('③ the prompt builder itself repairs a view built straight from stored bad data', async () => {
    const { document, rootId } = await seededBadTree('done')
    const mounted = await mount({ seedDocuments: [document] })
    const node = mounted.nodeFor(rootId)
    expect(node).toBeDefined()
    if (node === undefined) return
    // No repair at load: the in-memory node still carries the defect, so this isolates the OUTBOUND
    // half from the inbound funnel (which cannot have touched a seeded document).
    expect(node.title).toContain(LONE_HIGH)
    // The host's own resolved pair (the loaded base kit here) is what production threads in.
    const prompt = buildWorkerPrompt({ node, chain: [], children: [] }, {}, mounted.host.wellFormed)
    expect(isWellFormed(prompt)).toBe(true)
    expect(wellFormedDeep(node).title).toContain('\uFFFD')
  })
})
