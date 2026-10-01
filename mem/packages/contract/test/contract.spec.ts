import { describe, it, expect } from 'vitest'
import {
  ConfigSchema,
  MemoryConfigSchema,
  KnowledgeConfigSchema,
  REMEMBER_ACTIONS,
  RECALL_ACTIONS,
  REMEMBER_TOOL,
  RECALL_TOOL,
  ADMIN_TOOL,
  KB_TOOL,
  KB_ADD_TOOL,
  KbUnion,
  QUERY_TOOL,
  TOOL_SPECS,
  RETENTION_VOCABULARY,
  mergedFieldDescription,
  withoutRetentionDiagnostics,
  modelFacingToolResult,
  RecallUnion,
  DEFAULT_MODEL_WINDOW_TOKENS,
  toolInputJsonSchema,
  unwrapRemoteEnvelope,
  formatViolations,
  toolOk,
  toolErr,
  validationError,
  envAutoDownload,
  MAX_QUERY_CHARS,
  QueryUnion,
} from '../src/index.js'

/**
 * The house rule for every model-facing tool string: it says what a call does and how to
 * give the parameters — never WHY, and never what the call RETURNS. The return value
 * arrives on its own and speaks for itself, so any sentence about the payload's shape,
 * fields, caps or flags is budget spent on something the model can see anyway; reasons and
 * mechanics belong in DESIGN / CHANGELOG, where they cost no tokens on every step.
 *
 * These are the phrasings that this pass removed, kept as the guard so they do not creep back
 * in with the next edit. `plugin/test/prompt_section.spec.ts` pins the same discipline for
 * the three system-prompt sections, which never pass through a tool schema.
 *
 * `返回条数上限（1-50）` is NOT banned: it states what the `limit` PARAMETER means. The
 * banned entries below are whole phrases, so the cap wording cannot trip them by accident.
 */
const BANNED_RESULT_WORDING = [
  '返回结果', '返回值', '返回时', '只返回', '返回带', '返回该篇',
  '报告里', '在结果里', '含切片', '带 truncated', '带 `converter`',
  'semantic_available', 'would_warm',
] as const

/**
 * The third half of the rule, added after the first two: a TOOL CALL's description states WHAT IT
 * IS. "How to proceed" and "when you need it" belong to the system-prompt sections (which carry the
 * workflows) and to the tool's own return value — not here, where they cost tokens on every step.
 * The phrases are whole enough that legitimate text cannot trip them.
 */
const BANNED_PROCEDURE_WORDING = [
  '要改', '要修改', '先用', '再使用', '时才用', '时才需要', '只在',
  '先查一遍', '先检索', '不知道', '而不是它', '此时', '拿路径',
] as const

const BANNED_WHY_WORDING = [
  '因为', '否则', '原因是', '之所以', '所以',
  '让随后的', '换模型后', '换模型前', '队列在内存', '进程重启',
] as const

