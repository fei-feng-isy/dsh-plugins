/**
 * R3-3 · S4: the schema tax of B1 — what the caller-supplied structure costs in the tool contract.
 *
 * WHY THIS DECIDES THE CONTRACT SHAPE. The gain measured in R3-1 is worthless if the contract that
 * carries it costs more context than the retrieval saves. The price has three parts, measured here:
 *   (1) CHARACTERS/TOKENS added to `mem_remember`'s input schema, for THREE candidate shapes and at
 *       two description verbosity levels (the tax is mostly PROSE, and that has to be visible);
 *   (2) the CONTEXT convention: a host that re-sends tool definitions every turn pays the increment
 *       every turn; a host that caches them (or sends them once) pays it once. Which one this repo's
 *       runtime does is a HOST property, not observable here — both are given as arithmetic;
 *   (3) the WRITE cost: one `safeParse` increment per call, and the entity-link write — which, for a
 *       caller-supplied canonical bag, is SMALLER than what the engine writes today (the extractor
 *       writes ~30 names per fact, a canonical bag ~2).
 *
 * EVERY DERIVATION GOES THROUGH PRODUCTION CODE. The baseline schema is `toolInputJsonSchema(spec)`
 * from `@avantf/mem-contract` (the same function the MCP surface uses); a candidate is the SAME
 * spec with the production `RememberUnion` branches `.extend()`-ed by the new fields, run through the
 * same derivation. No hand-rolled JSON Schema.
 *
 * Usage: node mem/scripts/spikes/bench-r3-3-schema-tax.mjs [--json <path>]
 * PRIVACY: schema text and timings only; no fact text.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round3-s4-schema-tax.json'))

async function main() {
  // The contract's OWN zod instance (the derivation reads zod internals; a second copy could drift).
  const req = createRequire(join(L.lib('contract'), 'package.json'))
  const { z } = await import(pathToFileURL(req.resolve('zod')).href)
  const c = await import(join(L.lib('contract'), 'lib/index.js'))

  const spec = c.TOOL_SPECS.find((s) => s.name === 'mem_remember')
  const branchName = (o) => o.def.shape.action.def.values[0]
  const options = c.RememberUnion.def.options
  const withFields = (fields) => z.discriminatedUnion('action',
    options.map((o) => (['add', 'update'].includes(branchName(o)) ? o.extend(fields) : o)))
  const schemaOf = (input) => c.toolInputJsonSchema({ ...spec, input })
  const bytes = (s) => Buffer.byteLength(s, 'utf8')

  const field = (schema, description) => schema.optional().describe(description)

  // ── the three candidate shapes, at two verbosity levels ─────────────────────────────────────
  const SHAPES = [
    {
      id: 'shape-1-per-field',
      label: 'one optional parameter per field (subject/attribute/entities/event_date/source_ref/replaces)',
      fields: (verbose) => ({
        subject: field(z.string(), verbose ? '事实的主体（这条事实讲的是谁/什么）；可选。调用方在写入时给出规范主体名。' : '主体；可选。'),
        attribute: field(z.string(), verbose ? '事实的属性/方面（例如「版本」「配置」）；可选。与 subject 一起构成「谁的什么」。' : '属性；可选。'),
        entities: field(z.array(z.string()), verbose ? '这条事实真正关于的规范实体名列表；可选。与引擎自动抽取的实体并存，用于精确的实体型检索。' : '规范实体名列表；可选。'),
        event_date: field(z.string(), verbose ? '事实所指事件发生的日期（YYYY-MM-DD）；可选。与写入时间不同时，时间窗检索依赖它。' : '事件日期 YYYY-MM-DD；可选。'),
        source_ref: field(z.string(), verbose ? '这条事实的来源引用（文档路径或 URL）；可选。用于回答「这话是从哪来的」。' : '来源引用；可选。'),
        replaces: field(z.string(), verbose ? '这条事实取代的旧事实标识；可选。用于表达新旧关系而不删除旧记录。' : '取代的旧事实；可选。'),
      }),
    },
    {
      id: 'shape-2-structure-json',
      label: 'one `structure` JSON object parameter',
      fields: (verbose) => ({
        structure: field(z.object({
          entities: z.array(z.string()).optional(), subject: z.string().optional(), attribute: z.string().optional(),
          event_date: z.string().optional(), source_ref: z.string().optional(), replaces: z.string().optional(),
        }), verbose ? '写入时随事实一起给出的结构：entities 规范实体名列表、subject 主体、attribute 属性、event_date 事件日期（YYYY-MM-DD）、source_ref 来源引用、replaces 被取代的旧事实；字段皆可选。' : '结构对象；字段皆可选。'),
      }),
    },
    {
      id: 'shape-3-minimal-plus-update',
      label: 'minimal set on write (entities + event_date); the rest goes through `update`',
      fields: (verbose) => ({
        entities: field(z.array(z.string()), verbose ? '这条事实真正关于的规范实体名列表；可选。其余结构（subject/attribute/来源）留到 update 再补。' : '规范实体名列表；可选。'),
        event_date: field(z.string(), verbose ? '事实所指事件发生的日期（YYYY-MM-DD）；可选。与写入时间不同时，时间窗检索依赖它。' : '事件日期 YYYY-MM-DD；可选。'),
      }),
    },
  ]

  const baselineSchema = schemaOf(spec.input)
  const baselineJson = JSON.stringify(baselineSchema)
  const baselinePretty = JSON.stringify(baselineSchema, null, 2)
  const baselineFull = JSON.stringify({ name: spec.name, description: spec.description, parameters: baselineSchema })
  const baselineDescriptionChars = spec.description.length
  const fieldsBaselineChars = spec.input.def.options.reduce((n, o) => n + Object.keys(o.def.shape).length, 0)

  const candidates = []
  for (const shape of SHAPES) {
    for (const verbose of [true, false]) {
      const input = withFields(shape.fields(verbose))
      const schema = schemaOf(input)
      const json = JSON.stringify(schema)
      const full = JSON.stringify({ name: spec.name, description: spec.description, parameters: schema })
      candidates.push({
        shape: shape.id, label: shape.label, descriptions: verbose ? 'verbose (production-style)' : 'terse',
        schema_chars: json.length,
        schema_chars_delta: json.length - baselineJson.length,
        schema_bytes_delta: bytes(json) - bytes(baselineJson),
        schema_pretty_chars: JSON.stringify(schema, null, 2).length,
        schema_pretty_chars_delta: JSON.stringify(schema, null, 2).length - baselinePretty.length,
        tokens: L.estimateTokens(json),
        tokens_delta: L.estimateTokens(json) - L.estimateTokens(baselineJson),
        full_tool_chars_delta: full.length - baselineFull.length,
        full_tool_tokens_delta: L.estimateTokens(full) - L.estimateTokens(baselineFull),
      })
    }
  }

  // ── (2) the two context conventions ────────────────────────────────────────────────────────
  const TURNS = [1, 20, 100, 1000]
  const contextConventions = candidates.map((cand) => ({
    shape: cand.shape, descriptions: cand.descriptions, tokens_delta_per_definition: cand.tokens_delta,
    per_turn_host: Object.fromEntries(TURNS.map((t) => [`${t}_turns`, cand.tokens_delta * t])),
    cached_host: { once: cand.tokens_delta },
  }))

  // ── (3a) validation cost: safeParse, baseline vs candidate payloads ────────────────────────
  const reps = 3000
  const medianUs = (fn) => {
    const samples = []
    for (let i = 0; i < reps; i += 1) { const t0 = process.hrtime.bigint(); fn(); samples.push(Number(process.hrtime.bigint() - t0) / 1000) }
    samples.sort((a, b) => a - b)
    return L.round4(samples[Math.floor(samples.length / 2)])
  }
  const payloadBase = { action: 'add', content: '一条用于计时的事实内容。', category: 'general', ttl_days: 0 }
  const payloadFull = { ...payloadBase, subject: '计时', attribute: '配置', entities: ['计时', '配置'], event_date: '2026-10-06', source_ref: 'notes/x.md', replaces: 'none' }
  const structurePayload = { ...payloadBase, structure: { entities: ['计时', '配置'], subject: '计时', attribute: '配置', event_date: '2026-10-06', source_ref: 'notes/x.md', replaces: 'none' } }
  const minimalPayload = { ...payloadBase, entities: ['计时', '配置'], event_date: '2026-10-06' }
  const parseCost = {
    baseline_schema: medianUs(() => spec.input.safeParse(payloadBase)),
  }
  for (const shape of SHAPES) {
    const input = withFields(shape.fields(true))
    const payload = shape.id === 'shape-2-structure-json' ? structurePayload : shape.id === 'shape-3-minimal-plus-update' ? minimalPayload : payloadFull
    parseCost[shape.id] = medianUs(() => input.safeParse(payload))
    parseCost[`${shape.id}_without_new_fields`] = medianUs(() => input.safeParse(payloadBase))
  }

  // ── (3b) link-write cost: the DAO's own statements, 2-name vs 30-name bags ──────────────────
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const benchPath = join(L.tmpdir(), `avantf-r33-links-${process.pid}.db`)
  const db = new DatabaseSync(benchPath)
  const linkBench = () => {
    db.exec('DROP TABLE IF EXISTS fact_entities; DROP TABLE IF EXISTS entities;')
    db.exec('CREATE TABLE entities(entity_id INTEGER PRIMARY KEY, name TEXT UNIQUE)')
    db.exec('CREATE TABLE fact_entities(fact_id INTEGER, entity_id INTEGER, PRIMARY KEY(fact_id, entity_id))')
    db.exec('CREATE INDEX idx_fact_entities_entity ON fact_entities(entity_id)')
    const del = db.prepare('DELETE FROM fact_entities WHERE fact_id = ?')
    const ensure = db.prepare('INSERT OR IGNORE INTO entities(name) VALUES (?)')
    const idOf = db.prepare('SELECT entity_id FROM entities WHERE name = ?')
    const link = db.prepare('INSERT OR IGNORE INTO fact_entities(fact_id, entity_id) VALUES (?, ?)')
    const run = (facts, width) => {
      const t0 = process.hrtime.bigint()
      db.exec('BEGIN')
      for (let f = 0; f < facts; f += 1) {
        del.run(f)
        for (let i = 0; i < width; i += 1) { const n = `e${i % 40}`; ensure.run(n); const row = idOf.get(n); if (row) link.run(f, row.entity_id) }
      }
      db.exec('COMMIT')
      return Number(process.hrtime.bigint() - t0) / 1e6
    }
    run(78, 2)
    const reps2 = 5
    const two = []; const thirty = []
    for (let i = 0; i < reps2; i += 1) { two.push(run(78, 2)); thirty.push(run(78, 30)) }
    two.sort((a, b) => a - b); thirty.sort((a, b) => a - b)
    return { facts: 78, names_per_fact_2_ms: L.round4(two[Math.floor(reps2 / 2)]), names_per_fact_30_ms: L.round4(thirty[Math.floor(reps2 / 2)]) }
  }
  const linkWrite = linkBench()
  db.close()
  const s2 = (() => {
    try { return JSON.parse(readFileSync(join(L.REPO, 'docs/spikes/raw/round3-s2-supplier.json'), 'utf8')) } catch { return null }
  })()
  const measuredWritePath = s2 === null ? null : {
    source: 'round3-s2-supplier.json arm_stats (same statements against the fixture DB, real write path)',
    facts: 78,
    baseline_engine_bags: { links: s2.arm_stats.find((a) => a.arm === 'A0').links_written, ms: s2.arm_stats.find((a) => a.arm === 'A0').rewrite_ms },
    caller_canonical_bags: { links: s2.arm_stats.find((a) => a.arm === 'A2').links_written, ms: s2.arm_stats.find((a) => a.arm === 'A2').rewrite_ms },
    median_bag_width_production: s2.fixture.entities_per_fact_median_production,
    median_bag_width_caller: s2.arm_stats.find((a) => a.arm === 'A2').bag_width_median,
  }

  console.log('baseline schema chars:', baselineJson.length, 'pretty:', baselinePretty.length, 'tokens:', L.estimateTokens(baselineJson))
  for (const cand of candidates) console.log(cand.shape, cand.descriptions, 'delta chars', cand.schema_chars_delta, 'delta tokens', cand.tokens_delta)
  console.log('parse cost (us):', JSON.stringify(parseCost))
  console.log('link write:', JSON.stringify(linkWrite))

  const out = {
    card: 'R3-3 (S4 schema tax + default-unchanged cost side)',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    scope: 'schema + validation + link-write cost of B1; no retrieval A/B here (that is R3-1)',
    identity: { checked: 0, passed: 0, note: 'N/A — this card runs no retrieval pass (schema/validation/link-write only), like R2-5/R2-7' },
    baseline: {
      tool: 'mem_remember',
      derivation: 'toolInputJsonSchema(TOOL_SPECS[mem_remember]) from @avantf/mem-contract (the MCP-surface derivation)',
      schema_chars_compact: baselineJson.length,
      schema_chars_pretty: baselinePretty.length,
      schema_tokens: L.estimateTokens(baselineJson),
      full_tool_chars: baselineFull.length,
      full_tool_tokens: L.estimateTokens(baselineFull),
      description_chars: baselineDescriptionChars,
      baseline_branch_field_count: fieldsBaselineChars,
      note: 'the brief quotes ~5.0k chars for the mem_remember input schema; that is the PRETTY-PRINTED size (measured here at ' +
        String(baselinePretty.length) + '). The compact serialization the host actually ships is ' + String(baselineJson.length) + ' chars. Both conventions are reported below so neither is hidden.',
    },
    candidates,
    context_conventions: {
      per_turn_host: 'the host re-sends tool definitions in every request: pay tokens_delta every turn',
      cached_host: 'the host caches the tool-definition prefix (or sends it once per conversation): pay tokens_delta once',
      observable_here: false,
      note: 'which convention this runtime uses is a HOST property and cannot be observed from this repo; no client/transport was inspected.',
      table: contextConventions,
    },
    validation_cost_us: parseCost,
    link_write_cost: { micro_benchmark_same_statements: linkWrite, measured_write_path: measuredWritePath,
      note: 'the DAO statements (INSERT OR IGNORE entities / fact_entities) are the same; a caller-supplied canonical bag is NARROWER than the extractor bag, so B1 with supplied entities reduces the link write, it does not add to it.' },
    write_cost_summary: {
      baseline_engine_bag_width: measuredWritePath?.median_bag_width_production ?? null,
      caller_canonical_bag_width: measuredWritePath?.median_bag_width_caller ?? null,
      links_per_78_facts_engine: measuredWritePath?.baseline_engine_bags.links ?? null,
      links_per_78_facts_caller: measuredWritePath?.caller_canonical_bags.links ?? null,
    },
    reproduction: 'node mem/scripts/spikes/bench-r3-3-schema-tax.mjs --json mem/docs/spikes/raw/round3-s4-schema-tax.json (run after bench-r3-1 so the measured write path is present; it degrades to null without it)',
  }
  const badKeys = []
  const longStrings = []
  const walk = (v, path) => {
    if (typeof v === 'string') { if (v.length > 300) longStrings.push(`${path}(${v.length})`); return }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`))
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'text' || k === 'content') badKeys.push(`${path}.${k}`); walk(x, `${path}.${k}`) }
  }
  walk(out, '$')
  out.privacy_selfcheck = { text_or_content_keys: badKeys, strings_over_300: longStrings, clean: badKeys.length === 0 && longStrings.length === 0 }
  L.writeJson(jsonOut, out)
}

await main()
