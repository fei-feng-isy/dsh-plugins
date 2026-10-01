import { z } from 'zod'
import { CATEGORY_VALUES, FACT_STATUSES, FLOOR_PROFILES, withoutRetentionDiagnostics } from './types.js'

/**
 * The closed value sets these tools accept, exported so no other surface has to retype them.
 *
 * The CLI used to hand-copy each list into its own `enumFlag(…)` call, so adding a value here moved
 * the tool schema, the MCP inputSchema and the DSH parameter spec together while the CLI went on
 * refusing the new value — with no test failing anywhere. One array, every consumer reading it.
 * (`FACT_STATUSES` lives in `types.ts`, beside the `FactStatus` type it is the single source of.)
 */
/**
 * The built-in category vocabulary, spelled for the fields that DESCRIBE it.
 *
 * `category` is free-form (`FactCategory` is `… | string`) and stays that way — this is a suggestion
 * a caller can see, not a closed set the engine enforces. It is written once, in `types.ts`, and read
 * here so the constant has a real consumer: before this, nothing at runtime ever read it, which meant
 * editing it changed nothing anywhere.
 */
const CATEGORY_HINT = `内置分类：${CATEGORY_VALUES.join(' / ')}；也可自定义。`

export const CONTRADICTION_RESOLUTIONS = ['true_positive', 'false_positive'] as const
export const QUERY_KINDS = ['all', 'fact', 'doc_chunk'] as const

/**
 * The one description both retrieval entry points use for `floors`.
 *
 * Written once because `mem_recall.search` and `kb_query` accept the same override, and a second
 * copy is how the two surfaces drift (the model then reads two different meanings for one field).
 */
const FLOORS_FIELD_DESCRIPTION =
  '相关性门槛档位（可选）。不传=默认策略：严格门槛，严格门槛一条都没命中而确有条目被门槛丢弃时自动再跑一次宽松门槛；'
  + 'strict=只用严格门槛，无自动放宽；'
  + 'loose=直接用宽松门槛（仍有绝对底线，代词式提问如「我是谁」「我司」属于这一类）。'

/**
 * The longest retrieval query the contract accepts, in characters.
 *
 * There is no useful query beyond this, and there IS a cost: a CJK query is expanded into one trigram
 * OR-phrase per character and evaluated by SQLite **synchronously on the host's event loop** (200 000
 * characters measured at 119 seconds, of which the expansion was 27–52 ms — the rest was `MATCH`). The
 * cap belongs HERE because every entry point derives from this union: the plugin's tools, the MCP
 * inputSchema, the CLI's argv validation and the browser payload are all this same object.
 */
export const MAX_QUERY_CHARS = 2_000

/** Why the cap exists, in the words the caller sees. */
const QUERY_TOO_LONG = `检索文本最长 ${String(MAX_QUERY_CHARS)} 字符：更长的输入会被展开成成百上千个 OR 短语并在宿主事件循环上同步执行。`
  + '把范围收窄，或先用 kb_ingest 把整篇文档入库再检索。'

export type ContradictionResolution = (typeof CONTRADICTION_RESOLUTIONS)[number]
export type QueryKind = (typeof QUERY_KINDS)[number]

/** Action unions — one source of truth for tool schemas, MCP inputSchema, CLI args, UI payloads. */

/**
 * Cap on the conflicts reported back to a WRITER. A hub fact can be named in many open
 * pairs, and the write path's payload goes to a model; the full list stays available
 * through `contradict` / the settings page. Ordered by score, so a cap drops the least
 * severe first.
 *
 * Declared here (not in `core`) because the write path takes the cap from the contract. The
 * `mem_remember` description deliberately does NOT state the number any more — model-facing
 * text describes what a call does, never the shape of its result.
 */
export const MAX_REPORTED_CONFLICTS = 20

/**
 * Vocabulary that describes HOW memory is retained, banned from every model-facing string.
 *
 * The model cannot observe those clocks and has no action to take on them; the one thing such
 * text enables is rewriting a fact to "refresh" it, which defeats the policy it just described.
 * It binds every tool description and parameter description AND the DSH plugin's system-prompt
 * section, because the prompt section is prompt text too and a second copy of the list is a copy
 * that drifts.
 */
export const RETENTION_VOCABULARY = ['衰减', '消退', '遗忘', '强化', '活跃使用日', '信任度', '永久记忆', '长期有效的信息'] as const

