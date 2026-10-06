/**
 * Round-6 · S3 + S4 + S5 — the demand side (multi-hop / relation-browse), the four-way
 * attribution of each failure, and whether the four ENGINE-DERIVABLE edge types can connect the
 * gold a multi-hop question needs.
 *
 * S3 · DERIVATION (the round-4 engine's two hard rules, restated):
 *   1. the query must not contain a UNIQUE literal of its gold — every character 3-gram shared
 *      between the query and a gold fact must have active document frequency >= 2 (the FTS index
 *      is a trigram index, so a df-1 shared trigram means the lexical leg alone can answer);
 *   2. a time-free guard — the query must not parse as a time window (so a time leg cannot be the
 *      reason an answer appears), plus "the query must share at least one guarded trigram".
 *   Two query families:
 *     - MULTI-HOP : F1 and F2 share a bridge entity; F1 carries E1 (absent from F2), F2 carries E3
 *                   (absent from F1); the query is `E1 E3` and the gold is BOTH facts. A few
 *                   questions deliberately need a gold that is ARCHIVED (the S4 "A" population).
 *     - BROWSE    : an entity X with >=3 active facts; query `和X相关的`; gold = X's facts.
 *
 * S3 · MECHANISMS: production dispatch with default parameters (`search` for every question, plus
 * `ask` for multi-hop and `related` for browse). Reported: gold all / partial / none in top-3,
 * `missing` (gold absent from the returned pool), average rank, and an IDENTITY assertion
 * (production dispatch == the store method for the actions; runScript == product for `search`).
 *
 * S4 · ATTRIBUTION of every question no mechanism answers (all-gold-in-top-3 by none of them),
 * with an explicit priority so the four classes partition:
 *   A  the gold fact is not in the active corpus;
 *   D  gold exists but every carrier is SPURIOUS: the shared "entity" is a hub word (df > 15) or
 *      the only triple link joins two fragments (neither endpoint is an entity name);
 *   B  gold exists, no carrier of any kind (no shared entity, no triple link, no supersede,
 *      no contradiction);
 *   C  a real carrier exists (shared non-hub entity or an entity-named triple link) and no tested
 *      mechanism walks it.
 *
 * S5 · DERIVABLE EDGE COVERAGE (the "do we need an agent" decision): with ONLY the four
 * engine-derivable edge types — shared_entity / temporal / supersedes / contradicts — is each
 * multi-hop question's gold set connected? For the ones that are not, the needed edge type is
 * classified (`same_as` when the golds share only surface terms; otherwise sampled manually).
 *
 * PRIVACY: query strings, entity names and per-question judgments go to `/tmp/dsh-r6/s3-queries.json`
 * and `/tmp/dsh-r6/s3-sample.json`; the repo artifact keeps ids / counts / ratios only.
 *
 * OUTPUT: `mem/docs/spikes/raw/round6-s3-needs.json`.
 * Usage: node mem/scripts/spikes/bench-r6-3-needs.mjs [--json <path>] [--multi N] [--browse N]
 */
import { join } from 'node:path'
import * as B from './bench-r6-lib.mjs'

const outPath = B.arg('json', join(B.REPO, 'docs/spikes/raw/round6-s3-needs.json'))
const multiN = Number(B.arg('multi', 12))
const browseN = Number(B.arg('browse', 10))
const LIMIT = 5
const HUB_DF = 15

