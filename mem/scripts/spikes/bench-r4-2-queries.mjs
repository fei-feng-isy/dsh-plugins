/**
 * R4-S4 · the reverse-derived query set (E0's prototype: fact -> question).
 *
 * WHAT E0 NEEDS TO KNOW. Not "how well does retrieval do", but "can a query set be BUILT from the
 * corpus at all, without the queries being answerable by the lexical leg alone". The second clause
 * is the whole measurement: R2-2 already learned that a query carrying a literal unique to its gold
 * fact makes the word leg answer it by itself, so the measurement becomes self-fulfilling. The guard
 * here is deterministic and stricter than R2-2's df>=2 topic rule: for every 3-gram that the query
 * shares with the gold text, the 3-gram must occur in at least two active facts.
 *
 * FORMS (each with a gold set, `must_include`, `must_exclude`, and a collision profile):
 *   - `entity`      : `<topic> 是什么` / `<topic> 有哪些` — topic = an engine entity with df in [2,10]
 *                     carried by the fact; gold = the active facts carrying the topic;
 *   - `time`        : `<topic> <window word>` — window word chosen so the ANNOTATED event date falls
 *                     inside it, and as narrowly as possible; gold = the annotated facts whose event
 *                     date is in the window; its `guard_no_time` twin is the topic alone;
 *   - `attribute`   : `<subject>的<attribute>` from the shadow annotation; gold = the annotated facts
 *                     with the same (subject, attribute);
 *   - `irrelevant`  : a topic taken from an ARCHIVED fact's bag (not in the active corpus), gold = [];
 *                     the "must return nothing" guard.
 *
 * YIELD (the number the brief asks for, not a quality score): qualifying queries per 100 active
 * facts, per form, after the guard drops the disqualified candidates.
 *
 * Usage: node mem/scripts/spikes/bench-r4-2-queries.mjs [--json <path>]
 * PRIVACY: the query strings live in `/tmp/dsh-r4/queries.json`; the repo artifact carries ids,
 * counts, ratios and form names only.
 */
import { join } from 'node:path'
import * as R from './bench-r4-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round4-s4-queries.json'))
const NOW = new Date('2026-10-06T00:00:00+08:00')
const MIN_DF3 = 2
const WINDOW_PREFERENCE = ['前天', '昨天', '今天', '上周', '本周', '上个月', '这个月', '去年', '今年']

const pct = (n, d) => (d ? L.round4(n / d) : null)
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)

function readCorpus(snap) {
  const db = L.openReadOnly(snap)
  try {
    const facts = db.prepare("select fact_id id, content from facts where status='active' order by fact_id").all()
    const archived = db.prepare("select fact_id id, content from facts where status='archived'").all()
    const links = db.prepare(
      `select fe.fact_id id, e.name name from fact_entities fe join entities e on e.entity_id = fe.entity_id
         join facts f on f.fact_id = fe.fact_id where f.status='active'`,
    ).all()
    const bags = new Map()
    for (const r of links) {
      if (!bags.has(r.id)) bags.set(r.id, [])
      bags.get(r.id).push(r.name)
    }
    const archLinks = db.prepare(
      `select fe.fact_id id, e.name name from fact_entities fe join entities e on e.entity_id = fe.entity_id
         join facts f on f.fact_id = fe.fact_id where f.status='archived'`,
    ).all()
    const archBags = new Map()
    for (const r of archLinks) {
      if (!archBags.has(r.id)) archBags.set(r.id, [])
      archBags.get(r.id).push(r.name)
    }
    const df = new Map()
    for (const names of bags.values()) for (const n of new Set(names)) df.set(n, (df.get(n) ?? 0) + 1)
    return { facts, archived, bags, archBags, df }
  } finally {
    db.close()
  }
}

/** df of a 3-gram over the active texts (the guard's unit — the FTS index is trigram-based). */
function makeGramDf(texts) {
  const df = new Map()
  for (const t of texts.values()) {
    const seen = new Set()
    for (let i = 0; i + 3 <= t.length; i += 1) seen.add(t.slice(i, i + 3))
    for (const g of seen) df.set(g, (df.get(g) ?? 0) + 1)
  }
  return df
}