describe('contract', () => {
  it('parses the default merged config', () => {
    const cfg = ConfigSchema.parse({})
    expect(cfg.dataHome).toBe('~/.avantf')
    expect(cfg.semantic.backend).toBe('local_bge')
    expect(cfg.semantic.mirror).toBe('https://hf-mirror.com')
  })

  it('derives the default chunk size from the shipped model window, not from feel', () => {
    // transformers.js truncates past the model window with NO error, so a chunk larger than the
    // window gets embedded only in part — silently, and only its FTS leg sees the tail.
    // Chinese costs ~1 token per character and the tokenizer adds 2 wrapper tokens, so the
    // default chunk size has to stay inside `window - 2` (see retrieval-core `windowChars`).
    const kb = KnowledgeConfigSchema.parse({})
    expect(kb.chunk_size).toBeLessThanOrEqual(DEFAULT_MODEL_WINDOW_TOKENS - 2)
    expect(kb.chunk_overlap).toBeGreaterThan(0)
    expect(kb.chunk_overlap).toBeLessThan(kb.chunk_size)
    const cfg = ConfigSchema.parse({})
    // 0 is "auto": use the loaded model's declared window instead of a hard-coded number.
    expect(cfg.semantic.max_input_tokens).toBe(0)
    expect(cfg.rerank.max_input_tokens).toBe(0)
  })

  it('exposes the remembered actions', () => {
    expect(REMEMBER_ACTIONS).toContain('add')
    expect(RECALL_ACTIONS).toContain('ask')
  })

  it('update accepts the same category/ttl_days overrides as add', () => {
    // Regression: the update branch omitted `ttl_days`, so a model following the tool
    // description ("an explicit value always lands") had it silently STRIPPED by zod — the
    // call succeeded, the write reported 完成, and the TTL was unchanged.
    const parsed = REMEMBER_TOOL.input.safeParse({
      action: 'update', fact_id: 1, content: '改写后的事实', category: 'tool', ttl_days: 7,
    })
    if (!parsed.success) throw new Error(`update with category/ttl_days must parse: ${parsed.error.message}`)
    expect(parsed.data).toMatchObject({ action: 'update', category: 'tool', ttl_days: 7 })
  })

  it('retriever.leg_cap defaults to 0 (= derived) and refuses a negative cap', () => {
    // 0 is a VALUE meaning "derive it from the pool size" (`max(200, 4×overFetch)`), not "unset",
    // and the store reads it as `configured > 0 ? configured : derived` — so a negative value would
    // silently take the derived branch while looking like an explicit choice. `.nonnegative()`
    // makes the config say what the store does.
    const cfg = ConfigSchema.parse({})
    expect(cfg.retriever.leg_cap).toBe(0)
    const withCap = ConfigSchema.parse({ retriever: { leg_cap: 50 } })
    expect(withCap.retriever.leg_cap).toBe(50)
    expect(ConfigSchema.safeParse({ retriever: { leg_cap: -1 } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ retriever: { leg_cap: 1.5 } }).success).toBe(false)
  })

  it('retriever relevance floors default to the calibrated values, admit 0 = off, and refuse nonsense', () => {
    // The three floors are absolute cutoffs on the legs' OWN raw scores (cosine / distinct query
    // terms / Jaccard ratio); `0` means "this leg is not gated". They are config + result-payload
    // values only — deliberately NOT model-facing knobs (see the tool-schema assertion below).
    const cfg = ConfigSchema.parse({})
    expect(cfg.retriever.min_semantic_similarity).toBe(0.5)
    expect(cfg.retriever.min_fts_terms).toBe(2)
    expect(cfg.retriever.min_jaccard).toBe(0.2)
    const off = ConfigSchema.parse({ retriever: { min_semantic_similarity: 0, min_fts_terms: 0, min_jaccard: 0 } })
    expect(off.retriever).toMatchObject({ min_semantic_similarity: 0, min_fts_terms: 0, min_jaccard: 0 })
    expect(ConfigSchema.safeParse({ retriever: { min_semantic_similarity: 1.1 } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ retriever: { min_semantic_similarity: -0.1 } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ retriever: { min_jaccard: -0.1 } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ retriever: { min_fts_terms: -1 } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ retriever: { min_fts_terms: 1.5 } }).success).toBe(false)
    // DESIGN §20.19 / the tool contract: the floors must not leak into a model-visible schema.
    const toolSchemas = JSON.stringify([REMEMBER_TOOL, RECALL_TOOL, ADMIN_TOOL, KB_TOOL, KB_ADD_TOOL, QUERY_TOOL])
    expect(toolSchemas).not.toMatch(/min_semantic_similarity|min_fts_terms|min_jaccard/)
  })

  it('bounds retrieval OUTPUT by default, and lets one call override the bound', () => {
    // `limit` bounds how many hits, never how much text, so a broad query could otherwise put
    // tens of thousands of characters into a model's context (DESIGN §20).
    const cfg = ConfigSchema.parse({})
    expect(cfg.retriever.max_output_tokens).toBeGreaterThan(0)
    const search = RECALL_TOOL.input.safeParse({ action: 'search', query: '网关', max_tokens: 0 })
    if (!search.success) throw new Error(`search with max_tokens must parse: ${search.error.message}`)
    // 0 is a VALUE meaning "no budget", not "unset" — the same trap `ttl_days` had.
    expect(search.data).toMatchObject({ action: 'search', max_tokens: 0 })
    expect(QUERY_TOOL.input.safeParse({ query: '网关', max_tokens: 100 }).success).toBe(true)
  })

  it('ttl_days = 0 is a value, not "unset" (it cancels the expiry)', () => {
    // 0 is how the column and the lifecycle step encode "no expiry" (`ttl_days > 0`), so a
    // caller must be able to revoke its own constraint; `.positive()` rejected it, leaving a
    // fact with a TTL permanently capped.
    for (const action of ['add', 'update'] as const) {
      const input = action === 'add'
        ? { action, content: '不带有效期的事实', ttl_days: 0 }
        : { action, fact_id: 1, content: '取消有效期', ttl_days: 0 }
      const parsed = REMEMBER_TOOL.input.safeParse(input)
      if (!parsed.success) throw new Error(`${action} with ttl_days 0 must parse: ${parsed.error.message}`)
      expect(parsed.data).toMatchObject({ ttl_days: 0 })
    }
    // and a negative value is still rejected
    expect(REMEMBER_TOOL.input.safeParse({ action: 'add', content: 'x', ttl_days: -1 }).success).toBe(false)
  })

  it('per-store schemas keep empty db.path defaults (loader resolves them)', () => {
    expect(MemoryConfigSchema.parse({}).db.path).toBe('')
    // 500 fits the shipped model's window (see the derivation test above).
    expect(KnowledgeConfigSchema.parse({}).chunk_size).toBe(500)
  })

  it('ships a small knowledge-domain allowlist; an explicit empty array means "no restriction"', () => {
    // The allowlist is the write-side answer to "the same field, two names": a NEW domain is a
    // config change. `[]` is a VALUE ("accept anything"), not "unset" — so it is preserved.
    expect(KnowledgeConfigSchema.parse({}).domains).toEqual(['design', 'api', 'ops', 'research', 'notes'])
    expect(KnowledgeConfigSchema.parse({ domains: [] }).domains).toEqual([])
    expect(KnowledgeConfigSchema.parse({ domains: ['tech'] }).domains).toEqual(['tech'])
  })

  it('kb source is optional and parses to `default` on both write branches', () => {
    const add = KB_ADD_TOOL.input.parse({ domain: 'design', text: '正文' }) as { source: string }
    expect(add.source).toBe('default')
    const ingest = KbUnion.parse({ action: 'ingest', domain: 'design', text: '正文' })
    expect(ingest.action === 'ingest' && ingest.source).toBe('default')
    const imported = KbUnion.parse({ action: 'import', domain: 'design', paths: ['a.md'] })
    expect(imported.action === 'import' && imported.source).toBe('default')
    // An explicit value still wins over the default.
    expect((KB_ADD_TOOL.input.parse({ domain: 'design', source: 'spec', text: 'x' }) as { source: string }).source).toBe('spec')
  })

  it('derives `source` as an optional JSON-Schema field with its default, never a required one', () => {
    const add = toolInputJsonSchema(KB_ADD_TOOL) as {
      required?: string[]
      properties: Record<string, { default?: unknown; description?: string }>
    }
    expect(add.required).toContain('domain')
    expect(add.required).not.toContain('source')
    expect(add.properties.source?.default).toBe('default')
    // The internal union (UI/CLI/MCP `kb_manage`) must agree per branch.
    for (const action of ['ingest', 'import'] as const) {
      const kb = toolInputJsonSchema(KB_TOOL) as unknown as {
        oneOf: { properties: { action?: { enum?: string[] } }; required: string[] }[]
      }
      const branch = kb.oneOf.find(b => b.properties.action?.enum?.[0] === action)
      expect(branch?.required).not.toContain('source')
      expect(branch?.required).toContain('domain')
    }
  })

  it('names the domain allowlist, the source default and the title fallback in the field text', () => {
    const add = toolInputJsonSchema(KB_ADD_TOOL) as { properties: Record<string, { description?: string }> }
    expect(add.properties.domain?.description).toContain('knowledge.domains')
    expect(add.properties.source?.description).toContain('缺省 default')
    // The title no longer falls back to `source` (one shared value for every paste); the model-facing
    // text must state the real fallback — the body's first heading or line — not the old rule.
    expect(add.properties.title?.description).toContain('缺省取正文首个标题或首行')
  })

  it('keeps the replace confirmation on the internal union and OUT of the model-facing add tool', () => {
    // `overwrite` is the engine API's confirmation switch (the UI remote face and the CLI use it
    // after the user confirms a collision). It belongs to both write branches of `KbUnion`, and its
    // text states what it IS — no why, no when, no result shape (the three banned-word guards scan it).
    const kb = toolInputJsonSchema(KB_TOOL) as unknown as {
      oneOf: { properties: { action?: { enum?: string[] }; overwrite?: { description?: string; type?: string } } }[]
    }
    for (const action of ['ingest', 'import'] as const) {
      const branch = kb.oneOf.find(b => b.properties.action?.enum?.[0] === action)
      expect(branch?.properties.overwrite?.type).toBe('boolean')
      expect(branch?.properties.overwrite?.description).toBe('已确认覆盖同名文档；缺省拒绝。')
    }
    expect(KbUnion.parse({ action: 'ingest', domain: 'design', text: 'x', overwrite: true })).toMatchObject({ overwrite: true })
    expect(KbUnion.parse({ action: 'import', domain: 'design', paths: ['a.md'], overwrite: true })).toMatchObject({ overwrite: true })

    // The model's `kb_add` must NOT be able to express it: "add-only" is an ENGINE mode (rt.kbAdd),
    // not a field a model can flip. This is the guard against the switch leaking to the model face.
    const add = toolInputJsonSchema(KB_ADD_TOOL) as { properties: Record<string, unknown> }
    expect(Object.keys(add.properties)).not.toContain('overwrite')
    expect(KB_ADD_TOOL.description).not.toContain('overwrite')
  })

  it('presence.mode admits exactly the implemented mode (D3: no phantom options)', () => {
    expect(ConfigSchema.parse({}).trust.presence.mode).toBe('process')
    expect(ConfigSchema.parse({ trust: { presence: { mode: 'process' } } }).trust.presence.mode).toBe('process')
    // `activity` used to be accepted and then silently ignored — it must now fail loudly.
    expect(() => ConfigSchema.parse({ trust: { presence: { mode: 'activity' } } })).toThrow()
    expect(() => ConfigSchema.parse({ trust: { presence: { mode: 'wallclock' } } })).toThrow()
  })

  it('recall ask/chain/reason/related carry an in-schema limit (no out-of-contract casts)', () => {
    for (const action of ['ask', 'chain', 'reason', 'related'] as const) {
      const branch = action === 'chain'
        ? { action, subj: '张伟' }
        : action === 'reason'
          ? { action, entities: ['张伟'] }
          : action === 'related'
            ? { action, entity: '张伟' }
            : { action, query: '张伟管理谁' }
      const parsed = RecallUnion.parse({ ...branch, limit: 5 })
      expect((parsed as { limit?: number }).limit).toBe(5)
    }
  })
})

