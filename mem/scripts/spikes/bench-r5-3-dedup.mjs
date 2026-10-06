/**
 * R5-S3 · does the write SHAPE change what dedup and contradiction detection can see?
 *
 * THE MECHANISM (production, imported not re-implemented): `content` is `TEXT NOT NULL UNIQUE`, so
 * exact duplicates are caught for any shape; everything else goes through
 * `detectContradictionEmbedding`, which scores a pair only when BOTH sides carry >= 2 entities,
 * entity overlap >= 0.5, and cosine similarity in `[0.75, 0.97]` — `sim > 0.97` is read as a
 * near-duplicate (score 0, i.e. suppressed), `sim < 0.75` as unrelated. A paraphrase of the same
 * memory should land in the near-duplicate band or above; a NEGATED assertion should land in
 * `[0.75, 0.97]` and be reported. Both bands are measured for the long-段 shape and the atom shape.
 *
 * THE PROBES (model-written, once per sampled fact, from the model that did the splitting):
 *   paraphrase_long  a synonymous rewrite of the whole source fact
 *   paraphrase_atom  a synonymous rewrite of the fact's anchor atom (its longest atom)
 *   negation_atom    one sentence that denies what the anchor atom asserts
 *   emit with `--emit-probes`; the judging pass writes `/tmp/dsh-r5/s3-probes.json`.
 *
 * TWO LAYERS ARE REPORTED, because they can disagree:
 *   1. the threshold layer — cosine + entity overlap + the production score function;
 *   2. the WRITE PATH — `rt.remember` on a temp copy, recording `is_new` (content-UNIQUE hit) and
 *      the `contradictions` the write itself reports.
 *
 * Usage: node mem/scripts/spikes/bench-r5-3-dedup.mjs [--json <path>] [--sample 23]
 *        node mem/scripts/spikes/bench-r5-3-dedup.mjs --emit-probes
 * PRIVACY: probe texts stay in `/tmp/dsh-r5/s3-probe*.json`; the repo artifact is counts, sims,
 * overlaps and ratios.
 */
import { join } from 'node:path'
import * as R from './bench-r5-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round5-s3-dedup.json'))
const SAMPLE = Number(L.arg('sample', 23))
const EMIT = L.hasFlag('emit-probes')

const { extractEntities, tagText, entitiesFromTokens, triplesFromTokens } = await import(L.lib('core/lib/entities/extract.js'))
const { detectContradictionEmbedding } = await import(L.lib('core/lib/lifecycle/contradiction.js'))
const { normalizeWrite, normalizeWrites } = await import(L.lib('core/lib/store/common.js'))

const cosine = (a, b) => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : Math.max(-1, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))))
}
const overlap = (a, b) => {
  const A = new Set(a)
  const B = new Set(b)
  const union = new Set([...A, ...B])
  if (union.size === 0) return 0
  return [...A].filter((x) => B.has(x)).length / union.size
}
const namesOf = async (t) => [...new Set((await extractEntities(t)).map((e) => R.normName(e.name)))]
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)
const band = (sim) => (sim >= 0.97 ? 'near_dup_ge_0.97' : sim >= 0.75 ? 'contradiction_band_0.75_0.97' : 'below_0.75')

