/**
 * R3-0 · S1: emit the constructed fixture and its TRUTH TABLE as a standalone artifact.
 *
 * The fixture is built by `bench-r3-fixture.mjs` (deterministic from `FIXTURE_SEED`); this script
 * materializes what was constructed — every fact's canonical entities / subject / attribute / event
 * date, plus its length and a content hash — so a reviewer can check the truth the "perfect caller"
 * arm supplies WITHOUT the fact text ever being written down here. The corpus text itself is
 * synthetic and stays in memory (the arms re-derive it from the same seed).
 *
 * The assertions printed are the fixture's own anti-healthy-corpus checks: alias-shape about-facts
 * must not carry the canonical literal, literal-shape ones must, the self collision carrier must
 * carry the rewritten-query literal, the identity gold must not, and every text must be distinct.
 *
 * Usage: node mem/scripts/spikes/bench-r3-0-fixture.mjs [--json <path>]
 * PRIVACY: constructed corpus; truth + hashes + lengths only (no `text`/`content` keys).
 */
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'
import * as F from './bench-r3-fixture.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round3-fixture.json'))

const fixture = F.buildFixture()
const failed = fixture.assertions.filter((a) => !a.ok)
const out = {
  card: 'R3-0 (S1 fixture + truth table)',
  generated_at: new Date().toISOString(),
  node: process.version,
  loadavg: L.loadavg(),
  seed: F.FIXTURE_SEED,
  write_time: F.WRITE_TIME,
  identity: { checked: 0, passed: 0, note: 'N/A — this artifact constructs the corpus; it runs no retrieval pass (identity is recorded in round3-s2-supplier.json)' },
  construction: [
    '78 synthetic facts with a real-shaped length distribution.',
    '6 alias-shape topic groups: 3 about-facts each, alias/case/fullwidth surfaces only, and 3 of them also carry an unrelated note holding the canonical name literally.',
    '2 literal-shape groups (the R2-8 shape), where the canonical name is already a substring of the text.',
    'A 4-fact self family: identity gold, contact gold, the 用户是谁 collision carrier, and a policy fact that merely mentions the user.',
    '3 time topics x 3 near-duplicate facts separated only by their event date, plus a window-word distractor.',
    '9 short / 20 medium / 8 long filler notes for the length distribution.',
  ],
  counts: fixture.plan.counts,
  truth_table: F.truthTable(fixture),
  queries: {
    entity: fixture.queries.entity.map((q) => ({ id: q.id, query: q.query, shape: q.shape, canonical: q.canonical, gold_indices: q.gold_indices, literal_carrier: q.literal_carrier })),
    self: fixture.queries.self.map((q) => ({ id: q.id, query: q.query, gold_indices: q.gold_indices })),
    time: fixture.queries.time.map((q) => ({ id: q.id, query: q.query, topic: q.topic, window: q.window, gold_indices: q.gold_indices })),
    guards: fixture.queries.guards.map((q) => ({ id: q.id, query: q.query })),
  },
  plan: {
    topics: fixture.plan.topics.map((t) => ({ key: t.key, canonical: t.canonical, shape: t.shape, surfaces: t.surfaces, literal_carrier: t.literal_carrier, about_indices: t.about_indices })),
    time: fixture.plan.time,
    carriers: fixture.plan.carriers,
    carrier_key: fixture.plan.carrier_key,
    distractor_key: fixture.plan.distractor_key,
  },
  supply_normalization: F.CALLER_NAME_MAP,
  assertions: { checked: fixture.assertions.length, passed: fixture.assertions.length - failed.length, failures: failed, all: fixture.assertions },
  comparison_to_live_store: {
    live_facts: 85, live_min: 9, live_median: 313, live_max: 2672,
    fixture_facts: fixture.plan.counts.total, fixture_min: fixture.plan.counts.min, fixture_median: fixture.plan.counts.median, fixture_max: fixture.plan.counts.max,
    source: 'live figures are the R2-6 snapshot record (raw/round2-r2-6-subject-attribute.json: active_facts 85, median_len 313); round-1 states min 9 / max 2672. No live-store read in this card.',
  },
  reproduction: 'node mem/scripts/spikes/bench-r3-0-fixture.mjs --json mem/docs/spikes/raw/round3-fixture.json',
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

console.log(`fixture: ${fixture.plan.counts.total} facts, min ${fixture.plan.counts.min} / median ${fixture.plan.counts.median} / max ${fixture.plan.counts.max}`)
console.log(`assertions: ${fixture.assertions.length - failed.length}/${fixture.assertions.length} pass`)
console.log('privacy:', JSON.stringify(out.privacy_selfcheck))
L.writeJson(jsonOut, out)