function main() {
  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r42-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { facts, archived, bags, archBags, df } = readCorpus(snap)
  const texts = new Map(facts.map((f) => [f.id, String(f.content)]))
  const ids = facts.map((f) => f.id)
  const gramDf = makeGramDf(texts)
  L.banner('R4-S4 · reverse-derived query set', { active: ids.length, archived: archived.length, now: NOW.toISOString() })

  let annA = { facts: [] }
  try {
    annA = R.readTmp('annot-a.json')
  } catch {
    console.error('round4: /tmp/dsh-r4/annot-a.json missing — run the annotation step first')
    process.exitCode = 1
  }
  const annById = new Map((annA.facts ?? []).map((f) => [f.id, f]))

  const CJK = /[\u4e00-\u9fff]/
  const queryContent = (q, extra = []) => {
    // The "content" of a query = the derived topic/subject/attribute strings, with the fixed
    // Chinese templates removed (they are corpus-wide vocabulary and not what collision means).
    return [...extra].filter(Boolean).join('')
  }

  /** The guard: every 3-gram shared with the gold text must occur in >= MIN_DF3 active facts. */
  function guard(query, goldIds) {
    const goldText = goldIds.map((id) => texts.get(id) ?? '').join('\u0001')
    const offending = []
    const seen = new Set()
    for (let i = 0; i + 3 <= query.length; i += 1) {
      const g = query.slice(i, i + 3)
      if (seen.has(g)) continue
      seen.add(g)
      if (!goldText.includes(g)) continue
      const d = gramDf.get(g) ?? 0
      if (d < MIN_DF3) offending.push({ gram_len: 3, df: d })
    }
    return { unique_ok: offending.length === 0, offending }
  }

  /** Collision: a 5-gram of the query also occurs in an active fact that is NOT gold. */
  function collisions(query, goldIds) {
    const gold = new Set(goldIds)
    const hit = new Set()
    for (let i = 0; i + 5 <= query.length; i += 1) {
      const g = query.slice(i, i + 5)
      for (const id of ids) {
        if (gold.has(id)) continue
        if ((texts.get(id) ?? '').includes(g)) hit.add(id)
      }
    }
    return [...hit]
  }

  const candidates = []
  const push = (rec) => {
    const g = guard(rec.query, rec.gold)
    const col = collisions(rec.query, rec.gold)
    const lookup = rec.lookup ?? rec.topic ?? ''
    const basis = rec.shape_basis != null ? [rec.shape_basis] : rec.gold
    const shape = basis.length === 0
      ? 'guard_empty'
      : basis.some((id) => (texts.get(id) ?? '').includes(lookup)) ? 'literal' : 'alias'
    candidates.push({ ...rec, guard: g, collision_ids: col, qualifies: g.unique_ok, shape })
  }

  // ── entity form ────────────────────────────────────────────────────────────────────────────────
  const TEMPLATES = ['是什么', '有哪些']
  for (const id of ids) {
    const names = [...new Set(bags.get(id) ?? [])]
      .filter((n) => (df.get(n) ?? 0) >= 2 && (df.get(n) ?? 0) <= 10)
      .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || b.length - a.length || a.localeCompare(b))
    const topic = names[0]
    if (!topic) continue
    const gold = ids.filter((fid) => (bags.get(fid) ?? []).includes(topic))
    const tpl = TEMPLATES[id % TEMPLATES.length]
    const query = `${topic}${tpl}`
    const distractors = [...new Set(gold.flatMap((gid) => bags.get(gid) ?? []))]
      .filter((n) => n !== topic && (df.get(n) ?? 0) >= 2 && !(bags.get(id) ?? []).includes(n))
      .slice(0, 3)
    push({
      id: `ent-${id}`, form: 'entity', source_fact: id, derived_from: 'engine entity bag',
      topic, query, gold, guard_gold: id,
      must_include: [topic], must_exclude: distractors,
      content_terms: [topic], template: tpl,
    })
  }

  // ── time form (from the ANNOTATED event date) ──────────────────────────────────────────────────
  const annotatedDates = [...annById.values()].filter((f) => f.event_date)
  const windowOf = (word) => R.parseTimeWindow(word, NOW)
  for (const rec of annotatedDates) {
    const id = rec.id
    if (!texts.has(id)) continue
    const topicNames = [...new Set(bags.get(id) ?? [])]
      .filter((n) => (df.get(n) ?? 0) >= 2 && (df.get(n) ?? 0) <= 10)
      .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || a.localeCompare(b))
    const topic = topicNames[0]
    if (!topic) continue
    const target = Date.parse(`${rec.event_date}T00:00:00+08:00`)
    if (Number.isNaN(target)) continue
    const options = []
    for (const w of WINDOW_PREFERENCE) {
      const win = windowOf(w)
      if (win && target >= win.start && target < win.end) {
        const inWin = annotatedDates.filter((o) => Date.parse(`${o.event_date}T00:00:00+08:00`) >= win.start && Date.parse(`${o.event_date}T00:00:00+08:00`) < win.end)
        options.push({ word: w, win, size: inWin.length, gold: inWin.map((o) => o.id).filter((x) => texts.has(x)) })
      }
    }
    if (!options.length) continue
    options.sort((a, b) => a.size - b.size || a.win.end - a.win.start - (b.win.end - b.win.start) || WINDOW_PREFERENCE.indexOf(a.word) - WINDOW_PREFERENCE.indexOf(b.word))
    const pick = options[0]
    const query = `${topic} ${pick.word}`
    const distractors = [...new Set(ids.filter((fid) => fid !== id && (bags.get(fid) ?? []).some((n) => (df.get(n) ?? 0) >= 2)))]
      .slice(0, 0)
    push({
      id: `time-${id}`, form: 'time', source_fact: id, derived_from: 'shadow annotation event_date',
      topic, window_word: pick.word, window_rule: pick.win.rule,
      window_start: iso(pick.win.start), window_end: iso(pick.win.end),
      query, gold: pick.gold.length ? pick.gold : [id], guard_gold: id,
      must_include: [topic], must_exclude: distractors,
      content_terms: [topic],
      candidates_by_window: options.slice(0, 4).map((o) => ({ word: o.word, size: o.size })),
    })
    // the no-time guard twin
    push({
      id: `guard-${id}`, form: 'guard_no_time', source_fact: id, derived_from: 'time form guard',
      topic, query: topic, gold: ids.filter((fid) => (bags.get(fid) ?? []).includes(topic)), guard_gold: id,
      must_include: [topic], must_exclude: [], content_terms: [topic], parent: `time-${id}`,
    })
  }

  // ── attribute form (from the shadow annotation subject/attribute) ─────────────────────────────
  const groups = new Map()
  for (const rec of annById.values()) {
    if (!rec.subject || !rec.attribute || !texts.has(rec.id)) continue
    const k = `${R.normName(rec.subject)}\u0001${R.normName(rec.attribute)}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(rec)
  }
  let attrCount = 0
  for (const [k, recs] of groups) {
    if (recs.length < 2 || attrCount >= 30) continue
    attrCount += 1
    const subject = recs[0].subject
    const attribute = recs[0].attribute
    const gold = recs.map((r) => r.id)
    const query = `${subject}的${attribute}`
    const distractors = [...df.entries()].filter(([n, d]) => d >= 2 && !gold.some((gid) => (bags.get(gid) ?? []).includes(n))).slice(0, 3).map(([n]) => n)
    push({
      id: `attr-${attrCount}`, form: 'attribute', source_fact: recs[0].id, derived_from: 'shadow annotation subject+attribute',
      topic: subject, attribute, query, gold, guard_gold: recs[0].id,
      must_include: [subject, attribute], must_exclude: distractors,
      content_terms: [subject, attribute], group_size: recs.length,
    })
  }

  // ── canonical-entity form (the ALIAS shape: the name the caller would supply) ─────────────────
  // Every (fact, supplied name) pair from BOTH canonical-convention passes; gold = the annotated
  // facts that supplied the same name (folded). This is where the alias-shaped queries live.
  let annAext = { facts: [] }
  try { annAext = R.readTmp('annot-a-ext.json') } catch { /* optional */ }
  const nameToFacts = new Map()
  const pairs = []
  const seenPair = new Set()
  for (const src of [annA, annAext]) {
    for (const rec of src.facts ?? []) {
      if (!texts.has(rec.id)) continue
      for (const n of [...new Set(rec.entities ?? [])]) {
        if (String(n).length < 2) continue
        const k = R.normName(n)
        if (!nameToFacts.has(k)) nameToFacts.set(k, { name: n, facts: new Set() })
        nameToFacts.get(k).facts.add(rec.id)
        const pk = `${rec.id}\u0001${k}`
        if (seenPair.has(pk)) continue
        seenPair.add(pk)
        pairs.push({ id: rec.id, name: n, key: k })
      }
    }
  }
  pairs.forEach((entry, i) => {
    const tpl = TEMPLATES[i % TEMPLATES.length]
    push({
      id: `canon-${i + 1}`, form: 'entity_canonical', source_fact: entry.id,
      derived_from: 'shadow annotation canonical entity name (passes A / A-ext)',
      topic: entry.name, lookup: entry.name, query: `${entry.name}${tpl}`,
      gold: [...nameToFacts.get(entry.key).facts], guard_gold: entry.id, shape_basis: entry.id,
      must_include: [entry.name], must_exclude: [], content_terms: [entry.name], template: tpl,
    })
  })

  // ── irrelevant guard (topic from an archived fact) ─────────────────────────────────────────────
  let irr = 0
  for (const [aid, names] of archBags) {
    if (irr >= 12) break
    const topic = [...new Set(names)].filter((n) => (df.get(n) ?? 0) === 0 && n.length >= 2).sort((a, b) => b.length - a.length)[0]
    if (!topic) continue
    irr += 1
    push({
      id: `irr-${irr}`, form: 'irrelevant', source_fact: aid, derived_from: 'archived fact entity bag (absent from active corpus)',
      topic, query: `${topic} 是什么`, gold: [], guard_gold: null,
      must_include: [], must_exclude: [topic], content_terms: [topic], archived_source_fact: aid,
    })
  }

  // ── yield ──────────────────────────────────────────────────────────────────────────────────────
  const byForm = {}
  for (const c of candidates) {
    const f = (byForm[c.form] ??= { candidates: 0, qualifying: 0, disqualified: 0, gold_total: 0, source_facts: new Set(), collision_queries: 0, shapes: {} })
    f.candidates += 1
    if (c.qualifies) f.qualifying += 1
    else f.disqualified += 1
    f.gold_total += c.gold.length
    f.shapes[c.shape] = (f.shapes[c.shape] ?? 0) + 1
    if (c.source_fact != null) f.source_facts.add(c.source_fact)
    if (c.collision_ids.length) f.collision_queries += 1
  }
  const yieldTable = Object.fromEntries(Object.entries(byForm).map(([form, f]) => [form, {
    candidates: f.candidates, qualifying: f.qualifying, disqualified: f.disqualified,
    qualifying_per_100_active_facts: L.round4((f.qualifying / ids.length) * 100),
    distinct_source_facts: f.source_facts.size,
    mean_gold_size: f.qualifying ? L.round4(f.gold_total / f.candidates) : null,
    collision_queries: f.collision_queries,
    collision_share: pct(f.collision_queries, f.candidates),
    shapes: f.shapes,
  }]))
  const qualifying = candidates.filter((c) => c.qualifies)
  const annotatedSample = new Set(R.readTmp('corpus.json').sample ?? [])

  const out = {
    card: 'R4-S4',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'derivation card — the query set is generated, not run; retrieval cards identity-check the passes they run' },
    now: NOW.toISOString(),
    guard: { rule: `every 3-gram shared between the query and its gold text must have active df >= ${MIN_DF3}`, why: 'a query carrying a literal unique to the gold fact is answerable by the lexical leg alone (R2-2 lesson)' },
    forms: ['entity', 'time', 'guard_no_time', 'attribute', 'irrelevant'],
    yield: yieldTable,
    shape_distribution_qualifying: qualifying.reduce((acc, c) => { acc[c.shape] = (acc[c.shape] ?? 0) + 1; return acc }, {}),
    totals: {
      active_facts: ids.length,
      annotated_sample: annotatedSample.size,
      candidates: candidates.length,
      qualifying: qualifying.length,
      qualifying_per_100_active_facts: L.round4((qualifying.length / ids.length) * 100),
      qualifying_per_100_annotated_facts: L.round4((qualifying.length / annotatedSample.size) * 100),
      disqualified_by_guard: candidates.length - qualifying.length,
      with_collision: candidates.filter((c) => c.collision_ids.length).length,
      collision_share: pct(candidates.filter((c) => c.collision_ids.length).length, candidates.length),
    },
    per_source_fact: (() => {
      const all = new Set(candidates.map((c) => c.source_fact).filter((x) => x != null))
      const inSample = new Set([...all].filter((id) => annotatedSample.has(id)))
      return {
        distinct_source_facts: all.size,
        of_active: pct(all.size, ids.length),
        of_annotated_sample: pct(inSample.size, annotatedSample.size),
      }
    })(),
    records: candidates.map((c) => ({
      id: c.id, form: c.form, source_fact: c.source_fact, derived_from: c.derived_from,
      gold: c.gold, gold_size: c.gold.length, qualifies: c.qualifies,
      offending_grams: c.guard.offending.length, collision_count: c.collision_ids.length,
      must_include_count: c.must_include.length, must_exclude_count: c.must_exclude.length, shape: c.shape,
      window_word_present: c.window_word !== undefined, candidate_windows: c.candidates_by_window ?? null,
    })),
    derived_data_location: '/tmp/dsh-r4/queries.json (query strings, entity names, labels — never committed)',
    reproduction: 'node mem/scripts/spikes/bench-r4-2-queries.mjs --json mem/docs/spikes/raw/round4-s4-queries.json',
  }
  R.writeTmp('queries.json', {
    generated_at: new Date().toISOString(), now: NOW.toISOString(), min_df3: MIN_DF3,
    queries: candidates.map((c) => ({
      id: c.id, form: c.form, query: c.query, gold: c.gold, qualifies: c.qualifies, shape: c.shape,
      lookup: c.lookup ?? c.topic ?? null,
      must_include: c.must_include, must_exclude: c.must_exclude,
      topic: c.topic ?? null, attribute: c.attribute ?? null, template: c.template ?? null,
      window_word: c.window_word ?? null, window_rule: c.window_rule ?? null,
      window_start: c.window_start ?? null, window_end: c.window_end ?? null,
      parent: c.parent ?? null, source_fact: c.source_fact ?? null,
      guard_gold: c.guard_gold ?? null, group_size: c.group_size ?? null,
      collision_ids: c.collision_ids, offending_grams: c.guard.offending,
    })),
  })
  const whitelist = R.repoCjkWhitelist()
  out.privacy = R.auditArtifact(out, { cjkWhitelist: whitelist })
  if (!out.privacy.clean) {
    console.error('PRIVACY AUDIT FAILED', JSON.stringify(out.privacy).slice(0, 3000))
    process.exitCode = 1
  }
  L.writeJson(jsonOut, out)
  console.log('yield:', JSON.stringify(yieldTable, null, 1))
  console.log('totals:', JSON.stringify(out.totals))
  R.rm(work)
}

main()