describe('toolInputJsonSchema (MCP inputSchema derivation)', () => {
  it('merges union branches: required action enum + typed, described fields', () => {
    const schema = toolInputJsonSchema(REMEMBER_TOOL) as {
      type: string
      required?: string[]
      additionalProperties: boolean
      properties: Record<string, { type?: string; enum?: string[]; description?: string }>
    }
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['action'])
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(REMEMBER_ACTIONS as unknown as string[]))
    expect(schema.properties.content?.type).toBe('string')
    expect(schema.properties.content?.description).toContain('add')
    expect(schema.properties.fact_id?.type).toBe('integer')
    expect(schema.properties.ttl_days?.type).toBe('integer')
  })

  it('derives array item types and enums', () => {
    const schema = toolInputJsonSchema(RECALL_TOOL) as {
      properties: Record<string, { type?: string; items?: { type?: string }; enum?: string[] }>
    }
    expect(schema.properties.entities?.type).toBe('array')
    expect(schema.properties.entities?.items?.type).toBe('string')
    expect(schema.properties.limit?.type).toBe('integer')
  })

  it('marks plain-object required fields (kb_query)', () => {
    const schema = toolInputJsonSchema(QUERY_TOOL) as {
      required?: string[]
      properties: Record<string, { type?: string; enum?: string[] }>
    }
    expect(schema.required).toContain('query')
    expect(schema.properties.kind?.enum).toEqual(['all', 'fact', 'doc_chunk'])
    expect(schema.properties.limit?.type).toBe('integer')
  })

  it('emits oneOf with per-action required fields (schema agrees with server validation)', () => {
    interface Branch {
      properties: Record<string, { enum?: string[] }>
      required: string[]
    }
    const byAction = (spec: typeof RECALL_TOOL): Map<string, Branch> => {
      const schema = toolInputJsonSchema(spec) as unknown as { oneOf: Branch[] }
      return new Map(schema.oneOf.map((b) => [b.properties.action?.enum?.[0] ?? '', b]))
    }
    const recall = byAction(RECALL_TOOL)
    // `{"action":"search"}` without query must NOT validate any more.
    expect([...recall.get('search')!.required].sort()).toEqual(['action', 'query'])
    expect([...recall.get('probe')!.required].sort()).toEqual(['action', 'entity'])
    expect([...recall.get('ask')!.required]).toEqual(['action'])
    const admin = byAction(ADMIN_TOOL)
    expect(admin.get('archive')!.required).toContain('fact_id')
    expect(admin.get('list')!.required).toEqual(['action'])
  })

  it('carries zod value constraints and defaults into the schema', () => {
    const query = toolInputJsonSchema(QUERY_TOOL) as unknown as {
      properties: Record<string, { minLength?: number; exclusiveMinimum?: number; maximum?: number; default?: unknown }>
    }
    expect(query.properties.query?.minLength).toBe(1)
    // `.positive()` is exclusiveMinimum: 0 (not minimum: 1) — the closest draft-07 encoding.
    expect(query.properties.limit).toMatchObject({ exclusiveMinimum: 0, maximum: 50, default: 10 })

    const remember = toolInputJsonSchema(REMEMBER_TOOL) as unknown as {
      properties: Record<string, { exclusiveMinimum?: number; minimum?: number }>
    }
    // `ttl_days` is `.nonnegative()`: 0 is the explicit "no expiry" encoding, so the schema
    // must ADMIT it (it used to be `.positive()`, which made a set TTL impossible to revoke).
    expect(remember.properties.ttl_days?.minimum).toBe(0)
    expect(remember.properties.ttl_days?.exclusiveMinimum).toBeUndefined()
    expect(remember.properties.fact_id?.exclusiveMinimum).toBe(0)

    const kb = toolInputJsonSchema(KB_TOOL) as unknown as { properties: Record<string, { minItems?: number }> }
    expect(kb.properties.paths?.minItems).toBe(1)
  })

  it('merged field descriptions name every action that requires the field', () => {
    const schema = toolInputJsonSchema(REMEMBER_TOOL) as unknown as { properties: Record<string, { description?: string }> }
    // was "action=update 时必填" only, although remove/helpful/unhelpful require it too
    for (const action of ['update', 'remove', 'helpful', 'unhelpful']) {
      expect(schema.properties.fact_id?.description).toContain(action)
    }
    expect(schema.properties.content?.description).toContain('add')
    expect(schema.properties.content?.description).toContain('update')
  })

  it('every action is discoverable from its tool description', () => {
    for (const spec of TOOL_SPECS) {
      const schema = toolInputJsonSchema(spec) as unknown as { properties?: { action?: { enum?: string[] } } }
      for (const action of schema.properties?.action?.enum ?? []) {
        expect(spec.description, `${spec.name} description must mention "${action}"`).toContain(action)
      }
    }
  })

  it('derives each field`s required actions into its description', () => {
    // The helper both model-facing surfaces call (MCP `inputSchema` and the DSH tool parameters).
    // Per-action wording is stripped, so the authored text can never claim a narrower set than the
    // schema enforces; a field no action requires comes back untouched, and no base text at all
    // stays undefined rather than becoming an empty string.
    expect(mergedFieldDescription('要查看的事实 ID。action=detail 时必填。', ['detail', 'archive'])).toBe('【detail/archive 必填】要查看的事实 ID。')
    expect(mergedFieldDescription('要裁决的矛盾 ID（来自 mem_remember）。', ['contradict_resolve'])).toBe('【contradict_resolve 必填】要裁决的矛盾 ID（来自 mem_remember）。')
    expect(mergedFieldDescription('限定分类；可选。', [])).toBe('限定分类；可选。')
    expect(mergedFieldDescription(undefined, [])).toBeUndefined()
  })

  it('describes what the tools DO, never how memory is retained', () => {
    // Retention (trust decay, reinforcement, TTL enforcement, idle/purge) is the STORE's
    // business. A model cannot observe those clocks and has no action to take on them — the
    // only thing prompt text about them can produce is the temptation to "refresh" a fact by
    // rewriting it, which defeats the very policy it was told about. Tool text therefore
    // says what a call does; `helpful`/`pin` are named as actions only.
    // The list is shared with the DSH plugin's prompt-section guard (see RETENTION_VOCABULARY).
    const banned = RETENTION_VOCABULARY
    for (const spec of TOOL_SPECS) {
      for (const word of banned) {
        expect(spec.description, `${spec.name} must not explain retention ("${word}")`).not.toContain(word)
      }
      // Check the merged `properties` AND every `oneOf` branch: the merge keeps only the
      // FIRST branch per field, so a later branch (pin/unpin carry their own `fact_id`) would
      // otherwise escape the guard while still being shown to the model.
      const schema = toolInputJsonSchema(spec) as unknown as {
        properties?: Record<string, { description?: string }>
        oneOf?: { properties?: Record<string, { description?: string }> }[]
      }
      const groups = [schema.properties ?? {}, ...(schema.oneOf ?? []).map((branch) => branch.properties ?? {})]
      for (const group of groups) {
        for (const [field, property] of Object.entries(group)) {
          for (const word of banned) {
            expect(property.description ?? '', `${spec.name}.${field} must not explain retention ("${word}")`).not.toContain(word)
          }
        }
      }
    }
  })
})

