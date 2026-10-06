/**
 * P2-4 · A6 — the cost of a PER-HIT PER-LEG score envelope (cost only; no quality A/B).
 *
 * WHAT THIS IS. If each returned hit carried its per-leg score breakdown (the "逐臂分" envelope),
 * the model/panel payload would grow and serialization would cost more. A6 has NO effect on
 * retrieval quality, so the brief asks for the COST NUMBER only, for scheduling.
 *
 * THE ENVELOPE MEASURED. For every returned hit:
 *   `legs: { semantic: {raw, norm}, fts: {raw, norm}, jaccard: {raw, norm} }`
 * where `raw` is the leg's floored absolute score and `norm` is that leg's max-normalized value
 * (the number `fuse` actually sums). Absent legs are `null`.
 *
 * NUMBERS: bytes and estimated tokens added per hit; bytes added to the whole result; the
 * `JSON.stringify` cost with and without the envelope (median of repeated runs); and the current
 * `admin.stats` payload size (the `/mem` panel poll reads it) for scale.
 *
 * Usage: node mem/scripts/spikes/bench-a6-envelope-cost.mjs
 * PRIVACY: sizes / timings only — no fact text is written to the JSON.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/a6-envelope-cost.json'))
const LIMIT = 5
const REPS = 200

const bytes = (s) => Buffer.byteLength(s, 'utf8')

function medianMs(fn, reps = REPS) {
  const samples = []
  for (let i = 0; i < reps; i += 1) {
    const t0 = process.hrtime.bigint()
    fn()
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  samples.sort((a, b) => a - b)
  return L.round4(samples[Math.floor(samples.length / 2)])
}

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-a6-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts } = L.loadActiveTexts(snap)
  track.texts = texts
  L.banner('A6 · per-hit per-leg envelope cost', { active_facts: texts.size })
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })
  const queries = L.resolveRealGolds(snap, { texts })

  const identity = []
  for (const q of queries) identity.push(await L.identityCheck(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const idFail = identity.filter((r) => !r.ok)

  const rows = []
  let plainTotal = 0
  let envelopedTotal = 0
  let plainJsonMs = 0
  let envelopedJsonMs = 0
  let hitCount = 0
  for (const q of queries) {
    const prod = await L.prodResult(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict' })
    const pass = await L.runScript(rt, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const legs = pass.legs.map((l) => ({ leg: l.leg, raw: l.scores, norm: L.scaleByMax(l.scores) }))
    const withEnvelope = prod.hits.map((h) => {
      const envelope = {}
      for (const { leg, raw, norm } of legs) {
        envelope[leg] = { raw: raw.has(h.ref_id) ? L.round4(raw.get(h.ref_id)) : null, norm: norm.has(h.ref_id) ? L.round4(norm.get(h.ref_id)) : null }
      }
      return { ...h, legs: envelope }
    })
    const plainStr = JSON.stringify(prod.hits)
    const envStr = JSON.stringify(withEnvelope)
    const plain = bytes(plainStr)
    const env = bytes(envStr)
    plainTotal += plain
    envelopedTotal += env
    hitCount += prod.hits.length
    plainJsonMs += medianMs(() => JSON.stringify(prod.hits))
    envelopedJsonMs += medianMs(() => JSON.stringify(withEnvelope))
    rows.push({
      id: q.id,
      query: q.q,
      hits: prod.hits.length,
      plain_bytes: plain,
      enveloped_bytes: env,
      added_bytes: env - plain,
      added_bytes_per_hit: prod.hits.length ? L.round4((env - plain) / prod.hits.length) : null,
      plain_tokens: L.estimateTokens(plainStr),
      enveloped_tokens: L.estimateTokens(envStr),
    })
  }

  const stats = rt.admin({ action: 'stats' })
  const statsBytes = bytes(JSON.stringify(stats))

  const summary = {
    queries: rows.length,
    hits: hitCount,
    plain_bytes_total: plainTotal,
    enveloped_bytes_total: envelopedTotal,
    added_bytes_total: envelopedTotal - plainTotal,
    added_bytes_per_hit_mean: L.round4((envelopedTotal - plainTotal) / Math.max(1, hitCount)),
    added_pct_of_payload: L.round4(((envelopedTotal - plainTotal) / Math.max(1, plainTotal)) * 100),
    plain_json_ms_total: L.round4(plainJsonMs),
    enveloped_json_ms_total: L.round4(envelopedJsonMs),
    added_json_ms_per_hit: L.round4((envelopedJsonMs - plainJsonMs) / Math.max(1, hitCount)),
    admin_stats_bytes: statsBytes,
    note: 'A6 changes retrieval quality by construction (no A/B): these are pure cost numbers for scheduling.',
  }
  console.log(JSON.stringify(summary, null, 2))

  L.writeJson(jsonOut, {
    card: 'A6',
    measured_at: new Date().toISOString(),
    node: process.version,
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size },
    envelope: 'legs: { semantic|fts|jaccard: { raw, norm } } per hit (norm = fuse\u2019s max-normalized value)',
    reps: REPS,
    identity: { checked: identity.length, passed: identity.length - idFail.length, failures: idFail },
    summary,
    rows,
    reproduction: 'node mem/scripts/spikes/bench-a6-envelope-cost.mjs',
  })
  L.teardown(track)
}

await main()
