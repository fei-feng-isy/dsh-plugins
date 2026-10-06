/**
 * R5-S1(b) + S4 + S6(partial) · what the two independent splits actually contain.
 *
 * THE TWO REVIEWER RISKS THIS CARD EXISTS FOR (brief §2/§4/§7):
 *   1. **Consistency.** Round 4 measured write-side field agreement across independent processes
 *      at "at least one field differs = 48.44%". Splitting is a harder write: the same paragraph
 *      can come back as 2 atoms or as 5, with different boundaries. So the numbers are reported on
 *      TWO axes at once — the **edge set** (overlap + per-edge type agreement, after a
 *      deterministic atom alignment) and the **count/boundary** axis (atom-count difference and
 *      how much of pass A's boundary structure pass B reproduces).
 *   2. **Whether a relation layer would even be needed.** For every declared edge, the card asks
 *      the engine's own extractor whether the two atoms share an entity name and/or a parseable
 *      time expression. An edge whose endpoints already share an entity is one the engine can
 *      DERIVE (shared-entity adjacency); an edge that is not derivable is one only the writer can
 *      supply. That split is what turns "relations are inconsistent" into "and here is what that
 *      costs".
 *
 * It also emits the over-split audit SAMPLE (`/tmp/dsh-r5/oversplit-sample.json`); a separate
 * judging pass writes `oversplit-audit.json`, which this card folds in if it exists. The sample and
 * the audit are content-derived, so both live in `/tmp`.
 *
 * Usage: node mem/scripts/spikes/bench-r5-1-splits.mjs [--json <path>]
 * PRIVACY: repo artifact = ids, counts, ratios, lengths. Text never leaves `/tmp`.
 */
import { join } from 'node:path'
import * as R from './bench-r5-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round5-s1-splits.json'))
const SAMPLE_N = Number(L.arg('sample', 25))
const MATCH_MIN = Number(L.arg('match', 0.35))

const { extractEntities } = await import(L.lib('core/lib/entities/extract.js'))

// ─── text-shape helpers (all deterministic; no text is ever emitted) ─────────────────────────────
const PRONOUNS = ['它们', '它', '他们', '她们', '该', '此', '上述', '前述', '前者', '后者', '后者', '其', '同上', '本项', '该项', '这项', '那里', '这里']
const PRONOUN_RE = new RegExp(PRONOUNS.join('|'), 'g')