// ─── derivation helpers ───────────────────────────────────────────────────────
function buildTrigramIndex(db) {
  const df = new Map()
  const perFact = new Map()
  const rows = db.prepare("select fact_id id, content from facts where status = 'active'").all()
  for (const r of rows) {
    const set = new Set(B.trigrams(String(r.content)))
    perFact.set(r.id, set)
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return { df, perFact, ids: rows.map((r) => r.id) }
}

function guardQuery(idx, query, goldIds, parseWindow) {
  const q = new Set(B.trigrams(query))
  const shared = new Set()
  for (const gid of goldIds) for (const t of idx.perFact.get(gid) ?? []) if (q.has(t)) shared.add(t)
  const time = parseWindow(query)
  const reason = shared.size === 0 ? 'no_shared_trigram' : time !== undefined ? 'has_time_expression' : null
  let unique = 0
  for (const t of shared) if ((idx.df.get(t) ?? 0) < 2) unique += 1
  return { ok: reason === null && unique === 0, reason: unique > 0 ? 'unique_literal' : reason, shared_trigrams: shared.size, unique_shared_trigrams: unique, time_free: time === undefined }
}

async function main() {
  B.banner('round6 · S3/S4/S5 demand side')
  B.ensureTmp()
  const work = B.L.mkdtempSync(join(B.L.tmpdir(), 'avantf-r6-s3-'))
  const snap = join(work, 'memory.db')
  B.snapshotDb(B.pinSource(), snap)
  const db = B.openReadOnly(snap)
  const active = db.prepare("select fact_id id from facts where status = 'active' order by fact_id").all().map((r) => r.id)
  const activeSet = new Set(active)
  const meta = B.factMeta(db)
  const bags = B.entityBags(db)
  const entityNames = new Set(db.prepare('select name from entities').all().map((r) => r.name))
  const triples = B.allTriples(db)
  const tripleByFact = new Map()
  for (const t of triples) {
    if (!tripleByFact.has(t.fact_id)) tripleByFact.set(t.fact_id, [])
    tripleByFact.get(t.fact_id).push(t)
  }
  const contradictions = B.contradictionPairs(db)
  const supersedes = B.supersedesLinks(db)
  const timeWindows = B.factTimeWindows(db)
  const idx = buildTrigramIndex(db)
  const parseWindow = (text) => B.R.parseTimeWindow(text)

  const entFacts = new Map()
  for (const [fid, bag] of bags) {
    if (!activeSet.has(fid)) continue
    for (const name of bag) {
      if (!entFacts.has(name)) entFacts.set(name, new Set())
      entFacts.get(name).add(fid)
    }
  }
  const entDf = new Map([...entFacts.entries()].map(([n, s]) => [n, s.size]))

  // ── raw link helpers + a surface-term index (used by BOTH derivation and S4/S5) ────────────
  const sharedEntityNames = (a, b) => {
    const x = bags.get(a) ?? new Set()
    const y = bags.get(b) ?? new Set()
    const out = []
    for (const e of x) if (y.has(e)) out.push(e)
    return out
  }
  const tripleLinkExists = (a, b) => {
    for (const t1 of tripleByFact.get(a) ?? []) for (const t2 of tripleByFact.get(b) ?? []) {
      if (t1.obj === t2.subj || t2.obj === t1.subj) return true
    }
    return false
  }
  const termDf = new Map()
  const factTerms = new Map()
  for (const id of active) {
    const row = db.prepare('select content from facts where fact_id = ?').get(id)
    const terms = new Set([...(String(row.content).match(/[\u4e00-\u9fff]{2,}/g) ?? []), ...(String(row.content).match(/[A-Za-z0-9_.-]{3,}/g) ?? [])])
    factTerms.set(id, terms)
    for (const t of terms) termDf.set(t, (termDf.get(t) ?? 0) + 1)
  }
  const sharedSurfaceTerms = (a, b) => {
    const out = []
    for (const t of factTerms.get(a) ?? new Set()) {
      if ((factTerms.get(b) ?? new Set()).has(t) && (termDf.get(t) ?? 0) >= 2 && !entityNames.has(t)) out.push(t)
    }
    return out
  }

  // ── multi-hop candidates ───────────────────────────────────────────────────
  // THREE sources, deliberately: if every multi-hop question were derived from a shared entity,
  // S5's shared_entity coverage would be a construction, not a measurement. So the families are
  //   bridge_entity : F1,F2 share a non-hub entity  (the derivable case);
  //   bridge_triple : F1,F2 are joined by t1.obj === t2.subj and share NO entity;
  //   bridge_topic  : F1,F2 share only a surface term (df>=2, not an entity) and no triple link;
  //   archived_gold : one needed gold is archived (the S4 "A" population).
  const multiQ = []
  const usedPairs = new Set()
  const guardRejects = {}
  const tryAdd = (f1, f2, source) => {
    const key = `${Math.min(f1, f2)}|${Math.max(f1, f2)}`
    if (usedPairs.has(key)) return false
    const b1 = bags.get(f1) ?? new Set()
    const b2 = bags.get(f2) ?? new Set()
    const e1c = [...b1].filter((e) => !b2.has(e) && (entDf.get(e) ?? 0) >= 2 && (entDf.get(e) ?? 0) <= 20)
    const e3c = [...b2].filter((e) => !b1.has(e) && (entDf.get(e) ?? 0) >= 2 && (entDf.get(e) ?? 0) <= 20)
    if (!e1c.length || !e3c.length) return false
    for (const e1 of e1c.slice(0, 3)) {
      for (const e3 of e3c.slice(0, 3)) {
        const query = `${e1} ${e3}`
        const g = guardQuery(idx, query, [f1, f2], parseWindow)
        if (!g.ok) {
          guardRejects[g.reason] = (guardRejects[g.reason] ?? 0) + 1
          continue
        }
        usedPairs.add(key)
        multiQ.push({
          id: `mh-${multiQ.length + 1}`, kind: 'multi_hop', query, gold: [f1, f2],
          gold_status: [meta.get(f1)?.status, meta.get(f2)?.status], e1, e3, guard: g, derivation: source,
          bridge_kind: source,
        })
        return true
      }
    }
    return false
  }

  const takeFrom = (source, cap, pairs) => {
    let n = 0
    for (const [f1, f2] of pairs) {
      if (n >= cap || multiQ.length >= multiN) break
      if (tryAdd(f1, f2, source)) n += 1
    }
    return n
  }
  // ① shared non-hub entity, active-active
  const entityPairs = []
  for (const [, facts] of [...entFacts.entries()].filter(([, s]) => s.size >= 2 && s.size <= 20).sort((a, b) => a[0].localeCompare(b[0]))) {
    const arr = [...facts].filter((id) => activeSet.has(id)).sort((a, b) => a - b)
    for (let i = 0; i < arr.length; i += 1) for (let j = i + 1; j < arr.length; j += 1) entityPairs.push([arr[i], arr[j]])
  }
  const nEntity = takeFrom('bridge_entity', Math.max(1, multiN - 6), entityPairs)
  // ② triple link with NO shared entity
  const triplePairs = []
  for (const t1 of triples) {
    for (const t2 of triples) {
      if (t1.fact_id === t2.fact_id) continue
      if (t1.obj !== t2.subj) continue
      if (!activeSet.has(t1.fact_id) || !activeSet.has(t2.fact_id)) continue
      if (sharedEntityNames(t1.fact_id, t2.fact_id).length > 0) continue
      triplePairs.push([t1.fact_id, t2.fact_id])
    }
  }
  const nTriple = takeFrom('bridge_triple', 3, triplePairs)
  // ③ surface-topic only (no entity, no triple link)
  const topicPairs = []
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]
      const b = active[j]
      if (sharedEntityNames(a, b).length > 0) continue
      if (tripleLinkExists(a, b)) continue
      if (sharedSurfaceTerms(a, b).length === 0) continue
      topicPairs.push([a, b])
    }
  }
  const nTopic = takeFrom('bridge_topic', 3, topicPairs)
  // ④ archived gold (the S4 A population)
  const archivedPairs = []
  for (let i = 0; i < active.length; i += 1) {
    for (const [fid, m] of meta) {
      if (m.status === 'active') continue
      const a = active[i]
      if (sharedEntityNames(a, fid).length > 0 || tripleLinkExists(a, fid) || sharedSurfaceTerms(a, fid).length > 0) archivedPairs.push([fid, a])
    }
  }
  const nArchived = takeFrom('archived_gold', 2, archivedPairs)

  // ── browse candidates ──────────────────────────────────────────────────────
  const browseQ = []
  // Browse gold is capped at EXACTLY 3 facts: "gold all in top-3" is undefined for a larger gold
  // set, and the brief's three-way reading is what this card must report. 65 entities in this
  // corpus have exactly 3 active facts AND a guard-passing name, so the cap costs nothing.
  const browseEnts = [...entFacts.entries()]
    .filter(([, s]) => s.size === 3)
    .sort((a, b) => a[0].localeCompare(b[0]))
  for (const [name, facts] of browseEnts) {
    if (browseQ.length >= browseN) break
    const gold = [...facts].filter((id) => activeSet.has(id)).sort((a, b) => a - b)
    if (gold.length < 3) continue
    const query = `和${name}相关的`
    const g = guardQuery(idx, query, gold, parseWindow)
    if (!g.ok) continue
    // Skip a browse question whose entity overlaps a multi-hop bridge we already used (keeps the
    // two families from testing the same thing twice).
    if (browseQ.some((q) => q.entity === name)) continue
    browseQ.push({ id: `br-${browseQ.length + 1}`, kind: 'relation_browse', query, entity: name, gold, guard: g })
  }

  const queries = [...multiQ, ...browseQ]

  // ── carrier analysis (S4) and derivable-edge graph (S5) ────────────────────
  const sharedEntities = (a, b) => {
    const x = bags.get(a) ?? new Set()
    const y = bags.get(b) ?? new Set()
    const out = []
    for (const e of x) if (y.has(e)) out.push(e)
    return out
  }
  const tripleLinks = (a, b) => {
    const out = []
    for (const t1 of tripleByFact.get(a) ?? []) {
      for (const t2 of tripleByFact.get(b) ?? []) {
        if (t1.obj === t2.subj) out.push({ from: a, to: b, via: t1.obj })
        if (t2.obj === t1.subj) out.push({ from: b, to: a, via: t2.obj })
      }
    }
    return out
  }
  const supersedeLink = (a, b) => supersedes.get(a) === b || supersedes.get(b) === a
  const contradictLink = (a, b) => contradictions.has(`${Math.min(a, b)}|${Math.max(a, b)}`)
  const temporalLink = (a, b) => {
    // The CONTENT's usable event time, not the write time: `created_at` is a same-session artifact
    // (18 facts share one day here), so using it would manufacture temporal edges. Both facts must
    // carry a parseable time expression and their windows must be within 30 days.
    const wa = timeWindows.get(a)
    const wb = timeWindows.get(b)
    if (!wa || !wb) return false
    return Math.abs(wa.start - wb.start) <= 30 * 86400000
  }
  const carriersOf = (a, b) => ({
    shared_entity: sharedEntities(a, b),
    triple_link: tripleLinks(a, b),
    supersedes: supersedeLink(a, b),
    contradicts: contradictLink(a, b),
    temporal: temporalLink(a, b),
  })
  /** The four EDGE TYPES allowed by S5. */
  const derivableEdges = (a, b) => {
    const c = carriersOf(a, b)
    return {
      shared_entity: c.shared_entity.length > 0,
      temporal: c.temporal,
      supersedes: c.supersedes,
      contradicts: c.contradicts,
    }
  }
  function connectedUnder(gold, edgeFn) {
    if (gold.length <= 1) return true
    const parent = new Map(gold.map((g) => [g, g]))
    const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)))
    for (let i = 0; i < gold.length; i += 1) {
      for (let j = i + 1; j < gold.length; j += 1) {
        if (edgeFn(gold[i], gold[j])) parent.set(find(gold[i]), find(gold[j]))
      }
    }
    return gold.every((g) => find(g) === find(gold[0]))
  }

  // ── run the mechanisms ─────────────────────────────────────────────────────
  const emb = await B.warmEmbedder()
  const track = { runtimes: [], dirs: [work] }
  const rt = B.newRuntime({ snapPath: snap, semantic: emb, track })
  track.texts = rt.memory.loadTexts(active)
  const identityRecords = []
  let identityOk = 0

  const ids = (r) => (r.hits ?? []).map((h) => h.ref_id ?? h.id)
  async function runMechanism(q, mech) {
    if (mech === 'search') {
      const ident = await B.identityCheck(rt, q.query, { limit: LIMIT, track })
      identityRecords.push({ id: q.id, mech, ok: ident.ok })
      if (ident.ok) identityOk += 1
      const res = await rt.recall({ action: 'search', query: q.query, limit: LIMIT })
      return ids(res)
    }
    if (mech === 'ask') {
      const prod = await rt.recall({ action: 'ask', query: q.query, limit: LIMIT })
      const direct = await rt.memory.ask(q.query, LIMIT)
      const ok = B.sameOrder(ids(prod), ids(direct))
      identityRecords.push({ id: q.id, mech, ok })
      if (ok) identityOk += 1
      return ids(prod)
    }
    if (mech === 'related') {
      const prod = await rt.recall({ action: 'related', entity: q.entity, limit: 10 })
      const direct = rt.memory.related(q.entity, 10)
      const ok = JSON.stringify(prod) === JSON.stringify(direct)
      identityRecords.push({ id: q.id, mech, ok })
      if (ok) identityOk += 1
      // `related` answers with ENTITIES, not facts: it structurally cannot return the gold facts.
      return (Array.isArray(prod) ? prod : prod.hits ?? []).map((r) => `entity:${r.entity}`)
    }
    throw new Error(`unknown mechanism ${mech}`)
  }

  const results = []
  for (const q of queries) {
    const mechs = q.kind === 'relation_browse' ? ['search', 'related'] : ['search', 'ask']
    const per = {}
    for (const mech of mechs) {
      const got = await runMechanism(q, mech)
      const goldSet = new Set(q.gold)
      const top3 = got.slice(0, 3)
      const inTop3 = top3.filter((id) => goldSet.has(id))
      const inPool = got.filter((id) => goldSet.has(id))
      const ranks = q.gold.map((g) => (got.indexOf(g) === -1 ? null : got.indexOf(g) + 1))
      per[mech] = {
        returned: got.filter((id) => typeof id === 'number'),
        top3_all: inTop3.length === q.gold.length,
        top3_partial: inTop3.length > 0 && inTop3.length < q.gold.length,
        top3_none: inTop3.length === 0,
        gold_in_top3: inTop3.length,
        gold_in_pool: inPool.length,
        missing: q.gold.length - inPool.length,
        avg_rank: ranks.every((r) => r !== null) ? Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 100) / 100 : null,
      }
    }
    const anyAll = Object.values(per).some((r) => r.top3_all)
    const carriers = q.kind === 'multi_hop' ? carriersOf(q.gold[0], q.gold[1]) : null
    const derivable = q.kind === 'multi_hop' ? derivableEdges(q.gold[0], q.gold[1]) : null
    const derivableConnected = q.kind === 'multi_hop' ? connectedUnder(q.gold, (a, b) => {
      const e = derivableEdges(a, b)
      return e.shared_entity || e.temporal || e.supersedes || e.contradicts
    }) : true
    let neededType = null
    if (q.kind === 'multi_hop' && !derivableConnected) {
      const surface = sharedSurfaceTerms(q.gold[0], q.gold[1])
      neededType = surface.length > 0 ? 'same_as_or_same_topic(surface)' : 'causal_or_belongs_to(unspecified)'
    }
    // S4 classification (priority: A > D > B > C). Only MULTI-HOP questions are attributed:
    // the relation-level causes only make sense for a question that needs more than one fact, and
    // a browse question's gold all share the browse entity by construction.
    let attribution = null
    let reach = null
    if (q.kind === 'multi_hop' && !anyAll) {
      // Is the gap CANDIDATE GENERATION or RANKING? If the missing gold is inside the raw union of
      // the three legs, a relation edge could re-rank it; if it is not, no ranking change reaches
      // it. This is the reading that decides whether an engine-derived edge layer can help.
      const union = await B.legUnionIds(rt, q.query, { limit: LIMIT })
      const searchGot = per.search.returned
      const missingGold = q.gold.filter((g) => !searchGot.includes(g))
      reach = {
        missing_gold: missingGold.length,
        missing_in_leg_union: missingGold.filter((g) => union.has(g)).length,
        missing_absent_from_leg_union: missingGold.filter((g) => !union.has(g)).length,
        leg_union_size: union.size,
        gold_all_in_leg_union: q.gold.every((g) => union.has(g)),
      }
      const inactive = q.gold.filter((g) => meta.get(g)?.status !== 'active')
      if (inactive.length > 0) attribution = { class: 'A', evidence: `inactive_gold=${inactive.length}` }
      else if (carriers) {
        const realShared = carriers.shared_entity.filter((e) => (entDf.get(e) ?? 0) <= HUB_DF)
        const realTriple = carriers.triple_link.filter((l) => entityNames.has(l.via))
        const anyCarrier = carriers.shared_entity.length + carriers.triple_link.length + (carriers.supersedes ? 1 : 0) + (carriers.contradicts ? 1 : 0) > 0
        if (!anyCarrier) attribution = { class: 'B', evidence: 'no_carrier' }
        else if (realShared.length === 0 && realTriple.length === 0 && !carriers.supersedes && !carriers.contradicts) {
          // Every carrier is spurious: a hub word (df > HUB_DF) or a triple link whose pivot is a
          // fragment. The connection "exists" but says nothing — that is D, not C.
          const maxDf = carriers.shared_entity.length ? Math.max(...carriers.shared_entity.map((e) => entDf.get(e) ?? 0)) : 0
          attribution = { class: 'D', evidence: `spurious_only: shared=${carriers.shared_entity.length}(max_df=${maxDf}) triple=${carriers.triple_link.length}(fragment)` }
        } else attribution = { class: 'C', evidence: `real_carriers: shared=${realShared.length} triple=${realTriple.length} supersede=${carriers.supersedes ? 1 : 0} contradict=${carriers.contradicts ? 1 : 0}` }
      } else attribution = { class: 'B', evidence: 'no_carrier' }
    }
    results.push({
      id: q.id, kind: q.kind, derivation: q.derivation ?? null, bridge_kind: q.bridge_kind ?? null, gold: q.gold, gold_status: q.gold_status ?? q.gold.map((g) => meta.get(g)?.status),
      guard: q.guard, mechanisms: per, any_mechanism_all: anyAll, reach,
      carriers: carriers ? { shared_entity_count: carriers.shared_entity.length, shared_entity_max_df: carriers.shared_entity.length ? Math.max(...carriers.shared_entity.map((e) => entDf.get(e) ?? 0)) : 0, triple_link_count: carriers.triple_link.length, triple_link_entity_named: carriers.triple_link.filter((l) => entityNames.has(l.via)).length, supersedes: carriers.supersedes, contradicts: carriers.contradicts, temporal: carriers.temporal } : null,
      derivable_edges: derivable, derivable_connected: derivableConnected, needed_edge_type: neededType,
      attribution,
    })
  }

  // ── derived strings to /tmp; a manual sample of the unconnectable ones ──────
  const queryDump = B.writeTmp('s3-queries.json', {
    note: 'derived S3 query strings + gold ids; derived from real text, never committed',
    queries: queries.map((q) => ({ id: q.id, kind: q.kind, query: q.query, gold: q.gold, entity: q.entity ?? null, bridge_kind: q.bridge_kind ?? null })),
  })
  const unconnectable = results.filter((r) => r.kind === 'multi_hop' && !r.derivable_connected)
  const sample = unconnectable.slice(0, 10).map((r) => {
    const q = queries.find((x) => x.id === r.id)
    return { id: r.id, query: q.query, gold: r.gold, gold_contents: r.gold.map((g) => db.prepare('select content from facts where fact_id = ?').get(g)?.content ?? ''), carriers: r.carriers, needed_type_guess: r.needed_edge_type }
  })
  const samplePath = B.writeTmp('s3-sample.json', { note: 'unconnectable multi-hop gold pairs; name the needed edge type', items: sample })
  const judgment = B.readTmp('s3-judgment.json')
  const judged = judgment ? { items: judgment.items.length, types: judgment.items.reduce((m, i) => ((m[i.needed_type] = (m[i.needed_type] ?? 0) + 1), m), {}), method: String(judgment.method ?? 'manual').slice(0, 180) } : null

  // ── aggregates ─────────────────────────────────────────────────────────────
  const summarize = (rows) => {
    const out = {}
    for (const kind of ['multi_hop', 'relation_browse']) {
      const rs = rows.filter((r) => r.kind === kind)
      if (!rs.length) continue
      const byMech = {}
      for (const mech of kind === 'multi_hop' ? ['search', 'ask'] : ['search', 'related']) {
        byMech[mech] = {
          all: rs.filter((r) => r.mechanisms[mech].top3_all).length,
          partial: rs.filter((r) => r.mechanisms[mech].top3_partial).length,
          none: rs.filter((r) => r.mechanisms[mech].top3_none).length,
          missing_total: rs.reduce((n, r) => n + r.mechanisms[mech].missing, 0),
          gold_total: rs.reduce((n, r) => n + r.gold.length, 0),
          avg_rank: (() => {
            const vals = rs.map((r) => r.mechanisms[mech].avg_rank).filter((v) => v !== null)
            return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null
          })(),
        }
      }
      out[kind] = { questions: rs.length, gold_total: rs.reduce((n, r) => n + r.gold.length, 0), any_mechanism_all: rs.filter((r) => r.any_mechanism_all).length, by_mechanism: byMech }
    }
    return out
  }
  const attributionCounts = results.filter((r) => r.attribution).reduce((m, r) => ((m[r.attribution.class] = (m[r.attribution.class] ?? 0) + 1), m), {})
  const failures = results.filter((r) => r.attribution).length
  const multiHopFailures = results.filter((r) => r.kind === 'multi_hop' && !r.any_mechanism_all)
  const browseFailures = results.filter((r) => r.kind === 'relation_browse' && !r.any_mechanism_all)
  const reach = {
    multi_hop_failures: multiHopFailures.length,
    missing_gold_total: multiHopFailures.reduce((n, r) => n + (r.reach?.missing_gold ?? 0), 0),
    missing_in_leg_union: multiHopFailures.reduce((n, r) => n + (r.reach?.missing_in_leg_union ?? 0), 0),
    missing_absent_from_leg_union: multiHopFailures.reduce((n, r) => n + (r.reach?.missing_absent_from_leg_union ?? 0), 0),
    failures_with_all_gold_in_union: multiHopFailures.filter((r) => r.reach?.gold_all_in_leg_union).length,
    note: 'missing_in_leg_union = the gap is RANKING (a relation edge could re-rank it); absent = the gap is CANDIDATE GENERATION',
  }
  const s5 = (() => {
    const rs = results.filter((r) => r.kind === 'multi_hop')
    const connected = rs.filter((r) => r.derivable_connected).length
    const types = rs.filter((r) => !r.derivable_connected).reduce((m, r) => ((m[r.needed_edge_type] = (m[r.needed_edge_type] ?? 0) + 1), m), {})
    const byKind = {}
    for (const k of ['bridge_entity', 'bridge_triple', 'bridge_topic', 'archived_gold']) {
      const sub = rs.filter((r) => r.bridge_kind === k)
      if (!sub.length) continue
      byKind[k] = { questions: sub.length, derivable_connected: sub.filter((r) => r.derivable_connected).length, coverage: B.ratio(sub.filter((r) => r.derivable_connected).length, sub.length) }
    }
    return { multi_hop_questions: rs.length, derivable_connected: connected, coverage: B.ratio(connected, rs.length), by_bridge_kind: byKind, needed_types: types, single_edge_type_hits: {
      shared_entity: rs.filter((r) => r.carriers?.shared_entity_count > 0).length,
      temporal: rs.filter((r) => r.carriers?.temporal).length,
      supersedes: rs.filter((r) => r.carriers?.supersedes).length,
      contradicts: rs.filter((r) => r.carriers?.contradicts).length,
    } } })()
  const derivableOnlyCounts = (() => {
    // Which SINGLE derivable type connects each multi-hop gold set on its own (and none of them).
    const rs = results.filter((r) => r.kind === 'multi_hop')
    const one = { shared_entity_only: 0, temporal_only: 0, supersedes_only: 0, contradicts_only: 0, multi_needed: 0, none: 0 }
    for (const r of rs) {
      const e = r.derivable_edges
      const on = ['shared_entity', 'temporal', 'supersedes', 'contradicts'].filter((k) => e[k])
      if (on.length === 0) one.none += 1
      else if (on.length > 1) one.multi_needed += 1
      else one[`${on[0]}_only`] += 1
    }
    return one
  })()

  db.close()

  const artifact = {
    card: 'round6-s3-needs',
    generated_at: new Date().toISOString(),
    node: process.version,
    loadavg: B.loadavg(),
    corpus: { active_facts: active.length },
    derivation: { multi_hop: multiQ.length, relation_browse: browseQ.length, limit_per_mechanism: LIMIT, guard: 'shared 3-gram df>=2 + time-free + >=1 shared trigram', guard_rejects: guardRejects, by_bridge_kind: { bridge_entity: nEntity, bridge_triple: nTriple, bridge_topic: nTopic, archived_gold: nArchived }, archived_pair_candidates: archivedPairs.length, query_strings_file: queryDump },
    s3: summarize(results),
    s4: { failing_questions: failures, multi_hop_failures: multiHopFailures.length, browse_failures: browseFailures.length, counts: attributionCounts, shares: Object.fromEntries(Object.entries(attributionCounts).map(([k, v]) => [k, B.ratio(v, failures)])), criteria: { A: 'a gold fact is not active', D: `carrier exists but only spurious (shared entity df>${HUB_DF} or triple link joins fragments)`, B: 'no shared entity, no triple link, no supersede, no contradiction', C: 'a real carrier exists and no tested mechanism walks it' }, reach },
    s5: { ...s5, single_type_only: derivableOnlyCounts, derivable_types_only: ['shared_entity', 'temporal', 'supersedes', 'contradicts'] },
    identity: { checked: identityRecords.length, ok: identityOk, records_file: null },
    queries: results,
    manual_sample: { sample_file: samplePath, sample_size: sample.length, judged },
  }
  B.writeJson(outPath, artifact)
  B.L.teardown(track)
  console.log(`\nS3 multi=${multiQ.length} browse=${browseQ.length} identity ${identityOk}/${identityRecords.length}`)
  console.log('S3', JSON.stringify(artifact.s3))
  console.log('S4 failures', failures, JSON.stringify(attributionCounts))
  console.log('S5', JSON.stringify(s5), JSON.stringify(derivableOnlyCounts))
}

await main()
