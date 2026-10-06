/**
 * R4-S2 · shadow annotation — consistency, coverage, attribution rate, and the S1 bridge.
 *
 * WHAT THIS CARD IS. Two (or more) independent annotation passes over the same 64 real facts,
 * each pass answering "if I were the writing agent, what structure would I supply?". The passes
 * live in `/tmp/dsh-r4/annot-*.json` and are NEVER committed: the repo artifact carries only
 * agreement rates, coverage rates and the shape of the disagreements.
 *
 * TWO AGREEMENT CALIBRES (the brief asks for both).
 *   - `exact`: byte-identical strings / identical sets.
 *   - `folded`: NFKC + case fold + whitespace strip, plus (for entity sets) an ALIAS FOLD — two
 *     names fold together when one contains the other, or when the fact's own text carries both
 *     within 6 characters of each other (`…（阿里）…`, `…（PG）…`). This is STRICTLY WEAKER than
 *     R3's synthetic S3 folding (which had a declared synonym table), so this round's folded
 *     DISAGREEMENT rate is an UPPER bound; the comparison to R3's 43.59% / 19.23% is stated that
 *     way rather than pretended to be apples-to-apples.
 *
 * THE S1 BRIDGE (the most decision-relevant number). For every supplied entity name the card
 * classifies it against (a) the fact text and (b) the engine's own extracted bag:
 *   - `literal`: the supplied name is a verbatim substring of the text;
 *   - `alias`: it is not, yet the fact is about that thing — the ONLY shape where a caller-supplied
 *     canonical name adds recall over FTS (R2-8: the engine's own names are 100% literal);
 *   - `not_in_bag_but_literal`: the engine simply did not keep that token (an extraction gap, not a
 *     canonicalisation gap).
 *
 * Usage: node mem/scripts/spikes/bench-r4-1-annotation.mjs [--json <path>]
 * PRIVACY: aggregates only; the disagreement examples are written to /tmp.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as R from './bench-r4-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round4-s2-annotation.json'))
const PASS_FILES = [
  { key: 'A', label: 'in-session, canonical convention, order=length ascending', file: 'annot-a.json' },
  { key: 'B', label: 'in-session, surface-form convention, order=length descending', file: 'annot-b.json' },
  { key: 'A-ext', label: 'independent process, canonical convention, order=length ascending', file: 'annot-a-ext.json' },
  { key: 'B-ext', label: 'independent process, surface-form convention, order=length descending', file: 'annot-b-ext.json' },
]
const HEADLINE_PAIRS = [
  ['A', 'B-ext'],
  ['A', 'A-ext'],
  ['B', 'B-ext'],
  ['A', 'B'],
  ['A-ext', 'B-ext'],
]

const DAY = 86_400_000
const pct = (n, d) => (d ? L.round4(n / d) : null)

const fold = (s) => (s == null ? null : R.normName(String(s)))
const dayDiff = (a, b) => {
  if (!a || !b) return null
  const ta = Date.parse(`${a}T00:00:00Z`)
  const tb = Date.parse(`${b}T00:00:00Z`)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null
  return Math.abs(ta - tb) / DAY
}

/** Two names are the same entity under the alias fold (text = the fact's own text). */
function aliasFold(a, b, text) {
  const fa = fold(a)
  const fb = fold(b)
  if (fa === fb) return true
  if (fa.length >= 2 && fb.length >= 2 && (fa.includes(fb) || fb.includes(fa))) return true
  if (text) {
    const ia = text.indexOf(a)
    const ib = text.indexOf(b)
    if (ia >= 0 && ib >= 0 && Math.abs(ia - ib) <= 6) return true
  }
  return false
}

/** Perfect matching of the smaller set into the larger under `aliasFold`. */
function setsMatch(A, B, text) {
  const a = [...new Set(A)]
  const b = [...new Set(B)]
  if (a.length !== b.length) return false
  const used = new Array(b.length).fill(false)
  const assign = (i) => {
    if (i === a.length) return true
    for (let j = 0; j < b.length; j += 1) {
      if (used[j] || !aliasFold(a[i], b[j], text)) continue
      used[j] = true
      if (assign(i + 1)) return true
      used[j] = false
    }
    return false
  }
  return assign(0)
}

