/**
 * The host→client projection has to reach the client WITH ITS KEYS.
 *
 * WHY THIS SPEC EXISTS (package S, item S4). Both halves of this plugin are built with Typert
 * `strict` codecs, and a strict codec DROPS a key it does not name — silently, and **without failing
 * `safeParse`**. So "the schema accepted the payload" proves nothing about the fields the panel
 * renders; the assertion that does is a KEY-SET comparison against what the host actually emitted.
 * Until now every host-output assertion in this tree fed a hand-written fixture to a schema; nothing
 * fed a REAL payload from a mounted runtime to the codec the client half is generated against.
 *
 * WHAT IS "REAL" HERE. The runtime is built and exercised for real (`buildRuntime` + writes + reads),
 * and the payloads below are its own return values — the same values `AvantfMemGateway.call()`
 * forwards after `dispatchToolKey` (it only wraps them in the `{ok,value,wire}` envelope). The
 * UI-only methods are produced by their real host functions (`classifySource`, `browseDirectory`,
 * `KnowledgeStore.domainCatalog`/`addDomain`, `openDocumentPath`), not by literals.
 *
 * THE TWO DIRECTIONS ARE BOTH COVERED, and they are NOT symmetrical:
 *
 *   - RESULT codecs are `z.any()` by design ("never reject a host reply"), so a host field added in a
 *     later release must survive untouched. The pin is deep equality: anything a stricter codec would
 *     drop shows up as a difference.
 *   - ARGS codecs ARE strict zod objects (the reason the 矛盾裁决 buttons and 「认领文件」 shipped
 *     broken): a field the client sends that the face does not name is silently removed before the
 *     call leaves. The pin there is `keys(parsed) ⊇ keys(request)`, checked on the object the
 *     CONTRACT accepts — what a client call is built from.
 *
 * `test/remote_wire.spec.ts` covers the args direction at the SCHEMA level (declared ⊇ contract union
 * fields). This spec is the VALUE-level half: the real objects, through the real codecs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { buildRuntime, browseDirectory, classifySource, type AvantfRuntime } from '@avantf/mem'
import { ADMIN_TOOL, KB_TOOL, QUERY_TOOL, RECALL_TOOL, REMEMBER_TOOL, type ToolSpec } from '@avantf/mem-contract'
import { descriptors } from '../src/remote.js'
import { openDocumentPath } from '../src/open.js'

/** No model, no download: this spec is about wire keys, and the plugin's vitest env has downloads off. */
const semantic = {
  name: 'host_pin_never_warm',
  dim: 768,
  isAvailable: (): boolean => false,
  async encode(): Promise<Float32Array> { throw new Error('no model') },
  async encodeBatch(): Promise<Float32Array[]> { throw new Error('no model') },
}