describe('model-facing tool text: what to do, never why or what comes back', () => {
  /** Every authored string the model can read, tagged with where it came from. */
  const authoredTexts = (spec: (typeof TOOL_SPECS)[number]): { where: string; text: string }[] => {
    const out = [{ where: `${spec.name}.description`, text: spec.description }]
    const schema = toolInputJsonSchema(spec) as unknown as {
      properties?: Record<string, { description?: string }>
      oneOf?: { properties?: Record<string, { description?: string }> }[]
    }
    // Merged `properties` AND every `oneOf` branch: the merge keeps only the FIRST branch per
    // field, so a later branch would otherwise escape the guard while still reaching the model.
    const groups = [schema.properties ?? {}, ...(schema.oneOf ?? []).map((branch) => branch.properties ?? {})]
    for (const group of groups) {
      for (const [field, property] of Object.entries(group)) {
        if (property.description) out.push({ where: `${spec.name}.${field}`, text: property.description })
      }
    }
    return out
  }

  it('never describes the result payload, its caps or its flags', () => {
    for (const spec of TOOL_SPECS) {
      for (const { where, text } of authoredTexts(spec)) {
        for (const word of BANNED_RESULT_WORDING) {
          expect(text, `${where} must describe the call, not the result ("${word}")`).not.toContain(word)
        }
      }
    }
  })

  it('never explains why (reason, mechanism, precondition or consequence)', () => {
    for (const spec of TOOL_SPECS) {
      for (const { where, text } of authoredTexts(spec)) {
        for (const word of BANNED_WHY_WORDING) {
          expect(text, `${where} must state what to do, never why ("${word}")`).not.toContain(word)
        }
      }
    }
  })

  it('never says how to proceed or when to reach for it', () => {
    // The workflows live in the system-prompt sections (`avantf:kb-edit` says how to change a
    // document, `knowledge-usage` says when to query) and in the returns. A description that repeats
    // them pays for the same information on every step.
    for (const spec of TOOL_SPECS) {
      for (const { where, text } of authoredTexts(spec)) {
        for (const word of BANNED_PROCEDURE_WORDING) {
          expect(text, `${where} must state what it IS, not how or when to use it ("${word}")`).not.toContain(word)
        }
      }
    }
  })

  it('keeps the parameter semantics that ARE the "what it is" half', () => {
    // The other half of the rule: stripping the explanations must not strip what a value
    // MEANS. These are the load-bearing ones — the `0` sentinels and the action enums.
    const recall = toolInputJsonSchema(RECALL_TOOL) as unknown as { properties: Record<string, { description?: string; enum?: string[] }> }
    expect(recall.properties.limit?.description).toContain('返回条数上限（1-50）')
    expect(recall.properties.max_tokens?.description).toContain('0=不限制')
    const admin = toolInputJsonSchema(ADMIN_TOOL) as unknown as { properties: Record<string, { description?: string }> }
    expect(admin.properties.limit?.description).toContain('1-500')
    const remember = toolInputJsonSchema(REMEMBER_TOOL) as unknown as { properties: Record<string, { description?: string }> }
    expect(remember.properties.ttl_days?.description).toContain('不设有效期')
    const query = toolInputJsonSchema(QUERY_TOOL) as unknown as { properties: Record<string, { description?: string; enum?: string[] }> }
    expect(query.properties.kind?.enum).toEqual(['all', 'fact', 'doc_chunk'])
  })
})