/**
 * Admin actions that return a FACT VIEW. Their payload goes through
 * {@link modelFacingToolResult}, which drops the retention diagnostics; the other admin
 * actions (`trust_diagnose`, `vectors_diagnose`, …) are diagnostics the caller asked for and
 * pass through untouched.
 */
export const FACT_VIEW_ADMIN_ACTIONS = ['list', 'detail'] as const

/**
 * Shape one validated tool result for the MODEL. Applied at the two model-facing boundaries
 * (`@avantf/dsh-mem`'s tool runner and the MCP dispatch); the Remote gateway that drives the
 * operator UI keeps the full payload, and a caller that wants the numbers can ask for them
 * explicitly with `mem_admin`'s diagnostic actions.
 */
export function modelFacingToolResult(toolKey: string, action: unknown, value: unknown): unknown {
  if (toolKey !== 'admin') return value
  const isFactView = (FACT_VIEW_ADMIN_ACTIONS as readonly unknown[]).includes(action)
  return isFactView ? withoutRetentionDiagnostics(value) : value
}

export const REMEMBER_ACTIONS = ['add', 'update', 'remove', 'helpful', 'unhelpful'] as const

export const RememberUnion = z.discriminatedUnion(
  'action',
  [
    z.object({
      action: z.literal('add'),
      content: z.string().min(1).describe('要写入或替换的事实内容：一句自包含的陈述。action=add 时必填。'),
      category: z.string().optional().describe(`分类标签；可选，默认 general。${CATEGORY_HINT}`),
      ttl_days: z.number().int().nonnegative().optional().describe('有效期天数（0 或省略 = 不设有效期；正整数 = 自写入起该天数后自动归档）。update 未给则继承被改写事实的 TTL。'),
    }),
    z.object({
      action: z.literal('update'),
      fact_id: z.number().int().positive().describe('要更新的事实 ID。action=update 时必填。'),
      content: z.string().min(1).describe('替换后的新事实内容。action=update 时必填。'),
      category: z.string().optional().describe(`新的分类标签；可选，未给则继承被改写事实的分类。${CATEGORY_HINT}`),
      ttl_days: z.number().int().nonnegative().optional().describe('新的有效期天数（0 = 取消有效期）；可选，未给则继承被改写事实的 TTL。'),
    }),
    z.object({
      action: z.literal('remove'),
      fact_id: z.number().int().positive().describe('要删除的事实 ID。action=remove 时必填。'),
      reason: z.string().optional().describe('删除原因；可选。'),
    }),
    z.object({
      action: z.literal('helpful'),
      fact_id: z.number().int().positive().describe('对回答有帮助的事实 ID。action=helpful 时必填。'),
    }),
    z.object({
      action: z.literal('unhelpful'),
      fact_id: z.number().int().positive().describe('对回答无帮助的事实 ID。action=unhelpful 时必填。'),
    }),
  ],
)
export type RememberRequest = z.infer<typeof RememberUnion>

export const RECALL_ACTIONS = ['search', 'ask', 'chain', 'probe', 'reason', 'related', 'contradict'] as const

