/**
 * R5-S1(a) · the split corpus: the 68 active facts whose text is `length >= 200`.
 *
 * WHY THIS SCRIPT EXISTS AT ALL. Every other round-5 card is scored against the same input, and
 * that input is real memory text, so there must be exactly ONE place that reads it and exactly one
 * destination for what comes out of it: `/tmp/dsh-r5/corpus.json`. The repo artifact this script
 * writes carries the SELECTION (ids, lengths, counts) and a method note only.
 *
 * The shape claim the round-5 brief rests on (`85 active, median 313, p90 513, max 882, 68/85 >=
 * 200`) is re-derived here rather than copied, so a corpus that moved would be visible as a
 * mismatch instead of silently rescoring the previous round's numbers.
 *
 * Usage: node mem/scripts/spikes/bench-r5-0-corpus.mjs [--json <path>] [--min-len 200]
 * PRIVACY: the text goes to `/tmp/dsh-r5/corpus.json` and nowhere else; the repo artifact is
 * ids/lengths/counts plus the audit verdict.
 */
import { join } from 'node:path'
import * as R from './bench-r5-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round5-s1-corpus.json'))
const MIN_LEN = Number(L.arg('min-len', 200))

const q = R.quantile

/** The output contract the two splitting passes are given (also written to /tmp as a prompt card). */
export const SPLIT_CONTRACT = {
  version: 1,
  per_fact_fields: ['id', 'atoms[]', 'relations[]'],
  atom_fields: ['atom_id', 'text', 'source_sentence', 'self_contained'],
  relation_fields: ['from', 'to', 'type'],
  relation_types: R.RELATION_TYPES,
  rules: [
    'each atom carries exactly ONE assertion',
    'each atom is self-contained: it names its own subject and never points at a sibling with a pronoun or an ellipsis',
    'time information that the source states is preserved verbatim in the atom that carries it',
    'relations are declared only BETWEEN atoms of the SAME source fact (the batch = one fact)',
    'atom_id is "<fact_id>.a<k>" with k starting at 1 in reading order',
  ],
}

function main() {
  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r50-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const db = L.openReadOnly(snap)
  let rows
  let archived
  let bagWidths
  try {
    rows = db
      .prepare(
        `select fact_id id, content, length(content) len, category, created_at created, trust_score trust
           from facts where status='active' order by fact_id`,
      )
      .all()
    archived = db.prepare("select count(*) n from facts where status='archived'").get().n
    bagWidths = new Map(
      db
        .prepare(
          `select fe.fact_id id, count(*) n from fact_entities fe join facts f on f.fact_id=fe.fact_id
            where f.status='active' group by fe.fact_id`,
        )
        .all()
        .map((r) => [Number(r.id), Number(r.n)]),
    )
  } finally {
    db.close()
  }
  const lens = rows.map((r) => r.len)
  const selected = rows.filter((r) => r.len >= MIN_LEN)
  L.banner('R5-S1a · split corpus', { snapshot: L.DEFAULT_DB, active: rows.length, archived, selected: selected.length, min_len: MIN_LEN })

  const selectedIds = selected.map((r) => r.id)
  const selLens = selected.map((r) => r.len)
  const selBags = selected.map((r) => bagWidths.get(r.id) ?? 0)

  R.writeTmp('corpus.json', {
    generated_at: new Date().toISOString(),
    source: L.DEFAULT_DB,
    min_len: MIN_LEN,
    active_facts: rows.length,
    selected_facts: selected.length,
    contract: SPLIT_CONTRACT,
    facts: selected.map((r) => ({ id: r.id, len: r.len, text: String(r.content) })),
  })
  R.writeTmp('corpus-meta.json', {
    selected_ids: selectedIds,
    length_by_id: Object.fromEntries(selected.map((r) => [r.id, r.len])),
    bag_width_by_id: Object.fromEntries(selected.map((r) => [r.id, bagWidths.get(r.id) ?? 0])),
    all_active_ids: rows.map((r) => r.id),
  })

  // ── the shape claim, re-derived ───────────────────────────────────────────────────────────────
  const bands = { le200: 0, '200-300': 0, '300-500': 0, '500-1000': 0, gt1000: 0 }
  for (const n of lens) {
    if (n < 200) bands.le200 += 1
    else if (n < 300) bands['200-300'] += 1
    else if (n < 500) bands['300-500'] += 1
    else if (n <= 1000) bands['500-1000'] += 1
    else bands.gt1000 += 1
  }

  const out = {
    card: 'R5-S1a',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'corpus profile card — no retrieval pass, so no production arm to identity-check (R2-5/R2-7 convention)' },
    snapshot: { source: L.DEFAULT_DB, active_facts: rows.length, archived_facts: archived },
    selection: {
      rule: `status='active' and length(content) >= ${MIN_LEN}`,
      selected: selected.length,
      share_of_active: R.pct(selected.length, rows.length),
      brief_expectation: { active: 85, selected: 68 },
      matches_brief: selected.length === 68 && rows.length === 85,
    },
    length: {
      all_active: { min: q(lens, 0), p50: q(lens, 0.5), p90: q(lens, 0.9), max: q(lens, 1), mean: R.mean(lens) },
      selected: { min: q(selLens, 0), p25: q(selLens, 0.25), p50: q(selLens, 0.5), p75: q(selLens, 0.75), p90: q(selLens, 0.9), max: q(selLens, 1), mean: R.mean(selLens), total: selLens.reduce((a, b) => a + b, 0) },
      bands_all_active: bands,
    },
    entity_bag: {
      selected_median_width: R.median(selBags),
      selected_max_width: selBags.length ? Math.max(...selBags) : null,
      selected_total_links: selBags.reduce((a, b) => a + b, 0),
      note: 'the engine bag of the SOURCE fact is what S2 arm A0 inherits; an atom re-extracts its own bag',
    },
    split_contract: SPLIT_CONTRACT,
    derived_inputs: { corpus: R.tmpPath('corpus.json'), meta: R.tmpPath('corpus-meta.json') },
    reproduction: `node mem/scripts/spikes/bench-r5-0-corpus.mjs --json mem/docs/spikes/raw/round5-s1-corpus.json`,
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
  console.log(`active ${rows.length}; selected ${selected.length}; selected length median ${out.length.selected.p50}, total ${out.length.selected.total}`)
  R.rm(work)
}

main()