describe('model-facing tool results', () => {
  const fact = {
    fact_id: 1, content: 'x', category: 'general', status: 'active',
    trust_score: 0.42, remaining_days: 12, helpful_count: 3, retrieval_count: 7, supersedes_id: null,
  }

  it('drops the retention diagnostics and keeps the fact fields', () => {
    const detail = withoutRetentionDiagnostics(fact) as Record<string, unknown>
    expect(detail).not.toHaveProperty('trust_score')
    expect(detail).not.toHaveProperty('remaining_days')
    expect(detail).not.toHaveProperty('helpful_count')
    expect(detail).toMatchObject({ fact_id: 1, content: 'x', category: 'general', retrieval_count: 7 })
  })

  it('projects the page wrapper mem_admin list returns', () => {
    const page = withoutRetentionDiagnostics({ facts: [fact], count: 1, total: 1, truncated: false }) as {
      facts: Record<string, unknown>[]
      total: number
    }
    expect(page.total).toBe(1)
    expect(page.facts[0]).not.toHaveProperty('remaining_days')
    expect(page.facts[0]).toMatchObject({ fact_id: 1 })
  })

  it('shapes only mem_admin fact views; diagnostics asked for by name pass through', () => {
    const listResult = modelFacingToolResult('admin', 'list', { facts: [fact] }) as { facts: Record<string, unknown>[] }
    expect(listResult.facts[0]).not.toHaveProperty('trust_score')

    // `trust_diagnose`/`vectors_diagnose` are diagnostics: the caller asked for the numbers.
    const diagnose = { forgetting_soon: 2, reinforced_today: 1 }
    expect(modelFacingToolResult('admin', 'trust_diagnose', diagnose)).toBe(diagnose)

    // other tools are untouched
    const hits = { hits: [{ text: 'x', score: 1 }] }
    expect(modelFacingToolResult('recall', 'search', hits)).toBe(hits)
  })

  it('passes a non-object payload straight through', () => {
    expect(withoutRetentionDiagnostics(null)).toBeNull()
    expect(withoutRetentionDiagnostics(true)).toBe(true)
    expect(withoutRetentionDiagnostics('x')).toBe('x')
  })
})

