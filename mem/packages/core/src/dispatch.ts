/**
 * The model-facing tool dispatch, shared by EVERY surface that answers a contract tool key: the DSH
 * plugin's tool runner, the plugin's Remote gateway (the operator UI) and the MCP server.
 *
 * It lives here rather than in each adapter because the key set is owned by the contract's
 * `TOOL_SPECS`, and an adapter that hand-writes its own switch rots silently when a spec is added.
 * That is a measured failure, not a hypothetical: `kb_add`/`kb_list`/`kb_remove`/`kb_reindex` were
 * advertised by the MCP server's `tools/list` while its dispatcher still knew only the five older
 * keys, so all four answered `unknown tool key` — a tool that is listed, callable, and always
 * broken. One table keyed by the contract, plus {@link supportsToolKey} so a spec test can assert
 * "every advertised key dispatches" instead of trusting a hand-maintained list.
 *
 * `ToolSpec.key` is typed `string` (not a literal union), so exhaustiveness cannot be checked at
 * compile time — the spec assertion is the gate.
 */
import type {
  RememberRequest,
  RecallRequest,
  AdminRequest,
  KbRequest,
  QueryRequest,
  KbAddRequest,
} from '@avantf/mem-contract'
import type { AvantfRuntime } from './runtime.js'

/**
 * The default page for a model-facing `kb_list`.
 *
 * Without one, `kb_list` on a large library read and parsed EVERY managed file (resolving a path
 * needs the file's frontmatter to detect collisions) to answer a question nobody asked in full.
 */
export const KB_LIST_DEFAULT_LIMIT = 50

/** A document view with the managed file's path — what makes "edit it yourself" actionable. */
function withFilePath(
  rt: AvantfRuntime,
  doc: { doc_id: number; domain: string; source: string; title: string },
): Record<string, unknown> {
  // `docFilePathOf` takes the row the caller already has: `docFilePath` re-read `docs.get` for it,
  // and `kb_list` renders a path for every row.
  return { ...doc, file: rt.knowledge.docFilePathOf(doc) }
}

/**
 * The `kb_add` handler: a thin shell over the runtime's ADD-ONLY face (`rt.kbAdd`), which shares the
 * store's plan/classify/dispatch entry with the UI's 入库 (`rt.kb`) and differs only in the mode.
 *
 * This is the fix for a measured failure: told to "update the KB", a model called the old all-in-one
 * tool with a *new* title, which silently created a sibling document (《… · 补遗》) while the
 * original stayed behind — two overlapping documents, and the reader left to reconcile them.
 * Replacing is now an explicit file edit.
 *
 * The refusal itself lives in the STORE (the plan stage), not here: a pre-check in this handler used
 * to derive the title as `req.title ?? req.source`, which is exactly the fallback the store no
 * longer uses — so once the store derives an untitled paste from its body, a local pre-check would
 * check a different identity than the one the store actually writes.
 */
export async function kbAdd(rt: AvantfRuntime, data: KbAddRequest): Promise<unknown> {
  const paths = data.paths ?? []
  if (paths.length === 0 && (data.text ?? '') === '' && (data.source_uri ?? '') === '') {
    return { error: 'kb_add 需要 text、source_uri 或 paths 三者之一。' }
  }
  return rt.kbAdd(data)
}

type ToolDispatch = (rt: AvantfRuntime, data: never) => unknown

/**
 * Contract tool key → runtime call. `kb` is the INTERNAL engine face (the seven actions the UI and
 * the CLI drive, including `sync`, which is deliberately not model-facing); the four `kb_*` keys are
 * the model-facing split. Both are here because both are addressed by a `ToolSpec.key` or a Remote
 * method name.
 */
const DISPATCH: Record<string, ToolDispatch> = {
  remember: ((rt: AvantfRuntime, data: RememberRequest) => rt.remember(data)) as ToolDispatch,
  recall: ((rt: AvantfRuntime, data: RecallRequest) => rt.recall(data)) as ToolDispatch,
  admin: ((rt: AvantfRuntime, data: AdminRequest) => rt.admin(data)) as ToolDispatch,
  kb: ((rt: AvantfRuntime, data: KbRequest) => rt.kb(data)) as ToolDispatch,
  kb_add: ((rt: AvantfRuntime, data: KbAddRequest) => kbAdd(rt, data)) as ToolDispatch,
  kb_list: ((rt: AvantfRuntime, data: { doc_id?: number; domain?: string; source?: string; limit?: number; offset?: number }) => {
    if (data.doc_id !== undefined) {
      const detail = rt.knowledge.detail(data.doc_id)
      return detail === null
        ? { error: `文档不存在：doc_id=${String(data.doc_id)}` }
        : withFilePath(rt, detail)
    }
    return rt.knowledge
      .list(data.domain, data.source, data.limit ?? KB_LIST_DEFAULT_LIMIT, data.offset)
      .map((doc) => withFilePath(rt, doc))
  }) as ToolDispatch,
  kb_remove: ((rt: AvantfRuntime, data: { doc_id: number }) => rt.kb({ action: 'remove', doc_id: data.doc_id })) as ToolDispatch,
  kb_reindex: ((rt: AvantfRuntime, data: { domain?: string; dry_run?: boolean }) =>
    rt.kb({ action: 'reindex', domain: data.domain, dry_run: data.dry_run })) as ToolDispatch,
  query: ((rt: AvantfRuntime, data: QueryRequest) => rt.query(data)) as ToolDispatch,
}

/** Whether {@link dispatchToolKey} can answer this contract tool key. */
export function supportsToolKey(key: string): boolean {
  return Object.hasOwn(DISPATCH, key)
}

/**
 * Run one already-validated tool call.
 *
 * The caller owns validation (each surface parses with its own `ToolSpec.input` so the error
 * envelope matches its protocol) and owns the model-facing shaping
 * ({@link modelFacingToolResult}); this is the raw runtime call in between. An unknown key THROWS
 * rather than returning a payload, so a surface cannot mistake it for a successful empty result —
 * both adapters route the throw through their structured error envelope.
 */
export async function dispatchToolKey(
  rt: AvantfRuntime,
  key: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const dispatch = DISPATCH[key]
  if (dispatch === undefined) throw new Error(`unknown tool key ${key}`)
  return dispatch(rt, args as never)
}