export const RecallUnion = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('search'),
    query: z.string().min(1).max(MAX_QUERY_CHARS, QUERY_TOO_LONG).describe('检索文本。action=search 时必填。'),
    category: z.string().optional().describe('限定分类；可选。'),
    limit: z.number().int().positive().max(50).optional().describe('返回条数上限（1-50）；可选。'),
    max_tokens: z.number().int().nonnegative().optional().describe('本次结果的总 token 上限；0=不限制。缺省用配置 retrieval.max_output_tokens。'),
    floors: z.enum(FLOOR_PROFILES).optional().describe(FLOORS_FIELD_DESCRIPTION),
  }),
  z.object({
    action: z.literal('ask'),
    subj: z.string().optional().describe('三元组主语；action=ask 时与 pred/obj/query 至少给一个。'),
    pred: z.string().optional().describe('三元组谓语。'),
    obj: z.string().optional().describe('三元组宾语。'),
    query: z.string().optional().describe('自然语言问题；给了 query 就按整句检索。'),
    limit: z.number().int().positive().max(50).optional().describe('返回条数上限（1-50）；可选，默认 10。'),
  }),
  z.object({
    action: z.literal('chain'),
    subj: z.string().min(1).describe('链式推理的起点实体。action=chain 时必填。'),
    pred: z.string().optional().describe('第一跳关系；可选。'),
    second_pred: z.string().optional().describe('第二跳关系；可选。'),
    limit: z.number().int().positive().max(50).optional().describe('返回条数上限（1-50）；可选，默认 10。'),
  }),
  z.object({
    action: z.literal('probe'),
    entity: z.string().min(1).describe('要探查的实体名。action=probe 时必填。'),
    category: z.string().optional().describe('限定分类；可选。'),
    limit: z.number().int().positive().max(50).optional().describe('返回条数上限（1-50）；可选。'),
  }),
  z.object({
    action: z.literal('reason'),
    entities: z.array(z.string().min(1)).min(1).describe('参与推理的实体名数组（≥1）。action=reason 时必填。'),
    category: z.string().optional().describe('限定分类；可选。'),
    limit: z.number().int().positive().max(50).optional().describe('返回条数上限（1-50）；可选，默认 10。'),
  }),
  z.object({
    action: z.literal('related'),
    entity: z.string().min(1).describe('要查询相关事实的实体名。action=related 时必填。'),
    category: z.string().optional().describe('限定分类；可选。'),
    limit: z.number().int().positive().max(50).optional().describe('返回条数上限（1-50）；可选，默认 10。'),
  }),
  z.object({
    action: z.literal('contradict'),
    category: z.string().optional().describe('限定分类；可选。'),
    limit: z.number().int().positive().max(50).optional().describe('返回条数上限（1-50）；可选。'),
  }),
])
export type RecallRequest = z.infer<typeof RecallUnion>

export const ADMIN_ACTIONS = ['stats', 'list', 'detail', 'archive', 'restore', 'pin', 'unpin', 'trust_diagnose', 'vectors_diagnose', 'vectors_fix', 'contradict_check', 'contradict_resolve', 'maintenance'] as const

export const AdminUnion = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stats') }),
  z.object({
    action: z.literal('list'),
    category: z.string().optional().describe('限定分类；可选。'),
    status: z.enum(FACT_STATUSES).optional().describe('按状态过滤；可选，默认 active。'),
    limit: z.number().int().positive().max(500).optional().describe('返回条数上限（1-500）；可选，默认 50。'),
    offset: z.number().int().nonnegative().optional().describe('分页偏移（从 0 开始）；配合 limit 翻页；可选。'),
  }),
  z.object({
    action: z.literal('detail'),
    fact_id: z.number().int().positive().describe('要查看的事实 ID。action=detail 时必填。'),
  }),
  z.object({
    action: z.literal('archive'),
    fact_id: z.number().int().positive().describe('要归档的事实 ID。action=archive 时必填。'),
    reason: z.string().optional().describe('归档原因；可选。'),
  }),
  z.object({
    action: z.literal('restore'),
    fact_id: z.number().int().positive().describe('要恢复的事实 ID。action=restore 时必填。'),
  }),
  z.object({
    action: z.literal('pin'),
    fact_id: z.number().int().positive().describe('要标记为长期保留的事实 ID。action=pin 时必填。'),
  }),
  z.object({
    action: z.literal('unpin'),
    fact_id: z.number().int().positive().describe('要取消长期保留标记的事实 ID。action=unpin 时必填。'),
  }),
  z.object({ action: z.literal('trust_diagnose') }),
  z.object({ action: z.literal('vectors_diagnose') }),
  z.object({
    action: z.literal('vectors_fix'),
    dry_run: z.boolean().optional().describe('true=只诊断不写入；可选，默认 false。'),
  }),
  z.object({ action: z.literal('contradict_check') }),
  z.object({
    action: z.literal('contradict_resolve'),
    contradiction_id: z.number().int().positive().describe('要裁决的矛盾 ID（来自 `mem_remember` 的 contradictions 或 `mem_recall` 的 contradict）。'),
    resolution: z.enum(CONTRADICTION_RESOLUTIONS).describe('true_positive=确实是矛盾（配 loser_fact_id 归档错的一方）；false_positive=两条并不冲突，关闭该配对且两条都保留。'),
    loser_fact_id: z.number().int().positive().optional().describe('判错的一方（必须是该配对里的两条之一）；给定时会被归档。仅 true_positive 可带。'),
  }),
  z.object({ action: z.literal('maintenance') }),
])
export type AdminRequest = z.infer<typeof AdminUnion>

