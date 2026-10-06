/**
 * Round-6 · S1 — the triple profile (no labels + a manual-judged sample).
 *
 * WHAT IT MEASURES
 *   1. the per-fact triple-count distribution over the ACTIVE corpus;
 *   2. the predicate distribution (top-N) and how repetitive the predicate vocabulary is;
 *   3. the `STOP_PREDS` funnel: how many predicate candidates the strict-verb pass produces and
 *      how many of them the stop list / the length guard throw away. The filter constants are
 *      reproduced here as an INSTRUMENTATION COPY (they are four lines of tags) and the copy is
 *      cross-checked against `triplesFromTokens` on every fact, so a drift is visible;
 *   4. whether `subj` / `obj` are entity names (they match `entities.name`, or the owning fact's
 *      own `fact_entities` bag) or text fragments;
 *   5. a stratified 24-triple sample written to `/tmp/dsh-r6/s1-sample.json` for manual judging.
 *      If `/tmp/dsh-r6/s1-judgment.json` exists its aggregate accuracy is folded in.
 *
 * OUTPUT: `mem/docs/spikes/raw/round6-s1-triples.json` (aggregates + ids/lengths only).
 * Usage: node mem/scripts/spikes/bench-r6-1-triples.mjs [--json <path>] [--sample N]
 */
import { join } from 'node:path'
import * as B from './bench-r6-lib.mjs'
import { tagText, triplesFromTokens } from '../../packages/core/lib/entities/extract.js'

const outPath = B.arg('json', join(B.REPO, 'docs/spikes/raw/round6-s1-triples.json'))
const sampleN = Number(B.arg('sample', 24))

// Instrumentation copy of the predicate filter in `entities/extract.ts` (four tag lines).
const STRICT_VERB = new Set(['v', 'vd', 'vg', 'vf', 'vx', 'vi', 'vl', 'vq'])
const WEAK_VERB = new Set(['vn'])
const STOP_PREDS = new Set(['是', '有', '做', '来', '去', '说', '会', '要', '想', '让', '作为', '进行', '可以', '应该', '成为', '属于'])
const NEGATIONS = ['不', '没', '没有', '未', '别', '无需']
const ASPECT_SUFFIXES = ['了', '着', '过']
const stripAspect = (p) => {
  for (const s of ASPECT_SUFFIXES) if (p.length > s.length && p.endsWith(s)) return p.slice(0, -s.length)
  return p
}

async function stopPredFunnel(db) {
  const rows = db.prepare("select fact_id id, content from facts where status = 'active' order by fact_id").all()
  let facts = 0
  let candidates = 0
  let droppedStop = 0
  let droppedShort = 0
  let droppedNoPred = 0
  let replicaProduced = 0
  let storedTriples = 0
  let replicaMismatchFacts = 0
  for (const r of rows) {
    facts += 1
    const text = String(r.content)
    const tokens = await tagText(text)
    if (tokens === null) {
      droppedNoPred += 1
      continue
    }
    const t = tokens.filter((x) => x.word.trim()).map((x) => ({ word: x.word.trim(), tag: x.tag }))
    const idx = []
    for (let i = 0; i < t.length; i += 1) {
      if (!STRICT_VERB.has(t[i].tag)) continue
      if (t[i - 1]?.tag === 'vn') continue
      idx.push(i)
    }
    for (const i of idx) {
      candidates += 1
      let pred = t[i].word.trim()
      if (i > 0 && NEGATIONS.includes(t[i - 1].word)) pred = t[i - 1].word + pred
      pred = stripAspect(pred)
      if (STOP_PREDS.has(pred)) droppedStop += 1
      else if (pred.length < 2) droppedShort += 1
    }
    const replica = triplesFromTokens(tokens)
    replicaProduced += replica.length
    const stored = db.prepare('select count(*) c from triples where fact_id = ?').get(r.id).c
    storedTriples += stored
    if (replica.length !== stored) replicaMismatchFacts += 1
  }
  return {
    facts_scanned: facts,
    strict_verb_candidates: candidates,
    dropped_stop_preds: droppedStop,
    dropped_pred_too_short: droppedShort,
    dropped_no_tagger: droppedNoPred,
    kept_candidates: candidates - droppedStop - droppedShort,
    replica_produced_triples: replicaProduced,
    stored_triples: storedTriples,
    replica_mismatch_facts: replicaMismatchFacts,
    stop_pred_share_of_candidates: B.ratio(droppedStop, candidates),
  }
}

