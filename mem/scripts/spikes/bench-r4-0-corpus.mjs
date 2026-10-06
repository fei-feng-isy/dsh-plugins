/**
 * R4-S1 · the real corpus profile, and the number that decides B1's schedule:
 * the **alias vs literal shape share**.
 *
 * WHY SHAPE SHARE IS THE WHOLE CARD. R2-8 measured 2803/2803 (fact, entity) pairs on the live store
 * where the entity name is already a verbatim substring of the fact (the LITERAL shape). R3 then
 * showed the large caller-supplier gain exists ONLY on the ALIAS shape ("the canonical name does not
 * appear in the text"). So the share of facts whose stored names are NOT literal is, multiplied by
 * the write-side compliance rate, the real B1 expectation — and it is measurable offline.
 *
 * WHAT IS MEASURED
 *   - length distribution, entity-bag width, created/updated spread, staleness of the entity bag;
 *   - for every (fact, entity) pair: `literal` (verbatim substring), `normalized_only` (substring
 *     only after NFKC + case fold + whitespace strip), `absent` (neither);
 *   - the B1 ADDRESSABLE population implied by each reading, and the name-shape profile that says
 *     which pairs could plausibly be written differently by a caller (ASCII / mixed case /
 *     full-width are the ones a canonicalisation convention can move);
 *   - the count of facts carrying a parseable event-time expression (S5's demand upper bound).
 *
 * A LATER STAGE ADDS THE MODEL MEASUREMENT: this card can only say "the engine's own names are
 * literal". Whether a REAL writer would supply a non-literal canonical name is measured by the
 * round-4 shadow annotation (S2), and the bridge is reported in `round4-s2-annotation.json`.
 *
 * Usage: node mem/scripts/spikes/bench-r4-0-corpus.mjs [--json <path>] [--sample N]
 * PRIVACY: the repo artifact carries counts/ratios/lengths only. The fact text goes to
 * `/tmp/dsh-r4/corpus.json` (annotation input) and nowhere else.
 */
import { join } from 'node:path'
import * as R from './bench-r4-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round4-s1-corpus.json'))
const SAMPLE = Number(L.arg('sample', 64))
const NOW = new Date()

const pct = (n, d) => (d ? L.round4(n / d) : null)
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : null)

function readFacts(snap) {
  const db = L.openReadOnly(snap)
  try {
    const facts = db.prepare(
      `select fact_id id, content, length(content) len, category, trust_score trust, pinned,
              created_at created, updated_at updated, entities_version ev, mirror_source mirror, embedding_model model
         from facts where status='active' order by fact_id`,
    ).all()
    const links = db.prepare(
      `select fe.fact_id id, e.name name from fact_entities fe join entities e on e.entity_id = fe.entity_id
         join facts f on f.fact_id = fe.fact_id where f.status='active'`,
    ).all()
    const bags = new Map()
    for (const r of links) {
      if (!bags.has(r.id)) bags.set(r.id, [])
      bags.get(r.id).push(r.name)
    }
    const archived = db.prepare("select count(*) n from facts where status='archived'").get().n
    const evRows = db.prepare("select entities_version v, count(*) n from facts where status='active' group by entities_version").all()
    return { facts, bags, archived, evRows }
  } finally {
    db.close()
  }
}

/** Full-width ASCII (U+FF01..U+FF5E) — the shape a half/full-width canonicalisation would move. */
const HAS_FULLWIDTH = /[\uff01-\uff5e]/
const HAS_UPPER = /[A-Z]/
const ASCII_ONLY = /^[\x20-\x7e]+$/

const shapeOf = (name) => {
  const n = String(name)
  return {
    ascii: ASCII_ONLY.test(n),
    cjk: /[\u4e00-\u9fff]/.test(n),
    fullwidth: HAS_FULLWIDTH.test(n),
    upper: HAS_UPPER.test(n),
    len: n.length,
  }
}

