/**
 * R2-7 · L3 long-fact chunking PILOT — the only item that could change an order of magnitude.
 *
 * THE IDEA. A fact longer than the embedding window (production truncates at `N`) is represented by
 * one vector that averages/misses its parts. Split it into K <= 3 chunks, encode each, and let the
 * best chunk speak for the fact. The named downside: a chunk of a long note can out-score a short
 * fact that actually answers the question, so the LONG NOTE's rank position must not get worse.
 *
 * WHAT THIS PILOT REALLY IS, AND IS NOT. It uses the PRODUCTION embedding backend already in the
 * local cache (`bge-base-zh-v1.5`; `autoDownload: false` — nothing is downloaded) and the fact
 * vectors already stored in the snapshot. It does NOT build a second vector store and it does NOT
 * write to any database: ranks are recomputed from raw cosines. `buildRuntime` cost is therefore
 * reported as an ENCODE-cost proxy, labelled as such, not as a measured index build.
 *
 * RULES. `chunk_max` = max over the K chunk cosines (whole-fact vector for short facts);
 * `chunk_capped` = min(chunk_max, whole-fact cosine) — the "may not exceed the fact's own score"
 * aggregation, which by construction can only lower.
 *
 * VERDICT RULE (brief): top-3 rises AND the long-note position does not get worse => adopt; else
 * reject. N in {512, 128}.
 *
 * Usage: node mem/scripts/spikes/bench-r2-7-chunking-pilot.mjs [--json <path>]
 * PRIVACY: ids / lengths / ranks / timings only — no fact text is written. Chunk text is derived
 * in memory solely to encode it.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round2-r2-7-chunking-pilot.json'))
const LIMIT = 5
const MAX_K = 3

const blobToVec = (b) => {
  const f = new Float32Array(b.byteLength / 4)
  new Uint8Array(f.buffer).set(b)
  return f
}
const cosine = (a, b) => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
/** K contiguous, near-equal chunks; K = min(3, ceil(len / N)). */
function chunkText(text, n) {
  const len = text.length
  const k = Math.min(MAX_K, Math.max(1, Math.ceil(len / n)))
  const out = []
  let start = 0
  for (let i = 0; i < k; i += 1) {
    const end = i === k - 1 ? len : Math.round((len * (i + 1)) / k)
    out.push(text.slice(start, end))
    start = end
  }
  return out
}

function loadVectors(snap) {
  const db = L.openReadOnly(snap)
  try {
    const rows = db.prepare("select fact_id id, content, semantic_vector v, length(content) len from facts where status='active' order by fact_id").all()
    const out = new Map()
    for (const r of rows) out.set(r.id, { text: String(r.content), len: r.len, vec: r.v ? blobToVec(r.v) : null })
    return out
  } finally {
    db.close()
  }
}