export const KB_ACTIONS = ['ingest', 'import', 'list', 'detail', 'remove', 'reindex', 'sync'] as const

/** The `source` a write gets when it omits one; a document's identity is `(domain, source, title)`. */
export const DEFAULT_KB_SOURCE = 'default'

export const KbUnion = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('ingest'),
    text: z.string().min(1).optional().describe('要入库的文本；与 source_uri 至少给一个。'),
    source_uri: z.string().optional().describe('来源：本地文件路径或 http(s) URL，内容会被读取后入库；与 text 至少给一个。'),
    domain: z.string().min(1).describe('知识域；取值来自配置 knowledge.domains。action=ingest 时必填。'),
    source: z.string().optional().default(DEFAULT_KB_SOURCE).describe('来源名；可选，缺省 default。'),
    title: z.string().optional().describe('文档标题；可选。'),
    overwrite: z.boolean().optional().describe('已确认覆盖同名文档；缺省拒绝。'),
  }),
  z.object({
    action: z.literal('import'),
    paths: z.array(z.string().min(1)).min(1).describe('要导入的文件路径数组（≥1）。action=import 时必填。'),
    domain: z.string().min(1).describe('知识域；取值来自配置 knowledge.domains。action=import 时必填。'),
    source: z.string().optional().default(DEFAULT_KB_SOURCE).describe('来源名；可选，缺省 default。'),
    overwrite: z.boolean().optional().describe('已确认覆盖同名文档；缺省拒绝。'),
  }),
  z.object({
    action: z.literal('list'),
    domain: z.string().optional().describe('限定知识域；可选。'),
    source: z.string().optional().describe('限定来源；可选。'),
    limit: z.number().int().positive().optional().describe('本页最多返回多少篇文档（按 updated_at 倒序）；可选，缺省不限。'),
    offset: z.number().int().nonnegative().optional().describe('跳过多少篇（配合 limit 分页）；可选，默认 0。'),
  }),
  z.object({
    action: z.literal('detail'),
    doc_id: z.number().int().positive().describe('文档 ID。action=detail 时必填。'),
  }),
  z.object({
    action: z.literal('remove'),
    doc_id: z.number().int().positive().describe('要删除的文档 ID。action=remove 时必填。'),
  }),
  z.object({
    action: z.literal('reindex'),
    domain: z.string().optional().describe('只重建该知识域的索引；可选，缺省全部。'),
    dry_run: z.boolean().optional().describe('true=只报告将重建多少（chunks/实体/向量），不写入；可选，默认 false。'),
  }),
  z.object({
    action: z.literal('sync'),
    doc_id: z.number().int().positive().optional().describe('只同步该文档；可选，缺省检查全部。'),
    adopt: z
      .boolean()
      .optional()
      .describe(
        'true=认领：把该文档路径上**没有 frontmatter** 的文件重新摄入并补写 frontmatter（action=sync 且给了 doc_id 时才有意义）。整篇覆写会毁掉 frontmatter，此时 `sync` 会**自动**认领（守卫：文件完全没有 frontmatter、正文非空、指纹稳定、路径归属唯一）；不满足守卫的会留在 `unclaimed` 里，用这个参数立即认领。',
      ),
    dry_run: z.boolean().optional().describe('true=只报告哪些文档的受管文件被改过（stale/missing/orphans），不重新摄入；可选，默认 false。'),
  }),
])
export type KbRequest = z.infer<typeof KbUnion>

export const QueryUnion = z.object({
  query: z.string().min(1).max(MAX_QUERY_CHARS, QUERY_TOO_LONG).describe('检索文本，必填。'),
  kind: z.enum(QUERY_KINDS).optional().describe('结果类型：all/fact/doc_chunk；可选，默认 all。'),
  max_tokens: z.number().int().nonnegative().optional().describe('本次结果的总 token 上限；0=不限制。缺省用配置 retrieval.max_output_tokens。'),
  domain: z.string().optional().describe('限定知识域；可选。'),
  source: z.string().optional().describe('限定来源；可选。'),
  limit: z.number().int().positive().max(50).default(10).describe('返回条数上限（1-50）；可选，默认 10。'),
  floors: z.enum(FLOOR_PROFILES).optional().describe(FLOORS_FIELD_DESCRIPTION),
})
export type QueryRequest = z.infer<typeof QueryUnion>