function main() {
  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r40-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { facts, bags, archived, evRows } = readFacts(snap)
  L.banner('R4-S1 · real corpus profile + alias/literal shape', { snapshot_source: L.DEFAULT_DB, active: facts.length, archived })

  // ── per-pair shape classification ─────────────────────────────────────────────────────────────
  let pairs = 0
  let literalPairs = 0
  let normalizedOnlyPairs = 0
  let absentPairs = 0
  const perFact = []
  const shapeHist = { ascii: 0, cjk: 0, fullwidth: 0, upper: 0 }
  const nameLen = []
  for (const f of facts) {
    const content = String(f.content)
    const contentNorm = R.normName(content)
    const names = [...new Set(bags.get(f.id) ?? [])]
    let lit = 0
    let normOnly = 0
    let absent = 0
    for (const name of names) {
      pairs += 1
      const raw = content.includes(name)
      const folded = raw || contentNorm.includes(R.normName(name))
      if (raw) lit += 1
      else if (folded) normOnly += 1
      else absent += 1
      const s = shapeOf(name)
      if (s.ascii) shapeHist.ascii += 1
      if (s.cjk) shapeHist.cjk += 1
      if (s.fullwidth) shapeHist.fullwidth += 1
      if (s.upper) shapeHist.upper += 1
      nameLen.push(s.len)
    }
    literalPairs += lit
    normalizedOnlyPairs += normOnly
    absentPairs += absent
    perFact.push({ id: f.id, len: f.len, names: names.length, literal: lit, normalized_only: normOnly, absent })
  }
  nameLen.sort((a, b) => a - b)

  const factsWithNonLiteral = perFact.filter((p) => p.normalized_only + p.absent > 0)
  const factsWithAbsent = perFact.filter((p) => p.absent > 0)
  const bagWidths = perFact.map((p) => p.names).sort((a, b) => a - b)
  const lens = facts.map((f) => f.len).sort((a, b) => a - b)

  // ── timestamps ────────────────────────────────────────────────────────────────────────────────
  const created = facts.map((f) => String(f.created)).sort()
  const updated = facts.map((f) => String(f.updated)).sort()
  const createdDays = new Set(created.map((c) => c.slice(0, 10)))
  const daySpan = (created.length && createdDays.size)
    ? Math.round((Date.parse(created.at(-1).slice(0, 10)) - Date.parse(created[0].slice(0, 10))) / 86_400_000)
    : null

  // ── event-time expressions in the text (S5 demand upper bound) ────────────────────────────────
  const byRule = {}
  let withTime = 0
  const withTimeIds = []
  for (const f of facts) {
    const exprs = R.allTimeExpressions(String(f.content), NOW)
    if (exprs.length) {
      withTime += 1
      withTimeIds.push(f.id)
      for (const e of exprs) byRule[e.rule] = (byRule[e.rule] ?? 0) + 1
    }
  }

  // ── annotation sample: stratified by length, deterministic ────────────────────────────────────
  const ordered = [...facts].sort((a, b) => a.len - b.len || a.id - b.id)
  const step = Math.max(1, Math.floor(ordered.length / SAMPLE))
  const sample = ordered.filter((_, i) => i % step === 0).slice(0, SAMPLE)
  const sampleIds = sample.map((f) => f.id)

  // The annotation input lives in /tmp: id + length + text, NO engine entity bag (showing it would
  // bias the annotator toward the engine's own names and inflate the agreement with production).
  R.writeTmp('corpus.json', {
    generated_at: new Date().toISOString(),
    source: L.DEFAULT_DB,
    active_facts: facts.length,
    sample_size: sample.length,
    facts: ordered.map((f) => ({ id: f.id, len: f.len, text: String(f.content) })),
    sample: sampleIds,
  })
  R.writeTmp('corpus-index.json', {
    ordered_ids: ordered.map((f) => f.id),
    length_by_id: Object.fromEntries(ordered.map((f) => [f.id, f.len])),
    bag_by_id: Object.fromEntries(perFact.map((p) => [p.id, { names: p.names, literal: p.literal, normalized_only: p.normalized_only, absent: p.absent }])),
    sample: sampleIds,
  })

  const bands = { le20: 0, '20-100': 0, '100-500': 0, '500-1000': 0, gt1000: 0 }
  for (const n of lens) {
    if (n <= 20) bands.le20 += 1
    else if (n <= 100) bands['20-100'] += 1
    else if (n <= 500) bands['100-500'] += 1
    else if (n <= 1000) bands['500-1000'] += 1
    else bands.gt1000 += 1
  }

  const out = {
    card: 'R4-S1',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'profile card — no retrieval pass, so no production arm to identity-check (R2-5/R2-7 convention)' },
    snapshot: { source: L.DEFAULT_DB, active_facts: facts.length, archived_facts: archived, entity_rows: null },
    length: {
      min: lens[0] ?? null, p25: quantile(lens, 0.25), median: quantile(lens, 0.5), p75: quantile(lens, 0.75),
      max: lens.at(-1) ?? null, mean: lens.length ? L.round4(lens.reduce((a, b) => a + b, 0) / lens.length) : null,
      bands,
    },
    entity_bag: {
      facts_with_bag: perFact.filter((p) => p.names > 0).length,
      pairs,
      median_width: quantile(bagWidths, 0.5),
      min_width: bagWidths[0] ?? null,
      max_width: bagWidths.at(-1) ?? null,
      pairs_per_fact_mean: facts.length ? L.round4(pairs / facts.length) : null,
    },
    name_shape: {
      ascii_only: shapeHist.ascii, cjk: shapeHist.cjk, fullwidth: shapeHist.fullwidth, has_uppercase: shapeHist.upper,
      len_median: quantile(nameLen, 0.5), len_max: nameLen.at(-1) ?? null,
    },
    alias_vs_literal: {
      definition: {
        literal: 'stored entity name is a verbatim substring of the fact text',
        normalized_only: 'not literal, but a substring after NFKC + case fold + whitespace strip',
        absent: 'neither (the engine stored a name the text does not carry contiguously)',
      },
      pairs,
      literal_pairs: literalPairs, normalized_only_pairs: normalizedOnlyPairs, absent_pairs: absentPairs,
      literal_share: pct(literalPairs, pairs),
      non_literal_share: pct(normalizedOnlyPairs + absentPairs, pairs),
      facts: facts.length,
      facts_with_non_literal_name: factsWithNonLiteral.length,
      facts_with_non_literal_share: pct(factsWithNonLiteral.length, facts.length),
      facts_with_absent_name: factsWithAbsent.length,
      facts_with_absent_share: pct(factsWithAbsent.length, facts.length),
      b1_addressable_population_upper_bound: pct(factsWithNonLiteral.length, facts.length),
      reading: 'the engine\'s own names are literal by construction; the model-level canonicalisation gap is measured in S2 against the shadow annotation, and the retrieval consequence in S3',
    },
    timestamps: {
      created_min: created[0] ?? null, created_max: created.at(-1) ?? null,
      updated_min: updated[0] ?? null, updated_max: updated.at(-1) ?? null,
      distinct_created_days: createdDays.size, write_span_days: daySpan,
    },
    staleness: { by_entities_version: evRows, note: 'a fact whose entities_version is behind the store version still carries the old bag' },
    event_time: {
      definition: 'facts whose text carries at least one expression the round-1 Chinese time parser resolves',
      facts_with_parseable_time: withTime, share: pct(withTime, facts.length),
      by_rule: byRule,
      fact_ids: withTimeIds,
      demand_upper_bound_note: 'this is the A2 DEMAND upper bound: the most time queries the corpus could possibly support',
    },
    annotation: {
      sample_size: sample.length, sample_ids: sampleIds, stratified_by: 'length ascending, every floor(n/sample)-th fact',
      derived_input: R.tmpPath('corpus.json'),
      note: 'the text is in /tmp only; `bag_by_id` deliberately absent from the sample request so the two passes are not anchored on the engine names',
    },
    reproduction: 'node mem/scripts/spikes/bench-r4-0-corpus.mjs --json mem/docs/spikes/raw/round4-s1-corpus.json',
  }

  const whitelist = R.repoCjkWhitelist()
  out.privacy = R.auditArtifact(out, { cjkWhitelist: whitelist })
  out.privacy.whitelist_size = whitelist.size
  out.privacy.pattern_count = R.SENSITIVE_PATTERNS.length
  if (!out.privacy.clean) {
    console.error('PRIVACY AUDIT FAILED', JSON.stringify(out.privacy).slice(0, 2000))
    process.exitCode = 1
  }
  L.writeJson(jsonOut, out)
  console.log(`active ${facts.length}; pairs ${pairs}; literal ${literalPairs} (${out.alias_vs_literal.literal_share}); non-literal facts ${factsWithNonLiteral.length}; with event time ${withTime}`)
  R.rm(work)
}

main()
