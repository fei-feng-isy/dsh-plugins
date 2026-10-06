/**
 * R4-S5 · time queries on real content (the A2 demand bound), and
 * R4-S6 · attribute shape (filter vs groupleg) + the G-A7 attribution rate.
 *
 * S5 — A2's condition was "lifted on rank evidence" by R2-2 using **created_at** windows derived
 * from the snapshot. This card asks the two questions R2-2 could not:
 *   (a) how many real facts carry a USABLE EVENT TIME at all (the demand upper bound), and
 *   (b) does a window leg driven by the CALLER's event date (the shadow annotation) help, on
 *       queries derived from real content — and does it injure the no-time guards?
 * It also CROSS-VALIDATES against R2-2: the same derivation is re-run with R2-2's own pinned `now`
 * and its summary is compared to the stored `round2-r2-2-real-time-queries.json`.
 *
 * S6 — the attribute shape ("the <attribute> of <subject>") is the one query axis R3's set lacked.
 * Groups come from the shadow annotation (`subject`,`attribute`); the arms are the R2-6 shapes:
 * a pool FILTER on the group (narrows the union — structurally suspect) and a GROUP LEG (union
 * preserved). The rule supplier (production df-max entity as subject) is the no-caller control.
 * The same pass yields the G-A7 attribution rate per pass, by source kind, against R2-5's bound.
 *
 * Usage: node mem/scripts/spikes/bench-r4-4-time-attribute.mjs
 * PRIVACY: ids/counts/ratios/dates only; the query strings stay in /tmp.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as R from './bench-r4-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const outS5 = L.arg('s5', join(L.REPO, 'docs/spikes/raw/round4-s5-time.json'))
const outS6 = L.arg('s6', join(L.REPO, 'docs/spikes/raw/round4-s6-attribute-sources.json'))
const LIMIT = 5
const pct = (n, d) => (d ? L.round4(n / d) : null)

async function main() {
  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r44-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts } = L.loadActiveTexts(snap)
  const track = { runtimes: [], dirs: [work], texts }
  const emb = await L.warmEmbedder()
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const ids = [...texts.keys()]
  R.banner('R4-S5/S6 · time + attribute', { active: ids.length })

  const db = L.openReadOnly(snap)
  const created = new Map(db.prepare("select fact_id id, created_at c from facts where status='active'").all().map((r) => [Number(r.id), String(r.c)]))
  const links = db.prepare(
    `select fe.fact_id id, e.name name from fact_entities fe join entities e on e.entity_id = fe.entity_id
       join facts f on f.fact_id = fe.fact_id where f.status='active'`,
  ).all()
  const mirror = db.prepare("select count(*) n from facts where status='active' and mirror_source is not null and mirror_source <> ''").get().n
  db.close()
  const bags = new Map()
  for (const r of links) {
    if (!bags.has(r.id)) bags.set(r.id, [])
    bags.get(r.id).push(r.name)
  }
  const df = new Map()
  for (const names of bags.values()) for (const n of new Set(names)) df.set(n, (df.get(n) ?? 0) + 1)

  const qfile = R.readTmp('queries.json')
  const annA = R.readTmp('annot-a.json')
  let annAext = { facts: [] }
  let annBext = { facts: [] }
  try { annAext = R.readTmp('annot-a-ext.json') } catch { /* optional */ }
  try { annBext = R.readTmp('annot-b-ext.json') } catch { /* optional */ }

  // ── R2-2 cross-validation (same derivation, R2-2's pinned now) ────────────────────────────────
  const crossValidate = async () => {
    const storedPath = join(L.REPO, 'docs/spikes/raw/round2-r2-2-real-time-queries.json')
    let stored = null
    try { stored = JSON.parse(readFileSync(storedPath, 'utf8')) } catch { return { available: false } }
    const NOW22 = new Date(stored.now)
    const WINDOW_WORDS = stored.derivation.windows_tried
    const topics = [...df.entries()]
      .filter(([name, n]) => n >= 2 && n <= 8 && /[\u3400-\u4dbf\u4e00-\u9fff]/.test(name))
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => a.n - b.n || a.name.localeCompare(b.name))
    const inWindow = (id, win) => {
      const d = new Date(Date.parse(String(created.get(id)).replace(' ', 'T') + 'Z'))
      const day0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      const s = new Date(win.start)
      const e = new Date(win.end)
      return day0 >= new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime()
        && day0 < new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime()
    }
    const queries = []
    const usedEntities = new Set()
    for (const word of WINDOW_WORDS) {
      const win = R.parseTimeWindow(word, NOW22)
      if (!win) continue
      const per = []
      for (const t of topics) {
        if (usedEntities.has(t.name)) continue
        const factsWithTopic = ids.filter((id) => bags.get(id).includes(t.name))
        const inw = factsWithTopic.filter((id) => inWindow(id, win))
        if (inw.length === 1 && factsWithTopic.length >= 2) per.push({ topic: t.name, df: t.n, gold: inw[0] })
      }
      for (const p of per.slice(0, 2)) {
        usedEntities.add(p.topic)
        queries.push({ id: `r2t-${queries.length + 1}`, ...p, word, query: `${p.topic} ${word}` })
      }
    }
    const rankOf = (list, id) => (list.indexOf(id) === -1 ? null : list.indexOf(id) + 1)
    const summarize = (rows, get) => ({
      queries: rows.length,
      missing: rows.filter((r) => get(r).missing).length,
      in_top3: rows.filter((r) => get(r).in_top3).length,
      top1: rows.filter((r) => get(r).gold_rank === 1).length,
      found: rows.filter((r) => get(r).gold_rank !== null).length,
      avg_rank: (() => { const f = rows.filter((r) => get(r).gold_rank !== null); return f.length ? L.round4(f.reduce((n, r) => n + get(r).gold_rank, 0) / f.length) : null })(),
    })
    const rows = []
    for (const q of queries) {
      const win = R.parseTimeWindow(q.word, NOW22)
      const inWinIds = ids.filter((id) => inWindow(id, win))
      const base = await L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
      const arm = {
        appendLegs: () => (inWinIds.length ? [{ weight: 1.0, scores: new Map(inWinIds.map((id) => [id, 1])), leg: 'fts' }] : []),
      }
      const w = await L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm })
      const gw = R.parseTimeWindow(q.topic, NOW22)
      const gWinIds = gw ? ids.filter((id) => inWindow(id, gw)) : []
      const g = await L.runScript(rt, q.topic, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
      const gArm = await L.runScript(rt, q.topic, {
        limit: LIMIT, maxTokens: 0, floors: 'strict', track,
        arm: gWinIds.length ? { appendLegs: () => [{ weight: 1.0, scores: new Map(gWinIds.map((id) => [id, 1])), leg: 'fts' }] } : {},
      })
      rows.push({
        query: q.query, gold: q.gold,
        baseline: { gold_rank: rankOf(base.ids, q.gold), in_top3: base.ids.slice(0, 3).includes(q.gold), missing: !base.ids.includes(q.gold) },
        w1: { gold_rank: rankOf(w.ids, q.gold), in_top3: w.ids.slice(0, 3).includes(q.gold), missing: !w.ids.includes(q.gold) },
        guard_identical: g.ids.join(',') === gArm.ids.join(','),
      })
    }
    const mine = { queries: queries.length, baseline: summarize(rows, (r) => r.baseline), w1: summarize(rows, (r) => r.w1), guards_identical: rows.filter((r) => r.guard_identical).length }
    const theirIds = stored.rows.map((r) => r.id)
    const myDerivedCount = queries.length
    return {
      available: true, r22_now: stored.now, r22_queries: stored.rows.length, rederived_queries: myDerivedCount,
      same_query_count: theirIds.length === myDerivedCount,
      mine, theirs: { baseline: stored.summary.baseline, w1: stored.summary['w1.0'], guards_identical: stored.guards.identical },
      conclusion_matches: mine.w1.in_top3 === stored.summary['w1.0'].in_top3 && mine.baseline.in_top3 === stored.summary.baseline.in_top3,
    }
  }
  const cross = await crossValidate()

  // ── S5: content-derived time queries, caller event date vs created_at ─────────────────────────
  const timeQs = qfile.queries.filter((q) => q.qualifies && q.form === 'time')
  const guardQs = qfile.queries.filter((q) => q.qualifies && q.form === 'guard_no_time')
  const dayOf = (d) => Date.parse(`${d}T00:00:00+08:00`)
  const inWin = (ms, start, end) => ms >= Date.parse(`${start}T00:00:00+08:00`) && ms < Date.parse(`${end}T00:00:00+08:00`)
  const eventDates = new Map()
  for (const f of [...(annA.facts ?? []), ...(annAext.facts ?? [])]) if (f.event_date && texts.has(f.id)) eventDates.set(f.id, f.event_date)
  const createdDay = new Map(ids.map((id) => [id, new Date(Date.parse(String(created.get(id)).replace(' ', 'T') + 'Z')).getTime()]))

  const timeRows = []
  for (const q of timeQs) {
    const eventsInWin = [...eventDates.entries()].filter(([, d]) => inWin(dayOf(d), q.window_start, q.window_end)).map(([id]) => id)
    const createdInWin = ids.filter((id) => inWin(createdDay.get(id), q.window_start, q.window_end))
    const run = (extraIds, weight, hard) => L.runScript(rt, q.query, {
      limit: LIMIT, maxTokens: 0, floors: 'strict', track,
      arm: extraIds.length ? {
        appendLegs: () => [{ weight, scores: new Map(extraIds.map((id) => [id, 1])), leg: 'fts' }],
        ...(hard ? { fuse: (pool) => { const kept = pool.filter((h) => extraIds.includes(h.id)); return kept.length ? kept : pool } } : {}),
      } : {},
    })
    const rankOf = (p) => (p.ids.findIndex((x) => q.gold.includes(x)) === -1 ? null : p.ids.findIndex((x) => q.gold.includes(x)) + 1)
    const fold = (p) => ({ ids: p.ids, gold_rank: rankOf(p), in_top3: p.ids.slice(0, 3).some((x) => q.gold.includes(x)), missing: !p.ids.some((x) => q.gold.includes(x)) })
    const base = await run([], 0, false)
    const byCreated = await run(createdInWin, 1.0, false)
    const byEvent = await run(eventsInWin, 1.0, false)
    const byEventHard = await run(eventsInWin, 1.0, true)
    timeRows.push({
      id: q.id, gold: q.gold, window_start: q.window_start, window_end: q.window_end,
      window_word_present: q.window_word != null,
      annotated_event_facts_in_window: eventsInWin.length,
      created_at_facts_in_window: createdInWin.length,
      baseline: fold(base), window_created: fold(byCreated), window_event: fold(byEvent), window_event_hard: fold(byEventHard),
    })
  }
  const timeSummary = (key) => {
    const rs = timeRows
    const found = rs.filter((r) => r[key].gold_rank !== null)
    return {
      queries: rs.length,
      missing: rs.filter((r) => r[key].missing).length,
      in_top3: rs.filter((r) => r[key].in_top3).length,
      top1: rs.filter((r) => r[key].gold_rank === 1).length,
      avg_rank: found.length ? L.round4(found.reduce((n, r) => n + r[key].gold_rank, 0) / found.length) : null,
    }
  }
  // guards: a no-time query must be byte-identical with the leg on and off
  const guardRows = []
  for (const q of guardQs) {
    const base = await L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const win = R.parseTimeWindow(q.query)
    const legIds = win ? ids.filter((id) => inWin(createdDay.get(id), new Date(win.start).toISOString().slice(0, 10), new Date(win.end).toISOString().slice(0, 10))) : []
    const arms = await L.runScript(rt, q.query, {
      limit: LIMIT, maxTokens: 0, floors: 'strict', track,
      arm: legIds.length ? { appendLegs: () => [{ weight: 1.0, scores: new Map(legIds.map((id) => [id, 1])), leg: 'fts' }] } : {},
    })
    guardRows.push({ id: q.id, parsed: win !== undefined, identical: base.ids.join(',') === arms.ids.join(',') })
  }

  const s5 = {
    card: 'R4-S5',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: await (async () => {
      const recs = []
      for (const q of [...timeQs, ...guardQs]) recs.push(await L.identityCheck(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
      return { checked: recs.length, passed: recs.filter((r) => r.ok).length, failures: recs.filter((r) => !r.ok) }
    })(),
    demand_upper_bound: {
      annotation_event_date_share: pct([...new Set((annA.facts ?? []).filter((f) => f.event_date).map((f) => f.id))].length, (annA.facts ?? []).length),
      annotation_event_date_share_independent_pass: pct([...new Set((annAext.facts ?? []).filter((f) => f.event_date).map((f) => f.id))].length, (annAext.facts ?? []).length),
      s1_text_parseable_share: null,
      note: 'S1 measured 34/85 facts whose TEXT carries a parseable expression; the annotation says 18/64 (29.7% A-ext) facts have an explicit event date. The smaller number is the A2 demand bound: an explicit EVENT date, not a date-shaped string.',
    },
    derivation: { source: 'queries.json form=time (window chosen from the annotated event date, narrowest first)', queries: timeQs.length, guards: guardQs.length, event_dates_available: eventDates.size },
    summary: { baseline: timeSummary('baseline'), window_created_at: timeSummary('window_created'), window_event_date: timeSummary('window_event'), window_event_date_hard: timeSummary('window_event_hard') },
    guards: { total: guardRows.length, parsed_as_time: guardRows.filter((r) => r.parsed).length, byte_identical: guardRows.filter((r) => r.identical).length },
    rows: timeRows,
    cross_validation_r2_2: cross,
    reproduction: 'node mem/scripts/spikes/bench-r4-4-time-attribute.mjs',
  }

  // ── S6: attribute groups ──────────────────────────────────────────────────────────────────────
  const groups = new Map()
  for (const rec of annA.facts ?? []) {
    if (!rec.subject || !rec.attribute || !texts.has(rec.id)) continue
    const k = `${R.normName(rec.subject)}\u0001${R.normName(rec.attribute)}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(rec)
  }
  // Query shape: "<subject>的<attribute>" where the SUBJECT is shared by several annotated facts
  // and the ATTRIBUTE picks one of them. (The exact (subject,attribute) PAIR group is empty on a
  // 64-fact sample: the pilot found 0 pairs of size >= 2 — recorded, not hidden.)
  const subjectGroups = new Map()
  for (const rec of annA.facts ?? []) {
    if (!rec.subject || !texts.has(rec.id)) continue
    const k = R.normName(rec.subject)
    if (!subjectGroups.has(k)) subjectGroups.set(k, { subject: rec.subject, facts: [], attrs: new Map() })
    const g = subjectGroups.get(k)
    g.facts.push(rec.id)
    if (rec.attribute) g.attrs.set(rec.id, rec.attribute)
  }
  const usableSubjects = [...subjectGroups.values()].filter((g) => g.facts.length >= 3)
  const exactPairGroups = [...groups.values()].filter((recs) => recs.length >= 2).length
  const ruleSubject = (id) => {
    const names = [...new Set(bags.get(id) ?? [])]
    if (!names.length) return null
    names.sort((a, b) => (df.get(b) ?? 0) - (df.get(a) ?? 0) || a.localeCompare(b))
    return names[0]
  }
  const subjectRuleGroup = (subject) => new Set(ids.filter((id) => ruleSubject(id) === subject))
  const attrQs = []
  let attrN = 0
  for (const g of usableSubjects) {
    for (const id of g.facts) {
      const attribute = g.attrs.get(id)
      if (!attribute || attrN >= 40) continue
      attrN += 1
      attrQs.push({ id: `attrq-${attrN}`, query: `${g.subject}的${attribute}`, gold: [id], subject: g.subject, attribute, group: g.facts })
    }
  }

  const attrRows = []
  for (const q of attrQs) {
    const gold = q.gold
    const group = new Set(q.group)
    const rule = subjectRuleGroup(q.subject)
    const run = (arm) => L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm })
    const fold = (p) => ({
      ids: p.ids, pool_size: p.pool.length,
      gold_in_top1: gold.includes(p.ids[0]) ? 1 : 0,
      gold_in_top3: p.ids.slice(0, 3).filter((x) => gold.includes(x)).length,
      gold_in_pool: gold.filter((x) => new Set(p.pool.map((h) => h.id)).has(x)).length,
      gold_rank: p.ids.indexOf(gold[0]) === -1 ? null : p.ids.indexOf(gold[0]) + 1,
      missing: gold.some((x) => !p.ids.includes(x)),
    })
    const base = await run({})
    const filter = await run({ fuse: (pool) => pool.filter((h) => group.has(h.id)) })
    const filterRule = await run({ fuse: (pool) => (rule.size ? pool.filter((h) => rule.has(h.id)) : pool) })
    const gl = {}
    for (const w of [0.15, 0.5]) gl[`w${w}`] = await run({ appendLegs: () => (group.size ? [{ weight: w, scores: new Map([...group].map((id) => [id, 1])), leg: 'jaccard' }] : []) })
    const glRule = await run({ appendLegs: () => (rule.size ? [{ weight: 0.5, scores: new Map([...rule].map((id) => [id, 1])), leg: 'jaccard' }] : []) })
    attrRows.push({
      id: q.id, subject_group_size: q.group.length, gold_total: 1,
      baseline: fold(base), filter: fold(filter), filter_rule_subject: fold(filterRule),
      groupleg_w015: fold(gl['w0.15']), groupleg_w05: fold(gl['w0.5']), groupleg_rule_subject_w05: fold(glRule),
      union_narrowed_filter: filter.pool.length < base.pool.length,
      union_narrowed_filter_rule: filterRule.pool.length < base.pool.length,
      rule_group_size: rule.size,
    })
  }
  const attrSummary = (key) => {
    const rs = attrRows
    return {
      queries: rs.length,
      top1_queries: rs.filter((r) => r[key].gold_in_top1 === 1).length,
      top3_gold: rs.reduce((n, r) => n + r[key].gold_in_top3, 0),
      gold_total: rs.reduce((n, r) => n + r.gold_total, 0),
      gold_in_pool: rs.reduce((n, r) => n + r[key].gold_in_pool, 0),
      missing_queries: rs.filter((r) => r[key].missing).length,
      mean_pool: rs.length ? L.round4(rs.reduce((n, r) => n + r[key].pool_size, 0) / rs.length) : null,
    }
  }

  // G-A7 attribution rate per pass
  const attribution = {}
  for (const [key, src] of [['A', annA], ['A-ext', annAext], ['B-ext', annBext]]) {
    const recs = (src.facts ?? []).filter((f) => texts.has(f.id))
    const filled = recs.filter((f) => f.source_ref)
    const kinds = {}
    for (const f of filled) {
      const s = String(f.source_ref)
      const kd = /^https?:\/\//i.test(s) ? 'url' : /^[0-9a-f]{7,40}$/i.test(s) ? 'commit' : /[/\\]|\.[a-z0-9]{1,5}\b/i.test(s) ? 'path_or_doc' : 'other'
      kinds[kd] = (kinds[kd] ?? 0) + 1
    }
    attribution[key] = { facts: recs.length, source_ref_non_null: filled.length, rate: pct(filled.length, recs.length), kinds }
  }
  const r25 = (() => {
    try { return JSON.parse(readFileSync(join(L.REPO, 'docs/spikes/raw/round2-r2-5-source-coverage.json'), 'utf8')) } catch { return null }
  })()

  const s6 = {
    card: 'R4-S6',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'the identity check for this runtime is reported in S5 (same runtimes/plan); this section adds legs on top of an already-identity-checked pass' },
    attribute: {
      derivation: 'annotation subject groups with >= 3 facts; query = "<subject>的<attribute>", gold = the one fact carrying that attribute',
      subjects_with_3plus_facts: usableSubjects.length,
      exact_subject_attribute_pair_groups_of_2plus: exactPairGroups,
      queries: attrQs.length,
      summary: {
        baseline: attrSummary('baseline'),
        filter_caller_group: attrSummary('filter'),
        filter_rule_subject_group: attrSummary('filter_rule_subject'),
        groupleg_caller_w015: attrSummary('groupleg_w015'),
        groupleg_caller_w05: attrSummary('groupleg_w05'),
        groupleg_rule_subject_w05: attrSummary('groupleg_rule_subject_w05'),
      },
      mean_gold_rank: (() => {
        const mean = (k) => { const f = attrRows.filter((r) => r[k].gold_rank !== null); return f.length ? L.round4(f.reduce((n, r) => n + r[k].gold_rank, 0) / f.length) : null }
        return { baseline: mean('baseline'), filter: mean('filter'), groupleg_w05: mean('groupleg_w05'), groupleg_rule_w05: mean('groupleg_rule_subject_w05') }
      })(),
      union_narrowed_by_filter: attrRows.filter((r) => r.union_narrowed_filter).length,
      rows: attrRows,
    },
    ga7_attribution: {
      per_pass: attribution,
      r2_5_offline_proxy: r25 ? { proxy_share: r25.proxy?.share ?? null, overlapping_facts: r25.proxy?.overlapping_facts ?? null, counts: r25.counts, kb: r25.knowledge, acceptance_threshold: r25.instrumentation?.acceptance_threshold ?? null } : null,
      predicted_production_band: 'the model annotator filled a source for 45–63% of facts; a real writing agent has strictly less information than the annotator (it does not re-read the fact), so treat the offline rate as an UPPER bound, not a forecast',
      mirror_source_current: { facts_with_mirror_source: mirror, active: ids.length },
    },
    reproduction: 'node mem/scripts/spikes/bench-r4-4-time-attribute.mjs',
  }

  const whitelist = R.repoCjkWhitelist()
  for (const [name, o] of [['s5', s5], ['s6', s6]]) {
    o.privacy = R.auditArtifact(o, { cjkWhitelist: whitelist })
    if (!o.privacy.clean) {
      console.error(`PRIVACY AUDIT FAILED (${name})`, JSON.stringify(o.privacy).slice(0, 3000))
      process.exitCode = 1
    }
  }
  L.writeJson(outS5, s5)
  L.writeJson(outS6, s6)
  console.log('S5 summary:', JSON.stringify(s5.summary))
  console.log('S5 guards:', JSON.stringify(s5.guards), 'demand:', s5.demand_upper_bound.annotation_event_date_share)
  console.log('S5 r2-2 cross:', JSON.stringify(cross))
  console.log('S6 attr summary:', JSON.stringify(s6.attribute.summary))
  console.log('S6 unions narrowed by filter:', s6.attribute.union_narrowed_by_filter, '/', attrQs.length)
  console.log('S6 attribution:', JSON.stringify(attribution))
  L.teardown(track)
}

await main()