/** Transport-agnostic tool spec: name / key / description / zod input. */
export interface ToolSpec {
  key: string
  name: string
  description: string
  input: z.ZodType
}

export const REMEMBER_TOOL: ToolSpec = {
  key: 'remember',
  name: 'mem_remember',
  description:
    '写入/更新/删除长期记忆事实，或反馈某条事实是否有帮助。'
    + 'add=新增一条简洁的独立陈述；update=改写已有事实；remove=删除；helpful/unhelpful=反馈是否有用。'
    + '写入没有改变任何状态时是静默 no-op（add 命中完全重复的内容、update 重存同一内容）。'
    + 'category/ttl_days 规则：显式给定的值一定生效，未给则保留该事实原有的值——update 未给时继承被改写事实的 category 与 ttl_days，只有 add 的全新行才用默认值 general/0。',
  input: RememberUnion,
}
export const RECALL_TOOL: ToolSpec = {
  key: 'recall',
  name: 'mem_recall',
  description:
    '检索长期记忆中的事实。search=语义+全文+实体的混合检索；ask=按 SPO 三元组或自然语言提问；'
    + 'chain=沿 subj→pred→second_pred 做链式推理；probe=看某实体的相关事实；reason=围绕多个实体联合推理；'
    + 'related=列出与该实体共同出现的其他实体及共现次数（是实体清单，不是事实本身；要事实用 search/probe）；contradict=找出互相矛盾的事实。'
    + '只检索、不生成答案。',
  input: RecallUnion,
}
export const ADMIN_TOOL: ToolSpec = {
  key: 'admin',
  name: 'mem_admin',
  description:
    '记忆库运维与诊断。stats=计数；list=列举事实；detail=查看单条事实详情（实体/三元组/检索次数/修订链）；'
    + 'archive/restore=归档或恢复；pin/unpin=将事实标记为长期保留 / 取消该标记；trust_diagnose=记忆保留诊断；'
    + 'vectors_diagnose/vectors_fix=向量索引诊断与修复；'
    + 'contradict_check=补扫积压的矛盾候选；'
    + 'contradict_resolve=裁决一条已记录的矛盾；'
    + 'maintenance=跑一次完整的记忆维护。',
  input: AdminUnion,
}
export const KB_TOOL: ToolSpec = {
  key: 'kb',
  name: 'kb_manage',
  description:
    '维护文档知识库（按 domain→source 两级分类）。'
    + 'ingest=把文本入库，或读取 source_uri（本地文件/http(s)）入库（默认只能读工作区内文件、不能拉内网地址，见 knowledge.ingest）；'
    + '可摄入的是**文本、PDF 与可转换文档**：UTF-8 文本直接用；PDF 先抽取文本层（扫描件/图片型 PDF 没有文本层，会明确报错而不是入库空文档）；'
    + 'pandoc 能读的格式（.docx/.docm/.odt/.epub/.html/.htm/.xhtml/.tex/.rst/.ipynb/.csv/.tsv/.org/.rtf/.fb2/.opml/.bib/.docbook/.man/.typ）与 .xlsx 先转成 Markdown 再入库，'
    + '用了哪条转换器随 `converter` 回报（带版本，如 pandoc-3.11——跨机器的语料差异因此可见），没能带过来的内容（图片、公式、被截断的表格）写进 `warnings`；'
    + '其他二进制（图片、pptx、旧版 .doc/.xls/.ppt、可执行文件等）拒绝并说明检测到的类型；GBK/GB18030 等中文旧编码会被**自动解码**，用了哪种编码随 `encoding` 回报；只有两种解码都失败（无法识别的编码）才报错。'
    + 'import=导入本地文件或目录：目录只收 .md/.markdown/.txt/.json/.jsonl/.yaml/.yml/.pdf/.docx/.docm/.odt/.epub/.html/.htm/.xhtml/.tex/.rst/.ipynb/.csv/.tsv/.org/.rtf/.xlsx（不跟随符号链接），其余文件跳过并在结果里报出；直接给出的文件路径不看扩展名。返回 {imported, failed, skipped, skipped_total}；'
    + 'list=列出文档（按 updated_at 倒序，返回裸数组；可选 limit/offset 分页）；detail=查看文档详情；remove=删除文档（连同它的受管文件）；reindex=重建索引（可选限定 domain；dry_run=true 只报告待重建数量，不写入）；'
    + 'sync=把每篇文档的受管文件（knowledge.docs.dir 下那份可编辑的 .md）与库里的内容比对：'
    + '被手动改过的重新摄入，报告 stale/missing/orphans/unclaimed（dry_run=true 只报告不写入）；'
    + 'unclaimed 指「路径命中某篇、但文件已无 frontmatter」的文件，用 sync + adopt + doc_id 显式认领。',
  input: KbUnion,
}
export const QUERY_TOOL: ToolSpec = {
  key: 'query',
  name: 'kb_query',
  description:
    '在**用户已入库的文档切片**与记忆事实里做统一检索（跨库）。只检索、不生成答案。',
  input: QueryUnion,
}