/**
 * Regression gate for the two nested Remote envelopes (transport + gateway).
 * The client pages render `unwrapRemoteEnvelope(...).value` directly; if this
 * ever returns the gateway envelope instead of the payload, every settings page
 * silently shows "no data" while reporting success.
 */
describe('unwrapRemoteEnvelope', () => {
  it('peels the transport envelope AND the gateway envelope (the double-wrap bug)', () => {
    const payload = { facts: [{ fact_id: 1 }], total: 1, truncated: false }
    const transport = { ok: true, value: { ok: true, value: payload } }
    const out = unwrapRemoteEnvelope<typeof payload>(transport)
    expect(out).toEqual({ ok: true, value: payload })
    // the regression: the decoded value must be the payload, never the envelope
    expect(out.ok && (out.value as { facts?: unknown }).facts).toEqual([{ fact_id: 1 }])
  })

  it('decodes a gateway error envelope nested inside the transport envelope', () => {
    const transport = { ok: true, value: { ok: false, error: '参数不合法（mem_recall）', violations: ['query: Required'] } }
    const out = unwrapRemoteEnvelope(transport)
    expect(out.ok).toBe(false)
    expect(out.ok ? '' : out.error).toContain('参数不合法')
    expect(formatViolations(out.ok ? undefined : out.violations)).toBe('query: Required')
  })

  it('still accepts a bare payload from the transport (raw gateway return)', () => {
    expect(unwrapRemoteEnvelope({ ok: true, value: { hits: [] } })).toEqual({ ok: true, value: { hits: [] } })
  })

  it('surfaces a transport-level failure', () => {
    const out = unwrapRemoteEnvelope({ ok: false, error: { message: 'carrier down' } })
    expect(out.ok).toBe(false)
    expect(out.ok ? '' : out.error).toBe('carrier down')
  })

  it('treats a non-envelope value as the payload (arrays included)', () => {
    expect(unwrapRemoteEnvelope([1, 2])).toEqual({ ok: true, value: [1, 2] })
    expect(unwrapRemoteEnvelope(undefined)).toEqual({ ok: true, value: undefined })
  })
})

