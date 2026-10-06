import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  ADMIN_ACTIONS,
  REMEMBER_TOOL,
  RECALL_TOOL,
  ADMIN_TOOL,
  KB_TOOL,
  QUERY_TOOL,
  TOOL_SPECS,
  toolInputJsonSchema,
} from '@avantf/mem-contract'
import { unwrapRemoteEnvelope, formatViolations } from '@avantf/mem-contract/remote'
import { flattenToolSpec, zodToSpec, schemaDescription } from '../src/tool_schema.js'

/**
 * The derivation reads structural internals (`def.options`, `def.shape`, a literal's `def.values`)
 * to walk the unions and objects, so its failure mode is SILENT: if a zod upgrade renames one,
 * every field falls back to `{ type: 'string' }` and the model loses each field's real
 * type/constraints without a single error. These assertions pin the derived shape for that
 * reason — they are contract tests for the model-facing surface, not incidental coverage.
 *
 * (The FIELD-level mapping no longer hand-reads internals: it goes through zod's own
 * `z.toJSONSchema`, which is why a type tag change can only break this file's expectations and
 * not the derivation itself.)
 */
describe('union → DSH parameter map', () => {
  const remember = flattenToolSpec(REMEMBER_TOOL)

  it('collects one `action` enum from every union branch, in declaration order', () => {
    expect(remember['action']?.enum).toEqual(['add', 'update', 'remove', 'helpful', 'unhelpful'])
    expect(remember['action']?.required).toBe(true)
    expect(remember['action']?.type).toBe('string')
  })

  it('merges the branches` fields instead of taking the first branch only', () => {
    // `fact_id` only exists on update/remove/helpful/unhelpful — a first-branch-only
    // merge would drop it and the model could never call those actions. `source_ref` / `event_date`
    // / `valid_until` (batch 1) live on add/update only, so they exercise the same merge path.
    expect(Object.keys(remember).sort()).toEqual([
      'action', 'category', 'content', 'event_date', 'fact_id', 'reason', 'source_ref', 'ttl_days', 'valid_until',
    ])
  })

  it('keeps each field`s real type and description', () => {
    expect(remember['content']?.type).toBe('string')
    expect(remember['ttl_days']?.type).toBe('integer') // zod .int() → JSON integer
    expect(remember['reason']?.type).toBe('string')
    expect(remember['content']?.description).toContain('一句自包含的陈述')
  })

  it('describes arrays with their item type', () => {
    const recall = flattenToolSpec(RECALL_TOOL)
    expect(recall['entities']?.type).toBe('array')
    expect(recall['entities']?.items?.type).toBe('string')
    expect(recall['limit']?.type).toBe('integer')
    // Batch 1: the provenance filter and the per-leg-evidence switch are derived like any other
    // field, so a model calling `mem_recall` can actually send them.
    expect(recall['source']?.type).toBe('string')
    expect(recall['include_scores']?.type).toBe('boolean')
  })

  it('derives every tool without falling back to a bare string', () => {
    // The fallback is the silent-degradation path: if the structural read stops matching (a zod
    // upgrade renaming `def`, say), fields come back as `{type:'string'}` and NOTHING throws.
    // Only genuinely-string fields may look like that, and every tool must expose its own action
    // enum — which is derived from the same structures, so it goes missing at the same time.
    for (const spec of TOOL_SPECS) {
      const flat = flattenToolSpec(spec)
      expect(Object.keys(flat).length, spec.name).toBeGreaterThan(0)
      // The degradation this guards against turns EVERY field into `{type:'string'}`. Counting
      // fields was a proxy for that and broke on a legitimately single-field tool (`kb_remove`),
      // so the check is now the property itself: not everything came back a bare string.
      expect(Object.values(flat).some(field => field.type !== 'string'), `${spec.name} all degraded`).toBe(true)
      // The union-shaped tools carry an `action` discriminator; the split knowledge tools
      // (`kb_add`/`kb_list`/`kb_remove`/`kb_reindex`) and `kb_query` are plain objects, so the
      // check is "if it has one, it was derived" rather than "every tool has one".
      if (flat['action'] === undefined) continue
      expect(flat['action']?.enum?.length, spec.name).toBeGreaterThan(0)
    }
    const kb = flattenToolSpec(KB_TOOL)
    expect(kb['paths']?.items?.type).toBe('string')
    expect(kb['doc_id']?.type).toBe('integer')
  })

  it('marks a plain object`s own required fields', () => {
    const query = flattenToolSpec(QUERY_TOOL)
    expect(query['query']?.required).toBe(true)
    expect(query['limit']?.required).toBeUndefined() // has a zod default
    expect(query['kind']?.type).toBe('string')
  })

  it('lists the actions of a mixed-requiredness union once each', () => {
    const admin = flattenToolSpec(ADMIN_TOOL)
    // Derived from the contract constant, not retyped: a literal list here silently lags every
    // new action (it did for `contradict_resolve`), which is the drift this test exists to catch.
    expect(admin['action']?.enum).toEqual([...ADMIN_ACTIONS])
  })
})

/**
 * The same tool reaches the model through two surfaces — this one (DSH tool parameters) and the
 * MCP `inputSchema` — and they are derived by two different functions. The failure that motivated
 * these assertions: `flattenToolSpec` kept whichever union branch declared a field FIRST, so the
 * model read "action=detail 时必填" for `mem_admin.fact_id` although five actions require it, and
 * no action at all for `contradiction_id`. A wrong call then cost a `violations` round-trip.
 * Descriptions are derived by one shared contract function now; equality is the guard.
 */