// ─── The knowledge tools the MODEL sees ─────────────────────────────────────────────────────────
//
// `kb_manage` used to expose all seven actions of `KbUnion` as ONE tool. The model-facing surface
// is now five tools, because the two operations it actually has to get right are different jobs:
//
//  - ADD is a write with a name collision risk, so it is its own tool and it REFUSES a triple that
//    already exists (silently replacing a document was how "update the KB" turned into a second
//    document: any difference in the title string created a sibling instead of replacing).
//  - CHANGE is not a tool call at all: `kb_list` hands back the managed file's path and the agent
//    edits that `.md` with its own `edit`/`write`. The index follows automatically (`tools/result`
//    → per-file fingerprint → sync), so `sync` is deliberately NOT model-facing.
//
// `KbUnion`/`KB_TOOL` stay: they are the internal engine API the UI's remote face and the CLI
// dispatch through. Only the model-facing specs changed.

const KbDomainField = z.string().min(1).describe('知识域；取值来自配置 knowledge.domains。')
const KbSourceField = z.string().optional().default(DEFAULT_KB_SOURCE).describe('来源名；可选，缺省 default。')
const KbTitleField = z.string().optional().describe('文档标题；可选，缺省取正文首个标题或首行。')

/** One new document, or a batch import — never an update (see the tool description). */
export const KB_ADD_TOOL: ToolSpec = {
  key: 'kb_add',
  name: 'kb_add',
  description:
    '新增一篇文档入库。**只新增、不修改**：同一 `(domain, source, title)` 已存在时会被**拒绝**。'
    + '给 text 或 source_uri 是单篇（text 是粘贴文本，source_uri 是本地文件路径或 http(s) URL，'
    + '可摄入文本、PDF、pandoc 能读的文档格式与 .xlsx）；给 paths 是批量导入文件或目录'
    + '（目录只收 .md/.markdown/.txt/.json/.jsonl/.yaml/.yml/.pdf/.docx/.docm/.odt/.epub/.html/.htm/.xhtml/.tex/.rst/.ipynb/.csv/.tsv/.org/.rtf/.xlsx，'
    + '不跟随符号链接）。',
  input: z.object({
    domain: KbDomainField,
    source: KbSourceField,
    title: KbTitleField,
    text: z.string().min(1).optional().describe('要入库的文本；与 source_uri、paths 三选一。'),
    source_uri: z.string().optional().describe('来源：本地文件路径或 http(s) URL，内容会被读取后入库。'),
    paths: z.array(z.string().min(1)).min(1).optional().describe('批量导入的文件/目录路径（≥1）；给了它就是批量导入。'),
  }),
}

/**
 * The parsed `kb_add` input, no `overwrite`: the add-only MODE is a property of the runtime face
 * (`rt.kbAdd`), not a field the model can set. Spelled out (rather than `z.infer` of
 * `KB_ADD_TOOL.input`, which is widened to `z.ZodType` by `ToolSpec`) so the runtime method and the
 * plugin handler agree on the request. `source` is present because the contract defaults it.
 */
export interface KbAddRequest {
  domain: string
  source: string
  title?: string
  text?: string
  source_uri?: string
  paths?: string[]
}

