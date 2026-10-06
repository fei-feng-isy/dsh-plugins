/**
 * R5-S2 · the quality arms: does ATOMIZING beat one long fact, and does a RELATION LEG add anything
 * on top of atomizing? Same corpus, same queries, only the write SHAPE changes.
 *
 * THE THREE ARMS (brief §3)
 *   A0  the status quo: one long fact per source memory (68 rows)
 *   S1  the atoms of pass A (no relations)  — isolates "splitting itself"
 *   S2  the same atoms + a RELATION LEG built in-script from pass A's declared edges — isolates
 *       "relations on top of splitting". The leg is ONE leg with weight 0.15 (the weakest
 *       production leg) and a sensitivity arm at 0.05; production's weights are 0.55/0.30/0.15 and
 *       are NOT renormalized, so the leg can move a candidate by at most its own weight. That is
 *       the conservative reading: a relation layer that only wins because it out-weighted the
 *       other three legs would be a broken measurement, so it is not allowed to.
 *
 * THE QUERIES (reverse-derived, arm-independent — the two rules from round 4 are kept)
 *   per-atom   : one question per atom, derived from the atom's rarest engine entity whose document
 *                frequency over the ATOM corpus is in [2,10]; gold = that atom.
 *   cross-atom : one question per declared intra-fact edge, derived from the two atoms' topics
 *                (`<topicA> <topicB>`); gold = the two atoms. The RELATION-REQUIRED subset is the
 *                edges where neither atom carries the other's topic, i.e. the second gold cannot be
 *                reached from the query by the lexical or entity leg at all.
 *   guard      : every 3-gram shared between a query and its gold text must have df >= 2 over the
 *                atom corpus (a query answered by a literal unique to its gold would make the
 *                measurement self-fulfilling — the R2-2/R4 lesson). The guard never reads the arm.
 *
 * WHAT IS REPORTED PER ARM: top1 / gold-in-top3 / missing / gold-in-pool, the CHARACTERS RETURNED
 * PER ANSWER (the token-efficiency claim), the characters of the best gold hit, entity-bag width
 * and candidate fan-out.
 *
 * Usage: node mem/scripts/spikes/bench-r5-2-quality.mjs [--json <path>] [--limit 5]
 * PRIVACY: query strings and atom text stay in `/tmp/dsh-r5/queries.json`; the repo artifact is
 * ids, counts, scores, ratios.
 */
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as R from './bench-r5-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round5-s2-quality.json'))
const LIMIT = Number(L.arg('limit', 5))
const MIN_DF3 = 2
const REL_W = [0.15, 0.05]
const MATCH_MIN = 0.35

const { extractEntities } = await import(L.lib('core/lib/entities/extract.js'))

const trigramDf = (texts) => {
  const df = new Map()
  for (const t of texts) {
    const seen = new Set()
    for (let i = 0; i + 3 <= t.length; i += 1) seen.add(t.slice(i, i + 3))
    for (const g of seen) df.set(g, (df.get(g) ?? 0) + 1)
  }
  return df
}
const trigrams = (s) => {
  const out = new Set()
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3))
  return out
}
const jac = (a, b) => {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter += 1
  return inter / (a.size + b.size - inter)
}