function trigrams(s) {
  const out = new Set()
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3))
  return out
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter += 1
  return inter / (a.size + b.size - inter)
}
/** Pronoun/demonstrative tokens that appear WITHOUT a named subject in the same atom. */
function pronounHits(text) {
  const m = text.match(PRONOUN_RE)
  return m ? [...new Set(m)] : []
}
/** Greedy one-to-one alignment by 3-gram Jaccard, best pair first. */
function align(atomsA, atomsB) {
  const gramsA = atomsA.map((a) => trigrams(a.text))
  const gramsB = atomsB.map((b) => trigrams(b.text))
  const pairs = []
  for (let i = 0; i < atomsA.length; i += 1) {
    for (let j = 0; j < atomsB.length; j += 1) {
      const s = jaccard(gramsA[i], gramsB[j])
      if (s >= MATCH_MIN) pairs.push({ i, j, s })
    }
  }
  pairs.sort((x, y) => y.s - x.s || x.i - y.i || x.j - y.j)
  const usedA = new Set()
  const usedB = new Set()
  const map = new Map()
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue
    usedA.add(p.i)
    usedB.add(p.j)
    map.set(p.i, { j: p.j, sim: L.round4(p.s) })
  }
  return map
}
const undirected = (e) => (e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`)

function passStats(split, corpusById, meta) {
  const perFact = []
  let atoms = 0
  let atomChars = 0
  let sourceChars = 0
  let verbatimSource = 0
  let selfFalse = 0
  let pronounAtom = 0
  let singleAtomFacts = 0
  const atomLens = []
  const perFactAtoms = new Map()
  for (const f of split.facts ?? []) {
    const srcText = corpusById.get(f.id)?.text ?? ''
    sourceChars += srcText.length
    const list = f.atoms ?? []
    perFactAtoms.set(f.id, list)
    atoms += list.length
    if (list.length === 1) singleAtomFacts += 1
    for (const a of list) {
      atomChars += a.text.length
      atomLens.push(a.text.length)
      if (typeof a.source_sentence === 'string' && a.source_sentence.length >= 4 && srcText.includes(a.source_sentence)) verbatimSource += 1
      if (a.self_contained === false) selfFalse += 1
      if (pronounHits(a.text).length > 0) pronounAtom += 1
    }
    perFact.push({ id: f.id, atoms: list.length, edges: (f.relations ?? []).length, atom_chars: list.reduce((n, a) => n + a.text.length, 0), source_chars: srcText.length })
  }
  return { perFact, perFactAtoms, atoms, atomChars, sourceChars, verbatimSource, selfFalse, pronounAtom, singleAtomFacts, atomLens, meta }
}

function edgeStats(split, perFactAtoms) {
  const byType = {}
  const edges = []
  let atomsWithEdge = new Set()
  for (const f of split.facts ?? []) {
    for (const e of f.relations ?? []) {
      byType[e.type] = (byType[e.type] ?? 0) + 1
      edges.push({ id: f.id, ...e })
      atomsWithEdge.add(e.from)
      atomsWithEdge.add(e.to)
    }
  }
  return { byType, edges, atoms_with_edge: atomsWithEdge.size }
}

async function derivability(edges, perFactAtoms, corpusById) {
  const out = { shared_entity: 0, shared_time: 0, both: 0, neither: 0, by_type: {}, entity_cache: new Map() }
  const namesOf = async (atom) => {
    if (out.entity_cache.has(atom.atom_id)) return out.entity_cache.get(atom.atom_id)
    let names = []
    try {
      names = (await extractEntities(atom.text)).map((e) => R.normName(e.name))
    } catch {
      names = []
    }
    out.entity_cache.set(atom.atom_id, names)
    return names
  }
  for (const e of edges) {
    const atoms = perFactAtoms.get(e.id) ?? []
    const a = atoms.find((x) => x.atom_id === e.from)
    const b = atoms.find((x) => x.atom_id === e.to)
    const bucket = (out.by_type[e.type] ??= { edges: 0, shared_entity: 0, shared_time: 0, both: 0, neither: 0 })
    bucket.edges += 1
    if (!a || !b) continue
    const na = new Set(await namesOf(a))
    const nb = await namesOf(b)
    const sharedEnt = nb.some((n) => na.has(n))
    const ta = R.allTimeExpressions(a.text)
    const tb = R.allTimeExpressions(b.text)
    const sharedTime = ta.length > 0 && tb.length > 0 && ta.some((x) => tb.some((y) => x.matched === y.matched))
    if (sharedEnt && sharedTime) { out.both += 1; bucket.both += 1 }
    else if (sharedEnt) { out.shared_entity += 1; bucket.shared_entity += 1 }
    else if (sharedTime) { out.shared_time += 1; bucket.shared_time += 1 }
    else { out.neither += 1; bucket.neither += 1 }
  }
  delete out.entity_cache
  return out
}

function loadAudit() {
  try {
    return R.readTmp('oversplit-audit.json')
  } catch {
    return null
  }
}

async function main() {
  const corpus = R.readTmp('corpus.json')
  const meta = R.readTmp('corpus-meta.json')
  const corpusById = new Map(corpus.facts.map((f) => [f.id, f]))
  const corpusIds = new Set(corpusById.keys())
  L.banner('R5-S1b/S4 · split statistics, consistency, relation derivability', { corpus_facts: corpus.facts.length })

  const a = R.readTmp('split-a.json')
  const b = R.readTmp('split-b.json')
  const va = R.validateSplit(a, corpusIds)
  const vb = R.validateSplit(b, corpusIds)
  console.log(`split A: ${va.stats.atoms} atoms, ${va.stats.edges} edges, valid=${va.ok}; split B: ${vb.stats.atoms} atoms, ${vb.stats.edges} edges, valid=${vb.ok}`)

  const sa = passStats(a, corpusById, va.stats)
  const sb = passStats(b, corpusById, vb.stats)
  const ea = edgeStats(a, sa.perFactAtoms)
  const eb = edgeStats(b, sb.perFactAtoms)
  const deriv = await derivability(ea.edges, sa.perFactAtoms, corpusById)

  // ── S4 consistency: count/boundary + edge set ─────────────────────────────────────────────────
  let countEqual = 0
  let countDiffer = 0
  const relDiffs = []
  let matchedA = 0
  let matchedB = 0
  let edgeBothEndpointsMatched = 0
  let edgeOverlap = 0
  let edgeTypeAgree = 0
  let edgeOverlapReverseDen = 0
  let edgeOverlapReverse = 0
  const perFactAlign = []
  for (const f of corpus.facts) {
    const la = sa.perFactAtoms.get(f.id) ?? []
    const lb = sb.perFactAtoms.get(f.id) ?? []
    if (la.length === lb.length) countEqual += 1
    else countDiffer += 1
    relDiffs.push(Math.abs(la.length - lb.length) / Math.max(1, la.length, lb.length))
    const map = align(la, lb)
    matchedA += map.size
    matchedB += map.size
    const aEdges = (a.facts.find((x) => x.id === f.id)?.relations ?? [])
    const bEdgeKeys = new Set((b.facts.find((x) => x.id === f.id)?.relations ?? []).map(undirected))
    const bTypeByKey = new Map((b.facts.find((x) => x.id === f.id)?.relations ?? []).map((e) => [undirected(e), e.type]))
    let matchedEdges = 0
    let overlap = 0
    let typeAgree = 0
    for (const e of aEdges) {
      const i = la.findIndex((x) => x.atom_id === e.from)
      const j = la.findIndex((x) => x.atom_id === e.to)
      if (i < 0 || j < 0) continue
      const mi = map.get(i)
      const mj = map.get(j)
      if (!mi || !mj) continue
      matchedEdges += 1
      const key = undirected({ from: lb[mi.j].atom_id, to: lb[mj.j].atom_id })
      if (bEdgeKeys.has(key)) {
        overlap += 1
        if (bTypeByKey.get(key) === e.type) typeAgree += 1
      }
    }
    edgeBothEndpointsMatched += matchedEdges
    edgeOverlap += overlap
    edgeTypeAgree += typeAgree
    // reverse direction: B edges whose both endpoints are matched into A
    const mapInv = new Map([...map.entries()].map(([i, v]) => [v.j, i]))
    const aEdgeKeys = new Set(aEdges.map(undirected))
    for (const e of b.facts.find((x) => x.id === f.id)?.relations ?? []) {
      const i = lb.findIndex((x) => x.atom_id === e.from)
      const j = lb.findIndex((x) => x.atom_id === e.to)
      if (i < 0 || j < 0) continue
      const mi = mapInv.get(i)
      const mj = mapInv.get(j)
      if (mi === undefined || mj === undefined) continue
      edgeOverlapReverseDen += 1
      if (aEdgeKeys.has(undirected({ from: la[mi].atom_id, to: la[mj].atom_id }))) edgeOverlapReverse += 1
    }
    perFactAlign.push({ id: f.id, atoms_a: la.length, atoms_b: lb.length, matched: map.size })
  }

  // ── S6 failure modes (the numeric ones) ───────────────────────────────────────────────────────
  const atomLensA = sa.atomLens
  const inflationA = (meta.all_active_ids.length - corpus.facts.length) + sa.atoms
  const inflationB = (meta.all_active_ids.length - corpus.facts.length) + sb.atoms
  const orphanOnlyChild = (() => {
    // A fact whose atoms are all but one removed leaves that atom as the sole survivor; the share of
    // atoms that WOULD be the sole survivor under an "all siblings archived" purge.
    let sole = 0
    for (const f of corpus.facts) if ((sa.perFactAtoms.get(f.id) ?? []).length === 1) sole += 1
    return { facts_with_single_atom: sole, share: R.pct(sole, corpus.facts.length) }
  })()

  // ── over-split audit sample (25 atoms, stratified over facts) ─────────────────────────────────
  const sample = []
  const step = Math.max(1, Math.floor(corpus.facts.length / SAMPLE_N))
  for (let k = 0; k < corpus.facts.length && sample.length < SAMPLE_N; k += step) {
    const f = corpus.facts[k]
    const la = sa.perFactAtoms.get(f.id) ?? []
    if (la.length === 0) continue
    const pick = la[k % la.length]
    sample.push({ atom_id: pick.atom_id, fact_id: f.id, atom_text: pick.text, original_text: f.text })
  }
  R.writeTmp('oversplit-sample.json', { generated_at: new Date().toISOString(), n: sample.length, atoms: sample })
  const audit = loadAudit()

  const out = {
    card: 'R5-S1b/S4/S6a',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'split-statistics card — no retrieval pass; the S2 card identity-checks the passes it runs' },
    validation: {
      split_a_ok: va.ok,
      split_b_ok: vb.ok,
      split_a_problems: va.problems,
      split_b_problems: vb.problems,
      problem_kinds_a: [...new Set(va.problems.map((p) => p.kind))],
      problem_kinds_b: [...new Set(vb.problems.map((p) => p.kind))],
    },
    yield: {
      split_a: {
        atoms: sa.atoms, edges: ea.edges.length, facts_with_single_atom: sa.singleAtomFacts,
        atoms_per_fact: { min: Math.min(...sa.perFact.map((p) => p.atoms)), median: R.median(sa.perFact.map((p) => p.atoms)), max: Math.max(...sa.perFact.map((p) => p.atoms)), mean: R.mean(sa.perFact.map((p) => p.atoms)) },
        atom_len: { min: Math.min(...atomLensA), median: R.median(atomLensA), max: Math.max(...atomLensA), mean: R.mean(atomLensA) },
        source_chars: sa.sourceChars, atom_chars: sa.atomChars,
        atom_char_ratio: L.round4(sa.atomChars / sa.sourceChars),
        atoms_with_edge: ea.atoms_with_edge,
        edges_per_atom: L.round4(ea.edges.length / sa.atoms),
        relation_types: ea.byType,
        source_sentence_verbatim: sa.verbatimSource, source_sentence_verbatim_share: R.pct(sa.verbatimSource, sa.atoms),
      },
      split_b: {
        atoms: sb.atoms, edges: eb.edges.length, facts_with_single_atom: sb.singleAtomFacts,
        atoms_per_fact: { min: Math.min(...sb.perFact.map((p) => p.atoms)), median: R.median(sb.perFact.map((p) => p.atoms)), max: Math.max(...sb.perFact.map((p) => p.atoms)), mean: R.mean(sb.perFact.map((p) => p.atoms)) },
        atom_len: { min: Math.min(...sb.atomLens), median: R.median(sb.atomLens), max: Math.max(...sb.atomLens), mean: R.mean(sb.atomLens) },
        source_chars: sb.sourceChars, atom_chars: sb.atomChars,
        atom_char_ratio: L.round4(sb.atomChars / sb.sourceChars),
        atoms_with_edge: eb.atoms_with_edge,
        edges_per_atom: L.round4(eb.edges.length / sb.atoms),
        relation_types: eb.byType,
        source_sentence_verbatim: sb.verbatimSource, source_sentence_verbatim_share: R.pct(sb.verbatimSource, sb.atoms),
      },
    },
    consistency: {
      alignment_rule: `greedy one-to-one on 3-gram Jaccard >= ${MATCH_MIN}`,
      count_equal_facts: countEqual,
      count_differ_facts: countDiffer,
      count_diff_rate: R.pct(countDiffer, countEqual + countDiffer),
      mean_relative_count_diff: R.mean(relDiffs),
      atom_match_rate_a: R.pct(matchedA, sa.atoms),
      atom_match_rate_b: R.pct(matchedB, sb.atoms),
      edge_overlap_rate_a: R.pct(edgeOverlap, edgeBothEndpointsMatched),
      edge_overlap_rate_b: R.pct(edgeOverlapReverse, edgeOverlapReverseDen),
      edges_compared_a: edgeBothEndpointsMatched,
      edges_compared_b: edgeOverlapReverseDen,
      edge_type_agreement_rate: R.pct(edgeTypeAgree, edgeOverlap),
    },
    relation_derivability: {
      rule: 'an edge is engine-derivable when the two atoms share an engine-extracted entity name (shared_entity) and/or the same parseable time expression (shared_time)',
      totals: { edges: ea.edges.length, shared_entity: deriv.shared_entity, shared_time: deriv.shared_time, both: deriv.both, neither: deriv.neither },
      derivable_share: R.pct(deriv.shared_entity + deriv.shared_time + deriv.both, ea.edges.length),
      non_derivable_share: R.pct(deriv.neither, ea.edges.length),
      by_type: deriv.by_type,
    },
    failure_modes: {
      self_containment_loss_selfreported: { atoms: sa.selfFalse, share: R.pct(sa.selfFalse, sa.atoms) },
      self_containment_loss_heuristic: {
        rule: `atom contains one of ${PRONOUNS.length} demonstrative/pronoun tokens`,
        atoms: sa.pronounAtom, share: R.pct(sa.pronounAtom, sa.atoms),
      },
      row_inflation: {
        active_before: meta.all_active_ids.length,
        selected_rewritten: corpus.facts.length,
        atoms_a: sa.atoms, rows_after_a: inflationA, row_factor_a: L.round4(inflationA / meta.all_active_ids.length),
        atoms_b: sb.atoms, rows_after_b: inflationB, row_factor_b: L.round4(inflationB / meta.all_active_ids.length),
      },
      orphan_atoms: {
        ...orphanOnlyChild,
        note: 'an atom whose siblings are all archived becomes the sole survivor of its source fact; measured as the share of facts split into exactly one atom (no sibling to lose)',
      },
      over_split_audit: audit
        ? {
            judged: (audit.judged ?? []).length,
            verdicts: (audit.judged ?? []).reduce((acc, j) => { acc[j.verdict] = (acc[j.verdict] ?? 0) + 1; return acc }, {}),
            drifted_share: R.pct((audit.judged ?? []).filter((j) => j.verdict !== 'faithful').length, (audit.judged ?? []).length),
            judged_self_containment_false: (audit.judged ?? []).filter((j) => j.self_contained === false).length,
            judged_self_containment_false_share: R.pct((audit.judged ?? []).filter((j) => j.self_contained === false).length, (audit.judged ?? []).length),
          }
        : { pending: true, note: 'run the judging pass into /tmp/dsh-r5/oversplit-audit.json and re-run this card', sample_path: R.tmpPath('oversplit-sample.json'), sample_n: sample.length },
    },
    derived_inputs: { split_a: R.tmpPath('split-a.json'), split_b: R.tmpPath('split-b.json'), over_split_sample: R.tmpPath('oversplit-sample.json') },
    reproduction: 'node mem/scripts/spikes/bench-r5-1-splits.mjs --json mem/docs/spikes/raw/round5-s1-splits.json',
  }
  const whitelist = R.repoCjkWhitelist()
  out.privacy = R.auditArtifact(out, { cjkWhitelist: whitelist })
  if (!out.privacy.clean) {
    console.error('PRIVACY AUDIT FAILED', JSON.stringify(out.privacy).slice(0, 3000))
    process.exitCode = 1
  }
  L.writeJson(jsonOut, out)
  console.log('yield A:', JSON.stringify(out.yield.split_a.atoms_per_fact), 'atoms', sa.atoms, 'edges', ea.edges.length)
  console.log('consistency:', JSON.stringify(out.consistency))
  console.log('derivability:', JSON.stringify(out.relation_derivability.totals), out.relation_derivability.derivable_share)
}

main()