/** The corpus listing, with the managed path — the entry point for editing a document. */
export const KB_LIST_TOOL: ToolSpec = {
  key: 'kb_list',
  name: 'kb_list',
  description:
    '列出知识库里的文档：doc_id、domain、source、title、**受管 .md 文件的绝对路径**与更新时间；'
    + '给了 doc_id 时只取该篇。',
  input: z.object({
    doc_id: z.number().int().positive().optional().describe('给了 `doc_id` 时只取该篇；可选。'),
    domain: z.string().optional().describe('限定知识域；可选，仅在未给 doc_id 时有意义。'),
    source: z.string().optional().describe('限定来源；可选，仅在未给 doc_id 时有意义。'),
    limit: z.number().int().positive().optional().describe('本页最多返回多少篇（按 updated_at 倒序）；可选，缺省 50。'),
    offset: z.number().int().nonnegative().optional().describe('跳过多少篇（配合 limit 分页）；可选，默认 0。'),
  }),
}

export const KB_REMOVE_TOOL: ToolSpec = {
  key: 'kb_remove',
  name: 'kb_remove',
  description:
    '删除一篇文档，连同它在 `knowledge.docs.dir` 下的受管 .md 副本。',
  input: z.object({ doc_id: z.number().int().positive().describe('要删除的文档 ID。') }),
}

export const KB_REINDEX_TOOL: ToolSpec = {
  key: 'kb_reindex',
  name: 'kb_reindex',
  description:
    '重建知识库索引（分块/实体/向量）。可选限定 domain。',
  input: z.object({
    domain: z.string().optional().describe('只重建该知识域的索引；可选，缺省全部。'),
    dry_run: z.boolean().optional().describe('true=只报告将重建多少，不写入；可选，默认 false。'),
  }),
}

export const TOOL_SPECS: ToolSpec[] = [
  REMEMBER_TOOL,
  RECALL_TOOL,
  ADMIN_TOOL,
  KB_ADD_TOOL,
  KB_LIST_TOOL,
  KB_REMOVE_TOOL,
  KB_REINDEX_TOOL,
  QUERY_TOOL,
]

// ─── JSON Schema derivation (single source → MCP inputSchema etc.) ──────────

/**
 * Minimal structural view of the zod v4 internals the derivation reads.
 *
 * v4 replaced v3's `_def.typeName` string constants with a lowercase `def.type` tag and made
 * the nested pieces real fields: `def.shape` is an OBJECT (v3's was a function), `def.values`
 * carries a literal's/ enum's values, and `def.innerType` sits under every wrapper. Reading
 * them is what makes the derivation quiet about a version change: on the wrong zod, every tag
 * misses and the fields silently flatten to `{}` — which is why the derived shape is asserted by
 * the test suite rather than eyeballed after a zod bump.
 */
interface ZodDefView {
  type?: string
  innerType?: z.ZodTypeAny
  shape?: Record<string, z.ZodTypeAny>
  /** Literal and enum values in v4 (`['add']`, `['all','fact','doc_chunk']`). */
  values?: unknown
  options?: z.ZodTypeAny[]
}

function defOf(schema: z.ZodTypeAny): ZodDefView {
  return (schema as unknown as { def?: ZodDefView }).def ?? {}
}

/**
 * The IEEE-754 safe-integer bounds v4 attaches to every unbounded `z.number().int()`.
 *
 * They mean "no bound" and would otherwise show up in a MODEL-FACING schema as
 * `"maximum": 9007199254740991` — noise the model has to read past. Stripped; a real bound
 * (`minimum: 0` from `.nonnegative()`) is kept.
 */
const SAFE_INT_BOUNDS = new Set([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])

/**
 * One field's JSON Schema, via zod's own converter.
 *
 * `io: 'input'` is REQUIRED, not a detail: it decides `required`. A `.default(10)` field is
 * optional on the way IN (which is what server validation does — `safeParse({})` fills it) and
 * present on the way OUT. zod v4 also made `.default()` itself input-strict — it no longer
 * parses the default through the schema, so `sub.default({})` yields a bare `{}` instead of the
 * sub-schema's filled object. Nested defaults therefore use `.prefault({})` (see `config.ts`).
 */
function fieldToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // Requires JSON-Schema-compatible schemas; every schema here is (no refine/transform), and
  // `unrepresentable: 'any'` keeps an exotic future one from throwing at import time.
  const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete out.$schema
  for (const key of ['minimum', 'maximum'] as const) {
    if (typeof out[key] === 'number' && SAFE_INT_BOUNDS.has(out[key])) delete out[key]
  }
  return out
}

/** Every field of one union branch, with the branch-local required set. */
interface BranchShape {
  action: string
  properties: Record<string, unknown>
  required: string[]
}