/** The agent-facing envelope shared by the DSH tools and the MCP server. */
describe('ToolEnvelope helpers', () => {
  it('wraps success under `result` and failure under `error` (+violations)', () => {
    expect(toolOk({ hits: [] })).toEqual({ ok: true, result: { hits: [] } })
    expect(toolOk(undefined)).toEqual({ ok: true, result: null })
    expect(toolErr('boom')).toEqual({ ok: false, error: 'boom' })
    expect(toolErr(new Error('boom'), ['a: required'])).toEqual({ ok: false, error: 'boom', violations: ['a: required'] })
  })

  it('builds the shared contract-violation failure', () => {
    const failure = validationError('mem_recall', [{ path: ['query'], message: 'Required' }])
    expect(failure.ok).toBe(false)
    expect(failure.ok ? '' : failure.error).toContain('mem_recall')
    expect(failure.ok ? [] : failure.violations).toEqual(['query: Required'])
  })
})

describe('envAutoDownload (the two download switches)', () => {
  const NAMES = ['AVANTF_MEM_AUTO_DOWNLOAD', 'AVANTF_ENVINIT_AUTO_DOWNLOAD'] as const

  /** Run `fn` with both switches set exactly as given, restoring the process env afterwards. */
  function withEnv(values: Partial<Record<(typeof NAMES)[number], string>>, fn: () => void): void {
    const saved = NAMES.map((name) => [name, process.env[name]] as const)
    for (const name of NAMES) {
      const value = values[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    try {
      fn()
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  it('is an explicit true only for the project switch', () => {
    withEnv({}, () => { expect(envAutoDownload()).toBeUndefined() })
    withEnv({ AVANTF_MEM_AUTO_DOWNLOAD: '1' }, () => { expect(envAutoDownload()).toBe(true) })
    // The family switch merely being ON is not "force downloads": the configured value stands.
    withEnv({ AVANTF_ENVINIT_AUTO_DOWNLOAD: '1' }, () => { expect(envAutoDownload()).toBeUndefined() })
  })

  it('turns downloads OFF when EITHER switch is 0/false, family included', () => {
    withEnv({ AVANTF_MEM_AUTO_DOWNLOAD: '0' }, () => { expect(envAutoDownload()).toBe(false) })
    withEnv({ AVANTF_ENVINIT_AUTO_DOWNLOAD: '0' }, () => { expect(envAutoDownload()).toBe(false) })
    // The family gate wins even against an explicit project "on".
    withEnv({ AVANTF_MEM_AUTO_DOWNLOAD: '1', AVANTF_ENVINIT_AUTO_DOWNLOAD: '0' }, () => { expect(envAutoDownload()).toBe(false) })
    withEnv({ AVANTF_ENVINIT_AUTO_DOWNLOAD: 'false' }, () => { expect(envAutoDownload()).toBe(false) })
  })
})


describe('retrieval queries are bounded', () => {
  it('refuses a query past MAX_QUERY_CHARS, and says why', () => {
    // A CJK query becomes one trigram OR-phrase per character, and SQLite evaluates `MATCH`
    // SYNCHRONOUSLY on the host's event loop: 200 000 characters measured at 119 seconds. Every entry
    // point (plugin tools, MCP inputSchema, CLI argv, UI payload) derives from this union, so the cap
    // belongs here rather than in one of them.
    const over = '中'.repeat(MAX_QUERY_CHARS + 1)
    const rejected = RecallUnion.safeParse({ action: 'search', query: over })
    expect(rejected.success).toBe(false)
    expect(JSON.stringify(rejected.success ? [] : rejected.error.issues)).toContain('事件循环')
    expect(QueryUnion.safeParse({ query: over }).success).toBe(false)
    // Exactly at the cap is still a legal query.
    expect(QueryUnion.safeParse({ query: '中'.repeat(MAX_QUERY_CHARS) }).success).toBe(true)
  })
})