let dir: string
let rt: AvantfRuntime

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'avf-hostpin-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic })
})
afterAll(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/** What one `safeParse` tells us; only the two members this spec reads. */
type ParseResult = { success: true; data: unknown } | { success: false }

/** Run one wire codec's schema (`{mode, typeSymbol, schema, create}`) the way the harness does. */
function parseThrough(codec: unknown, value: unknown): ParseResult {
  const schema = (codec as { schema: { safeParse(input: unknown): ParseResult } }).schema
  expect(typeof schema?.safeParse, 'the descriptor must carry a codec schema').toBe('function')
  return schema.safeParse(value)
}

function descriptorOf(method: string): { parameters: readonly { codec: unknown }[]; result: unknown } {
  const descriptor = descriptors.find((entry) => entry.method === method)
  expect(descriptor, `descriptor '${method}' must exist`).toBeDefined()
  return descriptor as unknown as { parameters: readonly { codec: unknown }[]; result: unknown }
}

/**
 * The assertion S4 asks for: `success` is necessary and NOT sufficient.
 *
 * `toEqual` on the WHOLE parsed value is the strictest form of "no key was dropped": a strict codec
 * that forgot one field still returns `success: true`, but the parsed object would then be missing
 * that key (and any nested one) — which is exactly what a key-set-only check on the top level can
 * still miss.
 */
function expectKeysSurvive(codec: unknown, value: Record<string, unknown>, label: string): void {
  const parsed = parseThrough(codec, value)
  expect(parsed.success, `${label}: the real payload must parse`).toBe(true)
  if (!parsed.success) return
  expect(Object.keys(parsed.data as Record<string, unknown>), `${label}: emitted keys`).toEqual(
    expect.arrayContaining(Object.keys(value)),
  )
  expect(parsed.data, `${label}: payload unchanged (no key dropped at any depth)`).toEqual(value)
}

/** The real payload each Remote method answers with, produced below by the mounted runtime. */
async function realHostOutputs(): Promise<Record<string, Record<string, unknown>>> {
  const fact = await rt.remember({ action: 'add', content: '宿主投影 pin 的事实：发布窗口由陈静负责', category: 'pin' })
  await rt.kb({ action: 'ingest', text: '# 宿主投影\n\n这份资料的正文只用来做一次真实投影检查。', domain: 'notes', source: 'pin', title: '宿主投影' })
  // `kb list` answers an ARRAY (`DocumentSummary[]`); the projection pin needs an OBJECT payload, so
  // the real `kb detail` answer is used and the id comes from the real listing.
  const docs = (await rt.kb({ action: 'list', domain: 'notes' })) as unknown as { doc_id: number }[]
  expect(docs.length, 'the ingest above must produce one document').toBeGreaterThan(0)
  const docId = (docs[0] as { doc_id: number }).doc_id
  const managedPath = rt.knowledge.docFilePath(docId)
  expect(managedPath, 'the ingested document must have a managed file (used for a real OpenOutcome)').not.toBeNull()

  return {
    remember: fact as unknown as Record<string, unknown>,
    recall: (await rt.recall({ action: 'search', query: '发布窗口' })) as unknown as Record<string, unknown>,
    admin: rt.admin({ action: 'detail', fact_id: fact.fact_id }) as unknown as Record<string, unknown>,
    kb: (await rt.kb({ action: 'detail', doc_id: docId })) as unknown as Record<string, unknown>,
    query: (await rt.query({ query: '发布窗口', kind: 'all', limit: 10 })) as unknown as Record<string, unknown>,
    classifySource: classifySource('https://example.com/doc.md', rt.config.knowledge.ingest) as unknown as Record<string, unknown>,
    // `undefined` is the REAL default the picker opens with (and the gateway forwards when `path` is
    // absent): the workspace root the ingestion boundary already allows. Passing the temp dataHome
    // instead would be refused by that boundary — a real refusal, but not the projection this checks.
    browseDir: browseDirectory(undefined, rt.config.knowledge.ingest) as unknown as Record<string, unknown>,
    kbDomains: rt.knowledge.domainCatalog() as unknown as Record<string, unknown>,
    kbAddDomain: rt.knowledge.addDomain('pin-added') as unknown as Record<string, unknown>,
    // A real `OpenOutcome` with the side effect replaced: an EXPLICIT existing command
    // (`process.execPath`) goes through the real candidate resolution, and the injectable spawn is a
    // no-op, so nothing is launched. `knowledge.open` is a capture of the real return shape.
    openDoc: openDocumentPath(managedPath as string, 'file', process.execPath, {
      spawn: () => ({ unref: (): void => {} }),
      warn: (): void => {},
    }) as unknown as Record<string, unknown>,
  }
}

describe('the real host projection survives the wire codecs with its keys intact', () => {
  it('is NOT vacuous: a strict codec answers success while dropping the key (the S4 trap)', () => {
    // The mutation this spec exists to catch, demonstrated with the same zod generation the face
    // uses: a strict object that names no field accepts the payload — `safeParse().success` is TRUE —
    // and silently returns `{}`. Only a key-set (or deep) comparison can see it.
    const strictCodec = { schema: z.object({}) }
    const payload = { fact_id: 1, trust_score: 0.5, entities: ['陈静'] }
    const parsed = strictCodec.schema.safeParse(payload)
    expect(parsed.success).toBe(true)
    expect(Object.keys(parsed.data as Record<string, unknown>)).not.toEqual(expect.arrayContaining(Object.keys(payload)))
    // …and the helper below reports it, instead of leaving the drop invisible.
    expect(() => expectKeysSurvive(strictCodec, payload, 'strict-mutation')).toThrow()
  })

  it('has a real payload for every method the face publishes (the face itself decides the list)', () => {
    expect(descriptors).toHaveLength(10)
    expect(descriptors.map((d) => d.method).sort()).toEqual([
      'admin', 'browseDir', 'classifySource', 'kb', 'kbAddDomain', 'kbDomains', 'openDoc', 'query', 'recall', 'remember',
    ])
  })

  it('keeps every emitted key of every real host payload', async () => {
    const outputs = await realHostOutputs()
    for (const descriptor of descriptors) {
      const payload = outputs[descriptor.method]
      expect(payload, `a real payload for '${descriptor.method}' must be produced by the fixture`).toBeDefined()
      expect(Object.keys(payload as Record<string, unknown>).length).toBeGreaterThan(0)
      expectKeysSurvive(descriptorOf(descriptor.method).result, payload as Record<string, unknown>, descriptor.method)
    }
  })

  it('does NOT drop a host field the result codec never named (a stricter codec would go red here)', async () => {
    const outputs = await realHostOutputs()
    for (const descriptor of descriptors) {
      const withExtra = { ...(outputs[descriptor.method] as Record<string, unknown>), host_field_added_later: { nested: 1 } }
      // This is the S4 failure in its purest form: `z.any()` keeps it, a strict object would not —
      // and the strict version would still answer `success: true`.
      expectKeysSurvive(descriptorOf(descriptor.method).result, withExtra, `${descriptor.method} (+1 field)`)
    }
  })

  it('keeps every key of a contract-accepted request through the STRICT args codecs', () => {
    // The other direction, where a drop is a real (paid-for) bug: the args codec is a strict zod
    // object, and a request field it does not name never leaves the client.
    const requests: Record<string, { tool: ToolSpec; args: Record<string, unknown> }> = {
      remember: { tool: REMEMBER_TOOL, args: { action: 'add', content: '投影', category: 'c', ttl_days: 3, source_ref: 'session:s', event_date: '2026-01-02', valid_until: '2026-02-02' } },
      recall: { tool: RECALL_TOOL, args: { action: 'search', query: '投影', category: 'c', source: 's', limit: 5, max_tokens: 100, floors: 'strict', include_scores: true } },
      admin: { tool: ADMIN_TOOL, args: { action: 'list', category: 'c', status: 'active', source: 's', limit: 5, offset: 0 } },
      kb: { tool: KB_TOOL, args: { action: 'list', doc_id: 1, limit: 5, offset: 0, dry_run: true } },
      query: { tool: QUERY_TOOL, args: { query: '投影', kind: 'all', domain: 'notes', source: 'pin', limit: 5, max_tokens: 100, include_scores: true, floors: 'strict' } },
    }
    for (const [method, { tool, args }] of Object.entries(requests)) {
      const request = tool.input.parse(args) as Record<string, unknown>
      const descriptor = descriptorOf(method)
      const codec = descriptor.parameters[0]?.codec
      // Non-hollow by construction: the args codec IS strict, so it CAN drop a key.
      expect((codec as { mode?: string }).mode, `${method}: the args codec is strict`).toBe('strict')
      expectKeysSurvive(codec, request, `${method} args`)
    }
  })
})