function branchShapeOf(branch: z.ZodTypeAny): BranchShape | null {
  const fields = defOf(branch).shape
  if (fields === undefined) return null
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  let action = ''
  for (const [key, fieldSchema] of Object.entries(fields)) {
    if (key === 'action') {
      // v4 keeps a literal's value in `def.values` (an array), not v3's scalar `def.value`.
      const literal = (defOf(fieldSchema).values as unknown[] | undefined)?.[0]
      if (typeof literal === 'string') action = literal
      properties[key] = { type: 'string', enum: [action] }
      required.push(key)
      continue
    }
    properties[key] = fieldToJsonSchema(fieldSchema)
    if (!fieldSchema.isOptional()) required.push(key)
  }
  return action === '' ? null : { action, properties, required }
}

/**
 * Compose the top-level (merged) description for a union field.
 *
 * Descriptions are authored per action ("action=update 时必填"), so taking the
 * first branch's text verbatim told a model that `fact_id` only matters for
 * `update` although `remove/helpful/unhelpful` require it too. The action-clause
 * is stripped and replaced by the derived set of actions that make the field
 * required.
 *
 * Both model-facing surfaces call this: `toolInputJsonSchema` (MCP `inputSchema`) and
 * `@avantf/dsh-mem`'s `flattenToolSpec` (DSH tool parameters). They each walk the union and must
 * agree field for field — deriving the sentence in ONE place is what makes that so.
 */
export function mergedFieldDescription(base: string | undefined, requiredIn: string[]): string | undefined {
  const stripped = (base ?? '').replace(/\s*action=[^\s，。；、]*\s*时必填[。；]?/g, '').trim()
  const prefix = requiredIn.length > 0 ? `【${requiredIn.join('/')} 必填】` : ''
  const text = `${prefix}${stripped}`
  return text.length > 0 ? text : undefined
}

/**
 * Derive a full JSON Schema (draft-07) for a tool's input — used as the MCP
 * `inputSchema`.
 *
 * A discriminated union emits `oneOf` with ONE schema per action: each branch
 * carries its own `required` list, so `{"action":"search"}` (no `query`) is
 * rejected exactly like the server's own contract validation rejects it. The
 * merged `properties` map is kept alongside for MCP clients that ignore `oneOf`,
 * with every field's description stating which actions require it. Field-level
 * value constraints (`minimum`/`maximum`/`minLength`/`minItems`/`default`) are
 * carried over from zod. A plain object marks its own required fields.
 */
export function toolInputJsonSchema(spec: ToolSpec): Record<string, unknown> {
  const def = defOf(spec.input)
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  if (Array.isArray(def.options)) {
    const branches: BranchShape[] = []
    for (const branch of def.options) {
      const parsed = branchShapeOf(branch)
      if (parsed !== null) branches.push(parsed)
    }
    const actions = branches.map((b) => b.action)
    // Merged view: one entry per field, with the actions that require it.
    const merged: Record<string, { schema: unknown; requiredIn: string[] }> = {}
    for (const branch of branches) {
      for (const [key, fieldSchema] of Object.entries(branch.properties)) {
        if (key === 'action') continue
        const entry = merged[key] ?? { schema: fieldSchema, requiredIn: [] }
        if (branch.required.includes(key) && !entry.requiredIn.includes(branch.action)) entry.requiredIn.push(branch.action)
        merged[key] = entry
      }
    }
    for (const [key, entry] of Object.entries(merged)) {
      const base = (entry.schema as { description?: string }).description
      const description = mergedFieldDescription(base, entry.requiredIn)
      properties[key] = description === undefined ? entry.schema : { ...(entry.schema as object), description }
    }
    if (actions.length > 0) {
      properties.action = {
        type: 'string',
        enum: actions,
        description: `要执行的操作，取值：${actions.join(' | ')}。每个操作需要哪些字段见各字段说明。`,
      }
      required.push('action')
    }
    return {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
      oneOf: branches.map((branch) => ({
        type: 'object',
        properties: branch.properties,
        required: branch.required,
        additionalProperties: false,
      })),
    }
  }

  const shape = def.shape
  for (const [key, fieldSchema] of Object.entries(shape ?? {})) {
    properties[key] = fieldToJsonSchema(fieldSchema)
    if (!fieldSchema.isOptional()) required.push(key)
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}
