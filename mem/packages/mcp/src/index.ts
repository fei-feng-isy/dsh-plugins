import { readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildRuntime, dispatchToolKey, provisionToolchainAsync, type AvantfRuntime } from '@avantf/mem'
import {
  TOOL_SPECS,
  toolInputJsonSchema,
  modelFacingToolResult,
  toolOk,
  toolErr,
  toWellFormedDeep,
  validationError,
  type ToolSpec,
} from '@avantf/mem-contract'

/** Full JSON Schema per tool, derived from the contract (single source of truth). */
export function jsonSchema(spec: ToolSpec): Record<string, unknown> {
  return toolInputJsonSchema(spec)
}

/**
 * The ONE model-facing output boundary of the MCP server.
 *
 * Every `tools/call` answer — success envelope, validation error, thrown failure — leaves through
 * here, so this is the last place before `JSON.stringify`. `toWellFormedDeep` repairs every string
 * in the payload first: the MCP result can carry a database row this process did not just write (an
 * older build's data, a foreign driver's), and `JSON.stringify` would otherwise emit a lone
 * surrogate as `"\ud800"` — legal to JavaScript's parser, rejected by strict ones. Exported so the
 * boundary itself can be asserted without standing up a transport.
 */
export function textResult(payload: unknown, isError = false): { isError?: boolean; content: { type: 'text'; text: string }[] } {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(toWellFormedDeep(payload)) }] }
}

/**
 * The version the MCP handshake advertises.
 *
 * Read from this package's own manifest rather than restated: a literal here drifts on every bump
 * and NOTHING would catch it (an MCP client would simply report the wrong server version). The
 * package is built by plain `tsc`, not bundled, so `import.meta.url` still resolves to `lib/` one
 * level below the manifest — and npm always ships `package.json`.
 */
const PKG_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version

export async function buildMcpServer(rt: AvantfRuntime): Promise<Server> {
  const server = new Server({ name: 'avantf-mem', version: PKG_VERSION }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_SPECS.map((s) => ({ name: s.name, description: s.description, inputSchema: jsonSchema(s) })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const spec = TOOL_SPECS.find((s) => s.name === req.params.name)
    if (!spec) return textResult(toolErr(`unknown tool ${req.params.name}`), true)
    // Validate against the contract BEFORE dispatch (same envelope as @avantf/dsh-mem):
    // a bad call returns a structured error instead of a raw exception.
    const parsed = spec.input.safeParse(req.params.arguments ?? {})
    if (!parsed.success) return textResult(validationError(spec.name, parsed.error.issues), true)
    try {
      const result = await dispatchTool(rt, spec.key, parsed.data as Record<string, unknown>)
      return textResult(toolOk(result))
    } catch (error) {
      return textResult(toolErr(error), true)
    }
  })
  return server
}

/**
 * Dispatch one validated tool call. The tool key selects the runtime surface.
 *
 * This IS the model-facing boundary on the MCP side, so the result is shaped like the dsh
 * tool runner's: `mem_admin`'s fact views drop the retention diagnostics
 * ({@link modelFacingToolResult}), while diagnostics the caller asked for explicitly
 * (`trust_diagnose`, `vectors_diagnose`, …) pass through.
 *
 * The key → runtime mapping is the engine's ONE table (`dispatchToolKey`, shared with the DSH
 * plugin), not a switch maintained here: this file used to hand-maintain the key set and fell
 * behind the contract, so the four `kb_*` tools were advertised by `tools/list` and answered
 * `unknown tool key` on every call. An unknown key throws and the caller's `catch` routes it
 * through the same `toolErr` envelope as any other failure.
 */
export async function dispatchTool(rt: AvantfRuntime, key: string, args: Record<string, unknown>): Promise<unknown> {
  const value = await dispatchToolKey(rt, key, args)
  return modelFacingToolResult(key, args['action'], value)
}

export async function main(opts?: { dataHome?: string }): Promise<void> {
  const rt = buildRuntime({ dataHome: opts?.dataHome })
  const server = await buildMcpServer(rt)
  const transport = new StdioServerTransport()
  // Connect FIRST: awaiting a model download before `server.connect()` left the
  // MCP `initialize` handshake unanswered (clients time out on first run). The
  // provisioning sweep stays non-blocking and logs readiness per artifact, like the DSH plugin —
  // and it is the SAME sweep, so pandoc is provisioned here too.
  await server.connect(transport)
  // No dsh evidence here (there is no DSH host in the MCP entry), so no compatibility gate runs.
  void provisionToolchainAsync(rt)

  // Trust heartbeat (TRUST_MODEL.md §5): advance the active-day clock and sweep
  // settle/forget/idle/purge while the server is alive. 0 disables it.
  const heartbeatMinutes = rt.config.common.trust.presence.heartbeat_minutes
  if (heartbeatMinutes > 0) {
    const timer = setInterval(() => {
      try {
        rt.memory.trustTick()
      } catch (error) {
        // A failed sweep must never take the server down — but it must not be invisible either: the
        // DSH plugin's identical heartbeat logs, and a trust clock that stopped advancing shows up
        // much later as facts that never settle, forget or purge.
        rt.logger.warn(`trust heartbeat: sweep failed (${error instanceof Error ? error.message : String(error)})`)
      }
    }, heartbeatMinutes * 60_000)
    timer.unref()
  }
  const shutdown = (): void => {
    void server.close().finally(() => rt.shutdown()).finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  void main()
}