async function main() {
  B.banner('round6 · S1 triple profile')
  B.ensureTmp()
  const work = B.L.mkdtempSync(join(B.L.tmpdir(), 'avantf-r6-s1-'))
  const snap = join(work, 'memory.db')
  const t0 = Date.now()
  B.snapshotDb(B.pinSource(), snap)
  const db = B.openReadOnly(snap)

  const active = db.prepare("select fact_id id from facts where status = 'active' order by fact_id").all().map((r) => r.id)
  const activeSet = new Set(active)
  const triples = B.activeTriples(db).filter((t) => activeSet.has(t.fact_id))
  const allT = B.allTriples(db)
  const bags = B.entityBags(db)
  const meta = B.factMeta(db)
  const entityNames = new Set(db.prepare('select name from entities').all().map((r) => r.name))

  // ── 1. per-fact distribution ───────────────────────────────────────────────
  const perFact = new Map(active.map((id) => [id, 0]))
  for (const t of triples) perFact.set(t.fact_id, (perFact.get(t.fact_id) ?? 0) + 1)
  const counts = [...perFact.values()]
  const entityCounts = active.map((id) => (bags.get(id) ?? new Set()).size)

  // ── 2. predicate distribution ──────────────────────────────────────────────
  const predCount = new Map()
  for (const t of triples) predCount.set(t.pred, (predCount.get(t.pred) ?? 0) + 1)
  const predsSorted = [...predCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const singletonPreds = predsSorted.filter(([, c]) => c === 1).length
  const predLenDist = B.dist(predsSorted.flatMap(([p, c]) => Array.from({ length: c }, () => p.length)))
  // A predicate that IS an entity name is a mis-tagged noun, not a relation.
  const predIsEntityName = predsSorted.filter(([p]) => entityNames.has(p)).reduce((n, [, c]) => n + c, 0)
  // The predicate STRINGS are derived from real text: full distribution -> /tmp, ranks only -> repo.
  const predTmp = B.writeTmp('s1-predicates.json', {
    note: 'full predicate distribution over active triples; derived strings, never committed',
    predicates: predsSorted.slice(0, 80).map(([pred, count]) => ({ pred, count })),
  })
  const predicatesRedacted = predsSorted.slice(0, 25).map(([, count], i) => ({ rank: i + 1, len: predsSorted[i][0].length, count, share: B.ratio(count, triples.length) }))
  // How many distinct predicates a fact's triples use (repetition inside a fact).
  const predsPerFact = new Map()
  for (const t of triples) {
    if (!predsPerFact.has(t.fact_id)) predsPerFact.set(t.fact_id, new Set())
    predsPerFact.get(t.fact_id).add(t.pred)
  }

  // ── 3. STOP_PREDS funnel ───────────────────────────────────────────────────
  const funnel = await stopPredFunnel(db)
  funnel.stored_triples_containing_stop_pred = triples.filter((t) => STOP_PREDS.has(t.pred)).length

  // ── 4. subj/obj shape ──────────────────────────────────────────────────────
  const shape = {
    triples: triples.length,
    subj_exact_entity_name: triples.filter((t) => entityNames.has(t.subj)).length,
    obj_exact_entity_name: triples.filter((t) => entityNames.has(t.obj)).length,
    both_exact_entity_names: triples.filter((t) => entityNames.has(t.subj) && entityNames.has(t.obj)).length,
    subj_in_own_bag: triples.filter((t) => (bags.get(t.fact_id) ?? new Set()).has(t.subj)).length,
    obj_in_own_bag: triples.filter((t) => (bags.get(t.fact_id) ?? new Set()).has(t.obj)).length,
    both_in_own_bag: triples.filter((t) => {
      const b = bags.get(t.fact_id) ?? new Set()
      return b.has(t.subj) && b.has(t.obj)
    }).length,
    neither_in_own_bag: triples.filter((t) => {
      const b = bags.get(t.fact_id) ?? new Set()
      return !b.has(t.subj) && !b.has(t.obj)
    }).length,
    subj_len: B.dist(triples.map((t) => t.subj.length)),
    obj_len: B.dist(triples.map((t) => t.obj.length)),
    pred_len: B.dist(triples.map((t) => t.pred.length)),
  }
  shape.subj_exact_share = B.ratio(shape.subj_exact_entity_name, triples.length)
  shape.obj_exact_share = B.ratio(shape.obj_exact_entity_name, triples.length)
  shape.both_exact_share = B.ratio(shape.both_exact_entity_names, triples.length)
  shape.both_in_own_bag_share = B.ratio(shape.both_in_own_bag, triples.length)
  shape.neither_in_own_bag_share = B.ratio(shape.neither_in_own_bag, triples.length)

  // ── 4b. supplement vs noise vs the entity layer ────────────────────────────
  // A triple SUPPLEMENTS the bag when both endpoints are already known entities (it adds a
  // directed relation the bag cannot express). It is NOISE when neither endpoint is even in the
  // fact's own bag (a fragment that names nothing the fact talks about).
  const allEntityPairs = new Set()
  for (const [fid, bag] of bags) {
    const arr = [...bag]
    for (let i = 0; i < arr.length; i += 1) for (let j = i + 1; j < arr.length; j += 1) allEntityPairs.add(`${fid}|${arr[i]}|${arr[j]}`)
  }
  const relationBetweenKnown = triples.filter((t) => entityNames.has(t.subj) && entityNames.has(t.obj)).length
  const compare = {
    facts_active: active.length,
    facts_with_triple: [...perFact.values()].filter((c) => c > 0).length,
    facts_without_triple: [...perFact.values()].filter((c) => c === 0).length,
    triples_per_fact: B.dist(counts),
    triples_per_fact_histogram: B.histogram(counts),
    entities_per_fact: B.dist(entityCounts),
    entities_per_fact_median: B.dist(entityCounts).median,
    triples_per_fact_median: B.dist(counts).median,
    bag_cooccurrence_pairs_total: allEntityPairs.size,
    triples_that_add_a_relation_between_known_entities: relationBetweenKnown,
    triple_to_bag_link_ratio: B.ratio(triples.length, active.reduce((n, id) => n + (bags.get(id) ?? new Set()).size, 0)),
  }

  // ── 5. manual-judgment sample (stratified, deterministic) ──────────────────
  const byFact = new Map()
  for (const t of triples) {
    if (!byFact.has(t.fact_id)) byFact.set(t.fact_id, [])
    byFact.get(t.fact_id).push(t)
  }
  const factsWithTriples = [...byFact.keys()].sort((a, b) => a - b)
  const step = Math.max(1, Math.floor(factsWithTriples.length / sampleN))
  const sample = []
  for (let i = 0; i < factsWithTriples.length && sample.length < sampleN; i += step) {
    const fid = factsWithTriples[i]
    const list = byFact.get(fid)
    const pick = list[Math.floor(list.length / 2)]
    const row = db.prepare('select content from facts where fact_id = ?').get(fid)
    sample.push({ fact_id: fid, subj: pick.subj, pred: pick.pred, obj: pick.obj, content: String(row.content) })
  }
  const samplePath = B.writeTmp('s1-sample.json', { note: 'triple + source fact; judge each SPO', items: sample })

  const judgment = B.readTmp('s1-judgment.json')
  let judged = null
  if (judgment) {
    const verdicts = {}
    for (const it of judgment.items) verdicts[it.verdict] = (verdicts[it.verdict] ?? 0) + 1
    const total = judgment.items.length
    judged = {
      items: total,
      verdicts,
      faithful: verdicts.faithful ?? 0,
      accuracy: B.ratio(verdicts.faithful ?? 0, total),
      lenient_correct: (verdicts.faithful ?? 0) + (verdicts.boundary_noise ?? 0),
      lenient_accuracy: B.ratio((verdicts.faithful ?? 0) + (verdicts.boundary_noise ?? 0), total),
      method: String(judgment.method ?? 'manual').slice(0, 180),
      judge_note: judgment.note ? String(judgment.note).slice(0, 180) : null,
    }
  }

  const confidence = db_conf(db)
  db.close()
  B.R.rm(work)

  const artifact = {
    card: 'round6-s1-triples',
    generated_at: new Date().toISOString(),
    node: process.version,
    loadavg: B.loadavg(),
    elapsed_ms: Date.now() - t0,
    corpus: { active_facts: active.length, triples_on_active: triples.length, triples_total_all_status: allT.length, entities_total: entityNames.size, fact_entity_links_total: [...bags.values()].reduce((n, s) => n + s.size, 0) },
    confidence_values: confidence,
    per_fact: compare,
    predicates: {
      distinct: predCount.size,
      singleton_predicates: singletonPreds,
      singleton_share: B.ratio(singletonPreds, predCount.size),
      top25_redacted: predicatesRedacted,
      predicate_strings_file: predTmp,
      predicate_is_an_entity_name: predIsEntityName,
      predicate_is_an_entity_name_share: B.ratio(predIsEntityName, triples.length),
      length_distribution: predLenDist,
      distinct_preds_per_fact: B.dist([...predsPerFact.values()].map((s) => s.size)),
    },
    stop_preds_funnel: funnel,
    subj_obj_shape: shape,
    manual_sample: { sample_file: samplePath, sample_size: sample.length, judged },
  }
  B.writeJson(outPath, artifact)
  console.log(`\nS1: active=${active.length} triples=${triples.length} preds=${predCount.size} sample=${sample.length}`)
  if (judged) console.log(`S1 judged accuracy = ${judged.faithful}/${judged.items} = ${judged.accuracy}`)
  else console.log('S1 judgment NOT folded in (write /tmp/dsh-r6/s1-judgment.json and re-run)')
}

function db_conf(db) {
  const rows = db.prepare('select confidence, count(*) c from triples group by confidence').all()
  return rows.map((r) => ({ confidence: r.confidence, count: r.c }))
}

await main()