async function runN({ n, facts, emb, queries, texts }) {
  const ids = [...facts.keys()]
  const longIds = ids.filter((id) => facts.get(id).len > n)
  const chunkVectors = new Map()
  const t0 = Date.now()
  let chunkCount = 0
  for (const id of longIds) {
    const chunks = chunkText(facts.get(id).text, n)
    const vecs = []
    for (const c of chunks) {
      vecs.push(await emb.encode(c))
      chunkCount += 1
    }
    chunkVectors.set(id, vecs)
  }
  const encodeMs = Date.now() - t0

  // Per-fact cosine under baseline / chunk_max / chunk_capped.
  const scoreFact = (qv, id) => {
    const whole = cosine(qv, facts.get(id).vec)
    if (!chunkVectors.has(id)) return { whole, chunk_max: whole, chunk_capped: whole }
    let best = Number.NEGATIVE_INFINITY
    for (const v of chunkVectors.get(id)) {
      const c = cosine(qv, v)
      if (c > best) best = c
    }
    return { whole, chunk_max: best, chunk_capped: Math.min(best, whole) }
  }

  const rows = []
  for (const q of queries) {
    const qv = await emb.encode(q.q)
    const scored = ids.map((id) => ({ id, ...scoreFact(qv, id) }))
    const rank = (key) => [...scored].sort((a, b) => b[key] - a[key] || a.id - b.id).slice(0, LIMIT).map((s) => s.id)
    const base = rank('whole')
    const armMax = rank('chunk_max')
    const armCap = rank('chunk_capped')
    const goldRank = (list) => (q.gold ? (list.some((id) => q.gold.includes(id)) ? list.findIndex((id) => q.gold.includes(id)) + 1 : null) : null)
    rows.push({
      id: q.id,
      kind: q.kind,
      gold: q.gold ?? null,
      baseline_ids: base,
      chunk_max_ids: armMax,
      chunk_capped_ids: armCap,
      baseline_gold_rank: goldRank(base),
      chunk_max_gold_rank: goldRank(armMax),
      chunk_capped_gold_rank: goldRank(armCap),
      long_note_ranks: {
        baseline: Object.fromEntries(longIds.map((id) => [id, base.indexOf(id) === -1 ? null : base.indexOf(id) + 1])),
        chunk_max: Object.fromEntries(longIds.map((id) => [id, armMax.indexOf(id) === -1 ? null : armMax.indexOf(id) + 1])),
      },
    })
  }

  const goldRows = rows.filter((r) => r.gold !== null)
  const top = (key) => ({
    top1: goldRows.filter((r) => r[`${key}_gold_rank`] === 1).length,
    top3: goldRows.filter((r) => r[`${key}_gold_rank`] !== null && r[`${key}_gold_rank`] <= 3).length,
    missing: goldRows.filter((r) => r[`${key}_gold_rank`] === null).length,
  })
  // Long-note position: does any long note get WORSE, counting null (absent) as worse than any rank?
  let longNoteWorse = 0
  let longNoteBetter = 0
  let longNotesInBaselineTop5 = 0
  for (const r of rows) {
    for (const id of longIds) {
      const b = r.long_note_ranks.baseline[id]
      const a = r.long_note_ranks.chunk_max[id]
      if (b !== null) longNotesInBaselineTop5 += 1
      const worse = (b === null && a !== null) || (b !== null && (a === null || a > b))
      const better = (b !== null && a !== null && a < b) || (b === null && a === null ? false : b === null && a !== null)
      if (worse) longNoteWorse += 1
      if (b !== null && a !== null && a < b) longNoteBetter += 1
    }
  }
  return {
    n,
    long_facts: longIds.length,
    short_facts: ids.length - longIds.length,
    chunks_created: chunkCount,
    vector_count: ids.length - longIds.length + chunkCount,
    baseline_vector_count: ids.length,
    vector_ratio: L.round4((ids.length - longIds.length + chunkCount) / ids.length),
    encode_ms: encodeMs,
    top: { baseline: top('baseline'), chunk_max: top('chunk_max'), chunk_capped: top('chunk_capped') },
    long_note: { worse: longNoteWorse, better: longNoteBetter, in_baseline_top5: longNotesInBaselineTop5 },
    per_query: rows,
  }
}