describe('the DSH and MCP surfaces agree', () => {
  it('describes every field the same way on both', () => {
    for (const spec of TOOL_SPECS) {
      const dsh = flattenToolSpec(spec)
      const mcp = toolInputJsonSchema(spec) as { properties?: Record<string, { description?: string }> }
      for (const [key, field] of Object.entries(mcp.properties ?? {})) {
        expect(dsh[key]?.description, `${spec.name}.${key}`).toBe(field.description)
      }
    }
  })

  it('marks the same fields required on both', () => {
    for (const spec of TOOL_SPECS) {
      const dsh = Object.entries(flattenToolSpec(spec)).filter(([, param]) => param.required === true).map(([key]) => key)
      const mcp = (toolInputJsonSchema(spec) as { required?: string[] }).required ?? []
      expect(dsh.sort(), spec.name).toEqual([...mcp].sort())
    }
  })

  it('names the actions that require a field, not just the branch that declares it', () => {
    const remember = flattenToolSpec(REMEMBER_TOOL)
    expect(remember['content']?.description).toContain('【add/update 必填】')
    expect(remember['fact_id']?.description).toContain('【update/remove/helpful/unhelpful 必填】')
    expect(remember['category']?.description).not.toContain('必填】') // optional in every action

    const recall = flattenToolSpec(RECALL_TOOL)
    expect(recall['query']?.description).toContain('【search 必填】')
    // `related` needs an entity too — the first branch that DECLARED the field (`probe`) said
    // nothing about it, which is the same defect in a second place.
    expect(recall['entity']?.description).toContain('【probe/related 必填】')
    expect(recall['entities']?.description).toContain('【reason 必填】')

    const admin = flattenToolSpec(ADMIN_TOOL)
    expect(admin['fact_id']?.description).toContain('【detail/archive/restore/pin/unpin 必填】')
    expect(admin['contradiction_id']?.description).toContain('【contradict_resolve 必填】')
    expect(admin['resolution']?.description).toContain('【contradict_resolve 必填】')
    expect(admin['loser_fact_id']?.description).not.toContain('必填】') // optional even where it exists

    const kb = flattenToolSpec(KB_TOOL)
    expect(kb['doc_id']?.description).toContain('【detail/remove 必填】')
    expect(kb['title']?.description).not.toContain('必填】')
  })
})

describe('scalar derivation', () => {
  it('reads through optional/default wrappers to the underlying type', () => {
    const flat = flattenToolSpec(RECALL_TOOL)
    // `limit` is `z.number().int().positive().max(50).optional()`
    expect(flat['limit']?.type).toBe('integer')
    expect(flat['limit']?.description).toContain('返回条数上限')
  })

  it('returns no description when none was authored', () => {
    expect(schemaDescription({})).toBeUndefined()
    // A REAL schema, not a hand-made mirror of zod's internals: the old fake
    // (`{ _def: { typeName: 'ZodBoolean' } }`) had to be rewritten by hand on every zod bump,
    // and passing a fake that no longer matched proved nothing about the real derivation.
    expect(zodToSpec(z.boolean())).toEqual({ type: 'boolean' })
  })

  it('degrades to a plain string for a non-schema, rather than throwing', () => {
    // `flattenToolSpec` walks whatever the contract hands it; a value that is not a zod schema
    // must still produce a usable spec instead of taking the whole tool registration down.
    expect(zodToSpec({ _def: { typeName: 'ZodBoolean' } })).toEqual({ type: 'string' })
    expect(zodToSpec(undefined)).toEqual({ type: 'string' })
  })
})

/**
 * The client tabs read every host reply through this decoder, and getting it
 * wrong is exactly the bug that once made both tabs render an envelope as data
 * (empty lists forever). It is harness-free, so it is pinned here.
 */
describe('Remote envelope decoding', () => {
  const violation = { path: ['query'], message: 'Required' }

  it('peels the transport envelope and the application envelope, in that order', () => {
    expect(unwrapRemoteEnvelope({ ok: true, value: { ok: true, value: ['hit'] } })).toEqual({ ok: true, value: ['hit'] })
  })

  it('reports the application error with its violations', () => {
    expect(unwrapRemoteEnvelope({ ok: true, value: { ok: false, error: '参数不合法', violations: ['query: Required'] } }))
      .toEqual({ ok: false, error: '参数不合法', violations: ['query: Required'] })
  })

  it('reports a transport-level failure (no inner envelope)', () => {
    expect(unwrapRemoteEnvelope({ ok: false, error: 'carrier down' })).toEqual({ ok: false, error: 'carrier down' })
  })

  it('tolerates a bare payload and a bare null', () => {
    expect(unwrapRemoteEnvelope([1, 2])).toEqual({ ok: true, value: [1, 2] })
    expect(unwrapRemoteEnvelope(null)).toEqual({ ok: true, value: null })
  })

  it('formats violations for display, and renders nothing for an empty list', () => {
    expect(formatViolations(['a', 'b'])).toBe('a；b')
    expect(formatViolations([])).toBe('')
    expect(formatViolations(undefined)).toBe('')
  })

  it('turns a violation object into a readable message', () => {
    expect(unwrapRemoteEnvelope({ ok: true, value: { ok: false, error: 'bad', violations: [violation] } }).ok).toBe(false)
  })
})