const pathLike = (s) => /[/\\]/.test(s) || /\.[a-z0-9]{1,5}\b/i.test(s)
const urlLike = (s) => /^https?:\/\//i.test(s)
const commitLike = (s) => /^[0-9a-f]{7,40}$/i.test(s)
const kindOf = (s) => (urlLike(s) ? 'url' : commitLike(s) ? 'commit' : pathLike(s) ? 'path_or_doc' : 'other')

function main() {
  const corpus = R.readTmp('corpus.json')
  const index = R.readTmp('corpus-index.json')
  const textById = new Map(corpus.facts.map((f) => [f.id, f.text]))
  const sample = corpus.sample

  const passes = {}
  for (const entry of PASS_FILES) {
    const p = R.tmpPath(entry.file)
    if (!existsSync(p)) continue
    const data = JSON.parse(readFileSync(p, 'utf8'))
    const byId = new Map(data.facts.map((f) => [f.id, f]))
    const missing = sample.filter((id) => !byId.has(id))
    passes[entry.key] = { ...entry, data, byId, missing, convention_raw_location: `${R.tmpPath(entry.file)}#/convention`, convention_bytes: (data.convention ?? '').length }
  }
  const keys = Object.keys(passes)
  L.banner('R4-S2 · shadow annotation consistency', { passes: keys.join(','), sample: sample.length })

  // ── per-field comparison ──────────────────────────────────────────────────────────────────────
  const compare = (a, b, id) => {
    const text = textById.get(id)
    const ea = a?.entities ?? []
    const eb = b?.entities ?? []
    const entExact = [...ea].sort().join('\u0001') === [...eb].sort().join('\u0001')
    const entFolded = setsMatch(ea, eb, text)
    const normEq = (x, y) => (x == null && y == null) || (x != null && y != null && fold(x) === fold(y))
    const looseEq = (x, y) => normEq(x, y) || (x != null && y != null && (fold(x).includes(fold(y)) || fold(y).includes(fold(x))))
    const subjExact = (a?.subject ?? null) === (b?.subject ?? null)
    const attrExact = (a?.attribute ?? null) === (b?.attribute ?? null)
    const dateExact = (a?.event_date ?? null) === (b?.event_date ?? null)
    const d = dayDiff(a?.event_date ?? null, b?.event_date ?? null)
    const dateFolded = dateExact || (d !== null && d <= 1)
    const srcExact = (a?.source_ref ?? null) === (b?.source_ref ?? null)
    return {
      id,
      entities_exact: entExact,
      entities_folded: entFolded,
      subject_exact: subjExact,
      subject_folded: looseEq(a?.subject, b?.subject),
      attribute_exact: attrExact,
      attribute_folded: looseEq(a?.attribute, b?.attribute),
      event_date_exact: dateExact,
      event_date_folded: dateFolded,
      source_ref_exact: srcExact,
      source_ref_folded: normEq(a?.source_ref, b?.source_ref),
      source_ref_both_filled: (a?.source_ref ?? null) !== null && (b?.source_ref ?? null) !== null,
    }
  }

  const pairs = {}
  for (const [ka, kb] of HEADLINE_PAIRS) {
    const A = passes[ka]
    const B = passes[kb]
    if (!A || !B) continue
    const ids = sample.filter((id) => A.byId.has(id) && B.byId.has(id))
    const rows = ids.map((id) => compare(A.byId.get(id), B.byId.get(id), id))
    const n = rows.length
    const rate = (k) => pct(rows.filter((r) => r[k]).length, n)
    // "at least one field different", the R3 headline metric.
    const anyExactDiff = rows.filter((r) => !(r.entities_exact && r.subject_exact && r.attribute_exact && r.event_date_exact && r.source_ref_exact)).length
    const anyFoldedDiff = rows.filter((r) => !(r.entities_folded && r.subject_folded && r.attribute_folded && r.event_date_folded && r.source_ref_folded)).length
    const anyExactDiffNoAttr = rows.filter((r) => !(r.entities_exact && r.subject_exact && r.event_date_exact && r.source_ref_exact)).length
    const anyFoldedDiffNoAttr = rows.filter((r) => !(r.entities_folded && r.subject_folded && r.event_date_folded && r.source_ref_folded)).length
    pairs[`${ka}__vs__${kb}`] = {
      pass_a: ka, pass_b: kb, n,
      exact_agreement: {
        entities: rate('entities_exact'), subject: rate('subject_exact'), attribute: rate('attribute_exact'),
        event_date: rate('event_date_exact'), source_ref: rate('source_ref_exact'),
      },
      folded_agreement: {
        entities: rate('entities_folded'), subject: rate('subject_folded'), attribute: rate('attribute_folded'),
        event_date: rate('event_date_folded'), source_ref: rate('source_ref_folded'),
      },
      exact_disagreement_any_field: pct(anyExactDiff, n),
      folded_disagreement_any_field: pct(anyFoldedDiff, n),
      exact_disagreement_any_field_except_attribute: pct(anyExactDiffNoAttr, n),
      folded_disagreement_any_field_except_attribute: pct(anyFoldedDiffNoAttr, n),
      source_ref_both_filled: rows.filter((r) => r.source_ref_both_filled).length,
      per_fact_rows: rows,
    }
  }

  // ── per-pass coverage + attribution + the S1 bridge ───────────────────────────────────────────
  const perPass = {}
  for (const [k, p] of Object.entries(passes)) {
    const rows = sample.filter((id) => p.byId.has(id)).map((id) => p.byId.get(id))
    const text = (id) => textById.get(id) ?? ''
    let suppliedNames = 0
    let literal = 0
    let alias = 0
    let inEngineBag = 0
    let notInBagButLiteral = 0
    const srcKinds = {}
    let sourceFilled = 0
    let eventFilled = 0
    let entityFacts = 0
    let subjectFilled = 0
    let attributeFilled = 0
    const aliasExamples = []
    for (const r of rows) {
      const t = text(r.id)
      const names = [...new Set(r.entities ?? [])]
      if (names.length) entityFacts += 1
      if (r.subject) subjectFilled += 1
      if (r.attribute) attributeFilled += 1
      if (r.event_date) eventFilled += 1
      if (r.source_ref) {
        sourceFilled += 1
        const kd = kindOf(r.source_ref)
        srcKinds[kd] = (srcKinds[kd] ?? 0) + 1
      }
      for (const n of names) {
        suppliedNames += 1
        const isLiteral = t.includes(n)
        if (isLiteral) literal += 1
        else {
          alias += 1
          if (aliasExamples.length < 40) aliasExamples.push({ id: r.id, name: n, name_len: n.length })
        }
      }
    }
    perPass[k] = {
      label: p.label, convention_raw_location: p.convention_raw_location, convention_bytes: p.convention_bytes, facts: rows.length, missing_ids: p.missing,
      coverage: {
        entities_non_empty: pct(entityFacts, rows.length),
        subject_non_null: pct(subjectFilled, rows.length),
        attribute_non_null: pct(attributeFilled, rows.length),
        event_date_non_null: pct(eventFilled, rows.length),
        source_ref_non_null: pct(sourceFilled, rows.length),
      },
      source_ref_kinds: srcKinds,
      supplied_entity_names: suppliedNames,
      supplied_name_literal_in_text: literal,
      supplied_name_literal_share: pct(literal, suppliedNames),
      supplied_name_alias: alias,
      supplied_name_alias_share: pct(alias, suppliedNames),
      facts_with_at_least_one_alias: null, // filled below
    }
    // facts with >= 1 alias-shaped supplied name = the B1 addressable population, model-measured
    let factsWithAlias = 0
    for (const r of rows) {
      const t = text(r.id)
      if ([...new Set(r.entities ?? [])].some((n) => !t.includes(n))) factsWithAlias += 1
    }
    perPass[k].facts_with_at_least_one_alias = factsWithAlias
    perPass[k].facts_with_at_least_one_alias_share = pct(factsWithAlias, rows.length)
    R.writeTmp(`s2-alias-examples-${k}.json`, { pass: k, note: 'derived strings only, /tmp only', examples: aliasExamples })
  }

  // ── disagreement examples to /tmp (report gets shapes, not strings) ───────────────────────────
  for (const [name, rec] of Object.entries(pairs)) {
    const A = passes[rec.pass_a]
    const B = passes[rec.pass_b]
    const diff = rec.per_fact_rows.filter((r) => !(r.entities_exact && r.subject_exact && r.attribute_exact && r.event_date_exact && r.source_ref_exact))
    const examples = diff.slice(0, 40).map((r) => ({
      id: r.id,
      a: { entities: A.byId.get(r.id)?.entities, subject: A.byId.get(r.id)?.subject, attribute: A.byId.get(r.id)?.attribute, event_date: A.byId.get(r.id)?.event_date, source_ref: A.byId.get(r.id)?.source_ref },
      b: { entities: B.byId.get(r.id)?.entities, subject: B.byId.get(r.id)?.subject, attribute: B.byId.get(r.id)?.attribute, event_date: B.byId.get(r.id)?.event_date, source_ref: B.byId.get(r.id)?.source_ref },
      flags: Object.fromEntries(Object.entries(r).filter(([k, v]) => k.endsWith('_exact') && v === false)),
    }))
    R.writeTmp(`s2-diff-${name}.json`, { note: 'derived strings only, /tmp only', examples })
  }

  const headlineKey = HEADLINE_PAIRS.map(([a, b]) => `${a}__vs__${b}`).find((k) => pairs[k])
  const out = {
    card: 'R4-S2',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'annotation card — no retrieval pass (R2-5/R2-7 convention)' },
    design: {
      sample_size: sample.length,
      stratification: 'length ascending, every floor(85/64)-th fact',
      passes_present: keys,
      pass_files: PASS_FILES.filter((p) => passes[p.key]).map((p) => ({ key: p.key, label: p.label, file: `/tmp/dsh-r4/${p.file}` })),
      independence: {
        structural: 'passes marked "independent process" ran in a separate `dsh headless` process (own context, own session), reading only /tmp/dsh-r4/corpus.json; the two in-session passes share one context',
        conventions_differ: 'passes A/A-ext use canonical names + noun-phrase attributes + ascending order; passes B/B-ext use surface forms + verb-phrase attributes + descending order',
        temperature: 'not controllable from this harness; recorded as a residual',
        honest_residual: 'the two in-session passes share the model instance AND the context, so their agreement is inflated; the two-process pairs are the ones to read as cross-session evidence',
      },
      calibres: {
        exact: 'byte-identical strings / identical sets',
        folded: 'NFKC + case fold + whitespace strip; entity sets additionally allow an ALIAS FOLD (containment, or co-occurrence within 6 chars in the fact text); event_date folds within ±1 day; subject/attribute fold on containment',
        folding_is_weaker_than_R3: 'R3 S3 used a declared synonym table; this round has none, so folded disagreement here is an UPPER bound (conservative)',
      },
    },
    per_pass: perPass,
    pairwise: Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, { ...v, per_fact_rows: undefined }])),
    pairwise_per_fact: Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v.per_fact_rows])),
    headline: headlineKey ? {
      pair: headlineKey,
      exact_disagreement_any_field: pairs[headlineKey].exact_disagreement_any_field,
      folded_disagreement_any_field: pairs[headlineKey].folded_disagreement_any_field,
      comparison_to_R3: 'R3 synthetic S3: 43.59% exact / 19.23% folded; this round\'s folding is weaker, so its folded number is an upper bound on disagreement',
    } : null,
    bridge_to_S1: {
      s1_engine_name_literal_share: 1,
      model_measured_alias_share: Object.fromEntries(Object.entries(perPass).map(([k, v]) => [k, v.supplied_name_alias_share])),
      model_measured_facts_with_alias: Object.fromEntries(Object.entries(perPass).map(([k, v]) => [k, v.facts_with_at_least_one_alias_share])),
      note: 'a fact with >=1 alias-shaped supplied name is the B1 ADDRESSABLE population; S3 turns it into retrieval displacement',
    },
    examples_location: '/tmp/dsh-r4/s2-diff-*.json and s2-alias-examples-*.json (never committed)',
    reproduction: 'node mem/scripts/spikes/bench-r4-1-annotation.mjs --json mem/docs/spikes/raw/round4-s2-annotation.json',
  }
  const whitelist = R.repoCjkWhitelist()
  out.privacy = R.auditArtifact(out, { cjkWhitelist: whitelist })
  if (!out.privacy.clean) {
    console.error('PRIVACY AUDIT FAILED', JSON.stringify(out.privacy).slice(0, 3000))
    process.exitCode = 1
  }
  L.writeJson(jsonOut, out)
  console.log(`passes: ${keys.join(', ')}`)
  for (const [k, v] of Object.entries(pairs)) {
    console.log(`  ${k}: exact-any ${v.exact_disagreement_any_field}  folded-any ${v.folded_disagreement_any_field}`)
  }
  for (const [k, v] of Object.entries(perPass)) {
    console.log(`  ${k}: alias-share ${v.supplied_name_alias_share}  facts-with-alias ${v.facts_with_at_least_one_alias_share}  source_ref ${v.coverage.source_ref_non_null}  event_date ${v.coverage.event_date_non_null}`)
  }
}

main()