async function main() {
  const emb = await L.warmEmbedder()
  if (!(await emb.isAvailable?.() ?? true)) throw new Error('R2-7: embedder unavailable — nothing measured')
  const work = mkdtempSync(join(tmpdir(), 'avantf-r27-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts, meta } = L.loadActiveTexts(snap)
  L.banner('R2-7 · L3 long-fact chunking pilot', { snapshot: snap, active_facts: texts.size, max_k: MAX_K })

  const facts = loadVectors(snap)
  const missingVec = [...facts.values()].filter((f) => f.vec === null).length
  const queries = L.resolveRealGolds(snap, { texts })
  const rssBefore = L.rssMiB()

  const perN = {}
  for (const n of [512, 128]) perN[`N=${n}`] = await runN({ n, facts, emb, queries, texts })
  const rssAfter = L.rssMiB()

  // Write-latency multiple: whole vs K chunks on a sample of long facts (real encode calls).
  // Warm the session FIRST (the first call above absorbed the session warm-up: measured 2078 ms for
  // 8 whole encodes against 1957 ms for 24 chunk encodes, i.e. the multiple was an artefact), then
  // INTERLEAVE whole/chunk on each fact so drift cannot land on one side only.
  await emb.encode('预热：这条文本只用于让 ONNX 会话完成首次推理')
  const sampleLong = [...facts.entries()].filter(([, f]) => f.len > 512).slice(0, 8)
  const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6
  let wholeMs = 0
  let chunkMs = 0
  const perFact = []
  for (const [, f] of sampleLong) {
    let t0 = process.hrtime.bigint()
    await emb.encode(f.text)
    const w = ms(t0)
    t0 = process.hrtime.bigint()
    const chunks = chunkText(f.text, 512)
    for (const c of chunks) await emb.encode(c)
    const cms = ms(t0)
    wholeMs += w
    chunkMs += cms
    perFact.push({ len: f.len, chunks: chunks.length, whole_ms: L.round4(w), chunks_ms: L.round4(cms) })
  }

  for (const k of Object.keys(perN)) {
    const r = perN[k]
    console.log(`${k}: long ${r.long_facts}/${r.long_facts + r.short_facts}, chunks ${r.chunks_created}, vectors ${r.baseline_vector_count} -> ${r.vector_count} (x${r.vector_ratio}), encode ${r.encode_ms} ms`)
    console.log(`   top1/top3/missing baseline ${r.top.baseline.top1}/${r.top.baseline.top3}/${r.top.baseline.missing} | chunk_max ${r.top.chunk_max.top1}/${r.top.chunk_max.top3}/${r.top.chunk_max.missing} | chunk_capped ${r.top.chunk_capped.top1}/${r.top.chunk_capped.top3}/${r.top.chunk_capped.missing}`)
    console.log(`   long-note ranks worse ${r.long_note.worse}, better ${r.long_note.better}, long notes in baseline top5 ${r.long_note.in_baseline_top5}`)
  }
  console.log(`rss ${rssBefore} -> ${rssAfter} MiB; write latency ${wholeMs} -> ${chunkMs} ms on ${sampleLong.length} long facts (x${wholeMs ? L.round4(chunkMs / wholeMs) : null})`)

  const verdicts = {}
  for (const [k, r] of Object.entries(perN)) {
    const top3Up = r.top.chunk_max.top3 > r.top.baseline.top3 || r.top.chunk_max.top1 > r.top.baseline.top1
    verdicts[k] = {
      top3_up: r.top.chunk_max.top3 > r.top.baseline.top3,
      top1_up: r.top.chunk_max.top1 > r.top.baseline.top1,
      long_note_not_worse: r.long_note.worse === 0,
      adopt: top3Up && r.long_note.worse === 0,
    }
    verdicts[k].call = verdicts[k].adopt
      ? 'adopt'
      : !top3Up
        ? 'reject — no top-1/top-3 gain on the real 20-query network'
        : 'reject — the gain costs long-note rank positions'
  }

  const out = {
    card: 'R2-7',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size, median_len: [...meta.values()].map((m) => m.len).sort((a, b) => a - b)[Math.floor(meta.size / 2)] },
    method: {
      chunks: `K = min(${MAX_K}, ceil(len/N)) contiguous near-equal slices`,
      rules: { chunk_max: 'max cosine over the K chunks', chunk_capped: 'min(chunk_max, whole-fact cosine)' },
      no_db_write: true,
      download: false,
      facts_without_vector: missingVec,
    },
    identity: { applicable: false, note: 'pure vector pilot: ranks are recomputed from raw cosines, no retrieval pass is run, so there is no production arm to identity-check' },
    rss_mib: { before: rssBefore, after: rssAfter },
    write_latency: { sample_long_facts: sampleLong.length, whole_ms: L.round4(wholeMs), chunk_ms: L.round4(chunkMs), multiple: wholeMs ? L.round4(chunkMs / wholeMs) : null, per_fact: perFact, warmed: true },
    per_n: perN,
    verdicts,
    verdict: {
      adopt: false,
      call: 'reject for both N: no top-1/top-3 gain on the real 20-query network and long-note ranks get worse',
    },
    reproduction: 'node mem/scripts/spikes/bench-r2-7-chunking-pilot.mjs --json mem/docs/spikes/raw/round2-r2-7-chunking-pilot.json',
  }
  L.writeJson(jsonOut, out)
  L.teardown({ runtimes: [], dirs: [work] })
}

await main()
