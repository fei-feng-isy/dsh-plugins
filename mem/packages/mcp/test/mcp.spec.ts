import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, supportsToolKey, type AvantfRuntime } from '@avantf/mem'
import { buildMcpServer, jsonSchema } from '../src/index.js'
import { REMEMBER_TOOL, QUERY_TOOL, TOOL_SPECS } from '@avantf/mem-contract'

let dir: string
let rt: AvantfRuntime
let server: Awaited<ReturnType<typeof buildMcpServer>>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'avf-mcp-'))
  rt = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db') })
  server = await buildMcpServer(rt)
})
afterAll(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/** A real CallTool request through the SDK handler, with its text envelope already parsed. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean | undefined; body: { ok: boolean; result?: unknown; error?: string; violations?: string[] } }> {
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (req: { method: string; params: { name: string; arguments: Record<string, unknown> } }) => Promise<{
      isError?: boolean
      content: { type: string; text: string }[]
    }>>
  })._requestHandlers.get('tools/call')!
  const res = await handler({ method: 'tools/call', params: { name, arguments: args } })
  return {
    isError: res.isError,
    body: JSON.parse(res.content[0].text) as { ok: boolean; result?: unknown; error?: string; violations?: string[] },
  }
}

describe('MCP server', () => {
  it('builds a Server with the tools capability', () => {
    expect(server).toBeDefined()
    expect(server.getClientVersion || true).toBeTruthy()
    const caps = (server as unknown as { _capabilities?: unknown })._capabilities
    expect(caps).toBeDefined()
  })

  it('derives a full JSON schema from the contract (action enum + typed, described fields)', () => {
    const schema = jsonSchema(REMEMBER_TOOL) as {
      type: string
      required?: string[]
      properties: Record<string, { type?: string; description?: string; enum?: string[] }>
    }
    expect(schema.type).toBe('object')
    expect(schema.properties.action.enum).toContain('add')
    expect(schema.properties.action.enum).toContain('remove')
    expect(schema.required).toContain('action')
    // Per-action fields are present with types + descriptions (previously the
    // MCP inputSchema exposed ONLY the action enum).
    expect(schema.properties.content?.type).toBe('string')
    expect(schema.properties.content?.description).toBeTruthy()
    expect(schema.properties.ttl_days?.type).toBe('integer')
    const querySchema = jsonSchema(QUERY_TOOL) as { required?: string[]; properties: Record<string, { type?: string }> }
    expect(querySchema.required).toContain('query')
    expect(querySchema.properties.kind?.type).toBe('string')
  })

  it('exposes exactly the contract tool set, and dispatches every one of them', async () => {
    // Derived from the contract, not retyped: a hand-maintained list here is what let the split
    // knowledge tools ship advertised-but-broken (the server's `tools/list` came from TOOL_SPECS
    // while its dispatcher still knew only the five older keys, so all four `kb_*` calls answered
    // `unknown tool key`). Asserting the count is not enough — the KEY SET has to reach a handler.
    const names = TOOL_SPECS.map((s) => s.name)
    expect(names).toEqual(['mem_remember', 'mem_recall', 'mem_admin', 'kb_add', 'kb_list', 'kb_remove', 'kb_reindex', 'kb_query'])
    for (const spec of TOOL_SPECS) {
      expect(supportsToolKey(spec.key), `${spec.name} (key '${spec.key}') must dispatch`).toBe(true)
    }
  })

  it('answers a tools/call for each knowledge tool instead of `unknown tool key`', async () => {
    // The regression, pinned at the protocol surface: a real CallTool request per advertised name.
    const added = await callTool('kb_add', { domain: 'notes', source: 'default', text: '# MCP\n\n正文一段。' })
    expect(added.isError).toBeUndefined()
    const docId = (added.body.result as { doc_id: number }).doc_id
    expect(docId).toBeGreaterThan(0)

    const listed = await callTool('kb_list', { doc_id: docId })
    expect(listed.isError).toBeUndefined()
    expect((listed.body.result as { doc_id: number }).doc_id).toBe(docId)

    const reindexed = await callTool('kb_reindex', { dry_run: true })
    expect(reindexed.isError).toBeUndefined()

    const removed = await callTool('kb_remove', { doc_id: docId })
    expect(removed.isError).toBeUndefined()
  })

  it('dispatch routes to the runtime', async () => {
    const { dispatchTool } = await import('../src/index.js')
    const res = await dispatchTool(rt, 'remember', { action: 'add', content: '陈静加入平台组' })
    expect((res as { fact_id: number; is_new: boolean }).is_new).toBe(true)
  })

  it('shapes mem_admin fact views for the model, but keeps diagnostics on request', async () => {
    // The MCP dispatch IS a model-facing boundary: a fact view must not carry the retention
    // diagnostics (trust value, forget clock, reinforcement counter), while a diagnostic the
    // caller asked for by name passes through — and the runtime itself keeps everything for
    // the Remote gateway that drives the operator UI.
    const { dispatchTool } = await import('../src/index.js')
    const created = await dispatchTool(rt, 'remember', { action: 'add', content: '形状检查的事实' }) as { fact_id: number }

    const page = await dispatchTool(rt, 'admin', { action: 'list', limit: 5 }) as { facts: Record<string, unknown>[] }
    expect(page.facts.length).toBeGreaterThan(0)
    expect(page.facts[0]).not.toHaveProperty('trust_score')
    expect(page.facts[0]).not.toHaveProperty('remaining_days')
    expect(page.facts[0]).toHaveProperty('fact_id')

    const detail = await dispatchTool(rt, 'admin', { action: 'detail', fact_id: created.fact_id }) as Record<string, unknown>
    expect(detail).not.toHaveProperty('trust_score')
    expect(detail).not.toHaveProperty('helpful_count')
    expect(detail).toHaveProperty('entities')

    const diagnose = await dispatchTool(rt, 'admin', { action: 'trust_diagnose' }) as Record<string, unknown>
    expect(diagnose).toHaveProperty('forgetting_soon')

    // Same database, unfiltered runtime payload: the operator surface keeps the numbers. No cast
    // here — `rt.admin` returns the real `FactSummary`, which is what MAKES these two assertions
    // meaningful: the fields are guaranteed by the type, not merely assumed by the test.
    const raw = rt.admin({ action: 'list', limit: 5 })
    expect(raw.facts[0]).toHaveProperty('trust_score')
    expect(raw.facts[0]).toHaveProperty('remaining_days')
  })

  it('tools/list passes the SDK result validation with the derived schemas', async () => {
    // The handler runs inside the SDK's ListToolsResultSchema validation: a schema
    // shape the protocol rejects would break discovery for every MCP client.
    const list = (server as unknown as {
      _requestHandlers: Map<string, (req: { method: string; params: Record<string, unknown> }) => Promise<{
        tools: { name: string; inputSchema: { oneOf?: unknown[]; properties?: Record<string, unknown> } }[]
      }>>
    })._requestHandlers.get('tools/list')!
    const result = await list({ method: 'tools/list', params: {} })
    // Derived from the contract, not retyped: the split knowledge tools changed the count, and a
    // hardcoded number here is exactly the drift this file is supposed to catch.
    expect(result.tools).toHaveLength(TOOL_SPECS.length)
    for (const tool of result.tools) {
      expect(tool.inputSchema.properties).toBeDefined()
    }
    const recall = result.tools.find((t) => t.name === 'mem_recall')!
    expect(Array.isArray(recall.inputSchema.oneOf)).toBe(true)
  })

  it('callTool returns the shared {ok,result} envelope on both surfaces', async () => {
    const ok = await callTool('mem_remember', { action: 'add', content: '统一信封测试' })
    expect(ok.isError).toBeUndefined()
    expect(ok.body.ok).toBe(true)
    expect((ok.body.result as { fact_id: number }).fact_id).toBeGreaterThan(0)

    // contract violation → application error envelope AND protocol-level isError
    const bad = await callTool('mem_recall', { action: 'search' })
    expect(bad.isError).toBe(true)
    expect(bad.body.ok).toBe(false)
    expect(bad.body.error).toContain('参数不合法')
    expect(bad.body.violations?.join()).toContain('query')
  })
})