async function main() {
  const corpus = R.readTmp('corpus.json')
  const split = R.readTmp('split-a.json')
  const corpusById = new Map(corpus.facts.map((f) => [f.id, f]))
  const atomsOf = new Map(split.facts.map((f) => [f.id, f.atoms ?? []]))
  const relsOf = new Map(split.facts.map((f) => [f.id, f.relations ?? []]))
  const allAtoms = []
  for (const f of corpus.facts) for (const a of atomsOf.get(f.id) ?? []) allAtoms.push({ ...a, fact_id: f.id })
  L.banner('R5-S2 · write-shape quality arms', { source_facts: corpus.facts.length, atoms: allAtoms.length })

  // ── derivation inputs ─────────────────────────────────────────────────────────────────────────
  const gramDf = trigramDf(allAtoms.map((a) => a.text))
  const atomEntities = new Map()
  for (const a of allAtoms) {
    try {
      atomEntities.set(a.atom_id, [...new Set((await extractEntities(a.text)).map((e) => e.name))].filter((n) => n.length >= 2))
    } catch {
      atomEntities.set(a.atom_id, [])
    }
  }
  const entDf = new Map()
  for (const names of atomEntities.values()) for (const n of new Set(names)) entDf.set(n, (entDf.get(n) ?? 0) + 1)
  const topicOf = (atomId) => {
    const names = atomEntities.get(atomId) ?? []
    const ranked = names
      .filter((n) => (entDf.get(n) ?? 0) >= 2 && (entDf.get(n) ?? 0) <= 10)
      .sort((x, y) => (entDf.get(x) ?? 0) - (entDf.get(y) ?? 0) || y.length - x.length || x.localeCompare(y))
    return ranked[0] ?? null
  }
  const guard = (query, goldText) => {
    const offending = []
    const seen = new Set()
    for (let i = 0; i + 3 <= query.length; i += 1) {
      const g = query.slice(i, i + 3)
      if (seen.has(g)) continue
      seen.add(g)
      if (!goldText.includes(g)) continue
      if ((gramDf.get(g) ?? 0) < MIN_DF3) offending.push(g.length)
    }
    return { ok: offending.length === 0, offending: offending.length }
  }

  // ── build the query set (arm-independent) ─────────────────────────────────────────────────────
  const TEMPLATES = ['是什么', '有哪些']
  const perAtom = []
  for (let i = 0; i < allAtoms.length; i += 1) {
    const a = allAtoms[i]
    const topic = topicOf(a.atom_id)
    if (!topic) continue
    const query = `${topic}${TEMPLATES[i % TEMPLATES.length]}`
    const g = guard(query, a.text)
    if (!g.ok) continue
    const topicDf = entDf.get(topic) ?? 0
    perAtom.push({
      id: `atomq-${a.atom_id}`, form: 'per_atom', query, topic,
      source_fact: a.fact_id, gold_atoms: [a.atom_id],
      gold_text: a.text, topic_df_atoms: topicDf,
      topic_df_low: topicDf <= 2,
    })
  }
  const crossAtom = []
  for (const f of corpus.facts) {
    const la = atomsOf.get(f.id) ?? []
    for (const e of relsOf.get(f.id) ?? []) {
      if (e.type === 'contradicts') continue
      const A = la.find((x) => x.atom_id === e.from)
      const B = la.find((x) => x.atom_id === e.to)
      if (!A || !B) continue
      const ta = topicOf(A.atom_id)
      const tb = topicOf(B.atom_id)
      if (!ta || !tb || ta === tb) continue
      const query = `${ta} ${tb}`
      const goldText = `${A.text}\n${B.text}`
      const g = guard(query, goldText)
      if (!g.ok) continue
      const relationRequired = !B.text.includes(ta) && !A.text.includes(tb)
      crossAtom.push({
        id: `crossq-${A.atom_id}-${B.atom_id}`, form: 'cross_atom', query, topic: ta, topic2: tb,
        source_fact: f.id, gold_atoms: [A.atom_id, B.atom_id], edge_type: e.type,
        relation_required: relationRequired, gold_text: goldText,
      })
    }
  }
  const queries = [...perAtom, ...crossAtom]
  R.writeTmp('queries.json', {
    generated_at: new Date().toISOString(),
    guard: `every 3-gram shared with the gold text has atom-corpus df >= ${MIN_DF3}`,
    queries: queries.map((q) => ({ ...q, gold_text: undefined })),
  })
  console.log(`queries: per_atom ${perAtom.length}, cross_atom ${crossAtom.length} (relation_required ${crossAtom.filter((q) => q.relation_required).length})`)

  // ── corpora ───────────────────────────────────────────────────────────────────────────────────
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const workRoot = L.mkdtempSync(join(L.tmpdir(), 'avantf-r52-'))
  track.dirs.push(workRoot)

  const buildArm = async (name, items) => {
    const dir = join(workRoot, name)
    mkdirSync(dir, { recursive: true })
    const rt = R.newRuntime({ snapPath: join(dir, 'memory.db'), semantic: emb, track })
    const texts = new Map()
    const atomToFact = new Map()
    const factToFact = new Map()
    for (const it of items) {
      const res = await rt.remember({ action: 'add', content: it.text })
      texts.set(res.fact_id, it.text)
      if (it.atom_id) atomToFact.set(it.atom_id, res.fact_id)
      if (it.fact_id) factToFact.set(it.fact_id, res.fact_id)
    }
    const dbPath = join(dir, 'memory.db')
    const size = (() => { try { return statSync(dbPath).size } catch { return null } })()
    return { name, rt, texts, atomToFact, factToFact, size, rows: items.length }
  }
  const armA0 = await buildArm('A0', corpus.facts.map((f) => ({ text: f.text, fact_id: f.id })))
  const armS1 = await buildArm('S1', allAtoms.map((a) => ({ text: a.text, atom_id: a.atom_id })))
  console.log(`arms built: A0 rows ${armA0.rows} (${armA0.size} B), S1 rows ${armS1.rows} (${armS1.size} B)`)

  // The relation leg's index, from the ATOM corpus (S1/S2 share one DB).
  const atomNameSet = new Map()
  for (const a of allAtoms) atomNameSet.set(a.atom_id, new Set((atomEntities.get(a.atom_id) ?? []).map((n) => R.normName(n))))
  const adjacency = new Map()
  const addEdge = (x, y) => {
    if (!adjacency.has(x)) adjacency.set(x, new Set())
    adjacency.get(x).add(y)
  }
  for (const f of corpus.facts) {
    for (const e of relsOf.get(f.id) ?? []) {
      if (e.type === 'contradicts') continue
      addEdge(e.from, e.to)
      addEdge(e.to, e.from)
    }
  }
  const relationLeg = (weight) => (meta) => {
    const qNames = new Set((meta.qEntities ?? []).map((n) => R.normName(n)))
    if (qNames.size === 0) return []
    const scores = new Map()
    for (const [atomId, names] of atomNameSet) {
      let hit = false
      for (const n of names) if (qNames.has(n)) { hit = true; break }
      if (!hit) continue
      for (const nb of adjacency.get(atomId) ?? []) {
        const fid = armS1.atomToFact.get(nb)
        if (fid !== undefined) scores.set(fid, 1)
      }
    }
    if (scores.size === 0) return []
    return [{ weight, scores, leg: 'relation' }]
  }

  // ── run ───────────────────────────────────────────────────────────────────────────────────────
  const runArm = async (armId, arm, rt, texts, weight) => {
    const rows = []
    for (const q of queries) {
      const goldFacts = armId === 'A0'
        ? [armA0.factToFact.get(q.source_fact)].filter((x) => x !== undefined)
        : q.gold_atoms.map((a) => armS1.atomToFact.get(a)).filter((x) => x !== undefined)
      const p = await L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track: { texts }, arm: arm ?? {} })
      const goldSet = new Set(goldFacts)
      const poolIds = new Set(p.pool.map((h) => h.id))
      const rankedGoldIdx = p.ranked.findIndex((h) => goldSet.has(h.id))
      const legs0 = p.perVariant?.[0]?.raw ?? null
      rows.push({
        arm: armId, weight: weight ?? null, query_id: q.id, form: q.form, edge_type: q.edge_type ?? null,
        relation_required: q.relation_required ?? null, topic_df_low: q.topic_df_low ?? null,
        gold_total: goldFacts.length,
        ids: p.ids, pool_size: p.pool.length,
        gold_in_top1: p.ids.length ? (goldSet.has(p.ids[0]) ? 1 : 0) : null,
        gold_in_top3: p.ids.slice(0, 3).filter((x) => goldSet.has(x)).length,
        gold_in_pool: goldFacts.filter((x) => poolIds.has(x)).length,
        missing: goldFacts.some((x) => !p.ids.includes(x)),
        best_gold_rank: rankedGoldIdx === -1 ? null : rankedGoldIdx + 1,
        chars_returned: p.budgeted.reduce((n, h) => n + (h.text?.length ?? 0), 0),
        used_tokens: p.used_tokens,
        best_gold_chars: rankedGoldIdx === -1 ? null : (texts.get(p.ranked[rankedGoldIdx].id)?.length ?? null),
        candidates: legs0?.candidates?.length ?? null,
        anchors: legs0?.anchors?.length ?? null,
      })
    }
    return rows
  }

  const arms = [
    { id: 'A0', rt: armA0.rt, texts: armA0.texts, arm: null },
    { id: 'S1', rt: armS1.rt, texts: armS1.texts, arm: null },
    ...REL_W.map((w, i) => ({ id: `S2-w${w}`, rt: armS1.rt, texts: armS1.texts, arm: { appendLegs: relationLeg(w) }, weight: w, primary: i === 0 })),
  ]
  const allRows = []
  for (const a of arms) {
    allRows.push(...(await runArm(a.id, a.arm, a.rt, a.texts, a.weight)))
    console.log(`ran ${a.id}: ${queries.length} queries`)
  }

  // ── identity + default-unchanged ──────────────────────────────────────────────────────────────
  const identity = []
  for (let i = 0; i < queries.length; i += 25) {
    const q = queries[i]
    identity.push(await L.identityCheck(armS1.rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track: { texts: armS1.texts } }))
  }
  const identityFailures = identity.filter((r) => !r.ok)
  const noopArm = []
  for (let i = 0; i < queries.length; i += 25) {
    const q = queries[i]
    const plain = await L.runScript(armS1.rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track: { texts: armS1.texts }, arm: {} })
    const empty = await L.runScript(armS1.rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track: { texts: armS1.texts }, arm: { appendLegs: () => [] } })
    noopArm.push({ query_id: q.id, identical: JSON.stringify(plain.ids) === JSON.stringify(empty.ids) })
  }

  // ── summaries ─────────────────────────────────────────────────────────────────────────────────
  const summarize = (armId, filt) => {
    const rs = allRows.filter((r) => r.arm === armId).filter(filt ?? (() => true))
    const withGold = rs.filter((r) => r.gold_total > 0)
    const chars = withGold.filter((r) => r.gold_in_top1 === 1).map((r) => r.chars_returned)
    const goldChars = withGold.filter((r) => r.best_gold_chars !== null).map((r) => r.best_gold_chars)
    return {
      queries: rs.length,
      gold_total: withGold.reduce((n, r) => n + r.gold_total, 0),
      top1_queries: withGold.filter((r) => r.gold_in_top1 === 1).length,
      top1_rate: R.pct(withGold.filter((r) => r.gold_in_top1 === 1).length, withGold.length),
      top3_gold: withGold.reduce((n, r) => n + r.gold_in_top3, 0),
      top3_rate: R.pct(withGold.reduce((n, r) => n + r.gold_in_top3, 0), withGold.reduce((n, r) => n + r.gold_total, 0)),
      gold_in_pool: withGold.reduce((n, r) => n + r.gold_in_pool, 0),
      missing_queries: withGold.filter((r) => r.missing).length,
      mean_pool_size: R.mean(rs.map((r) => r.pool_size)),
      mean_chars_returned: R.mean(rs.map((r) => r.chars_returned)),
      mean_chars_returned_on_top1: R.mean(chars),
      mean_chars_of_best_gold: R.mean(goldChars),
      mean_entity_candidates: R.mean(rs.map((r) => r.candidates ?? 0)),
      mean_anchors: R.mean(rs.map((r) => r.anchors ?? 0)),
    }
  }

  const groupDefs = {
    per_atom: (r) => r.form === 'per_atom',
    per_atom_topic_df_le2: (r) => r.form === 'per_atom' && r.topic_df_low === true,
    cross_atom: (r) => r.form === 'cross_atom',
    cross_atom_relation_required: (r) => r.form === 'cross_atom' && r.relation_required === true,
    guard_like_single_topic: (r) => r.form === 'cross_atom' && r.relation_required === false,
  }
  const summary = {}
  for (const [g, filt] of Object.entries(groupDefs)) summary[g] = Object.fromEntries(arms.map((a) => [a.id, summarize(a.id, filt)]))

  // ── write-side cost + break-even (the decision number) ────────────────────────────────────────
  // "core" = what a real writing agent would have to emit per batch: the atom CONTENT only plus the
  // relation declarations. `source_sentence`/`self_contained`/`atom_id` are measurement keys and are
  // excluded, so the cost is not inflated by the harness's own bookkeeping.
  const serializedWrite = (f) => {
    const atoms = (atomsOf.get(f.id) ?? []).map((a) => ({ content: a.text }))
    const relations = (relsOf.get(f.id) ?? []).map((e) => ({ from: e.from, to: e.to, type: e.type }))
    return JSON.stringify({ facts: atoms, ...(relations.length ? { relations } : {}) }).length
  }
  const writeChars = corpus.facts.reduce((n, f) => n + serializedWrite(f), 0)
  const sourceChars = corpus.facts.reduce((n, f) => n + f.text.length, 0)
  const extraChars = writeChars - sourceChars
  const extraTokens = Math.round(extraChars * L.CJK_TOKENS_PER_CHAR)
  const perAtomChars = summary.per_atom
  const charsSavedPerRecall = (perAtomChars.A0.mean_chars_returned ?? 0) - (perAtomChars['S2-w0.15'].mean_chars_returned ?? perAtomChars.S1.mean_chars_returned ?? 0)
  const tokensSavedPerRecall = Math.round(Math.max(0, charsSavedPerRecall) * L.CJK_TOKENS_PER_CHAR)

  const out = {
    card: 'R5-S2',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: {
      checked: identity.length,
      passed: identity.length - identityFailures.length,
      failures: identityFailures.map((r, i) => ({ sample_index: i, ok: r.ok })),
      note: 'the script-side pass reproduces rt.recall on the ATOM corpus; sampling every 25th query (the full set is ~a few hundred and the assertion is per-orchestration, not per-query)',
    },
    design: {
      arms: arms.map((a) => a.id),
      arm_semantics: {
        A0: 'one long fact per source memory (status quo)',
        S1: 'the pass-A atoms, no relations',
        'S2-w*': 'the same atom DB plus ONE in-script relation leg at the stated weight (production weights 0.55/0.30/0.15 are NOT renormalized)',
      },
      relation_leg: 'query entities -> seed atoms carrying them -> their declared edge neighbours (contradicts excluded), each neighbour scored 1.0, leg scaled by its own max',
      production_weights: { semantic: 0.55, fts: 0.3, jaccard: 0.15 },
      guard: `query/gold shared 3-grams must have atom-corpus df >= ${MIN_DF3}`,
      query_forms: {
        per_atom: 'topic + 是什么/有哪些; gold = the atom (A0: its source fact)',
        cross_atom: 'topicA + topicB from a declared edge; gold = both atoms (A0: the source fact)',
      },
      relation_required_definition: 'neither atom of the edge carries the other atom\'s topic',
      source_facts: corpus.facts.length,
      atoms: allAtoms.length,
      queries: { per_atom: perAtom.length, cross_atom: crossAtom.length, relation_required: crossAtom.filter((q) => q.relation_required).length, total: queries.length, yield_per_100_atoms: R.pct(queries.length, allAtoms.length) },
    },
    corpora: {
      A0_rows: armA0.rows, A0_db_bytes: armA0.size,
      S1_rows: armS1.rows, S1_db_bytes: armS1.size,
      db_size_ratio: armA0.size && armS1.size ? L.round4(armS1.size / armA0.size) : null,
    },
    assertions: {
      identity_passed: identity.length - identityFailures.length,
      identity_checked: identity.length,
      appendLegs_noop_identical: noopArm.every((x) => x.identical),
      S1_equals_production_on_atom_corpus: identityFailures.length === 0,
      note: 'the relation leg exists only in the S2 arms; with no leg appended the script pass is byte-identical to production and to the no-op append',
    },
    summary,
    write_cost: {
      definition: 'serialized write payload = one per-fact batch call (facts:[{content}] + relations[]) versus the raw source text; the harness-only keys (atom_id/self_contained/source_sentence) are excluded',
      source_chars: sourceChars,
      write_chars: writeChars,
      extra_chars: extraChars,
      extra_chars_ratio: L.round4(writeChars / sourceChars),
      extra_tokens_cjk_1_per_char: extraTokens,
    },
    break_even: {
      chars_saved_per_recall: L.round4(charsSavedPerRecall),
      tokens_saved_per_recall: tokensSavedPerRecall,
      extra_write_tokens: extraTokens,
      recalls_to_break_even: tokensSavedPerRecall > 0 ? L.round4(extraTokens / tokensSavedPerRecall) : null,
      inputs: {
        A0_mean_chars_returned: perAtomChars.A0.mean_chars_returned,
        S1_mean_chars_returned: perAtomChars.S1.mean_chars_returned,
        S2_mean_chars_returned: perAtomChars['S2-w0.15'].mean_chars_returned,
      },
      note: 'only the ATOMIZED write cost is counted as extra; the relation-declaration characters are included, so the break-even is the upper bound of "relations + splitting pay off"',
    },
    rows: allRows,
    reproduction: 'node mem/scripts/spikes/bench-r5-2-quality.mjs --json mem/docs/spikes/raw/round5-s2-quality.json',
  }
  const whitelist = R.repoCjkWhitelist()
  out.privacy = R.auditArtifact(out, { cjkWhitelist: whitelist })
  if (!out.privacy.clean) {
    console.error('PRIVACY AUDIT FAILED', JSON.stringify(out.privacy).slice(0, 3000))
    process.exitCode = 1
  }
  L.writeJson(jsonOut, out)
  for (const g of Object.keys(groupDefs)) {
    console.log(g, JSON.stringify(Object.fromEntries(arms.map((a) => {
      const s = summary[g][a.id]
      return [a.id, `${s.top1_queries}/${s.queries} top3=${s.top3_gold}/${s.gold_total} pool=${s.gold_in_pool} miss=${s.missing_queries} chars=${s.mean_chars_returned}`]
    }))))
  }
  console.log('break_even:', JSON.stringify(out.break_even))
  L.teardown(track)
}

main()