async function main() {
  const corpus = R.readTmp('corpus.json')
  const split = R.readTmp('split-a.json')
  const atomsOf = new Map(split.facts.map((f) => [f.id, f.atoms ?? []]))
  const step = Math.max(1, Math.floor(corpus.facts.length / SAMPLE))
  const sample = corpus.facts.filter((_, i) => i % step === 0).slice(0, SAMPLE)

  if (EMIT) {
    const probeInput = {
      generated_at: new Date().toISOString(),
      instruction: 'for each fact write paraphrase_long / paraphrase_atom / negation_atom (see the round-5 prompt)',
      facts: sample.map((f) => {
        const list = atomsOf.get(f.id) ?? []
        const anchor = [...list].sort((a, b) => b.text.length - a.text.length)[0]
        return {
          id: f.id,
          original_text: f.text,
          anchor_atom_id: anchor?.atom_id ?? null,
          anchor_atom_text: anchor?.text ?? null,
          siblings: list.map((a) => ({ atom_id: a.atom_id, text: a.text })),
        }
      }),
    }
    R.writeTmp('s3-probe-input.json', probeInput)
    console.log(`probe input: ${probeInput.facts.length} facts -> ${R.tmpPath('s3-probe-input.json')}`)
    return
  }

  let probes
  try {
    probes = R.readTmp('s3-probes.json')
  } catch {
    console.error('round5: /tmp/dsh-r5/s3-probes.json missing — run with --emit-probes and the judging pass first')
    process.exitCode = 1
    return
  }
  const probeById = new Map((probes.facts ?? []).map((f) => [f.id, f]))
  L.banner('R5-S3 · dedup + contradiction detectability by write shape', { sample: sample.length, probes: probeById.size })

  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r53-'))
  track.dirs.push(work)
  const rerankRuntime = R.newRuntime({ snapPath: join(work, 'scratch.db'), semantic: emb, track })

  const encode = (t) => emb.encode(t)
  const rows = []
  const atomVec = new Map()
  const negVec = new Map()
  for (const f of sample) {
    const p = probeById.get(f.id)
    const list = atomsOf.get(f.id) ?? []
    const anchor = [...list].sort((a, b) => b.text.length - a.text.length)[0]
    if (!p || !anchor) continue
    const [eLong, eParLong, eAtom, eParAtom, eNeg] = await Promise.all([
      encode(f.text), encode(p.paraphrase_long), encode(anchor.text), encode(p.paraphrase_atom), encode(p.negation_atom),
    ])
    atomVec.set(f.id, eAtom)
    negVec.set(f.id, eNeg)
    const [nLong, nParLong, nAtom, nParAtom, nNeg] = await Promise.all([
      namesOf(f.text), namesOf(p.paraphrase_long), namesOf(anchor.text), namesOf(p.paraphrase_atom), namesOf(p.negation_atom),
    ])
    const pair = (va, vb, na, nb) => {
      const sim = cosine(va, vb)
      const ov = overlap(na, nb)
      const score = detectContradictionEmbedding(na, nb, va, vb)
      return { sim: L.round4(sim), overlap: L.round4(ov), score: L.round4(score), band: band(sim), min_entities_ok: Math.min(na.length, nb.length) >= 2 }
    }
    // controls: the same paraphrase against a SIBLING atom is handled at the write layer; the
    // threshold layer's far control is NEGATION_i vs ANCHOR_j across facts (see `counterexamples`)
    rows.push({
      fact_id: f.id,
      anchor_atom_id: anchor.atom_id,
      atoms: list.length,
      long_vs_paraphrase_long: pair(eLong, eParLong, nLong, nParLong),
      atom_vs_paraphrase_atom: pair(eAtom, eParAtom, nAtom, nParAtom),
      cross_long_vs_paraphrase_atom: pair(eLong, eParAtom, nLong, nParAtom),
      cross_atom_vs_paraphrase_long: pair(eAtom, eParLong, nAtom, nParLong),
      atom_vs_negation: pair(eAtom, eNeg, nAtom, nNeg),
      long_vs_negation: pair(eLong, eNeg, nLong, nNeg),
      exact_duplicate_control: pair(eAtom, eAtom, nAtom, nAtom),
    })
  }

  // ── the write-path layer, on temp copies ──────────────────────────────────────────────────────
  const dbLayer = async (shape) => {
    const dir = join(work, shape)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const rt = R.newRuntime({ snapPath: join(dir, 'memory.db'), semantic: emb, track })
    const ids = new Map()
    const addOne = async (text) => {
      const res = await rt.remember({ action: 'add', content: text })
      return { fact_id: res.fact_id, is_new: res.is_new, contradictions: (res.contradictions ?? []).length }
    }
    if (shape === 'long') {
      for (const f of sample) ids.set(f.id, await addOne(f.text))
    } else {
      for (const f of sample) {
        const list = atomsOf.get(f.id) ?? []
        for (const a of list) await addOne(a.text)
      }
    }
    // PHASED, deliberately: if the control adds were interleaved, a later control would re-add an
    // earlier probe verbatim, `add` would take its silent-duplicate branch (no detection at all),
    // and the detected-count would be an artifact of loop order instead of the thresholds.
    const result = { paraphrase: [], negation: [], cross_negation: [], exact_dup: [] }
    const anchorOf = (f) => [...(atomsOf.get(f.id) ?? [])].sort((a, b) => b.text.length - a.text.length)[0]
    for (const f of sample) {
      const p = probeById.get(f.id)
      if (!p) continue
      result.paraphrase.push(await addOne(shape === 'long' ? p.paraphrase_long : p.paraphrase_atom))
    }
    for (const f of sample) {
      const p = probeById.get(f.id)
      if (!p) continue
      result.negation.push({ ...(await addOne(p.negation_atom)), fact_id: f.id })
    }
    for (let i = 0; i < sample.length; i += 1) {
      const f = sample[i]
      const far = probeById.get(sample[(i + 3) % sample.length].id)
      // The control text must be NEW to THIS DB and about an unrelated fact: use the OTHER
      // shape's paraphrase (the long DB never holds atom paraphrases and vice versa), so a hit
      // here is a genuine false positive and not the content-UNIQUE no-op branch.
      if (far) result.cross_negation.push({ ...(await addOne(shape === 'long' ? far.paraphrase_atom : far.paraphrase_long)), fact_id: f.id })
    }
    for (const f of sample) {
      const anchor = anchorOf(f)
      if (!anchor) continue
      result.exact_dup.push(await addOne(shape === 'long' ? f.text : anchor.text))
    }
    return result
  }
  const longLayer = await dbLayer('long')
  const atomLayer = await dbLayer('atom')

  const summarizePair = (rs, key) => {
    const list = rs.map((r) => r[key])
    const withGold = list.filter((p) => p !== undefined)
    return {
      n: withGold.length,
      median_sim: median(withGold.map((p) => p.sim)),
      median_overlap: median(withGold.map((p) => p.overlap)),
      median_score: median(withGold.map((p) => p.score)),
      near_dup_ge_097: withGold.filter((p) => p.band === 'near_dup_ge_0.97').length,
      contradiction_band: withGold.filter((p) => p.band === 'contradiction_band_0.75_0.97').length,
      below_075: withGold.filter((p) => p.band === 'below_0.75').length,
      detected_by_production_score: withGold.filter((p) => p.score > 0).length,
    }
  }
  const wp = (list) => ({
    n: list.length,
    new_rows: list.filter((x) => x.is_new).length,
    content_unique_hits: list.filter((x) => !x.is_new).length,
    contradictions_reported: list.filter((x) => x.contradictions > 0).length,
  })

  const out = {
    card: 'R5-S3',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'threshold card + write-path card; the write path is graded by rt.remember itself, the S2 card carries the identity assertion' },
    design: {
      sample_facts: sample.length,
      anchor_rule: 'the longest atom of the source fact (pass A)',
      thresholds: { EMBED_SIM_MIN: 0.75, EMBED_SIM_DUP_MAX: 0.97, EMBED_OVERLAP_MIN: 0.5, EMBED_MIN_ENTITIES: 2 },
      bands: { near_dup_ge_097: 'sim >= 0.97 -> production reads it as a near-duplicate (contradiction score 0)', contradiction_band: '0.75 <= sim < 0.97 AND overlap >= 0.5 AND both sides >= 2 entities -> reported', below_075: 'invisible to the embedding leg' },
      probes: ['paraphrase_long', 'paraphrase_atom', 'negation_atom'],
    },
    threshold_layer: {
      long_vs_paraphrase_long: summarizePair(rows, 'long_vs_paraphrase_long'),
      atom_vs_paraphrase_atom: summarizePair(rows, 'atom_vs_paraphrase_atom'),
      cross_long_vs_paraphrase_atom: summarizePair(rows, 'cross_long_vs_paraphrase_atom'),
      cross_atom_vs_paraphrase_long: summarizePair(rows, 'cross_atom_vs_paraphrase_long'),
      atom_vs_negation: summarizePair(rows, 'atom_vs_negation'),
      long_vs_negation: summarizePair(rows, 'long_vs_negation'),
      exact_duplicate_control: summarizePair(rows, 'exact_duplicate_control'),
    },
    write_path: {
      long: { paraphrase: wp(longLayer.paraphrase), negation: wp(longLayer.negation), cross_negation_false_positive: wp(longLayer.cross_negation), exact_dup: wp(longLayer.exact_dup) },
      atom: { paraphrase: wp(atomLayer.paraphrase), negation: wp(atomLayer.negation), cross_negation_false_positive: wp(atomLayer.cross_negation), exact_dup: wp(atomLayer.exact_dup) },
      note: 'long/atom are separate temp DBs; probes are added in phases (paraphrases, then negations, then the cross-fact control) so no control re-adds an earlier probe verbatim; `cross_negation_false_positive` adds the OTHER shape\'s paraphrase of an unrelated fact — new text that must NOT be reported',
    },
    counterexamples: {
      unrelated_pair_threshold_layer: (() => {
        // NEGATION of fact j against the ANCHOR of fact i, measured on the vectors themselves
        // (the end-to-end answer is `write_path.*.cross_negation_false_positive`).
        const ids = rows.map((r) => r.fact_id)
        const vals = []
        for (let i = 0; i < ids.length; i += 1) {
          const j = ids[(i + 3) % ids.length]
          if (j === ids[i]) continue
          vals.push(cosine(atomVec.get(ids[i]), negVec.get(j)))
        }
        return { n: vals.length, median_sim: L.round4(median(vals)), share_ge_075: R.pct(vals.filter((v) => v >= 0.75).length, vals.length) }
      })(),
      exact_duplicate_control: summarizePair(rows, 'exact_duplicate_control'),
      note: 'unrelated_pair_threshold_layer = NEGATION_j vs ANCHOR_i across different facts (sim only; the entity-overlap gate is applied in write_path.cross_negation_false_positive); a high share_ge_075 bounds how generic the embedding band is',
    },
    rows,
    reproduction: 'node mem/scripts/spikes/bench-r5-3-dedup.mjs --json mem/docs/spikes/raw/round5-s3-dedup.json',
  }
  const whitelist = R.repoCjkWhitelist()
  out.privacy = R.auditArtifact(out, { cjkWhitelist: whitelist })
  if (!out.privacy.clean) {
    console.error('PRIVACY AUDIT FAILED', JSON.stringify(out.privacy).slice(0, 3000))
    process.exitCode = 1
  }
  L.writeJson(jsonOut, out)
  console.log('threshold:', JSON.stringify(out.threshold_layer))
  console.log('write_path:', JSON.stringify(out.write_path))
  L.teardown(track)
}

main()
